import { transform } from 'esbuild';
import { readdir, readFile, mkdir, writeFile, chmod, copyFile } from 'node:fs/promises';
const source = new URL('../cli/', import.meta.url);
const output = new URL('dist/', source);
await mkdir(output, { recursive: true });
for (const file of await readdir(source)) {
  if (!file.endsWith('.ts')) continue;
  const result = await transform(await readFile(new URL(file, source), 'utf8'), {
    loader: 'ts',
    format: 'esm',
    target: 'es2022',
    sourcefile: file,
  });
  await writeFile(new URL(file.replace(/\.ts$/, '.js'), output), result.code);
}
await chmod(new URL('index.js', output), 0o755);
await copyFile(new URL('../LICENSE', import.meta.url), new URL('LICENSE', source));
console.log('Built standalone CLI in cli/dist. Pack with: npm pack ./cli');
