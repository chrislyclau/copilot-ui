import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

export const activeContainers = new Set<string>();

export function getWorkspaceHash(sessionId?: string): string {
  const cwd = process.cwd();
  const hash = crypto.createHash('sha256').update(cwd);
  if (sessionId) {
    hash.update(':' + sessionId);
  }
  return hash.digest('hex').substring(0, 12);
}

export function getIsolatedName(prefix: string, sessionId?: string): string {
  return `${prefix}-${getWorkspaceHash(sessionId)}`;
}

export function syncWorkspace(src: string, dest: string): void {
  if (fs.existsSync(src)) {
    fs.cpSync(src, dest, { recursive: true });
  }
}

export function cleanupWorkspaceDir(dir: string): void {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

export function validateGitWorktree(dir: string): { valid: boolean; error?: string } {
  const sandboxGitDir = path.join(dir, '.aistudio', '.git');
  const dotGitPath = path.join(dir, '.git');
  
  if (fs.existsSync(dotGitPath) && fs.statSync(dotGitPath).isDirectory()) {
    return { valid: false, error: 'Access Denied: Un-sandboxed top-level .git directory found.' };
  }
  if (!fs.existsSync(sandboxGitDir)) {
    return { valid: false, error: 'Target directory is not an initialized AI Studio Git sandbox.' };
  }
  return { valid: true };
}
