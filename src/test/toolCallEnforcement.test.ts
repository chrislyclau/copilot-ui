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

    it('creates a brand-new session (not resumeSession) on stall when freshSessionConfig is provided', async () => {
      let sessionCount = 0;
      const makeSession = (resolves: boolean) => {
        sessionCount++;
        return {
          sessionId: `session-${sessionCount}`,
          on: vi.fn().mockReturnValue(vi.fn()),
          sendAndWait: vi.fn().mockImplementation(() => (resolves ? Promise.resolve() : new Promise(() => {}))),
        };
      };

      const initialSession = makeSession(false); // stalls
      const freshSessionConfig = { workingDirectory: '/tmp', systemPrompt: 'x', tools: [] } as any;
      const mockClient = {
        createSession: vi.fn().mockImplementation(async () => makeSession(true)), // succeeds
        resumeSession: vi.fn(),
      } as any;
      const onSessionId = vi.fn();

      const runPromise = runForcedToolTurn(initialSession as any, {}, 'my_tool', 'test prompt', {
        client: mockClient,
        maxRetries: 0,
        maxStallRetries: 1,
        getResult: () => ({ ok: true }),
        tools: [],
        freshSessionConfig,
        onSessionId,
      });

      // The turn will still ultimately fail (no tool-call event ever fires
      // in this mock), but what we care about here is *how* the stall was
      // recovered from, not the final outcome.
      const assertion = expect(runPromise).rejects.toThrow(/Session ended without calling 'my_tool'/);
      await vi.advanceTimersByTimeAsync(STALL_TIMEOUT_MS + 5000);
      await assertion;

      expect(mockClient.createSession).toHaveBeenCalledTimes(1);
      expect(mockClient.createSession).toHaveBeenCalledWith(freshSessionConfig);
      expect(mockClient.resumeSession).not.toHaveBeenCalled();

      // onSessionId must fire again with the new session's id, so callers
      // that correlate outbound requests via a global (e.g.
      // scripts/review-pr.ts's setActiveOpenRouterSessionId) stay in sync.
      expect(onSessionId).toHaveBeenCalledWith('session-2');
    });

    it('falls back to resumeSession when no freshSessionConfig is supplied', async () => {
      let sessionCount = 0;
      const makeSession = (resolves: boolean) => {
        sessionCount++;
        return {
          sessionId: `session-${sessionCount}`,
          on: vi.fn().mockReturnValue(vi.fn()),
          sendAndWait: vi.fn().mockImplementation(() => (resolves ? Promise.resolve() : new Promise(() => {}))),
        };
      };

      const initialSession = makeSession(false);
      const mockClient = {
        createSession: vi.fn(),
        resumeSession: vi.fn().mockImplementation(async () => makeSession(true)),
      } as any;

      const runPromise = runForcedToolTurn(initialSession as any, {}, 'my_tool', 'test prompt', {
        client: mockClient,
        maxRetries: 0,
        maxStallRetries: 1,
        getResult: () => ({ ok: true }),
        tools: [],
        // no freshSessionConfig
      });

      const assertion = expect(runPromise).rejects.toThrow(/Session ended without calling 'my_tool'/);
      await vi.advanceTimersByTimeAsync(STALL_TIMEOUT_MS + 5000);
      await assertion;

      expect(mockClient.resumeSession).toHaveBeenCalledTimes(1);
      expect(mockClient.createSession).not.toHaveBeenCalled();
    });

    it('restarts from the original prompt (not the in-flight nudge) when a stall happens mid-nudge-retry', async () => {
      let sessionCount = 0;
      const sentPrompts: string[] = [];
      const makeSession = (behavior: 'stall' | 'resolve') => {
        sessionCount++;
        const id = `session-${sessionCount}`;
        return {
          sessionId: id,
          on: vi.fn().mockReturnValue(vi.fn()),
          sendAndWait: vi.fn().mockImplementation((opts: { prompt: string }) => {
            sentPrompts.push(opts.prompt);
            return behavior === 'stall' ? new Promise(() => {}) : Promise.resolve();
          }),
        };
      };

      // Turn 1 (initial prompt): resolves normally but never calls the tool
      // -> triggers the nudge-retry path.
      const initialSession = makeSession('resolve');
      const freshSessionConfig = { workingDirectory: '/tmp', systemPrompt: 'x', tools: [] } as any;

      let resumeCallCount = 0;
      const mockClient = {
        createSession: vi.fn().mockImplementation(async () => makeSession('resolve')),
        resumeSession: vi.fn().mockImplementation(async () => {
          resumeCallCount++;
          // The nudge-retry's own resumeSession() call returns a session
          // whose *next* send (the nudge itself) stalls.
          return makeSession('stall');
        }),
      } as any;

      const runPromise = runForcedToolTurn(initialSession as any, {}, 'my_tool', 'test prompt', {
        client: mockClient,
        maxRetries: 1,
        maxStallRetries: 1,
        getResult: () => ({ ok: true }),
        tools: [],
        freshSessionConfig,
      });

      const assertion = expect(runPromise).rejects.toThrow(/Session ended without calling 'my_tool'/);
      await vi.advanceTimersByTimeAsync(STALL_TIMEOUT_MS + 5000);
      await assertion;

      expect(sentPrompts[0]).toBe('test prompt'); // initial turn
      // The nudge-retry's resumeSession call happened once (the ordinary,
      // non-stall nudge resume), and its send (the nudge itself) is what stalls...
      expect(resumeCallCount).toBe(1);
      expect(sentPrompts[1]).toContain('ended your turn without calling');
      // ...so recovery used createSession (not yet another resumeSession)
      // and resent the *original* prompt, not another nudge.
      expect(sentPrompts[2]).toBe('test prompt');
      expect(mockClient.createSession).toHaveBeenCalledTimes(1);
    });

    it('does not retry or discard the turn when the stall happens after the tool was already called', async () => {
      const handlers: Array<(e: unknown) => void> = [];
      const session = {
        sessionId: 's-tool-then-stall',
        on: vi.fn().mockImplementation((handler: (e: unknown) => void) => {
          handlers.push(handler);
          return vi.fn();
        }),
        sendAndWait: vi.fn().mockImplementation(() => {
          // Simulate the tool firing shortly after send, then the SDK
          // going completely quiet afterward (no closing event) -- the
          // exact shape of "submit_code_review called, then stream stalls".
          setTimeout(() => {
            handlers.forEach((h) => h({ type: 'tool.execution_complete', data: { toolName: 'my_tool' } }));
          }, 1000);
          return new Promise(() => {}); // sendAndWait itself never resolves
        }),
      };

      const mockClient = {
        createSession: vi.fn(),
        resumeSession: vi.fn(),
      } as any;

      const runPromise = runForcedToolTurn(session as any, {}, 'my_tool', 'test prompt', {
        client: mockClient,
        maxRetries: 2,
        maxStallRetries: 2,
        getResult: () => ({ ok: true }),
        tools: [],
      });

      await vi.advanceTimersByTimeAsync(STALL_TIMEOUT_MS + 5000);
      const result = await runPromise;

      expect(result.toolCalled).toBe(true);
      expect(result.result).toEqual({ ok: true });
      expect(mockClient.resumeSession).not.toHaveBeenCalled();
      expect(mockClient.createSession).not.toHaveBeenCalled();
    });
  });

  describe('sendAndWaitWithAbort SDK timeout decoupling', () => {
    it('does not pass a long caller timeoutMs straight through as the SDK\'s own absolute deadline', async () => {
      let capturedTimeout: number | undefined;
      const session = {
        sessionId: 's-long-healthy-turn',
        on: vi.fn().mockReturnValue(vi.fn()),
        sendAndWait: vi.fn().mockImplementation((_opts, timeout: number) => {
          capturedTimeout = timeout;
          return Promise.resolve();
        }),
      } as any;

      // Caller asks for a 10-minute budget (review-pr.ts's real value),
      // which exceeds STALL_TIMEOUT_MS -- so this should be raised past
      // SDK_HARD_TIMEOUT_CEILING_MS rather than forwarded verbatim, since
      // the SDK's own deadline would otherwise fire regardless of ongoing
      // progress.
      await sendAndWaitWithAbort(session, { prompt: 'hi' } as any, 600000);

      expect(capturedTimeout).toBeGreaterThan(600000);
    });

    it('passes a short caller timeoutMs straight through unchanged (fail-fast callers)', async () => {
      let capturedTimeout: number | undefined;
      const session = {
        sessionId: 's-short-deadline',
        on: vi.fn().mockReturnValue(vi.fn()),
        sendAndWait: vi.fn().mockImplementation((_opts, timeout: number) => {
          capturedTimeout = timeout;
          return Promise.resolve();
        }),
      } as any;

      // gateLoop.ts's clarity-check/classification callers pass short,
      // genuinely-hard deadlines (20s/30s) below STALL_TIMEOUT_MS and rely
      // on them firing before stall detection would ever engage -- these
      // must NOT be raised, or a real hang goes from failing in ~20-30s to
      // failing in ~90s x (maxStallRetries + 1).
      await sendAndWaitWithAbort(session, { prompt: 'hi' } as any, 20000);

      expect(capturedTimeout).toBe(20000);
    });
  });
});
