import { execFileSync } from 'node:child_process';

export interface LinkedIssue {
  number: number;
  title: string;
  body: string;
  url: string;
  state: string;
}

/**
 * Matches closing keywords (close/closes/closed/fix/fixes/fixed/resolve/
 * resolves/resolved) followed by a bare `#123` or a full
 * `owner/repo#123` / `https://github.com/owner/repo/issues/123` reference,
 * per GitHub's own linking syntax. Case-insensitive, and tolerant of the
 * keyword and reference being separated by "and"/commas (e.g.
 * "Fixes #12 and #34" -- handled by the global regex matching each keyword
 * occurrence separately below).
 */
const CLOSING_KEYWORD_RE =
  /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*:?\s+(?:(?:[\w.-]+\/[\w.-]+)?#(\d+)|https?:\/\/github\.com\/[\w.-]+\/[\w.-]+\/issues\/(\d+))/gi;

/** Matches any bare `#123` or issue-URL reference, regardless of keyword. */
const ANY_ISSUE_REF_RE =
  /(?:^|\s)(?:(?:[\w.-]+\/[\w.-]+)?#(\d+)|https?:\/\/github\.com\/[\w.-]+\/[\w.-]+\/issues\/(\d+))\b/g;

function extractIssueNumbers(text: string, re: RegExp): number[] {
  const numbers = new Set<number>();
  let match: RegExpExecArray | null;
  re.lastIndex = 0;
  while ((match = re.exec(text)) !== null) {
    const n = match[1] || match[2];
    if (n) numbers.add(parseInt(n, 10));
  }
  return [...numbers];
}

/**
 * Determines which issues are linked to a PR, combining two sources:
 * 1. GitHub's own `closingIssuesReferences` (issues that will auto-close via
 *    a recognized closing keyword in the PR body).
 * 2. Any other bare `#123` / issue-URL mentions in the PR body, so an issue
 *    referenced for context (without a closing keyword) is still surfaced.
 * Returns a de-duplicated list of issue numbers, in the order first seen.
 */
export function findLinkedIssueNumbers(prNumber: string): number[] {
  let body = '';
  let closingNumbers: number[] = [];
  try {
    const raw = execFileSync(
      'gh',
      ['pr', 'view', prNumber, '--json', 'body,closingIssuesReferences'],
    ).toString();
    const parsed = JSON.parse(raw);
    body = parsed.body || '';
    closingNumbers = (parsed.closingIssuesReferences || [])
      .map((ref: { number?: number }) => ref.number)
      .filter((n: unknown): n is number => typeof n === 'number');
  } catch (err) {
    console.warn('[review-pr] failed to fetch PR body/closing issues for linked-issue detection:', (err as Error)?.message || err);
    return [];
  }

  const mentioned = extractIssueNumbers(body, ANY_ISSUE_REF_RE);
  // Re-run the keyword-specific regex too, purely so numbers found via a
  // closing keyword in the body (even if gh's closingIssuesReferences missed
  // them, e.g. cross-repo refs) are still included.
  const keyworded = extractIssueNumbers(body, CLOSING_KEYWORD_RE);

  const ordered: number[] = [];
  const seen = new Set<number>();
  for (const n of [...closingNumbers, ...keyworded, ...mentioned]) {
    if (!seen.has(n)) {
      seen.add(n);
      ordered.push(n);
    }
  }
  return ordered;
}

/**
 * Fetches full content for each given issue number via `gh issue view`.
 * Issues that fail to fetch (deleted, wrong repo, no access, etc.) are
 * skipped with a warning rather than aborting the whole batch.
 */
export function fetchLinkedIssues(issueNumbers: number[]): LinkedIssue[] {
  const issues: LinkedIssue[] = [];
  for (const number of issueNumbers) {
    try {
      const raw = execFileSync(
        'gh',
        ['issue', 'view', String(number), '--json', 'number,title,body,url,state'],
      ).toString();
      const parsed = JSON.parse(raw);
      issues.push({
        number: parsed.number,
        title: parsed.title || 'Untitled',
        body: parsed.body || '',
        url: parsed.url || '',
        state: parsed.state || 'UNKNOWN',
      });
    } catch (err) {
      console.warn(`[review-pr] failed to fetch linked issue #${number}, skipping:`, (err as Error)?.message || err);
    }
  }
  return issues;
}

/** Renders a single linked issue as a standalone markdown file's content. */
export function renderIssueMarkdown(issue: LinkedIssue): string {
  return `# #${issue.number}: ${issue.title}\n\n_State: ${issue.state} | ${issue.url}_\n\n${issue.body.trim() || '_No description provided._'}\n`;
}
