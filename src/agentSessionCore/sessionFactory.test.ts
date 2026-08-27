import { describe, it, expect, vi } from 'vitest';
import { createAgentSession } from './sessionFactory';
import { createExecTool } from './execTool';

function fakeTool(name: string) {
  return {
    name,
    description: `fake tool ${name}`,
    parameters: { type: 'object', properties: {} },
    handler: vi.fn(async () => 'ok'),
  };
}

function customToolRequest(toolName: string) {
  return { kind: 'custom-tool', toolName } as never;
}

describe('createAgentSession (SYS-REQ-029c): tool-agnostic factory', () => {
  it('registers the exec tool alongside an arbitrary non-exec tool in the same SessionWrapper', async () => {
    const execTool = createExecTool();
    const other = fakeTool('run_tests');

    const { wrapper } = createAgentSession(undefined, [
      { tool: execTool, lock: { mode: 'unlocked', rationale: 'test: always available' } },
      { tool: other, lock: { mode: 'unlocked', rationale: 'test: always available' } },
    ]);

    const config = wrapper._createConfig();
    expect(config.availableTools).toEqual(expect.arrayContaining(['run_terminal_docker', 'run_tests']));
    await expect(config.onPermissionRequest(customToolRequest('run_terminal_docker'), { sessionId: 's1' }))
      .resolves.toMatchObject({ kind: 'approve-once' });
    await expect(config.onPermissionRequest(customToolRequest('run_tests'), { sessionId: 's1' }))
      .resolves.toMatchObject({ kind: 'approve-once' });
  });
});

describe('createAgentSession: lock policy as enablement, not a parallel gate (SYS-REQ-029e/029f/029g)', () => {
  it('locked + no active orchestration session -> disabled at the permission layer, schema still present', async () => {
    const execTool = createExecTool();
    const { wrapper, applyLockPolicy } = createAgentSession(undefined, [
      { tool: execTool, lock: { mode: 'locked', rationale: 'test: gate on orchestration state', getAutoApproveAll: () => false } },
    ]);

    applyLockPolicy();
    const config = wrapper._createConfig();

    // Schema stays declared (SYS-REQ-028/028d) even though the call will be rejected.
    expect(config.availableTools).toContain('run_terminal_docker');
    await expect(config.onPermissionRequest(customToolRequest('run_terminal_docker'), { sessionId: 's1' }))
      .resolves.toMatchObject({ kind: 'reject' });
  });

  it('locked + active orchestration session (simulated via getAutoApproveAll) -> enabled', async () => {
    const execTool = createExecTool();
    const { wrapper, applyLockPolicy } = createAgentSession(undefined, [
      { tool: execTool, lock: { mode: 'locked', rationale: 'test: gate on orchestration state', getAutoApproveAll: () => true } },
    ]);

    applyLockPolicy();
    const config = wrapper._createConfig();

    await expect(config.onPermissionRequest(customToolRequest('run_terminal_docker'), { sessionId: 's1' }))
      .resolves.toMatchObject({ kind: 'approve-once' });
  });

  it('unlocked tool stays enabled regardless of orchestration state, without applyLockPolicy touching it', async () => {
    const other = fakeTool('run_tests');
    const { wrapper, applyLockPolicy } = createAgentSession(undefined, [
      { tool: other, lock: { mode: 'unlocked', rationale: 'test: no session dependency' } },
    ]);

    applyLockPolicy(); // no locked tools registered -> no-op
    const config = wrapper._createConfig();

    await expect(config.onPermissionRequest(customToolRequest('run_tests'), { sessionId: 's1' }))
      .resolves.toMatchObject({ kind: 'approve-once' });
  });

  it('re-evaluates per call to applyLockPolicy (per-turn), not just once at construction', async () => {
    const execTool = createExecTool();
    let approved = false;
    const { wrapper, applyLockPolicy } = createAgentSession(undefined, [
      { tool: execTool, lock: { mode: 'locked', rationale: 'test: per-turn re-check', getAutoApproveAll: () => approved } },
    ]);

    applyLockPolicy();
    let config = wrapper._createConfig();
    await expect(config.onPermissionRequest(customToolRequest('run_terminal_docker'), { sessionId: 's1' }))
      .resolves.toMatchObject({ kind: 'reject' });

    approved = true;
    applyLockPolicy();
    config = wrapper._createConfig();
    await expect(config.onPermissionRequest(customToolRequest('run_terminal_docker'), { sessionId: 's1' }))
      .resolves.toMatchObject({ kind: 'approve-once' });
  });
});
