import test from 'node:test';
import assert from 'node:assert/strict';
import { readUiPreferences, saveUiPreferences } from '../src/lib/preferences.ts';

test('UI preferences persist independently for each profile and tolerate unavailable storage', () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const values = new Map<string, string>();
  const user = { id: 'one', role: 'admin' as const };
  const other = { id: 'two', role: 'admin' as const };
  const defaults = { itemLayout: 'side-panel', zenMode: false };
  try {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
      },
    });
    assert.deepEqual(readUiPreferences(user), defaults);
    saveUiPreferences(user, { itemLayout: 'centered', zenMode: true });
    assert.deepEqual(readUiPreferences(user), { itemLayout: 'centered', zenMode: true });
    assert.deepEqual(readUiPreferences(other), defaults);
    values.set('trestl.ui.v1.one', '{broken');
    assert.deepEqual(readUiPreferences(user), defaults);
    values.set('trestl.ui.v1.one', '{"itemLayout":"unknown","zenMode":"false"}');
    assert.deepEqual(readUiPreferences(user), defaults);
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() {
        throw new Error('Storage blocked');
      },
    });
    assert.doesNotThrow(() => saveUiPreferences(user, { itemLayout: 'centered', zenMode: true }));
    assert.deepEqual(readUiPreferences(user), defaults);
  } finally {
    if (original) Object.defineProperty(globalThis, 'localStorage', original);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  }
});
