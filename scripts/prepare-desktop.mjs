import { build } from 'esbuild';
import { build as buildWeb } from 'vite';
import { cp, mkdir, readFile, writeFile, chmod, rm, readdir, access } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
process.chdir(root);
const targets = {
  'darwin-arm64': 'aarch64-apple-darwin',
  'darwin-x64': 'x86_64-apple-darwin',
  'win32-x64': 'x86_64-pc-windows-msvc',
  'linux-x64': 'x86_64-unknown-linux-gnu',
  'linux-arm64': 'aarch64-unknown-linux-gnu',
};
const target = targets[`${process.platform}-${process.arch}`];
if (!target) throw new Error(`Unsupported desktop build host: ${process.platform}/${process.arch}`);
if (process.env.TAURI_ENV_TARGET_TRIPLE && process.env.TAURI_ENV_TARGET_TRIPLE !== target)
  throw new Error(
    'Build on a native runner for the requested target; the Node sidecar must match.',
  );
const resources = resolve('src-tauri/resources');
await mkdir(resources, { recursive: true });
await mkdir('src-tauri/binaries', { recursive: true });

// Bundle a pinned, official Node distribution. Verify the archive before extracting it.
const version = '22.23.4';
const platform = process.platform === 'win32' ? 'win' : process.platform;
const distribution = `node-v${version}-${platform}-${process.arch}`;
const archive = `${distribution}.${process.platform === 'win32' ? 'zip' : 'tar.gz'}`;
const cache = resolve('node_modules/.cache/trestl-desktop');
const runtime = resolve(
  cache,
  distribution,
  process.platform === 'win32' ? 'node.exe' : 'bin/node',
);
async function download(name) {
  const response = await fetch(`https://nodejs.org/dist/v${version}/${name}`);
  if (!response.ok) throw new Error(`Node download failed: ${response.status} (${name})`);
  return Buffer.from(await response.arrayBuffer());
}
try {
  await access(runtime);
} catch {
  await mkdir(cache, { recursive: true });
  const [bytes, sums] = await Promise.all([download(archive), download('SHASUMS256.txt')]);
  const expected = sums
    .toString()
    .split('\n')
    .find((line) => line.endsWith(`  ${archive}`))
    ?.split(' ')[0];
  if (!expected || createHash('sha256').update(bytes).digest('hex') !== expected)
    throw new Error('Node archive checksum mismatch');
  const archivePath = resolve(cache, archive);
  await writeFile(archivePath, bytes);
  if (process.platform === 'win32') {
    execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        'Expand-Archive -LiteralPath $env:TRESTL_NODE_ARCHIVE -DestinationPath $env:TRESTL_NODE_CACHE -Force',
      ],
      {
        stdio: 'inherit',
        env: { ...process.env, TRESTL_NODE_ARCHIVE: archivePath, TRESTL_NODE_CACHE: cache },
      },
    );
  } else execFileSync('tar', ['-xzf', archivePath, '-C', cache], { stdio: 'inherit' });
}
const binary = resolve(
  `src-tauri/binaries/trestl-node-${target}${process.platform === 'win32' ? '.exe' : ''}`,
);
await cp(runtime, binary);
await chmod(binary, 0o755);
await cp(resolve(cache, distribution, 'LICENSE'), resolve(resources, 'NODE-LICENSE'));

