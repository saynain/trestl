import { useState } from 'react';
import { LockKeyhole, Users } from 'lucide-react';
import type { Project } from '../../shared/types';
import { useApp } from '../lib/context';
import { projectAccessMembers, projectTeamMembers } from '../lib/project-access';
import { Avatar, Modal } from './ui';
import './project-access.css';

export default function ProjectAccess({ project }: { project: Project }) {
  const { data, editProject } = useApp();
  const [open, setOpen] = useState(false);
  const isPrivate = project.visibility === 'private';
  const members = isPrivate
    ? projectAccessMembers(project, data.projects, data.users)
    : projectTeamMembers(project, data.users);
  const onlyYou = members.length === 1 && members[0].id === data.user.id;
  const summary =
    isPrivate && onlyYou
      ? 'Only you'
      : `${members.length} ${members.length === 1 ? 'person' : 'people'}`;
  return (
    <>
      <button
        type="button"
        className="project-access-trigger"
        aria-label={
          isPrivate
            ? `Private · ${summary}. View people with access`
            : `Workspace · ${summary}. View project members`
        }
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
      >
        {isPrivate ? <LockKeyhole size={12} /> : <Users size={12} />}
        <span>
          {isPrivate ? 'Private' : 'Workspace'} · {summary}
        </span>
        {!onlyYou && (
          <span className="project-access-avatars" aria-hidden="true">
            {members.slice(0, 3).map((member) => (
              <Avatar key={member.id} user={member} size={19} />
            ))}
          </span>
        )}
      </button>
      {open && (
        <Modal
          title={isPrivate ? 'People with access' : 'Project members'}
          className="project-access-dialog"
          onClose={() => setOpen(false)}
        >
          <div className="project-access-summary">
            <p>
              {isPrivate
                ? `Only these people can access ${project.name}.`
                : `These people are the project team for ${project.name}. Everyone in the workspace can access this project.`}
            </p>
            <ul className="project-access-list">
              {members.map((member) => (
                <li key={member.id}>
                  <Avatar user={member} size={32} />
                  <div className="project-access-identity">
                    <strong>
                      {member.name}
                      {member.id === data.user.id ? ' (you)' : ''}
                    </strong>
                    <span>{member.email}</span>
                  </div>
                  {member.id === project.ownerId && <span className="muted">Owner</span>}
                </li>
              ))}
            </ul>
            <p className="muted">
              {project.parentId && 'Parent project restrictions also apply. '}
              Individually private items remain private to their creators.
            </p>
            {project.ownerId === data.user.id && (
              <button
                type="button"
                className="button primary"
                onClick={() => {
                  setOpen(false);
                  editProject(project);
                }}
              >
                {isPrivate ? 'Manage access' : 'Manage members'}
              </button>
            )}
          </div>
        </Modal>
      )}
    </>
  );
}
