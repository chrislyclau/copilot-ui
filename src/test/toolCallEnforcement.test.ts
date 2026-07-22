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

  it('resumeSession does not receive or alter the original prompt prefix', async () => {
    const sentPrompts: string[] = [];
    const initialPrompt = 'test prompt prefix that must survive untouched';
    let toolListener: ((event: unknown) => void) | undefined;

    const mockSession = {
      sessionId: 'test-session',
      on: vi.fn().mockImplementation((listener: (event: unknown) => void) => {
        toolListener = listener;
        return vi.fn();
      }),
      sendAndWait: vi.fn().mockImplementation(async (opts) => {
        sentPrompts.push(opts.prompt);
        // Simulate the tool being called on the resumed (second) turn only,
        // so the retry loop naturally exits with toolCalled === true instead
        // of exhausting retries.
        if (sentPrompts.length === 2) {
          toolListener?.({ type: 'tool.execution_complete', data: { toolName: 'my_tool' } });
        }
      })
    } as any;

    const mockClient = {
      resumeSession: vi.fn().mockImplementation(async (id, opts) => {
        // resumeSession's config must only carry session-level settings
        // (toolset/provider restriction) -- never the prompt itself. If it
        // ever gained a `prompt`/`initialPrompt`/message field, that would
        // mean the original prompt's prefix is being re-sent or mutated
        // through the resume path instead of staying untouched as the first
        // turn's message.
        expect(opts).not.toHaveProperty('prompt');
        expect(opts).not.toHaveProperty('initialPrompt');
        expect(opts).not.toHaveProperty('messages');
        expect(Object.keys(opts).sort()).toEqual(['availableTools', 'tools']);
        return mockSession;
      })
    } as any;

    await runForcedToolTurn(mockSession, {}, 'my_tool', initialPrompt, {
      client: mockClient,
      maxRetries: 1,
      getResult: () => 'ok',
      tools: []
    });

    // The first turn's prompt must be exactly the original prompt, verbatim
    // -- nothing prepended, appended, or otherwise modified before it's sent.
    expect(sentPrompts[0]).toBe(initialPrompt);

    // The retry nudge is a distinct, separate message -- it must not be a
    // concatenation of (or otherwise contain) the original prompt, which
    // would indicate the prefix leaked into/was reused by the resumed turn.
    expect(sentPrompts[1]).not.toContain(initialPrompt);

    expect(mockClient.resumeSession).toHaveBeenCalledTimes(1);
  });
});
