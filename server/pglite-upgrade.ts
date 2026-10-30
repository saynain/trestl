import { createReadStream } from 'node:fs';
import { access, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { join } from 'node:path';
import { restoreBackup, writeBackup } from './backup.ts';
import type { Database } from './db.ts';
import {
  markUpgradeStarted,
  preUpgradeBackup,
  readMarker,
  refuseNewerData,
  type UpgradeOptions,
} from './upgrade.ts';

/** PostgreSQL major version of the bundled PGlite engine. */
export const pgliteMajor = '18';
export type Engine = new (dataDir?: string, options?: { database?: string }) => PGlite;
/** Engines that still read folders written by earlier Trestl releases. */
const legacyEngines: Record<string, { name: string; load: () => Promise<Engine> }> = {
  // Trestl 0.6 and earlier used PGlite 0.3 (PostgreSQL 17), with tables in template1.
  // PGlite 0.4 also wrote PostgreSQL 17 folders, but into the postgres database.
  '17': {
    name: 'pglite-0.3',
    load: async () => (await import('pglite-0.3')).PGlite as unknown as Engine,
  },
};

export async function folderMajor(dataDir: string): Promise<string | null> {
  try {
    return (await readFile(join(dataDir, 'PG_VERSION'), 'utf8')).trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/**
 * Open a folder as it is, without changing it. A folder from an earlier PGlite opens with
 * that engine, in whichever database holds Trestl's tables.
 */
export async function openFolder(dataDir: string | undefined, major: string | null) {
  if (!dataDir || !major || major === pgliteMajor) return ready(new PGlite(dataDir));
  const legacy = legacyEngines[major];
  if (!legacy)
    throw new Error(
      `This PGlite folder uses PostgreSQL ${major}, which this Trestl release cannot open. ` +
        'Restore a backup into a new folder instead; see docs/backup.md.',
    );
  const Engine = await legacy.load();
  const found: string[] = [];
  for (const database of ['template1', 'postgres']) {
    const engine = await ready(new Engine(dataDir, { database }));
    try {
      const { rows } = await engine.query<{ found: boolean }>(
        `SELECT to_regclass('entities') IS NOT NULL AS found`,
      );
      if (rows[0]?.found) found.push(database);
    } finally {
      await engine.close();
    }
  }
  if (found.length > 1)
    throw new Error(
      `${dataDir} has Trestl tables in both its template1 and postgres databases, so Trestl ` +
        'cannot tell which one is current. It was not changed; see docs/backup.md.',
    );
  return ready(new Engine(dataDir, { database: found[0] ?? 'template1' }));
}
async function ready(engine: PGlite) {
  try {
    await engine.waitReady;
    return engine;
  } catch (error) {
    await engine.close().catch(() => {});
    throw error;
  }
}

const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );
const staging = (dataDir: string) => `${dataDir}-pglite-upgrade`;
const completed = 'trestl-upgrade.json';

/** Finish a folder swap that a crash interrupted after the new folder was verified. */
export async function recoverFolderUpgrade(dataDir: string) {
  const target = staging(dataDir);
  if ((await exists(dataDir)) || !(await exists(join(target, completed)))) return;
  await rename(target, dataDir);
  await rm(join(dataDir, completed), { force: true });
}

/**
 * Move a folder written by an older PGlite to the current one. The old engine writes a
 * pre-upgrade backup; the current engine restores it into a new folder, which must match
 * the original table by table; then the folders swap. The original is kept beside the new
 * one, and the backup restores into any later release. Call with the folder locked.
 */
export async function upgradeFolder(
  dataDir: string,
  major: string,
  options: UpgradeOptions,
  wrap: (engine: PGlite) => Database,
): Promise<void> {
  const log = options.log ?? { info: console.error, warn: console.warn };
  const legacy = wrap(await openFolder(dataDir, major));
  let backup: string | null = null;
  let marker;
  try {
    marker = await readMarker(legacy);
    if (marker !== undefined) {
      refuseNewerData(marker, options.version);
      backup = await preUpgradeBackup(legacy, 'pglite', dataDir, marker?.version ?? null, options);
      if (!backup) throw new Error(`No backup could be taken before moving ${dataDir}.`);
    }
  } finally {
    await legacy.close();
  }
  const target = staging(dataDir);
  // Anything here is an earlier attempt that never swapped; the original is intact.
  await rm(target, { recursive: true, force: true });
  if (backup) {
    const fresh = wrap(new PGlite(target));
    try {
      // The same installation: its credentials are copied unchanged, whatever the key.
      // The file's digests were taken from the original while writing it.
      const expected = await restoreBackup(fresh, createReadStream(backup), {
        appVersion: options.version,
        allowSecretMismatch: true,
      });
      const copied = await writeBackup(fresh, null, {
        engine: 'pglite',
        createdBy: { version: options.version, commit: null },
      });
      if (JSON.stringify(copied.digests) !== JSON.stringify(expected.digests))
        throw new Error('The new database does not match the original.');
      // Startup continues this upgrade with the same backup instead of taking another.
      await markUpgradeStarted(fresh, marker ?? null, options.version, backup);
    } catch (error) {
      await fresh.close().catch(() => {});
      await rm(target, { recursive: true, force: true });
      throw new Error(
        `Moving ${dataDir} to PostgreSQL ${pgliteMajor} failed, so it is unchanged. ` +
          `The backup taken before it is ${backup}. Cause: ${(error as Error).message}`,
        { cause: error },
      );
    }
    await fresh.close();
    await writeFile(join(target, completed), JSON.stringify({ from: major, backup }));
  }
  let kept = `${dataDir}-${legacyEngines[major]!.name}`;
  for (let attempt = 2; await exists(kept); attempt++)
    kept = `${dataDir}-${legacyEngines[major]!.name}-${attempt}`;
  try {
    await rename(dataDir, kept);
  } catch (error) {
    await rm(target, { recursive: true, force: true });
    throw new Error(
      `Could not rename ${dataDir} to ${kept}, so it is unchanged. A data folder that is itself ` +
        'a mount point cannot be renamed: mount its parent folder instead, and set DATA_DIR to a ' +
        `folder inside it. Cause: ${(error as Error).message}`,
      { cause: error },
    );
  }
  // Without Trestl tables there is nothing to copy: the current engine starts a new folder.
  if (backup)
    try {
      await rename(target, dataDir);
    } catch (error) {
      await rename(kept, dataDir).catch(() => {});
      throw error;
    }
  await rm(join(dataDir, completed), { force: true });
  await rm(join(kept, 'trestl.lock'), { force: true });
  log.info(
    `Moved ${dataDir} to PostgreSQL ${pgliteMajor}. The original folder is kept in ${kept}` +
      (backup ? `, and the backup taken before the move is ${backup}.` : '.'),
  );
}
