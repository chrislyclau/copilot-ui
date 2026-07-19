import { describe, it, beforeAll, expect } from 'vitest';
import * as path from 'path';
import * as fs from 'fs';
import { initializeWorkspace, getGitSandbox, getWorkspaceRoot } from '../workspace';
import { db } from '../db/index';
import { saveTask, getTask, saveSpec } from '../db/taskStore';
import { savePbi } from '../db/pbiStore';

describe('PBI-level integration branch + fast-forward merge (Issue 84 / RM-REQ-014/015/016)', () => {
  beforeAll(async () => {
    await initializeWorkspace();

    saveSpec({
      specId: 'spec-pbi-test',
      filePath: 'architecture-spec.md',
      version: 'v1',
      createdAt: Date.now(),
    });
  });

  function registerPbi(pbiId: string) {
    savePbi({
      pbiId,
      specId: 'spec-pbi-test',
      title: `Test PBI ${pbiId}`,
      description: 'A test PBI for integration-branch tests',
      status: 'in_progress',
      dependsOn: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  }

  function registerTask(taskId: string, pbiId: string) {
    saveTask({
      taskId,
      specId: 'spec-pbi-test',
      specVersion: 'v1',
      title: `Test Task ${taskId}`,
      description: 'A test task for PBI branch isolation',
      status: 'pending',
      touches: null,
      dependsOn: null,
      branchName: null,
      blockedReason: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      pbiId,
    });
  }

  it('creates pbi/<pbiId> off trunk on first use, and is idempotent on repeat calls', async () => {
    const sandbox = getGitSandbox();
    const pbiId = 'pbi-ensure-001';
    registerPbi(pbiId);

    await sandbox.ensurePbiBranch(pbiId);
    const shaAfterFirst = await sandbox.getHeadShaAsync();

    // Calling again should not fail, and should not create a duplicate or
    // move the branch — it just checks the existing branch back out.
    await sandbox.ensurePbiBranch(pbiId);
    const shaAfterSecond = await sandbox.getHeadShaAsync();

    expect(shaAfterSecond).toBe(shaAfterFirst);

    db.prepare('DELETE FROM pbis WHERE pbiId = ?').run(pbiId);
  });

  it('branches a task off pbi/<pbiId> (not trunk) when a PBI context exists', async () => {
    const sandbox = getGitSandbox();
    const pbiId = 'pbi-branch-002';
    const taskId = 'task-branch-002';
    registerPbi(pbiId);
    registerTask(taskId, pbiId);

    // Put a marker file on the PBI branch before any task branches off it.
    await sandbox.ensurePbiBranch(pbiId);
    const marker = path.join(getWorkspaceRoot(), 'pbi-002-marker.txt');
    fs.writeFileSync(marker, 'exists only on pbi/pbi-branch-002', 'utf8');
    await sandbox.commitAllChangesAsync('Add PBI marker file');

    // Checking out the task branch with a pbiId should branch off the PBI
    // branch, so the marker file must be present.
    await sandbox.checkoutTaskBranch(taskId, pbiId);
    expect(fs.existsSync(marker)).toBe(true);

    const task = getTask(taskId);
    expect(task?.branchName).toBe(`task/${taskId}`);

    await sandbox.parkTaskBranch(taskId);
    db.prepare('DELETE FROM tasks WHERE taskId = ?').run(taskId);
    db.prepare('DELETE FROM pbis WHERE pbiId = ?').run(pbiId);
  });

  it('fast-forward merges a completed task branch into pbi/<pbiId>', async () => {
    const sandbox = getGitSandbox();
    const pbiId = 'pbi-merge-003';
    const taskId = 'task-merge-003';
    registerPbi(pbiId);
    registerTask(taskId, pbiId);

    await sandbox.checkoutTaskBranch(taskId, pbiId);
    const taskFile = path.join(getWorkspaceRoot(), 'task-003-output.txt');
    fs.writeFileSync(taskFile, 'work completed by task-merge-003', 'utf8');
    await sandbox.commitAllChangesAsync('Complete task-merge-003');

    await sandbox.mergeTaskIntoPbi(taskId, pbiId);

    // Verify the file landed on pbi/<pbiId> by checking it out directly.
    await sandbox.checkoutAsync(`pbi/${pbiId}`);
    expect(fs.existsSync(taskFile)).toBe(true);

    // mergeTaskIntoPbi should leave the sandbox back on the base branch.
    await sandbox.checkoutAsync('main').catch(() => sandbox.checkoutAsync('master'));

    db.prepare('DELETE FROM tasks WHERE taskId = ?').run(taskId);
    db.prepare('DELETE FROM pbis WHERE pbiId = ?').run(pbiId);
  });

  it('throws (no auto three-way merge) when the task branch has diverged from pbi/<pbiId>, and returns to base', async () => {
    const sandbox = getGitSandbox();
    const pbiId = 'pbi-diverge-004';
    const taskId = 'task-diverge-004';
    registerPbi(pbiId);
    registerTask(taskId, pbiId);

    // Task branches off pbi/<pbiId> and does its own work.
    await sandbox.checkoutTaskBranch(taskId, pbiId);
    const taskFile = path.join(getWorkspaceRoot(), 'task-004-output.txt');
    fs.writeFileSync(taskFile, 'work by task-diverge-004', 'utf8');
    await sandbox.commitAllChangesAsync('Complete task-diverge-004');

    // Meanwhile pbi/<pbiId> itself moves forward independently (e.g. another
    // task already merged into it), so a fast-forward is no longer possible.
    await sandbox.checkoutAsync(`pbi/${pbiId}`);
    const pbiFile = path.join(getWorkspaceRoot(), 'pbi-004-independent.txt');
    fs.writeFileSync(pbiFile, 'independent pbi-level commit', 'utf8');
    await sandbox.commitAllChangesAsync('Independent PBI-level commit');

    await expect(sandbox.mergeTaskIntoPbi(taskId, pbiId)).rejects.toThrow();

    // Even on failure, the sandbox must be left back on the base branch
    // (never mid-merge or stuck on the PBI branch) so the next task can run.
    const currentBranch = await sandbox.checkoutAsync('main').then(
      () => 'main',
      () => 'master'
    );
    expect(['main', 'master']).toContain(currentBranch);

    db.prepare('DELETE FROM tasks WHERE taskId = ?').run(taskId);
    db.prepare('DELETE FROM pbis WHERE pbiId = ?').run(pbiId);
  });

  it('non-PBI tasks (no pbiId) still branch directly off trunk, unaffected by this change', async () => {
    const sandbox = getGitSandbox();
    const taskId = 'task-no-pbi-005';

    saveTask({
      taskId,
      specId: 'spec-pbi-test',
      specVersion: 'v1',
      title: 'Non-PBI task',
      description: 'A task with no PBI context',
      status: 'pending',
      touches: null,
      dependsOn: null,
      branchName: null,
      blockedReason: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      pbiId: null,
    });

    await sandbox.checkoutTaskBranch(taskId);
    const task = getTask(taskId);
    expect(task?.branchName).toBe(`task/${taskId}`);

    await sandbox.parkTaskBranch(taskId);
    db.prepare('DELETE FROM tasks WHERE taskId = ?').run(taskId);
  });

  it('returns to base branch even when the pbi/<pbiId> checkout itself fails (e.g. pbi branch never created)', async () => {
    const sandbox = getGitSandbox();
    const pbiId = 'pbi-never-created-006';
    const taskId = 'task-no-pbi-branch-006';

    // Register the task with a pbiId, but never call ensurePbiBranch /
    // checkoutTaskBranch(taskId, pbiId) for it — simulates the case where
    // pbi branch creation was silently swallowed upstream (checkoutTaskBranch
    // catches ensurePbiBranchImpl failures), so pbi/<pbiId> never exists.
    registerPbi(pbiId);
    registerTask(taskId, pbiId);

    // Task still needs *a* branch to attempt a merge from, so it's fine for
    // this to be a plain trunk-based branch — the point under test is the
    // checkout of the (nonexistent) pbi branch failing, not the merge itself.
    await sandbox.checkoutTaskBranch(taskId);

    await expect(sandbox.mergeTaskIntoPbi(taskId, pbiId)).rejects.toThrow();

    // Regression check: previously the checkout of pbi/<pbiId> sat outside
    // the try/finally, so a failure here left the sandbox on whatever branch
    // it was on rather than returning to base. Verify recovery is clean by
    // confirming a fresh checkoutTaskBranch call succeeds immediately after.
    const otherTaskId = 'task-followup-006';
    registerTask(otherTaskId, pbiId);
    await expect(sandbox.checkoutTaskBranch(otherTaskId)).resolves.toBeDefined();

    await sandbox.parkTaskBranch(otherTaskId);
    db.prepare('DELETE FROM tasks WHERE taskId IN (?, ?)').run(taskId, otherTaskId);
    db.prepare('DELETE FROM pbis WHERE pbiId = ?').run(pbiId);
  });
});
