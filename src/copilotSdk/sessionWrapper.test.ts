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

describe('SessionWrapper._createConfig (SYS-REQ-028/028a/028d-1: schema is fixed at construction)', () => {
  it('with zero tools: availableTools is empty and every candidate is denied', async () => {
    const wrapper = new SessionWrapper();
    const config = wrapper._createConfig();

    expect(config.availableTools).toEqual([]);
    expect(config.autoApproveAll).toBe(false);
    await expect(config.onPermissionRequest(shellRequest(), { sessionId: 's1' })).resolves.toMatchObject({
      kind: 'reject',
    });
  });

  it('with one built-in tool: availableTools and permission agree, and both stay true after a later disableTools call (028/028d-1)', async () => {
    const wrapper = new SessionWrapper(undefined, { builtins: ['bash'] });
    const config = wrapper._createConfig();

    expect(config.availableTools).toEqual(['bash']);
    await expect(config.onPermissionRequest(shellRequest(), { sessionId: 's1' })).resolves.toEqual({
      kind: 'approve-once',
    });
    await expect(config.onPermissionRequest(readRequest(), { sessionId: 's1' })).resolves.toMatchObject({
      kind: 'reject',
    });

    // Disabling the tool must NOT change the wire-level schema (028/028d-1):
    // availableTools is re-read fresh below and must still list 'bash'.
    wrapper.disableTools('bash');
    const configAfterDisable = wrapper._createConfig();
    expect(configAfterDisable.availableTools).toEqual(['bash']);
    // But the permission layer now denies it (028d).
    await expect(
      configAfterDisable.onPermissionRequest(shellRequest(), { sessionId: 's1' })
    ).resolves.toMatchObject({ kind: 'reject' });
  });

  it('with N mixed built-in and custom tools: every candidate resolves consistently', async () => {
    const tool = fakeTool('my_custom_tool');
    const wrapper = new SessionWrapper(undefined, {
      builtins: ['bash', 'view', 'grep', 'glob', 'edit'],
      custom: [tool],
    });
    const config = wrapper._createConfig();

    expect(config.availableTools).toEqual(['bash', 'view', 'grep', 'glob', 'edit', 'my_custom_tool']);
    expect(config.tools).toEqual([tool]);
    for (const req of [shellRequest(), readRequest(), customToolRequest('my_custom_tool')]) {
      await expect(config.onPermissionRequest(req, { sessionId: 's1' })).resolves.toEqual({
        kind: 'approve-once',
      });
    }
    await expect(config.onPermissionRequest(customToolRequest('unlisted_tool'), { sessionId: 's1' })).resolves.toMatchObject({
      kind: 'reject',
    });
  });

  it('approval is per-call, not a standing grant: repeated calls to an enabled tool are each independently approved', async () => {
    const wrapper = new SessionWrapper(undefined, { builtins: ['bash'] });
    const config = wrapper._createConfig();

    await expect(config.onPermissionRequest(shellRequest(), { sessionId: 's1' })).resolves.toEqual({
      kind: 'approve-once',
    });
    await expect(config.onPermissionRequest(shellRequest(), { sessionId: 's1' })).resolves.toEqual({
      kind: 'approve-once',
    });
  });

  it('all construction-time tools are enabled by default (SYS-REQ-028c)', async () => {
    const wrapper = new SessionWrapper(undefined, { builtins: ['bash', 'view'] });
    const config = wrapper._createConfig();

    await expect(config.onPermissionRequest(shellRequest(), { sessionId: 's1' })).resolves.toEqual({
      kind: 'approve-once',
    });
    await expect(config.onPermissionRequest(readRequest(), { sessionId: 's1' })).resolves.toEqual({
      kind: 'approve-once',
    });
  });
});

