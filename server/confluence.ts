import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppContext } from './context.ts';
import { decryptToken, encryptToken } from './integration-provider.ts';

export type ConfluenceDeployment = 'cloud' | 'datacenter';
interface Connection {
  id: string;
  userId: string;
  deployment: ConfluenceDeployment;
  baseUrl: string;
  username: string | null;
  encryptedToken: string;
  createdAt: string;
  updatedAt: string;
}
export interface ConfluencePage {
  id: string;
  title: string;
  url: string;
  excerpt: string;
  updatedAt?: string | null;
}
interface ProviderOptions {
  fetch?: typeof fetch;
  timeoutMs?: number;
  allowedOrigins: string[];
}
type JsonObject = Record<string, unknown>;
const object = (value: unknown): JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as JsonObject) : {};
const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const pageId = z.string().regex(/^[1-9]\d{0,24}$/);
const connectionSchema = z
  .object({
    deployment: z.enum(['cloud', 'datacenter']),
    baseUrl: z.string().trim().min(1).max(2000),
    username: z.string().trim().max(320).optional(),
    token: z
      .string()
      .trim()
      .min(1)
      .max(4096)
      .regex(/^[^\s\u0000-\u001f\u007f]+$/),
  })
  .strict();

export function validateConfluenceBase(
  deployment: ConfluenceDeployment,
  baseUrl: string,
  allowedOrigins: string[],
): string {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error('Provide a valid Confluence site URL.');
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))
  ) {
    throw new Error(
      'Confluence requires an HTTPS URL without credentials, query, or fragment. HTTP is allowed only for explicitly configured loopback development hosts.',
    );
  }
  if (!allowedOrigins.some((origin) => origin.replace(/\/$/, '') === url.origin)) {
    throw new Error(
      'This Confluence origin is not permitted. Ask an administrator to add its exact origin to CONFLUENCE_ALLOWED_ORIGINS.',
    );
  }
  let path = url.pathname.replace(/\/+$/, '');
  if (/%|\.{2}|\\/.test(path)) throw new Error('The Confluence base path is invalid.');
  if (deployment === 'cloud') {
    if (path && path !== '/wiki')
      throw new Error('Use your Confluence Cloud site URL, optionally ending in /wiki.');
    path = '/wiki';
  } else {
    path = path.replace(/\/rest\/api$/, '');
  }
  return `${url.origin}${path}`;
}

