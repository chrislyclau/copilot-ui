import { describe, it, expect, vi, beforeEach } from 'vitest';

// Issue #299: session builders like buildAuditorSessionSettings only
// assembled a task-specific submission tool, so any session built from it
// fell back to the copilot SDK's own default bash/view/edit tools acting
// directly on CopilotClient.workingDirectory -- entirely bypassing the
// app's centralized workspace abstraction (GitSandbox locking,
// GIT_TIMEOUT_MS/EXEC_TIMEOUT_MS enforcement, Docker-vs-native routing).
//
// This guards the fix structurally: every session assembled by the shared
// builder must include `run_terminal_docker`, and that tool's handler must
// actually route through the centralized `getExecCommand()` -- not just be
// present by name with a dead handler.

const mockExecCommand = vi.fn(async () => ({ stdout: 'ok', stderr: '', exitCode: 0 }));

const MOCK_WORKSPACE_ROOT = '/mock-workspace-root';

vi.mock('../../src/agentCore/workspace', async () => {
  // Keep the real module (getWorkspaceRoot/resolveWorkDir semantics) and
  // stub only the exec boundary the handler routes through.
  const actual = await vi.importActual<typeof import('../../src/agentCore/workspace')>(
    '../../src/agentCore/workspace',
  );
  return {
    ...actual,
    getExecCommand: () => mockExecCommand,
    getWorkspaceRoot: () => MOCK_WORKSPACE_ROOT,
  };
});

import { buildAuditorSessionSettings } from '../../src/agentCore/auditorHelper';
import { RUN_TERMINAL_DOCKER_TOOL } from '../../src/config/tools';

describe('buildAuditorSessionSettings default toolset (issue #299)', () => {
  beforeEach(() => {
    mockExecCommand.mockClear();
  });

  it('includes run_terminal_docker alongside the task-specific tool by default', () => {
    const settings = buildAuditorSessionSettings(
      { model: 'mock-model', provider: undefined } as never,
      'system prompt',
      {
        function: {
          name: 'submit_task_result',
          description: 'Submit result',
          parameters: { type: 'object', properties: {} },
        },
      },
      () => {},
    );

    const toolNames = settings.tools.map((t) => t.name);
    expect(toolNames).toContain('submit_task_result');
    expect(toolNames).toContain(RUN_TERMINAL_DOCKER_TOOL.function.name);
  });

  it("run_terminal_docker's handler routes through the centralized getExecCommand(), not a stub", async () => {
    const settings = buildAuditorSessionSettings(
      { model: 'mock-model', provider: undefined } as never,
      'system prompt',
      {
        function: {
          name: 'submit_task_result',
          description: 'Submit result',
          parameters: { type: 'object', properties: {} },
        },
      },
      () => {},
    );

    const execTool = settings.tools.find((t) => t.name === RUN_TERMINAL_DOCKER_TOOL.function.name);
    expect(execTool).toBeDefined();

    const result = await execTool!.handler({ command: 'echo hi' });
    // timeoutMs is always populated now (the clamped model-supplied value,
    // or DEFAULT_TIMEOUT_SECONDS * 1000 when timeoutSeconds is omitted) so
    // the tool boundary's deadline composes with whatever signal the
    // handler passes, instead of being silently dropped. See PR #465
    // review + AGENTS.md's "run_terminal_docker" section.
    expect(mockExecCommand).toHaveBeenCalledWith('echo hi', undefined, {
      workDir: MOCK_WORKSPACE_ROOT,
      timeoutMs: 60_000,
    });
    expect(result).toMatchObject({ stdout: 'ok', stderr: '', exitCode: 0 });
  });

  it('blocks workingDir path traversal without ever calling getExecCommand()', async () => {
    const settings = buildAuditorSessionSettings(
      { model: 'mock-model', provider: undefined } as never,
      'system prompt',
      {
        function: {
          name: 'submit_task_result',
          description: 'Submit result',
          parameters: { type: 'object', properties: {} },
        },
      },
      () => {},
    );

    const execTool = settings.tools.find((t) => t.name === RUN_TERMINAL_DOCKER_TOOL.function.name);
    const result = await execTool!.handler({ command: 'ls', workingDir: '../../etc' });
    expect(mockExecCommand).not.toHaveBeenCalled();
    expect(result).toMatchObject({ exitCode: 1 });
  });
});
