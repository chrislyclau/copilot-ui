import { describe, it, expect, vi } from 'vitest';
import {
  createHardenedSession,
  registerSessionPolicy,
  resumeHardenedSession,
  deleteHardenedSessionPolicy,
  getRejectedToolAttempts,
  clearRejectedToolAttempts,
  getReadonlySession,
  SessionPolicy,
} from '../copilotSdk/hardenedSession';
import { CopilotClient } from '../copilotSdk/boundary';

function makeMockClient(resumedSessionId?: string) {
  const createSession = vi.fn(async (config: any) => ({
    sessionId: 'session-created',
    config,
  }));
  const resumeSession = vi.fn(async (sessionId: string, config: any) => ({
    sessionId: resumedSessionId ?? sessionId,
    config,
  }));
  return { createSession, resumeSession } as unknown as CopilotClient;
}

const policy: SessionPolicy = {
  availableTools: ['read_file', 'write_file'],
  autoApprovedTools: ['read_file'],
};

describe('resumeHardenedSession', () => {
  it('re-derives the full config (availableTools, autoApproveAll: false, onPermissionRequest) on every resume', async () => {
    const client = makeMockClient();
    registerSessionPolicy('session-1', policy);

    await resumeHardenedSession(client, 'session-1');

    expect(client.resumeSession).toHaveBeenCalledTimes(1);
    const [sessionId, config] = (client.resumeSession as any).mock.calls[0];
    expect(sessionId).toBe('session-1');
    expect(config.availableTools).toEqual(policy.availableTools);
    expect(config.autoApproveAll).toBe(false);
    expect(typeof config.onPermissionRequest).toBe('function');
  });

  it('throws rather than falling back to SDK defaults when no policy is registered', async () => {
    const client = makeMockClient();
    await expect(resumeHardenedSession(client, 'never-registered')).rejects.toThrow(/no policy registered/);
    expect(client.resumeSession).not.toHaveBeenCalled();
  });

  it('rejects a tool not present in autoApprovedTools', async () => {
    const client = makeMockClient();
    registerSessionPolicy('session-2', policy);
    await resumeHardenedSession(client, 'session-2');
    const config = (client.resumeSession as any).mock.calls[0][1];

    const result = await config.onPermissionRequest(
      { kind: 'shell' },
      { sessionId: 'session-2' }
    );
    expect(result.kind).toBe('reject');
  });

  it('approves a tool present in autoApprovedTools', async () => {
    const client = makeMockClient();
    registerSessionPolicy('session-3', policy);
    await resumeHardenedSession(client, 'session-3');
    const config = (client.resumeSession as any).mock.calls[0][1];

    const result = await config.onPermissionRequest(
      { kind: 'custom-tool', toolName: 'read_file' },
      { sessionId: 'session-3' }
    );
    expect(result.kind).toBe('approve-once');
  });

  it('re-keys the stored policy under the id resumeSession returns, and drops the stale id', async () => {
    const client = makeMockClient('session-1-b');
    registerSessionPolicy('session-1', policy);

    const first = await resumeHardenedSession(client, 'session-1');
    expect(first.sessionId).toBe('session-1-b');

    // A follow-up resume must use the *new* id -- the old one is no longer valid.
    await expect(resumeHardenedSession(client, 'session-1')).rejects.toThrow(/no policy registered/);

    await resumeHardenedSession(client, 'session-1-b');
    expect(client.resumeSession).toHaveBeenCalledTimes(2);
  });

  it('migrates recorded rejections to the new id when resumeSession re-keys the session', async () => {
    const ids = ['session-migrate-a', 'session-migrate-b'];
    const resumeSession = vi.fn(async (_sessionId: string, config: any) => ({
      sessionId: ids.shift(),
      config,
    }));
    const client = { createSession: vi.fn(), resumeSession } as unknown as CopilotClient;
    registerSessionPolicy('session-migrate', policy);

    // First resume re-keys 'session-migrate' -> 'session-migrate-a'.
    const first = await resumeHardenedSession(client, 'session-migrate');
    expect(first.sessionId).toBe('session-migrate-a');
    let config = (client.resumeSession as any).mock.calls[0][1];
    await config.onPermissionRequest({ kind: 'shell' }, { sessionId: 'session-migrate-a' });
    expect(getRejectedToolAttempts('session-migrate-a')).toEqual(['shell']);

    // Second resume, keyed off the intermediate id, re-keys again -> 'session-migrate-b'.
    // The rejection recorded under the intermediate id must migrate along with the policy.
    const second = await resumeHardenedSession(client, 'session-migrate-a');
    expect(second.sessionId).toBe('session-migrate-b');
    config = (client.resumeSession as any).mock.calls[1][1];
    await config.onPermissionRequest({ kind: 'view' }, { sessionId: 'session-migrate-b' });

    expect(getRejectedToolAttempts('session-migrate-a')).toEqual([]);
    expect(getRejectedToolAttempts('session-migrate-b')).toEqual(['shell', 'view']);
  });

  it('passes through non-policy base config (e.g. provider) without letting it override policy fields', async () => {
    const client = makeMockClient();
    registerSessionPolicy('session-4', policy);

    await resumeHardenedSession(client, 'session-4', { provider: 'openrouter' } as any);

    const config = (client.resumeSession as any).mock.calls[0][1];
    expect(config.provider).toBe('openrouter');
    expect(config.availableTools).toEqual(policy.availableTools);
    expect(config.autoApproveAll).toBe(false);
  });

  it('createHardenedSession binds a policy that a later resume can use without re-supplying config', async () => {
    const client = makeMockClient();
    await createHardenedSession(client, {}, policy);

    await resumeHardenedSession(client, 'session-created');
    const config = (client.resumeSession as any).mock.calls[0][1];
    expect(config.availableTools).toEqual(policy.availableTools);
    expect(config.autoApproveAll).toBe(false);
  });

  it('deleteHardenedSessionPolicy makes a subsequent resume fail loudly', async () => {
    const client = makeMockClient();
    registerSessionPolicy('session-5', policy);
    deleteHardenedSessionPolicy('session-5');

    await expect(resumeHardenedSession(client, 'session-5')).rejects.toThrow(/no policy registered/);
  });

  it('a caller that evicts on turn-end (as toolCallEnforcement now does) leaves no stale entry behind', async () => {
    const client = makeMockClient();
    registerSessionPolicy('session-6', policy);
    await resumeHardenedSession(client, 'session-6');
    // Simulates the `finally { deleteHardenedSessionPolicy(currentSessionId) }`
    // toolCallEnforcement.ts's runForcedToolTurn/runForcedToolTurnUntilTimeout
    // now run at the end of every turn, so policyBySessionId doesn't grow
    // unboundedly across turns in a long-running process.
    deleteHardenedSessionPolicy('session-6');

    await expect(resumeHardenedSession(client, 'session-6')).rejects.toThrow(/no policy registered/);
  });
});

