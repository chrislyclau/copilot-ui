import { describe, it } from 'vitest';
import assert from 'node:assert';
import { CapiProxy } from './harness/CapiProxy';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { CopilotClient } from '../copilotSdk/boundary';

describe('Copilot SDK Client Integration Tests', () => {
  it('Runs integration test with mock CapiProxy playback', { timeout: 60000 }, async () => {
    console.log('Starting Integration Test with CapiProxy...');
    
    // 1. Start the proxy
    const proxy = new CapiProxy();
    const proxyUrl = await proxy.start();
    console.log(`CapiProxy listening at ${proxyUrl}`);

    // This test's tool handlers are fully mocked (no real command execution),
    // but workingDirectory is still kept isolated from the app's own source
    // tree as a defensive precaution rather than pointed at process.cwd().
    const tempWorkDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdk-integration-'));

    try {
      // 2. Set proxy dummy configurations
      await proxy.setCopilotUserByToken("fake-token", {
        login: "test-user",
        copilot_plan: "individual_pro",
        endpoints: {
          api: proxyUrl,
          telemetry: `${proxyUrl}/telemetry`,
        },
        analytics_tracking_id: "test-tracking-id",
      });

      const snapshotPath = path.resolve(process.cwd(), 'src/test/snapshots/gate_loop/single_retry.yaml');
      await proxy.updateConfig({
        filePath: snapshotPath,
        workDir: tempWorkDir,
      });
      console.log(`Loaded snapshot from ${snapshotPath}`);

      // 3. Construct CopilotClient pointing to the proxy
      const client = new CopilotClient({
        workingDirectory: tempWorkDir,
        logLevel: 'none',
        useLoggedInUser: false,
        env: {
          ...process.env,
          ...proxy.getProxyEnv(),
          COPILOT_API_URL: proxyUrl,
        }
      });

      await client.start();
      console.log('CopilotClient started.');

      try {
        // 4. Create Session 
        const session = await client.createSession({
          model: 'claude-sonnet-4.5',
          provider: {
            type: 'openai',
            baseUrl: proxyUrl,
            apiKey: 'test-api-key',
          },
          systemMessage: {
            mode: 'replace',
            content: 'Test System Message' 
          },
          tools: [
            {
              name: 'run_tests',
              description: 'Run the tests',
              parameters: { type: 'object', properties: {} },
              handler: async (args) => {
                console.log('Tool handler run_tests called with args:', args);
                return { status: 'failed', output: 'FAIL: 2 tests failed\ngate: failed' };
              }
            }
          ],
          streaming: false
        });

        console.log('Session created. Sending prompt...');

        // 5. Send message and check proxy playback
        const responseStream = await session.sendAndWait({ prompt: 'Run the gate check.' }, 30000);
        
        console.log('Got response. Response string:', responseStream);
        assert.ok(responseStream, 'Should receive non-empty simulation output response');
        
        await session.disconnect();
      } finally {
        await client.stop();
      }
    } finally {
      await proxy.stop();
      fs.rmSync(tempWorkDir, { recursive: true, force: true });
    }
  });
});
