import { describe, it, beforeAll, afterAll } from 'vitest';
import assert from 'node:assert';
import { serverHarness } from './harness/ServerHarness';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { getWorkspaceHostLocation } from "../workspace";

describe('Model Escalation Integration Tests', () => {
  beforeAll(async () => {
    await serverHarness.start();
  });

  afterAll(async () => {
    await serverHarness.stop();
  });

  it('Verifies model escalation upgrade progression on persistent gate setbacks', { timeout: 60000 }, async () => {
    console.log('Starting model_escalation integration test...');
    
    const { serverPort, proxy, proxyUrl } = serverHarness;
    assert.ok(proxy);

    const snapshotPath = path.resolve(process.cwd(), 'src/test/snapshots/gate_loop/model_escalation.yaml');
    
    // Set up a mock workspaces directory under the OS temp root via workspace host location
    const relativeCwd = 'escalation-' + Math.random().toString(36).substring(2, 8);
    const tempCwd = path.join(getWorkspaceHostLocation(), relativeCwd);
    fs.mkdirSync(tempCwd, { recursive: true });
    fs.writeFileSync(path.join(tempCwd, '.git'), 'gitdir: /fake/path');
    
    // Write package.json with custom check-counter lint script
    fs.writeFileSync(path.join(tempCwd, 'package.json'), JSON.stringify({
      name: 'mock-escalation-workspace',
      scripts: {
        lint: 'node lint.js',
        test: 'exit 0',
        audit: 'exit 0'
      }
    }, null, 2));

    // Write turn-aware script: fails first twice (for first tier and its retry), then succeeds on third
    fs.writeFileSync(path.join(tempCwd, 'lint.js'), `
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
        console.log('FAIL: Turn 1 lint failed');
        process.exit(1);
      } else if (count === 2) {
        console.log('FAIL: Turn 2 lint failed');
        process.exit(1);
      } else {
        console.log('SUCCESS: Turn 3 lint passed on escalated model');
        process.exit(0);
      }
    `);

    try {
      await proxy.updateConfig({
        filePath: snapshotPath,
        workDir: tempCwd,
      });
      
      console.log('Sending request to /api/copilot/gate-run with model tier start: gemini-3.1-flash-lite');

      const res = await fetch(`http://127.0.0.1:${serverPort}/api/copilot/gate-run`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          prompt: 'Perform model escalation check.',
          model: 'gemini-3.1-flash-lite',
          cwd: relativeCwd,
          gates: ['runLint'],
          maxRetries: 1 // 1 retry on baseline, then escalate
        })
      });

      const stream = res.body;
      let finalData = '';
      
      if (stream) {
        for await (const chunk of stream as any) {
          finalData += Buffer.from(chunk as ArrayBuffer).toString('utf-8');
        }
      }

      console.log('Finished stream retrieval. \nfinalData:\n', finalData);
      console.log('Verifying model escalation events...');
      
      // Assert:
      // 1. Should have run lint with FAIL of turn 1 and turn 2
      assert.ok(
        finalData.includes('Turn 1 lint failed'),
        'Should include turn 1 failure'
      );
      assert.ok(
        finalData.includes('Turn 2 lint failed'),
        'Should include turn 2 failure'
      );
      
      // 2. Should have run lint with SUCCESS of turn 3 on gemini-3.5-flash
      assert.ok(
        finalData.includes('SUCCESS: Turn 3 lint passed on escalated model'),
        'Should include turn 3 success on escalated model'
      );

      // 3. Should contain loop.retry indicating escalation upgrade
      assert.ok(
        finalData.includes('loop.retry'),
        'Should emit loop.retry'
      );

      // 4. Verification that model upgraded to gemini-3.5-flash
      assert.ok(
        finalData.includes('gemini-3.5-flash'),
        'Should contain the escalated model tier in output history'
      );

      // 5. Verification that it completed successfully
      assert.ok(
        finalData.includes('loop.complete'),
        'Should complete loop successfully'
      );

      console.log('✓ Model escalation integration test passed!');
    } finally {
      // Clean up temporary workspace
      if (fs.existsSync(tempCwd)) {
        fs.rmSync(tempCwd, { recursive: true, force: true });
      }
    }
  });
});
