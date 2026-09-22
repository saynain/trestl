import { logoUrl } from '../../lib/brand';
import { lazy, useEffect, useState } from 'react';
import {
  ArrowRightLeft,
  Box,
  Boxes,
  Check,
  Code2,
  Command,
  Copy,
  ExternalLink,
  FileCode2,
  GitBranch,
  House,
  Menu,
  Moon,
  PanelsTopLeft,
  Rocket,
  Search,
  ShieldCheck,
  Sun,
  Terminal,
  Users,
} from 'lucide-react';
import { RootProvider } from 'fumadocs-ui/provider/astro';
import { useTheme } from 'fumadocs-ui/provider/base';
import { DocsLayout, useNotebookLayout } from 'fumadocs-ui/layouts/notebook';
import { DocsBody, DocsDescription, DocsPage, DocsTitle } from 'fumadocs-ui/page';
import { useSearchContext } from 'fumadocs-ui/contexts/search';
import type { Root, Node } from 'fumadocs-core/page-tree';
import type { DocPage } from '../../lib/docs';
import { docPages, docUrl, repository } from '../../lib/docs-manifest';
import DocsHome, { homeToc } from './DocsHome';

const DocsSearch = lazy(() => import('./DocsSearch'));
const icons = {
  rocket: Rocket,
  users: Users,
  box: Box,
  boxes: Boxes,
  shield: ShieldCheck,
  panels: PanelsTopLeft,
  transfer: ArrowRightLeft,
  git: GitBranch,
  branch: GitBranch,
  terminal: Terminal,
  command: Command,
  code: Code2,
  file: FileCode2,
};
const children: Node[] = [{ type: 'page', name: 'Overview', url: '/docs/', icon: <House /> }];
let lastGroup = '';
for (const page of docPages) {
  if (lastGroup !== page.group) children.push({ type: 'separator', name: page.group });
  lastGroup = page.group;
  const Icon = icons[page.icon];
  children.push({ type: 'page', name: page.title, url: docUrl(page.slug), icon: <Icon /> });
}
const tree: Root = { name: 'Documentation', children };