describe('SessionWrapper.enableTools/disableTools (SYS-REQ-028b/028c)', () => {
  it('disableTools denies at the permission layer without touching availableTools/tools', async () => {
    const wrapper = new SessionWrapper(undefined, { builtins: ['bash'] });
    wrapper.disableTools('bash');
    const config = wrapper._createConfig();

    expect(config.availableTools).toEqual(['bash']);
    await expect(config.onPermissionRequest(shellRequest(), { sessionId: 's1' })).resolves.toMatchObject({
      kind: 'reject',
    });
  });

  it('enableTools re-allows a previously-disabled tool', async () => {
    const wrapper = new SessionWrapper(undefined, { builtins: ['bash'] });
    wrapper.disableTools('bash').enableTools('bash');
    const config = wrapper._createConfig();

    await expect(config.onPermissionRequest(shellRequest(), { sessionId: 's1' })).resolves.toEqual({
      kind: 'approve-once',
    });
  });

  it('a custom tool can be disabled and re-enabled the same way as a built-in', async () => {
    const tool = fakeTool('run_gh_command');
    const wrapper = new SessionWrapper(undefined, { custom: [tool] });
    wrapper.disableTools('run_gh_command');
    const config = wrapper._createConfig();

    // Schema stays present regardless of enablement (028/028d).
    expect(config.availableTools).toEqual(['run_gh_command']);
    expect(config.tools).toEqual([tool]);
    await expect(
      config.onPermissionRequest(customToolRequest('run_gh_command'), { sessionId: 's1' })
    ).resolves.toMatchObject({ kind: 'reject' });
  });

  it('throws synchronously on an unknown tool name and applies no partial state change (SYS-REQ-028b)', () => {
    const wrapper = new SessionWrapper(undefined, { builtins: ['bash', 'view'] });

    expect(() => wrapper.disableTools('bash', 'unknown_tool')).toThrow(/unknown tool/);

    // 'bash' must still be enabled -- the throw happened before any mutation
    // was applied, not partway through the name list.
    const config = wrapper._createConfig();
    return expect(config.onPermissionRequest(shellRequest(), { sessionId: 's1' })).resolves.toEqual({
      kind: 'approve-once',
    });
  });

  it('enableTools with an unknown name also throws synchronously, atomically', () => {
    const wrapper = new SessionWrapper(undefined, { builtins: ['bash'] });
    wrapper.disableTools('bash');

    expect(() => wrapper.enableTools('bash', 'unknown_tool')).toThrow(/unknown tool/);

    // 'bash' must still be disabled -- the earlier disableTools call is not
    // undone by the partially-attempted enableTools call.
    const config = wrapper._createConfig();
    return expect(config.onPermissionRequest(shellRequest(), { sessionId: 's1' })).resolves.toMatchObject({
      kind: 'reject',
    });
  });

  it('a name never supplied at construction cannot be enabled -- there is no post-construction way to add a tool (SYS-REQ-028a)', () => {
    const wrapper = new SessionWrapper(undefined, { builtins: ['bash'] });
    expect(() => wrapper.enableTools('view')).toThrow(/unknown tool/);
    expect(wrapper._createConfig().availableTools).toEqual(['bash']);
  });
});

