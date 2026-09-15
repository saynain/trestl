#!/usr/bin/env node
import { browserLogin } from './browser-login.js';
import { parseArgs } from 'node:util';
import { basename } from 'node:path';
import { readFile, stat } from 'node:fs/promises';
import {
  credentialPath,
  listProfiles,
  loadCredentials,
  saveCredentials,
  logout,
  readToken,
  secrets,
  serverUrl,
} from './auth.js';
import { initializeConfig, repositoryConfig } from './config.js';
import { CliError, httpError, usage } from './errors.js';
import type {
  Project,
  WorkItem,
  ItemDetail,
  Milestone,
  ProjectCanvas,
  CanvasSummary,
} from '../shared/types';
const help = `Trestl — project work from your terminal

Usage: trestl <command> [arguments] [options]

Commands:
  login                         Sign in using your browser
  logout                        Remove the saved token for a profile
  auth status                   Check authentication (never prints the token)
  profiles list                 Discover saved profiles locally (no network)
  init                          Write repository defaults (.trestl.json)
  config                        Show repository defaults and effective profile
  get <id-or-identifier>         Read an item, description, activity and links
  list                          List work items
  search <text>                 Search titles, descriptions, identifiers
  create <title>                Create a work item
  update <id-or-identifier>      Update a work item
  projects                      List projects
  project-create <name>         Create a project (requires --key)
  project-update <id-or-key>    Update project dates or description
  relation-add <blocker> <dependent>  Add a finish-to-start dependency
  milestone-update <id>         Update milestone title or date
  milestones                    List milestones (optional --project)
  milestone-create <title>     Create a milestone (requires --project)
  comment <id-or-identifier> <text>  Add an internal comment
  canvases list                 List canvases (requires a project)
  canvases create <title>       Create a blank canvas
  canvases import <file>        Import an .excalidraw file as a new canvas
  canvases show <id>            Print a browser link; --json includes revision
  canvases delete <id>          Delete using --expected-revision from show
  export                        Export your accessible workspace as JSON

Options:
  --no-config                   Ignore repository defaults
  --page                        Return one page as {data,nextCursor?}
  --limit <1-500>               Page size (default: 100)
  --cursor <cursor>             Continue a page (requires --page)
  --expected-revision <number>  Update only the revision you previously read
  --idempotency-key <key>       Deduplicate a create/comment across retries
  --version                     Show CLI version
  --profile <name>              Saved account profile (default: default)
  --url <server-url>            Server URL; saved during login
  --no-browser                  Print the approval URL without opening it
  --name <name>                 Name this CLI session for later revocation
  --scope <read|write>           CLI access (default: write)
  --token                       Enter an existing API token using a hidden prompt
  --token-stdin                 Read an existing token from standard input
  --project <id-or-key>          Filter or set project (use "none" to clear)
  --status <status>             backlog|todo|in_progress|in_review|done|canceled
  --priority <priority>         none|low|medium|high|urgent
  --type <type>                 task|bug|idea|followup
  --title <title>               New title for update or canvas import
  --collection <id|none>        Collection for canvas create/import
  --description <text>          Item description
  --start <YYYY-MM-DD|none>     Scheduled start
  --key <key>                   Unique project key
  --lifecycle <lifecycle>       ongoing|fixed (project-create)
  --color <#hex>                Project color
  --completed                   Mark a new milestone completed
  --labels <comma-separated>    Item labels (use "none" to clear)
  --due <YYYY-MM-DD|none>       Delivery deadline
  --follow-up <YYYY-MM-DD|none> Review date
  --assignee <user-id|none>      Assign or clear owner
  --visibility <visibility>     workspace|private
  --json                        Print machine-readable JSON
  --help                        Show this help

Environment:
  TRESTL_URL    Server origin (default http://localhost:4317)
  TRESTL_TOKEN Personal API token override (otherwise uses saved login)
  TRESTL_PROFILE Default profile name
  TRESTL_CONFIG_DIR Override credential directory

Examples:
  trestl create "Plan cluster upgrade" --project K8S --priority high
  trestl update K8S-12 --status in_progress --due 2026-10-15
  trestl list --project K8S --json
  trestl export > trestl-export.json
`;

