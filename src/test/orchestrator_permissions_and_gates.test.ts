import { describe, it, beforeAll, afterAll, expect, beforeEach } from 'vitest';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { handleGateRunPermission, setGlobalAutoApproveAll } from '../orchestrator/gateLoop';
import { activeSessions, sseResToSessionId, activeLocks } from '../orchestrator/sessionState';
import { CapiProxy } from './harness/CapiProxy';

describe('handleGateRunPermission Unit Tests', () => {
  const originalEnv = process.env.NODE_ENV;

  beforeEach(() => {
    activeSessions.clear();
    process.env.NODE_ENV = 'production'; // Set to production so the environment check doesn't auto-approve everything
    setGlobalAutoApproveAll(false);
  });

  afterAll(() => {
    process.env.NODE_ENV = originalEnv;
    setGlobalAutoApproveAll(true);
  });

  it('should auto-approve safe utility tools', async () => {
    const safeTools = ['submit_audit_findings', 'ambiguity_check', 'composer_router'];
    for (const tool of safeTools) {
      const res = await handleGateRunPermission({ toolName: tool } as any);
      expect(res.kind).toBe('approve-once');
    }
  });

  it('should block unauthorized or unknown tools', async () => {
    const unauthorizedTools = ['delete_database', 'arbitrary_bash', 'some_unknown_tool'];
    for (const tool of unauthorizedTools) {
      const res = await handleGateRunPermission({ toolName: tool } as any);
      expect(res.kind).toBe('reject');
      expect((res as any).reason).toContain('is not authorized');
    }
  });

  it('should block allowed orchestrator tools if there is no active running session context', async () => {
    const allowedTools = ['run_terminal_docker', 'run_tests'];
    for (const tool of allowedTools) {
      const res = await handleGateRunPermission({ toolName: tool } as any);
      expect(res.kind).toBe('reject');
      expect((res as any).reason).toContain('active, authorized orchestration session');
    }
  });

  it('should approve allowed orchestrator tools when there is an active running session', async () => {
    // Inject active running session
    activeSessions.set('test-session', {
      sessionId: 'test-session',
      currentModel: 'gemini-3.1-flash-lite',
      cwd: '/tmp',
      lastUsedAt: Date.now(),
      currentTierIndex: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      eventSequenceCounter: 0,
      stateSnapshot: {
        isRunning: true,
        awaitingHuman: false,
        retryCount: 0,
        currentTier: 'gemini-3.1-flash-lite',
        activeGate: undefined,
        hasFailureState: false,
      },
      conversationHistory: [],
      turns: [],
      copilotSession: {} as any,
    });

    const allowedTools = ['run_terminal_docker', 'run_tests'];
    for (const tool of allowedTools) {
      const res = await handleGateRunPermission({ toolName: tool } as any);
      expect(res.kind).toBe('approve-once');
    }
  });

  it('should still auto-approve when process.env.NODE_ENV is test', async () => {
    process.env.NODE_ENV = 'test';
    const res = await handleGateRunPermission({ toolName: 'run_terminal_docker' } as any);
    expect(res.kind).toBe('approve-once');
  });
});

