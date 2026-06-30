import { describe, it, expect, vi } from 'vitest';

import { createSseWriter } from '../utils/sseWriter';

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
