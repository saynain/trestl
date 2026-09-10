import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server/app.ts';
import type { AppContext } from '../server/context.ts';

test('readiness checks the database while liveness survives a database outage', async () => {
  const app = await createApp({ dataDir: ':memory:', integrations: false });
  try {
    assert.equal((await app.inject('/health')).statusCode, 200);
    assert.equal((await app.inject('/ready')).statusCode, 200);
    const { db } = (app as typeof app & { context: AppContext }).context;
    const query = db.query;
    db.query = async () => {
      throw new Error('private database connection details');
    };
    try {
      const response = await app.inject('/ready');
      assert.equal(response.statusCode, 503);
      assert.deepEqual(response.json(), { status: 'unavailable' });
      assert.equal((await app.inject('/health')).statusCode, 200);
    } finally {
      db.query = query;
    }
    assert.equal((await app.inject('/ready')).statusCode, 200);
  } finally {
    await app.close();
  }
});
