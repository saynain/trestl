import type { Milestone } from '../../shared/types';
import { useApp } from '../lib/context';
import { shortDate } from '../lib/model';
import { StatusIcon } from './ui';
import './milestone-items.css';

export function MilestoneProgress({ milestone }: { milestone: Milestone }) {
  const { data } = useApp();
  const items = data.items.filter(
    (item) => item.milestoneId === milestone.id && item.projectId === milestone.projectId,
  );
  const done = items.filter((item) => item.status === 'done').length;
  return (
    <span className="milestone-progress" aria-label={`${done} of ${items.length} work items done`}>
      <progress max={items.length || 1} value={done} />
      <span>
        {done}/{items.length} done
      </span>
    </span>
  );
}

export function MilestoneItems({ milestone }: { milestone: Milestone }) {
  const { data, openItem } = useApp();
  const items = data.items.filter(
    (item) => item.milestoneId === milestone.id && item.projectId === milestone.projectId,
  );
  return (
    <div className="milestone-items">
      <MilestoneProgress milestone={milestone} />
      {items.length ? (
        <ul>
          {items.map((item) => (
            <li key={item.id}>
              <button type="button" onClick={() => openItem(item.id)}>
                <StatusIcon status={item.status} />
                <span className="muted">{item.identifier}</span>
                <span>{item.title}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">
          No linked work items. Choose this milestone in a work item’s properties.
        </p>
      )}
    </div>
  );
}

export function MilestoneList({
  milestones,
  onEdit,
}: {
  milestones: Milestone[];
  onEdit?: (milestone: Milestone) => void;
}) {
  return (
    <div className="milestone-linked-list">
      {milestones.map((milestone) => (
        <details key={milestone.id}>
          <summary>
            <strong>{milestone.title}</strong>
            <MilestoneProgress milestone={milestone} />
            <span className="muted">{shortDate(milestone.dueDate) || 'No date'}</span>
          </summary>
          <MilestoneItems milestone={milestone} />
          {onEdit && (
            <button type="button" className="button" onClick={() => onEdit(milestone)}>
              Edit milestone
            </button>
          )}
        </details>
      ))}
    </div>
  );
}
