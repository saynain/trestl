import { Action, ActionPanel, Detail, Icon, showToast, Toast } from '@raycast/api';
import { useRef } from 'react';
import { api, itemUrl, type Item, type ItemDetail as DetailData } from './api';
import { ItemForm } from './create-item';
import { label, statuses, priorities, UtilityActions } from './common';
import { useResource } from './use-resource';
export function ItemActions({ item, refresh }: { item: Item; refresh: () => void }) {
  const busy = useRef(false);
  async function update(body: Partial<Item>) {
    if (busy.current) return;
    busy.current = true;
    const toast = await showToast({
      style: Toast.Style.Animated,
      title: `Updating ${item.identifier}`,
    });
    try {
      await api(`items/${encodeURIComponent(item.id)}`, { method: 'PATCH', body });
      toast.style = Toast.Style.Success;
      toast.title = `${item.identifier} updated`;
      refresh();
    } catch (e) {
      toast.style = Toast.Style.Failure;
      toast.title = 'Could not update work';
      toast.message = e instanceof Error ? e.message : 'Request failed';
    } finally {
      busy.current = false;
    }
  }
  return (
    <>
      <Action.OpenInBrowser
        url={itemUrl(item.id)}
        title="Open in Trestl"
        shortcut={{ modifiers: ['cmd'], key: 'o' }}
      />
      <Action.Push
        title="Edit Work Item"
        icon={Icon.Pencil}
        shortcut={{ modifiers: ['cmd'], key: 'e' }}
        target={<ItemForm item={item} onSaved={refresh} />}
      />
      <Action
        title={item.status === 'done' ? 'Reopen Work Item' : 'Mark as Done'}
        icon={Icon.CheckCircle}
        shortcut={{ modifiers: ['cmd', 'shift'], key: 'd' }}
        onAction={() => update({ status: item.status === 'done' ? 'todo' : 'done' })}
      />
      <ActionPanel.Submenu title="Set Status" icon={Icon.Circle}>
        {statuses.map((status) => (
          <Action key={status} title={label(status)} onAction={() => update({ status })} />
        ))}
      </ActionPanel.Submenu>
      <ActionPanel.Submenu title="Set Priority" icon={Icon.Flag}>
        {priorities.map((priority) => (
          <Action key={priority} title={label(priority)} onAction={() => update({ priority })} />
        ))}
      </ActionPanel.Submenu>
      <Action.CopyToClipboard content={item.identifier} title="Copy Identifier" />
      <Action.CopyToClipboard
        content={itemUrl(item.id)}
        title="Copy Link"
        shortcut={{ modifiers: ['cmd', 'shift'], key: 'c' }}
      />
    </>
  );
}
export default function ItemDetail({ id, onChanged }: { id: string; onChanged: () => void }) {
  const resource = useResource<DetailData>(`items/${encodeURIComponent(id)}`);
  const item = resource.data?.item;
  const refresh = () => {
    resource.refresh();
    onChanged();
  };
  const markdown = item
    ? `# ${item.identifier} · ${item.title}\n\n${item.description || '_No description._'}\n\n${resource.data?.activity.length ? '## Activity\n\n' : ''}${resource.data?.activity.map((a) => `**${a.kind === 'comment' ? 'Comment' : 'Update'} · ${a.createdAt.slice(0, 10)}**\n\n${a.body}`).join('\n\n---\n\n') || ''}`
    : resource.error || 'Loading work item…';
  return (
    <Detail
      navigationTitle={item?.identifier || 'Work Item'}
      isLoading={resource.loading}
      markdown={markdown}
      metadata={
        item && (
          <Detail.Metadata>
            <Detail.Metadata.Label title="Status" text={label(item.status)} />
            <Detail.Metadata.Label title="Priority" text={label(item.priority)} />
            <Detail.Metadata.Label title="Type" text={label(item.type)} />
            <Detail.Metadata.Label title="Visibility" text={label(item.visibility)} />
            <Detail.Metadata.Label title="Due Date" text={item.dueDate || 'Not set'} />
            <Detail.Metadata.Label title="Review Date" text={item.followUpDate || 'Not set'} />
            <Detail.Metadata.Label
              title="Recurrence"
              text={item.recurrence ? label(item.recurrence) : 'None'}
            />
            {item.labels.length > 0 && (
              <Detail.Metadata.TagList title="Labels">
                {item.labels.map((value) => (
                  <Detail.Metadata.TagList.Item key={value} text={value} />
                ))}
              </Detail.Metadata.TagList>
            )}
            {resource.data?.links
              .filter((link) => /^https?:\/\//i.test(link.url))
              .map((link) => (
                <Detail.Metadata.Link
                  key={link.id}
                  title={link.title}
                  text={link.kind}
                  target={link.url}
                />
              ))}
          </Detail.Metadata>
        )
      }
      actions={
        <ActionPanel>
          {item && <ItemActions item={item} refresh={refresh} />}
          <UtilityActions refresh={refresh} />
        </ActionPanel>
      }
    />
  );
}
