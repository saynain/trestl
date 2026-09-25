import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';

function matches(actual: string | undefined, expected: string) {
  if (!actual) return false;
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Only the native window receives the one-use launch URL over the private stdout pipe. */
export function registerDesktopGateway(app: FastifyInstance, token: string) {
  let launched = false;
  app.addHook('onRequest', async (request, reply) => {
    const address = app.server.address();
    const host = address && typeof address !== 'string' ? `127.0.0.1:${address.port}` : '';
    const origin = `http://${host}`;
    if (
      !host ||
      request.headers.host !== host ||
      (request.headers.origin && request.headers.origin !== origin) ||
      request.headers['sec-fetch-site'] === 'cross-site'
    )
      return reply.code(403).send({ message: 'Desktop request origin is not allowed' });

    const url = new URL(request.url, origin);
    if (url.pathname === '/__desktop/launch' && request.method === 'GET') {
      if (launched || !matches(url.searchParams.get('token') ?? undefined, token))
        return reply.code(403).send({ message: 'Invalid desktop launch' });
      launched = true;
      return reply
        .setCookie('trestl_desktop', token, {
          httpOnly: true,
          sameSite: 'strict',
          path: '/',
        })
        .redirect('/');
    }
    if (!matches(request.cookies.trestl_desktop, token))
      return reply.code(403).send({ message: 'Open this installation in Trestl Desktop' });
    // A changing loopback port cannot support OIDC redirect URLs or a trusted proxy.
    if (url.pathname === '/api/v1/admin/authentication' && request.method !== 'GET')
      return reply.code(400).send({ message: 'Desktop installations use local accounts' });
  });
  app.addHook('onSend', async (_request, reply) => {
    const address = app.server.address();
    const socketOrigin =
      address && typeof address !== 'string' ? ` ws://127.0.0.1:${address.port}` : '';
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Cache-Control', 'no-store');
    reply.header(
      'Content-Security-Policy',
      `default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; font-src 'self' data:; connect-src 'self'${socketOrigin}; worker-src 'self' blob:; frame-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'`,
    );
  });
}
