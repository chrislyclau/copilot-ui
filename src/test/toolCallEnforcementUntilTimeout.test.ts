import { describe, it, expect, vi } from 'vitest';
import { runForcedToolTurnUntilTimeout, FORCED_TOOL_TURN_HARD_TIMEOUT_MS } from '../utils/toolCallEnforcement';

describe('runForcedToolTurnUntilTimeout', () => {
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
      }),
    } as any;

    const mockClient = {
      resumeSession: vi.fn().mockImplementation(async (id, opts) => {
        expect(opts.availableTools).toEqual(['my_tool']);
        return mockSession;
      }),
    } as any;

    const runPromise = runForcedToolTurnUntilTimeout(mockSession, { provider: 'openrouter' }, 'my_tool', 'test prompt', {
      client: mockClient,
      maxRetries: 1,
      getResult: () => null,
      tools: [],
    });

    await expect(runPromise).rejects.toThrow(/Session ended without calling 'my_tool' after 1 retry/);
    expect(callCount).toBe(2);
    expect(mockClient.resumeSession).toHaveBeenCalledTimes(1);
  });

  it('resolves once the target tool fires, without any resume', async () => {
    const mockSession = {
      sessionId: 's1',
      on: vi.fn().mockImplementation((handler) => {
        handler({ type: 'tool.execution_start', data: { toolName: 'my_tool' } });
        return vi.fn();
      }),
      sendAndWait: vi.fn().mockResolvedValue(undefined),
    } as any;

    const mockClient = { resumeSession: vi.fn() } as any;

    const result = await runForcedToolTurnUntilTimeout(mockSession, {}, 'my_tool', 'test prompt', {
      client: mockClient,
      getResult: () => ({ ok: true }),
    });

    expect(result.toolCalled).toBe(true);
    expect(result.result).toEqual({ ok: true });
    expect(mockClient.resumeSession).not.toHaveBeenCalled();
  });

  it('passes timeoutMs straight through to sendAndWait (no watchdog ceiling applied)', async () => {
    const mockSession = {
      sessionId: 's2',
      on: vi.fn().mockImplementation((handler) => {
        handler({ type: 'tool.execution_start', data: { toolName: 'my_tool' } });
        return vi.fn();
      }),
      sendAndWait: vi.fn().mockResolvedValue(undefined),
    } as any;

    await runForcedToolTurnUntilTimeout(mockSession, {}, 'my_tool', 'test prompt', {
      client: { resumeSession: vi.fn() } as any,
      timeoutMs: 42,
      getResult: () => null,
    });

    expect(mockSession.sendAndWait).toHaveBeenCalledWith({ prompt: 'test prompt' }, 42);
  });

  it('defaults timeoutMs to FORCED_TOOL_TURN_HARD_TIMEOUT_MS (60 min) when unset', async () => {
    const mockSession = {
      sessionId: 's3',
      on: vi.fn().mockImplementation((handler) => {
        handler({ type: 'tool.execution_start', data: { toolName: 'my_tool' } });
        return vi.fn();
      }),
      sendAndWait: vi.fn().mockResolvedValue(undefined),
    } as any;

    await runForcedToolTurnUntilTimeout(mockSession, {}, 'my_tool', 'test prompt', {
      client: { resumeSession: vi.fn() } as any,
      getResult: () => null,
    });

    expect(FORCED_TOOL_TURN_HARD_TIMEOUT_MS).toBe(60 * 60 * 1000);
    expect(mockSession.sendAndWait).toHaveBeenCalledWith({ prompt: 'test prompt' }, FORCED_TOOL_TURN_HARD_TIMEOUT_MS);
  });

  it('rejects on abort signal without touching resumeSession', async () => {
    const abortController = new AbortController();
    const mockSession = {
      sessionId: 's4',
      on: vi.fn().mockReturnValue(vi.fn()),
      sendAndWait: vi.fn().mockImplementation(() => new Promise(() => {})), // never resolves
    } as any;
    const mockClient = { resumeSession: vi.fn() } as any;

    const runPromise = runForcedToolTurnUntilTimeout(mockSession, {}, 'my_tool', 'test prompt', {
      client: mockClient,
      abortSignal: abortController.signal,
      getResult: () => null,
    });

    abortController.abort();

    await expect(runPromise).rejects.toThrow(/aborted/);
    expect(mockClient.resumeSession).not.toHaveBeenCalled();
  });
});
