import { db } from './index';

export interface PbiRecord {
  readonly pbiId: string;
  readonly specId: string;
  readonly title: string;
  readonly description: string | null;
  readonly status: 'pending' | 'in_progress' | 'blocked' | 'done';
  readonly dependsOn: string | null; // JSON string of pbiIds
  readonly createdAt: number;
  readonly updatedAt: number;
}

export function savePbi(pbi: PbiRecord): void {
  const stmt = db.prepare(`
    INSERT INTO pbis (
      pbiId, specId, title, description, status, dependsOn, createdAt, updatedAt
    ) VALUES (
      @pbiId, @specId, @title, @description, @status, @dependsOn, @createdAt, @updatedAt
    )
    ON CONFLICT(pbiId) DO UPDATE SET
      specId = excluded.specId,
      title = excluded.title,
      description = excluded.description,
      status = excluded.status,
      dependsOn = excluded.dependsOn,
      updatedAt = excluded.updatedAt
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
  });
}

export function getPbi(pbiId: string): PbiRecord | undefined {
  return db.prepare('SELECT * FROM pbis WHERE pbiId = ?').get(pbiId) as PbiRecord | undefined;
}

export function getPbisForSpec(specId: string): PbiRecord[] {
  return db.prepare('SELECT * FROM pbis WHERE specId = ? ORDER BY createdAt ASC').all(specId) as PbiRecord[];
}

export function deletePbi(pbiId: string): void {
  db.prepare('DELETE FROM pbis WHERE pbiId = ?').run(pbiId);
}

export function deletePbisForSpec(specId: string): void {
  db.prepare('DELETE FROM pbis WHERE specId = ?').run(specId);
}
