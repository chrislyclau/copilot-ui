import express from 'express';
import path from 'path';
import fs from 'fs';
import { CopilotClient, SessionConfig, SdkProviderConfig, Tool } from '../copilotSdk/boundary';
import { MODEL_TIERS } from '../config/models';
import { SessionRecord, StateSnapshot } from '../types/session';
import { getWorkspaceHostLocation, getExecCommand } from '../workspace';
import { saveSession, deleteSession } from '../db/sessionStore';
import { getAuditorExecutionConfig, executeAuditSession } from '../utils/auditorHelper';
import { submitAuditFindingsTool } from '../config/tools';

export interface CopilotCreateSessionOptions extends Omit<SessionConfig, 'provider'> {
  provider?: SdkProviderConfig;
  tools?: Tool<unknown>[];
  streaming?: boolean;
}

const LOG_FILE = path.join('/tmp', 'debug_log.txt');
export const lastRunLog: string[] = [];

export const DEFAULT_WORKSPACE_DIR = getWorkspaceHostLocation();
if (!fs.existsSync(DEFAULT_WORKSPACE_DIR)) {
  fs.mkdirSync(DEFAULT_WORKSPACE_DIR, { recursive: true });
}

export class SessionMap extends Map<string, SessionRecord> {
  set(key: string, value: SessionRecord) {
    super.set(key, value);
    try {
      console.log(`[SessionMap] Saving session ${key} to DB...`);
      saveSession(value);
    } catch (e) {
      console.error(`Failed to save session ${key} to SQLite:`, e);
    }
    return this;
  }

  delete(key: string) {
    const res = super.delete(key);
    try {
      console.log(`[SessionMap] Deleting session ${key} from DB...`);
      deleteSession(key);
    } catch (e) {
      console.error(`Failed to delete session ${key} from SQLite:`, e);
    }
    return res;
  }
}

export const activeSessions = new SessionMap();
export const sseResToSessionId = new Map<express.Response, string>();
export const sessionWritePromises = new Map<string, Promise<void>>();
export const activeLocks = new Map<string, AbortController>();

export let sensitiveValuesCache: Set<string> | null = null;
export function setSensitiveValuesCache(val: Set<string> | null) {
  sensitiveValuesCache = val;
}

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

export async function getOrCreateSession(
  sessionId: string,
  currentModel: string,
  cwd: string,
  client: CopilotClient,
  createSessionOptions: CopilotCreateSessionOptions
): Promise<SessionRecord> {
  const now = Date.now();
  const existing = activeSessions.get(sessionId);
  
  const safeModelTier = (MODEL_TIERS.includes(currentModel) ? currentModel : MODEL_TIERS[0]) || 'gemini-3.1-flash-lite';

  if (existing) {
    if (existing.currentModel !== currentModel || existing.cwd !== cwd || !existing.copilotSession) {
      writeLog(`[Session] Context mismatch or missing copilotSession detected for ${sessionId}. Recreating session context.`);
      try {
        existing.unsubscribe?.();
        if (existing.copilotSession) {
          await existing.copilotSession.disconnect();
        }
      } catch (err) {
        writeLog(`[Session] Error disconnecting outdated session ${sessionId}: ${err}`);
      }
      const newSession = await client.createSession(createSessionOptions);
      const updated: SessionRecord = {
        sessionId,
        copilotSession: newSession,
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

  const newSession = await client.createSession(createSessionOptions);
  const record: SessionRecord = {
    sessionId,
    copilotSession: newSession,
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
            finalCwd = cwd;
          } else {
            throw new Error(makeDirResult.stderr);
          }
        } catch (err: any) {
          writeLog(`[SDK] Working directory ${cwd} does not exist and could not be created, falling back to ${DEFAULT_WORKSPACE_DIR}. Error: ${err.message}`);
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

export function writeLog(message: string) {
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] ${message}\n`;
  lastRunLog.push(`[${timestamp}] ${message}`);
  if (lastRunLog.length > 500) lastRunLog.shift();
  try {
    fs.appendFileSync(LOG_FILE, line, 'utf8');
  } catch (err) {
    // ignore
  }
  console.log(message);
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

export async function runLlmAudit(promptStr: string, codeStateSummary: string, apiKey?: string): Promise<{ pass: boolean; findings: any[] }> {
  const executionConfig = getAuditorExecutionConfig(apiKey);
  const systemPrompt = `You are an expert security auditor and code reviewer operating as an isolated quality assurance suite. Analyze the provided codebase and audit it for vulnerabilities, validation gate status, and functional readiness relative to the requirements.
You MUST submit structured verification feedback, logic checks, and compiler gate status using the 'submit_audit_findings' tool immediately. Do NOT reply with standard conversational text; you MUST call the 'submit_audit_findings' tool.`;

  const auditPrompt = `
      Analyze the current code state based on the requirement: "${promptStr}".
      
      Current Code State:
      ${codeStateSummary}
    `;

  try {
    const auditResult = await executeAuditSession<{ pass: boolean; findings: any[] }>(
      DEFAULT_WORKSPACE_DIR,
      executionConfig,
      systemPrompt,
      submitAuditFindingsTool,
      auditPrompt,
      {
        toolChoice: { type: 'function', function: { name: submitAuditFindingsTool.function.name } },
        allowOthers: false
      }
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
  } catch (err: any) {
    writeLog(`[runLlmAudit] Exception: ${err.message || err}`);
    return {
      pass: false,
      findings: [
        {
          severity: 'critical',
          file: '',
          description: `Auditor session crashed: ${err.message || err}`
        }
      ]
    };
  }
}
