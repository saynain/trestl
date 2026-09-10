import type { User, Workspace } from '../shared/types.ts';
import { makeStore, type Database, type Store } from './db.ts';
import { addMembership } from './workspaces.ts';
export interface Installation {
  id: 'installation';
  workspaceId: string;
  ownerId: string;
}
export const installation = (s: Store) => s.get<Installation>('system', 'installation');

/** Select an existing data boundary; never merge private data or widen project visibility. */
export async function migrateInstallation(db: Database) {
  await db.transaction(async (tx) => {
    const s = makeStore(tx);
    await tx.query(
      "SELECT id FROM entities WHERE collection='system' AND id='mutation-lock' FOR UPDATE",
    );
    if (await installation(s)) return;
    const spaces = await s.list<Workspace>('workspaces');
    if (!spaces.length) return;
    const configured =
      process.env.INSTALLATION_ID?.trim() || process.env.PROXY_AUTH_INSTALLATION_ID?.trim();
    const shared = spaces.filter((w) => w.kind === 'shared');
    const chosen = configured
      ? spaces.find((w) => w.id === configured)
      : shared.length === 1
        ? shared[0]
        : spaces.length === 1
          ? spaces[0]
          : null;
    if (!chosen)
      throw new Error(
        'Choose the existing installation with INSTALLATION_ID. Multiple legacy workspaces will not be merged automatically.',
      );
    await s.put('workspaces', { ...chosen, kind: 'shared' });
    await s.put<Installation>('system', {
      id: 'installation',
      workspaceId: chosen.id,
      ownerId: chosen.ownerId,
    });
  });
}
export async function createInstallation(s: Store, user: User, name: string) {
  const workspace: Workspace = {
    id: 'default',
    name,
    kind: 'shared',
    ownerId: user.id,
    createdAt: new Date().toISOString(),
  };
  await s.put('workspaces', workspace);
  await addMembership(s, workspace.id, user.id, 'admin');
  await s.put<Installation>('system', {
    id: 'installation',
    workspaceId: workspace.id,
    ownerId: user.id,
  });
  return workspace;
}
