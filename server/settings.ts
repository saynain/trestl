import { randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

/** A deployment value Trestl cannot safely run with. The message is shown to the operator. */
export class SettingsError extends Error {}

type Env = Record<string, string | undefined>;
export type DatabaseSetting =
  | { kind: 'postgres'; url: string; description: string }
  | { kind: 'pglite'; dataDir: string; description: string; secretFile?: string };
export interface ServerSettings {
  port: number;
  host: string;
  origin?: string;
  database: DatabaseSetting;
  warnings: string[];
}

const loopback = ['localhost', '127.0.0.1', '[::1]'];
const originHint =
  'Use the address people open in their browser, such as https://projects.example.com, or leave it unset.';
// Never echo a value that may embed credentials.
const shown = (value: string) =>
  value.includes('@') ? 'the configured value' : JSON.stringify(value);

/** Normalizes APP_ORIGIN to scheme://host[:port]. Empty means "derive from each request". */
export function appOrigin(value: string | undefined): string | undefined {
  const raw = value?.trim();
  if (!raw) return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SettingsError(`APP_ORIGIN ${shown(raw)} is not a URL. ${originHint}`);
  }
  if (!['http:', 'https:'].includes(url.protocol))
    throw new SettingsError(`APP_ORIGIN must start with https:// or http://. ${originHint}`);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/')
    throw new SettingsError(
      `APP_ORIGIN ${shown(raw)} must contain only a scheme, host and optional port, without a path. ${originHint}`,
    );
  return url.origin;
}

/** Reads an optional on/off setting, rejecting values that would otherwise be guessed. */
export function flag(env: Env, name: string): boolean | undefined {
  const value = env[name]?.trim().toLowerCase();
  if (!value) return undefined;
  if (['true', '1', 'yes', 'on'].includes(value)) return true;
  if (['false', '0', 'no', 'off'].includes(value)) return false;
  throw new SettingsError(`${name} must be true or false, or unset.`);
}

/**
 * Session cookies are Secure when the browser reaches Trestl over HTTPS. An HTTPS
 * APP_ORIGIN always means Secure: the origin check already rejects changes from any
 * other address. Otherwise SECURE_COOKIES decides, then APP_ORIGIN's scheme, then each
 * request's own scheme, so plain-HTTP trials on a LAN address keep their session.
 */
export function cookieSecurity(env: Env = process.env): boolean | 'request' {
  const origin = appOrigin(env.APP_ORIGIN);
  if (origin?.startsWith('https:')) return true;
  return flag(env, 'SECURE_COOKIES') ?? (origin ? false : 'request');
}

function database(env: Env): DatabaseSetting {
  const url = env.DATABASE_URL?.trim();
  if (url) {
    let description = 'the server in DATABASE_URL';
    try {
      const parsed = new URL(url);
      description = `${parsed.hostname}:${parsed.port || '5432'}${parsed.pathname}`;
    } catch {
      /* pg also accepts forms that URL cannot parse; it reports its own errors. */
    }
    return { kind: 'postgres', url, description };
  }
  const dir = env.DATA_DIR?.trim() || '.data';
  if (dir === ':memory:') return { kind: 'pglite', dataDir: dir, description: 'memory' };
  const dataDir = resolve(dir);
  // Beside, not inside, the database folder: upgrades and restores replace that folder.
  return { kind: 'pglite', dataDir, description: dataDir, secretFile: `${dataDir}-app-secret` };
}

/** Validates deployment settings before startup so mistakes fail early with a clear message. */
export function readSettings(env: Env = process.env): ServerSettings {
  const warnings: string[] = [];
  const rawPort = env.PORT?.trim() || '4317';
  const port = Number(rawPort);
  if (!/^\d+$/.test(rawPort) || port < 1 || port > 65535)
    throw new SettingsError(`PORT must be a whole number from 1 to 65535; got ${shown(rawPort)}.`);
  const origin = appOrigin(env.APP_ORIGIN);
  flag(env, 'SECURE_COOKIES'); // Reject a malformed value even where an HTTPS origin decides.
  const secure = cookieSecurity(env);
  if (
    secure === true &&
    origin?.startsWith('http:') &&
    !loopback.includes(new URL(origin).hostname)
  )
    warnings.push(
      `SECURE_COOKIES is true but APP_ORIGIN uses plain HTTP, so browsers will drop the sign-in cookie. Serve Trestl over HTTPS or unset SECURE_COOKIES.`,
    );
  const db = database(env);
  const secret = env.APP_SECRET ?? '';
  if (secret && secret.length < 32)
    warnings.push(
      `APP_SECRET has ${secret.length} characters; Git and sign-in provider credentials need at least 32. Generate one with: openssl rand -hex 32`,
    );
  else if (!secret && db.kind === 'postgres')
    warnings.push(
      'APP_SECRET is not set, so Git and sign-in provider credentials cannot be stored. Generate one with: openssl rand -hex 32',
    );
  const interval = env.INTEGRATION_SYNC_INTERVAL_MS?.trim();
  if (interval && interval !== '0' && !(Number(interval) >= 60_000))
    warnings.push(
      `INTEGRATION_SYNC_INTERVAL_MS ${shown(interval)} is below 60000, so periodic repository sync is off.`,
    );
  return { port, host: env.HOST?.trim() || '127.0.0.1', origin, database: db, warnings };
}

/**
 * Keeps a generated encryption key beside PGlite data, as the desktop app does, so a
 * single-container trial can store Git credentials without extra configuration. A
 * configured APP_SECRET always wins.
 */
export async function storedAppSecret(path: string, configured: string | undefined) {
  const saved = () => readFile(path, 'utf8').then((value) => value.trim());
  if (configured) {
    const existing = await saved().catch(() => undefined);
    return {
      path,
      secret: configured,
      created: false,
      mismatch: !!existing && existing !== configured,
    };
  }
  let created = true;
  try {
    await writeFile(path, randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST')
      throw new SettingsError(
        `Trestl could not save a generated key at ${path} (${(error as Error).message}). Make that folder writable, or set APP_SECRET.`,
      );
    created = false;
  }
  const secret = await saved();
  if (secret.length < 32)
    throw new SettingsError(`${path} is invalid. Restore it from a backup, or set APP_SECRET.`);
  return { path, secret, created, mismatch: false };
}

const connectionCodes = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  '28P01', // wrong password
  '28000', // role not allowed to connect
  '3D000', // database does not exist
]);
/** Explains a PostgreSQL connection failure at startup; other errors keep their stack trace. */
export function databaseConnectionError(error: unknown, db: DatabaseSetting): string | undefined {
  if (db.kind !== 'postgres') return;
  const { code, message } = error as { code?: string; message?: string };
  if (!connectionCodes.has(code ?? '') && !/connection (timeout|terminated)/i.test(message ?? ''))
    return;
  return `Trestl cannot connect to PostgreSQL at ${db.description}: ${message || code}. Check DATABASE_URL and that the database is running and reachable from Trestl.`;
}
