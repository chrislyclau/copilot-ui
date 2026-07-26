import { describe, it, expect, vi, beforeEach } from 'vitest';

interface SessionDouble {
  sessionId: string;
  on: ReturnType<typeof vi.fn>;
  sendAndWait: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
}

// Session doubles created by the mocked CopilotClient below, in creation
// order.
let sessionsCreated: SessionDouble[] = [];

function makeSessionDouble(): SessionDouble {
  const id = `session-${sessionsCreated.length + 1}`;
  const listeners: Array<(event: unknown) => void> = [];
  const emit = (event: unknown) => listeners.forEach((cb) => cb(event));
  const session = {
    sessionId: id,
    on: vi.fn().mockImplementation((cb: (event: unknown) => void) => {
      listeners.push(cb);
      return vi.fn(() => {
        const idx = listeners.indexOf(cb);
        if (idx >= 0) listeners.splice(idx, 1);
      });
    }),
    sendAndWait: vi.fn().mockImplementation(() => {
      // A healthy turn: the model calls the target tool, then the send
      // resolves. executeAuditSession no longer routes through
      // runForcedToolTurn's stall watchdog/resume ladder (issue #207 --
      // it now uses runForcedToolTurnUntilTimeout, which has neither), so
      // there is no "stall" leg to model here anymore. The stall-specific
      // disconnect regression (issue #186/#187) is still covered directly
      // against the dormant `runForcedToolTurn` in toolCallEnforcement.test.ts.
      emit({ type: 'tool.execution_start', data: { toolName: 'submit_finding' } });
      return Promise.resolve();
    }),
    disconnect: vi.fn().mockResolvedValue(undefined),
  };
  sessionsCreated.push(session);
  return session;
}

// executeAuditSession constructs its own `new CopilotClient(...)` internally
// (auditorHelper.ts), so the only seam available to a test is the
// `../copilotSdk/boundary` module itself -- mock the class it exports rather
// than trying to inject a client instance.
vi.mock('../copilotSdk/boundary', () => {
  class MockCopilotClient {
    async start() {}
    async stop() {}
    async createSession(_config: unknown) {
      return makeSessionDouble();
    }
    async resumeSession(_id: string, _config: unknown) {
      return makeSessionDouble();
    }
  }
  return { CopilotClient: MockCopilotClient };
});

import { executeAuditSession, ToolDefinition } from '../utils/auditorHelper';

describe('executeAuditSession: session is always disconnected once the turn completes', () => {
  beforeEach(() => {
    sessionsCreated = [];
  });

  it('disconnects the session used for a successful turn (issue #187, updated for issue #207)', async () => {
    const tool: ToolDefinition = {
      function: {
        name: 'submit_finding',
        description: 'Submit an audit finding',
        parameters: {
          type: 'object',
          properties: { pass: { type: 'boolean' } },
          required: ['pass'],
        },
      },
    };

    const result = await executeAuditSession(
      '/tmp/does-not-matter',
      {} as any,
      'You are an auditor.',
      tool,
      'Audit this change.',
      {},
      undefined,
      300000,
      undefined,
      2,
    );

    expect(result).toBeTruthy();
    expect(sessionsCreated.length).toBe(1);
    expect(sessionsCreated[0]!.disconnect).toHaveBeenCalledTimes(1);
  });
});
