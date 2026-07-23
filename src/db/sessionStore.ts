import { db } from './index';
import { SessionRecord } from '../types/session';
import { ModelTier } from '../config/models';

interface SessionRow {
  readonly sessionId: string;
  readonly taskId?: string;
  readonly currentModel: string;
  readonly cwd: string;
  readonly copilotSessionId?: string;
  readonly lastUsedAt: number;
  readonly currentTierIndex: number;
  readonly planVersions?: string;
  readonly totalInputTokens: number;
  readonly totalOutputTokens: number;
  readonly eventSequenceCounter: number;
  readonly stateSnapshot?: string;
  readonly conversationHistory?: string;
  readonly turns?: string;
  readonly diagnosticTrail?: string;
}

export function getSession(sessionId: string): Partial<SessionRecord> | undefined {
  const row = db.prepare('SELECT * FROM sessions WHERE sessionId = ?').get(sessionId) as SessionRow | undefined;
  if (!row) return undefined;
  return {
    sessionId: row.sessionId,
    taskId: row.taskId,
    currentModel: row.currentModel as ModelTier, // TODO: refine Model type
    cwd: row.cwd,
    copilotSessionId: row.copilotSessionId || undefined,
    lastUsedAt: row.lastUsedAt,
    currentTierIndex: row.currentTierIndex,
    planVersions: row.planVersions ? JSON.parse(row.planVersions) : undefined,
    totalInputTokens: row.totalInputTokens,
    totalOutputTokens: row.totalOutputTokens,
    eventSequenceCounter: row.eventSequenceCounter,
    stateSnapshot: row.stateSnapshot ? JSON.parse(row.stateSnapshot) : undefined,
    conversationHistory: row.conversationHistory ? JSON.parse(row.conversationHistory) : undefined,
    turns: row.turns ? JSON.parse(row.turns) : undefined,
    diagnosticTrail: row.diagnosticTrail ? JSON.parse(row.diagnosticTrail) : undefined,
  };
}

export function saveSession(session: SessionRecord) {
  const stmt = db.prepare(`
    INSERT INTO sessions (
      sessionId, taskId, currentModel, cwd, copilotSessionId, lastUsedAt, currentTierIndex,
      planVersions, totalInputTokens, totalOutputTokens,
      eventSequenceCounter, stateSnapshot, conversationHistory,
      turns, diagnosticTrail
    ) VALUES (
      @sessionId, @taskId, @currentModel, @cwd, @copilotSessionId, @lastUsedAt, @currentTierIndex,
      @planVersions, @totalInputTokens, @totalOutputTokens,
      @eventSequenceCounter, @stateSnapshot, @conversationHistory,
      @turns, @diagnosticTrail
    )
    ON CONFLICT(sessionId) DO UPDATE SET
      taskId = excluded.taskId,
      currentModel = excluded.currentModel,
      cwd = excluded.cwd,
      copilotSessionId = excluded.copilotSessionId,
      lastUsedAt = excluded.lastUsedAt,
      currentTierIndex = excluded.currentTierIndex,
      planVersions = excluded.planVersions,
      totalInputTokens = excluded.totalInputTokens,
      totalOutputTokens = excluded.totalOutputTokens,
      eventSequenceCounter = excluded.eventSequenceCounter,
      stateSnapshot = excluded.stateSnapshot,
      conversationHistory = excluded.conversationHistory,
      turns = excluded.turns,
      diagnosticTrail = excluded.diagnosticTrail
  `);
  
  stmt.run({
    sessionId: session.sessionId,
    taskId: session.taskId || null,
    currentModel: session.currentModel,
    cwd: session.cwd,
    copilotSessionId: session.copilotSessionId || null,
    lastUsedAt: session.lastUsedAt,
    currentTierIndex: session.currentTierIndex,
    planVersions: session.planVersions ? JSON.stringify(session.planVersions) : null,
    totalInputTokens: session.totalInputTokens,
    totalOutputTokens: session.totalOutputTokens,
    eventSequenceCounter: session.eventSequenceCounter,
    stateSnapshot: session.stateSnapshot ? JSON.stringify(session.stateSnapshot) : null,
    conversationHistory: session.conversationHistory ? JSON.stringify(session.conversationHistory) : null,
    turns: session.turns ? JSON.stringify(session.turns) : null,
    diagnosticTrail: session.diagnosticTrail ? JSON.stringify(session.diagnosticTrail) : null,
  });
}

export function getAllSessions(): ReadonlyArray<Partial<SessionRecord>> {
  const rows = db.prepare('SELECT * FROM sessions').all() as ReadonlyArray<SessionRow>;
  return rows.map(row => ({
    sessionId: row.sessionId,
    taskId: row.taskId,
    currentModel: row.currentModel as ModelTier,
    cwd: row.cwd,
    copilotSessionId: row.copilotSessionId || undefined,
    lastUsedAt: row.lastUsedAt,
    currentTierIndex: row.currentTierIndex,
    planVersions: row.planVersions ? JSON.parse(row.planVersions) : undefined,
    totalInputTokens: row.totalInputTokens,
    totalOutputTokens: row.totalOutputTokens,
    eventSequenceCounter: row.eventSequenceCounter,
    stateSnapshot: row.stateSnapshot ? JSON.parse(row.stateSnapshot) : undefined,
    conversationHistory: row.conversationHistory ? JSON.parse(row.conversationHistory) : undefined,
    turns: row.turns ? JSON.parse(row.turns) : undefined,
    diagnosticTrail: row.diagnosticTrail ? JSON.parse(row.diagnosticTrail) : undefined,
  }));
}

export function deleteSession(sessionId: string) {
  db.prepare('DELETE FROM sessions WHERE sessionId = ?').run(sessionId);
}
