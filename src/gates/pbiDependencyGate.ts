import { getPbi, getPbisForSpec, savePbi, PbiRecord } from '../db/pbiStore';
import { appendEscalation, getPendingEscalation } from '../utils/escalationStore';

/**
 * Dependency-blocked PBI escalation (Issue 80 / RM-REQ-060/061/062).
 *
 * Before starting work on a PBI, its `dependsOn` edges must be checked: if
 * any dependency is itself `blocked`, this PBI cannot proceed either. Rather
 * than silently stalling, it is parked (status: 'blocked') and a single
 * async escalation is raised describing the *impact* of the blocking PBI --
 * how many other PBIs (directly and transitively) are stuck behind it -- so
 * humans can prioritize resolving high-impact blockers first.
 */

function synthesizeSessionId(blockedPbiId: string): string {
  // No real agent session exists yet for a PBI that hasn't started -- use a
  // deterministic pseudo-session id scoped to the blocked PBI so
  // getPendingEscalation can dedupe repeated checks into a single entry
  // (RM-REQ-061: "raise a single async escalation").
  return `pbi-dependency-blocked:${blockedPbiId}`;
}

export interface DependentImpact {
  /** PBIs whose dependsOn directly references the blocked PBI. */
  readonly direct: number;
  /** Full dependency-graph walk: all PBIs (direct + indirect) stuck behind the blocked PBI. */
  readonly transitive: number;
}

/**
 * Walks the persisted PBI graph for `specId` (dependsOn edges only ever
 * reference PBIs within the same spec/batch -- see pbiDerivation.ts) and
 * computes how many PBIs are stuck behind `blockedPbiId`, directly and
 * transitively.
 */
export function computeDependentImpact(blockedPbiId: string, specId: string): DependentImpact {
  const allPbis = getPbisForSpec(specId);

  // dependentsOf.get(x) = pbiIds that directly list x in their dependsOn.
  const dependentsOf = new Map<string, string[]>();
  for (const p of allPbis) {
    const deps: string[] = p.dependsOn ? JSON.parse(p.dependsOn) : [];
    for (const depId of deps) {
      if (!dependentsOf.has(depId)) {
        dependentsOf.set(depId, []);
      }
      dependentsOf.get(depId)!.push(p.pbiId);
    }
  }

  const direct = dependentsOf.get(blockedPbiId) ?? [];

  // Full graph walk: BFS outward from the direct dependents, following
  // "who depends on this PBI" edges, to find every PBI stuck behind
  // blockedPbiId (directly or through a chain of dependencies).
  const visited = new Set<string>();
  const queue = [...direct];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (visited.has(current)) {
      continue;
    }
    visited.add(current);
    const next = dependentsOf.get(current) ?? [];
    queue.push(...next);
  }

  return { direct: direct.length, transitive: visited.size };
}

export interface DependencyBlockedEscalationResult {
  readonly raised: boolean;
  readonly impact: DependentImpact;
}

/**
 * Raises a single async human escalation for a blocked PBI, describing its
 * downstream impact (RM-REQ-061/062). No-ops (does not raise) when:
 * - the PBI has no dependents at all (a leaf blocked PBI with nothing
 *   waiting on it -- parking is a valid resting state, not an incident), or
 * - an escalation for this exact blocked PBI is already pending (dedupe --
 *   "a single async escalation", not one per dependency-check).
 */
export function raiseDependencyBlockedEscalation(blockedPbiId: string): DependencyBlockedEscalationResult {
  const blockedPbi = getPbi(blockedPbiId);
  if (!blockedPbi) {
    throw new Error(`No PBI found for pbiId "${blockedPbiId}".`);
  }

  const impact = computeDependentImpact(blockedPbiId, blockedPbi.specId);

  if (impact.direct === 0 && impact.transitive === 0) {
    // Leaf blocked PBI with no dependents -- not an incident.
    return { raised: false, impact };
  }

  const sessionId = synthesizeSessionId(blockedPbiId);
  if (getPendingEscalation(sessionId)) {
    // Already raised and still pending -- keep this a single escalation.
    return { raised: false, impact };
  }

  appendEscalation({
    sessionId,
    summary:
      `pbi/${blockedPbiId} ("${blockedPbi.title}") is blocked and has ${impact.direct} PBI(s) directly ` +
      `depending on it (${impact.transitive} total across the full dependency graph). Resolving this blocker ` +
      `unblocks downstream work -- prioritize accordingly.`,
    failedGate: 'pbi-dependency-blocked',
    failedGateFeedback: JSON.stringify({ blockedPbiId, ...impact }),
    retryHistory: [],
  });

  return { raised: true, impact };
}

export type PbiStartEligibility =
  | { readonly canStart: true }
  | { readonly canStart: false; readonly reason: 'waiting-on-dependency'; readonly dependencyPbiId: string }
  | { readonly canStart: false; readonly reason: 'blocked-by-dependency'; readonly dependencyPbiId: string };

/**
 * PBI-selection logic (RM-REQ-060): checks `dependsOn` status before a PBI
 * may start work.
 *
 * - If every dependency is `done` (or there are none), the PBI may start.
 * - If a dependency exists but simply hasn't finished yet (pending/
 *   in_progress), the PBI must wait -- this is normal scheduling, not an
 *   incident, so no escalation and no status change.
 * - If a dependency is itself `blocked`, this PBI cannot proceed: it is
 *   parked (status set to 'blocked') and a dependency-blocked escalation is
 *   raised for the blocking PBI (RM-REQ-061/062).
 */
export function checkPbiDependencies(pbiId: string): PbiStartEligibility {
  const pbi = getPbi(pbiId);
  if (!pbi) {
    throw new Error(`No PBI found for pbiId "${pbiId}".`);
  }

  const dependsOn: string[] = pbi.dependsOn ? JSON.parse(pbi.dependsOn) : [];

  // Two-pass scan, not a single early-return loop: a `blocked` dependency
  // must take priority over a merely-pending one regardless of array order.
  // (A single-pass loop that returns on the first non-done dependency it
  // sees would miss a blocked dependency listed after a pending one --
  // order-dependent behavior that silently skips parking + escalation.)
  let waitingOnPbiId: string | undefined;

  for (const depId of dependsOn) {
    const dep: PbiRecord | undefined = getPbi(depId);
    if (!dep || dep.status === 'done') {
      continue;
    }

    if (dep.status === 'blocked') {
      if (pbi.status !== 'blocked') {
        savePbi({ ...pbi, status: 'blocked', updatedAt: Date.now() });
      }
      raiseDependencyBlockedEscalation(depId);
      return { canStart: false, reason: 'blocked-by-dependency', dependencyPbiId: depId };
    }

    // pending or in_progress: ordinary "not ready yet" -- keep scanning in
    // case a later dependency is actually blocked, but remember this one in
    // case none are.
    if (!waitingOnPbiId) {
      waitingOnPbiId = depId;
    }
  }

  if (waitingOnPbiId) {
    return { canStart: false, reason: 'waiting-on-dependency', dependencyPbiId: waitingOnPbiId };
  }

  return { canStart: true };
}
