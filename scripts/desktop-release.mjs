import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdir, readFile, mkdir, copyFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const targets = {
  'aarch64-apple-darwin': ['dmg'],
  'x86_64-apple-darwin': ['dmg'],
  'x86_64-pc-windows-msvc': ['exe', 'msi'],
  'x86_64-unknown-linux-gnu': ['AppImage', 'deb', 'rpm'],
};
export async function verifyVersion(root = '.', tag) {
  const json = async (file) => JSON.parse(await readFile(join(root, file), 'utf8'));
  const version = (await json('package.json')).version;
  if (!/^\d+\.\d+\.\d+$/.test(version))
    throw new Error('Desktop installer versions must use major.minor.patch');
  const cargo = await readFile(join(root, 'src-tauri/Cargo.toml'), 'utf8');
  const lock = await readFile(join(root, 'src-tauri/Cargo.lock'), 'utf8');
  const versions = [
    (await json('cli/package.json')).version,
    (await json('src-tauri/tauri.conf.json')).version,
    cargo.match(/^version = "([^"]+)"/m)?.[1],
    lock.match(/name = "trestl-desktop"\r?\nversion = "([^"]+)"/)?.[1],
  ];
  if (versions.some((value) => value !== version))
    throw new Error('Root, CLI, Tauri, Cargo and Cargo.lock versions must match');
  if (tag && tag !== `v${version}`)
    throw new Error(`Release tag must be v${version}, received ${tag}`);
  return version;
}
export function assetNames(version, target) {
  if (!targets[target]) throw new Error(`Unsupported desktop target: ${target}`);
  return targets[target].map((extension) => `trestl-desktop-${version}-${target}.${extension}`);
}
async function filesUnder(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await filesUnder(path)));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}
export async function collectInstallers(root, target, output, updates = false) {
  const version = await verifyVersion(root);
  const names = assetNames(version, target);
  const files = await filesUnder(join(root, 'src-tauri/target', target, 'release/bundle'));
  await mkdir(output, { recursive: true });
  for (const [index, extension] of targets[target].entries()) {
    const candidates = files.filter((file) => file.endsWith(`.${extension}`));
    if (candidates.length !== 1)
      throw new Error(`Expected one ${target} .${extension} installer, found ${candidates.length}`);
    await copyFile(candidates[0], join(output, names[index]));
  }
  if (updates) {
    for (const entry of updateAssets(version).filter((entry) => entry.target === target)) {
      if (!names.includes(entry.name)) {
        const candidates = files.filter((file) => file.endsWith('.app.tar.gz'));
        if (candidates.length !== 1) throw new Error('Expected one macOS updater archive');
        await copyFile(candidates[0], join(output, entry.name));
      }
      const extension = entry.name.endsWith('.app.tar.gz')
        ? '.app.tar.gz'
        : `.${entry.name.split('.').pop()}`;
      const signatures = files.filter((file) => file.endsWith(`${extension}.sig`));
      if (signatures.length !== 1)
        throw new Error(`Missing or ambiguous signature for ${entry.name}`);
      await copyFile(signatures[0], join(output, `${entry.name}.sig`));
    }
  }
  return names;
}
export async function checksumInstallers(root, directory, updates = false) {
  const version = await verifyVersion(root);
  const expected = Object.keys(targets)
    .flatMap((target) => assetNames(version, target))
    .sort();
  if (updates) {
    for (const entry of updateAssets(version)) {
      if (!expected.includes(entry.name)) expected.push(entry.name);
      expected.push(`${entry.name}.sig`);
    }
    expected.push('latest.json');
    expected.sort();
  }
  const actual = (await readdir(directory)).filter((name) => name !== 'desktop-SHA256SUMS').sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw new Error(
      'Desktop release must contain exactly all seven platform installers and the requested updater artifacts',
    );
  const lines = [];
  for (const name of expected) {
    const bytes = await readFile(join(directory, name));
    if (!bytes.length) throw new Error(`Empty installer: ${name}`);
    lines.push(`${createHash('sha256').update(bytes).digest('hex')}  ${name}`);
  }
  await writeFile(join(directory, 'desktop-SHA256SUMS'), lines.join('\n') + '\n');
  return expected;
}
export function updateAssets(version) {
  return [
    ['aarch64-apple-darwin', 'darwin-aarch64', 'app.tar.gz'],
    ['x86_64-apple-darwin', 'darwin-x86_64', 'app.tar.gz'],
    ['x86_64-pc-windows-msvc', 'windows-x86_64-nsis', 'exe'],
    ['x86_64-pc-windows-msvc', 'windows-x86_64-msi', 'msi'],
    ['x86_64-unknown-linux-gnu', 'linux-x86_64-appimage', 'AppImage'],
  ].map(([target, platform, extension]) => ({
    target,
    platform,
    name: `trestl-desktop-${version}-${target}.${extension}`,
  }));
}
export async function writeUpdateManifest(root, directory) {
  const version = await verifyVersion(root);
  const platforms = {};
  for (const { platform, name } of updateAssets(version)) {
    const signature = (await readFile(join(directory, `${name}.sig`), 'utf8')).trim();
    if (!signature || !Buffer.from(signature, 'base64').toString().startsWith('untrusted comment:'))
      throw new Error(`Invalid updater signature encoding: ${name}`);
    if (!(await readFile(join(directory, name))).length) throw new Error(`Empty updater: ${name}`);
    platforms[platform] = {
      signature,
      url: `https://github.com/saynain/trestl/releases/download/v${version}/${name}`,
    };
  }
  const notes = await readFile(join(root, `docs/releases/v${version}.md`), 'utf8');
  const manifest = { version, notes, platforms };
  await writeFile(join(directory, 'latest.json'), JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}
export async function configureUpdater(root = '.') {
  const config = JSON.parse(await readFile(join(root, 'src-tauri/tauri.conf.json'), 'utf8'));
  const key = (await readFile(join(root, 'src-tauri/updater.pub'), 'utf8')).trim();
  if (config.plugins?.updater?.pubkey !== key)
    throw new Error('Bundler and native updater public keys must agree');
  let overrides = {};
  if (process.platform === 'win32')
    overrides = JSON.parse(await readFile(join(root, 'src-tauri/signing.release.json'), 'utf8'));
  overrides.bundle = { ...overrides.bundle, createUpdaterArtifacts: true };
  await writeFile(join(root, 'src-tauri/updater.release.json'), JSON.stringify(overrides));
}
export async function verifyUpdateSignatures(root, directory) {
  const version = await verifyVersion(root);
  execFileSync(
    'cargo',
    [
      'run',
      '--quiet',
      '--locked',
      '--manifest-path',
      join(root, 'scripts/verify-update/Cargo.toml'),
      '--',
      join(root, 'src-tauri/updater.pub'),
      ...updateAssets(version).map(({ name }) => join(directory, name)),
    ],
    { stdio: 'inherit' },
  );
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [command, argument] = process.argv.slice(2);
  if (command === 'verify') console.log(await verifyVersion('.', argument));
  else if (command === 'collect')
    await collectInstallers(
      '.',
      argument,
      resolve('dist/desktop-release'),
      process.argv.includes('--updates'),
    );
  else if (command === 'checksums')
    await checksumInstallers('.', argument, process.argv.includes('--updates'));
  else if (command === 'manifest') await writeUpdateManifest('.', argument);
  else if (command === 'verify-signatures') await verifyUpdateSignatures('.', argument);
  else if (command === 'configure-updater') await configureUpdater();
  else
    throw new Error(
      'Usage: desktop-release.mjs verify [tag] | collect <target> [--updates] | checksums <dir> [--updates] | manifest <dir> | verify-signatures <dir> | configure-updater',
    );
}
