import express from 'express';
import path from 'path';
import fs from 'fs';
import { CopilotClient, SessionConfig, SdkProviderConfig, Tool, CopilotSession } from '../../agentCore/copilotSdk/boundary';
import { SessionWrapper, SessionWrapperToolsConfig, SessionWrapperBaseConfig } from '../../agentCore/copilotSdk/sessionWrapper';
import { MODEL_TIERS, ModelTier } from '../../config/models';
import { SessionRecord, StateSnapshot } from '../../types/session';
import { AuditResult } from '../../types/audit';
import { getWorkspaceHostLocation, getExecCommand, getWorkspaceRoot } from '../../agentCore/workspace';
import { checkPathInside } from '../security/pathGuard';
import { saveSession, deleteSession, getSession } from '../db/sessionStore';
import { getAuditorExecutionConfig, executeAuditSession } from '../../agentCore/auditorHelper';
import { ExecutionConfig } from '../../agentCore/providerRegistry';
import { submitAuditFindingsTool } from '../../config/tools';
import { enforceWorkingMemoryTruncation } from '../../agentCore/contextManager';

export interface CopilotCreateSessionOptions extends Omit<SessionConfig, 'provider'> {
  provider?: SdkProviderConfig;
  tools?: Tool<unknown>[];
  streaming?: boolean;
}

export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
}

const LOG_FILE = path.join('/tmp', 'debug_log.txt');
let CURRENT_LOG_LEVEL = process.env.LOG_LEVEL ? (LogLevel[process.env.LOG_LEVEL.toUpperCase() as keyof typeof LogLevel] ?? LogLevel.WARN) : LogLevel.WARN;
let FILE_LOG_LEVEL = LogLevel.DEBUG; // Always record everything to file for troubleshooting

export function setLogLevels(current: LogLevel, file: LogLevel = LogLevel.DEBUG) {
  CURRENT_LOG_LEVEL = current;
  FILE_LOG_LEVEL = file;
}
export const lastRunLog: string[] = [];

export const DEFAULT_WORKSPACE_DIR = getWorkspaceHostLocation();
if (!fs.existsSync(DEFAULT_WORKSPACE_DIR)) {
  fs.mkdirSync(DEFAULT_WORKSPACE_DIR, { recursive: true });
}

export class SessionMap extends Map<string, SessionRecord> {
  set(key: string, value: SessionRecord) {
    super.set(key, value);
    try {
      writeLog(`[SessionMap] Saving session ${key} to DB...`, LogLevel.DEBUG);
      // Synchronous SQLite run
      saveSession(value);
    } catch (e) {
      writeLog(`Failed to save session ${key} to SQLite: ${e}`, LogLevel.WARN);
    }
    return this;
  }

  delete(key: string) {
    const res = super.delete(key);
    try {
      writeLog(`[SessionMap] Deleting session ${key} from DB...`, LogLevel.DEBUG);
      deleteSession(key);
    } catch (e) {
      writeLog(`Failed to delete session ${key} from SQLite: ${e}`, LogLevel.WARN);
    }
    return res;
  }
}

export const activeSessions = new SessionMap();
export const sseResToSessionId = new Map<express.Response, string>();
export const sessionWritePromises = new Map<string, Promise<void>>();

/**
 * Shared active-orchestration-session gate for tools whose handler code we
 * own (`run_terminal_docker`, `run_tests`) -- moved from the permission
 * layer (`handleGateRunPermission` in gateLoop.ts) into the tool handlers
 * themselves as part of the #346 migration off `SessionWrapper.adopt()`.
 * `SessionWrapper`'s own `onPermissionRequest` only expresses static
 * name-based enablement (SYS-REQ-028d); it has no hook for this kind of
 * live-state check, so rather than extending SessionWrapper's permission
 * surface (a spec change), the check moves to where we already own the
 * code path and can simply decline to do the side-effecting work.
 *
 * `autoApproveAll` is passed in rather than imported directly, since the
 * source of truth (`globalAutoApproveAll` in gateLoop.ts) would otherwise
 * create a circular import (gateLoop.ts already imports the tool handlers
 * this function is used by). Preserves handleGateRunPermission's exact
 * prior scope: checks for ANY active, non-awaiting-human session across
 * `activeSessions`, not just the calling session -- not narrowed here.
 */
