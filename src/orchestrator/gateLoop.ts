import express from "express";

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
  ToolExecutionCompleteContent,
  defineTool,
} from "../copilotSdk/boundary";

// From other files
import {
  DEFAULT_ROLES_CONFIG,
  MODEL_TIERS,
  getNextTier,
} from "../config/models";
import { runGate, runTests, runLint, runWithTimeout } from "../gates";
import {
  SessionRecord,
  StateSnapshot,
  CopilotEventData,
  Turn,
} from "../types/session";
import { ExtendedSessionEvent } from "../types/events";
import { AuditFinding } from "../types/audit";
import {
  formatContextNarrowingPrompt,
  formatEscalationPrompt,
  formatHumanEscalationPrompt,
  formatClarityCheckPrompt,
} from "../utils/prompt";
import { makeDockerToolHandler } from "../utils/toolHandlers";
import {
  RUN_TERMINAL_DOCKER_TOOL,
  submitAuditFindingsTool,
  COMPOSER_ROUTER_TOOL,
  AMBIGUITY_CHECK_TOOL,
} from "../config/tools";
import { runForcedToolTurn } from "../utils/toolCallEnforcement";
import {
  normalizeGates,
  TASK_TYPE_GATE_MAP,
  resolvePipeline,
} from "../config/gates";
import { runSpecAudit } from "../gates/specAuditor";
import { validateCwd } from "../security/pathGuard";
import { sanitizeSensitives } from "../utils/sanitizers";
import { truncateOutput } from "../utils/formatters";
import {
  initializeWorkspace,
  getGitSandbox,
  getExecCommand,
  getWorkspaceRoot,
} from "../workspace";
import {
  enforceWorkingMemoryTruncation,
  SlidingWindowCircularBuffer,
  clearCleanCache,
} from "../utils/contextManager";
import { fetchStubbedTraceResponse } from "../utils/traceRegistry";
import {
  appendEscalation,
  updateEscalationStatus,
  getEscalations,
  getPendingEscalation,
} from "../utils/escalationStore";
import { createSseWriter } from "../utils/sseWriter";
import {
  getSession,
  saveSession,
  deleteSession,
  getAllSessions,
} from "../db/sessionStore";
import { saveTask, getTask, TaskRecord } from "../db/taskStore";
import { decomposeSpecIntoTasks } from "../utils/taskManager";
import { ProviderRegistry } from "../utils/providerRegistry";

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
    type: "function";
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
  LogLevel,
  sensitiveValuesCache,
  DIAGNOSTIC_SCENARIOS,
  DEFAULT_WORKSPACE_DIR,
  CopilotCreateSessionOptions,
  getCodeState,
  runLlmAudit,
} from "./sessionState";

import { ExtendedResponse, SseWriter } from "../utils/sseWriter";

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

const secureWrite = async (
  res: express.Response,
  data: string,
  isRequestClosed: boolean = false,
) => {
  return getSseWriter().secureWrite(res, data, isRequestClosed);
};

const flushSseAndEnd = async (res: express.Response) => {
  return getSseWriter().flushSseAndEnd(res);
};

function pruneConversationHistory(
  history: ReadonlyArray<{ role: "user" | "assistant"; content: string }>,
) {
  return enforceWorkingMemoryTruncation(history);
}

export let globalAutoApproveAll = process.env.NODE_ENV === "test";
export function setGlobalAutoApproveAll(val: boolean) {
  globalAutoApproveAll = val;
}

// Least-privilege permission evaluator for incoming commands and tools
export const handleGateRunPermission = async (
  req: PermissionRequest,
): Promise<PermissionRequestResult & { reason?: string }> => {
  let toolName = "";
  if (req.kind === "custom-tool") {
    toolName = req.toolName || "";
  } else if (req.kind === "shell") {
    toolName =
      req.commands?.[0]?.identifier || req.fullCommandText?.split(" ")[0] || "";
  } else {
    // Backwards compatibility or alternative structures safely checked
    const record = req as unknown as Record<string, unknown>;
    if (typeof record.toolName === "string" && record.toolName) {
      toolName = record.toolName;
    } else if (typeof record.name === "string" && record.name) {
      toolName = record.name;
    } else if (Array.isArray(record.toolCalls) && record.toolCalls.length > 0) {
      const firstCall = record.toolCalls[0] as Record<string, unknown>;
      if (
        firstCall &&
        firstCall.function &&
        typeof firstCall.function === "object"
      ) {
        const fn = firstCall.function as Record<string, unknown>;
        if (typeof fn.name === "string" && fn.name) {
          toolName = fn.name;
        }
      }
    } else if (typeof record.command === "string" && record.command) {
      toolName = record.command;
    }
  }

  if (globalAutoApproveAll) {
    writeLog(
      `[Security] Auto-approving tool/command execution: ${toolName || "unknown"}`,
      LogLevel.INFO,
    );
    return { kind: "approve-once" };
  }

  // Safe read-only/audit tools
  const safeTools = [
    "submit_audit_findings",
    "ambiguity_check",
    "composer_router",
  ];
  if (safeTools.includes(toolName)) {
    writeLog(
      `[Security] Auto-approved safe utility tool: ${toolName}`,
      LogLevel.DEBUG,
    );
    return { kind: "approve-once" };
  }

  // If in test environment, allow command execution in sandbox
  if (process.env.NODE_ENV === "test") {
    writeLog(
      `[Security] Approved command execution in test environment: ${toolName}`,
      LogLevel.DEBUG,
    );
    return { kind: "approve-once" };
  }

  // Allowed orchestrator tools
  const allowedOrchestratorTools = ["run_terminal_docker", "run_tests"];
  if (allowedOrchestratorTools.includes(toolName)) {
    // Verify there is an active running session
    const hasActiveSession = Array.from(activeSessions.values()).some(
      (s) => s.stateSnapshot?.isRunning && !s.stateSnapshot?.awaitingHuman,
    );
    if (hasActiveSession) {
      writeLog(
        `[Security] Approved active session tool execution: ${toolName}`,
        LogLevel.DEBUG,
      );
      return { kind: "approve-once" };
    } else {
      writeLog(
        `[Security Check Failed] Denied tool execution outside of an active running session context: ${toolName}`,
        LogLevel.WARN,
      );
      return {
        kind: "reject",
        feedback: `Execution of ${toolName} requires an active, authorized orchestration session context.`,
        reason: `Execution of ${toolName} requires an active, authorized orchestration session context.`,
      };
    }
  }

  // Default block for other tools
  writeLog(
    `[Security Check Failed] Blocked unknown or unauthorized tool: ${toolName}`,
    LogLevel.WARN,
  );
  return {
    kind: "reject",
    feedback: `Tool ${toolName} is not authorized`,
    reason: `Tool ${toolName} is not authorized`,
  };
};

interface RehydratedRequest extends express.Request {
  _rehydratedHistory?: ReadonlyArray<{
    readonly role: "user" | "assistant";
    readonly content: string;
  }>;
  _rehydratedTurns?: ReadonlyArray<Turn>;
  _rehydratedStateSnapshot?: StateSnapshot;
  _blueprintTargets?: ReadonlyArray<string>;
}

export class SessionSseHub {
  private static subscribers = new Map<string, Set<express.Response>>();
  private static bufferedEvents = new Map<string, CopilotEventData[]>();

  static subscribe(sessionId: string, res: express.Response) {
    if (!this.subscribers.has(sessionId)) {
      this.subscribers.set(sessionId, new Set());
    }
    this.subscribers.get(sessionId)!.add(res);
    writeLog(
      `[Hub] Subscribed response for session ${sessionId}. Total: ${this.subscribers.get(sessionId)!.size}`,
    );
  }

  static unsubscribe(sessionId: string, res: express.Response) {
    const subs = this.subscribers.get(sessionId);
    if (subs) {
      subs.delete(res);
      writeLog(
        `[Hub] Unsubscribed response for session ${sessionId}. Remaining: ${subs.size}`,
      );
      if (subs.size === 0) {
        this.subscribers.delete(sessionId);
      }
    }
  }

  static clearBuffer(sessionId: string) {
    this.bufferedEvents.set(sessionId, []);
  }

  static getBuffer(sessionId: string) {
    return this.bufferedEvents.get(sessionId) || [];
  }

  static addToBuffer(sessionId: string, event: CopilotEventData) {
    if (!this.bufferedEvents.has(sessionId)) {
      this.bufferedEvents.set(sessionId, []);
    }
    this.bufferedEvents.get(sessionId)!.push(event);
  }

  static async broadcast(
    sessionId: string,
    data: string,
    isClosed: boolean = false,
  ) {
    let finalData = data;
    let enrichedEvent: CopilotEventData | null = null;

    if (data.startsWith("data: {")) {
      const jsonStr = data.substring(5).trim();
      if (jsonStr) {
        try {
          const parsed = JSON.parse(jsonStr);
          if (parsed && typeof parsed === "object") {
            if (parsed.sequenceId !== undefined) {
              enrichedEvent = parsed;
              finalData = `data: ${JSON.stringify(parsed)}\n\n`;
            } else {
              const session = activeSessions.get(sessionId);
              if (session) {
                const newSequenceCounter =
                  (session.eventSequenceCounter || 0) + 1;
                activeSessions.set(sessionId, {
                  ...session,
                  eventSequenceCounter: newSequenceCounter,
                  turns: session.turns ? [...session.turns] : [],
                });
                const updatedSession = activeSessions.get(sessionId)!;
                const { enrichEventPayload } =
                  await import("../utils/sseWriter");
                const typedEventObj = enrichEventPayload(
                  parsed,
                  newSequenceCounter,
                  updatedSession.stateSnapshot,
                );
                enrichedEvent = typedEventObj;

                if (updatedSession.turns.length === 0) {
                  const newTurn: Turn = {
                    id: `turn-fallback-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`,
                    taskLabel: "System Recovery / Unknown Turn",
                    status: "running",
                    events: [],
                  };
                  activeSessions.set(sessionId, {
                    ...updatedSession,
                    turns: [...updatedSession.turns, newTurn],
                  });
                }
                const currentSession = activeSessions.get(sessionId)!;
                const currentTurn =
                  currentSession.turns[currentSession.turns.length - 1];
                if (currentTurn) {
                  const updatedTurns = currentSession.turns.map(
                    (turn, index) =>
                      index === currentSession.turns.length - 1
                        ? { ...turn, events: [...turn.events, typedEventObj] }
                        : turn,
                  );
                  activeSessions.set(sessionId, {
                    ...currentSession,
                    turns: updatedTurns,
                  });
                }
                finalData = `data: ${JSON.stringify(typedEventObj)}\n\n`;
              }
            }
          }
        } catch (e) {
          writeLog(`[Hub Broadcast Error] Parsing event failed: ${e}`);
        }
      }
    }

    if (enrichedEvent) {
      this.addToBuffer(sessionId, enrichedEvent);
    }

    const subs = this.subscribers.get(sessionId);
    if (subs) {
      const promises = Array.from(subs).map(async (subRes) => {
        try {
          await secureWrite(subRes, finalData, isClosed);
        } catch (err) {
          writeLog(
            `[Hub Broadcast Error] Failed to write to subscriber: ${err}`,
          );
        }
      });
      await Promise.all(promises);
    }
  }

