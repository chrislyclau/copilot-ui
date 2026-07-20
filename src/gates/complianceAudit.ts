import { getAuditorExecutionConfig, executeAuditSession } from '../utils/auditorHelper';
import { submitComplianceAuditTool } from '../config/tools';
import { getGitSandbox, getExecCommand, getWorkspaceRoot } from '../workspace';
import { getPbi, savePbi } from '../db/pbiStore';
import { getTasksForPbi, saveTask, getSpec, TaskRecord } from '../db/taskStore';
import { getAuditorMaxTierIndex } from '../config/models';
import crypto from 'crypto';

export interface ComplianceFinding {
  readonly title: string;
  readonly description: string;
}

/**
 * Distinguishes the remediation scenario an audit result falls into
 * (Issue 81 acceptance criteria: "Escalation entries distinguish between
 * different remediation scenarios"):
 * - 'clean': no findings; PBI marked done.
 * - 'findings-first-pass': findings on the first audit of this cycle;
 *   remediation tasks created via the normal task escalation ladder,
 *   audit's own tier unchanged.
 * - 'findings-audit-escalated': the *next* audit after a remediation cycle
 *   completed still found issues -- the audit's own model tier is escalated
 *   (RM-REQ-021) and further remediation tasks are created at the new tier.
 * - 'findings-pbi-parked': the audit was already on its highest tier and
 *   still found issues after a full remediation cycle -- the entire PBI is
 *   parked and a human escalation is raised (RM-REQ-022), no further
 *   remediation tasks are created.
 */
export type ComplianceAuditScenario =
  | 'clean'
  | 'findings-first-pass'
  | 'findings-audit-escalated'
  | 'findings-pbi-parked';

export interface ComplianceAuditResult {
  readonly pbiId: string;
  readonly pass: boolean;
  readonly findings: readonly ComplianceFinding[];
  /** taskIds of the remediation tasks created for this audit's findings, if any. */
  readonly remediationTaskIds: readonly string[];
  /** Which remediation scenario this result represents (Issue 81). */
  readonly scenario: ComplianceAuditScenario;
  /** The auditor tier index this audit ran at. */
  readonly auditTierIndex: number;
  /** True if this audit result parked the entire PBI (RM-REQ-022). */
  readonly pbiParked: boolean;
}

interface ComplianceAuditToolResult {
  pass: boolean;
  findings: ComplianceFinding[];
}

const SUBMIT_COMPLIANCE_AUDIT_EXAMPLE = `{
  "pass": false,
  "findings": [
    { "title": "Missing input validation on login endpoint", "description": "The spec requires request-body validation before touching the session store; the current diff calls into sessionStore.create directly with unvalidated input." }
  ]
}`;

const SYSTEM_PROMPT = `You are a strict PBI Compliance Auditor. Unlike the per-task Spec-Gate Auditor, you evaluate the *entire accumulated diff* of a Product Backlog Item (all of its tasks combined) against the subset of the specification relevant to that PBI. Your job is to catch drift or incomplete implementations that individual task-level gates would miss because no single task's diff shows the full picture.

You must not answer conversationally and must strictly invoke 'submit_compliance_audit'.

**How to call the tool:**
Call 'submit_compliance_audit' using your tool-calling capability (a real function/tool call), not as text in your message. Example of correctly-shaped arguments:

${SUBMIT_COMPLIANCE_AUDIT_EXAMPLE}`;

function buildUserPrompt(pbiTitle: string, pbiDescription: string, specContent: string, diff: string): string {
  return `Audit the following PBI's accumulated diff against trunk for compliance with the spec.

PBI TITLE: ${pbiTitle}
PBI DESCRIPTION: ${pbiDescription}

RELEVANT SPEC:
${specContent}

ACCUMULATED DIFF (pbi branch vs trunk):
${diff}`;
}

/**
 * Runs the PBI-level compliance-audit operation (RM-REQ-010): distinct from
 * per-task gates, evaluates the `pbi/<pbiId>` branch's accumulated diff
 * against trunk, checked against the spec.
 *
 * On findings (RM-REQ-013): creates new tasks within the same PBI via this
 * structured tool-call result directly -- NOT by writing prose into
 * architecture-spec.md for decomposeSpecIntoTasks' regex-based parser to
 * reparse -- and marks the PBI as not-yet-satisfied (status reverted to
 * 'in_progress').
 *
 * On a clean pass: marks the PBI 'done'. Per RM-REQ-017 (Issue 83 decision),
 * this does NOT merge pbi/<pbiId> into trunk -- that remains a human PR.
 */
