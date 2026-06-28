import { describe, it, beforeAll, afterAll } from 'vitest';
import assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import { validateGitWorktree, cleanupWorkspaceDir } from '../utils/workspace';

describe('Git Worktree Guard Tests', () => {
  let savedDiagnosticMode: string | undefined;
  let savedTestingGitWorktreeGuard: string | undefined;

  beforeAll(() => {
    savedDiagnosticMode = process.env.DIAGNOSTIC_MODE;
    savedTestingGitWorktreeGuard = process.env.TESTING_GIT_WORKTREE_GUARD;
    // Force standard mode for testing validateGitWorktree path checks
    process.env.DIAGNOSTIC_MODE = 'false';
    process.env.TESTING_GIT_WORKTREE_GUARD = 'true';
  });

  afterAll(() => {
    process.env.DIAGNOSTIC_MODE = savedDiagnosticMode;
    process.env.TESTING_GIT_WORKTREE_GUARD = savedTestingGitWorktreeGuard;
  });

  it('validateGitWorktree rejects when directory has .git as a directory', async () => {
    const originalCwd = process.cwd();
    // Create a temporary workspace where .git is a directory
    const tempDir = path.resolve(originalCwd, 'tmp-invalid-git-workspace');
    if (fs.existsSync(tempDir)) {
      cleanupWorkspaceDir(tempDir);
    }
    fs.mkdirSync(tempDir, { recursive: true });
    fs.mkdirSync(path.join(tempDir, '.git'), { recursive: true }); // .git is a directory!

    try {
      const result = validateGitWorktree(tempDir);
      assert.strictEqual(result.valid, false);
      assert.match(result.error || '', /Un-sandboxed top-level .git directory found/);
    } finally {
      if (fs.existsSync(tempDir)) {
        cleanupWorkspaceDir(tempDir);
      }
    }
  });

  it('validateGitWorktree succeeds if .aistudio/.git is a directory instead of .git', async () => {
    const originalCwd = process.cwd();
    const tempDir = path.resolve(originalCwd, 'tmp-valid-git-workspace');
    if (fs.existsSync(tempDir)) {
      cleanupWorkspaceDir(tempDir);
    }
    fs.mkdirSync(tempDir, { recursive: true });
    fs.mkdirSync(path.join(tempDir, '.aistudio'), { recursive: true });
    fs.mkdirSync(path.join(tempDir, '.aistudio', '.git'), { recursive: true });

    try {
      const result = validateGitWorktree(tempDir);
      assert.strictEqual(result.valid, true);
    } finally {
      if (fs.existsSync(tempDir)) {
        cleanupWorkspaceDir(tempDir);
      }
    }
  });
});


