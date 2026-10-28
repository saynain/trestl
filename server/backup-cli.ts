import { createReadStream, existsSync } from 'node:fs';
import { readdir, rm, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Readable } from 'node:stream';
import { parseArgs } from 'node:util';
import {
  backupFileName,
  isBackupError,
  readBackup,
  restoreBackup,
  secretStatus,
  writeBackup,
  writeBackupFile,
  type BackupSummary,
} from './backup.ts';
import { openDatabase } from './db.ts';
import { serverBuild, serverVersion } from './version.ts';

const help = `Trestl installation backup

Usage: pnpm -s backup <command> [options]
       node --import tsx server/backup-cli.ts <command> [options]

Commands:
  create [--output <path>]  Back up the database. <path> is a file, a folder, or -
                            for standard output. Defaults to BACKUP_DIR, then the
                            PGlite backup folder, then the current folder.
  verify <file>             Check a backup's integrity and whether APP_SECRET matches.
  restore <file>            Restore a backup into a new, empty database. Use - to
                            read standard input.

The database is chosen like the server's: DATABASE_URL for PostgreSQL, otherwise
PGlite in DATA_DIR (default .data). Stop a PGlite server before using its folder.

Options:
  --database-url <url>      Use this PostgreSQL database instead of DATABASE_URL
  --data-dir <path>         Use this PGlite folder instead of DATA_DIR
  --allow-secret-mismatch   Restore even though APP_SECRET differs from the backup.
                            Integration credentials must then be reconnected.
  -h, --help                Show this help
`;

class UsageError extends Error {}

function target(values: { 'database-url'?: string; 'data-dir'?: string }) {
  const databaseUrl =
    values['database-url'] ?? (values['data-dir'] ? undefined : process.env.DATABASE_URL);
  const dataDir = resolve(values['data-dir'] ?? process.env.DATA_DIR ?? '.data');
  return databaseUrl
    ? { databaseUrl, label: 'the PostgreSQL database', engine: 'postgres' as const }
    : { dataDir, label: dataDir, engine: 'pglite' as const };
}

function input(file: string | undefined): Readable {
  if (!file) throw new UsageError('Name the backup file to read, or - for standard input.');
  return file === '-' ? process.stdin : createReadStream(file);
}

function describe(summary: BackupSummary) {
  const { header } = summary;
  const secret = {
    matches: 'matches this APP_SECRET',
    differs: 'differs from this APP_SECRET',
    missing: 'recorded, but APP_SECRET is not set here',
    'not-recorded': 'was not set when the backup was taken',
  }[secretStatus(header, process.env.APP_SECRET)];
  return [
    `Created:      ${header.createdAt} by Trestl ${header.createdBy.version}`,
    `Database:     ${header.database.engine}, last migrated by ${
      header.database.version ? `Trestl ${header.database.version}` : 'an earlier Trestl release'
    }`,
    `Contents:     ${summary.rows} rows in ${Object.keys(summary.tables).length} tables`,
    ...Object.entries(summary.tables).map(([name, rows]) => `  ${name}: ${rows}`),
    `APP_SECRET:   ${secret}`,
  ].join('\n');
}

async function create(values: Parameters<typeof target>[0] & { output?: string }) {
  const database = target(values);
  const db = await openDatabase({ ...database, initialize: false, mustExist: true });
  try {
    const build = serverBuild();
    const info = {
      engine: database.engine,
      createdBy: { version: build.version, commit: build.commit },
      secret: process.env.APP_SECRET,
    };
    if (values.output === '-') {
      const summary = await writeBackup(db, process.stdout, info);
      console.error(`Backed up ${summary.rows} rows from ${database.label} to standard output.`);
      return;
    }
    let path =
      values.output ??
      process.env.BACKUP_DIR ??
      (database.engine === 'pglite' ? `${database.dataDir}-backups` : '.');
    if (!values.output || (existsSync(path) && (await stat(path)).isDirectory()))
      path = join(path, backupFileName(build.version));
    const summary = await writeBackupFile(db, resolve(path), info);
    console.error(`Backed up ${summary.rows} rows from ${database.label} to ${resolve(path)}.`);
    if (!summary.header.secretCheck)
      console.error(
        'APP_SECRET is not set, so restoring cannot confirm the key for integration credentials.',
      );
  } finally {
    await db.close();
  }
}

async function restore(
  file: string | undefined,
  values: Parameters<typeof target>[0] & { 'allow-secret-mismatch'?: boolean },
) {
  const source = input(file);
  const database = target(values);
  let created = false;
  if (database.engine === 'pglite') {
    const entries = existsSync(database.dataDir) ? await readdir(database.dataDir) : null;
    if (entries?.length)
      throw new UsageError(
        `${database.dataDir} is not empty. Restore into a new folder with --data-dir, or move the existing folder aside first.`,
      );
    created = !entries;
  }
  const db = await openDatabase({ ...database, initialize: false });
  let summary: BackupSummary;
  try {
    summary = await restoreBackup(db, source, {
      appVersion: serverVersion(),
      secret: process.env.APP_SECRET,
      allowSecretMismatch: values['allow-secret-mismatch'],
    });
  } catch (error) {
    await db.close();
    // The folder was empty or absent before; remove only what this attempt created.
    if (database.engine === 'pglite') {
      if (created) await rm(database.dataDir, { recursive: true, force: true });
      else
        for (const entry of await readdir(database.dataDir))
          await rm(join(database.dataDir, entry), { recursive: true, force: true });
    }
    throw error;
  }
  await db.close();
  console.error(`Restored ${summary.rows} rows into ${database.label}.\n${describe(summary)}`);
  console.error('Start Trestl with the same APP_SECRET; it applies any newer migrations.');
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      output: { type: 'string', short: 'o' },
      'database-url': { type: 'string' },
      'data-dir': { type: 'string' },
      'allow-secret-mismatch': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  const [command, file, ...extra] = positionals;
  if (values.help || !command) {
    process.stdout.write(help);
    return;
  }
  if (extra.length) throw new UsageError(`Unexpected argument: ${extra[0]}`);
  if (command === 'create') {
    if (file) throw new UsageError('Use --output to choose where the backup is written.');
    await create(values);
  } else if (command === 'verify') {
    console.log(describe(await readBackup(input(file))));
  } else if (command === 'restore') await restore(file, values);
  else throw new UsageError(`Unknown command: ${command}`);
}

main().catch((error) => {
  console.error(
    error instanceof UsageError || isBackupError(error)
      ? error.message
      : `Backup command failed: ${error instanceof Error ? error.message : error}`,
  );
  process.exitCode = 1;
});