export function checkActiveOrchestrationSession(
  autoApproveAll: boolean,
  toolName: string
): { ok: true } | { ok: false; message: string } {
  if (autoApproveAll) {
    return { ok: true };
  }
  const hasActiveSession = Array.from(activeSessions.values()).some(
    s => s.stateSnapshot?.isRunning && !s.stateSnapshot?.awaitingHuman
  );
  if (hasActiveSession) {
    return { ok: true };
  }
  return {
    ok: false,
    message: `Execution of ${toolName} requires an active, authorized orchestration session context.`,
  };
}
export const activeLocks = new Map<string, AbortController>();

export function resetSessionForNewRun(sessionId: string) {
  if (sessionId && activeSessions.has(sessionId)) {
    const currentRec = activeSessions.get(sessionId)!;
    activeSessions.set(sessionId, {
      ...currentRec,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      conversationHistory: [],
      turns: [],
      diagnosticTrail: [],
      eventSequenceCounter: 0,
      stateSnapshot: {
        ...currentRec.stateSnapshot,
        hasFailureState: false,
        retryCount: 0
      }
    });
  }
}

export function updateStateSnapshot(sessionId: string | null | undefined, updates: Partial<StateSnapshot>) {
  if (sessionId && activeSessions.has(sessionId)) {
    const session = activeSessions.get(sessionId)!;
    activeSessions.set(sessionId, {
      ...session,
      stateSnapshot: { ...session.stateSnapshot, ...updates }
    });
  }
}

export const DIAGNOSTIC_SCENARIOS: Record<string, { gateSequence: boolean[], executorResponse: string }> = {
  'clean_run': {
    gateSequence: [true],
    executorResponse: 'Task completed successfully on the first attempt with no errors found by gates.'
  },
  'single_retry': {
    gateSequence: [false, true],
    executorResponse: 'I have made the necessary adjustments to fix the gate failures.'
  },
  'model_escalation': {
    gateSequence: [false, false, true],
    executorResponse: 'I am upgrading to a more capable model to solve these persistent issues.'
  },
  'human_escalation': {
    gateSequence: [false, false, false, false, false, false],
    executorResponse: 'The issue appears complex and may require human oversight to resolve.'
  },
  'gate_crash': {
    gateSequence: [],
    executorResponse: 'Simulation of an unexpected runtime failure in the gate infrastructure.'
  }
};

/**
 * Folds retained `SessionRecord.conversationHistory` bookkeeping into the
 * config passed to `client.createSession`, so a recreated session doesn't
 * silently start with empty context at the SDK/model level (see #155).
 *
 * `createSession`/`resumeSession` have no `conversationHistory` field to
 * populate directly -- resume avoids the problem entirely by continuing the
 * SDK's own server-side history, but a genuine `createSession` fallback has
 * no such continuity. The only config surface that reaches the model before
 * the first turn is `systemMessage`, so the retained history is serialized
 * into it there, mirroring the same "[Conversation History]" formatting
 * already used ad hoc by `formatContextNarrowingPrompt`/`formatEscalationPrompt`
 * for individual prompt strings.
 *
 * A no-op (returns `options` unchanged) when there's no history to carry
 * forward, so callers with a brand-new session never pay for this.
 */
/**
 * Builds the plain-text "[Retained Conversation History]" block used to
 * fold bookkeeping history into a fresh session's system prompt, applying
 * the same 40k-char working-memory truncation as every other
 * history-to-model path (see `withRetainedHistory` below). Returns
 * `undefined` when there's no history to carry forward, so callers can
 * treat that as "nothing to append."
 */
export function buildRetainedHistoryBlock(
  history: SessionRecord['conversationHistory'] | undefined
): string | undefined {
  if (!history || history.length === 0) {
    return undefined;
  }
  const truncatedHistory = enforceWorkingMemoryTruncation(history);
  if (truncatedHistory.length === 0) {
    return undefined;
  }
  return `\n\n[Retained Conversation History]\n${truncatedHistory.map(h => `${h.role}: ${h.content}`).join('\n')}`;
}

