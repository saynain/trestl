import type { User } from '../../shared/types';

type Profile = Pick<User, 'id' | 'workspaceId'>;
export const draftKey = (user: Profile, scope: string) =>
  `trestl.draft.v1.${encodeURIComponent(user.workspaceId || 'default')}.${encodeURIComponent(user.id)}.${encodeURIComponent(scope)}`;

/** Draft storage is optional: a full or disabled browser store must not block writing. */
export function readDraft<T>(key: string, valid: (value: unknown) => value is T): T | null {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) || 'null');
    return valid(value) ? value : null;
  } catch {
    return null;
  }
}
export function saveDraft(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* Continue editing when storage is unavailable. */
  }
}
export function clearDraft(key: string) {
  try {
    localStorage.removeItem(key);
  } catch {
    /* Continue saving when storage is unavailable. */
  }
}

export interface RetryIntent {
  fingerprint: string;
  key: string;
  createdAt: number;
}
export const retryLifetimeMs = 30 * 60 * 1000;
/** Identical retries replay one write; changing the submitted body starts a new write. */
export function retryIntent(
  body: unknown,
  previous: RetryIntent | null,
  now = Date.now(),
): RetryIntent {
  const fingerprint = JSON.stringify(body);
  return previous?.fingerprint === fingerprint &&
    previous.createdAt <= now &&
    now - previous.createdAt < retryLifetimeMs
    ? previous
    : { fingerprint, key: crypto.randomUUID(), createdAt: now };
}
export const isRetryIntent = (value: unknown): value is RetryIntent => {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.fingerprint === 'string' &&
    typeof candidate.key === 'string' &&
    typeof candidate.createdAt === 'number' &&
    Number.isFinite(candidate.createdAt)
  );
};

export interface DraftText {
  title: string;
  description: string;
}
export function hasDraftChanges(current: DraftText, base: DraftText): boolean {
  return current.title !== base.title || current.description !== base.description;
}
