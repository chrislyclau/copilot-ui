import { describe, it, expect, vi } from 'vitest';

import { createSseWriter, enrichEventPayload } from '../utils/sseWriter';

describe('enrichEventPayload helper', () => {
  it('correctly injects sequenceId and stateSnapshot into the parsed event payload', () => {
    const rawEvent = {
      type: 'assistant.message',
      data: {
        content: 'Hello world'
      }
    };
    const stateSnapshot = {
      isRunning: true,
      retryCount: 2,
      currentTier: 'gemini-3.1-flash-lite' as any,
      activeGate: 'runTests',
      hasFailureState: false,
      awaitingHuman: false
    };

    const enriched = enrichEventPayload(rawEvent, 42, stateSnapshot);

    expect(enriched.type).toBe('assistant.message');
    expect((enriched.data as any).content).toBe('Hello world');
    expect((enriched.data as any).sequenceId).toBe(42);
    expect((enriched.data as any).stateSnapshot).toEqual(stateSnapshot);
  });

  it('handles events with no existing data payload gracefully', () => {
    const rawEvent = {
      type: 'session.idle'
    };

    const enriched = enrichEventPayload(rawEvent, 10);

    expect(enriched.type).toBe('session.idle');
    expect((enriched.data as any).sequenceId).toBe(10);
    expect((enriched.data as any).stateSnapshot).toBeUndefined();
  });
});

describe('SSE writer lock handling', () => {
  it('does not reinsert a lock for a response that is already closed', async () => {
    const activeSessions = new Map();
    const sseResToSessionId = new Map();
    const writeLog = vi.fn();
    const { secureWrite, sseWriteLocks } = createSseWriter({
      activeSessions,
      sseResToSessionId,
      writeLog,
    });

    const res: any = {
      writableEnded: true,
      destroyed: true,
      once: vi.fn(),
      removeListener: vi.fn(),
      write: vi.fn(() => {
        throw new Error('write should not be called for closed responses');
      }),
    };

    await secureWrite(res, 'data: {"type":"test"}\n\n');

    expect(sseWriteLocks.has(res)).toBe(false);
  });
});
