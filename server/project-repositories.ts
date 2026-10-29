import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Project, User } from '../shared/types.ts';
import type { AppContext } from './context.ts';
import { makeStore } from './db.ts';
import {
  gitOrigins,
  ownGitConnection,
  withGitCredential,
  type GitConnection,
} from './git-connections.ts';
import { checkRepositoryAccess, validateSource } from './integration-provider.ts';
import type { SyncResult } from './integrations.ts';
import {
  assessAccess,
  attachmentModes,
  canManageRepositories,
  detachAttachments,
  disconnectItems,
  ensureDefault,
  modeOf,
  projectAttachments,
  publicAttachment,
  repositoryIdentity,
  type AttachmentMode,
  type RepositoryAttachment,
} from './repository-attachments.ts';
import { sameWorkspace } from './workspaces.ts';
import { readOnlyConnection, twoWayPreview } from './repository-policy.ts';
import { mirrors, outboundFields } from '../shared/repository-sync.ts';

interface SyncEngine {
  sync(attachment: RepositoryAttachment): Promise<SyncResult>;
  syncing(id: string): boolean;
}
const base = '/api/v1/projects/:projectId/repositories';
type Params = { projectId: string };
type AttachmentParams = Params & { id: string };
const target = z
  .object({
    connectionId: z.string().min(1).max(200),
    repository: z.string().trim().min(3).max(300),
  })
  .strict();
const mode = z.enum(attachmentModes);
const publication = z
  .object({ comments: z.boolean(), status: z.boolean(), assignee: z.boolean() })
  .strict();

