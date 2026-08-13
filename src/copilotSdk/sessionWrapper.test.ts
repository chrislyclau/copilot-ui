import { describe, it, expect, vi } from 'vitest';
import { SessionWrapper } from './sessionWrapper';
import type { CopilotClient, CopilotSession, PermissionRequest, SessionConfig } from './boundary';

/**
 * Minimal fake `CopilotClient`: records every `createSession`/`resumeSession`
 * call's config and hands back a fake session whose `sessionId` increments,
 * so tests can assert on create-vs-resume decisions and on exactly what
 * config was passed, without touching the real SDK.
 */
type FakeConfig = SessionConfig & { autoApproveAll?: boolean };

function fakeClient(): {
  client: CopilotClient;
  createCalls: FakeConfig[];
  resumeCalls: { sessionId: string; config: FakeConfig }[];
  sessions: CopilotSession[];
} {
  const createCalls: FakeConfig[] = [];
  const resumeCalls: { sessionId: string; config: FakeConfig }[] = [];
  const sessions: CopilotSession[] = [];
  let nextId = 0;

  function fakeSession(sessionId: string): CopilotSession {
    const session = {
      sessionId,
      sendAndWait: vi.fn().mockResolvedValue(undefined),
    } as unknown as CopilotSession;
    sessions.push(session);
    return session;
  }

  const client = {
    createSession: vi.fn(async (config: FakeConfig) => {
      createCalls.push(config);
      return fakeSession(`session-${nextId++}`);
    }),
    resumeSession: vi.fn(async (sessionId: string, config: FakeConfig) => {
      resumeCalls.push({ sessionId, config });
      return fakeSession(sessionId);
    }),
  } as unknown as CopilotClient;

  return { client, createCalls, resumeCalls, sessions };
}

function shellRequest(): PermissionRequest {
  return { kind: 'shell' } as PermissionRequest;
}

function readRequest(): PermissionRequest {
  return { kind: 'read' } as PermissionRequest;
}

function customToolRequest(toolName: string): PermissionRequest {
  return { kind: 'custom-tool', toolName } as PermissionRequest;
}

function fakeTool(name: string) {
  return {
    name,
    description: `fake tool ${name}`,
    parameters: {},
    handler: vi.fn(async () => 'ok'),
  };
}

