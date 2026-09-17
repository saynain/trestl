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
    lock.match(/name = "trestl-desktop"\nversion = "([^"]+)"/)?.[1],
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
export async function collectInstallers(root, target, output) {
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
  return names;
}
export async function checksumInstallers(root, directory) {
  const version = await verifyVersion(root);
  const expected = Object.keys(targets)
    .flatMap((target) => assetNames(version, target))
    .sort();
  const actual = (await readdir(directory)).filter((name) => name !== 'desktop-SHA256SUMS').sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw new Error('Desktop release must contain exactly all seven platform installers');
  const lines = [];
  for (const name of expected) {
    const bytes = await readFile(join(directory, name));
    if (!bytes.length) throw new Error(`Empty installer: ${name}`);
    lines.push(`${createHash('sha256').update(bytes).digest('hex')}  ${name}`);
  }
  await writeFile(join(directory, 'desktop-SHA256SUMS'), lines.join('\n') + '\n');
  return expected;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [command, argument] = process.argv.slice(2);
  if (command === 'verify') console.log(await verifyVersion('.', argument));
  else if (command === 'collect')
    await collectInstallers('.', argument, resolve('dist/desktop-release'));
  else if (command === 'checksums') await checksumInstallers('.', argument);
  else
    throw new Error('Usage: desktop-release.mjs verify [tag] | collect <target> | checksums <dir>');
}
