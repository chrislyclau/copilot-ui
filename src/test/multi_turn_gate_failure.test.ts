import { getWorkspaceHostLocation } from "../workspace";
import { describe, it, beforeAll, afterAll } from 'vitest';
import assert from 'node:assert';
import { serverHarness } from './harness/ServerHarness';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

describe('Multi-Turn Gate Failure Persistence Tests', () => {
  beforeAll(async () => {
    await serverHarness.start();
  });

  afterAll(async () => {
    await serverHarness.stop();
  });

  it('Verifies that failedGateFeedback persists across distinct loop retry boundaries', { timeout: 60000 }, async () => {
    console.log('Starting multi_turn_gate_failure integration test...');
    
    const { serverPort, proxy, proxyUrl } = serverHarness;
    assert.ok(proxy);

    const snapshotPath = path.resolve(process.cwd(), 'src/test/snapshots/gate_loop/multi_turn_gate_failure.yaml');
    
    // Set up a mock workspaces directory under the OS temp root
    const relativeCwd = 'multi-turn-' + Math.random().toString(36).substring(2, 8);
    const hostCwd = path.join(getWorkspaceHostLocation(), relativeCwd);
    fs.mkdirSync(hostCwd, { recursive: true });
    
    fs.writeFileSync(path.join(hostCwd, '.git'), 'gitdir: /fake/path');
    
    // Write package.json with a custom lint command that triggers our turn-aware script
    fs.writeFileSync(path.join(hostCwd, 'package.json'), JSON.stringify({
      name: 'mock-workspace',
      scripts: {
        lint: 'node lint.js'
      }
    }, null, 2));

    // Write lint.js turn-aware compiler check simulator
    fs.writeFileSync(path.join(hostCwd, 'lint.js'), `
      const fs = require('fs');
      const path = require('path');
      const countFile = path.join(__dirname, 'count.txt');
      let count = 0;
      if (fs.existsSync(countFile)) {
        count = parseInt(fs.readFileSync(countFile, 'utf8').trim(), 10);
      }
      count++;
      fs.writeFileSync(countFile, String(count), 'utf8');
      
      if (count === 1) {
        console.log('FAIL: Turn 1 compiler failure - failedGateFeedback persists');
        process.exit(1);
      } else if (count === 2) {
        console.log('FAIL: Turn 2 compiler failure - failedGateFeedback persists');
        process.exit(1);
      } else {
        console.log('SUCCESS: Turn 3 compiler success');
        process.exit(0);
      }
    `);

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
          prompt: 'Run the validation checks.',
          model: 'claude-sonnet-4.5',
          cwd: relativeCwd,
          gates: ['runLint'],
          maxRetries: 2
        })
      });

      const stream = res.body;
      let finalData = '';
      
      if (stream) {
        for await (const chunk of stream as any) {
          finalData += Buffer.from(chunk as ArrayBuffer).toString('utf-8');
        }
      }

      console.log('Finished streaming. Verifying telemetry...');
      
      // Assert that we have retry records highlighting both persisting failed compiler outputs
      assert.ok(
        finalData.includes('Turn 1 compiler failure - failedGateFeedback persists'),
        'Should persist and output Turn 1 failure'
      );
      assert.ok(
        finalData.includes('Turn 2 compiler failure - failedGateFeedback persists'),
        'Should persist and output Turn 2 failure'
      );
      assert.ok(
        finalData.includes('SUCCESS: Turn 3 compiler success'),
        'Should eventually pass and output Turn 3 success'
      );
      assert.ok(
        finalData.includes('loop.complete'),
        'Should complete loop cleanly'
      );
      
      console.log('✓ Multi-Turn gate failure persistence verified!');
    } finally {
      // Clean up temporary workspace
      if (fs.existsSync(hostCwd)) {
        fs.rmSync(hostCwd, { recursive: true, force: true });
      }
    }
  });
});
