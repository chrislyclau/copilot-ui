import { getWorkspaceHostLocation } from "../workspace";
import { describe, it, beforeAll, afterAll } from 'vitest';
import assert from 'node:assert';
import { serverHarness } from './harness/ServerHarness';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

describe('Stream Token Timing and Mutation Guard Tests', () => {
  beforeAll(async () => {
    await serverHarness.start();
  });

  afterAll(async () => {
    await serverHarness.stop();
  });

  it('Ensures that delays between text chunks and tool blocks do not short-circuit the mutation validation gates', { timeout: 60000 }, async () => {
    console.log('Starting stream_token_timing integration test...');

    const { serverPort, proxy, proxyUrl } = serverHarness;
    assert.ok(proxy);

    const snapshotPath = path.resolve(process.cwd(), 'src/test/snapshots/gate_loop/stream_token_timing.yaml');
    
    const relativeCwd = 'stream-timing-' + Math.random().toString(36).substring(2, 8);
    const hostCwd = path.join(getWorkspaceHostLocation(), relativeCwd);
    fs.mkdirSync(hostCwd, { recursive: true });
    
    fs.writeFileSync(path.join(hostCwd, '.git'), 'gitdir: /fake/path');
    
    // Write package.json with exit 0 lint script so validation gate succeeds instantly
    fs.writeFileSync(path.join(hostCwd, 'package.json'), JSON.stringify({
      name: 'mock-workspace',
      scripts: {
        lint: 'echo "Success" && exit 0'
      }
    }, null, 2));

    try {
      await proxy.updateConfig({
        filePath: snapshotPath,
        workDir: hostCwd,
      });

      console.log('Sending request to /api/copilot/gate-run');

      const res = await fetch(`http://127.0.0.1:${serverPort}/api/copilot/gate-run`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          prompt: 'Modify index.html to add a div.',
          model: 'claude-sonnet-4.5',
          cwd: relativeCwd,
          gates: ['runLint'],
          maxRetries: 1
        })
      });

      const stream = res.body;
      let finalData = '';
      
      if (stream) {
        for await (const chunk of stream as any) {
          finalData += Buffer.from(chunk as ArrayBuffer).toString('utf-8');
        }
      }

      console.log('Finished streaming. Verifying stream data...');

      // Verify that we do NOT see a MutationGate failure because the delayed tool call was successfully registered before completion
      assert.ok(
        !finalData.includes('MutationGate'),
        'Delayed tool stream should not trigger MutationGate verification block failure!'
      );

      // Verify tool result event is streamed cleanly
      assert.ok(
        finalData.includes('tool.execution_complete'),
        'Should correctly stream back the delayed tool execution result'
      );

      assert.ok(
        finalData.includes('loop.complete'),
        'Should complete loop cleanly'
      );

      console.log('✓ Stream token timing and mutation gate verification verified!');
    } finally {
      if (fs.existsSync(hostCwd)) {
        fs.rmSync(hostCwd, { recursive: true, force: true });
      }
    }
  });
});
