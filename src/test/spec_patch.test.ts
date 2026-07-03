import { getWorkspaceHostLocation } from "../workspace";
import { describe, it, beforeAll, afterAll } from 'vitest';
import assert from 'node:assert';
import { serverHarness } from './harness/ServerHarness';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

describe('Spec Patch REST API Integration Tests', () => {
  beforeAll(async () => {
    await serverHarness.start();
  });

  afterAll(async () => {
    await serverHarness.stop();
  });

  it('Verifies that calling /api/copilot/spec-patch updates the spec file', { timeout: 60000 }, async () => {
    console.log('Starting spec_patch integration test...');
    
    const { serverPort, proxy, proxyUrl } = serverHarness;
    assert.ok(proxy);

    const snapshotPath = path.resolve(process.cwd(), 'src/test/snapshots/gate_loop/spec_patch.yaml');
    
    const relativeCwd = 'spec-patch-' + Math.random().toString(36).substring(2, 8);
    const hostCwd = path.join(getWorkspaceHostLocation(), relativeCwd);
    fs.mkdirSync(hostCwd, { recursive: true });
    
    fs.writeFileSync(path.join(hostCwd, '.git'), 'gitdir: /fake/path');
    
    // Initial empty architecture-spec.md
    const specPath = path.join(hostCwd, 'architecture-spec.md');
    fs.writeFileSync(specPath, '# Initial Architecture Spec\n', 'utf8');

    fs.writeFileSync(path.join(hostCwd, 'package.json'), JSON.stringify({
      name: 'mock-spec-patch-workspace',
      scripts: {
        lint: 'echo "Lint Passed" && exit 0'
      }
    }, null, 2));

    try {
      await proxy.updateConfig({
        filePath: snapshotPath,
        workDir: hostCwd,
      });
      
      const sessionId = 'test-spec-patch-session-123';
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
      let patchTriggered = false;
      const newSpecContent = '# Patched Spec v2\nMy new system guidelines and rules.';

      if (reader) {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const chunkStr = Buffer.from(value).toString('utf-8');
          receivedData += chunkStr;

          // Trigger spec patch when we receive our first few bytes of response stream
          if (!patchTriggered && receivedData.length > 0) {
            patchTriggered = true;
            console.log('Received first SSE stream feedback. Triggering Spec Patch mid-flight...');
            
            // Slight delay to ensure activeSession registry transitions successfully
            await new Promise(r => setTimeout(r, 200));

            console.log(`Sending Spec Patch request for sessionId: ${sessionId}`);
            const patchRes = await fetch(`http://127.0.0.1:${serverPort}/api/copilot/spec-patch`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json'
              },
              body: JSON.stringify({
                sessionId,
                specPatch: newSpecContent
              })
            });

            const patchData = await patchRes.json();
            console.log('Spec Patch REST response:', patchData);
            assert.strictEqual(patchRes.status, 200, 'Spec patch endpoint should return 200 OK');
            assert.strictEqual(patchData.success, true, 'Spec patch response should signal success: true');
          }
        }
      }

      console.log('Streamed run data on spec patch abort output:', receivedData);

      // Verify that the architecture-spec.md file has been updated in the workspace
      const updatedSpecInFs = fs.readFileSync(specPath, 'utf8');
      console.log('Updated Architecture Spec on Disk:', updatedSpecInFs);
      assert.strictEqual(updatedSpecInFs, newSpecContent, 'The spec content on disk should exactly match the patched version');

      console.log('✓ Spec Patch API integration test verified successfully!');
    } finally {
      // Clean up temporary workspace
      if (fs.existsSync(hostCwd)) {
        fs.rmSync(hostCwd, { recursive: true, force: true });
      }
    }
  });

  it('Verifies that pendingPatchedSpec is injected into the next prompt layout during gate loop re-invocation', async () => {
    const { serverPort } = serverHarness;
    const tempCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-patch-reprompt-'));
    fs.writeFileSync(path.join(tempCwd, '.git'), 'gitdir: /fake/path');
    fs.writeFileSync(path.join(tempCwd, 'package.json'), JSON.stringify({
      name: 'mock-spec-patch-workspace-reprompt',
      scripts: { lint: 'echo "Lint Passed" && exit 0' }
    }, null, 2));

    try {
      const sessionId = 'test-reprompt-session-123';
      
      // 1. Send an initial spec patch request first, which will fail with 404 because session doesn't exist yet,
      // or we can start a gate-run first. Let's start a gate-run first so the session exists.
      const runRes = await fetch(`http://127.0.0.1:${serverPort}/api/copilot/gate-run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: 'Help me build a server.',
          model: 'claude-sonnet-4.5',
          cwd: tempCwd,
          sessionId,
          gates: ['runLint'],
          maxRetries: 1
        })
      });

      // Let's read some bytes to make sure the session is initialized
      const reader = runRes.body?.getReader();
      if (reader) {
        await reader.read();
      }

      // 2. Call spec-patch endpoint to store the pending spec
      const patchRes = await fetch(`http://127.0.0.1:${serverPort}/api/copilot/spec-patch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId,
          specPatch: '# Updated Spec For Reprompt Test'
        })
      });
      const patchData = await patchRes.json();
      assert.strictEqual(patchRes.status, 200);
      assert.strictEqual(patchData.success, true);

      // 3. Since the previous run is aborted/finished, let's call gate-run again to trigger the prompt injection!
      const runRes2 = await fetch(`http://127.0.0.1:${serverPort}/api/copilot/gate-run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: 'Help me build a server.',
          model: 'claude-sonnet-4.5',
          cwd: tempCwd,
          sessionId,
          gates: ['runLint'],
          maxRetries: 1
        })
      });

      const reader2 = runRes2.body?.getReader();
      let streamedOutput = '';
      if (reader2) {
        while (true) {
          const { done, value } = await reader2.read();
          if (done) break;
          streamedOutput += Buffer.from(value).toString('utf-8');
        }
      }
      
      assert.ok(streamedOutput.length > 0, 'Should have received streamed response for second gate-run');
    } finally {
      if (fs.existsSync(tempCwd)) {
        fs.rmSync(tempCwd, { recursive: true, force: true });
      }
    }
  });
});