export function withRetainedHistory(
  options: CopilotCreateSessionOptions,
  history: SessionRecord['conversationHistory']
): CopilotCreateSessionOptions {
  const historyBlock = buildRetainedHistoryBlock(history);
  if (!historyBlock) {
    return options;
  }

  const existingSystemMessage = options.systemMessage;

  if (existingSystemMessage?.mode === 'replace') {
    // Replace mode hands the model the caller's system message verbatim with
    // no SDK-managed sections to fall back on -- appending here is the only
    // way to still surface the retained history to a recreated session.
    return {
      ...options,
      systemMessage: {
        ...existingSystemMessage,
        content: `${existingSystemMessage.content}${historyBlock}`,
      },
    };
  }

  // Append mode (the default when systemMessage is omitted) and customize
  // mode both expose a plain `content` string that is added on top of the
  // SDK-managed prompt, so the history block can simply be appended there.
  return {
    ...options,
    systemMessage: {
      ...existingSystemMessage,
      content: `${existingSystemMessage?.content ?? ''}${historyBlock}`,
    },
  };
}

export async function getOrCreateSession(
  sessionId: string,
  currentModel: string,
  cwd: string,
  client: CopilotClient,
  createSessionOptions: CopilotCreateSessionOptions
): Promise<SessionRecord> {
  const now = Date.now();
  let existing = activeSessions.get(sessionId);

  // Try to rehydrate if not in memory
  if (!existing) {
    const stored = getSession(sessionId);
    if (stored) {
      writeLog(`[Session] Rehydrating session ${sessionId} from DB before creating new context.`);
      existing = {
        ...stored,
        sessionId,
        copilotSession: null as unknown as CopilotSession,
        currentModel: stored.currentModel || 'gemini-3.1-flash-lite',
        cwd: stored.cwd || getWorkspaceRoot(),
        lastUsedAt: stored.lastUsedAt || now,
        totalInputTokens: stored.totalInputTokens || 0,
        totalOutputTokens: stored.totalOutputTokens || 0,
        eventSequenceCounter: stored.eventSequenceCounter || 0,
        stateSnapshot: stored.stateSnapshot || { isRunning: false, awaitingHuman: false, retryCount: 0, currentTier: 'gemini-3.1-flash-lite' },
        conversationHistory: stored.conversationHistory || [],
        turns: stored.turns || [],
        diagnosticTrail: stored.diagnosticTrail || []
      } as SessionRecord;
      activeSessions.set(sessionId, existing);
    }
  }

  const safeModelTier = (MODEL_TIERS.includes(currentModel) ? currentModel : MODEL_TIERS[0]) || 'gemini-3.1-flash-lite';

  if (existing) {
    const modelOrCwdChanged = existing.currentModel !== currentModel || existing.cwd !== cwd;
    if (modelOrCwdChanged || !existing.copilotSession) {
      writeLog(`[Session] Context mismatch or missing copilotSession detected for ${sessionId}. ${modelOrCwdChanged ? 'Recreating' : 'Resuming'} session context.`);
      // The real server-side Copilot session ID (a random UUID the SDK
      // assigns) is NOT the same as `sessionId`, which is only the
      // client-side activeSessions Map key. It's captured from the live
      // CopilotSession object whenever we have one, but it's also
      // persisted to the DB (SessionRecord.copilotSessionId) precisely so
      // it survives a disconnect or a rehydrate-from-DB (where
      // copilotSession is null, see line ~148) -- otherwise the resume
      // path below would be unreachable for exactly the cases it exists
      // to handle.
      const realSessionId = existing.copilotSession?.sessionId || existing.copilotSessionId;
      try {
        existing.unsubscribe?.();
        if (existing.copilotSession) {
          await existing.copilotSession.disconnect();
        }
      } catch (err) {
        writeLog(`[Session] Error disconnecting outdated session ${sessionId}: ${err}`);
      }
      // Only resume when the model/cwd are unchanged and we merely lost the
      // live session object (e.g. after an UpstreamStreamStall retry, or a
      // session rehydrated mid-flight) -- that's the actual stall/reconnect
      // scenario this fixes (see #154): it was misdiagnosed as a
      // provider-side hang and "fixed" by discarding the live session and
      // its conversation/prompt state, when the real cause was a
      // ~10-minute server-side idle timeout that resumeSession recovers
      // from cleanly.
      //
      // A cwd change MUST still get a brand-new session via createSession,
      // not resumeSession -- this isn't just a preference. The SDK's
      // ResumeSessionConfig type has no workingDirectory field at all (only
      // SessionConfig, used at creation, does): a session's working
      // directory is fixed at creation time and cannot be changed on
      // resume. Resuming across a cwd change would silently keep running
      // tool calls against the session's *original* directory while our
      // own SessionRecord.cwd bookkeeping claimed it had moved -- a real
      // cross-workspace mismatch, not just a cosmetic one. A model-tier
      // escalation is also treated as a fresh-session case for the same
      // "deliberate context change, not a reconnect" reason, even though
      // model itself isn't structurally blocked on resume the way cwd is.
      //
      // Only fall back to createSession if resuming genuinely fails (e.g.
      // the underlying SDK session is truly unrecoverable) -- fail loud via
      // logging rather than silently masking a real dead-session case.
      let newSession: CopilotSession;
      if (!modelOrCwdChanged && realSessionId) {
        try {
          // eslint-disable-next-line no-restricted-syntax -- pre-existing direct resumeSession call site; not yet migrated to SessionWrapper (issue #246 item 7, tracked separately from item 4's enforcement)
          newSession = await client.resumeSession(realSessionId, createSessionOptions);
        } catch (err) {
          writeLog(`[Session] resumeSession(${realSessionId}) failed, falling back to createSession: ${err}`, LogLevel.WARN);
          // resumeSession would have carried the SDK's own server-side
          // history forward; that continuity is lost the moment we fall
          // back to createSession, so the retained bookkeeping history must
          // be folded into the new session's config explicitly (see #155).
          // eslint-disable-next-line no-restricted-syntax -- pre-existing direct createSession call site; not yet migrated to SessionWrapper (issue #246 item 7, tracked separately from item 4's enforcement)
          newSession = await client.createSession(withRetainedHistory(createSessionOptions, existing.conversationHistory));
        }
      } else {
        // A cwd/model change (or no realSessionId to resume) means this is
        // always a brand-new SDK session with no server-side history of its
        // own -- fold the retained bookkeeping history into its config so it
        // isn't silently dropped (see #155).
        // eslint-disable-next-line no-restricted-syntax -- pre-existing direct createSession call site; not yet migrated to SessionWrapper (issue #246 item 7, tracked separately from item 4's enforcement)
        newSession = await client.createSession(withRetainedHistory(createSessionOptions, existing.conversationHistory));
      }
      const updated: SessionRecord = {
        sessionId,
        copilotSession: newSession,
        copilotSessionId: newSession.sessionId,
        currentModel: safeModelTier,
        cwd,
        lastUsedAt: now,
        totalInputTokens: existing.totalInputTokens || 0,
        totalOutputTokens: existing.totalOutputTokens || 0,
        eventSequenceCounter: existing.eventSequenceCounter || 0,
        stateSnapshot: {
          ...(existing.stateSnapshot || {
            isRunning: false,
            retryCount: 0,
            currentTier: safeModelTier,
            activeGate: undefined,
            hasFailureState: false,
            awaitingHuman: false,
          }),
          currentTier: safeModelTier,
        },
        conversationHistory: existing.conversationHistory || [],
        turns: existing.turns || [],
        diagnosticTrail: existing.diagnosticTrail || []
      };
      activeSessions.set(sessionId, updated);
      return updated;
    }
    activeSessions.set(sessionId, { ...existing, lastUsedAt: now });
    return { ...existing, lastUsedAt: now };
  }

  // eslint-disable-next-line no-restricted-syntax -- pre-existing direct createSession call site; not yet migrated to SessionWrapper (issue #246 item 7, tracked separately from item 4's enforcement)
  const newSession = await client.createSession(createSessionOptions);
  const record: SessionRecord = {
    sessionId,
    copilotSession: newSession,
    copilotSessionId: newSession.sessionId,
    currentModel: safeModelTier,
    cwd,
    lastUsedAt: now,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    eventSequenceCounter: 0,
    stateSnapshot: {
      isRunning: false,
      retryCount: 0,
      currentTier: safeModelTier,
      activeGate: undefined,
      hasFailureState: false,
      awaitingHuman: false,
    },
    conversationHistory: [],
    turns: [],
    diagnosticTrail: []
  };
  activeSessions.set(sessionId, record);
  return record;
}

