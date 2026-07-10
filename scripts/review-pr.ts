// check for openrouter models first before falling back to gemini
if (!process.env.REVIEWER_PROVIDER && process.env.REVIEWER_MODEL) {
  if (process.env.REVIEWER_MODEL.includes('/')) {
    process.env.REVIEWER_PROVIDER = 'openrouter';
  } else {
    process.env.REVIEWER_PROVIDER = 'gemini';
  }
}
import { execFileSync } from 'node:child_process';
import type { Server } from 'node:http';
import { app, setActiveOpenRouterSessionId } from '../src/serverRuntime';
import { getReviewerExecutionConfig, executeAuditSession } from '../src/utils/auditorHelper';
import { submitCodeReviewTool } from '../src/config/tools';
import { getFilteredDiff } from './diffFilter';
import {
  loadPreviousReviewState,
  isCommitReachable,
  isAncestor,
  renderStateMarker,
  type ReviewState,
  type PersistedBlockingFinding,
} from './reviewState';

interface CodeReviewFinding {
  severity: 'blocking' | 'suggestion' | 'nit';
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

function buildSystemPrompt(incremental: boolean): string {
  return `You are a code review agent. Review the given PR diff for bugs, compliance issues, and quality concerns.

Compliance information is located in AGENTS.md and README.md.

${incremental
    ? `The PR DIFF below only covers changes since the last review round. A list of previously reported blocking findings is included -- for each one, check whether it is now resolved, still open, or (if it no longer applies at all) drop it. Only set the 'status' field on findings that correspond to one of these prior items. Do not re-raise a previously reported blocking finding as a new finding; instead report it once with the appropriate status.`
    : `This is a full review of the entire PR diff (no prior review state was found, or it could not be used). Do not set the 'status' field on any findings.`}

Suggestions and nits are not tracked across review rounds -- just report whatever you currently observe, with no 'status' field.

You must not answer conversationally and must strictly invoke 'submit_code_review'.`;
}

function buildUserPrompt(diff: string, previousState: ReviewState | null, incremental: boolean): string {
  if (!incremental || !previousState || previousState.blockingFindings.length === 0) {
    return `PR DIFF:\n${diff}`;
  }
  const findingsList = previousState.blockingFindings
    .map((f: PersistedBlockingFinding) => `- \`${f.file}${f.line ? ':' + f.line : ''}\`: ${f.message}`)
    .join('\n');
  return `Previously reported blocking findings (verify each is resolved, still-open, or no longer applicable):\n${findingsList}\n\nPR DIFF (since last reviewed commit):\n${diff}`;
}

async function main() {
  const baseSha = process.env.PR_BASE_SHA;
  const headSha = process.env.PR_HEAD_SHA;
  const prNumber = process.env.PR_NUMBER;

  if (!baseSha || !headSha || !prNumber) {
    console.error('Missing required env vars: PR_BASE_SHA, PR_HEAD_SHA, PR_NUMBER.');
    process.exit(1);
  }

  const previousState = loadPreviousReviewState(prNumber);
  const { range, incremental } = resolveDiffRange(baseSha, headSha, previousState);

  const diff = getFilteredDiff(range);
  if (!diff.trim()) {
    console.log(`No diff to review for range ${range}, skipping.`);
    return;
  }

  const systemPrompt = buildSystemPrompt(incremental);
  const userPrompt = buildUserPrompt(diff, previousState, incremental);

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
        toolChoice: { type: 'function', function: { name: submitCodeReviewTool.function.name } },
        allowOthers: false
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

  if (!result) {
    console.error('Reviewer failed to return findings.');
    process.exit(1);
  }

  const bySeverity = (sev: CodeReviewFinding['severity']) =>
    result.findings.filter((f) => f.severity === sev);

  const section = (label: string, items: CodeReviewFinding[]) =>
    items.length
      ? `**${label}**\n` + items.map((f) => {
          const statusTag = f.status ? ` _(${f.status})_` : '';
          return `- \`${f.file}${f.line ? ':' + f.line : ''}\`: ${f.message}${statusTag}`;
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

  // Carry forward blocking findings across runs -- but only in incremental
  // mode. In full-review mode (fallback due to force-push/rebase/shallow
  // clone, or no prior state), the model reviewed the ENTIRE diff and was not
  // shown the prior findings list at all (see buildSystemPrompt/buildUserPrompt),
  // so it has no way to mark anything 'resolved'. Treating its full-review
  // output as authoritative and NOT seeding from previousState avoids stale
  // findings persisting forever after every force-push. In incremental mode,
  // the model only sees new changes, so a prior finding it doesn't mention at
  // all (e.g. it lives in a file untouched by this round's diff) must NOT be
  // silently dropped -- it should still be considered open until something
  // explicitly reports it 'resolved'.
  //
  // Keyed on file:line (or file alone if line is undefined) to distinguish
  // multiple findings in the same file and prevent data loss. A prior finding
  // that is not re-reported this round is preserved as-is, ensuring no blocking
  // issue is silently dropped unless explicitly marked 'resolved' by the model.
  const findingKey = (f: { file: string; line?: number }) => 
    f.line !== undefined ? `${f.file}:${f.line}` : f.file;

  const carriedForward = new Map<string, PersistedBlockingFinding>();

  if (incremental) {
    for (const f of previousState?.blockingFindings || []) {
      carriedForward.set(findingKey(f), f);
    }
  }

  // Now apply what the model actually reported this round: 'resolved' removes
  // it, 'still-open' refreshes it, and a fresh blocking finding with no status
  // (either a genuinely new incremental finding, or any finding at all in
  // full-review mode) is added/kept as-is. Prior findings not mentioned in this
  // round remain in carriedForward unchanged.
  for (const f of blockingFindings) {
    const key = findingKey(f);
    if (f.status === 'resolved') {
      carriedForward.delete(key);
    } else {
      carriedForward.set(key, { file: f.file, line: f.line, message: f.message });
    }
  }

  const stillOpenBlocking: PersistedBlockingFinding[] = Array.from(carriedForward.values());

  const newState: ReviewState = {
    lastReviewedSha: headSha,
    blockingFindings: stillOpenBlocking,
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
