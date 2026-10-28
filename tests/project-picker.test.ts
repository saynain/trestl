import test from 'node:test';
import assert from 'node:assert/strict';
import type { Project } from '../shared/types.ts';
import {
  projectDestination,
  projectPickerSections,
  readProjectHistory,
  recordProjectVisit,
  rememberedTab,
  saveProjectHistory,
  type ProjectHistory,
} from '../src/lib/project-picker.ts';

function project(id: string, name: string, overrides: Partial<Project> = {}): Project {
  return {
    id,
    key: id.toUpperCase(),
    name,
    description: '',
    color: '#34775a',
    icon: 'box',
    parentId: null,
    lifecycle: 'ongoing',
    status: 'active',
    startDate: null,
    dueDate: null,
    visibility: 'workspace',
    ownerId: 'me',
    createdAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}
const projects = [
  project('platform', 'Platform'),
  project('platform-dx', 'Developer experience', { parentId: 'platform' }),
  project('mobile', 'Mobile'),
  project('mobile-dx', 'Developer experience', { parentId: 'mobile' }),
  project('leadership', 'Team leadership', { visibility: 'private' }),
  project('initiatives', 'Initiatives', { parentId: 'leadership' }),
  project('old', 'Old platform', { status: 'archived' }),
];
const names = (entries: { project: Project; path: string[] }[]) =>
  entries.map((entry) => [...entry.path, entry.project.name].join(' / '));

test('visits keep the most recent projects first and remember a restorable view', () => {
  let history: ProjectHistory = { recent: [], views: {} };
  history = recordProjectVisit(history, 'platform', 'board');
  history = recordProjectVisit(history, 'mobile', 'roadmap-present');
  history = recordProjectVisit(history, 'platform', 'list');
  assert.deepEqual(history.recent, ['platform', 'mobile']);
  assert.deepEqual(history.views, { mobile: 'roadmap', platform: 'list' });
  // Unknown destinations still count as a visit without replacing the remembered view.
  history = recordProjectVisit(history, 'mobile', 'settings?item=1');
  assert.deepEqual(history.recent, ['mobile', 'platform']);
  assert.equal(history.views.mobile, 'roadmap');
  for (let index = 0; index < 12; index++)
    history = recordProjectVisit(history, `p${index}`, 'list');
  assert.equal(history.recent.length, 8);
  assert.equal(history.recent[0], 'p11');
});

test('only project views are remembered, never presentations or item state', () => {
  assert.equal(rememberedTab('overview'), 'overview');
  assert.equal(rememberedTab('canvases/abc'), 'canvases/abc');
  assert.equal(rememberedTab('overview/milestone-1'), 'overview/milestone-1');
  assert.equal(rememberedTab('roadmap-present'), 'roadmap');
  assert.equal(rememberedTab('weekly'), undefined);
  assert.equal(rememberedTab('canvases/abc/def'), undefined);
});

test('switching restores the last valid view and drops stale canvas or milestone targets', () => {
  const data = {
    projects,
    milestones: [{ id: 'm1', projectId: 'platform' }],
    canvases: [{ id: 'c1', projectId: 'platform' }],
  } as unknown as Parameters<typeof projectDestination>[0];
  const history = (tab: string): ProjectHistory => ({ recent: [], views: { platform: tab } });
  assert.equal(projectDestination(data, { recent: [], views: {} }, 'platform'), 'overview');
  assert.equal(projectDestination(data, history('board'), 'platform'), 'board');
  assert.equal(projectDestination(data, history('canvases/c1'), 'platform'), 'canvases/c1');
  assert.equal(projectDestination(data, history('canvases/gone'), 'platform'), 'canvases');
  assert.equal(projectDestination(data, history('overview/m1'), 'platform'), 'overview/m1');
  assert.equal(projectDestination(data, history('overview/m2'), 'platform'), 'overview');
  // A milestone with the same id in another project is not this project's milestone.
  assert.equal(
    projectDestination(data, { recent: [], views: { mobile: 'overview/m1' } }, 'mobile'),
    'overview',
  );
});

test('recents and favorites never reveal projects missing from the bootstrap', () => {
  const sections = projectPickerSections(
    { projects },
    [
      { kind: 'project', id: 'secret' },
      { kind: 'view', id: 'platform' },
      { kind: 'project', id: 'mobile' },
    ],
    ['secret', 'platform', 'old', 'mobile-dx', 'mobile'],
    'mobile',
  );
  const recent = sections.find((section) => section.id === 'recent')!;
  const favorites = sections.find((section) => section.id === 'favorites')!;
  // Inaccessible and archived projects are skipped; the current project is not a recent.
  assert.deepEqual(names(recent.entries), ['Platform', 'Mobile / Developer experience']);
  assert.deepEqual(names(favorites.entries), ['Mobile']);
  assert.equal(
    sections.flatMap((section) => section.entries).some((entry) => entry.project.id === 'secret'),
    false,
  );
});

test('all projects follow the tree, with parent paths and inherited privacy', () => {
  const sections = projectPickerSections({ projects }, [], []);
  assert.deepEqual(
    sections.map((section) => section.id),
    ['all'],
  );
  const all = sections[0].entries;
  assert.deepEqual(names(all), [
    'Mobile',
    'Mobile / Developer experience',
    'Platform',
    'Platform / Developer experience',
    'Team leadership',
    'Team leadership / Initiatives',
  ]);
  assert.deepEqual(
    all.filter((entry) => entry.restricted).map((entry) => entry.project.id),
    ['leadership', 'initiatives'],
  );
});

test('typing ranks name matches first and keeps similar children distinguishable', () => {
  const [matches] = projectPickerSections({ projects }, [], ['mobile-dx'], undefined, 'dev');
  assert.equal(matches.id, 'matches');
  // The recently used child wins the tie between identical names.
  assert.deepEqual(names(matches.entries), [
    'Mobile / Developer experience',
    'Platform / Developer experience',
  ]);
  const [byPath] = projectPickerSections({ projects }, [], [], undefined, 'platform dev');
  assert.deepEqual(names(byPath.entries), ['Platform / Developer experience']);
  const [byKey] = projectPickerSections({ projects }, [], [], undefined, 'MOBILE-DX');
  assert.deepEqual(names(byKey.entries), ['Mobile / Developer experience']);
  const [prefix] = projectPickerSections({ projects }, [], [], undefined, 'plat');
  assert.deepEqual(names(prefix.entries), ['Platform', 'Platform / Developer experience']);
  const [none] = projectPickerSections({ projects }, [], [], undefined, 'zzz');
  assert.deepEqual(none.entries, []);
});

test('project history is stored per profile and tolerates broken or blocked storage', () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const values = new Map<string, string>();
  try {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
      },
    });
    assert.deepEqual(readProjectHistory('one'), { recent: [], views: {} });
    saveProjectHistory('one', { recent: ['a', 'b'], views: { a: 'board' } });
    assert.deepEqual(readProjectHistory('one'), { recent: ['a', 'b'], views: { a: 'board' } });
    assert.deepEqual(readProjectHistory('two'), { recent: [], views: {} });
    values.set(
      'trestl.project-history.v1.one',
      JSON.stringify({ recent: ['a', 'a', 4, ''], views: { a: 'weekly', b: 'gantt', c: 3 } }),
    );
    assert.deepEqual(readProjectHistory('one'), { recent: ['a'], views: { b: 'gantt' } });
    values.set('trestl.project-history.v1.one', '{broken');
    assert.deepEqual(readProjectHistory('one'), { recent: [], views: {} });
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() {
        throw new Error('Storage blocked');
      },
    });
    assert.doesNotThrow(() => saveProjectHistory('one', { recent: ['a'], views: {} }));
    assert.deepEqual(readProjectHistory('one'), { recent: [], views: {} });
  } finally {
    if (original) Object.defineProperty(globalThis, 'localStorage', original);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  }
});
