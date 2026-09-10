/** Records created before profiles belong to the original workspace. */
export const workspaceOf = (record: { workspaceId?: string }) => record.workspaceId ?? 'default';
export const sameWorkspace = (a: { workspaceId?: string }, b: { workspaceId?: string }) =>
  workspaceOf(a) === workspaceOf(b);
