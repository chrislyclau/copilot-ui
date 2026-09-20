import * as docker from "./dockerRunner";
import * as native from "./nativeRunner";
import { GitSandbox, ExecCommand } from "./git";

function isAIStudio(): boolean {
  return process.env.AI_STUDIO === "true" || process.env.NODE_ENV === "test" || process.env.VITEST === "true";
}

function getRunner() {
  return isAIStudio() ? native : docker;
}

/**
 * Factory for the shared GitSandbox singleton. The package default creates
 * the plain generic sandbox; the app passes its own factory (creating the
 * orchestration-side TaskGitSandbox subclass) so the singleton also carries
 * the task/PBI branch operations. Keeps agentCore free of app imports —
 * the app pushes its subclass in rather than agentCore reaching out.
 */
export type GitSandboxFactory = (
  workTree: string,
  gitDir: string,
  execCommand: ExecCommand
) => GitSandbox;

function defaultCreateSandbox(workTree: string, gitDir: string, execCommand: ExecCommand): GitSandbox {
  return new GitSandbox(workTree, gitDir, execCommand);
}

// Shared singleton — one instance means one busy flag, so withLock
// actually protects concurrent callers across the whole application.
let _sandbox: GitSandbox | null = null;

/**
 * Initializes the workspace for this app instance.
 * Selects the appropriate runner based on the AI_STUDIO environment variable,
 * creates the shared GitSandbox singleton, and initializes the git environment.
 *
 * Must be called once at startup before any getGitSandbox() or execCommand calls.
 * Calling it a second time is a no-op — the existing sandbox is returned as-is.
 *
 * @param options.createSandbox Optional factory for the shared sandbox
 *   singleton. The app passes its TaskGitSandbox factory
 *   (src/orchestration/taskGitSandbox.ts) so the singleton carries the
 *   task/PBI branch operations; the package default creates the plain
 *   generic GitSandbox.
 */
export async function initializeWorkspace(options?: { createSandbox?: GitSandboxFactory }): Promise<void> {
  if (_sandbox) return;
  const runner = getRunner();
  _sandbox = (options?.createSandbox ?? defaultCreateSandbox)(
    runner.getWorkspaceRoot(),
    runner.getGitDir(),
    runner.execCommand
  );
  await _sandbox.initializeGitSandboxAsync();
}

/**
 * Returns the shared GitSandbox instance.
 * Throws if initializeWorkspace() has not been called yet.
 */
export function getGitSandbox(): GitSandbox {
  if (!_sandbox) {
    throw new Error(
      "GitSandbox is not initialized. Call initializeWorkspace() before getGitSandbox()."
    );
  }
  return _sandbox;
}

/**
 * Returns an execCommand function bound to the appropriate runner.
 */
export function getExecCommand() {
  return getRunner().execCommand;
}

/**
 * Returns the workspace root bound to the appropriate runner.
 */
export function getWorkspaceRoot(): string {
  return getRunner().getWorkspaceRoot();
}

/**
 * Returns the host workspace location bound to the appropriate runner.
 */
export function getWorkspaceHostLocation(): string {
  return getRunner().getWorkspaceHostLocation();
}