/**
 * Hotswap replacement for `getOrCreateSession`, introduced for issue #246
 * item 7 / #346 (see AGENTS.md "SessionWrapper: toolCallEnforcement.ts retry
 * logic needs to own a SessionWrapper" comment thread). Coexists with the
 * original `getOrCreateSession` -- nothing here removes or calls it -- so
 * call sites can migrate one at a time rather than all at once. Once every
 * caller of `getOrCreateSession` has moved to this function, the old one
 * (and `SessionRecord.copilotSession`/`SessionWrapper.adopt()`) become
 * removable in a follow-up.
 *
 * Behavioral difference from `getOrCreateSession`, by design: `SessionWrapper`
 * never creates/resumes a session at construction time (SYS-REQ-028f) -- only
 * the wrapper's own first `sendAndWait()` call does. So unlike
 * `getOrCreateSession`, this function does NOT eagerly call
 * `client.createSession`/`client.resumeSession` itself; it only decides
 * *which* `SessionWrapper` instance the caller should send this turn's
 * prompt through, and persistence of `copilotSessionId`/DB save must happen
 * at the caller's `sendAndWait(prompt, timeout, listeners)` call, not here
 * (see the migrated call site for the pattern).
 *
 * Model/cwd-change semantics are preserved: an existing wrapper whose
 * `currentModel`/`cwd` no longer match this call's is discarded (its live
 * session, if any, disconnected) and replaced with a brand-new
 * `SessionWrapper`, mirroring `getOrCreateSession`'s "deliberate context
 * change, not a reconnect" createSession-not-resume behavior for the same
 * cases.
 *
 * Rehydrate-from-DB (no in-memory `SessionRecord`, but a persisted
 * `copilotSessionId` from a prior process) falls through to the
 * fresh-construction branch below, same as a genuine model/cwd change.
 * Unlike `getOrCreateSession`, this does not attempt to resume the prior
 * SDK session by its known id -- `SessionWrapper`/`SessionConfig` has no
 * "resume by bare id, no live object" construction path, and there's no
 * correctness cost to not having one: the app's own `conversationHistory`
 * is already persisted per session (`SessionRecord.conversationHistory`),
 * so a fresh wrapper can fully recover context via
 * `wrapper.setSystemPrompt(foldedHistoryText)` before its first
 * `sendAndWait()` -- the same folding `withRetainedHistory` already does
 * for `getOrCreateSession`'s own createSession-fallback branch, and
 * `setSystemPrompt` content called pre-first-send becomes part of the
 * frozen, byte-identical-across-resume `systemMessage` (SYS-REQ-028g/h),
 * so this is spec-compliant, not a workaround. The only real cost is losing
 * the prior session's server-side prompt-cache prefix -- and that cache is
 * only warm for 5-60 minutes, so a process restart (which is what puts a
 * record in this branch at all) has almost always already outlived it
 * regardless of whether resume-by-id existed. Not treating this as a gap
 * needing a spec change.
 */
