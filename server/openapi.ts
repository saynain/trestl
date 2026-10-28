import { z } from 'zod';
import { projectPackage, importOptions } from './project-transfer-schema.ts';

const string = { type: 'string' };
const importedFrom = {
  type: 'object',
  readOnly: true,
  description: 'Provenance from a project file, not a verified local author identity.',
  properties: { authorName: string, identifier: string },
  required: ['authorName'],
};
const nullableString = { type: ['string', 'null'] };
const date = { type: ['string', 'null'], format: 'date' };
const uuid = { type: 'string', format: 'uuid' };
const visibility = { type: 'string', enum: ['workspace', 'private'] };
const status = {
  type: 'string',
  enum: ['backlog', 'todo', 'in_progress', 'in_review', 'done', 'canceled'],
};
const priority = { type: 'string', enum: ['none', 'low', 'medium', 'high', 'urgent'] };
const itemType = { type: 'string', enum: ['task', 'bug', 'idea', 'followup'] };
const schemas: Record<string, unknown> = {
  Error: {
    type: 'object',
    required: ['error', 'message'],
    properties: { error: string, message: string },
  },
  User: {
    type: 'object',
    properties: {
      id: uuid,
      workspaceId: { ...string, readOnly: true },
      name: string,
      email: { type: 'string', format: 'email' },
      disabledAt: { ...string, readOnly: true },
      color: string,
      role: { type: 'string', enum: ['admin', 'member'] },
    },
  },
  RoadmapFeature: {
    type: 'object',
    additionalProperties: false,
    required: [
      'id',
      'title',
      'summary',
      'area',
      'horizon',
      'status',
      'scope',
      'rationale',
      'targetDate',
    ],
    properties: {
      id: uuid,
      title: { ...string, minLength: 1, maxLength: 120 },
      summary: { ...string, maxLength: 240 },
      area: { ...string, maxLength: 60 },
      horizon: { type: 'string', enum: ['current', 'next', 'future', 'deferred'] },
      status: { ...string, maxLength: 80 },
      scope: { ...string, maxLength: 10000 },
      rationale: { ...string, maxLength: 500 },
      targetDate: date,
      projectIds: { type: 'array', items: uuid, maxItems: 100, uniqueItems: true },
      milestoneIds: { type: 'array', items: uuid, maxItems: 100, uniqueItems: true },
      itemIds: { type: 'array', items: uuid, maxItems: 100, uniqueItems: true },
    },
  },
  Roadmap: {
    type: 'object',
    properties: {
      revision: { type: 'integer', minimum: 0 },
      headline: { ...string, maxLength: 240 },
      reviewNote: { ...string, maxLength: 500 },
      reviewedAt: date,
      features: {
        type: 'array',
        maxItems: 100,
        items: { $ref: '#/components/schemas/RoadmapFeature' },
      },
    },
  },
  Project: {
    type: 'object',
    properties: {
      creationActorId: {
        ...nullableString,
        readOnly: true,
        description:
          'Immutable verified local creation actor; absent/null creation is not attributed.',
      },
      id: uuid,
      workspaceId: { ...string, readOnly: true },
      roadmap: { $ref: '#/components/schemas/Roadmap', readOnly: true },
      key: string,
      name: string,
      description: string,
      color: string,
      icon: string,
      parentId: nullableString,
      lifecycle: { type: 'string', enum: ['ongoing', 'fixed'] },
      status: { type: 'string', enum: ['active', 'planned', 'completed', 'archived'] },
      startDate: date,
      dueDate: date,
      visibility,
      ownerId: uuid,
      memberIds: {
        type: 'array',
        items: uuid,
        maxItems: 1000,
        description:
          'Additional workspace members with access to a private project. Only the owner can change membership. Parent project restrictions and individually private items still apply. Missing means no additional members.',
      },
      createdAt: { type: 'string', format: 'date-time' },
    },
  },
  IssueSource: {
    type: 'object',
    description:
      'Read-only origin metadata. Repository state is independent of local planning status; metadata remains after disconnection.',
    properties: {
      provider: { type: 'string', enum: ['github', 'gitea'] },
      integrationId: string,
      repository: string,
      number: { type: 'integer' },
      url: { type: 'string', format: 'uri' },
      state: { type: 'string', enum: ['open', 'closed'] },
      lastSyncedAt: nullableString,
      connected: { type: 'boolean' },
    },
  },
  WorkItem: {
    type: 'object',
    properties: {
      importedFrom,
      revision: {
        type: 'integer',
        minimum: 0,
        readOnly: true,
        description: 'Monotonic revision. Older records without this field have revision 0.',
      },
      creationActorId: {
        ...nullableString,
        readOnly: true,
        description:
          'Immutable verified local creation actor; automatic, imported, or unrecorded creation is not attributed.',
      },
      id: uuid,
      workspaceId: { ...string, readOnly: true },
      identifier: string,
      title: string,
      description: string,
      projectId: nullableString,
      milestoneId: {
        ...nullableString,
        description:
          'Milestone in the item’s project. Moving projects clears this unless explicitly supplied.',
      },
      parentId: nullableString,
      type: itemType,
      status,
      priority,
      assigneeId: nullableString,
      startDate: date,
      dueDate: date,
      followUpDate: date,
      recurrence: { type: ['string', 'null'], enum: ['daily', 'weekly', 'monthly', null] },
      labels: { type: 'array', items: string },
      visibility,
      creatorId: uuid,
      createdAt: string,
      updatedAt: string,
      completedAt: nullableString,
      position: { type: 'number' },
      externalUrl: nullableString,
      source: { $ref: '#/components/schemas/IssueSource', readOnly: true },
    },
  },
  Activity: {
    type: 'object',
    properties: {
      importedFrom,
      id: uuid,
      itemId: uuid,
      userId: uuid,
      kind: { type: 'string', enum: ['comment', 'event'] },
      source: {
        type: 'object',
        readOnly: true,
        description:
          'Present only for imported repository comments; body contains the original Markdown.',
        properties: { provider: { type: 'string', enum: ['github', 'gitea'] }, author: string },
      },
      body: string,
      createdAt: string,
    },
  },
  Relation: {
    type: 'object',
    properties: {
      id: uuid,
      itemId: uuid,
      targetId: uuid,
      kind: { type: 'string', enum: ['blocks', 'related'] },
    },
  },
  ResourceLink: {
    type: 'object',
    properties: {
      id: uuid,
      projectId: nullableString,
      itemId: nullableString,
      title: string,
      url: { type: 'string', format: 'uri' },
      kind: { type: 'string', enum: ['confluence', 'repository', 'link'] },
    },
  },
  SavedView: {
    type: 'object',
    properties: {
      workspaceId: { ...string, readOnly: true },
      id: uuid,
      userId: uuid,
      name: string,
      icon: string,
      filters: { type: 'object', additionalProperties: string },
      layout: { type: 'string', enum: ['list', 'board'] },
    },
  },
  Milestone: {
    type: 'object',
    properties: {
      itemIds: { type: 'array', items: uuid, readOnly: true },
      progress: {
        type: 'object',
        readOnly: true,
        description: 'Counts visible linked items; only done counts as completed.',
        properties: { total: { type: 'integer' }, done: { type: 'integer' } },
      },
      revision: { type: 'integer', minimum: 0, readOnly: true },
      id: uuid,
      projectId: uuid,
      title: string,
      dueDate: date,
      completed: { type: 'boolean' },
    },
  },
};
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const list = (name: string) => ({
  type: 'object',
  properties: { data: { type: 'array', items: ref(name) }, nextCursor: string },
});
schemas.RelationDetail = {
  allOf: [
    ref('Relation'),
    {
      type: 'object',
      required: ['direction', 'relatedItem'],
      properties: {
        direction: {
          type: 'string',
          enum: ['outgoing', 'incoming'],
          description:
            'Relative to the requested item. A blocks relation points from itemId to targetId.',
        },
        relatedItem: {
          type: 'object',
          required: ['id', 'identifier', 'title'],
          properties: { id: uuid, identifier: string, title: string },
        },
      },
    },
  ],
};
schemas.ProjectRelation = {
  type: 'object',
  properties: { id: uuid, itemId: uuid, projectId: uuid },
};
schemas.ItemDetail = {
  type: 'object',
  properties: {
    item: ref('WorkItem'),
    activity: { type: 'array', items: ref('Activity') },
    relations: { type: 'array', items: ref('Relation') },
    projectRelations: { type: 'array', items: ref('ProjectRelation') },
    links: { type: 'array', items: ref('ResourceLink') },
  },
};
schemas.ActivityHeatmap = {
  type: 'object',
  required: ['year', 'days', 'total'],
  properties: {
    year: { type: 'integer', minimum: 1970 },
    total: { type: 'integer', minimum: 0 },
    days: {
      type: 'array',
      minItems: 365,
      maxItems: 366,
      items: {
        type: 'object',
        required: ['date', 'count'],
        properties: {
          date: { type: 'string', format: 'date' },
          count: { type: 'integer', minimum: 0 },
        },
      },
    },
  },
};
schemas.ProjectUpdate = {
  type: 'object',
  required: ['id', 'projectId', 'authorId', 'health', 'body', 'createdAt'],
  properties: {
    importedFrom: {
      type: 'object',
      readOnly: true,
      description: 'Original author name from an imported file; not a verified local identity.',
      properties: { authorName: string },
      required: ['authorName'],
    },
    sortKey: { ...uuid, readOnly: true },
    id: uuid,
    projectId: uuid,
    authorId: uuid,
    health: { type: 'string', enum: ['on_track', 'at_risk', 'off_track'] },
    body: { type: 'string', minLength: 1, maxLength: 20000 },
    createdAt: { type: 'string', format: 'date-time' },
  },
};
schemas.MentionNotification = {
  type: 'object',
  properties: {
    id: uuid,
    workspaceId: uuid,
    recipientId: uuid,
    actorId: uuid,
    itemId: uuid,
    activityId: { ...uuid, nullable: true },
    kind: { type: 'string', enum: ['mention'] },
    createdAt: { type: 'string', format: 'date-time' },
    readAt: { type: 'string', format: 'date-time', nullable: true },
  },
};
schemas.Bootstrap = {
  type: 'object',
  properties: {
    notifications: { type: 'array', items: ref('MentionNotification') },
    authMode: { type: 'string', enum: ['local', 'google', 'oidc', 'proxy'] },
    workspace: ref('Workspace'),
    workspaces: { type: 'array', items: ref('Workspace') },
    user: ref('User'),
    users: { type: 'array', items: ref('User') },
    projects: { type: 'array', items: ref('Project') },
    projectUpdates: { type: 'array', items: ref('ProjectUpdate') },
    items: { type: 'array', items: ref('WorkItem') },
    views: { type: 'array', items: ref('SavedView') },
    links: { type: 'array', items: ref('ResourceLink') },
    milestones: { type: 'array', items: ref('Milestone') },
    relations: { type: 'array', items: ref('Relation') },
    projectRelations: { type: 'array', items: ref('ProjectRelation') },
  },
};
const object = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});
schemas.Workspace = object({
  id: string,
  name: string,
  kind: { type: 'string', enum: ['personal', 'shared'] },
  ownerId: uuid,
  createdAt: string,
  role: { type: 'string', enum: ['admin', 'member'] },
});
function writable(name: string, omit: string[], required: string[] = []) {
  const schema = schemas[name] as { properties: Record<string, unknown> };
  return object(
    Object.fromEntries(Object.entries(schema.properties).filter(([key]) => !omit.includes(key))),
    required,
  );
}
const errorResponses = Object.fromEntries(
  [400, 401, 403, 404, 409, 429].map((code) => [
    code,
    {
      description: {
        400: 'Invalid request',
        401: 'Authentication required',
        403: 'Access denied',
        404: 'Not found or not visible',
        409: 'Conflict',
        429: 'Rate limited',
      }[code],
      content: { 'application/json': { schema: ref('Error') } },
    },
  ]),
);
const paths: Record<string, Record<string, unknown>> = {};
function operation(
  path: string,
  method: string,
  summary: string,
  response: unknown,
  body?: unknown,
  options: {
    public?: boolean;
    browserOnly?: boolean;
    created?: boolean;
    noContent?: boolean;
    optionalBody?: boolean;
    notModified?: boolean;
    parameters?: unknown[];
    description?: string;
  } = {},
) {
  const params = [
    ...Array.from(path.matchAll(/\{([^}]+)\}/g)).map((match) => ({
      name: match[1],
      in: 'path',
      required: true,
      schema: string,
    })),
    ...(options.parameters ?? []),
  ];
  const code = options.noContent ? '204' : options.created ? '201' : '200';
  const revisionBody = body as
    { properties?: { expectedRevision?: unknown }; required?: string[] } | undefined;
  const revisionDescription = revisionBody?.properties?.expectedRevision
    ? `${revisionBody.required?.includes('expectedRevision') ? 'Required' : 'Optional'} expectedRevision compares the submitted revision with the current resource revision${path.endsWith('/roadmap') ? ' (roadmap.revision)' : ''}. Read the resource first and send its revision; a stale revision returns 409 without applying changes. After a conflict, read the resource again before retrying.${method === 'delete' ? '' : ' Successful updates return the new revision in the updated resource.'}${revisionBody.required?.includes('expectedRevision') ? '' : ' Omit expectedRevision only when applying the operation regardless of the current revision is intended.'}`
    : undefined;
  (paths[path] ??= {})[method] = {
    summary,
    ...((options.description || revisionDescription) && {
      description: [options.description, revisionDescription].filter(Boolean).join(' '),
    }),
    operationId: `${method}${path.replace(/[^a-zA-Z]/g, '_')}`,
    security: options.public
      ? []
      : options.browserOnly
        ? [{ cookieAuth: [] }]
        : [{ bearerAuth: [] }, { cookieAuth: [] }],
    ...(params.length ? { parameters: params } : {}),
    ...(body
      ? {
          requestBody: {
            required: !options.optionalBody,
            content: { 'application/json': { schema: body } },
          },
        }
      : {}),
    responses: {
      [code]: {
        description: 'Success',
        ...(options.notModified
          ? {
              headers: {
                ETag: {
                  schema: string,
                  description: 'Opaque bootstrap revision for a subsequent conditional read.',
                },
              },
            }
          : {}),
        ...(!options.noContent ? { content: { 'application/json': { schema: response } } } : {}),
      },
      ...(options.notModified
        ? {
            304: {
              description: 'Authenticated data is unchanged; no response body.',
              headers: { ETag: { schema: string } },
            },
          }
        : {}),
      ...errorResponses,
    },
  };
}
operation(
  '/auth/status',
  'get',
  'Check setup and session status',
  object({
    needsSetup: { type: 'boolean' },
    authenticated: { type: 'boolean' },
    authMode: { type: 'string', enum: ['local', 'google', 'oidc', 'proxy'] },
    user: ref('User'),
  }),
  undefined,
  { public: true },
);
const credentialFields = {
  name: string,
  email: { type: 'string', format: 'email' },
  password: { type: 'string', minLength: 10, maxLength: 200 },
};
operation(
  '/auth/setup',
  'post',
  'Initialize the named installation and its password-protected administrator',
  ref('User'),
  object(
    {
      ...credentialFields,
      seedDemo: { type: 'boolean', default: false },
      installationName: { ...string, minLength: 1, maxLength: 80, default: 'Trestl' },
    },
    ['name', 'email', 'password'],
  ),
  { public: true, created: true },
);
operation(
  '/auth/login',
  'post',
  'Sign in and set an HTTP-only session cookie',
  ref('User'),
  object({ email: string, password: string }, ['email', 'password']),
  { public: true },
);
operation(
  '/workspaces',
  'get',
  'Get the current installation (legacy endpoint name)',
  list('Workspace'),
);
operation(
  '/workspaces/current',
  'patch',
  'Rename the current shared workspace (admin only)',
  ref('Workspace'),
  object({ name: { ...string, minLength: 1, maxLength: 80 } }, ['name']),
  { browserOnly: true },
);
operation(
  '/workspaces/current/members/{userId}',
  'patch',
  'Change a member role; the owner remains an admin',
  object({ id: string, workspaceId: string, userId: uuid, role: string }),
  object({ role: { type: 'string', enum: ['admin', 'member'] } }, ['role']),
  { browserOnly: true },
);
operation(
  '/auth/account',
  'patch',
  'Update your account; email/password changes require the current password',
  ref('User'),
  object({
    name: string,
    email: { type: 'string', format: 'email' },
    currentPassword: string,
    password: { type: 'string', minLength: 10, maxLength: 200 },
  }),
);
operation(
  '/auth/logout',
  'post',
  'Invalidate the session cookie',
  object({ ok: { type: 'boolean' } }),
);
operation(
  '/bootstrap',
  'get',
  'Load accessible planning data; send the returned ETag as If-None-Match for a bodyless 304 when unchanged',
  ref('Bootstrap'),
  undefined,
  {
    notModified: true,
    parameters: [{ name: 'If-None-Match', in: 'header', required: false, schema: string }],
  },
);
operation(
  '/activity/heatmap',
  'get',
  'Count visible local activity by UTC calendar day',
  ref('ActivityHeatmap'),
  undefined,
  {
    description:
      'Counts project/work item creation with an explicitly recorded immutable local actor, internal item comments/events, and project updates attributed to verified workspace users. Older creation actors are not reconstructed. Automatic recurring creation is excluded. Imported/source actions and future timestamps are excluded. Project scope includes accessible descendants and explicitly linked visible work. User and project filters intersect; with neither filter, the current user is selected. Every date in the requested year is returned, including zero-count future days. Hidden and unknown project/user IDs return 404.',
    parameters: [
      { name: 'projectId', in: 'query', required: false, schema: uuid },
      { name: 'userId', in: 'query', required: false, schema: uuid },
      {
        name: 'year',
        in: 'query',
        required: false,
        schema: {
          type: 'integer',
          minimum: 1970,
          description: 'Defaults to the current UTC year; future years are invalid.',
        },
      },
    ],
  },
);
operation(
  '/projects/{id}/roadmap',
  'patch',
  'Replace a project roadmap; stale revisions return 409',
  ref('Project'),
  {
    type: 'object',
    additionalProperties: false,
    required: ['expectedRevision', 'headline', 'reviewNote', 'reviewedAt', 'features'],
    properties: {
      expectedRevision: { type: 'integer', minimum: 0 },
      headline: { ...string, maxLength: 240 },
      reviewNote: { ...string, maxLength: 500 },
      reviewedAt: date,
      features: { type: 'array', maxItems: 100, items: ref('RoadmapFeature') },
    },
  },
);
operation(
  '/projects/{id}/updates',
  'get',
  'Read project health updates, newest first; requires project access',
  object({ data: { type: 'array', items: ref('ProjectUpdate') } }),
);
operation(
  '/projects/{id}/updates',
  'post',
  'Post a health update as the signed-in user; requires project access',
  ref('ProjectUpdate'),
  object(
    {
      health: { type: 'string', enum: ['on_track', 'at_risk', 'off_track'] },
      body: { type: 'string', minLength: 1, maxLength: 20000 },
    },
    ['health', 'body'],
  ),
  { created: true },
);
const idempotencyParameter = {
  name: 'Idempotency-Key',
  in: 'header',
  required: false,
  schema: { type: 'string', pattern: '^[A-Za-z0-9._:-]{1,128}$' },
  description:
    'Reuse for retries of the same request. Scoped to user and operation; different input returns 409. Records persist with the database. Replay requires current access to the original item.',
};
const resources = [
  [
    'projects',
    'Project',
    ['id', 'ownerId', 'creationActorId', 'createdAt', 'roadmap'],
    ['key', 'name'],
  ],
  [
    'items',
    'WorkItem',
    [
      'id',
      'identifier',
      'creatorId',
      'creationActorId',
      'createdAt',
      'updatedAt',
      'completedAt',
      'source',
      'revision',
    ],
    ['title'],
  ],
  ['views', 'SavedView', ['id', 'userId', 'workspaceId'], ['name', 'filters', 'layout']],
  ['links', 'ResourceLink', ['id'], ['title', 'url', 'kind']],
  ['milestones', 'Milestone', ['id', 'revision', 'itemIds', 'progress'], ['projectId', 'title']],
] as const;
for (const [path, schema, omit, required] of resources) {
  const parameters =
    path === 'items'
      ? [
          'q',
          'projectId',
          'parentId',
          'milestoneId',
          'assigneeId',
          'status',
          'priority',
          'type',
          'visibility',
          'cursor',
          'limit',
        ].map((name) => ({ name, in: 'query', required: false, schema: string }))
      : [];
  operation(
    `/${path}`,
    'get',
    `List accessible ${path}${path === 'milestones' ? ' by due date (undated last), then title' : ''}`,
    list(schema),
    undefined,
    { parameters },
  );
  operation(
    `/${path}`,
    'post',
    `Create ${schema}`,
    ref(schema),
    writable(schema, [...omit], [...required]),
    {
      created: true,
      ...(['items', 'milestones'].includes(path) ? { parameters: [idempotencyParameter] } : {}),
    },
  );
  if (path === 'items' || path === 'projects' || path === 'milestones')
    operation(
      `/${path}/{id}`,
      'get',
      `Get ${schema}${path === 'items' ? ' by UUID or identifier' : path === 'projects' ? ' by UUID or key' : ' by UUID'}`,
      ref(path === 'items' ? 'ItemDetail' : schema),
    );
  operation(
    `/${path}/{id}`,
    'patch',
    `Update ${schema}${path === 'items' ? '; linked title, description and externalUrl changes return 409. Planning fields stay local.' : ''}`,
    path === 'items' ? object({ item: ref('WorkItem') }, ['item']) : ref(schema),
    path === 'items' || path === 'milestones'
      ? {
          ...writable(schema, [...omit]),
          properties: {
            ...writable(schema, [...omit]).properties,
            expectedRevision: {
              type: 'integer',
              minimum: 0,
              maximum: 2147483646,
              description: 'Optional compare-and-set revision; stale updates return 409.',
            },
            ...(path === 'items'
              ? {
                  undoCompletion: {
                    type: 'boolean',
                    description:
                      'Explicit completion Undo. Requires expectedRevision and a status other than done. Cancels only an untouched, unreferenced recurring successor; ordinary reopening preserves it. This command flag is never stored on the item.',
                  },
                }
              : {}),
          },
        }
      : writable(schema, [...omit]),
  );
  operation(
    `/${path}/{id}`,
    'delete',
    `Delete ${schema}`,
    {},
    path === 'items'
      ? object({
          expectedRevision: {
            type: 'integer',
            minimum: 0,
            maximum: 2147483646,
            description: 'Optional compare-and-set revision; stale deletions return 409.',
          },
        })
      : undefined,
    { noContent: true, ...(path === 'items' ? { optionalBody: true } : {}) },
  );
}
operation(
  '/items/batch',
  'post',
  'Atomically reorder, change statuses, or reparent work items; stale revisions return 409 without applying any updates',
  list('WorkItem'),
  object(
    {
      updates: {
        type: 'array',
        minItems: 1,
        maxItems: 1000,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: uuid,
            expectedRevision: { type: 'integer', minimum: 0, maximum: 2147483646 },
            status,
            position: { type: 'number' },
            parentId: { ...uuid, nullable: true },
          },
          required: ['id', 'expectedRevision'],
        },
      },
    },
    ['updates'],
  ),
);
operation(
  '/items/{id}/comments',
  'post',
  'Add a local discussion comment',
  ref('Activity'),
  object({ body: { type: 'string', minLength: 1, maxLength: 50000 } }, ['body']),
  { created: true, parameters: [idempotencyParameter] },
);
operation(
  '/items/ready',
  'get',
  'List ready work, by priority then due date',
  list('WorkItem'),
  undefined,
  {
    description:
      'Ready work is accessible, has status todo, is unassigned or assigned to the caller, and has no unfinished blockers (finish-to-start blocks relations whose blocker is not done or canceled). Blockers the caller cannot access still block. Order: priority (urgent first), due date (undated last), then board position. Read-only tokens may list ready work.',
    parameters: [
      {
        name: 'projectId',
        description: 'Project UUID or key; null selects inbox items',
        schema: string,
      },
      { name: 'label', description: 'Case-insensitive label name', schema: string },
      {
        name: 'repository',
        description:
          'owner/name. Matches the repository an item was imported from or its own repository links; items without either match their project repository links.',
        schema: string,
      },
      { name: 'cursor', schema: string },
      { name: 'limit', schema: { type: 'integer', minimum: 1, maximum: 500 } },
    ].map((parameter) => ({ ...parameter, in: 'query', required: false })),
  },
);
const queueResult = object(
  { item: ref('WorkItem'), comment: ref('Activity'), link: ref('ResourceLink') },
  ['item'],
);
const queueRevision = {
  type: 'integer',
  minimum: 0,
  maximum: 2147483646,
  description: 'Optional compare-and-set revision; a stale revision returns 409.',
};
const queueComment = { type: 'string', minLength: 1, maxLength: 50000 };
for (const [action, summary, description, properties] of [
  [
    'claim',
    'Claim ready work: assign yourself and set in_progress',
    'The item must be ready for the caller when the claim commits. Concurrent claims serialize: exactly one succeeds and the others return 409. Reuse an Idempotency-Key to retry an uncertain claim; a new key never claims the same item twice.',
    { expectedRevision: queueRevision },
  ],
  [
    'release',
    'Release your claim: set todo and clear the assignee',
    'Only the claimant (status in_progress, assigned to the caller) can release. An optional comment explains why.',
    { expectedRevision: queueRevision, comment: queueComment },
  ],
  [
    'handoff',
    'Hand off your claim for review: set in_review',
    'Only the claimant can hand off. The assignee stays as the responsible person. pullRequestUrl adds a repository link once per URL; comment adds a discussion comment.',
    {
      expectedRevision: queueRevision,
      comment: queueComment,
      pullRequestUrl: { type: 'string', format: 'uri', maxLength: 2048 },
    },
  ],
] as const)
  operation(`/items/{id}/${action}`, 'post', summary, queueResult, object(properties), {
    optionalBody: true,
    parameters: [idempotencyParameter],
    description: `Accepts an item UUID or identifier. ${description} Read-only tokens return 403.`,
  });
