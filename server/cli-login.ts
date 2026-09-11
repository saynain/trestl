import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { makeStore, type Database } from './db.ts';
import type { AppContext } from './context.ts';
import { installation } from './installation.ts';
import { workspaceUser } from './workspaces.ts';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const challenge = (value: string) => createHash('sha256').update(value).digest('base64url');
const codeSchema = z.string().regex(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
const deviceSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const lifetime = 10 * 60_000;
const interval = 5;
type Pending = {
  device_hash: string;
  user_code: string;
  challenge: string;
  name: string;
  scope: 'read' | 'write';
  expires_at: Date | string;
  polled_at: Date | string | null;
  user_id: string | null;
  workspace_id: string | null;
};
export async function initializeCliLogin(db: Database) {
  await db.query(`CREATE TABLE IF NOT EXISTS cli_logins (
    device_hash TEXT PRIMARY KEY, user_code TEXT UNIQUE NOT NULL, challenge TEXT NOT NULL,
    name TEXT NOT NULL, scope TEXT NOT NULL, expires_at TIMESTAMPTZ NOT NULL,
    polled_at TIMESTAMPTZ, user_id TEXT, workspace_id TEXT)`);
}

/** These endpoints may run in a separate gateway process. They never serve app data. */
export function registerCliDeviceEndpoints(
  app: FastifyInstance,
  db: Database,
  origin: () => string,
) {
  app.post(
    '/cli-auth/device',
    { bodyLimit: 4096, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const input = z
        .object({
          challenge: deviceSchema,
          name: z.string().trim().min(1).max(80),
          scope: z.enum(['read', 'write']).default('write'),
        })
        .strict()
        .parse(request.body);
      const url = new URL(origin());
      if (
        url.protocol !== 'https:' &&
        !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
      )
        throw Object.assign(new Error('Configure a secure APP_ORIGIN for CLI login.'), {
          statusCode: 503,
        });
      const deviceCode = randomBytes(32).toString('base64url');
      const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
      const letters = [...randomBytes(8)].map((n) => alphabet[n % alphabet.length]).join('');
      const userCode = `${letters.slice(0, 4)}-${letters.slice(4)}`;
      await db.transaction(async (tx) => {
        // Bound the public endpoint's storage even if an attacker rotates source IPs.
        await tx.query(
          "SELECT id FROM entities WHERE collection='system' AND id='mutation-lock' FOR UPDATE",
        );
        await tx.query('DELETE FROM cli_logins WHERE expires_at <= NOW()');
        const count = (
          await tx.query<{ count: string }>('SELECT COUNT(*) AS count FROM cli_logins')
        ).rows[0];
        if (Number(count.count) >= 1000)
          throw Object.assign(new Error('Too many pending sign-ins. Try again later.'), {
            statusCode: 503,
          });
        await tx.query(
          'INSERT INTO cli_logins(device_hash,user_code,challenge,name,scope,expires_at) VALUES($1,$2,$3,$4,$5,$6)',
          [
            hash(deviceCode),
            userCode,
            input.challenge,
            input.name,
            input.scope,
            new Date(Date.now() + lifetime).toISOString(),
          ],
        );
      });
      reply.header('Cache-Control', 'no-store');
      return {
        deviceCode,
        userCode,
        verificationUri: `${url.origin}/cli-login?code=${userCode}`,
        expiresIn: lifetime / 1000,
        interval,
      };
    },
  );
  app.post('/cli-auth/token', { bodyLimit: 4096 }, async (request, reply) => {
    const input = z
      .object({ deviceCode: deviceSchema, verifier: deviceSchema })
      .strict()
      .parse(request.body);
    reply.header('Cache-Control', 'no-store');
    return db.transaction(async (tx) => {
      // Same lock as membership/offboarding changes; approval cannot race removal.
      await tx.query(
        "SELECT id FROM entities WHERE collection='system' AND id='mutation-lock' FOR UPDATE",
      );
      const row = (
        await tx.query<Pending>('SELECT * FROM cli_logins WHERE device_hash=$1 FOR UPDATE', [
          hash(input.deviceCode),
        ])
      ).rows[0];
      if (!row || new Date(row.expires_at).getTime() <= Date.now())
        return reply.code(400).send({ error: 'expired_token' });
      const actual = Buffer.from(challenge(input.verifier));
      const expected = Buffer.from(row.challenge);
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
        return reply.code(400).send({ error: 'invalid_grant' });
      if (row.polled_at && Date.now() - new Date(row.polled_at).getTime() < interval * 1000)
        return reply.code(429).header('Retry-After', String(interval)).send({ error: 'slow_down' });
      await tx.query('UPDATE cli_logins SET polled_at=NOW() WHERE device_hash=$1', [
        row.device_hash,
      ]);
      if (!row.user_id || !row.workspace_id)
        return reply.code(400).send({ error: 'authorization_pending' });
      const s = makeStore(tx);
      const site = await installation(s);
      const user = await workspaceUser(s, row.user_id, row.workspace_id);
      if (!user || user.disabledAt || site?.workspaceId !== row.workspace_id) {
        await tx.query('DELETE FROM cli_logins WHERE device_hash=$1', [row.device_hash]);
        return reply.code(403).send({ error: 'access_denied' });
      }
      const token = `ep_${randomBytes(32).toString('base64url')}`;
      await tx.query(
        'INSERT INTO tokens(id,hash,user_id,name,scope,created_at,workspace_id) VALUES($1,$2,$3,$4,$5,NOW(),$6)',
        [randomUUID(), hash(token), user.id, row.name, row.scope, site.workspaceId],
      );
      await tx.query('DELETE FROM cli_logins WHERE device_hash=$1', [row.device_hash]);
      return { token, tokenType: 'Bearer', scope: row.scope };
    });
  });
}

export function registerCliApproval(app: FastifyInstance, ctx: AppContext) {
  const lookup = async (code: string, db = ctx.db) =>
    (
      await db.query<Pending>('SELECT * FROM cli_logins WHERE user_code=$1 AND expires_at>NOW()', [
        code,
      ])
    ).rows[0];
  app.get<{ Params: { code: string } }>('/api/v1/auth/cli/:code', async (request) => {
    ctx.requireUser(request);
    if (request.tokenScope) ctx.fail(403, 'Use a signed-in browser to approve a CLI.');
    const row = await lookup(codeSchema.parse(request.params.code));
    if (!row || row.user_id) ctx.fail(404, 'This code has expired or was already approved.');
    return { code: row.user_code, name: row.name, scope: row.scope, expiresAt: row.expires_at };
  });
  app.post('/api/v1/auth/cli/approve', async (request) => {
    const user = ctx.requireUser(request);
    if (request.tokenScope) ctx.fail(403, 'Use a signed-in browser to approve a CLI.');
    const { code } = z.object({ code: codeSchema }).strict().parse(request.body);
    return ctx.db.transaction(async (tx) => {
      await tx.query(
        "SELECT id FROM entities WHERE collection='system' AND id='mutation-lock' FOR UPDATE",
      );
      const row = await lookup(code, tx);
      if (!row || row.user_id) ctx.fail(404, 'This code has expired or was already approved.');
      const s = makeStore(tx),
        site = await installation(s);
      const current = site && (await workspaceUser(s, user.id, site.workspaceId));
      if (!current || current.disabledAt) ctx.fail(403, 'Account is no longer available.');
      await tx.query('UPDATE cli_logins SET user_id=$1,workspace_id=$2 WHERE user_code=$3', [
        user.id,
        site.workspaceId,
        code,
      ]);
      return { approved: true };
    });
  });
}

/** No cookie fallback. A malformed, unknown, revoked or disabled token fails closed. */
export async function validGatewayToken(db: Database, authorization?: string): Promise<boolean> {
  const token = authorization?.match(/^Bearer (ep_[A-Za-z0-9_-]{43})$/i)?.[1];
  if (!token) return false;
  const row = (
    await db.query<{ user_id: string; workspace_id: string; scope: string }>(
      'SELECT user_id,workspace_id,scope FROM tokens WHERE hash=$1',
      [hash(token)],
    )
  ).rows[0];
  if (!row || !['read', 'write', 'admin'].includes(row.scope)) return false;
  const s = makeStore(db),
    site = await installation(s);
  if (!site || row.workspace_id !== site.workspaceId) return false;
  const user = await workspaceUser(s, row.user_id, row.workspace_id);
  return !!user && !user.disabledAt;
}
