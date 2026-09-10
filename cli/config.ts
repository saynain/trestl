import { access, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { usage } from './errors.js';

export type RepositoryConfig = { profile?: string; project?: string };
export async function repositoryConfig(
  start = process.cwd(),
): Promise<{ path?: string; config: RepositoryConfig }> {
  let directory = resolve(start);
  while (true) {
    const path = join(directory, '.trestl.json');
    let contents: string | undefined;
    try {
      contents = await readFile(path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw usage(`Cannot read ${path}.`);
    }
    if (contents !== undefined) {
      try {
        const config = JSON.parse(contents);
        if (
          !config ||
          typeof config !== 'object' ||
          Array.isArray(config) ||
          Object.entries(config).some(
            ([key, value]) =>
              !['profile', 'project'].includes(key) || typeof value !== 'string' || !value.trim(),
          )
        )
          throw new Error();
        return { path, config };
      } catch {
        throw usage(
          `${path} must be a JSON object containing only profile and/or project strings. Never put credentials here.`,
        );
      }
    }
    // Do not inherit another repository's defaults across a Git root.
    try {
      await access(join(directory, '.git'));
      return { config: {} };
    } catch {}
    const parent = dirname(directory);
    if (parent === directory) return { config: {} };
    directory = parent;
  }
}
export async function initializeConfig(config: RepositoryConfig): Promise<string> {
  const path = join(process.cwd(), '.trestl.json');
  try {
    await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, { flag: 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST')
      throw usage(`${path} already exists. Edit it to change repository defaults.`);
    throw error;
  }
  return path;
}
