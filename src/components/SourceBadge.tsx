import { AlertCircle, Github, GitFork } from 'lucide-react';
import type { WorkItem } from '../../shared/types';
import { isDone } from '../lib/model';

/** Native items deliberately have no badge; linked work keeps its repository identity. */
export function SourceBadge({ item }: { item: WorkItem }) {
  const source = item.source;
  if (!source) return null;
  const provider = source.provider === 'github' ? 'GitHub' : 'Gitea';
  const Icon = source.provider === 'github' ? Github : GitFork;
  const needsReview = source.state === 'closed' && !isDone(item);
  return (
    <span className="source-badge-line">
      <a
        className="source-badge"
        href={source.url}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={`Open ${provider} issue ${source.repository} #${source.number}`}
        title={`${provider} · ${source.repository} #${source.number} · ${source.state}${source.connected ? '' : ' · Connection removed'}`}
        onClick={(event) => event.stopPropagation()}
        onPointerDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => event.stopPropagation()}
      >
        <Icon size={12} />
        <span className="source-provider-name">{provider}</span>
        <span className="source-repository">{source.repository}</span>
        <span>#{source.number}</span>
      </a>
      {needsReview && (
        <span
          className="source-review-flag"
          role="img"
          aria-label="Repository issue closed; local work remains"
          title="Repository issue closed; local work remains"
        >
          <AlertCircle size={13} />
        </span>
      )}
    </span>
  );
}
