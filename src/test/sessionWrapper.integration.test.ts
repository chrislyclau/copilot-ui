import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { CapiProxy } from './harness/CapiProxy';
import { CopilotClient } from '../copilotSdk/boundary';
import { SessionWrapper } from '../copilotSdk/sessionWrapper';

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

  // Scope item 2 (SYS-REQ-027h): tool-permission enforcement end-to-end. A
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
  // calls on the same instance and confirms the SECOND real HTTP request to
  // CAPI reflects the new config, not the config the session was created
  // with -- the live-SDK counterpart to #328's footgun regression coverage
  // for issue #208 (resume dropping `systemMessage`).
  it('re-derives config on resume so a live session sees the post-mutation tools/system prompt', { timeout: 30000 }, async () => {
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
        .setSystemPrompt({ mode: 'append', content: 'Initial prompt marker.' });

      await wrapper.sendAndWait('Status check', 15000);

      wrapper.removeTools('bash').addTools('view').setSystemPrompt({ mode: 'append', content: 'Updated prompt marker.' });

      await wrapper.sendAndWait('Status check', 15000);

      const completions = proxy.requestHistory.filter((r) => Array.isArray(r.messages));
      expect(completions.length).toBeGreaterThanOrEqual(2);

      const firstSystem = completions[0].messages.find((m: any) => m.role === 'system')?.content ?? '';
      const secondSystem = completions[1].messages.find((m: any) => m.role === 'system')?.content ?? '';

      // Match SessionWrapper's own tool-usage sentence (buildToolUsageSection
      // in sessionWrapper.ts) rather than a bare substring like "bash" --
      // the SDK's own boilerplate instructions mention built-in tool names
      // generically, which would make a bare substring check pass
      // regardless of what SessionWrapper actually derived.
      expect(firstSystem).toContain('Only the following tools may be called: bash.');
      expect(firstSystem).toContain('Initial prompt marker.');
      expect(firstSystem).not.toContain('Updated prompt marker.');

      // The live SDK's second request must carry the re-derived config, not
      // the one the session was created with.
      expect(secondSystem).toContain('Only the following tools may be called: view.');
      expect(secondSystem).not.toContain('Only the following tools may be called: bash.');
      expect(secondSystem).toContain('Updated prompt marker.');
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
});
