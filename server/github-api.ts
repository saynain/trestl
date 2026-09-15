import { createPrivateKey, sign } from 'node:crypto';
import type { AppContext } from './context.ts';

export function githubError(message: string, statusCode = 502): never {
  throw Object.assign(new Error(message), { statusCode, expose: true });
}
export function appJwt(appId: string, privateKey: string) {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const value = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({ iat: now - 60, exp: now + 540, iss: appId })}`;
  return `${value}.${sign('RSA-SHA256', Buffer.from(value), createPrivateKey(privateKey)).toString('base64url')}`;
}
/** All API destinations are constructed locally; never follow provider-supplied URLs. */
export async function githubApi<T>(
  ctx: AppContext,
  path: string,
  token?: string,
  method = 'GET',
  body?: unknown,
): Promise<T> {
  if (!path.startsWith('/') || path.startsWith('//')) throw new Error('Invalid GitHub API path');
  try {
    const response = await (ctx.githubFetch ?? fetch)(`https://api.github.com${path}`, {
      method,
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2026-03-10',
        'User-Agent': 'Trestl',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) {
      await response.body?.cancel();
      githubError(
        `GitHub returned HTTP ${response.status}. Check repository access and app permissions, then retry.`,
      );
    }
    if (response.status === 204) return undefined as T;
    if (!response.body) githubError('GitHub returned an empty response.');
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.length;
        if (size > 8 * 1024 * 1024) {
          await reader.cancel();
          githubError('GitHub response exceeded the size limit.');
        }
        chunks.push(chunk.value);
      }
    } finally {
      reader.releaseLock();
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as T;
  } catch (error) {
    if ((error as { expose?: boolean }).expose) throw error;
    githubError('GitHub could not be reached or returned an invalid response. Please retry.');
  }
}
