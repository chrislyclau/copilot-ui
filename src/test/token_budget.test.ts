import { describe, it, beforeAll, afterAll, expect, beforeEach } from 'vitest';
import { serverHarness } from './harness/ServerHarness';

describe('Token Budget Exhaustion', () => {
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

  it('should escalate to human when MAX_SESSION_TOKEN_BUDGET is exceeded', { timeout: 30000 }, async () => {
    const { serverPort, proxy, serverModule } = serverHarness;
    const activeSessions = serverModule.activeSessions;
    const db = serverModule.db;
    const getPendingEscalation = serverModule.getPendingEscalation;


    const sessionId = 'test-token-session-1';
    const fs = await import('fs');
    const path = await import('path');
    const os = await import('os');
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'token-'));
    const snapPath = path.join(tempDir, 'snap.yaml');
    
    // We just need a single passing interaction
    fs.writeFileSync(snapPath, `conversations:\n  - messages:\n      - role: assistant\n        content: "I am token!"`);
    await proxy!.updateConfig({ filePath: snapPath, workDir: tempDir });

    const reqPromise = fetch(`http://localhost:${serverPort}/api/copilot/gate-run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'continue', sessionId }),
    });

    // Wait until it initializes the session
    for (let i = 0; i < 100; i++) {
      if (activeSessions.has(sessionId)) {
        break;
      }
      await new Promise(r => setTimeout(r, 100));
    }

    expect(activeSessions.has(sessionId)).toBeTruthy();

    // Now wait for the run to complete - it should hit the loop and escalate
    const response = await reqPromise;
    expect(response.status).toBe(200);

    if (response.body) {
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value);
        if (chunk.includes('composer.plan') || chunk.includes('loop.warning')) {
          const sess = activeSessions.get(sessionId!);
          if (sess) {
            sess.totalInputTokens = 500001;
          }
        }
      }
    }

    const pending = getPendingEscalation(sessionId!);
    expect(pending).toBeDefined();
    expect(pending?.summary).toContain('Token budget exhausted');
  });
});

