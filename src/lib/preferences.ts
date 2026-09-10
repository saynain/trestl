import type { User } from '../../shared/types';

type Profile = Pick<User, 'id' | 'workspaceId' | 'role'>;
export interface UiPreferences {
  itemLayout: 'side-panel' | 'centered';
  zenMode: boolean;
}
export const defaultUiPreferences: UiPreferences = { itemLayout: 'side-panel', zenMode: false };
const uiKey = (user: Profile) => `trestl.ui.v1.${user.id}`;
export function readUiPreferences(user: Profile): UiPreferences {
  try {
    const saved = JSON.parse(localStorage.getItem(uiKey(user)) || 'null');
    return {
      itemLayout: saved?.itemLayout === 'centered' ? 'centered' : 'side-panel',
      zenMode: saved?.zenMode === true,
    };
  } catch {
    return { ...defaultUiPreferences };
  }
}
export function saveUiPreferences(user: Profile, preferences: UiPreferences) {
  try {
    localStorage.setItem(uiKey(user), JSON.stringify(preferences));
  } catch {
    /* Preferences may be unavailable in private browsing. */
  }
}
const themeKey = (user: Profile) => `trestl.theme.v1.${user.id}`;
export function readTheme(user: Profile): string {
  try {
    const saved = localStorage.getItem(themeKey(user));
    // Preserve the original administrator's pre-profile preference only.
    const legacy = !user.workspaceId || user.workspaceId === 'default';
    const value =
      saved ?? (legacy && user.role === 'admin' ? localStorage.getItem('trestl-theme') : null);
    return value === 'dark' || value === 'system' ? value : 'light';
  } catch {
    return 'light';
  }
}
export function saveTheme(user: Profile, theme: string) {
  try {
    localStorage.setItem(themeKey(user), theme);
  } catch {
    /* Preferences may be unavailable in private browsing. */
  }
}

export type CanvasTheme = 'light' | 'dark';
const canvasThemeKey = (user: Profile) => `trestl.canvas-theme.v1.${user.id}`;
export function readCanvasTheme(user: Profile): CanvasTheme {
  try {
    return localStorage.getItem(canvasThemeKey(user)) === 'dark' ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}
export function saveCanvasTheme(user: Profile, theme: CanvasTheme) {
  try {
    localStorage.setItem(canvasThemeKey(user), theme);
  } catch {
    /* The editor still switches theme when browser storage is unavailable. */
  }
}