describe('SessionWrapper.sendAndWait: construction/resume lifecycle (SYS-REQ-028e/028f/028g)', () => {
  it('the first call always creates; a second call on the same instance resumes', async () => {
    const { client, createCalls, resumeCalls } = fakeClient();
    const wrapper = new SessionWrapper(client, { builtins: ['bash'] }).setModelName('claude-sonnet-4.5');

    await wrapper.sendAndWait('turn one');
    expect(createCalls).toHaveLength(1);
    expect(resumeCalls).toHaveLength(0);

    await wrapper.sendAndWait('turn two');
    expect(createCalls).toHaveLength(1);
    expect(resumeCalls).toHaveLength(1);
    expect(resumeCalls[0]?.sessionId).toBe('session-0');
  });

  it('resume sends onPermissionRequest, autoApproveAll: false, and the SDK-mandatory tools/availableTools/systemMessage -- no model or other base-config fields (SYS-REQ-028g)', async () => {
    const { client, resumeCalls } = fakeClient();
    const wrapper = new SessionWrapper(client, { builtins: ['bash'] }, { workingDirectory: '/tmp/work' })
      .setSystemPrompt('be terse')
      .setModelName('claude-sonnet-4.5');

    await wrapper.sendAndWait('turn one');
    await wrapper.sendAndWait('turn two');

    const resumeConfig = resumeCalls[0]?.config;
    expect(resumeConfig?.onPermissionRequest).toBeDefined();
    // autoApproveAll: false must ride along -- CopilotClient's own
    // resumeSession override (boundary.ts) defaults it to true when
    // omitted, which would silently replace onPermissionRequest with an
    // auto-approve-everything handler and defeat SYS-REQ-028d entirely.
    expect(resumeConfig?.autoApproveAll).toBe(false);
    // systemMessage IS resent on resume: `resumeSession` does not inherit it
    // from the session being resumed (AGENTS.md, "resumeSession() drops the
    // system prompt unless you re-pass it"; boundary.ts docstring on
    // `CopilotClient.resumeSession`; issue #208). Omitting it here would
    // silently fall back to the SDK's default system prompt for the rest of
    // the turn.
    expect(Object.keys(resumeConfig ?? {}).sort()).toEqual([
      'autoApproveAll',
      'availableTools',
      'onPermissionRequest',
      'systemMessage',
      'tools',
    ]);
  });

  it('the wire-level tools schema is byte-identical between create and every resume, even after enableTools/disableTools (SYS-REQ-028/028a)', async () => {
    const { client, createCalls, resumeCalls } = fakeClient();
    const wrapper = new SessionWrapper(client, { builtins: ['bash', 'view'] }).setModelName('claude-sonnet-4.5');

    await wrapper.sendAndWait('turn one');
    wrapper.disableTools('bash').enableTools('bash').disableTools('view');
    await wrapper.sendAndWait('turn two');

    // `tools`/`availableTools` ARE resent on resume (SYS-REQ-028g's SDK-
    // requires-it carve-out, see previous test) -- but their VALUE must
    // still be byte-identical to what create sent, never narrowed to the
    // enabled subset, regardless of the enableTools/disableTools calls in
    // between (SYS-REQ-028/028a/028d-1).
    expect(createCalls[0]?.availableTools).toEqual(['bash', 'view']);
    expect(resumeCalls[0]?.config?.availableTools).toEqual(['bash', 'view']);
    expect(resumeCalls[0]?.config?.tools).toEqual(createCalls[0]?.tools);
  });
});

describe('SessionWrapper.sendAndWait: systemMessage (SYS-REQ-028h)', () => {
  it('is sent in customize mode, carrying the caller instructions, and resent byte-identical on resume', async () => {
    const { client, createCalls, resumeCalls } = fakeClient();
    const wrapper = new SessionWrapper(client, { builtins: ['bash'] })
      .setSystemPrompt('you are an auditor')
      .setModelName('claude-sonnet-4.5');

    await wrapper.sendAndWait('turn one');
    await wrapper.sendAndWait('turn two');

    expect(createCalls[0]?.systemMessage?.mode).toBe('customize');
    expect(createCalls[0]?.systemMessage?.content).toContain('you are an auditor');
    // `resumeSession` does not inherit `systemMessage` from the session
    // being resumed (issue #208 / AGENTS.md) -- it falls into the same
    // "SDK requires it re-sent" carve-out as `tools`/`availableTools`, so it
    // must be resent here byte-identical to what creation sent, frozen for
    // the session's life (SYS-REQ-028l).
    expect(resumeCalls[0]?.config.systemMessage).toEqual(createCalls[0]?.systemMessage);
  });

  it('stays byte-identical across every resume even if setSystemPrompt is called again mid-session', async () => {
    const { client, createCalls, resumeCalls } = fakeClient();
    const wrapper = new SessionWrapper(client, { builtins: ['bash'] })
      .setSystemPrompt('initial')
      .setModelName('claude-sonnet-4.5');

    await wrapper.sendAndWait('turn one');
    wrapper.setSystemPrompt('changed');
    await wrapper.sendAndWait('turn two');
    await wrapper.sendAndWait('turn three');

    expect(resumeCalls[0]?.config.systemMessage).toEqual(createCalls[0]?.systemMessage);
    expect(resumeCalls[1]?.config.systemMessage).toEqual(createCalls[0]?.systemMessage);
    expect(resumeCalls[0]?.config.systemMessage?.content).not.toContain('changed');
  });

  it('setSystemPrompt after the session has started does not change what was already frozen at creation', async () => {
    const { client, createCalls } = fakeClient();
    const wrapper = new SessionWrapper(client, { builtins: ['bash'] })
      .setSystemPrompt('initial')
      .setModelName('claude-sonnet-4.5');

    await wrapper.sendAndWait('turn one');
    wrapper.setSystemPrompt('changed');

    expect(createCalls[0]?.systemMessage?.content).toContain('initial');
    expect(wrapper._createConfig().systemMessage?.content).toContain('initial');
    expect(wrapper._createConfig().systemMessage?.content).not.toContain('changed');
  });
});

