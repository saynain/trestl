import { Action, ActionPanel, Icon, List } from '@raycast/api';
import { useState } from 'react';
import { projectUrl, type Project } from './api';
import { WorkList } from './search-items';
import { ItemForm } from './create-item';
import { useResource } from './use-resource';
import { label, UtilityActions } from './common';
export default function SearchProjects() {
  const { data, loading, error, refresh } = useResource<{ data: Project[] }>('projects');
  const [status, setStatus] = useState('active');
  return (
    <List
      navigationTitle="Search Projects"
      isLoading={loading}
      searchBarPlaceholder="Search project name or key…"
      searchBarAccessory={
        <List.Dropdown tooltip="Project status" value={status} onChange={setStatus}>
          <List.Dropdown.Item value="" title="All Projects" />
          {['active', 'planned', 'completed', 'archived'].map((value) => (
            <List.Dropdown.Item key={value} value={value} title={label(value)} />
          ))}
        </List.Dropdown>
      }
      actions={
        <ActionPanel>
          <UtilityActions refresh={refresh} />
        </ActionPanel>
      }
    >
      <List.EmptyView
        title={error ? 'Could Not Load Projects' : 'No Projects Found'}
        description={error || 'Try another search or select All Projects.'}
        icon={error ? Icon.ExclamationMark : Icon.Folder}
        actions={
          <ActionPanel>
            <UtilityActions refresh={refresh} />
          </ActionPanel>
        }
      />
      {data?.data
        .filter((p) => !status || p.status === status)
        .map((project) => (
          <List.Item
            key={project.id}
            title={project.name}
            subtitle={project.key}
            keywords={[project.description]}
            icon={Icon.Folder}
            accessories={[
              { text: label(project.status) },
              {
                icon: project.visibility === 'private' ? Icon.Lock : Icon.Person,
                tooltip: label(project.visibility),
              },
            ]}
            actions={
              <ActionPanel>
                <Action.Push
                  title="Browse Project Work"
                  icon={Icon.List}
                  target={
                    <WorkList
                      title={`${project.key} · ${project.name}`}
                      filters={{ projectId: project.id }}
                    />
                  }
                />
                <Action.OpenInBrowser
                  title="Open Project in Trestl"
                  url={projectUrl(project.id)}
                  shortcut={{ modifiers: ['cmd'], key: 'o' }}
                />
                <Action.Push
                  title="Create Work Item in Project"
                  icon={Icon.Plus}
                  shortcut={{ modifiers: ['cmd'], key: 'n' }}
                  target={<ItemForm projectId={project.id} />}
                />
                <Action.CopyToClipboard
                  title="Copy Project Link"
                  content={projectUrl(project.id)}
                />
                <UtilityActions refresh={refresh} />
              </ActionPanel>
            }
          />
        ))}
    </List>
  );
}
