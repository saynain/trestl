import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { User, Workspace } from '../shared/types.ts';
import { makeStore, type Database } from './db.ts';
import { addMembership, workspaceUser } from './workspaces.ts';

export interface ProxyAuthConfig {
  secret: string;
  provider: string;
  installationId: string;
  installationName: string;
  allowedDomains: string[];
  adminEmails: string[];
  linkExistingEmails: string[];
  origin: string;
}
const deny = (statusCode: number, message: string): never => {
  throw Object.assign(new Error(message), { statusCode });
};
const digest = (value: string) => createHash('sha256').update(value).digest();
const list = (value = '') =>
  value
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
export function proxyAuthConfig(env = process.env): ProxyAuthConfig | null {
  if (!env.AUTH_MODE || env.AUTH_MODE === 'local') return null;
  if (env.AUTH_MODE !== 'proxy') throw new Error('AUTH_MODE must be local or proxy');
  return validateProxyAuth({
    secret: env.PROXY_AUTH_SECRET ?? '',
    provider: env.PROXY_AUTH_PROVIDER ?? 'google',
    installationId: env.PROXY_AUTH_INSTALLATION_ID?.trim() || 'default',
    installationName: env.INSTALLATION_NAME ?? 'Trestl',
    allowedDomains: list(env.PROXY_AUTH_ALLOWED_DOMAINS),
    adminEmails: list(env.PROXY_AUTH_ADMIN_EMAILS),
    linkExistingEmails: list(env.PROXY_AUTH_LINK_EXISTING_EMAILS),
    origin: env.APP_ORIGIN ?? '',
  });
}
export function validateProxyAuth(config: ProxyAuthConfig) {
  if (config.secret.length < 32)
    throw new Error('PROXY_AUTH_SECRET must contain at least 32 characters');
  if (
    !config.allowedDomains.length ||
    config.allowedDomains.some((d) => !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(d))
  )
    throw new Error('PROXY_AUTH_ALLOWED_DOMAINS must explicitly list company domains');
  if (
    !config.adminEmails.length ||
    config.adminEmails.some(
      (email) =>
        !z.email().safeParse(email).success || !config.allowedDomains.includes(email.split('@')[1]),
    )
  )
    throw new Error('PROXY_AUTH_ADMIN_EMAILS must list administrators in the allowed domains');
  if (!config.provider.trim() || !config.installationId.trim() || !config.installationName.trim())
    throw new Error('Proxy provider and installation identity must not be empty');
  const origin = new URL(config.origin);
  if (
    origin.origin !== config.origin ||
    !['https:', 'http:'].includes(origin.protocol) ||
    (origin.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname))
  )
    throw new Error(
      'APP_ORIGIN must be an exact HTTPS origin (HTTP is allowed on loopback for testing)',
    );
  return config;
}

/** External identities are accepted only with the proxy’s secret. */
export async function authenticateProxy(
  request: FastifyRequest,
  db: Database,
  config: ProxyAuthConfig,
): Promise<User | null> {
  const secret = request.headers['x-trestl-proxy-secret'];
  if (typeof secret !== 'string' || !timingSafeEqual(digest(secret), digest(config.secret)))
    return null;
  const subject = request.headers['x-auth-request-user'];
  const emailHeader = request.headers['x-auth-request-email'];
  const nameHeader = request.headers['x-auth-request-preferred-username'];
  if (
    typeof subject !== 'string' ||
    !subject.trim() ||
    subject.length > 255 ||
    /[,\r\n]/.test(subject)
  )
    return deny(401, 'The authentication proxy did not supply a valid user identity');
  if (typeof emailHeader !== 'string' || !z.email().max(254).safeParse(emailHeader).success)
    return deny(401, 'The authentication proxy did not supply a valid email');
  const email = emailHeader.toLowerCase();
  if (!config.allowedDomains.includes(email.split('@')[1]))
    return deny(403, 'This email domain is not allowed');
  // Provider + stable subject, never mutable email, is the account identity.
  const identityId = digest(JSON.stringify([config.provider, subject])).toString('hex');
  // Normal requests only read the current identity and permissions. Serialize provisioning
  // and profile changes, not every task read/write in the installation.
  const currentStore = makeStore(db);
  const binding = await currentStore.get<{ id: string; userId: string }>(
    'proxyIdentities',
    identityId,
  );
  if (binding) {
    const current = await workspaceUser(currentStore, binding.userId, config.installationId);
    if (!current) return deny(403, 'Your account does not have access to this installation');
    if (current.disabledAt) return deny(403, 'Your Trestl account is disabled');
    const name =
      typeof nameHeader === 'string' && nameHeader.trim()
        ? nameHeader.trim().slice(0, 120)
        : current.name;
    if (current.email === email && current.name === name) return current;
  }
  return db.transaction(async (tx) => {
    await tx.query(
      "SELECT id FROM entities WHERE collection='system' AND id='mutation-lock' FOR UPDATE",
    );
    const store = makeStore(tx);
    const identity = await store.get<{ id: string; userId: string }>('proxyIdentities', identityId);
    let user = identity ? await store.get<User>('users', identity.userId) : null;
    if (identity && !user) return deny(403, 'This account is no longer available');
    const existing = (await store.list<User>('users')).find(
      (u) => u.email.toLowerCase() === email && u.id !== user?.id,
    );
    if (!identity && existing) {
      if (!config.linkExistingEmails.includes(email))
        return deny(
          409,
          'An account with this email already exists. An administrator must explicitly link it before proxy sign-in.',
        );
      if (
        (await store.list<{ id: string; userId: string }>('proxyIdentities')).some(
          (i) => i.userId === existing.id,
        )
      )
        return deny(409, 'This account is already linked to another external identity');
      user = existing;
    } else if (existing) return deny(409, 'This email is already used by another account');
    if (user?.disabledAt) return deny(403, 'Your Trestl account is disabled');
    let installation = await store.get<Workspace>('workspaces', config.installationId);
    if (installation && installation.kind !== 'shared')
      return deny(409, 'The configured installation must be a shared workspace');
    if (!installation) return deny(403, 'Complete installation setup first');
    const isNew = !user;
    user ??= {
      id: randomUUID(),
      email,
      name: email.split('@')[0],
      role: 'member',
      color: '#7c9b87',
      workspaceId: config.installationId,
    };
    if (isNew) {
      await addMembership(
        store,
        installation.id,
        user.id,
        config.adminEmails.includes(email) ? 'admin' : 'member',
      );
    }
    // Existing accounts must already belong; removed members are never silently re-enrolled.
    if (!isNew && !(await workspaceUser(store, user.id, installation.id)))
      return deny(403, 'Your account does not have access to this installation');
    const updated: User = {
      ...user,
      email,
      name:
        typeof nameHeader === 'string' && nameHeader.trim()
          ? nameHeader.trim().slice(0, 120)
          : user.name,
    };
    await store.put('users', updated);
    if (!identity) await store.put('proxyIdentities', { id: identityId, userId: user.id });
    if (user.email !== email)
      await tx.query('UPDATE credentials SET email=$1 WHERE user_id=$2', [email, user.id]);
    return (await workspaceUser(store, user.id, installation.id))!;
  });
}