describe('disallowed-tool rejection (issue #246 item 3)', () => {
  // A policy that doesn't opt any built-in into autoApprovedTools -- the
  // default posture every session should have unless a policy explicitly
  // widens it.
  const noBuiltInsPolicy: SessionPolicy = {
    availableTools: ['read_file'],
    autoApprovedTools: ['read_file'],
  };

  it.each([
    { name: 'bash', req: { kind: 'shell' } },
    { name: 'view', req: { kind: 'read' } },
    { name: 'grep', req: { kind: 'custom-tool', toolName: 'grep' } },
    { name: 'task', req: { kind: 'custom-tool', toolName: 'task' } },
  ])('rejects a resumed session\'s request for the disallowed "$name" tool', async ({ req }) => {
    const client = makeMockClient();
    const sessionId = `builtin-reject-${req.kind}-${'toolName' in req ? req.toolName : 'k'}`;
    registerSessionPolicy(sessionId, noBuiltInsPolicy);
    await resumeHardenedSession(client, sessionId);
    const config = (client.resumeSession as any).mock.calls[0][1];

    const result = await config.onPermissionRequest(req, { sessionId });

    expect(result.kind).toBe('reject');
  });

  it('leaves bash/view/grep/task unavailable by default when a policy does not explicitly include them', async () => {
    const client = makeMockClient();
    registerSessionPolicy('session-defaults', noBuiltInsPolicy);
    await resumeHardenedSession(client, 'session-defaults');
    const config = (client.resumeSession as any).mock.calls[0][1];

    for (const req of [
      { kind: 'shell' },
      { kind: 'read' },
      { kind: 'custom-tool', toolName: 'grep' },
      { kind: 'custom-tool', toolName: 'task' },
    ]) {
      const result = await config.onPermissionRequest(req, { sessionId: 'session-defaults' });
      expect(result.kind).toBe('reject');
    }
  });

  it('approves a built-in that a policy explicitly opts into autoApprovedTools', async () => {
    const client = makeMockClient();
    const policyWithShell: SessionPolicy = {
      availableTools: ['read_file'],
      autoApprovedTools: ['shell'],
    };
    registerSessionPolicy('session-explicit-shell', policyWithShell);
    await resumeHardenedSession(client, 'session-explicit-shell');
    const config = (client.resumeSession as any).mock.calls[0][1];

    const result = await config.onPermissionRequest({ kind: 'shell' }, { sessionId: 'session-explicit-shell' });

    expect(result.kind).toBe('approve-once');
  });

  it('records the attempted tool name for each rejection, in order', async () => {
    const client = makeMockClient();
    registerSessionPolicy('session-record', noBuiltInsPolicy);
    await resumeHardenedSession(client, 'session-record');
    const config = (client.resumeSession as any).mock.calls[0][1];

    await config.onPermissionRequest({ kind: 'shell' }, { sessionId: 'session-record' });
    await config.onPermissionRequest({ kind: 'custom-tool', toolName: 'task' }, { sessionId: 'session-record' });
    // An approved request should not show up in the rejection record.
    await config.onPermissionRequest({ kind: 'custom-tool', toolName: 'read_file' }, { sessionId: 'session-record' });

    expect(getRejectedToolAttempts('session-record')).toEqual(['shell', 'task']);
  });

  it('returns an empty array for a session with no rejections on file', () => {
    expect(getRejectedToolAttempts('never-rejected-anything')).toEqual([]);
  });

  it('clearRejectedToolAttempts resets the record for a session', async () => {
    const client = makeMockClient();
    registerSessionPolicy('session-clear', noBuiltInsPolicy);
    await resumeHardenedSession(client, 'session-clear');
    const config = (client.resumeSession as any).mock.calls[0][1];
    await config.onPermissionRequest({ kind: 'shell' }, { sessionId: 'session-clear' });
    expect(getRejectedToolAttempts('session-clear')).toEqual(['shell']);

    clearRejectedToolAttempts('session-clear');

    expect(getRejectedToolAttempts('session-clear')).toEqual([]);
  });

  it('deleteHardenedSessionPolicy also clears the recorded rejection history', async () => {
    const client = makeMockClient();
    registerSessionPolicy('session-delete-clears', noBuiltInsPolicy);
    await resumeHardenedSession(client, 'session-delete-clears');
    const config = (client.resumeSession as any).mock.calls[0][1];
    await config.onPermissionRequest({ kind: 'shell' }, { sessionId: 'session-delete-clears' });
    expect(getRejectedToolAttempts('session-delete-clears')).toEqual(['shell']);

    deleteHardenedSessionPolicy('session-delete-clears');

    expect(getRejectedToolAttempts('session-delete-clears')).toEqual([]);
  });
});

