import { describe, it, beforeEach, expect, vi } from 'vitest';
import * as path from 'path';
import * as fs from 'fs';
import { db } from '../db/index';
import { saveSpec, saveTask, getTask, getTasksForPbi } from '../db/taskStore';
import { savePbi, getPbi } from '../db/pbiStore';
import { getGitSandbox, getWorkspaceRoot, initializeWorkspace } from '../workspace';

vi.mock('../utils/auditorHelper', async () => {
  const actual = await vi.importActual<typeof import('../utils/auditorHelper')>('../utils/auditorHelper');
  return {
    ...actual,
    getAuditorExecutionConfig: (_apiKey?: string, tierIndex: number = 0) => ({
      model: `mock-model-tier-${tierIndex}`,
      provider: undefined,
    }),
    executeAuditSession: vi.fn(),
  };
});

import { executeAuditSession } from '../utils/auditorHelper';
import {
  runComplianceAudit,
  shouldTriggerComplianceAudit,
  getPeriodicAuditIntervalTasks,
} from '../gates/complianceAudit';

const mockedExecuteAuditSession = executeAuditSession as unknown as ReturnType<typeof vi.fn>;

describe('Compliance-audit operation (Issue 82 / RM-REQ-010/011/012/013)', () => {
  const specId = 'spec-compliance-test';

  beforeEach(async () => {
    await initializeWorkspace();
    db.prepare('DELETE FROM tasks').run();
    db.prepare('DELETE FROM pbis').run();
    db.prepare('DELETE FROM specs').run();
    mockedExecuteAuditSession.mockReset();
    delete process.env.PBI_COMPLIANCE_AUDIT_PERIODIC_N;

    saveSpec({ specId, filePath: 'architecture-spec.md', version: 'v1', createdAt: Date.now() });
  });

  function registerPbi(pbiId: string) {
    savePbi({
      pbiId,
      specId,
      title: `PBI ${pbiId}`,
      description: 'Test PBI for compliance audit',
      status: 'in_progress',
      dependsOn: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  }

  it('throws when the pbiId does not exist', async () => {
    await expect(runComplianceAudit(getWorkspaceRoot(), 'pbi-does-not-exist')).rejects.toThrow(/No PBI found/);
    expect(mockedExecuteAuditSession).not.toHaveBeenCalled();
  });

  it('throws when pbi/<pbiId> does not exist as a branch, rather than treating it as a clean empty-diff pass', async () => {
    const pbiId = 'pbi-no-branch-ever-created';
    registerPbi(pbiId);
    // Deliberately never call ensurePbiBranch/checkoutTaskBranch for this
    // pbiId, so `git diff base...pbi/<pbiId>` fails for real (unknown
    // revision), rather than the legitimate "no commits yet" empty-stdout
    // case. This must propagate as an error, not be reported as pass=true.
    await expect(runComplianceAudit(getWorkspaceRoot(), pbiId)).rejects.toThrow();
    expect(mockedExecuteAuditSession).not.toHaveBeenCalled();
  });

  it('short-circuits with pass=true and no model call when pbi/<pbiId> has no diff against trunk', async () => {
    const pbiId = 'pbi-empty-diff';
    registerPbi(pbiId);
    await getGitSandbox().ensurePbiBranch(pbiId);

    const result = await runComplianceAudit(getWorkspaceRoot(), pbiId);

    expect(result.pass).toBe(true);
    expect(result.findings).toHaveLength(0);
    expect(mockedExecuteAuditSession).not.toHaveBeenCalled();

    // Empty diff is not the same claim as "satisfies the spec" -- must not
    // mark the PBI done off an empty diff.
    expect(getPbi(pbiId)?.status).toBe('in_progress');
  });

  it('marks the PBI done on a clean audit (no findings)', async () => {
    const pbiId = 'pbi-clean-pass';
    const taskId = 'task-clean-pass';
    registerPbi(pbiId);
    saveTask({
      taskId, specId, specVersion: 'v1', title: 'Do work', description: null,
      status: 'done', touches: null, dependsOn: null, branchName: `task/${taskId}`,
      blockedReason: null, createdAt: Date.now(), updatedAt: Date.now(), pbiId,
    });

    const sandbox = getGitSandbox();
    await sandbox.checkoutTaskBranch(taskId, pbiId);
    fs.writeFileSync(path.join(getWorkspaceRoot(), 'clean-pass-output.txt'), 'work', 'utf8');
    await sandbox.commitAllChangesAsync('Do work');
    await sandbox.mergeTaskIntoPbi(taskId, pbiId);

    mockedExecuteAuditSession.mockResolvedValue({ pass: true, findings: [] });

    const result = await runComplianceAudit(getWorkspaceRoot(), pbiId);

    expect(result.pass).toBe(true);
    expect(result.remediationTaskIds).toHaveLength(0);
    expect(getPbi(pbiId)?.status).toBe('done');

    // Confirms the forced-tool-call discipline, mirroring the Auditor/Reviewer/
    // PBI-derivation pattern.
    const [, , , tool] = mockedExecuteAuditSession.mock.calls[0] as unknown[];
    expect((tool as { function: { name: string } }).function.name).toBe('submit_compliance_audit');
  });

  it('creates remediation tasks via structured result and marks the PBI not-yet-satisfied on findings', async () => {
    const pbiId = 'pbi-with-findings';
    const taskId = 'task-with-findings';
    registerPbi(pbiId);
    saveTask({
      taskId, specId, specVersion: 'v1', title: 'Do work', description: null,
      status: 'done', touches: null, dependsOn: null, branchName: `task/${taskId}`,
      blockedReason: null, createdAt: Date.now(), updatedAt: Date.now(), pbiId,
    });

    const sandbox = getGitSandbox();
    await sandbox.checkoutTaskBranch(taskId, pbiId);
    fs.writeFileSync(path.join(getWorkspaceRoot(), 'with-findings-output.txt'), 'incomplete work', 'utf8');
    await sandbox.commitAllChangesAsync('Do incomplete work');
    await sandbox.mergeTaskIntoPbi(taskId, pbiId);

    mockedExecuteAuditSession.mockResolvedValue({
      pass: false,
      findings: [
        { title: 'Missing error handling', description: 'The spec requires a try/catch around the write.' },
        { title: 'Missing test coverage', description: 'No test exercises the failure path.' },
      ],
    });

    const result = await runComplianceAudit(getWorkspaceRoot(), pbiId);

    expect(result.pass).toBe(false);
    expect(result.remediationTaskIds).toHaveLength(2);

    // RM-REQ-013: tasks created programmatically from the structured result,
    // not by writing prose into architecture-spec.md.
    const remediationTasks = getTasksForPbi(pbiId).filter((t) => t.taskId !== taskId);
    expect(remediationTasks).toHaveLength(2);
    expect(remediationTasks.map((t) => t.title).sort()).toEqual(
      ['Missing error handling', 'Missing test coverage'].sort()
    );
    expect(remediationTasks.every((t) => t.status === 'pending')).toBe(true);
    expect(remediationTasks.every((t) => t.pbiId === pbiId)).toBe(true);

    // RM-REQ-013: PBI's completion state marked not-yet-satisfied.
    expect(getPbi(pbiId)?.status).toBe('in_progress');
  });

  it('throws when the model never returns a valid submit_compliance_audit tool call', async () => {
    const pbiId = 'pbi-bad-tool-call';
    const taskId = 'task-bad-tool-call';
    registerPbi(pbiId);
    saveTask({
      taskId, specId, specVersion: 'v1', title: 'Do work', description: null,
      status: 'done', touches: null, dependsOn: null, branchName: `task/${taskId}`,
      blockedReason: null, createdAt: Date.now(), updatedAt: Date.now(), pbiId,
    });
    const sandbox = getGitSandbox();
    await sandbox.checkoutTaskBranch(taskId, pbiId);
    fs.writeFileSync(path.join(getWorkspaceRoot(), 'bad-tool-call-output.txt'), 'work', 'utf8');
    await sandbox.commitAllChangesAsync('Do work');
    await sandbox.mergeTaskIntoPbi(taskId, pbiId);

    mockedExecuteAuditSession.mockResolvedValue(null);

    await expect(runComplianceAudit(getWorkspaceRoot(), pbiId)).rejects.toThrow(
      /did not return a proper submit_compliance_audit/
    );
  });

  describe('Tiered escalation for compliance-audit remediation (Issue 81 / RM-REQ-020/021/022)', () => {
    function markPbiTaskDone(pbiId: string, taskId: string, content: string) {
      // Helper mirroring the other tests' pattern: put a task's diff onto
      // pbi/<pbiId> so runComplianceAudit has something to audit.
      return (async () => {
        const sandbox = getGitSandbox();
        await sandbox.checkoutTaskBranch(taskId, pbiId);
        fs.writeFileSync(path.join(getWorkspaceRoot(), `${taskId}-output.txt`), content, 'utf8');
        await sandbox.commitAllChangesAsync(`Do work for ${taskId}`);
        await sandbox.mergeTaskIntoPbi(taskId, pbiId);
      })();
    }

    it('a first-time finding creates remediation tasks without escalating the audit tier', async () => {
      const pbiId = 'pbi-first-finding';
      const taskId = 'task-first-finding';
      registerPbi(pbiId);
      saveTask({
        taskId, specId, specVersion: 'v1', title: 'Do work', description: null,
        status: 'done', touches: null, dependsOn: null, branchName: `task/${taskId}`,
        blockedReason: null, createdAt: Date.now(), updatedAt: Date.now(), pbiId,
      });
      await markPbiTaskDone(pbiId, taskId, 'incomplete work');

      mockedExecuteAuditSession.mockResolvedValue({
        pass: false,
        findings: [{ title: 'Missing validation', description: 'Spec requires input validation.' }],
      });

      const result = await runComplianceAudit(getWorkspaceRoot(), pbiId);

      expect(result.scenario).toBe('findings-first-pass');
      expect(result.pbiParked).toBe(false);
      expect(result.auditTierIndex).toBe(0);
      expect(result.remediationTaskIds).toHaveLength(1);
      expect(getPbi(pbiId)?.auditTierIndex).toBe(0);
      expect(getPbi(pbiId)?.lastAuditHadFindings).toBe(true);
      expect(getPbi(pbiId)?.status).toBe('in_progress');
    });

    it('escalates the audit tier when a repeat audit (after remediation) still finds issues', async () => {
      const pbiId = 'pbi-repeat-finding';
      const taskId = 'task-repeat-finding';
      registerPbi(pbiId);
      saveTask({
        taskId, specId, specVersion: 'v1', title: 'Do work', description: null,
        status: 'done', touches: null, dependsOn: null, branchName: `task/${taskId}`,
        blockedReason: null, createdAt: Date.now(), updatedAt: Date.now(), pbiId,
      });
      await markPbiTaskDone(pbiId, taskId, 'incomplete work');

      // First audit: finds an issue, tier stays at 0.
      mockedExecuteAuditSession.mockResolvedValue({
        pass: false,
        findings: [{ title: 'Missing validation', description: 'Spec requires input validation.' }],
      });
      const first = await runComplianceAudit(getWorkspaceRoot(), pbiId);
      expect(first.scenario).toBe('findings-first-pass');
      expect(first.remediationTaskIds).toHaveLength(1);

      // Simulate the remediation cycle actually completing: the remediation
      // task's work lands on pbi/<pbiId> AND the task itself is marked done
      // (both are required for allTasksForPbiDone -- merely merging more
      // commits onto the branch without completing the task is exactly the
      // premature-escalation bug this guards against).
      const remediationTaskId = first.remediationTaskIds[0]!;
      fs.writeFileSync(path.join(getWorkspaceRoot(), 'remediation-output.txt'), 'still incomplete', 'utf8');
      await getGitSandbox().checkoutTaskBranch(remediationTaskId, pbiId);
      await getGitSandbox().commitAllChangesAsync('Remediation attempt');
      await getGitSandbox().mergeTaskIntoPbi(remediationTaskId, pbiId);
      const remediationTask = getTasksForPbi(pbiId).find((t) => t.taskId === remediationTaskId)!;
      saveTask({ ...remediationTask, status: 'done', updatedAt: Date.now() });

      // Second (repeat) audit: still finds an issue -- must escalate tier.
      mockedExecuteAuditSession.mockResolvedValue({
        pass: false,
        findings: [{ title: 'Still missing validation', description: 'Remediation did not fix it.' }],
      });
      const second = await runComplianceAudit(getWorkspaceRoot(), pbiId);

      expect(second.scenario).toBe('findings-audit-escalated');
      expect(second.auditTierIndex).toBe(1);
      expect(second.pbiParked).toBe(false);
      expect(second.remediationTaskIds).toHaveLength(1);
      expect(getPbi(pbiId)?.auditTierIndex).toBe(1);
      expect(getPbi(pbiId)?.status).toBe('in_progress');

      // The repeat-failure audit itself runs at the *still-current* tier
      // (tier can only be known to need escalation after seeing this
      // result) -- the escalated tier takes effect starting with the next
      // audit run for this PBI, which is what result.auditTierIndex (and
      // the persisted PBI record) reflect going forward.
      const firstCallConfig = (mockedExecuteAuditSession.mock.calls[0] as unknown[])[1] as { model: string };
      const secondCallConfig = (mockedExecuteAuditSession.mock.calls[1] as unknown[])[1] as { model: string };
      expect(secondCallConfig.model).toBe(firstCallConfig.model);
      expect(secondCallConfig.model).toBe('mock-model-tier-0');

      // A third audit run (after the tier-1 remediation cycle completes)
      // must actually use the escalated tier.
      const secondRemediationTaskId = second.remediationTaskIds[0]!;
      fs.writeFileSync(path.join(getWorkspaceRoot(), 'remediation-2-output.txt'), 'yet another attempt', 'utf8');
      await getGitSandbox().checkoutTaskBranch(secondRemediationTaskId, pbiId);
      await getGitSandbox().commitAllChangesAsync('Second remediation attempt');
      await getGitSandbox().mergeTaskIntoPbi(secondRemediationTaskId, pbiId);
      const secondRemediationTask = getTasksForPbi(pbiId).find((t) => t.taskId === secondRemediationTaskId)!;
      saveTask({ ...secondRemediationTask, status: 'done', updatedAt: Date.now() });

      mockedExecuteAuditSession.mockResolvedValue({ pass: true, findings: [] });
      await runComplianceAudit(getWorkspaceRoot(), pbiId);

      const thirdCallConfig = (mockedExecuteAuditSession.mock.calls[2] as unknown[])[1] as { model: string };
      expect(thirdCallConfig.model).toBe('mock-model-tier-1');
    });

    it('parks the entire PBI when the highest audit tier still finds issues after a full remediation cycle', async () => {
      const pbiId = 'pbi-parked';
      const taskId = 'task-parked';
      registerPbi(pbiId);
      saveTask({
        taskId, specId, specVersion: 'v1', title: 'Do work', description: null,
        status: 'done', touches: null, dependsOn: null, branchName: `task/${taskId}`,
        blockedReason: null, createdAt: Date.now(), updatedAt: Date.now(), pbiId,
      });
      await markPbiTaskDone(pbiId, taskId, 'incomplete work');

      // Force the PBI to already be at the highest audit tier, mid-cycle
      // (a prior audit already found something and remediation ran).
      const maxTierPbi = getPbi(pbiId)!;
      savePbi({
        ...maxTierPbi,
        auditTierIndex: 2, // highest configured tier (0, 1, 2)
        lastAuditHadFindings: true,
      });

      mockedExecuteAuditSession.mockResolvedValue({
        pass: false,
        findings: [{ title: 'Persistent issue', description: 'Still broken at the top tier.' }],
      });

      const result = await runComplianceAudit(getWorkspaceRoot(), pbiId);

      expect(result.scenario).toBe('findings-pbi-parked');
      expect(result.pbiParked).toBe(true);
      expect(result.remediationTaskIds).toHaveLength(0);
      expect(getPbi(pbiId)?.status).toBe('blocked');
      expect(getPbi(pbiId)?.auditTierIndex).toBe(2);

      // No further remediation tasks were spun up for a parked PBI.
      const tasks = getTasksForPbi(pbiId).filter((t) => t.taskId !== taskId);
      expect(tasks).toHaveLength(0);
    });

    it('resets the audit tier back to 0 on a subsequent clean pass', async () => {
      const pbiId = 'pbi-reset-on-clean';
      const taskId = 'task-reset-on-clean';
      registerPbi(pbiId);
      saveTask({
        taskId, specId, specVersion: 'v1', title: 'Do work', description: null,
        status: 'done', touches: null, dependsOn: null, branchName: `task/${taskId}`,
        blockedReason: null, createdAt: Date.now(), updatedAt: Date.now(), pbiId,
      });
      await markPbiTaskDone(pbiId, taskId, 'work');

      const escalatedPbi = getPbi(pbiId)!;
      savePbi({ ...escalatedPbi, auditTierIndex: 1, lastAuditHadFindings: true });

      mockedExecuteAuditSession.mockResolvedValue({ pass: true, findings: [] });

      const result = await runComplianceAudit(getWorkspaceRoot(), pbiId);

      expect(result.scenario).toBe('clean');
      expect(result.auditTierIndex).toBe(0);
      expect(getPbi(pbiId)?.auditTierIndex).toBe(0);
      expect(getPbi(pbiId)?.lastAuditHadFindings).toBe(false);
      expect(getPbi(pbiId)?.status).toBe('done');
    });
    it('does not escalate the tier or park the PBI when a repeat finding fires mid-cycle (remediation tasks still pending)', async () => {
      // Regression test for the reviewer-flagged bug: shouldTriggerComplianceAudit's
      // periodic trigger can re-run this audit while some of the prior cycle's
      // remediation tasks are still pending. lastAuditHadFindings alone must not
      // be treated as "a full remediation cycle completed and still failed".
      const pbiId = 'pbi-midcycle-repeat';
      const taskId = 'task-midcycle-repeat';
      registerPbi(pbiId);
      saveTask({
        taskId, specId, specVersion: 'v1', title: 'Do work', description: null,
        status: 'done', touches: null, dependsOn: null, branchName: `task/${taskId}`,
        blockedReason: null, createdAt: Date.now(), updatedAt: Date.now(), pbiId,
      });
      await markPbiTaskDone(pbiId, taskId, 'incomplete work');

      // First audit: finds an issue, creates a remediation task, tier stays at 0.
      mockedExecuteAuditSession.mockResolvedValue({
        pass: false,
        findings: [{ title: 'Missing validation', description: 'Spec requires input validation.' }],
      });
      const first = await runComplianceAudit(getWorkspaceRoot(), pbiId);
      expect(first.scenario).toBe('findings-first-pass');
      expect(first.remediationTaskIds).toHaveLength(1);

      // The remediation task from the first audit is still 'pending' -- the
      // remediation cycle has NOT completed. Simulate a periodic re-trigger
      // (e.g. an unrelated task on the same PBI merging) firing this audit
      // again anyway, while that remediation task is still outstanding.
      const pendingRemediationTask = getTasksForPbi(pbiId).find((t) => t.taskId !== taskId)!;
      expect(pendingRemediationTask.status).toBe('pending');

      mockedExecuteAuditSession.mockResolvedValue({
        pass: false,
        findings: [{ title: 'Missing validation', description: 'Spec requires input validation.' }],
      });
      const second = await runComplianceAudit(getWorkspaceRoot(), pbiId);

      // Must NOT be treated as a genuine repeat failure: the remediation
      // cycle from the first audit never actually finished.
      expect(second.scenario).toBe('findings-first-pass');
      expect(second.pbiParked).toBe(false);
      expect(second.auditTierIndex).toBe(0);
      expect(getPbi(pbiId)?.auditTierIndex).toBe(0);
      expect(getPbi(pbiId)?.status).toBe('in_progress');

      const secondCallConfig = (mockedExecuteAuditSession.mock.calls[1] as unknown[])[1] as { model: string };
      expect(secondCallConfig.model).toBe('mock-model-tier-0');
    });
  });

  describe('shouldTriggerComplianceAudit (RM-REQ-011/012)', () => {
    it('triggers end-of-pbi when all tasks are done, taking precedence over periodic', () => {
      process.env.PBI_COMPLIANCE_AUDIT_PERIODIC_N = '2';
      const pbiId = 'pbi-trigger-all-done';
      registerPbi(pbiId);
      for (let i = 0; i < 2; i++) {
        saveTask({
          taskId: `${pbiId}-t${i}`, specId, specVersion: 'v1', title: `t${i}`, description: null,
          status: 'done', touches: null, dependsOn: null, branchName: null,
          blockedReason: null, createdAt: Date.now(), updatedAt: Date.now(), pbiId,
        });
      }
      const decision = shouldTriggerComplianceAudit(pbiId);
      expect(decision).toEqual({ trigger: true, reason: 'end-of-pbi' });
    });

    it('triggers periodic when configured and done-count hits the interval, with tasks still pending', () => {
      process.env.PBI_COMPLIANCE_AUDIT_PERIODIC_N = '2';
      const pbiId = 'pbi-trigger-periodic';
      registerPbi(pbiId);
      saveTask({
        taskId: `${pbiId}-t0`, specId, specVersion: 'v1', title: 't0', description: null,
        status: 'done', touches: null, dependsOn: null, branchName: null,
        blockedReason: null, createdAt: Date.now(), updatedAt: Date.now(), pbiId,
      });
      saveTask({
        taskId: `${pbiId}-t1`, specId, specVersion: 'v1', title: 't1', description: null,
        status: 'done', touches: null, dependsOn: null, branchName: null,
        blockedReason: null, createdAt: Date.now(), updatedAt: Date.now(), pbiId,
      });
      saveTask({
        taskId: `${pbiId}-t2`, specId, specVersion: 'v1', title: 't2', description: null,
        status: 'pending', touches: null, dependsOn: null, branchName: null,
        blockedReason: null, createdAt: Date.now(), updatedAt: Date.now(), pbiId,
      });
      const decision = shouldTriggerComplianceAudit(pbiId);
      expect(decision).toEqual({ trigger: true, reason: 'periodic' });
    });

    it('does not trigger when neither condition is met', () => {
      process.env.PBI_COMPLIANCE_AUDIT_PERIODIC_N = '5';
      const pbiId = 'pbi-no-trigger';
      registerPbi(pbiId);
      saveTask({
        taskId: `${pbiId}-t0`, specId, specVersion: 'v1', title: 't0', description: null,
        status: 'done', touches: null, dependsOn: null, branchName: null,
        blockedReason: null, createdAt: Date.now(), updatedAt: Date.now(), pbiId,
      });
      saveTask({
        taskId: `${pbiId}-t1`, specId, specVersion: 'v1', title: 't1', description: null,
        status: 'pending', touches: null, dependsOn: null, branchName: null,
        blockedReason: null, createdAt: Date.now(), updatedAt: Date.now(), pbiId,
      });
      expect(shouldTriggerComplianceAudit(pbiId)).toEqual({ trigger: false, reason: null });
    });

    it('does not periodic-trigger when the interval env var is unset (disabled by default)', () => {
      const pbiId = 'pbi-periodic-disabled';
      registerPbi(pbiId);
      saveTask({
        taskId: `${pbiId}-t0`, specId, specVersion: 'v1', title: 't0', description: null,
        status: 'done', touches: null, dependsOn: null, branchName: null,
        blockedReason: null, createdAt: Date.now(), updatedAt: Date.now(), pbiId,
      });
      saveTask({
        taskId: `${pbiId}-t1`, specId, specVersion: 'v1', title: 't1', description: null,
        status: 'pending', touches: null, dependsOn: null, branchName: null,
        blockedReason: null, createdAt: Date.now(), updatedAt: Date.now(), pbiId,
      });
      expect(getPeriodicAuditIntervalTasks()).toBe(0);
      expect(shouldTriggerComplianceAudit(pbiId)).toEqual({ trigger: false, reason: null });
    });
  });
});
