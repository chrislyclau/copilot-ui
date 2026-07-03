import { describe, it } from 'vitest';
import assert from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { GitSandbox, type ExecCommand } from './git';

const execAsync = promisify(exec);

function createShellExecCommand(failFirstMkdir: boolean): ExecCommand {
  let shouldFail = failFirstMkdir;

  return async (command, signal) => {
    if (shouldFail && command.startsWith('mkdir -p ')) {
      shouldFail = false;
      return {
        stdout: '',
        stderr: 'simulated mkdir failure',
        exitCode: 1,
      };
    }

    try {
      const { stdout, stderr } = await execAsync(command, {
        shell: '/bin/bash',
        signal,
      });
      return { stdout, stderr, exitCode: 0 };
    } catch (error: unknown) {
      const execError = error as {
        stdout?: string;
        stderr?: string;
        message?: string;
        code?: number | string;
      };
      return {
        stdout: execError.stdout ?? '',
        stderr: execError.stderr ?? execError.message ?? '',
        exitCode: typeof execError.code === 'number' ? execError.code : 1,
      };
    }
  };
}

describe('GitSandbox initialization', () => {
  it('can be retried after a failed initialization and then called again safely', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'git-sandbox-'));
    const workTree = path.join(root, 'worktree');
    const gitDir = path.join(root, '.git');

    try {
      const sandbox = new GitSandbox(workTree, gitDir, createShellExecCommand(true));

      await assert.rejects(() => sandbox.initializeGitSandboxAsync());

      await assert.doesNotReject(() => sandbox.initializeGitSandboxAsync());
      await assert.doesNotReject(() => sandbox.initializeGitSandboxAsync());
      assert.ok(fs.existsSync(path.join(gitDir, 'HEAD')));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
