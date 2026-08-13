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

  function makeWrapper(client: CopilotClient): SessionWrapper {
    return new SessionWrapper(client, {
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
      const wrapper = makeWrapper(client).setModelName('claude-sonnet-4.5').addTools('view');

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
      const wrapper = makeWrapper(client)
        .setModelName('claude-sonnet-4.5')
        .addTools('bash')
        .setSystemPrompt('Initial prompt marker.');

      await wrapper.sendAndWait('Status check', 15000);

      wrapper.removeTools('bash').addTools('view').setSystemPrompt('Updated prompt marker.');

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
      expect(firstSystem).toContain('Only the following tools may be called: bash.');
      expect(firstSystem).toContain('Initial prompt marker.');
      expect(firstSystem).not.toContain('Updated prompt marker.');

      // #345: the second request's systemMessage must be byte-identical to
      // the first's -- it is frozen at session creation and never
      // re-derived on resume, regardless of what tools/system prompt
      // changed in between (protects the prompt/KV cache prefix).
      expect(secondSystem).toBe(firstSystem);

      // The mutation is instead visible in the re-derived availableTools
      // (still fully live per SYS-REQ-027d, unaffected by this fix) and in
      // a notice appended ahead of the second turn's user prompt.
      expect(secondUser).toContain('Tools added: view');
      expect(secondUser).toContain('Tools removed: bash');
      expect(secondUser).toContain('Additional operating instructions have also been updated');
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
      const wrapper = makeWrapper(client).setModelName('claude-sonnet-4.5').addTools('view');

      // Turn 1: 'view' is allowed but the scripted turn doesn't call it yet.
      await wrapper.sendAndWait('Stand by', 15000);

      // Remove the tool, then resume with a turn that tries to call it.
      wrapper.removeTools('view');
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
              (m.content.includes('is not permitted under this session') || m.content.includes('does not exist'))
          )
      );
      expect(rejectionSeen).toBe(true);

      // And the tool must never have actually executed post-removal: no
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

  // Regression test for a theoretical footgun in BUILTIN_TOOL_PERMISSION_KIND
  // (sessionWrapper.ts): 'view' and 'grep' both map to permission kind
  // 'read', and built-in PermissionRequests carry only `kind`, not a tool
  // name -- so if a bare `kind: 'read'` request ever reached our handler
  // while only 'view' was added, `allowedKinds` (derived from 'view') would
  // approve it, wrongly granting 'grep'. This test locks in that the SDK's
  // own `availableTools` gate is name-based and rejects 'grep' by name
  // BEFORE any kind-based reasoning is possible -- our handler never sees
  // a same-kind ambiguous request in practice. If this test ever starts
  // failing because a same-kind tool call gets approved, that means the SDK
  // changed how it gates 'availableTools' (or a call site started supplying
  // a custom PermissionRequest path that skips it) and the kind-collision
  // gap in `BUILTIN_TOOL_PERMISSION_KIND` has gone from theoretical to real.
  it('does not approve a same-permission-kind tool ("grep") via kind collision when only "view" is allowed', { timeout: 30000 }, async () => {
    const snapshotPath = path.resolve(
      process.cwd(),
      'src/test/snapshots/session_wrapper/kind_collision_denial.yaml'
    );
    await proxy.updateConfig({ filePath: snapshotPath, workDir: tmpWorkDir });

    const client = makeClient();
    await client.start();
    try {
      // Deliberately add only 'view', never 'grep' -- both share permission
      // kind 'read' per BUILTIN_TOOL_PERMISSION_KIND.
      const wrapper = makeWrapper(client).setModelName('claude-sonnet-4.5').addTools('view');

      await wrapper.sendAndWait('Search for TODO in notes.txt using grep', 15000);

      // The live SDK must deny 'grep' outright -- not silently approve it
      // because 'view' (same kind) happens to be allowed.
      const grepDenied = proxy.requestHistory.some(
        (r) =>
          Array.isArray(r.messages) &&
          r.messages.some(
            (m: any) =>
              m.role === 'tool' &&
              typeof m.content === 'string' &&
              (m.content.includes("Tool 'grep' does not exist") || m.content.includes('is not permitted under this session'))
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
      const wrapper = makeWrapper(client).setModelName('claude-sonnet-4.5').addTool(echoNotesTool);

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

  // Issue #345, scope item 2 (resume-scope case): a custom tool added
  // before one `sendAndWait()` and removed via `removeTool` before the next
  // is actually denied on the live SDK on the second call -- mirroring
  // `removeTools_denial.yaml`'s assertions (rejection message seen, the
  // handler's real output never leaked) but for a handler-backed tool
  // instead of a built-in.
  it('rejects a real call to a custom tool removed before resume', { timeout: 30000 }, async () => {
    const snapshotPath = path.resolve(
      process.cwd(),
      'src/test/snapshots/session_wrapper/custom_tool_removeTool_denial.yaml'
    );
    await proxy.updateConfig({ filePath: snapshotPath, workDir: tmpWorkDir });

    const client = makeClient();
    await client.start();
    try {
      const { tool: echoNotesTool, getCallCount } = makeEchoNotesTool();
      const wrapper = makeWrapper(client).setModelName('claude-sonnet-4.5').addTool(echoNotesTool);

      // Turn 1: 'echo_notes' is allowed but the scripted turn doesn't call it yet.
      await wrapper.sendAndWait('Stand by', 15000);

      // Remove the custom tool, then resume with a turn that tries to call it.
      wrapper.removeTool('echo_notes');
      await wrapper.sendAndWait('Check notes.txt with the custom tool again', 15000);

      // The handler itself must never have run post-removal.
      expect(getCallCount()).toBe(0);

      // The live SDK must actually deny the call -- either via our
      // `onPermissionRequest` handler's exact reject feedback, or (as with
      // the built-in `removeTools_denial` case) the SDK's own "tool does
      // not exist" message once the name drops out of `availableTools`.
      const rejectionSeen = proxy.requestHistory.some(
        (r) =>
          Array.isArray(r.messages) &&
          r.messages.some(
            (m: any) =>
              m.role === 'tool' &&
              typeof m.content === 'string' &&
              (m.content.includes("'echo_notes' is not permitted under this session") || m.content.includes('does not exist'))
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

      // Post-#345: removal must NOT show up in the system prompt at all --
      // that prompt is frozen at session creation (SYS-REQ-027k) precisely
      // so a removal like this one doesn't bust the prefix/KV cache.
      // Enforcement lives at the permission layer (already asserted above
      // via `rejectionSeen`); the model learns about the removal from the
      // notice appended to the second turn's user prompt instead.
      const completions = proxy.requestHistory.filter((r) => Array.isArray(r.messages));
      expect(completions.length).toBeGreaterThanOrEqual(2);
      const firstSystem = completions[0].messages.find((m: any) => m.role === 'system')?.content ?? '';
      const secondSystem = completions[1].messages.find((m: any) => m.role === 'system')?.content ?? '';
      const secondUser = [...completions[1].messages].reverse().find((m: any) => m.role === 'user')?.content ?? '';

      expect(firstSystem).toContain('Only the following tools may be called: echo_notes.');
      expect(secondSystem).toBe(firstSystem);
      expect(secondUser).toContain('Tools removed: echo_notes');
    } finally {
      await client.stop();
    }
  });

  // Issue #345, cross-method regression coverage for the reviewer's
  // blocking finding on this PR: `removeTools()` -- the built-in-shaped
  // mutator, not its own counterpart `removeTool()` -- must also clear a
  // custom tool added via `addTool`, keeping `availableTools`, `tools`, and
  // the tool-usage system-prompt section in agreement on the live SDK
  // (SYS-REQ-027h). Mirrors the test above but removes via `removeTools`.
  it('rejects a real call to a custom tool removed via removeTools before resume, and the tool-usage prompt reflects it', { timeout: 30000 }, async () => {
    const snapshotPath = path.resolve(
      process.cwd(),
      'src/test/snapshots/session_wrapper/custom_tool_removeTool_denial.yaml'
    );
    await proxy.updateConfig({ filePath: snapshotPath, workDir: tmpWorkDir });

    const client = makeClient();
    await client.start();
    try {
      const { tool: echoNotesTool, getCallCount } = makeEchoNotesTool();
      const wrapper = makeWrapper(client).setModelName('claude-sonnet-4.5').addTool(echoNotesTool);

      await wrapper.sendAndWait('Stand by', 15000);

      // The reviewer's exact repro: remove a custom tool via removeTools(),
      // not removeTool().
      wrapper.removeTools('echo_notes');
      await wrapper.sendAndWait('Check notes.txt with the custom tool again', 15000);

      expect(getCallCount()).toBe(0);

      const rejectionSeen = proxy.requestHistory.some(
        (r) =>
          Array.isArray(r.messages) &&
          r.messages.some(
            (m: any) =>
              m.role === 'tool' &&
              typeof m.content === 'string' &&
              (m.content.includes("'echo_notes' is not permitted under this session") || m.content.includes('does not exist'))
          )
      );
      expect(rejectionSeen).toBe(true);

      const realFileLeaked = proxy.requestHistory.some(
        (r) =>
          Array.isArray(r.messages) &&
          r.messages.some(
            (m: any) => m.role === 'tool' && typeof m.content === 'string' && m.content.includes('hello from the real filesystem')
          )
      );
      expect(realFileLeaked).toBe(false);

      // Same frozen-prefix check as the removeTool() case above -- proves
      // _customTools was actually cleared by removeTools(), not just
      // _tools, since a stale _customTools entry wouldn't change what
      // availableTools/the notice derive from, but WOULD still show up in
      // the derived `tools` dispatch array (the bug the reviewer flagged).
      const completions = proxy.requestHistory.filter((r) => Array.isArray(r.messages));
      expect(completions.length).toBeGreaterThanOrEqual(2);
      const firstSystem = completions[0].messages.find((m: any) => m.role === 'system')?.content ?? '';
      const secondSystem = completions[1].messages.find((m: any) => m.role === 'system')?.content ?? '';
      const secondUser = [...completions[1].messages].reverse().find((m: any) => m.role === 'user')?.content ?? '';

      expect(firstSystem).toContain('Only the following tools may be called: echo_notes.');
      expect(secondSystem).toBe(firstSystem);
      expect(secondUser).toContain('Tools removed: echo_notes');
    } finally {
      await client.stop();
    }
  });
});
