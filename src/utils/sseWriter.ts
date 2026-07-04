import type { Response } from 'express';
import type { CopilotEventData, CopilotEventPayload, SessionRecord, Turn, StateSnapshot } from '../types/session';
import { LogLevel } from '../orchestrator/sessionState';

export interface ExtendedResponse extends Response {
  simulateBackpressureDelayMs?: number;
  _cleanupRegistered?: boolean;
}

export interface SseWriterDependencies {
  activeSessions: Map<string, SessionRecord>;
  sseResToSessionId: Map<Response, string>;
  writeLog: (message: string, level?: LogLevel) => void;
}

export interface SseWriter {
  secureWrite: (res: Response, data: string, isRequestClosed?: boolean) => Promise<void>;
  flushSseAndEnd: (res: Response) => Promise<void>;
  sseWriteLocks: Map<Response, Promise<void>>;
}

export interface RawEventObj {
  readonly id?: string;
  readonly timestamp?: string;
  readonly type?: string;
  readonly sequenceId?: number;
  readonly data?: unknown;
  readonly [key: string]: unknown;
}

/**
 * Enriches a parsed event payload with a sequenceId and the session's stateSnapshot.
 */
export function enrichEventPayload(
  parsedEventObj: RawEventObj,
  sequenceId: number,
  stateSnapshot?: StateSnapshot
): CopilotEventData {
  const rawData = parsedEventObj.data;
  const enrichedData = (rawData && typeof rawData === 'object'
    ? { ...rawData }
    : {}) as Record<string, unknown>;

  enrichedData.sequenceId = sequenceId;

  if (stateSnapshot) {
    enrichedData.stateSnapshot = stateSnapshot;
  }

  return {
    ...parsedEventObj,
    id: parsedEventObj.id || '',
    timestamp: parsedEventObj.timestamp || new Date().toISOString(),
    type: parsedEventObj.type || 'unknown',
    sequenceId,
    data: enrichedData as CopilotEventPayload
  };
}