paths['/images'] = {
  post: {
    summary: 'Upload a PNG, JPEG, GIF, or WebP image for work item Markdown (8 MB maximum)',
    operationId: 'post_image',
    security: [{ bearerAuth: [] }, { cookieAuth: [] }],
    requestBody: {
      required: true,
      content: Object.fromEntries(
        ['image/png', 'image/jpeg', 'image/gif', 'image/webp'].map((type) => [
          type,
          { schema: { type: 'string', format: 'binary' } },
        ]),
      ),
    },
    responses: {
      201: {
        description:
          'Image URL. It becomes visible to work item readers when referenced in a description or comment.',
        content: { 'application/json': { schema: object({ url: string }, ['url']) } },
      },
      ...errorResponses,
      413: {
        description: 'Image exceeds the upload size or workspace storage limit',
        content: { 'application/json': { schema: ref('Error') } },
      },
    },
  },
};
paths['/images/{id}'] = {
  get: {
    summary: 'Read an uploaded image when you own it or can access its work item',
    operationId: 'get_image',
    security: [{ bearerAuth: [] }, { cookieAuth: [] }],
    parameters: [{ name: 'id', in: 'path', required: true, schema: uuid }],
    responses: {
      200: {
        description: 'Image bytes',
        content: Object.fromEntries(
          ['image/png', 'image/jpeg', 'image/gif', 'image/webp'].map((type) => [
            type,
            { schema: { type: 'string', format: 'binary' } },
          ]),
        ),
      },
      ...errorResponses,
    },
  },
};
operation(
  '/items/{id}/relations',
  'get',
  'List accessible item relationships in both directions',
  object({ data: { type: 'array', items: ref('RelationDetail') } }, ['data']),
  undefined,
  {
    description:
      'Accepts an item UUID or identifier. Includes only relationships whose two items are accessible. relatedItem identifies the opposite endpoint for display; itemId and targetId retain the original direction.',
  },
);
operation(
  '/items/{id}/relations',
  'post',
  'Link related or blocked work',
  ref('Relation'),
  object({ targetId: uuid, kind: { type: 'string', enum: ['blocks', 'blocked_by', 'related'] } }, [
    'targetId',
    'kind',
  ]),
  {
    created: true,
    description:
      'blocked_by means the target blocks this item. It is stored and returned as a blocks relationship from the target to this item, sharing the same relationship ID as the equivalent blocks request. Self-links and dependency cycles are rejected.',
  },
);
operation('/items/{id}/relations/{relationId}', 'delete', 'Delete a relationship', {}, undefined, {
  noContent: true,
});
operation(
  '/items/{id}/project-relations/{relationId}',
  'delete',
  'Delete a project relationship',
  {},
  undefined,
  { noContent: true },
);
operation(
  '/notifications',
  'get',
  'List your accessible mention notifications, newest first',
  list('MentionNotification'),
);
operation(
  '/notifications/{id}',
  'patch',
  'Mark your notification read or unread',
  ref('MentionNotification'),
  object({ read: { type: 'boolean' } }, ['read']),
);
operation(
  '/notifications/read-all',
  'post',
  'Mark all accessible notifications as read',
  {},
  object({}),
  { noContent: true },
);
operation('/users', 'get', 'List workspace members', list('User'));
operation(
  '/users',
  'post',
  'Create a local account in this installation (admin only)',
  ref('User'),
  object(
    { ...credentialFields, role: { type: 'string', enum: ['admin', 'member'], default: 'member' } },
    ['name', 'email', 'password'],
  ),
  { created: true },
);
operation(
  '/users/{id}/access',
  'patch',
  'Disable or enable an installation account (proxy mode; administrator browser session required). Disabling revokes all its personal tokens and sessions.',
  object({ ok: { type: 'boolean' } }),
  object({ disabled: { type: 'boolean' } }),
);
operation(
  '/tokens',
  'get',
  'List your personal token metadata',
  object({
    data: {
      type: 'array',
      items: object({
        id: uuid,
        name: string,
        scope: string,
        workspaceId: string,
        createdAt: string,
      }),
    },
  }),
);
operation(
  '/tokens',
  'post',
  'Create a personal token (browser session required; secret returned once)',
  object({
    id: uuid,
    name: string,
    scope: string,
    workspaceId: string,
    createdAt: string,
    token: string,
  }),
  object(
    { name: string, scope: { type: 'string', enum: ['read', 'write', 'admin'], default: 'write' } },
    ['name'],
  ),
  { created: true },
);
operation('/tokens/{id}', 'delete', 'Revoke your token', {}, undefined, { noContent: true });
operation(
  '/export',
  'get',
  'Export your accessible data without credentials or integration secrets',
  {
    type: 'object',
    properties: {
      ...(schemas.Bootstrap as { properties: object }).properties,
      version: { type: 'integer' },
      exportedAt: string,
      activity: { type: 'array', items: ref('Activity') },
      relations: { type: 'array', items: ref('Relation') },
      projectRelations: { type: 'array', items: ref('ProjectRelation') },
    },
  },
);
// Keep the portable format's published fields aligned with its runtime validator.
schemas.ProjectPackage = z.toJSONSchema(projectPackage);
schemas.ProjectImportOptions = z.toJSONSchema(importOptions);
schemas.ProjectImportResult = object({
  projectId: uuid,
  projectIds: { type: 'array', items: uuid },
  itemCount: { type: 'integer' },
});
operation(
  '/projects/{id}/export',
  'get',
  'Download a portable project and accessible subprojects (32 MB maximum)',
  ref('ProjectPackage'),
);
operation(
  '/project-import/preview',
  'post',
  'Validate a project file and suggest names, keys, and private access without writing',
  object({
    options: ref('ProjectImportOptions'),
    people: { type: 'array', items: object({ id: uuid, name: string }) },
    counts: { type: 'object', additionalProperties: { type: 'integer' } },
    warnings: { type: 'array', items: string },
  }),
  object({ package: ref('ProjectPackage') }),
);
operation(
  '/project-import',
  'post',
  'Import as new projects atomically; reuse requestId and body for safe retries',
  ref('ProjectImportResult'),
  object({ package: ref('ProjectPackage'), options: ref('ProjectImportOptions'), requestId: uuid }),
  { created: true },
);

