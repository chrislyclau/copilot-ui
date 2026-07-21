import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { runForcedToolTurn, sendAndWaitWithAbort, STALL_TIMEOUT_MS } from '../utils/toolCallEnforcement';

describe('runForcedToolTurn', () => {
  it('no-tool-call -> retry once with availableTools narrowed and tool_choice set; exhausts retries -> throws', async () => {
    let callCount = 0;
    const mockSession = {
      sessionId: 'test-session',
      on: vi.fn().mockReturnValue(vi.fn()),
      sendAndWait: vi.fn().mockImplementation(async (opts) => {
        callCount++;
        if (callCount === 2) {
          expect(opts.tool_choice).toEqual({ type: 'function', function: { name: 'my_tool' } });
        }
      })
    } as any;

    const mockClient = {
      resumeSession: vi.fn().mockImplementation(async (id, opts) => {
        expect(opts.availableTools).toEqual(['my_tool']);
        return mockSession;
      })
    } as any;

    const runPromise = runForcedToolTurn(mockSession, { provider: 'openrouter' }, 'my_tool', 'test prompt', {
      client: mockClient,
      maxRetries: 1,
      getResult: () => null,
      tools: []
    });

    await expect(runPromise).rejects.toThrow(/Session ended without calling 'my_tool' after 1 retry/);
    expect(callCount).toBe(2);
    expect(mockClient.resumeSession).toHaveBeenCalledTimes(1);
  });
});

describe('Upstream stall detection & retry (review-pr.ts stall-retry follow-up)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * A session whose sendAndWait never resolves and never emits any event --
   * simulates the exact "upstream stream stalled" failure mode this feature
   * targets (no session.error, no further chunks, connection just idles).
   */
  function makeStalledSession(sessionId: string) {
    return {
      sessionId,
      on: vi.fn().mockReturnValue(vi.fn()),
      sendAndWait: vi.fn().mockImplementation(() => new Promise(() => {})), // never resolves
    } as any;
  }

  describe('sendAndWaitWithAbort', () => {
    it('rejects with an isStall-tagged error after STALL_TIMEOUT_MS of total silence', async () => {
      const session = makeStalledSession('s1');
      const promise = sendAndWaitWithAbort(session, { prompt: 'hi' } as any, 300000);
      const assertion = expect(promise).rejects.toMatchObject({ isStall: true });
      await vi.advanceTimersByTimeAsync(STALL_TIMEOUT_MS + 5000);
      await assertion;
    });

    it('resolves normally when sendAndWait completes before the stall threshold', async () => {
      const session = {
        sessionId: 's2',
        on: vi.fn().mockReturnValue(vi.fn()),
        sendAndWait: vi.fn().mockResolvedValue(undefined),
      } as any;
      await expect(sendAndWaitWithAbort(session, { prompt: 'hi' } as any, 300000)).resolves.toBeUndefined();
    });

    it('does not fire the stall timer if events keep arriving (resets the silence clock)', async () => {
      let eventHandler: (() => void) | undefined;
      const session = {
        sessionId: 's3',
        on: vi.fn().mockImplementation((handler) => {
          eventHandler = handler;
          return vi.fn();
        }),
        sendAndWait: vi.fn().mockImplementation(() => new Promise((resolve) => {
          // Simulate periodic activity (e.g. streaming deltas) that should
          // keep resetting the stall clock, then resolve just past the
          // point where a naive one-shot timer would have already fired.
          const interval = setInterval(() => eventHandler?.(), STALL_TIMEOUT_MS - 10000);
          setTimeout(() => {
            clearInterval(interval);
            resolve(undefined);
          }, STALL_TIMEOUT_MS + 20000);
        })),
      } as any;

      const promise = sendAndWaitWithAbort(session, { prompt: 'hi' } as any, 600000);
      await vi.advanceTimersByTimeAsync(STALL_TIMEOUT_MS + 25000);
      await expect(promise).resolves.toBeUndefined();
    });
  });

  describe('runForcedToolTurn stall-retry', () => {
    it('retries on the same prompt after a stall (does not consume the tool-not-called retry budget)', async () => {
      let sessionCount = 0;
      const sessions: any[] = [];

      const makeSession = () => {
        sessionCount++;
        const id = `session-${sessionCount}`;
        const isFirst = sessionCount === 1;
        const session = {
          sessionId: id,
          on: vi.fn().mockImplementation((handler: (e: unknown) => void) => {
            if (!isFirst) {
              // Second (post-stall-retry) session: immediately signal the
              // tool was called once sendAndWait is invoked below.
            }
            return vi.fn();
          }),
          sendAndWait: vi.fn().mockImplementation(() => {
            if (isFirst) {
              return new Promise(() => {}); // stalls forever
            }
            return Promise.resolve();
          }),
        };
        sessions.push(session);
        return session;
      };

      const initialSession = makeSession();
      const mockClient = {
        resumeSession: vi.fn().mockImplementation(async () => makeSession()),
      } as any;

      const runPromise = runForcedToolTurn(initialSession as any, {}, 'my_tool', 'test prompt', {
        client: mockClient,
        maxRetries: 2,
        maxStallRetries: 1,
        getResult: () => ({ ok: true }),
        tools: [],
      });

      // Attach the rejection expectation before advancing timers, so the
      // rejection is "handled" synchronously with respect to Node's
      // unhandled-rejection tracking (otherwise the promise can reject
      // during advanceTimersByTimeAsync before anything is listening).
      const assertion = expect(runPromise).rejects.toThrow(/Session ended without calling 'my_tool'/);

      // The second (post-stall-retry) session's sendAndWait resolves, but
      // toolCalled will still be false since no tool event was emitted --
      // so this then proceeds into the normal nudge-retry path, which is
      // fine: what we actually care about is that the stall did not throw
      // immediately and did trigger exactly one resumeSession before any
      // nudge retry.
      await vi.advanceTimersByTimeAsync(STALL_TIMEOUT_MS + 5000);
      await assertion;

      expect(mockClient.resumeSession).toHaveBeenCalledTimes(1 + 2); // 1 stall retry + 2 nudge retries
      expect(sessionCount).toBe(1 + 1 + 2); // initial + stall-retry + 2 nudge-retries
    });

    it('gives up after exhausting maxStallRetries on persistent stalls', async () => {
      const stalledSession = () => ({
        sessionId: 'always-stalled',
        on: vi.fn().mockReturnValue(vi.fn()),
        sendAndWait: vi.fn().mockImplementation(() => new Promise(() => {})),
      });

      const initialSession = stalledSession();
      const mockClient = {
        resumeSession: vi.fn().mockImplementation(async () => stalledSession()),
      } as any;

      const runPromise = runForcedToolTurn(initialSession as any, {}, 'my_tool', 'test prompt', {
        client: mockClient,
        maxRetries: 0,
        maxStallRetries: 1,
        getResult: () => null,
        tools: [],
      });

      const assertion = expect(runPromise).rejects.toMatchObject({ isStall: true });
      // Initial send stalls (1), retry stalls (2) -> maxStallRetries=1 exhausted -> rethrows.
      await vi.advanceTimersByTimeAsync((STALL_TIMEOUT_MS + 5000) * 2);
      await assertion;
      expect(mockClient.resumeSession).toHaveBeenCalledTimes(1);
    });
  });
});
