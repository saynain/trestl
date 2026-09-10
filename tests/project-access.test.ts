import test from 'node:test';
import assert from 'node:assert/strict';
import type { Project, User } from '../shared/types.ts';
import { projectAccessMembers } from '../src/lib/project-access.ts';

const users: User[] = ['owner', 'alex', 'jamie', 'outsider'].map((id) => ({
  id,
  name: id,
  email: `${id}@example.test`,
  role: 'member',
  color: '#34775a',
}));
const project: Project = {
  id: 'project',
  key: 'TEST',
  name: 'Private project',
  description: '',
  color: '#34775a',
  icon: 'folder',
  parentId: null,
  lifecycle: 'ongoing',
  status: 'active',
  startDate: null,
  dueDate: null,
  visibility: 'private',
  ownerId: 'owner',
  createdAt: '2026-09-10',
};

test('access summaries include the owner and selected members once, with legacy projects owner-only', () => {
  assert.deepEqual(
    projectAccessMembers(project, [project], users).map((u) => u.id),
    ['owner'],
  );
  const shared = { ...project, memberIds: ['jamie', 'owner', 'alex', 'alex', 'missing'] };
  assert.deepEqual(
    projectAccessMembers(shared, [shared], users).map((u) => u.id),
    ['owner', 'alex', 'jamie'],
  );
  const otherWorkspace = { ...users[3], workspaceId: 'other' };
  assert.equal(
    projectAccessMembers({ ...project, memberIds: ['outsider'] }, [project], [otherWorkspace])
      .length,
    0,
  );
});

test('access summaries intersect all ancestor restrictions, including restrictions on the owner', () => {
  const parent = { ...project, id: 'parent', ownerId: 'alex', memberIds: ['jamie'] };
  const child = { ...project, parentId: parent.id, memberIds: ['alex', 'jamie', 'outsider'] };
  assert.deepEqual(
    projectAccessMembers(child, [parent, child], users).map((u) => u.id),
    ['alex', 'jamie'],
  );
  assert.deepEqual(
    projectAccessMembers(child, [{ ...parent, visibility: 'workspace' }, child], users).map(
      (u) => u.id,
    ),
    ['owner', 'alex', 'jamie', 'outsider'],
  );
});

test('missing or cyclic ancestor chains do not claim that users have access', () => {
  const child = { ...project, parentId: 'missing' };
  assert.deepEqual(projectAccessMembers(child, [child], users), []);
  assert.deepEqual(
    projectAccessMembers(
      { ...project, parentId: project.id },
      [{ ...project, parentId: project.id }],
      users,
    ),
    [],
  );
});
