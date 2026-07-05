import { describe, it, beforeAll, afterAll } from 'vitest';
import assert from 'node:assert';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
;
import { CapiProxy } from './harness/CapiProxy';

describe('Scenario 2: Composer router picks non-feature taskType (style-only)', () => {
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

  it('Scenario 2: Composer router picks non-feature taskType (style-only)', { timeout: 60000 }, async () => {
    const tempCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'scen2-'));
    const sessionId = 'session-' + Math.random().toString(36).substring(2, 8);

    try {
      await proxy.setOverrides({ taskType: 'style-only' });
      
      const snapshotPath = path.resolve(tempCwd, 'scenario2.yaml');
      fs.writeFileSync(snapshotPath, `conversations:
  - messages:
      - role: assistant
        content: Style looks good.
`);
      await proxy.updateConfig({ filePath: snapshotPath, workDir: tempCwd });

      fs.writeFileSync(path.join(tempCwd, '.git'), 'gitdir: /fake/path');
      fs.writeFileSync(path.join(tempCwd, 'package.json'), JSON.stringify({ scripts: { lint: "echo 'lint ok'" } }));

      const res = await fetch(`http://127.0.0.1:${serverPort}/api/copilot/gate-run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: 'Change the background color to blue.',
          model: 'gemini-3.1-flash-lite',
          cwd: tempCwd,
          gates: ['runLint', 'runTests', 'runAudit'],
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

      assert.ok(finalData.includes('"taskType":"style-only"'), 'Should reflect style-only task type');
      assert.ok(finalData.includes('"gateName":"runLint"'), 'Should run runLint');
      assert.ok(!finalData.includes('"gateName":"runTests"'), 'Should NOT run runTests');
      assert.ok(!finalData.includes('"gateName":"runAudit"'), 'Should NOT run runAudit');
    } finally {
      fs.rmSync(tempCwd, { recursive: true, force: true });
    }
  });
});
