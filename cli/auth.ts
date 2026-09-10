import { chmod, lstat, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

export const secrets = new Set<string>();
export type Credentials = { url: string; token: string };

export function serverUrl(input: string): string {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error('Server URL must be a valid HTTP(S) URL.');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
    throw new Error('Server URL must use HTTP(S) without embedded credentials.');
  if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
    throw new Error('Use HTTPS for remote servers to protect your API token.');
  if (url.search || url.hash) throw new Error('Server URL must not contain a query or fragment.');
  return url.toString().replace(/\/+$/, '');
}

export async function listProfiles(): Promise<string[]> {
  const directory = dirname(credentialPath('default'));
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    // Discover names only: do not open credential files or follow symlinks.
    return entries
      .filter(
        (entry) => entry.isFile() && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}\.json$/.test(entry.name),
      )
      .map((entry) => entry.name.slice(0, -5))
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw new Error(
      'Cannot list saved profiles. Check access to the Trestl configuration directory.',
    );
  }
}

export function credentialPath(profile: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(profile))
    throw new Error('Profile names must contain 1–64 letters, digits, underscores or hyphens.');
  return join(
    process.env.TRESTL_CONFIG_DIR || join(homedir(), '.config', 'trestl'),
    `${profile}.json`,
  );
}

export async function loadCredentials(path: string): Promise<Credentials | undefined> {
  try {
    const stat = await lstat(path);
    if (!stat.isFile()) throw new Error('Credential path must be a regular file.');
    if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0)
      throw new Error('Credential file is accessible to other users. Set its permissions to 600.');
    const data = JSON.parse(await readFile(path, 'utf8'));
    if (typeof data.token !== 'string' || !data.token.trim() || typeof data.url !== 'string')
      throw new Error('Invalid credentials');
    secrets.add(data.token);
    return { url: serverUrl(data.url), token: data.token };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    // Do not expose malformed file contents, which may contain a token.
    throw new Error(
      'Cannot read saved credentials. Check file permissions (600), or run logout and login again.',
    );
  }
}

export async function saveCredentials(path: string, credentials: Credentials): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (!(await lstat(directory)).isDirectory())
    throw new Error('Config directory must not be a symlink.');
  await chmod(directory, 0o700);
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(credentials)}\n`, { mode: 0o600, flag: 'wx' });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function logout(path: string): Promise<void> {
  await rm(path, { force: true });
}

export async function readToken(fromStdin: boolean): Promise<string> {
  let token: string;
  if (fromStdin) {
    if (process.stdin.isTTY)
      throw new Error('Pipe a token into login --token-stdin, or use login for a hidden prompt.');
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
    token = Buffer.concat(chunks).toString('utf8').trim();
  } else {
    if (!process.stdin.isTTY || !process.stderr.isTTY)
      throw new Error(
        'Interactive login requires a terminal. Use login --token-stdin for automation.',
      );
    process.stderr.write('Personal API token (hidden): ');
    token = await new Promise<string>((resolve, reject) => {
      let value = '';
      const wasRaw = process.stdin.isRaw;
      process.stdin.setRawMode(true);
      process.stdin.resume();
      const finish = (error?: Error) => {
        process.stdin.off('data', onData);
        process.stdin.setRawMode(wasRaw);
        process.stdin.pause();
        process.stderr.write('\n');
        if (error) reject(error);
        else resolve(value.trim());
      };
      const onData = (data: Buffer) => {
        for (const character of data.toString('utf8')) {
          if (character === '\u0003' || character === '\u0004')
            return finish(new Error('Login canceled.'));
          if (character === '\r' || character === '\n') return finish();
          if (character === '\u007f' || character === '\b') value = value.slice(0, -1);
          else if (character >= ' ') value += character;
        }
      };
      process.stdin.on('data', onData);
    });
  }
  if (!token || /\s/.test(token))
    throw new Error('Provide one nonempty API token without whitespace.');
  secrets.add(token);
  return token;
}
