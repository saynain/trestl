import {
  resolveGitCredential,
  migrateGitConnections,
  ownGitConnection,
  registerGitConnections,
  type GitConnection,
} from './git-connections.ts';
import { invalidateGitHubCredential } from './github-app.ts';
import { sameWorkspace, workspaceOf, workspaceUser } from './workspaces.ts';
import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Activity, Project, User, WorkItem } from '../shared/types.ts';
import type { AppContext } from './context.ts';
import { nextItemIdentifier } from './item-identifiers.ts';
import { makeStore } from './db.ts';
import {
  encryptToken,
  fetchRepository,
  validateSource,
  ProviderRequestError,
  type Provider,
  type SourceIssue,
} from './integration-provider.ts';

interface Integration {
  id: string;
  provider: Provider;
  name: string;
  baseUrl: string;
  repository: string;
  projectId: string;
  creatorId: string;
  encryptedToken?: string;
  connectionId?: string;
  createdAt: string;
  lastSyncedAt: string | null;
  lastError: string | null;
}
interface ImportedIssue {
  id: string;
  integrationId: string;
  itemId: string;
  remoteId: string;
  sourceState: string;
}
interface ImportedComment {
  id: string;
  itemId: string;
  activityId: string;
}
interface SyncResult {
  imported: number;
  updated: number;
  comments: number;
  integration: ReturnType<typeof sanitize>;
}
const createSchema = z.object({
  provider: z.enum(['github', 'gitea']).optional(),
  name: z.string().trim().min(1).max(100),
  baseUrl: z.string().max(2000).optional(),
  repository: z.string().trim().max(300),
  projectId: z.string().min(1).max(200),
  token: z.string().trim().min(1).max(4096).optional(),
  connectionId: z.string().min(1).max(200).optional(),
});
function sanitize(integration: Integration) {
  const { encryptedToken: _token, ...publicFields } = integration;
  return { ...publicFields, configured: true };
}
function identity(
  integration: Pick<Integration, 'provider' | 'baseUrl' | 'repository'>,
  remoteId = '',
): string {
  return createHash('sha256')
    .update(
      [
        integration.provider,
        integration.baseUrl,
        integration.repository.toLowerCase(),
        remoteId,
      ].join('\n'),
    )
    .digest('hex');
}
/** Upgrade imported records in place without network access or per-item queries. */
export async function backfillIssueSources(ctx: AppContext) {
  await ctx.db.transaction(async (db) => {
    const store = makeStore(db);
    await db.query(
      "SELECT id FROM entities WHERE collection='system' AND id='mutation-lock' FOR UPDATE",
    );
    const integrations = new Map(
      (await store.list<Integration>('integrations')).map((row) => [row.id, row]),
    );
    const items = new Map((await store.list<WorkItem>('items')).map((row) => [row.id, row]));
    for (const mapping of await store.list<ImportedIssue>('importedIssues')) {
      const item = items.get(mapping.itemId);
      if (!item || item.source || !item.externalUrl) continue;
      const integration = integrations.get(mapping.integrationId);
      let url: URL;
      try {
        url = new URL(item.externalUrl);
      } catch {
        continue;
      }
      const match = url.pathname.match(/\/([^/]+)\/([^/]+)\/issues\/(\d+)\/?$/);
      if (!match || !['http:', 'https:'].includes(url.protocol) || url.username || url.password)
        continue;
      item.source = {
        provider: integration?.provider ?? (url.hostname === 'github.com' ? 'github' : 'gitea'),
        integrationId: mapping.integrationId,
        repository: integration?.repository ?? `${match[1]}/${match[2]}`,
        number: Number(match[3]),
        url: item.externalUrl,
        state: mapping.sourceState === 'closed' ? 'closed' : 'open',
        lastSyncedAt: integration?.lastSyncedAt ?? null,
        connected: !!integration,
      };
      await store.put('items', item);
    }
    const activities = new Map(
      (await store.list<Activity>('activity')).map((row) => [row.id, row]),
    );
    for (const mapping of await store.list<ImportedComment>('importedComments')) {
      const activity = activities.get(mapping.activityId);
      const source = items.get(mapping.itemId)?.source;
      if (!activity || activity.source || !source || activity.itemId !== mapping.itemId) continue;
      // Only strip the exact legacy envelope on a mapped imported comment.
      const legacy = activity.body.match(
        /^\*\*(.+)\*\* · imported from (GitHub|Gitea)\n\n([\s\S]*)$/,
      );
      if (!legacy || legacy[2].toLowerCase() !== source.provider) continue;
      await store.put('activity', {
        ...activity,
        body: legacy[3],
        source: {
          provider: source.provider,
          author: legacy[1]!.replace(/\\([\\`*_{}[\]()#+.!<>|~-])/g, '$1'),
        },
      });
    }
  });
}

/** Credentials never leave the server; synchronization is strictly inbound. */
export async function registerIntegrations(app: FastifyInstance, ctx: AppContext) {
  const allowedOrigins = (process.env.INTEGRATION_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  const secret = () => process.env.APP_SECRET ?? '';
  let syncing = false;
  await migrateGitConnections(ctx);
  await registerGitConnections(app, ctx);
  await backfillIssueSources(ctx);

  function admin(request: FastifyRequest): User {
    const user = ctx.requireUser(request);
    if (user.role !== 'admin' || (request.tokenScope && request.tokenScope !== 'admin'))
      ctx.fail(
        403,
        'Only workspace administrators with administrator-scoped credentials can manage repository connections.',
      );
    return user;
  }
  async function authorized(user: User, id: string): Promise<Integration> {
    const integration = await ctx.store.get<Integration>('integrations', id);
    if (!integration || !(await ctx.canProject(user, integration.projectId)))
      ctx.fail(404, 'Repository connection not found.');
    return integration;
  }

  async function applyIssues(
    integration: Integration,
    remote: SourceIssue[],
    credential: GitConnection,
  ): Promise<SyncResult> {
    return ctx.db.transaction(async (db) => {
      const store = makeStore(db);
      await db.query(
        "SELECT id FROM entities WHERE collection='system' AND id='mutation-lock' FOR UPDATE",
      );
      // Serialize this connection across API instances as well as within a process.
      const locked = await db.query<{ data: Integration }>(
        'SELECT data FROM entities WHERE collection=$1 AND id=$2 FOR UPDATE',
        ['integrations', integration.id],
      );
      if (!locked.rows.length)
        ctx.fail(404, 'The repository connection was removed during synchronization.');
      if (locked.rows[0]!.data.connectionId !== credential.id)
        ctx.fail(
          409,
          'Repository credentials changed during synchronization. Retry with the current connection.',
        );
      const currentCredential = await store.get<GitConnection>('gitConnections', credential.id);
      if (!currentCredential || currentCredential.encryptedToken !== credential.encryptedToken)
        ctx.fail(
          409,
          'Repository credentials changed during synchronization. Retry with the current connection.',
        );
      const project = await store.get<Project>('projects', integration.projectId);
      if (!project) ctx.fail(404, 'The connected project no longer exists.');
      const owner = await workspaceUser(store, integration.creatorId, workspaceOf(project));
      if (!owner || owner.role !== 'admin' || !(await ctx.canProject(owner, project.id, store)))
        ctx.fail(403, 'The connection owner no longer has access to this project.');
      const result = { imported: 0, updated: 0, comments: 0 };
      for (const issue of remote) {
        const mappingId = identity(integration, issue.id);
        const mapping = await store.get<ImportedIssue>('importedIssues', mappingId);
        let item = mapping ? await store.get<WorkItem>('items', mapping.itemId) : null;
        if (item && !(await ctx.canItem(owner, item.id, store))) continue;
        const now = ctx.now();
        const source: NonNullable<WorkItem['source']> = {
          provider: integration.provider,
          integrationId: integration.id,
          repository: integration.repository,
          number: issue.number,
          url: issue.externalUrl,
          state: issue.closed ? 'closed' : 'open',
          lastSyncedAt: now,
          connected: true,
        };
        if (!item) {
          item = {
            id: ctx.id(),
            identifier: await nextItemIdentifier(db, project.id, workspaceOf(project)),
            title: issue.title,
            description: issue.description,
            projectId: project.id,
            parentId: null,
            type: issue.labels.some((label) => label.toLowerCase() === 'bug') ? 'bug' : 'task',
            status: issue.closed ? 'done' : 'todo',
            priority: 'none',
            assigneeId: null,
            dueDate: null,
            followUpDate: null,
            recurrence: null,
            labels: issue.labels,
            visibility: project.visibility,
            creatorId: integration.creatorId,
            workspaceId: workspaceOf(project),
            createdAt: now,
            updatedAt: now,
            completedAt: issue.closed ? now : null,
            position: Date.now(),
            externalUrl: issue.externalUrl,
            source,
          };
          await store.put('items', item);
          const event: Activity = {
            id: ctx.id(),
            itemId: item.id,
            userId: integration.creatorId,
            kind: 'event',
            body: `Imported from ${integration.provider === 'github' ? 'GitHub' : 'Gitea'} · ${integration.repository} #${issue.number}. Repository updates own the title and description; planning fields stay local.`,
            createdAt: now,
          };
          await store.put('activity', event);
          result.imported++;
        } else if (
          item.title !== issue.title ||
          item.description !== issue.description ||
          item.externalUrl !== issue.externalUrl ||
          item.source?.state !== source.state
        ) {
          item = {
            ...item,
            title: issue.title,
            description: issue.description,
            externalUrl: issue.externalUrl,
            updatedAt: now,
          };
          await store.put('items', item);
          result.updated++;
        }
        item = { ...item, source };
        await store.put('items', item);
        await store.put<ImportedIssue>('importedIssues', {
          id: mappingId,
          integrationId: integration.id,
          itemId: item.id,
          remoteId: issue.id,
          sourceState: issue.closed ? 'closed' : 'open',
        });
        const received = new Set<string>();
        for (const comment of issue.comments) {
          const commentId = identity(integration, `comment:${comment.id}`);
          received.add(commentId);
          const existing = await store.get<ImportedComment>('importedComments', commentId);
          const activityId = existing?.activityId ?? ctx.id();
          const body = comment.body;
          const activity: Activity = {
            id: activityId,
            itemId: item.id,
            userId: integration.creatorId,
            kind: 'comment',
            body,
            createdAt: comment.createdAt,
            source: { provider: integration.provider, author: comment.author },
          };
          const previous = existing ? await store.get<Activity>('activity', activityId) : null;
          if (
            !previous ||
            previous.body !== body ||
            previous.source?.author !== comment.author ||
            previous.source?.provider !== integration.provider
          ) {
            await store.put('activity', activity);
            result.comments++;
          }
          await store.put<ImportedComment>('importedComments', {
            id: commentId,
            itemId: item.id,
            activityId,
          });
        }
        // Mirror deleted source comments without touching locally authored discussion.
        const priorComments = (
          await db.query<{ data: ImportedComment }>(
            "SELECT data FROM entities WHERE collection='importedComments' AND data->>'itemId'=$1",
            [item.id],
          )
        ).rows.map((row) => row.data);
        for (const comment of priorComments) {
          if (!received.has(comment.id)) {
            await store.remove('activity', comment.activityId);
            await store.remove('importedComments', comment.id);
          }
        }
      }
      // Commit sync status with the items so disconnect cannot resurrect an import.
      const updated = { ...locked.rows[0]!.data, lastSyncedAt: ctx.now(), lastError: null };
      await store.put('integrations', updated);
      // Missing remote issues are retained: providers can hide issues because access changed.
      return { ...result, integration: sanitize(updated) };
    });
  }

  async function sync(integration: Integration): Promise<SyncResult> {
    if (syncing)
      ctx.fail(409, 'A repository synchronization is already running. Please retry shortly.');
    syncing = true;
    try {
      let credential = await ownGitConnection(
        ctx,
        integration.creatorId,
        integration.connectionId ?? '',
      );
      if (
        credential.provider !== integration.provider ||
        credential.baseUrl !== integration.baseUrl
      )
        throw new Error('Repository connection does not match its saved credentials.');
      let token: string;
      try {
        const resolved = await resolveGitCredential(ctx, credential);
        credential = resolved.connection;
        token = resolved.token;
      } catch (error) {
        if (credential.githubApp) throw error;
        throw new Error(
          'Repository credentials could not be decrypted. Restore APP_SECRET or recreate this connection.',
        );
      }
      let issues: SourceIssue[];
      try {
        issues = await fetchRepository(integration, token, {
          allowedOrigins: credential.shared
            ? [...allowedOrigins, new URL(credential.baseUrl).origin]
            : allowedOrigins,
          ...(credential.githubApp || credential.githubInstallation
            ? { fetch: ctx.githubFetch }
            : {}),
        });
      } catch (error) {
        if (
          error instanceof ProviderRequestError &&
          error.providerStatus === 401 &&
          credential.githubApp
        ) {
          await invalidateGitHubCredential(ctx, credential);
          throw new Error('GitHub authorization was revoked. Reconnect GitHub in Settings.');
        }
        throw error;
      }
      // Recheck owner authorization after network work, before writing fetched content.
      const project = await ctx.store.get<Project>('projects', integration.projectId);
      const owner =
        project && (await workspaceUser(ctx.store, integration.creatorId, workspaceOf(project)));
      if (!owner || owner.role !== 'admin' || !(await ctx.canProject(owner, integration.projectId)))
        throw new Error('The connection owner no longer has administrator access to this project.');
      const current = await ctx.store.get<Integration>('integrations', integration.id);
      if (!current)
        throw new Error('The repository connection was removed during synchronization.');
      return await applyIssues(current, issues, credential);
    } catch (error) {
      // Only known error text is persisted; provider response bodies and token values are never logged.
      const text = error instanceof Error ? error.message : 'Repository synchronization failed.';
      const message =
        /^(GitHub |Provider |Repository |Could not reach |The connection |The connected |The repository )/.test(
          text,
        )
          ? text
          : 'Repository synchronization failed. Check server configuration and database availability.';
      const current = await ctx.store.get<Integration>('integrations', integration.id);
      if (current)
        await ctx.db.query(
          "UPDATE entities SET data=jsonb_set(data, '{lastError}', $3::jsonb) WHERE collection='integrations' AND id=$1 AND data->>'connectionId'=$2",
          [integration.id, integration.connectionId, JSON.stringify(message)],
        );
      ctx.fail(502, message);
    } finally {
      syncing = false;
    }
  }

  app.get('/api/v1/integrations', async (request) => {
    const user = admin(request);
    const integrations = await ctx.store.list<Integration>('integrations');
    const visible = await Promise.all(
      integrations.map(async (integration) =>
        (await ctx.canProject(user, integration.projectId)) ? sanitize(integration) : null,
      ),
    );
    return visible.filter(Boolean);
  });
  app.post('/api/v1/integrations', async (request, reply) => {
    const user = admin(request);
    const parsed = createSchema.safeParse(request.body);
    if (!parsed.success)
      ctx.fail(400, 'Provide a name, projectId, owner/repository, and saved connection.');
    const data = parsed.data;
    const saved = data.connectionId
      ? await ownGitConnection(ctx, user.id, data.connectionId)
      : null;
    if (!saved && (!data.provider || !data.token))
      ctx.fail(400, 'Choose a saved connection, or provide a provider and token.');
    if (
      saved &&
      (data.token ||
        (data.provider && data.provider !== saved.provider) ||
        (data.baseUrl && data.baseUrl !== saved.baseUrl))
    )
      ctx.fail(400, 'Use the provider and credentials of the saved connection.');
    if (!(await ctx.canProject(user, data.projectId))) ctx.fail(404, 'Project not found.');
    if (secret().length < 32)
      ctx.fail(
        503,
        'APP_SECRET must contain at least 32 characters before repository connections can be configured.',
      );
    let source;
    try {
      source = validateSource(
        {
          provider: saved?.provider ?? data.provider!,
          baseUrl:
            saved?.baseUrl ??
            (data.baseUrl || (data.provider === 'github' ? 'https://api.github.com' : '')),
          repository: data.repository,
        },
        saved?.shared ? [...allowedOrigins, new URL(saved.baseUrl).origin] : allowedOrigins,
      );
    } catch (error) {
      ctx.fail(400, error instanceof Error ? error.message : 'Invalid repository configuration.');
    }
    const existing = await ctx.store.list<Integration>('integrations');
    const projects = new Map((await ctx.store.list<Project>('projects')).map((p) => [p.id, p]));
    if (
      existing.some((connection) => {
        const project = projects.get(connection.projectId);
        return project && sameWorkspace(user, project) && identity(connection) === identity(source);
      })
    )
      ctx.fail(
        409,
        'This repository already has a connection. Use views to show the same work across projects.',
      );
    const id =
      workspaceOf(user) === 'default'
        ? identity(source)
        : createHash('sha256')
            .update(`${workspaceOf(user)}:${identity(source)}`)
            .digest('hex');
    const connectionId = saved?.id ?? ctx.id();
    const credential: GitConnection = saved ?? {
      id: connectionId,
      userId: user.id,
      provider: source.provider,
      name: data.name,
      baseUrl: source.baseUrl,
      encryptedToken: encryptToken(data.token!, secret(), connectionId),
      createdAt: ctx.now(),
      updatedAt: ctx.now(),
    };
    const integration: Integration = {
      ...source,
      id,
      name: data.name,
      projectId: data.projectId,
      creatorId: user.id,
      connectionId,
      createdAt: ctx.now(),
      lastSyncedAt: null,
      lastError: null,
    };
    await ctx.db.transaction(async (db) => {
      const store = makeStore(db);
      await db.query(
        "SELECT id FROM entities WHERE collection='system' AND id='mutation-lock' FOR UPDATE",
      );
      if (saved && !(await store.get<GitConnection>('gitConnections', saved.id)))
        ctx.fail(404, 'Git connection not found.');
      const inserted = await db.query(
        'INSERT INTO entities(collection,id,data) VALUES ($1,$2,$3::jsonb) ON CONFLICT(collection,id) DO NOTHING RETURNING id',
        ['integrations', id, JSON.stringify(integration)],
      );
      if (!inserted.rows.length) ctx.fail(409, 'This repository already has a connection.');
      if (!saved) await store.put('gitConnections', credential);
    });
    reply.code(201);
    return sanitize(integration);
  });
  app.delete<{ Params: { id: string } }>('/api/v1/integrations/:id', async (request, reply) => {
    const user = admin(request);
    await authorized(user, request.params.id);
    if (syncing)
      ctx.fail(
        409,
        'Wait for the running repository synchronization before removing a connection.',
      );
    await ctx.db.transaction(async (db) => {
      const store = makeStore(db);
      await db.query(
        "SELECT id FROM entities WHERE collection='system' AND id='mutation-lock' FOR UPDATE",
      );
      for (const item of await store.list<WorkItem>('items')) {
        if (item.source?.integrationId === request.params.id)
          await store.put('items', { ...item, source: { ...item.source, connected: false } });
      }
      await store.remove('integrations', request.params.id);
    });
    return reply.code(204).send();
  });
  app.post<{ Params: { id: string } }>('/api/v1/integrations/:id/sync', async (request) =>
    sync(await authorized(admin(request), request.params.id)),
  );

  // Explicit opt-in reconciliation, minimum one minute, with one process owning scheduling.
  const intervalMs = Number(process.env.INTEGRATION_SYNC_INTERVAL_MS ?? 0);
  if (Number.isFinite(intervalMs) && intervalMs >= 60_000) {
    let stopped = false;
    const timer = setInterval(async () => {
      if (stopped || syncing) return;
      try {
        for (const integration of await ctx.store.list<Integration>('integrations')) {
          if (stopped || syncing) break;
          const project = await ctx.store.get<Project>('projects', integration.projectId);
          const owner =
            project &&
            (await workspaceUser(ctx.store, integration.creatorId, workspaceOf(project)));
          if (
            !owner ||
            owner.role !== 'admin' ||
            !(await ctx.canProject(owner, integration.projectId))
          )
            continue;
          try {
            await sync(integration);
          } catch {
            /* A sanitized error is available on the connection. */
          }
        }
      } catch {
        app.log.warn('Repository reconciliation could not read connection configuration.');
      }
    }, intervalMs);
    timer.unref();
    app.addHook('onClose', async () => {
      stopped = true;
      clearInterval(timer);
    });
  }
}
