import assert from 'node:assert/strict';
import { readFile, readdir, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const dist = fileURLToPath(new URL('../dist/', import.meta.url));
const decode = (value) =>
  value.replaceAll('&amp;', '&').replaceAll('&#39;', "'").replaceAll('&quot;', '"');
async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  return (
    await Promise.all(
      entries.map((entry) =>
        entry.isDirectory()
          ? walk(path.join(directory, entry.name))
          : path.join(directory, entry.name),
      ),
    )
  ).flat();
}
const pages = (await walk(path.join(dist, 'docs'))).filter((file) => file.endsWith('.html'));
assert.ok(pages.length >= 17, 'Build must include the docs landing page and all guides.');
pages.push(path.join(dist, 'index.html'), path.join(dist, 'play/index.html'));
const failures = [];
let links = 0;
for (const file of pages) {
  const html = await readFile(file, 'utf8');
  const relative = path.relative(dist, file).replaceAll(path.sep, '/');
  const source = `https://docs.test/${relative.replace(/index\.html$/, '')}`;
  if (relative.startsWith('docs/')) {
    assert.equal([...html.matchAll(/<h1(?:\s|>)/g)].length, 1, `${relative}: expected one H1`);
    assert.match(
      html,
      /<meta name="description" content="[^"]+"/,
      `${relative}: missing description`,
    );
  }
  for (const [, raw] of html.matchAll(/\bhref="([^"]+)"/g)) {
    const url = new URL(decode(raw), source);
    if (url.origin !== 'https://docs.test') continue;
    links++;
    let destination = path.join(dist, decodeURIComponent(url.pathname));
    try {
      if ((await stat(destination)).isDirectory())
        destination = path.join(destination, 'index.html');
      const target = await readFile(destination, 'utf8');
      if (url.hash && destination.endsWith('.html')) {
        const id = decodeURIComponent(url.hash.slice(1));
        if (id && !target.includes(`id="${id}"`))
          failures.push(`${relative}: missing anchor ${url.pathname}${url.hash}`);
      }
    } catch {
      failures.push(`${relative}: missing target ${url.pathname}`);
    }
  }
}
const search = JSON.parse(await readFile(path.join(dist, 'api/search.json'), 'utf8'));
assert.ok(
  JSON.stringify(search).includes('backup-and-restore'),
  'Search must include section-level content.',
);
const api = JSON.parse(await readFile(path.join(dist, 'docs/openapi.json'), 'utf8'));
assert.ok(
  api.openapi && Object.keys(api.paths).length > 0,
  'The downloadable API contract must contain real endpoints.',
);
assert.deepEqual(failures, [], 'Built internal links and anchors must resolve.');
console.log(
  `Verified ${pages.length} pages, ${links} internal links, section search, and the generated OpenAPI contract.`,
);
