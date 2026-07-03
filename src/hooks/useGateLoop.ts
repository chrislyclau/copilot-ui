import { useState, useCallback, useRef } from 'react';
import { ModelTier, DEFAULT_ROLES_CONFIG, MODEL_TIERS } from '../config/models';
import { CopilotEvent, TurnData } from '../mockEvents';
import { deriveEventMeta } from '../parser';
import { GateConfig } from '../types';
import { ExtendedSessionEvent } from '../types/events';
import { getSequenceId, CopilotEventData } from '../types/session';

interface HistoryPayload {
  readonly turns: readonly {
    readonly id: string;
    readonly events: readonly unknown[];
    readonly [key: string]: unknown;
  }[];
  readonly stateSnapshot?: {
    readonly minValidSequenceId?: number;
    readonly isRunning: boolean;
    readonly retryCount?: number;
    readonly currentTier?: ModelTier;
    readonly awaitingHuman?: boolean;
    readonly activeGate?: string;
    readonly hasFailureState?: boolean;
  };
}

export function useGateLoop(
  appendEventToScenario: (scenarioId: string, copilotEvent: CopilotEvent) => void,
  setScenarioEvents?: (scenarioId: string, events: readonly CopilotEvent[]) => void,
  setScenarioTurns?: (scenarioId: string, turns: readonly TurnData[], events: readonly CopilotEvent[]) => void
) {
  const [isRunning, setIsRunning] = useState(false);
  const [status, setStatus] = useState<'idle' | 'running' | 'complete' | 'shutdown' | 'error'>('idle');
  const [currentTier, setCurrentTier] = useState<ModelTier>(DEFAULT_ROLES_CONFIG.executorTiers?.[0]?.model || 'gemini-3.1-flash-lite');
  const [retryCount, setRetryCount] = useState(0);
  const [activeGate, setActiveGate] = useState<'tests' | 'lint' | 'audit' | undefined>(undefined);
  const [awaitingHuman, setAwaitingHuman] = useState(false);
  const [activeOutput, setActiveOutput] = useState<string>('');
  const [activeReplayTraceId, setActiveReplayTraceId] = useState<string | undefined>(undefined);
  
  const abortControllerRef = useRef<AbortController | undefined>(undefined);
  const activeSessionIdRef = useRef<string | undefined>(undefined);
  const completedRef = useRef(false);
  const clientLogRef = useRef<string[]>([]);

  const getClientLog = useCallback(() => clientLogRef.current, []);

  const logClient = useCallback((msg: string) => {
    const timestamp = new Date().toISOString();
    const formatted = `[Client] [${timestamp}] ${msg}`;
    clientLogRef.current.push(formatted);
    if (clientLogRef.current.length > 500) clientLogRef.current.shift();
    // Silent background push to shared server logs
    fetch('/api/diagnostics/log', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: formatted })
    }).catch(() => {});
  }, []);

  const executeStream = async (
    endpoint: string, 
    payload: GateConfig | { readonly sessionId: string | undefined; readonly input: string }, 
    sessionId: string, 
    setScenarioTurnsCb?: (scenarioId: string, turns: readonly TurnData[], events: readonly CopilotEvent[]) => void
  ) => {
    // Abort any existing in-flight run for this hook instance
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    abortControllerRef.current = new AbortController();

    let hydrationSettled = !((setScenarioEvents || setScenarioTurns) && sessionId);
    let pendingEventsQueue: readonly CopilotEventData[] = [];
    let minValidSeqIdFromSnapshot = 0;

    const processLiveEvent = (data: ExtendedSessionEvent) => {
      // Update active stream log line for Ambient Status Strip
      if (data.type === 'assistant.message_delta') {
        if (data.data?.deltaContent) {
          setActiveOutput(data.data.deltaContent);
        }
      } else if (data.type === 'tool.execution_start') {
        setActiveOutput(`Running ${data.data?.toolName || 'tool'}...`);
      } else if (data.type === 'tool.result' || data.type === 'tool.execution_complete') {
        const d = data.data as { readonly stdout?: string; readonly stderr?: string };
        const out = d?.stdout || d?.stderr || '';
        if (out) {
          const lastLine = out.split('\n').map((l: string) => l.trim()).filter(Boolean).pop();
          if (lastLine) setActiveOutput(lastLine);
        }
      } else if (data.type === 'gate.start') {
        setActiveOutput(`Checking Guard: ${data.data?.gateName || ''}...`);
      } else if (data.type === 'gate.result') {
        setActiveOutput(`Guard ${data.data?.gateName || ''} resolved: ${data.data?.pass ? 'PASSED' : 'FAILED'}`);
      } else if (data.type === 'assistant.streaming_delta') {
        if (data.data?.totalResponseSizeBytes) {
          setActiveOutput(`Streaming response: ${data.data.totalResponseSizeBytes} bytes`);
        }
      }

      // Handle specific events
      if (data.type === 'gate.start') {
        if (data.data?.gateName) {
          const mappedGate = 
            data.data.gateName === 'runTests' ? 'tests' :
            data.data.gateName === 'runLint' ? 'lint' :
            data.data.gateName === 'runAudit' ? 'audit' : undefined;
          setActiveGate(mappedGate);
        }
      } else if (data.type === 'loop.escalate_human') {
        setAwaitingHuman(true);
        setActiveGate(undefined);
      } else if (data.type === 'loop.retry') {
        const retryData = data.data;
        if (retryData.retryCount !== undefined) {
          setRetryCount(retryData.retryCount);
        }
        if (retryData.nextModel) {
          setCurrentTier(retryData.nextModel);
        }
        setActiveGate(undefined);
      } else if (data.type === 'gate.result') {
        const resData = data.data;
        if (resData && typeof resData === 'object' && resData.retryCount !== undefined) {
          setRetryCount(resData.retryCount as number);
        }
        setAwaitingHuman(false);
        setActiveGate(undefined);
      } else if (data.type === 'loop.clarity_check_failed') {
        setIsRunning(false);
        setStatus('error');
        setActiveGate(undefined);
        completedRef.current = true;
      } else if (data.type === 'loop.error') {
        setIsRunning(false);
        setStatus('error');
        setActiveGate(undefined);
        completedRef.current = true;
      } else if (data.type === 'loop.complete' || data.type === 'session.idle' || data.type === 'session.shutdown') {
        setIsRunning(false);
        setStatus(data.type === 'loop.complete' ? 'complete' : data.type === 'session.idle' ? 'idle' : 'shutdown');
        setActiveGate(undefined);
        completedRef.current = true;
      }
      
      const eventData = data.data;
      const { category, title } = deriveEventMeta(data.type || 'system.unknown', eventData);
      const copilotEvent: CopilotEvent = {
        sessionEvent: {
          id: data.id || `evt-${Math.random().toString(36).substring(7)}`,
          timestamp: data.timestamp || new Date().toISOString(),
          type: data.type || 'system.unknown',
          data: eventData || {}
        } as ExtendedSessionEvent,
        title,
        category
      };
      
      logClient(`[HOOK] appendEventToScenario called: scenarioId=${sessionId} type=${data.type}`);
      appendEventToScenario(sessionId, copilotEvent);
    };

    // T2: Connection drop hydration catch-up logic
    const hydrationPromise = (async () => {
      if (!hydrationSettled) {
        try {
          logClient(`Checking active execution footprint for session: ${sessionId}`);
          const histRes = await fetch(`/api/copilot/session/${sessionId}/history`, {
            signal: abortControllerRef.current!.signal
          });
          if (histRes.ok) {
            const histPayload = (await histRes.json()) as HistoryPayload;
            if (histPayload && histPayload.turns && histPayload.turns.length > 0) {
              logClient(`Active execution footprint detected. Hydrating ${histPayload.turns.length} turns from history.`);
              
              // Map turns and flatten events for backward compatibility
              const allFlattenedEvents: CopilotEvent[] = [];
              const mappedTurns: readonly TurnData[] = histPayload.turns.map((turn) => {
                const hydratedTurnEvents: readonly CopilotEvent[] = (turn.events || [])
                  .filter((item): item is { type: string; [key: string]: unknown } => 
                    item !== null && typeof item === 'object' && 'type' in item
                  )
                  .map((data) => {
                    const { category, title } = deriveEventMeta(data.type, data.data);
                    const ce: CopilotEvent = {
                      sessionEvent: {
                        id: (data.id as string) || `evt-${Math.random().toString(36).substring(7)}`,
                        timestamp: (data.timestamp as string) || new Date().toISOString(),
                        type: data.type,
                        data: data.data || {}
                      } as ExtendedSessionEvent,
                      title,
                      category
                    };
                    allFlattenedEvents.push(ce);
                    return ce;
                  });
                  return { ...turn, events: hydratedTurnEvents } as TurnData;
              });
              
              const turnsSetter = setScenarioTurnsCb || setScenarioTurns;
              turnsSetter?.(sessionId, mappedTurns, allFlattenedEvents);
              logClient(`Hydration complete. React state array atomic-swapped.`);
            }

            if (histPayload && histPayload.stateSnapshot) {
              const snap = histPayload.stateSnapshot;
              if (snap.minValidSequenceId !== undefined) {
                minValidSeqIdFromSnapshot = snap.minValidSequenceId;
              }
              setIsRunning(snap.isRunning);
              setRetryCount(snap.retryCount || 0);
              setCurrentTier(snap.currentTier || 'gemini-3.1-flash-lite');
              setAwaitingHuman(!!snap.awaitingHuman);
              if (snap.activeGate) {
                const mappedGate = snap.activeGate === 'runTests' ? 'tests' :
                                   snap.activeGate === 'runLint' ? 'lint' :
                                   snap.activeGate === 'runAudit' ? 'audit' : undefined;
                setActiveGate(mappedGate);
              } else {
                setActiveGate(undefined);
              }
              if (snap.hasFailureState) {
                setStatus('error');
              } else if (!snap.isRunning) {
                setStatus('complete');
              } else {
                setStatus('running');
              }
              logClient(`State Hydration complete from stateSnapshot. minValidSequenceId = ${minValidSeqIdFromSnapshot}`);
            }
          }
        } catch (err: unknown) {
          const isAbort = err instanceof Error && err.name === 'AbortError';
          if (!isAbort) {
            const msg = err instanceof Error ? err.message : String(err);
            logClient(`Skipping history hydration: ${msg}`);
          }
        }
      }

      hydrationSettled = true;
      if (pendingEventsQueue.length > 0) {
        let eventsToFlush = [...pendingEventsQueue];
        if (minValidSeqIdFromSnapshot > 0) {
          eventsToFlush = eventsToFlush.filter((ev: any) => {
            const seq = getSequenceId(ev);
            return seq === 0 || seq >= minValidSeqIdFromSnapshot;
          });
        }
        logClient(`Flushing ${eventsToFlush.length} queued live events post-hydration.`);
        eventsToFlush.forEach((ev) => processLiveEvent(ev as ExtendedSessionEvent));
        pendingEventsQueue = [];
      }
    })();
    
    try {
      let requestBody: any = payload;
      if (payload && 'prompt' in payload) {
        const { setScenarioTurns, ...serializablePayload } = payload as GateConfig;
        requestBody = serializablePayload;
      }

      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
        signal: abortControllerRef.current.signal
      });

      if (!response.ok) {
        let msg = `HTTP ${response.status}`;
        try {
          const body = await response.json();
          msg += ` - ${body.error || body.message || 'Unknown Error'}`;
        } catch (_) {
           msg += ` - ${response.statusText}`;
        }
        throw new Error(msg);
      }
      
      if (!response.body) throw new Error('No response body');
      
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let loopErrorMessage = '';
      
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        
        const lines = buffer.split('\n\n');
        buffer = lines.pop() || '';
        
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = JSON.parse(line.slice(6));
            logClient(`received event: type="${data.type || 'unknown'}" dataKeys=${Object.keys(data.data || {}).join(',') || 'none'}`);
            
            if (data.type === 'loop.error') {
              loopErrorMessage = data.data?.message || 'Gate loop encountered an error.';
            }

            if (!hydrationSettled) {
               pendingEventsQueue = [...pendingEventsQueue, data];
               logClient(`Hydration active. Event queued.`);
            } else {
               processLiveEvent(data as ExtendedSessionEvent);
            }
          }
        }
      }
      
      if (loopErrorMessage) {
        throw new Error(loopErrorMessage);
      }
    } catch (err: unknown) {
      const isAbort = err instanceof Error && err.name === 'AbortError';
      const msg = err instanceof Error ? err.message : String(err);
      logClient(`Error in streamEndpoint hook: ${msg}`);
      console.error(err);
      if (!isAbort) throw err;
    } finally {
      setIsRunning(false);
      setActiveReplayTraceId(undefined);
      if (!completedRef.current) {
        setStatus('shutdown');
      }
      setActiveGate(undefined);
      logClient(`Finished streamEndpoint. Status set to: ${completedRef.current ? 'completed' : 'shutdown'}`);
    }
  };

  const runWithGates = useCallback(async (config: GateConfig) => {
    logClient(`Starting gate loop run. config: ${JSON.stringify({ ...config, apiKey: config.apiKey ? 'REDACTED' : 'none' })}`);
    setIsRunning(true);
    setStatus('running');
    setRetryCount(0);
    setAwaitingHuman(false);
    setActiveGate(undefined);
    completedRef.current = false;
    setActiveReplayTraceId(config.replayTraceId || undefined);
    setCurrentTier((config.model as ModelTier) || DEFAULT_ROLES_CONFIG.executorTiers?.[0]?.model || 'gemini-3.1-flash-lite');
    activeSessionIdRef.current = config.sessionId;
    
    await executeStream('/api/copilot/gate-run', config, config.sessionId, config.setScenarioTurns);
  }, [appendEventToScenario, logClient]);

  const resumeAsHuman = useCallback((input: string) => {
    if (!activeSessionIdRef.current) return Promise.reject(new Error('No active session ID'));
    logClient(`Sending human feedback: "${input}"`);
    
    setIsRunning(true);
    setStatus('running');
    setAwaitingHuman(false);
    completedRef.current = false;
    setActiveReplayTraceId(undefined);
    
    return executeStream('/api/copilot/gate-resume', { sessionId: activeSessionIdRef.current, input }, activeSessionIdRef.current);
  }, [logClient]);

    return {
    runWithGates,
    isRunning,
    status,
    currentTier,
    retryCount,
    activeGate,
    awaitingHuman,
    resumeAsHuman,
    getClientLog,
    activeOutput,
    activeReplayTraceId,
    availableTiers: MODEL_TIERS
  };
}
