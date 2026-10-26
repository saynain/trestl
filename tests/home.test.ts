import test from 'node:test';
import assert from 'node:assert/strict';
import type { WorkItem } from '../shared/types.ts';
import {
  homeItems,
  homeSection,
  homeTodayKey,
  readHomeToday,
  saveHomeToday,
  tomorrow,
} from '../src/lib/home.ts';

const base: WorkItem = {
  id: 'one',
  identifier: 'IN-1',
  title: 'Review something',
  description: '',
  projectId: null,
  parentId: null,
  type: 'task',
  status: 'todo',
  priority: 'none',
  assigneeId: null,
  dueDate: null,
  followUpDate: null,
  recurrence: null,
  labels: [],
  visibility: 'private',
  creatorId: 'me',
  createdAt: '2026-09-01T12:00:00Z',
  updatedAt: '2026-09-01T12:00:00Z',
  completedAt: null,
  position: 1,
};
const date = '2026-09-09';
const group = (changes: Partial<WorkItem>) => homeSection({ ...base, ...changes }, date);

test('reviews become actionable on their date, independently of delivery dates', () => {
  assert.equal(group({ followUpDate: '2026-09-08' }), 'attention');
  assert.equal(group({ followUpDate: date, dueDate: '2026-12-01' }), 'attention');
  assert.equal(group({ followUpDate: '2026-09-10' }), 'next');
  assert.equal(group({ status: 'in_progress' }), 'continuing');
  assert.equal(group({ status: 'in_review' }), 'continuing');
  assert.equal(group({ status: 'in_progress', followUpDate: '2026-09-10' }), 'continuing');
  assert.equal(homeSection({ ...base, followUpDate: '2026-09-10' }, '2026-09-10'), 'attention');
});

test('continuing work does not compete with immediate deadlines or reviews', () => {
  assert.equal(group({ status: 'in_progress', dueDate: '2026-10-01' }), 'continuing');
  assert.equal(group({ status: 'in_review', dueDate: date }), 'attention');
  assert.equal(group({ status: 'in_progress', followUpDate: date }), 'attention');
});

test('Today selections are private to the workspace, profile and calendar day', () => {
  const existing = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    },
  });
  try {
    const key = homeTodayKey('workspace', 'me', date);
    saveHomeToday(key, ['one']);
    assert.deepEqual(readHomeToday(key), ['one']);
    assert.deepEqual(readHomeToday(homeTodayKey('other', 'me', date)), []);
    assert.deepEqual(readHomeToday(homeTodayKey('workspace', 'other', date)), []);
    assert.deepEqual(readHomeToday(homeTodayKey('workspace', 'me', tomorrow(date))), []);
    values.set(key, '["one",null,"one",2]');
    assert.deepEqual(readHomeToday(key), ['one']);
    values.set(key, 'invalid');
    assert.deepEqual(readHomeToday(key), []);
  } finally {
    if (existing) Object.defineProperty(globalThis, 'localStorage', existing);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  }
});

test('postponing a review never hides a due or overdue deadline', () => {
  assert.equal(group({ dueDate: date, followUpDate: tomorrow(date) }), 'attention');
  assert.equal(group({ dueDate: '2026-09-08', followUpDate: tomorrow(date) }), 'attention');
});

test('undated tasks stay actionable and someday work can be scheduled or promoted', () => {
  assert.equal(group({}), 'next');
  assert.equal(group({ type: 'followup' }), 'next');
  assert.equal(group({ type: 'idea', status: 'backlog' }), 'someday');
  assert.equal(group({ type: 'idea', status: 'todo' }), 'next');
  assert.equal(group({ status: 'backlog', followUpDate: '2026-09-10' }), 'next');
  assert.equal(group({ status: 'backlog', dueDate: date }), 'attention');
  assert.equal(group({ status: 'backlog', dueDate: '2026-09-10' }), 'next');
});

test('Home excludes completed and delegated work and orders by earliest relevant date', () => {
  const items: WorkItem[] = [
    { ...base, id: 'undated' },
    { ...base, id: 'future', followUpDate: '2026-10-01' },
    { ...base, id: 'review', dueDate: '2026-12-01', followUpDate: date },
    { ...base, id: 'due', dueDate: '2026-09-08', followUpDate: '2026-10-01' },
    { ...base, id: 'done', status: 'done' },
    { ...base, id: 'canceled', status: 'canceled' },
    { ...base, id: 'delegated', assigneeId: 'other' },
    { ...base, id: 'other', creatorId: 'other' },
  ];
  assert.deepEqual(
    homeItems(items, 'me').map((i) => i.id),
    ['due', 'review', 'future', 'undated'],
  );
  assert.equal(items[0].id, 'undated');
});

test('tomorrow handles month, year and daylight-saving boundaries as calendar dates', () => {
  assert.equal(tomorrow('2026-09-30'), '2026-10-01');
  assert.equal(tomorrow('2026-12-31'), '2027-01-01');
  assert.equal(tomorrow('2028-02-28'), '2028-02-29');
  assert.equal(tomorrow('2026-03-29'), '2026-03-30');
});
