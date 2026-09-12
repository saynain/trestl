import { useState, type FormEvent } from 'react';
import { Upload } from 'lucide-react';
import type { Project } from '../../shared/types';
import type {
  ProjectImportOptions,
  ProjectImportPreview,
  ProjectImportResult,
} from '../../shared/project-transfer';
import { api, post } from '../lib/api';
import { useApp } from '../lib/context';
import { navigate } from '../lib/model';
import { Modal } from './ui';
import { Select } from './Select';
import './project-transfer.css';

export function ExportProject({ project, onClose }: { project: Project; onClose: () => void }) {
  const { toast } = useApp();
  const [busy, setBusy] = useState(false);
  async function download() {
    setBusy(true);
    try {
      const contents = await api(`/projects/${project.id}/export`);
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(contents)], { type: 'application/json' }),
      );
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `${project.key.toLowerCase()}.trestl-project.json`;
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 10000);
      onClose();
      toast('Project export downloaded');
    } catch (error) {
      toast((error as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title="Export project"
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <div className="transfer-body">
        <p>
          Download <strong>{project.name}</strong> and its subprojects as a file you can import into
          another Trestl installation.
        </p>
        <p>
          Includes accessible work items, discussion, roadmaps, milestones, links, relationships,
          and canvases. Private content you cannot access and references outside this project tree
          are excluded.
        </p>
        <p>
          Accounts, memberships, and integration credentials are excluded. The file contains project
          content, so share it only with people who should have access.
        </p>
        <div className="transfer-actions">
          <button className="button" disabled={busy} onClick={() => onClose()}>
            Cancel
          </button>
          <button className="button primary" disabled={busy} onClick={() => void download()}>
            {busy ? 'Preparing…' : 'Download project'}
          </button>
        </div>
      </div>
    </Modal>
  );
}

export function ImportProject() {
  const { data, refresh, toast } = useApp();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [contents, setContents] = useState<unknown>();
  const [preview, setPreview] = useState<ProjectImportPreview>();
  const [options, setOptions] = useState<ProjectImportOptions>();
  const [requestId, setRequestId] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [fileName, setFileName] = useState('');
  // Preserve the exact request after submission so uncertain network responses can
  // be retried safely. A successful import remains recoverable if refresh fails.
  const [submitted, setSubmitted] = useState<ProjectImportOptions>();
  const [result, setResult] = useState<ProjectImportResult>();
  function reset() {
    setError('');
    setContents(undefined);
    setPreview(undefined);
    setOptions(undefined);
    setSubmitted(undefined);
    setResult(undefined);
    setConfirmed(false);
    setFileName('');
    setRequestId(crypto.randomUUID());
  }
  async function load(file: File) {
    reset();
    setBusy(true);
    setFileName(file.name);
    try {
      if (file.size > 32 * 1024 * 1024)
        throw new Error(
          'Choose a project file smaller than 32 MB. Export subprojects separately for larger projects.',
        );
      let value: unknown;
      try {
        value = JSON.parse(await file.text());
      } catch {
        throw new Error('This file is not valid JSON. Choose a Trestl project export.');
      }
      const review = await post<ProjectImportPreview>('/project-import/preview', {
        package: value,
      });
      setContents(value);
      setPreview(review);
      setOptions(review.options);
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function complete(event: FormEvent) {
    event.preventDefault();
    if (!options || !confirmed || busy) return;
    setBusy(true);
    setError('');
    const selection = submitted ?? options;
    setSubmitted(selection);
    try {
      const imported =
        result ??
        (await post<ProjectImportResult>('/project-import', {
          package: contents,
          options: selection,
          requestId,
        }));
      setResult(imported);
      await refresh();
      setOpen(false);
      reset();
      navigate('project', imported.projectId, 'overview');
      toast(
        `Imported ${imported.projectIds.length} project${imported.projectIds.length === 1 ? '' : 's'} and ${imported.itemCount} work items`,
      );
    } catch (error) {
      setError((error as Error).message);
      // Only a definite client rejection permits editing. Network/server failures
      // may have happened after commit; keep the same request for a safe retry.
      if ('status' in (error as object) && (error as { status: number }).status < 500)
        setSubmitted(undefined);
    } finally {
      setBusy(false);
    }
  }
  const members = data.users.filter((u) => !u.disabledAt);
  return (
    <>
      <button
        className="button new-item-button import-project-button"
        aria-label="Import project"
        onClick={() => {
          if (!open && !submitted) reset();
          setOpen(true);
        }}
      >
        <Upload size={15} />
        <span>
          Import<span className="import-project-noun"> project</span>
        </span>
      </button>
      {open && (
        <Modal
          title={preview ? 'Review project import' : 'Import project'}
          wide={!!preview}
          onClose={() => {
            if (!busy) setOpen(false);
          }}
        >
          <form onSubmit={(e) => void complete(e)} className="transfer-body">
            {!preview && (
              <>
                <p>
                  Bring a project and its subprojects from another Trestl installation. You can
                  review names, visibility, and assignees before creating anything.
                </p>
                <label className="field">
                  Project file
                  <input
                    className="input"
                    type="file"
                    accept=".json,application/json"
                    disabled={busy}
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file) void load(file);
                    }}
                  />
                </label>
                <small className="muted">
                  Choose a .trestl-project.json export, up to 32 MB. Installation exports and
                  database backups use different formats.
                </small>
              </>
            )}
            {preview && options && (
              <>
                <p className="muted">{fileName}</p>
                <div className="transfer-summary" aria-label="Import contents">
                  {Object.entries(preview.counts)
                    .filter(([key, count]) => count > 0 || key === 'projects' || key === 'items')
                    .map(([key, count]) => (
                      <span key={key}>
                        <strong>{count}</strong>{' '}
                        {{
                          items: 'work items',
                          activity: 'history entries',
                          canvasCollections: 'canvas collections',
                        }[key] ?? key}
                      </span>
                    ))}
                </div>
                <p>
                  <strong>Owner: {data.user.name} (you)</strong>
                  <br />
                  <span className="muted">
                    Every project is created as a new copy. Existing projects stay unchanged.
                  </span>
                </p>
                <p className="muted">
                  Original author names and dates are kept. Private work items will be visible only
                  to you. Integration credentials are excluded and linked issues become independent
                  copies.
                </p>
                <fieldset disabled={busy || !!submitted} className="transfer-fields">
                  <legend>Project names and access</legend>
                  {options.projects.map((project, index) => (
                    <div className="transfer-project" key={project.id}>
                      <label className="field">
                        {index === 0 ? 'Root project name' : 'Subproject name'}
                        <input
                          className="input"
                          required
                          maxLength={240}
                          value={project.name}
                          onChange={(e) =>
                            setOptions({
                              ...options,
                              projects: options.projects.map((p) =>
                                p.id === project.id ? { ...p, name: e.target.value } : p,
                              ),
                            })
                          }
                        />
                      </label>
                      <label className="field">
                        Key
                        <input
                          className="input"
                          aria-label={`Key for ${project.name}`}
                          required
                          pattern="[A-Z][A-Z0-9]{1,9}"
                          title="2–10 letters or digits, starting with a letter"
                          maxLength={10}
                          value={project.key}
                          onChange={(e) =>
                            setOptions({
                              ...options,
                              projects: options.projects.map((p) =>
                                p.id === project.id
                                  ? { ...p, key: e.target.value.toUpperCase() }
                                  : p,
                              ),
                            })
                          }
                        />
                      </label>
                      <label className="field">
                        Visibility
                        <Select
                          aria-label={`Visibility for ${project.name}`}
                          value={project.visibility}
                          onChange={(e) =>
                            setOptions({
                              ...options,
                              projects: options.projects.map((p) =>
                                p.id === project.id
                                  ? { ...p, visibility: e.target.value as Project['visibility'] }
                                  : p,
                              ),
                            })
                          }
                        >
                          <option value="private">Private</option>
                          <option value="workspace">Workspace</option>
                        </Select>
                      </label>
                    </div>
                  ))}
                  {!!preview.people.length && (
                    <>
                      <h3>Map assignees</h3>
                      <p className="muted">
                        Unmapped assignments become unassigned. Mapping does not invite anyone or
                        grant access to private projects.
                      </p>
                      {preview.people.map((person) => (
                        <label className="field" key={person.id}>
                          {person.name}
                          <Select
                            aria-label={`Assignee for ${person.name}`}
                            value={options.assignees[person.id] ?? ''}
                            onChange={(e) =>
                              setOptions({
                                ...options,
                                assignees: {
                                  ...options.assignees,
                                  [person.id]: e.target.value || null,
                                },
                              })
                            }
                          >
                            <option value="">Unassigned</option>
                            {members.map((member) => (
                              <option key={member.id} value={member.id}>
                                {member.name}
                              </option>
                            ))}
                          </Select>
                        </label>
                      ))}
                    </>
                  )}
                  <details className="transfer-notes">
                    <summary>What changes during import</summary>
                    <ul>
                      {preview.warnings.map((warning) => (
                        <li key={warning}>{warning}</li>
                      ))}
                    </ul>
                  </details>
                  <label className="check-field">
                    <input
                      type="checkbox"
                      checked={confirmed}
                      onChange={(e) => setConfirmed(e.target.checked)}
                    />
                    I reviewed the names, access, and assignments.
                  </label>
                </fieldset>
              </>
            )}
            {error && (
              <p className="transfer-error" role="alert">
                {error}
              </p>
            )}
            {busy && (
              <p role="status">{preview ? 'Importing project…' : 'Reading project file…'}</p>
            )}
            <div className="transfer-actions">
              <button
                type="button"
                className="button"
                disabled={busy}
                onClick={() => setOpen(false)}
              >
                Close
              </button>
              {preview && !submitted && (
                <button type="button" className="button" disabled={busy} onClick={reset}>
                  Choose another file
                </button>
              )}
              {preview && (
                <button className="button primary" type="submit" disabled={!confirmed || busy}>
                  {result
                    ? 'Open imported project'
                    : submitted
                      ? 'Retry import'
                      : 'Import as new projects'}
                </button>
              )}
            </div>
          </form>
        </Modal>
      )}
    </>
  );
}
