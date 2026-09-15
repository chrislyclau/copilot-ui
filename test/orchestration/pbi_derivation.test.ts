import { describe, it, beforeEach, expect, vi } from 'vitest';
import * as path from 'path';
import * as fs from 'fs';
import { db } from '../../src/orchestration/db';
import { saveSpec } from '../../src/orchestration/db/taskStore';
import { getWorkspaceRoot } from '../../src/agentCore/workspace';

vi.mock('../../src/agentCore/auditorHelper', async () => {
  const actual = await vi.importActual<typeof import('../../src/agentCore/auditorHelper')>('../../src/agentCore/auditorHelper');
  return {
    ...actual,
    getAuditorExecutionConfig: () => ({ model: 'mock-model', provider: undefined }),
    executeAuditSession: vi.fn(),
  };
});

import { executeAuditSession } from '../../src/agentCore/auditorHelper';
import { runPbiDerivation } from '../../src/orchestration/gates/pbiDerivation';

const mockedExecuteAuditSession = executeAuditSession as unknown as ReturnType<typeof vi.fn>;

describe('PBI derivation operation', () => {
  const mockCwd = path.join(getWorkspaceRoot(), 'test-pbi-derivation-dir');

  beforeEach(() => {
    // sessions rows (e.g. left by server-harness suites sharing /tmp/app-test.db)
    // reference tasks, so they must go first or this FK fails on file ordering.
    db.prepare('DELETE FROM sessions').run();
    db.prepare('DELETE FROM tasks').run();
    db.prepare('DELETE FROM pbis').run();
    db.prepare('DELETE FROM specs').run();
    mockedExecuteAuditSession.mockReset();
    if (!fs.existsSync(mockCwd)) {
      fs.mkdirSync(mockCwd, { recursive: true });
    }
    fs.writeFileSync(path.join(mockCwd, 'architecture-spec.md'), 'Spec: build a widget.');
  });

  it('throws when the specId does not exist', async () => {
    await expect(runPbiDerivation(mockCwd, 'spec-does-not-exist')).rejects.toThrow(/No spec found/);
    expect(mockedExecuteAuditSession).not.toHaveBeenCalled();
  });

  it('returns the proposed PBI batch (not persisted) on a successful tool call', async () => {
    const relativePath = path.relative(getWorkspaceRoot(), path.join(mockCwd, 'architecture-spec.md'));
    saveSpec({ specId: 'spec-widget-1', filePath: relativePath, version: 'v1', createdAt: Date.now() });

    mockedExecuteAuditSession.mockResolvedValue({
      pbis: [
        { batchId: 'pbi-1', title: 'Scaffolding', description: 'Set up the widget module.', status: 'pending', dependsOn: [] },
        { batchId: 'pbi-2', title: 'Wire it up', description: 'Connect the widget to the app.', status: 'pending', dependsOn: ['pbi-1'] },
      ],
    });

    const result = await runPbiDerivation(mockCwd, 'spec-widget-1');

    expect(result.specId).toBe('spec-widget-1');
    expect(result.pbis).toHaveLength(2);
    expect(result.pbis[1]?.dependsOn).toEqual(['pbi-1']);

    // Not persisted -- this is a proposal only (Issue 4 handles persistence).
    const persisted = db.prepare('SELECT * FROM pbis WHERE specId = ?').all('spec-widget-1');
    expect(persisted).toHaveLength(0);

    // Confirms the forced-tool-call discipline: submit_pbi_derivation is the
    // only tool passed through to the session (mirrors the Auditor/Reviewer pattern).
    const [, , , tool] = mockedExecuteAuditSession.mock.calls[0] as unknown[];
    expect((tool as { function: { name: string } }).function.name).toBe('submit_pbi_derivation');
  });

  it('throws when the model never returns a valid tool call', async () => {
    const relativePath = path.relative(getWorkspaceRoot(), path.join(mockCwd, 'architecture-spec.md'));
    saveSpec({ specId: 'spec-widget-2', filePath: relativePath, version: 'v1', createdAt: Date.now() });
    mockedExecuteAuditSession.mockResolvedValue(null);

    await expect(runPbiDerivation(mockCwd, 'spec-widget-2')).rejects.toThrow(/did not return a proper submit_pbi_derivation/);
  });
});
