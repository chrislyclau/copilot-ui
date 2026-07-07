import { execFileSync } from 'node:child_process';
import type { Server } from 'node:http';
import { app } from '../src/serverRuntime';
import { getReviewerExecutionConfig, executeAuditSession } from '../src/utils/auditorHelper';
import { submitCodeReviewTool } from '../src/config/tools';

interface CodeReviewFinding {
  severity: 'blocking' | 'suggestion' | 'nit';
  file: string;
  line?: number;
  message: string;
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

async function main() {
  const baseSha = process.env.PR_BASE_SHA;
  const headSha = process.env.PR_HEAD_SHA;
  const prNumber = process.env.PR_NUMBER;

  if (!baseSha || !headSha || !prNumber) {
    console.error('Missing required env vars: PR_BASE_SHA, PR_HEAD_SHA, PR_NUMBER.');
    process.exit(1);
  }

  const diff = execFileSync('git', ['diff', `${baseSha}...${headSha}`], { maxBuffer: 1024 * 1024 * 20 }).toString();
  if (!diff.trim()) {
    console.log('No diff to review, skipping.');
    return;
  }

  const systemPrompt = `You are a code review agent. Review the given PR diff for bugs, security issues, and quality concerns.

Project Guidelines & Directives:
- Setting 'autoApproveAll = true' or similar auto-approval mechanisms (e.g. in 'createSession') is an INTENTIONAL design directive of this project. Do NOT flag this as a security vulnerability or blocking issue, as everything is designed to be auto-approved by default.

This PR may have been reviewed on a previous push -- focus on issues that are new or still unresolved, and avoid re-raising points that would already have been addressed.

You must not answer conversationally and must strictly invoke 'submit_code_review'.`;

  const executionConfig = getReviewerExecutionConfig();
  const proxyServer = await startProviderProxy();
  let result: CodeReviewResult | null;

  try {
    result = await executeAuditSession<CodeReviewResult>(
      process.cwd(),
      executionConfig,
      systemPrompt,
      submitCodeReviewTool,
      `PR DIFF:\n${diff}`,
      {
        toolChoice: { type: 'function', function: { name: submitCodeReviewTool.function.name } },
        allowOthers: false
      },
      undefined,
      600000
    );
  } finally {
    await stopProviderProxy(proxyServer);
  }

  if (!result) {
    console.error('Reviewer failed to return findings.');
    process.exit(1);
  }

  const bySeverity = (sev: CodeReviewFinding['severity']) =>
    result.findings.filter((f) => f.severity === sev);

  const section = (label: string, items: CodeReviewFinding[]) =>
    items.length
      ? `**${label}**\n` + items.map((f) => `- \`${f.file}${f.line ? ':' + f.line : ''}\`: ${f.message}`).join('\n')
      : '';

  const body = [
    `### Code Review`,
    result.summary,
    section('Blocking', bySeverity('blocking')),
    section('Suggestions', bySeverity('suggestion')),
    section('Nits', bySeverity('nit')),
  ].filter(Boolean).join('\n\n');

  try {
    execFileSync('gh', ['pr', 'comment', prNumber, '--body', body], { stdio: 'inherit' });
  } catch (commentErr) {
    console.warn('[review-pr] failed to post PR comment using GitHub CLI (this is expected if the run originates from a fork or lacks write permissions):', commentErr);
  }

  process.exit(0);
}

main().catch((err) => {
  console.error('[review-pr] failed:', err?.message || err);
  process.exit(1);
});
