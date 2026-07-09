import { execFileSync } from 'node:child_process';
import { defineTool } from '../../src/copilotSdk/boundary';
import type { Tool } from '../../src/copilotSdk/boundary';

/**
 * The only `gh` subcommands the issue-task agent is allowed to invoke.
 * Each entry is the `<noun> <verb>` pair (e.g. "issue comment"), matched
 * against the first two positional args the model supplies.
 *
 * Deliberately conservative for Phase 1: no `repo`, no `workflow`, no
 * `release`, nothing that can delete/merge/close destructively, and
 * nothing that shells out further (e.g. `gh api`, `gh ssh`). Expand this
 * list only alongside explicit product review.
 */
export const ALLOWED_GH_COMMANDS: readonly string[] = [
  'issue view',
  'issue comment',
  'pr view',
  'pr diff',
  'pr comment',
  'label list',
];

export const RUN_GH_COMMAND_TOOL_NAME = 'run_gh_command';

export interface RunGhCommandArgs {
  /**
   * Full gh CLI argument vector, WITHOUT the leading "gh" itself, e.g.
   * ["issue", "comment", "42", "--body", "Thanks for the report!"].
   */
  args: string[];
}

export interface RunGhCommandResult {
  output?: string;
  error?: string;
}

function subcommandOf(args: string[]): string {
  return args.slice(0, 2).join(' ');
}

/**
 * True only if the first two positional args exactly match an allowlisted
 * "<noun> <verb>" pair. Deliberately strict (no prefix/substring matching)
 * so e.g. "issue delete" can never sneak in under "issue".
 */
export function isAllowedGhCommand(args: string[]): boolean {
  if (!Array.isArray(args) || args.length < 2) return false;
  return ALLOWED_GH_COMMANDS.includes(subcommandOf(args));
}

/**
 * Builds the `run_gh_command` SDK tool. The handler never throws for a
 * disallowed subcommand -- it returns a rejection as normal tool output so
 * the model can see why it failed and try an allowed alternative instead of
 * the whole session crashing. It only throws (propagates) for genuinely
 * unexpected failures, which the caller's session error handling covers.
 */
export function createRunGhCommandTool(): Tool<RunGhCommandArgs> {
  return defineTool<RunGhCommandArgs>(
    RUN_GH_COMMAND_TOOL_NAME,
    'Executes a single whitelisted "gh" (GitHub CLI) subcommand and returns its ' +
      'real stdout/stderr. Only the following subcommands are permitted: ' +
      `${ALLOWED_GH_COMMANDS.join(', ')}. Any other subcommand is rejected and ` +
      'reported back as an error instead of being run -- if that happens, pick ' +
      'a different, allowed way to accomplish the goal rather than retrying the ' +
      'same call.',
    {
      type: 'object',
      properties: {
        args: {
          type: 'array',
          items: { type: 'string' },
          description:
            'The gh CLI argument vector, excluding the leading "gh", e.g. ' +
            '["issue", "comment", "42", "--body", "text"].',
        },
      },
      required: ['args'],
    },
    async ({ args }): Promise<RunGhCommandResult> => {
      if (!Array.isArray(args) || args.length < 2) {
        const message = `Rejected: gh command must include at least a resource and an action (got ${JSON.stringify(args)}).`;
        console.warn(`[agentGhTool] ${message}`);
        return { error: message };
      }

      if (!isAllowedGhCommand(args)) {
        const message =
          `Rejected: "gh ${subcommandOf(args)}" is not on the allowlist. ` +
          `Allowed subcommands: ${ALLOWED_GH_COMMANDS.join(', ')}.`;
        console.warn(`[agentGhTool] Rejected disallowed gh subcommand: "${subcommandOf(args)}" (full args: ${JSON.stringify(args)})`);
        return { error: message };
      }

      const hasRepoArg = args.some((arg) =>
        arg === '--repo' || arg.startsWith('--repo=') || arg.startsWith('-R')
      );
      if (hasRepoArg) {
        const message = 'Rejected: cross-repo access is forbidden. Remove --repo/-R flags.';
        console.warn(`[agentGhTool] ${message}`);
        return { error: message };
      }

      try {
        console.log(`[agentGhTool] Running: gh ${args.join(' ')}`);
        const output = execFileSync('gh', args, {
          encoding: 'utf-8',
          maxBuffer: 10 * 1024 * 1024,
          timeout: 60000,
        });
        return { output };
      } catch (err: any) {
        const message =
          err?.stderr?.toString?.() || err?.message || String(err);
        console.error(`[agentGhTool] gh command failed: ${message}`);
        return { error: `gh command failed: ${message}` };
      }
    },
  );
}
