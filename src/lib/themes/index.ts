import type { User } from '../../../shared/types';
import { readTheme } from '../preferences';
import {
  BUILT_IN_THEMES,
  THEME_COLOR_ROLES,
  T3_CHAT_THEME,
  getThemeColorsForAppearance,
  type ThemeAppearance,
  type ThemeColors,
  type ThemeDefinition,
} from './t3-palettes';
import { T3_CODE_THEME } from './t3-code';
import { CATPPUCCIN_MOCHA_THEME } from './catppuccin-mocha';
export { getThemeColorsForAppearance, THEME_COLOR_ROLES };
export type { ThemeAppearance, ThemeColors, ThemeDefinition };
export type Appearance = ThemeAppearance | 'system';
type Profile = Pick<User, 'id' | 'workspaceId' | 'role'>;
export interface ThemePreferences {
  mode: Appearance;
  light: string;
  dark: string;
  custom: ThemeDefinition[];
}
export const builtInThemes = [T3_CODE_THEME, ...BUILT_IN_THEMES, CATPPUCCIN_MOCHA_THEME];
const key = (user: Profile) => `trestl.appearance.v1.${user.id}`;
const eventName = 'trestl-appearance';
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const appearance = (value: unknown): value is ThemeAppearance =>
  value === 'light' || value === 'dark';
export function validColor(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 120) return false;
  // Only literal colors: no external resources, CSS variables, or inherited values.
  if (
    !/^(#(?:[\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})|(?:oklch|oklab|rgb|rgba|hsl|hsla|hwb|lab|lch|color)\([\d\s.,%+\-/a-z]+\))$/i.test(
      value,
    )
  )
    return false;
  return typeof CSS === 'undefined' || CSS.supports('color', value);
}
function colors(value: unknown, mode: ThemeAppearance): ThemeColors {
  if (!record(value)) throw new Error('Theme colors must be an object.');
  const result = { ...getThemeColorsForAppearance(T3_CHAT_THEME, mode)! };
  for (const [role, color] of Object.entries(value)) {
    if (!THEME_COLOR_ROLES.includes(role as keyof ThemeColors))
      throw new Error(`Unknown color role: ${role}`);
    if (!validColor(color))
      throw new Error(`Invalid color for ${role}. Use a hex, RGB, HSL, or OKLCH color.`);
    result[role as keyof ThemeColors] = color;
  }
  return result;
}
export function parseThemeFile(value: unknown): ThemeDefinition {
  if (!record(value) || value.version !== 1)
    throw new Error('Choose a version 1 T3 Code theme JSON file.');
  if (typeof value.name !== 'string' || !value.name.trim() || value.name.trim().length > 48)
    throw new Error('Give the theme a name of 1–48 characters.');
  const id =
    value.id ??
    value.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');
  if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,47}$/.test(id))
    throw new Error('Theme IDs must be 1–48 lowercase letters, numbers, or hyphens.');
  if (['trestl', 'system', 'light', 'dark', ...builtInThemes.map((t) => t.id)].includes(id))
    throw new Error('That theme ID is reserved. Choose a different ID.');
  if (!appearance(value.appearance)) throw new Error('Theme appearance must be light or dark.');
  const variants: Partial<Record<ThemeAppearance, ThemeColors>> = {};
  if (value.variants !== undefined) {
    if (!record(value.variants)) throw new Error('Theme variants must be an object.');
    for (const [mode, palette] of Object.entries(value.variants)) {
      if (!appearance(mode) || mode === value.appearance)
        throw new Error('Variants must contain only the opposite appearance.');
      variants[mode] = colors(palette, mode);
    }
  }
  return {
    id,
    label: value.name.trim(),
    appearance: value.appearance,
    colors: colors(value.colors, value.appearance),
    variants,
  };
}
export function serializeTheme(theme: ThemeDefinition) {
  return (
    JSON.stringify(
      {
        version: 1,
        id: theme.id,
        name: theme.label,
        appearance: theme.appearance,
        colors: theme.colors,
        variants: theme.variants,
      },
      null,
      2,
    ) + '\n'
  );
}
export function resolveTheme(preferences: ThemePreferences, mode: ThemeAppearance) {
  return (
    [...builtInThemes, ...preferences.custom].find(
      (t) => t.id === preferences[mode] && getThemeColorsForAppearance(t, mode),
    ) ?? null
  );
}
export function readAppearance(user: Profile): ThemePreferences {
  const fallback: ThemePreferences = {
    mode: readTheme(user) as Appearance,
    light: 'trestl',
    dark: 'trestl',
    custom: [],
  };
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(key(user)) ?? 'null');
    if (!record(saved)) return fallback;
    const custom: ThemeDefinition[] = [];
    if (Array.isArray(saved.custom))
      for (const file of saved.custom) {
        try {
          const theme = parseThemeFile(file);
          if (!custom.some((t) => t.id === theme.id)) custom.push(theme);
        } catch {
          /* Ignore an invalid entry without discarding the rest of the library. */
        }
      }
    const result: ThemePreferences = {
      mode: saved.mode === 'system' || appearance(saved.mode) ? saved.mode : fallback.mode,
      light: typeof saved.light === 'string' ? saved.light : 'trestl',
      dark: typeof saved.dark === 'string' ? saved.dark : 'trestl',
      custom,
    };
    for (const mode of ['light', 'dark'] as const)
      if (!resolveTheme(result, mode)) result[mode] = 'trestl';
    return result;
  } catch {
    return fallback;
  }
}
export function saveAppearance(user: Profile, preferences: ThemePreferences): boolean {
  let persisted = true;
  try {
    localStorage.setItem(
      key(user),
      JSON.stringify({
        ...preferences,
        custom: preferences.custom.map((t) => JSON.parse(serializeTheme(t))),
      }),
    );
  } catch {
    persisted = false;
  }
  applyAppearance(preferences);
  window.dispatchEvent(new CustomEvent(eventName, { detail: { userId: user.id, preferences } }));
  return persisted;
}
export function resolvedMode(mode: Appearance, dark: boolean): ThemeAppearance {
  return mode === 'system' ? (dark ? 'dark' : 'light') : mode;
}
export function applyAppearance(preferences: ThemePreferences) {
  const mode = resolvedMode(
    preferences.mode,
    window.matchMedia('(prefers-color-scheme: dark)').matches,
  );
  const root = document.documentElement;
  root.dataset.theme = mode;
  const theme = resolveTheme(preferences, mode);
  root.dataset.palette = theme?.id ?? 'trestl';
  for (const role of THEME_COLOR_ROLES) {
    const color = theme && getThemeColorsForAppearance(theme, mode)?.[role];
    if (color) root.style.setProperty(`--theme-${role}`, color);
    else root.style.removeProperty(`--theme-${role}`);
  }
}
export function watchAppearance(user: Profile, onChange?: (preferences: ThemePreferences) => void) {
  let current = readAppearance(user);
  const apply = () => {
    applyAppearance(current);
    onChange?.(current);
  };
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  const changed = (event: Event) => {
    const detail = (event as CustomEvent).detail;
    if (detail?.userId === user.id) {
      current = detail.preferences;
      apply();
    }
  };
  const stored = (event: StorageEvent) => {
    if (event.key === key(user) || event.key === null) {
      current = readAppearance(user);
      apply();
    }
  };
  apply();
  window.addEventListener(eventName, changed);
  window.addEventListener('storage', stored);
  media.addEventListener('change', apply);
  return () => {
    window.removeEventListener(eventName, changed);
    window.removeEventListener('storage', stored);
    media.removeEventListener('change', apply);
  };
}
