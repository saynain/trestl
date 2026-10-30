import { readFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { PGlite as LegacyPGlite } from 'pglite-0.3';
import { restoreBackup } from '../server/backup.ts';
import { pgliteDatabase } from '../server/db.ts';
import { testSecret, type Fixture } from './backup-fixture.ts';

const fixtures = new URL('./fixtures/', import.meta.url);
/**
 * A PGlite 0.3 (PostgreSQL 17) folder holding data that Trestl 0.6.0 wrote. The fixture is
 * the backup of an installation that release created, so the folder has its exact tables
 * and rows. The installation's APP_SECRET is `testSecret`; its fake Gitea is at port 4516.
 * PGlite 0.4 wrote the same PostgreSQL 17 folders, but into the `postgres` database.
 */
export async function releaseFolder(dataDir: string, database = 'template1'): Promise<Fixture> {
  const legacy = pgliteDatabase(new LegacyPGlite(dataDir, { database }) as never);
  try {
    const backup = await readFile(new URL('release-0.6.0.jsonl', fixtures));
    await restoreBackup(legacy, Readable.from([gzipSync(backup)]), {
      appVersion: '0.6.0',
      secret: testSecret,
    });
  } finally {
    await legacy.close();
  }
  return JSON.parse(await readFile(new URL('release-0.6.0.json', fixtures), 'utf8'));
}

// The packaged desktop test runs this file to build a folder for the bundled service.
if (process.argv[1] === fileURLToPath(import.meta.url)) await releaseFolder(process.argv[2]!);
