**HOW TO USE CapiProxy FOR SESSIONWRAPPER / SDK INTEGRATION TESTS**

---

**Architecture**

`CapiProxy` (`src/test/harness/CapiProxy.ts`) is a plain in-process `http.Server` that stands in for the CAPI `/chat/completions` endpoint. Point `CopilotClient` at it via `COPILOT_API_URL` and the real SDK runs against it exactly as it would against the real network: session create/resume, tool-permission enforcement, and `systemMessage`/config derivation all execute for real inside the SDK. Only the LLM completion boundary itself is faked — the proxy reads each incoming request, matches it against a YAML snapshot, and returns a scripted `assistant` reply (text or tool call). Tool calls are part of the YAML; the proxy replays the LLM's tool-call decision, your actual tool handler executes, and the tool's real output goes back through the proxy as the next request's `role: tool` message.

There is no TLS interception, no child process, and no pass-through to a real endpoint anywhere in this file — `CapiProxy` only ever serves from a YAML snapshot already on disk. **Snapshots are hand-authored, not recorded.** Generating one is just writing YAML in the format below; there's no live-network step required or implemented.

---

**Starting the proxy in tests**

The proxy runs in-process, in the same test process as everything else:

```typescript
const proxy = new CapiProxy();
const proxyUrl = await proxy.start();
```

`proxy.setCopilotUserByToken(...)` exists only as a no-op stub for interface compatibility with the SDK's own harness naming — this `CapiProxy` doesn't do real auth-token handling, so there's nothing to configure there.

---

**Wiring CopilotClient to the proxy**

```typescript
const client = new CopilotClient({
  workingDirectory: workDir,
  logLevel: "none",
  useLoggedInUser: false,
  env: {
    ...process.env,
    ...proxy.getProxyEnv(),   // sets COPILOT_API_URL -- the only var this harness needs
    COPILOT_API_URL: proxyUrl,
  },
});
```

`getProxyEnv()` only sets `COPILOT_API_URL`. There's no `HTTP_PROXY`/`HTTPS_PROXY`/`NODE_EXTRA_CA_CERTS` to set, because there's no TLS-intercepting tunnel involved — the client just talks HTTP directly to the local proxy.

---

**Pointing each test at its snapshot**

```typescript
await proxy.updateConfig({
  filePath: "src/test/snapshots/session_wrapper/create_resume.yaml",
  workDir,
});
```

Loads the YAML file synchronously from disk and resets the proxy's per-test call counter. Call this once per test, typically in the test body or `beforeEach`, before starting the client.

---

**YAML snapshot format**

Each `conversations` entry describes one round-trip's worth of messages. The proxy matches an incoming request's `messages` array against each entry (by role sequence, comparing prefix-wise) and, on a match, returns the next `assistant` turn as the completion.

Matching rules (see `CapiProxy.ts` for the exact logic):
- `role` must match at every compared index.
- For `system`/`user` messages, the expected `content` is checked as a **substring** of the incoming content (not exact equality) — so an expected value only needs to contain the part you actually care about.
- `${system}` and `${user}` as the expected `content` are **wildcards**: they skip content comparison entirely for that message. Use these whenever the exact prompt/system-message text isn't what the test is checking.
- Non-string content (e.g. `tool_calls`) is compared with `JSON.stringify` equality.

**Simple text response:**
```yaml
models:
  - claude-sonnet-4.5
conversations:
  - messages:
      - role: system
        content: ${system}        # wildcard -- matches any system prompt
      - role: user
        content: Run the gate check.
      - role: assistant
        content: The gate check passed. All tests green.
```

**Tool call conversation (multi-turn):**
```yaml
models:
  - claude-sonnet-4.5
conversations:
  - messages:
      - role: system
        content: ${system}
      - role: user
        content: Run the gate check.
      - role: assistant
        tool_calls:
          - id: toolcall_0
            type: function
            function:
              name: run_gate
              arguments: '{"target":"tests","flags":[]}'
  - messages:
      - role: system
        content: ${system}
      - role: user
        content: Run the gate check.
      - role: assistant
        tool_calls:
          - id: toolcall_0
            type: function
            function:
              name: run_gate
              arguments: '{"target":"tests","flags":[]}'
      - role: tool
        tool_call_id: toolcall_0
        content: |-
          FAIL: 2 tests failed
          gate: failed
      - role: assistant
        content: The gate failed. 2 tests need fixing.
```

Key points about the format:
- Each `conversations` entry is one full conversation thread; multiple entries in the list back multiple round-trips within one test (e.g. the second entry above is what the proxy returns once the tool result comes back).
- `${system}`/`${user}` placeholders exist specifically so a snapshot doesn't need to encode exact prompt text it doesn't care about — write the real, meaningful content (a specific user message, an expected tool call) and wildcard the rest.

---

**Generating snapshots**

Write the YAML by hand. That's the only supported path in this repo — `CapiProxy` has no record mode, so there's nothing to run against a live endpoint and nothing to capture. Since these tests exercise the integration between `SessionWrapper`/`CopilotClient` and the real SDK (session lifecycle, config derivation, tool dispatch, permission enforcement), not the integration between the SDK and an actual model, a hand-written scripted reply is exactly what the test needs: it fixes the model's decision so the real SDK code around it can be exercised deterministically. There is no live-network step to reach for, optional or otherwise, for this class of test.

If a genuine live-recording capability (real CAPI pass-through, writing a YAML from the actual exchange) is ever wanted, that's new functionality to build in `CapiProxy.ts` — TLS interception, a real auth path, etc. — not something already present here that a test can just enable.

---

**Teardown**

```typescript
afterEach(async () => {
  await client.stop();
  await proxy.stop();
});
```

`proxy.stop()` just closes the HTTP server. There's nothing to flush — the proxy never writes to disk.

---

**What this tests end-to-end**

With this setup your actual `SessionWrapper`/`CopilotClient` code runs unmodified against the real SDK. The proxy only replays the LLM's decision (tool call or text response); everything else — session create/resume, `_createConfig()` derivation, tool handler dispatch, `onPermissionRequest` enforcement, `sendAndWait` round-tripping — runs for real. You're testing:
- Session lifecycle (create → send → resume → tool calls → stop)
- Config re-derivation across resumes (`availableTools`, `systemMessage`, permission handler)
- Tool handler registration and dispatch, including real handler output flowing back through the SDK
- Retry/escalation logic triggered by real tool-output evaluation
