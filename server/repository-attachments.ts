import { createHash } from 'node:crypto';
import type { Project, User, WorkItem } from '../shared/types.ts';
import { noPublication, type Publication, type SyncMode } from '../shared/repository-sync.ts';
import type { AppContext } from './context.ts';
import { makeStore, type Store } from './db.ts';
import type { GitConnection } from './git-connections.ts';
import { repositoryWebUrl, type Provider, type RepositoryAccess } from './integration-provider.ts';

/**
 * Reference links a repository to a project. Inbound mirror imports its issues and
 * comments, which is how every repository import before attachments behaved.
 * Two-way is only reachable through an explicit, previewed activation.
 */
export type AttachmentMode = SyncMode;
/** Modes that can be chosen directly; two-way needs the activation preview. */
export const attachmentModes = ['reference', 'inbound'] as const;

export interface AttachmentAccess {
  checkedAt: string;
  private: boolean | null;
  /** The credential could list issues in the repository. */
  issues: boolean;
  /** Whether the credential could publish, if a future mode allowed it. Nothing writes yet. */
  write: boolean;
  reason: string | null;
}
/** Stored in the `integrations` collection so imports keep their IDs and source identity. */
export interface RepositoryAttachment {
  id: string;
  provider: Provider;
  name: string;
  baseUrl: string;
  repository: string;
  projectId: string;
  creatorId: string;
  connectionId?: string;
  /** Legacy inline credential, moved into gitConnections at startup. */
  encryptedToken?: string;
  createdAt: string;
  updatedAt?: string;
  lastSyncedAt: string | null;
  lastError: string | null;
  lastErrorAt?: string | null;
  /** Absent on imports created before attachments; those are inbound mirrors. */
  mode?: AttachmentMode;
  /** One attachment per project is the default destination for new items. */
  isDefault?: boolean;
  /** Provider repository ID, recorded when access is verified. */
  remoteId?: string | null;
  access?: AttachmentAccess;
  /** Fields the project opted into publishing. Only honoured in two-way mode. */
  publish?: Publication;
  /** Who confirmed the two-way preview, and when. Earlier local content is never published. */
  twoWay?: { activatedAt: string; activatedBy: string } | null;
}

export const modeOf = (attachment: Pick<RepositoryAttachment, 'mode'>): AttachmentMode =>
  attachment.mode ?? 'inbound';

/** Path-based identity used by imported issue and comment mappings since the first release. */
export function repositoryIdentity(
  source: Pick<RepositoryAttachment, 'provider' | 'baseUrl' | 'repository'>,
  remoteId = '',
): string {
  return createHash('sha256')
    .update([source.provider, source.baseUrl, source.repository.toLowerCase(), remoteId].join('\n'))
    .digest('hex');
}

/** Project owners and workspace administrators manage a project's repositories. */
export async function canManageRepositories(
  ctx: AppContext,
  user: User,
  projectId: string,
  store: Store = ctx.store,
): Promise<boolean> {
  const project = await store.get<Project>('projects', projectId);
  return (
    !!project &&
    (project.ownerId === user.id || user.role === 'admin') &&
    (await ctx.canProject(user, projectId, store))
  );
}

/** Explains up front why a credential could never publish, instead of failing later. */
export function assessAccess(
  connection: GitConnection,
  access: RepositoryAccess,
  checkedAt: string,
): AttachmentAccess {
  const reason = connection.githubInstallation
    ? 'This GitHub App installation only requests read access to issues.'
    : connection.githubApp
      ? 'GitHub sign-in connections use a read-only GitHub App.'
      : !access.metadata
        ? 'This credential can read issues but not repository permissions, so Trestl treats it as read-only.'
        : access.push === false
          ? `This credential has read-only access to ${access.repository}.`
          : access.push === null
            ? 'The provider did not report write access for this credential.'
            : null;
  return { checkedAt, private: access.private, issues: access.issues, write: !reason, reason };
}