export async function getOrCreateSessionWrapper(
  sessionId: string,
  currentModel: string,
  cwd: string,
  client: CopilotClient,
  toolsConfig: SessionWrapperToolsConfig,
  baseConfig: SessionWrapperBaseConfig
): Promise<{ record: SessionRecord; wrapper: SessionWrapper }> {
  const now = Date.now();
  const existing = activeSessions.get(sessionId);

  const safeModelTier = (MODEL_TIERS.includes(currentModel) ? currentModel : MODEL_TIERS[0]) || 'gemini-3.1-flash-lite';

  const contextChanged = !existing || existing.currentModel !== currentModel || existing.cwd !== cwd || !existing.sessionWrapper;

  if (!contextChanged && existing?.sessionWrapper) {
    // Same model/cwd, wrapper already live: hand back the SAME wrapper
    // instance so its next `sendAndWait()` resumes internally
    // (SYS-REQ-028f/028e) -- no adopt(), no new construction.
    const updated: SessionRecord = { ...existing, lastUsedAt: now };
    activeSessions.set(sessionId, updated);
    return { record: updated, wrapper: existing.sessionWrapper };
  }

  // Context changed, or no live wrapper yet (fresh session, or a
  // rehydrate-from-DB case -- see the rehydrate note above): disconnect whatever
  // live session the old wrapper may be holding, then construct a fresh
  // wrapper. Its session is NOT created yet -- that happens on the caller's
  // first `sendAndWait()`.
  if (existing?.sessionWrapper?.session) {
    try {
      await existing.sessionWrapper.session.disconnect();
    } catch (err) {
      writeLog(`[SessionWrapper] Error disconnecting outdated wrapper session ${sessionId}: ${err}`, LogLevel.WARN);
    }
  }

  const wrapper = new SessionWrapper(client, toolsConfig, baseConfig).setModelName(safeModelTier);

  // Fold any retained bookkeeping history into the fresh wrapper's system
  // prompt before its first sendAndWait -- see the rehydrate note above.
  // Must happen before first send: setSystemPrompt content is only picked
  // up while `_frozenSystemMessage` is still unset (SYS-REQ-028g/h).
  // `systemMessage` is a `SessionWrapperBaseConfig`-excluded/owned key
  // (SessionWrapper builds it itself from `setSystemPrompt` state), so
  // there is no caller-supplied base content to prepend here -- the history
  // block is the entire caller-facing prompt for a rehydrated session.
  const historyBlock = buildRetainedHistoryBlock(existing?.conversationHistory ?? undefined);
  if (historyBlock) {
    wrapper.setSystemPrompt(historyBlock);
  }

  const record: SessionRecord = {
    sessionId,
    // `copilotSession` stays null under the wrapper-owned path -- callers
    // migrated onto this function must stop reading it and use `wrapper`
    // (or `wrapper.session`, post-`sendAndWait`) instead.
    copilotSession: null,
    copilotSessionId: existing?.copilotSessionId,
    sessionWrapper: wrapper,
    currentModel: safeModelTier,
    cwd,
    lastUsedAt: now,
    totalInputTokens: existing?.totalInputTokens || 0,
    totalOutputTokens: existing?.totalOutputTokens || 0,
    eventSequenceCounter: existing?.eventSequenceCounter || 0,
    stateSnapshot: {
      ...(existing?.stateSnapshot || {
        isRunning: false,
        retryCount: 0,
        currentTier: safeModelTier as ModelTier,
        activeGate: undefined,
        hasFailureState: false,
        awaitingHuman: false,
      }),
      currentTier: safeModelTier as ModelTier,
    },
    conversationHistory: existing?.conversationHistory || [],
    turns: existing?.turns || [],
    diagnosticTrail: existing?.diagnosticTrail || [],
  };
  activeSessions.set(sessionId, record);
  return { record, wrapper };
}

