import { randomUUID } from 'node:crypto';
import { extractMentions } from '../shared/mentions.ts';
import type {
  MentionNotification,
  ProjectRelation,
  Relation,
  User,
  WorkItem,
} from '../shared/types.ts';
import type { Store } from './db.ts';
import { workspaceOf, workspaceUser } from './workspaces.ts';

export async function addMentionRelations(
  store: Store,
  user: User,
  item: WorkItem,
  body: string,
  previousBody: string,
  check: {
    item: (id: string) => Promise<unknown>;
    project: (id: string) => Promise<unknown>;
    canvas: (id: string) => Promise<unknown>;
    recipientCanRead: (recipient: User) => Promise<boolean>;
  },
  activityId: string | null = null,
) {
  const previous = new Set(extractMentions(previousBody).map((m) => `${m.kind}:${m.id}`));
  const mentions = extractMentions(body).filter((m) => !previous.has(`${m.kind}:${m.id}`));
  const relations = await store.list<Relation>('relations');
  const projects = await store.list<ProjectRelation>('projectRelations');
  for (const mention of mentions) {
    if (mention.kind === 'user') {
      const target = await workspaceUser(store, mention.id, workspaceOf(user));
      if (!target || target.disabledAt)
        throw Object.assign(new Error('Mentioned person is unavailable in this workspace'), {
          statusCode: 400,
          expose: true,
        });
      if (target.id !== user.id && (await check.recipientCanRead(target))) {
        await store.put<MentionNotification>('notifications', {
          id: randomUUID(),
          workspaceId: workspaceOf(user),
          recipientId: target.id,
          actorId: user.id,
          itemId: item.id,
          activityId,
          kind: 'mention',
          createdAt: new Date().toISOString(),
          readAt: null,
        });
      }
    } else if (mention.kind === 'item') {
      await check.item(mention.id);
      if (mention.id === item.id) continue;
      if (
        relations.some(
          (r) =>
            r.kind === 'related' &&
            ((r.itemId === item.id && r.targetId === mention.id) ||
              (r.targetId === item.id && r.itemId === mention.id)),
        )
      )
        continue;
      relations.push(
        await store.put<Relation>('relations', {
          id: randomUUID(),
          itemId: item.id,
          targetId: mention.id,
          kind: 'related',
        }),
      );
    } else if (mention.kind === 'canvas') {
      await check.canvas(mention.id);
    } else if (mention.kind === 'project') {
      await check.project(mention.id);
      if (projects.some((r) => r.itemId === item.id && r.projectId === mention.id)) continue;
      projects.push(
        await store.put<ProjectRelation>('projectRelations', {
          id: randomUUID(),
          itemId: item.id,
          projectId: mention.id,
        }),
      );
    }
  }
}
