import { describe, it, beforeAll, afterAll } from 'vitest';
import assert from 'node:assert';
import { serverHarness } from './harness/ServerHarness';
import { getExecCommand } from '../workspace';

describe('Server End-to-End Integration Tests', () => {
  beforeAll(async () => {
    await serverHarness.start();
  });

  afterAll(async () => {
    await serverHarness.stop();
  });

  it('E2E loop run with SSE streaming results', { timeout: 60000 }, async () => {
    console.log('Starting Integration Test for server.ts...');
    
    const { serverPort, proxy } = serverHarness;
    assert.ok(proxy);

    // Create unique sessionId and tempCwd
    const sessionId = 'session-' + Math.random().toString(36).substring(2, 8);
    const tempCwd = `git-worktree-${sessionId}`;
    const snapshotPath = process.cwd() + '/src/test/snapshots/gate_loop/single_retry_server_integration.yaml';
    
    const exec = getExecCommand();
    await exec(`mkdir -p '${tempCwd}'`);
    await exec(`echo '{"name":"mock-integration-workspace","scripts":{"lint":"echo \\"Lint Passed\\" && exit 0","test":"echo \\"FAIL: 2 tests failed\\\\ngate: failed\\" && exit 1"}}' > '${tempCwd}/package.json'`);
    await exec(`echo 'gitdir: /fake/path' > '${tempCwd}/.git'`);

    try {
      await proxy.updateConfig({
        filePath: snapshotPath,
        workDir: tempCwd,
      });

      // Override the taskType classifier to run the runTests gate
      await proxy.setOverrides({
        taskType: 'test-only'
      });
      
      // Send request to /api/copilot/gate-run
      console.log('Sending request to /api/copilot/gate-run');

      const res = await fetch(`http://127.0.0.1:${serverPort}/api/copilot/gate-run`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          prompt: 'Run the gate check.',
          model: 'claude-sonnet-4.5',
          cwd: tempCwd,
          gates: ['tests'],
          maxRetries: 1,
          sessionId: sessionId
        })
      });

      const stream = res.body;
      let finalData = '';
      
      if (stream) {
        for await (const chunk of stream as any) {
          finalData += Buffer.from(chunk as ArrayBuffer).toString('utf-8');
          // Look for the assistant's final response
          if (finalData.includes('The gate failed. 2 tests need fixing.')) {
             console.log('Found expected response in SSE stream!');
             break; 
          }
        }
      }
      
      if (!finalData.includes('The gate failed. 2 tests need fixing.')) {
        throw new Error('Did not find expected response. Final Data: ' + finalData);
      }
    } finally {
      await exec(`rm -rf '${tempCwd}'`);
    }
  });
});
