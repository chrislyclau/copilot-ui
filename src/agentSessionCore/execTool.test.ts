import { describe, it, expect, vi } from 'vitest';
import { createExecTool, createExecToolHandler } from './execTool';

vi.mock('../workspace', () => ({
  getExecCommand: () => async (command: string) => ({
    stdout: `ran: ${command}`,
    stderr: '',
    exitCode: 0,
  }),
}));

describe('createExecTool / createExecToolHandler (SYS-REQ-029b/029d)', () => {
  it('produces a tool definition matching the canonical run_terminal_docker schema', () => {
    const tool = createExecTool();
    expect(tool.name).toBe('run_terminal_docker');
    expect(tool.parameters).toMatchObject({ required: ['command'] });
    expect(typeof tool.handler).toBe('function');
  });

  it('blocks working-directory traversal identically regardless of delivery mode', async () => {
    const unstreamed = createExecToolHandler();
    const delivered: unknown[] = [];
    const streamed = createExecToolHandler({ onDeliver: (e) => { delivered.push(e); } });

    const argsWithTraversal = { command: 'ls', workingDir: '../etc' };
    const resultA = await unstreamed(argsWithTraversal);
    const resultB = await streamed(argsWithTraversal);

    expect(resultA).toEqual(resultB);
    expect(resultA.exitCode).toBe(1);
    expect(resultA.stderr).toMatch(/traversal/i);
    // Traversal is rejected before exec, so nothing should have been delivered.
    expect(delivered).toHaveLength(0);
  });

  it('runs the command and sanitizes/truncates output the same way across delivery modes', async () => {
    const unstreamed = createExecToolHandler();
    const delivered: unknown[] = [];
    const streamed = createExecToolHandler({ onDeliver: (e) => { delivered.push(e); } });

    const args = { command: 'echo hi' };
    const resultA = await unstreamed(args);
    const resultB = await streamed(args);

    expect(resultA).toEqual(resultB);
    expect(resultA.stdout).toBe('ran: echo hi');
    expect(delivered).toEqual([
      { toolName: 'run_terminal_docker', stdout: 'ran: echo hi', stderr: '', exitCode: 0 },
    ]);
  });

  it('never consults orchestration-session state itself (SYS-REQ-029e)', async () => {
    // No orchestrator import anywhere in this module -- executing the
    // handler with no active session context at all must still succeed,
    // proving availability is decided one layer up, not in the handler.
    const handler = createExecToolHandler();
    const result = await handler({ command: 'echo hi' });
    expect(result.exitCode).toBe(0);
  });
});
