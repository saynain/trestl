import { Component, lazy, Suspense, useEffect, useState, type ReactNode } from 'react';
import { Pencil, PencilRuler, Plus, Search, Trash2 } from 'lucide-react';
import type { CanvasCollection, CanvasSummary, Project, ProjectCanvas } from '../../shared/types';
import { api, post } from '../lib/api';
import { navigate } from '../lib/model';
import { EmptyState, Modal } from './ui';
import CanvasCard from './CanvasCard';
import CanvasCollectionDialog from './CanvasCollectionDialog';
import { organizeCanvases, type CanvasSort } from '../lib/canvas-organization';
import './canvases.css';

const CanvasEditor = lazy(() => import('./CanvasEditor'));
class EditorBoundary extends Component<
  { children: ReactNode; onClose: () => void },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    if (this.state.failed)
      return (
        <div className="canvas-notice" role="alert">
          <span>The canvas editor could not open. Reload the page to try again.</span>
          <button className="button" onClick={() => window.location.reload()}>
            Reload page
          </button>
          <button className="button" onClick={this.props.onClose}>
            All canvases
          </button>
        </div>
      );
    return this.props.children;
  }
}

export default function Canvases({ project, canvasId }: { project: Project; canvasId?: string }) {
  const [canvases, setCanvases] = useState<CanvasSummary[]>([]);
  const [collections, setCollections] = useState<CanvasCollection[]>([]);
  const [collectionFilter, setCollectionFilter] = useState('all');
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<CanvasSort>('updated');
  const [collectionDialog, setCollectionDialog] = useState<'create' | 'rename' | 'delete'>();
  const [newCollectionId, setNewCollectionId] = useState('');
  const [canvas, setCanvas] = useState<ProjectCanvas>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [retry, setRetry] = useState(0);
  const base = `/projects/${project.id}/canvases`;
  const open = (id?: string) => navigate('project', project.id, id ? `canvases/${id}` : 'canvases');
  useEffect(() => {
    setCollectionFilter('all');
    setQuery('');
    setCollectionDialog(undefined);
  }, [project.id]);
  const selectedCollection = collections.find((item) => item.id === collectionFilter);
  const visibleCanvases = organizeCanvases(canvases, collectionFilter, query, sort);
  const beginCreate = () => {
    setError('');
    setTitle('');
    setNewCollectionId(selectedCollection?.id || '');
    setCreating(true);
  };
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError('');
    setCanvas(undefined);
    const load = async () => {
      try {
        if (canvasId) {
          const result = await api<ProjectCanvas>(`${base}/${encodeURIComponent(canvasId)}`);
          if (active) setCanvas(result);
        } else {
          const [result, groups] = await Promise.all([
            api<{ data: CanvasSummary[] }>(base),
            api<{ data: CanvasCollection[] }>(`/projects/${project.id}/canvas-collections`),
          ]);
          if (active) {
            setCanvases(result.data);
            setCollections(groups.data);
            setCollectionFilter((current) =>
              current === 'all' ||
              current === 'unsorted' ||
              groups.data.some((c) => c.id === current)
                ? current
                : 'unsorted',
            );
          }
        }
      } catch (e) {
        if (active) setError((e as Error).message);
      } finally {
        if (active) setLoading(false);
      }
    };
    void load();
    return () => {
      active = false;
    };
  }, [base, canvasId, retry]);
  if (loading)
    return (
      <div className="canvas-loading" role="status">
        Loading canvases…
      </div>
    );
  if (canvas)
    return (
      <EditorBoundary key={canvas.id} onClose={() => open()}>
        <Suspense
          fallback={
            <div className="canvas-loading" role="status">
              Opening canvas editor…
            </div>
          }
        >
          <CanvasEditor
            key={canvas.id}
            canvas={canvas}
            project={project}
            onClose={() => open()}
            onOpen={open}
            onReload={() => setRetry((n) => n + 1)}
          />
        </Suspense>
      </EditorBoundary>
    );
  return (
    <section className="canvases-page">
      <div className="canvases-heading">
        <div>
          <h2>Canvases</h2>
          <p>A place to think through systems, sketch ideas, and keep the bigger picture.</p>
        </div>
        <button className="button primary" onClick={beginCreate}>
          <Plus size={16} />
          New canvas
        </button>
      </div>
      <div className="canvas-organization">
        <div className="canvas-collection-bar">
          <div className="canvas-collection-filters" role="group" aria-label="Filter by collection">
            {[
              { id: 'all', name: 'All canvases' },
              { id: 'unsorted', name: 'Unsorted' },
              ...collections,
            ].map((group) => (
              <button
                key={group.id}
                aria-pressed={collectionFilter === group.id}
                onClick={() => setCollectionFilter(group.id)}
              >
                {group.name}
                <span>
                  {group.id === 'all'
                    ? canvases.length
                    : canvases.filter((c) => (c.collectionId || 'unsorted') === group.id).length}
                </span>
              </button>
            ))}
          </div>
          <button className="button" onClick={() => setCollectionDialog('create')}>
            <Plus size={14} />
            New collection
          </button>
        </div>
        <div className="canvas-filter-bar">
          <label className="canvas-overview-search">
            <Search size={16} />
            <input
              type="search"
              aria-label="Search canvases"
              placeholder="Search canvases…"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          <label className="canvas-sort">
            Sort by
            <select
              className="input"
              aria-label="Sort canvases"
              value={sort}
              onChange={(event) => setSort(event.target.value as CanvasSort)}
            >
              <option value="updated">Recently edited</option>
              <option value="newest">Newest first</option>
              <option value="alphabetical">Alphabetical</option>
            </select>
          </label>
          {selectedCollection && (
            <div className="canvas-collection-actions">
              <button className="button" onClick={() => setCollectionDialog('rename')}>
                <Pencil size={14} />
                Rename collection
              </button>
              <button
                className="icon-button"
                aria-label="Remove collection"
                title="Remove collection"
                onClick={() => setCollectionDialog('delete')}
              >
                <Trash2 size={15} />
              </button>
            </div>
          )}
        </div>
      </div>
      {error && (
        <div className="canvas-notice" role="alert">
          {error}
          <button className="button" onClick={() => setRetry((n) => n + 1)}>
            Try again
          </button>
          {canvasId && (
            <button className="button" onClick={() => open()}>
              All canvases
            </button>
          )}
        </div>
      )}
      {!error && !canvases.length && (
        <EmptyState
          icon={<PencilRuler size={28} />}
          title="Give your ideas room"
          description="Create an architecture diagram, map a workflow, or sketch your next idea. Your canvases stay with this project."
          action={
            <button className="button" onClick={beginCreate}>
              <Plus size={15} />
              Create your first canvas
            </button>
          }
        />
      )}
      {!error && canvases.length > 0 && visibleCanvases.length === 0 && (
        <EmptyState
          icon={<PencilRuler size={28} />}
          title={query.trim() ? 'No matching canvases' : 'This collection is empty'}
          description={
            query.trim()
              ? 'Try a different name or collection.'
              : 'Create a canvas here, or move one from its card menu.'
          }
          action={
            query.trim() ? (
              <button className="button" onClick={() => setQuery('')}>
                Clear search
              </button>
            ) : (
              <button className="button" onClick={beginCreate}>
                New canvas
              </button>
            )
          }
        />
      )}
      <div className="canvas-grid">
        {visibleCanvases.map((item) => (
          <CanvasCard
            key={item.id}
            item={item}
            collections={collections}
            onOpen={() => open(item.id)}
            onChange={() => setRetry((n) => n + 1)}
          />
        ))}
      </div>
      {collectionDialog && (
        <CanvasCollectionDialog
          projectId={project.id}
          collection={collectionDialog === 'create' ? undefined : selectedCollection}
          deleting={collectionDialog === 'delete'}
          onClose={() => {
            setCollectionDialog(undefined);
            setRetry((n) => n + 1);
          }}
          onDone={(id) => {
            setCollectionDialog(undefined);
            setCollectionFilter(id);
            setRetry((n) => n + 1);
          }}
        />
      )}
      {creating && (
        <Modal
          title="New canvas"
          onClose={() => {
            if (!busy) setCreating(false);
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
                const result = await post<ProjectCanvas>(base, {
                  title: title.trim(),
                  collectionId: newCollectionId || null,
                });
                setCreating(false);
                open(result.id);
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            <label className="field">
              Canvas name
              <input
                autoFocus
                className="input"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="System architecture"
                maxLength={240}
                required
              />
            </label>
            <label className="field">
              Collection
              <select
                className="input"
                aria-label="Collection"
                value={newCollectionId}
                onChange={(event) => setNewCollectionId(event.target.value)}
              >
                <option value="">Unsorted</option>
                {collections.map((group) => (
                  <option key={group.id} value={group.id}>
                    {group.name}
                  </option>
                ))}
              </select>
            </label>
            <p>Saved in {project.name}. Access follows this project.</p>
            {error && <p role="alert">{error}</p>}
            <div className="canvas-form-actions">
              <button
                type="button"
                className="button"
                onClick={() => setCreating(false)}
                disabled={busy}
              >
                Cancel
              </button>
              <button className="button primary" disabled={busy || !title.trim()}>
                {busy ? 'Creating…' : 'Create canvas'}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </section>
  );
}