/** These snippets are plain text, never HTML or Markdown supplied by a remote site. */
export function confluencePlainText(value: unknown, maxLength = 1500): string {
  const named: Record<string, string> = {
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
    nbsp: ' ',
    ndash: '–',
    mdash: '—',
    hellip: '…',
  };
  const source = text(value),
    lower = source.toLowerCase(),
    parts: string[] = [];
  let cursor = 0;
  // A forward-only scanner avoids expensive regex backtracking on malformed markup.
  while (cursor < source.length) {
    const start = source.indexOf('<', cursor);
    if (start < 0) {
      parts.push(source.slice(cursor));
      break;
    }
    parts.push(source.slice(cursor, start), ' ');
    if (source.startsWith('<!--', start)) {
      const end = source.indexOf('-->', start + 4);
      if (end < 0) break;
      cursor = end + 3;
      continue;
    }
    const end = source.indexOf('>', start + 1);
    if (end < 0) break;
    const tag = lower.slice(start + 1, Math.min(end, start + 20)).trimStart();
    const blocked = /^(script|style)(?:\s|\/|$)/.exec(tag)?.[1];
    if (blocked) {
      const closeStart = lower.indexOf(`</${blocked}`, end + 1);
      if (closeStart < 0) break;
      const closeEnd = source.indexOf('>', closeStart + 2);
      if (closeEnd < 0) break;
      cursor = closeEnd + 1;
    } else cursor = end + 1;
  }
  return parts
    .join('')
    .replace(/@@@(?:end)?hl@@@/g, '')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
      if (!entity.startsWith('#')) return named[entity.toLowerCase()] ?? match;
      const code =
        entity[1]?.toLowerCase() === 'x'
          ? parseInt(entity.slice(2), 16)
          : parseInt(entity.slice(1), 10);
      return Number.isSafeInteger(code) &&
        code >= 32 &&
        code <= 0x10ffff &&
        !(code >= 0xd800 && code <= 0xdfff)
        ? String.fromCodePoint(code)
        : ' ';
    })
    .replace(/[<>]/g, '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

export function confluenceCql(query: string): string {
  const escaped = query
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .trim()
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"');
  return `type = page AND text ~ "${escaped}" ORDER BY lastmodified DESC`;
}
const aad = (connection: Pick<Connection, 'userId' | 'deployment' | 'baseUrl'>): string =>
  `confluence:${connection.userId}:${connection.deployment}:${connection.baseUrl}`;
function publicConnection(connection: Connection) {
  const { encryptedToken: _token, ...publicFields } = connection;
  return { ...publicFields, configured: true };
}
function canonicalPageUrl(baseUrl: string, id: string): string {
  // Construct the known Confluence page route rather than trusting remote URLs.
  return `${baseUrl}/pages/viewpage.action?pageId=${encodeURIComponent(id)}`;
}
class ConfluenceError extends Error {
  constructor(
    message: string,
    readonly statusCode = 502,
  ) {
    super(message);
  }
}

async function readConfluenceJson(response: Response): Promise<JsonObject> {
  const limit = 2 * 1024 * 1024;
  if (Number(response.headers.get('content-length') ?? 0) > limit) {
    await response.body?.cancel();
    throw new ConfluenceError('Confluence response exceeded the 2 MB preview limit.');
  }
  if (!response.body) throw new ConfluenceError('Confluence returned an empty response.');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.length;
      if (length > limit) {
        await reader.cancel();
        throw new ConfluenceError('Confluence response exceeded the 2 MB preview limit.');
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  let json: unknown;
  try {
    json = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new ConfluenceError(
      'Confluence returned invalid JSON. Check the site URL and authentication configuration.',
    );
  }
  if (!json || typeof json !== 'object' || Array.isArray(json))
    throw new ConfluenceError('Confluence returned an unexpected response.');
  return json as JsonObject;
}

/** Confluence is queried with this user's own credentials on every request. No content cache exists. */
export async function queryConfluence(
  connection: Pick<Connection, 'deployment' | 'baseUrl' | 'username'>,
  token: string,
  operation: { kind: 'search'; query: string } | { kind: 'page'; id: string },
  options: ProviderOptions,
): Promise<{ data: ConfluencePage[]; hasMore: boolean } | ConfluencePage> {
  const baseUrl = validateConfluenceBase(
    connection.deployment,
    connection.baseUrl,
    options.allowedOrigins,
  );
  const url =
    operation.kind === 'search'
      ? new URL(`${baseUrl}/rest/api/search`)
      : new URL(
          connection.deployment === 'cloud'
            ? `${baseUrl}/api/v2/pages/${pageId.parse(operation.id)}`
            : `${baseUrl}/rest/api/content/${pageId.parse(operation.id)}`,
        );
  if (operation.kind === 'search') {
    url.searchParams.set('cql', confluenceCql(operation.query));
    url.searchParams.set('limit', '25');
    url.searchParams.set('excerpt', 'highlight');
  } else if (connection.deployment === 'cloud') url.searchParams.set('body-format', 'storage');
  else url.searchParams.set('expand', 'body.storage,version');
  const headers = {
    Accept: 'application/json',
    'User-Agent': 'Trestl/0.1',
    Authorization:
      connection.deployment === 'cloud'
        ? `Basic ${Buffer.from(`${connection.username}:${token}`, 'utf8').toString('base64')}`
        : `Bearer ${token}`,
  };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 15_000);
  timer.unref();
  try {
    const response = await (options.fetch ?? fetch)(url, {
      method: 'GET',
      headers,
      redirect: 'error',
      signal: controller.signal,
    });
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 401)
        throw new ConfluenceError(
          'Confluence rejected your credentials. Update your personal connection.',
        );
      if (response.status === 403 || response.status === 404)
        throw new ConfluenceError(
          'This Confluence content is unavailable or your account does not have permission to view it.',
          404,
        );
      if (response.status === 429)
        throw new ConfluenceError(
          'Confluence is rate limiting requests. Please retry shortly.',
          429,
        );
      throw new ConfluenceError(
        `Confluence request failed (HTTP ${response.status}). Please retry later.`,
      );
    }
    const body = await readConfluenceJson(response);
    if (operation.kind === 'search') {
      if (!Array.isArray(body.results))
        throw new ConfluenceError('Confluence returned an unexpected search response.');
      const data: ConfluencePage[] = [];
      for (const raw of body.results.slice(0, 25)) {
        const result = object(raw),
          content = object(result.content);
        const id = text(content.id);
        if (!pageId.safeParse(id).success || (content.type && content.type !== 'page')) continue;
        data.push({
          id,
          title: confluencePlainText(content.title || result.title, 500),
          url: canonicalPageUrl(baseUrl, id),
          excerpt: confluencePlainText(result.excerpt),
        });
      }
      return {
        data,
        hasMore: Boolean(object(body._links).next) || Number(body.totalSize ?? 0) > 25,
      };
    }
    if (text(body.id) !== operation.id || (body.type && body.type !== 'page'))
      throw new ConfluenceError('Confluence returned an unexpected page response.');
    const version = object(body.version);
    const updated = text(version.createdAt || version.when);
    const updatedAt =
      updated && !Number.isNaN(Date.parse(updated)) ? new Date(updated).toISOString() : null;
    return {
      id: operation.id,
      title: confluencePlainText(body.title, 500),
      url: canonicalPageUrl(baseUrl, operation.id),
      excerpt: confluencePlainText(object(object(body.body).storage).value, 3000),
      updatedAt,
    };
  } catch (error) {
    if (controller.signal.aborted)
      throw new ConfluenceError('Confluence request timed out. Please retry later.', 504);
    if (error instanceof ConfluenceError) throw error;
    // Never return provider bodies, authorization headers, or underlying request details.
    throw new ConfluenceError(
      'Could not reach Confluence. Check the site URL, TLS certificate, and redirect configuration.',
    );
  } finally {
    clearTimeout(timer);
  }
}

