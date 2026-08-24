import { execFileSync } from 'node:child_process';
import { defineTool } from '../../src/copilotSdk/boundary';
import type { Tool } from '../../src/copilotSdk/boundary';

/**
 * Three narrowly-scoped tools for the code-change agent (issue #407), each
 * doing exactly one `execFileSync` git/gh call -- never a free-form shell --
 * mirroring `agentGhTool.ts`'s one-purpose-per-tool discipline. Unlike
 * `agentGhTool.ts`'s single allowlisted `run_gh_command` tool, these are
 * split into three separate tools rather than one allowlist, since each has
 * a genuinely different argument shape and, for `create_pr`, a distinct
 * credential (see below).
 */

export const MAKE_COMMIT_TOOL_NAME = 'make_commit';
export const RENAME_BRANCH_TOOL_NAME = 'rename_branch';
export const CREATE_PR_TOOL_NAME = 'create_pr';

export interface MakeCommitArgs {
  message: string;
}

export interface RenameBranchArgs {
  branch_name: string;
}

export interface CreatePrArgs {
  title: string;
  body: string;
}

export interface GitToolResult {
  output?: string;
  error?: string;
}

/**
 * `git add -A && git commit -m <message>`. No push -- this only ever
 * touches the local working tree/history. Callable multiple times per
 * session, so the agent can make several small commits rather than one
 * giant one.
 */
export function createMakeCommitTool(): Tool<MakeCommitArgs> {
  return defineTool<MakeCommitArgs>(
    MAKE_COMMIT_TOOL_NAME,
    'Stages all current changes and creates a local git commit with the given message. ' +
      'Does NOT push anything anywhere. Safe to call multiple times in one session.',
    {
      type: 'object',
      properties: {
        message: {
          type: 'string',
          description: 'The commit message to use.',
        },
      },
      required: ['message'],
    },
    async ({ message }): Promise<GitToolResult> => {
      if (typeof message !== 'string' || !message.trim()) {
        const error = 'Rejected: commit message must be a non-empty string.';
        console.warn(`[agentGitTools:make_commit] ${error}`);
        return { error };
      }
      try {
        execFileSync('git', ['add', '-A'], { encoding: 'utf-8', timeout: 60000 });
        const output = execFileSync('git', ['commit', '-m', message], {
          encoding: 'utf-8',
          timeout: 60000,
        });
        console.log(`[agentGitTools:make_commit] committed: ${message}`);
        return { output };
      } catch (err: any) {
        const errorMessage = err?.stdout?.toString?.() || err?.stderr?.toString?.() || err?.message || String(err);
        console.error(`[agentGitTools:make_commit] failed: ${errorMessage}`);
        return { error: `git commit failed: ${errorMessage}` };
      }
    },
  );
}

/**
 * Local `git branch -m <branch_name>` only. No push -- renaming the branch
 * the agent's working tree is currently on doesn't touch the placeholder
 * branch the workflow already pushed as `agent/run-<run_id>`; that rename
 * only takes effect remotely once `create_pr` pushes the (now-renamed)
 * current branch.
 */
export function createRenameBranchTool(): Tool<RenameBranchArgs> {
  return defineTool<RenameBranchArgs>(
    RENAME_BRANCH_TOOL_NAME,
    'Renames the current local git branch to the given name. Does NOT push -- the new name ' +
      'only reaches the remote the next time create_pr pushes.',
    {
      type: 'object',
      properties: {
        branch_name: {
          type: 'string',
          description: 'The new branch name, e.g. "fix/issue-123-short-name".',
        },
      },
      required: ['branch_name'],
    },
    async ({ branch_name: branchName }): Promise<GitToolResult> => {
      if (typeof branchName !== 'string' || !branchName.trim()) {
        const error = 'Rejected: branch_name must be a non-empty string.';
        console.warn(`[agentGitTools:rename_branch] ${error}`);
        return { error };
      }
      try {
        const output = execFileSync('git', ['branch', '-m', branchName], {
          encoding: 'utf-8',
          timeout: 30000,
        });
        console.log(`[agentGitTools:rename_branch] renamed current branch to: ${branchName}`);
        return { output: output || `Renamed current branch to ${branchName}.` };
      } catch (err: any) {
        const errorMessage = err?.stdout?.toString?.() || err?.stderr?.toString?.() || err?.message || String(err);
        console.error(`[agentGitTools:rename_branch] failed: ${errorMessage}`);
        return { error: `git branch -m failed: ${errorMessage}` };
      }
    },
  );
}

