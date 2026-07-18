import { describe, it, beforeEach, expect } from 'vitest';
import { db } from '../db/index';
import { saveSpec } from '../db/taskStore';
import { savePbi, getPbisForSpec, PbiRecord } from '../db/pbiStore';
import { computePbiDiff } from '../utils/pbiDiff';
import { acceptPbiDiff, BlockingRemovalError } from '../gates/pbiAcceptance';
import { DerivedPbi } from '../gates/pbiDerivation';

function pbi(overrides: Partial<PbiRecord> & { pbiId: string; title: string }): PbiRecord {
  return {
    specId: 'spec-1',
    description: null,
    status: 'pending',
    dependsOn: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

function derived(overrides: Partial<DerivedPbi> & { batchId: string; title: string }): DerivedPbi {
  return {
    description: 'desc',
    status: 'pending',
    dependsOn: [],
    ...overrides,
  };
}

describe('computePbiDiff', () => {
  it('treats everything as an addition when nothing is persisted yet', () => {
    const diff = computePbiDiff('spec-1', [], [
      derived({ batchId: 'pbi-1', title: 'Scaffolding' }),
      derived({ batchId: 'pbi-2', title: 'Wire it up', dependsOn: ['pbi-1'] }),
    ]);

    expect(diff.additions).toHaveLength(2);
    expect(diff.removals).toHaveLength(0);
    expect(diff.edgeChanges).toHaveLength(0);
    expect(diff.unchanged).toHaveLength(0);
    const wireUp = diff.additions.find((a) => a.title === 'Wire it up')!;
    expect(wireUp.dependsOn).toEqual(['pbi-1']); // dangling batchId ref, resolved at accept time
  });

  it('matches existing PBIs by normalized title and reports unchanged when edges match', () => {
    const existing = [pbi({ pbiId: 'pbi-a', title: '  Scaffolding  ', dependsOn: JSON.stringify([]) })];
    const diff = computePbiDiff('spec-1', existing, [derived({ batchId: 'pbi-1', title: 'scaffolding' })]);

    expect(diff.unchanged).toEqual([{ pbiId: 'pbi-a', title: '  Scaffolding  ' }]);
    expect(diff.additions).toHaveLength(0);
    expect(diff.edgeChanges).toHaveLength(0);
  });

  it('reports an edge change when dependsOn differs for a matched PBI', () => {
    const existing = [
      pbi({ pbiId: 'pbi-a', title: 'Scaffolding' }),
      pbi({ pbiId: 'pbi-b', title: 'Wire it up', dependsOn: JSON.stringify([]) }),
    ];
    const diff = computePbiDiff('spec-1', existing, [
      derived({ batchId: 'd1', title: 'Scaffolding' }),
      derived({ batchId: 'd2', title: 'Wire it up', dependsOn: ['d1'] }),
    ]);

    expect(diff.edgeChanges).toEqual([
      { pbiId: 'pbi-b', title: 'Wire it up', oldDependsOn: [], newDependsOn: ['pbi-a'] },
    ]);
  });

  it('flags a safe removal (pending) as non-blocking and an in-progress removal as status-incompatible', () => {
    const existing = [
      pbi({ pbiId: 'pbi-safe', title: 'Stale idea', status: 'pending' }),
      pbi({ pbiId: 'pbi-unsafe', title: 'Real work', status: 'in_progress' }),
    ];
    const diff = computePbiDiff('spec-1', existing, []);

    expect(diff.removals).toHaveLength(2);
    const safe = diff.removals.find((r) => r.pbiId === 'pbi-safe')!;
    const unsafe = diff.removals.find((r) => r.pbiId === 'pbi-unsafe')!;
    expect(safe.statusIncompatible).toBe(false);
    expect(unsafe.statusIncompatible).toBe(true);
    expect(diff.hasBlockingRemovals).toBe(true);
  });
});

describe('acceptPbiDiff (persistence)', () => {
  beforeEach(() => {
    db.prepare('DELETE FROM tasks').run();
    db.prepare('DELETE FROM pbis').run();
    db.prepare('DELETE FROM specs').run();
    saveSpec({ specId: 'spec-accept-1', filePath: 'spec.md', version: 'v1', createdAt: Date.now() });
  });

  it('persists additions and resolves intra-batch dependsOn to real pbiIds', () => {
    const result = acceptPbiDiff('spec-accept-1', [], [
      derived({ batchId: 'pbi-1', title: 'Scaffolding' }),
      derived({ batchId: 'pbi-2', title: 'Wire it up', dependsOn: ['pbi-1'] }),
    ]);

    expect(result.created).toHaveLength(2);
    const persisted = getPbisForSpec('spec-accept-1');
    expect(persisted).toHaveLength(2);

    const wireUp = persisted.find((p) => p.title === 'Wire it up')!;
    const scaffolding = persisted.find((p) => p.title === 'Scaffolding')!;
    expect(JSON.parse(wireUp.dependsOn!)).toEqual([scaffolding.pbiId]);
    expect(scaffolding.pbiId).not.toBe('pbi-1'); // batchId is not the persisted id
  });

  it('is idempotent on immediate re-derivation with no changes (nothing created/updated/removed)', () => {
    acceptPbiDiff('spec-accept-1', [], [derived({ batchId: 'pbi-1', title: 'Scaffolding' })]);
    const existing = getPbisForSpec('spec-accept-1');

    const result = acceptPbiDiff('spec-accept-1', existing, [derived({ batchId: 'd1', title: 'Scaffolding' })]);

    expect(result.created).toHaveLength(0);
    expect(result.updated).toHaveLength(0);
    expect(result.removed).toHaveLength(0);
    expect(getPbisForSpec('spec-accept-1')).toHaveLength(1);
  });

  it('rejects (does not persist) a diff with a status-incompatible removal unless explicitly overridden', () => {
    savePbi(pbi({ pbiId: 'pbi-inprog', specId: 'spec-accept-1', title: 'Real work', status: 'in_progress' }));

    expect(() => acceptPbiDiff('spec-accept-1', getPbisForSpec('spec-accept-1'), [])).toThrow(BlockingRemovalError);
    expect(getPbisForSpec('spec-accept-1')).toHaveLength(1); // untouched

    const result = acceptPbiDiff('spec-accept-1', getPbisForSpec('spec-accept-1'), [], {
      allowStatusIncompatibleRemovals: true,
    });
    expect(result.removed).toEqual(['pbi-inprog']);
    expect(getPbisForSpec('spec-accept-1')).toHaveLength(0);
  });

  it('removes safe (pending/blocked) PBIs without requiring an override', () => {
    savePbi(pbi({ pbiId: 'pbi-stale', specId: 'spec-accept-1', title: 'Stale idea', status: 'pending' }));

    const result = acceptPbiDiff('spec-accept-1', getPbisForSpec('spec-accept-1'), []);
    expect(result.removed).toEqual(['pbi-stale']);
    expect(getPbisForSpec('spec-accept-1')).toHaveLength(0);
  });
});
