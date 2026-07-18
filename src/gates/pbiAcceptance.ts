import crypto from 'crypto';
import { PbiRecord, savePbi, deletePbi } from '../db/pbiStore';
import { DerivedPbi } from './pbiDerivation';
import { computePbiDiff, PbiDiff } from '../utils/pbiDiff';

export interface AcceptPbiDiffResult {
  readonly diff: PbiDiff;
  readonly created: readonly PbiRecord[];
  readonly updated: readonly PbiRecord[];
  readonly removed: readonly PbiRecord['pbiId'][];
  readonly skippedRemovals: readonly PbiDiff['removals'][number][];
}

export class BlockingRemovalError extends Error {
  constructor(public readonly diff: PbiDiff) {
    super(
      `Cannot accept this derivation: ${diff.removals.filter((r) => r.statusIncompatible).length} PBI(s) with in-progress/done work would be removed. Resolve these manually (e.g. re-derive with adjusted spec, or explicitly override) before accepting.`
    );
    this.name = 'BlockingRemovalError';
  }
}

/**
 * Persists an accepted PBI-derivation (or re-derivation diff) for a spec,
 * per RM-REQ-073. PBIs are not ephemeral / recomputed-on-read: this is the
 * only path by which a derivation's output is written to the database, and
 * it only runs once a human has reviewed and accepted the proposed diff
 * (computed via computePbiDiff / the /api/copilot/pbi-diff endpoint).
 *
 * By default, a diff containing a status-incompatible removal (an existing
 * 'in_progress' or 'done' PBI that the new derivation no longer contains)
 * is rejected outright (RM-REQ-072) -- pass `allowStatusIncompatibleRemovals:
 * true` to explicitly override and remove them anyway.
 */
export function acceptPbiDiff(
  specId: string,
  existing: readonly PbiRecord[],
  derived: readonly DerivedPbi[],
  options: { allowStatusIncompatibleRemovals?: boolean } = {}
): AcceptPbiDiffResult {
  const diff = computePbiDiff(specId, existing, derived);

  if (diff.hasBlockingRemovals && !options.allowStatusIncompatibleRemovals) {
    throw new BlockingRemovalError(diff);
  }

  const now = Date.now();

  // Resolve batchId -> pbiId for newly-created additions before persisting,
  // so that dependsOn edges between two additions in the same batch resolve
  // to real pbiIds rather than batch-local placeholders.
  const batchIdToNewPbiId = new Map<string, string>();
  for (const addition of diff.additions) {
    batchIdToNewPbiId.set(addition.batchId, `${specId}-pbi-${crypto.randomUUID()}`);
  }

  function resolveFinal(id: string): string {
    return batchIdToNewPbiId.get(id) ?? id;
  }

  const created: PbiRecord[] = [];
  for (const addition of diff.additions) {
    const record: PbiRecord = {
      pbiId: batchIdToNewPbiId.get(addition.batchId)!,
      specId,
      title: addition.title,
      description: addition.description,
      status: addition.status,
      dependsOn: JSON.stringify(addition.dependsOn.map(resolveFinal)),
      createdAt: now,
      updatedAt: now,
    };
    savePbi(record);
    created.push(record);
  }

  const existingById = new Map(existing.map((p) => [p.pbiId, p]));
  const updated: PbiRecord[] = [];
  for (const change of diff.edgeChanges) {
    const prior = existingById.get(change.pbiId);
    if (!prior) continue;
    const record: PbiRecord = {
      ...prior,
      dependsOn: JSON.stringify(change.newDependsOn.map(resolveFinal)),
      updatedAt: now,
    };
    savePbi(record);
    updated.push(record);
  }

  const removed: string[] = [];
  const skippedRemovals: PbiDiff['removals'][number][] = [];
  for (const removal of diff.removals) {
    if (removal.statusIncompatible && !options.allowStatusIncompatibleRemovals) {
      // Should be unreachable given the guard above, but kept defensive.
      skippedRemovals.push(removal);
      continue;
    }
    deletePbi(removal.pbiId);
    removed.push(removal.pbiId);
  }

  return { diff, created, updated, removed, skippedRemovals };
}
