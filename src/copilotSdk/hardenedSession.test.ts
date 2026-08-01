import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  createHardenedSession,
  resumeHardenedSession,
  registerSessionPolicy,
  deleteHardenedSessionPolicy,
  getRejectedToolAttempts,
  getReadonlySession,
  deriveSessionConfig,
  SessionPolicy,
} from './hardenedSession';
import type { CopilotClient, CopilotSession, PermissionRequest } from './boundary';

/**
 * Unit tests for issue #246 item 6:
 * - every `resumeSession` call (nudge-retry + stall-retry shaped scenarios)
 *   includes `availableTools` matching the original policy and
 *   `autoApproveAll: false`
 * - a resumed session receiving a disallowed-tool request is rejected
 * - (type-level omission test lives in hardenedSession.typecheck.test.ts)
 */

function makeMockSession(sessionId: string): CopilotSession {
  return {
    sessionId,
    workspacePath: '/tmp/ws',
    capabilities: {} as CopilotSession['capabilities'],
    on: vi.fn().mockReturnValue(vi.fn()),
    getEvents: vi.fn().mockReturnValue([]),
    disconnect: vi.fn(),
  } as unknown as CopilotSession;
}

function makePolicy(overrides: Partial<SessionPolicy> = {}): SessionPolicy {
  return {
    availableTools: ['read', 'write'],
    tools: [],
    systemMessage: { mode: 'append', content: 'be helpful' },
    autoApprovedTools: ['read'],
    ...overrides,
  };
}

let sessionCounter = 0;

function makeMockClient(sessionFactory: (id: string) => CopilotSession = makeMockSession): CopilotClient {
  return {
    createSession: vi.fn().mockImplementation(async () => sessionFactory(`created-session-${++sessionCounter}`)),
    resumeSession: vi.fn().mockImplementation(async (id: string) => sessionFactory(id)),
  } as unknown as CopilotClient;
}