describe('SessionWrapper._createConfig', () => {
  it('with zero tools: denies every candidate and reports no availableTools', async () => {
    const wrapper = new SessionWrapper();
    const config = wrapper._createConfig();

    expect(config.availableTools).toEqual([]);
    expect(config.autoApproveAll).toBe(false);
    await expect(config.onPermissionRequest(shellRequest(), { sessionId: 's1' })).resolves.toMatchObject({
      kind: 'reject',
    });
    expect(typeof config.systemMessage === 'object' ? config.systemMessage?.content : '').toContain(
      'No tools are available'
    );
  });

  it('with one built-in tool: system-prompt section, availableTools, and permission never disagree', async () => {
    const wrapper = new SessionWrapper().addTools('bash');
    const config = wrapper._createConfig();

    expect(config.availableTools).toEqual(['bash']);
    expect(config.systemMessage?.content).toContain('bash');
    await expect(config.onPermissionRequest(shellRequest(), { sessionId: 's1' })).resolves.toEqual({
      kind: 'approve-once',
    });
    // A candidate not in the tool list is still denied.
    await expect(config.onPermissionRequest(readRequest(), { sessionId: 's1' })).resolves.toMatchObject({
      kind: 'reject',
    });
  });

  it('with N mixed built-in and custom tools: every candidate resolves consistently', async () => {
    const wrapper = new SessionWrapper().addTools('bash', 'view', 'grep', 'glob', 'edit', 'my_custom_tool');
    const config = wrapper._createConfig();

    expect(config.availableTools).toEqual(['bash', 'view', 'grep', 'glob', 'edit', 'my_custom_tool']);
    for (const req of [shellRequest(), readRequest(), customToolRequest('my_custom_tool')]) {
      await expect(config.onPermissionRequest(req, { sessionId: 's1' })).resolves.toEqual({
        kind: 'approve-once',
      });
    }
    await expect(config.onPermissionRequest(customToolRequest('unlisted_tool'), { sessionId: 's1' })).resolves.toMatchObject({
      kind: 'reject',
    });
  });

  it('approval is per-call, not a standing grant: repeated calls to an allowed tool are each independently approved', async () => {
    const wrapper = new SessionWrapper().addTools('bash');
    const config = wrapper._createConfig();

    await expect(config.onPermissionRequest(shellRequest(), { sessionId: 's1' })).resolves.toEqual({
      kind: 'approve-once',
    });
    await expect(config.onPermissionRequest(shellRequest(), { sessionId: 's1' })).resolves.toEqual({
      kind: 'approve-once',
    });
  });

  it('removeTools denies the tool once _createConfig is re-derived (next-turn semantics)', async () => {
    const wrapper = new SessionWrapper().addTools('bash');
    const firstTurnConfig = wrapper._createConfig();
    await expect(firstTurnConfig.onPermissionRequest(shellRequest(), { sessionId: 's1' })).resolves.toEqual({
      kind: 'approve-once',
    });

    wrapper.removeTools('bash');
    const nextTurnConfig = wrapper._createConfig();
    expect(nextTurnConfig.availableTools).toEqual([]);
    await expect(nextTurnConfig.onPermissionRequest(shellRequest(), { sessionId: 's1' })).resolves.toMatchObject({
      kind: 'reject',
    });
  });

  it('addTool: availableTools, tools array, and permission for the custom tool never disagree', async () => {
    const tool = fakeTool('run_gh_command');
    const wrapper = new SessionWrapper().addTool(tool);
    const config = wrapper._createConfig();

    expect(config.availableTools).toEqual(['run_gh_command']);
    expect(config.tools).toEqual([tool]);
    expect(config.systemMessage?.content).toContain('run_gh_command');
    await expect(
      config.onPermissionRequest(customToolRequest('run_gh_command'), { sessionId: 's1' })
    ).resolves.toEqual({ kind: 'approve-once' });
  });

  it('addTool alongside built-ins: both show up in availableTools and tools carries only the handler-backed one', () => {
    const tool = fakeTool('submit_clarity_check');
    const wrapper = new SessionWrapper().addTools('bash', 'view').addTool(tool);
    const config = wrapper._createConfig();

    expect(config.availableTools).toEqual(['bash', 'view', 'submit_clarity_check']);
    expect(config.tools).toEqual([tool]);
  });

  it('removeTool denies the custom tool once _createConfig is re-derived (next-turn semantics)', async () => {
    const tool = fakeTool('run_gh_command');
    const wrapper = new SessionWrapper().addTool(tool);
    const firstTurnConfig = wrapper._createConfig();
    await expect(
      firstTurnConfig.onPermissionRequest(customToolRequest('run_gh_command'), { sessionId: 's1' })
    ).resolves.toEqual({ kind: 'approve-once' });

    wrapper.removeTool('run_gh_command');
    const nextTurnConfig = wrapper._createConfig();
    expect(nextTurnConfig.availableTools).toEqual([]);
    expect(nextTurnConfig.tools).toEqual([]);
    await expect(
      nextTurnConfig.onPermissionRequest(customToolRequest('run_gh_command'), { sessionId: 's1' })
    ).resolves.toMatchObject({ kind: 'reject' });
  });

  it('removeTool on a name never added is a no-op', () => {
    const wrapper = new SessionWrapper().addTools('bash').removeTool('never_added');
    const config = wrapper._createConfig();
    expect(config.availableTools).toEqual(['bash']);
    expect(config.tools).toEqual([]);
  });

  // Regression test for the reviewer's blocking finding on this PR
  // (SYS-REQ-027h): a custom tool added via `addTool` but removed via the
  // built-in-shaped `removeTools` -- not its own counterpart `removeTool` --
  // must not leave `_customTools` stale. Before the fix, this left
  // `availableTools: []` (derived from `_tools`) disagreeing with
  // `tools: [tool]` (derived from `_customTools`): a handler-backed tool
  // still in the SDK-dispatch array despite being absent from the
  // permission allowlist and system-prompt tool section.
  it('removeTools also clears a custom tool added via addTool, keeping availableTools/tools/permission in agreement', async () => {
    const tool = fakeTool('run_gh_command');
    const wrapper = new SessionWrapper().addTool(tool).removeTools('run_gh_command');
    const config = wrapper._createConfig();

    expect(config.availableTools).toEqual([]);
    expect(config.tools).toEqual([]);
    await expect(
      config.onPermissionRequest(customToolRequest('run_gh_command'), { sessionId: 's1' })
    ).resolves.toMatchObject({ kind: 'reject' });
  });

  it('removeTools only removes the named custom tool, leaving other addTool entries and built-ins intact', () => {
    const keep = fakeTool('submit_clarity_check');
    const drop = fakeTool('run_gh_command');
    const wrapper = new SessionWrapper()
      .addTools('bash')
      .addTool(keep)
      .addTool(drop)
      .removeTools('run_gh_command');
    const config = wrapper._createConfig();

    expect(config.availableTools).toEqual(['bash', 'submit_clarity_check']);
    expect(config.tools).toEqual([keep]);
  });

  it('forces systemMessage into replace mode even with no caller-supplied system prompt (issue #345 follow-up: append/customize modes still let the SDK inject a live-tool-derived section)', () => {
    const config = new SessionWrapper().addTools('bash')._createConfig();
    expect(config.systemMessage?.mode).toBe('replace');
    expect(config.systemMessage?.content).toContain('bash');
  });

  it('folds tool guidance into a caller-supplied system prompt without dropping caller content, still forced into replace mode', () => {
    const wrapper = new SessionWrapper().addTools('bash').setSystemPrompt('be terse');
    const config = wrapper._createConfig();
    expect(config.systemMessage?.mode).toBe('replace');
    expect(config.systemMessage?.content).toContain('be terse');
    expect(config.systemMessage?.content).toContain('bash');
  });

  it('passes _modelName through to the derived config', () => {
    const config = new SessionWrapper().setModelName('claude-sonnet-4.5')._createConfig();
    expect(config.model).toBe('claude-sonnet-4.5');
  });
});

