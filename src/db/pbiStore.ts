import { db } from './index';

export interface PbiRecord {
  readonly pbiId: string;
  readonly specId: string;
  readonly title: string;
  readonly description: string | null;
  readonly status: 'pending' | 'in_progress' | 'blocked' | 'pr_ready' | 'done';
  readonly dependsOn: string | null; // JSON string of pbiIds
  readonly createdAt: number;
  readonly updatedAt: number;
  /** Issue 81/RM-REQ-021: compliance-audit's own escalation tier for this PBI. Defaults to 0. */
  readonly auditTierIndex?: number;
  /**
   * Issue 81: whether the most recently *run* compliance audit for this PBI
   * reported findings. Used to distinguish a first-time finding (creates
   * remediation tasks, tier unchanged) from a repeat finding after a
   * completed remediation cycle (escalates the audit's own tier per
   * RM-REQ-021). Reset to false on a clean pass.
   */
  readonly lastAuditHadFindings?: boolean;
}

interface PbiRow {
  readonly pbiId: string;
  readonly specId: string;
  readonly title: string;
  readonly description: string | null;
  readonly status: 'pending' | 'in_progress' | 'blocked' | 'pr_ready' | 'done';
  readonly dependsOn: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly auditTierIndex: number | null;
  readonly lastAuditHadFindings: number | null;
}

function rowToPbi(row: PbiRow): PbiRecord {
  return {
    ...row,
    auditTierIndex: row.auditTierIndex ?? 0,
    lastAuditHadFindings: !!row.lastAuditHadFindings,
  };
}

export function savePbi(pbi: PbiRecord): void {
  const stmt = db.prepare(`
    INSERT INTO pbis (
      pbiId, specId, title, description, status, dependsOn, createdAt, updatedAt, auditTierIndex, lastAuditHadFindings
    ) VALUES (
      @pbiId, @specId, @title, @description, @status, @dependsOn, @createdAt, @updatedAt, @auditTierIndex, @lastAuditHadFindings
    )
    ON CONFLICT(pbiId) DO UPDATE SET
      specId = excluded.specId,
      title = excluded.title,
      description = excluded.description,
      status = excluded.status,
      dependsOn = excluded.dependsOn,
      updatedAt = excluded.updatedAt,
      auditTierIndex = excluded.auditTierIndex,
      lastAuditHadFindings = excluded.lastAuditHadFindings
  `);
  stmt.run({
    pbiId: pbi.pbiId,
    specId: pbi.specId,
    title: pbi.title,
    description: pbi.description,
    status: pbi.status,
    dependsOn: pbi.dependsOn,
    createdAt: pbi.createdAt,
    updatedAt: pbi.updatedAt,
    auditTierIndex: pbi.auditTierIndex ?? 0,
    lastAuditHadFindings: pbi.lastAuditHadFindings ? 1 : 0,
  });
}

export function getPbi(pbiId: string): PbiRecord | undefined {
  const row = db.prepare('SELECT * FROM pbis WHERE pbiId = ?').get(pbiId) as PbiRow | undefined;
  return row ? rowToPbi(row) : undefined;
}

export function getPbisForSpec(specId: string): PbiRecord[] {
  const rows = db.prepare('SELECT * FROM pbis WHERE specId = ? ORDER BY createdAt ASC').all(specId) as PbiRow[];
  return rows.map(rowToPbi);
}

export function deletePbisForSpec(specId: string): void {
  db.prepare('DELETE FROM pbis WHERE specId = ?').run(specId);
}
