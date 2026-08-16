import { describe, it, beforeAll, afterAll } from 'vitest';
import assert from 'node:assert';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
;
import { CapiProxy } from './harness/CapiProxy';

describe('Scenario 3: Mutation gate failure (SYS-REQ-004)', () => {
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

  it('Scenario 3: Mutation gate succeeds on nudge retry', { timeout: 60000 }, async () => {
    const tempCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'scen3-retry-'));
    const sessionId = 'session-' + Math.random().toString(36).substring(2, 8);
    try {
      await proxy.setOverrides({ taskType: 'feature' });
      const snapshotPath = path.resolve(tempCwd, 'scenario3-retry.yaml');
      fs.writeFileSync(snapshotPath, `conversations:
  - messages:
      - role: system
        content: \${system}
      - role: user
        content: \${user}
      - role: assistant
        content: I will now implement the feature by changing many files... (but I won't call any tools)
      - role: user
        content: \${user}
      - role: assistant
        content: ""
        tool_calls:
          - id: toolcall_1
            type: function
            function:
              name: run_terminal_docker
              arguments: '{"command": "echo hello"}'`);
      await proxy.updateConfig({ filePath: snapshotPath, workDir: tempCwd });
      fs.writeFileSync(path.join(tempCwd, '.git'), 'gitdir: /fake/path');
      const historyLenBefore = proxy.requestHistory.length;
      const res = await fetch(`http://127.0.0.1:${serverPort}/api/copilot/gate-run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: 'Implement a new user auth feature.',
          model: 'gemini-3.1-flash-lite',
          cwd: tempCwd,
          gates: ['runLint'],
          maxRetries: 0,
          sessionId
        })
      });
      const stream = res.body;
      let finalData = '';
      if (stream) {
        for await (const chunk of stream as any) {
          finalData += Buffer.from(chunk as ArrayBuffer).toString('utf-8');
        }
      }
      assert.ok(!finalData.includes('"gateName":"MutationGate"'), 'Should NOT fail with MutationGate on retry');

      // SYS-REQ-004 narrowed retry (issue #361): the retry must resume the
      // SAME session -- not spin up a fresh, history-less one -- so the
      // model still sees turn 1's context on the forced-tool retry turn.
      // Assert directly on what was actually sent to CAPI, rather than only
      // checking that a tool call eventually landed, since a brand-new
      // session could also produce a tool call while silently losing
      // context.
      const requestsThisTest = proxy.requestHistory.slice(historyLenBefore);
      const retryRequestSawPriorTurn = requestsThisTest.some((req: any) =>
        JSON.stringify(req.messages).includes(
          "I will now implement the feature by changing many files"
        )
      );
      assert.ok(
        retryRequestSawPriorTurn,
        "Narrowed retry should resume the original session: the retry's outgoing " +
          "request must still include turn 1's assistant message, proving " +
          "conversation history/context survived the retry rather than being " +
          "silently dropped by starting a fresh session."
      );
    } finally {
      fs.rmSync(tempCwd, { recursive: true, force: true });
    }
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

  it('Scenario 3: Mutation gate failure (SYS-REQ-004)', { timeout: 60000 }, async () => {
    const tempCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'scen3-'));
    const sessionId = 'session-' + Math.random().toString(36).substring(2, 8);

    try {
      await proxy.setOverrides({ taskType: 'feature' });
      const snapshotPath = path.resolve(tempCwd, 'scenario3.yaml');
      fs.writeFileSync(snapshotPath, `conversations:
  - messages:
      - role: system
        content: \${system}
      - role: user
        content: \${user}
      - role: assistant
        content: I will now implement the feature by changing many files... (but I won't call any tools)
`);
      await proxy.updateConfig({ filePath: snapshotPath, workDir: tempCwd });

      fs.writeFileSync(path.join(tempCwd, '.git'), 'gitdir: /fake/path');

      const res = await fetch(`http://127.0.0.1:${serverPort}/api/copilot/gate-run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: 'Implement a new user auth feature.',
          model: 'gemini-3.1-flash-lite',
          cwd: tempCwd,
          gates: ['runLint'],
          maxRetries: 0,
          sessionId
        })
      });

      const stream = res.body;
      let finalData = '';
      if (stream) {
        for await (const chunk of stream as any) {
          finalData += Buffer.from(chunk as ArrayBuffer).toString('utf-8');
        }
      }

      assert.ok(finalData.includes('"gateName":"MutationGate"'), 'Should fail with MutationGate');
      assert.ok(finalData.includes('Plain text explanations are blocked for mutation tasks'), 'Should include MutationGate feedback');
    } finally {
      fs.rmSync(tempCwd, { recursive: true, force: true });
    }
  });
});