describe('SessionWrapper.sendAndWait: per-turn enablement notice (SYS-REQ-028i/028l)', () => {
  it('is prepended on the very first turn, before any mutation has happened', async () => {
    const { client, sessions } = fakeClient();
    const wrapper = new SessionWrapper(client, { builtins: ['bash', 'view'] }).setModelName('claude-sonnet-4.5');

    await wrapper.sendAndWait('turn one');

    const firstSendAndWait = sessions[0]?.sendAndWait as ReturnType<typeof vi.fn>;
    const firstPrompt = firstSendAndWait.mock.calls[0]?.[0] as string;
    expect(firstPrompt).toContain('Tools enabled this turn');
    expect(firstPrompt).toContain('bash, view');
    expect(firstPrompt.endsWith('turn one')).toBe(true);
  });

  it('is present again on the second turn even when nothing changed', async () => {
    const { client, sessions } = fakeClient();
    const wrapper = new SessionWrapper(client, { builtins: ['bash'] }).setModelName('claude-sonnet-4.5');

    await wrapper.sendAndWait('turn one');
    await wrapper.sendAndWait('turn two');

    const resumedSendAndWait = sessions[1]?.sendAndWait as ReturnType<typeof vi.fn>;
    const secondPrompt = resumedSendAndWait.mock.calls[0]?.[0] as string;
    expect(secondPrompt).toContain('Tools enabled this turn');
    expect(secondPrompt.endsWith('turn two')).toBe(true);
  });

  it('reflects a disableTools call made between turns', async () => {
    const { client, sessions } = fakeClient();
    const wrapper = new SessionWrapper(client, { builtins: ['bash', 'view'] }).setModelName('claude-sonnet-4.5');

    await wrapper.sendAndWait('turn one');
    wrapper.disableTools('view');
    await wrapper.sendAndWait('turn two');

    const resumedSendAndWait = sessions[1]?.sendAndWait as ReturnType<typeof vi.fn>;
    const secondPrompt = resumedSendAndWait.mock.calls[0]?.[0] as string;
    expect(secondPrompt).toContain('Only the following tools are currently enabled and may be called: bash.');
  });

  it('states that no tools are enabled when the subset is empty', async () => {
    const { client, sessions } = fakeClient();
    const wrapper = new SessionWrapper(client, { builtins: ['bash'] }).setModelName('claude-sonnet-4.5');
    wrapper.disableTools('bash');

    await wrapper.sendAndWait('turn one');

    const firstSendAndWait = sessions[0]?.sendAndWait as ReturnType<typeof vi.fn>;
    const firstPrompt = firstSendAndWait.mock.calls[0]?.[0] as string;
    expect(firstPrompt).toContain('No tools are currently enabled');
  });

  it('prepends into MessageOptions.prompt rather than dropping the rest of the options', async () => {
    const { client, sessions } = fakeClient();
    const wrapper = new SessionWrapper(client, { builtins: ['bash'] }).setModelName('claude-sonnet-4.5');

    await wrapper.sendAndWait({ prompt: 'turn one', attachments: [{ type: 'file', path: '/tmp/x.txt' }] } as never);

    const firstSendAndWait = sessions[0]?.sendAndWait as ReturnType<typeof vi.fn>;
    const firstOptions = firstSendAndWait.mock.calls[0]?.[0] as { prompt: string; attachments: unknown[] };
    expect(firstOptions.prompt).toContain('Tools enabled this turn');
    expect(firstOptions.prompt.endsWith('turn one')).toBe(true);
    expect(firstOptions.attachments).toEqual([{ type: 'file', path: '/tmp/x.txt' }]);
  });

  it('also relays a system-prompt-only change as a distinct notice', async () => {
    const { client, sessions } = fakeClient();
    const wrapper = new SessionWrapper(client, { builtins: ['bash'] })
      .setSystemPrompt('be terse')
      .setModelName('claude-sonnet-4.5');

    await wrapper.sendAndWait('turn one');
    wrapper.setSystemPrompt('be verbose');
    await wrapper.sendAndWait('turn two');

    const resumedSendAndWait = sessions[1]?.sendAndWait as ReturnType<typeof vi.fn>;
    const secondPrompt = resumedSendAndWait.mock.calls[0]?.[0] as string;
    expect(secondPrompt).toContain("additional operating instructions changed");
  });
});

