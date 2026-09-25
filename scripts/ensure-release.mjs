import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// CLI and desktop jobs may finish concurrently. Either can create the shared
// release, but neither may change an existing release or overwrite its assets.
export function ensureRelease(tag, run = (args) => spawnSync('gh', args, { encoding: 'utf8' })) {
  if (!/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(tag ?? ''))
    throw new Error('Expected a version tag');
  const view = () => run(['release', 'view', tag]);
  if (view().status === 0) return;
  const notes = `docs/releases/${tag}.md`;
  const args = ['release', 'create', tag, '--verify-tag', '--title', `Trestl ${tag}`];
  if (existsSync(notes)) args.push('--notes-file', notes);
  else
    args.push(
      '--notes',
      'Trestl application, desktop and CLI release. See the README for installation.',
    );
  if (tag.includes('-')) args.push('--prerelease');
  const created = run(args);
  if (created.status !== 0 && view().status !== 0)
    throw new Error(`Could not create or find GitHub Release ${tag}: ${created.stderr ?? ''}`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  ensureRelease(process.env.RELEASE_TAG);
