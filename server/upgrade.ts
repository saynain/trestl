import { join } from 'node:path';
import { backupFileName, writeBackupFile } from './backup.ts';
import type { Database } from './db.ts';
import { compareVersions } from './version.ts';

export interface UpgradeOptions {
  version: string;
  /** Resolved only when a backup is written; reading git metadata is otherwise unnecessary. */
  commit?: () => string | null;
  /** Where pre-upgrade backups go. PGlite defaults to a folder beside its data folder. */
  backupDir?: string | null;
  secret?: string;
  log?: { info(message: string): void; warn(message: string): void };
}

/**
 * Runs before any migration. A newer release backs up existing data first; an older
 * release refuses to open data that a newer one has already migrated.
 */
export async function checkUpgrade(
  db: Database,
  engine: 'pglite' | 'postgres',
  dataDir: string | undefined,
  options: UpgradeOptions,
): Promise<string | null> {
  const log = options.log ?? { info: console.error, warn: console.warn };
  const exists = (
    await db.query<{ name: string | null }>(`SELECT to_regclass('public.entities')::text AS name`)
  ).rows[0]?.name;
  if (!exists) return null;
  const recorded =
    (
      await db.query<{ version: string | null }>(
        `SELECT data->>'version' AS version FROM entities WHERE collection='system' AND id='installation-version'`,
      )
    ).rows[0]?.version ?? null;
  if (recorded === options.version) return null;
  if (recorded && compareVersions(recorded, options.version) === 1)
    throw new Error(
      `This database was last used by Trestl ${recorded}, which is newer than this Trestl ${options.version}. ` +
        `Running an older release could damage its data. Install Trestl ${recorded} or later, ` +
        'or restore a backup taken before the upgrade into a new database.',
    );
  const from = recorded ? `Trestl ${recorded}` : 'an earlier Trestl release';
  const directory =
    options.backupDir || (engine === 'pglite' && dataDir ? `${dataDir}-backups` : null);
  if (!directory) {
    log.warn(
      `Upgrading this database from ${from} to ${options.version} without an automatic backup. ` +
        'Set BACKUP_DIR to a persistent folder to back up before each upgrade.',
    );
    return null;
  }
  const path = join(directory, backupFileName(recorded, new Date(), `-before-${options.version}`));
  try {
    const summary = await writeBackupFile(db, path, {
      engine,
      createdBy: { version: options.version, commit: options.commit?.() ?? null },
      secret: options.secret,
    });
    log.info(
      `Backed up ${summary.rows} rows to ${path} before upgrading from ${from} to ${options.version}.`,
    );
  } catch (error) {
    throw new Error(
      `The pre-upgrade backup to ${path} failed, so the upgrade did not start and your data is unchanged. ` +
        `Make sure the folder is writable and has free space, or set BACKUP_DIR. Cause: ${
          (error as Error).message
        }`,
      { cause: error },
    );
  }
  return path;
}

/** Recorded after every startup migration has succeeded. */
export async function recordInstallationVersion(db: Database, version: string) {
  await db.query(
    `INSERT INTO entities(collection,id,data) VALUES ('system','installation-version',$1::jsonb)
     ON CONFLICT(collection,id) DO UPDATE SET data=EXCLUDED.data
     WHERE entities.data->>'version' IS DISTINCT FROM EXCLUDED.data->>'version'`,
    [JSON.stringify({ id: 'installation-version', version, recordedAt: new Date().toISOString() })],
  );
}
