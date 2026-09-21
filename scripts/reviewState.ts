import { execFileSync } from 'node:child_process';

/**
 * Marker wrapping a JSON payload embedded (invisibly, as an HTML comment) at the
 * bottom of every review-pr PR comment. Used to recover state on the next run
 * without any external/persistent storage -- CI containers are not assumed to
 * persist anything between runs, but PR comments obviously do.
 */
export const STATE_MARKER_START = '<!-- review-pr:state';
export const STATE_MARKER_END = '-->';

export interface ReviewState {
  lastReviewedSha: string;
  /** copilot-sdk session id for the run that produced this state, for correlating with logs. */
  session_id?: string;
}

export interface GhComment {
  author?: { login?: string };
  body: string;
  createdAt?: string;
}

/**
 * Identity gh CLI comments as this bot when authenticated via the default
 * GITHUB_TOKEN in Actions. Overridable via REVIEW_BOT_LOGIN for other setups
 * (e.g. a GitHub App with its own bot identity).
 */
export function getBotLogin(): string {
  return process.env.REVIEW_BOT_LOGIN || 'github-actions[bot]';
}

/**
 * Normalizes a GitHub bot login for comparison. `gh`'s `--json comments`
 * (GraphQL-backed) has been observed reporting the standard Actions bot as
 * plain "github-actions", while the REST API / UI show "github-actions[bot]".
 * Stripping the suffix on both sides makes the comparison robust to either form.
 */
export function normalizeBotLogin(login: string | undefined): string {
  return (login || '').replace(/\[bot\]$/, '');
}

export function fetchComments(prNumber: string): GhComment[] {
  try {
    const raw = execFileSync(
      'gh',
      ['pr', 'view', prNumber, '--json', 'comments'],
      { maxBuffer: 1024 * 1024 * 20 },
    ).toString();
    return JSON.parse(raw).comments || [];
  } catch (err) {
    console.warn('[review-pr] failed to fetch PR comments for prior state, doing full review:', (err as Error)?.message || err);
    return [];
  }
}

/**
 * Fetches all comments on the PR and returns the most recent one authored by
 * this bot that contains a parseable state marker. Returns null if there is no
 * prior state, the marker is malformed, or the gh call fails for any reason --
 * callers should treat null as "do a full review", never as a hard error.
 */
export function loadPreviousReviewState(prNumber: string, comments?: GhComment[]): ReviewState | null {
  if (!comments) {
    comments = fetchComments(prNumber);
  }

  const botLogin = getBotLogin();
  for (let i = comments.length - 1; i >= 0; i--) {
    const comment = comments[i];
    if (!comment) {
      // Malformed entry in the comments array -- skip it rather than hard
      // erroring, per this function's documented contract (see doc comment
      // above): callers treat null as "do a full review", never a crash.
      continue;
    }
    if (normalizeBotLogin(comment.author?.login) !== normalizeBotLogin(botLogin)) continue;
    const state = parseStateMarker(comment.body);
    if (state) return state;
  }
  console.log(`[review-pr] no prior state found among ${comments.length} comment(s) on PR #${prNumber} (expected bot login "${botLogin}"; saw authors: ${JSON.stringify(comments.map(c => c?.author?.login))})`);
  return null;
}

function parseStateMarker(body: string): ReviewState | null {
  const startIdx = body.indexOf(STATE_MARKER_START);
  if (startIdx === -1) return null;
  const endIdx = body.indexOf(STATE_MARKER_END, startIdx);
  if (endIdx === -1) return null;

  // Payload is base64-encoded (see renderStateMarker) specifically so that
  // arbitrary finding text -- which could itself contain "-->" -- can't
  // terminate the HTML comment early and corrupt both the visible comment
  // and the parse.
  const encoded = body.slice(startIdx + STATE_MARKER_START.length, endIdx).trim();
  try {
    const jsonText = Buffer.from(encoded, 'base64').toString('utf-8');
    const parsed = JSON.parse(jsonText);
    if (
      typeof parsed?.lastReviewedSha !== 'string' ||
      (parsed?.session_id !== undefined && typeof parsed.session_id !== 'string')
    ) {
      return null;
    }
    return parsed as ReviewState;
  } catch (err) {
    console.warn('[review-pr] found a state marker but could not parse it, ignoring:', (err as Error)?.message || err);
    return null;
  }
}

/** Renders the hidden state block to append to the bottom of a new PR comment. */
export function renderStateMarker(state: ReviewState): string {
  const encoded = Buffer.from(JSON.stringify(state), 'utf-8').toString('base64');
  return `${STATE_MARKER_START}\n${encoded}\n${STATE_MARKER_END}`;
}

/**
 * Checks whether `sha` is a commit reachable in the local checkout. Used to
 * guard against force-pushes/rebases that drop the previously-reviewed commit,
 * or shallow clones that never had it in the first place.
 */
export function isCommitReachable(sha: string): boolean {
  try {
    execFileSync('git', ['cat-file', '-e', `${sha}^{commit}`], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Checks whether `ancestorSha` is an ancestor of `descendantSha` (or the same
 * commit). This matters because a two-dot diff (`a..b`) only produces "exactly
 * what changed since a" when a is genuinely on b's history -- e.g. after a
 * rebase, the old commit object can still exist locally (isCommitReachable
 * would say yes) while no longer being an ancestor of the new head, in which
 * case incremental review should not be trusted.
 */
export function isAncestor(ancestorSha: string, descendantSha: string): boolean {
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', ancestorSha, descendantSha], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Builds the reviewer context manifest's working-tree note, or '' when the
 * working tree already IS the PR head. Two checkout layouts exist and must be
 * distinguished:
 *
 * - Base-branch layout (code-review.yml checks out the PR's base branch and
 *   exposes the PR head as a worktree): HEAD differs from the PR head AND the
 *   PR head is not an ancestor of HEAD -- emit the note.
 * - Legacy layout (workflow checks out refs/pull/N/merge): HEAD is a merge
 *   commit whose second parent IS the PR head. HEAD differs from the PR head
 *   whenever base has diverged, but the PR's code is still in the tree, so
 *   claiming "this is the base branch" would be false -- emit no note. That
 *   is why the ancestor check below is required and a bare sha comparison is
 *   not enough.
 *
 * Like the other helpers in this module, operates on the process's cwd.
 */
export function buildWorkingTreeNote(headSha: string, hasPrTree: boolean): string {
  try {
    const localHeadSha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    if (localHeadSha !== headSha && !isAncestor(headSha, localHeadSha)) {
      return [
        `**Working tree note:** This working directory is NOT the PR head -- it is checked out at the PR's base branch (HEAD \`${localHeadSha.slice(0, 12)}\`, PR head \`${headSha.slice(0, 12)}\`). The reviewer runtime deliberately runs on base-branch code so a broken PR cannot break the review itself.`,
        `\`diff.patch\` is the authoritative record of the PR's changes.`,
        hasPrTree
          ? `The PR's own code is checked out at \`pr-tree/\` (read-only worktree, no node_modules -- run \`npm ci --legacy-peer-deps\` inside it before running tsc/eslint/vitest against the PR code).`
          : '',
      ].filter(Boolean).join(' ');
    }
    return '';
  } catch {
    // git unavailable or not a repo -- omit the note rather than guess.
    return '';
  }
}
