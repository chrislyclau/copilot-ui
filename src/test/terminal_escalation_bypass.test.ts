import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import assert from 'node:assert';
import crypto from 'node:crypto';
import { serverHarness } from './harness/ServerHarness';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { getWorkspaceHostLocation } from "../workspace";
import { getTask } from '../db/taskStore';

describe('Terminal Escalation Bypass Test', () => {
  beforeAll(async () => {
    await serverHarness.start();
  });

  afterAll(async () => {
    await serverHarness.stop();
  });

  it('Bypasses terminal halt on failure, blocks task, and resumes with the next pending task', { timeout: 60000 }, async () => {
    console.log('Starting terminal escalation bypass test...');

    const { serverPort, proxy, serverModule } = serverHarness;
    assert.ok(proxy);

    const relativeCwd = 'terminal-bypass-' + Math.random().toString(36).substring(2, 8);
    const tempCwd = path.join(getWorkspaceHostLocation(), relativeCwd);
    fs.mkdirSync(tempCwd, { recursive: true });

    // Setup git structure
    fs.writeFileSync(path.join(tempCwd, '.git'), 'gitdir: /fake/path');

    // Create a modular spec with two steps
    const specContent = `# Spec

## Step 1: Failed Task
This task will fail and trigger terminal escalation.

## Step 2: Next Task
This task is pending and should be picked up after Step 1 gets blocked.
`;
    fs.writeFileSync(path.join(tempCwd, 'architecture-spec.md'), specContent, 'utf8');

    // Write package.json with a failing lint script
    fs.writeFileSync(path.join(tempCwd, 'package.json'), JSON.stringify({
      name: 'mock-terminal-bypass-workspace',
      scripts: {
        lint: 'exit 1',
        test: 'exit 0'
      }
    }, null, 2));

    const snapshotPath = path.resolve(tempCwd, 'bypass_snapshot.yaml');
    fs.writeFileSync(snapshotPath, `conversations:
  - messages:
      - role: assistant
        tool_calls: [{ id: "c1", type: "function", function: { name: "run_terminal_docker", arguments: "{\\"command\\":\\"ls\\"}" } }]
  - messages:
      - role: assistant
        content: "Trying to recover but will fail on final model tier/ceiling retry."
  - messages:
      - role: assistant
        content: "Running the next task now!"
`);

    await proxy.updateConfig({
      filePath: snapshotPath,
      workDir: tempCwd,
    });

    const sessionId = 'bypass-test-session-' + Math.random().toString(36).substring(2, 8);

    const res = await fetch(`http://127.0.0.1:${serverPort}/api/copilot/gate-run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt: 'Start the loop.',
        model: 'gemini-3.1-pro-preview',
        cwd: relativeCwd,
        sessionId,
        gates: ['runLint'],
        maxRetries: 0 // No retries to accelerate terminal escalation path
      })
    });

    const stream = res.body;
    let finalData = '';
    if (stream) {
      for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) {
        finalData += Buffer.from(chunk as ArrayBuffer).toString('utf-8');
      }
    }

    console.log('Stream finished. finalData:\n', finalData);

    // Assert that the escalate_human event was emitted
    assert.ok(finalData.includes('loop.escalate_human'), 'Should have emitted loop.escalate_human event');

    // Assert that the loop continued to run next task and did not halt
    assert.ok(finalData.includes('Running the next task now!'), 'Should have transitioned and run the next task');

    // Verify task state in DB
    if (serverModule) {
      const db = serverModule.db;
      const relativePath = path.join(relativeCwd, 'architecture-spec.md');
      const specId = 'spec-' + crypto.createHash('sha256').update(relativePath).digest('hex').substring(0, 12);
      const failedTaskId = `${specId}-step-1`;
      const nextTaskId = `${specId}-step-2`;

      const failedTask = getTask(failedTaskId);
      const nextTask = getTask(nextTaskId);

      expect(failedTask).toBeDefined();
      expect(failedTask?.status).toBe('blocked');
      expect(failedTask?.blockedReason).toContain('Failed gate');

      expect(nextTask).toBeDefined();
      // Since Step 2 also failed/stopped, or is running/blocked, it should have been processed.
      expect(nextTask?.status).not.toBe('pending');
    }

    // Clean up
    if (fs.existsSync(tempCwd)) {
      fs.rmSync(tempCwd, { recursive: true, force: true });
    }
  });
});
