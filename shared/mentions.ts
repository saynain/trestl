import { fromMarkdown } from 'mdast-util-from-markdown';

export type MentionKind = 'user' | 'item' | 'project' | 'milestone';
export type Mention = { kind: MentionKind; id: string };
export const mentionTriggers = { user: '@', item: '/', project: '$', milestone: '%' } as const;

// Stable IDs survive renames and moves. Ordinary Markdown keeps exports readable.
export function mentionHref({ kind, id }: Mention) {
  return `#/mention/${kind}/${id}`;
}

export function parseMentionHref(href: string): Mention | null {
  const match =
    /^#\/mention\/(user|item|project|milestone)\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(
      href,
    );
  return match ? { kind: match[1].toLowerCase() as MentionKind, id: match[2].toLowerCase() } : null;
}

export function mentionMarkdown(mention: Mention, label: string) {
  const escaped = label.replace(/[\\\[\]`*_]/g, '\\$&').replace(/[\r\n]+/g, ' ');
  return `[${mentionTriggers[mention.kind]}${escaped}](${mentionHref(mention)})`;
}

export function extractMentions(markdown: string): Mention[] {
  const found = new Map<string, Mention>();
  const tree = fromMarkdown(markdown);
  function visit(node: { type: string; url?: string; children?: typeof tree.children }) {
    if (node.type === 'link' && node.url) {
      const mention = parseMentionHref(node.url);
      if (mention) found.set(`${mention.kind}:${mention.id}`, mention);
    }
    if (node.children) for (const child of node.children) visit(child);
  }
  visit(tree);
  return [...found.values()];
}

export function mentionQuery(value: string, caret: number) {
  const before = value.slice(0, caret);
  const match = /(?:^|[\s(])([@/$%])([^\s\[\]()@/$%`]{0,80})$/.exec(before);
  if (!match) return null;
  const start = caret - match[2].length - 1;
  // Never offer mentions inside code, links, or Markdown link destinations.
  let excluded = false;
  const tree = fromMarkdown(value);
  function visit(node: {
    type: string;
    position?: { start: { offset?: number }; end: { offset?: number } };
    children?: typeof tree.children;
  }) {
    if (
      ['code', 'inlineCode', 'link', 'image', 'html'].includes(node.type) &&
      start >= (node.position?.start.offset ?? Infinity) &&
      start < (node.position?.end.offset ?? -1)
    )
      excluded = true;
    if (node.children) for (const child of node.children) visit(child);
  }
  visit(tree);
  if (excluded) return null;
  return {
    kind: ({ '@': 'user', '/': 'item', $: 'project', '%': 'milestone' } as const)[
      match[1] as '@' | '/' | '$' | '%'
    ],
    query: match[2],
    start,
    end: caret,
  };
}

// Remap portable references while leaving code samples and ordinary external URLs intact.
export function remapMentionIds(
  markdown: string,
  mappings: Partial<Record<string, ReadonlyMap<string, string>>>,
) {
  const tree = fromMarkdown(markdown);
  const edits: { start: number; end: number; href: string }[] = [];
  function visit(node: {
    type: string;
    url?: string;
    position?: { start: { offset?: number }; end: { offset?: number } };
    children?: typeof tree.children;
  }) {
    if (node.type === 'link' && node.url) {
      const mention = parseMentionHref(node.url);
      const nextId = mention && mappings[mention.kind]?.get(mention.id);
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      if (mention && nextId && start !== undefined && end !== undefined) {
        const relative = markdown.slice(start, end).lastIndexOf(node.url);
        if (relative >= 0)
          edits.push({
            start: start + relative,
            end: start + relative + node.url.length,
            href: mentionHref({ ...mention, id: nextId }),
          });
      }
    }
    if (node.children) for (const child of node.children) visit(child);
  }
  visit(tree);
  for (const edit of edits.sort((a, b) => b.start - a.start))
    markdown = markdown.slice(0, edit.start) + edit.href + markdown.slice(edit.end);
  return markdown;
}
