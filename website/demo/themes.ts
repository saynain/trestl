// Keep the production palette library/editor while supplying demo-only theme inheritance.
import type { User } from '../../shared/types';
import * as product from '../../src/lib/themes/index';
import { readDemoMode, saveTheme } from './preferences';
export * from '../../src/lib/themes/index';
type Profile = Pick<User, 'id' | 'workspaceId' | 'role'>;
export function readAppearance(user: Profile): product.ThemePreferences {
  return { ...product.readAppearance(user), mode: readDemoMode() };
}
export function saveAppearance(user: Profile, preferences: product.ThemePreferences): boolean {
  saveTheme(user, preferences.mode);
  return product.saveAppearance(user, preferences);
}
export function watchAppearance(
  user: Profile,
  onChange?: (preferences: product.ThemePreferences) => void,
) {
  const apply = () => {
    const preferences = readAppearance(user);
    product.applyAppearance(preferences);
    onChange?.(preferences);
  };
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  const events = ['trestl:demo-theme', 'trestl-appearance', 'storage'];
  events.forEach((event) => window.addEventListener(event, apply));
  media.addEventListener('change', apply);
  apply();
  return () => {
    events.forEach((event) => window.removeEventListener(event, apply));
    media.removeEventListener('change', apply);
  };
}
