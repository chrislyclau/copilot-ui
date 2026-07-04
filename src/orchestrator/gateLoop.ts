import os from 'os';
import express from 'express';
import path from 'path';
import fs from 'fs';

// From SDK boundary
import {
  CopilotClient,
  CopilotSession,
  PermissionRequest,
  PermissionRequestResult,
  SessionConfig,
  SdkProviderConfig,
  Tool,
  SessionEvent,
  MessageOptions,
  ToolExecutionCompleteContent
} from '../copilotSdk/boundary';

// From other files
import { DEFAULT_ROLES_CONFIG, MODEL_TIERS, getNextTier } from '../config/models';
import { runGate, runTests, runLint, runWithTimeout } from '../gates';
import { SessionRecord, StateSnapshot, CopilotEventData, Turn } from '../types/session';
import { ExtendedSessionEvent } from '../types/events';
import { AuditFinding } from '../types/audit';
import {
  formatContextNarrowingPrompt,
  formatEscalationPrompt,
  formatHumanEscalationPrompt,
  formatClarityCheckPrompt
} from '../utils/prompt';
import { makeDockerToolHandler } from '../utils/toolHandlers';
import {
  RUN_TERMINAL_DOCKER_TOOL,
  submitAuditFindingsTool,
  COMPOSER_ROUTER_TOOL,
  AMBIGUITY_CHECK_TOOL
} from '../config/tools';
import { normalizeGates, TASK_TYPE_GATE_MAP, resolvePipeline } from '../config/gates';
import { runSpecAudit } from '../gates/specAuditor';
import { validateCwd } from '../security/pathGuard';
import { sanitizeSensitives } from '../utils/sanitizers';
import { truncateOutput } from '../utils/formatters';
import { initializeWorkspace, getGitSandbox, getExecCommand, getWorkspaceRoot } from '../workspace';
import { enforceWorkingMemoryTruncation, SlidingWindowCircularBuffer, clearCleanCache } from '../utils/contextManager';
import { fetchStubbedTraceResponse } from '../utils/traceRegistry';
import { appendEscalation, updateEscalationStatus, getEscalations, getPendingEscalation } from '../utils/escalationStore';
import { createSseWriter } from '../utils/sseWriter';
import { getSession, saveSession, deleteSession, getAllSessions } from '../db/sessionStore';
import { ProviderRegistry } from '../utils/providerRegistry';

export interface ClarityCheckData {
  score: number;
  missingVariables: string[];
  feedback?: string;
}

export interface ComposerRouteArguments {
  taskType?: string;
  targetDirectories?: string[];
}

export interface ExtendedMessageOptions extends MessageOptions {
  tool_choice?: {
    type: 'function';
    function: {
      name: string;
    };
  };
}

// From orchestrator/sessionState (unified shared state)
import {
  activeSessions,
  sseResToSessionId,
  sessionWritePromises,
  activeLocks,
  getGlobalClient,
  getOrCreateSession,
  resetSessionForNewRun,
  updateStateSnapshot,
  writeLog,
  sensitiveValuesCache,
  DIAGNOSTIC_SCENARIOS,
  DEFAULT_WORKSPACE_DIR,
  CopilotCreateSessionOptions,
  getCodeState,
  runLlmAudit
} from './sessionState';

import { ExtendedResponse, SseWriter } from '../utils/sseWriter';

let lazySseWriter: SseWriter | null = null;
function getSseWriter(): SseWriter {
  if (!lazySseWriter) {
    lazySseWriter = createSseWriter({
      activeSessions,
      sseResToSessionId,
      writeLog,
    });
  }
  return lazySseWriter;
}

const secureWrite = async (res: express.Response, data: string, isRequestClosed: boolean = false) => {
  return getSseWriter().secureWrite(res, data, isRequestClosed);
};

const flushSseAndEnd = async (res: express.Response) => {
  return getSseWriter().flushSseAndEnd(res);
};

function pruneConversationHistory(history: ReadonlyArray<{ role: 'user' | 'assistant'; content: string }>) {
  return enforceWorkingMemoryTruncation(history);
}

// Least-privilege permission evaluator for incoming commands and tools
export const handleGateRunPermission = async (req: PermissionRequest): Promise<PermissionRequestResult & { reason?: string }> => {
  let toolName = '';
  if (req.kind === 'custom-tool') {
    toolName = req.toolName || '';
  } else if (req.kind === 'shell') {
    toolName = req.commands?.[0]?.identifier || req.fullCommandText?.split(' ')[0] || '';
  } else {
    // Backwards compatibility or alternative structures safely checked
    const record = req as unknown as Record<string, unknown>;
    if (typeof record.toolName === 'string' && record.toolName) {
      toolName = record.toolName;
    } else if (typeof record.name === 'string' && record.name) {
      toolName = record.name;
    } else if (Array.isArray(record.toolCalls) && record.toolCalls.length > 0) {
      const firstCall = record.toolCalls[0] as Record<string, unknown>;
      if (firstCall && firstCall.function && typeof firstCall.function === 'object') {
        const fn = firstCall.function as Record<string, unknown>;
        if (typeof fn.name === 'string' && fn.name) {
          toolName = fn.name;
        }
      }
    } else if (typeof record.command === 'string' && record.command) {
      toolName = record.command;
    }
  }
  
  // Safe read-only/audit tools
  const safeTools = ['submit_audit_findings', 'ambiguity_check', 'composer_router'];
  if (safeTools.includes(toolName)) {
    writeLog(`[Security] Auto-approved safe utility tool: ${toolName}`);
    return { kind: 'approve-once' };
  }

  // If in test environment, allow command execution in sandbox
  if (process.env.NODE_ENV === 'test') {
    writeLog(`[Security] Approved command execution in test environment: ${toolName}`);
    return { kind: 'approve-once' };
  }

  // Allowed orchestrator tools
  const allowedOrchestratorTools = ['run_terminal_docker', 'run_tests'];
  if (allowedOrchestratorTools.includes(toolName)) {
    // Verify there is an active running session
    const hasActiveSession = Array.from(activeSessions.values()).some(
      s => s.stateSnapshot?.isRunning && !s.stateSnapshot?.awaitingHuman
    );
    if (hasActiveSession) {
      writeLog(`[Security] Approved active session tool execution: ${toolName}`);
      return { kind: 'approve-once' };
    } else {
      writeLog(`[Security Check Failed] Denied tool execution outside of an active running session context: ${toolName}`);
      return {
        kind: 'reject',
        feedback: `Execution of ${toolName} requires an active, authorized orchestration session context.`,
        reason: `Execution of ${toolName} requires an active, authorized orchestration session context.`
      };
    }
  }

  // Default block for other tools
  writeLog(`[Security Check Failed] Blocked unknown or unauthorized tool: ${toolName}`);
  return {
    kind: 'reject',
    feedback: `Tool ${toolName} is not authorized`,
    reason: `Tool ${toolName} is not authorized`
  };
};

interface RehydratedRequest extends express.Request {
  _rehydratedHistory?: ReadonlyArray<{ readonly role: 'user' | 'assistant'; readonly content: string }>;
  _rehydratedTurns?: ReadonlyArray<Turn>;
  _rehydratedStateSnapshot?: StateSnapshot;
  _blueprintTargets?: ReadonlyArray<string>;
}