describe('SessionWrapper.sendAndWait', () => {
  it('creates on the first call, resumes on subsequent calls against the same instance', async () => {
    const { client, createCalls, resumeCalls } = fakeClient();
    const wrapper = new SessionWrapper(client).addTools('bash').setModelName('claude-sonnet-4.5');

    await wrapper.sendAndWait('hello');
    expect(createCalls).toHaveLength(1);
    expect(resumeCalls).toHaveLength(0);

    await wrapper.sendAndWait('hello again');
    expect(createCalls).toHaveLength(1);
    expect(resumeCalls).toHaveLength(1);
    expect(resumeCalls[0]?.sessionId).toBe('session-0');
  });

  it('produces no caller-visible config difference between the create call and a resume call', async () => {
    const { client, createCalls, resumeCalls } = fakeClient();
    const wrapper = new SessionWrapper(client)
      .addTools('bash', 'view')
      .setSystemPrompt('be terse')
      .setModelName('claude-sonnet-4.5');

    await wrapper.sendAndWait('turn one');
    await wrapper.sendAndWait('turn two');

    const created = createCalls[0];
    const resumed = resumeCalls[0]?.config;
    expect(resumed?.availableTools).toEqual(created?.availableTools);
    expect(resumed?.systemMessage).toEqual(created?.systemMessage);
    expect(resumed?.autoApproveAll).toBe(created?.autoApproveAll);
  });

  it('re-derives config on resume: a tool added between calls is present on the resumed config, not stale', async () => {
    const { client, resumeCalls } = fakeClient();
    const wrapper = new SessionWrapper(client).addTools('bash').setModelName('claude-sonnet-4.5');

    await wrapper.sendAndWait('turn one');
    wrapper.addTools('view');
    await wrapper.sendAndWait('turn two');

    expect(resumeCalls[0]?.config.availableTools).toEqual(['bash', 'view']);
  });

  it('re-derives config on resume: a tool removed between calls is absent from the resumed config', async () => {
    const { client, resumeCalls } = fakeClient();
    const wrapper = new SessionWrapper(client).addTools('bash', 'view').setModelName('claude-sonnet-4.5');

    await wrapper.sendAndWait('turn one');
    wrapper.removeTools('view');
    await wrapper.sendAndWait('turn two');

    expect(resumeCalls[0]?.config.availableTools).toEqual(['bash']);
  });

  it('addTool called after the session has started is never rejected and the handler-backed tool applies next turn (SYS-REQ-027f)', async () => {
    const { client, createCalls, resumeCalls } = fakeClient();
    const tool = fakeTool('run_gh_command');
    const wrapper = new SessionWrapper(client).setModelName('claude-sonnet-4.5');

    await wrapper.sendAndWait('turn one');
    expect(() => wrapper.addTool(tool)).not.toThrow();
    await wrapper.sendAndWait('turn two');

    expect(createCalls[0]?.tools).toEqual([]);
    expect(resumeCalls[0]?.config.tools).toEqual([tool]);
    expect(resumeCalls[0]?.config.availableTools).toEqual(['run_gh_command']);
  });

  it('setSystemPrompt called after the session has started is never rejected, but does not touch the frozen resumed systemMessage (SYS-REQ-027f/k) -- it reaches the model via the appended notice instead', async () => {
    const { client, createCalls, resumeCalls, sessions } = fakeClient();
    const wrapper = new SessionWrapper(client).addTools('bash').setModelName('claude-sonnet-4.5');

    await wrapper.sendAndWait('turn one');
    expect(() => wrapper.setSystemPrompt('be terse')).not.toThrow();
    await wrapper.sendAndWait('turn two');

    // The resumed systemMessage is byte-identical to the create call's --
    // 'be terse' never appears there (SYS-REQ-027k).
    expect(resumeCalls[0]?.config.systemMessage).toEqual(createCalls[0]?.systemMessage);
    // Instead, the change is relayed as a notice appended to the prompt.
    // `sessions[0]` backs the create call ('turn one'); `sessions[1]` backs
    // the resume call ('turn two') -- the fake hands back a fresh session
    // object per call, mirroring the real client/session split.
    const resumedSendAndWait = sessions[1]?.sendAndWait as ReturnType<typeof vi.fn>;
    const secondPrompt = resumedSendAndWait.mock.calls[0]?.[0];
    expect(secondPrompt).toContain('Additional operating instructions have also been updated');
    expect(secondPrompt).toContain('turn two');
  });

  it('setModelName called after the session has started is never rejected and applies next turn (SYS-REQ-027f)', async () => {
    const { client, createCalls, resumeCalls } = fakeClient();
    const wrapper = new SessionWrapper(client).addTools('bash').setModelName('claude-sonnet-4.5');

    await wrapper.sendAndWait('turn one');
    expect(() => wrapper.setModelName('claude-opus-4.8')).not.toThrow();
    await wrapper.sendAndWait('turn two');

    expect(createCalls[0]?.model).toBe('claude-sonnet-4.5');
    expect(resumeCalls[0]?.config.model).toBe('claude-opus-4.8');
  });

  it('throws a clear error rather than calling the SDK when no client was supplied', async () => {
    const wrapper = new SessionWrapper().addTools('bash').setModelName('claude-sonnet-4.5');
    await expect(wrapper.sendAndWait('hello')).rejects.toThrow(/no CopilotClient/);
  });

  it('throws a clear error rather than silently dropping model when no model name was set', async () => {
    const { client } = fakeClient();
    const wrapper = new SessionWrapper(client).addTools('bash');
    await expect(wrapper.sendAndWait('hello')).rejects.toThrow(/no model name was set/);
  });

  it('_baseConfig fields survive the create config merge alongside a set model', async () => {
    const { client, createCalls } = fakeClient();
    const wrapper = new SessionWrapper(client, { workingDirectory: '/tmp/work' })
      .addTools('bash')
      .setModelName('claude-sonnet-4.5');

    await wrapper.sendAndWait('hello');

    expect(createCalls[0]?.workingDirectory).toBe('/tmp/work');
    expect(createCalls[0]?.model).toBe('claude-sonnet-4.5');
  });
});

