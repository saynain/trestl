import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkRehype from 'remark-rehype';
import rehypeSlug from 'rehype-slug';
import rehypePrettyCode from 'rehype-pretty-code';
import rehypeStringify from 'rehype-stringify';
import { structure } from 'fumadocs-core/mdx-plugins/remark-structure';
import { docPages, docUrl, repository, type DocMeta } from './docs-manifest';

// Defined by Astro's config: import.meta.url moves when the server is bundled.
declare const __TRESTL_REPO_ROOT__: string;
const root = __TRESTL_REPO_ROOT__;
const destinations = new Map<string, string>(
  docPages.map((page) => [page.file, docUrl(page.slug)]),
);
destinations.set('README.md', '/docs/quick-start/');

/** Resolve repository-relative Markdown links into the public docs routes. */
export function resolveDocLink(href: string, sourceFile: string): string {
  if (/^(?:[a-z][a-z\d+.-]*:|\/|#)/i.test(href)) return href;
  const [, file, suffix] = href.match(/^([^?#]*)(.*)$/)!;
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(sourceFile), file));
  return (destinations.get(resolved) ?? `${repository}/blob/main/${resolved}`) + suffix;
}

type Node = {
  type: string;
  url?: string;
  children?: Node[];
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
};
function visit(node: Node, callback: (node: Node) => void) {
  callback(node);
  node.children?.forEach((child) => visit(child, callback));
}
function textContent(node: Node): string {
  return node.value ?? node.children?.map(textContent).join('') ?? '';
}

export async function loadDoc(meta: DocMeta) {
  const original = await readFile(path.join(root, meta.file), 'utf8');
  const markdown = original
    .replace(/^# .+\r?\n/, '')
    .replace(/^\s*\[Back to the project\][^\n]+\n/, '')
    .trim();
  const toc: { title: string; url: string; depth: number }[] = [];
  const result = await unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(() => (tree: unknown) => {
      visit(tree as Node, (node) => {
        if (node.url && ['link', 'definition', 'image'].includes(node.type))
          node.url = resolveDocLink(node.url, meta.file);
      });
    })
    .use(remarkRehype)
    .use(rehypeSlug)
    .use(() => (tree: unknown) => {
      visit(tree as Node, (node) => {
        if (node.tagName && /^h[23]$/.test(node.tagName))
          toc.push({
            title: textContent(node),
            url: `#${node.properties?.id}`,
            depth: Number(node.tagName[1]),
          });
      });
    })
    .use(rehypePrettyCode, {
      theme: { light: 'github-light', dark: 'github-dark' },
      keepBackground: false,
    })
    .use(rehypeStringify)
    .process(markdown);
  return { ...meta, html: String(result), toc, structuredData: structure(markdown, [remarkGfm]) };
}

// Build-time only: clients receive the selected page, never this loader or filesystem access.
export async function loadDocs() {
  return Promise.all(docPages.map(loadDoc));
}

export type Doc = Awaited<ReturnType<typeof loadDoc>>;

export type DocPage = Omit<Doc, 'structuredData'>;
