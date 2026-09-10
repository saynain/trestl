const string = { type: 'string' };
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
      revision: {
        type: 'integer',
        minimum: 0,
        readOnly: true,
        description: 'Monotonic revision. Older records without this field have revision 0.',
      },
      id: uuid,
      workspaceId: { ...string, readOnly: true },
      identifier: string,
      title: string,
      description: string,
      projectId: nullableString,
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
schemas.ItemDetail = {
  type: 'object',
  properties: {
    item: ref('WorkItem'),
    activity: { type: 'array', items: ref('Activity') },
    relations: { type: 'array', items: ref('Relation') },
    links: { type: 'array', items: ref('ResourceLink') },
  },
};
schemas.Bootstrap = {
  type: 'object',
  properties: {
    user: ref('User'),
    users: { type: 'array', items: ref('User') },
    projects: { type: 'array', items: ref('Project') },
    items: { type: 'array', items: ref('WorkItem') },
    views: { type: 'array', items: ref('SavedView') },
    links: { type: 'array', items: ref('ResourceLink') },
    milestones: { type: 'array', items: ref('Milestone') },
    relations: { type: 'array', items: ref('Relation') },
  },
};
const object = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
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
    parameters?: unknown[];
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
  (paths[path] ??= {})[method] = {
    summary,
    operationId: `${method}${path.replace(/[^a-zA-Z]/g, '_')}`,
    security: options.public
      ? []
      : options.browserOnly
        ? [{ cookieAuth: [] }]
        : [{ bearerAuth: [] }, { cookieAuth: [] }],
    ...(params.length ? { parameters: params } : {}),
    ...(body
      ? { requestBody: { required: true, content: { 'application/json': { schema: body } } } }
      : {}),
    responses: {
      [code]: {
        description: 'Success',
        ...(!options.noContent ? { content: { 'application/json': { schema: response } } } : {}),
      },
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
  'Initialize the workspace and sign in',
  ref('User'),
  object({ ...credentialFields, seedDemo: { type: 'boolean', default: true } }, [
    'name',
    'email',
    'password',
  ]),
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
operation('/auth/profiles', 'get', 'List saved browser profiles', list('User'), undefined, {
  browserOnly: true,
});
operation(
  '/auth/profiles',
  'post',
  'Create an empty workspace with a new administrator and sign in',
  ref('User'),
  object(credentialFields, ['name', 'email', 'password']),
  { created: true, browserOnly: true },
);
operation(
  '/auth/switch',
  'post',
  'Switch to a saved, authenticated browser profile',
  object({ ok: { type: 'boolean' } }),
  object({ userId: uuid }, ['userId']),
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
  'Load the current user and all accessible planning data',
  ref('Bootstrap'),
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
const idempotencyParameter = {
  name: 'Idempotency-Key',
  in: 'header',
  required: false,
  schema: { type: 'string', pattern: '^[A-Za-z0-9._:-]{1,128}$' },
  description:
    'Reuse for retries of the same request. Scoped to user and operation; different input returns 409. Records persist with the database. Replay requires current access to the original item.',
};
const resources = [
  ['projects', 'Project', ['id', 'ownerId', 'createdAt', 'roadmap'], ['key', 'name']],
  [
    'items',
    'WorkItem',
    [
      'id',
      'identifier',
      'creatorId',
      'createdAt',
      'updatedAt',
      'completedAt',
      'source',
      'revision',
    ],
    ['title'],
  ],
  ['views', 'SavedView', ['id', 'userId'], ['name', 'filters', 'layout']],
  ['links', 'ResourceLink', ['id'], ['title', 'url', 'kind']],
  ['milestones', 'Milestone', ['id', 'revision'], ['projectId', 'title']],
] as const;
for (const [path, schema, omit, required] of resources) {
  const parameters =
    path === 'items'
      ? [
          'q',
          'projectId',
          'parentId',
          'assigneeId',
          'status',
          'priority',
          'type',
          'visibility',
          'cursor',
          'limit',
        ].map((name) => ({ name, in: 'query', required: false, schema: string }))
      : [];
  operation(`/${path}`, 'get', `List accessible ${path}`, list(schema), undefined, { parameters });
  operation(
    `/${path}`,
    'post',
    `Create ${schema}`,
    ref(schema),
    writable(schema, [...omit], [...required]),
    { created: true, ...(path === 'items' ? { parameters: [idempotencyParameter] } : {}) },
  );
  if (path === 'items' || path === 'projects')
    operation(
      `/${path}/{id}`,
      'get',
      `Get ${schema}${path === 'items' ? ' by UUID or identifier' : ' by UUID or key'}`,
      ref(path === 'items' ? 'ItemDetail' : schema),
    );
  operation(
    `/${path}/{id}`,
    'patch',
    `Update ${schema}${path === 'items' ? '; linked title, description and externalUrl changes return 409. Planning fields stay local.' : ''}`,
    ref(schema),
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
          },
        }
      : writable(schema, [...omit]),
  );
  operation(`/${path}/{id}`, 'delete', `Delete ${schema}`, {}, undefined, { noContent: true });
}
operation(
  '/items/{id}/comments',
  'post',
  'Add a local discussion comment',
  ref('Activity'),
  object({ body: { type: 'string', minLength: 1, maxLength: 50000 } }, ['body']),
  { created: true, parameters: [idempotencyParameter] },
);
operation(
  '/items/{id}/relations',
  'post',
  'Link related or blocked work',
  ref('Relation'),
  object({ targetId: uuid, kind: { type: 'string', enum: ['blocks', 'related'] } }, [
    'targetId',
    'kind',
  ]),
  { created: true },
);
operation('/items/{id}/relations/{relationId}', 'delete', 'Delete a relationship', {}, undefined, {
  noContent: true,
});
operation('/users', 'get', 'List workspace members', list('User'));
operation(
  '/users',
  'post',
  'Create a member (administrator only; no email is sent)',
  ref('User'),
  object(
    { ...credentialFields, role: { type: 'string', enum: ['admin', 'member'], default: 'member' } },
    ['name', 'email', 'password'],
  ),
  { created: true },
);
operation(
  '/tokens',
  'get',
  'List your personal token metadata',
  object({
    data: {
      type: 'array',
      items: object({ id: uuid, name: string, scope: string, createdAt: string }),
    },
  }),
);
operation(
  '/tokens',
  'post',
  'Create a personal token (browser session required; secret returned once)',
  object({ id: uuid, name: string, scope: string, createdAt: string, token: string }),
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
    },
  },
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
  authType: { type: 'string', enum: ['token', 'github-app'] },
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
const gitConnectionInput = object(
  {
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
  'List your personal Git connections, usable across all projects',
  { type: 'array', items: ref('GitConnection') },
);
operation(
  '/git/connections',
  'post',
  'Save a personal Git token (browser session only)',
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
    version: '0.1.0',
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