schemas.Integration = object({
  id: string,
  connectionId: string,
  provider: { type: 'string', enum: ['github', 'gitea'] },
  name: string,
  baseUrl: string,
  repository: string,
  projectId: uuid,
  creatorId: uuid,
  createdAt: string,
  lastSyncedAt: nullableString,
  lastError: nullableString,
  configured: { type: 'boolean' },
});
operation(
  '/integrations',
  'get',
  'List repository connections (administrator only; returns an array)',
  { type: 'array', items: ref('Integration') },
);
operation(
  '/integrations',
  'post',
  'Connect a repository for inbound issue synchronization (administrator only)',
  ref('Integration'),
  object(
    {
      provider: { type: 'string', enum: ['github', 'gitea'] },
      name: string,
      baseUrl: string,
      repository: string,
      projectId: uuid,
      token: {
        type: 'string',
        writeOnly: true,
        description: 'Legacy input; creates a reusable personal connection. Prefer connectionId.',
      },
      connectionId: {
        type: 'string',
        description: 'Your saved Git connection. Required unless provider and token are supplied.',
      },
    },
    ['name', 'repository', 'projectId'],
  ),
  { created: true },
);
operation(
  '/integrations/{id}',
  'delete',
  'Disconnect a repository and retain imported work (administrator only)',
  {},
  undefined,
  { noContent: true },
);
operation(
  '/integrations/{id}/sync',
  'post',
  'Fetch issues and source comments without writing to the repository',
  object({
    imported: { type: 'integer' },
    updated: { type: 'integer' },
    comments: { type: 'integer' },
    integration: ref('Integration'),
  }),
);
schemas.GitConnection = object({
  id: string,
  authType: { type: 'string', enum: ['token', 'github-app', 'github-installation'] },
  shared: { type: 'boolean' },
  githubAccount: string,
  reconnectRequired: { type: 'boolean' },
  userId: uuid,
  provider: { type: 'string', enum: ['github', 'gitea'] },
  name: string,
  baseUrl: string,
  createdAt: string,
  updatedAt: string,
  configured: { type: 'boolean' },
});