describe('SessionWrapper SDK-footgun regression tests', () => {
  it('never drops systemMessage on resume (issue #208: resumeSession does not inherit it from the SDK)', async () => {
    const { client, createCalls, resumeCalls } = fakeClient();
    const wrapper = new SessionWrapper(client)
      .addTools('bash')
      .setSystemPrompt('be terse')
      .setModelName('claude-sonnet-4.5');

    await wrapper.sendAndWait('turn one');
    await wrapper.sendAndWait('turn two');

    // The regression this guards: resumeSession does not inherit systemMessage
    // from the session being resumed, so a resumeConfig that forgets to
    // re-pass it silently loses it. SessionWrapper always re-derives and
    // re-passes systemMessage explicitly, so it must be present -- and equal
    // to the create call's -- on every resume, not just the first turn.
    expect(createCalls[0]?.systemMessage).toBeDefined();
    expect(resumeCalls[0]?.config.systemMessage).toBeDefined();
    expect(resumeCalls[0]?.config.systemMessage).toEqual(createCalls[0]?.systemMessage);
  });

  it('always forces systemMessage into replace mode -- no mode/sections choice reaches the SDK -- and stays byte-identical across a tool-list change (issue #345 follow-up: append/customize modes still let the SDK inject a live-tool-derived section, which is exactly what replace mode exists to prevent)', async () => {
    const { client, createCalls, resumeCalls, sessions } = fakeClient();
    const wrapper = new SessionWrapper(client)
      .addTools('bash')
      .setSystemPrompt('you are an auditor')
      .setModelName('claude-sonnet-4.5');

    await wrapper.sendAndWait('turn one');
    wrapper.addTools('view'); // changes the tool list between calls
    await wrapper.sendAndWait('turn two');

    // #345 follow-up: `_createConfig()` no longer offers append/customize at
    // all -- every session, regardless of what the caller passed to
    // `setSystemPrompt`, gets `mode: 'replace'` so nothing SDK-managed (in
    // particular no live-`availableTools`-derived tool_instructions section)
    // rides along in the outgoing systemMessage. The entire object -- mode
    // and content -- must still be byte-identical create-to-resume. The
    // tool-list change is instead visible in `availableTools` (still
    // re-derived, see the SYS-REQ-027d test above) and relayed to the model
    // via a notice appended to the resumed turn's prompt (SYS-REQ-027k).
    const created = createCalls[0]?.systemMessage;
    const resumed = resumeCalls[0]?.config.systemMessage;
    expect(resumed).toEqual(created);
    expect(created?.mode).toBe('replace');
    expect(created?.mode === 'replace' ? created.content : '').toContain('bash');
    expect(created?.mode === 'replace' ? created.content : '').toContain('you are an auditor');

    const resumedSendAndWait = sessions[1]?.sendAndWait as ReturnType<typeof vi.fn>;
    const secondPrompt = resumedSendAndWait.mock.calls[0]?.[0];
    expect(secondPrompt).toContain('Tools added: view');
  });
});

