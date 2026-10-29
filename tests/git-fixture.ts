import assert from 'node:assert/strict';
import { createServer } from 'node:http';

/** A Gitea server that only answers GET requests and records every call. */
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
  const server = createServer((request, response) => {
    assert.equal(request.method, 'GET', 'Attaching repositories never writes to the provider');
    assert.equal(request.headers.authorization, 'token service-account-token');
    const url = new URL(request.url!, 'http://gitea.test');
    requests.push(url.pathname);
    const json = (status: number, body: unknown) => {
      response.writeHead(status, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(body));
    };
    if (url.pathname === '/api/v1/repos/search')
      return json(200, { ok: true, data: Object.values(repositories) });
    const match = url.pathname.match(
      /^\/api\/v1\/repos\/([^/]+\/[^/]+)(\/issues(\/\d+\/comments)?)?$/,
    );
    const repository = match && repositories[match[1]!];
    if (!repository) return json(404, { message: 'service-account-token not found' });
    if (!match[2]) return json(200, repository);
    if (match[3]) return json(200, []);
    const page = url.searchParams.get('page');
    return json(
      200,
      page && page !== '1'
        ? []
        : [
            {
              id: Number(repository.id) * 10,
              number: 1,
              title: `First issue in ${match[1]}`,
              body: 'From the repository',
              state: 'open',
              repository: { id: repository.id },
            },
          ],
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return { server, requests, repositories, origin: `http://127.0.0.1:${address.port}` };
}
