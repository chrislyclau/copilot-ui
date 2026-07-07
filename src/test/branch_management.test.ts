import { describe, it, beforeAll, expect } from 'vitest';
import * as path from 'path';
import * as fs from 'fs';
import { initializeWorkspace, getGitSandbox, getWorkspaceRoot } from '../workspace';
import { db } from '../db/index';
import { saveTask, getTask, saveSpec } from '../db/taskStore';

describe('Git Sandbox Branch Management', () => {
  beforeAll(async () => {
    await initializeWorkspace();
  });

  it('should support checking out, parking, and resuming task branches', async () => {
    const sandbox = getGitSandbox();
    const taskId = 'test-branch-task-999';

    // Register spec to satisfy Foreign Key constraint
    saveSpec({
      specId: 'spec-test',
      filePath: 'architecture-spec.md',
      version: 'v1',
      createdAt: Date.now()
    });

    // 1. Create a dummy task in SQLite so that the saveTask update succeeds
    saveTask({
      taskId,
      specId: 'spec-test',
      specVersion: 'v1',
      title: 'Test Branch Task',
      description: 'A test task for git branch isolation',
      status: 'pending',
      touches: null,
      dependsOn: null,
      branchName: null,
      blockedReason: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    // Verify task initially has no branch name
    let task = getTask(taskId);
    expect(task).toBeDefined();
    expect(task?.branchName).toBeNull();

    // 2. Checkout the task branch
    await sandbox.checkoutTaskBranch(taskId);

    // Verify that the task record now has the correct branch name in the DB
    task = getTask(taskId);
    expect(task?.branchName).toBe(`task/${taskId}`);

    // Create a temporary file to simulate work done in this branch
    const testFile = path.join(getWorkspaceRoot(), 'temp-branch-test.txt');
    fs.writeFileSync(testFile, 'work in progress on task-999', 'utf8');

    // 3. Park the task branch
    await sandbox.parkTaskBranch(taskId);

    // Verify task record still has the branch name recorded
    task = getTask(taskId);
    expect(task?.branchName).toBe(`task/${taskId}`);

    // Verify that the temporary file was committed and the working tree is clean
    // Since we switched back to main/master, the temporary file (which was committed only on the task branch) should not be present
    const fileExistsOnBase = fs.existsSync(testFile);
    expect(fileExistsOnBase).toBe(false);

    // 4. Resume the task branch
    await sandbox.resumeTaskBranch(taskId);

    // Verify that the file is back when we resume
    const fileExistsOnResume = fs.existsSync(testFile);
    expect(fileExistsOnResume).toBe(true);
    expect(fs.readFileSync(testFile, 'utf8')).toBe('work in progress on task-999');

    // Clean up: return to base and delete task record and dummy file
    await sandbox.parkTaskBranch(taskId);
    db.prepare('DELETE FROM tasks WHERE taskId = ?').run(taskId);
  });
});
