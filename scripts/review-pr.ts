// check for openrouter models first before falling back to gemini
if (!process.env.REVIEWER_PROVIDER && process.env.REVIEWER_MODEL) {
  if (process.env.REVIEWER_MODEL.includes('/')) {
    process.env.REVIEWER_PROVIDER = 'openrouter';
  } else {
    process.env.REVIEWER_PROVIDER = 'gemini';
  }
}
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { app, setActiveOpenRouterSessionId } from '../src/serverRuntime.ts';
import { getReviewerExecutionConfig, executeAuditSession } from '../src/utils/auditorHelper.ts';
import { submitCodeReviewTool as baseSubmitCodeReviewTool } from '../src/config/tools.ts';
import { getFilteredDiff } from './diffFilter';
import {
  loadPreviousReviewState,
  isCommitReachable,
  isAncestor,
  renderStateMarker,
  fetchComments,
  normalizeBotLogin,
  getBotLogin,
  STATE_MARKER_START,
  STATE_MARKER_END,
  type GhComment,
  type ReviewState,
} from './reviewState';

interface CodeReviewFinding {
  severity: 'blocking' | 'suggestion' | 'nit';
  category?: 'bug' | 'security' | 'performance' | 'style';
  file: string;
  line?: number;
  message: string;
  status?: 'new' | 'still-open' | 'resolved';
}

interface CodeReviewResult {
  findings: CodeReviewFinding[];
  summary: string;
}
const PORT = parseInt(process.env.PORT || '3000', 10);
/**
 * ProviderRegistry routes gemini (and other non-anthropic-direct) calls through
 * this app's own '/api/providers/:provider/*' proxy route rather than hitting
 * the upstream API directly (see src/serverRuntime.ts). That route is normally
 * only reachable because the full app server is already running. This script
 * runs headless in CI, so it has to stand the proxy up itself for the duration
 * of the review call.
 */
function startProviderProxy(): Promise<Server> {  
  process.env.COPILOT_API_URL = `http://127.0.0.1:${PORT}`;
  return new Promise((resolve, reject) => {
    const server = app.listen(PORT, '127.0.0.1', () => resolve(server));
    server.on('error', reject);
  });
}

function stopProviderProxy(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

/**
 * Resolves which diff range to review. Prefers an incremental diff since the
 * last-reviewed sha (cheaper, and lets the model focus on what's actually new)
 * but falls back to the full base...head diff whenever that isn't possible or
 * safe: no prior state, the prior sha is unreachable (force-push/rebase, or a
 * shallow checkout that never had it), it's not actually an ancestor of head
 * (e.g. rebase that dropped it from history but left the commit object
 * dangling locally), or it's identical to the current head (nothing new to
 * review incrementally, though we still may want to bail out entirely --
 * handled by the caller).
 *
 * Uses double-dot (`a..b`) rather than triple-dot for the incremental range:
 * triple-dot diffs against the merge-base of the two commits, which is only
 * equivalent to "changes since a" when a is a strict ancestor of b -- exactly
 * the case we've already verified via isAncestor by this point.
 */
function resolveDiffRange(
  baseSha: string,
  headSha: string,
  previousState: ReviewState | null,
): { range: string; incremental: boolean } {
  if (!previousState) {
    return { range: `${baseSha}...${headSha}`, incremental: false };
  }
  if (previousState.lastReviewedSha === headSha) {
    return { range: `${baseSha}...${headSha}`, incremental: false };
  }
  if (!isCommitReachable(previousState.lastReviewedSha)) {
    console.warn(
      `[review-pr] previously-reviewed sha ${previousState.lastReviewedSha} is not reachable in this checkout ` +
      `(force-push, rebase, or shallow clone) -- falling back to a full review.`,
    );
    return { range: `${baseSha}...${headSha}`, incremental: false };
  }
  if (!isAncestor(previousState.lastReviewedSha, headSha)) {
    console.warn(
      `[review-pr] previously-reviewed sha ${previousState.lastReviewedSha} is not an ancestor of ${headSha} ` +
      `(likely a rebase/force-push rewrote history) -- falling back to a full review.`,
    );
    return { range: `${baseSha}...${headSha}`, incremental: false };
  }
  return { range: `${previousState.lastReviewedSha}..${headSha}`, incremental: true };
}

const submitCodeReviewTool = typeof structuredClone === 'function' ? structuredClone(baseSubmitCodeReviewTool) : JSON.parse(JSON.stringify(baseSubmitCodeReviewTool));

function buildSystemPrompt(incremental: boolean): string {
  return `You are a code review agent. Review the given PR diff for bugs, compliance issues, and quality concerns.

Compliance information is located in AGENTS.md and README.md.

**Finding-Admission Gate (Strict Rules):**
- A finding may only be reported when you can answer ALL of the following: 1. Where does the issue occur? 2. Why is it a problem? 3. How did this change introduce or expose it? 4. What input, state, or execution path would trigger it? If you cannot answer all four, DO NOT report it.
- Prefer one well-evidenced finding over multiple speculative ones, and merge closely related findings into a single finding.

**Scope Rules:**
- Limit findings to changed lines, changed blocks, or behavior directly affected by the changed code (including touched callers/callees, changed contracts, data flow, and tests).
- DO NOT raise cleanup suggestions for unrelated pre-existing code.
- DO NOT raise issues against pre-existing code unless the current PR newly breaks, exposes, or worsens that code path.
- If the PR consists primarily of code movement/refactoring, limit findings to newly introduced bugs, regressions, or meaningful performance problems.
- DO NOT raise style/preference findings unless they create a real readability, consistency, or maintenance problem, or violate an established repo standard.


**Classification and Output Rules:**
- Keep each finding's message concise (target: under ~150 words) unless a code snippet is necessary for clarity.
- Never state that the PR is approved or ready to merge, and never attempt to merge the PR.
- If there are zero findings, your summary must state that no actionable findings were identified, and you must not fabricate filler content.

${incremental
    ? `The PR DIFF in \`.review-context/diff.patch\` only covers changes since the last review round. The full comment history of the PR is available in \`.review-context/comments.md\`.
Read \`.review-context/comments.md\` to determine if previously reported blocking findings are now resolved, still open, or no longer applicable.
- Treat a prior finding as still open unless the comment history and current diff together indicate it was addressed — i.e., silence in the incremental diff about a prior finding is not evidence of resolution.
- Do not re-raise a prior finding as newly reported once you judge it addressed; instead, acknowledge it as 'resolved' in the finding output.
- When a fix introduced in response to prior feedback is found to have introduced a new issue that did not previously exist, raise it as a new finding (regression check).
- Only set the 'status' field to 'still-open' or 'resolved' on findings that correspond to a prior finding from the comment history.`
    : `This is a full review of the entire PR diff in \`.review-context/diff.patch\`.`}

You must not answer conversationally and must strictly invoke 'submit_code_review'.`;
}

function buildUserPrompt(): string {
  return `The context is available in \`.review-context/\`. Read \`README.md\` to start.`;
}

