import { PbiRecord } from '../db/pbiStore';
import { DerivedPbi } from '../gates/pbiDerivation';

/**
 * Statuses under which removing a persisted PBI is considered safe: no work
 * has started, or the PBI was already known to be blocked. Anything further
 * along ('in_progress' | 'done') represents real completed/ongoing work, so
 * a re-derivation that no longer contains that PBI cannot silently drop it
 * (RM-REQ-072).
 */
const REMOVAL_SAFE_STATUSES: ReadonlySet<PbiRecord['status']> = new Set(['pending', 'blocked']);

/**
 * Normalizes a title for identity matching between an existing persisted PBI
 * and a freshly derived one. Derivation has no notion of persisted pbiIds
 * (it only knows batch-local batchIds), so title is the only stable-ish
 * signal available for matching without a dedicated matching model pass
 * (flagged as an open/unsolved Groomer-role problem in the roadmap spec --
 * this is intentionally a simple heuristic, not a claim of semantic matching).
 */
function normalizeTitle(title: string): string {
  return title.trim().toLowerCase().replace(/\s+/g, ' ');
}

export interface PbiAddition {
  readonly batchId: string;
  readonly title: string;
  readonly description: string;
  readonly status: DerivedPbi['status'];
  /** dependsOn expressed as batchIds, resolved to pbiIds/batchIds at accept time. */
  readonly dependsOn: readonly string[];
}

export interface PbiEdgeChange {
  readonly pbiId: string;
  readonly title: string;
  readonly oldDependsOn: readonly string[];
  readonly newDependsOn: readonly string[];
}

export interface PbiRemoval {
  readonly pbiId: string;
  readonly title: string;
  readonly status: PbiRecord['status'];
  /** True if this PBI has status 'in_progress' or 'done' -- removal is blocked until manually resolved. */
  readonly statusIncompatible: boolean;
}

export interface PbiUnchanged {
  readonly pbiId: string;
  readonly title: string;
}

export interface PbiDiff {
  readonly specId: string;
  readonly additions: readonly PbiAddition[];
  readonly edgeChanges: readonly PbiEdgeChange[];
  readonly removals: readonly PbiRemoval[];
  readonly unchanged: readonly PbiUnchanged[];
  /** True if any removal is status-incompatible; acceptance of this diff as-is is blocked until resolved. */
  readonly hasBlockingRemovals: boolean;
}

/**
 * Computes a proposed diff between the PBIs currently persisted for a spec
 * and a freshly derived batch, per RM-REQ-072. Matching between the two sets
 * is by normalized title (see normalizeTitle) since derivation output has no
 * persisted pbiId to key off of.
 *
 * This is pure and read-only -- it does not touch the database.
 */
export function computePbiDiff(specId: string, existing: readonly PbiRecord[], derived: readonly DerivedPbi[]): PbiDiff {
  const existingByTitle = new Map<string, PbiRecord>();
  for (const pbi of existing) {
    existingByTitle.set(normalizeTitle(pbi.title), pbi);
  }

  const derivedByBatchId = new Map<string, DerivedPbi>();
  for (const d of derived) {
    derivedByBatchId.set(d.batchId, d);
  }

  // Resolve a derived PBI's dependsOn (batchIds) into pbiIds where the
  // target batchId matches an existing persisted PBI by title, else leave
  // as the batchId itself (resolved to a real pbiId only once that addition
  // is persisted, at accept time).
  function resolveDependsOn(dependsOn: readonly string[]): string[] {
    return dependsOn.map((batchId) => {
      const target = derivedByBatchId.get(batchId);
      if (!target) return batchId; // dangling reference; passed through as-is
      const matched = existingByTitle.get(normalizeTitle(target.title));
      return matched ? matched.pbiId : batchId;
    });
  }

  const additions: PbiAddition[] = [];
  const edgeChanges: PbiEdgeChange[] = [];
  const unchanged: PbiUnchanged[] = [];
  const matchedExistingTitles = new Set<string>();

  for (const d of derived) {
    const normalized = normalizeTitle(d.title);
    const existingMatch = existingByTitle.get(normalized);

    if (!existingMatch) {
      additions.push({
        batchId: d.batchId,
        title: d.title,
        description: d.description,
        status: d.status,
        dependsOn: resolveDependsOn(d.dependsOn),
      });
      continue;
    }

    matchedExistingTitles.add(normalized);
    const oldDependsOn: string[] = existingMatch.dependsOn ? JSON.parse(existingMatch.dependsOn) : [];
    const newDependsOn = resolveDependsOn(d.dependsOn);

    const oldSet = new Set(oldDependsOn);
    const newSet = new Set(newDependsOn);
    const edgesEqual = oldSet.size === newSet.size && [...oldSet].every((id) => newSet.has(id));

    if (edgesEqual) {
      unchanged.push({ pbiId: existingMatch.pbiId, title: existingMatch.title });
    } else {
      edgeChanges.push({
        pbiId: existingMatch.pbiId,
        title: existingMatch.title,
        oldDependsOn,
        newDependsOn,
      });
    }
  }

  const removals: PbiRemoval[] = [];
  for (const pbi of existing) {
    if (matchedExistingTitles.has(normalizeTitle(pbi.title))) continue;
    removals.push({
      pbiId: pbi.pbiId,
      title: pbi.title,
      status: pbi.status,
      statusIncompatible: !REMOVAL_SAFE_STATUSES.has(pbi.status),
    });
  }

  return {
    specId,
    additions,
    edgeChanges,
    removals,
    unchanged,
    hasBlockingRemovals: removals.some((r) => r.statusIncompatible),
  };
}