/** Project owners attach repositories using credentials an administrator configured. */
export async function registerProjectRepositories(
  app: FastifyInstance,
  ctx: AppContext,
  engine: SyncEngine,
) {
  async function visibleProject(request: FastifyRequest, projectId: string) {
    const user = ctx.requireUser(request);
    const project = await ctx.store.get<Project>('projects', projectId);
    if (!project || !(await ctx.canProject(user, projectId))) ctx.fail(404, 'Project not found.');
    return { user, project };
  }
  async function manager(request: FastifyRequest, projectId: string, allowTokens = false) {
    const visible = await visibleProject(request, projectId);
    if (!allowTokens && request.tokenScope && request.tokenScope !== 'admin')
      ctx.fail(403, 'Manage project repositories from a signed-in browser session.');
    if (!(await canManageRepositories(ctx, visible.user, projectId)))
      ctx.fail(403, 'Only the project owner or a workspace administrator can manage repositories.');
    return visible;
  }
  async function attachment(projectId: string, id: string) {
    const found = await ctx.store.get<RepositoryAttachment>('integrations', id);
    if (!found || found.projectId !== projectId) ctx.fail(404, 'Repository not found.');
    return found;
  }
  async function present(user: User, row: RepositoryAttachment) {
    const connection = row.connectionId
      ? await ctx.store.get<GitConnection>('gitConnections', row.connectionId)
      : null;
    return publicAttachment(row, user, connection, engine.syncing(row.id));
  }
  /** Inbound mirrors import issues, so one repository mirrors into one project per workspace. */
  async function conflict(
    project: Project,
    candidate: Pick<RepositoryAttachment, 'provider' | 'baseUrl' | 'repository'> & {
      id?: string;
      mode: AttachmentMode;
    },
    store = ctx.store,
  ) {
    const identity = repositoryIdentity(candidate);
    const projects = new Map((await store.list<Project>('projects')).map((p) => [p.id, p]));
    for (const other of await store.list<RepositoryAttachment>('integrations')) {
      if (other.id === candidate.id || repositoryIdentity(other) !== identity) continue;
      if (other.projectId === project.id)
        return 'This repository is already attached to this project.';
      const owner = projects.get(other.projectId);
      if (
        candidate.mode !== 'reference' &&
        modeOf(other) !== 'reference' &&
        owner &&
        sameWorkspace(owner, project)
      )
        return 'This repository already mirrors issues into another project. Attach it here as Reference, or detach it there first.';
    }
    return null;
  }
  /** Reads repository metadata and issues with the chosen credential. Never writes. */
  async function inspect(user: User, connectionId: string, repository: string) {
    const connection = await ownGitConnection(ctx, user.id, connectionId);
    let source;
    try {
      source = validateSource({ ...connection, repository }, gitOrigins(connection));
    } catch (error) {
      ctx.fail(400, error instanceof Error ? error.message : 'Invalid repository.');
    }
    const checked = await withGitCredential(ctx, connection, (token, options) =>
      checkRepositoryAccess(source, token, options),
    );
    return {
      connection,
      source: {
        provider: source.provider,
        baseUrl: source.baseUrl,
        repository: checked.repository,
      },
      remoteId: checked.remoteId,
      access: assessAccess(connection, checked, ctx.now()),
    };
  }

  app.get<{ Params: Params }>(base, async (request) => {
    const { user } = await visibleProject(request, request.params.projectId);
    const rows = await projectAttachments(ctx.store, request.params.projectId);
    rows.sort((a, b) => Number(!!b.isDefault) - Number(!!a.isDefault));
    return { data: await Promise.all(rows.map((row) => present(user, row))) };
  });

  app.post<{ Params: Params }>(`${base}/verify`, async (request) => {
    const { user, project } = await manager(request, request.params.projectId);
    const input = target.safeParse(request.body);
    if (!input.success) ctx.fail(400, 'Choose a Git connection and an owner/repository.');
    const checked = await inspect(user, input.data.connectionId, input.data.repository);
    return {
      ...checked.source,
      remoteId: checked.remoteId,
      access: checked.access,
      conflicts: {
        reference: await conflict(project, { ...checked.source, mode: 'reference' }),
        inbound: await conflict(project, { ...checked.source, mode: 'inbound' }),
      },
    };
  });

  app.post<{ Params: Params }>(base, async (request, reply) => {
    const { user, project } = await manager(request, request.params.projectId);
    const input = target
      .extend({ mode, isDefault: z.boolean().optional() })
      .strict()
      .safeParse(request.body);
    if (!input.success) ctx.fail(400, 'Choose a Git connection, an owner/repository, and a mode.');
    const checked = await inspect(user, input.data.connectionId, input.data.repository);
    if (input.data.mode === 'inbound' && !checked.access.issues)
      ctx.fail(
        400,
        `This connection cannot read issues in ${checked.source.repository}. Attach it as Reference, or grant the credential issue read access.`,
      );
    const now = ctx.now();
    const created: RepositoryAttachment = {
      id: ctx.id(),
      ...checked.source,
      name: checked.source.repository,
      projectId: project.id,
      creatorId: user.id,
      connectionId: checked.connection.id,
      createdAt: now,
      updatedAt: now,
      lastSyncedAt: null,
      lastError: null,
      lastErrorAt: null,
      mode: input.data.mode,
      isDefault: false,
      remoteId: checked.remoteId,
      access: checked.access,
    };
    await ctx.db.transaction(async (db) => {
      const store = makeStore(db);
      await db.query(
        "SELECT id FROM entities WHERE collection='system' AND id='mutation-lock' FOR UPDATE",
      );
      const current = await store.get<GitConnection>('gitConnections', checked.connection.id);
      if (!current) ctx.fail(404, 'Git connection not found.');
      if (!(await canManageRepositories(ctx, user, project.id, store)))
        ctx.fail(
          403,
          'Only the project owner or a workspace administrator can manage repositories.',
        );
      const blocked = await conflict(project, { ...created, mode: input.data.mode }, store);
      if (blocked) ctx.fail(409, blocked);
      const siblings = await projectAttachments(store, project.id);
      created.isDefault = !siblings.length || !!input.data.isDefault;
      if (created.isDefault)
        for (const sibling of siblings.filter((s) => s.isDefault))
          await store.put('integrations', { ...sibling, isDefault: false });
      await store.put('integrations', created);
    });
    reply.code(201);
    return present(user, created);
  });

  app.patch<{ Params: AttachmentParams }>(`${base}/:id`, async (request) => {
    const { user, project } = await manager(request, request.params.projectId);
    const input = z
      .object({ mode: mode.optional(), isDefault: z.literal(true).optional() })
      .strict()
      .safeParse(request.body);
    if (!input.success) ctx.fail(400, 'Choose a repository mode, or make it the default.');
    const existing = await attachment(project.id, request.params.id);
    const nextMode = input.data.mode ?? modeOf(existing);
    if (nextMode !== modeOf(existing) && engine.syncing(existing.id))
      ctx.fail(409, 'Wait for the running synchronization before changing the repository mode.');
    let access = existing.access;
    if (nextMode === 'inbound' && !mirrors(modeOf(existing))) {
      if (!existing.connectionId)
        ctx.fail(409, 'Attach this repository again with a saved connection.');
      const checked = await inspect(user, existing.connectionId, existing.repository);
      if (!checked.access.issues)
        ctx.fail(
          400,
          `This connection cannot read issues in ${existing.repository}. Grant the credential issue read access first.`,
        );
      access = checked.access;
    }
    const saved = await ctx.db.transaction(async (db) => {
      const store = makeStore(db);
      await db.query(
        "SELECT id FROM entities WHERE collection='system' AND id='mutation-lock' FOR UPDATE",
      );
      const current = await store.get<RepositoryAttachment>('integrations', existing.id);
      if (!current || current.projectId !== project.id) ctx.fail(404, 'Repository not found.');
      const next: RepositoryAttachment = {
        ...current,
        mode: nextMode,
        ...(access ? { access } : {}),
        updatedAt: ctx.now(),
      };
      // Leaving two-way withdraws consent; enabling it again needs a new preview.
      if (nextMode !== 'two_way') {
        delete next.publish;
        delete next.twoWay;
      }
      if (nextMode !== modeOf(current)) {
        const blocked = await conflict(project, { ...next, mode: nextMode }, store);
        if (blocked) ctx.fail(409, blocked);
        // Imported items stop following the repository, exactly as when it is detached.
        if (nextMode === 'reference') await disconnectItems(store, new Set([current.id]));
      }
      if (input.data.isDefault) {
        for (const sibling of await projectAttachments(store, project.id))
          if (sibling.id !== current.id && sibling.isDefault)
            await store.put('integrations', { ...sibling, isDefault: false });
        next.isDefault = true;
      }
      await store.put('integrations', next);
      return next;
    });
    return present(user, saved);
  });

  app.delete<{ Params: AttachmentParams }>(`${base}/:id`, async (request, reply) => {
    const { project } = await manager(request, request.params.projectId);
    const existing = await attachment(project.id, request.params.id);
    if (engine.syncing(existing.id))
      ctx.fail(409, 'Wait for the running synchronization before detaching this repository.');
    await ctx.db.transaction(async (db) => {
      const store = makeStore(db);
      await db.query(
        "SELECT id FROM entities WHERE collection='system' AND id='mutation-lock' FOR UPDATE",
      );
      await detachAttachments(store, [existing.id]);
      await ensureDefault(store, project.id);
    });
    return reply.code(204).send();
  });

  /** Two-way consent is a person's decision: browser sessions only, never API tokens. */
  async function previewTwoWay(request: FastifyRequest<{ Params: AttachmentParams }>) {
    const { user, project } = await manager(request, request.params.projectId);
    if (request.tokenScope) ctx.fail(403, 'Enable two-way sync from a signed-in browser session.');
    const body = (request.body ?? {}) as { publish?: unknown };
    const publish = publication.safeParse(body.publish);
    if (!publish.success || !outboundFields.some((field) => publish.data[field]))
      ctx.fail(400, 'Choose at least one field to publish: replies, status or assignee.');
    const existing = await attachment(project.id, request.params.id);
    if (!existing.connectionId)
      ctx.fail(409, 'Attach this repository again with a saved connection.');
    const checked = await inspect(user, existing.connectionId, existing.repository);
    if (!checked.access.write || readOnlyConnection(checked.connection))
      ctx.fail(400, `Two-way sync is unavailable. ${checked.access.reason}`);
    if (!checked.access.issues)
      ctx.fail(400, `This connection cannot read issues in ${existing.repository}.`);
    return {
      user,
      project,
      existing,
      checked,
      publish: publish.data,
      preview: twoWayPreview(existing, checked.connection, checked.access, publish.data, user.id),
    };
  }

  app.post<{ Params: AttachmentParams }>(
    `${base}/:id/two-way/preview`,
    async (request) => (await previewTwoWay(request)).preview,
  );

  app.post<{ Params: AttachmentParams }>(`${base}/:id/two-way`, async (request) => {
    const confirmation = z
      .object({ confirmation: z.string().min(1).max(200) })
      .safeParse(request.body ?? {});
    if (!confirmation.success) ctx.fail(400, 'Review the two-way preview and confirm it.');
    const { user, project, existing, checked, publish, preview } = await previewTwoWay(request);
    if (preview.confirmation !== confirmation.data.confirmation)
      ctx.fail(409, 'What two-way sync would publish has changed. Review the preview again.');
    if (engine.syncing(existing.id))
      ctx.fail(409, 'Wait for the running synchronization before changing the repository mode.');
    const saved = await ctx.db.transaction(async (db) => {
      const store = makeStore(db);
      await db.query(
        "SELECT id FROM entities WHERE collection='system' AND id='mutation-lock' FOR UPDATE",
      );
      const current = await store.get<RepositoryAttachment>('integrations', existing.id);
      if (!current || current.projectId !== project.id) ctx.fail(404, 'Repository not found.');
      if (!(await canManageRepositories(ctx, user, project.id, store)))
        ctx.fail(
          403,
          'Only the project owner or a workspace administrator can manage repositories.',
        );
      if (current.connectionId !== checked.connection.id)
        ctx.fail(409, 'The repository connection changed. Review the preview again.');
      const blocked = await conflict(project, { ...current, mode: 'two_way' }, store);
      if (blocked) ctx.fail(409, blocked);
      const now = ctx.now();
      const next: RepositoryAttachment = {
        ...current,
        mode: 'two_way',
        access: checked.access,
        publish,
        twoWay: { activatedAt: now, activatedBy: user.id },
        updatedAt: now,
      };
      await store.put('integrations', next);
      return next;
    });
    return present(user, saved);
  });

  app.post<{ Params: AttachmentParams }>(`${base}/:id/sync`, async (request) => {
    const { user, project } = await manager(request, request.params.projectId, true);
    const result = await engine.sync(await attachment(project.id, request.params.id));
    return {
      imported: result.imported,
      updated: result.updated,
      comments: result.comments,
      repository: await present(user, await attachment(project.id, request.params.id)),
    };
  });
}