operation(
  '/admin/version',
  'get',
  'Read running server version and latest stable release (admin only)',
  object({
    running: object({
      version: string,
      commit: nullableString,
      buildId: nullableString,
      builtAt: nullableString,
      release: { type: 'boolean' },
    }),
    latest: {
      ...object({ version: string, url: string, publishedAt: nullableString }),
      type: ['object', 'null'],
    },
    status: { type: 'string', enum: ['up-to-date', 'update-available', 'unreleased', 'unknown'] },
    checkedAt: string,
    message: nullableString,
  }),
  undefined,
  {
    browserOnly: true,
    description:
      'Checks the public saynain/trestl GitHub Releases API with no credentials. Results, including failures, are cached for 15 minutes. Manual refresh is bounded to one upstream check per minute.',
    parameters: [
      {
        name: 'refresh',
        in: 'query',
        schema: { type: 'boolean' },
        description: 'Request a fresh release check, subject to the one-minute minimum interval.',
      },
    ],
  },
);

const authenticationFields = {
  mode: { type: 'string', enum: ['local', 'google', 'oidc', 'proxy'] },
  origin: string,
  issuer: string,
  clientId: string,
  allowedDomains: { type: 'array', items: string },
  linkExistingEmails: { type: 'array', items: string },
};
const authenticationResponse = object({
  ...authenticationFields,
  clientSecretConfigured: { type: 'boolean' },
  proxySecretConfigured: { type: 'boolean' },
});
operation(
  '/admin/authentication',
  'get',
  'Read installation authentication settings without secrets (admin only)',
  authenticationResponse,
  undefined,
  { browserOnly: true },
);
operation(
  '/admin/authentication',
  'put',
  'Configure installation sign-in (admin only)',
  authenticationResponse,
  object(
    {
      ...authenticationFields,
      clientSecret: { type: 'string', writeOnly: true },
      proxySecret: { type: 'string', minLength: 32, writeOnly: true },
    },
    ['mode', 'origin'],
  ),
  { browserOnly: true },
);
operation(
  '/admin/github-installation',
  'post',
  'Verify and save a shared GitHub App installation (admin only)',
  ref('GitConnection'),
  object(
    {
      name: string,
      appId: string,
      installationId: string,
      privateKey: { type: 'string', writeOnly: true },
    },
    ['name', 'appId', 'installationId', 'privateKey'],
  ),
  { created: true, browserOnly: true },
);
const gitConnectionInput = object(
  {
    shared: { type: 'boolean', default: false },
    provider: { type: 'string', enum: ['github', 'gitea'] },
    name: string,
    baseUrl: string,
    token: { type: 'string', writeOnly: true },
  },
  ['provider', 'name', 'token'],
);
operation(
  '/git/connections',
  'get',
  'List shared installation Git connections and your legacy personal credentials',
  { type: 'array', items: ref('GitConnection') },
);
operation(
  '/git/connections',
  'post',
  'Save a Git credential; shared credentials require an administrator browser session',
  ref('GitConnection'),
  gitConnectionInput,
  { created: true },
);
operation(
  '/git/connections/{id}',
  'put',
  'Replace your Git token and name without changing its provider or host (browser session only)',
  ref('GitConnection'),
  object({ name: string, token: { type: 'string', writeOnly: true } }, ['name', 'token']),
);
operation(
  '/git/connections/{id}',
  'delete',
  'Remove your personal Git connection and stop its imports, retaining imported work (browser session only)',
  {},
  undefined,
  { noContent: true },
);
operation(
  '/git/connections/{id}/issue',
  'get',
  'Look up an issue with your saved Git token; does not import work or cache content',
  object({
    id: string,
    number: { type: 'integer' },
    title: string,
    description: string,
    closed: { type: 'boolean' },
    externalUrl: string,
    repository: string,
    provider: { type: 'string', enum: ['github', 'gitea'] },
  }),
  undefined,
  {
    parameters: [
      {
        name: 'repository',
        in: 'query',
        required: true,
        schema: { type: 'string' },
        description: 'owner/repository',
      },
      { name: 'number', in: 'query', required: true, schema: { type: 'integer', minimum: 1 } },
    ],
  },
);
operation(
  '/git/github-app/status',
  'get',
  'Check whether this self-hosted instance has GitHub App sign-in configured',
  object({ enabled: { type: 'boolean' }, installUrl: string }),
);
operation(
  '/git/github-app/authorize',
  'post',
  'Start a session-bound GitHub App authorization with state and PKCE',
  object({ authorizationUrl: string }),
  object({ connectionId: string }),
  { browserOnly: true },
);
operation(
  '/git/github-app/callback',
  'get',
  'Consume GitHub authorization once and redirect to settings or GitHub repository selection',
  {},
  undefined,
  {
    browserOnly: true,
    parameters: [
      { name: 'state', in: 'query', required: true, schema: string },
      { name: 'code', in: 'query', schema: string },
      { name: 'error', in: 'query', schema: string },
    ],
  },
);
operation(
  '/git/github-app/setup',
  'get',
  'Return from GitHub installation setup; supplied installation IDs never grant access',
  {},
  undefined,
  { browserOnly: true },
);
for (const path of ['/git/github-app/callback', '/git/github-app/setup']) {
  const endpoint = paths[path].get as { responses: Record<string, unknown> };
  delete endpoint.responses['200'];
  endpoint.responses['303'] = {
    description: 'Redirect to settings or GitHub repository selection',
    headers: { Location: { schema: string } },
  };
}
operation(
  '/git/connections/{id}/github-installations',
  'get',
  'Verify installation access with your GitHub App user token; refreshes expiring credentials',
  object({
    data: {
      type: 'array',
      items: object({
        id: { type: 'integer' },
        account: string,
        repositorySelection: string,
        suspended: { type: 'boolean' },
        issuesReadable: { type: 'boolean' },
        settingsUrl: string,
      }),
    },
    hasMore: { type: 'boolean' },
  }),
  undefined,
  {
    parameters: [
      { name: 'page', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 1000 } },
    ],
  },
);
schemas.ConfluenceConnection = object({
  id: uuid,
  userId: uuid,
  deployment: { type: 'string', enum: ['cloud', 'datacenter'] },
  baseUrl: string,
  username: nullableString,
  createdAt: string,
  updatedAt: string,
  configured: { type: 'boolean' },
});
schemas.ConfluencePage = object({
  id: string,
  title: string,
  url: { type: 'string', format: 'uri' },
  excerpt: string,
  updatedAt: nullableString,
});
const confluenceInput = object(
  {
    deployment: { type: 'string', enum: ['cloud', 'datacenter'] },
    baseUrl: { type: 'string', format: 'uri' },
    username: string,
    token: { type: 'string', writeOnly: true },
  },
  ['deployment', 'baseUrl', 'token'],
);
operation('/confluence/connection', 'get', 'Get your own Confluence connection metadata', {
  anyOf: [ref('ConfluenceConnection'), { type: 'null' }],
});
operation(
  '/confluence/connection',
  'post',
  'Save your personal Confluence credentials (browser session required)',
  ref('ConfluenceConnection'),
  confluenceInput,
  { created: true },
);
operation(
  '/confluence/connection',
  'put',
  'Replace your personal Confluence credentials (browser session required)',
  ref('ConfluenceConnection'),
  confluenceInput,
);
for (const method of ['post', 'put']) {
  const responses = (
    paths['/confluence/connection'][method] as { responses: Record<string, unknown> }
  ).responses;
  const success = responses['200'] ?? responses['201'];
  responses['200'] = success;
  responses['201'] = success;
}
operation(
  '/confluence/connection',
  'delete',
  'Delete your personal Confluence credentials (browser session required)',
  {},
  undefined,
  { noContent: true },
);
operation(
  '/confluence/search',
  'get',
  'Search documentation using only your Confluence permissions',
  object({ data: { type: 'array', items: ref('ConfluencePage') }, hasMore: { type: 'boolean' } }),
  undefined,
  {
    parameters: [
      {
        name: 'q',
        in: 'query',
        required: true,
        schema: { type: 'string', minLength: 1, maxLength: 200 },
      },
    ],
  },
);
operation(
  '/confluence/pages/{id}',
  'get',
  'Preview a page using your Confluence credentials; results are not cached',
  ref('ConfluencePage'),
);
const canvasSceneSchema = object(
  {
    elements: {
      type: 'array',
      maxItems: 20000,
      items: {
        type: 'object',
        required: ['id', 'type', 'x', 'y', 'width', 'height'],
        additionalProperties: true,
      },
    },
    appState: object({
      viewBackgroundColor: { type: 'string', maxLength: 100 },
      gridSize: { type: ['number', 'null'], exclusiveMinimum: 0 },
    }),
    files: {
      type: 'object',
      additionalProperties: {
        type: 'object',
        description:
          'Excalidraw image data with matching id, mimeType, base64 dataURL, and created timestamp.',
      },
    },
  },
  ['elements', 'appState', 'files'],
);
schemas.CanvasScene = canvasSceneSchema;
const canvasMetadata = {
  id: uuid,
  projectId: uuid,
  workspaceId: string,
  title: { ...string, minLength: 1, maxLength: 240 },
  collectionId: { type: ['string', 'null'], format: 'uuid' },
  revision: { type: 'integer', minimum: 1 },
  createdBy: uuid,
  updatedBy: uuid,
  createdAt: { ...string, format: 'date-time' },
  updatedAt: { ...string, format: 'date-time' },
};
const requiredCanvasMetadata = Object.keys(canvasMetadata).filter((key) => key !== 'collectionId');
schemas.CanvasSummary = object(canvasMetadata, requiredCanvasMetadata);
schemas.ProjectCanvas = object({ ...canvasMetadata, scene: ref('CanvasScene') }, [
  ...requiredCanvasMetadata,
  'scene',
]);
operation(
  '/projects/{projectId}/canvases',
  'get',
  'List canvas metadata visible in this project; scene contents are excluded',
  list('CanvasSummary'),
);
operation(
  '/projects/{projectId}/canvases',
  'post',
  'Create a project canvas (8 MiB request limit)',
  ref('ProjectCanvas'),
  object(
    {
      title: canvasMetadata.title,
      scene: ref('CanvasScene'),
      collectionId: canvasMetadata.collectionId,
    },
    ['title'],
  ),
  { created: true },
);
operation(
  '/projects/{projectId}/canvases/import',
  'post',
  'Import a native .excalidraw document as one new canvas (8 MiB request limit); editor-only preferences are discarded',
  ref('ProjectCanvas'),
  object(
    {
      title: canvasMetadata.title,
      collectionId: canvasMetadata.collectionId,
      document: {
        type: 'object',
        required: ['type', 'elements'],
        additionalProperties: true,
        properties: {
          type: { type: 'string', const: 'excalidraw' },
          elements: canvasSceneSchema.properties.elements,
          appState: {
            type: 'object',
            additionalProperties: true,
            properties: {
              viewBackgroundColor: { type: 'string', maxLength: 100 },
              gridSize: { type: ['number', 'null'], exclusiveMinimum: 0 },
            },
          },
          files: canvasSceneSchema.properties.files,
        },
      },
    },
    ['title', 'document'],
  ),
  { created: true },
);
operation(
  '/projects/{projectId}/canvases/{canvasId}/show',
  'get',
  'Return a browser link and current revision; URL is relative to the installation origin and requires project access',
  object({ id: uuid, title: string, revision: { type: 'integer' }, url: string }, [
    'id',
    'title',
    'revision',
    'url',
  ]),
);
operation(
  '/projects/{projectId}/canvases/{canvasId}',
  'get',
  'Read an editable canvas; access follows project and ancestor privacy',
  ref('ProjectCanvas'),
);
operation(
  '/projects/{projectId}/canvases/{canvasId}',
  'patch',
  'Save a canvas using its current revision; conflicts return 409 (8 MiB request limit)',
  ref('ProjectCanvas'),
  object(
    {
      title: canvasMetadata.title,
      collectionId: canvasMetadata.collectionId,
      scene: ref('CanvasScene'),
      expectedRevision: { type: 'integer', minimum: 0, maximum: 2147483646 },
    },
    ['expectedRevision'],
  ),
);
operation(
  '/projects/{projectId}/canvases/{canvasId}',
  'delete',
  'Delete a canvas using its current revision',
  undefined,
  object({ expectedRevision: { type: 'integer', minimum: 0, maximum: 2147483646 } }, [
    'expectedRevision',
  ]),
  { noContent: true },
);

