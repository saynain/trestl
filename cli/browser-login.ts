import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { hostname } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { CliError, usage } from './errors.js';
import { secrets } from './auth.js';

export async function browserLogin(
  url: string,
  options: { noBrowser: boolean; name?: string; scope?: string },
): Promise<string> {
  const scope = options.scope ?? 'write';
  if (!['read', 'write'].includes(scope)) throw usage('--scope must be read or write.');
  const name = options.name ?? `CLI on ${hostname()}`;
  if (!name.trim() || name.length > 80) throw usage('--name must contain 1–80 characters.');
  const verifier = randomBytes(32).toString('base64url');
  secrets.add(verifier);
  async function request(path: string, body: unknown) {
    let response: Response;
    try {
      response = await fetch(`${url}/cli-auth/${path}`, {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(20_000),
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(body),
      });
    } catch {
      throw new CliError(
        'CLI login request failed. Check the server URL and connectivity.',
        'network_error',
        6,
      );
    }
    const data = await response.json().catch(() => null);
    if (!data || typeof data !== 'object')
      throw new CliError(
        'Server does not support browser CLI login. Upgrade the server, or use login --token.',
        'protocol_error',
        6,
      );
    return { response, data };
  }
  const { response, data } = await request('device', {
    challenge: createHash('sha256').update(verifier).digest('base64url'),
    name,
    scope,
  });
  if (!response.ok)
    throw new CliError(`Could not start CLI login (HTTP ${response.status}).`, 'unauthorized', 3);
  const expectedUri = `${url}/cli-login?code=${data.userCode}`;
  if (
    typeof data.deviceCode !== 'string' ||
    !/^[A-Za-z0-9_-]{43}$/.test(data.deviceCode) ||
    typeof data.userCode !== 'string' ||
    !/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/.test(data.userCode) ||
    data.verificationUri !== expectedUri ||
    !Number.isFinite(data.expiresIn) ||
    data.expiresIn <= 0 ||
    data.expiresIn > 600 ||
    !Number.isFinite(data.interval) ||
    data.interval < 1 ||
    data.interval > 30
  )
    throw new CliError('Server returned an invalid CLI login response.', 'protocol_error', 6);
  secrets.add(data.deviceCode);
  process.stderr.write(
    `Open ${expectedUri}\nConfirm code ${data.userCode} in your browser. Requested access: ${scope}.\nWaiting for approval (Ctrl+C to cancel)…\n`,
  );
  if (!options.noBrowser) {
    // No shell interpolation; URL is checked against the explicitly selected server.
    const command =
      process.platform === 'darwin'
        ? 'open'
        : process.platform === 'win32'
          ? 'rundll32.exe'
          : 'xdg-open';
    const args =
      process.platform === 'win32' ? ['url.dll,FileProtocolHandler', expectedUri] : [expectedUri];
    const child = spawn(command, args, { detached: true, stdio: 'ignore', shell: false });
    child.on('error', () =>
      process.stderr.write('Could not open a browser automatically. Open the URL above.\n'),
    );
    child.unref();
  }
  const deadline = Date.now() + data.expiresIn * 1000;
  let interval = data.interval * 1000;
  while (Date.now() < deadline) {
    await delay(interval);
    if (Date.now() >= deadline) break;
    const result = await request('token', { deviceCode: data.deviceCode, verifier });
    if (result.response.ok) {
      if (
        typeof result.data.token !== 'string' ||
        !/^ep_[A-Za-z0-9_-]{43}$/.test(result.data.token) ||
        result.data.tokenType !== 'Bearer' ||
        result.data.scope !== scope
      )
        throw new CliError('Server returned an invalid CLI token.', 'protocol_error', 6);
      secrets.add(result.data.token);
      return result.data.token;
    }
    if (result.response.status === 400 && result.data.error === 'authorization_pending') continue;
    if (result.response.status === 429) {
      interval = Math.min(interval + 5000, 30_000);
      continue;
    }
    throw new CliError(
      'CLI login was denied or expired. Run trestl login again.',
      'unauthorized',
      3,
    );
  }
  throw new CliError('CLI login expired. Run trestl login again.', 'unauthorized', 3);
}
