import type { WorkItem, Project, User, ItemDetail } from '../../../shared/types';
export type { WorkItem as Item, Project, User, ItemDetail };
export interface Connection {
  serverUrl: string;
  webUrl?: string;
  token: string;
}
export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH';
  body?: unknown;
  signal?: AbortSignal;
}
export interface Page<T> {
  data: T[];
  nextCursor?: string;
}

export function origin(value: string, label: string): URL {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error(`${label} must be a valid HTTP(S) origin.`);
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/'
  )
    throw new Error(`${label} must be an HTTP(S) origin without a path, query, or credentials.`);
  if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
    throw new Error(
      `Use HTTPS for a remote ${label.toLowerCase()}. HTTP is only allowed on loopback.`,
    );
  return url;
}
export function webLink(
  connection: Connection,
  page: 'item' | 'project' | 'home',
  id?: string,
): string {
  const url = origin(connection.webUrl?.trim() || connection.serverUrl, 'Web URL');
  url.hash = `/${page}${id ? `/${encodeURIComponent(id)}` : ''}`;
  return url.toString();
}
export function createClient(connection: Connection, transport: typeof fetch = fetch) {
  return async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const base = origin(connection.serverUrl, 'Server URL');
    if (!connection.token.trim())
      throw new Error('Set a personal API token in extension preferences.');
    if (!/^[a-z][a-z0-9/-]*(?:\?.*)?$/i.test(path) || path.includes('..'))
      throw new Error('Invalid API path.');
    let response: Response;
    try {
      response = await transport(new URL(`/api/v1/${path}`, base), {
        method: options.method || 'GET',
        redirect: 'error',
        headers: {
          Authorization: `Bearer ${connection.token.trim()}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: AbortSignal.any([
          ...(options.signal ? [options.signal] : []),
          AbortSignal.timeout(20_000),
        ]),
      });
    } catch (error) {
      if (options.signal?.aborted) throw error;
      if (error instanceof Error && error.name === 'TimeoutError')
        throw new Error('Trestl took too long to respond. Retry or check the server.');
      throw new Error(
        'Cannot reach Trestl. Check the server URL and connection; redirects are not followed.',
      );
    }
    if (response.status === 401)
      throw new Error(
        'Authentication failed. Replace your personal API token in extension preferences.',
      );
    if (response.status === 403)
      throw new Error(
        'Access denied. Changes need a write-scoped token and permission to access this work.',
      );
    if (response.status === 404)
      throw new Error('Work not found or no longer accessible. Refresh the list.');
    if (response.status === 429) throw new Error('Too many requests. Wait a moment and retry.');
    if (response.status >= 500)
      throw new Error(`Trestl is unavailable (${response.status}). Retry shortly.`);
    let result: unknown;
    try {
      result = await response.json();
    } catch {
      throw new Error(
        'The server returned an unexpected response. Check that Server URL points to Trestl.',
      );
    }
    if (!response.ok) {
      const message =
        result &&
        typeof result === 'object' &&
        'message' in result &&
        typeof result.message === 'string'
          ? result.message
          : 'Request failed';
      throw new Error(
        `${response.status}: ${message.replaceAll(connection.token.trim(), '[redacted]')}`,
      );
    }
    return result as T;
  };
}
export function itemsPath(
  query: string,
  filters: Record<string, string> = {},
  cursor?: string,
): string {
  const params = new URLSearchParams({ ...filters, q: query, limit: '100' });
  if (cursor) params.set('cursor', cursor);
  return `items?${params}`;
}
export function mergePage<T extends { id: string }>(items: T[], incoming: T[]): T[] {
  return Array.from(new Map([...items, ...incoming].map((item) => [item.id, item])).values());
}
export function dateOnly(date: Date | null | undefined): string | null {
  return date
    ? `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
    : null;
}
