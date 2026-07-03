import { describe, it, beforeAll, afterAll } from 'vitest';
import assert from 'node:assert';
import { serverHarness } from './harness/ServerHarness';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { initializeWorkspace, getGitSandbox } from '../workspace';

describe('Spec-Gate Auditor Validation Tests', () => {
  beforeAll(async () => {
    await serverHarness.start();
  });

  afterAll(async () => {
    await serverHarness.stop();
  });

  it('Verifies that a Spec-Gate Audit Failure stops the pipeline and returns a SPEC_VIOLATION event', { timeout: 60000 }, async () => {
    console.log('Starting spec_gate_audit integration test...');

    const { serverPort, proxy, proxyUrl } = serverHarness;
    assert.ok(proxy);

    const snapshotPath = path.resolve(process.cwd(), 'src/test/snapshots/gate_loop/spec_gate_audit_failure.yaml');
    
    const tempCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-gate-'));

    // Initialize git and commit a baseline to simulate active changes
    console.log('Initializing local mock git structure inside test workspace...');
    // initializeWorkspace() creates and initializes the shared GitSandbox.
    await initializeWorkspace();
    const sandbox = getGitSandbox();
    
    fs.writeFileSync(path.join(tempCwd, 'architecture-spec.md'), 'Spec: Must conform to specs.');
    fs.writeFileSync(path.join(tempCwd, 'temp.txt'), 'baseline state');
    
    await sandbox.commitAllChangesAsync("initial specs commit");
    
    // Make a modification to create unstaged changes (meaning git diff is non-empty)
    fs.writeFileSync(path.join(tempCwd, 'temp.txt'), 'baseline state - modified with unstaged edits');

    // Write package.json with exit 0 lint script so compilation check passes instantly
    fs.writeFileSync(path.join(tempCwd, 'package.json'), JSON.stringify({
      name: 'mock-spec-workspace',
      scripts: {
        lint: 'echo "Lint Passed" && exit 0'
      }
    }, null, 2));

    try {
      await proxy.updateConfig({
        filePath: snapshotPath,
        workDir: tempCwd,
      });

      console.log('Sending request to /api/copilot/gate-run with Spec Gate auditing enabled');

      const res = await fetch(`http://127.0.0.1:${serverPort}/api/copilot/gate-run`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          prompt: 'Implement features conforming to architecture spec.',
          model: 'claude-sonnet-4.5',
          cwd: tempCwd,
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

      console.log('Finished streaming. Verifying Spec Gate violation response...');

      // Verify compilation checks ran successfully
      assert.ok(
        finalData.includes('Lint Passed'),
        'Standard build checks should succeed first'
      );

      // Verify Spec-Gate Auditor fails with SPEC_VIOLATION feedback
      assert.ok(
        finalData.includes('SPEC_VIOLATION'),
        'Output should stream back the SPEC_VIOLATION failure reason'
      );

      assert.ok(
        finalData.includes('Authentication router is missing'),
        'Output should include auditor structural feedback text'
      );

      console.log('✓ Spec-Gate Auditor integration test validated successfully!');
    } finally {
      if (fs.existsSync(tempCwd)) {
        fs.rmSync(tempCwd, { recursive: true, force: true });
      }
    }
  });
});
