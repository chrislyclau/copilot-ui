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