export async function registerConfluence(app: FastifyInstance, ctx: AppContext) {
  const allowedOrigins = (process.env.CONFLUENCE_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  const secret = () => process.env.APP_SECRET ?? '';
  const own = (request: FastifyRequest) => ctx.requireUser(request);
  const browserUser = (request: FastifyRequest) => {
    const user = own(request);
    if (request.tokenScope)
      ctx.fail(403, 'Manage personal Confluence credentials from a signed-in browser session.');
    return user;
  };
  async function connected(request: FastifyRequest) {
    const user = own(request);
    const connection = await ctx.store.get<Connection>('confluenceConnections', user.id);
    if (!connection || connection.userId !== user.id)
      ctx.fail(404, 'Connect your own Confluence account in Settings to search documentation.');
    let token: string;
    try {
      token = decryptToken(connection.encryptedToken, secret(), aad(connection));
    } catch {
      ctx.fail(
        503,
        'Your Confluence credentials could not be decrypted. Restore APP_SECRET or reconnect your account.',
      );
    }
    return { connection, token };
  }
  async function callProvider(
    request: FastifyRequest,
    operation: { kind: 'search'; query: string } | { kind: 'page'; id: string },
  ) {
    const { connection, token } = await connected(request);
    try {
      return await queryConfluence(connection, token, operation, { allowedOrigins });
    } catch (error) {
      if (error instanceof ConfluenceError) ctx.fail(error.statusCode, error.message);
      ctx.fail(
        400,
        'Confluence configuration is no longer permitted. Check the site URL and CONFLUENCE_ALLOWED_ORIGINS.',
      );
    }
  }
  app.addHook('onSend', async (request, reply, payload) => {
    if (request.url.startsWith('/api/v1/confluence/'))
      reply.header('Cache-Control', 'private, no-store').header('Vary', 'Cookie, Authorization');
    return payload;
  });
  app.get('/api/v1/confluence/connection', async (request) => {
    const user = own(request);
    const connection = await ctx.store.get<Connection>('confluenceConnections', user.id);
    return connection && connection.userId === user.id ? publicConnection(connection) : null;
  });
  app.route({
    method: ['POST', 'PUT'],
    url: '/api/v1/confluence/connection',
    handler: async (request, reply) => {
      const user = browserUser(request);
      const parsed = connectionSchema.safeParse(request.body);
      if (!parsed.success)
        ctx.fail(
          400,
          'Provide a deployment, Confluence base URL, access token, and Cloud account email when applicable.',
        );
      const input = parsed.data;
      if (input.deployment === 'cloud' && !z.email().safeParse(input.username).success)
        ctx.fail(400, 'Confluence Cloud requires your Atlassian account email.');
      if (secret().length < 32)
        ctx.fail(
          503,
          'APP_SECRET must contain at least 32 characters before Confluence can be configured.',
        );
      let baseUrl: string;
      try {
        baseUrl = validateConfluenceBase(input.deployment, input.baseUrl, allowedOrigins);
      } catch (error) {
        ctx.fail(400, error instanceof Error ? error.message : 'Invalid Confluence configuration.');
      }
      const previous = await ctx.store.get<Connection>('confluenceConnections', user.id);
      const now = ctx.now();
      const connection: Connection = {
        id: user.id,
        userId: user.id,
        deployment: input.deployment,
        baseUrl,
        username: input.deployment === 'cloud' ? input.username! : null,
        encryptedToken: '',
        createdAt: previous?.createdAt ?? now,
        updatedAt: now,
      };
      connection.encryptedToken = encryptToken(input.token, secret(), aad(connection));
      await ctx.store.put('confluenceConnections', connection);
      return reply.code(previous ? 200 : 201).send(publicConnection(connection));
    },
  });
  app.delete('/api/v1/confluence/connection', async (request, reply) => {
    await ctx.store.remove('confluenceConnections', browserUser(request).id);
    return reply.code(204).send();
  });
  app.get<{ Querystring: { q?: string } }>('/api/v1/confluence/search', async (request) => {
    const query = z.string().trim().min(1).max(200).safeParse(request.query.q);
    if (!query.success) ctx.fail(400, 'Enter a documentation search between 1 and 200 characters.');
    return callProvider(request, { kind: 'search', query: query.data });
  });
  app.get<{ Params: { id: string } }>('/api/v1/confluence/pages/:id', async (request) => {
    const id = pageId.safeParse(request.params.id);
    if (!id.success) ctx.fail(400, 'A numeric Confluence page ID is required.');
    return callProvider(request, { kind: 'page', id: id.data });
  });
}
