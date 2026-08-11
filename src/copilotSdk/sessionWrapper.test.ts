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
} {
  const createCalls: FakeConfig[] = [];
  const resumeCalls: { sessionId: string; config: FakeConfig }[] = [];
  let nextId = 0;

  function fakeSession(sessionId: string): CopilotSession {
    return {
      sessionId,
      sendAndWait: vi.fn().mockResolvedValue(undefined),
    } as unknown as CopilotSession;
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

  return { client, createCalls, resumeCalls };
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

  it('folds tool guidance into an unset system prompt as append mode', () => {
    const config = new SessionWrapper().addTools('bash')._createConfig();
    expect(config.systemMessage?.mode).toBe('append');
  });

  it('folds tool guidance into a caller-supplied replace-mode system prompt without dropping caller content', () => {
    const wrapper = new SessionWrapper().addTools('bash').setSystemPrompt({ mode: 'replace', content: 'be terse' });
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
      .setSystemPrompt({ mode: 'append', content: 'be terse' })
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
