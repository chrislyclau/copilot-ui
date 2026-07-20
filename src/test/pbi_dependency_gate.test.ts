import { describe, it, beforeEach, expect } from 'vitest';
import { db } from '../db/index';
import { saveSpec } from '../db/taskStore';
import { savePbi, getPbi, PbiRecord } from '../db/pbiStore';
import { getEscalations } from '../utils/escalationStore';
import {
  checkPbiDependencies,
  computeDependentImpact,
  raiseDependencyBlockedEscalation,
} from '../gates/pbiDependencyGate';

describe('Dependency-blocked PBI escalation (Issue 80 / RM-REQ-060/061/062)', () => {
  const specId = 'spec-dep-gate-test';

  beforeEach(() => {
    db.prepare('DELETE FROM sessions').run();
    db.prepare('DELETE FROM tasks').run();
    db.prepare('DELETE FROM pbis').run();
    db.prepare('DELETE FROM specs').run();
    db.prepare('DELETE FROM escalations').run();
    saveSpec({ specId, filePath: 'architecture-spec.md', version: 'v1', createdAt: Date.now() });
  });

  function makePbi(pbiId: string, status: PbiRecord['status'], dependsOn: string[] | null): PbiRecord {
    return {
      pbiId,
      specId,
      title: `Title for ${pbiId}`,
      description: null,
      status,
      dependsOn: dependsOn ? JSON.stringify(dependsOn) : null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
  }

  describe('checkPbiDependencies (RM-REQ-060)', () => {
    it('throws when the pbiId does not exist', () => {
      expect(() => checkPbiDependencies('pbi-does-not-exist')).toThrow(/No PBI found/);
    });

    it('allows starting when there are no dependencies', () => {
      savePbi(makePbi('pbi-a', 'pending', null));
      expect(checkPbiDependencies('pbi-a')).toEqual({ canStart: true });
    });

    it('allows starting when all dependencies are done', () => {
      savePbi(makePbi('pbi-a', 'done', null));
      savePbi(makePbi('pbi-b', 'pending', ['pbi-a']));
      expect(checkPbiDependencies('pbi-b')).toEqual({ canStart: true });
    });

    it('waits (no escalation, no status change) when a dependency is merely pending/in_progress', () => {
      savePbi(makePbi('pbi-a', 'in_progress', null));
      savePbi(makePbi('pbi-b', 'pending', ['pbi-a']));

      const result = checkPbiDependencies('pbi-b');

      expect(result).toEqual({ canStart: false, reason: 'waiting-on-dependency', dependencyPbiId: 'pbi-a' });
      expect(getPbi('pbi-b')?.status).toBe('pending'); // not parked
      expect(getEscalations()).toHaveLength(0);
    });

    it('parks the PBI and raises escalation when a dependency is blocked', () => {
      savePbi(makePbi('pbi-a', 'blocked', null));
      savePbi(makePbi('pbi-b', 'pending', ['pbi-a']));

      const result = checkPbiDependencies('pbi-b');

      expect(result).toEqual({ canStart: false, reason: 'blocked-by-dependency', dependencyPbiId: 'pbi-a' });
      expect(getPbi('pbi-b')?.status).toBe('blocked');

      const escalations = getEscalations();
      expect(escalations).toHaveLength(1);
      expect(escalations[0]?.failedGate).toBe('pbi-dependency-blocked');
      expect(escalations[0]?.summary).toContain('pbi-a');
    });

    it('does not re-park an already-blocked PBI, but still checks escalation dedupe', () => {
      savePbi(makePbi('pbi-a', 'blocked', null));
      savePbi(makePbi('pbi-b', 'blocked', ['pbi-a']));

      checkPbiDependencies('pbi-b');
      checkPbiDependencies('pbi-b');

      // Still just one pending escalation despite two checks (RM-REQ-061: "a single async escalation").
      expect(getEscalations()).toHaveLength(1);
    });

    it('detects a blocked dependency even when it is listed after a merely-pending one (regression)', () => {
      // Order-dependent bug regression: a single-pass loop that returns on
      // the FIRST non-done dependency would stop at pbi-pending and never
      // reach pbi-blocked-dep, silently skipping the park + escalation.
      savePbi(makePbi('pbi-pending', 'in_progress', null));
      savePbi(makePbi('pbi-blocked-dep', 'blocked', null));
      savePbi(makePbi('pbi-c', 'pending', ['pbi-pending', 'pbi-blocked-dep']));

      const result = checkPbiDependencies('pbi-c');

      expect(result).toEqual({
        canStart: false,
        reason: 'blocked-by-dependency',
        dependencyPbiId: 'pbi-blocked-dep',
      });
      expect(getPbi('pbi-c')?.status).toBe('blocked');

      const escalations = getEscalations();
      expect(escalations).toHaveLength(1);
      expect(escalations[0]?.summary).toContain('pbi-blocked-dep');
    });
  });

  describe('computeDependentImpact (full dependency-graph walk)', () => {
    it('returns zero for a leaf PBI with no dependents', () => {
      savePbi(makePbi('pbi-leaf', 'blocked', null));
      expect(computeDependentImpact('pbi-leaf', specId)).toEqual({ direct: 0, transitive: 0 });
    });

    it('counts only direct dependents when there is no deeper chain', () => {
      savePbi(makePbi('pbi-a', 'blocked', null));
      savePbi(makePbi('pbi-b', 'pending', ['pbi-a']));
      savePbi(makePbi('pbi-c', 'pending', ['pbi-a']));
      expect(computeDependentImpact('pbi-a', specId)).toEqual({ direct: 2, transitive: 2 });
    });

    it('walks the full transitive chain (direct dependents plus their dependents)', () => {
      // a <- b <- c <- d  (b, c, d all depend transitively on a)
      savePbi(makePbi('pbi-a', 'blocked', null));
      savePbi(makePbi('pbi-b', 'pending', ['pbi-a']));
      savePbi(makePbi('pbi-c', 'pending', ['pbi-b']));
      savePbi(makePbi('pbi-d', 'pending', ['pbi-c']));
      expect(computeDependentImpact('pbi-a', specId)).toEqual({ direct: 1, transitive: 3 });
    });

    it('deduplicates diamond-shaped dependency graphs', () => {
      //   a <- b <- d
      //   a <- c <- d
      savePbi(makePbi('pbi-a', 'blocked', null));
      savePbi(makePbi('pbi-b', 'pending', ['pbi-a']));
      savePbi(makePbi('pbi-c', 'pending', ['pbi-a']));
      savePbi(makePbi('pbi-d', 'pending', ['pbi-b', 'pbi-c']));
      expect(computeDependentImpact('pbi-a', specId)).toEqual({ direct: 2, transitive: 3 });
    });
  });

  describe('raiseDependencyBlockedEscalation (RM-REQ-061/062)', () => {
    it('throws when the pbiId does not exist', () => {
      expect(() => raiseDependencyBlockedEscalation('pbi-does-not-exist')).toThrow(/No PBI found/);
    });

    it('does not raise an escalation for a leaf blocked PBI with no dependents', () => {
      savePbi(makePbi('pbi-leaf', 'blocked', null));

      const result = raiseDependencyBlockedEscalation('pbi-leaf');

      expect(result.raised).toBe(false);
      expect(result.impact).toEqual({ direct: 0, transitive: 0 });
      expect(getEscalations()).toHaveLength(0);
    });

    it('raises a single escalation including direct and transitive impact metrics', () => {
      savePbi(makePbi('pbi-a', 'blocked', null));
      savePbi(makePbi('pbi-b', 'pending', ['pbi-a']));
      savePbi(makePbi('pbi-c', 'pending', ['pbi-b']));

      const result = raiseDependencyBlockedEscalation('pbi-a');

      expect(result.raised).toBe(true);
      expect(result.impact).toEqual({ direct: 1, transitive: 2 });

      const escalations = getEscalations();
      expect(escalations).toHaveLength(1);
      const feedback = JSON.parse(escalations[0]!.failedGateFeedback!);
      expect(feedback).toEqual({ blockedPbiId: 'pbi-a', direct: 1, transitive: 2 });
    });

    it('does not raise a second escalation while one is already pending for the same blocked PBI', () => {
      savePbi(makePbi('pbi-a', 'blocked', null));
      savePbi(makePbi('pbi-b', 'pending', ['pbi-a']));

      const first = raiseDependencyBlockedEscalation('pbi-a');
      const second = raiseDependencyBlockedEscalation('pbi-a');

      expect(first.raised).toBe(true);
      expect(second.raised).toBe(false);
      expect(getEscalations()).toHaveLength(1);
    });
  });
});