export async function runComplianceAudit(
  cwd: string,
  pbiId: string,
  abortSignal?: AbortSignal
): Promise<ComplianceAuditResult> {
  const pbi = getPbi(pbiId);
  if (!pbi) {
    throw new Error(`No PBI found for pbiId "${pbiId}".`);
  }

  const sandbox = getGitSandbox();
  // git diff base...pbi returns exit 0 with empty stdout when there are no
  // commits yet -- that's the legitimate "nothing to audit" case handled
  // below. A thrown error here means something actually went wrong (missing
  // pbi/<pbiId> branch, git failure, etc.) and must propagate rather than be
  // silently treated as a clean, model-free pass.
  const diff = await sandbox.getPbiDiffAsync(pbiId);

  if (!diff.trim()) {
    // Nothing accumulated on the PBI branch yet -- nothing to audit.
    // Deliberately does not mark the PBI done: an empty diff is not the
    // same claim as "the diff satisfies the spec".
    return {
      pbiId,
      pass: true,
      findings: [],
      remediationTaskIds: [],
      scenario: 'clean',
      auditTierIndex: pbi.auditTierIndex ?? 0,
      pbiParked: false,
    };
  }

  // Spec scoping: the roadmap calls for auditing against "the subset of the
  // spec relevant to that PBI" (RM-REQ-010). There is no separate per-PBI
  // spec-slicing mechanism yet, so the full spec is passed together with the
  // PBI's own title/description as scoping context for the model. Slicing
  // the spec itself is a reasonable follow-up but out of scope here.
  let specContent = '';
  const specRecord = getSpec(pbi.specId);
  if (specRecord) {
    try {
      const execResult = await getExecCommand()(
        `cd '${getWorkspaceRoot()}' && cat '${specRecord.filePath}'`,
        abortSignal
      );
      if (execResult.exitCode === 0) {
        specContent = execResult.stdout;
      }
    } catch (e) {
      // Fall through with an empty spec; the audit prompt below still runs,
      // giving the model the diff and PBI context even without spec text.
    }
  }

  const auditTierIndex = pbi.auditTierIndex ?? 0;
  const executionConfig = getAuditorExecutionConfig(undefined, auditTierIndex);
  const userPrompt = buildUserPrompt(pbi.title, pbi.description ?? '', specContent, diff);

  const result = await executeAuditSession<ComplianceAuditToolResult>(
    cwd,
    executionConfig,
    SYSTEM_PROMPT,
    submitComplianceAuditTool,
    userPrompt,
    { toolCallExample: SUBMIT_COMPLIANCE_AUDIT_EXAMPLE },
    abortSignal
  );

  if (!result || typeof result.pass !== 'boolean' || !Array.isArray(result.findings)) {
    throw new Error(
      `Compliance audit for pbiId "${pbiId}" failed: model did not return a proper submit_compliance_audit tool call.`
    );
  }

  if (result.pass && result.findings.length === 0) {
    // A clean pass resets the audit escalation ladder (RM-REQ-021 only
    // applies to *repeated* failures) -- a subsequent finding on some later
    // remediation cycle should start back at tier 0, not inherit an
    // escalated tier from an unrelated earlier cycle.
    savePbi({
      ...pbi,
      status: 'done',
      auditTierIndex: 0,
      lastAuditHadFindings: false,
      updatedAt: Date.now(),
    });
    return {
      pbiId,
      pass: true,
      findings: [],
      remediationTaskIds: [],
      scenario: 'clean',
      auditTierIndex: 0,
      pbiParked: false,
    };
  }

  // RM-REQ-021: distinguish a first-time finding (mid-cycle, tier
  // unchanged) from a *repeat* finding after a full remediation cycle.
  // `lastAuditHadFindings` alone is not sufficient: shouldTriggerComplianceAudit's
  // periodic trigger (RM-REQ-012) can fire this audit again while some of the
  // prior cycle's remediation tasks (which carry this same pbiId) are still
  // pending -- e.g. one remediation task done, others not, but doneCount hits
  // another periodic multiple. Escalating the audit tier or parking the PBI
  // in that situation would be premature: the remediation cycle hasn't
  // actually finished yet, so this audit run doesn't tell us anything about
  // whether the remediation worked. Only treat this as a genuine repeat
  // failure once every task on the PBI (including all remediation tasks) is
  // done -- i.e. this audit was reached via the end-of-pbi trigger, or a
  // periodic trigger that happens to coincide with full completion.
  const allTasksForPbiDone = (() => {
    const tasks = getTasksForPbi(pbiId);
    return tasks.length > 0 && tasks.every((t) => t.status === 'done');
  })();
  const isRepeatFailure = pbi.lastAuditHadFindings === true && allTasksForPbiDone;
  const now = Date.now();

  if (isRepeatFailure) {
    const maxTierIndex = getAuditorMaxTierIndex();
    if (auditTierIndex >= maxTierIndex) {
      // RM-REQ-022: highest-tier persistent failure after a full
      // remediation cycle -- park the entire PBI (not just individual
      // tasks) rather than spinning up yet more remediation tasks, and
      // signal the caller to raise an async human escalation.
      savePbi({
        ...pbi,
        status: 'blocked',
        auditTierIndex,
        lastAuditHadFindings: true,
        updatedAt: now,
      });
      return {
        pbiId,
        pass: false,
        findings: result.findings,
        remediationTaskIds: [],
        scenario: 'findings-pbi-parked',
        auditTierIndex,
        pbiParked: true,
      };
    }
  }

  // RM-REQ-013/RM-REQ-020: findings create new remediation tasks via this
  // structured tool-call result directly, not by writing prose for the
  // regex-based decomposer. These tasks then go through the *same* tiered
  // task-escalation ladder (retry same model -> escalate model tier -> park)
  // that gateLoop.ts already applies to every ordinary task -- no separate
  // remediation-specific ladder is needed for the tasks themselves.
  const specVersion = specRecord?.version ?? 'unknown';
  const remediationTaskIds: string[] = [];

  for (const finding of result.findings) {
    const taskId = `${pbiId}-remediation-${crypto.randomBytes(4).toString('hex')}`;
    const task: TaskRecord = {
      taskId,
      specId: pbi.specId,
      specVersion,
      title: finding.title,
      description: finding.description,
      status: 'pending',
      touches: null,
      dependsOn: null,
      branchName: null,
      blockedReason: null,
      createdAt: now,
      updatedAt: now,
      pbiId,
    };
    saveTask(task);
    remediationTaskIds.push(taskId);
  }

  const nextAuditTierIndex = isRepeatFailure ? auditTierIndex + 1 : auditTierIndex;

  // RM-REQ-013: mark the PBI's completion state as not-yet-satisfied, and
  // (RM-REQ-021) escalate the audit's own tier if this was a repeat failure,
  // recording that a finding is now pending so the *next* audit for this PBI
  // is correctly recognized as a potential repeat.
  savePbi({
    ...pbi,
    status: 'in_progress',
    auditTierIndex: nextAuditTierIndex,
    lastAuditHadFindings: true,
    updatedAt: now,
  });

  return {
    pbiId,
    pass: false,
    findings: result.findings,
    remediationTaskIds,
    scenario: isRepeatFailure ? 'findings-audit-escalated' : 'findings-first-pass',
    auditTierIndex: nextAuditTierIndex,
    pbiParked: false,
  };
}

