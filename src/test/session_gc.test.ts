import { describe, it, beforeEach, afterEach } from 'vitest';
import assert from 'node:assert';

import { activeSessions, sessionWritePromises } from '../../server';
import { sweepStaleSessions } from '../services/sessionGarbageCollector';

describe('Session TTL Garbage Collector Tests', () => {
  beforeEach(() => {
    activeSessions.clear();
    sessionWritePromises.clear();
  });

  afterEach(() => {
    activeSessions.clear();
    sessionWritePromises.clear();
  });

  it('correctly prunes stale sessions from activeSessions, sessionWritePromises, and activeLocks when they exceed TTL', async () => {
    const staleSessionId = 'stale-session-gc-test';
    const mockRes = {};
    let abortCalled = false;
    const mockAbortController = new AbortController();
    const originalAbort = mockAbortController.abort.bind(mockAbortController);
    mockAbortController.abort = () => {
      abortCalled = true;
      return originalAbort();
    };
    
    // Setup stale session
    const mockDisconnectCalled = { value: false };
    const mockSessionRecord: any = {
      sessionId: staleSessionId,
      lastUsedAt: Date.now() - 31 * 60 * 1000, // 31 minutes ago (TTL is 30 mins)
      copilotSession: {
        disconnect: async () => {
          mockDisconnectCalled.value = true;
        }
      }
    };
    
    activeSessions.set(staleSessionId, mockSessionRecord);
    sessionWritePromises.set(staleSessionId, Promise.resolve());

    const sseResToSessionId = new Map([[mockRes, staleSessionId]]);
    const activeLocks = new Map([[staleSessionId, mockAbortController]]);

    await sweepStaleSessions({
      activeSessions,
      sessionWritePromises,
      sseResToSessionId,
      activeLocks,
      ttlMs: 30 * 60 * 1000,
      writeLog: () => {},
    });

    // Verify cleanup
    assert.strictEqual(activeSessions.has(staleSessionId), false, 'Stale session must be evicted from activeSessions');
    assert.strictEqual(sessionWritePromises.has(staleSessionId), false, 'Stale session must be evicted from sessionWritePromises');
    assert.strictEqual(sseResToSessionId.has(mockRes), false, 'SSE response mapping must be removed during GC eviction');
    assert.strictEqual(abortCalled, true, 'activeLocks AbortController must be aborted during GC eviction');
    assert.strictEqual(activeLocks.has(staleSessionId), false, 'activeLocks entry must be removed during GC eviction');
    assert.strictEqual(mockAbortController.signal.aborted, true, 'AbortController signal must be aborted during GC eviction');
    assert.strictEqual(mockDisconnectCalled.value, true, 'copilotSession.disconnect() must be invoked during GC eviction');
  });
});
