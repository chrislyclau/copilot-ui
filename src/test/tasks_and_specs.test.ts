import { describe, it, beforeEach, expect } from 'vitest';
import { db } from '../db/index';
import { saveSpec, getSpec, saveTask, getTask, getTasksForSpec } from '../db/taskStore';
import { savePbi, getPbi, getPbisForSpec } from '../db/pbiStore';
import { decomposeSpecIntoTasks } from '../utils/taskManager';
import * as fs from 'fs';
import * as path from 'path';
import { getWorkspaceRoot } from '../workspace';

describe('Specs and Tasks Database & Decomposition layer', () => {
  const mockCwd = path.join(getWorkspaceRoot(), 'test-spec-tasks-dir');

  beforeEach(() => {
    db.prepare('DELETE FROM sessions').run();
    db.prepare('DELETE FROM tasks').run();
    db.prepare('DELETE FROM pbis').run();
    db.prepare('DELETE FROM specs').run();
    if (!fs.existsSync(mockCwd)) {
      fs.mkdirSync(mockCwd, { recursive: true });
    }
  });

  it('should save and get specs and tasks correctly', () => {
    saveSpec({
      specId: 'spec-abc',
      filePath: 'architecture-spec.md',
      version: 'abc123sha',
      createdAt: Date.now()
    });

    const spec = getSpec('spec-abc');
    expect(spec).toBeDefined();
    expect(spec?.filePath).toBe('architecture-spec.md');
    expect(spec?.version).toBe('abc123sha');

    saveTask({
      taskId: 'task-abc-1',
      specId: 'spec-abc',
      specVersion: 'abc123sha',
      title: 'Setup routing',
      description: 'Setup the auth and healthcheck routes',
      status: 'pending',
      touches: JSON.stringify(['src/server.ts']),
      dependsOn: null,
      branchName: null,
      blockedReason: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      pbiId: null,
    });

    const task = getTask('task-abc-1');
    expect(task).toBeDefined();
    expect(task?.title).toBe('Setup routing');
    expect(task?.status).toBe('pending');
  });

  it('should save and get PBIs correctly', () => {
    saveSpec({
      specId: 'spec-xyz',
      filePath: 'spec-xyz.md',
      version: 'xyz123sha',
      createdAt: Date.now()
    });

    savePbi({
      pbiId: 'pbi-xyz-1',
      specId: 'spec-xyz',
      title: 'Initialize DB Schema',
      description: 'Set up basic sqlite tables',
      status: 'pending',
      dependsOn: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    const pbi = getPbi('pbi-xyz-1');
    expect(pbi).toBeDefined();
    expect(pbi?.title).toBe('Initialize DB Schema');
    expect(pbi?.status).toBe('pending');

    const pbis = getPbisForSpec('spec-xyz');
    expect(pbis.length).toBe(1);
    expect(pbis[0]?.pbiId).toBe('pbi-xyz-1');
  });

  it('should decompose a markdown specification into first-class tasks', async () => {
    const specContent = `# System Spec v1.0
We need to build a modular calculator app with clean UI and complete test cases.

## Step 1: Initialize Project Structure
Create folders and setup Vite configs.

## Step 2: Implement Core Engine
Add add, subtract, multiply, and divide math functions with strict type-safety.

## Step 3: Implement Visual Layout
Use Tailwind CSS grid layouts to center the calculator.

## Step 4: Add Interactive State
Wire up inputs and standard operations using custom hooks.

## Step 5: Setup Keypad Shortcuts
Allow physical numeric keys to map to screen taps.

## Step 6: Add History Log panel
Keep track of previous formulas and answers in standard local memory.

## Step 7: Write Unit and Integration Tests
Validate standard math rules and error scenarios under Vitest.`;

    const specFile = path.join(mockCwd, 'architecture-spec.md');
    fs.writeFileSync(specFile, specContent, 'utf8');

    const result = await decomposeSpecIntoTasks('test-spec-tasks-dir');
    expect(result).not.toBeNull();
    
    const { spec, tasks } = result!;
    expect(spec).toBeDefined();
    expect(tasks.length).toBe(7);
    expect(tasks[0]?.title).toBe('Initialize Project Structure');
    expect(tasks[1]?.title).toBe('Implement Core Engine');
    expect(tasks[6]?.title).toBe('Write Unit and Integration Tests');

    // Dependencies checks: Task 2 should depend on Task 1
    expect(tasks[1]?.dependsOn).toBe(JSON.stringify([`${spec.specId}-step-1`]));

    // Assert that every task produced has a non-null pbiId
    for (const task of tasks) {
      expect(task.pbiId).not.toBeNull();
      expect(task.pbiId).toBe(`${spec.specId}-pbi-default`);
    }

    // Assert that getPbisForSpec(specId) returns at least the one catch-all PBI created alongside it
    const pbis = getPbisForSpec(spec.specId);
    expect(pbis.length).toBeGreaterThanOrEqual(1);
    expect(pbis[0]?.pbiId).toBe(`${spec.specId}-pbi-default`);
    expect(pbis[0]?.title).toBe('Default PBI');
  });

  it('should persist task status across re-decompositions', async () => {
    const specContent = `# Spec
## Step 1: Task A
Details A
## Step 2: Task B
Details B`;

    const specFile = path.join(mockCwd, 'architecture-spec.md');
    fs.writeFileSync(specFile, specContent, 'utf8');

    // First decomposition
    const res1 = await decomposeSpecIntoTasks('test-spec-tasks-dir');
    expect(res1?.tasks.length).toBe(2);
    expect(res1?.tasks[0]?.status).toBe('pending');

    // Change status of first task to done
    const firstTask = res1!.tasks[0]!;
    saveTask({
      ...firstTask,
      status: 'done',
      updatedAt: Date.now()
    });

    // Run decomposition again
    const res2 = await decomposeSpecIntoTasks('test-spec-tasks-dir');
    expect(res2?.tasks.length).toBe(2);
    expect(res2?.tasks[0]?.status).toBe('done');
    expect(res2?.tasks[1]?.status).toBe('pending');
  });

  it('should persist PBI status across re-decompositions', async () => {
    const specContent = `# Spec
## Step 1: Task A
Details A`;

    const specFile = path.join(mockCwd, 'architecture-spec.md');
    fs.writeFileSync(specFile, specContent, 'utf8');

    // First decomposition
    const res1 = await decomposeSpecIntoTasks('test-spec-tasks-dir');
    expect(res1?.tasks.length).toBe(1);
    
    const pbiId = res1?.tasks[0]?.pbiId;
    expect(pbiId).toBeDefined();
    
    const pbi = getPbi(pbiId!);
    expect(pbi).toBeDefined();
    expect(pbi?.status).toBe('pending');

    // Change status of the catch-all PBI to done
    savePbi({
      ...pbi!,
      status: 'done',
      updatedAt: Date.now()
    });

    // Run decomposition again
    const res2 = await decomposeSpecIntoTasks('test-spec-tasks-dir');
    expect(res2?.tasks.length).toBe(1);

    const pbiUpdated = getPbi(pbiId!);
    expect(pbiUpdated?.status).toBe('done');
  });

  it('should migrate specId and associated tasks/PBIs when the spec file is moved/renamed', async () => {
    const specContent = '# Spec\n## Step 1: Task A\nDetails A';
    const originalDir = 'test-spec-tasks-dir';
    const originalPath = path.join(getWorkspaceRoot(), originalDir, 'architecture-spec.md');
    fs.writeFileSync(originalPath, specContent, 'utf8');

    // Initial decomposition
    const res1 = await decomposeSpecIntoTasks(originalDir);
    expect(res1).not.toBeNull();
    if (!res1) throw new Error('res1 is null');
    const originalSpecId = res1.spec.specId;
    const originalTasks = res1.tasks;
    expect(originalTasks.length).toBe(1);

    // Save one task as done to verify state preservation
    const firstTask = originalTasks[0];
    if (!firstTask) throw new Error('firstTask is undefined');
    saveTask({
      ...firstTask,
      status: 'done',
      updatedAt: Date.now()
    });

    // Clean up original file to simulate moving it
    fs.unlinkSync(originalPath);

    // Write to a new directory. To test migration properly with the tightened heuristic
    // which requires the immediate parent directory to be identical, we simulate moving
    // the parent directory rather than placing it in a differently named directory.
    // The previous test changed the parent dir from test-spec-tasks-dir to moved-spec-tasks-dir
    // which now intentionally breaks migration since parent directories differ.
    // Let's create an outer wrapper and move the directory inside.
    const movedDir = 'outer-folder/test-spec-tasks-dir';
    const movedDirFull = path.join(getWorkspaceRoot(), movedDir);
    if (!fs.existsSync(movedDirFull)) {
      fs.mkdirSync(movedDirFull, { recursive: true });
    }
    const movedPath = path.join(movedDirFull, 'architecture-spec.md');
    fs.writeFileSync(movedPath, specContent, 'utf8');

    // Run decomposition on the new directory
    const res2 = await decomposeSpecIntoTasks(movedDir);
    expect(res2).not.toBeNull();
    if (!res2) throw new Error('res2 is null');
    expect(res2.spec.specId).toBe(originalSpecId);
    expect(res2.tasks.length).toBe(1);
    const movedTask = res2.tasks[0];
    if (!movedTask) throw new Error('movedTask is undefined');
    expect(movedTask.status).toBe('done'); // Verified task state is preserved!

    // Clean up moved files/folders
    if (fs.existsSync(movedPath)) {
      fs.unlinkSync(movedPath);
    }
    if (fs.existsSync(movedDirFull)) {
      fs.rmdirSync(movedDirFull);
    }
  });
});
