import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import fastifyStatic from '@fastify/static';
import { createApp } from './app.ts';
import type { AppContext } from './context.ts';
import { installation } from './installation.ts';
import {
  databaseConnectionError,
  storedAppSecret,
  readSettings,
  SettingsError,
  type ServerSettings,
} from './settings.ts';

let settings: ServerSettings;
try {
  settings = readSettings();
} catch (error) {
  if (!(error instanceof SettingsError)) throw error;
  console.error(`Trestl cannot start: ${error.message}`);
  process.exit(1);
}
if (settings.origin) process.env.APP_ORIGIN = settings.origin;
const { database } = settings;
// Images up to v0.6.0 kept PGlite data in /app/.data; never start empty beside it.
const previousImageData = '/app/.data';
if (
  database.kind === 'pglite' &&
  database.dataDir !== previousImageData &&
  existsSync(resolve(previousImageData, 'PG_VERSION')) &&
  !existsSync(resolve(database.dataDir, 'PG_VERSION'))
) {
  console.error(
    `Trestl cannot start: ${previousImageData} holds data from an earlier image, but data now lives in ${database.dataDir}. Move it as described in docs/quick-start.md#upgrade, or set DATA_DIR=${previousImageData}.`,
  );
  process.exit(1);
}
let app: Awaited<ReturnType<typeof createApp>>;
try {
  app = await createApp({ logger: true });
} catch (error) {
  const message = databaseConnectionError(error, database);
  if (!message) throw error;
  console.error(message);
  process.exit(1);
}
for (const warning of settings.warnings) app.log.warn(warning);
if (database.kind === 'pglite' && database.secretFile) {
  const key = await storedAppSecret(database.secretFile, process.env.APP_SECRET).catch(
    async (error) => {
      if (!(error instanceof SettingsError)) throw error;
      console.error(`Trestl cannot start: ${error.message}`);
      await app.close();
      process.exit(1);
    },
  );
  process.env.APP_SECRET = key.secret;
  if (key.created)
    app.log.info(
      `Generated the key that encrypts Git and sign-in credentials at ${key.path}. Back it up with the data, or set APP_SECRET.`,
    );
  if (key.mismatch)
    app.log.warn(
      `APP_SECRET differs from the generated key at ${key.path}. Credentials saved with that key cannot be decrypted; unset APP_SECRET or reconnect them.`,
    );
}
app.log.info(
  `Storing data in ${database.kind === 'pglite' ? 'PGlite' : 'PostgreSQL'} at ${database.description}`,
);
const dist = resolve('dist');
if (existsSync(dist)) {
  await app.register(fastifyStatic, { root: dist, prefix: '/' });
  app.setNotFoundHandler((request, reply) =>
    request.url.startsWith('/api/')
      ? reply.code(404).send({ error: 'not_found', message: 'Endpoint not found' })
      : reply.sendFile('index.html'),
  );
}
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.on(signal, async () => {
    await app.close();
    process.exit(0);
  });
try {
  await app.listen({ port: settings.port, host: settings.host });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
if (!(await installation((app as typeof app & { context: AppContext }).context.store)))
  app.log.info(
    `Open ${settings.origin ?? 'Trestl'} in a browser to create the administrator account. Until then, anyone who can reach this server can set it up.`,
  );
