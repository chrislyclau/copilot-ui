import { describe, it, beforeEach, expect } from 'vitest';
import { db } from '../db/index';
import { getSession, saveSession, deleteSession, getAllSessions } from '../db/sessionStore';
import { appendEscalation, getPendingEscalation, updateEscalationStatus } from '../utils/escalationStore';
import { SessionRecord } from '../types/session';

describe('SQLite Persistence layer', () => {
  beforeEach(() => {
    db.prepare('DELETE FROM sessions').run();
    db.prepare('DELETE FROM escalations').run();
  });

  it('should save and get a session correctly', () => {
    const dummySession: SessionRecord = {
      sessionId: 'sess-123',
      currentModel: 'gemini-3.1-flash-lite',
      cwd: '/fake/dir',
      lastUsedAt: 1000000,
      currentTierIndex: 0,
      totalInputTokens: 100,
      totalOutputTokens: 200,
      eventSequenceCounter: 5,
      stateSnapshot: {
        isRunning: true,
        awaitingHuman: false,
        retryCount: 0,
        currentTier: 'gemini-3.1-flash-lite',
        activeGate: undefined,
        hasFailureState: false
      },
      conversationHistory: [{ role: 'user', content: 'hello' }],
      turns: [],
      copilotSession: null as any
    };

    saveSession(dummySession);

    const retrieved = getSession('sess-123');
    expect(retrieved).not.toBeNull();
    expect(retrieved?.sessionId).toBe('sess-123');
    expect(retrieved?.cwd).toBe('/fake/dir');
    expect(retrieved?.stateSnapshot?.isRunning).toBe(true);
    expect(retrieved?.conversationHistory?.[0]?.content).toBe('hello');
  });

  it('should update an existing session', () => {
    const dummySession: SessionRecord = {
      sessionId: 'sess-123',
      currentModel: 'gemini-3.1-flash-lite',
      cwd: '/fake/dir',
      lastUsedAt: 1000000,
      currentTierIndex: 0,
      totalInputTokens: 100,
      totalOutputTokens: 200,
      eventSequenceCounter: 5,
      stateSnapshot: {
        isRunning: true,
        awaitingHuman: false,
        retryCount: 0,
        currentTier: 'gemini-3.1-flash-lite',
        activeGate: undefined,
        hasFailureState: false
      },
      conversationHistory: [],
      turns: [],
      copilotSession: null as any
    };

    saveSession(dummySession);

    const dummySession2 = { ...dummySession, cwd: '/new/dir', totalInputTokens: 150 };
    saveSession(dummySession2);

    const retrieved = getSession('sess-123');
    expect(retrieved?.cwd).toBe('/new/dir');
    expect(retrieved?.totalInputTokens).toBe(150);
  });

  it('should delete a session', () => {
    const dummySession: SessionRecord = {
      sessionId: 'sess-123',
      currentModel: 'gemini-3.1-flash-lite',
      cwd: '/fake/dir',
      lastUsedAt: 1000000,
      currentTierIndex: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      eventSequenceCounter: 0,
      stateSnapshot: {} as any,
      conversationHistory: [],
      turns: [],
      copilotSession: null as any
    };

    saveSession(dummySession);
    expect(getSession('sess-123')).toBeDefined();

    deleteSession('sess-123');
    expect(getSession('sess-123')).toBeUndefined();
  });

  it('should save and retrieve escalations', () => {
    appendEscalation({
      sessionId: 'sess-escalate',
      summary: 'Test escalation',
      failedGate: 'budget_guard',
      failedGateFeedback: 'budget exceeded',
      retryHistory: [],
      stateSnapshot: {
        isRunning: false,
        retryCount: 0,
        currentTier: 'gemini-3.1-flash-lite',
        activeGate: undefined,
        hasFailureState: false,
        awaitingHuman: false,
      },
      conversationHistory: [{ role: 'user', content: 'hello' }],
      turns: [],
      cwd: '/workspace',
      currentModel: 'gemini'
    });

    const pending = getPendingEscalation('sess-escalate');
    expect(pending).toBeDefined();
    expect(pending?.summary).toBe('Test escalation');
    expect(pending?.failedGate).toBe('budget_guard');
    expect(pending?.stateSnapshot?.isRunning).toBe(false);

    updateEscalationStatus('sess-escalate', 'resolved');

    const noLongerPending = getPendingEscalation('sess-escalate');
    expect(noLongerPending).toBeUndefined();
  });
});