export function createSseWriter({
  activeSessions,
  sseResToSessionId,
  writeLog,
}: SseWriterDependencies): SseWriter {
  const sseWriteLocks = new Map<Response, Promise<void>>();

  async function secureWrite(res: Response, data: string, isRequestClosed: boolean = false) {
    if (res.destroyed || res.writableEnded || isRequestClosed) {
      writeLog(`[WRITE] secureWrite skipped early because response is closed/destroyed/writableEnded.`, LogLevel.DEBUG);
      return;
    }
    const extRes = res as ExtendedResponse;
    if (extRes.simulateBackpressureDelayMs && Number(extRes.simulateBackpressureDelayMs) > 0) {
      await new Promise(r => setTimeout(r, Number(extRes.simulateBackpressureDelayMs)));
    }
    writeLog(`[WRITE] secureWrite called, isRequestClosed=${isRequestClosed} length=${data.length}`, LogLevel.DEBUG);
    let eventObj: CopilotEventData | null = null;
    let sessionObj: SessionRecord | null = null;

    if (!extRes._cleanupRegistered) {
      extRes._cleanupRegistered = true;
      res.once('close', () => {
        sseWriteLocks.delete(res);
      });
    }

    const lock = sseWriteLocks.get(res) || Promise.resolve();
    const nextLock = lock.then(async () => {
      // 1. Session State Recording (Moved inside lock to prevent races)
      if (data.startsWith('data: {')) {
        const sessId = sseResToSessionId.get(res);
        if (sessId) {
          const session = activeSessions.get(sessId);
          if (session) {
            sessionObj = session;
            try {
              const jsonStr = data.substring(5).trim();
              if (jsonStr) {
                const parsedEventObj = JSON.parse(jsonStr);
                if (parsedEventObj && typeof parsedEventObj === 'object') {
                  const newSequenceCounter = (session.eventSequenceCounter || 0) + 1;
                  activeSessions.set(sessId, {
                    ...session,
                    eventSequenceCounter: newSequenceCounter,
                    turns: session.turns ? [...session.turns] : []
                  });
                  const updatedSession = activeSessions.get(sessId)!;
                  const typedEventObj = enrichEventPayload(
                    parsedEventObj,
                    newSequenceCounter,
                    updatedSession.stateSnapshot
                  );
                  eventObj = typedEventObj;

                  if (updatedSession.turns.length === 0) {
                    const newTurn: Turn = {
                      id: `turn-fallback-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`,
                      taskLabel: 'System Recovery / Unknown Turn',
                      status: 'running',
                      events: [] as CopilotEventData[]
                    };
                    activeSessions.set(sessId, {
                      ...updatedSession,
                      turns: [...updatedSession.turns, newTurn]
                    });
                  }
                  const currentSession = activeSessions.get(sessId)!;
                  const currentTurn = currentSession.turns[currentSession.turns.length - 1];
                  if (currentTurn) {
                    const updatedTurns = currentSession.turns.map((turn, index) =>
                      index === currentSession.turns.length - 1 ?
                      { ...turn, events: [...turn.events, typedEventObj] } : turn
                    );
                    activeSessions.set(sessId, {
                      ...currentSession,
                      turns: updatedTurns
                    });
                  }

                  data = `data: ${JSON.stringify(typedEventObj)}\n\n`;
                }
              }
            } catch (err: unknown) {
              writeLog(`[secureWrite] Error recording session event: ${err instanceof Error ? err.message : String(err)}`);
            }
          }
        }
      }

      return new Promise<void>((resolve, reject) => {
        if (res.writableEnded || res.destroyed) {
          writeLog(`[WRITE] secureWrite skipped, res.writableEnded=${res.writableEnded} res.destroyed=${res.destroyed}`);
          resolve();
          return;
        }

        const timeoutId = setTimeout(() => {
          writeLog(`[WRITE] Streaming buffer flush timeout (5000ms). Breaking socket and releasing reservation lock.`);
          res.destroy();
          reject(new Error('Streaming buffer flush timeout (5000ms). Socket flagged as broken.'));
        }, 5000);

        const canWrite = res.write(data);
        writeLog(`[WRITE] secureWrite result: canWrite=${canWrite}`);
        if (!canWrite) {
          writeLog(`[Backpressure] Streaming buffer full. Pausing until drain...`);
          let settled = false;
          const cleanup = () => {
            if (settled) return;
            settled = true;
            clearTimeout(timeoutId);
            res.removeListener('close', onClose);
            res.removeListener('drain', onDrain);
          };
          const onClose = () => {
            cleanup();
            resolve();
          };
          const onDrain = () => {
            cleanup();
            writeLog(`[Backpressure] Streaming buffer drained. Resuming...`);
            resolve();
          };
          res.once('close', onClose);
          res.once('drain', onDrain);
        } else {
          clearTimeout(timeoutId);
          resolve();
        }
      });
    }).catch(err => {
      writeLog(`[SSE Lock Error] ${err}`);
      if (sessionObj && eventObj) {
        const sessionId = sessionObj.sessionId;
        const currentSession = sessionId ? activeSessions.get(sessionId) : undefined;
        const baseSession = currentSession;
        if (!baseSession) {
          throw err;
        }

        const nextDiagnosticTrail = [...(baseSession.diagnosticTrail || []), eventObj];
        let nextTurns = baseSession.turns;
        if (Array.isArray(baseSession.turns) && baseSession.turns.length > 0) {
          const lastIndex = baseSession.turns.length - 1;
          const lastTurn = baseSession.turns[lastIndex];
          const filteredEvents = Array.isArray(lastTurn.events)
            ? lastTurn.events.filter((ev: CopilotEventData) => ev !== eventObj)
            : lastTurn.events;
          nextTurns = baseSession.turns.map((turn: Turn, idx: number) =>
            idx === lastIndex ? { ...turn, events: filteredEvents } : turn,
          );
        }

        if (sessionId) {
          activeSessions.set(sessionId, { ...baseSession, diagnosticTrail: nextDiagnosticTrail, turns: nextTurns });
          writeLog(`[secureWrite] Appended dropped event ${eventObj.type} to diagnosticTrail.`);
          if (Array.isArray(baseSession.turns) && baseSession.turns.length > 0) {
            writeLog(`[secureWrite] Removed dropped event from current turn to avoid client serialization drift.`);
          }
        }
      }
      throw err;
    });
    if (res.writableEnded || res.destroyed) {
      writeLog(`[WRITE] secureWrite skipped, res.writableEnded=${res.writableEnded} res.destroyed=${res.destroyed}`);
      return;
    }
    sseWriteLocks.set(res, nextLock.catch(() => {}));
    await nextLock;
  }

  async function flushSseAndEnd(res: Response): Promise<void> {
    let lock = sseWriteLocks.get(res);
    while (lock) {
      writeLog(`[SSE Flush] Awaiting pending writes in sseWriteLocks before ending response...`);
      await lock;
      const newLock = sseWriteLocks.get(res);
      if (newLock === lock) break;
      lock = newLock;
    }
    sseWriteLocks.delete(res);
    if (typeof (res as any).flush === 'function') {
      (res as any).flush();
    }
    await new Promise<void>((resolve) => {
      if (res.writableNeedDrain) {
        writeLog(`[SSE Flush] Stream needs drain, waiting for drain event...`);
        res.once('drain', resolve);
      } else {
        process.nextTick(resolve);
      }
    });
    if (!res.writableEnded && !res.destroyed) {
      writeLog(`[SSE Flush] Call res.end() after resolving all write locks and drains.`);
      res.end();
    }
  }

  return { secureWrite, flushSseAndEnd, sseWriteLocks };
}
