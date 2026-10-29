import { createHmac } from 'node:crypto';
import type { Activity, Project, User, WorkItem } from '../shared/types.ts';
import {
  fieldOwnership,
  outboundLabels,
  type OutboundField,
  type Publication,
} from '../shared/repository-sync.ts';
import type { AppContext } from './context.ts';
import type { Store } from './db.ts';
import type { GitConnection } from './git-connections.ts';
import { repositoryWebUrl } from './integration-provider.ts';
import {
  modeOf,
  type AttachmentAccess,
  type RepositoryAttachment,
} from './repository-attachments.ts';
import { workspaceOf, workspaceUser } from './workspaces.ts';

/** Every write Trestl could make to a repository, and the opt-in it needs. */
export type OutboundKind = 'comment.create' | 'issue.state' | 'issue.assignee';
export const outboundField: Record<OutboundKind, OutboundField> = {
  'comment.create': 'comments',
  'issue.state': 'status',
  'issue.assignee': 'assignee',
};

export class OutboundRejected extends Error {
  readonly statusCode = 403;
  constructor(
    readonly code: 'mode' | 'not_opted_in' | 'capability' | 'permission' | 'content',
    message: string,
  ) {
    super(message);
  }
}

/** Connections that can never publish, whatever the provider reports. */
export const readOnlyConnection = (connection: GitConnection) =>
  !!(connection.githubApp || connection.githubInstallation);

/**
 * The single gate for outbound operations. It checks the attachment mode and opt-in,
 * the provider capability, and the actor's own project permission, so shared
 * credentials never let project visibility alone publish content.
 */
export async function authorizeOutbound(
  ctx: AppContext,
  store: Store,
  request: {
    attachmentId: string;
    itemId: string;
    kind: OutboundKind;
    actorId: string;
    tokenScope?: string | null;
    activityId?: string;
  },
) {
  const attachment = await store.get<RepositoryAttachment>('integrations', request.attachmentId);
  if (!attachment) throw new OutboundRejected('mode', 'This repository is no longer attached.');
  const field = outboundField[request.kind];
  if (modeOf(attachment) !== 'two_way')
    throw new OutboundRejected(
      'mode',
      `${attachment.repository} is not in two-way mode, so Trestl does not publish to it.`,
    );
  if (!attachment.publish?.[field] || !attachment.twoWay)
    throw new OutboundRejected(
      'not_opted_in',
      `This project has not opted into publishing ${outboundLabels[field].title.toLowerCase()} to ${attachment.repository}.`,
    );
  const connection = attachment.connectionId
    ? await store.get<GitConnection>('gitConnections', attachment.connectionId)
    : null;
  if (!connection || readOnlyConnection(connection) || attachment.access?.write !== true)
    throw new OutboundRejected(
      'capability',
      attachment.access?.reason ?? 'This repository connection cannot publish.',
    );
  if (request.tokenScope === 'read')
    throw new OutboundRejected('permission', 'Read-only tokens cannot publish.');
  const project = await store.get<Project>('projects', attachment.projectId);
  const actor = project && (await workspaceUser(store, request.actorId, workspaceOf(project)));
  if (!project || !actor || !(await ctx.canProject(actor, project.id, store)))
    throw new OutboundRejected('permission', 'You do not have access to this project.');
  if (!projectTeam(project, actor))
    throw new OutboundRejected(
      'permission',
      'Only the project owner, project members and administrators can publish to its repositories.',
    );
  if (!connection.shared && connection.userId !== actor.id)
    throw new OutboundRejected(
      'permission',
      'This repository uses someone’s personal connection. Only they can publish with it.',
    );
  const item = await store.get<WorkItem>('items', request.itemId);
  if (
    !item ||
    !(await ctx.canItem(actor, item.id, store)) ||
    item.source?.integrationId !== attachment.id ||
    !item.source.connected
  )
    throw new OutboundRejected('content', 'This item does not follow this repository.');
  if (item.visibility === 'private')
    throw new OutboundRejected('content', 'Private items are never published.');
  let activity: Activity | null = null;
  if (request.kind === 'comment.create') {
    activity = request.activityId
      ? await store.get<Activity>('activity', request.activityId)
      : null;
    if (
      !activity ||
      activity.itemId !== item.id ||
      activity.kind !== 'comment' ||
      activity.source ||
      activity.importedFrom ||
      activity.userId !== actor.id
    )
      throw new OutboundRejected('content', 'Only your own replies on this item can be published.');
    if (activity.createdAt < attachment.twoWay.activatedAt)
      throw new OutboundRejected(
        'content',
        'Notes written before two-way was enabled are never published.',
      );
  }
  return { attachment, connection, project, actor, item, activity };
}

const projectTeam = (project: Project, user: User) =>
  user.role === 'admin' || project.ownerId === user.id || !!project.memberIds?.includes(user.id);

/** What enabling two-way would do. The confirmation binds the exact preview shown. */
export function twoWayPreview(
  attachment: RepositoryAttachment,
  connection: GitConnection,
  access: AttachmentAccess,
  publish: Publication,
  viewerId: string,
) {
  const provider = attachment.provider === 'github' ? 'GitHub' : 'Gitea';
  const preview = {
    destination: {
      provider: attachment.provider,
      repository: attachment.repository,
      webUrl: repositoryWebUrl(attachment),
      private: access.private,
    },
    publisher: connection.shared
      ? `The shared “${connection.name}” connection publishes on everyone’s behalf.`
      : `Your personal “${connection.name}” connection publishes as you.`,
    audience:
      access.private === false
        ? `${attachment.repository} is public. Anyone can read what Trestl publishes.`
        : access.private
          ? `Everyone with access to ${attachment.repository} on ${provider} can read what Trestl publishes.`
          : `Everyone who can read ${attachment.repository} on ${provider} can read what Trestl publishes.`,
    fields: fieldOwnership.map((row) => ({
      field: row.field,
      owner: row.opt && !publish[row.opt] ? 'Stays in Trestl' : row.two_way,
      published: row.opt ? publish[row.opt] : false,
    })),
    publish,
    neverPublished: [
      'Notes and comments written before two-way is enabled',
      'Internal notes, and comments not posted as replies',
      'Private items',
      'Priority, dates, labels and follow-ups',
    ],
    note: `This version records the project’s choice. Trestl does not write to ${attachment.repository} yet.`,
  };
  const confirmation = createHmac('sha256', process.env.APP_SECRET ?? '')
    .update(JSON.stringify({ id: attachment.id, viewerId, connection: connection.id, preview }))
    .digest('base64url');
  return { ...preview, confirmation };
}
