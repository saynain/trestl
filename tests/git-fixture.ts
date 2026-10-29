import assert from 'node:assert/strict';
import { createServer } from 'node:http';

/**
 * A Gitea server that only answers GET requests and records every call. Each
 * repository has one issue, numbered 1, whose provider ID is the repository ID × 10.
 */
export async function giteaServer() {
  const requests: string[] = [];
  const repositories: Record<string, Record<string, unknown>> = {
    'team/platform': {
      id: 501,
      full_name: 'team/platform',
      private: true,
      has_issues: true,
      permissions: { admin: false, push: true, pull: true },
    },
    'team/docs': {
      id: 502,
      full_name: 'team/docs',
      private: false,
      has_issues: true,
      permissions: { admin: false, push: false, pull: true },
    },
  };
  /** Comments per repository ID; they move with the repository when it is renamed. */
  const comments: Record<string, { id: number; body: string; user: { login: string } }[]> = {};
  /** Answer this many issue requests with HTTP 503 first. */
  const failures = { remaining: 0 };
  const issue = (repository: Record<string, unknown>) => ({
    id: Number(repository.id) * 10,
    number: 1,
    title: `First issue in ${repository.full_name}`,
    body: 'From the repository',
    state: 'open',
    repository: { id: repository.id },
  });
  const server = createServer((request, response) => {
    assert.equal(request.method, 'GET', 'Repository sync never writes to the provider');
    assert.equal(request.headers.authorization, 'token service-account-token');
    const url = new URL(request.url!, 'http://gitea.test');
    requests.push(url.pathname);
    const json = (status: number, body: unknown) => {
      response.writeHead(status, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(body));
    };
    if (url.pathname === '/api/v1/repos/search')
      return json(200, { ok: true, data: Object.values(repositories) });
    const byId = url.pathname.match(/^\/api\/v1\/repositories\/(\d+)$/);
    if (byId) {
      const found = Object.values(repositories).find((row) => String(row.id) === byId[1]);
      return found ? json(200, found) : json(404, {});
    }
    const match = url.pathname.match(
      /^\/api\/v1\/repos\/([^/]+\/[^/]+)(\/issues(\/(\d+))?(\/comments)?)?$/,
    );
    const repository = match && repositories[match[1]!];
    if (!repository) return json(404, { message: 'service-account-token not found' });
    if (!match[2]) return json(200, repository);
    if (failures.remaining > 0) {
      failures.remaining--;
      return json(503, { message: 'service-account-token unavailable' });
    }
    if (match[5]) return json(200, comments[String(repository.id)] ?? []);
    if (match[4]) return match[4] === '1' ? json(200, issue(repository)) : json(404, {});
    const page = url.searchParams.get('page');
    return json(200, page && page !== '1' ? [] : [issue(repository)]);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return {
    server,
    requests,
    repositories,
    comments,
    failures,
    origin: `http://127.0.0.1:${address.port}`,
    /** Rename or transfer a repository, keeping its provider ID. */
    rename(from: string, to: string) {
      repositories[to] = { ...repositories[from], full_name: to };
      delete repositories[from];
    },
  };
}
