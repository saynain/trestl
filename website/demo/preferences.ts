import type { User } from '../../shared/types';
export * from '../../src/lib/preferences';
type Profile = Pick<User, 'id' | 'workspaceId' | 'role'>;
type Theme = 'light' | 'dark';
const key = 'trestl.demo.theme';
const canvasKey = 'trestl.demo.canvas-theme';
const websiteKey = 'trestl.website.theme';
const system = matchMedia('(prefers-color-scheme: dark)');
function stored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function valid(value: unknown): value is Theme {
  return value === 'light' || value === 'dark';
}
// Preserve a choice made in the earlier demo while keeping website preferences separate.
let manual = stored(key) || stored('trestl.theme.v1.demo-you');
let canvasManual = stored(canvasKey) || stored('trestl.canvas-theme.v1.demo-you');
function inherited(): Theme {
  try {
    if (window.parent !== window && valid(window.parent.document.documentElement.dataset.theme)) {
      return window.parent.document.documentElement.dataset.theme as Theme;
    }
  } catch {
    /* A standalone or cross-origin embed falls back to its own preferences. */
  }
  const website = stored(websiteKey);
  return valid(website) ? website : system.matches ? 'dark' : 'light';
}
export function readDemoMode(): Theme | 'system' {
  return manual === 'system' ? 'system' : valid(manual) ? manual : inherited();
}
export function readTheme(_user?: Profile): Theme {
  const mode = readDemoMode();
  return mode === 'system' ? (system.matches ? 'dark' : 'light') : mode;
}
export function saveTheme(_user: Profile, theme: string) {
  if (!valid(theme) && theme !== 'system') return;
  manual = theme;
  try {
    localStorage.setItem(key, theme);
  } catch {
    /* Keep the in-memory override. */
  }
}
export function readCanvasTheme(_user: Profile): Theme {
  return valid(canvasManual) ? canvasManual : readTheme();
}
export function saveCanvasTheme(_user: Profile, theme: Theme) {
  canvasManual = theme;
  try {
    localStorage.setItem(canvasKey, theme);
  } catch {
    /* Keep the in-memory override. */
  }
}
export function followWebsiteTheme() {
  const apply = () => {
    document.documentElement.dataset.theme = readTheme();
    window.dispatchEvent(new Event('trestl:demo-theme'));
  };
  apply();
  system.addEventListener('change', apply);
  window.addEventListener('message', (event) => {
    if (
      event.source !== window.parent ||
      event.origin !== window.location.origin ||
      event.data?.type !== 'trestl:follow-website-theme'
    )
      return;
    manual = null;
    canvasManual = null;
    try {
      [
        key,
        canvasKey,
        'trestl.theme.v1.demo-you',
        'trestl.canvas-theme.v1.demo-you',
        'trestl.appearance.v1.demo-you',
      ].forEach((key) => localStorage.removeItem(key));
    } catch {
      /* Clearing the in-memory override is sufficient for this session. */
    }
    apply();
  });
  window.addEventListener('storage', (event) => {
    if (event.key === key || event.key === null) manual = stored(key);
    if (event.key === canvasKey || event.key === null) canvasManual = stored(canvasKey);
    apply();
  });
  try {
    if (window.parent !== window) {
      new MutationObserver(apply).observe(window.parent.document.documentElement, {
        attributes: true,
        attributeFilter: ['data-theme'],
      });
    }
  } catch {
    /* Cross-origin embeds use their own system preference. */
  }
}