/**
 * Env-configurable periodic drift-check interval (RM-REQ-012): if set to a
 * positive integer N, a standing compliance audit is triggered every N tasks
 * that reach `done` within a PBI, independent of and prior to the
 * end-of-PBI trigger in RM-REQ-011. Unset or <= 0 disables periodic
 * triggering (only the end-of-PBI trigger applies).
 */
export function getPeriodicAuditIntervalTasks(): number {
  const raw = process.env.PBI_COMPLIANCE_AUDIT_PERIODIC_N;
  if (!raw) return 0;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Decides whether a compliance audit should fire for `pbiId` right now,
 * given the current state of its tasks (RM-REQ-011/012). Called after a
 * task successfully merges into pbi/<pbiId>.
 *
 * Precedence: if all tasks are done, the end-of-PBI trigger (RM-REQ-011)
 * always fires, regardless of the periodic interval -- there is no reason
 * to defer a full-completion audit because a periodic checkpoint hasn't
 * been reached yet. Otherwise, the periodic trigger (RM-REQ-012) fires
 * when the done-count is a positive multiple of the configured interval.
 */
export function shouldTriggerComplianceAudit(
  pbiId: string
): { trigger: boolean; reason: 'end-of-pbi' | 'periodic' | null } {
  const tasks = getTasksForPbi(pbiId);
  if (tasks.length === 0) {
    return { trigger: false, reason: null };
  }
  const doneCount = tasks.filter((t) => t.status === 'done').length;
  const allDone = doneCount === tasks.length;
  if (allDone) {
    return { trigger: true, reason: 'end-of-pbi' };
  }
  const interval = getPeriodicAuditIntervalTasks();
  if (interval > 0 && doneCount > 0 && doneCount % interval === 0) {
    return { trigger: true, reason: 'periodic' };
  }
  return { trigger: false, reason: null };
}
