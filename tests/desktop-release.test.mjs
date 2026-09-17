import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import {
  verifyVersion,
  assetNames,
  collectInstallers,
  checksumInstallers,
  targets,
} from '../scripts/desktop-release.mjs';
import { ensureRelease } from '../scripts/ensure-release.mjs';

async function fixture(fn) {
  const root = await mkdtemp(join(tmpdir(), 'trestl-release-'));
  try {
    await mkdir(join(root, 'cli'));
    await mkdir(join(root, 'src-tauri'));
    for (const file of ['package.json', 'cli/package.json', 'src-tauri/tauri.conf.json'])
      await writeFile(join(root, file), JSON.stringify({ version: '0.4.0' }));
    await writeFile(join(root, 'src-tauri/Cargo.toml'), '[package]\nversion = "0.4.0"\n');
    await writeFile(
      join(root, 'src-tauri/Cargo.lock'),
      'name = "trestl-desktop"\nversion = "0.4.0"\n',
    );
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
test('release tag and every app version must agree', async () => {
  await fixture(async (root) => {
    assert.equal(await verifyVersion(root, 'v0.4.0'), '0.4.0');
    await assert.rejects(verifyVersion(root, 'v0.3.0'), /Release tag/);
    await assert.rejects(verifyVersion(root, 'v0.4.0-rc.1'), /Release tag/);
    await writeFile(join(root, 'cli/package.json'), '{"version":"0.3.0"}');
    await assert.rejects(verifyVersion(root, 'v0.4.0'), /versions must match/);
  });
});
test('release collection rejects missing or duplicate installers and preserves bytes', async () => {
  await fixture(async (root) => {
    const target = 'x86_64-pc-windows-msvc';
    const bundle = join(root, 'src-tauri/target', target, 'release/bundle');
    await mkdir(join(bundle, 'nsis'), { recursive: true });
    await mkdir(join(bundle, 'msi'));
    const output = join(root, 'output');
    await writeFile(join(bundle, 'nsis/Trestl.exe'), 'signed exe');
    await assert.rejects(collectInstallers(root, target, output), /Expected one.*msi/);
    await writeFile(join(bundle, 'msi/Trestl.msi'), 'signed msi');
    const files = await collectInstallers(root, target, output);
    assert.equal(await readFile(join(output, files[0]), 'utf8'), 'signed exe');
    await writeFile(join(bundle, 'nsis/old.exe'), 'old');
    await assert.rejects(collectInstallers(root, target, output), /found 2/);
  });
});
test('desktop checksums cover exactly all platforms without colliding with CLI checksums', async () => {
  await fixture(async (root) => {
    const output = join(root, 'output');
    await mkdir(output);
    await assert.rejects(checksumInstallers(root, output), /all seven/);
    const names = Object.keys(targets).flatMap((target) => assetNames('0.4.0', target));
    assert.equal(new Set(names).size, 7);
    for (const name of names) await writeFile(join(output, name), name);
    await checksumInstallers(root, output);
    const checksums = await readFile(join(output, 'desktop-SHA256SUMS'), 'utf8');
    for (const name of names)
      assert.ok(
        checksums.includes(`${createHash('sha256').update(name).digest('hex')}  ${name}\n`),
      );
    await writeFile(join(output, 'unexpected.exe'), 'wrong');
    await assert.rejects(checksumInstallers(root, output), /all seven/);
    await rm(join(output, 'unexpected.exe'));
    await writeFile(join(output, names[0]), '');
    await assert.rejects(checksumInstallers(root, output), /Empty installer/);
  });
});
test('CLI and desktop release creation tolerate a concurrent creator without editing a release', () => {
  const calls = [];
  const outcomes = [1, 1, 0]; // missing, competing create won, now exists
  ensureRelease('v0.4.0', (args) => {
    calls.push(args);
    return { status: outcomes.shift() };
  });
  assert.deepEqual(
    calls.map((args) => args[1]),
    ['view', 'create', 'view'],
  );
  assert.ok(calls[1].includes('--verify-tag'));
  assert.throws(() => ensureRelease('v0.4.0', () => ({ status: 1 })), /Could not create/);
  assert.throws(() => ensureRelease('main', () => ({ status: 0 })), /version tag/);
  let called = 0;
  ensureRelease('v0.4.0', () => {
    called++;
    return { status: 0 };
  });
  assert.equal(called, 1);
});
