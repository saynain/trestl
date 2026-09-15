import type { WorkItem } from '../shared/types.ts';
import type { SourceIssue } from './integration-provider.ts';

export interface IssueFields {
  title: string;
  description: string;
  labels: string[];
  state: 'open' | 'closed';
}
export const sameField = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const labels = (values: string[]) => [...new Set(values)].sort();
export const localIssueFields = (item: WorkItem): IssueFields => ({
  title: item.title,
  description: item.description,
  labels: labels(item.labels),
  state: ['done', 'canceled'].includes(item.status) ? 'closed' : 'open',
});
export const remoteIssueFields = (issue: SourceIssue): IssueFields => ({
  title: issue.title,
  description: issue.description,
  labels: labels(issue.labels),
  state: issue.closed ? 'closed' : 'open',
});
/** Merge independently edited fields; never choose a winner for competing edits. */
export function mergeIssueFields(base: IssueFields, local: IssueFields, remote: IssueFields) {
  const merged = { ...remote };
  const conflicts: (keyof IssueFields)[] = [];
  for (const field of ['title', 'description', 'labels', 'state'] as const) {
    if (sameField(local[field], base[field]) || sameField(local[field], remote[field])) continue;
    if (!sameField(remote[field], base[field])) {
      conflicts.push(field);
      continue;
    }
    Object.assign(merged, { [field]: local[field] });
  }
  return { merged, conflicts };
}