describe('getReadonlySession (issue #246 item 5)', () => {
  function makeFakeSdkSession(sessionId: string) {
    const onMock = vi.fn(() => () => {});
    const getEventsMock = vi.fn(async () => []);
    return {
      sessionId,
      workspacePath: `/workspaces/${sessionId}`,
      capabilities: { ui: { elicitation: false } },
      on: onMock,
      getEvents: getEventsMock,
      // Mutating/control methods that must NOT be reachable through the
      // read-only view -- present here to prove the view doesn't forward them.
      send: vi.fn(),
      sendAndWait: vi.fn(),
      abort: vi.fn(),
      setModel: vi.fn(),
      log: vi.fn(),
      disconnect: vi.fn(),
    };
  }

  it('returns undefined for a session that was never created or registered', () => {
    expect(getReadonlySession('never-seen')).toBeUndefined();
  });

  it('exposes sessionId, workspacePath, capabilities, on, and getEvents for a session created via createHardenedSession', async () => {
    const fakeSession = makeFakeSdkSession('ro-session-created');
    const client = {
      createSession: vi.fn(async () => fakeSession),
      resumeSession: vi.fn(),
    } as unknown as CopilotClient;

    await createHardenedSession(client, {}, policy);
    const view = getReadonlySession('ro-session-created');

    expect(view).toBeDefined();
    expect(view!.sessionId).toBe('ro-session-created');
    expect(view!.workspacePath).toBe('/workspaces/ro-session-created');
    expect(view!.capabilities).toEqual({ ui: { elicitation: false } });

    const handler = vi.fn();
    view!.on(handler);
    expect(fakeSession.on).toHaveBeenCalledWith(handler);

    await view!.getEvents();
    expect(fakeSession.getEvents).toHaveBeenCalledTimes(1);
  });

  it('does not expose send/sendAndWait/abort/setModel/log/disconnect', async () => {
    const fakeSession = makeFakeSdkSession('ro-session-no-mutate');
    const client = {
      createSession: vi.fn(async () => fakeSession),
      resumeSession: vi.fn(),
    } as unknown as CopilotClient;

    await createHardenedSession(client, {}, policy);
    const view = getReadonlySession('ro-session-no-mutate') as unknown as Record<string, unknown>;

    for (const method of ['send', 'sendAndWait', 'abort', 'setModel', 'log', 'disconnect']) {
      expect(view[method]).toBeUndefined();
    }
  });

  it('tracks the session under its post-resume id when resumeSession re-keys it', async () => {
    const oldSession = makeFakeSdkSession('ro-resume-old');
    const newSession = makeFakeSdkSession('ro-resume-new');
    const client = {
      createSession: vi.fn(async () => oldSession),
      resumeSession: vi.fn(async () => newSession),
    } as unknown as CopilotClient;

    await createHardenedSession(client, {}, policy);
    await resumeHardenedSession(client, 'ro-resume-old');

    expect(getReadonlySession('ro-resume-old')).toBeUndefined();
    expect(getReadonlySession('ro-resume-new')).toBeDefined();
  });

  it('registerSessionPolicy makes a pre-existing session visible via getReadonlySession when passed the session object', () => {
    const fakeSession = makeFakeSdkSession('ro-registered');
    registerSessionPolicy('ro-registered', policy, fakeSession as unknown as Parameters<typeof registerSessionPolicy>[2]);

    expect(getReadonlySession('ro-registered')).toBeDefined();
  });

  it('registerSessionPolicy without a session object leaves getReadonlySession returning undefined', () => {
    registerSessionPolicy('ro-not-registered', policy);

    expect(getReadonlySession('ro-not-registered')).toBeUndefined();
  });

  it('deleteHardenedSessionPolicy evicts the tracked session too', async () => {
    const fakeSession = makeFakeSdkSession('ro-evicted');
    const client = {
      createSession: vi.fn(async () => fakeSession),
      resumeSession: vi.fn(),
    } as unknown as CopilotClient;

    await createHardenedSession(client, {}, policy);
    expect(getReadonlySession('ro-evicted')).toBeDefined();

    deleteHardenedSessionPolicy('ro-evicted');

    expect(getReadonlySession('ro-evicted')).toBeUndefined();
  });
});
