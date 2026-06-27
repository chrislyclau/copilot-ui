import * as docker from "./dockerRunner";
import * as native from "./nativeRunner";
import { GitSandbox } from "./git";

function isAIStudio(): boolean {
  return process.env.AI_STUDIO === "true";
}

function getRunner() {
  return isAIStudio() ? native : docker;
}

/**
 * Initializes the workspace for this app instance.
 * Selects the appropriate runner based on the AI_STUDIO environment variable
 * and initializes the git sandbox at the corresponding paths.
 *
 * Must be called once at startup before any execCommand calls are made.
 */
export async function initializeWorkspace(): Promise<void> {
  const runner = getRunner();
  const sandbox = new GitSandbox(runner.getWorkspaceRoot(), runner.getGitDir());
  await sandbox.initializeGitSandboxAsync();
}

/**
 * Returns an execCommand function bound to the appropriate runner.
 */
export function getExecCommand() {
  return getRunner().execCommand;
}

/**
 * Returns a GitSandbox instance bound to the appropriate runner's paths.
 */
export function getGitSandbox(): GitSandbox {
  const runner = getRunner();
  return new GitSandbox(runner.getWorkspaceRoot(), runner.getGitDir());
}