const collectionProperties = {
  id: uuid,
  projectId: uuid,
  workspaceId: string,
  name: { ...string, minLength: 1, maxLength: 100 },
  revision: { type: 'integer', minimum: 1 },
  createdAt: { ...string, format: 'date-time' },
  updatedAt: { ...string, format: 'date-time' },
};
schemas.CanvasCollection = object(collectionProperties, Object.keys(collectionProperties));
operation(
  '/projects/{projectId}/canvas-collections',
  'get',
  'List project canvas collections; access follows project privacy',
  list('CanvasCollection'),
);
operation(
  '/projects/{projectId}/canvas-collections',
  'post',
  'Create a canvas collection with a unique name in this project',
  ref('CanvasCollection'),
  object({ name: collectionProperties.name }, ['name']),
  { created: true },
);
operation(
  '/projects/{projectId}/canvas-collections/{collectionId}',
  'patch',
  'Rename a canvas collection; stale revisions return 409',
  ref('CanvasCollection'),
  object(
    {
      name: collectionProperties.name,
      expectedRevision: { type: 'integer', minimum: 0, maximum: 2147483646 },
    },
    ['name', 'expectedRevision'],
  ),
);
operation(
  '/projects/{projectId}/canvas-collections/{collectionId}',
  'delete',
  'Remove a collection and move its canvases to Unsorted without deleting diagrams; increments affected canvas revisions',
  undefined,
  object({ expectedRevision: { type: 'integer', minimum: 0, maximum: 2147483646 } }, [
    'expectedRevision',
  ]),
  { noContent: true },
);

export const openapi = {
  openapi: '3.1.0',
  info: {
    title: 'Trestl API',
    version: '0.4.0',
    description:
      'Repository-independent project planning. Authenticate with a browser session or a scoped personal token. Core collection responses use data arrays; /integrations returns a direct array; item pagination uses opaque cursor values returned as nextCursor. Private project access is inherited by descendants. All dates are ISO YYYY-MM-DD and timestamps are UTC ISO 8601. The bootstrap endpoint is intended for small self-hosted workspaces. Repository imports require an admin account. Git and Confluence connections use individual credentials and explicit allowed origins. Work mutations never post to external providers; GitHub App authorization and refresh exchange credentials with GitHub.',
  },
  servers: [{ url: '/api/v1' }],
  components: {
    securitySchemes: {
      bearerAuth: {
        type: 'http',
        scheme: 'bearer',
        description: 'Personal access token created in Settings',
      },
      cookieAuth: { type: 'apiKey', in: 'cookie', name: 'trestl_session' },
    },
    schemas,
  },
  paths,
};
