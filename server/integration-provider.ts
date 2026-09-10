import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

export type Provider = 'github' | 'gitea';
export class ProviderRequestError extends Error {
  constructor(
    readonly providerStatus: number,
    message: string,
  ) {
    super(message);
  }
}

export interface RepositorySource {
  provider: Provider;
  baseUrl: string;
  repository: string;
}
export interface SourceComment {
  id: string;
  author: string;
  body: string;
  createdAt: string;
}
export interface SourceIssue {
  id: string;
  number: number;
  title: string;
  description: string;
  closed: boolean;
  externalUrl: string;
  labels: string[];
  comments: SourceComment[];
}

function key(secret: string): Buffer {
  if (secret.length < 32)
    throw new Error(
      'APP_SECRET must contain at least 32 characters to configure repository integrations.',
    );
  return createHash('sha256').update(secret).digest();
}

/** AES-GCM authenticates both the credential and its integration identity. */
export function encryptToken(token: string, secret: string, integrationId: string): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(secret), nonce);
  cipher.setAAD(Buffer.from(integrationId));
  const encrypted = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
  return [nonce, cipher.getAuthTag(), encrypted]
    .map((value) => value.toString('base64url'))
    .join('.');
}

export function decryptToken(value: string, secret: string, integrationId: string): string {
  const [nonce, tag, encrypted] = value.split('.').map((part) => Buffer.from(part, 'base64url'));
  if (!nonce || !tag || !encrypted) throw new Error('Invalid credential envelope.');
  const decipher = createDecipheriv('aes-256-gcm', key(secret), nonce);
  decipher.setAAD(Buffer.from(integrationId));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}

/** Operators explicitly trust the exact origins that may receive provider credentials. */
export function validateSource(
  source: RepositorySource,
  allowedOrigins: string[] = [],
): RepositorySource {
  if (
    !/^[\w.-]+\/[\w.-]+$/.test(source.repository) ||
    source.repository.split('/').some((part) => part === '.' || part === '..')
  ) {
    throw new Error('Repository must be in owner/repository format.');
  }
  let url: URL;
  try {
    url = new URL(source.baseUrl);
  } catch {
    throw new Error('Invalid provider base URL.');
  }
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !['https:', 'http:'].includes(url.protocol)
  ) {
    throw new Error('Provider URL must be HTTP(S) without credentials, query, or fragment.');
  }
  const trusted = allowedOrigins.some((origin) => origin.replace(/\/$/, '') === url.origin);
  const github = source.provider === 'github' && url.origin === 'https://api.github.com';
  if (!github && !trusted)
    throw new Error(
      'Provider origin is not permitted. Add its exact origin to INTEGRATION_ALLOWED_ORIGINS.',
    );
  // A configured HTTP origin is deliberately permitted for internal installations.
  const path = url.pathname.replace(/\/+$/, '');
  if (source.provider === 'github' && github && path)
    throw new Error('GitHub base URL must be https://api.github.com.');
  if (/%|\.\./.test(path)) throw new Error('Provider base path is invalid.');
  const canonicalPath = source.provider === 'gitea' ? path.replace(/\/api\/v1$/, '') : path;
  return {
    ...source,
    repository: source.repository.trim(),
    baseUrl: `${url.origin}${canonicalPath}`,
  };
}

interface FetchOptions {
  allowedOrigins?: string[];
  fetch?: typeof fetch;
  timeoutMs?: number;
  maxPages?: number;
  pageSize?: number;
}
type JsonRecord = Record<string, unknown>;
function record(value: unknown): JsonRecord {
  return typeof value === 'object' && value !== null ? (value as JsonRecord) : {};
}
function string(value: unknown): string {
  return typeof value === 'string' ? value : '';
}
function sourceId(value: unknown): string {
  if (
    (typeof value === 'string' && /^\d+$/.test(value)) ||
    (typeof value === 'number' && Number.isSafeInteger(value) && value > 0)
  )
    return String(value);
  throw new Error('Provider returned an invalid issue or comment identifier.');
}
function date(value: unknown): string {
  const parsed = new Date(string(value));
  return Number.isNaN(parsed.getTime()) ? new Date(0).toISOString() : parsed.toISOString();
}

