/** Optional isolated ForwardAuth service for deployments that gate all app traffic. */
import Fastify from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { z } from 'zod';
import type { Database } from './db.ts';
import { registerCliDeviceEndpoints, validGatewayToken } from './cli-login.ts';
export async function createTokenGateway(db: Database, origin: string) {
  const app = Fastify({ logger: false, bodyLimit: 4096 });
  await app.register(rateLimit, { max: 300, timeWindow: '1 minute' });
  app.setErrorHandler((error, _request, reply) => {
    const status =
      error instanceof z.ZodError ? 400 : ((error as { statusCode?: number }).statusCode ?? 503);
    reply.code(status).send({ error: status === 400 ? 'invalid_request' : 'unavailable' });
  });
  app.get('/health', async () => ({ status: 'ok' }));
  app.get('/ready', async (_request, reply) => {
    try {
      await db.query('SELECT 1 FROM cli_logins LIMIT 1');
      return { status: 'ok' };
    } catch {
      return reply.code(503).send({ status: 'unavailable' });
    }
  });
  app.get('/verify', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return reply
      .code((await validGatewayToken(db, request.headers.authorization)) ? 202 : 401)
      .send();
  });
  registerCliDeviceEndpoints(app, db, () => origin);
  return app;
}
