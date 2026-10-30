import { randomBytes } from 'node:crypto';
import { mkdir, open, readFile, unlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import fastifyStatic from '@fastify/static';
import { createApp } from '../server/app.ts';

async function main() {
  // The shell supplies paths over stdin, never argv, and keeps the pipe open for its lifetime.
  const input = createInterface({ input: process.stdin });
  const config = await new Promise<{ dataDir: string; resources: string }>((accept, reject) => {
    input.once('line', (line) => {
      try {
        accept(JSON.parse(line));
      } catch (error) {
        reject(error);
      }
    });
    input.once('close', () => reject(new Error('Desktop host closed before configuration')));
  });
  if (!config.dataDir || !config.resources) throw new Error('Missing desktop paths');
  const dataDir = resolve(config.dataDir);
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const lockPath = resolve(dataDir, 'desktop.lock');
  async function acquireLock() {
    try {
      return await open(lockPath, 'wx', 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const pid = Number(await readFile(lockPath, 'utf8'));
      if (!Number.isSafeInteger(pid) || pid <= 0)
        throw new Error('Invalid desktop lock. Close Trestl before removing desktop.lock.');
      try {
        process.kill(pid, 0);
      } catch (probe) {
        if ((probe as NodeJS.ErrnoException).code === 'ESRCH') {
          await unlink(lockPath);
          return await open(lockPath, 'wx', 0o600);
        }
        throw probe;
      }
      throw new Error(
        'This desktop database is already in use. Close the other Trestl process first.',
      );
    }
  }
  const lock = await acquireLock();
  await lock.writeFile(String(process.pid));
  let app: Awaited<ReturnType<typeof createApp>> | undefined;
  let stopping = false;
  let initializing = true;
  let requestedExit: number | undefined;
  let stopProgress = () => {};
  async function stop(code = 0) {
    if (initializing) {
      requestedExit = code;
      return;
    }
    if (stopping) return;
    stopping = true;
    try {
      await app?.close();
    } finally {
      await lock.close();
      await unlink(lockPath);
      process.exit(code);
    }
  }
  input.once('close', () => {
    void stop();
  });
  input.on('line', (line) => {
    if (line === 'shutdown') void stop();
  });
  process.once('SIGINT', () => {
    void stop();
  });
  process.once('SIGTERM', () => {
    void stop();
  });
  if (process.stdin.readableEnded) requestedExit = 0;
  try {
    const secretPath = resolve(dataDir, 'app-secret');
    try {
      await writeFile(secretPath, randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const secret = (await readFile(secretPath, 'utf8')).trim();
    if (secret.length < 32)
      throw new Error('The desktop app-secret file is invalid. Restore it from a backup.');
    // Never inherit a developer's hosted deployment/database/authentication configuration.
    for (const key of Object.keys(process.env)) {
      if (
        /^(DATABASE_URL|DATA_DIR|BACKUP_DIR|APP_|AUTH_|PROXY_|TRUST_PROXY|SECURE_COOKIES|INSTALLATION_|INTEGRATION_|GITHUB_)/.test(
          key,
        )
      )
        delete process.env[key];
    }
    process.env.APP_SECRET = secret;
    process.env.SECURE_COOKIES = 'false';
    process.env.NODE_ENV = 'production';
    const token = randomBytes(32).toString('hex');
    // One-time work before the launch line, such as a pre-upgrade backup, can take minutes.
    const progress = setInterval(() => process.stdout.write('{"status":"starting"}\n'), 30_000);
    stopProgress = () => clearInterval(progress);
    app = await createApp({
      dataDir: resolve(dataDir, 'database'),
      backupDir: resolve(dataDir, 'backups'),
      proxyAuth: null,
      desktopToken: token,
    });
    await app.register(fastifyStatic, { root: resolve(config.resources, 'web'), prefix: '/' });
    app.setNotFoundHandler((request, reply) =>
      request.url.startsWith('/api/')
        ? reply.code(404).send({ message: 'Endpoint not found' })
        : reply.sendFile('index.html'),
    );
    // Reuse the origin so webview preferences survive normal restarts. If another
    // process occupies it, the OS selects a free port; never trust the occupant.
    const portPath = resolve(dataDir, 'port');
    let port = 0;
    try {
      const saved = Number(await readFile(portPath, 'utf8'));
      if (Number.isInteger(saved) && saved >= 1024 && saved <= 65535) port = saved;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    let origin: string;
    try {
      origin = await app.listen({ host: '127.0.0.1', port });
    } catch (error) {
      if (!port || (error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error;
      origin = await app.listen({ host: '127.0.0.1', port: 0 });
    }
    await writeFile(portPath, new URL(origin).port, { mode: 0o600 });
    stopProgress();
    initializing = false;
    if (requestedExit !== undefined) {
      await stop(requestedExit);
      return;
    }
    process.stdout.write(
      JSON.stringify({ url: `${origin}/__desktop/launch?token=${token}` }) + '\n',
    );
  } catch (error) {
    stopProgress();
    initializing = false;
    console.error(error instanceof Error ? error.message : 'Desktop service failed');
    await stop(1);
  }
}
main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
