import type { SessionRecord } from '../types/session';

export interface SessionGarbageCollectorDependencies {
  activeSessions: Map<string, SessionRecord>;
  sessionWritePromises: Map<string, Promise<void>>;
  sseResToSessionId: Map<unknown, string>;
  activeLocks: Map<string, AbortController>;
  ttlMs: number;
  writeLog: (message: string) => void;
}

export async function sweepStaleSessions({
  activeSessions,
  sessionWritePromises,
  sseResToSessionId,
  activeLocks,
  ttlMs,
  writeLog,
}: SessionGarbageCollectorDependencies): Promise<number> {
  const now = Date.now();
  const staleSessionIds: string[] = [];

  for (const [sessionId, record] of activeSessions.entries()) {
    const isRunning = Boolean(record.stateSnapshot?.isRunning);
    const isStale = now - record.lastUsedAt > ttlMs;
    if (!isRunning && isStale) {
      staleSessionIds.push(sessionId);
    }
  }

  for (const sessionId of staleSessionIds) {
    const record = activeSessions.get(sessionId);
    if (!record) continue;

    writeLog(`[Session GC] Evicting stale session ${sessionId}.`);
    sessionWritePromises.delete(sessionId);

    const controller = activeLocks.get(sessionId);
    if (controller) {
      try {
        controller.abort();
      } catch {
        // ignore
      }
    }
    activeLocks.delete(sessionId);
    for (const [res, mappedSessionId] of sseResToSessionId.entries()) {
      if (mappedSessionId === sessionId) {
        sseResToSessionId.delete(res);
      }
    }

    activeSessions.delete(sessionId);

    try {
      await record.unsubscribe?.();
    } catch (err) {
      writeLog(`[Session GC] Failed to unsubscribe stale session ${sessionId}: ${err}`);
    }

    try {
      await record.copilotSession.disconnect();
    } catch (err) {
      writeLog(`[Session GC] Failed to disconnect stale session ${sessionId}: ${err}`);
    }
  }

  return staleSessionIds.length;
}

export function startSessionGarbageCollector(
  deps: SessionGarbageCollectorDependencies,
  sweepIntervalMs: number = 5 * 60 * 1000,
): () => void {
  const timer = setInterval(() => {
    void sweepStaleSessions(deps).catch(err => {
      deps.writeLog(`[Session GC] Sweep failed: ${err}`);
    });
  }, sweepIntervalMs);

  if (typeof (timer as any).unref === 'function') {
    (timer as any).unref();
  }

  return () => clearInterval(timer);
}
