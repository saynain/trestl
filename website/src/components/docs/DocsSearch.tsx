import { useDocsSearch } from 'fumadocs-core/search/client';
import { staticClient } from 'fumadocs-core/search/client/orama-static';
import {
  SearchDialog,
  SearchDialogClose,
  SearchDialogContent,
  SearchDialogHeader,
  SearchDialogIcon,
  SearchDialogInput,
  SearchDialogList,
  SearchDialogOverlay,
  type SharedProps,
} from 'fumadocs-ui/components/dialog/search';

const client = staticClient({ from: '/api/search.json' });
const suggestions = [
  { id: 'quick-start', type: 'page' as const, content: 'Quick start', url: '/docs/quick-start/' },
  {
    id: 'docker',
    type: 'page' as const,
    content: 'Self-host with Docker',
    url: '/docs/self-hosting/docker/',
  },
  { id: 'cli', type: 'page' as const, content: 'CLI & agents', url: '/docs/integrations/cli/' },
];

export default function DocsSearch(props: SharedProps) {
  const { search, setSearch, query } = useDocsSearch({ client });
  return (
    <SearchDialog {...props} search={search} onSearchChange={setSearch} isLoading={query.isLoading}>
      <SearchDialogOverlay />
      <SearchDialogContent>
        <SearchDialogHeader>
          <SearchDialogIcon />
          <SearchDialogInput
            placeholder="Search documentation…"
            aria-label="Search documentation"
          />
          <SearchDialogClose />
        </SearchDialogHeader>
        {query.error ? (
          <p className="search-error" role="alert">
            Search couldn't load. Check your connection and try again, or browse the guides in the
            sidebar.
          </p>
        ) : (
          <SearchDialogList items={query.data === 'empty' ? suggestions : query.data} />
        )}
      </SearchDialogContent>
    </SearchDialog>
  );
}