let globalClient: CopilotClient | null = null;
let globalClientCwd: string | null = null;
let globalClientProxyUrl: string | null = null;
let initializationPromise: Promise<CopilotClient> | null = null;

export async function resetGlobalClient() {
  if (globalClient) {
    writeLog('[SDK] Explicitly resetting global CopilotClient via resetGlobalClient...');
    try {
      await globalClient.stop();
    } catch (_) {}
    globalClient = null;
    globalClientCwd = null;
    globalClientProxyUrl = null;
    initializationPromise = null;
  }
}

export async function getGlobalClient(cwd?: string): Promise<CopilotClient> {
  const currentProxyUrl = process.env.COPILOT_API_URL || '';
  if (globalClient) {
    const cwdChanged = cwd && globalClientCwd && path.resolve(cwd) !== path.resolve(globalClientCwd);
    const proxyChanged = globalClientProxyUrl !== null && currentProxyUrl !== globalClientProxyUrl;
    if (cwdChanged || proxyChanged) {
      writeLog(`[SDK] Resetting global CopilotClient. cwdChanged=${cwdChanged} (from ${globalClientCwd} to ${cwd}), proxyChanged=${proxyChanged} (from ${globalClientProxyUrl} to ${currentProxyUrl})`);
      try {
        await globalClient.stop();
      } catch (_) {}
      globalClient = null;
      globalClientCwd = null;
      globalClientProxyUrl = null;
      initializationPromise = null;
    } else {
      return globalClient;
    }
  }

  if (initializationPromise) {
    return initializationPromise;
  }

  initializationPromise = (async () => {
    try {
      writeLog('[SDK] Instantiating and starting global CopilotClient...');
      
      let finalCwd = DEFAULT_WORKSPACE_DIR;
      if (cwd) {
        try {
          const makeDirResult = await getExecCommand()(`mkdir -p '${cwd}'`);
          if (makeDirResult.exitCode === 0) {
            if (checkPathInside(getWorkspaceRoot(), cwd)) {
              const relativeCwd = path.relative(getWorkspaceRoot(), cwd);
              finalCwd = path.join(getWorkspaceHostLocation(), relativeCwd);
            } else {
              finalCwd = cwd;
            }
            fs.mkdirSync(finalCwd, { recursive: true });
          } else {
            throw new Error(makeDirResult.stderr);
          }
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          writeLog(`[SDK] Working directory ${cwd} does not exist and could not be created, falling back to ${DEFAULT_WORKSPACE_DIR}. Error: ${msg}`);
          finalCwd = DEFAULT_WORKSPACE_DIR;
        }
      }

      const client = new CopilotClient({
        workingDirectory: finalCwd,
        logLevel: 'none',
        useLoggedInUser: false,
      });
      await client.start();
      writeLog('[SDK] Global CopilotClient started successfully.');
      globalClient = client;
      globalClientCwd = finalCwd;
      globalClientProxyUrl = currentProxyUrl;
      return client;
    } catch (e) {
      throw e;
    } finally {
      initializationPromise = null;
    }
  })();

  return initializationPromise;
}

