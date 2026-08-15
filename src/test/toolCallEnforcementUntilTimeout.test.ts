import { describe, it, expect, vi } from 'vitest';
import { runForcedToolTurnUntilTimeout, FORCED_TOOL_TURN_HARD_TIMEOUT_MS } from '../utils/toolCallEnforcement';
import { SessionWrapper } from '../copilotSdk/sessionWrapper';

function makeWrapper(client: unknown, toolNames: string[] = ['my_tool']): SessionWrapper {
  return new SessionWrapper(client as any, { builtins: toolNames }, {})
    .setModelName('test-model')
    .setSystemPrompt('');
}

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
      createSession: vi.fn().mockResolvedValue(mockSession),
      resumeSession: vi.fn().mockImplementation(async (id, opts) => {
        expect(opts.availableTools).toEqual(['my_tool']);
        return mockSession;
      }),
    } as any;

    const runPromise = runForcedToolTurnUntilTimeout(makeWrapper(mockClient), 'my_tool', 'test prompt', {
      maxRetries: 1,
      getResult: () => null,
      provider: 'openrouter',
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

    const mockClient = {
      createSession: vi.fn().mockResolvedValue(mockSession),
      resumeSession: vi.fn(),
    } as any;

    const result = await runForcedToolTurnUntilTimeout(makeWrapper(mockClient), 'my_tool', 'test prompt', {
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

    const mockClient = {
      createSession: vi.fn().mockResolvedValue(mockSession),
      resumeSession: vi.fn(),
    } as any;

    await runForcedToolTurnUntilTimeout(makeWrapper(mockClient), 'my_tool', 'test prompt', {
      timeoutMs: 42,
      getResult: () => null,
    });

    expect(mockSession.sendAndWait).toHaveBeenCalledTimes(1);
    const [promptOpts, timeout] = mockSession.sendAndWait.mock.calls[0];
    expect(promptOpts.prompt).toContain('test prompt');
    expect(timeout).toBe(42);
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

    const mockClient = {
      createSession: vi.fn().mockResolvedValue(mockSession),
      resumeSession: vi.fn(),
    } as any;

    await runForcedToolTurnUntilTimeout(makeWrapper(mockClient), 'my_tool', 'test prompt', {
      getResult: () => null,
    });

    expect(FORCED_TOOL_TURN_HARD_TIMEOUT_MS).toBe(60 * 60 * 1000);
    expect(mockSession.sendAndWait).toHaveBeenCalledTimes(1);
    const [promptOpts, timeout] = mockSession.sendAndWait.mock.calls[0];
    expect(promptOpts.prompt).toContain('test prompt');
    expect(timeout).toBe(FORCED_TOOL_TURN_HARD_TIMEOUT_MS);
  });

  it('carries a caller-provided systemMessage through the nudge-retry resumeSession call (issue #208 regression)', async () => {
    const mockSession = {
      sessionId: 'test-session',
      on: vi.fn().mockReturnValue(vi.fn()),
      sendAndWait: vi.fn().mockImplementation(async () => {}),
    } as any;

    const mockClient = {
      createSession: vi.fn().mockResolvedValue(mockSession),
      resumeSession: vi.fn().mockImplementation(async (_id, opts) => {
        expect(opts.systemMessage).toEqual({ mode: 'customize', content: 'curated auditor prompt' });
        return mockSession;
      }),
    } as any;

    const wrapper = makeWrapper(mockClient).setSystemPrompt('curated auditor prompt');

    const runPromise = runForcedToolTurnUntilTimeout(wrapper, 'my_tool', 'test prompt', {
      maxRetries: 1,
      getResult: () => null,
    });

    await expect(runPromise).rejects.toThrow(/Session ended without calling 'my_tool'/);
    expect(mockClient.resumeSession).toHaveBeenCalledTimes(1);
  });

  it('preserves the full construction-time tool set (not narrowed to targetTools) as availableTools across a nudge-retry resume (issue #299 regression)', async () => {
    const mockSession = {
      sessionId: 'test-session',
      on: vi.fn().mockReturnValue(vi.fn()),
      sendAndWait: vi.fn().mockImplementation(async () => {}),
    } as any;

    const mockClient = {
      createSession: vi.fn().mockResolvedValue(mockSession),
      resumeSession: vi.fn().mockImplementation(async (_id, opts) => {
        expect(opts.availableTools).toEqual(['my_tool', 'run_terminal_docker']);
        return mockSession;
      }),
    } as any;

    const runPromise = runForcedToolTurnUntilTimeout(
      makeWrapper(mockClient, ['my_tool', 'run_terminal_docker']),
      'my_tool',
      'test prompt',
      {
        maxRetries: 1,
        getResult: () => null,
      },
    );

    await expect(runPromise).rejects.toThrow(/Session ended without calling 'my_tool'/);
    expect(mockClient.resumeSession).toHaveBeenCalledTimes(1);
  });

  it('keeps a non-target construction-time tool (e.g. run_terminal_docker) enabled across a nudge-retry resume, not just the forced target tool (issue #299 regression via auditorHelper.ts)', async () => {
    const mockSession = {
      sessionId: 'test-session',
      on: vi.fn().mockReturnValue(vi.fn()),
      sendAndWait: vi.fn().mockImplementation(async () => {}),
    } as any;

    let capturedOnPermissionRequest: ((req: any, invocation: any) => Promise<any>) | undefined;

    const mockClient = {
      createSession: vi.fn().mockImplementation(async (opts: any) => {
        capturedOnPermissionRequest = opts.onPermissionRequest;
        return mockSession;
      }),
      resumeSession: vi.fn().mockResolvedValue(mockSession),
    } as any;

    // Mirrors auditorHelper.ts's wrapper construction: `run_terminal_docker`
    // is a construction-time custom tool alongside the forced target tool
    // (`my_tool`), not passed via `availableTools` to runForcedToolTurnUntilTimeout.
    const wrapper = new SessionWrapper(
      mockClient,
      {
        custom: [
          { name: 'my_tool', description: '', parameters: {}, handler: async () => ({}) },
          { name: 'run_terminal_docker', description: '', parameters: {}, handler: async () => ({}) },
        ],
      },
      {},
    )
      .setModelName('test-model')
      .setSystemPrompt('');

    const runPromise = runForcedToolTurnUntilTimeout(wrapper, 'my_tool', 'test prompt', {
      maxRetries: 1,
      getResult: () => null,
      // Intentionally NOT passing `availableTools: ['my_tool', 'run_terminal_docker']`
      // here -- see auditorHelper.ts's comment on why that would disable
      // run_terminal_docker instead of preserving it.
    });

    await expect(runPromise).rejects.toThrow(/Session ended without calling 'my_tool'/);

    expect(capturedOnPermissionRequest).toBeDefined();
    await expect(
      capturedOnPermissionRequest!({ kind: 'custom-tool', toolName: 'run_terminal_docker' }, { sessionId: 'test-session' }),
    ).resolves.toMatchObject({ kind: 'approve-once' });
  });

  it('rejects on abort signal without touching resumeSession', async () => {
    const abortController = new AbortController();
    const mockSession = {
      sessionId: 's4',
      on: vi.fn().mockReturnValue(vi.fn()),
      sendAndWait: vi.fn().mockImplementation(() => new Promise(() => {})), // never resolves
    } as any;

    const mockClient = {
      createSession: vi.fn().mockResolvedValue(mockSession),
      resumeSession: vi.fn(),
    } as any;

    const runPromise = runForcedToolTurnUntilTimeout(makeWrapper(mockClient), 'my_tool', 'test prompt', {
      abortSignal: abortController.signal,
      getResult: () => null,
    });

    abortController.abort();

    await expect(runPromise).rejects.toThrow(/aborted/);
    expect(mockClient.resumeSession).not.toHaveBeenCalled();
  });
});