async function main() {
  const baseSha = process.env.PR_BASE_SHA;
  const headSha = process.env.PR_HEAD_SHA;
  const prNumber = process.env.PR_NUMBER;

  if (!baseSha || !headSha || !prNumber) {
    console.error('Missing required env vars: PR_BASE_SHA, PR_HEAD_SHA, PR_NUMBER.');
    process.exit(1);
  }

  const comments = fetchComments(prNumber);

  const previousState = loadPreviousReviewState(prNumber, comments);
  const { range, incremental } = resolveDiffRange(baseSha, headSha, previousState);
  const diff = getFilteredDiff(range);
  if (!diff.trim()) {
    console.log(`No diff to review for range ${range}, skipping.`);
    return;
  }

  const contextDir = join(process.cwd(), '.review-context');
  mkdirSync(contextDir, { recursive: true });

  const normalizedBotLogin = normalizeBotLogin(getBotLogin());
  
  let commentsMd = '';
  for (const c of comments) {
    const author = c.author?.login || 'unknown';
    const isBot = normalizeBotLogin(author) === normalizedBotLogin;
    const authorTag = isBot ? `${author} (BOT)` : author;
    
    let body = c.body || '';
    const startIdx = body.indexOf(STATE_MARKER_START);
    if (startIdx !== -1) {
      const endIdx = body.indexOf(STATE_MARKER_END, startIdx);
      if (endIdx !== -1) {
        body = body.slice(0, startIdx) + body.slice(endIdx + STATE_MARKER_END.length);
      }
    }
    
    commentsMd += `### Comment by ${authorTag} at ${c.createdAt || 'unknown time'}\n\n${body.trim()}\n\n---\n\n`;
  }
  
  writeFileSync(join(contextDir, 'comments.md'), commentsMd || '');

  if (diff.split('\n').length > 500) {
    try {
      const diffStat = execFileSync('git', ['diff', '--stat', range]).toString();
      writeFileSync(join(contextDir, 'diff-stat.txt'), diffStat);
    } catch (e) {
      // ignore
    }
  }
  writeFileSync(join(contextDir, 'diff.patch'), diff);

  let prMetaMd = '_No description provided._';
  try {
    const rawMeta = execFileSync('gh', ['pr', 'view', prNumber, '--json', 'title,body']).toString();
    const meta = JSON.parse(rawMeta);
    const title = meta.title || 'Untitled';
    const bodyText = meta.body ? meta.body.trim() : '';
    prMetaMd = `# ${title}\n\n${bodyText || '_No description provided._'}`;
  } catch (e) {
    // ignore
  }
  writeFileSync(join(contextDir, 'pr-meta.md'), prMetaMd);

  const hasDiffStat = existsSync(join(contextDir, 'diff-stat.txt'));

  const manifest = `# PR Review Context Files
- \`diff.patch\`: A standard unified diff of the changes in this PR${incremental ? ' since the last review' : ''}.
${hasDiffStat ? '- `diff-stat.txt`: A summary of the changed files and lines.\n' : ''}- \`pr-meta.md\`: The PR title and description.
- \`comments.md\`: The full comment history of the PR.
`;
  writeFileSync(join(contextDir, 'README.md'), manifest);

  const systemPrompt = buildSystemPrompt(incremental);
  const userPrompt = buildUserPrompt();

  const executionConfig = getReviewerExecutionConfig();
  const proxyServer = await startProviderProxy();
  let result: CodeReviewResult | null;
  let sessionId: string | undefined;

  try {
    result = await executeAuditSession<CodeReviewResult>(
      process.cwd(),
      executionConfig,
      systemPrompt,
      submitCodeReviewTool,
      userPrompt,
      {
        toolChoice: 'auto',
      },
      undefined,
      600000,
      (id) => {
        sessionId = id;
        setActiveOpenRouterSessionId(id);
      },
    );
  } finally {
    setActiveOpenRouterSessionId(undefined);
    await stopProviderProxy(proxyServer);
  }

  if (sessionId) {
    console.log(`[review-pr] reviewer session_id: ${sessionId}`);
  } else {
    // Session was never created (e.g. client.start()/createSession() threw before
    // the callback fired) -- still worth knowing when correlating a failed run.
    console.warn('[review-pr] no session_id was captured for this run.');
  }

  // executeAuditSession throws (rather than returning null) if the model
  // never calls submit_code_review after exhausting its retries, so by this
  // point `result` is guaranteed non-null -- the throw is caught by main()'s
  // top-level .catch(), which logs it (including the model's last message)
  // and exits non-zero. This check only exists to narrow the type for TS.
  if (!result) {
    throw new Error('Unreachable: executeAuditSession resolved without throwing or returning a result.');
  }

  // The tool schema marks `findings`/`summary` as required, but that's only
  // advisory -- it isn't enforced on the model's actual tool-call arguments,
  // so a call that omits `findings` (e.g. the model decides there's nothing
  // to report and drops the array instead of sending `[]`) would otherwise
  // crash below. Normalize defensively rather than trusting the schema was honored.
  if (!Array.isArray(result.findings)) {
    result.findings = [];
  }
  if (typeof result.summary !== 'string') {
    result.summary = '';
  }

  if (result.findings.length === 0) {
    if (!result.summary || result.summary.trim() === '') {
      result.summary = 'No actionable findings were identified.';
    }
  }

  const bySeverity = (sev: CodeReviewFinding['severity']) =>
    result.findings.filter((f) => f.severity === sev);

  const section = (label: string, items: CodeReviewFinding[]) =>
    items.length
      ? `**${label}**\n` + items.map((f) => {
          const statusTag = f.status ? ` _(${f.status})_` : '';
          const categoryTag = f.category ? `[${f.category}] ` : '';
          return `- \`${f.file}${f.line ? ':' + f.line : ''}\`: ${categoryTag}${f.message}${statusTag}`;
        }).join('\n')
      : '';

  const blockingFindings = bySeverity('blocking');

  const body = [
    `### Code Review${incremental ? ' (incremental, since last review)' : ''}`,
    result.summary,
    section('Blocking', blockingFindings),
    section('Suggestions', bySeverity('suggestion')),
    section('Nits', bySeverity('nit')),
    sessionId ? `<sub>session_id: \`${sessionId}\`</sub>` : '',
  ].filter(Boolean).join('\n\n');

  const newState: ReviewState = {
    lastReviewedSha: headSha,
    session_id: sessionId,
  };
  const bodyWithState = `${body}\n\n${renderStateMarker(newState)}`;

  try {
    execFileSync('gh', ['pr', 'comment', prNumber, '--body', bodyWithState], { stdio: 'inherit' });
  } catch (commentErr) {
    console.warn('[review-pr] failed to post PR comment using GitHub CLI (this is expected if the run originates from a fork or lacks write permissions):', commentErr);
  }

  process.exit(0);
}

main().catch((err) => {
  console.error('[review-pr] failed:', err?.message || err);
  process.exit(1);
});