function DocsHeader() {
  const { setOpenSearch } = useSearchContext();
  const { slots } = useNotebookLayout();
  const { resolvedTheme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const dark = mounted && resolvedTheme === 'dark';
  return (
    <header id="nd-subnav" className="docs-header">
      <div className="docs-brand-group">
        <a href="/" aria-label="Trestl home" className="docs-brand">
          <img src={logoUrl} width={30} height={24} alt="" />
          trestl
        </a>
        <a href="/docs/" className="docs-label">
          Documentation
        </a>
      </div>
      <button
        className="docs-search"
        onClick={() => setOpenSearch(true)}
        aria-label="Search documentation"
      >
        <Search size={16} />
        <span>Search documentation…</span>
        <kbd>⌘ K</kbd>
      </button>
      <nav aria-label="Site navigation" className="docs-header-links">
        <a href="/">
          Website <ExternalLink size={12} />
        </a>
        <a href="/play/">
          Try the demo <ExternalLink size={12} />
        </a>
      </nav>
      <button
        className="docs-icon-button"
        aria-label={dark ? 'Switch to light theme' : 'Switch to dark theme'}
        title={dark ? 'Switch to light theme' : 'Switch to dark theme'}
        onClick={() => setTheme(dark ? 'light' : 'dark')}
      >
        {dark ? <Moon size={19} /> : <Sun size={19} />}
      </button>
      <a href={repository} className="docs-icon-button docs-github" aria-label="Source on GitHub">
        <svg width="21" height="21" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <path d="M12 .9a11.1 11.1 0 0 0-3.51 21.63c.55.1.76-.24.76-.53v-2.07c-3.09.67-3.74-1.31-3.74-1.31-.5-1.28-1.24-1.62-1.24-1.62-1.01-.69.08-.67.08-.67 1.12.08 1.71 1.15 1.71 1.15.99 1.7 2.59 1.21 3.22.93.1-.72.39-1.21.71-1.49-2.47-.28-5.07-1.24-5.07-5.49 0-1.21.43-2.2 1.14-2.98-.12-.28-.49-1.41.11-2.94 0 0 .93-.3 3.05 1.14a10.66 10.66 0 0 1 5.56 0c2.12-1.44 3.05-1.14 3.05-1.14.6 1.53.23 2.66.11 2.94.71.78 1.14 1.77 1.14 2.98 0 4.26-2.6 5.21-5.08 5.49.4.35.76 1.02.76 2.06V22c0 .3.2.64.77.53A11.1 11.1 0 0 0 12 .9Z" />
        </svg>
      </a>
      <slots.sidebar.trigger
        className="docs-icon-button docs-menu"
        aria-label="Open documentation menu"
      >
        <Menu size={21} />
      </slots.sidebar.trigger>
    </header>
  );
}

function Article({ page }: { page: DocPage }) {
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState('');
  useEffect(() => {
    const root = document.querySelector('.docs-markdown');
    const cleanups: (() => void)[] = [];
    root?.querySelectorAll('pre').forEach((pre) => {
      const wrapper = pre.parentElement;
      if (!wrapper) return;
      const button = document.createElement('button');
      button.className = 'code-copy';
      button.type = 'button';
      button.textContent = 'Copy';
      button.setAttribute('aria-label', 'Copy code');
      button.setAttribute('aria-live', 'polite');
      let timeout: ReturnType<typeof setTimeout>;
      button.onclick = async () => {
        try {
          await navigator.clipboard.writeText(pre.textContent ?? '');
          button.textContent = 'Copied';
        } catch {
          button.textContent = 'Select code to copy';
        }
        timeout = setTimeout(() => {
          button.textContent = 'Copy';
        }, 2000);
      };
      wrapper.append(button);
      cleanups.push(() => {
        clearTimeout(timeout);
        button.remove();
      });
    });
    return () => cleanups.forEach((cleanup) => cleanup());
  }, [page.slug]);
  useEffect(() => {
    if (!copied) return;
    const timeout = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timeout);
  }, [copied]);
  return (
    <>
      <DocsTitle>{page.title}</DocsTitle>
      <DocsDescription>{page.description}</DocsDescription>
      <div className="article-actions">
        <button
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(location.href);
              setCopied(true);
              setCopyError('');
            } catch {
              setCopyError('Copy the page address from your browser.');
            }
          }}
        >
          {copied ? <Check size={14} /> : <Copy size={14} />}
          {copied ? 'Copied' : 'Copy link'}
        </button>
        <a href={`${repository}/blob/main/${page.file}`}>
          View source <ExternalLink size={13} />
        </a>
        <span role="status">{copyError || (copied ? 'Link copied.' : '')}</span>
      </div>
      <DocsBody>
        <div className="docs-markdown" dangerouslySetInnerHTML={{ __html: page.html }} />
      </DocsBody>
    </>
  );
}

export default function DocsSite({ page, pathname }: { page: DocPage | null; pathname: string }) {
  return (
    <RootProvider
      pathname={pathname}
      theme={{
        attribute: 'data-theme',
        storageKey: 'trestl.website.theme',
        defaultTheme: 'system',
        hotKey: false,
      }}
      search={{ SearchDialog: DocsSearch, preload: false }}
    >
      <DocsLayout
        tree={tree}
        tabs={false}
        nav={{ mode: 'top' }}
        slots={{ header: DocsHeader }}
        sidebar={{ collapsible: false }}
        themeSwitch={{ enabled: false }}
      >
        <DocsPage
          className={page ? 'trestl-article' : 'trestl-home-page'}
          toc={page?.toc ?? homeToc}
          breadcrumb={{ enabled: !!page }}
          footer={{ enabled: !!page }}
        >
          {page ? <Article page={page} /> : <DocsHome />}
        </DocsPage>
      </DocsLayout>
    </RootProvider>
  );
}
