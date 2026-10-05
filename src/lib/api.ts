import { trackDesktopWrite } from './desktop-updates';
import type { Bootstrap } from '../../shared/types';
export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}
export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const done = options.method && options.method !== 'GET' ? trackDesktopWrite() : () => {};
  try {
    const res = await fetch(`/api/v1${path}`, {
      ...options,
      credentials: 'same-origin',
      headers: {
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...options.headers,
      },
    });
    if (!res.ok) {
      let message = `Request failed (${res.status})`;
      try {
        const data = await res.json();
        message = data.message || data.error || message;
      } catch {
        /* non-JSON response */
      }
      throw new ApiError(message, res.status);
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  } finally {
    done();
  }
}
export function post<T>(path: string, body: unknown) {
  return api<T>(path, { method: 'POST', body: JSON.stringify(body) });
}
export function patch<T>(path: string, body: unknown) {
  return api<T>(path, { method: 'PATCH', body: JSON.stringify(body) });
}
export function remove(path: string) {
  return api<void>(path, { method: 'DELETE' });
}
export async function fetchBootstrap(etag?: string): Promise<{ data?: Bootstrap; etag?: string }> {
  const response = await fetch('/api/v1/bootstrap', {
    credentials: 'same-origin',
    headers: etag ? { 'If-None-Match': etag } : {},
    cache: 'no-store',
  });
  if (response.status === 304) return { etag };
  if (!response.ok) {
    let message = `Request failed (${response.status})`;
    try {
      const body = await response.json();
      message = body.message || body.error || message;
    } catch {
      /* non-JSON response */
    }
    throw new ApiError(message, response.status);
  }
  return {
    data: (await response.json()) as Bootstrap,
    etag: response.headers.get('ETag') ?? undefined,
  };
}
