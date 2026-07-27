import { describe, it, expect, vi, beforeEach } from 'vitest';

const execFileSyncMock = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', () => ({
  execFileSync: execFileSyncMock,
}));

import { createRunGhCommandTool } from '../../scripts/tools/agentGhTool';

describe('agentGhTool: --repo/-R cross-repo detector', () => {
  beforeEach(() => {
    execFileSyncMock.mockReset();
    execFileSyncMock.mockReturnValue('ok');
  });

  const handler = async (args: string[]) => {
    const tool = createRunGhCommandTool();
    return (tool.handler as (a: { args: string[] }) => Promise<{ output?: string; error?: string }>)({
      args,
    });
  };

  it('does not false-positive on a comment body that looks like a flag', async () => {
    const result = await handler(['issue', 'comment', '42', '--body', '-Ready: looks good']);
    expect(result.error).toBeUndefined();
    expect(execFileSyncMock).toHaveBeenCalled();
  });

  it('does not false-positive on a comment body starting with --repo', async () => {
    const result = await handler(['issue', 'comment', '42', '--body', '--reporting done']);
    expect(result.error).toBeUndefined();
    expect(execFileSyncMock).toHaveBeenCalled();
  });

  it('still rejects an actual --repo flag', async () => {
    const result = await handler(['issue', 'view', '42', '--repo', 'other/repo']);
    expect(result.error).toMatch(/cross-repo access is forbidden/);
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });

  it('still rejects an actual -R flag', async () => {
    const result = await handler(['issue', 'view', '42', '-R', 'other/repo']);
    expect(result.error).toMatch(/cross-repo access is forbidden/);
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });

  it('still rejects --repo= form', async () => {
    const result = await handler(['issue', 'view', '42', '--repo=other/repo']);
    expect(result.error).toMatch(/cross-repo access is forbidden/);
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });

  it('still rejects the attached short-flag form -R=owner/repo', async () => {
    const result = await handler(['issue', 'view', '42', '-R=other/repo']);
    expect(result.error).toMatch(/cross-repo access is forbidden/);
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });

  it('still rejects the attached short-flag form -Rowner/repo', async () => {
    const result = await handler(['issue', 'view', '42', '-Rother/repo']);
    expect(result.error).toMatch(/cross-repo access is forbidden/);
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });
});
