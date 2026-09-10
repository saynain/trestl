import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  ArrowUpRight,
  BookOpen,
  Check,
  ChevronDown,
  ChevronUp,
  Link2,
  Loader2,
  Search,
  Settings,
} from 'lucide-react';
import { api, post } from '../lib/api';
import { useApp } from '../lib/context';
import { navigate } from '../lib/model';
import { Modal } from './ui';
import './item.css';
interface Connection {
  deployment: 'cloud' | 'datacenter';
  baseUrl: string;
}
interface Page {
  id: string;
  title: string;
  url: string;
  excerpt: string;
  updatedAt?: string | null;
}
interface SearchResults {
  data: Page[];
  hasMore: boolean;
}
const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : 'Could not reach Confluence. Please try again.';
export default function ConfluenceSearch({
  projectId,
  onClose,
}: {
  projectId: string;
  onClose: () => void;
}) {
  const { data, refresh, toast } = useApp();
  const project = data.projects.find((p) => p.id === projectId);
  const [connection, setConnection] = useState<Connection | null>(null);
  const [loadingConnection, setLoadingConnection] = useState(true);
  const [connectionError, setConnectionError] = useState('');
  const [query, setQuery] = useState('');
  const [searchedFor, setSearchedFor] = useState('');
  const [results, setResults] = useState<SearchResults | null>(null);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState('');
  const [preview, setPreview] = useState<Page | null>(null);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [previewError, setPreviewError] = useState('');
  const [linking, setLinking] = useState<string | null>(null);
  const [linked, setLinked] = useState(new Set<string>());
  const [connectionAttempt, setConnectionAttempt] = useState(0);
  const searchRequest = useRef<AbortController | null>(null);
  const previewRequest = useRef<AbortController | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      searchRequest.current?.abort();
      previewRequest.current?.abort();
    };
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    setLoadingConnection(true);
    setConnectionError('');
    api<Connection | null>('/confluence/connection', { signal: controller.signal })
      .then((value) => {
        if (!controller.signal.aborted) setConnection(value);
      })
      .catch((err) => {
        if (!controller.signal.aborted) setConnectionError(errorMessage(err));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoadingConnection(false);
      });
    return () => controller.abort();
  }, [connectionAttempt]);
  function openSettings() {
    onClose();
    navigate('settings', undefined, 'integrations');
  }
  async function search(e: FormEvent) {
    e.preventDefault();
    if (!query.trim()) return;
    searchRequest.current?.abort();
    previewRequest.current?.abort();
    const controller = new AbortController();
    searchRequest.current = controller;
    const text = query.trim();
    setSearching(true);
    setError('');
    setResults(null);
    setPreview(null);
    setPreviewId(null);
    setPreviewing(false);
    setSearchedFor(text);
    try {
      const next = await api<SearchResults>(`/confluence/search?q=${encodeURIComponent(text)}`, {
        signal: controller.signal,
      });
      if (!controller.signal.aborted) setResults(next);
    } catch (err) {
      if (!controller.signal.aborted) setError(errorMessage(err));
    } finally {
      if (!controller.signal.aborted) setSearching(false);
    }
  }
  async function showPreview(page: Page) {
    previewRequest.current?.abort();
    setPreview(null);
    setPreviewError('');
    if (previewId === page.id) {
      setPreviewId(null);
      setPreviewing(false);
      return;
    }
    const controller = new AbortController();
    previewRequest.current = controller;
    setPreviewId(page.id);
    setPreviewing(true);
    try {
      const next = await api<Page>(`/confluence/pages/${encodeURIComponent(page.id)}`, {
        signal: controller.signal,
      });
      if (!controller.signal.aborted) setPreview(next);
    } catch (err) {
      if (!controller.signal.aborted) setPreviewError(errorMessage(err));
    } finally {
      if (!controller.signal.aborted) setPreviewing(false);
    }
  }
  async function linkPage(page: Page) {
    if (linking) return;
    setLinking(page.id);
    setError('');
    try {
      await post('/links', {
        projectId,
        itemId: null,
        title: page.title,
        url: page.url,
        kind: 'confluence',
      });
      if (alive.current) setLinked((previous) => new Set([...previous, page.url]));
      await refresh();
      toast(`Linked “${page.title}” to ${project?.name || 'project'}`);
    } catch (err) {
      if (alive.current) setError(errorMessage(err));
    } finally {
      if (alive.current) setLinking(null);
    }
  }
  return (
    <Modal
      title="Find Confluence documentation"
      onClose={onClose}
      wide
      className="confluence-search-modal"
    >
      <div className="confluence-search-content">
        {loadingConnection ? (
          <div className="confluence-search-empty" role="status">
            <Loader2 size={23} className="spin" />
            <p>Loading your Confluence connection…</p>
          </div>
        ) : connectionError ? (
          <div className="confluence-search-empty">
            <div className="form-error" role="alert">
              {connectionError}
            </div>
            <button className="button" onClick={() => setConnectionAttempt((value) => value + 1)}>
              Try again
            </button>
          </div>
        ) : !connection ? (
          <div className="confluence-search-empty">
            <span className="confluence-empty-icon">
              <BookOpen size={25} />
            </span>
            <h3>Connect your documentation</h3>
            <p>
              Search Confluence with your own account, preview pages, and link the useful ones to{' '}
              {project?.name || 'this project'}.
            </p>
            <button className="button primary" onClick={openSettings}>
              <Settings size={14} />
              Connect in settings
            </button>
          </div>
        ) : (
          <>
            <p className="confluence-search-context">
              <BookOpen size={15} />
              <span>{new URL(connection.baseUrl).hostname}</span>
              <span className="muted">· Your Confluence permissions</span>
            </p>
            <form className="confluence-search-form" onSubmit={search}>
              <div>
                <Search size={16} />
                <input
                  autoFocus
                  aria-label="Search Confluence"
                  placeholder="Search documentation…"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  maxLength={200}
                />
              </div>
              <button className="button primary" disabled={!query.trim() || searching}>
                {searching ? <Loader2 size={14} className="spin" /> : <Search size={14} />}Search
              </button>
            </form>
            {error && (
              <div className="form-error" role="alert">
                {error}
              </div>
            )}
            {searching ? (
              <div className="confluence-search-empty" role="status">
                <Loader2 size={22} className="spin" />
                <p>Searching Confluence…</p>
              </div>
            ) : results ? (
              <>
                <div className="confluence-search-count" aria-live="polite">
                  {results.data.length} {results.data.length === 1 ? 'page' : 'pages'} for “
                  {searchedFor}”
                </div>
                {!results.data.length ? (
                  <div className="confluence-search-empty">
                    <Search size={24} />
                    <h3>No matching pages</h3>
                    <p>
                      Try another title or keyword. Results only include pages your Confluence
                      account can access.
                    </p>
                  </div>
                ) : (
                  <div className="confluence-search-results">
                    {results.data.map((page) => {
                      const alreadyLinked =
                        linked.has(page.url) ||
                        data.links.some(
                          (link) => link.projectId === projectId && link.url === page.url,
                        );
                      return (
                        <article className="confluence-search-result" key={page.id}>
                          <div className="confluence-result-heading">
                            <BookOpen size={17} />
                            <a href={page.url} target="_blank" rel="noopener noreferrer">
                              {page.title}
                              <ArrowUpRight size={13} />
                            </a>
                          </div>
                          {page.excerpt && (
                            <p className="confluence-result-excerpt">{page.excerpt}</p>
                          )}
                          <div className="confluence-result-actions">
                            <button
                              className="button ghost small"
                              onClick={() => void showPreview(page)}
                            >
                              {previewId === page.id ? (
                                <ChevronUp size={13} />
                              ) : (
                                <ChevronDown size={13} />
                              )}
                              {previewId === page.id ? 'Hide preview' : 'Preview page'}
                            </button>
                            <button
                              className="button small"
                              disabled={alreadyLinked || linking !== null}
                              onClick={() => void linkPage(page)}
                            >
                              {alreadyLinked ? (
                                <Check size={13} />
                              ) : linking === page.id ? (
                                <Loader2 className="spin" size={13} />
                              ) : (
                                <Link2 size={13} />
                              )}
                              {alreadyLinked
                                ? 'Linked to project'
                                : linking === page.id
                                  ? 'Linking…'
                                  : 'Link to project'}
                            </button>
                          </div>
                          {previewId === page.id && (
                            <div className="confluence-page-preview">
                              {previewing ? (
                                <p className="confluence-preview-loading" role="status">
                                  <Loader2 size={14} className="spin" />
                                  Loading page…
                                </p>
                              ) : previewError ? (
                                <div className="form-error" role="alert">
                                  {previewError}
                                </div>
                              ) : preview ? (
                                <>
                                  {preview.updatedAt && (
                                    <time className="muted">
                                      Updated {new Date(preview.updatedAt).toLocaleDateString()}
                                    </time>
                                  )}
                                  <p>{preview.excerpt || 'This page has no text to preview.'}</p>
                                  <a href={preview.url} target="_blank" rel="noopener noreferrer">
                                    Read full page in Confluence <ArrowUpRight size={12} />
                                  </a>
                                </>
                              ) : null}
                            </div>
                          )}
                        </article>
                      );
                    })}
                  </div>
                )}
                {results.hasMore && (
                  <p className="confluence-search-more">
                    More pages match this search. Refine your keywords to narrow the results.
                  </p>
                )}
              </>
            ) : (
              !error && (
                <div className="confluence-search-empty">
                  <Search size={23} />
                  <p>Find a runbook, architecture decision, or project document.</p>
                </div>
              )
            )}
            <footer className="confluence-search-footer">
              Page titles and links are shared with project members. Confluence controls access to
              the documentation.
            </footer>
          </>
        )}
      </div>
    </Modal>
  );
}
