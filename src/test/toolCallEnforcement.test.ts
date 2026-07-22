import { describe, it, expect, vi } from 'vitest';
import { runForcedToolTurn } from '../utils/toolCallEnforcement';

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
