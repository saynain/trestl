import {
  Action,
  ActionPanel,
  Form,
  Detail,
  popToRoot,
  showToast,
  Toast,
  open,
  useNavigation,
  type LaunchProps,
} from '@raycast/api';
import { useRef, useState } from 'react';
import { api, itemUrl, type Item, type Project, type User } from './api';
import { dateOnly } from './client';
import { useResource } from './use-resource';
import { label, priorities, statuses, UtilityActions } from './common';
interface Values {
  title: string;
  description: string;
  projectId: string;
  type: string;
  priority: string;
  status: string;
  visibility: string;
  assigneeId: string;
  dueDate: Date | null;
  followUpDate: Date | null;
}
export function ItemForm({
  item,
  projectId,
  initialTitle,
  onSaved,
  root = false,
}: {
  item?: Item;
  projectId?: string;
  initialTitle?: string;
  onSaved?: () => void;
  root?: boolean;
}) {
  const projects = useResource<{ data: Project[] }>('projects');
  const users = useResource<{ data: User[] }>('users');
  const [saving, setSaving] = useState(false);
  const busy = useRef(false);
  const [titleError, setTitleError] = useState<string>();
  const { pop } = useNavigation();
  async function submit(values: Values) {
    if (!values.title.trim() || values.title.trim().length > 240) {
      setTitleError('Enter a title of 1–240 characters');
      return;
    }
    if (busy.current) return;
    // Do not clear existing assignments if option loading failed.
    if (!projects.data || !users.data) {
      await showToast({
        style: Toast.Style.Failure,
        title: 'Wait for projects and members to load',
        message: projects.error || users.error,
      });
      return;
    }
    busy.current = true;
    setSaving(true);
    try {
      const body = {
        ...values,
        title: values.title.trim(),
        projectId: values.projectId || null,
        assigneeId: values.assigneeId || null,
        dueDate: dateOnly(values.dueDate),
        followUpDate: dateOnly(values.followUpDate),
      };
      // Only send changed fields: imported issue text is source-owned.
      const payload = item
        ? Object.fromEntries(
            Object.entries(body).filter(([key, value]) => value !== item[key as keyof Item]),
          )
        : body;
      const saved = await api<Item>(item ? `items/${encodeURIComponent(item.id)}` : 'items', {
        method: item ? 'PATCH' : 'POST',
        body: payload,
      });
      await showToast({
        style: Toast.Style.Success,
        title: `${saved.identifier} ${item ? 'updated' : 'created'}`,
        primaryAction: {
          title: 'Open Work Item',
          onAction: () => {
            void open(itemUrl(saved.id));
          },
        },
      });
      onSaved?.();
      if (root) await popToRoot();
      else pop();
    } catch (e) {
      await showToast({
        style: Toast.Style.Failure,
        title: 'Could not save work item',
        message: e instanceof Error ? e.message : 'Request failed',
      });
    } finally {
      busy.current = false;
      setSaving(false);
    }
  }
  const refresh = () => {
    projects.refresh();
    users.refresh();
  };
  // Mount uncontrolled dropdowns only after their default options exist.
  if (!projects.data || !users.data)
    return (
      <Detail
        navigationTitle={item ? `Edit ${item.identifier}` : 'Create Work Item'}
        isLoading={projects.loading || users.loading}
        markdown={projects.error || users.error || 'Loading projects and members…'}
        actions={
          <ActionPanel>
            <UtilityActions refresh={refresh} />
          </ActionPanel>
        }
      />
    );
  return (
    <Form
      navigationTitle={item ? `Edit ${item.identifier}` : 'Create Work Item'}
      isLoading={saving || projects.loading || users.loading}
      enableDrafts={!item}
      actions={
        <ActionPanel>
          <Action.SubmitForm title={item ? 'Save Changes' : 'Create Work Item'} onSubmit={submit} />
          <UtilityActions refresh={refresh} />
        </ActionPanel>
      }
    >
      {(projects.error || users.error) && (
        <Form.Description title="Connection Error" text={projects.error || users.error} />
      )}
      <Form.TextField
        id="title"
        title="Title"
        defaultValue={item?.title || initialTitle || ''}
        placeholder="What needs your attention?"
        error={titleError}
        onChange={() => setTitleError(undefined)}
      />
      <Form.TextArea
        id="description"
        title="Description"
        defaultValue={item?.description || ''}
        placeholder="Add context (Markdown supported)"
      />
      <Form.Dropdown
        id="projectId"
        title="Project"
        defaultValue={item?.projectId || projectId || ''}
      >
        <Form.Dropdown.Item value="" title="Inbox" />
        {projects.data?.data.map((p) => (
          <Form.Dropdown.Item key={p.id} value={p.id} title={`${p.key} · ${p.name}`} />
        ))}
      </Form.Dropdown>
      <Form.Dropdown id="type" title="Type" defaultValue={item?.type || 'task'}>
        {['task', 'bug', 'idea', 'followup'].map((value) => (
          <Form.Dropdown.Item key={value} value={value} title={label(value)} />
        ))}
      </Form.Dropdown>
      <Form.Dropdown id="status" title="Status" defaultValue={item?.status || 'todo'}>
        {statuses.map((value) => (
          <Form.Dropdown.Item key={value} value={value} title={label(value)} />
        ))}
      </Form.Dropdown>
      <Form.Dropdown id="priority" title="Priority" defaultValue={item?.priority || 'none'}>
        {priorities.map((value) => (
          <Form.Dropdown.Item key={value} value={value} title={label(value)} />
        ))}
      </Form.Dropdown>
      <Form.Dropdown id="assigneeId" title="Assignee" defaultValue={item?.assigneeId || ''}>
        <Form.Dropdown.Item value="" title="Unassigned" />
        {users.data?.data.map((u) => (
          <Form.Dropdown.Item key={u.id} value={u.id} title={u.name} />
        ))}
      </Form.Dropdown>
      <Form.DatePicker
        id="dueDate"
        title="Due Date"
        type={Form.DatePicker.Type.Date}
        defaultValue={item?.dueDate ? new Date(`${item.dueDate}T12:00:00`) : null}
      />
      <Form.DatePicker
        id="followUpDate"
        title="Review Date"
        type={Form.DatePicker.Type.Date}
        defaultValue={item?.followUpDate ? new Date(`${item.followUpDate}T12:00:00`) : null}
      />
      <Form.Dropdown
        id="visibility"
        title="Visibility"
        defaultValue={item?.visibility || 'private'}
      >
        <Form.Dropdown.Item value="private" title="Private" />
        <Form.Dropdown.Item value="workspace" title="Workspace" />
      </Form.Dropdown>
    </Form>
  );
}
export default function CreateItem(props: LaunchProps<{ arguments: { title?: string } }>) {
  return <ItemForm root initialTitle={props.arguments?.title} />;
}
