import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { rehypeTaskCheckboxes, setMarkdownTaskChecked } from '../src/lib/markdown-tasks.ts';

function renderTasks(source: string) {
  const html = renderToStaticMarkup(
    createElement(Markdown, {
      remarkPlugins: [remarkGfm],
      rehypePlugins: [rehypeTaskCheckboxes],
      children: source,
    }),
  );
  const offsets = [...html.matchAll(/data-task-offset="(\d+)"/g)].map((match) => Number(match[1]));
  return { html, offsets };
}

test('task toggles preserve Markdown and distinguish repeated, nested, and quoted tasks', () => {
  const source = [
    '# Checklist 🐶',
    '',
    '- [ ] Same **task**',
    '  - [X] Nested task',
    '- [ ] Same **task**',
    '',
    '> 1. [ ] Quoted task',
    '',
    '+ [x] Finished task',
  ].join('\r\n');
  const { offsets, html } = renderTasks(source);
  assert.equal(offsets.length, 5);
  assert.match(html, /aria-label="Task: Same task"/);
  assert.match(html, /aria-label="Task: Nested task"/);
  assert.match(html, /aria-label="Task: Quoted task"/);
  for (const offset of offsets) {
    const checked = setMarkdownTaskChecked(source, offset, true);
    assert.equal(checked, source.slice(0, offset) + 'x' + source.slice(offset + 1));
    assert.equal(
      setMarkdownTaskChecked(checked, offset, false),
      source.slice(0, offset) + ' ' + source.slice(offset + 1),
    );
  }
});

test('loose and ordered lists are interactive but task-like code and prose are untouched', () => {
  const source = [
    'An inline `[ ]` and a plain [ ] marker.',
    '',
    '```markdown',
    '- [ ] Code sample',
    '```',
    '',
    '    - [ ] Indented code',
    '',
    '1) [ ] First task',
    '',
    '   More detail.',
    '',
    '2) [x] Second task',
  ].join('\n');
  const { offsets } = renderTasks(source);
  assert.deepEqual(offsets, [source.indexOf('[ ] First') + 1, source.indexOf('[x] Second') + 1]);
});

test('invalid task offsets leave the source unchanged', () => {
  const source = '- [ ] Task';
  for (const offset of [-1, 0, 1, 3.5, NaN, source.length, 999])
    assert.equal(setMarkdownTaskChecked(source, offset, true), source);
});
