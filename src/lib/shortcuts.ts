/** Shared definitions keep keyboard handling, command hints and help in sync. */
export const shortcuts = {
  command: {
    keys: ['mod+k'],
    label: 'Open command menu',
    group: 'Workspace',
    typing: true,
    dialog: true,
  },
  search: { keys: ['/'], label: 'Search workspace', group: 'Workspace' },
  sidebar: {
    keys: ['mod+b'],
    label: 'Toggle sidebar (zen mode)',
    group: 'Workspace',
    dialog: true,
  },
  help: { keys: ['?'], label: 'Keyboard shortcuts', group: 'Workspace', dialog: true },
  dismiss: { keys: ['escape'], label: 'Close menu or dialog', group: 'Workspace', typing: true },
  create: { keys: ['c'], label: 'Create work item', group: 'Workspace' },
  home: { keys: ['g h'], label: 'Go to Home', group: 'Navigation' },
  inbox: { keys: ['g i'], label: 'Go to Inbox', group: 'Navigation' },
  myWork: { keys: ['g m'], label: 'Go to My work', group: 'Navigation' },
  projects: { keys: ['g p'], label: 'Go to All projects', group: 'Navigation' },
  settings: { keys: ['g s'], label: 'Go to Settings', group: 'Navigation' },
  findItem: { keys: ['o i'], label: 'Find a work item', group: 'Navigation' },
  findProject: { keys: ['o p'], label: 'Switch project', group: 'Navigation' },
  listSearch: {
    keys: ['mod+f'],
    label: 'Search current list or board',
    group: 'Lists & boards',
    typing: true,
  },
  filter: { keys: ['f'], label: 'Open filters', group: 'Lists & boards' },
  layout: { keys: ['shift+b'], label: 'Switch list / board', group: 'Lists & boards' },
  next: {
    keys: ['j', 'arrowdown'],
    label: 'Focus next work item',
    group: 'Lists & boards',
    repeat: true,
  },
  previous: {
    keys: ['k', 'arrowup'],
    label: 'Focus previous work item',
    group: 'Lists & boards',
    repeat: true,
  },
  open: { keys: ['enter'], label: 'Open focused work item', group: 'Lists & boards' },
  expandTree: {
    keys: ['arrowright'],
    label: 'Expand subtasks / focus first child',
    group: 'Lists & boards',
  },
  collapseTree: {
    keys: ['arrowleft'],
    label: 'Collapse subtasks / focus parent',
    group: 'Lists & boards',
  },
  status: { keys: ['s'], label: 'Change status', group: 'Work items' },
  priority: { keys: ['p'], label: 'Change priority', group: 'Work items' },
  assignee: { keys: ['a'], label: 'Change assignee', group: 'Work items' },
  assignMe: { keys: ['i'], label: 'Assign to me', group: 'Work items' },
  project: { keys: ['shift+p'], label: 'Move to project', group: 'Work items' },
  labels: { keys: ['l'], label: 'Edit tags', group: 'Work items' },
  dueDate: { keys: ['shift+d'], label: 'Set due date', group: 'Work items' },
  title: { keys: ['t'], label: 'Edit title', group: 'Work items' },
  description: { keys: ['d'], label: 'Edit description', group: 'Work items' },
  comment: { keys: ['m'], label: 'Focus comment editor', group: 'Work items' },
  subtask: { keys: ['mod+shift+o'], label: 'Create subtask', group: 'Work items' },
  copyLink: { keys: ['mod+shift+,'], label: 'Copy work item link', group: 'Work items' },
  copyId: { keys: ['mod+shift+.'], label: 'Copy work item identifier', group: 'Work items' },
  composeStatus: {
    keys: ['ctrl+shift+s'],
    label: 'Set status',
    group: 'While creating',
    typing: true,
  },
  composePriority: {
    keys: ['ctrl+shift+p'],
    label: 'Set priority',
    group: 'While creating',
    typing: true,
  },
  composeAssignee: {
    keys: ['ctrl+shift+a'],
    label: 'Set assignee',
    group: 'While creating',
    typing: true,
  },
  composeProject: {
    keys: ['ctrl+shift+j'],
    label: 'Set project',
    group: 'While creating',
    typing: true,
  },
  submit: { keys: ['mod+enter'], label: 'Create work item', group: 'While creating', typing: true },
  createMore: {
    keys: ['mod+shift+enter'],
    label: 'Create and keep composing',
    group: 'While creating',
    typing: true,
  },
} satisfies Record<string, ShortcutDefinition>;

