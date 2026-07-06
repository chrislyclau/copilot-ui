import { db } from './index';

export interface SpecRecord {
  readonly specId: string;
  readonly filePath: string;
  readonly version: string;
  readonly createdAt: number;
}

export interface TaskRecord {
  readonly taskId: string;
  readonly specId: string | null;
  readonly specVersion: string;
  readonly title: string;
  readonly description: string | null;
  readonly status: 'pending' | 'running' | 'blocked' | 'done' | 'stale' | 'superseded';
  readonly touches: string | null; // JSON string of file paths/globs
  readonly dependsOn: string | null; // JSON string of taskIds
  readonly branchName: string | null;
  readonly blockedReason: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export function saveSpec(spec: SpecRecord): void {
  const stmt = db.prepare(`
    INSERT INTO specs (specId, filePath, version, createdAt)
    VALUES (@specId, @filePath, @version, @createdAt)
    ON CONFLICT(specId) DO UPDATE SET
      filePath = excluded.filePath,
      version = excluded.version,
      createdAt = excluded.createdAt
  `);
  stmt.run({
    specId: spec.specId,
    filePath: spec.filePath,
    version: spec.version,
    createdAt: spec.createdAt,
  });
}

export function getSpec(specId: string): SpecRecord | undefined {
  return db.prepare('SELECT * FROM specs WHERE specId = ?').get(specId) as SpecRecord | undefined;
}

export function getSpecByPathAndVersion(filePath: string, version: string): SpecRecord | undefined {
  return db.prepare('SELECT * FROM specs WHERE filePath = ? AND version = ?').get(filePath, version) as SpecRecord | undefined;
}

export function saveTask(task: TaskRecord): void {
  const stmt = db.prepare(`
    INSERT INTO tasks (
      taskId, specId, specVersion, title, description, status,
      touches, dependsOn, branchName, blockedReason, createdAt, updatedAt
    ) VALUES (
      @taskId, @specId, @specVersion, @title, @description, @status,
      @touches, @dependsOn, @branchName, @blockedReason, @createdAt, @updatedAt
    )
    ON CONFLICT(taskId) DO UPDATE SET
      specId = excluded.specId,
      specVersion = excluded.specVersion,
      title = excluded.title,
      description = excluded.description,
      status = excluded.status,
      touches = excluded.touches,
      dependsOn = excluded.dependsOn,
      branchName = excluded.branchName,
      blockedReason = excluded.blockedReason,
      updatedAt = excluded.updatedAt
  `);
  stmt.run({
    taskId: task.taskId,
    specId: task.specId,
    specVersion: task.specVersion,
    title: task.title,
    description: task.description,
    status: task.status,
    touches: task.touches,
    dependsOn: task.dependsOn,
    branchName: task.branchName,
    blockedReason: task.blockedReason,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  });
}

export function getTask(taskId: string): TaskRecord | undefined {
  return db.prepare('SELECT * FROM tasks WHERE taskId = ?').get(taskId) as TaskRecord | undefined;
}

export function getTasksForSpec(specId: string): TaskRecord[] {
  return db.prepare('SELECT * FROM tasks WHERE specId = ? ORDER BY createdAt ASC').all(specId) as TaskRecord[];
}

export function deleteTasksForSpec(specId: string): void {
  db.prepare('DELETE FROM tasks WHERE specId = ?').run(specId);
}
