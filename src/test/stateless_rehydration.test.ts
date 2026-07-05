import { describe, it, beforeAll, afterAll, expect, beforeEach } from 'vitest';
import { serverHarness } from './harness/ServerHarness';

describe('Stateless Rehydration & Crash Recovery', () => {
  beforeAll(async () => {
    await serverHarness.start();
  });

  afterAll(async () => {
    await serverHarness.stop();
  });

  beforeEach(() => {
    if (serverHarness.serverModule) {
      serverHarness.serverModule.db.prepare('DELETE FROM sessions').run();
      serverHarness.serverModule.db.prepare('DELETE FROM escalations').run();
      serverHarness.serverModule.activeSessions.clear();
    }
  });

  it('should rehydrate session from SQLite when activeSessions is empty', { timeout: 30000 }, async () => {
    const { serverPort, proxy, serverModule } = serverHarness;
    const activeSessions = serverModule.activeSessions;
    const db = serverModule.db;

    const fs = await import('fs');
    const path = await import('path');
    const os = await import('os');
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stateless-'));
    const snapPath = path.join(tempDir, 'snap.yaml');
    
    // First interaction: runs normally
    // Second interaction: runs normally
    fs.writeFileSync(snapPath, `conversations:\n  - messages:\n      - role: assistant\n        content: "I am ready."\n  - messages:\n      - role: assistant\n        content: "I am resumed."`);
    await proxy!.updateConfig({ filePath: snapPath, workDir: tempDir });

    const sessionId = 'test-session-1';

    // Send first request to create session
    console.log('[Test] Sending fetch request...');
    const createRes = await fetch(`http://localhost:${serverPort}/api/copilot/gate-run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'start', sessionId }),
    });
    console.log('[Test] fetch returned headers! status:', createRes.status);
    
    expect(createRes.status).toBe(200);

    if (createRes.body) {
      const reader = createRes.body.getReader();
      while (true) {
        const { done } = await reader.read();
        if (done) break;
      }
    }

    const activeSessionRecord = activeSessions.get(sessionId);
    expect(activeSessionRecord).toBeDefined();

    console.log('[Test] Before clear, DB contains:', db.prepare('SELECT sessionId FROM sessions').all());
    const row = db.prepare('SELECT * FROM sessions WHERE sessionId = ?').get(sessionId);
    console.log('[Test] DB row for session:', !!row);

    // Clear memory cache, simulating a restart
    activeSessions.clear();
    serverModule.activeLocks.clear();
    expect(activeSessions.has(sessionId)).toBe(false);

    // Now resume, which should force rehydration
    const resumeRes = await fetch(`http://localhost:${serverPort}/api/copilot/gate-resume`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'continue', sessionId }),
    });

    expect(resumeRes.status).toBe(200);

    // Drain stream
    if (resumeRes.body) {
      const reader = resumeRes.body.getReader();
      while (true) {
        const { done } = await reader.read();
        if (done) break;
      }
    }

    // Should be back in memory
    expect(activeSessions.has(sessionId)).toBe(true);
    
    activeSessions.delete(sessionId);
  });
});

