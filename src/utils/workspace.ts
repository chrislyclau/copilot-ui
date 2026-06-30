import * as fs from "fs";
import * as path from "path";

export interface WorkspaceValidationResult {
  valid: boolean;
  error?: string;
}

export function validateGitWorktree(workTree: string): WorkspaceValidationResult {
  const gitPath = path.join(workTree, ".git");

  if (fs.existsSync(gitPath) && fs.lstatSync(gitPath).isDirectory()) {
    return {
      valid: false,
      error: "Un-sandboxed top-level .git directory found.",
    };
  }

  return { valid: true };
}

export function cleanupWorkspaceDir(workTree: string): void {
  fs.rmSync(workTree, { recursive: true, force: true });
}
