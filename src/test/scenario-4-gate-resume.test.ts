import { describe, it, beforeAll, afterAll } from 'vitest';
import assert from 'node:assert';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
;
import { CapiProxy } from './harness/CapiProxy';

describe('Scenario 4: Human escalation and gate-resume', () => {
  let app: any;
  let server: any;
  let serverPort: number;
  let proxy: CapiProxy;

  beforeAll(async () => {
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
    await proxy.stop();
    await new Promise<void>((resolve) => {
      if (server) {
        server.close(() => resolve());
      } else {
        resolve();
      }
    });
  });

  it('Scenario 4: Human escalation and gate-resume', { timeout: 60000 }, async () => {
    const tempCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'scen4-'));
    const sessionId = 'resume-test-session-' + Math.random().toString(36).substring(2, 8);

    try {
      // Setup escalation: force fail runLint
      await proxy.setOverrides({ taskType: 'feature' });
      const snapshotPath = path.resolve(tempCwd, 'scenario4.yaml');
      fs.writeFileSync(snapshotPath, `conversations:
  - messages: # Initial Executor Attempt (fails)
      - role: assistant
        tool_calls: [{ id: "c1", type: "function", function: { name: "run_terminal_docker", arguments: "{\\"command\\":\\"ls\\"}" } }]
  - messages: # After resume (success)
      - role: assistant
        content: Proceeding based on human feedback.
`);
      await proxy.updateConfig({ filePath: snapshotPath, workDir: tempCwd });

      fs.writeFileSync(path.join(tempCwd, '.git'), 'gitdir: /fake/path');
      // Make lint fail
      fs.writeFileSync(path.join(tempCwd, 'package.json'), JSON.stringify({ scripts: { lint: "exit 1" } }));

      console.log('--- Phase 1: Initiating Escalation ---');
      const res = await fetch(`http://127.0.0.1:${serverPort}/api/copilot/gate-run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: 'Refactor the app.',
          model: 'gemini-3.1-flash-lite',
          cwd: tempCwd,
          sessionId,
          gates: ['runLint'],
          maxRetries: 0
        })
      });

      const stream = res.body;
      let escalated = false;
      if (stream) {
        for await (const chunk of stream as any) {
          const data = Buffer.from(chunk as ArrayBuffer).toString('utf-8');
          if (data.includes('loop.escalate_human')) escalated = true;
        }
      }
      assert.ok(escalated, 'Should have emitted loop.escalate_human');

      console.log('--- Phase 2: Resuming ---');
      const resumeRes = await fetch(`http://127.0.0.1:${serverPort}/api/copilot/gate-resume`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId,
          input: 'I fixed the lint manually, please continue.'
        })
      });

      const resumeStream = resumeRes.body;
      let resumedContent = '';
      if (resumeStream) {
        for await (const chunk of resumeStream as any) {
          resumedContent += Buffer.from(chunk as ArrayBuffer).toString('utf-8');
        }
      }
      assert.ok(resumedContent.includes('Proceeding based on human feedback.'), 'Should have resumed and used next snapshot entry');
      
    } finally {
      fs.rmSync(tempCwd, { recursive: true, force: true });
    }
  });
});