  static async endAll(sessionId: string) {
    const subs = this.subscribers.get(sessionId);
    if (subs) {
      const promises = Array.from(subs).map(async (subRes) => {
        try {
          await flushSseAndEnd(subRes);
        } catch (err) {
          writeLog(`[Hub EndAll Error] Failed to end subscriber: ${err}`);
        }
      });
      await Promise.all(promises);
      this.subscribers.delete(sessionId);
    }
  }
}

export const activeBackgroundRuns = new Map<
  string,
  {
    abortController: AbortController;
    promise: Promise<void>;
  }
>();

export const handleGateLoop = async (
  req: express.Request,
  res: express.Response,
) => {
  const rreq = req as RehydratedRequest;
  const isResume = rreq.path.includes("/gate-resume");
  const { sessionId, diagnosticScenario, replayTraceId } = req.body;
  let currentSessionId =
    sessionId ||
    `sess-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;

  const isDiagnostic =
    (!!diagnosticScenario || !!replayTraceId) &&
    process.env.DIAGNOSTIC_MODE === "true";
  if ((diagnosticScenario || replayTraceId) && !isDiagnostic) {
    writeLog(
      "[Security] Diagnostic mode is disabled. Rejecting diagnostic request.",
      LogLevel.WARN,
    );
    res.writeHead(403, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        success: false,
        error: "Diagnostic mode is disabled via environment configuration.",
      }),
    );
    return;
  }

  if (activeLocks.has(currentSessionId)) {
    res.writeHead(409, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        success: false,
        error: `Session ${currentSessionId} is currently busy processing another request.`,
      }),
    );
    return;
  }

  // 1. Check if locked due to manual panic intervention
  const sess = activeSessions.get(currentSessionId);
  if (sess && sess.stateSnapshot?.manualIntervention) {
    res.writeHead(403, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        success: false,
        error: "Session locked due to manual panic intervention.",
      }),
    );
    return;
  }

  let initialCwd = getWorkspaceRoot();
  try {
    initialCwd = validateCwd(req.body.cwd);
  } catch (e) {}
  if (!activeSessions.has(currentSessionId)) {
    activeSessions.set(currentSessionId, {
      sessionId: currentSessionId,
      cwd: initialCwd,
      copilotSession: null as unknown as CopilotSession,
      stateSnapshot: { isRunning: true },
    } as unknown as SessionRecord);
  }

  // 2. Check if a background run is already active for this session
  const activeRun = activeBackgroundRuns.get(currentSessionId);
  const wantStream = req.query.stream !== "false" && req.body.stream !== false;

  if (activeRun) {
    writeLog(
      `[GateLoop] Session ${currentSessionId} already has an active background run.`,
    );
    if (wantStream) {
      writeLog(
        `[GateLoop] Reconnecting streaming client directly to in-progress session ${currentSessionId}`,
      );
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      res.write(":\n\n");
      SessionSseHub.subscribe(currentSessionId, res);
      const buffered = SessionSseHub.getBuffer(currentSessionId);
      for (const ev of buffered) {
        await secureWrite(res, `data: ${JSON.stringify(ev)}\n\n`);
      }
      res.on("close", () => {
        writeLog(
          `[GateLoop] Reconnected client connection closed for session ${currentSessionId}`,
        );
        SessionSseHub.unsubscribe(currentSessionId, res);
      });
    } else {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          success: true,
          sessionId: currentSessionId,
          alreadyRunning: true,
        }),
      );
    }
    return;
  }

  // Clear buffer for a completely fresh run
  SessionSseHub.clearBuffer(currentSessionId);

  if (wantStream) {
    // Set up SSE headers on the initial connection if legacy inline stream is requested
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.write(":\n\n");
    sseResToSessionId.set(res, currentSessionId);
    SessionSseHub.subscribe(currentSessionId, res);
    res.on("close", () => {
      writeLog(
        `[GateLoop] Initial streaming client connection closed for session ${currentSessionId}. Loop continues running in background.`,
      );
      SessionSseHub.unsubscribe(currentSessionId, res);
      sseResToSessionId.delete(res);
    });
  }

  // Create AbortController for the background task
  const runAbortController = new AbortController();
  activeLocks.set(currentSessionId, runAbortController);

  // Now, spawn the background task asynchronously!
  const runPromise = (async () => {
    let session: CopilotSession | null = null;
    let unsubscribe: (() => void) | null = null;
    let isRequestClosed = false;
    let heartbeatId: NodeJS.Timeout | null = null;
    let cleaningUp = false;

    const abortController = runAbortController;
    const abortPromise = new Promise<never>((_, reject) => {
      const onAbort = () =>
        reject(new Error("Operation aborted by client or timeout"));
      if (abortController.signal.aborted) onAbort();
      else
        abortController.signal.addEventListener("abort", onAbort, {
          once: true,
        });
    });

    // Create a virtual res object that writes to the SessionSseHub
    const res = {
      destroyed: false,
      writableEnded: false,
      writeHead: (
        status: number,
        headers: Record<string, string | number | string[]>,
      ) => {
        writeLog(`[Background virtualRes] writeHead status=${status}`);
        return res;
      },
      write: (chunk: string | Buffer) => {
        SessionSseHub.broadcast(currentSessionId, chunk.toString());
        return true;
      },
      end: (chunk?: string | Buffer) => {
        if (chunk) {
          SessionSseHub.broadcast(currentSessionId, chunk.toString());
        }
        const mutRes = res as unknown as {
          destroyed: boolean;
          writableEnded: boolean;
        };
        mutRes.writableEnded = true;
        mutRes.destroyed = true;
        SessionSseHub.endAll(currentSessionId);
      },
      once: () => {},
      removeListener: () => {},
    } as unknown as express.Response;

    const cleanup = async () => {
      if (cleaningUp) return;
      cleaningUp = true;
      isRequestClosed = true;
      const mutRes = res as unknown as {
        destroyed: boolean;
        writableEnded: boolean;
      };
      mutRes.writableEnded = true;
      mutRes.destroyed = true;
      abortController.abort();

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
              conversationHistory: history.slice(-20),
            });
            writeLog(
              `[GC] Trimmed conversation history for session ${currentSessionId} to prevent memory bloat.`,
            );
          }
        }
        // Force-evict cleanCache content to prevent stale static strings from leaking across sessions
        clearCleanCache();
        writeLog(`[GC] Cleared static log regex cache on session shutdown.`);
      }
      if (unsubscribe) {
        try {
          unsubscribe();
        } catch (e) {}
        unsubscribe = null;
      }
      try {
        if (session) {
          // If the session is part of the persistent activeSessions, do NOT disconnect here.
          // Disconnecting would break context retention for future turns using getOrCreateSession.
          // The global GC interval handles pruning inactive persistent sessions.
          const isPersistent = Array.from(activeSessions.values()).some(
            (s) => s.copilotSession === session,
          );
          if (!isPersistent) {
            await session.disconnect();
          }
          session = null;
        }
      } catch (e) {}
    };

    try {
      console.log("gateLoop body:", req.body);
      const {
        prompt,
        input,
        gates: rawGates,
        maxRetries = 2,
        apiKey,
        model,
        cwd,
        sessionId,
        diagnosticScenario,
        replayTraceId,
        simulateBackpressureDelayMs,
      } = req.body;
      const gates = Array.isArray(rawGates)
        ? rawGates
        : rawGates
          ? [String(rawGates)]
          : [];
      const keyToUse = apiKey || process.env.GEMINI_API_KEY;
      const registryInstance = new ProviderRegistry(keyToUse);

      if (simulateBackpressureDelayMs) {
        (res as ExtendedResponse).simulateBackpressureDelayMs = Number(
          simulateBackpressureDelayMs,
        );
      }

      const payload = req.body;

      // Register virtualRes so secureWrite can map it to sessionId
      sseResToSessionId.set(res, currentSessionId);

      writeLog(
        `[Background API Run] starting: isResume=${isResume}, model=${model || "default"}, cwd=${cwd || "default"}, sessionId=${sessionId || "none"}`,
      );

      const isDiagnostic =
        (!!diagnosticScenario || !!replayTraceId) &&
        process.env.DIAGNOSTIC_MODE === "true";
      const scenario =
        isDiagnostic && diagnosticScenario
          ? DIAGNOSTIC_SCENARIOS[diagnosticScenario as string]
          : null;

      if ((diagnosticScenario || replayTraceId) && !isDiagnostic) {
        writeLog(
          "[Security] Diagnostic mode is disabled. Rejecting diagnostic request.",
          LogLevel.WARN,
        );
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            success: false,
            error: "Diagnostic mode is disabled via environment configuration.",
          }),
        );
        await cleanup();
        return;
      }

      if (currentSessionId) {
        const sessId = currentSessionId;
        if (isResume) {
          updateEscalationStatus(sessId, "resumed");
        }
      }

      let promptStr = prompt as string;
      let sessRecord = currentSessionId
        ? activeSessions.get(currentSessionId)
        : null;

      // Rehydrate if memory is cleared but we have it in the DB
      if (!sessRecord && currentSessionId) {
        const storedSession = getSession(currentSessionId);
        if (storedSession && storedSession.stateSnapshot) {
          writeLog(
            `[GateLoop] Rehydrating session ${currentSessionId} from SQLite database.`,
          );

          sessRecord = {
            stateSnapshot: storedSession.stateSnapshot,
            conversationHistory: storedSession.conversationHistory || [],
            turns: storedSession.turns || [],
            cwd: storedSession.cwd || getWorkspaceRoot(),
            currentModel: storedSession.currentModel || "gemini-3.1-flash-lite",
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
            promptStr = formatHumanEscalationPrompt(
              promptStr,
              snap.failedGateName,
              snap.failedGateFeedback || "",
              input,
            );
          }
        }
      }

      if (sessRecord && sessRecord.pendingPatchedSpec) {
        const updatedSpecText = sessRecord.pendingPatchedSpec;
        activeSessions.set(currentSessionId!, {
          ...sessRecord,
          pendingPatchedSpec: undefined,
        });
        promptStr = `${promptStr}\n\n[SYSTEM UPDATE] The system architecture specification has been updated. Please continue the task and adapt your strategy to adhere to the updated specification:\n\n${updatedSpecText}`;
      }

      if (!promptStr || promptStr.trim() === "") {
        res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("User prompt is required.");
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
        writeLog(`[Security Blocked] ${msg}`, LogLevel.WARN);
        res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
        res.end(
          "Access denied: Invalid directory path or directory traversal.",
        );
        await cleanup();
        return;
      }

      const startModel = model || "gemini-3.1-flash-lite";

      const executionConfig = registryInstance.getExecutionConfig(startModel);

      // Determine if a key is actually required by checking the mapped provider
      const activeProviderType = executionConfig.providerType;

      const requiresKey =
        activeProviderType !== "copilot-native" &&
        activeProviderType !== "local";

      if (requiresKey && (!keyToUse || keyToUse === "MY_GEMINI_API_KEY")) {
        res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
        res.end(
          "API Key is missing for the selected provider. Please add your key under Settings > Secrets, or type your own key.",
        );
        await cleanup();
        return;
      }

      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });

      let assistantMessage = "";
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
        const loopExecutionConfig =
          registryInstance.getExecutionConfig(startModel);
        const loopSessionOptions: CopilotCreateSessionOptions = {
          model: loopExecutionConfig.model,
          ...(loopExecutionConfig.provider
            ? { provider: loopExecutionConfig.provider as SdkProviderConfig }
            : {}),
          tools: [
            {
              name: RUN_TERMINAL_DOCKER_TOOL.function.name,
              description: RUN_TERMINAL_DOCKER_TOOL.function.description,
              parameters: RUN_TERMINAL_DOCKER_TOOL.function
                .parameters as Record<string, unknown>,
              handler: makeDockerToolHandler(
                secureWrite,
                res,
                abortController.signal,
                writeLog,
                sensitiveValuesCache || new Set<string>(),
                sessionId || undefined,
              ),
            },
            {
              name: "run_tests",
              description:
                "Run project tests (Integration compatibility alias)",
              parameters: {
                type: "object",
                properties: {
                  target: { type: "string" },
                  flags: { type: "array", items: { type: "string" } },
                },
              },
              handler: async (args: unknown) => {
                const res = await runTests(runCwd);
                return { status: "success", output: res.output };
              },
            },
          ],
          onPermissionRequest: handleGateRunPermission,
          streaming: true,
        };

        console.log(
          "Calling getOrCreateSession with",
          sessionId,
          loopExecutionConfig.model,
          runCwd,
        );
        await getOrCreateSession(
          sessionId,
          loopExecutionConfig.model,
          runCwd,
          client,
          loopSessionOptions,
        );
        updateStateSnapshot(sessionId, { isRunning: true });
      }

      if (!isResume) {
        resetSessionForNewRun(sessionId);
      }

      let activeTaskId: string | undefined;
      try {
        const decomposition = await decomposeSpecIntoTasks(runCwd);
        if (decomposition) {
          const { tasks } = decomposition;
          if (isResume) {
            // If we are resuming, find if there is a task that failed/blocked/running and complete/skip it
            // to "resume from the next step"
            for (const t of tasks) {
              if (t.status === "blocked" || t.status === "running") {
                const updatedTask = {
                  ...t,
                  status: "done" as const,
                  updatedAt: Date.now(),
                };
                saveTask(updatedTask);
                writeLog(
                  `[GateLoop] Resuming: Advanced past blocked/running task ${t.taskId}.`,
                );
                break; // advance one task at a time
              }
            }
            // Re-decompose to get updated status
            const refreshed = await decomposeSpecIntoTasks(runCwd);
            if (refreshed) {
              const nextTask = refreshed.tasks.find(
                (t) => t.status === "pending" || t.status === "running",
              );
              if (nextTask) {
                activeTaskId = nextTask.taskId;
                saveTask({
                  ...nextTask,
                  status: "running",
                  updatedAt: Date.now(),
                });
                writeLog(
                  `[GateLoop] Selected next pending task to run: ${activeTaskId}`,
                );
              }
            }
          } else {
            // Regular run: find the first pending or running task
            const currentTask = tasks.find(
              (t) => t.status === "pending" || t.status === "running",
            );
            if (currentTask) {
              activeTaskId = currentTask.taskId;
              saveTask({
                ...currentTask,
                status: "running",
                updatedAt: Date.now(),
              });
              writeLog(
                `[GateLoop] Selected first pending task to run: ${activeTaskId}`,
              );
            }
          }
        }
      } catch (err) {
        writeLog(`[GateLoop] Task decomposition failed: ${err}`);
      }

      if (activeTaskId) {
        try {
          const taskRecord = getTask(activeTaskId);
          if (taskRecord && taskRecord.branchName) {
            writeLog(
              `[GateLoop] Task ${activeTaskId} has existing branch ${taskRecord.branchName}. Resuming branch.`,
            );
            await getGitSandbox().resumeTaskBranch(activeTaskId);
          } else {
            writeLog(
              `[GateLoop] Task ${activeTaskId} has no existing branch. Creating new branch.`,
            );
            await getGitSandbox().checkoutTaskBranch(
              activeTaskId,
              taskRecord?.pbiId ?? undefined,
            );
          }
        } catch (err) {
          writeLog(
            `[GateLoop] Error checking out/resuming task branch: ${err}`,
          );
          const taskRecord = getTask(activeTaskId);
          if (taskRecord) {
            saveTask({
              ...taskRecord,
              status: "blocked",
              blockedReason: `Failed to checkout/resume branch: ${err instanceof Error ? err.message : String(err)}`,
              updatedAt: Date.now(),
            });
          }
          throw new Error(
            `Failed to checkout/resume branch: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      const activeSessionRecord = sessionId
        ? activeSessions.get(sessionId)
        : null;
      const taskLabel =
        promptStr.length > 50 ? promptStr.slice(0, 47) + "..." : promptStr;
      const currentTurnId = `turn-${Date.now()}`;
      if (activeSessionRecord) {
        activeSessions.set(sessionId, {
          ...activeSessionRecord,
          taskId: activeTaskId || activeSessionRecord.taskId,
          turns: [
            ...(activeSessionRecord.turns || []),
            {
              id: currentTurnId,
              taskLabel,
              status: "running",
              events: [],
            },
          ],
        });
      }

      res.write(":\n\n");

      let currentPrompt = promptStr;

      // T0: Ambiguity Checker (SYS-REQ-016/017)
      if (!isDiagnostic && !isResume) {
        writeLog(`[Ambiguity] Running pre-flight clarity check...`);
        try {
          const clarityConfig = registryInstance.getExecutionConfig(
            DEFAULT_ROLES_CONFIG.planner.model,
          );
          const claritySession: CopilotSession = await client.createSession({
            model: clarityConfig.model,
            provider: clarityConfig.provider as SdkProviderConfig,
            onPermissionRequest: async () => ({ kind: "approve-once" }),
            tools: [
              defineTool(
                AMBIGUITY_CHECK_TOOL.function.name,
                AMBIGUITY_CHECK_TOOL.function.description,
                AMBIGUITY_CHECK_TOOL.function.parameters,
                async () => {
                  return { status: "success" };
                },
              ),
            ],
          });

          let clarityData: ClarityCheckData | null = null;
          // NOTE: attached via onSession below (not just on `claritySession`), because
          // runForcedToolTurn's nudge retry calls client.resumeSession() internally,
          // which returns a brand-new CopilotSession object. A listener bound only to
          // the original `claritySession` would silently miss the tool call if the
          // model only complies on the retry.
          const attachClarityListener = (s: CopilotSession) => {
            return s.on("tool.execution_start", (event) => {
              writeLog(
                `[Ambiguity] Event: ${event.type} ${JSON.stringify(event.data || {})}`,
              );
              if (
                event.data?.toolName === "submit_clarity_check" &&
                event.data.arguments
              ) {
                const args = event.data.arguments as Record<string, unknown>;
                clarityData = {
                  score: typeof args.score === "number" ? args.score : 0,
                  missingVariables: Array.isArray(args.missingVariables)
                    ? args.missingVariables.map((v) => String(v))
                    : [],
                  feedback:
                    typeof args.feedback === "string"
                      ? args.feedback
                      : undefined,
                };
                writeLog(
                  `[Ambiguity] Captured clarityData from tool.execution_start: ${JSON.stringify(clarityData)}`,
                );
              }
            });
          };

          writeLog(`[Ambiguity] Sending request to ambiguity checker...`);
          let currentClaritySession = claritySession;
          const clarityAbortHandler = () => {
            currentClaritySession.disconnect().catch(() => {});
          };
          abortController.signal.addEventListener("abort", clarityAbortHandler);
          let clarityRunResult:
            | Awaited<ReturnType<typeof runForcedToolTurn>>
            | undefined;
          try {
            const runPromise = runForcedToolTurn(
              claritySession,
              clarityConfig,
              "submit_clarity_check",
              formatClarityCheckPrompt(promptStr),
              {
                client,
                timeoutMs: 20000,
                getResult: () => clarityData,
                tools: [
                  defineTool(
                    AMBIGUITY_CHECK_TOOL.function.name,
                    AMBIGUITY_CHECK_TOOL.function.description,
                    AMBIGUITY_CHECK_TOOL.function.parameters,
                    async () => {
                      return { status: "success" };
                    },
                  ),
                ],
                onSession: (s) => {
                  currentClaritySession = s;
                  const unsub = attachClarityListener(s);
                  return unsub;
                },
              },
            );
            clarityRunResult = (await Promise.race([
              runPromise,
              abortPromise,
            ])) as Awaited<ReturnType<typeof runForcedToolTurn>> | undefined;
          } finally {
            abortController.signal.removeEventListener(
              "abort",
              clarityAbortHandler,
            );
          }
          writeLog(
            `[Ambiguity] sendAndWait finished. clarityData is: ${JSON.stringify(clarityData)}`,
            LogLevel.DEBUG,
          );
          // Fire-and-forget: nothing downstream needs to wait on cleanup completing,
          // and awaiting it here adds real (occasionally spiky) latency to the
          // request path for no benefit.
          (clarityRunResult?.session ?? currentClaritySession)
            .disconnect()
            .catch(() => {});

          const finalClarityData = clarityData as ClarityCheckData | null;
          if (finalClarityData && finalClarityData.score < 0.85) {
            const missingList = finalClarityData.missingVariables
              .map((v: string) => `• ${v}`)
              .join("\n");
            const clarityEvent = {
              type: "loop.clarity_check_failed",
              data: {
                score: finalClarityData.score,
                missingVariables: finalClarityData.missingVariables,
                feedback: `Goal ambiguity detected (Clarity: ${finalClarityData.score}). Please clarify:\n${missingList}`,
              },
            };
            await secureWrite(
              res,
              `data: ${JSON.stringify(clarityEvent)}\n\n`,
              isRequestClosed,
            );
            await flushSseAndEnd(res);
            await cleanup();
            return;
          }
        } catch (err) {
          writeLog(
            `[Ambiguity] Check failed, bypassing: ${err}`,
            LogLevel.WARN,
          );
          const warnEvent = {
            type: "loop.warning",
            data: {
              message: `Ambiguity check failed: ${err instanceof Error ? err.message : String(err)}. Bypassing to execution.`,
            },
          };
          await secureWrite(
            res,
            `data: ${JSON.stringify(warnEvent)}\n\n`,
            isRequestClosed,
          );
        }
      }

      // T1: Composer Router Classification (Structured Tool Choice)
      let activeStepGates = normalizeGates(gates || []);
      let classifiedType = "";
      if (!isDiagnostic && !isResume) {
        writeLog(
          `[Composer] Classifying task intent for: "${promptStr.substring(0, 50)}..."`,
        );
        try {
          const classificationConfig = registryInstance.getExecutionConfig(
            DEFAULT_ROLES_CONFIG.planner.model,
          );
          const classificationSession: CopilotSession =
            await client.createSession({
              model: classificationConfig.model,
              provider: classificationConfig.provider as SdkProviderConfig,
              onPermissionRequest: async () => ({ kind: "approve-once" }),
              tools: [
                defineTool(
                  COMPOSER_ROUTER_TOOL.function.name,
                  COMPOSER_ROUTER_TOOL.function.description,
                  COMPOSER_ROUTER_TOOL.function.parameters,
                  async () => {
                    return { status: "success" };
                  },
                ),
              ],
            });
          let toolArguments: ComposerRouteArguments | null = null;
          // NOTE: attached via onSession below (not just on `classificationSession`),
          // because runForcedToolTurn's nudge retry calls client.resumeSession()
          // internally, which returns a brand-new CopilotSession object. A listener
          // bound only to the original `classificationSession` would silently miss
          // the tool call if the model only complies on the retry.
          const attachClassificationListener = (s: CopilotSession) => {
            return s.on("tool.execution_start", (event) => {
              if (
                event.data?.toolName === "initialize_blueprint" &&
                event.data.arguments
              ) {
                const args = event.data.arguments as Record<string, unknown>;
                toolArguments = {
                  taskType:
                    typeof args.taskType === "string"
                      ? args.taskType
                      : undefined,
                  targetDirectories: Array.isArray(args.targetDirectories)
                    ? args.targetDirectories.map((d) => String(d))
                    : undefined,
                };
                writeLog(
                  `[Composer] Captured toolArguments from tool.execution_start: ${JSON.stringify(toolArguments)}`,
                );
              }
            });
          };

          const classificationPrompt = `Analyze the following user prompt for a code generation task and initialize the workspace blueprint: "${promptStr}"`;

          let currentClassificationSession = classificationSession;
          const classificationAbortHandler = () => {
            currentClassificationSession.disconnect().catch(() => {});
          };
          abortController.signal.addEventListener(
            "abort",
            classificationAbortHandler,
          );
          try {
            // Force the tool choice to guarantee a structured plan
            const runPromise = runForcedToolTurn(
              classificationSession,
              classificationConfig,
              "initialize_blueprint",
              classificationPrompt,
              {
                client,
                timeoutMs: 30000,
                getResult: () => toolArguments,
                tools: [
                  defineTool(
                    COMPOSER_ROUTER_TOOL.function.name,
                    COMPOSER_ROUTER_TOOL.function.description,
                    COMPOSER_ROUTER_TOOL.function.parameters,
                    async () => {
                      return { status: "success" };
                    },
                  ),
                ],
                onSession: (s) => {
                  currentClassificationSession = s;
                  const unsub = attachClassificationListener(s);
                  return unsub;
                },
              },
            );
            await Promise.race([runPromise, abortPromise]);
          } finally {
            abortController.signal.removeEventListener(
              "abort",
              classificationAbortHandler,
            );
          }

          // Note: The type cast 'as ComposerRouteArguments | null' is required to prevent TypeScript's
          // control flow analysis from narrowing this asynchronously-mutated variable to 'null' (and thus 'never').
          const args = toolArguments as ComposerRouteArguments | null;
          if (args && args.taskType) {
            classifiedType = args.taskType;
            activeStepGates = resolvePipeline(classifiedType);
            writeLog(
              `[Composer] Structured classification: ${classifiedType}, Gates: ${activeStepGates.join(", ")}`,
            );

            // T2: Emit Explicit composer.plan Stream Events
            const planEvent = {
              type: "composer.plan",
              data: {
                taskType: classifiedType,
                resolvedGates: [...activeStepGates],
                gates: [...activeStepGates],
                targetDirectories: [...(args.targetDirectories || [])],
              },
            };
            await secureWrite(
              res,
              `data: ${JSON.stringify(planEvent)}\n\n`,
              isRequestClosed,
            );

            if (args.targetDirectories) {
              rreq._blueprintTargets = args.targetDirectories;
            }
          } else {
            writeLog(
              `[Composer] Structured classification failed or empty, falling back to feature.`,
            );
            activeStepGates = resolvePipeline("feature");

            const warnEvent = {
              type: "loop.warning",
              data: {
                message:
                  "Plan classification failed or returned no intent. Falling back to default feature pipeline.",
              },
            };
            await secureWrite(
              res,
              `data: ${JSON.stringify(warnEvent)}\n\n`,
              isRequestClosed,
            );
          }
          // Fire-and-forget: same reasoning as the clarity-check disconnect above.
          currentClassificationSession.disconnect().catch(() => {});
        } catch (err) {
          writeLog(
            `[Composer] Classification failed, falling back: ${err}`,
            LogLevel.WARN,
          );
          activeStepGates = resolvePipeline("feature");

          const warnEvent = {
            type: "loop.warning",
            data: {
              message: `Classification error: ${err instanceof Error ? err.message : String(err)}. Falling back to default feature pipeline.`,
            },
          };
          await secureWrite(
            res,
            `data: ${JSON.stringify(warnEvent)}\n\n`,
            isRequestClosed,
          );
        }
      }

      const moveToNextTask = async (
        failureReason: string,
        failureGate: string,
      ): Promise<boolean> => {
        writeLog(
          `[GateLoop] moveToNextTask initiated. Failure reason: ${failureReason}. Failure gate: ${failureGate}`,
        );

        // 1. Park the current active task branch (which commits changes, saves branch name, and returns to base)
        if (activeTaskId) {
          try {
            await getGitSandbox().parkTaskBranch(activeTaskId);
            writeLog(`[GateLoop] Parked task branch for: ${activeTaskId}`);
          } catch (e) {
            writeLog(
              `[GateLoop] Error parking task branch on terminal escalation: ${e}`,
            );
          }
        }

        // 2. Mark task blocked in the tasks table with the failure reason
        if (activeTaskId) {
          try {
            const t = getTask(activeTaskId);
            if (t) {
              saveTask({
                ...t,
                status: "blocked",
                blockedReason: `Failed gate: ${failureGate}. Feedback: ${failureReason}`,
                updatedAt: Date.now(),
              });
              writeLog(`[GateLoop] Task ${activeTaskId} marked as BLOCKED.`);
            }
          } catch (err) {
            writeLog(`[GateLoop] Error marking task as blocked: ${err}`);
          }
        }

        // 3. Pull next pending task from queue
        let nextTask: TaskRecord | undefined;
        try {
          const decomposition = await decomposeSpecIntoTasks(runCwd);
          if (decomposition) {
            nextTask = decomposition.tasks.find((t) => t.status === "pending");
          }
        } catch (err) {
          writeLog(`[GateLoop] Error pulling next pending task: ${err}`);
        }

        // 4. Continue loop
        if (nextTask) {
          try {
            saveTask({
              ...nextTask,
              status: "running",
              updatedAt: Date.now(),
            });
            activeTaskId = nextTask.taskId;
            writeLog(
              `[GateLoop] Selected next pending task to run: ${activeTaskId}`,
            );

            // Checkout or resume branch for the new active task
            const taskRecord = getTask(activeTaskId);
            if (taskRecord && taskRecord.branchName) {
              writeLog(
                `[GateLoop] Task ${activeTaskId} has existing branch ${taskRecord.branchName}. Resuming branch.`,
              );
              await getGitSandbox().resumeTaskBranch(activeTaskId);
            } else {
              writeLog(
                `[GateLoop] Task ${activeTaskId} has no existing branch. Creating new branch.`,
              );
              await getGitSandbox().checkoutTaskBranch(
                activeTaskId,
                taskRecord?.pbiId ?? undefined,
              );
            }
          } catch (err) {
            writeLog(
              `[GateLoop] Error marking next task as running or checking out its branch: ${err}`,
            );
            return false;
          }

          // Reset loop variables and state
          loopCycleCounter = 0;
          currentModelIndex = 0;
          retryCount = 0;
          totalRetries = 0;
          retryHistory.length = 0;
          lastFailedGate = "";
          consecutiveFailures = 0;
          failedGateName = "";
          failedGateFeedback = "";
          allGatesPassed = true;

          promptStr = `${nextTask.title}\n\n${nextTask.description || ""}`;
          currentPrompt = promptStr;

          updateStateSnapshot(sessionId, {
            isRunning: true,
            awaitingHuman: false,
            hasFailureState: false,
            currentTier: uniqueModelTiers[0],
            retryCount: 0,
            activeGate: undefined,
          });

          if (sessionId && activeSessions.has(sessionId)) {
            const sRec = activeSessions.get(sessionId)!;
            const newTurnId = `turn-${Date.now()}`;
            activeSessions.set(sessionId, {
              ...sRec,
              taskId: activeTaskId,
              turns: [
                ...(sRec.turns || []),
                {
                  id: newTurnId,
                  taskLabel: nextTask.title,
                  status: "running",
                  events: [],
                },
              ],
            });
          }
          return true;
        } else {
          writeLog(`[GateLoop] No more pending tasks in queue.`);
          return false;
        }
      };

      const MAX_SESSION_TOKEN_BUDGET = 500000;
      let loopCycleCounter = 0;
      const MAX_RETRY_CYCLES = 10;
      let lastFailedGate = "";
      let consecutiveFailures = 0;
      let failedGateName = "";
      let failedGateFeedback = "";
      let allGatesPassed = true;

      if (isResume && sessRecord && sessRecord.stateSnapshot) {
        const snap = sessRecord.stateSnapshot;
        currentModelIndex = snap.currentModelIndex || 0;
        retryCount = 0; // reset for the human attempt
        totalRetries = snap.totalRetries || Math.max(0, snap.retryCount || 0);
        if (Array.isArray(snap.retryHistory)) {
          retryHistory.push(...snap.retryHistory);
        }
        failedGateName = snap.failedGateName || "";
        failedGateFeedback = snap.failedGateFeedback || "";
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
            writeLog(
              `[GateLoop] Iteration ceiling reached (${MAX_RETRY_CYCLES}). Bypassing further auto-healing logic and forcing human intervention.`,
              LogLevel.WARN,
            );
            const escalateEvent = {
              type: "loop.ceiling_breached",
              data: {
                summary: `Loop iteration ceiling of ${MAX_RETRY_CYCLES} reached. Bypassing further auto-healing logic and forcing human intervention.`,
                failedGate: failedGateName || "unknown",
                retryHistory: retryHistory,
              },
            };
            if (sessionId && activeSessions.has(sessionId)) {
              const currentRec = activeSessions.get(sessionId)!;
              const nextState = {
                ...currentRec.stateSnapshot,
                awaitingHuman: true,
                isRunning: false,
              };
              activeSessions.set(sessionId, {
                ...currentRec,
                stateSnapshot: nextState,
              });
              appendEscalation({
                sessionId,
                summary: `Loop iteration ceiling of ${MAX_RETRY_CYCLES} reached. Bypassing further auto-healing logic and forcing human intervention.`,
                failedGate: failedGateName || "unknown",
                failedGateFeedback:
                  failedGateFeedback || "Loop iteration ceiling reached.",
                retryHistory: retryHistory || [],
                stateSnapshot: nextState,
                conversationHistory: currentRec.conversationHistory,
                turns: currentRec.turns,
                cwd: currentRec.cwd,
                currentModel: currentRec.currentModel,
              });
            }
            await secureWrite(
              res,
              `data: ${JSON.stringify(escalateEvent)}\n\n`,
              isRequestClosed,
            );

            // For compatibility with UI/escalation expectations, we also emit loop.escalate_human event
            const humanEscalateEvent = {
              type: "loop.escalate_human",
              data: {
                summary: `Loop iteration ceiling of ${MAX_RETRY_CYCLES} reached. Bypassing further auto-healing logic and forcing human intervention.`,
                failedGate: failedGateName || "unknown",
                retryHistory: retryHistory,
              },
            };
            await secureWrite(
              res,
              `data: ${JSON.stringify(humanEscalateEvent)}\n\n`,
              isRequestClosed,
            );

            const moved = await moveToNextTask(
              failedGateFeedback || "Loop iteration ceiling reached.",
              failedGateName || "unknown",
            );
            if (moved) {
              continue;
            } else {
              writeLog(
                `[GateLoop] No more pending tasks. Saving failure state snapshot and ending loop on ceiling breach.`,
              );

              updateStateSnapshot(sessionId, {
                awaitingHuman: true,
                isRunning: false,
                hasFailureState: true,
                currentModelIndex,
                totalRetries,
                currentPrompt: promptStr, // Original prompt
                retryHistory,
                failedGateName,
                failedGateFeedback,
              });

              await cleanup();
              return; // Terminate request
            }
          }

          if (isRequestClosed) {
            try {
              if (session) {
                await session.disconnect();
                session = null;
              }
            } catch (e) {}
            break;
          }

          const loopExecutionConfig =
            registryInstance.getExecutionConfig(currentModel);

          const currentTierConfig = DEFAULT_ROLES_CONFIG.executorTiers.find(
            (t) => t.model === currentModel,
          ) ||
            (DEFAULT_ROLES_CONFIG.planner.model === currentModel
              ? DEFAULT_ROLES_CONFIG.planner
              : null) || {
              provider: "gemini",
              model: currentModel,
              tokenRatio: 4,
            };
          const divisor = currentTierConfig.tokenRatio || 4;
          const estimatedInputTokens = Math.ceil(
            currentPrompt.length / divisor,
          );

          // Token budget tracking and short-circuit - enforced across ALL tiers to protect financial metrics
          if (sessionId && activeSessions.has(sessionId)) {
            const currentRec = activeSessions.get(sessionId)!;
            activeSessions.set(sessionId, {
              ...currentRec,
              totalInputTokens:
                (currentRec.totalInputTokens || 0) + estimatedInputTokens,
            });
            const updatedRec = activeSessions.get(sessionId)!;
            if (updatedRec.totalInputTokens! > MAX_SESSION_TOKEN_BUDGET) {
              writeLog(
                `[GateLoop] Token budget exceeded! Budget: ${MAX_SESSION_TOKEN_BUDGET}, Projected: ${updatedRec.totalInputTokens}. Short-circuiting...`,
                LogLevel.WARN,
              );
              const escalateEvent = {
                type: "loop.escalate_human",
                data: {
                  summary: `Token budget exhausted. The execution has consumed too many resources. Projected cost exceeds the safety threshold of ${MAX_SESSION_TOKEN_BUDGET} tokens. Human intervention required.`,
                  failedGate: failedGateName || "budget_guard",
                  retryHistory: retryHistory,
                },
              };
              const nextState = {
                ...updatedRec.stateSnapshot,
                awaitingHuman: true,
                isRunning: false,
              };
              activeSessions.set(sessionId, {
                ...updatedRec,
                stateSnapshot: nextState,
              });
              appendEscalation({
                sessionId,
                summary: `Token budget exhausted. The execution has consumed too many resources. Projected cost exceeds the safety threshold of ${MAX_SESSION_TOKEN_BUDGET} tokens. Human intervention required.`,
                failedGate: failedGateName || "budget_guard",
                failedGateFeedback: "",
                retryHistory: retryHistory || [],
                stateSnapshot: nextState,
                conversationHistory: updatedRec.conversationHistory,
                turns: updatedRec.turns,
                cwd: updatedRec.cwd,
                currentModel: updatedRec.currentModel,
              });
              await secureWrite(
                res,
                `data: ${JSON.stringify(escalateEvent)}\n\n`,
                isRequestClosed,
              );
              break;
            }
          }

          const loopSessionOptions: CopilotCreateSessionOptions = {
            model: loopExecutionConfig.model,
            ...(loopExecutionConfig.provider
              ? { provider: loopExecutionConfig.provider as SdkProviderConfig }
              : {}),
            tools: [
              {
                name: RUN_TERMINAL_DOCKER_TOOL.function.name,
                description: RUN_TERMINAL_DOCKER_TOOL.function.description,
                parameters: RUN_TERMINAL_DOCKER_TOOL.function
                  .parameters as Record<string, unknown>,
                handler: makeDockerToolHandler(
                  secureWrite,
                  res,
                  abortController.signal,
                  writeLog,
                  sensitiveValuesCache || new Set<string>(),
                  sessionId || undefined,
                ),
              },
              {
                name: "run_tests",
                description:
                  "Run project tests (Integration compatibility alias)",
                parameters: {
                  type: "object",
                  properties: {
                    target: { type: "string" },
                    flags: { type: "array", items: { type: "string" } },
                  },
                },
                handler: async (args: unknown) => {
                  const res = await runTests(runCwd);
                  return { status: "success", output: res.output };
                },
              },
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
              loopSessionOptions,
            );
            session = record.copilotSession;
            reused = true;
            writeLog(
              `[GateLoop] Retr/obtained session ${sessionId} for model ${currentModel}`,
            );
          }

          // Clean up last iteration's session if NOT reused and NOT first turn
          if (!reused && session) {
            try {
              await session.disconnect();
            } catch (e) {
              writeLog(
                `[GateLoop] Error disconnecting last loop session: ${e}`,
                LogLevel.WARN,
              );
            }
            session = null;
          }

          // Create fresh session if none found/reused (e.g., if sessionId is not provided)
          if (!session) {
            writeLog(
              `[GateLoop] Creating fresh session for model ${currentModel}`,
            );
            session = await client.createSession(
              loopSessionOptions as SessionConfig,
            );

            // Store new session in activeSessions for future reuse
            if (sessionId) {
              if (activeSessions.has(sessionId)) {
                try {
                  await activeSessions
                    .get(sessionId)!
                    .copilotSession?.disconnect();
                } catch (e) {}
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
                stateSnapshot: (req as RehydratedRequest)
                  ._rehydratedStateSnapshot || {
                  isRunning: true,
                  retryCount: retryCount,
                  currentTier: currentModel,
                  activeGate: undefined,
                  hasFailureState: consecutiveFailures > 0,
                  awaitingHuman: false,
                },
                conversationHistory:
                  (req as RehydratedRequest)._rehydratedHistory || [],
                turns: (req as RehydratedRequest)._rehydratedTurns || [],
                diagnosticTrail: [],
              });
              writeLog(
                `[GateLoop] Cached new session ${sessionId} for future reuse.`,
              );
            }
          }

          writeLog(
            `[GateLoop] Starting iteration with model: ${currentModel}, retryCount: ${retryCount}/${maxRetries}`,
            LogLevel.DEBUG,
          );
          updateStateSnapshot(sessionId, {
            isRunning: true,
            currentTier: currentModel,
            retryCount,
            activeGate: undefined,
            awaitingHuman: false,
          });

          // Setup streaming event listener for current session
          assistantMessage = "";
          try {
            if (isDiagnostic) {
              // Emit mock text chunk and idle event to satisfy client UI/Timeline
              let content = "";
              if (payload.replayTraceId) {
                const currentSubtaskId =
                  loopCycleCounter === 1 ? "classify_intent" : "run_tests";
                const currentRole =
                  loopCycleCounter === 1 ? "planner" : "executor";
                // INTERCEPTOR (Task 1.2): fetch stubbed response or throw hard alignment exception
                content = fetchStubbedTraceResponse(
                  payload.replayTraceId,
                  currentSubtaskId,
                  currentRole,
                  0,
                );

                // Stream high-fidelity pipeline structure events
                const turnStartEvent = {
                  type: "turn.start",
                  turnIndex: 0,
                  label: "Replay Generation Run",
                };
                await secureWrite(
                  res,
                  `data: ${JSON.stringify(turnStartEvent)}\n\n`,
                  isRequestClosed,
                );

                const subtaskStartEvent = {
                  type: "subtask.start",
                  turnIndex: 0,
                  subtaskId: currentSubtaskId,
                  label:
                    currentSubtaskId === "classify_intent"
                      ? "Classify Intent"
                      : "Run Tests",
                };
                await secureWrite(
                  res,
                  `data: ${JSON.stringify(subtaskStartEvent)}\n\n`,
                  isRequestClosed,
                );

                const msgEvent = {
                  type: "assistant.message",
                  data: { content },
                };
                await secureWrite(
                  res,
                  `data: ${JSON.stringify(msgEvent)}\n\n`,
                  isRequestClosed,
                );
                await new Promise((r) => setTimeout(r, 200));

                const subtaskCompleteEvent = {
                  type: "subtask.complete",
                  turnIndex: 0,
                  subtaskId: currentSubtaskId,
                  success: true,
                };
                await secureWrite(
                  res,
                  `data: ${JSON.stringify(subtaskCompleteEvent)}\n\n`,
                  isRequestClosed,
                );
              } else {
                content = scenario!.executorResponse;
              }

              // Push assistant message to history
              if (sessionId && activeSessions.has(sessionId)) {
                const sRec = activeSessions.get(sessionId)!;
                activeSessions.set(sessionId, {
                  ...sRec,
                  conversationHistory: [
                    ...(sRec.conversationHistory || []),
                    { role: "assistant", content },
                  ],
                });
              }

              if (!payload.replayTraceId) {
                const msgEvent = {
                  type: "assistant.message",
                  data: { content },
                };
                await secureWrite(
                  res,
                  `data: ${JSON.stringify(msgEvent)}\n\n`,
                  isRequestClosed,
                );
                await new Promise((r) => setTimeout(r, 400)); // Simulate thinking/streaming time
              }

              const idleEvent = { type: "session.idle", data: {} };
              await secureWrite(
                res,
                `data: ${JSON.stringify(idleEvent)}\n\n`,
                isRequestClosed,
              );
              writeLog(`[GateLoop][Diagnostic] Emitted response: ${content}`);
            } else {
              if (!session) {
                throw new Error("Failed to create or rehydrate session.");
              }
              const activeSession: CopilotSession = session;

              let eventChain = Promise.resolve();
              const pDone = new Promise<void>((resolve, reject) => {
                const onAbort = () => {
                  if (unsubscribe) {
                    unsubscribe();
                    unsubscribe = null;
                  }
                  reject(new Error("Operation aborted by client or timeout"));
                };
                abortController.signal.addEventListener("abort", onAbort);

                unsubscribe = activeSession.on((event: SessionEvent) => {
                  eventChain = eventChain.then(async () => {
                    const extEvent = event as ExtendedSessionEvent;
                    if (sessionId && activeSessions.has(sessionId)) {
                      const sRec = activeSessions.get(sessionId)!;
                      activeSessions.set(sessionId, {
                        ...sRec,
                        unsubscribe: unsubscribe || undefined,
                      });
                    }
                    try {
                      if (
                        res.writableEnded ||
                        res.destroyed ||
                        isRequestClosed ||
                        abortController.signal.aborted
                      ) {
                        if (unsubscribe) {
                          unsubscribe();
                          unsubscribe = null;
                        }
                        abortController.signal.removeEventListener(
                          "abort",
                          onAbort,
                        );
                        reject(
                          new Error(
                            "SSE stream connection terminated or closed",
                          ),
                        );
                        return;
                      }

                      if (extEvent.type === "tool.user_requested") {
                        toolWasCalledInThisTurn = true;
                      }

                      if (
                        extEvent.type === "tool.result" &&
                        sessionId &&
                        activeSessions.has(sessionId)
                      ) {
                        const sRec = activeSessions.get(sessionId)!;
                        const toolName = extEvent.data.toolName || "unknown";
                        const output =
                          extEvent.data.stdout || extEvent.data.stderr || "";
                        activeSessions.set(sessionId, {
                          ...sRec,
                          conversationHistory: [
                            ...(sRec.conversationHistory || []),
                            {
                              role: "user",
                              content: `[System (Tool Result): ${toolName}]\n${output}`,
                            },
                          ],
                        });
                      }

                      // Aggregate assistant message content
                      if (extEvent.type === "assistant.message") {
                        assistantMessage += extEvent.data.content || "";
                      } else if (extEvent.type === "assistant.message_delta") {
                        assistantMessage += extEvent.data.deltaContent || "";
                      }

                      // Step 2: Emit all SDK events to client
                      await secureWrite(
                        res,
                        `data: ${JSON.stringify(extEvent)}\n\n`,
                        isRequestClosed,
                      );

                      if (
                        extEvent.type === "session.idle" ||
                        extEvent.type === "session.shutdown"
                      ) {
                        if (unsubscribe) {
                          unsubscribe();
                          unsubscribe = null;
                        }
                        abortController.signal.removeEventListener(
                          "abort",
                          onAbort,
                        );
                        resolve();
                      } else if (extEvent.type === "session.error") {
                        if (unsubscribe) {
                          unsubscribe();
                          unsubscribe = null;
                        }
                        abortController.signal.removeEventListener(
                          "abort",
                          onAbort,
                        );
                        reject(new Error(extEvent.data.message));
                      }
                    } catch (err: unknown) {
                      writeLog(
                        `[GateLoop] Error forwarding event: ${err instanceof Error ? err.message : String(err)}`,
                        LogLevel.WARN,
                      );
                      abortController.signal.removeEventListener(
                        "abort",
                        onAbort,
                      );
                      reject(err);
                    }
                  });
                });
              });

              writeLog(
                `[GateLoop] Session started. Sending prompt: "${currentPrompt.substring(0, 60)}..."`,
                LogLevel.DEBUG,
              );

              // Push user message to history ONLY on first iteration
              if (
                loopCycleCounter === 1 &&
                sessionId &&
                activeSessions.has(sessionId)
              ) {
                const sRec = activeSessions.get(sessionId)!;
                activeSessions.set(sessionId, {
                  ...sRec,
                  conversationHistory: [
                    ...(sRec.conversationHistory || []),
                    { role: "user", content: promptStr },
                  ],
                });
              }

              writeLog(
                `[SESSION] sendAndWait called with prompt length=${currentPrompt.length}`,
                LogLevel.DEBUG,
              );
              await Promise.race([
                session.sendAndWait({ prompt: currentPrompt }, 600000),
                abortPromise,
              ]);
              writeLog(`[SESSION] sendAndWait finished.`, LogLevel.DEBUG);
              // Wait for session.idle / turn completion
              writeLog(`[SESSION] Awaiting pDone resolution`);
              try {
                await Promise.race([pDone, abortPromise]);
                writeLog(`[SESSION] pDone resolved successfully`);
              } catch (pErr: unknown) {
                writeLog(
                  `[GateLoop] Stream delivery broken or aborted during execution: ${pErr instanceof Error ? pErr.message : String(pErr)}. Aborting loop.`,
                  LogLevel.WARN,
                );
                break;
              }

              if (sessionId && activeSessions.has(sessionId)) {
                const currentRec = activeSessions.get(sessionId)!;
                const currentTierConfig =
                  DEFAULT_ROLES_CONFIG.executorTiers.find(
                    (t) => t.model === currentModel,
                  ) ||
                    (DEFAULT_ROLES_CONFIG.planner.model === currentModel
                      ? DEFAULT_ROLES_CONFIG.planner
                      : null) || {
                      provider: "gemini",
                      model: currentModel,
                      tokenRatio: 4,
                    };
                const divisor = currentTierConfig.tokenRatio || 4;
                activeSessions.set(sessionId, {
                  ...currentRec,
                  totalOutputTokens:
                    (currentRec.totalOutputTokens || 0) +
                    Math.ceil(assistantMessage.length / divisor),
                });
              }

              // Push assistant message to history if not diagnostic (diagnostic path does it separately)
              if (!isDiagnostic && sessionId && activeSessions.has(sessionId)) {
                const sRec = activeSessions.get(sessionId)!;
                activeSessions.set(sessionId, {
                  ...sRec,
                  conversationHistory: [
                    ...(sRec.conversationHistory || []),
                    { role: "assistant", content: assistantMessage },
                  ],
                });
              }

              // SYS-REQ-004: Enforce structured tool calls for mutation tasks.
              // Only attempt a narrowed forced-tool retry if NO tool was called at all on the
              // first turn (toolWasCalledInThisTurn is set generically by the tool.user_requested
              // listener above, for any tool -- not just run_terminal_docker). This avoids
              // clobbering a turn that legitimately called a different tool (e.g. runLint).
              if (
                !isDiagnostic &&
                (classifiedType === "feature" ||
                  classifiedType === "refactor") &&
                !toolWasCalledInThisTurn
              ) {
                writeLog(
                  `[GateLoop] SYS-REQ-004: No tool call detected on first turn. Attempting one narrowed retry before failing MutationGate.`,
                  LogLevel.WARN,
                );
                try {
                  const retryResult = (await Promise.race([
                    runForcedToolTurn(
                      session,
                      loopExecutionConfig,
                      (loopSessionOptions.tools
                        ?.map(
                          (t) =>
                            t.name ||
                            (t as { function?: { name?: string } }).function
                              ?.name,
                        )
                        .filter(Boolean) as string[]) || [],
                      currentPrompt,
                      {
                        client,
                        abortSignal: abortController.signal,
                        timeoutMs: 600000,
                        maxRetries: 1,
                        getResult: () => undefined,
                        tools: loopSessionOptions.tools,
                      },
                    ),
                    abortPromise,
                  ])) as
                    | {
                        result: unknown;
                        session: CopilotSession;
                        lastAssistantText: string;
                        toolCalled: boolean;
                      }
                    | undefined;

                  if (retryResult) {
                    if (retryResult.session) {
                      session = retryResult.session;
                      // `runForcedToolTurn` may have resumed into a brand-new
                      // CopilotSession object (client.resumeSession() returns a
                      // different handle than the one passed in). The next loop
                      // iteration's getOrCreateSession() reads the cached
                      // copilotSession for this sessionId, so if we don't
                      // repoint the cache here, the next turn silently goes to
                      // the stale pre-retry session and loses this retry's tool
                      // call + result -- the exact context-loss bug this fixes.
                      if (sessionId && activeSessions.has(sessionId)) {
                        const sRecAfterRetry = activeSessions.get(sessionId)!;
                        activeSessions.set(sessionId, {
                          ...sRecAfterRetry,
                          copilotSession: retryResult.session,
                        });
                      }
                    }
                    if (retryResult.toolCalled) {
                      toolWasCalledInThisTurn = true;
                    }
                    assistantMessage = retryResult.lastAssistantText; // update assistant message so it doesn't just fail downstream logic
                    if (sessionId && activeSessions.has(sessionId)) {
                      const sRecForHistory = activeSessions.get(sessionId)!;
                      activeSessions.set(sessionId, {
                        ...sRecForHistory,
                        conversationHistory: [
                          ...(sRecForHistory.conversationHistory || []),
                          { role: "assistant", content: assistantMessage },
                        ],
                      });
                    }
                  }
                } catch (retryErr: unknown) {
                  writeLog(
                    `[GateLoop] Narrowed forced-tool retry threw: ${retryErr instanceof Error ? retryErr.message : String(retryErr)}`,
                    LogLevel.WARN,
                  );
                }
              }

              if (
                !isDiagnostic &&
                (classifiedType === "feature" ||
                  classifiedType === "refactor") &&
                !toolWasCalledInThisTurn
              ) {
                writeLog(
                  `[GateLoop] SYS-REQ-004: Mutation task without tool call detected. Failing current turn.`,
                  LogLevel.WARN,
                );
                allGatesPassedInThisCycle = false;
                failedGateName = "MutationGate";
                failedGateFeedback = truncateOutput(
                  "The executor failed to emit any structured tool calls to modify files. Plain text explanations are blocked for mutation tasks.",
                );

                // Emit explicit gate events for MutationGate to satisfy protocol consistency and test assertions
                const mgStartEvent = {
                  type: "gate.start",
                  data: { gateName: "MutationGate", retryCount },
                };
                await secureWrite(
                  res,
                  `data: ${JSON.stringify(mgStartEvent)}\n\n`,
                  isRequestClosed,
                );

                const mgResultEvent = {
                  type: "gate.result",
                  data: {
                    gateName: "MutationGate",
                    pass: false,
                    feedback: failedGateFeedback,
                    durationMs: 0,
                    retryCount,
                  },
                };
                await secureWrite(
                  res,
                  `data: ${JSON.stringify(mgResultEvent)}\n\n`,
                  isRequestClosed,
                );
              }
            }
          } finally {
            const toUnsubscribe: unknown = unsubscribe;
            if (typeof toUnsubscribe === "function") {
              try {
                toUnsubscribe();
              } catch (e) {}
              unsubscribe = null;
            }
          }

          await new Promise<void>((resolve) => setTimeout(resolve, 500));

          if (isRequestClosed) {
            try {
              if (session) {
                await session.disconnect();
                session = null;
              }
            } catch (e) {}
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
                type: "gate.start",
                data: {
                  gateName,
                  retryCount,
                },
              };
              await secureWrite(
                res,
                `data: ${JSON.stringify(startGateEvent)}\n\n`,
                isRequestClosed,
              );

              writeLog(`[GateLoop] Running gate: ${gateName}`, LogLevel.INFO);
              gatesRunCount++;

              let gateResult;
              try {
                if (isDiagnostic) {
                  await new Promise((r) => setTimeout(r, 600)); // Simulate tool run time

                  if (
                    diagnosticScenario === "gate_crash" &&
                    gatesRunCount === 1
                  ) {
                    throw new Error("DIAGNOSTIC_SIMULATED_CRASH");
                  }

                  // Use the sequence. If we run out of sequence values, default to pass if it's not the 'human_escalation' scenario
                  const seq = scenario ? scenario.gateSequence : [];
                  const pass =
                    gatesRunCount - 1 < seq.length
                      ? seq[gatesRunCount - 1]
                      : true;

                  gateResult = {
                    gateName,
                    pass,
                    feedback: pass
                      ? `[Diagnostic] ${gateName} passed correctly.`
                      : `[Diagnostic] ${gateName} failed as requested.`,
                    durationMs: 600,
                  };
                } else if (gateName === "runAudit") {
                  const startAuditTime = Date.now();
                  const currentCodeState = await getCodeState(runCwd);
                  const auditPayload = await runLlmAudit(
                    promptStr,
                    currentCodeState,
                    keyToUse,
                    abortController.signal,
                  );
                  const loopPassed = auditPayload.pass;

                  let feedbackStr = "";
                  if (loopPassed) {
                    feedbackStr = "Audit passed.";
                  } else if (
                    auditPayload.findings &&
                    Array.isArray(auditPayload.findings)
                  ) {
                    feedbackStr = auditPayload.findings
                      .map(
                        (f: AuditFinding) =>
                          `[${f.severity.toUpperCase()}] ${f.file || "General"}: ${f.description}`,
                      )
                      .join("\n");
                  } else {
                    feedbackStr = "Audit failed on quality checks.";
                  }

                  gateResult = {
                    gateName: "runAudit",
                    pass: loopPassed,
                    feedback: feedbackStr,
                    durationMs: Date.now() - startAuditTime,
                  };
                } else {
                  gateResult = await runGate(
                    gateName,
                    runCwd,
                    abortController.signal,
                  );
                }

                // Update audit trail
                if (sessionId && activeSessions.has(sessionId)) {
                  const sRec = activeSessions.get(sessionId)!;
                  const newSequenceCounter =
                    (sRec.eventSequenceCounter || 0) + 1;
                  activeSessions.set(sessionId, {
                    ...sRec,
                    eventSequenceCounter: newSequenceCounter,
                  });
                  const updatedSRec = activeSessions.get(sessionId)!;
                  const eventObj = {
                    timestamp: new Date().toISOString(),
                    action: gateName,
                    rationale: gateResult.feedback,
                    tier: uniqueModelTiers[currentModelIndex],
                    sequenceId: newSequenceCounter,
                    data: {
                      sequenceId: newSequenceCounter,
                    },
                  };
                  const updatedTurns = updatedSRec.turns
                    ? [...updatedSRec.turns]
                    : [];
                  // SYS-REQ-004: Restructured recovery mechanism. Check if ANY standard turn exists before fallbacks.
                  if (updatedTurns.length === 0) {
                    updatedTurns.push({
                      id: `turn-fallback-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`,
                      taskLabel: "System Recovery / Unknown Turn",
                      status: "running",
                      events: [],
                    });
                  }
                  // This event Obj is slightly differently formed but append it to events array
                  const turnIndex = updatedTurns.length - 1;
                  const turnToUse = updatedTurns[turnIndex];
                  if (turnToUse) {
                    const newEvent: CopilotEventData = {
                      id: `evt-audit-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`,
                      timestamp: eventObj.timestamp,
                      type: "gate.legacyAudit",
                      data: eventObj,
                    };
                    const finalTurns = updatedTurns.map((turn, index) =>
                      index === turnIndex
                        ? { ...turn, events: [...turn.events, newEvent] }
                        : turn,
                    );
                    activeSessions.set(sessionId, {
                      ...updatedSRec,
                      turns: finalTurns,
                    });
                  } else {
                    activeSessions.set(sessionId, {
                      ...updatedSRec,
                      turns: updatedTurns,
                    });
                  }
                }
              } catch (gateErr: unknown) {
                const gateErrMsg =
                  gateErr instanceof Error ? gateErr.message : String(gateErr);
                gateResult = {
                  pass: false,
                  feedback: `Gate check crashed: ${gateErrMsg}`,
                  durationMs: 0,
                };
              }

              // Step 5: Emit a `gate.result` event
              writeLog(
                `[LOOP] Gate ${gateName} result: pass=${gateResult.pass} durationMs=${gateResult.durationMs}`,
                gateResult.pass ? LogLevel.INFO : LogLevel.WARN,
              );
              updateStateSnapshot(sessionId, {
                activeGate: undefined,
                hasFailureState: !gateResult.pass,
              });
              const gateEvent = {
                type: "gate.result",
                data: {
                  gateName,
                  pass: gateResult.pass,
                  feedback: gateResult.feedback,
                  durationMs: gateResult.durationMs,
                  retryCount,
                },
              };
              await secureWrite(
                res,
                `data: ${JSON.stringify(gateEvent)}\n\n`,
                isRequestClosed,
              );

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
                  writeLog(
                    `[GateLoop] Persistent bottleneck detected on gate ${failedGateName} (${consecutiveFailures} failures). Injecting auto-heal steps.`,
                    LogLevel.WARN,
                  );
                  if (!activeStepGates.includes("runLint")) {
                    activeStepGates.unshift("runLint");
                    writeLog(
                      `[GateLoop] Injected runLint at the start of pipeline to auto-heal syntax structures.`,
                    );
                  }
                  const alternativeGates = [...activeStepGates];
                  const mutatedEvent = {
                    type: "composer.plan_mutated",
                    data: {
                      cycle: 5,
                      newGates: alternativeGates,
                      gates: alternativeGates,
                    },
                  };
                  await secureWrite(
                    res,
                    `data: ${JSON.stringify(mutatedEvent)}\n\n`,
                    isRequestClosed,
                  );
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
                  writeLog(
                    `[GateLoop] Skipping Spec-Gate Auditor: Diff is identical to last passing state (SHA: ${currentSha})`,
                  );
                }
              } catch (e) {}
            }

            if (skipSpecAudit) {
              const skipEvent = {
                type: "gate.result",
                data: {
                  gateName: "runSpecAudit",
                  pass: true,
                  feedback:
                    "Spec audit skipped: codebase state unchanged since last validation.",
                  durationMs: 0,
                  retryCount,
                },
              };
              await secureWrite(
                res,
                `data: ${JSON.stringify(skipEvent)}\n\n`,
                isRequestClosed,
              );
            } else {
              writeLog(
                `[GateLoop] Executing Spec-Gate Auditor against isolation sandbox...`,
              );
              updateStateSnapshot(sessionId, { activeGate: "runSpecAudit" });
              const startSpecEvent = {
                type: "gate.start",
                data: { gateName: "runSpecAudit" },
              };
              await secureWrite(
                res,
                `data: ${JSON.stringify(startSpecEvent)}\n\n`,
                isRequestClosed,
              );

              const specResult = await runSpecAudit(
                runCwd,
                abortController.signal,
              );
              updateStateSnapshot(sessionId, {
                activeGate: undefined,
                hasFailureState: !specResult.pass,
              });

              if (
                specResult.pass &&
                sessionId &&
                activeSessions.has(sessionId)
              ) {
                const sessionRec = activeSessions.get(sessionId)!;
                try {
                  const currentSha = await getGitSandbox().getHeadShaAsync();
                  activeSessions.set(sessionId, {
                    ...sessionRec,
                    lastPassedSpecAuditSha: currentSha,
                  });
                } catch (e) {}
              }

              const specGateEv = {
                type: "gate.result",
                data: {
                  gateName: "runSpecAudit",
                  pass: specResult.pass,
                  feedback: truncateOutput(specResult.feedback),
                  durationMs: Date.now() - specStart,
                  retryCount,
                },
              };
              await secureWrite(
                res,
                `data: ${JSON.stringify(specGateEv)}\n\n`,
                isRequestClosed,
              );

              if (!specResult.pass) {
                allGatesPassedInThisCycle = false;
                failedGateName = "runSpecAudit";
                failedGateFeedback = truncateOutput(specResult.feedback);
              }
            }
          }

          // Final success check for current cycle
          allGatesPassed = allGatesPassedInThisCycle;

          if (allGatesPassed) {
            consecutiveFailures = 0;
            lastFailedGate = "";
            updateStateSnapshot(sessionId, {
              isRunning: false,
              hasFailureState: false,
            });
            // Step 6: All gates pass → emit `loop.complete`, end
            writeLog(
              `[GateLoop] All gates passed successfully!`,
              LogLevel.INFO,
            );

            // Mark active task as done
            if (sessionId && activeSessions.has(sessionId)) {
              const currentSession = activeSessions.get(sessionId)!;
              if (currentSession.taskId) {
                try {
                  const t = getTask(currentSession.taskId);
                  if (t) {
                    saveTask({
                      ...t,
                      status: "done",
                      updatedAt: Date.now(),
                    });
                    writeLog(
                      `[GateLoop] Task ${currentSession.taskId} marked as DONE.`,
                    );
                  }
                } catch (err) {
                  writeLog(`[GateLoop] Error marking task as done: ${err}`);
                }
              }
            }

            const util = await import("util");
            let commitSha = "";
            const taskLabel =
              promptStr.length > 50
                ? promptStr.slice(0, 47) + "..."
                : promptStr;

            try {
              commitSha = await getGitSandbox().commitAllChangesAsync(
                `Turn Completed: ${taskLabel}`,
              );
            } catch (e: unknown) {
              // suppress git error output
            }

            // RM-REQ-014/015: fast-forward the completed task branch into
            // pbi/<pbiId> when this task belongs to a PBI. Trunk is never
            // touched here (RM-REQ-017) — that happens only via human PR
            // review once the PBI's compliance audit is clean.
            if (sessionId && activeSessions.has(sessionId)) {
              const currentSession = activeSessions.get(sessionId)!;
              const doneTaskId = currentSession.taskId;
              const doneTask = doneTaskId ? getTask(doneTaskId) : undefined;
              if (doneTask && doneTask.pbiId) {
                try {
                  await getGitSandbox().mergeTaskIntoPbi(
                    doneTask.taskId,
                    doneTask.pbiId,
                  );
                  writeLog(
                    `[GateLoop] Fast-forward merged task/${doneTask.taskId} into pbi/${doneTask.pbiId}.`,
                  );
                } catch (mergeErr) {
                  // RM-REQ-015: no auto three-way merge — fail loudly and
                  // escalate for human/manual resolution instead.
                  writeLog(
                    `[GateLoop] Fast-forward merge of task/${doneTask.taskId} into pbi/${doneTask.pbiId} failed: ${mergeErr}`,
                    LogLevel.ERROR,
                  );
                  // Revert the done marking: RM-REQ-014 ties "done" to a
                  // successfully merged task. Leaving it "done" here would
                  // let RM-REQ-011 (all-tasks-done → compliance audit) and
                  // RM-REQ-017 (PR-ready marking) treat the PBI as complete
                  // when its work never actually landed on pbi/<pbiId>.
                  try {
                    const staleTask = getTask(doneTask.taskId);
                    if (staleTask) {
                      saveTask({
                        ...staleTask,
                        status: "blocked",
                        blockedReason: `pbi-ff-merge failed: ${String(mergeErr)}`,
                        updatedAt: Date.now(),
                      });
                    }
                  } catch (revertErr) {
                    writeLog(
                      `[GateLoop] Failed to revert task status after merge failure: ${revertErr}`,
                      LogLevel.ERROR,
                    );
                  }
                  try {
                    appendEscalation({
                      sessionId,
                      summary:
                        `Task ${doneTask.taskId} completed but could not be ` +
                        `fast-forward merged into pbi/${doneTask.pbiId}. The task ` +
                        `branch has diverged from the PBI integration branch. ` +
                        `Manual resolution required: rebase task/${doneTask.taskId} ` +
                        `onto the current pbi/${doneTask.pbiId} tip, or restart the ` +
                        `task fresh off the current PBI tip. Task status reverted to ` +
                        `'blocked' pending resolution.`,
                      failedGate: "pbi-ff-merge",
                      failedGateFeedback: String(mergeErr),
                      retryHistory: [],
                    });
                  } catch (escalateErr) {
                    writeLog(
                      `[GateLoop] Failed to record merge-failure escalation: ${escalateErr}`,
                      LogLevel.ERROR,
                    );
                  }
                }
              }
            }

            if (sessionId && activeSessions.has(sessionId)) {
              const currentSession = activeSessions.get(sessionId)!;
              if (currentSession.turns && currentSession.turns.length > 0) {
                const currentTurn =
                  currentSession.turns[currentSession.turns.length - 1];
                if (currentTurn) {
                  const updatedTurns: ReadonlyArray<Turn> =
                    currentSession.turns.map((turn, index) =>
                      index === currentSession.turns.length - 1
                        ? ({ ...turn, status: "completed", commitSha } as Turn)
                        : turn,
                    );
                  activeSessions.set(sessionId, {
                    ...currentSession,
                    turns: updatedTurns,
                  });
                }
              }
            }

            const turnCompletedEvent = {
              type: "TURN_COMPLETED",
              data: {
                turnId: `turn-${Date.now()}`,
                taskLabel,
                commitSha,
              },
            };
            await secureWrite(
              res,
              `data: ${JSON.stringify(turnCompletedEvent)}\n\n`,
              isRequestClosed,
            );

            const completeEvent = {
              type: "loop.complete",
              data: {
                totalRetries,
                gatesRun: gatesRunCount,
                durationMs: Date.now() - loopStartTime,
              },
            };
            await secureWrite(
              res,
              `data: ${JSON.stringify(completeEvent)}\n\n`,
              isRequestClosed,
            );
            break;
          }

          // A gate failed. Record details in retry history only (avoiding prompt redundancy)
          retryHistory.push({
            retryCount,
            model: currentModel,
            failedGate: failedGateName,
            feedback: failedGateFeedback,
          });

          // Step 7: If any gate fails AND retryCount < maxRetries
          if (retryCount < maxRetries) {
            retryCount++;
            totalRetries++;
            const nextModel = currentModel; // stays on current tier
            writeLog(
              `[GateLoop] Gate failed. Retrying (attempt ${retryCount}/${maxRetries}) on same model.`,
            );

            const retryEvent = {
              type: "loop.retry",
              data: {
                retryCount,
                maxRetries,
                currentModel,
                nextModel,
                failedGate: failedGateName,
                feedback: failedGateFeedback,
              },
            };
            await secureWrite(res, `data: ${JSON.stringify(retryEvent)}\n\n`);

            // Narrow context: Original request + structured feedback on failing gate
            let history: ReadonlyArray<{
              readonly role: "user" | "assistant";
              readonly content: string;
            }> = [];
            if (sessionId && activeSessions.has(sessionId)) {
              const narrowedSession = activeSessions.get(sessionId)!;
              const pruned = pruneConversationHistory(
                narrowedSession.conversationHistory,
              );
              activeSessions.set(sessionId, {
                ...narrowedSession,
                conversationHistory: pruned,
              });
              history = pruned;
            } else {
              history = pruneConversationHistory([]);
            }
            currentPrompt = formatContextNarrowingPrompt(
              promptStr,
              failedGateName,
              failedGateFeedback,
              history,
            );
            continue; // runs step 1 again
          }

          // Step 8: retryCount === maxRetries
          const isFinalModel =
            currentModelIndex === uniqueModelTiers.length - 1;
          if (!isFinalModel) {
            // Escalate model tier, reset retryCount
            currentModelIndex++;
            retryCount = 0;
            totalRetries++;
            const nextModel = uniqueModelTiers[currentModelIndex];
            writeLog(
              `[GateLoop] Reached max retries. Escalating model tier from ${currentModel} to ${nextModel}.`,
            );

            const retryEvent = {
              type: "loop.retry",
              data: {
                retryCount,
                maxRetries,
                currentModel,
                nextModel,
                failedGate: failedGateName,
                feedback: failedGateFeedback,
              },
            };
            await secureWrite(res, `data: ${JSON.stringify(retryEvent)}\n\n`);

            // Model Escalation
            let history: ReadonlyArray<{
              readonly role: "user" | "assistant";
              readonly content: string;
            }> = [];
            if (sessionId && activeSessions.has(sessionId)) {
              const escalatedSession = activeSessions.get(sessionId)!;
              const pruned = pruneConversationHistory(
                escalatedSession.conversationHistory,
              );
              activeSessions.set(sessionId, {
                ...escalatedSession,
                conversationHistory: pruned,
              });
              history = pruned;
            } else {
              history = pruneConversationHistory([]);
            }
            currentPrompt = formatEscalationPrompt(
              promptStr,
              failedGateName,
              failedGateFeedback,
              history,
            );
            continue; // runs step 1 with escalated model
          }

          // Step 9: On final model tier and still failing → emit `loop.escalate_human` and transition to next task!
          writeLog(
            `[GateLoop] Failed on final model tier. Escalating to human for session ${sessionId} and moving to next task.`,
          );

          const escalateEvent = {
            type: "loop.escalate_human",
            data: {
              summary: `All validation gates failed. The '${failedGateName}' gate failed on premium model ${currentModel}.`,
              failedGate: failedGateName,
              retryHistory,
            },
          };
          await secureWrite(res, `data: ${JSON.stringify(escalateEvent)}\n\n`);

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

          if (!sessionId || isRequestClosed) {
            try {
              if (session) {
                await session.disconnect();
                session = null;
              }
            } catch (e) {}
            break;
          }

          const moved = await moveToNextTask(
            failedGateFeedback,
            failedGateName,
          );
          if (moved) {
            continue;
          } else {
            writeLog(
              `[GateLoop] No more pending tasks. Saving failure state snapshot and ending loop.`,
            );

            updateStateSnapshot(sessionId, {
              awaitingHuman: true,
              isRunning: false,
              hasFailureState: true,
              currentModelIndex,
              totalRetries,
              currentPrompt: promptStr, // Original prompt
              retryHistory,
              failedGateName,
              failedGateFeedback,
            });

            await cleanup();
            return; // Terminate request
          }
        }
      } catch (innerLoopErr: unknown) {
        allGatesPassed = false;
        writeLog(
          `[GateLoop] Critical inner loop failure: ${innerLoopErr instanceof Error ? innerLoopErr.stack || innerLoopErr.message : String(innerLoopErr)}`,
        );
      } finally {
        writeLog(`[GateLoop] Inner loop execution cycle terminated.`);
      }
    } catch (err: unknown) {
      if (heartbeatId) {
        clearInterval(heartbeatId);
        heartbeatId = null;
      }
      const errMsg = err instanceof Error ? err.message : String(err);
      writeLog(
        `[GateLoop] Exception in background loop: ${err instanceof Error ? err.stack : errMsg}`,
      );
      await cleanup();

      try {
        await SessionSseHub.broadcast(
          currentSessionId,
          `data: ${JSON.stringify({
            type: "loop.error",
            data: { message: errMsg || "Fatal pipeline escalation error" },
          })}\n\n`,
        );
        await SessionSseHub.broadcast(
          currentSessionId,
          `data: ${JSON.stringify({
            type: "session.error",
            data: {
              message: errMsg || "Error occurred during gate run execution.",
            },
          })}\n\n`,
        );
      } catch (_) {}
    } finally {
      activeBackgroundRuns.delete(currentSessionId);
      updateStateSnapshot(currentSessionId, {
        isRunning: false,
        activeGate: undefined,
      });
      writeLog(
        `[CleanupGuard] Background orchestration sequence finished or failed.`,
      );

      await cleanup();
      await SessionSseHub.endAll(currentSessionId);
    }
  })();

  activeBackgroundRuns.set(currentSessionId, {
    abortController: runAbortController,
    promise: runPromise,
  });

  if (!wantStream) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ success: true, sessionId: currentSessionId }));
  }
};

export const handleGateStream = async (
  req: express.Request,
  res: express.Response,
) => {
  const sessionId =
    (req.query.sessionId as string) ||
    (req.headers["x-copilot-session-id"] as string);

  if (!sessionId) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({ success: false, error: "Session ID is required." }),
    );
    return;
  }

  writeLog(`[GateStream] Establishing SSE stream for session ${sessionId}`);

  // Set headers for SSE
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write(":\n\n");

  // Register SSE mapping
  sseResToSessionId.set(res, sessionId);

  // Subscribe the response res to the active session's SSE Hub
  SessionSseHub.subscribe(sessionId, res);

  // Stream all buffered events that the client hasn't seen
  const buffered = SessionSseHub.getBuffer(sessionId);
  writeLog(
    `[GateStream] Streaming ${buffered.length} buffered events to client for session ${sessionId}.`,
  );
  for (const ev of buffered) {
    await secureWrite(res, `data: ${JSON.stringify(ev)}\n\n`);
  }

  res.on("close", () => {
    writeLog(`[GateStream] Client connection closed for session ${sessionId}`);
    SessionSseHub.unsubscribe(sessionId, res);
    sseResToSessionId.delete(res);
  });
};