describe('SessionWrapper resume update notice (SYS-REQ-027k, issue #345)', () => {
  it('appends no notice when nothing changed between turns', async () => {
    const { client, sessions } = fakeClient();
    const wrapper = new SessionWrapper(client).addTools('bash').setModelName('claude-sonnet-4.5');

    await wrapper.sendAndWait('turn one');
    await wrapper.sendAndWait('turn two');

    const resumedSendAndWait = sessions[1]?.sendAndWait as ReturnType<typeof vi.fn>;
    expect(resumedSendAndWait.mock.calls[0]?.[0]).toBe('turn two');
  });

  it('reports both additions and removals in the same notice', async () => {
    const { client, sessions } = fakeClient();
    const wrapper = new SessionWrapper(client).addTools('bash', 'view').setModelName('claude-sonnet-4.5');

    await wrapper.sendAndWait('turn one');
    wrapper.addTools('grep').removeTools('view');
    await wrapper.sendAndWait('turn two');

    const resumedSendAndWait = sessions[1]?.sendAndWait as ReturnType<typeof vi.fn>;
    const secondPrompt = resumedSendAndWait.mock.calls[0]?.[0] as string;
    expect(secondPrompt).toContain('Tools added: grep');
    expect(secondPrompt).toContain('Tools removed: view');
    expect(secondPrompt.endsWith('turn two')).toBe(true);
  });

  it('prepends the notice into MessageOptions.prompt rather than dropping the rest of the options', async () => {
    const { client, sessions } = fakeClient();
    const wrapper = new SessionWrapper(client).addTools('bash').setModelName('claude-sonnet-4.5');

    await wrapper.sendAndWait('turn one');
    wrapper.addTools('view');
    await wrapper.sendAndWait({ prompt: 'turn two', attachments: [{ type: 'file', path: '/tmp/x.txt' }] } as never);

    const resumedSendAndWait = sessions[1]?.sendAndWait as ReturnType<typeof vi.fn>;
    const secondOptions = resumedSendAndWait.mock.calls[0]?.[0] as { prompt: string; attachments: unknown[] };
    expect(secondOptions.prompt).toContain('Tools added: view');
    expect(secondOptions.prompt.endsWith('turn two')).toBe(true);
    expect(secondOptions.attachments).toEqual([{ type: 'file', path: '/tmp/x.txt' }]);
  });
});

describe('SessionWrapper side-door surface (SYS-REQ-027g)', () => {
  it('exposes no method that could bind policy/config to a session it did not create', () => {
    // Enumerates the intended public API. If a `registerSessionPolicy`-style
    // side door is ever added, this list must grow to match it -- catching
    // that as a deliberate, reviewable diff rather than a silent addition.
    const allowedPublicMethods = new Set([
      'addTools',
      'removeTools',
      'addTool',
      'removeTool',
      'setSystemPrompt',
      'setModelName',
      'sendAndWait',
    ]);
    // `_createConfig` is intentionally public (tests call it directly) but is
    // a pure derivation from own state, not an adoption mechanism -- excluded
    // from `allowedPublicMethods` on purpose so it's visible here as the one
    // deliberate exception rather than silently allowed by the loop below.
    const excludedFromCheck = new Set(['constructor', '_createConfig']);

    const actualMethods = Object.getOwnPropertyNames(SessionWrapper.prototype).filter(
      (name) => !excludedFromCheck.has(name)
    );

    for (const name of actualMethods) {
      expect(allowedPublicMethods.has(name)).toBe(true);
    }
    expect(actualMethods.sort()).toEqual([...allowedPublicMethods].sort());
  });
});
