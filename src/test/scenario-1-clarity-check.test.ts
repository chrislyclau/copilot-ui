import { describe, it, beforeAll, afterAll } from 'vitest';
import assert from 'node:assert';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
;
import { CapiProxy } from './harness/CapiProxy';

describe('Scenario 1: Clarity check fails (score < 0.85) -> loop.clarity_check_failed', () => {
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
    await new Promise<void>((resolve) => server.on('listening', resolve));
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

  it('Scenario 1: Clarity check fails (score < 0.85)', { timeout: 60000 }, async () => {
    const tempCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'scen1-'));
    const sessionId = 'session-' + Math.random().toString(36).substring(2, 8);

    try {
      await proxy.setOverrides({ clarityScore: 0.5, missingVariables: ['target architecture', 'language preferences'] });
      
      fs.writeFileSync(path.join(tempCwd, '.git'), 'gitdir: /fake/path');

      const res = await fetch(`http://127.0.0.1:${serverPort}/api/copilot/gate-run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: 'Build something vague.',
          model: 'gemini-3.1-flash-lite',
          cwd: tempCwd,
          gates: ['runLint'],
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

      assert.ok(finalData.includes('loop.clarity_check_failed'), 'Should emit loop.clarity_check_failed');
      assert.ok(finalData.includes('"score":0.5'), 'Should reflect the low score');
      assert.ok(finalData.includes('target architecture'), 'Should include missing variables');
      
    } finally {
      fs.rmSync(tempCwd, { recursive: true, force: true });
    }
  });
});
