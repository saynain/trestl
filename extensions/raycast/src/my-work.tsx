import { ActionPanel, List, Icon } from '@raycast/api';
import { type User } from './api';
import { WorkList } from './search-items';
import { useResource } from './use-resource';
import { UtilityActions } from './common';
export default function MyWork() {
  const { data, loading, error, refresh } = useResource<{ authenticated: boolean; user?: User }>(
    'auth/status',
  );
  if (data?.user) return <WorkList title="My Work" filters={{ assigneeId: data.user.id }} />;
  return (
    <List isLoading={loading}>
      <List.EmptyView
        icon={Icon.Person}
        title={
          error
            ? 'Could Not Load My Work'
            : loading
              ? 'Loading My Work…'
              : 'Authentication Required'
        }
        description={error || 'Set a valid personal API token in extension preferences.'}
        actions={
          <ActionPanel>
            <UtilityActions refresh={refresh} />
          </ActionPanel>
        }
      />
    </List>
  );
}
