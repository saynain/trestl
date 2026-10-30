import { join } from 'node:path';
import { backupFileName, unusedBackupPath, writeBackupFile } from './backup.ts';
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
/** Stored as the `system/installation-version` entity. */
export interface Marker {
  id: 'installation-version';
  /** The release that last finished migrating this database; null before it was recorded. */
  version: string | null;
  recordedAt?: string;
  /** Set from the pre-upgrade backup until every migration has succeeded. */
  upgrade?: { to: string; backup: string | null; startedAt: string };
}

/** The marker, or `undefined` when the database has no Trestl tables yet. */
export async function readMarker(db: Database): Promise<Marker | null | undefined> {
  const exists = (
    await db.query<{ name: string | null }>(`SELECT to_regclass('entities')::text AS name`)
  ).rows[0]?.name;
  if (!exists) return undefined;
  return (
    (
      await db.query<{ data: Marker }>(
        `SELECT data FROM entities WHERE collection='system' AND id='installation-version'`,
      )
    ).rows[0]?.data ?? null
  );
}

/** Never let a release open data that a newer one has migrated, or started to. */
export function refuseNewerData(marker: Marker | null, version: string) {
  const recorded = marker?.version;
  const pending = marker?.upgrade;
  if (recorded && compareVersions(recorded, version) === 1)
    throw new Error(
      `This database was last used by Trestl ${recorded}, which is newer than this Trestl ${version}. ` +
        `Running an older release could damage its data. Install Trestl ${recorded} or later, ` +
        'or restore a backup taken before the upgrade into a new database.',
    );
  if (pending && compareVersions(pending.to, version) === 1)
    throw new Error(
      `An upgrade to Trestl ${pending.to} started on this database and did not finish. ` +
        `Running Trestl ${version} could damage its data. Start Trestl ${pending.to} again, ` +
        (pending.backup
          ? `or restore ${pending.backup} into a new database.`
          : 'or restore a backup taken before the upgrade into a new database.'),
    );
}

export async function markUpgradeStarted(
  db: Database,
  marker: Marker | null,
  version: string,
  backup: string | null,
) {
  const started: Marker = {
    ...marker,
    id: 'installation-version',
    version: marker?.version ?? null,
    upgrade: {
      to: version,
      backup,
      startedAt: marker?.upgrade?.startedAt ?? new Date().toISOString(),
    },
  };
  await db.query(
    `INSERT INTO entities(collection,id,data) VALUES ('system','installation-version',$1::jsonb)
     ON CONFLICT(collection,id) DO UPDATE SET data=EXCLUDED.data`,
    [JSON.stringify(started)],
  );
}

/**
 * Runs before any migration. A newer release backs up existing data once, then marks the
 * upgrade as started; an older release refuses data that a newer one has started to migrate.
 */
export async function checkUpgrade(
  db: Database,
  engine: 'pglite' | 'postgres',
  dataDir: string | undefined,
  options: UpgradeOptions,
): Promise<string | null> {
  const log = options.log ?? { info: console.error, warn: console.warn };
  const marker = await readMarker(db);
  if (marker === undefined) return null;
  const recorded = marker?.version ?? null;
  const pending = marker?.upgrade;
  if (recorded === options.version && !pending) return null;
  refuseNewerData(marker, options.version);
  let backup: string | null;
  if (pending) {
    // The data was backed up before the upgrade began; later copies could be partial.
    backup = pending.backup;
    log.info(
      `Continuing the upgrade from ${recorded ? `Trestl ${recorded}` : 'an earlier Trestl release'} ` +
        `to ${options.version}.` +
        (backup ? ` The backup from before it is ${backup}.` : ''),
    );
  } else {
    backup = await preUpgradeBackup(db, engine, dataDir, recorded, options);
  }
  await markUpgradeStarted(db, marker, options.version, backup);
  return backup;
}

export async function preUpgradeBackup(
  db: Database,
  engine: 'pglite' | 'postgres',
  dataDir: string | undefined,
  recorded: string | null,
  options: UpgradeOptions,
): Promise<string | null> {
  const log = options.log ?? { info: console.error, warn: console.warn };
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
  let path = join(directory, backupFileName(recorded, new Date(), `-before-${options.version}`));
  try {
    path = await unusedBackupPath(
      directory,
      backupFileName(recorded, new Date(), `-before-${options.version}`),
    );
    const summary = await writeBackupFile(db, path, {
      engine,
      createdBy: { version: options.version, commit: options.commit?.() ?? null },
      secret: options.secret,
    });
    log.info(
      `Backed up ${summary.rows} rows to ${path} before upgrading from ${from} to ${options.version}.`,
    );
    return path;
  } catch (error) {
    const storage = typeof (error as NodeJS.ErrnoException).code === 'string';
    throw new Error(
      `The pre-upgrade backup to ${path} failed, so the upgrade did not start and your data is unchanged. ` +
        (storage
          ? 'Make sure the folder is writable and has free space, or set BACKUP_DIR. '
          : '') +
        `Cause: ${(error as Error).message}`,
      { cause: error },
    );
  }
}

/** Recorded after every startup migration has succeeded; this also ends a pending upgrade. */
export async function recordInstallationVersion(db: Database, version: string) {
  await db.query(
    `INSERT INTO entities(collection,id,data) VALUES ('system','installation-version',$1::jsonb)
     ON CONFLICT(collection,id) DO UPDATE SET data=EXCLUDED.data
     WHERE entities.data->>'version' IS DISTINCT FROM EXCLUDED.data->>'version'
       OR entities.data ? 'upgrade'`,
    [JSON.stringify({ id: 'installation-version', version, recordedAt: new Date().toISOString() })],
  );
}