const frontendModules = new Set();
process.env.VITE_TRESTL_DESKTOP = 'true';
process.env.VITE_TRESTL_DESKTOP_PLATFORM = process.platform;
await buildWeb({
  plugins: [
    {
      name: 'desktop-license-inventory',
      generateBundle() {
        for (const id of this.getModuleIds()) {
          if (id.includes('node_modules') && !id.startsWith('\0'))
            frontendModules.add(id.split('?')[0]);
        }
      },
    },
  ],
  build: { outDir: resolve(resources, 'web'), emptyOutDir: true },
});
// Freeze the packaged server identity while the source tree is still available.
const serverPackage = JSON.parse(await readFile(resolve('package.json'), 'utf8'));
function sourceGit(...args) {
  try {
    return (
      execFileSync('git', args, { cwd: root, timeout: 1000, stdio: ['ignore', 'pipe', 'ignore'] })
        .toString()
        .trim() || null
    );
  } catch {
    return null;
  }
}
const serverCommit = sourceGit('rev-parse', 'HEAD');
const serverDirty = !!sourceGit('status', '--porcelain', '--untracked-files=no');
const serverBuild = {
  version: serverPackage.version,
  commit: serverCommit,
  buildId: serverCommit ? `${serverCommit.slice(0, 12)}${serverDirty ? '-dirty' : ''}` : null,
  builtAt: new Date().toISOString(),
  release:
    !serverDirty &&
    sourceGit('describe', '--tags', '--exact-match', 'HEAD') === `v${serverPackage.version}`,
};
const result = await build({
  entryPoints: ['desktop/server.ts'],
  outfile: resolve(resources, 'server.cjs'),
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  define: {
    __TRESTL_BUNDLED_BUILD__: JSON.stringify(serverBuild),
    'import.meta.url': '__trestlBundleUrl',
  },
  banner: { js: "const __trestlBundleUrl = require('node:url').pathToFileURL(__filename).href;" },
  external: ['@electric-sql/pglite', 'pg-native'],
  metafile: true,
});
// Keep PGlite's WASM/data files and relative loaders intact.
const pglite = resolve(dirname(fileURLToPath(import.meta.resolve('@electric-sql/pglite'))), '..');
const destination = resolve(resources, 'node_modules/@electric-sql/pglite');
await rm(destination, { recursive: true, force: true });
await cp(pglite, destination, { recursive: true, dereference: true });
const packages = new Set([pglite]);
for (const input of [...Object.keys(result.metafile.inputs), ...frontendModules]) {
  if (!input.includes('node_modules')) continue;
  let directory = dirname(resolve(input));
  while (directory.includes('node_modules')) {
    try {
      await access(resolve(directory, 'package.json'));
      packages.add(directory);
      break;
    } catch {
      directory = dirname(directory);
    }
  }
}
let notices = 'Trestl Desktop third-party JavaScript dependencies\n\n';
for (const directory of [...packages].sort()) {
  const pkg = JSON.parse(await readFile(resolve(directory, 'package.json'), 'utf8'));
  notices += `\n--- ${pkg.name}@${pkg.version} (${pkg.license ?? 'see license'}) ---\n`;
  for (const name of await readdir(directory)) {
    if (/^(licen[cs]e|copying|notice)([._-]|$)/i.test(name))
      notices += (await readFile(resolve(directory, name), 'utf8')) + '\n';
  }
}
await writeFile(resolve(resources, 'THIRD-PARTY-NOTICES.txt'), notices);
// Ship the native dependency notices as well as the JavaScript and Node notices.
const metadata = JSON.parse(
  execFileSync(
    'cargo',
    [
      'metadata',
      '--manifest-path',
      'src-tauri/Cargo.toml',
      '--format-version',
      '1',
      '--locked',
      '--filter-platform',
      target,
    ],
    { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 },
  ),
);
let rustNotices = 'Trestl Desktop third-party Rust dependencies\n\n';
for (const pkg of metadata.packages) {
  if (!pkg.source) continue;
  const directory = dirname(pkg.manifest_path);
  rustNotices += `\n--- ${pkg.name}@${pkg.version} (${pkg.license ?? 'see license'}) ---\n${pkg.repository ?? ''}\n`;
  const files = (await readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && /^(licen[cs]e|copying|notice)([._-]|$)/i.test(entry.name))
    .map((entry) => entry.name);
  if (pkg.license_file && !files.includes(pkg.license_file)) files.push(pkg.license_file);
  for (const name of files)
    rustNotices += (await readFile(resolve(directory, name), 'utf8')) + '\n';
}
await writeFile(resolve(resources, 'RUST-THIRD-PARTY-NOTICES.txt'), rustNotices);
await cp('LICENSE', resolve(resources, 'LICENSE'));
console.log(`Desktop resources prepared for ${target} with Node ${version}.`);