export function writeLog(message: string, level: LogLevel = LogLevel.INFO) {
  const levelName = LogLevel[level];
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] [${levelName}] ${message}\n`;

  // Always write to the debug file if it meets the file threshold (DEBUG+)
  if (level >= FILE_LOG_LEVEL) {
    try {
      fs.appendFileSync(LOG_FILE, line, 'utf8');
    } catch (err) {
      // ignore
    }
  }

  // Only push to in-memory history and console if it meets the "Quiet Mode" threshold
  if (level >= CURRENT_LOG_LEVEL) {
    lastRunLog.push(`[${timestamp}] [${levelName}] ${message}`);
    if (lastRunLog.length > 500) lastRunLog.shift();
    
    // Only print to console if it's INFO or higher, or if DEBUG was explicitly requested
    if (level >= LogLevel.INFO || CURRENT_LOG_LEVEL <= LogLevel.DEBUG) {
      console.log(`[${levelName}] ${message}`);
    }
  }
}

export function initLogFile() {
  try {
    fs.writeFileSync(LOG_FILE, `=== COPILOT EVENT SYSTEM DEBUGLOG ===\nInitialized at ${new Date().toISOString()}\n\n`, 'utf8');
  } catch (err) {
    // ignore
  }
}

export async function getCodeState(dir: string): Promise<string> {
  const execCommand = getExecCommand();
  const MAX_FILES = 100;
  const MAX_AGGREGATE_SIZE = 80000;

  try {
    const findCmd = `cd '${dir}' && find . -type f \\( -name "*.ts" -o -name "*.tsx" -o -name "*.js" -o -name "*.jsx" -o -name "*.json" -o -name "*.html" -o -name "*.css" -o -name "*.md" \\) ! -path "*/node_modules/*" ! -path "*/dist/*" ! -path "*/.git/*" ! -name "package-lock.json" ! -name ".env"`;
    const findResult = await execCommand(findCmd);
    if (findResult.exitCode !== 0) {
      writeLog(`[getCodeState] find command failed: ${findResult.stderr}`);
      return '';
    }

    const files = findResult.stdout
      .split('\n')
      .map(f => f.trim())
      .filter(f => f && f !== '.');

    let result = '';
    let fileCount = 0;
    let totalSize = 0;

    for (const relPath of files) {
      if (fileCount >= MAX_FILES || totalSize >= MAX_AGGREGATE_SIZE) {
        result += '\n\n--- [CODEBASE TRUNCATED DUE TO SIZE LIMITS] ---';
        break;
      }

      const sizeCmd = `cd '${dir}' && wc -c < '${relPath}'`;
      const sizeResult = await execCommand(sizeCmd);
      if (sizeResult.exitCode !== 0) {
        continue;
      }
      const size = parseInt(sizeResult.stdout.trim(), 10);
      if (isNaN(size) || size >= 50000 || (totalSize + size) >= MAX_AGGREGATE_SIZE) {
        continue;
      }

      const catCmd = `cd '${dir}' && cat '${relPath}'`;
      const catResult = await execCommand(catCmd);
      if (catResult.exitCode !== 0) {
        continue;
      }

      const ext = relPath.substring(relPath.lastIndexOf('.'));
      result += `\n\n--- File: ${relPath.replace(/^\.\//, '')} ---\n\`\`\`${ext.slice(1)}\n${catResult.stdout}\n\`\`\``;
      fileCount++;
      totalSize += size;
    }

    return result;
  } catch (err) {
    writeLog(`[getCodeState] Error reading codebase: ${err}`);
    return '';
  }
}

