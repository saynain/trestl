import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';
import { migrateItemIdentifiers } from './item-identifiers.ts';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

export interface Database {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  transaction<T>(fn: (db: Database) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}
export async function openDatabase(
  options: { databaseUrl?: string; dataDir?: string } = {},
): Promise<Database> {
  let db: Database;
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
    const dataDir =
      options.dataDir === ':memory:' ? undefined : resolve(options.dataDir ?? '.data');
    if (dataDir) await mkdir(dataDir, { recursive: true });
    const engine = new PGlite(dataDir);
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
      close: () => engine.close(),
    };
  }
  await db.query(
    `CREATE TABLE IF NOT EXISTS entities (collection TEXT NOT NULL, id TEXT NOT NULL, data JSONB NOT NULL, PRIMARY KEY(collection,id))`,
  );
  await db.query(`CREATE INDEX IF NOT EXISTS entities_data_gin ON entities USING GIN(data)`);
  await db.query(
    `CREATE TABLE IF NOT EXISTS credentials (user_id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, password TEXT NOT NULL)`,
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
