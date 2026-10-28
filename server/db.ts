import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';
import { migrateItemIdentifiers } from './item-identifiers.ts';
import { checkUpgrade, type UpgradeOptions } from './upgrade.ts';
import { existsSync } from 'node:fs';
import { mkdir, open, readFile, unlink } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join, resolve } from 'node:path';

export interface Database {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  transaction<T>(fn: (db: Database) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

const running = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
};
/**
 * PGlite does not stop a second process from opening the same folder, and two writers
 * corrupt it. The lock lives inside the folder, created only once PostgreSQL has
 * initialized it, because PGlite 0.3 refuses to initialize a folder containing files.
 */
const lockedHere = new Set<string>();
async function lockDataDir(dataDir: string): Promise<() => Promise<void>> {
  const path = join(dataDir, 'trestl.lock');
  const owner = `${process.pid} ${hostname()}`;
  // A restarting development server may still be closing; give it a moment.
  const deadline = Date.now() + 5000;
  for (;;) {
    try {
      const handle = await open(path, 'wx', 0o600);
      await handle.writeFile(owner);
      await handle.close();
      lockedHere.add(path);
      return async () => {
        lockedHere.delete(path);
        if ((await readFile(path, 'utf8').catch(() => '')) === owner)
          await unlink(path).catch(() => {});
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const holder = await readFile(path, 'utf8').catch(() => '');
    const [pid, host] = holder.split(' ');
    // An empty lock is still being written by its owner, unless it stays empty. Our own
    // PID can be left over from a crash: containers restart their server as PID 1.
    const stale = holder
      ? host !== hostname() ||
        !(Number(pid) > 0) ||
        (Number(pid) === process.pid ? !lockedHere.has(path) : !running(Number(pid)))
      : Date.now() > deadline;
    if (stale) {
      if ((await readFile(path, 'utf8').catch(() => '')) === holder)
        await unlink(path).catch(() => {});
      continue;
    }
    if (Date.now() > deadline)
      throw new Error(
        `The database in ${dataDir} is in use by process ${pid}. Stop that Trestl process first. ` +
          `If no Trestl process is running, delete ${path}.`,
      );
    await new Promise((accept) => setTimeout(accept, 100));
  }
}

export async function openDatabase(
  options: {
    databaseUrl?: string;
    dataDir?: string;
    initialize?: boolean;
    /** Fail instead of creating an empty PGlite database. */
    mustExist?: boolean;
    /** Checked before migrations; see checkUpgrade. */
    upgrade?: UpgradeOptions;
  } = {},
): Promise<Database> {
  let db: Database;
  let dataDir: string | undefined;
  if (options.databaseUrl) {
    const pool = new pg.Pool({
      connectionString: options.databaseUrl,
      connectionTimeoutMillis: 3000,
    });
    // Idle clients can disconnect during a PostgreSQL restart. pg removes the
    // failed client; handling this event lets the pool reconnect on later queries.
    pool.on('error', () => {
      console.error('PostgreSQL idle connection lost; the pool will reconnect.');
    });
    db = {
      query: async <T>(sql: string, params?: unknown[]) => ({
        rows: (await pool.query(sql, params)).rows as T[],
      }),
      transaction: async (fn) => {
        const client = await pool.connect();
        const tx: Database = {
          query: async <T>(sql: string, params?: unknown[]) => ({
            rows: (await client.query(sql, params)).rows as T[],
          }),
          transaction: async (inner) => inner(tx),
          close: async () => {},
        };
        try {
          await client.query('BEGIN');
          const result = await fn(tx);
          await client.query('COMMIT');
          return result;
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        } finally {
          client.release();
        }
      },
      close: () => pool.end(),
    };
  } else {
    dataDir = options.dataDir === ':memory:' ? undefined : resolve(options.dataDir ?? '.data');
    let unlock: (() => Promise<void>) | undefined;
    const initialized = !!dataDir && existsSync(join(dataDir, 'PG_VERSION'));
    if (dataDir && !initialized && options.mustExist)
      throw new Error(`No Trestl database was found in ${dataDir}.`);
    if (dataDir) await mkdir(dataDir, { recursive: true });
    if (dataDir && initialized) unlock = await lockDataDir(dataDir);
    const engine = new PGlite(dataDir);
    try {
      await engine.waitReady;
      if (dataDir && !unlock) unlock = await lockDataDir(dataDir);
    } catch (error) {
      await unlock?.();
      throw error;
    }
    db = {
      query: async <T>(sql: string, params?: unknown[]) => ({
        rows: (await engine.query<T>(sql, params)).rows,
      }),
      transaction: (fn) =>
        engine.transaction(async (raw) => {
          const tx: Database = {
            query: async <T>(sql: string, params?: unknown[]) => ({
              rows: (await raw.query<T>(sql, params)).rows,
            }),
            transaction: async (inner) => inner(tx),
            close: async () => {},
          };
          return fn(tx);
        }),
      close: async () => {
        try {
          await engine.close();
        } finally {
          await unlock?.();
        }
      },
    };
  }
  if (options.initialize === false) return db;
  if (options.upgrade)
    try {
      await checkUpgrade(db, options.databaseUrl ? 'postgres' : 'pglite', dataDir, options.upgrade);
    } catch (error) {
      await db.close();
      throw error;
    }
  await db.query(
    `CREATE TABLE IF NOT EXISTS entities (collection TEXT NOT NULL, id TEXT NOT NULL, data JSONB NOT NULL, PRIMARY KEY(collection,id))`,
  );
  await db.query(`CREATE INDEX IF NOT EXISTS entities_data_gin ON entities USING GIN(data)`);
  await db.query(
    `CREATE INDEX IF NOT EXISTS entities_workspace ON entities(collection, (COALESCE(data->>'workspaceId','default')))`,
  );
  await db.query(
    `CREATE INDEX IF NOT EXISTS activity_item_date ON entities((data->>'itemId'),(data->>'createdAt')) WHERE collection='activity'`,
  );
  // A database trigger also observes integration writes and direct SQL updates.
  // The counter changes in the writer's transaction, so rolled-back changes
  // never invalidate a successful bootstrap response.
  await db.query(
    `CREATE TABLE IF NOT EXISTS bootstrap_revision (id INTEGER PRIMARY KEY CHECK (id=1), revision BIGINT NOT NULL)`,
  );
  await db.query(`INSERT INTO bootstrap_revision(id,revision) VALUES (1,0) ON CONFLICT DO NOTHING`);
  await db.query(`CREATE OR REPLACE FUNCTION bump_bootstrap_revision() RETURNS trigger AS $$
    BEGIN
      UPDATE bootstrap_revision SET revision=revision+1 WHERE id=1;
      RETURN NULL;
    END;
    $$ LANGUAGE plpgsql`);
  await db.transaction(async (tx) => {
    // Hold the table lock across replacement: another writer must never observe
    // a gap with the invalidation trigger temporarily absent on restart.
    await tx.query(`DROP TRIGGER IF EXISTS entities_bootstrap_revision ON entities`);
    await tx.query(`CREATE TRIGGER entities_bootstrap_revision
      AFTER INSERT OR UPDATE OR DELETE ON entities
      FOR EACH STATEMENT EXECUTE FUNCTION bump_bootstrap_revision()`);
  });
  await db.query(
    `CREATE TABLE IF NOT EXISTS credentials (user_id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, password TEXT NOT NULL)`,
  );
  await db.query(
    `CREATE TABLE IF NOT EXISTS item_images (
      id TEXT PRIMARY KEY,
      creator_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      item_id TEXT,
      mime_type TEXT NOT NULL,
      data BYTEA NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
  );
  await db.query(
    `CREATE TABLE IF NOT EXISTS sessions (hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires_at TIMESTAMPTZ NOT NULL)`,
  );
  await db.query(
    `CREATE TABLE IF NOT EXISTS tokens (id TEXT PRIMARY KEY, hash TEXT UNIQUE NOT NULL, user_id TEXT NOT NULL, name TEXT NOT NULL, scope TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL)`,
  );
  await migrateItemIdentifiers(db);
  return db;
}
export function makeStore(db: Database) {
  return {
    query: <T>(sql: string, params?: unknown[]) => db.query<T>(sql, params),
    async list<T>(collection: string): Promise<T[]> {
      return (
        await db.query<{ data: T }>('SELECT data FROM entities WHERE collection=$1 ORDER BY id', [
          collection,
        ])
      ).rows.map((row) => row.data);
    },
    async listWorkspace<T>(collection: string, workspaceId: string): Promise<T[]> {
      return (
        await db.query<{ data: T }>(
          `SELECT data FROM entities WHERE collection=$1 AND COALESCE(data->>'workspaceId','default')=$2 ORDER BY id`,
          [collection, workspaceId],
        )
      ).rows.map((row) => row.data);
    },
    async get<T>(collection: string, id: string): Promise<T | null> {
      return (
        (
          await db.query<{ data: T }>('SELECT data FROM entities WHERE collection=$1 AND id=$2', [
            collection,
            id,
          ])
        ).rows[0]?.data ?? null
      );
    },
    async put<T extends { id: string }>(
      collection: string,
      entity: T,
      expectedRevision?: number,
    ): Promise<T> {
      if (collection === 'items') {
        const result = await db.query<{ data: T }>(
          `INSERT INTO entities(collection,id,data) VALUES ($1,$2,$3::jsonb || jsonb_build_object('revision',1))
           ON CONFLICT(collection,id) DO UPDATE SET data=EXCLUDED.data || jsonb_build_object('revision',COALESCE((entities.data->>'revision')::integer,0)+1)
           WHERE $4::integer IS NULL OR COALESCE((entities.data->>'revision')::integer,0)=$4
           RETURNING data`,
          [collection, entity.id, JSON.stringify(entity), expectedRevision ?? null],
        );
        if (!result.rows[0])
          throw Object.assign(new Error('Work item changed. Read it again before updating.'), {
            statusCode: 409,
          });
        return result.rows[0].data;
      }
      await db.query(
        'INSERT INTO entities(collection,id,data) VALUES ($1,$2,$3::jsonb) ON CONFLICT(collection,id) DO UPDATE SET data=EXCLUDED.data',
        [collection, entity.id, JSON.stringify(entity)],
      );
      return entity;
    },
    async remove(collection: string, id: string): Promise<void> {
      await db.query('DELETE FROM entities WHERE collection=$1 AND id=$2', [collection, id]);
    },
  };
}
export type Store = ReturnType<typeof makeStore>;
