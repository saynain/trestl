import { useState } from 'react';
import type { CanvasCollection } from '../../shared/types';
import { api, patch, post } from '../lib/api';
import { Modal } from './ui';

export default function CanvasCollectionDialog({
  projectId,
  collection,
  deleting,
  onClose,
  onDone,
}: {
  projectId: string;
  collection?: CanvasCollection;
  deleting?: boolean;
  onClose: () => void;
  onDone: (id: string) => void;
}) {
  const [name, setName] = useState(collection?.name || '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const base = `/projects/${projectId}/canvas-collections`;
  return (
    <Modal
      title={deleting ? 'Remove collection' : collection ? 'Rename collection' : 'New collection'}
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <form
        className="canvas-create"
        onSubmit={async (event) => {
          event.preventDefault();
          if (busy) return;
          setBusy(true);
          setError('');
          try {
            if (deleting && collection) {
              await api(`${base}/${collection.id}`, {
                method: 'DELETE',
                body: JSON.stringify({ expectedRevision: collection.revision }),
              });
              onDone('unsorted');
            } else {
              const result = collection
                ? await patch<CanvasCollection>(`${base}/${collection.id}`, {
                    name: name.trim(),
                    expectedRevision: collection.revision,
                  })
                : await post<CanvasCollection>(base, { name: name.trim() });
              onDone(result.id);
            }
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        {deleting ? (
          <p>
            Remove “{collection?.name}”? Its canvases will move to Unsorted. No diagrams will be
            deleted.
          </p>
        ) : (
          <label className="field">
            Collection name
            <input
              autoFocus
              className="input"
              required
              maxLength={100}
              placeholder="Architecture"
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
        )}
        {error && <p role="alert">{error}</p>}
        <div className="canvas-form-actions">
          <button type="button" className="button" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button
            className={`button ${deleting ? 'danger' : 'primary'}`}
            disabled={busy || (!deleting && !name.trim())}
          >
            {busy
              ? 'Saving…'
              : deleting
                ? 'Remove collection'
                : collection
                  ? 'Save name'
                  : 'Create collection'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
