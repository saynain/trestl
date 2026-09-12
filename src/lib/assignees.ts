import type { User } from '../../shared/types';

/** Keep a disabled current assignee visible without offering new assignments to them. */
export function assigneeOptions(users: User[], currentId?: string | null) {
  const names = new Map<string, number>();
  for (const user of users) {
    const name = user.name.trim().toLowerCase();
    names.set(name, (names.get(name) ?? 0) + 1);
  }
  return users
    .filter((user) => !user.disabledAt || user.id === currentId)
    .map((user) => ({
      id: user.id,
      label:
        user.name +
        ((names.get(user.name.trim().toLowerCase()) ?? 0) > 1 ? ` · ${user.email}` : '') +
        (user.disabledAt ? ' (disabled)' : ''),
      disabled: !!user.disabledAt,
    }));
}
