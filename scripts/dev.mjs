import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
if (existsSync('.env')) process.loadEnvFile('.env');
const port = process.env.PORT || '4317';
const webPort = process.env.WEB_PORT || '5173';
const env = {
  ...process.env,
  PORT: port,
  WEB_PORT: webPort,
  APP_ORIGIN: process.env.APP_ORIGIN || `http://127.0.0.1:${webPort}`,
};
const children = [
  spawn(process.execPath, [resolve('node_modules/tsx/dist/cli.mjs'), 'watch', 'server/index.ts'], {
    env,
    stdio: 'inherit',
  }),
  spawn(
    process.execPath,
    [
      resolve('node_modules/vite/bin/vite.js'),
      '--host',
      '127.0.0.1',
      '--port',
      webPort,
      '--strictPort',
    ],
    { env, stdio: 'inherit' },
  ),
];
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill('SIGTERM');
  setTimeout(() => process.exit(code), 400).unref();
}
for (const child of children) {
  child.on('error', (error) => {
    console.error(error.message);
    stop(1);
  });
  child.on('exit', (code) => stop(code || 0));
}
process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());