export function publicAttachment(
  attachment: RepositoryAttachment,
  viewer: User,
  connection: GitConnection | null,
  syncing = false,
) {
  return {
    id: attachment.id,
    projectId: attachment.projectId,
    provider: attachment.provider,
    repository: attachment.repository,
    baseUrl: attachment.baseUrl,
    webUrl: repositoryWebUrl(attachment),
    mode: modeOf(attachment),
    isDefault: !!attachment.isDefault,
    // Personal credential names are their owner's business; secrets never leave the server.
    connection: connection
      ? {
          id: connection.id,
          name:
            connection.shared || connection.userId === viewer.id
              ? connection.name
              : 'Personal connection',
          shared: !!connection.shared,
        }
      : null,
    creatorId: attachment.creatorId,
    createdAt: attachment.createdAt,
    lastSyncedAt: attachment.lastSyncedAt,
    lastError: attachment.lastError,
    lastErrorAt: attachment.lastErrorAt ?? null,
    syncing,
    access: attachment.access ?? null,
    publish:
      modeOf(attachment) === 'two_way' ? (attachment.publish ?? noPublication) : noPublication,
    twoWay: modeOf(attachment) === 'two_way' ? (attachment.twoWay ?? null) : null,
  };
}
export type PublicAttachment = ReturnType<typeof publicAttachment>;

const byAge = (a: RepositoryAttachment, b: RepositoryAttachment) =>
  a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);

export async function projectAttachments(store: Store, projectId: string) {
  return (
    await store.query<{ data: RepositoryAttachment }>(
      "SELECT data FROM entities WHERE collection='integrations' AND data->>'projectId'=$1",
      [projectId],
    )
  ).rows
    .map((row) => row.data)
    .sort(byAge);
}

/** Keep exactly one default per project, preferring the oldest remaining attachment. */
export async function ensureDefault(store: Store, projectId: string) {
  const attachments = await projectAttachments(store, projectId);
  const chosen = attachments.find((a) => a.isDefault) ?? attachments[0];
  for (const attachment of attachments) {
    const isDefault = attachment === chosen;
    if (!!attachment.isDefault !== isDefault)
      await store.put('integrations', { ...attachment, isDefault });
  }
}

/** Stops synchronization; imported work stays where it is and is marked disconnected. */
export async function detachAttachments(store: Store, ids: Iterable<string>) {
  const detached = new Set(ids);
  if (!detached.size) return;
  const projects = new Set<string>();
  for (const id of detached) {
    const attachment = await store.get<RepositoryAttachment>('integrations', id);
    if (attachment) projects.add(attachment.projectId);
  }
  await disconnectItems(store, detached);
  for (const id of detached) await store.remove('integrations', id);
  for (const projectId of projects) await ensureDefault(store, projectId);
}

export async function disconnectItems(store: Store, attachmentIds: Set<string>) {
  for (const item of await store.list<WorkItem>('items')) {
    if (item.source && attachmentIds.has(item.source.integrationId) && item.source.connected)
      await store.put('items', { ...item, source: { ...item.source, connected: false } });
  }
}

/** Existing imports become inbound mirrors; each project gets one default. Idempotent. */
export async function migrateRepositoryAttachments(ctx: AppContext) {
  await ctx.db.transaction(async (db) => {
    const store = makeStore(db);
    await db.query(
      "SELECT id FROM entities WHERE collection='system' AND id='mutation-lock' FOR UPDATE",
    );
    const attachments = (await store.list<RepositoryAttachment>('integrations')).sort(byAge);
    const defaults = new Set(attachments.filter((a) => a.isDefault).map((a) => a.projectId));
    for (const attachment of attachments) {
      const isDefault = !!attachment.isDefault || !defaults.has(attachment.projectId);
      defaults.add(attachment.projectId);
      if (attachment.mode && attachment.isDefault === isDefault) continue;
      await store.put('integrations', { ...attachment, mode: modeOf(attachment), isDefault });
    }
  });
}
