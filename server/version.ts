import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import type { ServerBuild, ServerVersion } from '../shared/server-version.ts';
import type { AppContext } from './context.ts';

const repository = 'https://github.com/saynain/trestl';
const latestEndpoint = 'https://api.github.com/repos/saynain/trestl/releases/latest';
// Desktop bundles inject their immutable metadata; source/Docker servers read installed files.
declare const __TRESTL_BUNDLED_BUILD__: ServerBuild | undefined;
function git(...args: string[]): string | null {
  try {
    return (
      execFileSync('git', args, {
        cwd: fileURLToPath(new URL('../', import.meta.url)),
        timeout: 1000,
        stdio: ['ignore', 'pipe', 'ignore'],
      })
        .toString()
        .trim() || null
    );
  } catch {
    return null;
  }
}

/** Read the installed server package, never a version baked into the browser bundle. */
export function serverBuild(): ServerBuild {
  if (typeof __TRESTL_BUNDLED_BUILD__ !== 'undefined') return __TRESTL_BUNDLED_BUILD__;
  const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const commit = process.env.TRESTL_BUILD_COMMIT || git('rev-parse', 'HEAD');
  const dirty =
    !process.env.TRESTL_BUILD_COMMIT && !!git('status', '--porcelain', '--untracked-files=no');
  const ref = process.env.TRESTL_BUILD_REF || git('describe', '--tags', '--exact-match', 'HEAD');
  return {
    version,
    commit,
    buildId:
      process.env.TRESTL_BUILD_ID ||
      (commit ? `${commit.slice(0, 12)}${dirty ? '-dirty' : ''}` : null),
    builtAt: process.env.TRESTL_BUILD_DATE || null,
    release: !dirty && ref === `v${version}`,
  };
}

function semver(value: string) {
  const match =
    /^(?:v)?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([\da-zA-Z-]+(?:\.[\da-zA-Z-]+)*))?(?:\+[\da-zA-Z-]+(?:\.[\da-zA-Z-]+)*)?$/.exec(
      value,
    );
  if (!match || match[4]?.split('.').some((v) => /^0\d+$/.test(v))) return null;
  return { core: match.slice(1, 4).map(BigInt), pre: match[4]?.split('.') ?? [] };
}
export function compareVersions(a: string, b: string): number | null {
  const left = semver(a),
    right = semver(b);
  if (!left || !right) return null;
  for (let i = 0; i < 3; i++) {
    if (left.core[i] !== right.core[i]) return left.core[i] < right.core[i] ? -1 : 1;
  }
  if (!left.pre.length || !right.pre.length)
    return left.pre.length === right.pre.length ? 0 : left.pre.length ? -1 : 1;
  for (let i = 0; i < Math.max(left.pre.length, right.pre.length); i++) {
    const l = left.pre[i],
      r = right.pre[i];
    if (l === r) continue;
    if (l === undefined || r === undefined) return l === undefined ? -1 : 1;
    const ln = /^\d+$/.test(l),
      rn = /^\d+$/.test(r);
    if (ln && rn) return BigInt(l) < BigInt(r) ? -1 : 1;
    if (ln !== rn) return ln ? -1 : 1;
    return l < r ? -1 : 1;
  }
  return 0;
}

export function createVersionChecker(
  running: ServerBuild,
  fetchRelease: typeof fetch = fetch,
  now: () => number = Date.now,
) {
  let cached: ServerVersion | null = null;
  let checked = -Infinity;
  let pending: Promise<ServerVersion> | null = null;
  async function check(): Promise<ServerVersion> {
    let latest: ServerVersion['latest'] = null;
    let status: ServerVersion['status'] = 'unknown';
    let message: string | null = null;
    try {
      const response = await fetchRelease(latestEndpoint, {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Trestl-version-check' },
        signal: AbortSignal.timeout(5000),
        redirect: 'error',
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error('Release unavailable');
      }
      // Do not buffer an unbounded upstream response or expose release bodies/errors to clients.
      const reader = response.body?.getReader();
      if (!reader) throw new Error('No release data');
      let length = 0;
      const chunks: Uint8Array[] = [];
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          length += value.byteLength;
          if (length > 256 * 1024) throw new Error('Release data too large');
          chunks.push(value);
        }
      } finally {
        await reader.cancel();
      }
      const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (
        typeof data.tag_name !== 'string' ||
        !semver(data.tag_name) ||
        data.draft ||
        data.prerelease
      )
        throw new Error('Invalid stable release');
      latest = {
        version: data.tag_name.replace(/^v/, ''),
        url: `${repository}/releases/tag/${encodeURIComponent(data.tag_name)}`,
        publishedAt:
          typeof data.published_at === 'string' && Number.isFinite(Date.parse(data.published_at))
            ? new Date(data.published_at).toISOString()
            : null,
      };
      const comparison = compareVersions(running.version, latest.version);
      status =
        comparison === null
          ? 'unknown'
          : comparison < 0
            ? 'update-available'
            : comparison > 0 || !running.release
              ? 'unreleased'
              : 'up-to-date';
    } catch {
      message =
        'Latest release is unavailable. GitHub may be unreachable, rate limited, or the repository may be private or have no published release.';
    }
    checked = now();
    cached = { running, latest, status, checkedAt: new Date(checked).toISOString(), message };
    return cached;
  }
  return (refresh = false): Promise<ServerVersion> => {
    // Manual refresh bypasses the regular 15-minute cache, bounded to once per minute.
    if (cached && now() - checked < (refresh ? 60_000 : 15 * 60_000))
      return Promise.resolve(cached);
    if (!pending)
      pending = check().finally(() => {
        pending = null;
      });
    return pending;
  };
}

export function registerServerVersion(app: FastifyInstance, ctx: AppContext) {
  const check = createVersionChecker(serverBuild(), ctx.githubFetch);
  app.get<{ Querystring: { refresh?: string } }>(
    '/api/v1/admin/version',
    async (request, reply) => {
      const user = ctx.requireUser(request);
      if (request.tokenScope || user.role !== 'admin')
        ctx.fail(403, 'Administrator browser access is required');
      reply.header('Cache-Control', 'no-store');
      return check(request.query.refresh === 'true');
    },
  );
}