describe('Orchestration gate-run and resume Integration Tests', () => {
  let app: any;
  let server: any;
  let serverPort: number;
  let proxy: CapiProxy;
  let originalEnv: string | undefined;

  beforeAll(async () => {
    originalEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'test';

    proxy = new CapiProxy();
    const proxyUrl = await proxy.start();
    process.env.COPILOT_API_URL = proxyUrl;
    process.env.GEMINI_API_KEY = 'test-key';

    const serverModule = await import('../../server');
    app = serverModule.app;

    server = app.listen(0);
    const addr = server.address() as any;
    serverPort = addr.port;
  });

  afterAll(async () => {
    process.env.NODE_ENV = originalEnv;
    await proxy.stop();
    await new Promise<void>((resolve) => {
      if (server) {
        server.close(() => resolve());
      } else {
        resolve();
      }
    });
  });

  it('Integration: POST /api/copilot/gate-run should manage state and SSE flow', { timeout: 30000 }, async () => {
    const tempCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'scen-perms-'));
    const sessionId = 'session-int-test';

    try {
      await proxy.setOverrides({ taskType: 'style-only' });
      
      const snapshotPath = path.resolve(tempCwd, 'scenario.yaml');
      fs.writeFileSync(snapshotPath, `conversations:
  - messages:
      - role: assistant
        content: Approved style edits.
`);
      await proxy.updateConfig({ filePath: snapshotPath, workDir: tempCwd });

      fs.writeFileSync(path.join(tempCwd, '.git'), 'gitdir: /fake/path');
      fs.writeFileSync(path.join(tempCwd, 'package.json'), JSON.stringify({ name: 'test-app', scripts: { lint: "echo 'lint ok'" } }));

      // Run gate-run
      const res = await fetch(`http://127.0.0.1:${serverPort}/api/copilot/gate-run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: 'Tweak layout colors',
          model: 'gemini-3.1-flash-lite',
          cwd: tempCwd,
          gates: ['runLint'],
          sessionId
        })
      });

      expect(res.status).toBe(200);

      const stream = res.body;
      let finalData = '';
      if (stream) {
        for await (const chunk of stream as any) {
          finalData += Buffer.from(chunk as ArrayBuffer).toString('utf-8');
        }
      }

      // Assert that we received events and processed them
      expect(finalData).toContain('session.idle');
      expect(finalData).toContain('taskType');
      
      // State snapshot should reflect finished loop successfully
      const sess = activeSessions.get(sessionId);
      expect(sess).toBeDefined();
      expect(sess?.stateSnapshot?.isRunning).toBe(false);

    } finally {
      fs.rmSync(tempCwd, { recursive: true, force: true });
    }
  });

  it('Integration: POST /api/copilot/gate-resume should support stateless resumption', { timeout: 30000 }, async () => {
    const tempCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'scen-resume-'));
    const sessionId = 'session-resume-test';

    try {
      await proxy.setOverrides({ taskType: 'style-only' });
      
      const snapshotPath = path.resolve(tempCwd, 'scenario.yaml');
      fs.writeFileSync(snapshotPath, `conversations:
  - messages:
      - role: assistant
        content: Resumed style edits.
`);
      await proxy.updateConfig({ filePath: snapshotPath, workDir: tempCwd });

      fs.writeFileSync(path.join(tempCwd, '.git'), 'gitdir: /fake/path');
      fs.writeFileSync(path.join(tempCwd, 'package.json'), JSON.stringify({ name: 'test-app', scripts: { lint: "echo 'lint ok'" } }));

      // Save session in SQLite DB and clear activeSessions to test real rehydration
      const dummySession = {
        sessionId,
        currentModel: 'gemini-3.1-flash-lite',
        cwd: tempCwd,
        lastUsedAt: Date.now(),
        currentTierIndex: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        eventSequenceCounter: 0,
        stateSnapshot: {
          isRunning: true,
          awaitingHuman: true,
          retryCount: 0,
          currentTier: 'gemini-3.1-flash-lite',
          activeGate: 'runLint',
          hasFailureState: false,
          currentPrompt: 'Please check this project.',
        },
        conversationHistory: [],
        turns: [],
        copilotSession: null as any,
      };

      const { saveSession } = await import('../db/sessionStore');
      saveSession(dummySession);
      activeSessions.clear();

      // Resume gate-run via resume path
      const res = await fetch(`http://127.0.0.1:${serverPort}/api/copilot/gate-resume`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: 'Please check this project.',
          input: 'Lint succeeded manually',
          model: 'gemini-3.1-flash-lite',
          cwd: tempCwd,
          sessionId
        })
      });

      expect(res.status).toBe(200);

      const stream = res.body;
      let finalData = '';
      if (stream) {
        for await (const chunk of stream as any) {
          finalData += Buffer.from(chunk as ArrayBuffer).toString('utf-8');
        }
      }

      // Assert that we resumed and successfully ran to idle
      expect(finalData).toContain('session.idle');

      const sess = activeSessions.get(sessionId);
      expect(sess).toBeDefined();
      expect(sess?.stateSnapshot?.isRunning).toBe(false);
      expect(sess?.stateSnapshot?.awaitingHuman).toBe(false);

    } finally {
      fs.rmSync(tempCwd, { recursive: true, force: true });
    }
  });
});
