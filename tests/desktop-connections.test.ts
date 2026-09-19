import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server/app.ts';
import packageInfo from '../package.json' with { type: 'json' };

test('remote desktop discovery reports installation identity and a separate bridge version without exposing users', async () => {
  const app = await createApp({ dataDir: ':memory:', integrations: false });
  try {
    const initial = (await app.inject('/api/v1/auth/status')).json();
    assert.deepEqual(initial.desktop, { bridgeVersion: 1, serverVersion: packageInfo.version });
    assert.equal(initial.authenticated, false);
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/setup',
      payload: {
        name: 'Owner',
        email: 'owner@example.test',
        password: 'desktop-discovery-password',
        installationName: 'Remote installation',
      },
    });
    assert.equal(created.statusCode, 201);
    const status = (await app.inject('/api/v1/auth/status')).json();
    assert.equal(status.installationName, 'Remote installation');
    assert.equal(status.authenticated, false);
    assert.equal(status.user, undefined);
    assert.deepEqual(status.desktop, initial.desktop);
  } finally {
    await app.close();
  }
});
