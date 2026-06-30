import type express from 'express';
import type { CopilotEventData, SessionRecord, Turn } from '../types/session';

export interface SseWriterDependencies {
  activeSessions: Map<string, SessionRecord>;
  sseResToSessionId: Map<express.Response, string>;
  writeLog: (message: string) => void;
}

export interface SseWriter {
  secureWrite: (res: any, data: string, isRequestClosed?: boolean) => Promise<void>;
  flushSseAndEnd: (res: any) => Promise<void>;
  sseWriteLocks: Map<express.Response, Promise<void>>;
}

export function createSseWriter({
  activeSessions,
  sseResToSessionId,
  writeLog,
}: SseWriterDependencies): SseWriter {
  const sseWriteLocks = new Map<express.Response, Promise<void>>();

  async function secureWrite(res: any, data: string, isRequestClosed: boolean = false) {
    if (res.simulateBackpressureDelayMs && Number(res.simulateBackpressureDelayMs) > 0) {
      await new Promise(r => setTimeout(r, Number(res.simulateBackpressureDelayMs)));
    }
    writeLog(`[WRITE] secureWrite called, isRequestClosed=${isRequestClosed} length=${data.length}`);
    let eventObj: any = null;
    let sessionObj: any = null;
    if (data.startsWith('data: {')) {
      writeLog(`[SSE] data written: ${data.trim().replace(/^data:\s*/, '')}`);
      const sessId = sseResToSessionId.get(res);
      if (sessId) {
        const session = activeSessions.get(sessId);
        if (session) {
          sessionObj = session;
          try {
            const jsonStr = data.substring(5).trim();
            if (jsonStr) {
              eventObj = JSON.parse(jsonStr);
              if (eventObj && typeof eventObj === 'object') {
                const newSequenceCounter = (session.eventSequenceCounter || 0) + 1;
                activeSessions.set(sessId, {
                  ...session,
                  eventSequenceCounter: newSequenceCounter,
                  turns: session.turns ? [...session.turns] : []
                });
                const updatedSession = activeSessions.get(sessId)!;
                if (!eventObj.data || typeof eventObj.data !== 'object') {
                  eventObj.data = {};
                }
                eventObj.data.sequenceId = newSequenceCounter;

                if (updatedSession.stateSnapshot) {
                  eventObj.data.stateSnapshot = updatedSession.stateSnapshot;
                }

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
                    { ...turn, events: [...turn.events, eventObj] } : turn
                  );
                  activeSessions.set(sessId, {
                    ...currentSession,
                    turns: updatedTurns
                  });
                }

                data = `data: ${JSON.stringify(eventObj)}\n\n`;
              }
            }
          } catch (err: any) {
            writeLog(`[secureWrite] Error recording session event: ${err.message}`);
          }
        }
      }
    }
    if (!(res as any)._cleanupRegistered) {
      (res as any)._cleanupRegistered = true;
      res.once('close', () => {
        sseWriteLocks.delete(res);
      });
    }
    const lock = sseWriteLocks.get(res) || Promise.resolve();
    const nextLock = lock.then(() => {
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
          res.once('drain', () => {
            clearTimeout(timeoutId);
            writeLog(`[Backpressure] Streaming buffer drained. Resuming...`);
            resolve();
          });

          res.once('close', () => {
            clearTimeout(timeoutId);
            resolve();
          });
        } else {
          clearTimeout(timeoutId);
          resolve();
        }
      });
    }).catch(err => {
      writeLog(`[SSE Lock Error] ${err}`);
      if (sessionObj && eventObj) {
        if (!sessionObj.diagnosticTrail) {
          sessionObj.diagnosticTrail = [];
        }
        sessionObj.diagnosticTrail.push(eventObj);
        writeLog(`[secureWrite] Appended dropped event ${eventObj.type} to diagnosticTrail.`);

        if (sessionObj.turns && sessionObj.turns.length > 0) {
          const currentTurn = sessionObj.turns[sessionObj.turns.length - 1];
          const index = currentTurn.events.indexOf(eventObj);
          if (index !== -1) {
            currentTurn.events.splice(index, 1);
            writeLog(`[secureWrite] Removed dropped event from current turn to avoid client serialization drift.`);
          }
        }
      }
      throw err;
    });
    sseWriteLocks.set(res, nextLock.catch(() => {}));
    await nextLock;
  }

  async function flushSseAndEnd(res: any): Promise<void> {
    let lock = sseWriteLocks.get(res);
    while (lock) {
      writeLog(`[SSE Flush] Awaiting pending writes in sseWriteLocks before ending response...`);
      await lock;
      const newLock = sseWriteLocks.get(res);
      if (newLock === lock) break;
      lock = newLock;
    }
    sseWriteLocks.delete(res);
    if (typeof res.flush === 'function') {
      res.flush();
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
