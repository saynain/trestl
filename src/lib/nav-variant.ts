/**
 * Temporary navigation exploration for #89. Available in development, or in a build made with
 * VITE_TRESTL_NAV_VARIANTS=true. Remove once a variant is chosen.
 */
export type NavVariant = 'current' | 'a' | 'b' | 'c';
export const navVariants: { id: NavVariant; label: string; description: string }[] = [
  { id: 'current', label: 'Current', description: 'Today’s sidebar and seven page tabs' },
  { id: 'a', label: 'A', description: 'Picker on top, project sections in the sidebar' },
  {
    id: 'b',
    label: 'B',
    description: 'Project block with its own picker, sections in the sidebar',
  },
  { id: 'c', label: 'C', description: 'Sidebar picker, slimmer in-page tabs' },
];
export const navVariantsEnabled =
  import.meta.env.DEV || import.meta.env.VITE_TRESTL_NAV_VARIANTS === 'true';
const key = 'trestl.dev.nav-variant';
const valid = (value: unknown): value is NavVariant =>
  navVariants.some((variant) => variant.id === value);

export function readNavVariant(): NavVariant {
  if (!navVariantsEnabled) return 'current';
  const requested = new URLSearchParams(window.location.search).get('nav');
  if (valid(requested)) return requested;
  try {
    const saved = localStorage.getItem(key);
    return valid(saved) ? saved : 'current';
  } catch {
    return 'current';
  }
}

export function saveNavVariant(variant: NavVariant) {
  try {
    localStorage.setItem(key, variant);
  } catch {
    /* The switch still works for this page view. */
  }
}

/** The sidebar section a project route belongs to. */
export type ProjectSection = 'overview' | 'work' | 'roadmap' | 'canvases' | 'resources';
export const projectSectionLabels: Record<ProjectSection, string> = {
  overview: 'Overview',
  work: 'Work',
  roadmap: 'Roadmap',
  canvases: 'Canvases',
  resources: 'Resources',
};
export function projectSection(tab: string): ProjectSection | undefined {
  if (tab === 'overview' || tab.startsWith('overview/')) return 'overview';
  if (tab === 'list' || tab === 'board' || tab === 'gantt') return 'work';
  if (tab.startsWith('roadmap')) return 'roadmap';
  if (tab === 'canvases' || tab.startsWith('canvases/')) return 'canvases';
  if (tab === 'resources') return 'resources';
  return undefined;
}