async function readJson(response: Response): Promise<unknown> {
  const maxBytes = 5 * 1024 * 1024;
  if (Number(response.headers.get('content-length') || 0) > maxBytes)
    throw new Error('Provider response exceeded the 5 MB limit.');
  if (!response.body) throw new Error('Provider returned an empty response.');
  const reader = response.body.getReader();
  let bytes = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.length;
      if (bytes > maxBytes) {
        await reader.cancel();
        throw new Error('Provider response exceeded the 5 MB limit.');
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Error('Provider returned invalid JSON.');
  }
}

/** Only GET requests are used. Remote-provided URLs and redirects are never followed. */
export async function fetchRepository(
  sourceInput: RepositorySource,
  token: string,
  options: FetchOptions = {},
): Promise<SourceIssue[]> {
  const source = validateSource(sourceInput, options.allowedOrigins);
  const request = options.fetch ?? fetch;
  const pageSize = Math.min(options.pageSize ?? 100, 100);
  const maxPages = options.maxPages ?? 100;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 120_000);
  timeout.unref();
  let totalBytes = 0;
  const base =
    source.provider === 'gitea' && !source.baseUrl.endsWith('/api/v1')
      ? `${source.baseUrl}/api/v1`
      : source.baseUrl;
  const repo = source.repository.split('/').map(encodeURIComponent).join('/');
  const prefix = `${base}/repos/${repo}/issues`;
  try {
    async function pages(path: string, issues: boolean): Promise<JsonRecord[]> {
      const all: JsonRecord[] = [];
      // Gitea's per-issue comments endpoint returns the entire collection and ignores
      // page/limit. Only its issue list (and both GitHub endpoints) is paginated.
      // https://docs.gitea.com/api/operations/issue-get-comments/
      const paginated = issues || source.provider === 'github';
      for (let page = 1; page <= maxPages; page++) {
        const url = new URL(path);
        if (paginated) {
          url.searchParams.set('page', String(page));
          url.searchParams.set(
            source.provider === 'gitea' ? 'limit' : 'per_page',
            String(pageSize),
          );
        }
        if (issues) {
          url.searchParams.set('state', 'all');
          if (source.provider === 'gitea') url.searchParams.set('type', 'issues');
          else {
            url.searchParams.set('sort', 'created');
            url.searchParams.set('direction', 'asc');
          }
        }
        const response = await request(url, {
          method: 'GET',
          redirect: 'error',
          signal: controller.signal,
          headers: {
            Accept: 'application/json',
            Authorization: `${source.provider === 'gitea' ? 'token' : 'Bearer'} ${token}`,
            'User-Agent': 'Trestl/0.1',
            ...(source.provider === 'github' ? { 'X-GitHub-Api-Version': '2022-11-28' } : {}),
          },
        });
        if (!response.ok) {
          await response.body?.cancel();
          throw new ProviderRequestError(
            response.status,
            `Provider request failed (HTTP ${response.status}). Check repository access, token permissions, and rate limits.`,
          );
        }
        const body = await readJson(response);
        if (!Array.isArray(body))
          throw new Error('Provider returned an unexpected response; an array was required.');
        totalBytes += Buffer.byteLength(JSON.stringify(body));
        if (totalBytes > 50 * 1024 * 1024)
          throw new Error('Repository synchronization exceeded the 50 MB limit.');
        all.push(...body.map(record));
        if (!paginated) return all;
        // Request one empty page when Link is unavailable: Gitea can clamp page size.
        // Never follow the Link URL, which might send a token to a different host.
        const link = response.headers.get('link');
        if (body.length === 0 || (link && !/rel="?next"?/.test(link))) return all;
      }
      throw new Error(
        `Provider pagination exceeded ${maxPages} pages; synchronization was not applied.`,
      );
    }
    const remoteIssues = await pages(prefix, true);
    const results: SourceIssue[] = [];
    for (const issue of remoteIssues) {
      if (issue.pull_request) continue;
      const number = Number(issue.number);
      if (!Number.isSafeInteger(number) || number < 1)
        throw new Error('Provider returned an invalid issue number.');
      const id = sourceId(issue.id);
      const comments = await pages(`${prefix}/${number}/comments`, false);
      // Construct links from the trusted source, never from untrusted html_url.
      const webBase =
        source.baseUrl === 'https://api.github.com'
          ? 'https://github.com'
          : source.baseUrl.replace(/\/api\/(v1|v3)$/, '');
      results.push({
        id,
        number,
        title: string(issue.title).slice(0, 500) || `Issue #${number}`,
        description: string(issue.body).slice(0, 200_000),
        closed: issue.state === 'closed',
        externalUrl: `${webBase}/${repo}/issues/${number}`,
        labels: (Array.isArray(issue.labels) ? issue.labels : [])
          .map((label) => string(record(label).name))
          .filter(Boolean)
          .slice(0, 50),
        comments: comments.map((comment) => ({
          id: sourceId(comment.id),
          author: string(record(comment.user).login) || 'unknown',
          body: string(comment.body).slice(0, 200_000),
          createdAt: date(comment.created_at),
        })),
      });
    }
    return results;
  } catch (error) {
    if (controller.signal.aborted)
      throw new Error('Repository synchronization timed out. No changes were applied.');
    // Fetch errors can contain addresses. Never include headers, credentials, or response bodies.
    if (error instanceof TypeError)
      throw new Error(
        'Could not reach the provider. Verify its URL, TLS certificate, and redirect configuration.',
      );
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

/** Resolve a reference on demand with the caller's token, without importing a repository. */
export async function fetchIssue(
  sourceInput: RepositorySource,
  number: number,
  token: string,
  options: FetchOptions = {},
): Promise<Omit<SourceIssue, 'comments' | 'labels'> & { repository: string; provider: Provider }> {
  const source = validateSource(sourceInput, options.allowedOrigins);
  if (!Number.isSafeInteger(number) || number < 1)
    throw new Error('Provider issue number is invalid.');
  const base = source.provider === 'gitea' ? `${source.baseUrl}/api/v1` : source.baseUrl;
  const repo = source.repository.split('/').map(encodeURIComponent).join('/');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 15_000);
  timer.unref();
  try {
    const response = await (options.fetch ?? fetch)(`${base}/repos/${repo}/issues/${number}`, {
      method: 'GET',
      redirect: 'error',
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        Authorization: `${source.provider === 'gitea' ? 'token' : 'Bearer'} ${token}`,
        'User-Agent': 'Trestl/0.1',
        ...(source.provider === 'github' ? { 'X-GitHub-Api-Version': '2022-11-28' } : {}),
      },
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new ProviderRequestError(
        response.status,
        `Provider request failed (HTTP ${response.status}). Check the issue reference and your token's repository access and permissions.`,
      );
    }
    const body = record(await readJson(response));
    if (Number(body.number) !== number || body.pull_request)
      throw new Error(
        'Provider returned an unexpected issue. Pull requests are not supported here.',
      );
    const webBase =
      source.baseUrl === 'https://api.github.com'
        ? 'https://github.com'
        : source.baseUrl.replace(/\/api\/(v1|v3)$/, '');
    return {
      id: sourceId(body.id),
      number,
      title: string(body.title).slice(0, 500) || `Issue #${number}`,
      description: string(body.body).slice(0, 3000),
      closed: body.state === 'closed',
      externalUrl: `${webBase}/${repo}/issues/${number}`,
      repository: source.repository,
      provider: source.provider,
    };
  } catch (error) {
    if (controller.signal.aborted)
      throw new Error('Provider issue lookup timed out. Please retry later.');
    if (error instanceof TypeError)
      throw new Error(
        'Could not reach the provider. Check its URL, TLS certificate, and redirect configuration.',
      );
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
