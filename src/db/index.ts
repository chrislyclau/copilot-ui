import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

export const isTestMode = process.env.NODE_ENV === 'test' || process.env.DIAGNOSTIC_MODE === 'true';

// Use /tmp for the databases to avoid polluting the workspace root and triggering
// file watcher/tracking layer resets.
const dbDir = '/tmp';
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

const dbPath = path.join(dbDir, isTestMode ? 'app-test.db' : 'app.db');
export const db = new Database(dbPath);

db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    sessionId TEXT PRIMARY KEY,
    currentModel TEXT,
    cwd TEXT,
    lastUsedAt INTEGER,
    currentTierIndex INTEGER,
    planVersions TEXT,
    totalInputTokens INTEGER,
    totalOutputTokens INTEGER,
    eventSequenceCounter INTEGER,
    stateSnapshot TEXT,
    conversationHistory TEXT,
    turns TEXT,
    diagnosticTrail TEXT
  );

  CREATE TABLE IF NOT EXISTS escalations (
    id TEXT PRIMARY KEY,
    sessionId TEXT,
    escalatedAt INTEGER,
    summary TEXT,
    failedGate TEXT,
    failedGateFeedback TEXT,
    retryHistory TEXT,
    status TEXT,
    stateSnapshot TEXT,
    conversationHistory TEXT,
    turns TEXT,
    cwd TEXT,
    currentModel TEXT
  );
`);
