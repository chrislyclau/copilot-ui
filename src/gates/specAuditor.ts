import { getAuditorExecutionConfig, executeAuditSession } from '../utils/auditorHelper';
import { submitSpecAuditTool } from '../config/tools';
import { getGitSandbox, getExecCommand } from '../workspace';

export async function runSpecAudit(cwd: string, abortSignal?: AbortSignal): Promise<{ pass: boolean; feedback: string }> {
  const targetCwd = cwd;
  const executionConfig = getAuditorExecutionConfig();

  try {
    console.log('[runSpecAudit] Start git diff async...');
    // 1. Get git diff against active container sandbox worktree
    let diff = '';
    try {
      diff = await getGitSandbox().getGitDiffAsync();
    } catch (e: any) {
      diff = e.stdout?.toString() || '';
    }
    console.log('[runSpecAudit] Diff length:', diff.length);

    if (!diff.trim()) {
      return { pass: true, feedback: 'No code changes to audit (empty git diff).' };
    }

    // 2. Read architecture-spec.md
    let spec = '';
    const execResult = await getExecCommand()(
      targetCwd ? `cd '${targetCwd}' && cat architecture-spec.md` : 'cat architecture-spec.md',
      abortSignal
    );
    if (execResult.exitCode === 0) {
      spec = execResult.stdout;
      console.log('[runSpecAudit] Spec found, length:', spec.length);
    } else {
      console.log('[runSpecAudit] No spec found.');
      return { pass: true, feedback: 'No architecture-spec.md found.' };
    }

    const systemPrompt = `You are a strict Spec-Gate Auditor checking for structural deviations.
You must not answer conversationally and must strictly invoke 'submit_spec_audit'.`;

    const auditPrompt = `
      Analyze the current code patch against the architecture spec.
      
      ARCHITECTURE SPEC:
      ${spec}
      
      GIT DIFF:
      ${diff}
    `;

    console.log('[runSpecAudit] Executing audit session...');
    const auditResult = await executeAuditSession<any>(
      targetCwd,
      executionConfig,
      systemPrompt,
      submitSpecAuditTool,
      auditPrompt,
      {
        toolChoice: { type: 'function', function: { name: submitSpecAuditTool.function.name } },
      },
      abortSignal
    );

    if (auditResult) {
      if (auditResult.pass === false || auditResult.violation_type === 'SPEC_VIOLATION') {
        return { pass: false, feedback: `SPEC_VIOLATION: ${auditResult.feedback}` };
      }
      return { pass: true, feedback: auditResult.feedback || 'PASS' };
    }

    return { pass: false, feedback: 'SPEC_VIOLATION: Auditor failed to return a proper tool call.' };
  } catch (err: any) {
    return { pass: false, feedback: `SPEC_VIOLATION: Auditor session crashed: ${err.message || err}` };
  }
}
