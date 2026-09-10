import { Action, ActionPanel, Icon, List, type LaunchProps } from '@raycast/api';
import { useEffect, useRef, useState } from 'react';
import { api, type Item, type Page } from './api';
import { itemsPath, mergePage } from './client';
import ItemDetail, { ItemActions } from './item-detail';
import { ItemForm } from './create-item';
import { label, statuses, UtilityActions } from './common';

export function WorkList({
  filters = {},
  title = 'Search Work Items',
  initialQuery = '',
}: {
  filters?: Record<string, string>;
  title?: string;
  initialQuery?: string;
}) {
  const [query, setQuery] = useState(initialQuery);
  const [status, setStatus] = useState('');
  const [items, setItems] = useState<Item[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [nextCursor, setNextCursor] = useState<string>();
  const [revision, setRevision] = useState(0);
  const activeRequest = useRef<AbortController | undefined>(undefined);
  const morePending = useRef(false);
  const path = itemsPath(query, { ...filters, ...(status ? { status } : {}) });
  const latestPath = useRef(path);
  latestPath.current = path;
  const refresh = () => setRevision((value) => value + 1);
  useEffect(() => {
    const controller = new AbortController();
    activeRequest.current = controller;
    morePending.current = false;
    setNextCursor(undefined);
    setItems([]);
    setError('');
    setLoading(true);
    const timer = setTimeout(() => {
      api<Page<Item>>(path, { signal: controller.signal })
        .then((result) => {
          if (!controller.signal.aborted && latestPath.current === path) {
            setItems(result.data);
            setNextCursor(result.nextCursor);
          }
        })
        .catch((e: Error) => {
          if (!controller.signal.aborted) setError(e.message);
        })
        .finally(() => {
          if (!controller.signal.aborted) setLoading(false);
        });
    }, 200);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [path, revision]);
  async function loadMore() {
    const controller = activeRequest.current;
    if (loading || morePending.current || !nextCursor || !controller || controller.signal.aborted)
      return;
    morePending.current = true;
    setLoading(true);
    try {
      const result = await api<Page<Item>>(`${path}&cursor=${encodeURIComponent(nextCursor)}`, {
        signal: controller.signal,
      });
      if (!controller.signal.aborted && latestPath.current === path) {
        setItems((current) => mergePage(current, result.data));
        setNextCursor(result.nextCursor);
        setError('');
      }
    } catch (e) {
      if (!controller.signal.aborted) setError(e instanceof Error ? e.message : 'Request failed');
    } finally {
      if (!controller.signal.aborted) {
        morePending.current = false;
        setLoading(false);
      }
    }
  }
  const createAction = (
    <Action.Push
      title="Create Work Item"
      icon={Icon.Plus}
      shortcut={{ modifiers: ['cmd'], key: 'n' }}
      target={<ItemForm projectId={filters.projectId} initialTitle={query} onSaved={refresh} />}
    />
  );
  return (
    <List
      navigationTitle={title}
      isLoading={loading}
      searchText={query}
      searchBarPlaceholder="Search title, description, or identifier…"
      onSearchTextChange={setQuery}
      filtering={false}
      searchBarAccessory={
        <List.Dropdown tooltip="Filter by status" value={status} onChange={setStatus}>
          <List.Dropdown.Item value="" title="All Statuses" />
          {statuses.map((value) => (
            <List.Dropdown.Item key={value} value={value} title={label(value)} />
          ))}
        </List.Dropdown>
      }
      pagination={{
        pageSize: 100,
        hasMore: !!nextCursor && !error,
        onLoadMore: () => {
          void loadMore();
        },
      }}
      actions={
        <ActionPanel>
          {createAction}
          <UtilityActions refresh={refresh} />
        </ActionPanel>
      }
    >
      <List.EmptyView
        icon={error ? Icon.ExclamationMark : Icon.MagnifyingGlass}
        title={error ? 'Could Not Load Work' : 'No Work Items Found'}
        description={error || 'Try another search or capture a work item with ⌘N.'}
        actions={
          <ActionPanel>
            {createAction}
            <UtilityActions refresh={refresh} />
          </ActionPanel>
        }
      />
      {error && items.length > 0 && (
        <List.Item
          title="Could Not Load More Work"
          subtitle={error}
          icon={Icon.ExclamationMark}
          actions={
            <ActionPanel>
              <UtilityActions refresh={refresh} />
            </ActionPanel>
          }
        />
      )}
      {items.map((item) => (
        <List.Item
          key={item.id}
          id={item.id}
          icon={
            item.status === 'done'
              ? Icon.CheckCircle
              : item.status === 'canceled'
                ? Icon.MinusCircle
                : Icon.Circle
          }
          title={item.title}
          subtitle={item.identifier}
          accessories={[
            { text: label(item.status) },
            ...(item.priority !== 'none'
              ? [{ icon: Icon.Flag, tooltip: `${label(item.priority)} priority` }]
              : []),
            ...(item.dueDate ? [{ text: item.dueDate, tooltip: 'Due date' }] : []),
          ]}
          actions={
            <ActionPanel>
              <Action.Push
                title="Show Work Item"
                icon={Icon.Sidebar}
                target={<ItemDetail id={item.id} onChanged={refresh} />}
              />
              <ItemActions item={item} refresh={refresh} />
              {createAction}
              <UtilityActions refresh={refresh} />
            </ActionPanel>
          }
        />
      ))}
    </List>
  );
}
export default function SearchItems(props: LaunchProps<{ arguments: { query?: string } }>) {
  return <WorkList initialQuery={props.arguments?.query} />;
}
