import type { ProjectUpdate } from './types';
/** Newest first; compare instants (imported timestamps may have different offsets). */
export function compareProjectUpdates(a: ProjectUpdate, b: ProjectUpdate) {
  return (
    Date.parse(b.createdAt) - Date.parse(a.createdAt) ||
    (b.sortKey ?? b.id).localeCompare(a.sortKey ?? a.id) ||
    b.id.localeCompare(a.id)
  );
}