/**
 * Pushes the current branch and opens a PR via `gh pr create`. This is the
 * ONLY tool of the three with write credentials -- and those credentials
 * are passed directly into this closure at construction time, never read
 * from `process.env` inside the handler below (see the `writeToken` param).
 * That keeps the general session environment's `GH_TOKEN` read-only (issue
 * #407's "Security / credential separation"): any ad hoc `gh`/`git`
 * invocation the agent makes from inside `run_terminal_docker` only ever
 * sees the read-only token.
 *
 * The `bash` builtin is a different story: it runs as a child of the same
 * Node process as this script, so it inherits `process.env` directly --
 * unlike `run_terminal_docker`'s containerized shell, which does not.
 * `GH_WRITE_TOKEN` (the source of `writeToken`) is therefore deleted from
 * `process.env` in `code-change-agent.ts`'s `main()` right after this
 * closure captures it and before the session (and so `bash`) ever starts.
 * The write token is also never persisted to disk: the workflow checks out
 * with `persist-credentials: false`, so there's nothing in `.git/config`
 * either. This tool authenticates its own push with a one-off
 * `-c http.extraheader=...` argument built fresh from the closure value on
 * every call, making it the only code path capable of a real push/PR.
 */
export function createCreatePrTool(writeToken: string): Tool<CreatePrArgs> {
  if (!writeToken || !writeToken.trim()) {
    throw new Error('createCreatePrTool: a non-empty write-scoped token is required.');
  }
  return defineTool<CreatePrArgs>(
    CREATE_PR_TOOL_NAME,
    'Pushes the current branch to the fork and opens a pull request with the given title and ' +
      'body. Only call this once you have already committed your changes via make_commit -- ' +
      'do not call this if you made no changes.',
    {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description: 'The pull request title.',
        },
        body: {
          type: 'string',
          description: 'The pull request body/description.',
        },
      },
      required: ['title', 'body'],
    },
    async ({ title, body }): Promise<GitToolResult> => {
      if (typeof title !== 'string' || !title.trim()) {
        const error = 'Rejected: title must be a non-empty string.';
        console.warn(`[agentGitTools:create_pr] ${error}`);
        return { error };
      }
      if (typeof body !== 'string') {
        const error = 'Rejected: body must be a string.';
        console.warn(`[agentGitTools:create_pr] ${error}`);
        return { error };
      }
      // Scoped to just this call's process environment via `env`, rather
      // than mutating `process.env` for the whole session -- keeps the
      // write token out of the general environment that
      // `run_terminal_docker`-invoked commands (and any other tool) would
      // otherwise inherit.
      const env = { ...process.env, GH_TOKEN: writeToken };
      // The checkout step runs with persist-credentials: false specifically
      // so nothing writes this token to .git/config, where the agent's
      // bash builtin or run_terminal_docker's bind-mounted container could
      // read it back out and push independently of this tool. So instead
      // of relying on any persisted credential, the auth header is passed
      // as a one-off `-c http.extraheader=...` argv value: it lives only in
      // this process's argument list/environment for the duration of this
      // single `git push`, never touching disk.
      const authHeader = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${writeToken}`).toString('base64')}`;
      try {
        execFileSync(
          'git',
          ['-c', `http.extraheader=${authHeader}`, 'push', '-u', 'origin', 'HEAD'],
          { encoding: 'utf-8', timeout: 120000, env },
        );
        const output = execFileSync(
          'gh',
          ['pr', 'create', '--title', title, '--body', body],
          { encoding: 'utf-8', timeout: 60000, env },
        );
        console.log(`[agentGitTools:create_pr] opened PR: ${title}`);
        return { output };
      } catch (err: any) {
        const errorMessage = err?.stdout?.toString?.() || err?.stderr?.toString?.() || err?.message || String(err);
        console.error(`[agentGitTools:create_pr] failed: ${errorMessage}`);
        return { error: `push/PR creation failed: ${errorMessage}` };
      }
    },
  );
}
