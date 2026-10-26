import { useRef, useState } from 'react';
import { ArrowDown, ArrowUp, Bookmark, Search, Star } from 'lucide-react';
import { useApp } from '../lib/context';
import { favoriteEntries, hasFavorite, toggleFavorite } from '../lib/navigation';
import { navigate } from '../lib/model';
import type { Favorite } from '../lib/preferences';
import { Modal, ProjectIcon } from './ui';

export function FavoriteButton({
  entry,
  name,
  onRemove,
}: {
  entry: Favorite;
  name: string;
  onRemove?: () => void;
}) {
  const { uiPreferences, updateUiPreferences } = useApp();
  const active = hasFavorite(uiPreferences.favorites, entry);
  const label = `${active ? 'Remove' : 'Add'} ${name} ${active ? 'from' : 'to'} favorites`;
  return (
    <button
      className={`icon-button favorite-button ${active ? 'is-favorite' : ''}`}
      aria-label={label}
      title={label}
      aria-pressed={active}
      onClick={() => {
        updateUiPreferences({ favorites: toggleFavorite(uiPreferences.favorites, entry) });
        if (active) onRemove?.();
      }}
    >
      <Star size={17} fill={active ? 'currentColor' : 'none'} />
    </button>
  );
}

export function FavoritesDialog({ onClose }: { onClose: () => void }) {
  const { data, uiPreferences, updateUiPreferences } = useApp();
  const favorites = favoriteEntries(data, uiPreferences.favorites);
  const [tab, setTab] = useState<'favorites' | 'projects' | 'views'>(
    favorites.length ? 'favorites' : 'projects',
  );
  const [query, setQuery] = useState('');
  const search = useRef<HTMLInputElement>(null);
  const entries =
    tab === 'favorites'
      ? favorites
      : tab === 'projects'
        ? data.projects
            .filter((project) => project.status !== 'archived')
            .sort((a, b) => a.name.localeCompare(b.name))
            .map((project) => ({
              kind: 'project' as const,
              id: project.id,
              name: project.name,
              project,
              view: undefined,
            }))
        : [...data.views]
            .sort((a, b) => a.name.localeCompare(b.name))
            .map((view) => ({
              kind: 'view' as const,
              id: view.id,
              name: view.name,
              project: undefined,
              view,
            }));
  const filtered = entries.filter((entry) =>
    `${entry.name} ${entry.project?.key || ''}`.toLowerCase().includes(query.toLowerCase().trim()),
  );
  function move(entry: Favorite, direction: number) {
    // Reorder the visible favorites without dropping temporarily inaccessible entries.
    const index = favorites.findIndex(
      (favorite) => favorite.kind === entry.kind && favorite.id === entry.id,
    );
    const neighbor = favorites[index + direction];
    if (!neighbor) return;
    const next = [...uiPreferences.favorites];
    const from = next.findIndex(
      (favorite) => favorite.kind === entry.kind && favorite.id === entry.id,
    );
    const to = next.findIndex(
      (favorite) => favorite.kind === neighbor.kind && favorite.id === neighbor.id,
    );
    [next[from], next[to]] = [next[to], next[from]];
    updateUiPreferences({ favorites: next });
  }
  return (
    <Modal title="Your favorites" onClose={onClose} className="navigation-dialog">
      <p className="navigation-dialog-intro">
        Keep the projects and saved views you return to close at hand.
      </p>
      <nav className="navigation-dialog-tabs" aria-label="Favorite sources">
        {(
          [
            ['favorites', 'Favorites'],
            ['projects', 'Projects'],
            ['views', 'Saved views'],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            className={tab === value ? 'active' : ''}
            aria-current={tab === value ? 'page' : undefined}
            onClick={() => {
              setTab(value);
              setQuery('');
            }}
          >
            {label}
          </button>
        ))}
      </nav>
      <label className="navigation-search">
        <Search size={16} />
        <input
          ref={search}
          aria-label="Find projects or saved views"
          placeholder="Find a project or saved view…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </label>
      <div className="navigation-results">
        {filtered.map((entry) => {
          const parent = entry.project?.parentId
            ? data.projects.find((project) => project.id === entry.project?.parentId)
            : undefined;
          const index = favorites.findIndex(
            (favorite) => favorite.kind === entry.kind && favorite.id === entry.id,
          );
          return (
            <div className="navigation-entry" key={`${entry.kind}:${entry.id}`}>
              <button
                className="navigation-entry-main"
                onClick={() => {
                  navigate(entry.kind, entry.id, entry.view?.layout || 'overview');
                  onClose();
                }}
              >
                {entry.project ? (
                  <ProjectIcon project={entry.project} size={19} />
                ) : (
                  <Bookmark size={19} />
                )}
                <span>
                  <strong>{entry.name}</strong>
                  <small>{entry.project ? parent?.name || entry.project.key : 'Saved view'}</small>
                </span>
              </button>
              {tab === 'favorites' && (
                <div className="favorite-order">
                  <button
                    className="icon-button"
                    aria-label={`Move ${entry.name} up`}
                    disabled={!!query || index === 0}
                    onClick={() => move(entry, -1)}
                  >
                    <ArrowUp size={15} />
                  </button>
                  <button
                    className="icon-button"
                    aria-label={`Move ${entry.name} down`}
                    disabled={!!query || index === favorites.length - 1}
                    onClick={() => move(entry, 1)}
                  >
                    <ArrowDown size={15} />
                  </button>
                </div>
              )}
              <FavoriteButton
                entry={entry}
                name={entry.name}
                onRemove={tab === 'favorites' ? () => search.current?.focus() : undefined}
              />
            </div>
          );
        })}
        {!filtered.length && (
          <p className="navigation-empty">
            {query
              ? 'No matches. Try another name.'
              : tab === 'favorites'
                ? 'Choose projects or saved views to add your first favorite.'
                : tab === 'views'
                  ? 'Save a filtered work list to create a view.'
                  : 'Your projects will appear here.'}
          </p>
        )}
      </div>
      <div className="navigation-dialog-footer">
        <span>Favorites are saved in this browser.</span>
        <button className="button" onClick={onClose}>
          Done
        </button>
      </div>
    </Modal>
  );
}
