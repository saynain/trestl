import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from './context.ts';
import type { Database, Store } from './db.ts';
import type { CanvasCollection, ProjectCanvas, User } from '../shared/types.ts';
import { sameWorkspace, workspaceOf } from './workspaces.ts';

export const canvasBodyLimit = 8 * 1024 * 1024;
export const canvasElement = z
  .object({
    id: z.string().min(1).max(200),
    link: z
      .string()
      .max(2048)
      .nullable()
      .optional()
      .refine((value) => {
        if (!value) return true;
        try {
          return ['http:', 'https:', 'mailto:'].includes(
            new URL(value, 'https://trestl.invalid/').protocol,
          );
        } catch {
          return false;
        }
      }, 'Use a web, email, or relative link'),
    type: z.enum([
      'rectangle',
      'diamond',
      'ellipse',
      'line',
      'arrow',
      'text',
      'image',
      'freedraw',
      'frame',
      'magicframe',
      'selection',
    ]),
    x: z.number(),
    y: z.number(),
    width: z.number().nonnegative(),
    height: z.number().nonnegative(),
  })
  .passthrough();
export const canvasFile = z
  .object({
    id: z.string().min(1).max(200),
    mimeType: z.enum(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml']),
    dataURL: z
      .string()
      .regex(/^data:image\/(png|jpeg|gif|webp|svg\+xml);base64,[A-Za-z0-9+/=\r\n]+$/),
    created: z.number(),
    lastRetrieved: z.number().optional(),
    version: z.number().optional(),
  })
  .strict()
  .refine(
    (f) => f.dataURL.startsWith(`data:${f.mimeType};base64,`),
    'Image type does not match its data',
  );
export const canvasScene = z
  .object({
    elements: z
      .array(canvasElement)
      .max(20000)
      .refine(
        (elements) => new Set(elements.map((e) => e.id)).size === elements.length,
        'Duplicate element IDs',
      ),
    appState: z
      .object({
        viewBackgroundColor: z.string().max(100).optional(),
        gridSize: z.number().positive().nullable().optional(),
      })
      .strict(),
    files: z
      .record(z.string().max(200), canvasFile)
      .refine(
        (files) => Object.entries(files).every(([key, value]) => key === value.id),
        'Image IDs must match',
      ),
  })
  .strict()
  .refine(
    (scene) =>
      scene.elements.every(
        (e) =>
          e.type !== 'image' ||
          e.isDeleted ||
          (typeof e.fileId === 'string' && Object.hasOwn(scene.files, e.fileId)),
      ),
    'An image is missing its file',
  );
const title = z.string().trim().min(1).max(240);
const collectionId = z.string().uuid().nullable();
const create = z
  .object({ title, scene: canvasScene.optional(), collectionId: collectionId.optional() })
  .strict();
const revision = z.number().int().nonnegative().max(2147483646);
const update = z
  .object({
    title: title.optional(),
    scene: canvasScene.optional(),
    collectionId: collectionId.optional(),
    expectedRevision: revision,
  })
  .strict()
  .refine(
    (v) => v.title !== undefined || v.scene !== undefined || v.collectionId !== undefined,
    'Provide a title, scene, or collection',
  );

export function registerCanvases(
  app: FastifyInstance,
  ctx: AppContext,
  mutate: <T>(fn: (store: Store, tx: Database) => Promise<T>) => Promise<T>,
) {
  const checked = async (store: Store, user: User, projectId: string, canvasId?: string) => {
    if (!(await ctx.canProject(user, projectId, store))) ctx.fail(404, 'Project not found');
    if (!canvasId) return;
    const canvas = await store.get<ProjectCanvas>('canvases', canvasId);
    if (!canvas || canvas.projectId !== projectId || !sameWorkspace(user, canvas))
      ctx.fail(404, 'Canvas not found');
    return canvas!;
  };
  type Params = { projectId: string; canvasId: string };
  const checkedCollection = async (store: Store, user: User, projectId: string, id: string) => {
    await checked(store, user, projectId);
    const collection = await store.get<CanvasCollection>('canvasCollections', id);
    if (!collection || collection.projectId !== projectId || !sameWorkspace(user, collection))
      ctx.fail(404, 'Collection not found');
    return collection!;
  };
  const listCollections = async (projectId: string, user: User, db = ctx.db) => {
    const result = await db.query<{ data: CanvasCollection }>(
      "SELECT data FROM entities WHERE collection='canvasCollections' AND data->>'projectId'=$1 ORDER BY lower(data->>'name'), id",
      [projectId],
    );
    return result.rows.map((row) => row.data).filter((c) => sameWorkspace(user, c));
  };
  const uniqueName = async (
    db: Database,
    projectId: string,
    user: User,
    name: string,
    id?: string,
  ) => {
    if (
      (await listCollections(projectId, user, db)).some(
        (c) => c.id !== id && c.name.toLowerCase() === name.toLowerCase(),
      )
    )
      ctx.fail(409, 'A collection with that name already exists.');
  };
  const collectionName = z.string().trim().min(1).max(100);
  const collectionBase = '/api/v1/projects/:projectId/canvas-collections';
  type CollectionParams = { projectId: string; collectionId: string };
  app.get<{ Params: CollectionParams }>(collectionBase, async (request) => {
    const user = ctx.requireUser(request);
    await checked(ctx.store, user, request.params.projectId);
    return { data: await listCollections(request.params.projectId, user) };
  });
  app.post<{ Params: CollectionParams }>(collectionBase, async (request, reply) => {
    const user = ctx.requireUser(request),
      input = z.object({ name: collectionName }).strict().parse(request.body);
    const result = await mutate(async (store, tx) => {
      await checked(store, user, request.params.projectId);
      await uniqueName(tx, request.params.projectId, user, input.name);
      return store.put<CanvasCollection>('canvasCollections', {
        id: ctx.id(),
        projectId: request.params.projectId,
        workspaceId: workspaceOf(user),
        name: input.name,
        revision: 1,
        createdAt: ctx.now(),
        updatedAt: ctx.now(),
      });
    });
    return reply.code(201).send(result);
  });
  app.patch<{ Params: CollectionParams }>(`${collectionBase}/:collectionId`, async (request) => {
    const user = ctx.requireUser(request),
      input = z
        .object({ name: collectionName, expectedRevision: revision })
        .strict()
        .parse(request.body);
    return mutate(async (store, tx) => {
      const collection = await checkedCollection(
        store,
        user,
        request.params.projectId,
        request.params.collectionId,
      );
      if (collection.revision !== input.expectedRevision)
        ctx.fail(409, 'This collection changed elsewhere. Refresh and try again.');
      await uniqueName(tx, request.params.projectId, user, input.name, collection.id);
      return store.put('canvasCollections', {
        ...collection,
        name: input.name,
        revision: collection.revision + 1,
        updatedAt: ctx.now(),
      });
    });
  });
  app.delete<{ Params: CollectionParams }>(
    `${collectionBase}/:collectionId`,
    async (request, reply) => {
      const user = ctx.requireUser(request),
        input = z.object({ expectedRevision: revision }).strict().parse(request.body);
      await mutate(async (store, tx) => {
        const collection = await checkedCollection(
          store,
          user,
          request.params.projectId,
          request.params.collectionId,
        );
        if (collection.revision !== input.expectedRevision)
          ctx.fail(409, 'This collection changed elsewhere. Refresh and try again.');
        const members = await tx.query<{ id: string }>(
          "SELECT id FROM entities WHERE collection='canvases' AND data->>'projectId'=$1 AND data->>'collectionId'=$2",
          [collection.projectId, collection.id],
        );
        for (const { id } of members.rows) {
          const canvas = (await checked(store, user, collection.projectId, id))!;
          await store.put('canvases', {
            ...canvas,
            collectionId: null,
            revision: canvas.revision + 1,
            updatedBy: user.id,
            updatedAt: ctx.now(),
          });
        }
        await store.remove('canvasCollections', collection.id);
      });
      return reply.code(204).send();
    },
  );
  const base = '/api/v1/projects/:projectId/canvases';
  app.get<{ Params: Params }>(base, async (request) => {
    const user = ctx.requireUser(request);
    await checked(ctx.store, user, request.params.projectId);
    // Project-filtered metadata only: never load every canvas scene into bootstrap or lists.
    const result = await ctx.db.query<{ data: Omit<ProjectCanvas, 'scene'> }>(
      "SELECT data - 'scene' AS data FROM entities WHERE collection='canvases' AND data->>'projectId'=$1 ORDER BY data->>'updatedAt' DESC, id",
      [request.params.projectId],
    );
    return { data: result.rows.map((row) => row.data).filter((c) => sameWorkspace(user, c)) };
  });
  app.post<{ Params: Params }>(base, { bodyLimit: canvasBodyLimit }, async (request, reply) => {
    const user = ctx.requireUser(request),
      input = create.parse(request.body);
    const canvas = await mutate(async (store, tx) => {
      await checked(store, user, request.params.projectId);
      if (input.collectionId)
        await checkedCollection(store, user, request.params.projectId, input.collectionId);
      return store.put<ProjectCanvas>('canvases', {
        id: ctx.id(),
        projectId: request.params.projectId,
        workspaceId: workspaceOf(user),
        title: input.title,
        collectionId: input.collectionId ?? null,
        scene: input.scene ?? { elements: [], appState: {}, files: {} },
        revision: 1,
        createdBy: user.id,
        updatedBy: user.id,
        createdAt: ctx.now(),
        updatedAt: ctx.now(),
      });
    });
    return reply.code(201).send(canvas);
  });
  app.get<{ Params: Params }>(`${base}/:canvasId`, async (request) =>
    checked(ctx.store, ctx.requireUser(request), request.params.projectId, request.params.canvasId),
  );
  app.patch<{ Params: Params }>(
    `${base}/:canvasId`,
    { bodyLimit: canvasBodyLimit },
    async (request) => {
      const user = ctx.requireUser(request),
        input = update.parse(request.body);
      return mutate(async (store, tx) => {
        const canvas = (await checked(
          store,
          user,
          request.params.projectId,
          request.params.canvasId,
        ))!;
        if (canvas.revision !== input.expectedRevision)
          ctx.fail(
            409,
            'This canvas changed elsewhere. Save your work as a copy or reload the latest version.',
          );
        if (input.collectionId)
          await checkedCollection(store, user, request.params.projectId, input.collectionId);
        return store.put('canvases', {
          ...canvas,
          title: input.title ?? canvas.title,
          scene: input.scene ?? canvas.scene,
          collectionId:
            input.collectionId === undefined ? (canvas.collectionId ?? null) : input.collectionId,
          revision: canvas.revision + 1,
          updatedBy: user.id,
          updatedAt: ctx.now(),
        });
      });
    },
  );
  app.delete<{ Params: Params }>(`${base}/:canvasId`, async (request, reply) => {
    const user = ctx.requireUser(request);
    const input = z.object({ expectedRevision: revision }).strict().parse(request.body);
    await mutate(async (store, tx) => {
      const canvas = (await checked(
        store,
        user,
        request.params.projectId,
        request.params.canvasId,
      ))!;
      if (canvas.revision !== input.expectedRevision)
        ctx.fail(409, 'This canvas changed elsewhere. Reload before deleting it.');
      await store.remove('canvases', canvas.id);
    });
    return reply.code(204).send();
  });
}
