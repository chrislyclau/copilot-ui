import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { CapiProxy } from './harness/CapiProxy';
import { CopilotClient, defineTool } from '../copilotSdk/boundary';
import { SessionWrapper } from '../copilotSdk/sessionWrapper';
import {
  FROZEN_SDK_SYSTEM_MESSAGE_BASELINE,
  stripSdkGeneratedDynamicSections,
} from '../copilotSdk/systemMessageBaseline';

// Exercises SessionWrapper (src/copilotSdk/sessionWrapper.ts) against a REAL
// CopilotClient/CopilotSession talking to the CapiProxy harness described in
// copilot-sdk-record-replay.md, per issue #332. The proxy (ReplayingCapiProxy)
// only mocks the LLM completions boundary (CopilotClient -> CAPI) -- session
// create/resume, tool-permission enforcement, and config re-derivation all
// run for real against the SDK. Nothing here asserts against an assumed SDK
// contract; it asserts against what the live SDK actually does, which is
// exactly what #328's black-box unit tests (mocked session/client doubles)
// cannot catch.
//
// Snapshot YAMLs live in src/test/snapshots/session_wrapper/. See that
// directory's naming for which test each file backs.
describe('SessionWrapper against the live Copilot SDK (Issue #332)', () => {
  let proxy: CapiProxy;
  let proxyUrl: string;
  let tmpWorkDir: string;
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(async () => {
    proxy = new CapiProxy();
    proxyUrl = await proxy.start();
    tmpWorkDir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-wrapper-sdk-'));
    fs.writeFileSync(path.join(tmpWorkDir, 'notes.txt'), 'hello from the real filesystem');
  });

  afterEach(async () => {
    await proxy.stop();
    fs.rmSync(tmpWorkDir, { recursive: true, force: true });
    process.env = { ...ORIGINAL_ENV };
  });

  function makeClient(): CopilotClient {
    return new CopilotClient({
      workingDirectory: tmpWorkDir,
      logLevel: 'none',
      useLoggedInUser: false,
      env: {
        ...process.env,
        ...proxy.getProxyEnv(),
        COPILOT_API_URL: proxyUrl,
      },
    });
  }

  function makeWrapper(client: CopilotClient, toolsConfig: ConstructorParameters<typeof SessionWrapper>[1] = {}): SessionWrapper {
    return new SessionWrapper(client, toolsConfig, {
      provider: {
        type: 'openai',
        baseUrl: proxyUrl,
        apiKey: 'test-api-key',
      },
    });
  }

  // Handler-backed custom Tool for issue #345 coverage: reads the real
  // seeded file from tmpWorkDir, so a successful dispatch produces output
  // ("hello from the real filesystem") that couldn't appear unless the SDK
  // actually invoked this handler -- the same "real output leaked/didn't
  // leak" signal the built-in `view` tests use for `addTools`/`removeTools`.
  function makeEchoNotesTool() {
    let callCount = 0;
    const tool = defineTool(
      'echo_notes',
      'Echoes the contents of a text file in the working directory.',
      {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
      },
      async (args: unknown) => {
        callCount++;
        const { path: relPath } = args as { path: string };
        return fs.readFileSync(path.join(tmpWorkDir, relPath), 'utf8');
      }
    );
    return { tool, getCallCount: () => callCount };
  }

  // Scope item 1 (SYS-REQ-027c): session create/resume round trip. Confirms
  // `_createConfig()`'s output is accepted by the real SDK on both the
  // create path (no `_session` yet) and the resume path (same instance,
  // second `sendAndWait()` call) -- no schema mismatch, no silently ignored
  // fields, and the same `SessionWrapper` instance transparently decides
  // create vs resume as documented.
  it('creates then resumes a real SDK session across two sendAndWait calls', { timeout: 30000 }, async () => {
    const snapshotPath = path.resolve(process.cwd(), 'src/test/snapshots/session_wrapper/create_resume.yaml');
    await proxy.updateConfig({ filePath: snapshotPath, workDir: tmpWorkDir });

    const client = makeClient();
    await client.start();
    try {
      const wrapper = makeWrapper(client).setModelName('claude-sonnet-4.5');

      const first = await wrapper.sendAndWait('Hello', 15000);
      expect(first).toBeTruthy();

      const second = await wrapper.sendAndWait('Hello', 15000);
      expect(second).toBeTruthy();

      // Two distinct CAPI completions were actually sent over the wire --
      // proof the second call went through resumeSession rather than
      // silently reusing/short-circuiting the first response.
      const completions = proxy.requestHistory.filter((r) => Array.isArray(r.messages));
      expect(completions.length).toBeGreaterThanOrEqual(2);
    } finally {
      await client.stop();
    }
  });

  // Staleness guard for FROZEN_SDK_SYSTEM_MESSAGE_BASELINE (see the doc
  // comment on that constant in systemMessageBaseline.ts). Bypasses
  // SessionWrapper entirely and drives `CopilotClient.createSession`
  // directly with the SDK's default (non-`replace`) `systemMessage`, zero
  // tools -- i.e. reproduces exactly what
  // src/test/scripts/capture-system-message-baseline.ts captures by hand --
  // then asserts the first history entry's system message, once the two
  // per-session dynamic sections are stripped, is byte-identical to the
  // frozen constant SessionWrapper builds `replace`-mode prompts on top of.
  // A real `@github/copilot-sdk` upgrade that changes its own baseline
  // prompt fails this test immediately instead of silently drifting until
  // someone re-runs the capture script by hand.
  it("does not drift from the installed SDK's own baseline system message", { timeout: 30000 }, async () => {
    const snapshotPath = path.resolve(process.cwd(), 'src/test/snapshots/session_wrapper/create_resume.yaml');
    await proxy.updateConfig({ filePath: snapshotPath, workDir: tmpWorkDir });

    const client = makeClient();
    await client.start();
    try {
      const session = await client.createSession({
        model: 'claude-sonnet-4.5',
        provider: { type: 'openai', baseUrl: proxyUrl, apiKey: 'test-api-key' },
        availableTools: [],
        autoApproveAll: false,
        onPermissionRequest: async () => ({ kind: 'reject', feedback: 'no tools' }),
      } as Parameters<typeof client.createSession>[0]);

      await session.sendAndWait('Hello', 15000);

      // The first history entry (create, not resume) is what
      // `FROZEN_SDK_SYSTEM_MESSAGE_BASELINE` was originally captured from.
      const completions = proxy.requestHistory.filter((r) => Array.isArray(r.messages));
      const firstSystemMessage = completions[0]?.messages.find((m: any) => m.role === 'system')?.content ?? '';

      expect(stripSdkGeneratedDynamicSections(firstSystemMessage)).toBe(FROZEN_SDK_SYSTEM_MESSAGE_BASELINE);
    } finally {
      await client.stop();
    }
  });


  // tool present in `_tools` is exposed to the model; when the model calls
  // it, we confirm the SDK actually executes it (i.e. the SDK invoked our
  // `onPermissionRequest` with a shape our handler could resolve, and honored
  // the approve-once result) rather than just checking our handler's return
  // value in isolation.
  it('lets a real model turn call an allowed tool, and the SDK actually executes it', { timeout: 30000 }, async () => {
    const snapshotPath = path.resolve(
      process.cwd(),
      'src/test/snapshots/session_wrapper/tool_permission_allowed.yaml'
    );
    await proxy.updateConfig({ filePath: snapshotPath, workDir: tmpWorkDir });

    const client = makeClient();
    await client.start();
    try {
      const wrapper = makeWrapper(client, { builtins: ['view'] }).setModelName('claude-sonnet-4.5');

      const result = await wrapper.sendAndWait('Check notes.txt', 15000);
      expect(result).toBeTruthy();

      // The SDK only sends a follow-up completion (with the tool's real
      // output folded in as a `tool` message) if it actually ran the tool --
      // which only happens if our onPermissionRequest handler approved the
      // real PermissionRequest the SDK sent it, and the SDK honored that
      // approval. A hand-mocked session double can't prove this.
      const toolResultSent = proxy.requestHistory.some(
        (r) => Array.isArray(r.messages) && r.messages.some((m: any) => m.role === 'tool')
      );
      expect(toolResultSent).toBe(true);
    } finally {
      await client.stop();
    }
  });

  // Scope item 3 (SYS-REQ-027d): resume config re-derivation against a live
  // session. Mutates `_tools`/`_systemPrompt` between two `sendAndWait()`
  // calls on the same instance. Per #345, `systemMessage` itself must now
  // stay frozen across resumes (to protect the prompt/KV cache prefix) --
  // the tool-list/system-prompt mutation instead shows up as (a) the
  // re-derived `availableTools`/permission outcome, still fully live per
  // turn, and (b) an update notice appended to the SECOND request's user
  // turn.
  //
  // `resume_rederivation.yaml` (like every snapshot in this directory) is a
  // hand-authored script for the CapiProxy harness, not a capture of a real
  // model's output: it only encodes `role` sequence and scripted `assistant`
  // replies, and CapiProxy's matcher (see CapiProxy.ts) treats `${system}`/
  // `${user}` as wildcards that skip content matching entirely. It has no
  // dependency on what SessionWrapper actually puts in `systemMessage`, so
  // it needs no update -- and no live CAPI endpoint, ever -- when that
  // content's shape changes, including the #345 fix this test exercises.
  it('freezes systemMessage across resume; tool/prompt mutations surface via availableTools and an appended notice instead', { timeout: 30000 }, async () => {
    const snapshotPath = path.resolve(
      process.cwd(),
      'src/test/snapshots/session_wrapper/resume_rederivation.yaml'
    );
    await proxy.updateConfig({ filePath: snapshotPath, workDir: tmpWorkDir });

    const client = makeClient();
    await client.start();
    try {
      const wrapper = makeWrapper(client, { builtins: ['bash', 'view'] })
        .setModelName('claude-sonnet-4.5')
        .setSystemPrompt('Initial prompt marker.');

      await wrapper.sendAndWait('Status check', 15000);

      wrapper.disableTools('bash').enableTools('view').setSystemPrompt('Updated prompt marker.');

      await wrapper.sendAndWait('Status check', 15000);

      const completions = proxy.requestHistory.filter((r) => Array.isArray(r.messages));
      expect(completions.length).toBeGreaterThanOrEqual(2);

      const firstSystem = completions[0].messages.find((m: any) => m.role === 'system')?.content ?? '';
      const secondSystem = completions[1].messages.find((m: any) => m.role === 'system')?.content ?? '';
      const secondUser = [...completions[1].messages].reverse().find((m: any) => m.role === 'user')?.content ?? '';

      // Match SessionWrapper's own tool-usage sentence (buildToolUsageSection
      // in sessionWrapper.ts) rather than a bare substring like "bash" --
      // the SDK's own boilerplate instructions mention built-in tool names
      // generically, which would make a bare substring check pass
      // regardless of what SessionWrapper actually derived.
      expect(firstSystem).toContain('Initial prompt marker.');
      expect(firstSystem).not.toContain('Updated prompt marker.');

      // SYS-REQ-028g/h: the second request's systemMessage IS resent on
      // resume (byte-identical to creation, since resumeSession does not
      // inherit it -- issue #208), so it stays identical to what creation
      // sent regardless of what `_systemPrompt` changed to afterward.
      expect(secondSystem).toBe(firstSystem);

      // The mutation is instead visible only via the per-turn enablement
      // notice (SYS-REQ-028i/028l), never in availableTools (fixed at
      // construction per SYS-REQ-028/028d-1).
      expect(secondUser).toContain('Only the following tools are currently enabled and may be called: view.');
      expect(secondUser).toContain("additional operating instructions changed");
    } finally {
      await client.stop();
    }
  });

  // Scope item 4 (SYS-REQ-027j): `removeTools` denial takes effect against
  // the live SDK. A tool is allowed, then removed before a resumed turn
  // attempts to call it again; confirms the SDK actually rejects the call on
  // the live boundary (our handler's reject feedback reaches the SDK / model),
  // not just that `_createConfig()`'s output looks right in isolation.
  it('rejects a real tool call for a tool removed before resume', { timeout: 30000 }, async () => {
    const snapshotPath = path.resolve(
      process.cwd(),
      'src/test/snapshots/session_wrapper/removeTools_denial.yaml'
    );
    await proxy.updateConfig({ filePath: snapshotPath, workDir: tmpWorkDir });

    const client = makeClient();
    await client.start();
    try {
      const wrapper = makeWrapper(client, { builtins: ['view'] }).setModelName('claude-sonnet-4.5');

      // Turn 1: 'view' is allowed but the scripted turn doesn't call it yet.
      await wrapper.sendAndWait('Stand by', 15000);

      // Disable the tool, then resume with a turn that tries to call it.
      wrapper.disableTools('view');
      await wrapper.sendAndWait('Check notes.txt again', 15000);

      // The live SDK must actually deny the call -- either via our
      // `onPermissionRequest` handler's exact reject feedback
      // (sessionWrapper.ts), or (as observed against the real SDK: it
      // short-circuits calls to tools outside `availableTools` before ever
      // invoking our permission handler) via the SDK's own "tool does not
      // exist" message. Either is proof the live SDK enforced the removal;
      // a hand-mocked double can't reveal which path the real SDK takes.
      const rejectionSeen = proxy.requestHistory.some(
        (r) =>
          Array.isArray(r.messages) &&
          r.messages.some(
            (m: any) =>
              m.role === 'tool' &&
              typeof m.content === 'string' &&
              m.content.includes('is not currently enabled for this session')
          )
      );
      expect(rejectionSeen).toBe(true);

      // And the tool must never have actually executed post-disable: no
      // request should show a successful tool-result echoing the real file
      // contents we seeded (that would mean the SDK ran 'view' anyway).
      const realFileLeaked = proxy.requestHistory.some(
        (r) =>
          Array.isArray(r.messages) &&
          r.messages.some(
            (m: any) => m.role === 'tool' && typeof m.content === 'string' && m.content.includes('hello from the real filesystem')
          )
      );
      expect(realFileLeaked).toBe(false);
    } finally {
      await client.stop();
    }
  });

  // Regression test for the BUILTIN_TOOL_PERMISSION_KIND collision
  // (sessionWrapper.ts): 'view', 'grep', and 'glob' all map to permission
  // kind 'read', and built-in PermissionRequests carry only `kind`, not a
  // tool name -- so a bare `kind: 'read'` request cannot say which sibling
  // issued it. Before SYS-REQ-028d-1, this was masked by the SDK's own
  // name-based `availableTools` gate, which rejected a disabled sibling by
  // name before `onPermissionRequest` ever ran. Now that `availableTools`
  // is always the full construction-time list (both 'view' and 'grep' are
  // declared and visible to the model below), that name-based gate no
  // longer helps -- `_onPermissionRequest`'s kind-collision handling is the
  // only thing standing between a disabled 'grep' and a live tool call.
  it('rejects a real "grep" tool call when "grep" is disabled, even while its permission-kind sibling "view" stays enabled', { timeout: 30000 }, async () => {
    const snapshotPath = path.resolve(
      process.cwd(),
      'src/test/snapshots/session_wrapper/kind_collision_denial.yaml'
    );
    await proxy.updateConfig({ filePath: snapshotPath, workDir: tmpWorkDir });

    const client = makeClient();
    await client.start();
    try {
      // Both share permission kind 'read' -- 'view' stays enabled, only
      // 'grep' is disabled, so a naive same-kind approval would wrongly let
      // 'grep' through on the strength of 'view' being allowed.
      const wrapper = makeWrapper(client, { builtins: ['view', 'grep'] }).setModelName('claude-sonnet-4.5');
      wrapper.disableTools('grep');

      await wrapper.sendAndWait('Search for TODO in notes.txt using grep', 15000);

      // The live SDK's tool call to 'grep' must reach our permission layer
      // and be denied there -- not silently approved via the 'read' kind
      // that 'view' also shares.
      const grepDenied = proxy.requestHistory.some(
        (r) =>
          Array.isArray(r.messages) &&
          r.messages.some(
            (m: any) =>
              m.role === 'tool' &&
              typeof m.content === 'string' &&
              m.content.includes('is not currently enabled for this session')
          )
      );
      expect(grepDenied).toBe(true);

      // And 'grep' must never have actually executed: no real grep output
      // (which would include the seeded file's content) should appear.
      const grepRan = proxy.requestHistory.some(
        (r) =>
          Array.isArray(r.messages) &&
          r.messages.some(
            (m: any) => m.role === 'tool' && typeof m.content === 'string' && m.content.includes('hello from the real filesystem')
          )
      );
      expect(grepRan).toBe(false);
    } finally {
      await client.stop();
    }
  });

  // Issue #345, scope item 1: a handler-backed custom Tool added via
  // `addTool` is (a) offered to the model in `availableTools`/the derived
  // tool-usage system-prompt section on the same footing as a built-in, and
  // (b) actually dispatched by the live SDK -- not just auto-approved in
  // isolation. Mirrors `tool_permission_allowed.yaml`'s structure/assertions
  // ("lets a real model turn call an allowed tool...") but with
  // `addTool(customTool)` instead of `addTools('view')`.
  it('lets a real model turn call a custom handler-backed tool, and the SDK actually executes it', { timeout: 30000 }, async () => {
    const snapshotPath = path.resolve(
      process.cwd(),
      'src/test/snapshots/session_wrapper/custom_tool_permission_allowed.yaml'
    );
    await proxy.updateConfig({ filePath: snapshotPath, workDir: tmpWorkDir });

    const client = makeClient();
    await client.start();
    try {
      const { tool: echoNotesTool, getCallCount } = makeEchoNotesTool();
      const wrapper = makeWrapper(client, { custom: [echoNotesTool] }).setModelName('claude-sonnet-4.5');

      const result = await wrapper.sendAndWait('Check notes.txt with the custom tool', 15000);
      expect(result).toBeTruthy();

      // Our handler itself was actually invoked by the SDK, not just
      // approved -- callCount is only incremented inside the handler.
      expect(getCallCount()).toBeGreaterThanOrEqual(1);

      // And its real output made it back into a follow-up completion, the
      // same signal `tool_permission_allowed` uses for `view`: a hand-mocked
      // session double can approve a permission request without the SDK
      // ever actually wiring the handler's return value into the next
      // request, so this is the part that proves end-to-end dispatch.
      const toolResultSent = proxy.requestHistory.some(
        (r) =>
          Array.isArray(r.messages) &&
          r.messages.some(
            (m: any) => m.role === 'tool' && typeof m.content === 'string' && m.content.includes('hello from the real filesystem')
          )
      );
      expect(toolResultSent).toBe(true);
    } finally {
      await client.stop();
    }
  });

  // SYS-REQ-028, resume-scope case: a custom tool declared at construction
  // and disabled via `disableTools` before the next `sendAndWait()` is
  // actually denied on the live SDK on the second call -- for a
  // handler-backed tool instead of a built-in. Per SYS-REQ-028/028d-1 its
  // schema stays present in `availableTools`/`tools` across the disable;
  // only the permission layer denies it (SYS-REQ-028d), so (unlike the
  // pre-028 `removeTool` behavior) the SDK's own "tool does not exist"
  // fallback should never be the mechanism here.
  it('rejects a real call to a custom tool disabled before resume', { timeout: 30000 }, async () => {
    const snapshotPath = path.resolve(
      process.cwd(),
      'src/test/snapshots/session_wrapper/custom_tool_removeTool_denial.yaml'
    );
    await proxy.updateConfig({ filePath: snapshotPath, workDir: tmpWorkDir });

    const client = makeClient();
    await client.start();
    try {
      const { tool: echoNotesTool, getCallCount } = makeEchoNotesTool();
      const wrapper = makeWrapper(client, { custom: [echoNotesTool] }).setModelName('claude-sonnet-4.5');

      // Turn 1: 'echo_notes' is enabled but the scripted turn doesn't call it yet.
      await wrapper.sendAndWait('Stand by', 15000);

      // Disable the custom tool, then resume with a turn that tries to call it.
      wrapper.disableTools('echo_notes');
      await wrapper.sendAndWait('Check notes.txt with the custom tool again', 15000);

      // The handler itself must never have run post-disable.
      expect(getCallCount()).toBe(0);

      // The live SDK must actually deny the call via our `onPermissionRequest`
      // handler's reject feedback -- the schema is still declared
      // (SYS-REQ-028d-1), so an SDK "tool does not exist" fallback would
      // indicate a spec violation here, not an acceptable alternate path.
      const rejectionSeen = proxy.requestHistory.some(
        (r) =>
          Array.isArray(r.messages) &&
          r.messages.some(
            (m: any) =>
              m.role === 'tool' &&
              typeof m.content === 'string' &&
              m.content.includes("'echo_notes' is not currently enabled for this session")
          )
      );
      expect(rejectionSeen).toBe(true);

      // And the handler's real output must never have leaked into any
      // request -- proof the removal was enforced, not just that our
      // handler was never *asked* to run.
      const realFileLeaked = proxy.requestHistory.some(
        (r) =>
          Array.isArray(r.messages) &&
          r.messages.some(
            (m: any) => m.role === 'tool' && typeof m.content === 'string' && m.content.includes('hello from the real filesystem')
          )
      );
      expect(realFileLeaked).toBe(false);

      // SYS-REQ-028/028d-1: the disable must NOT show up in systemMessage at
      // all -- that field is frozen at session creation and never even
      // re-sent on resume (SYS-REQ-028g), precisely so a disable like this
      // one doesn't bust the prefix/KV cache. Enforcement lives at the
      // permission layer (already asserted above via `rejectionSeen`); the
      // model learns about the disable from the per-turn enablement notice
      // appended to the second turn's user prompt instead (SYS-REQ-028i).
      const completions = proxy.requestHistory.filter((r) => Array.isArray(r.messages));
      expect(completions.length).toBeGreaterThanOrEqual(2);
      const firstSystem = completions[0].messages.find((m: any) => m.role === 'system')?.content ?? '';
      const secondSystem = completions[1].messages.find((m: any) => m.role === 'system')?.content ?? '';
      const secondUser = [...completions[1].messages].reverse().find((m: any) => m.role === 'user')?.content ?? '';

      expect(secondSystem).toBe(firstSystem);
      expect(secondUser).toContain('No tools are currently enabled');
    } finally {
      await client.stop();
    }
  });
});