describe('SessionWrapper.sendAndWait: mid-turn enablement race (SYS-REQ-028k)', () => {
  it('an in-flight call is unaffected by a disableTools that lands after its permission check already ran; a later call to the same tool is denied', async () => {
    const wrapper = new SessionWrapper(undefined, { builtins: ['bash'] });
    const config = wrapper._createConfig();

    const firstCallResult = await config.onPermissionRequest(shellRequest(), { sessionId: 's1' });
    expect(firstCallResult).toEqual({ kind: 'approve-once' });

    wrapper.disableTools('bash');

    const secondCallResult = await config.onPermissionRequest(shellRequest(), { sessionId: 's1' });
    expect(secondCallResult).toMatchObject({ kind: 'reject' });
  });
});

describe('SessionWrapper: misc lifecycle errors', () => {
  it('setModelName called after the session has started is never rejected and applies next turn', async () => {
    const { client, createCalls, resumeCalls } = fakeClient();
    const wrapper = new SessionWrapper(client, { builtins: ['bash'] }).setModelName('claude-sonnet-4.5');

    await wrapper.sendAndWait('turn one');
    expect(() => wrapper.setModelName('claude-opus-4.8')).not.toThrow();
    await wrapper.sendAndWait('turn two');

    expect(createCalls[0]?.model).toBe('claude-sonnet-4.5');
    // model isn't part of the resume payload at all (SYS-REQ-028g) -- it was
    // only ever meaningful at creation time.
    expect(resumeCalls[0]?.config.model).toBeUndefined();
  });

  it('throws a clear error rather than calling the SDK when no client was supplied', async () => {
    const wrapper = new SessionWrapper(undefined, { builtins: ['bash'] }).setModelName('claude-sonnet-4.5');
    await expect(wrapper.sendAndWait('hello')).rejects.toThrow(/no CopilotClient/);
  });

  it('throws a clear error rather than silently dropping model when no model name was set', async () => {
    const { client } = fakeClient();
    const wrapper = new SessionWrapper(client, { builtins: ['bash'] });
    await expect(wrapper.sendAndWait('hello')).rejects.toThrow(/no model name was set/);
  });

  it('_baseConfig fields survive the create config merge alongside a set model', async () => {
    const { client, createCalls } = fakeClient();
    const wrapper = new SessionWrapper(client, { builtins: ['bash'] }, { workingDirectory: '/tmp/work' }).setModelName(
      'claude-sonnet-4.5'
    );

    await wrapper.sendAndWait('hello');

    expect(createCalls[0]?.workingDirectory).toBe('/tmp/work');
    expect(createCalls[0]?.model).toBe('claude-sonnet-4.5');
  });
});

describe('SessionWrapper side-door surface (SYS-REQ-028e/028j)', () => {
  it('exposes no method that could bind policy/config to a session it did not create, and no post-construction tool-adding method', () => {
    const allowedPublicMethods = new Set(['enableTools', 'disableTools', 'setSystemPrompt', 'setModelName', 'sendAndWait']);
    const excludedFromCheck = new Set(['constructor', '_createConfig', '_setEnablement']);

    const actualMethods = Object.getOwnPropertyNames(SessionWrapper.prototype).filter(
      (name) => !excludedFromCheck.has(name)
    );

    for (const name of actualMethods) {
      expect(allowedPublicMethods.has(name)).toBe(true);
    }
    expect(actualMethods.sort()).toEqual([...allowedPublicMethods].sort());
  });
});
