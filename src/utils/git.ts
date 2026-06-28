import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

function getGitPaths(cwd: string) {
  let gitDir = path.join(cwd, '.git');
  if (process.env.DIAGNOSTIC_MODE === 'true') {
    if (cwd === '/tmp/sandbox/workspace') {
      gitDir = '/tmp/sandbox/.git';
    } else {
      gitDir = path.join(cwd, '.git');
    }
  } else {
    gitDir = path.join(cwd, '.aistudio', '.git');
  }
  return { gitDir, workTree: cwd };
}

function runGit(cwd: string, args: string[]): string {
  const { gitDir, workTree } = getGitPaths(cwd);
  try {
    return execFileSync('git', args, {
      cwd,
      env: {
        ...process.env,
        HOME: cwd,
        GIT_DIR: gitDir,
        GIT_WORK_TREE: workTree,
        GIT_PAGER: 'cat',
      },
      stdio: 'pipe'
    }).toString().trim();
  } catch (err: any) {
    const msg = err.stderr ? err.stderr.toString().trim() : err.message;
    throw new Error(`Git command failed: ${msg}`);
  }
}

export function initializeGitSandboxSync(cwd: string): void {
  const { gitDir } = getGitPaths(cwd);
  
  fs.mkdirSync(path.dirname(gitDir), { recursive: true });
  fs.mkdirSync(gitDir, { recursive: true });

  const runGitLocal = (args: string[]) => {
    try {
      return execFileSync('git', args, {
        cwd,
        env: {
          ...process.env,
          HOME: cwd,
          GIT_DIR: gitDir,
          GIT_WORK_TREE: cwd,
          GIT_PAGER: 'cat',
        },
        stdio: 'pipe'
      }).toString().trim();
    } catch (err: any) {
      const msg = err.stderr ? err.stderr.toString().trim() : err.message;
      throw new Error(`Git init command failed: ${msg}`);
    }
  };

  runGitLocal(['init']);

  try {
    const excludeDir = path.join(gitDir, 'info');
    fs.mkdirSync(excludeDir, { recursive: true });
    fs.writeFileSync(path.join(excludeDir, 'exclude'), '.aistudio/\n');
  } catch (e) {}

  runGitLocal(['config', 'user.email', 'sandbox@aistudio.local']);
  runGitLocal(['config', 'user.name', 'AI Studio Sandbox']);
  runGitLocal(['add', '-A']);
  runGitLocal(['commit', '--allow-empty', '-m', 'Sandbox Baseline (pre-existing files)']);
}

export async function initializeGitSandboxAsync(cwd: string): Promise<void> {
  initializeGitSandboxSync(cwd);
}

export async function getGitDiffHead(cwd: string): Promise<string> {
  try {
    return runGit(cwd, ['diff', 'HEAD']);
  } catch (e) {
    return '';
  }
}

export function getGitDiffSync(cwd: string): string {
  try {
    return runGit(cwd, ['diff']);
  } catch (e: any) {
    return '';
  }
}

export async function getGitDiffHeadNumstat(cwd: string): Promise<string> {
  try {
    return runGit(cwd, ['diff', 'HEAD', '--numstat']);
  } catch (e) {
    return '';
  }
}

export async function getHeadShaAsync(cwd: string): Promise<string> {
  try {
    return runGit(cwd, ['rev-parse', 'HEAD']);
  } catch (e) {
    return '';
  }
}

export function commitAllChangesSync(cwd: string, message: string): string {
  runGit(cwd, ['add', '-A']);
  runGit(cwd, ['commit', '--allow-empty', '-m', message]);
  return runGit(cwd, ['rev-parse', 'HEAD']);
}

export async function commitAllChangesAsync(cwd: string, message: string): Promise<string> {
  return commitAllChangesSync(cwd, message);
}

export async function restoreCheckpointAsync(
  cwd: string,
  commitSha: string,
  message: string
): Promise<void> {
  const status = runGit(cwd, ['status', '--porcelain']);
  if (status.length > 0) {
    throw new Error(
      "GitSandbox: cannot restore checkpoint — worktree has uncommitted changes. " +
      "Commit or discard them first."
    );
  }

  let addedFiles: string[] = [];
  try {
    const diffOut = runGit(cwd, ['diff', '--name-only', '--diff-filter=A', commitSha, 'HEAD']);
    addedFiles = diffOut.split('\n').map(f => f.trim()).filter(Boolean);
  } catch (e) {
    // Ignore
  }

  runGit(cwd, ['checkout', commitSha, '--', '.']);

  for (const file of addedFiles) {
    const filePath = path.join(cwd, file);
    try {
      if (fs.existsSync(filePath)) {
        fs.rmSync(filePath, { force: true });
      }
    } catch (e) {
      // Ignore
    }
  }

  runGit(cwd, ['clean', '-fd']);
  runGit(cwd, ['add', '-A']);
  try {
    runGit(cwd, ['commit', '-m', message]);
  } catch (e) {
    // Ignore
  }
}
