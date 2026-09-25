/** Optional isolated ForwardAuth process; no application UI or data routes. */
import { openDatabase } from './db.ts';
import { createTokenGateway } from './token-gateway-app.ts';
const origin = process.env.APP_ORIGIN;
if (!origin || !process.env.DATABASE_URL)
  throw new Error('APP_ORIGIN and DATABASE_URL are required.');
const db = await openDatabase({ databaseUrl: process.env.DATABASE_URL, initialize: false });
const app = await createTokenGateway(db, origin);
app.addHook('onClose', () => db.close());
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, async () => {
    await app.close();
    process.exit(0);
  });
await app.listen({ host: '0.0.0.0', port: Number(process.env.PORT ?? 4318) });
