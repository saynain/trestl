import type { User, Workspace, WorkspaceMembership } from '../shared/types.ts';
import { makeStore, type Database, type Store } from './db.ts';

/** Records created before profiles belong to the original workspace. */
export const workspaceOf = (record: { workspaceId?: string }) => record.workspaceId ?? 'default';
export const sameWorkspace = (a: { workspaceId?: string }, b: { workspaceId?: string }) =>
  workspaceOf(a) === workspaceOf(b);
export const membershipId = (workspaceId: string, userId: string) => `${workspaceId}:${userId}`;
export async function membership(s: Store, workspaceId: string, userId: string) {
  return s.get<WorkspaceMembership>('memberships', membershipId(workspaceId, userId));
}
export async function addMembership(
  s: Store,
  workspaceId: string,
  userId: string,
  role: User['role'],
) {
  return s.put('memberships', { id: membershipId(workspaceId, userId), workspaceId, userId, role });
}
export async function workspaceUser(
  s: Store,
  userId: string,
  workspaceId: string,
): Promise<User | null> {
  const result = await s.query<{ data: User }>(
    `
    SELECT u.data || jsonb_build_object('workspaceId',w.id,'role',m.data->>'role') AS data
    FROM entities u JOIN entities m ON m.collection='memberships' AND m.data->>'userId'=u.id
    JOIN entities w ON w.collection='workspaces' AND w.id=m.data->>'workspaceId'
    WHERE u.collection='users' AND u.id=$1 AND w.id=$2
      AND (w.data->>'kind'='shared' OR w.data->>'ownerId'=u.id)`,
    [userId, workspaceId],
  );
  return result.rows[0]?.data ?? null;
}
export async function workspaceMembers(s: Store, workspaceId: string): Promise<User[]> {
  return (
    await s.query<{ data: User }>(
      `
    SELECT u.data || jsonb_build_object('workspaceId',w.id,'role',m.data->>'role') AS data
    FROM entities u JOIN entities m ON m.collection='memberships' AND m.data->>'userId'=u.id
    JOIN entities w ON w.collection='workspaces' AND w.id=m.data->>'workspaceId'
    WHERE u.collection='users' AND w.id=$1
      AND (w.data->>'kind'='shared' OR w.data->>'ownerId'=u.id) ORDER BY u.id`,
      [workspaceId],
    )
  ).rows.map((r) => r.data);
}
export async function userWorkspaces(
  s: Store,
  userId: string,
): Promise<(Workspace & { role: User['role'] })[]> {
  return (
    await s.query<{ data: Workspace & { role: User['role'] } }>(
      `
    SELECT w.data || jsonb_build_object('role',m.data->>'role') AS data
    FROM entities w JOIN entities m ON m.collection='memberships' AND m.data->>'workspaceId'=w.id
    WHERE w.collection='workspaces' AND m.data->>'userId'=$1
      AND (w.data->>'kind'='shared' OR w.data->>'ownerId'=$1)
    ORDER BY (w.data->>'kind'='personal') DESC, lower(w.data->>'name'), w.id`,
      [userId],
    )
  ).rows.map((r) => r.data);
}
/** Preserve legacy installation boundaries and roles without creating new workspaces per user. */
export async function migrateWorkspaces(db: Database) {
  await db.query('ALTER TABLE sessions ADD COLUMN IF NOT EXISTS workspace_id TEXT');
  await db.query('ALTER TABLE tokens ADD COLUMN IF NOT EXISTS workspace_id TEXT');
  await db.transaction(async (tx) => {
    const s = makeStore(tx);
    await tx.query(
      "SELECT id FROM entities WHERE collection='system' AND id='mutation-lock' FOR UPDATE",
    );
    if (await s.get('system', 'workspace-memberships-v1')) return;
    const users = await s.list<User>('users');
    for (const workspaceId of new Set(users.map(workspaceOf))) {
      const members = users.filter((u) => workspaceOf(u) === workspaceId);
      const owner = members.find((u) => u.role === 'admin') ?? members[0];
      await s.put<Workspace>('workspaces', {
        id: workspaceId,
        name: workspaceId === 'default' ? 'Workspace' : `${owner.name}’s workspace`,
        kind: 'shared',
        ownerId: owner.id,
        createdAt: new Date().toISOString(),
      });
      for (const user of members)
        await addMembership(s, workspaceId, user.id, user.id === owner.id ? 'admin' : user.role);
    }
    // Freeze existing sessions and tokens to their original workspace.
    await tx.query(
      `UPDATE sessions SET workspace_id=COALESCE(e.data->>'workspaceId','default') FROM entities e WHERE e.collection='users' AND e.id=sessions.user_id AND sessions.workspace_id IS NULL`,
    );
    await tx.query(
      `UPDATE tokens SET workspace_id=COALESCE(e.data->>'workspaceId','default') FROM entities e WHERE e.collection='users' AND e.id=tokens.user_id AND tokens.workspace_id IS NULL`,
    );
    for (const view of await s.list<{ id: string; userId: string; workspaceId?: string }>(
      'views',
    )) {
      const owner = users.find((u) => u.id === view.userId);
      if (owner) await s.put('views', { ...view, workspaceId: workspaceOf(owner) });
    }
    await s.put('system', { id: 'workspace-memberships-v1' });
  });
}
