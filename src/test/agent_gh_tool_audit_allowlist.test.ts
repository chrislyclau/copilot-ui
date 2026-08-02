import { describe, it, expect, vi, beforeEach } from 'vitest';

const execFileSyncMock = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', () => ({
  execFileSync: execFileSyncMock,
}));

import { createRunGhCommandTool, isAllowedGhCommand, ALLOWED_GH_COMMANDS } from '../../scripts/tools/agentGhTool';

// scripts/audit-codebase.ts scopes its session to this list only -- kept in
// sync here rather than imported, since importing audit-codebase.ts would
// pull in serverRuntime.ts and friends for what's meant to be a narrow,
// fast-running unit test of the allowlist boundary itself.
const AUDIT_ALLOWED_GH_COMMANDS = ['issue create'] as const;

describe('agentGhTool: configurable allowlist (issue #273 audit script scoping)', () => {
  beforeEach(() => {
    execFileSyncMock.mockReset();
    execFileSyncMock.mockReturnValue('ok');
  });

  it('a tool built with the audit allowlist permits "issue create"', async () => {
    const tool = createRunGhCommandTool(AUDIT_ALLOWED_GH_COMMANDS);
    const result = await (tool.handler as (a: { args: string[] }) => Promise<{ output?: string; error?: string }>)({
      args: ['issue', 'create', '--title', 'Audit findings', '--body', 'findings...'],
    });
    expect(result.error).toBeUndefined();
    expect(execFileSyncMock).toHaveBeenCalled();
  });

  it('a tool built with the audit allowlist rejects commands from the default (run-issue-task) allowlist', async () => {
    const tool = createRunGhCommandTool(AUDIT_ALLOWED_GH_COMMANDS);
    const result = await (tool.handler as (a: { args: string[] }) => Promise<{ output?: string; error?: string }>)({
      args: ['issue', 'comment', '42', '--body', 'hi'],
    });
    expect(result.error).toMatch(/not on the allowlist/);
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });

  it('the default allowlist (run-issue-task.ts) does not include "issue create"', () => {
    expect(ALLOWED_GH_COMMANDS).not.toContain('issue create');
  });

  it('a tool built with the default allowlist rejects "issue create"', async () => {
    const tool = createRunGhCommandTool();
    const result = await (tool.handler as (a: { args: string[] }) => Promise<{ output?: string; error?: string }>)({
      args: ['issue', 'create', '--title', 'x', '--body', 'y'],
    });
    expect(result.error).toMatch(/not on the allowlist/);
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });

  it('normalizes a JSON-encoded string args payload into an array (model formatting flakiness)', async () => {
    const tool = createRunGhCommandTool(AUDIT_ALLOWED_GH_COMMANDS);
    const result = await (tool.handler as unknown as (a: { args: unknown }) => Promise<{ output?: string; error?: string }>)({
      args: JSON.stringify(['issue', 'create', '--title', 'x', '--body', 'y']),
    });
    expect(result.error).toBeUndefined();
    expect(execFileSyncMock).toHaveBeenCalledWith(
      'gh',
      ['issue', 'create', '--title', 'x', '--body', 'y'],
      expect.anything(),
    );
  });

  it('isAllowedGhCommand respects the passed-in allowlist', () => {
    expect(isAllowedGhCommand(['issue', 'create'], AUDIT_ALLOWED_GH_COMMANDS)).toBe(true);
    expect(isAllowedGhCommand(['issue', 'create'])).toBe(false);
    expect(isAllowedGhCommand(['issue', 'view'])).toBe(true);
  });
});
