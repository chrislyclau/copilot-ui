import express from 'express';
import path from 'path';
import fs from 'fs';
import { createServer as createViteServer } from 'vite';
import { CopilotClient, PermissionRequestResult, SessionConfig, ProviderConfig as SdkProviderConfig, Tool } from '@github/copilot-sdk';
import dotenv from 'dotenv';

export interface CopilotCreateSessionOptions extends Omit<SessionConfig, 'provider'> {
  provider?: SdkProviderConfig;
  tools?: Tool<unknown>[];
  streaming?: boolean;
}
import { DEFAULT_ROLES_CONFIG } from './src/config/models';
import { runGate, runTests, runLint, runWithTimeout } from './src/gates';
import { MODEL_TIERS, getNextTier } from './src/config/models';
import { SessionRecord, StateSnapshot, CopilotEventData, Turn } from './src/types/session';
import { formatContextNarrowingPrompt, formatEscalationPrompt, formatHumanEscalationPrompt, formatClarityCheckPrompt } from './src/utils/prompt';
import { makeDockerToolHandler } from './src/utils/toolHandlers';
import { RUN_TERMINAL_DOCKER_TOOL, submitAuditFindingsTool, COMPOSER_ROUTER_TOOL, AMBIGUITY_CHECK_TOOL } from './src/config/tools';

import { normalizeGates, TASK_TYPE_GATE_MAP, resolvePipeline } from './src/config/gates';
import { runSpecAudit } from './src/gates/specAuditor';
import { sanitizeSensitives } from './src/utils/sanitizers';
import { truncateOutput } from './src/utils/formatters';
import { initializeWorkspace, getGitSandbox, getExecCommand, getWorkspaceHostLocation } from './src/workspace';
import { enforceWorkingMemoryTruncation, SlidingWindowCircularBuffer, clearCleanCache } from './src/utils/contextManager';
import { fetchStubbedTraceResponse } from './src/utils/traceRegistry';
import { appendEscalation, updateEscalationStatus, getEscalations, getPendingEscalation } from './src/utils/escalationStore';
@@
-const LOG_FILE = path.join('/tmp', 'debug_log.txt');
+const LOG_FILE = path.join('/tmp', 'debug_log.txt');
 export const lastRunLog: string[] = [];
-
-const DEFAULT_WORKSPACE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-ui-workspace-'));
+
+const DEFAULT_WORKSPACE_DIR = getWorkspaceHostLocation();
@@
-      const workspaceHash = Buffer.from(currentSessionId || 'default').toString('base64url').replace(/[^a-z0-9]/gi, '').substring(0, 8);
+      const workspaceHash = Buffer.from(currentSessionId || 'default').toString('base64url').replace(/[^a-z0-9]/gi, '').substring(0, 8);
       const targetTempDir = path.join(process.cwd(), `tmp-${workspaceHash}`);
       await getExecCommand()(`rm -rf '${targetTempDir}'`);
       writeLog(`[CleanupGuard] Scrubbed local runtime temporary worktree directory: ${targetTempDir}`);