const common = ['profile', 'url', 'json', 'no-config'];
const fields = [
  'project',
  'status',
  'priority',
  'type',
  'description',
  'start',
  'due',
  'labels',
  'follow-up',
  'assignee',
  'visibility',
];
const filters = [
  'project',
  'status',
  'priority',
  'type',
  'assignee',
  'visibility',
  'limit',
  'cursor',
  'page',
];
const commandOptions: Record<string, string[]> = {
  login: ['token-stdin', 'token', 'no-browser', 'name', 'scope'],
  logout: [],
  auth: [],
  profiles: [],
  init: ['project'],
  config: [],
  list: filters,
  search: filters,
  get: [],
  projects: [],
  'project-create': ['key', 'description', 'lifecycle', 'color', 'start', 'due', 'visibility'],
  'project-update': ['description', 'start', 'due'],
  'relation-add': [],
  'milestone-update': ['title', 'due', 'expected-revision'],
  milestones: ['project'],
  'milestone-create': ['project', 'due', 'completed'],
  export: [],
  canvases: ['project', 'title', 'collection', 'expected-revision'],
  create: [...fields, 'idempotency-key'],
  update: [...fields, 'title', 'expected-revision'],
  comment: ['idempotency-key'],
};
const booleanOptions = [
  'json',
  'help',
  'version',
  'token-stdin',
  'token',
  'no-browser',
  'no-config',
  'page',
  'completed',
];
const stringOptions = [...new Set([...common, ...Object.values(commandOptions).flat()])].filter(
  (key) => !booleanOptions.includes(key),
);
const jsonRequested = process.argv.slice(2).includes('--json');

