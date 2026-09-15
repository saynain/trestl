import test from 'node:test';
import assert from 'node:assert/strict';
import {
  builtInThemes,
  getThemeColorsForAppearance,
  parseThemeFile,
  readAppearance,
  resolveTheme,
  resolvedMode,
  serializeTheme,
  validColor,
  THEME_COLOR_ROLES,
} from '../src/lib/themes/index.ts';

test('all six original T3 themes have complete light and dark palettes', () => {
  assert.deepEqual(
    builtInThemes.filter((t) => t.id !== 'catppuccin-mocha').map((t) => t.label),
    ['T3 Code', 'T3 Chat', 'Grove', 'Ocean', 'Ember', 'Iris'],
  );
  for (const theme of builtInThemes.filter((t) => t.id !== 'catppuccin-mocha'))
    for (const mode of ['light', 'dark'] as const) {
      const colors = getThemeColorsForAppearance(theme, mode)!;
      assert.deepEqual(Object.keys(colors).sort(), [...THEME_COLOR_ROLES].sort());
      for (const color of Object.values(colors))
        assert.ok(validColor(color), `${theme.id}: ${color}`);
    }
});
test('T3 version 1 themes round trip with both appearances and fill partial palettes', () => {
  const theme = parseThemeFile({
    version: 1,
    id: 'custom-ocean',
    name: 'Custom ocean',
    appearance: 'light',
    colors: { accent: '#123456' },
    variants: { dark: { canvas: '#111111' } },
  });
  assert.equal(theme.colors.accent, '#123456');
  assert.equal(theme.variants?.dark?.canvas, '#111111');
  assert.deepEqual(parseThemeFile(JSON.parse(serializeTheme(theme))), theme);
  assert.equal(Object.keys(theme.colors).length, THEME_COLOR_ROLES.length);
});
test('invalid imports cannot override built-ins or inject nonliteral CSS', () => {
  const file = { version: 1, id: 'custom', name: 'Custom', appearance: 'light', colors: {} };
  for (const invalid of [
    { version: 2 },
    { id: 'ocean' },
    { name: '' },
    { appearance: 'system' },
    { colors: { accent: 'url(https://example.com)' } },
    { colors: { text: 'var(--text)' } },
    { colors: { unknown: '#fff' } },
    { variants: { light: {} } },
  ])
    assert.throws(() => parseThemeFile({ ...file, ...invalid }));
});
test('appearance migration, profile isolation, corruption recovery and separate mode selection', () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: { getItem: (key: string) => values.get(key) ?? null },
  });
  try {
    const user = { id: 'one', role: 'admin' as const };
    values.set('trestl-theme', 'dark');
    assert.equal(readAppearance(user).mode, 'dark');
    assert.equal(readAppearance({ id: 'two', role: 'member' }).mode, 'light');
    values.set(
      'trestl.appearance.v1.one',
      JSON.stringify({
        mode: 'system',
        light: 'grove',
        dark: 'ocean',
        custom: [{ invalid: true }],
      }),
    );
    const preferences = readAppearance(user);
    assert.equal(resolveTheme(preferences, 'light')?.id, 'grove');
    assert.equal(resolveTheme(preferences, 'dark')?.id, 'ocean');
    assert.deepEqual(preferences.custom, []);
    values.set('trestl.appearance.v1.one', '{broken');
    assert.equal(readAppearance(user).dark, 'trestl');
    values.set('trestl.appearance.v1.one', JSON.stringify({ light: 'deleted', dark: 'ocean' }));
    assert.equal(readAppearance(user).light, 'trestl');
    assert.equal(resolvedMode('system', true), 'dark');
    assert.equal(resolvedMode('system', false), 'light');
    assert.equal(resolvedMode('light', true), 'light');
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() {
        throw new Error('blocked');
      },
    });
    assert.equal(readAppearance(user).mode, 'light');
  } finally {
    if (previous) Object.defineProperty(globalThis, 'localStorage', previous);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  }
});

test('system changes, cross-tab updates, blocked storage, and cleanup keep the applied theme consistent', async () => {
  const { watchAppearance, saveAppearance } = await import('../src/lib/themes/index.ts');
  const originals = new Map(
    ['window', 'document', 'localStorage'].map((name) => [
      name,
      Object.getOwnPropertyDescriptor(globalThis, name),
    ]),
  );
  const storage = new Map<string, string>();
  const tokens = new Map<string, string>();
  const root = {
    dataset: {} as Record<string, string>,
    style: {
      setProperty: (key: string, value: string) => tokens.set(key, value),
      removeProperty: (key: string) => tokens.delete(key),
    },
  };
  const media = Object.assign(new EventTarget(), { matches: false });
  const win = Object.assign(new EventTarget(), { matchMedia: () => media });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: win });
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: { documentElement: root },
  });
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    },
  });
  const user = { id: 'live', role: 'admin' as const };
  let stop = () => {};
  try {
    stop = watchAppearance(user);
    saveAppearance(user, { mode: 'system', light: 'grove', dark: 'ocean', custom: [] });
    assert.equal(root.dataset.palette, 'grove');
    media.matches = true;
    media.dispatchEvent(new Event('change'));
    assert.equal(root.dataset.theme, 'dark');
    assert.equal(root.dataset.palette, 'ocean');
    assert.equal(tokens.size, THEME_COLOR_ROLES.length);
    storage.set(
      'trestl.appearance.v1.live',
      JSON.stringify({ mode: 'light', light: 'iris', dark: 'ocean', custom: [] }),
    );
    win.dispatchEvent(Object.assign(new Event('storage'), { key: 'trestl.appearance.v1.live' }));
    assert.equal(root.dataset.palette, 'iris');
    saveAppearance(user, { mode: 'dark', light: 'trestl', dark: 'trestl', custom: [] });
    assert.equal(tokens.size, 0);
    assert.equal(root.dataset.palette, 'trestl');
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() {
        throw new Error('blocked');
      },
    });
    assert.equal(
      saveAppearance(user, { mode: 'light', light: 'ember', dark: 'trestl', custom: [] }),
      false,
    );
    assert.equal(root.dataset.palette, 'ember');
    stop();
    root.dataset.palette = 'stopped';
    media.dispatchEvent(new Event('change'));
    assert.equal(root.dataset.palette, 'stopped');
  } finally {
    stop();
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
});
