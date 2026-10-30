import type { Priority, ResourceLink, WorkItem } from './types';

const priorityRank: Record<Priority, number> = { urgent: 0, high: 1, medium: 2, low: 3, none: 4 };

/**
 * Who an item belongs to: its assignee, or the creator of an unassigned inbox capture
 * (the same rule as isMyWork in the interface). Null means anyone may claim it.
 */
export function queueOwner(item: WorkItem) {
  return item.assigneeId ?? (item.projectId ? null : item.creatorId);
}

/** Ready order: priority, then the earliest due date (undated last), then board position. */
export function compareReady(a: WorkItem, b: WorkItem) {
  return (
    (priorityRank[a.priority] ?? 4) - (priorityRank[b.priority] ?? 4) ||
    Number(!a.dueDate) - Number(!b.dueDate) ||
    (a.dueDate ?? '').localeCompare(b.dueDate ?? '') ||
    a.position - b.position ||
    a.id.localeCompare(b.id)
  );
}

/** Normalizes an owner/name repository reference; returns null for anything else. */
export function repositoryName(value: string) {
  const name = value
    .trim()
    .replace(/^\/+|\/+$/g, '')
    .replace(/\.git$/i, '')
    .toLowerCase();
  return /^[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(name) ? name : null;
}

/** A link points into owner/name at any path depth, since Gitea may be served from a subpath. */
function linksTo(url: string, repository: string) {
  let path: string;
  try {
    path = new URL(url).pathname.toLowerCase();
  } catch {
    return false;
  }
  const needle = `/${repository}`;
  for (let at = path.indexOf(needle); at >= 0; at = path.indexOf(needle, at + 1)) {
    const rest = path.slice(at + needle.length);
    if (!rest || rest.startsWith('/') || /^\.git(\/|$)/.test(rest)) return true;
  }
  return false;
}

/**
 * An item belongs to the repository it was imported from or that its own repository
 * links point to. Items without their own repository use their project's repository links.
 */
export function belongsToRepository(item: WorkItem, links: ResourceLink[], repository: string) {
  const own = links.filter((link) => link.kind === 'repository' && link.itemId === item.id);
  if (item.source || own.length)
    return (
      item.source?.repository.toLowerCase() === repository ||
      own.some((link) => linksTo(link.url, repository))
    );
  return links.some(
    (link) =>
      link.kind === 'repository' &&
      !link.itemId &&
      !!item.projectId &&
      link.projectId === item.projectId &&
      linksTo(link.url, repository),
  );
}

/** A short link title such as "owner/name#12" for pull and merge request URLs. */
export function pullRequestTitle(url: string) {
  const match = /\/([^/]+)\/([^/]+?)(?:\.git)?\/(?:pulls?|-\/merge_requests)\/(\d+)/.exec(
    new URL(url).pathname,
  );
  return match ? `Pull request ${match[1]}/${match[2]}#${match[3]}` : 'Pull request';
}
