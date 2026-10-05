import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';

// A real production build + API, deliberately isolated from .env and the user's database.
const port = process.env.PREVIEW_PORT || '4318';
const origin = `http://127.0.0.1:${port}`;
const dataDir =
  process.env.PREVIEW_DATA_DIR ||
  resolve(tmpdir(), `trestl-preview-${process.getuid?.() ?? 'local'}`);
if (!existsSync('dist/index.html'))
  throw new Error('Build the frontend before starting the demo preview.');
const child = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
  env: {
    ...process.env,
    DATA_DIR: dataDir,
    DATABASE_URL: '',
    AUTH_MODE: 'local',
    APP_SECRET: 'local-trestl-demo-preview-only',
    APP_ORIGIN: origin,
    PORT: port,
    HOST: '127.0.0.1',
  },
  stdio: 'inherit',
});
let closed = false;
child.on('exit', (code) => {
  closed = true;
  process.exitCode = code ?? 1;
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
try {
  let status;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (closed) throw new Error('Preview server exited before it was ready.');
    try {
      const response = await fetch(`${origin}/api/v1/auth/status`);
      if (response.ok) {
        status = await response.json();
        break;
      }
    } catch {
      /* starting */
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  if (!status) throw new Error('Preview server did not become ready.');
  if (status.needsSetup) {
    const response = await fetch(`${origin}/api/v1/auth/setup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: origin },
      body: JSON.stringify({
        installationName: 'Trestl demo preview',
        name: 'Demo Reviewer',
        email: 'demo@trestl.local',
        password: 'TrestlDemo2026!',
        seedDemo: true,
      }),
    });
    if (!response.ok) throw new Error(`Demo setup failed: ${await response.text()}`);
  }
  console.log(
    `\nDemo preview: ${origin}\nLogin: demo@trestl.local / TrestlDemo2026!\nIsolated database: ${dataDir}\n`,
  );
} catch (error) {
  child.kill('SIGTERM');
  throw error;
}
