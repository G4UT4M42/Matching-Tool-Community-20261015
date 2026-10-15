import type { MatchGroup, MatchingState } from '../types.js';

/**
 * A match can reserve transaction/document IDs without being approved.
 * Only these historical final statuses are evidence-accepted for reporting.
 * An unreviewed PROPOSED or REJECTED group is never report-eligible.
 */
export function isAcceptedMatchGroup(group: MatchGroup): boolean {
  return group.status === 'accepted' || group.status === 'confirmed' || group.status === 'manual';
}

export function acceptedDocumentIds(state: MatchingState): Set<string> {
  const accepted = new Set<string>();
  for (const group of state.match_groups.values()) {
    if (!isAcceptedMatchGroup(group)) continue;
    for (const documentId of group.document_ids) accepted.add(documentId);
  }
  return accepted;
}