async function main() {
  let parsed;
  try {
    parsed = parseArgs({
      args: process.argv.slice(2),
      allowPositionals: true,
      strict: true,
      options: Object.fromEntries([
        ...stringOptions.map((key) => [key, { type: 'string' as const }]),
        ...booleanOptions.map((key) => [
          key,
          { type: 'boolean' as const, ...(key === 'help' ? { short: 'h' } : {}) },
        ]),
      ]),
    });
  } catch (error) {
    throw usage((error as Error).message);
  }
  const values = parsed.values as Record<string, string | boolean | undefined>;
  function output(data: unknown, rows?: Record<string, unknown>[]) {
    if (values.json || !rows) process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
    else if (!rows.length) process.stdout.write('No results.\n');
    else console.table(rows);
  }
  if (values.version) {
    const { version } = JSON.parse(
      await readFile(new URL('../package.json', import.meta.url), 'utf8'),
    );
    if (values.json) output({ version });
    else process.stdout.write(`${version}\n`);
    return;
  }
  if (values.help || !parsed.positionals.length) {
    if (values.json) output({ help });
    else process.stdout.write(help);
    return;
  }
  const [command, ...args] = parsed.positionals;
  if (!Object.hasOwn(commandOptions, command))
    throw usage(`Unknown command "${command}". Run trestl --help.`);
  for (const key of Object.keys(values))
    if (![...common, ...commandOptions[command]].includes(key))
      throw usage(`--${key} is not supported by ${command}.`);
  const canvasAction = command === 'canvases' ? args[0] : undefined;
  if (command === 'canvases') {
    if (!['list', 'create', 'import', 'show', 'delete'].includes(canvasAction || ''))
      throw usage(
        'Usage: trestl canvases <list|create|import|show|delete> [argument] --project <id-or-key>',
      );
    const allowed = [
      ...common,
      'project',
      ...(canvasAction === 'import' ? ['title', 'collection'] : []),
      ...(canvasAction === 'create' ? ['collection'] : []),
      ...(canvasAction === 'delete' ? ['expected-revision'] : []),
    ];
    for (const key of Object.keys(values))
      if (!allowed.includes(key))
        throw usage(`--${key} is not supported by canvases ${canvasAction}.`);
  }
  const count =
    command === 'canvases'
      ? canvasAction === 'list'
        ? 1
        : 2
      : ['comment', 'relation-add'].includes(command)
        ? 2
        : [
              'get',
              'search',
              'create',
              'update',
              'auth',
              'profiles',
              'project-create',
              'project-update',
              'milestone-update',
              'milestone-create',
            ].includes(command)
          ? 1
          : 0;
  if (args.length !== count)
    throw usage(
      `Incorrect arguments for ${command}. Quote text containing spaces. Run trestl --help.`,
    );
  if (command === 'auth' && args[0] !== 'status') throw usage('Usage: trestl auth status');
  if (command === 'profiles' && args[0] !== 'list') throw usage('Usage: trestl profiles list');
  if (command === 'project-create' && !values.key) throw usage('project-create requires --key.');
  if (command === 'milestone-create' && (!values.project || values.project === 'none'))
    throw usage('milestone-create requires an explicit --project.');
  if (values.cursor !== undefined && !values.page) throw usage('--cursor requires --page.');
  function integer(key: string, min: number, max: number): number | undefined {
    if (values[key] === undefined) return undefined;
    const text = String(values[key]);
    const number = Number(text);
    if (!/^\d+$/.test(text) || !Number.isSafeInteger(number) || number < min || number > max)
      throw usage(`--${key} must be an integer between ${min} and ${max}.`);
    return number;
  }
  integer('limit', 1, 500);
  const expectedRevision = integer('expected-revision', 0, 2147483646);
  if (canvasAction === 'delete' && expectedRevision === undefined)
    throw usage('canvases delete requires --expected-revision from canvases show --json.');
  if (
    values['idempotency-key'] &&
    !/^[A-Za-z0-9._:-]{1,128}$/.test(String(values['idempotency-key']))
  )
    throw usage(
      '--idempotency-key must contain 1–128 letters, digits, dots, underscores, colons or hyphens.',
    );
  const repository =
    values['no-config'] || command === 'init' ? { config: {} } : await repositoryConfig();
  const profile = String(
    values.profile || process.env.TRESTL_PROFILE || repository.config.profile || 'default',
  );
  const path = credentialPath(profile);
  if (command === 'profiles') {
    const names = await listProfiles();
    const profiles = names.map((name) => ({ name, selected: name === profile }));
    const tokenOverride = Boolean(process.env.TRESTL_TOKEN);
    if (values.json) output({ selectedProfile: profile, tokenOverride, profiles });
    else {
      process.stdout.write(
        `Selected profile: ${profile}${names.includes(profile) ? '' : ' (not saved)'}\n`,
      );
      if (tokenOverride)
        process.stdout.write('TRESTL_TOKEN overrides saved credentials for API requests.\n');
      output(
        profiles,
        profiles.map((entry) => ({ Profile: entry.name, Selected: entry.selected ? 'yes' : '' })),
      );
    }
    return;
  }
  if (command === 'init') {
    if (!values.project) throw usage('Use trestl init --project <key> [--profile <name>].');
    output({
      path: await initializeConfig({ profile, project: String(values.project) }),
      profile,
      project: values.project,
    });
    return;
  }
  if (command === 'config') {
    output({
      path: 'path' in repository ? repository.path : undefined,
      profile,
      project: repository.config.project ?? null,
    });
    return;
  }
  if (command === 'logout') {
    await logout(path);
    output({
      profile,
      loggedOut: true,
      message:
        'Saved credentials removed. Environment tokens are unaffected; revoke the token in Settings to invalidate it.',
    });
    return;
  }
  if (
    command === 'login' &&
    (values.token || values['token-stdin']) &&
    (values['no-browser'] || values.name || values.scope)
  )
    throw usage('Browser options cannot be combined with --token or --token-stdin.');
  if (values.token && values['token-stdin']) throw usage('Choose --token or --token-stdin.');
  const saved = await loadCredentials(path);
  const url = serverUrl(
    String(values.url || process.env.TRESTL_URL || saved?.url || 'http://localhost:4317'),
  );
  const environmentToken = process.env.TRESTL_TOKEN;
  if (environmentToken) secrets.add(environmentToken);
  const token =
    command === 'login'
      ? values.token || values['token-stdin']
        ? await readToken(Boolean(values['token-stdin']))
        : await browserLogin(url, {
            noBrowser: Boolean(values['no-browser']),
            name: values.name as string | undefined,
            scope: values.scope as string | undefined,
          })
      : environmentToken || (saved?.url === url ? saved.token : undefined);
  if (!token) {
    if (saved && saved.url !== url)
      throw new CliError(
        'Saved token belongs to a different server. Run login --url for this server or select another profile.',
        'unauthorized',
        3,
      );
    throw new CliError('Not logged in. Run trestl login, or set TRESTL_TOKEN.', 'unauthorized', 3);
  }
  const base = new URL(`${url}/api/v1/`);
  async function api<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
    let response: Response;
    try {
      response = await fetch(new URL(path, base), {
        method,
        redirect: 'error',
        signal: AbortSignal.timeout(20_000),
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
          ...(method === 'POST' && values['idempotency-key']
            ? { 'Idempotency-Key': String(values['idempotency-key']) }
            : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new CliError(
        'Request failed or timed out. Check server connectivity. For create/comment retries, reuse the same idempotency key.',
        'network_error',
        6,
      );
    }
    const data = await response.json().catch(() => null);
    if (!response.ok)
      throw httpError(
        response.status,
        `${method} ${path.split('?')[0]}: ${response.status} ${typeof data?.message === 'string' ? data.message : response.statusText}`,
      );
    if (data === null && response.status !== 204)
      throw new CliError(
        'Server returned invalid JSON. Check the server URL.',
        'protocol_error',
        6,
      );
    return data as T;
  }
  type Page<T> = { data: T[]; nextCursor?: string };
  async function page<T>(path: string, query: URLSearchParams): Promise<Page<T>> {
    const result = await api<Page<T>>(`${path}?${query}`);
    if (
      !result ||
      !Array.isArray(result.data) ||
      (result.nextCursor !== undefined && typeof result.nextCursor !== 'string')
    )
      throw new CliError(`Unexpected response for ${path}.`, 'protocol_error', 6);
    return result;
  }
  async function all<T>(path: string, query = new URLSearchParams()): Promise<T[]> {
    const result: T[] = [];
    const seen = new Set<string>();
    while (true) {
      const resultPage = await page<T>(path, query);
      result.push(...resultPage.data);
      if (!resultPage.nextCursor) return result;
      if (seen.has(resultPage.nextCursor))
        throw new CliError('Server returned a repeated pagination cursor.', 'protocol_error', 6);
      seen.add(resultPage.nextCursor);
      query.set('cursor', resultPage.nextCursor);
    }
  }
  function rows(items: WorkItem[]) {
    return items.map((i) => ({
      Item: i.identifier,
      Title: i.title,
      Status: i.status,
      Priority: i.priority,
      Due: i.dueDate || '—',
      Revision: i.revision ?? 0,
    }));
  }
  const itemPath = () => `items/${encodeURIComponent(args[0])}`;
  if (command === 'login' || command === 'auth') {
    const status = await api<{
      authenticated: boolean;
      user?: { id: string; name: string; email: string };
    }>('auth/status');
    if (!status.authenticated)
      throw new CliError(
        'Authentication failed. Create a valid personal API token in Settings and run login again.',
        'unauthorized',
        3,
      );
    if (command === 'login') await saveCredentials(path, { url, token });
    output({
      profile,
      url,
      authenticated: true,
      source: command === 'login' ? 'saved' : environmentToken ? 'environment' : 'saved',
      user: status.user
        ? { id: status.user.id, name: status.user.name, email: status.user.email }
        : undefined,
    });
    return;
  }
  if (command === 'canvases') {
    const projectRef = values.project ?? repository.config.project;
    if (!projectRef || projectRef === 'none')
      throw usage('Canvases require --project <id-or-key> or a repository project default.');
    let document: unknown;
    if (canvasAction === 'import') {
      try {
        if ((await stat(args[1])).size > 8 * 1024 * 1024)
          throw usage('Choose a canvas smaller than 8 MB.');
        document = JSON.parse(await readFile(args[1], 'utf8'));
        if (
          !document ||
          typeof document !== 'object' ||
          !('type' in document) ||
          document.type !== 'excalidraw'
        )
          throw usage('Choose a valid .excalidraw file.');
      } catch (error) {
        if (error instanceof CliError) throw error;
        throw usage('Cannot read a valid .excalidraw JSON file at the supplied path.');
      }
    }
    const project = await api<Project>(`projects/${encodeURIComponent(String(projectRef))}`);
    const canvasBase = `projects/${encodeURIComponent(project.id)}/canvases`;
    if (canvasAction === 'list') {
      const canvases = await all<CanvasSummary>(canvasBase);
      output(
        canvases,
        canvases.map((c) => ({
          ID: c.id,
          Title: c.title,
          Revision: c.revision,
          Updated: c.updatedAt,
        })),
      );
    } else if (canvasAction === 'create' || canvasAction === 'import') {
      const title =
        canvasAction === 'create'
          ? args[1]
          : (values.title ??
            (basename(args[1])
              .replace(/\.excalidraw$/i, '')
              .trim()
              .slice(0, 240) ||
              'Imported canvas'));
      output(
        await api<ProjectCanvas>(
          `${canvasBase}${canvasAction === 'import' ? '/import' : ''}`,
          'POST',
          {
            title,
            ...(canvasAction === 'import' ? { document } : {}),
            ...(values.collection
              ? { collectionId: values.collection === 'none' ? null : values.collection }
              : {}),
          },
        ),
      );
    } else if (canvasAction === 'show') {
      const result = await api<{ id: string; title: string; revision: number; url: string }>(
        `${canvasBase}/${encodeURIComponent(args[1])}/show`,
      );
      const link = new URL(result.url, `${url}/`).href;
      if (values.json) output({ ...result, url: link });
      else process.stdout.write(`${link}\n`);
    } else {
      await api(`${canvasBase}/${encodeURIComponent(args[1])}`, 'DELETE', { expectedRevision });
      if (values.json) output({ deleted: true, id: args[1] });
      else process.stdout.write('Canvas deleted.\n');
    }
    return;
  }
  if (command === 'export') {
    output(await api('export'));
    return;
  }
  if (command === 'projects') {
    const projects = await all<Project>('projects');
    output(
      projects,
      projects.map((p) => ({
        ID: p.id,
        Key: p.key,
        Name: p.name,
        Lifecycle: p.lifecycle,
        Parent: p.parentId || '—',
      })),
    );
    return;
  }
  if (command === 'relation-add') {
    const blocker = await api<ItemDetail>(itemPath());
    const dependent = await api<ItemDetail>(`items/${encodeURIComponent(args[1])}`);
    output(
      await api(`items/${encodeURIComponent(blocker.item.id)}/relations`, 'POST', {
        targetId: dependent.item.id,
        kind: 'blocks',
      }),
    );
    return;
  }
  if (command === 'project-update' || command === 'milestone-update') {
    const body: Record<string, unknown> = {};
    for (const key of ['description', 'title'])
      if (values[key] !== undefined) body[key] = values[key];
    for (const [flag, key] of [
      ['start', 'startDate'],
      ['due', 'dueDate'],
    ])
      if (values[flag] !== undefined) body[key] = values[flag] === 'none' ? null : values[flag];
    if (!Object.keys(body).length) throw usage('Provide at least one field to update.');
    if (command === 'milestone-update') {
      if (expectedRevision === undefined)
        throw usage('milestone-update requires --expected-revision from milestones.');
      body.expectedRevision = expectedRevision;
    }
    output(
      await api(
        `${command === 'project-update' ? 'projects' : 'milestones'}/${encodeURIComponent(args[0])}`,
        'PATCH',
        body,
      ),
    );
    return;
  }
  if (command === 'project-create') {
    const body: Record<string, unknown> = { name: args[0], key: values.key };
    for (const key of ['description', 'lifecycle', 'color', 'visibility'])
      if (values[key] !== undefined) body[key] = values[key];
    for (const [flag, key] of [
      ['start', 'startDate'],
      ['due', 'dueDate'],
    ])
      if (values[flag] !== undefined) body[key] = values[flag] === 'none' ? null : values[flag];
    output(await api<Project>('projects', 'POST', body));
    return;
  }
  if (command === 'milestones' || command === 'milestone-create') {
    const project = values.project
      ? await api<Project>(`projects/${encodeURIComponent(String(values.project))}`)
      : null;
    if (command === 'milestones') {
      const milestones = (await all<Milestone>('milestones')).filter(
        (m) => !project || m.projectId === project.id,
      );
      output(
        milestones,
        milestones.map((m) => ({
          ID: m.id,
          Title: m.title,
          Due: m.dueDate || '—',
          Completed: m.completed,
        })),
      );
    } else {
      output(
        await api<Milestone>('milestones', 'POST', {
          projectId: project!.id,
          title: args[0],
          ...(values.due !== undefined
            ? { dueDate: values.due === 'none' ? null : values.due }
            : {}),
          ...(values.completed ? { completed: true } : {}),
        }),
      );
    }
    return;
  }
  if (command === 'get') {
    const detail = await api<ItemDetail>(itemPath());
    if (values.json) output(detail);
    else {
      output(detail.item, rows([detail.item]));
      process.stdout.write(`\n${detail.item.description || '(No description)'}\n`);
      for (const entry of detail.activity)
        process.stdout.write(`\n${entry.createdAt} · ${entry.kind}\n${entry.body}\n`);
      for (const link of detail.links) process.stdout.write(`\n${link.title}: ${link.url}\n`);
    }
    return;
  }
  if (command === 'list' || command === 'search') {
    const query = new URLSearchParams();
    const project = values.project ?? repository.config.project;
    if (project) query.set('projectId', project === 'none' ? 'null' : String(project));
    for (const key of ['status', 'priority', 'type', 'visibility', 'limit', 'cursor'])
      if (values[key] !== undefined) query.set(key, String(values[key]));
    if (values.assignee)
      query.set('assigneeId', values.assignee === 'none' ? 'null' : String(values.assignee));
    if (command === 'search') query.set('q', args[0]);
    if (values.page) output(await page<WorkItem>('items', query));
    else {
      const items = await all<WorkItem>('items', query);
      output(items, rows(items));
    }
    return;
  }
  if (command === 'comment') {
    if (!args[1].trim()) throw usage('Comment cannot be empty.');
    output(await api(`${itemPath()}/comments`, 'POST', { body: args[1] }));
    return;
  }
  const body: Record<string, unknown> = {};
  for (const key of ['title', 'description', 'status', 'priority', 'type', 'visibility'])
    if (values[key] !== undefined) body[key] = values[key];
  for (const [flag, key] of [
    ['start', 'startDate'],
    ['due', 'dueDate'],
    ['follow-up', 'followUpDate'],
    ['assignee', 'assigneeId'],
  ]) {
    if (values[flag] !== undefined) body[key] = values[flag] === 'none' ? null : values[flag];
  }
  if (values.labels !== undefined)
    body.labels =
      values.labels === 'none'
        ? []
        : String(values.labels)
            .split(',')
            .map((label) => label.trim())
            .filter(Boolean);
  // Repository defaults scope reads and new captures, never move an existing item implicitly.
  const project = values.project ?? (command === 'create' ? repository.config.project : undefined);
  if (project)
    body.projectId =
      project === 'none'
        ? null
        : (await api<Project>(`projects/${encodeURIComponent(String(project))}`)).id;
  if (command === 'create') body.title = args[0];
  if (!Object.keys(body).length)
    throw usage('No changes specified. Use --status, --title, --due, or another update option.');
  if (command === 'update') {
    body.expectedRevision =
      expectedRevision ?? (await api<ItemDetail>(itemPath())).item.revision ?? 0;
  }
  const result = await api<WorkItem>(
    command === 'create' ? 'items' : itemPath(),
    command === 'create' ? 'POST' : 'PATCH',
    body,
  );
  output(result, rows([result]));
}

main().catch((error: unknown) => {
  let message = error instanceof Error ? error.message : 'Unexpected error';
  if (process.env.TRESTL_TOKEN) secrets.add(process.env.TRESTL_TOKEN);
  for (const secret of secrets) message = message.split(secret).join('[redacted]');
  const failure = error instanceof CliError ? error : new CliError(message);
  process.stderr.write(
    jsonRequested
      ? `${JSON.stringify({ error: { code: failure.code, message, ...(failure.status ? { status: failure.status } : {}) } })}\n`
      : `trestl: ${message}\n`,
  );
  process.exitCode = failure.exitCode;
});
