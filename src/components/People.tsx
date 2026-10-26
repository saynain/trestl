import ActivityHeatmap from './ActivityHeatmap';
import { Avatar, EmptyState } from './ui';
import { useApp } from '../lib/context';
import { navigate } from '../lib/model';
import './people.css';

export default function People({ userId }: { userId?: string }) {
  const { data } = useApp();
  const person = data.users.find((user) => user.id === (userId || data.user.id));
  if (!person)
    return (
      <EmptyState
        title="Person not found"
        description="Choose someone in this workspace."
        action={
          <button className="button" onClick={() => navigate('people')}>
            My activity
          </button>
        }
      />
    );
  return (
    <div className="people-content">
      <div className="people-heading">
        <div>
          <h1>People</h1>
          <p>Activity across the work you can see in this workspace.</p>
        </div>
        <label className="field people-picker">
          Person
          <select
            className="input"
            value={person.id}
            onChange={(event) => navigate('people', event.target.value)}
          >
            {[...data.users]
              .sort((a, b) => a.name.localeCompare(b.name))
              .map((user) => (
                <option key={user.id} value={user.id}>
                  {user.name}
                  {user.id === data.user.id ? ' (you)' : ''}
                </option>
              ))}
          </select>
        </label>
      </div>
      <div className="people-profile">
        <Avatar user={person} size={46} />
        <div>
          <h2>{person.name}</h2>
          <p>{person.id === data.user.id ? 'Your activity' : 'Workspace activity'}</p>
        </div>
      </div>
      <ActivityHeatmap key={`${data.user.workspaceId}:${person.id}`} userId={person.id} />
    </div>
  );
}
