import { Action, ActionPanel, Icon, openExtensionPreferences } from '@raycast/api';
export const statuses = [
  'backlog',
  'todo',
  'in_progress',
  'in_review',
  'done',
  'canceled',
] as const;
export const priorities = ['none', 'low', 'medium', 'high', 'urgent'] as const;
export const label = (value: string) =>
  value === 'followup'
    ? 'Follow-up'
    : value.replaceAll('_', ' ').replace(/^./, (c) => c.toUpperCase());
export function UtilityActions({ refresh }: { refresh?: () => void }) {
  return (
    <ActionPanel.Section>
      {refresh && (
        <Action
          title="Refresh"
          icon={Icon.ArrowClockwise}
          shortcut={{ modifiers: ['cmd'], key: 'r' }}
          onAction={refresh}
        />
      )}
      <Action
        title="Open Extension Preferences"
        icon={Icon.Gear}
        onAction={openExtensionPreferences}
      />
    </ActionPanel.Section>
  );
}
