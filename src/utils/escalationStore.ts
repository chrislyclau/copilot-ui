import { db } from '../db/index';
import { StateSnapshot, Turn } from '../types/session';

export interface EscalationEntry {
  readonly id: string;
  readonly sessionId: string;
  readonly escalatedAt: number;
  readonly summary: string;
  readonly failedGate: string | undefined;
  readonly failedGateFeedback: string | undefined;
  readonly retryHistory: ReadonlyArray<unknown>;
  readonly status: 'pending' | 'resumed' | 'resolved';
  // Context for rehydration
  readonly stateSnapshot?: StateSnapshot;
  readonly conversationHistory?: ReadonlyArray<{ readonly role: 'user' | 'assistant'; readonly content: string }>;
  readonly turns?: ReadonlyArray<Turn>;
  readonly cwd?: string;
  readonly currentModel?: string;
}

interface EscalationRow {
  readonly id: string;
  readonly sessionId: string;
  readonly escalatedAt: number;
  readonly summary: string;
  readonly failedGate: string | null;
  readonly failedGateFeedback: string | null;
  readonly retryHistory: string;
  readonly status: 'pending' | 'resumed' | 'resolved';
  readonly stateSnapshot?: string | null;
  readonly conversationHistory?: string | null;
  readonly turns?: string | null;
  readonly cwd?: string | null;
  readonly currentModel?: string | null;
}

export function getEscalations(): ReadonlyArray<EscalationEntry> {
  const rows = db.prepare('SELECT * FROM escalations ORDER BY escalatedAt DESC').all() as ReadonlyArray<EscalationRow>;
  return rows.map(row => ({
    ...row,
    failedGate: row.failedGate ?? undefined,
    failedGateFeedback: row.failedGateFeedback ?? undefined,
    cwd: row.cwd ?? undefined,
    currentModel: row.currentModel ?? undefined,
    retryHistory: row.retryHistory ? JSON.parse(row.retryHistory) : [],
    stateSnapshot: row.stateSnapshot ? JSON.parse(row.stateSnapshot) : undefined,
    conversationHistory: row.conversationHistory ? JSON.parse(row.conversationHistory) : undefined,
    turns: row.turns ? JSON.parse(row.turns) : undefined
  }));
}

export function appendEscalation(entry: Omit<EscalationEntry, 'id' | 'escalatedAt' | 'status'>) {
  const newId = Math.random().toString(36).substring(2, 15);
  const now = Date.now();
  
  db.prepare(`
    INSERT INTO escalations (
      id, sessionId, escalatedAt, summary, failedGate, failedGateFeedback,
      retryHistory, status, stateSnapshot, conversationHistory, turns, cwd, currentModel
    ) VALUES (
      @id, @sessionId, @escalatedAt, @summary, @failedGate, @failedGateFeedback,
      @retryHistory, @status, @stateSnapshot, @conversationHistory, @turns, @cwd, @currentModel
    )
  `).run({
    id: newId,
    sessionId: entry.sessionId,
    escalatedAt: now,
    summary: entry.summary,
    failedGate: entry.failedGate || null,
    failedGateFeedback: entry.failedGateFeedback || null,
    retryHistory: entry.retryHistory ? JSON.stringify(entry.retryHistory) : '[]',
    status: 'pending',
    stateSnapshot: entry.stateSnapshot ? JSON.stringify(entry.stateSnapshot) : null,
    conversationHistory: entry.conversationHistory ? JSON.stringify(entry.conversationHistory) : null,
    turns: entry.turns ? JSON.stringify(entry.turns) : null,
    cwd: entry.cwd || null,
    currentModel: entry.currentModel || null
  });
}

export function updateEscalationStatus(sessionId: string, status: 'pending' | 'resumed' | 'resolved') {
  db.prepare(`
    UPDATE escalations 
    SET status = @status 
    WHERE sessionId = @sessionId AND status = 'pending'
  `).run({ status, sessionId });
}

export function getPendingEscalation(sessionId: string): EscalationEntry | undefined {
  const row = db.prepare(`
    SELECT * FROM escalations 
    WHERE sessionId = @sessionId AND status = 'pending' 
    ORDER BY escalatedAt DESC LIMIT 1
  `).get({ sessionId }) as EscalationRow | undefined;
  
  if (!row) return undefined;
  
  return {
    ...row,
    failedGate: row.failedGate ?? undefined,
    failedGateFeedback: row.failedGateFeedback ?? undefined,
    cwd: row.cwd ?? undefined,
    currentModel: row.currentModel ?? undefined,
    retryHistory: row.retryHistory ? JSON.parse(row.retryHistory) : [],
    stateSnapshot: row.stateSnapshot ? JSON.parse(row.stateSnapshot) : undefined,
    conversationHistory: row.conversationHistory ? JSON.parse(row.conversationHistory) : undefined,
    turns: row.turns ? JSON.parse(row.turns) : undefined
  };
}
