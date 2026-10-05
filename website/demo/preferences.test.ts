import assert from 'node:assert/strict';
import { test } from 'node:test';

test('demo follows its host, preserves manual choices, and falls back safely without storage', async () => {
  const values = new Map<string, string>();
  let storageBlocked = false;
  const storage = {
    getItem(key: string) {
      if (storageBlocked) throw Error('Blocked');
      return values.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      if (storageBlocked) throw Error('Blocked');
      values.set(key, value);
    },
    removeItem(key: string) {
      if (storageBlocked) throw Error('Blocked');
      values.delete(key);
    },
  };
  const media = Object.assign(new EventTarget(), { matches: false });
  const root = { dataset: { theme: 'light' } };
  const host = { document: { documentElement: root } };
  const frame = Object.assign(new EventTarget(), {
    parent: host,
    location: { origin: 'https://demo.test' },
  });
  const document = { documentElement: { dataset: { theme: '' } } };
  let hostChanged = () => {};
  const globals = {
    window: frame,
    document,
    localStorage: storage,
    matchMedia: () => media,
    MutationObserver: class {
      constructor(callback: () => void) {
        hostChanged = callback;
      }
      observe() {}
    },
  };
  const previous = new Map(
    Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  );
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { value, configurable: true });
  try {
    const {
      followWebsiteTheme,
      readTheme,
      saveTheme,
      readCanvasTheme,
      saveCanvasTheme,
      readUiPreferences,
      saveUiPreferences,
    } = await import('./preferences');
    const user = { id: 'demo-you', role: 'admin' as const, workspaceId: 'demo' };
    values.set(
      'trestl.ui.v1.demo-you',
      JSON.stringify({
        itemLayout: 'centered',
        favorites: [{ kind: 'project', id: 'real-project' }],
      }),
    );
    assert.deepEqual(readUiPreferences(user).favorites, []);
    saveUiPreferences(user, {
      itemLayout: 'centered',
      zenMode: true,
      favorites: [
        { kind: 'project', id: 'studio' },
        { kind: 'view', id: 'priority' },
      ],
    });
    assert.deepEqual(readUiPreferences(user).favorites, [
      { kind: 'project', id: 'studio' },
      { kind: 'view', id: 'priority' },
    ]);
    assert.deepEqual(readUiPreferences({ ...user, workspaceId: 'other' }).favorites, []);
    assert.deepEqual(readUiPreferences({ ...user, id: 'other' }).favorites, []);
    assert.equal(JSON.parse(values.get('trestl.ui.v1.demo-you')!).favorites[0].id, 'real-project');
    followWebsiteTheme();
    assert.equal(document.documentElement.dataset.theme, 'light');
    root.dataset.theme = 'dark';
    hostChanged();
    assert.equal(document.documentElement.dataset.theme, 'dark');
    assert.equal(readCanvasTheme(user), 'dark');
    saveTheme(user, 'light');
    root.dataset.theme = 'light';
    hostChanged();
    root.dataset.theme = 'dark';
    hostChanged();
    assert.equal(document.documentElement.dataset.theme, 'light');
    assert.equal(values.get('trestl.demo.theme'), 'light');
    saveCanvasTheme(user, 'dark');
    assert.equal(readCanvasTheme(user), 'dark');
    const reset = (origin: string) =>
      frame.dispatchEvent(
        Object.assign(new Event('message'), {
          source: host,
          origin,
          data: { type: 'trestl:follow-website-theme' },
        }),
      );
    reset('https://unrelated.test');
    assert.equal(readTheme(user), 'light');
    reset(frame.location.origin);
    assert.equal(readTheme(user), 'dark');
    assert.equal(values.has('trestl.demo.theme'), false);
    root.dataset.theme = 'light';
    hostChanged();
    assert.equal(readCanvasTheme(user), 'light');
    // Standalone previews follow the website's saved choice, then the OS.
    Object.defineProperty(frame, 'parent', { value: frame });
    values.set('trestl.website.theme', 'dark');
    assert.equal(readTheme(user), 'dark');
    values.set('trestl.website.theme', 'system');
    media.matches = true;
    media.dispatchEvent(new Event('change'));
    assert.equal(document.documentElement.dataset.theme, 'dark');
    media.matches = false;
    media.dispatchEvent(new Event('change'));
    assert.equal(document.documentElement.dataset.theme, 'light');
    storageBlocked = true;
    assert.deepEqual(readUiPreferences(user).favorites, []);
    assert.doesNotThrow(() =>
      saveUiPreferences(user, { itemLayout: 'side-panel', zenMode: false, favorites: [] }),
    );
    saveTheme(user, 'dark');
    media.dispatchEvent(new Event('change'));
    assert.equal(readTheme(user), 'dark');
  } finally {
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
