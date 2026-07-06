import { describe, it, beforeEach, expect } from 'vitest';
import { db } from '../db/index';
import { saveSpec, getSpec, saveTask, getTask, getTasksForSpec } from '../db/taskStore';
import { decomposeSpecIntoTasks } from '../utils/taskManager';
import * as fs from 'fs';
import * as path from 'path';
import { getWorkspaceRoot } from '../workspace';

describe('Specs and Tasks Database & Decomposition layer', () => {
  const mockCwd = path.join(getWorkspaceRoot(), 'test-spec-tasks-dir');

  beforeEach(() => {
    db.prepare('DELETE FROM sessions').run();
    db.prepare('DELETE FROM tasks').run();
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
      updatedAt: Date.now()
    });

    const task = getTask('task-abc-1');
    expect(task).toBeDefined();
    expect(task?.title).toBe('Setup routing');
    expect(task?.status).toBe('pending');
  });

  it('should decompose a markdown specification into first-class tasks', async () => {
    const specContent = `
# System Spec v1.0

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
Validate standard math rules and error scenarios under Vitest.
`;

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
  });

  it('should persist task status across re-decompositions', async () => {
    const specContent = `
# Spec

## Step 1: Task A
Details A

## Step 2: Task B
Details B
`;
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
});
