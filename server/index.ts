import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import fastifyStatic from '@fastify/static';
import { createApp } from './app.ts';
const app = await createApp({ logger: true });
const dist = resolve('dist');
if (existsSync(dist)) {
  await app.register(fastifyStatic, { root: dist, prefix: '/' });
  app.setNotFoundHandler((request, reply) =>
    request.url.startsWith('/api/')
      ? reply.code(404).send({ error: 'not_found', message: 'Endpoint not found' })
      : reply.sendFile('index.html'),
  );
}
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.on(signal, async () => {
    await app.close();
    process.exit(0);
  });
try {
  await app.listen({
    port: Number(process.env.PORT ?? 4317),
    host: process.env.HOST ?? '127.0.0.1',
  });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
