import { describe, it, expect } from 'vitest';
import { withRetainedHistory, CopilotCreateSessionOptions } from '../orchestrator/sessionState';

// Exercises withRetainedHistory in isolation: the pure config-merging step
// that getOrCreateSession's createSession-fallback branch relies on to avoid
// silently dropping conversation history (#155).
describe('withRetainedHistory', () => {
  const history = [
    { role: 'user' as const, content: 'Build a login form.' },
    { role: 'assistant' as const, content: 'Added LoginForm.tsx.' },
  ];

  it('returns the options unchanged when there is no history to carry forward', () => {
    const options: CopilotCreateSessionOptions = { model: 'gemini-3.1-flash-lite' };
    expect(withRetainedHistory(options, [])).toBe(options);
  });

  it('appends history into systemMessage.content when systemMessage is unset (default append mode)', () => {
    const options: CopilotCreateSessionOptions = { model: 'gemini-3.1-flash-lite' };
    const result = withRetainedHistory(options, history);

    expect(result.systemMessage?.mode).toBeUndefined();
    expect(result.systemMessage?.content).toContain('[Retained Conversation History]');
    expect(result.systemMessage?.content).toContain('user: Build a login form.');
    expect(result.systemMessage?.content).toContain('assistant: Added LoginForm.tsx.');
    // Original options object must not be mutated.
    expect(options.systemMessage).toBeUndefined();
  });

  it('appends history after existing content in append mode without discarding it', () => {
    const options: CopilotCreateSessionOptions = {
      systemMessage: { mode: 'append', content: 'Existing instructions.' },
    };
    const result = withRetainedHistory(options, history);

    expect(result.systemMessage?.content).toContain('Existing instructions.');
    expect(result.systemMessage?.content).toContain('[Retained Conversation History]');
    expect(result.systemMessage?.content?.indexOf('Existing instructions.')).toBeLessThan(
      result.systemMessage!.content!.indexOf('[Retained Conversation History]')
    );
  });

  it('appends history after existing content in customize mode, preserving sections', () => {
    const options: CopilotCreateSessionOptions = {
      systemMessage: {
        mode: 'customize',
        sections: { environment_context: { action: 'remove' } },
        content: 'Customize content.',
      },
    };
    const result = withRetainedHistory(options, history);

    expect(result.systemMessage?.mode).toBe('customize');
    expect((result.systemMessage as any).sections).toEqual({ environment_context: { action: 'remove' } });
    expect(result.systemMessage?.content).toContain('Customize content.');
    expect(result.systemMessage?.content).toContain('[Retained Conversation History]');
  });

  it('applies the 40k-char working-memory truncation before folding history in', () => {
    // A single oversized entry comfortably exceeds the 40,000-char budget
    // enforced by enforceWorkingMemoryTruncation, so the raw content must not
    // survive verbatim into the system message.
    const hugeEntry = { role: 'assistant' as const, content: 'x'.repeat(100_000) };
    const options: CopilotCreateSessionOptions = { model: 'gemini-3.1-flash-lite' };

    const result = withRetainedHistory(options, [hugeEntry]);

    const content = result.systemMessage?.content;
    expect(content).toBeDefined();
    expect(content!.length).toBeLessThan(hugeEntry.content.length);
    expect(content!.length).toBeLessThan(45_000);
  });

  it('appends history onto replace-mode content rather than dropping it', () => {
    const options: CopilotCreateSessionOptions = {
      systemMessage: { mode: 'replace', content: 'Full custom system message.' },
    };
    const result = withRetainedHistory(options, history);

    expect(result.systemMessage?.mode).toBe('replace');
    expect(result.systemMessage?.content).toContain('Full custom system message.');
    expect(result.systemMessage?.content).toContain('[Retained Conversation History]');
  });
});
