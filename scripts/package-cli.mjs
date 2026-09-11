import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
const destination = resolve(process.argv[2] ?? 'dist/cli-release');
await mkdir(destination, { recursive: true });
execFileSync(process.execPath, ['scripts/build-cli.mjs'], { stdio: 'inherit' });
const packed = JSON.parse(
  execFileSync(
    'npm',
    ['pack', './cli', '--json', '--ignore-scripts', '--pack-destination', destination],
    { encoding: 'utf8' },
  ),
);
const filename = packed[0].filename;
const sum = createHash('sha256')
  .update(await readFile(resolve(destination, filename)))
  .digest('hex');
await writeFile(resolve(destination, 'SHA256SUMS'), `${sum}  ${filename}\n`);
console.log(`CLI package and checksum: ${destination}`);
