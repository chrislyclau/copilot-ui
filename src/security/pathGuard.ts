import path from 'path';
import os from 'os';
import fs from 'fs';
import { getWorkspaceRoot } from '../workspace';

/**
 * Checks if a child path is physically and logically inside a parent directory.
 * Prevents directory traversal attacks, including handling symlinks.
 */
export function checkPathInside(parent: string, child: string): boolean {
  const absParent = path.resolve(parent);
  const absChild = path.resolve(child);
  const relAbs = path.relative(absParent, absChild);
  const isUnresolvedSafe = relAbs === '' || (!relAbs.startsWith('..') && !path.isAbsolute(relAbs));
  if (isUnresolvedSafe) return true;

  try {
    const realParent = fs.realpathSync(parent);
    const realChild = fs.realpathSync(child);
    const relReal = path.relative(realParent, realChild);
    return relReal === '' || (!relReal.startsWith('..') && !path.isAbsolute(relReal));
  } catch {
    return false;
  }
}

/**
 * Normalizes and sanitizes a requested directory path.
 * Strips out leading separators and back-traversal patterns.
 */
export function normalizeCwd(cwd: string | undefined): string {
  let inputCwd = getWorkspaceRoot();
  if (cwd && typeof cwd === 'string') {
    if (process.env.NODE_ENV === 'test' && path.isAbsolute(cwd) && cwd.startsWith(os.tmpdir())) {
      inputCwd = cwd;
    } else {
      const normalizedSubpath = path.normalize(cwd)
        .replace(/^([a-zA-Z]:)?(\/|\\)+/, '')
        .replace(/^(\.\.(\/|\\|$))+/, '');
      inputCwd = path.join(getWorkspaceRoot(), normalizedSubpath);
    }
  }
  return inputCwd;
}

/**
 * Validates that the requested directory is safe (inside workspace root or tmpdir).
 * Throws a Security Exception if the path is unsafe or contains shell-injection characters.
 */
export function validateCwd(cwd: string | undefined): string {
  if (cwd && typeof cwd === 'string') {
    // Strict pattern check: only allow safe alphanumeric and path separator characters to eliminate shell injection
    if (!/^[a-zA-Z0-9_\-\.\/]+$/.test(cwd)) {
      throw new Error(`Security Exception: Directory path contains unsafe characters: ${cwd}`);
    }
  }
  
  const runCwd = normalizeCwd(cwd);
  
  const isCwdSafe = checkPathInside(getWorkspaceRoot(), runCwd) || 
                    (process.env.NODE_ENV === 'test' && checkPathInside(os.tmpdir(), runCwd));
                    
  if (!isCwdSafe) {
    throw new Error(`Security Exception: Directory path is outside workspace root: ${cwd}`);
  }
  
  return runCwd;
}
