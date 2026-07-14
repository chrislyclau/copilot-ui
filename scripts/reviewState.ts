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
    if(!comment) {
      throw new Error("[review-pr] Unexpected: comment is falsy");
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
