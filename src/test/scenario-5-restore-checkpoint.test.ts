import { getWorkspaceHostLocation } from "../workspace";
import { describe, it, beforeAll, afterAll } from 'vitest';
import assert from 'node:assert';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { initializeWorkspace, getGitSandbox } from '../workspace';
; 
import { serverHarness } from './harness/ServerHarness';

/**
 * Scenario 5: Checkpoint restore success.
 *
 * This test exercises /api/copilot/checkpoint/restore via the session-independent
 * `cwd` parameter introduced in __30.  No gate-run is required — git state is
 * set up directly via initializeGitSandboxSync / commitAllChangesSync, and `cwd`
 * is passed explicitly in the restore request body.
 *
 * Previous incarnation called gate-run with a fake API key purely to "register"
 * a session before calling restore.  That caused a livelock: gate-run consumed
 * the request body but never resolved (retry loop against dead proxy, activeLocks
 * held the session, server livelocked).
 */
describe('Scenario 5: Checkpoint restore success', () => {
  let originalRealGitTest: string | undefined;

  beforeAll(async () => {
    originalRealGitTest = process.env.REAL_GIT_TEST;
    process.env.REAL_GIT_TEST = 'true';
    await serverHarness.start();
  });

  afterAll(async () => {
    process.env.REAL_GIT_TEST = originalRealGitTest;
    await serverHarness.stop();
  });

  it('Scenario 5: Checkpoint restore success', { timeout: 30_000 }, async () => {
    const { serverPort } = serverHarness;
    const relativeCwd = 'scen5-' + Math.random().toString(36).substring(2, 8);
    const hostCwd = path.join(getWorkspaceHostLocation(), relativeCwd);
    fs.mkdirSync(hostCwd, { recursive: true });

    try {
      // Set up a real git sandbox directly — no server session needed.
      // initializeWorkspace() already initializes the shared GitSandbox.
      await initializeWorkspace();
      const sandbox = getGitSandbox();

      fs.writeFileSync(path.join(hostCwd, 'v.txt'), 'v1');
      const sha = (await sandbox.commitAllChangesAsync('initial')).trim();

      // Write an update and also add a new file that wasn't in v1
      fs.writeFileSync(path.join(hostCwd, 'v.txt'), 'v2');
      fs.writeFileSync(path.join(hostCwd, 'new_file.txt'), 'i_am_new');
      await sandbox.commitAllChangesAsync('update');

      // Verify both files exist before restoring
      assert.strictEqual(fs.readFileSync(path.join(hostCwd, 'v.txt'), 'utf8'), 'v2');
      assert.strictEqual(fs.readFileSync(path.join(hostCwd, 'new_file.txt'), 'utf8'), 'i_am_new');

      // Restore to the v1 commit, passing cwd directly (no session required).
      const res = await fetch(`http://127.0.0.1:${serverPort}/api/copilot/checkpoint/restore`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          commitSha: sha,
          taskLabel: 'Restore point',
          cwd: relativeCwd,
        }),
      });

      const data = (await res.json()) as any;
      assert.strictEqual(res.status, 200, `Expected 200, got ${res.status}: ${JSON.stringify(data)}`);
      assert.ok(data.success, `Expected success: true, got ${JSON.stringify(data)}`);

      // Verify v.txt reflects restored content
      const content = fs.readFileSync(path.join(hostCwd, 'v.txt'), 'utf8');
      assert.strictEqual(content, 'v1', 'File content should reflect restored commit');

      // Verify that new_file.txt (which was added after the checkpoint) is deleted
      const fileExists = fs.existsSync(path.join(hostCwd, 'new_file.txt'));
      assert.strictEqual(fileExists, false, 'Files added after the checkpoint should be removed');
    } finally {
      if (fs.existsSync(hostCwd)) {
        fs.rmSync(hostCwd, { recursive: true, force: true });
      }
    }
  });
});
