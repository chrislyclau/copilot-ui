import { execFileSync } from 'node:child_process';

/**
 * Pathspecs excluded from review diffs: lockfiles, recorded trace/snapshot
 * fixtures, and other generated or data-only files that add a lot of tokens
 * for essentially zero review value. Extend this list as new noisy paths
 * show up in practice.
 */
const EXCLUDED_PATHSPECS = [
  ':!package-lock.json',
  ':!**/package-lock.json',
  ':!src/test/snapshots/**',
  ':!src/test/fixtures/traces/**',
];

/**
 * Runs `git diff <range>` excluding noisy paths. Returns the diff text, or ''
 * if there's nothing to review (including the case where every changed file
 * was excluded).
 */
export function getFilteredDiff(range: string): string {
  return execFileSync(
    'git',
    ['diff', range, '--', '.', ...EXCLUDED_PATHSPECS],
    { maxBuffer: 1024 * 1024 * 20 },
  ).toString();
}
