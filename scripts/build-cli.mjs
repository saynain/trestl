import ts from 'typescript';
import { readdir, readFile, mkdir, writeFile, chmod, copyFile } from 'node:fs/promises';
const source = new URL('../cli/', import.meta.url);
const output = new URL('dist/', source);
await mkdir(output, { recursive: true });
for (const file of await readdir(source)) {
  if (!file.endsWith('.ts')) continue;
  const result = ts.transpileModule(await readFile(new URL(file, source), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    fileName: file,
  });
  await writeFile(new URL(file.replace(/\.ts$/, '.js'), output), result.outputText);
}
await chmod(new URL('index.js', output), 0o755);
await copyFile(new URL('../LICENSE', import.meta.url), new URL('LICENSE', source));
console.log('Built standalone CLI in cli/dist. Pack with: npm pack ./cli');