/**
 * `executionConfigOverride` lets callers supply a pre-resolved
 * ExecutionConfig (e.g. from the Issue 79 auditor rotation pool) instead of
 * the single-tier default -- when omitted, behavior is unchanged from
 * before the rotation pool existed.
 */
export async function runLlmAudit(
  promptStr: string,
  codeStateSummary: string,
  apiKey?: string,
  abortSignal?: AbortSignal,
  executionConfigOverride?: ExecutionConfig,
): Promise<AuditResult> {
  const executionConfig = executionConfigOverride ?? getAuditorExecutionConfig(apiKey);
  const systemPrompt = `You are an expert security auditor and code reviewer operating as an isolated quality assurance suite. Analyze the provided codebase and audit it for vulnerabilities, validation gate status, and functional readiness relative to the requirements.
You MUST submit structured verification feedback, logic checks, and compiler gate status using the 'submit_audit_findings' tool immediately. Do NOT reply with standard conversational text; you MUST call the 'submit_audit_findings' tool.`;

  const auditPrompt = `
      Analyze the current code state based on the requirement: "${promptStr}".
      
      Current Code State:
      ${codeStateSummary}
    `;

  try {
    const auditResult = await executeAuditSession<AuditResult>(
      DEFAULT_WORKSPACE_DIR,
      executionConfig,
      systemPrompt,
      submitAuditFindingsTool,
      auditPrompt,
      {},
      abortSignal
    );

    if (auditResult) {
      return auditResult;
    }

    return {
      pass: false,
      findings: [
        {
          severity: 'critical',
          file: '',
          description: 'Auditor failed to invoke the submit_audit_findings tool. A valid, structured tool invocation is required.'
        }
      ]
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    writeLog(`[runLlmAudit] Exception: ${msg}`);

    const isAbort = (abortSignal && abortSignal.aborted) || (err instanceof Error && err.name === 'AbortError') || msg.toLowerCase().includes('abort') || msg.toLowerCase().includes('cancel');
    if (isAbort) {
      writeLog(`[runLlmAudit] Audit session was aborted or cancelled.`);
      return {
        pass: false,
        aborted: true,
        findings: [
          {
            severity: 'low',
            file: '',
            description: 'Audit session was aborted or cancelled.'
          }
        ]
      };
    }

    return {
      pass: false,
      findings: [
        {
          severity: 'critical',
          file: '',
          description: `Auditor session crashed: ${msg}`
        }
      ]
    };
  }
}