export interface ShortcutDefinition {
  keys: string[];
  label: string;
  group: string;
  typing?: boolean;
  dialog?: boolean;
  repeat?: boolean;
}
export type ShortcutId = keyof typeof shortcuts;
export type ItemAction =
  | 'status'
  | 'priority'
  | 'assignee'
  | 'project'
  | 'labels'
  | 'dueDate'
  | 'title'
  | 'description'
  | 'comment';
export const itemActions: ItemAction[] = [
  'status',
  'priority',
  'assignee',
  'project',
  'labels',
  'dueDate',
  'title',
  'description',
  'comment',
];
export type KeyInput = Pick<
  KeyboardEvent,
  'key' | 'code' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'isComposing' | 'repeat'
>;

export function matchesStroke(event: KeyInput, stroke: string, mac: boolean): boolean {
  if (event.isComposing || event.key === 'Dead' || event.key === 'Process') return false;
  const parts = stroke.split('+');
  const key = parts.at(-1)!;
  const mod = parts.includes('mod');
  if (event.metaKey !== (mod && mac)) return false;
  if (event.ctrlKey !== (parts.includes('ctrl') || (mod && !mac))) return false;
  if (event.altKey !== parts.includes('alt')) return false;
  // '?' already includes Shift on common layouts; punctuation with explicit modifiers uses code.
  if (key !== '?' && event.shiftKey !== parts.includes('shift')) return false;
  const actual =
    parts.includes('shift') && key === ','
      ? event.code === 'Comma'
        ? ','
        : event.key
      : parts.includes('shift') && key === '.'
        ? event.code === 'Period'
          ? '.'
          : event.key
        : event.key.toLowerCase();
  return actual === key;
}

export function formatShortcut(
  keys: string,
  mac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform),
): string {
  const labels: Record<string, string> = {
    mod: mac ? '⌘' : 'Ctrl',
    ctrl: mac ? '⌃' : 'Ctrl',
    shift: mac ? '⇧' : 'Shift',
    alt: mac ? '⌥' : 'Alt',
    arrowup: '↑',
    arrowdown: '↓',
    enter: '↵',
    escape: 'Esc',
  };
  return keys
    .split(' ')
    .map((stroke) =>
      stroke
        .split('+')
        .map((key) => labels[key] || key.toUpperCase())
        .join(mac ? ' ' : ' + '),
    )
    .join(' then ');
}

/** Resolves chords before single-letter actions and expires incomplete sequences. */
export class ShortcutMatcher {
  private pending: { prefix: string; at: number } | null = null;
  reset() {
    this.pending = null;
  }
  match(
    event: KeyInput,
    ids: ShortcutId[],
    mac: boolean,
    now: number,
  ): { id?: ShortcutId; prefix?: string } {
    if (event.isComposing) {
      this.reset();
      return {};
    }
    if (event.repeat) ids = ids.filter((id) => (shortcuts[id] as ShortcutDefinition).repeat);
    if (this.pending && now - this.pending.at <= 1000) {
      const { prefix } = this.pending;
      this.reset();
      const id = ids.find((id) =>
        shortcuts[id].keys.some((key) => {
          const parts = key.split(' ');
          return parts.length === 2 && parts[0] === prefix && matchesStroke(event, parts[1], mac);
        }),
      );
      if (id) return { id };
    }
    this.reset();
    for (const id of ids) {
      for (const key of shortcuts[id].keys) {
        const parts = key.split(' ');
        if (!matchesStroke(event, parts[0], mac)) continue;
        if (parts.length > 1) {
          this.pending = { prefix: parts[0], at: now };
          return { prefix: parts[0] };
        }
        return { id };
      }
    }
    return {};
  }
}
