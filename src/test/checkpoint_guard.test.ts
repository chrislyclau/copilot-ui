import { describe, it, beforeAll, afterAll } from 'vitest';
import assert from 'node:assert';
import { serverHarness } from './harness/ServerHarness';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { getWorkspaceHostLocation } from '../workspace';

describe('Checkpoint Guard REST API Integration Tests', () => {
  beforeAll(async () => {
    await serverHarness.start();
  });

  afterAll(async () => {
    await serverHarness.stop();
  });

  it('Verifies that calling /api/copilot/checkpoint/restore during an active loop returns 409 Conflict', { timeout: 60000 }, async () => {
    console.log('Starting checkpoint_guard integration test...');
    
    const { serverPort, proxy, proxyUrl } = serverHarness;
    assert.ok(proxy);

    const snapshotPath = path.resolve(process.cwd(), 'src/test/snapshots/gate_loop/panic_stop.yaml');
    
    const relativeCwd = 'checkpoint-' + Math.random().toString(36).substring(2, 8);
    const hostCwd = path.join(getWorkspaceHostLocation(), relativeCwd);
    fs.mkdirSync(hostCwd, { recursive: true });
    
    fs.writeFileSync(path.join(hostCwd, '.git'), 'gitdir: /fake/path');
    
    fs.writeFileSync(path.join(hostCwd, 'package.json'), JSON.stringify({
      name: 'mock-checkpoint-workspace',
      scripts: {
        lint: 'echo "Lint Passed" && exit 0'
      }
    }, null, 2));

    try {
      await proxy.updateConfig({
        filePath: snapshotPath,
        workDir: hostCwd,
      });
      
      const sessionId = 'test-checkpoint-session-123';
      console.log(`Sending start request to /api/copilot/gate-run with sessionId: ${sessionId}`);

      // Trigger active stream run
      const runRes = await fetch(`http://127.0.0.1:${serverPort}/api/copilot/gate-run`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          prompt: 'Help me build a server.',
          model: 'claude-sonnet-4.5',
          cwd: relativeCwd,
          sessionId,
          gates: ['runLint'],
          maxRetries: 1
        })
      });

      const reader = runRes.body?.getReader();
      let receivedData = '';
      let checkpointRestoreTriggered = false;

      if (reader) {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const chunkStr = Buffer.from(value).toString('utf-8');
          receivedData += chunkStr;

          // Trigger checkpoint restore when session is actively running
          if (!checkpointRestoreTriggered && receivedData.length > 0) {
            checkpointRestoreTriggered = true;
            console.log('Received active stream bytes. Triggering conflict checkpoint/restore request...');
            
            // Slight delay to ensure status registers as active in the map
            await new Promise(r => setTimeout(r, 200));

            console.log(`Sending Restore Checkpoint request for sessionId: ${sessionId}`);
            const restoreRes = await fetch(`http://127.0.0.1:${serverPort}/api/copilot/checkpoint/restore`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json'
              },
              body: JSON.stringify({
                sessionId,
                commitSha: 'mock_sha_checkpoint_123',
                taskLabel: 'Test Task Label'
              })
            });

            const restoreData = await restoreRes.json();
            console.log('Restore POST conflict response:', restoreData);
            assert.strictEqual(restoreRes.status, 409, 'Restore must return HTTP 409 Conflict when cycle is running');
            assert.strictEqual(restoreData.success, false, 'Restore response success must be false');
            assert.ok(restoreData.error.includes('Cannot restore checkpoint'), 'Restore error message should reflect run blocker');
          }
        }
      }

      console.log('Finished streaming loop.');
    } finally {
      // Clean up temporary workspace
      if (fs.existsSync(hostCwd)) {
        fs.rmSync(hostCwd, { recursive: true, force: true });
      }
    }
  });

  it('Verifies that calling /api/copilot/checkpoint/restore with explicitCwd during an active loop in that cwd returns 409 Conflict', { timeout: 60000 }, async () => {
    console.log('Starting checkpoint_guard explicitCwd integration test...');
    
    const { serverPort, proxy, proxyUrl } = serverHarness;
    assert.ok(proxy);

    const snapshotPath = path.resolve(process.cwd(), 'src/test/snapshots/gate_loop/panic_stop.yaml');
    
    const tempCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'checkpoint-explicit-'));
    fs.writeFileSync(path.join(tempCwd, '.git'), 'gitdir: /fake/path');
    
    fs.writeFileSync(path.join(tempCwd, 'package.json'), JSON.stringify({
      name: 'mock-checkpoint-workspace-explicit',
      scripts: {
        lint: 'echo "Lint Passed" && exit 0'
      }
    }, null, 2));

    try {
      await proxy.updateConfig({
        filePath: snapshotPath,
        workDir: tempCwd,
      });
      
      const sessionId = 'test-checkpoint-session-explicit';
      console.log(`Sending start request to /api/copilot/gate-run with sessionId: ${sessionId}`);

      // Trigger active stream run
      const runRes = await fetch(`http://127.0.0.1:${serverPort}/api/copilot/gate-run`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          prompt: 'Help me build a server.',
          model: 'claude-sonnet-4.5',
          cwd: tempCwd,
          sessionId,
          gates: ['runLint'],
          maxRetries: 1
        })
      });

      const reader = runRes.body?.getReader();
      let receivedData = '';
      let checkpointRestoreTriggered = false;

      if (reader) {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const chunkStr = Buffer.from(value).toString('utf-8');
          receivedData += chunkStr;

          // Trigger checkpoint restore with explicitCwd when session is actively running
          if (!checkpointRestoreTriggered && receivedData.length > 0) {
            checkpointRestoreTriggered = true;
            console.log('Received active stream bytes. Triggering conflict checkpoint/restore request with explicitCwd...');
            
            // Slight delay to ensure status registers as active in the map
            await new Promise(r => setTimeout(r, 200));

            console.log(`Sending Restore Checkpoint request for explicitCwd: ${tempCwd}`);
            const restoreRes = await fetch(`http://127.0.0.1:${serverPort}/api/copilot/checkpoint/restore`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json'
              },
              body: JSON.stringify({
                cwd: tempCwd,
                commitSha: 'mock_sha_checkpoint_123',
                taskLabel: 'Test Task Label'
              })
            });

            const restoreData = await restoreRes.json();
            console.log('Restore POST explicitCwd conflict response:', restoreData);
            assert.strictEqual(restoreRes.status, 409, 'Restore must return HTTP 409 Conflict when cycle is running in the CWD');
            assert.strictEqual(restoreData.success, false, 'Restore response success must be false');
            assert.ok(restoreData.error.includes('Cannot restore checkpoint'), 'Restore error message should reflect run blocker');
          }
        }
      }

      console.log('Finished streaming loop.');
    } finally {
      // Clean up temporary workspace
      if (fs.existsSync(tempCwd)) {
        fs.rmSync(tempCwd, { recursive: true, force: true });
      }
    }
  });
});
