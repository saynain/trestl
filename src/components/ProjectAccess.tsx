import { useState } from 'react';
import { LockKeyhole } from 'lucide-react';
import type { Project } from '../../shared/types';
import { useApp } from '../lib/context';
import { projectAccessMembers } from '../lib/project-access';
import { Avatar, Modal } from './ui';
import './project-access.css';

export default function ProjectAccess({ project }: { project: Project }) {
  const { data, editProject } = useApp();
  const [open, setOpen] = useState(false);
  const members = projectAccessMembers(project, data.projects, data.users);
  const onlyYou = members.length === 1 && members[0].id === data.user.id;
  const summary = onlyYou
    ? 'Only you'
    : `${members.length} ${members.length === 1 ? 'person' : 'people'}`;
  return (
    <>
      <button
        type="button"
        className="project-access-trigger"
        aria-label={`Private · ${summary}. View people with access`}
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
      >
        <LockKeyhole size={12} />
        <span>Private · {summary}</span>
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
          title="People with access"
          className="project-access-dialog"
          onClose={() => setOpen(false)}
        >
          <div className="project-access-summary">
            <p>Only these people can access {project.name}.</p>
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
                Manage access
              </button>
            )}
          </div>
        </Modal>
      )}
    </>
  );
}