export const handleGateLoop = async (req: express.Request, res: express.Response) => {
  const rreq = req as RehydratedRequest;
  const isResume = rreq.path.includes('/gate-resume');
  let session: CopilotSession | null = null;
  let unsubscribe: (() => void) | null = null;
  let isRequestClosed = false;
  let currentSessionId: string | null = null;
  let heartbeatId: NodeJS.Timeout | null = null;
  let resolveWritePromise: (() => void) | null = null;
  let cleaningUp = false;

  const abortController = new AbortController();
  const abortPromise = new Promise<never>((_, reject) => {
    const onAbort = () => reject(new Error('Operation aborted by client or timeout'));
    if (abortController.signal.aborted) onAbort();
    else abortController.signal.addEventListener('abort', onAbort, { once: true });
  });

  const registerSseForSession = (sessionId: string | null) => {
    if (sessionId) {
      const currentMutationPromise = new Promise<void>((resolve) => {
        resolveWritePromise = resolve;
      });
      sessionWritePromises.set(sessionId, currentMutationPromise);
      sseResToSessionId.set(res, sessionId);
    } else {
      sseResToSessionId.set(res, 'unregistered-session');
    }
  };

  const unregisterSseForSession = () => {
    if (resolveWritePromise) {
      try { resolveWritePromise(); } catch (e) {}
      resolveWritePromise = null;
    }
    if (currentSessionId) {
      sessionWritePromises.delete(currentSessionId);
    }
    sseResToSessionId.delete(res);
  };

  const cleanup = async () => {
    if (cleaningUp) return;
    cleaningUp = true;
    isRequestClosed = true;
    abortController.abort();

    unregisterSseForSession();

    if (heartbeatId) {
      clearInterval(heartbeatId);
      heartbeatId = null;
    }
    if (currentSessionId) {
      if (activeLocks.get(currentSessionId) === abortController) {
        activeLocks.delete(currentSessionId);
      }
      // T2: Memory guardrails - trim history on completion if too large to prevent memory bloat
      const sessionRec = activeSessions.get(currentSessionId);
      if (sessionRec) {
        const history = sessionRec.conversationHistory || [];
        if (history.length > 50) {
          activeSessions.set(sessionRec.sessionId, {
            ...sessionRec,
            conversationHistory: history.slice(-20)
          });
          writeLog(`[GC] Trimmed conversation history for session ${currentSessionId} to prevent memory bloat.`);
        }
      }
      // Force-evict cleanCache content to prevent stale static strings from leaking across sessions
      clearCleanCache();
      writeLog(`[GC] Cleared static log regex cache on session shutdown.`);
    }
    if (unsubscribe) {
      try { unsubscribe(); } catch (e) {}
      unsubscribe = null;
    }
    try {
      if (session) {
        // If the session is part of the persistent activeSessions, do NOT disconnect here.
        // Disconnecting would break context retention for future turns using getOrCreateSession.
        // The global GC interval handles pruning inactive persistent sessions.
        const isPersistent = Array.from(activeSessions.values()).some(s => s.copilotSession === session);
        if (!isPersistent) {
          await session.disconnect();
        }
        session = null;
      }
    } catch (e) {}
  };

  req.on('close', () => {
    writeLog(`[SDK] req.on(close) fired. res.writableEnded=${res.writableEnded} res.destroyed=${res.destroyed} req.destroyed=${req.destroyed}`);
    // Only clean up if the socket or response is actually destroyed before cleanly finishing
    if (!res.writableEnded && res.destroyed) {
       writeLog('[SDK] Client aborted gate-run connection gracefully.');
       cleanup();
    }
  });
  
  req.on('aborted', () => {
    writeLog('[SDK] Client aborted gate-run connection prematurely.');
    cleanup();
  });

  try {
    const { prompt, input, gates: rawGates, maxRetries = 2, apiKey, model, cwd, sessionId, diagnosticScenario, replayTraceId, simulateBackpressureDelayMs } = req.body;
    const gates = Array.isArray(rawGates) ? rawGates : (rawGates ? [String(rawGates)] : []);
    const keyToUse = apiKey || process.env.GEMINI_API_KEY;
    const registryInstance = new ProviderRegistry(keyToUse);
    currentSessionId = sessionId || null;

    if (simulateBackpressureDelayMs) {
      (res as ExtendedResponse).simulateBackpressureDelayMs = Number(simulateBackpressureDelayMs);
    }

    const payload = req.body;

    if (currentSessionId) {
      const sess = activeSessions.get(currentSessionId);
      if (sess && sess.stateSnapshot?.manualIntervention) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Session locked due to manual panic intervention.' }));
        return;
      }
    }

    registerSseForSession(currentSessionId);

    writeLog(`[API Request] POST /api/copilot/gate-run: isResume=${isResume}, model=${model || 'default'}, cwd=${cwd || 'default'}, sessionId=${sessionId || 'none'}`);

    const isDiagnostic = (!!diagnosticScenario || !!replayTraceId) && process.env.DIAGNOSTIC_MODE === 'true';
    const scenario = isDiagnostic && diagnosticScenario ? DIAGNOSTIC_SCENARIOS[diagnosticScenario as string] : null;

    if ((diagnosticScenario || replayTraceId) && !isDiagnostic) {
      writeLog('[Security] Diagnostic mode is disabled. Rejecting diagnostic request.');
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'Diagnostic mode is disabled via environment configuration.' }));
      await cleanup();
      return;
    }

    if (currentSessionId) {
      const sessId = currentSessionId;
      if (activeLocks.has(sessId)) {
        writeLog(`[GateLoop] Session ${sessId} is currently busy. Returning 409 Conflict.`);
        res.writeHead(409, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `Session ${sessId} is currently busy processing another request.` }));
        await cleanup();
        return;
      }
      activeLocks.set(sessId, abortController);
      if (isResume) {
        updateEscalationStatus(sessId, 'resumed');
      }
    }

    let promptStr = prompt as string;
    let sessRecord = currentSessionId ? activeSessions.get(currentSessionId) : null;
    
    // Rehydrate if memory is cleared but we have it in the DB
    if (!sessRecord && currentSessionId) {
      const storedSession = getSession(currentSessionId);
      if (storedSession && storedSession.stateSnapshot) {
        writeLog(`[GateLoop] Rehydrating session ${currentSessionId} from SQLite database.`);
        
        sessRecord = {
          stateSnapshot: storedSession.stateSnapshot,
          conversationHistory: storedSession.conversationHistory || [],
          turns: storedSession.turns || [],
          cwd: storedSession.cwd || DEFAULT_WORKSPACE_DIR,
          currentModel: storedSession.currentModel || 'gemini-3.1-flash-lite',
          sessionId: currentSessionId,
          copilotSession: null as unknown as CopilotSession, // populated below
          lastUsedAt: storedSession.lastUsedAt || Date.now(),
          totalInputTokens: storedSession.totalInputTokens,
          totalOutputTokens: storedSession.totalOutputTokens,
          eventSequenceCounter: storedSession.eventSequenceCounter,
          currentTierIndex: storedSession.currentTierIndex,
          planVersions: storedSession.planVersions,
          diagnosticTrail: storedSession.diagnosticTrail,
        };
        activeSessions.set(currentSessionId, sessRecord);
        
        rreq._rehydratedHistory = storedSession.conversationHistory;
        rreq._rehydratedTurns = storedSession.turns;
        rreq._rehydratedStateSnapshot = storedSession.stateSnapshot;
      }
    }

    if (isResume && sessRecord && sessRecord.stateSnapshot) {
      const snap = sessRecord.stateSnapshot;
      if (snap.currentPrompt) {
        promptStr = snap.currentPrompt;
        if (input && snap.failedGateName) {
          promptStr = formatHumanEscalationPrompt(promptStr, snap.failedGateName, snap.failedGateFeedback || '', input);
        }
      }
    }

    if (sessRecord && sessRecord.pendingPatchedSpec) {
      const updatedSpecText = sessRecord.pendingPatchedSpec;
      activeSessions.set(currentSessionId!, { ...sessRecord, pendingPatchedSpec: undefined });
      promptStr = `${promptStr}\n\n[SYSTEM UPDATE] The system architecture specification has been updated. Please continue the task and adapt your strategy to adhere to the updated specification:\n\n${updatedSpecText}`;
    }

    if (!promptStr || promptStr.trim() === '') {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('User prompt is required.');
      await cleanup();
      return;
    }

    // SYS-REQ-023: Validate/normalize client-supplied cwd via getWorkspaceRoot.
    // SECURITY JUSTIFICATION: Absolute paths are accepted to support container-isolated execution environments
    // (e.g., Docker runs where the host directory structure mapping differs from native).
    // To maintain a strict security boundary, we employ checkPathInside() which performs absolute resolution and
    // realpath/symlink resolution to guarantee the target directory is physically inside the authorized list of roots.
    let runCwd = getWorkspaceRoot();
    try {
      runCwd = validateCwd(cwd);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      writeLog(`[Security Blocked] ${msg}`);
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Access denied: Invalid directory path or directory traversal.');
      await cleanup();
      return;
    }

    const startModel = model || 'gemini-3.1-flash-lite';

    const executionConfig = registryInstance.getExecutionConfig(startModel);

    // Determine if a key is actually required by checking the mapped provider
    const activeProviderType = executionConfig.providerType;

    const requiresKey = activeProviderType !== 'copilot-native' && activeProviderType !== 'local';

    if (requiresKey && (!keyToUse || keyToUse === 'MY_GEMINI_API_KEY')) {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('API Key is missing for the selected provider. Please add your key under Settings > Secrets, or type your own key.');
      await cleanup();
      return;
    }


    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no'
    });

    let assistantMessage = '';
    heartbeatId = setInterval(async () => {
      if (!res.writableEnded && !res.destroyed && !isRequestClosed) {
        try {
          await secureWrite(res, `:\n\n`, isRequestClosed);
        } catch (err) {
          writeLog(`[SSE Heartbeat Error] ${err}`);
          if (heartbeatId) {
            clearInterval(heartbeatId);
            heartbeatId = null;
          }
        }
      }
    }, 15000);
    
    // Step 4. Escalation ladder: defined in config/models.ts; loop consults it
    const modelTiers = [startModel];
    let currentModelForLadder = startModel;
    while (true) {
      const next = getNextTier(currentModelForLadder);
      if (!next) break;
      modelTiers.push(next);
      currentModelForLadder = next;
    }
    const uniqueModelTiers = [...new Set(modelTiers)];

    let currentModelIndex = 0;
    let retryCount = 0;
    let totalRetries = 0;
    let gatesRunCount = 0;
    const loopStartTime = Date.now();
    const retryHistory: unknown[] = [];

    const client = await getGlobalClient(runCwd);
    
    if (sessionId) {
      const loopExecutionConfig = registryInstance.getExecutionConfig(startModel);
      const loopSessionOptions: CopilotCreateSessionOptions = {
        model: loopExecutionConfig.model,
        ...(loopExecutionConfig.provider ? { provider: loopExecutionConfig.provider as SdkProviderConfig } : {}),
        tools: [
          {
            name: RUN_TERMINAL_DOCKER_TOOL.function.name,
            description: RUN_TERMINAL_DOCKER_TOOL.function.description,
            parameters: RUN_TERMINAL_DOCKER_TOOL.function.parameters as Record<string, unknown>,
            handler: makeDockerToolHandler(secureWrite, res, abortController.signal, writeLog, sensitiveValuesCache || new Set<string>(), sessionId || undefined)
          },
          {
            name: 'run_tests',
            description: 'Run project tests (Integration compatibility alias)',
            parameters: {
              type: 'object',
              properties: {
                target: { type: 'string' },
                flags: { type: 'array', items: { type: 'string' } }
              }
            },
            handler: async (args: unknown) => {
              const res = await runTests(runCwd);
              return { status: 'success', output: res.output };
            }
          }
        ],
        onPermissionRequest: handleGateRunPermission,
        streaming: true,
      };

      await getOrCreateSession(
        sessionId,
        loopExecutionConfig.model,
        runCwd,
        client,
        loopSessionOptions
      );
      updateStateSnapshot(sessionId, { isRunning: true });
    }

    if (!isResume) {
      resetSessionForNewRun(sessionId);
    }
    
    const activeSessionRecord = sessionId ? activeSessions.get(sessionId) : null;
    const taskLabel = promptStr.length > 50 ? promptStr.slice(0, 47) + '...' : promptStr;
    const currentTurnId = `turn-${Date.now()}`;
    if (activeSessionRecord) {
      activeSessions.set(sessionId, {
        ...activeSessionRecord,
        turns: [
          ...(activeSessionRecord.turns || []),
          {
            id: currentTurnId,
            taskLabel,
            status: 'running',
            events: []
          }
        ]
      });
    }

    let currentPrompt = promptStr;

    // T0: Ambiguity Checker (SYS-REQ-016/017)
    if (!isDiagnostic && !isResume) {
      writeLog(`[Ambiguity] Running pre-flight clarity check...`);
      try {
        const clarityConfig = registryInstance.getExecutionConfig('gemini-3.1-flash-lite');
        const claritySession: CopilotSession = await client.createSession({
          model: clarityConfig.model,
          provider: clarityConfig.provider as SdkProviderConfig,
          onPermissionRequest: async () => ({ kind: 'approve-once' }),
          tools: [{
            name: AMBIGUITY_CHECK_TOOL.function.name,
            description: AMBIGUITY_CHECK_TOOL.function.description,
            parameters: AMBIGUITY_CHECK_TOOL.function.parameters,
            handler: async () => {
              return { status: 'success' };
            }
          } as Tool<unknown>],
        });
        
        let clarityData: ClarityCheckData | null = null;
        const unsub = claritySession.on('tool.execution_start', (event) => {
          writeLog(`[Ambiguity] Event: ${event.type} ${JSON.stringify(event.data || {})}`);
          if (event.data?.toolName === 'submit_clarity_check' && event.data.arguments) {
            const args = event.data.arguments as Record<string, unknown>;
            clarityData = {
              score: typeof args.score === 'number' ? args.score : 0,
              missingVariables: Array.isArray(args.missingVariables) ? args.missingVariables.map(v => String(v)) : [],
              feedback: typeof args.feedback === 'string' ? args.feedback : undefined,
            };
            writeLog(`[Ambiguity] Captured clarityData from tool.execution_start: ${JSON.stringify(clarityData)}`);
          }
        });
        
        writeLog(`[Ambiguity] Sending request to ambiguity checker...`);
        const clarityAbortHandler = () => {
          claritySession.disconnect().catch(() => {});
        };
        abortController.signal.addEventListener('abort', clarityAbortHandler);
        try {
          await Promise.race([
            claritySession.sendAndWait({
              prompt: formatClarityCheckPrompt(promptStr),
              tool_choice: { type: 'function', function: { name: 'submit_clarity_check' } }
            } as ExtendedMessageOptions, 20000),
            abortPromise
          ]);
        } finally {
          abortController.signal.removeEventListener('abort', clarityAbortHandler);
        }
        writeLog(`[Ambiguity] sendAndWait finished. clarityData is: ${JSON.stringify(clarityData)}`);
        unsub();
        await claritySession.disconnect();
        
        const finalClarityData = clarityData as ClarityCheckData | null;
        if (finalClarityData && finalClarityData.score < 0.85) {
          const missingList = finalClarityData.missingVariables.map((v: string) => `• ${v}`).join('\n');
          const clarityEvent = {
            type: 'loop.clarity_check_failed',
            data: {
              score: finalClarityData.score,
              missingVariables: finalClarityData.missingVariables,
              feedback: `Goal ambiguity detected (Clarity: ${finalClarityData.score}). Please clarify:\n${missingList}`
            }
          };
          await secureWrite(res, `data: ${JSON.stringify(clarityEvent)}\n\n`, isRequestClosed);
          await flushSseAndEnd(res);
          await cleanup();
          return;
        }
      } catch (err) {
        writeLog(`[Ambiguity] Check failed, bypassing: ${err}`);
        const warnEvent = {
          type: 'loop.warning',
          data: { message: `Ambiguity check failed: ${err instanceof Error ? err.message : String(err)}. Bypassing to execution.` }
        };
        await secureWrite(res, `data: ${JSON.stringify(warnEvent)}\n\n`, isRequestClosed);
      }
    }

    // T1: Composer Router Classification (Structured Tool Choice)
    let activeStepGates = normalizeGates(gates || []);
    let classifiedType = '';
    if (!isDiagnostic && !isResume) {
      writeLog(`[Composer] Classifying task intent for: "${promptStr.substring(0, 50)}..."`);
      try {
        const classificationConfig = registryInstance.getExecutionConfig('gemini-3.1-flash-lite');
        const classificationSession: CopilotSession = await client.createSession({
          model: classificationConfig.model,
          provider: classificationConfig.provider as SdkProviderConfig,
          onPermissionRequest: async () => ({ kind: 'approve-once' }),
          tools: [{
            name: COMPOSER_ROUTER_TOOL.function.name,
            description: COMPOSER_ROUTER_TOOL.function.description,
            parameters: COMPOSER_ROUTER_TOOL.function.parameters,
            handler: async () => {
              return { status: 'success' };
            }
          } as Tool<unknown>],
        });
               let toolArguments: ComposerRouteArguments | null = null;
        const unsub = classificationSession.on('tool.execution_start', (event) => {
          if (event.data?.toolName === 'initialize_blueprint' && event.data.arguments) {
            const args = event.data.arguments as Record<string, unknown>;
            toolArguments = {
              taskType: typeof args.taskType === 'string' ? args.taskType : undefined,
              targetDirectories: Array.isArray(args.targetDirectories) ? args.targetDirectories.map(d => String(d)) : undefined,
            };
            writeLog(`[Composer] Captured toolArguments from tool.execution_start: ${JSON.stringify(toolArguments)}`);
          }
        });

        const classificationPrompt = `Analyze the following user prompt for a code generation task and initialize the workspace blueprint: "${promptStr}"`;

        const classificationAbortHandler = () => {
          classificationSession.disconnect().catch(() => {});
        };
        abortController.signal.addEventListener('abort', classificationAbortHandler);
        try {
          // Force the tool choice to guarantee a structured plan
          await Promise.race([
            classificationSession.sendAndWait({ 
              prompt: classificationPrompt,
              tool_choice: { type: 'function', function: { name: 'initialize_blueprint' } }
            } as ExtendedMessageOptions, 30000),
            abortPromise
          ]);
        } finally {
          abortController.signal.removeEventListener('abort', classificationAbortHandler);
        }
        
        unsub();

        // Note: The type cast 'as ComposerRouteArguments | null' is required to prevent TypeScript's
        // control flow analysis from narrowing this asynchronously-mutated variable to 'null' (and thus 'never').
        const args = toolArguments as ComposerRouteArguments | null;
        if (args && args.taskType) {
          classifiedType = args.taskType;
          activeStepGates = resolvePipeline(classifiedType);
          writeLog(`[Composer] Structured classification: ${classifiedType}, Gates: ${activeStepGates.join(', ')}`);
          
          // T2: Emit Explicit composer.plan Stream Events
          const planEvent = {
            type: 'composer.plan',
            data: {
              taskType: classifiedType,
              resolvedGates: [...activeStepGates],
              gates: [...activeStepGates],
              targetDirectories: [...(args.targetDirectories || [])]
            }
          };
          await secureWrite(res, `data: ${JSON.stringify(planEvent)}\n\n`, isRequestClosed);
          
          if (args.targetDirectories) {
             rreq._blueprintTargets = args.targetDirectories;
          }
        } else {
          writeLog(`[Composer] Structured classification failed or empty, falling back to feature.`);
          activeStepGates = resolvePipeline('feature');
          
          const warnEvent = {
            type: 'loop.warning',
            data: { message: 'Plan classification failed or returned no intent. Falling back to default feature pipeline.' }
          };
          await secureWrite(res, `data: ${JSON.stringify(warnEvent)}\n\n`, isRequestClosed);
        }
        await classificationSession.disconnect();
      } catch (err) {
        writeLog(`[Composer] Classification failed, falling back: ${err}`);
        activeStepGates = resolvePipeline('feature');

        const warnEvent = {
          type: 'loop.warning',
          data: { message: `Classification error: ${err instanceof Error ? err.message : String(err)}. Falling back to default feature pipeline.` }
        };
        await secureWrite(res, `data: ${JSON.stringify(warnEvent)}\n\n`, isRequestClosed);
      }
    }

    const MAX_SESSION_TOKEN_BUDGET = 500000;
    let loopCycleCounter = 0;
    const MAX_RETRY_CYCLES = 10;
    let lastFailedGate = '';
    let consecutiveFailures = 0;
    let failedGateName = '';
    let failedGateFeedback = '';
    let allGatesPassed = true;

    if (isResume && sessRecord && sessRecord.stateSnapshot) {
      const snap = sessRecord.stateSnapshot;
      currentModelIndex = snap.currentModelIndex || 0;
      retryCount = 0; // reset for the human attempt
      totalRetries = snap.totalRetries || Math.max(0, (snap.retryCount || 0));
      if (Array.isArray(snap.retryHistory)) {
        retryHistory.push(...snap.retryHistory);
      }
      failedGateName = snap.failedGateName || '';
      failedGateFeedback = snap.failedGateFeedback || '';
    }

    try {
      while (!isRequestClosed) {
        loopCycleCounter++;
        // Enforce mandatory sandbox runtimes as per protocol SYS-REQ-014
        // Note: bypassDocker is strictly internal and should remain false for this environment
        let allGatesPassedInThisCycle = true;
        let toolWasCalledInThisTurn = false;
        
        const currentModel = uniqueModelTiers[currentModelIndex];
        const isPremiumTier = currentModelIndex > 0;
        
        if (loopCycleCounter > MAX_RETRY_CYCLES) {
          writeLog(`[GateLoop] Iteration ceiling reached (${MAX_RETRY_CYCLES}). Bypassing further auto-healing logic and forcing human intervention.`);
          const escalateEvent = {
            type: 'loop.ceiling_breached',
            data: {
              summary: `Loop iteration ceiling of ${MAX_RETRY_CYCLES} reached. Bypassing further auto-healing logic and forcing human intervention.`,
              failedGate: failedGateName || 'unknown',
              retryHistory: retryHistory
            }
          };
          if (sessionId && activeSessions.has(sessionId)) {
            const currentRec = activeSessions.get(sessionId)!;
            const nextState = {
              ...currentRec.stateSnapshot,
              awaitingHuman: true,
              isRunning: false
            };
            activeSessions.set(sessionId, {
              ...currentRec,
              stateSnapshot: nextState
            });
            appendEscalation({
              sessionId,
              summary: `Loop iteration ceiling of ${MAX_RETRY_CYCLES} reached. Bypassing further auto-healing logic and forcing human intervention.`,
              failedGate: failedGateName || 'unknown',
              failedGateFeedback: '',
              retryHistory: retryHistory || [],
              stateSnapshot: nextState,
              conversationHistory: currentRec.conversationHistory,
              turns: currentRec.turns,
              cwd: currentRec.cwd,
              currentModel: currentRec.currentModel,
            });
          }
          await secureWrite(res, `data: ${JSON.stringify(escalateEvent)}\n\n`, isRequestClosed);
          break;
        }

        if (isRequestClosed) {
          try { if (session) { await session.disconnect(); session = null; } } catch (e) {}
          break;
        }

        const loopExecutionConfig = registryInstance.getExecutionConfig(currentModel);

        const currentTierConfig = DEFAULT_ROLES_CONFIG.executorTiers.find(t => t.model === currentModel) || (DEFAULT_ROLES_CONFIG.planner.model === currentModel ? DEFAULT_ROLES_CONFIG.planner : null) || { provider: 'gemini', model: currentModel, tokenRatio: 4 };
        const divisor = currentTierConfig.tokenRatio || 4;
        const estimatedInputTokens = Math.ceil(currentPrompt.length / divisor);

        // Token budget tracking and short-circuit - enforced across ALL tiers to protect financial metrics
        if (sessionId && activeSessions.has(sessionId)) {
          const currentRec = activeSessions.get(sessionId)!;
          activeSessions.set(sessionId, {
            ...currentRec,
            totalInputTokens: (currentRec.totalInputTokens || 0) + estimatedInputTokens
          });
          const updatedRec = activeSessions.get(sessionId)!;
          if (updatedRec.totalInputTokens! > MAX_SESSION_TOKEN_BUDGET) {
            writeLog(`[GateLoop] Token budget exceeded! Budget: ${MAX_SESSION_TOKEN_BUDGET}, Projected: ${updatedRec.totalInputTokens}. Short-circuiting...`);
            const escalateEvent = {
              type: 'loop.escalate_human',
              data: {
                summary: `Token budget exhausted. The execution has consumed too many resources. Projected cost exceeds the safety threshold of ${MAX_SESSION_TOKEN_BUDGET} tokens. Human intervention required.`,
                failedGate: failedGateName || 'budget_guard',
                retryHistory: retryHistory
              }
            };
            const nextState = {
              ...updatedRec.stateSnapshot,
              awaitingHuman: true,
              isRunning: false
            };
            activeSessions.set(sessionId, {
              ...updatedRec,
              stateSnapshot: nextState
            });
            appendEscalation({
              sessionId,
              summary: `Token budget exhausted. The execution has consumed too many resources. Projected cost exceeds the safety threshold of ${MAX_SESSION_TOKEN_BUDGET} tokens. Human intervention required.`,
              failedGate: failedGateName || 'budget_guard',
              failedGateFeedback: '',
              retryHistory: retryHistory || [],
              stateSnapshot: nextState,
              conversationHistory: updatedRec.conversationHistory,
              turns: updatedRec.turns,
              cwd: updatedRec.cwd,
              currentModel: updatedRec.currentModel,
            });
            await secureWrite(res, `data: ${JSON.stringify(escalateEvent)}\n\n`, isRequestClosed);
            break;
          }
        }

        const loopSessionOptions: CopilotCreateSessionOptions = {
          model: loopExecutionConfig.model,
          ...(loopExecutionConfig.provider ? { provider: loopExecutionConfig.provider as SdkProviderConfig } : {}),
          tools: [
            {
              name: RUN_TERMINAL_DOCKER_TOOL.function.name,
              description: RUN_TERMINAL_DOCKER_TOOL.function.description,
              parameters: RUN_TERMINAL_DOCKER_TOOL.function.parameters as Record<string, unknown>,
              handler: makeDockerToolHandler(secureWrite, res, abortController.signal, writeLog, sensitiveValuesCache || new Set<string>(), sessionId || undefined)
            },
            {
              name: 'run_tests',
              description: 'Run project tests (Integration compatibility alias)',
              parameters: {
                type: 'object',
                properties: {
                  target: { type: 'string' },
                  flags: { type: 'array', items: { type: 'string' } }
                }
              },
              handler: async (args: unknown) => {
                const res = await runTests(runCwd);
                return { status: 'success', output: res.output };
              }
            }
          ],
          onPermissionRequest: handleGateRunPermission,
          streaming: true,
        };

        // Step 1: Session Lifecycle using unified getOrCreateSession helper FIRST to prevent telemetry loss
        let reused = false;
        if (sessionId) {
          const record = await getOrCreateSession(
            sessionId,
            loopExecutionConfig.model,
            runCwd,
            client,
            loopSessionOptions
          );
          session = record.copilotSession;
          reused = true;
          writeLog(`[GateLoop] Retr/obtained session ${sessionId} for model ${currentModel}`);
        }

        // Clean up last iteration's session if NOT reused and NOT first turn
        if (!reused && session) {
          try {
            await session.disconnect();
          } catch (e) {
            writeLog(`[GateLoop] Error disconnecting last loop session: ${e}`);
          }
          session = null;
        }

        // Create fresh session if none found/reused (e.g., if sessionId is not provided)
        if (!session) {
          writeLog(`[GateLoop] Creating fresh session for model ${currentModel}`);
          session = await client.createSession(loopSessionOptions as SessionConfig);

          // Store new session in activeSessions for future reuse
          if (sessionId) {
            if (activeSessions.has(sessionId)) {
              try { await activeSessions.get(sessionId)!.copilotSession.disconnect(); } catch (e) {}
            }
            activeSessions.set(sessionId, {
              sessionId,
              copilotSession: session,
              currentModel: currentModel,
              cwd: runCwd,
              lastUsedAt: Date.now(),
              totalInputTokens: 0,
              totalOutputTokens: 0,
              eventSequenceCounter: 0,
              stateSnapshot: (req as RehydratedRequest)._rehydratedStateSnapshot || {
                isRunning: true,
                retryCount: retryCount,
                currentTier: currentModel,
                activeGate: undefined,
                hasFailureState: consecutiveFailures > 0,
                awaitingHuman: false,
              },
              conversationHistory: (req as RehydratedRequest)._rehydratedHistory || [],
              turns: (req as RehydratedRequest)._rehydratedTurns || [],
              diagnosticTrail: []
            });
            writeLog(`[GateLoop] Cached new session ${sessionId} for future reuse.`);
          }
        }

        writeLog(`[GateLoop] Starting iteration with model: ${currentModel}, retryCount: ${retryCount}/${maxRetries}`);
        updateStateSnapshot(sessionId, { isRunning: true, currentTier: currentModel, retryCount, activeGate: undefined, awaitingHuman: false });

        // Setup streaming event listener for current session
        assistantMessage = '';
        try {
          if (isDiagnostic) {
            // Emit mock text chunk and idle event to satisfy client UI/Timeline
            let content = '';
            if (payload.replayTraceId) {
              const currentSubtaskId = loopCycleCounter === 1 ? 'classify_intent' : 'run_tests';
              const currentRole = loopCycleCounter === 1 ? 'planner' : 'executor';
              // INTERCEPTOR (Task 1.2): fetch stubbed response or throw hard alignment exception
              content = fetchStubbedTraceResponse(payload.replayTraceId, currentSubtaskId, currentRole, 0);

              // Stream high-fidelity pipeline structure events
              const turnStartEvent = {
                type: 'turn.start',
                turnIndex: 0,
                label: 'Replay Generation Run'
              };
              await secureWrite(res, `data: ${JSON.stringify(turnStartEvent)}\n\n`, isRequestClosed);

              const subtaskStartEvent = {
                type: 'subtask.start',
                turnIndex: 0,
                subtaskId: currentSubtaskId,
                label: currentSubtaskId === 'classify_intent' ? 'Classify Intent' : 'Run Tests'
              };
              await secureWrite(res, `data: ${JSON.stringify(subtaskStartEvent)}\n\n`, isRequestClosed);
              
              const msgEvent = { type: 'assistant.message', data: { content } };
              await secureWrite(res, `data: ${JSON.stringify(msgEvent)}\n\n`, isRequestClosed);
              await new Promise(r => setTimeout(r, 200));

              const subtaskCompleteEvent = {
                type: 'subtask.complete',
                turnIndex: 0,
                subtaskId: currentSubtaskId,
                success: true
              };
              await secureWrite(res, `data: ${JSON.stringify(subtaskCompleteEvent)}\n\n`, isRequestClosed);
            } else {
              content = scenario!.executorResponse;
            }

            // Push assistant message to history
            if (sessionId && activeSessions.has(sessionId)) {
              const sRec = activeSessions.get(sessionId)!;
              activeSessions.set(sessionId, {
                ...sRec,
                conversationHistory: [...(sRec.conversationHistory || []), { role: 'assistant', content }]
              });
            }

            if (!payload.replayTraceId) {
              const msgEvent = { type: 'assistant.message', data: { content } };
              await secureWrite(res, `data: ${JSON.stringify(msgEvent)}\n\n`, isRequestClosed);
              await new Promise(r => setTimeout(r, 400)); // Simulate thinking/streaming time
            }

            const idleEvent = { type: 'session.idle', data: {} };
            await secureWrite(res, `data: ${JSON.stringify(idleEvent)}\n\n`, isRequestClosed);
            writeLog(`[GateLoop][Diagnostic] Emitted response: ${content}`);
          } else {
            if (!session) {
                throw new Error('Failed to create or rehydrate session.');
            }
            const activeSession: CopilotSession = session;

            const pDone = new Promise<void>((resolve, reject) => {
              const onAbort = () => {
                if (unsubscribe) { unsubscribe(); unsubscribe = null; }
                reject(new Error('Operation aborted by client or timeout'));
              };
              abortController.signal.addEventListener('abort', onAbort);

              unsubscribe = activeSession.on(async (event: SessionEvent) => {
                const extEvent = event as ExtendedSessionEvent;
                if (sessionId && activeSessions.has(sessionId)) {
                  const sRec = activeSessions.get(sessionId)!;
                  activeSessions.set(sessionId, {
                    ...sRec,
                    unsubscribe: unsubscribe || undefined
                  });
                }
                try {
                  if (res.writableEnded || res.destroyed || isRequestClosed || abortController.signal.aborted) {
                    if (unsubscribe) { unsubscribe(); unsubscribe = null; }
                    abortController.signal.removeEventListener('abort', onAbort);
                    reject(new Error('SSE stream connection terminated or closed'));
                    return;
                  }

                  if (extEvent.type === 'tool.user_requested') {
                    toolWasCalledInThisTurn = true;
                  }

                  if (extEvent.type === 'tool.result' && sessionId && activeSessions.has(sessionId)) {
                    const sRec = activeSessions.get(sessionId)!;
                    const toolName = extEvent.data.toolName || 'unknown';
                    const output = extEvent.data.stdout || extEvent.data.stderr || '';
                    activeSessions.set(sessionId, {
                        ...sRec,
                        conversationHistory: [
                            ...(sRec.conversationHistory || []),
                            { role: 'user', content: `[System (Tool Result): ${toolName}]\n${output}` }
                        ]
                    });
                  }

                  // Aggregate assistant message content
                  if (extEvent.type === 'assistant.message') {
                    assistantMessage += extEvent.data.content || '';
                  } else if (extEvent.type === 'assistant.message_delta') {
                    assistantMessage += extEvent.data.deltaContent || '';
                  }

                  // Step 2: Emit all SDK events to client
                  await secureWrite(res, `data: ${JSON.stringify(extEvent)}\n\n`, isRequestClosed);

                  if (extEvent.type === 'session.idle' || extEvent.type === 'session.shutdown') {
                    if (unsubscribe) { unsubscribe(); unsubscribe = null; }
                    abortController.signal.removeEventListener('abort', onAbort);
                    resolve();
                  } else if (extEvent.type === 'session.error') {
                    if (unsubscribe) { unsubscribe(); unsubscribe = null; }
                    abortController.signal.removeEventListener('abort', onAbort);
                    reject(new Error(extEvent.data.message));
                  }
                } catch (err: unknown) {
                  writeLog(`[GateLoop] Error forwarding event: ${err instanceof Error ? err.message : String(err)}`);
                  abortController.signal.removeEventListener('abort', onAbort);
                  reject(err);
                }
              });
            });

            writeLog(`[GateLoop] Session started. Sending prompt: "${currentPrompt.substring(0, 60)}..."`);
            
            // Push user message to history ONLY on first iteration 
            if (loopCycleCounter === 1 && sessionId && activeSessions.has(sessionId)) {
              const sRec = activeSessions.get(sessionId)!;
              activeSessions.set(sessionId, {
                ...sRec,
                conversationHistory: [...(sRec.conversationHistory || []), { role: 'user', content: promptStr }]
              });
            }

            writeLog(`[SESSION] sendAndWait called with prompt length=${currentPrompt.length}`);
            await Promise.race([
              session.sendAndWait({ prompt: currentPrompt }, 600000),
              abortPromise
            ]);
            writeLog(`[SESSION] sendAndWait finished.`);
            // Wait for session.idle / turn completion
            writeLog(`[SESSION] Awaiting pDone resolution`);
            try {
              await Promise.race([pDone, abortPromise]);
              writeLog(`[SESSION] pDone resolved successfully`);
            } catch (pErr: unknown) {
              writeLog(`[GateLoop] Stream delivery broken or aborted during execution: ${pErr instanceof Error ? pErr.message : String(pErr)}. Aborting loop.`);
              break;
            }

            if (sessionId && activeSessions.has(sessionId)) {
              const currentRec = activeSessions.get(sessionId)!;
              const currentTierConfig = DEFAULT_ROLES_CONFIG.executorTiers.find(t => t.model === currentModel) || (DEFAULT_ROLES_CONFIG.planner.model === currentModel ? DEFAULT_ROLES_CONFIG.planner : null) || { provider: 'gemini', model: currentModel, tokenRatio: 4 };
              const divisor = currentTierConfig.tokenRatio || 4;
              activeSessions.set(sessionId, {
                ...currentRec,
                totalOutputTokens: (currentRec.totalOutputTokens || 0) + Math.ceil(assistantMessage.length / divisor)
              });
            }

            // Push assistant message to history if not diagnostic (diagnostic path does it separately)
            if (!isDiagnostic && sessionId && activeSessions.has(sessionId)) {
              const sRec = activeSessions.get(sessionId)!;
              activeSessions.set(sessionId, {
                ...sRec,
                conversationHistory: [...(sRec.conversationHistory || []), { role: 'assistant', content: assistantMessage }]
              });
            }

            // SYS-REQ-004: Enforce structured tool calls for mutation tasks
            if (!isDiagnostic && process.env.NODE_ENV !== 'test' && (classifiedType === 'feature' || classifiedType === 'refactor') && !toolWasCalledInThisTurn) {
               writeLog(`[GateLoop] SYS-REQ-004: Mutation task without tool call detected. Failing current turn.`);
               allGatesPassedInThisCycle = false;
               failedGateName = 'MutationGate';
               failedGateFeedback = truncateOutput('The executor failed to emit any structured tool calls to modify files. Plain text explanations are blocked for mutation tasks.');
               
               // Emit explicit gate events for MutationGate to satisfy protocol consistency and test assertions
               const mgStartEvent = { type: 'gate.start', data: { gateName: 'MutationGate', retryCount } };
               await secureWrite(res, `data: ${JSON.stringify(mgStartEvent)}\n\n`, isRequestClosed);
               
               const mgResultEvent = {
                 type: 'gate.result',
                 data: {
                   gateName: 'MutationGate',
                   pass: false,
                   feedback: failedGateFeedback,
                   durationMs: 0,
                   retryCount
                 }
               };
               await secureWrite(res, `data: ${JSON.stringify(mgResultEvent)}\n\n`, isRequestClosed);
            }
          }
        } finally {
          const toUnsubscribe: unknown = unsubscribe;
          if (typeof toUnsubscribe === 'function') {
            try { toUnsubscribe(); } catch (e) {}
            unsubscribe = null;
          }
        }

        await new Promise<void>((resolve) => setTimeout(resolve, 500));

        if (isRequestClosed) {
          try { if (session) { await session.disconnect(); session = null; } } catch (e) {}
          break;
        }

        // Step 3: Run each gate in sequence
        if (allGatesPassedInThisCycle) {
          for (const gateName of activeStepGates) {
            if (isRequestClosed) {
              allGatesPassedInThisCycle = false;
              break;
            }

            // Emit a `gate.start` event with current gateName to client
            updateStateSnapshot(sessionId, { activeGate: gateName });
            const startGateEvent = {
              type: 'gate.start',
              data: {
                gateName,
                retryCount
              }
            };
            await secureWrite(res, `data: ${JSON.stringify(startGateEvent)}\n\n`, isRequestClosed);

            writeLog(`[GateLoop] Running gate: ${gateName}`);
            gatesRunCount++;
            
            let gateResult;
            try {
              if (isDiagnostic) {
                await new Promise(r => setTimeout(r, 600)); // Simulate tool run time
                
                if (diagnosticScenario === 'gate_crash' && gatesRunCount === 1) {
                  throw new Error("DIAGNOSTIC_SIMULATED_CRASH");
                }

                // Use the sequence. If we run out of sequence values, default to pass if it's not the 'human_escalation' scenario
                const seq = scenario ? scenario.gateSequence : [];
                const pass = (gatesRunCount - 1 < seq.length) ? seq[gatesRunCount - 1] : true;

                gateResult = {
                  gateName,
                  pass,
                  feedback: pass ? `[Diagnostic] ${gateName} passed correctly.` : `[Diagnostic] ${gateName} failed as requested.`,
                  durationMs: 600
                };
              } else if (gateName === 'runAudit') {
                const startAuditTime = Date.now();
                const currentCodeState = await getCodeState(runCwd);
                const auditPayload = await runLlmAudit(promptStr, currentCodeState, keyToUse, abortController.signal);
                const loopPassed = auditPayload.pass;
                
                let feedbackStr = '';
                if (loopPassed) {
                  feedbackStr = "Audit passed.";
                } else if (auditPayload.findings && Array.isArray(auditPayload.findings)) {
                  feedbackStr = auditPayload.findings.map((f: AuditFinding) => `[${f.severity.toUpperCase()}] ${f.file || 'General'}: ${f.description}`).join('\n');
                } else {
                  feedbackStr = "Audit failed on quality checks.";
                }

                gateResult = {
                  gateName: 'runAudit',
                  pass: loopPassed,
                  feedback: feedbackStr,
                  durationMs: Date.now() - startAuditTime
                };
              } else {
                gateResult = await runGate(gateName, runCwd, abortController.signal);
              }
              
              // Update audit trail
              if (sessionId && activeSessions.has(sessionId)) {
                const sRec = activeSessions.get(sessionId)!;
                const newSequenceCounter = (sRec.eventSequenceCounter || 0) + 1;
                activeSessions.set(sessionId, { ...sRec, eventSequenceCounter: newSequenceCounter });
                const updatedSRec = activeSessions.get(sessionId)!;
                const eventObj = {
                  timestamp: new Date().toISOString(),
                  action: gateName,
                  rationale: gateResult.feedback,
                  tier: uniqueModelTiers[currentModelIndex],
                  sequenceId: newSequenceCounter,
                  data: {
                    sequenceId: newSequenceCounter
                  }
                };
                const updatedTurns = updatedSRec.turns ? [...updatedSRec.turns] : [];
                // SYS-REQ-004: Restructured recovery mechanism. Check if ANY standard turn exists before fallbacks.
                if (updatedTurns.length === 0) {
                  updatedTurns.push({
                    id: `turn-fallback-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`,
                    taskLabel: 'System Recovery / Unknown Turn',
                    status: 'running',
                    events: []
                  });
                }
                // This event Obj is slightly differently formed but append it to events array
                const turnIndex = updatedTurns.length - 1;
                const turnToUse = updatedTurns[turnIndex];
                if (turnToUse) {
                  const newEvent: CopilotEventData = {
                    id: `evt-audit-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`,
                    timestamp: eventObj.timestamp,
                    type: 'gate.legacyAudit',
                    data: eventObj
                  };
                  const finalTurns = updatedTurns.map((turn, index) => 
                    index === turnIndex ? 
                    { ...turn, events: [...turn.events, newEvent] } : turn
                  );
                  activeSessions.set(sessionId, {
                      ...updatedSRec,
                      turns: finalTurns
                  });
                } else {
                  activeSessions.set(sessionId, {
                      ...updatedSRec,
                      turns: updatedTurns
                  });
                }
              }
            } catch (gateErr: unknown) {
              const gateErrMsg = gateErr instanceof Error ? gateErr.message : String(gateErr);
              gateResult = {
                pass: false,
                feedback: `Gate check crashed: ${gateErrMsg}`,
                durationMs: 0
              };
            }

            // Step 5: Emit a `gate.result` event
            writeLog(`[LOOP] Gate ${gateName} result: pass=${gateResult.pass} durationMs=${gateResult.durationMs}`);
            updateStateSnapshot(sessionId, { activeGate: undefined, hasFailureState: !gateResult.pass });
            const gateEvent = {
              type: 'gate.result',
              data: {
                gateName,
                pass: gateResult.pass,
                feedback: gateResult.feedback,
                durationMs: gateResult.durationMs,
                retryCount
              }
            };
            await secureWrite(res, `data: ${JSON.stringify(gateEvent)}\n\n`, isRequestClosed);

            if (!gateResult.pass) {
              allGatesPassedInThisCycle = false;
              failedGateName = gateName;
              failedGateFeedback = truncateOutput(gateResult.feedback);

              // T2: Fallback Upgrades for Distressed Pipelines
              if (failedGateName === lastFailedGate) {
                consecutiveFailures++;
              } else {
                lastFailedGate = failedGateName;
                consecutiveFailures = 1;
              }

              if (consecutiveFailures >= 5) {
                writeLog(`[GateLoop] Persistent bottleneck detected on gate ${failedGateName} (${consecutiveFailures} failures). Injecting auto-heal steps.`);
                if (!activeStepGates.includes('runLint')) {
                  activeStepGates.unshift('runLint');
                  writeLog(`[GateLoop] Injected runLint at the start of pipeline to auto-heal syntax structures.`);
                }
                const alternativeGates = [...activeStepGates];
                const mutatedEvent = {
                  type: 'composer.plan_mutated',
                  data: {
                    cycle: 5,
                    newGates: alternativeGates,
                    gates: alternativeGates
                  }
                };
                await secureWrite(res, `data: ${JSON.stringify(mutatedEvent)}\n\n`, isRequestClosed);
              }

              break; // Stop running further gates as this one failed
            }
          }
        }

        if (!isRequestClosed && allGatesPassedInThisCycle) {
          // T1: Spec-Gate Auditor Isolation Sandbox
          const specStart = Date.now();
          let skipSpecAudit = false;
          if (sessionId && activeSessions.has(sessionId)) {
            const sessionRec = activeSessions.get(sessionId)!;
            try {
              const currentSha = await getGitSandbox().getHeadShaAsync();
              if (sessionRec.lastPassedSpecAuditSha === currentSha) {
                skipSpecAudit = true;
                writeLog(`[GateLoop] Skipping Spec-Gate Auditor: Diff is identical to last passing state (SHA: ${currentSha})`);
              }
            } catch (e) {}
          }

          if (skipSpecAudit) {
            const skipEvent = {
              type: 'gate.result',
              data: {
                gateName: 'runSpecAudit',
                pass: true,
                feedback: 'Spec audit skipped: codebase state unchanged since last validation.',
                durationMs: 0,
                retryCount
              }
            };
            await secureWrite(res, `data: ${JSON.stringify(skipEvent)}\n\n`, isRequestClosed);
          } else {
            writeLog(`[GateLoop] Executing Spec-Gate Auditor against isolation sandbox...`);
            updateStateSnapshot(sessionId, { activeGate: 'runSpecAudit' });
            const startSpecEvent = { type: 'gate.start', data: { gateName: 'runSpecAudit' } };
            await secureWrite(res, `data: ${JSON.stringify(startSpecEvent)}\n\n`, isRequestClosed);
            
            const specResult = await runSpecAudit(runCwd, abortController.signal);
            updateStateSnapshot(sessionId, { activeGate: undefined, hasFailureState: !specResult.pass });
            
            if (specResult.pass && sessionId && activeSessions.has(sessionId)) {
              const sessionRec = activeSessions.get(sessionId)!;
              try {
                const currentSha = await getGitSandbox().getHeadShaAsync();
                activeSessions.set(sessionId, { ...sessionRec, lastPassedSpecAuditSha: currentSha });
              } catch (e) {}
            }

            const specGateEv = {
              type: 'gate.result',
              data: {
                gateName: 'runSpecAudit',
                pass: specResult.pass,
                feedback: truncateOutput(specResult.feedback),
                durationMs: Date.now() - specStart,
                retryCount
              }
            };
            await secureWrite(res, `data: ${JSON.stringify(specGateEv)}\n\n`, isRequestClosed);

            if (!specResult.pass) {
              allGatesPassedInThisCycle = false;
              failedGateName = 'runSpecAudit';
              failedGateFeedback = truncateOutput(specResult.feedback);
            }
          }
        }

        // Final success check for current cycle
        allGatesPassed = allGatesPassedInThisCycle;
        
        if (allGatesPassed) {
          consecutiveFailures = 0;
          lastFailedGate = '';
          updateStateSnapshot(sessionId, { isRunning: false, hasFailureState: false });
          // Step 6: All gates pass → emit `loop.complete`, end
          writeLog(`[GateLoop] All gates passed successfully!`);

          const util = await import('util');
          let commitSha = '';
          const taskLabel = promptStr.length > 50 ? promptStr.slice(0, 47) + '...' : promptStr;
          
          try {
            commitSha = await getGitSandbox().commitAllChangesAsync(`Turn Completed: ${taskLabel}`);
          } catch (e: any) {
            // suppress git error output
          }
          
          if (sessionId && activeSessions.has(sessionId)) {
            const currentSession = activeSessions.get(sessionId)!;
            if (currentSession.turns && currentSession.turns.length > 0) {
              const currentTurn = currentSession.turns[currentSession.turns.length - 1];
              if (currentTurn) {
                const updatedTurns: ReadonlyArray<Turn> = currentSession.turns.map((turn, index) =>
                  index === currentSession.turns.length - 1
                    ? { ...turn, status: 'completed', commitSha } as Turn
                    : turn
                );
                activeSessions.set(sessionId, {
                  ...currentSession,
                  turns: updatedTurns
                });
              }
            }
          }

          const turnCompletedEvent = {
            type: 'TURN_COMPLETED',
            data: {
              turnId: `turn-${Date.now()}`,
              taskLabel,
              commitSha
            }
          };
          await secureWrite(res, `data: ${JSON.stringify(turnCompletedEvent)}\n\n`, isRequestClosed);

          const completeEvent = {
            type: 'loop.complete',
            data: {
              totalRetries,
              gatesRun: gatesRunCount,
              durationMs: Date.now() - loopStartTime
            }
          };
          await secureWrite(res, `data: ${JSON.stringify(completeEvent)}\n\n`, isRequestClosed);
          break;
        }

        // A gate failed. Record details in retry history only (avoiding prompt redundancy)
        retryHistory.push({
          retryCount,
          model: currentModel,
          failedGate: failedGateName,
          feedback: failedGateFeedback
        });

        // Step 7: If any gate fails AND retryCount < maxRetries
        if (retryCount < maxRetries) {
          retryCount++;
          totalRetries++;
          const nextModel = currentModel; // stays on current tier
          writeLog(`[GateLoop] Gate failed. Retrying (attempt ${retryCount}/${maxRetries}) on same model.`);

          const retryEvent = {
            type: 'loop.retry',
            data: {
              retryCount,
              maxRetries,
              currentModel,
              nextModel,
              failedGate: failedGateName,
              feedback: failedGateFeedback
            }
          };
          await secureWrite(res, `data: ${JSON.stringify(retryEvent)}\n\n`);

          // Narrow context: Original request + structured feedback on failing gate
          let history: ReadonlyArray<{ readonly role: 'user' | 'assistant'; readonly content: string }> = [];
          if (sessionId && activeSessions.has(sessionId)) {
            const narrowedSession = activeSessions.get(sessionId)!;
            const pruned = pruneConversationHistory(narrowedSession.conversationHistory);
            activeSessions.set(sessionId, {
              ...narrowedSession,
              conversationHistory: pruned
            });
            history = pruned;
          } else {
            history = pruneConversationHistory([]);
          }
          currentPrompt = formatContextNarrowingPrompt(promptStr, failedGateName, failedGateFeedback, history);
          continue; // runs step 1 again
        }

        // Step 8: retryCount === maxRetries
        const isFinalModel = currentModelIndex === uniqueModelTiers.length - 1;
        if (!isFinalModel) {
          // Escalate model tier, reset retryCount
          currentModelIndex++;
          retryCount = 0;
          totalRetries++;
          const nextModel = uniqueModelTiers[currentModelIndex];
          writeLog(`[GateLoop] Reached max retries. Escalating model tier from ${currentModel} to ${nextModel}.`);

          const retryEvent = {
            type: 'loop.retry',
            data: {
              retryCount,
              maxRetries,
              currentModel,
              nextModel,
              failedGate: failedGateName,
              feedback: failedGateFeedback
            }
          };
          await secureWrite(res, `data: ${JSON.stringify(retryEvent)}\n\n`);

          // Model Escalation
          let history: ReadonlyArray<{ readonly role: 'user' | 'assistant'; readonly content: string }> = [];
          if (sessionId && activeSessions.has(sessionId)) {
            const escalatedSession = activeSessions.get(sessionId)!;
            const pruned = pruneConversationHistory(escalatedSession.conversationHistory);
            activeSessions.set(sessionId, {
              ...escalatedSession,
              conversationHistory: pruned
            });
            history = pruned;
          } else {
            history = pruneConversationHistory([]);
          }
          currentPrompt = formatEscalationPrompt(promptStr, failedGateName, failedGateFeedback, history);
          continue; // runs step 1 with escalated model
        }

        // Step 9: On final model tier and still failing → emit `loop.escalate_human` & wait!
        writeLog(`[GateLoop] Failed on final model tier. Escalating to human for session ${sessionId}.`);
        updateStateSnapshot(sessionId, { awaitingHuman: true, isRunning: false, hasFailureState: true });
        const escalateEvent = {
          type: 'loop.escalate_human',
          data: {
            summary: `All validation gates failed. The '${failedGateName}' gate failed on premium model ${currentModel}.`,
            failedGate: failedGateName,
            retryHistory
          }
        };
        await secureWrite(res, `data: ${JSON.stringify(escalateEvent)}\n\n`);

        if (!sessionId || isRequestClosed) {
          try { if (session) { await session.disconnect(); session = null; } } catch (e) {}
          break;
        }

        // Persist loop state to StateSnapshot for human resumption
        updateStateSnapshot(sessionId, {
          awaitingHuman: true,
          isRunning: false,
          hasFailureState: true,
          currentModelIndex,
          totalRetries,
          currentPrompt: promptStr, // Original prompt
          retryHistory,
          failedGateName,
          failedGateFeedback
        });

        const activeRec = activeSessions.get(sessionId);

        // Add to persistent escalation store for task list UI
        appendEscalation({
          sessionId,
          summary: `All validation gates failed. The '${failedGateName}' gate failed on premium model ${currentModel}.`,
          failedGate: failedGateName,
          failedGateFeedback: failedGateFeedback,
          retryHistory: retryHistory || [],
          stateSnapshot: activeRec?.stateSnapshot,
          conversationHistory: activeRec?.conversationHistory,
          turns: activeRec?.turns,
          cwd: activeRec?.cwd,
          currentModel: activeRec?.currentModel,
        });

        writeLog(`[GateLoop] State saved. Closing SSE stream to await stateless POST /gate-resume for session ${sessionId}.`);
        await flushSseAndEnd(res);
        return; // Break completely; this request is finished!
      }
    } catch (innerLoopErr: any) {
      allGatesPassed = false;
      writeLog(`[GateLoop] Critical inner loop failure: ${innerLoopErr.stack || innerLoopErr}`);
    } finally {
      writeLog(`[GateLoop] Inner loop execution cycle terminated.`);
    }
    } catch (err: unknown) {
      if (heartbeatId) {
        clearInterval(heartbeatId);
        heartbeatId = null;
      }
      const errMsg = err instanceof Error ? err.message : String(err);
      writeLog(`[GateLoop] Exception in endpoint loop: ${err instanceof Error ? err.stack : errMsg}`);
      await cleanup();

      try {
        if (!res.destroyed && !res.writableEnded) {
          await secureWrite(res, `data: ${JSON.stringify({
            type: 'loop.error',
            data: { message: errMsg || 'Fatal pipeline escalation error' }
          })}\n\n`);
          await secureWrite(res, `data: ${JSON.stringify({
            type: 'session.error',
            data: { message: errMsg || 'Error occurred during gate run execution.' }
          })}\n\n`);
          await flushSseAndEnd(res);
        }
      } catch (_) {}
    } finally {
    updateStateSnapshot(currentSessionId, { isRunning: false, activeGate: undefined });
    writeLog(`[CleanupGuard] Orchestration sequence finished or failed.`);
    
    await cleanup();
    if (!res.writableEnded && !res.destroyed) {
      await flushSseAndEnd(res);
    }
  }
};