describe('createHardenedSession', () => {
  it('always derives autoApproveAll: false and the full policy-owned config', async () => {
    const client = makeMockClient();
    const policy = makePolicy();

    await createHardenedSession(client, { model: 'claude-sonnet-4.5' }, policy);

    expect(client.createSession).toHaveBeenCalledTimes(1);
    const [config] = (client.createSession as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(config.availableTools).toEqual(policy.availableTools);
    expect(config.autoApproveAll).toBe(false);
    expect(typeof config.onPermissionRequest).toBe('function');
    expect(config.systemMessage).toBe(policy.systemMessage);
  });
});

describe('resumeHardenedSession', () => {
  it('nudge-retry-shaped resume: includes availableTools matching the original policy and autoApproveAll: false', async () => {
    const client = makeMockClient();
    const policy = makePolicy({ availableTools: ['read', 'write', 'my_tool'] });
    const created = await createHardenedSession(client, {}, policy);

    // Simulate a nudge-retry: caller resumes the same session id after a
    // no-tool-call retry, passing only non-policy fields (provider).
    await resumeHardenedSession(client, created.sessionId, { provider: { name: 'openrouter' } } as any);

    expect(client.resumeSession).toHaveBeenCalledTimes(1);
    const [, config] = (client.resumeSession as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(config.availableTools).toEqual(policy.availableTools);
    expect(config.autoApproveAll).toBe(false);
    expect(typeof config.onPermissionRequest).toBe('function');
  });

  it('stall-retry-shaped resume: still includes availableTools and autoApproveAll: false even with no baseConfig supplied', async () => {
    const client = makeMockClient();
    const policy = makePolicy({ availableTools: ['bash', 'view'] });
    const created = await createHardenedSession(client, {}, policy);

    // Stall-retry historically dropped `availableTools` entirely by
    // omitting it from the resumeConfig. Here the caller supplies no
    // baseConfig at all -- deriveSessionConfig must still fill it in.
    await resumeHardenedSession(client, created.sessionId);

    const [, config] = (client.resumeSession as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(config.availableTools).toEqual(policy.availableTools);
    expect(config.autoApproveAll).toBe(false);
  });

  it('re-keys the stored policy under the sessionId returned by resumeSession, so a second resume still finds it', async () => {
    const client = makeMockClient(() => makeMockSession('rekey-new-id'));
    const policy = makePolicy();
    registerSessionPolicy('rekey-orig', policy);

    const resumed = await resumeHardenedSession(client, 'rekey-orig');
    expect(resumed.sessionId).toBe('rekey-new-id');

    // A subsequent resume against the new id must still succeed (policy found).
    await expect(resumeHardenedSession(client, 'rekey-new-id')).resolves.toBeDefined();
  });

  it('throws rather than silently falling back to SDK defaults when no policy is registered', async () => {
    const client = makeMockClient();
    await expect(resumeHardenedSession(client, 'unregistered-session')).rejects.toThrow(
      /no policy registered/
    );
    expect(client.resumeSession).not.toHaveBeenCalled();
  });
});

describe('disallowed-tool rejection (regression)', () => {
  it('rejects a resumed session receiving a request for a tool not in autoApprovedTools (e.g. bash)', async () => {
    const client = makeMockClient();
    const policy = makePolicy({ availableTools: ['read'], autoApprovedTools: ['read'] });
    const created = await createHardenedSession(client, {}, policy);

    await resumeHardenedSession(client, created.sessionId);
    const [, resumedConfig] = (client.resumeSession as ReturnType<typeof vi.fn>).mock.calls[0]!;

    const bashRequest = { kind: 'shell' } as PermissionRequest;
    const result = await resumedConfig.onPermissionRequest(bashRequest, { sessionId: created.sessionId });

    expect(result.kind).toBe('reject');
    expect(getRejectedToolAttempts(created.sessionId)).toContain('shell');
  });

  it('rejects a resumed session receiving a request for a disallowed custom tool (e.g. view/task)', async () => {
    const client = makeMockClient();
    const policy = makePolicy({ availableTools: ['read'], autoApprovedTools: [] });
    const created = await createHardenedSession(client, {}, policy);
    await resumeHardenedSession(client, created.sessionId);
    const [, resumedConfig] = (client.resumeSession as ReturnType<typeof vi.fn>).mock.calls[0]!;

    for (const toolName of ['view', 'task']) {
      const req = { kind: 'custom-tool', toolName } as PermissionRequest;
      const result = await resumedConfig.onPermissionRequest(req, { sessionId: created.sessionId });
      expect(result.kind).toBe('reject');
    }
    expect(getRejectedToolAttempts(created.sessionId)).toEqual(['view', 'task']);
  });

  it('approves a tool present in autoApprovedTools', async () => {
    const policy = makePolicy({ autoApprovedTools: ['read'] });
    const config = deriveSessionConfig(policy);
    const result = await config.onPermissionRequest({ kind: 'read' } as PermissionRequest, { sessionId: 's1' });
    expect(result.kind).toBe('approve-once');
  });
});

describe('getReadonlySession', () => {
  it('returns a view that exposes inspection members but not session-control methods', async () => {
    const client = makeMockClient();
    const policy = makePolicy();
    const created = await createHardenedSession(client, {}, policy);

    const readonlyView = getReadonlySession(created.sessionId);
    expect(readonlyView).toBeDefined();
    expect(readonlyView!.sessionId).toBe(created.sessionId);
    expect('send' in readonlyView!).toBe(false);
    expect('disconnect' in readonlyView!).toBe(false);
  });

  it('returns undefined for a session id nothing was registered/tracked under', () => {
    expect(getReadonlySession('never-seen')).toBeUndefined();
  });
});

describe('deleteHardenedSessionPolicy', () => {
  beforeEach(() => {
    deleteHardenedSessionPolicy('cleanup-target');
  });

  it('clears stored policy, tracked session, and rejection history so a later resume throws', async () => {
    const client = makeMockClient();
    registerSessionPolicy('cleanup-target', makePolicy());
    deleteHardenedSessionPolicy('cleanup-target');

    await expect(resumeHardenedSession(client, 'cleanup-target')).rejects.toThrow(/no policy registered/);
    expect(getRejectedToolAttempts('cleanup-target')).toEqual([]);
  });
});
