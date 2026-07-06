import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

export const isTestMode = process.env.NODE_ENV === 'test';

// Use /tmp for the databases to avoid polluting the workspace root and triggering
// file watcher/tracking layer resets.
const dbDir = '/tmp';
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

const dbPath = path.join(dbDir, isTestMode ? 'app-test.db' : 'app.db');
export const db = new Database(dbPath);

db.exec(`
  CREATE TABLE IF NOT EXISTS specs (
    specId TEXT PRIMARY KEY,
    filePath TEXT NOT NULL,        -- path to spec.md in workspace
    version TEXT NOT NULL,         -- git SHA at time of decomposition
    createdAt INTEGER
  );

  CREATE TABLE IF NOT EXISTS tasks (
    taskId TEXT PRIMARY KEY,
    specId TEXT REFERENCES specs(specId),
    specVersion TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    status TEXT CHECK(status IN ('pending','running','blocked','done','stale','superseded')) DEFAULT 'pending',
    touches TEXT,                  -- JSON array of file paths/globs
    dependsOn TEXT,                -- JSON array of taskIds
    branchName TEXT,
    blockedReason TEXT,
    createdAt INTEGER,
    updatedAt INTEGER
  );

  CREATE TABLE IF NOT EXISTS sessions (
    sessionId TEXT PRIMARY KEY,
    taskId TEXT REFERENCES tasks(taskId),
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

try {
  db.prepare('ALTER TABLE sessions ADD COLUMN taskId TEXT').run();
} catch (e) {
  // Ignored if column already exists or table is empty
}
