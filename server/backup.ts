import { createHash, createHmac } from 'node:crypto';
import { once } from 'node:events';
import { createWriteStream } from 'node:fs';
import { access, mkdir, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { pipeline, type Readable, type Writable } from 'node:stream';
import { pipeline as pipelineAsync } from 'node:stream/promises';
import { StringDecoder } from 'node:string_decoder';
import { createGunzip, createGzip } from 'node:zlib';
import { z } from 'zod';
import type { Database } from './db.ts';
import { compareVersions } from './version.ts';

/**
 * An installation backup is a gzip-compressed stream of JSON lines: a header, then each
 * table's definition and rows, then a footer with counts and SHA-256 digests. It is a
 * logical copy, so it restores into PGlite or PostgreSQL of any supported major version.
 */
export const backupExtension = '.trestl-backup';
const formatVersion = 1;
type Engine = 'pglite' | 'postgres';
const header = z.object({
  format: z.literal('trestl-backup'),
  formatVersion: z.number().int(),
  createdAt: z.string(),
  createdBy: z.object({ version: z.string(), commit: z.string().nullable() }),
  database: z.object({
    engine: z.enum(['pglite', 'postgres']),
    server: z.string(),
    /** The Trestl version that last migrated this database; null before it was recorded. */
    version: z.string().nullable(),
  }),
  secretCheck: z.string().nullable(),
});
export type BackupHeader = z.infer<typeof header>;
const identifier = z.string().min(1).max(63);
const table = z.object({
  name: identifier,
  columns: z
    .array(
      z.object({
        name: identifier,
        type: z.string().regex(/^[a-z][a-z0-9 _(),[\]]*$/),
        notNull: z.boolean(),
        default: z.string().nullable(),
      }),
    )
    .min(1),
  constraints: z.array(
    z.object({
      name: identifier,
      type: z.enum(['p', 'u', 'c', 'f', 'x']),
      definition: z.string().regex(/^(PRIMARY KEY|UNIQUE|CHECK|FOREIGN KEY|EXCLUDE)\b/),
    }),
  ),
  indexes: z.array(
    z.object({ name: identifier, definition: z.string().regex(/^CREATE (UNIQUE )?INDEX /) }),
  ),
});
type TableSchema = z.infer<typeof table>;
const tableEnd = z.object({ name: identifier, rows: z.number().int(), sha256: z.string() });
const end = z.object({ tables: z.number().int(), rows: z.number().int(), sha256: z.string() });
export interface BackupSummary {
  header: BackupHeader;
  tables: Record<string, number>;
  rows: number;
}

const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
// Text is every type's lossless interchange format; fix the settings that shape it.
const sessionSettings = [
  "SET LOCAL DateStyle = 'ISO, YMD'",
  "SET LOCAL IntervalStyle = 'postgres'",
  "SET LOCAL TimeZone = 'UTC'",
  'SET LOCAL extra_float_digits = 3',
  "SET LOCAL bytea_output = 'hex'",
];

/** A keyed digest proves which APP_SECRET encrypted the credentials without storing it. */
export function secretCheck(secret: string | undefined): string | null {
  if (!secret || secret.length < 32) return null;
  const key = createHash('sha256').update(secret).digest();
  return createHmac('sha256', key).update('trestl-backup-secret-check-v1').digest('base64url');
}

export async function installationVersion(db: Database): Promise<string | null> {
  const exists = (
    await db.query<{ name: string | null }>(`SELECT to_regclass('public.entities')::text AS name`)
  ).rows[0]?.name;
  if (!exists) return null;
  return (
    (
      await db.query<{ version: string | null }>(
        `SELECT data->>'version' AS version FROM entities WHERE collection='system' AND id='installation-version'`,
      )
    ).rows[0]?.version ?? null
  );
}

async function readSchema(db: Database): Promise<(TableSchema & { key: string[] })[]> {
  const tables = (
    await db.query<{ oid: string; name: string }>(
      `SELECT c.oid::text AS oid, c.relname AS name FROM pg_class c
       JOIN pg_namespace n ON n.oid=c.relnamespace
       WHERE n.nspname='public' AND c.relkind='r' ORDER BY c.relname`,
    )
  ).rows;
  const result = [];
  for (const { oid, name } of tables) {
    const columns = (
      await db.query<{
        name: string;
        type: string;
        notNull: boolean;
        default: string | null;
        generated: boolean;
      }>(
        `SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type,
           a.attnotnull AS "notNull", pg_get_expr(d.adbin, d.adrelid) AS "default",
           (a.attidentity <> '' OR a.attgenerated <> '') AS generated
         FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
         WHERE a.attrelid=$1::oid AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum`,
        [oid],
      )
    ).rows;
    // Fail loudly instead of writing a backup that cannot be restored faithfully.
    for (const column of columns)
      if (column.generated || /\bnextval\(/.test(column.default ?? ''))
        throw new Error(
          `Backups do not support sequence or generated column ${name}.${column.name}`,
        );
    const constraints = (
      await db.query<{ name: string; type: 'p' | 'u' | 'c' | 'f' | 'x'; definition: string }>(
        `SELECT conname AS name, contype::text AS type, pg_get_constraintdef(oid) AS definition
         FROM pg_constraint WHERE conrelid=$1::oid AND contype IN ('p','u','c','f','x')
         ORDER BY contype, conname`,
        [oid],
      )
    ).rows;
    const indexes = (
      await db.query<{ name: string; definition: string }>(
        `SELECT i.relname AS name, pg_get_indexdef(x.indexrelid) AS definition
         FROM pg_index x JOIN pg_class i ON i.oid=x.indexrelid
         WHERE x.indrelid=$1::oid
           AND NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conindid=x.indexrelid)
         ORDER BY i.relname`,
        [oid],
      )
    ).rows;
    const key = (
      await db.query<{ name: string }>(
        `SELECT a.attname AS name FROM pg_index x
         CROSS JOIN LATERAL unnest(x.indkey::int2[]) WITH ORDINALITY AS k(attnum, position)
         JOIN pg_attribute a ON a.attrelid=x.indrelid AND a.attnum=k.attnum
         WHERE x.indrelid=$1::oid AND x.indisprimary ORDER BY k.position`,
        [oid],
      )
    ).rows.map((row) => row.name);
    const schema = table.safeParse({
      name,
      columns: columns.map(({ generated: _, ...column }) => column),
      constraints,
      indexes,
    });
    if (!schema.success) throw new Error(`Backups do not support the definition of table ${name}`);
    result.push({ ...schema.data, key });
  }
  return result;
}

/** Stream a consistent snapshot of every table in the public schema. */
export async function writeBackup(
  db: Database,
  output: Writable,
  info: {
    engine: Engine;
    createdBy: { version: string; commit: string | null };
    secret?: string;
  },
): Promise<BackupSummary> {
  const gzip = createGzip();
  const written = pipelineAsync(gzip, output);
  // Surface a failed destination (for example a full disk) instead of waiting forever.
  written.catch(() => {});
  const overall = createHash('sha256');
  async function emit(value: unknown, ...hashes: ReturnType<typeof createHash>[]) {
    const line = JSON.stringify(value) + '\n';
    for (const hash of hashes) hash.update(line);
    if (!gzip.write(line)) await Promise.race([once(gzip, 'drain'), written]);
  }
  let summary: BackupSummary;
  try {
    summary = await db.transaction(async (tx) => {
      await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
      for (const setting of sessionSettings) await tx.query(setting);
      const backupHeader: BackupHeader = {
        format: 'trestl-backup',
        formatVersion,
        createdAt: new Date().toISOString(),
        createdBy: info.createdBy,
        database: {
          engine: info.engine,
          server: (await tx.query<{ version: string }>('SELECT version() AS version')).rows[0]!
            .version,
          version: await installationVersion(tx),
        },
        secretCheck: secretCheck(info.secret),
      };
      await emit(backupHeader, overall);
      const tables: Record<string, number> = {};
      let total = 0;
      for (const { key, ...schema } of await readSchema(tx)) {
        await emit({ table: schema }, overall);
        const digest = createHash('sha256');
        const columns = schema.columns
          .map((c, i) =>
            c.type === 'bytea'
              ? `encode(${quote(c.name)}, 'base64') AS c${i}`
              : `${quote(c.name)}::text AS c${i}`,
          )
          .join(', ');
        const types = new Map(schema.columns.map((c) => [c.name, c.type]));
        const keyed = key.length > 0 && key.every((k) => types.get(k) !== 'bytea');
        const order = keyed
          ? key.map(quote).join(', ')
          : schema.columns.map((_, i) => i + 1).join(', ');
        const limit = schema.columns.some((c) => c.type === 'bytea') ? 16 : 500;
        let count = 0;
        let last: (string | null)[] | null = null;
        for (;;) {
          // Keyset pagination keeps large tables linear; the snapshot keeps pages consistent.
          const where: string =
            keyed && last
              ? `WHERE (${key.map(quote).join(', ')}) > (${key
                  .map((k, i) => `$${i + 1}::${types.get(k)}`)
                  .join(', ')})`
              : '';
          const { rows }: { rows: Record<string, string | null>[] } = await tx.query(
            `SELECT ${columns} FROM ${quote(schema.name)} ${where} ORDER BY ${order} LIMIT ${limit}${
              keyed ? '' : ` OFFSET ${count}`
            }`,
            keyed && last ? last : [],
          );
          for (const row of rows) {
            const values = schema.columns.map((_, i) => row[`c${i}`] ?? null);
            await emit(values, overall, digest);
          }
          count += rows.length;
          if (rows.length < limit) break;
          const final: Record<string, string | null> = rows.at(-1)!;
          last = key.map(
            (k): string | null => final[`c${schema.columns.findIndex((c) => c.name === k)}`],
          );
        }
        await emit(
          { tableEnd: { name: schema.name, rows: count, sha256: digest.digest('hex') } },
          overall,
        );
        tables[schema.name] = count;
        total += count;
      }
      await emit({
        end: { tables: Object.keys(tables).length, rows: total, sha256: overall.digest('hex') },
      });
      return { header: backupHeader, tables, rows: total };
    });
  } catch (error) {
    // Close the destination before the caller removes an incomplete file.
    gzip.destroy();
    await written.catch(() => {});
    throw error;
  }
  gzip.end();
  await written;
  return summary;
}

/** Write to a temporary name first, so an interrupted backup never looks complete. */
export async function writeBackupFile(
  db: Database,
  path: string,
  info: Parameters<typeof writeBackup>[2],
): Promise<BackupSummary> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  try {
    await access(path);
    throw Object.assign(new Error(`Backup file already exists: ${path}`), { code: 'EEXIST' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const partial = `${path}.partial`;
  try {
    const summary = await writeBackup(
      db,
      createWriteStream(partial, { flags: 'wx', mode: 0o600, flush: true }),
      info,
    );
    await rename(partial, path);
    return summary;
  } catch (error) {
    await unlink(partial).catch(() => {});
    throw error;
  }
}

export function backupFileName(version: string | null, date = new Date(), suffix = '') {
  const stamp = date
    .toISOString()
    .replace(/\.\d+Z$/, 'Z')
    .replaceAll(/[-:]/g, '')
    .replace('T', '-');
  return `trestl-${stamp}-${version ?? 'unknown'}${suffix}${backupExtension}`;
}

class BackupError extends Error {}
function invalid(message: string): never {
  throw new BackupError(`Invalid backup: ${message}`);
}

async function* lines(input: Readable): AsyncGenerator<string> {
  // Errors from the source or decompression end the iteration with that error.
  const gunzip = pipeline(input, createGunzip(), () => {});
  const decoder = new StringDecoder('utf8');
  let buffered = '';
  try {
    for await (const chunk of gunzip) {
      buffered += decoder.write(chunk as Buffer);
      let index;
      while ((index = buffered.indexOf('\n')) >= 0) {
        yield buffered.slice(0, index);
        buffered = buffered.slice(index + 1);
      }
    }
  } catch (error) {
    if (!String((error as NodeJS.ErrnoException).code).startsWith('Z_')) throw error;
    invalid(`the file is incomplete or damaged (${(error as Error).message}).`);
  }
  buffered += decoder.end();
  if (buffered) invalid('the file ends in the middle of a record.');
}

/** Validate the complete stream; handlers run for each record in order. */
export async function readBackup(
  input: Readable,
  handlers: {
    header?: (header: BackupHeader) => void | Promise<void>;
    table?: (schema: TableSchema) => void | Promise<void>;
    row?: (schema: TableSchema, values: (string | null)[]) => void | Promise<void>;
    tableEnd?: (schema: TableSchema, rows: number) => void | Promise<void>;
  } = {},
): Promise<BackupSummary> {
  const overall = createHash('sha256');
  let parsedHeader: BackupHeader | undefined;
  let current: { schema: TableSchema; rows: number; digest: ReturnType<typeof createHash> } | null =
    null;
  const tables: Record<string, number> = {};
  let total = 0;
  let finished = false;
  for await (const line of lines(input)) {
    if (finished) invalid('data follows the end of the backup.');
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      invalid('a record is not valid JSON.');
    }
    if (!parsedHeader) {
      const candidate = record as { format?: unknown; formatVersion?: unknown };
      if (candidate?.format !== 'trestl-backup') invalid('this is not a Trestl backup.');
      if (typeof candidate.formatVersion === 'number' && candidate.formatVersion > formatVersion)
        throw new BackupError(
          'This backup was written by a newer Trestl release. Upgrade Trestl to restore it.',
        );
      const result = header.safeParse(record);
      if (!result.success || result.data.formatVersion !== formatVersion)
        invalid('the header is not supported.');
      parsedHeader = result.data;
      overall.update(line + '\n');
      await handlers.header?.(parsedHeader);
      continue;
    }
    if (Array.isArray(record)) {
      if (!current) invalid('a row appears outside a table.');
      if (
        record.length !== current.schema.columns.length ||
        !record.every((value) => value === null || typeof value === 'string')
      )
        invalid(`a row in ${current.schema.name} does not match its columns.`);
      overall.update(line + '\n');
      current.digest.update(line + '\n');
      current.rows++;
      await handlers.row?.(current.schema, record);
      continue;
    }
    const entry = record as { table?: unknown; tableEnd?: unknown; end?: unknown };
    if (entry.table !== undefined) {
      if (current) invalid(`table ${current.schema.name} has no end record.`);
      const parsed = table.safeParse(entry.table);
      if (!parsed.success) invalid('a table definition is not supported.');
      if (Object.hasOwn(tables, parsed.data.name))
        invalid(`table ${parsed.data.name} appears twice.`);
      current = { schema: parsed.data, rows: 0, digest: createHash('sha256') };
      overall.update(line + '\n');
      await handlers.table?.(current.schema);
    } else if (entry.tableEnd !== undefined) {
      const parsed = tableEnd.safeParse(entry.tableEnd);
      if (!current || !parsed.success || parsed.data.name !== current.schema.name)
        invalid('a table end record is misplaced.');
      if (parsed.data.rows !== current.rows || parsed.data.sha256 !== current.digest.digest('hex'))
        invalid(`the rows of ${current.schema.name} are incomplete or damaged.`);
      overall.update(line + '\n');
      await handlers.tableEnd?.(current.schema, current.rows);
      tables[current.schema.name] = current.rows;
      total += current.rows;
      current = null;
    } else if (entry.end !== undefined) {
      const parsed = end.safeParse(entry.end);
      if (current || !parsed.success) invalid('the end record is misplaced.');
      if (
        parsed.data.tables !== Object.keys(tables).length ||
        parsed.data.rows !== total ||
        parsed.data.sha256 !== overall.digest('hex')
      )
        invalid('the contents are incomplete or damaged.');
      finished = true;
    } else invalid('a record has an unknown type.');
  }
  if (!parsedHeader) invalid('the file is empty.');
  if (!finished) invalid('the file is incomplete. It may have been truncated.');
  return { header: parsedHeader, tables, rows: total };
}

export type SecretStatus = 'matches' | 'differs' | 'missing' | 'not-recorded';
export function secretStatus(backup: BackupHeader, secret: string | undefined): SecretStatus {
  if (!backup.secretCheck) return 'not-recorded';
  const current = secretCheck(secret);
  if (!current) return 'missing';
  return current === backup.secretCheck ? 'matches' : 'differs';
}

/**
 * Restore into a database without any tables, in one transaction: a damaged or
 * incompatible backup leaves the target unchanged. The next server start applies the
 * usual migrations from the backed-up version.
 */
export async function restoreBackup(
  db: Database,
  input: Readable,
  options: { appVersion: string; secret?: string; allowSecretMismatch?: boolean },
): Promise<BackupSummary> {
  return db.transaction(async (tx) => {
    for (const setting of sessionSettings) await tx.query(setting);
    const existing = (
      await tx.query<{ name: string }>(
        `SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
         WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','S','f') LIMIT 1`,
      )
    ).rows[0];
    if (existing)
      throw new BackupError(
        `The target database is not empty (it contains ${existing.name}). Restore into a new, empty database.`,
      );
    let batch: (string | null)[][] = [];
    let batchSize = 0;
    const deferred: string[] = [];
    async function flush(schema: TableSchema) {
      if (!batch.length) return;
      const width = schema.columns.length;
      const values = batch
        .map(
          (_, row) =>
            `(${schema.columns
              .map((c, i) =>
                c.type === 'bytea'
                  ? `decode($${row * width + i + 1}, 'base64')`
                  : `$${row * width + i + 1}::${c.type}`,
              )
              .join(', ')})`,
        )
        .join(', ');
      await tx.query(
        `INSERT INTO ${quote(schema.name)} (${schema.columns.map((c) => quote(c.name)).join(', ')}) VALUES ${values}`,
        batch.flat(),
      );
      batch = [];
      batchSize = 0;
    }
    return readBackup(input, {
      header(backup) {
        const version = backup.database.version;
        if (version && compareVersions(version, options.appVersion) === 1)
          throw new BackupError(
            `This backup comes from Trestl ${version}, which is newer than this Trestl ${options.appVersion}. Restore it with Trestl ${version} or later.`,
          );
        const secret = secretStatus(backup, options.secret);
        if ((secret === 'differs' || secret === 'missing') && !options.allowSecretMismatch)
          throw new BackupError(
            secret === 'missing'
              ? 'Set APP_SECRET to the value used by the backed-up installation. Its integration credentials cannot be decrypted without it.'
              : 'APP_SECRET differs from the backed-up installation, so its integration credentials could not be decrypted. Use the original APP_SECRET.',
          );
      },
      async table(schema) {
        const definitions = [
          ...schema.columns.map(
            (c) =>
              `${quote(c.name)} ${c.type}${c.notNull ? ' NOT NULL' : ''}${
                c.default === null ? '' : ` DEFAULT ${c.default}`
              }`,
          ),
          ...schema.constraints
            .filter((c) => c.type !== 'f')
            .map((c) => `CONSTRAINT ${quote(c.name)} ${c.definition}`),
        ];
        await tx.query(`CREATE TABLE ${quote(schema.name)} (${definitions.join(', ')})`);
        // References and secondary indexes are cheaper and order-independent after loading.
        for (const c of schema.constraints.filter((c) => c.type === 'f'))
          deferred.push(
            `ALTER TABLE ${quote(schema.name)} ADD CONSTRAINT ${quote(c.name)} ${c.definition}`,
          );
        for (const index of schema.indexes) deferred.push(index.definition);
      },
      async row(schema, values) {
        batch.push(values);
        batchSize += values.reduce((sum, value) => sum + (value?.length ?? 0), 0);
        if (batch.length * schema.columns.length >= 2000 || batchSize >= 4 * 1024 * 1024)
          await flush(schema);
      },
      async tableEnd(schema, rows) {
        await flush(schema);
        const count = (
          await tx.query<{ count: string }>(
            `SELECT count(*)::text AS count FROM ${quote(schema.name)}`,
          )
        ).rows[0]!.count;
        if (Number(count) !== rows)
          throw new BackupError(`Restored ${count} of ${rows} rows into ${schema.name}.`);
      },
    }).then(async (summary) => {
      for (const statement of deferred) await tx.query(statement);
      return summary;
    });
  });
}
export const isBackupError = (error: unknown) => error instanceof BackupError;
