import crypto from 'crypto';
import * as path from 'path';

/**
 * Resolves the default workspace containment fallback directory when no explicit path is provided.
 * It refers to the isolated 'workspace' subdirectory under the project root.
 */
export function getDefaultWorkspaceDir(): string {
  return './workspace';
}

/**
 * Resolves the workspace root path.
 * Returns '.'.
 */
export function getWorkspaceRoot(): string {
  return '.';
}

/**
 * Resolves the git directory location.
 * Returns the standard './.aistudio/.git' location.
 */
export function getGitRoot(): string {
  return './.aistudio/.git';
}

export function getWorkspaceHash(sessionId?: string): string {
  const salt = 'aistudio-workspace-salt';
  return crypto.createHash('md5').update((sessionId || 'default') + salt).digest('hex').substring(0, 8);
}

export function getIsolatedName(base: string, sessionId?: string): string {
    return base + '-' + getWorkspaceHash(sessionId);
}

