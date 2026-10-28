import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  mkdtempSync,
  readFileSync,
  statSync,
  rmSync,
  existsSync,
  mkdirSync,
  writeFileSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const testRoot = mkdtempSync(join(tmpdir(), 'trestl-cli-'));
after(() => rmSync(testRoot, { recursive: true, force: true }));

const cwd = fileURLToPath(new URL('..', import.meta.url));
const fixture = `
const relation = {id:'relation-id',itemId:'item-id',targetId:'dependent-id',kind:'blocks'};
const item = {id:'item-id',identifier:'K8S-1',title:'Cluster upgrade',description:'Upgrade plan',status:'todo',priority:'high',projectId:'project-id',dueDate:null,revision:3};
globalThis.fetch = async (input, options) => {
  const url = new URL(input); const path=url.pathname;
  if(options.headers.Authorization!=='Bearer test-token')throw new Error('Missing authorization');
  if(path.endsWith('/auth/status'))return Response.json({authenticated: !process.env.TEST_REJECT_TOKEN,user:{id:'user-id',name:'Test User',email:'test@example.com'}});
  if(process.env.TEST_UPSTREAM_ERROR)return Response.json({message:'test-token upstream failed'},{status:Number(process.env.TEST_UPSTREAM_ERROR)||503});
  if(path.endsWith('/items/item-id/relations') && options.method==='POST') {
    const body=JSON.parse(options.body);
    if(body.targetId!=='dependent-id' || body.kind!=='blocks')throw new Error('Incorrect dependency direction');
    return Response.json({id:'relation-id',itemId:'item-id',...body},{status:201});
  }
  if(path.endsWith('/items/item-id/relations/relation-id') && options.method==='DELETE')return new Response(null,{status:204});
  if(path.endsWith('/items/K8S-1') && options.method==='DELETE') {
    if(JSON.parse(options.body).expectedRevision!==3)return Response.json({message:'Work item changed'},{status:409});
    return new Response(null,{status:204});
  }
  if((path.endsWith('/items/K8S-2') || path.endsWith('/items/dependent-id')) && options.method==='GET')return Response.json({item:{...item,id:'dependent-id',identifier:'K8S-2'},activity:[],links:[],relations:[]});
  if(path.endsWith('/projects/K8S') && options.method==='PATCH')return Response.json({id:'project-id',...JSON.parse(options.body)});
  if(path.endsWith('/milestones/milestone-id') && options.method==='PATCH') {
    const body=JSON.parse(options.body);
    if(body.expectedRevision!==2)return Response.json({message:'Milestone changed'},{status:409});
    return Response.json({id:'milestone-id',...body,revision:3});
  }
  if(path.endsWith('/projects') && options.method==='POST')return Response.json({id:'new-project',...JSON.parse(options.body)},{status:201});
  if(path.endsWith('/milestones') && options.method==='POST') {
    const body = JSON.parse(options.body);
    if(body.projectId!=='project-id')throw new Error('Milestone project key not resolved');
    if(process.env.TEST_KEY && options.headers['Idempotency-Key']!==process.env.TEST_KEY)throw new Error('Missing retry key');
    return Response.json({id:'milestone-id',...body},{status:201});
  }
  if(path.endsWith('/milestones'))return Response.json({data:[{id:'milestone-id',projectId:'project-id',title:'Launch',dueDate:'2026-10-01',completed:false,revision:2,progress:{done:2,total:5}},{id:'other',projectId:'other-project',title:process.env.TEST_CROSS_PROJECT_TITLE?'Launch':'Other',completed:false},...(process.env.TEST_DUPLICATE_MILESTONE?[{id:'duplicate',projectId:'project-id',title:'Launch'}]:[])]});
  if(path.includes('/projects/project-id/canvases')) {
    const canvas={id:'canvas-id',title:'Architecture',revision:2,updatedAt:'2026-09-13T00:00:00Z'};
    if(path.endsWith('/show')) return Response.json({...canvas,url:'/#/project/project-id?tab=canvases%2Fcanvas-id'});
    if(options.method==='DELETE') {
      if(JSON.parse(options.body).expectedRevision!==2)return Response.json({message:'Canvas changed'},{status:409});
      return new Response(null,{status:204});
    }
    if(options.method==='POST') {
      const body=JSON.parse(options.body);
      if(path.endsWith('/import') && body.document?.type!=='excalidraw')throw new Error('Missing native document');
      return Response.json({...canvas,...body},{status:201});
    }
    return Response.json({data:[canvas]});
  }
  if(path.endsWith('/projects'))return Response.json({data:[{id:'project-id',key:'K8S',name:'Kubernetes'}]});
  if(path.endsWith('/projects/K8S'))return Response.json({id:'project-id',key:'K8S',name:'Kubernetes'});
  if(path.endsWith('/items') && options.method==='GET') {
    if(process.env.TEST_EXPECT_QUERY) for(const [key,value] of Object.entries(JSON.parse(process.env.TEST_EXPECT_QUERY))) if(url.searchParams.get(key)!==value)throw new Error('Missing query '+key);
    if(process.env.TEST_REPEAT_CURSOR)return Response.json({data:[item],nextCursor:'1'});
    if(url.searchParams.has('q'))return Response.json({data:[item]});
    return Response.json(url.searchParams.has('cursor')?{data:[{...item,id:'other-id',identifier:'K8S-2',title:'Documentation',description:'Runbooks'}]}:{data:[item],nextCursor:'1'});
  }
  if(path.endsWith('/items') && options.method==='POST') {
    const body=JSON.parse(options.body);
    if(body.projectId!=='project-id')throw new Error('Project key was not resolved');
    if(process.env.TEST_KEY && options.headers['Idempotency-Key']!==process.env.TEST_KEY)throw new Error('Missing retry key');
    return Response.json({...item,...body},{status:201});
  }
  if(path.endsWith('/items/K8S-1') && options.method==='GET')return Response.json({item,activity:[],links:[],relations:process.env.TEST_NO_RELATION?[]:[relation,{...relation,id:'reverse',itemId:'dependent-id',targetId:'item-id'}]});
  if(path.endsWith('/items/K8S-1') && options.method==='PATCH') {
    const body=JSON.parse(options.body);
    if(body.projectId!==undefined && process.env.TEST_NO_MOVE)throw new Error('Implicit project move');
    if(body.expectedRevision!==3)return Response.json({message:'Work item changed'},{status:409});
    return Response.json(process.env.TEST_PATCH_ENVELOPE?{item:{...item,...body,revision:4}}:{...item,...body,revision:4});
  }
  if(path.endsWith('/items/K8S-1/comments')) {
    if(process.env.TEST_KEY && options.headers['Idempotency-Key']!==process.env.TEST_KEY)throw new Error('Missing retry key');
    return Response.json({body:JSON.parse(options.body).body},{status:201});
  }
  if(path.endsWith('/items/ready')) {
    if(process.env.TEST_EXPECT_QUERY) for(const [key,value] of Object.entries(JSON.parse(process.env.TEST_EXPECT_QUERY))) if(url.searchParams.get(key)!==value)throw new Error('Missing query '+key);
    return Response.json(url.searchParams.has('cursor')?{data:[{...item,id:'other-id',identifier:'K8S-2',priority:'low'}]}:{data:[item],nextCursor:'1'});
  }
  const queue=path.match(/[/]items[/]K8S-1[/](claim|release|handoff)$/);
  if(queue && options.method==='POST') {
    if(process.env.TEST_KEY && options.headers['Idempotency-Key']!==process.env.TEST_KEY)throw new Error('Missing retry key');
    if(process.env.TEST_EXPECT_BODY && options.body!==process.env.TEST_EXPECT_BODY)throw new Error('Unexpected body '+options.body);
    if(process.env.TEST_CLAIMED)return Response.json({error:'conflict',message:'K8S-1 is already in progress (claimed by Other). Choose another ready item.'},{status:409});
    const body=JSON.parse(options.body);
    const status={claim:'in_progress',release:'todo',handoff:'in_review'}[queue[1]];
    return Response.json({item:{...item,status,revision:4},...(body.comment?{comment:{body:body.comment}}:{}),...(body.pullRequestUrl?{link:{url:body.pullRequestUrl,kind:'repository'}}:{})});
  }
  if(path.endsWith('/export'))return Response.json({version:1,items:[item]});
  return Response.json({message:'Work item not found'},{status:404});
};
`;

function run(args, token = 'test-token', options = {}) {
  return spawnSync(
    process.execPath,
    [
      '--import',
      import.meta.resolve('tsx'),
      '--import',
      `data:text/javascript,${encodeURIComponent(fixture)}`,
      fileURLToPath(new URL('../cli/index.ts', import.meta.url)),
      ...args,
    ],
    {
      cwd: options.cwd || cwd,
      env: {
        ...process.env,
        TRESTL_PROFILE: '',
        TRESTL_CONFIG_DIR: join(testRoot, 'empty'),
        TRESTL_URL: 'http://localhost:3001',
        TRESTL_TOKEN: token,
        ...options.env,
      },
      input: options.input,
      encoding: 'utf8',
    },
  );
}
test('help is accessible without a token', () => {
  const r = run(['--help'], '');
  assert.equal(r.status, 0);
  assert.match(r.stdout, /Usage:/);
});
test('missing token returns a useful nonzero error', () => {
  const r = run(['list'], '');
  assert.equal(r.status, 3);
  assert.match(r.stderr, /Not logged in/);
});
test('list follows pagination and emits valid JSON only', () => {
  const r = run(['list', '--json']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).length, 2);
});
test('search and project filters work together', () => {
  const r = run(['search', 'upgrade', '--project', 'K8S', '--json']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout)[0].identifier, 'K8S-1');
  assert.equal(JSON.parse(r.stdout).length, 1);
});
test('create resolves project key and sends work item values', () => {
  const r = run(['create', 'New plan', '--project', 'K8S', '--visibility', 'private', '--json']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).title, 'New plan');
  assert.equal(JSON.parse(r.stdout).visibility, 'private');
});
test('update resolves identifier and clears dates', () => {
  const r = run(['update', 'K8S-1', '--status', 'done', '--due', 'none', '--json']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).status, 'done');
  assert.equal(JSON.parse(r.stdout).dueDate, null);
});
test('comment posts text to the resolved item', () => {
  const r = run(['comment', 'K8S-1', 'Review on Friday', '--json']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).body, 'Review on Friday');
});
test('export emits JSON', () => {
  const r = run(['export']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).version, 1);
});
test('an unknown option fails rather than silently mutating', () => {
  const r = run(['create', 'Title', '--typo', 'secret']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /Unknown option/);
});

function authRun(directory, args, options = {}) {
  return run(args, '', {
    ...options,
    env: { TRESTL_CONFIG_DIR: directory, TRESTL_URL: '', ...options.env },
  });
}
function login(directory, extra = [], options = {}) {
  return authRun(
    directory,
    ['login', '--token-stdin', '--url', 'http://localhost:3001', ...extra],
    {
      input: 'test-token\n',
      ...options,
    },
  );
}
test('login persists validated credentials; later processes use them and logout removes them', () => {
  const directory = join(testRoot, 'lifecycle');
  const result = login(directory);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.includes('test-token'), false);
  assert.equal(readFileSync(join(directory, 'default.json'), 'utf8').includes('test-token'), true);
  if (process.platform !== 'win32') {
    assert.equal(statSync(directory).mode & 0o777, 0o700);
    assert.equal(statSync(join(directory, 'default.json')).mode & 0o777, 0o600);
  }
  const listing = authRun(directory, ['list', '--json']);
  assert.equal(listing.status, 0, listing.stderr);
  assert.equal(JSON.parse(listing.stdout).length, 2);
  const status = authRun(directory, ['auth', 'status']);
  assert.equal(status.status, 0, status.stderr);
  assert.equal(JSON.parse(status.stdout).source, 'saved');
  assert.equal(status.stdout.includes('test-token'), false);
  assert.equal(authRun(directory, ['logout']).status, 0);
  assert.equal(existsSync(join(directory, 'default.json')), false);
  assert.equal(authRun(directory, ['list']).status, 3);
});
test('named profiles are isolated and server overrides never reuse saved tokens', () => {
  const directory = join(testRoot, 'profiles');
  assert.equal(login(directory, ['--profile', 'work']).status, 0);
  assert.equal(authRun(directory, ['list']).status, 3);
  assert.equal(authRun(directory, ['list', '--profile', 'work']).status, 0);
  const mismatch = authRun(directory, [
    'list',
    '--profile',
    'work',
    '--url',
    'https://other.example',
  ]);
  assert.equal(mismatch.status, 3);
  assert.match(mismatch.stderr, /different server/);
  assert.equal(authRun(directory, ['list'], { env: { TRESTL_PROFILE: 'work' } }).status, 0);
});
test('failed login preserves the existing credentials', () => {
  const directory = join(testRoot, 'rejected');
  assert.equal(login(directory).status, 0);
  const before = readFileSync(join(directory, 'default.json'), 'utf8');
  const result = login(directory, [], { env: { TEST_REJECT_TOKEN: '1' } });
  assert.equal(result.status, 3);
  assert.match(result.stderr, /Authentication failed/);
  assert.equal(readFileSync(join(directory, 'default.json'), 'utf8'), before);
});
test('saved tokens are redacted from upstream errors', () => {
  const directory = join(testRoot, 'redaction');
  assert.equal(login(directory).status, 0);
  const result = authRun(directory, ['list'], { env: { TEST_UPSTREAM_ERROR: '503' } });
  assert.equal(result.status, 6);
  assert.match(result.stderr, /redacted/);
  assert.equal(result.stderr.includes('test-token'), false);
});
test('environment token overrides saved credentials', () => {
  const directory = join(testRoot, 'override');
  assert.equal(login(directory).status, 0);
  const result = authRun(directory, ['auth', 'status'], {
    env: { TRESTL_TOKEN: 'test-token' },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).source, 'environment');
});
test('login rejects insecure remote URLs, unsafe profiles and missing piped tokens', () => {
  const directory = join(testRoot, 'invalid');
  for (const args of [
    ['--url', 'http://remote.example'],
    ['--profile', '../escape'],
  ]) {
    assert.equal(login(directory, args).status, 1);
  }
  assert.equal(login(directory, [], { input: '' }).status, 1);
  assert.equal(authRun(directory, ['login', '--token']).status, 1);
  assert.equal(existsSync(join(directory, 'default.json')), false);
});

test('get uses direct identifier lookup and includes complete detail', () => {
  const result = run(['get', 'K8S-1', '--json']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).item.revision, 3);
  assert.deepEqual(JSON.parse(result.stdout).activity, []);
});
test('list sends filters on every page and supports bounded page output', () => {
  const args = [
    'list',
    '--project',
    'K8S',
    '--status',
    'todo',
    '--assignee',
    'none',
    '--limit',
    '1',
    '--json',
  ];
  const env = {
    TEST_EXPECT_QUERY: JSON.stringify({
      projectId: 'K8S',
      status: 'todo',
      assigneeId: 'null',
      limit: '1',
    }),
  };
  const all = run(args, 'test-token', { env });
  assert.equal(all.status, 0, all.stderr);
  assert.equal(JSON.parse(all.stdout).length, 2);
  const page = run([...args, '--page'], 'test-token', { env });
  assert.equal(page.status, 0, page.stderr);
  assert.equal(JSON.parse(page.stdout).nextCursor, '1');
  const next = run([...args, '--page', '--cursor', '1'], 'test-token', { env });
  assert.equal(next.status, 0, next.stderr);
  assert.equal(JSON.parse(next.stdout).data[0].identifier, 'K8S-2');
});
test('JSON errors and exit codes distinguish usage, auth, not found, conflict and availability', () => {
  for (const [args, token, env, exit, code] of [
    [['list', '--bogus'], 'test-token', {}, 2, 'usage_error'],
    [['list'], '', {}, 3, 'unauthorized'],
    [['get', 'missing'], 'test-token', {}, 4, 'not_found'],
    [
      ['update', 'K8S-1', '--status', 'done', '--expected-revision', '2'],
      'test-token',
      {},
      5,
      'conflict',
    ],
    [['list'], 'test-token', { TEST_UPSTREAM_ERROR: '503' }, 6, 'server_error'],
    [['list'], 'test-token', { TEST_UPSTREAM_ERROR: '429' }, 6, 'rate_limited'],
  ]) {
    const result = run([...args, '--json'], token, { env });
    assert.equal(result.status, exit, result.stderr);
    assert.equal(result.stdout, '');
    assert.equal(JSON.parse(result.stderr).error.code, code);
  }
});
test('commands reject unsupported flags and pagination loops', () => {
  for (const args of [
    ['get', 'K8S-1', '--status', 'done'],
    ['list', '--cursor', '1'],
    ['list', '--limit', '501'],
    ['create', 'Title', '--expected-revision', '1'],
  ]) {
    assert.equal(run(args).status, 2);
  }
  const loop = run(['list'], 'test-token', { env: { TEST_REPEAT_CURSOR: '1' } });
  assert.equal(loop.status, 6);
  assert.match(loop.stderr, /repeated pagination/);
});
test('create and comment send user-provided retry keys', () => {
  const options = { env: { TEST_KEY: 'capture-123' } };
  assert.equal(
    run(
      ['create', 'New task', '--project', 'K8S', '--idempotency-key', 'capture-123'],
      'test-token',
      options,
    ).status,
    0,
  );
  assert.equal(
    run(
      ['comment', 'K8S-1', 'An internal note', '--idempotency-key', 'capture-123'],
      'test-token',
      options,
    ).status,
    0,
  );
});

test('repository defaults work from nested directories and never implicitly move existing work', () => {
  const directory = join(testRoot, 'repository');
  mkdirSync(join(directory, 'src'), { recursive: true });
  const initialized = run(['init', '--profile', 'work', '--project', 'K8S', '--json'], '', {
    cwd: directory,
  });
  assert.equal(initialized.status, 0, initialized.stderr);
  assert.deepEqual(JSON.parse(readFileSync(join(directory, '.trestl.json'), 'utf8')), {
    profile: 'work',
    project: 'K8S',
  });
  assert.equal(run(['init', '--project', 'OTHER'], '', { cwd: directory }).status, 2);
  const config = run(['config', '--json'], '', { cwd: join(directory, 'src') });
  assert.equal(JSON.parse(config.stdout).profile, 'work');
  const list = run(['list', '--json'], 'test-token', {
    cwd: join(directory, 'src'),
    env: { TEST_EXPECT_QUERY: JSON.stringify({ projectId: 'K8S' }) },
  });
  assert.equal(list.status, 0, list.stderr);
  const create = run(['create', 'Capture from repository', '--json'], 'test-token', {
    cwd: directory,
  });
  assert.equal(create.status, 0, create.stderr);
  const update = run(['update', 'K8S-1', '--status', 'done', '--json'], 'test-token', {
    cwd: directory,
    env: { TEST_NO_MOVE: '1' },
  });
  assert.equal(update.status, 0, update.stderr);
  const ignored = run(['config', '--no-config', '--json'], '', { cwd: directory });
  assert.equal(JSON.parse(ignored.stdout).project, null);
  const overridden = run(['config', '--profile', 'personal', '--json'], '', { cwd: directory });
  assert.equal(JSON.parse(overridden.stdout).profile, 'personal');
  writeFileSync(join(directory, '.trestl.json'), JSON.stringify({ token: 'never-print-this' }));
  const invalid = run(['config', '--json'], '', { cwd: directory });
  assert.equal(invalid.status, 2);
  assert.equal(invalid.stderr.includes('never-print-this'), false);
});

test('profiles list discovers names offline without opening credentials or following symlinks', () => {
  const directory = join(testRoot, 'discovery');
  mkdirSync(directory);
  // Even malformed contents do not matter: discovery never opens the files.
  writeFileSync(join(directory, 'work.json'), 'a-secret-that-must-not-appear', { mode: 0o000 });
  writeFileSync(join(directory, 'personal.json'), '{invalid-json');
  writeFileSync(join(directory, 'work.json.tmp'), 'ignore');
  writeFileSync(join(directory, 'invalid name.json'), 'ignore');
  mkdirSync(join(directory, 'folder.json'));
  symlinkSync(join(directory, 'personal.json'), join(directory, 'linked.json'));
  const result = authRun(directory, ['profiles', 'list', '--json']);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    selectedProfile: 'default',
    tokenOverride: false,
    profiles: [
      { name: 'personal', selected: false },
      { name: 'work', selected: false },
    ],
  });
  assert.equal(result.stdout.includes('a-secret-that-must-not-appear'), false);
  assert.equal(result.stderr, '');
  const overridden = authRun(directory, ['profiles', 'list', '--profile', 'work', '--json'], {
    env: { TRESTL_TOKEN: 'never-print-token' },
  });
  const data = JSON.parse(overridden.stdout);
  assert.equal(data.selectedProfile, 'work');
  assert.equal(data.tokenOverride, true);
  assert.equal(data.profiles[1].selected, true);
  assert.equal(overridden.stdout.includes('never-print-token'), false);
  assert.match(authRun(directory, ['profiles', 'list']).stdout, /default \(not saved\)/);
});
test('profiles list handles missing directories and respects repository and explicit selection', () => {
  const directory = join(testRoot, 'profile-selection');
  const empty = authRun(join(directory, 'missing'), ['profiles', 'list', '--json']);
  assert.equal(empty.status, 0, empty.stderr);
  assert.deepEqual(JSON.parse(empty.stdout).profiles, []);
  mkdirSync(directory);
  writeFileSync(join(directory, '.trestl.json'), JSON.stringify({ profile: 'work' }));
  for (const [args, env, expected] of [
    [[], {}, 'work'],
    [[], { TRESTL_PROFILE: 'personal' }, 'personal'],
    [['--profile', 'chosen'], { TRESTL_PROFILE: 'personal' }, 'chosen'],
    [['--no-config'], {}, 'default'],
  ]) {
    const result = authRun(join(directory, 'missing'), ['profiles', 'list', '--json', ...args], {
      cwd: directory,
      env,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).selectedProfile, expected);
  }
  for (const args of [['profiles'], ['profiles', 'unknown'], ['profiles', 'list', 'extra']])
    assert.equal(run(args).status, 2);
});

test('planning commands require explicit project identity and resolve milestone scope', () => {
  assert.equal(run(['project-create', 'Demo', '--json']).status, 2);
  assert.equal(run(['milestone-create', 'Launch', '--json']).status, 2);
  const project = run([
    'project-create',
    'Launchpad',
    '--key',
    'DEMO',
    '--start',
    '2026-09-01',
    '--due',
    '2026-10-01',
    '--lifecycle',
    'fixed',
    '--json',
  ]);
  assert.equal(project.status, 0, project.stderr);
  assert.equal(JSON.parse(project.stdout).startDate, '2026-09-01');
  assert.equal(JSON.parse(project.stdout).lifecycle, 'fixed');
  const milestone = run([
    'milestone-create',
    'Launch',
    '--project',
    'K8S',
    '--due',
    '2026-10-01',
    '--completed',
    '--json',
  ]);
  assert.equal(milestone.status, 0, milestone.stderr);
  assert.equal(JSON.parse(milestone.stdout).projectId, 'project-id');
  assert.equal(JSON.parse(milestone.stdout).completed, true);
  const list = run(['milestones', '--project', 'K8S', '--json']);
  assert.equal(list.status, 0, list.stderr);
  assert.equal(JSON.parse(list.stdout).length, 1);
});
test('CLI creates and clears timeline start dates and tags', () => {
  const created = run([
    'create',
    'Scheduled task',
    '--project',
    'K8S',
    '--start',
    '2026-09-01',
    '--due',
    '2026-09-09',
    '--labels',
    'demo, design',
    '--json',
  ]);
  assert.equal(created.status, 0, created.stderr);
  assert.equal(JSON.parse(created.stdout).startDate, '2026-09-01');
  assert.deepEqual(JSON.parse(created.stdout).labels, ['demo', 'design']);
  const cleared = run([
    'update',
    'K8S-1',
    '--start',
    'none',
    '--labels',
    'none',
    '--expected-revision',
    '3',
    '--json',
  ]);
  assert.equal(cleared.status, 0, cleared.stderr);
  assert.equal(JSON.parse(cleared.stdout).startDate, null);
  assert.deepEqual(JSON.parse(cleared.stdout).labels, []);
});

test('dependency command resolves both identifiers in blocker-to-dependent order', () => {
  const r = run(['relation-add', 'K8S-1', 'K8S-2', '--json']);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), {
    id: 'relation-id',
    itemId: 'item-id',
    targetId: 'dependent-id',
    kind: 'blocks',
  });
});
test('project update only sends requested fields and can clear dates', () => {
  const r = run([
    'project-update',
    'K8S',
    '--due',
    'none',
    '--description',
    'A release plan',
    '--json',
  ]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), {
    id: 'project-id',
    dueDate: null,
    description: 'A release plan',
  });
});
test('milestone updates require the observed revision and propagate conflicts', () => {
  const missing = run(['milestone-update', 'milestone-id', '--due', '2026-10-15', '--json']);
  assert.equal(missing.status, 2);
  const stale = run([
    'milestone-update',
    'milestone-id',
    '--due',
    '2026-10-15',
    '--expected-revision',
    '1',
    '--json',
  ]);
  assert.equal(stale.status, 5);
  const ok = run([
    'milestone-update',
    'milestone-id',
    '--due',
    '2026-10-15',
    '--expected-revision',
    '2',
    '--json',
  ]);
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(JSON.parse(ok.stdout).dueDate, '2026-10-15');
  assert.equal(JSON.parse(ok.stdout).revision, 3);
});

test('canvas commands resolve project keys, import native files, show links, and require revision-safe deletes', () => {
  const file = join(testRoot, 'architecture.excalidraw');
  writeFileSync(
    file,
    JSON.stringify({ type: 'excalidraw', elements: [], appState: {}, files: {} }),
  );
  const runCanvas = (args) => run(['canvases', ...args, '--project', 'K8S', '--json']);
  let r = runCanvas(['list']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout)[0].id, 'canvas-id');
  r = runCanvas(['create', 'New canvas', '--collection', 'collection-id']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).title, 'New canvas');
  assert.equal(JSON.parse(r.stdout).collectionId, 'collection-id');
  r = runCanvas(['import', file]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).title, 'architecture');
  assert.equal(JSON.parse(r.stdout).document.type, 'excalidraw');
  r = runCanvas(['import', file, '--title', 'Renamed']);
  assert.equal(JSON.parse(r.stdout).title, 'Renamed');
  r = runCanvas(['show', 'canvas-id']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(
    JSON.parse(r.stdout).url,
    'http://localhost:3001/#/project/project-id?tab=canvases%2Fcanvas-id',
  );
  r = run(['canvases', 'show', 'canvas-id', '--project', 'K8S']);
  assert.equal(
    r.stdout.trim(),
    'http://localhost:3001/#/project/project-id?tab=canvases%2Fcanvas-id',
  );
  assert.equal(runCanvas(['delete', 'canvas-id']).status, 2);
  assert.equal(runCanvas(['delete', 'canvas-id', '--expected-revision', '1']).status, 5);
  r = runCanvas(['delete', 'canvas-id', '--expected-revision', '2']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).deleted, true);
  writeFileSync(file, 'invalid JSON');
  assert.equal(runCanvas(['import', file]).status, 2);
  assert.equal(runCanvas(['import', file + '.missing']).status, 2);
  assert.equal(run(['canvases', 'list', '--no-config']).status, 2);
  assert.equal(runCanvas(['show', 'canvas-id', '--title', 'Ignored']).status, 2);
  assert.equal(runCanvas(['unknown']).status, 2);
});

test('canvas commands respect repository project defaults', () => {
  const directory = join(testRoot, 'canvas-repo');
  mkdirSync(directory);
  writeFileSync(join(directory, '.trestl.json'), JSON.stringify({ project: 'K8S' }));
  const r = run(['canvases', 'list', '--json'], 'test-token', { cwd: directory });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout)[0].id, 'canvas-id');
});

test('per-command help lists only applicable flags without authenticating', () => {
  const update = run(['update', '--help'], '');
  assert.equal(update.status, 0, update.stderr);
  for (const flag of [
    'title',
    'description',
    'labels',
    'expected-revision',
    'parent',
    'no-parent',
    'milestone',
  ])
    assert.match(update.stdout, new RegExp('--' + flag));
  assert.match(update.stdout, /Usage: trestl update <id-or-identifier>/);
  assert.doesNotMatch(update.stdout, /--idempotency-key|--completed|Commands:/);
  const create = run(['create', '--help', '--json'], '');
  assert.match(JSON.parse(create.stdout).help, /--idempotency-key/);
  assert.doesNotMatch(JSON.parse(create.stdout).help, /--expected-revision/);
  assert.equal(run(['unknown', '--help'], '').status, 2);
});

test('parent references resolve on create and update and can be cleared', () => {
  for (const reference of ['K8S-2', 'dependent-id']) {
    for (const args of [
      ['create', 'Child', '--project', 'K8S'],
      ['update', 'K8S-1'],
    ]) {
      const r = run([...args, '--parent', reference, '--json']);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(JSON.parse(r.stdout).parentId, 'dependent-id');
    }
  }
  const cleared = run(['update', 'K8S-1', '--no-parent', '--json']);
  assert.equal(cleared.status, 0, cleared.stderr);
  assert.equal(JSON.parse(cleared.stdout).parentId, null);
  assert.equal(run(['update', 'K8S-1', '--parent', 'K8S-2', '--no-parent']).status, 2);
  assert.equal(run(['update', 'K8S-1', '--parent', 'missing']).status, 4);
});

test('relation removal resolves endpoints and removes only the outgoing dependency', () => {
  const r = run(['relation-remove', 'K8S-1', 'K8S-2', '--json']);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { deleted: true, id: 'relation-id' });
  assert.equal(
    run(['relation-remove', 'K8S-1', 'K8S-2'], 'test-token', { env: { TEST_NO_RELATION: '1' } })
      .status,
    4,
  );
  assert.equal(run(['relation-remove', 'K8S-2', 'K8S-1']).status, 4);
});

test('item deletion requires the observed revision and propagates conflicts', () => {
  assert.equal(run(['delete', 'K8S-1'], '').status, 2);
  assert.equal(run(['delete', 'K8S-1', '--expected-revision', '2']).status, 5);
  const r = run(['delete', 'K8S-1', '--expected-revision', '3', '--json']);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { deleted: true, id: 'K8S-1' });
});

test('milestone assignment resolves IDs and project-scoped titles and can be cleared', () => {
  for (const reference of ['milestone-id', 'Launch']) {
    for (const args of [
      ['create', 'Milestone task', '--project', 'K8S'],
      ['update', 'K8S-1'],
    ]) {
      const r = run([...args, '--milestone', reference, '--json'], 'test-token', {
        env: { TEST_CROSS_PROJECT_TITLE: '1' },
      });
      assert.equal(r.status, 0, r.stderr);
      assert.equal(JSON.parse(r.stdout).milestoneId, 'milestone-id');
    }
  }
  const cleared = run(['update', 'K8S-1', '--no-milestone', '--json']);
  assert.equal(cleared.status, 0, cleared.stderr);
  assert.equal(JSON.parse(cleared.stdout).milestoneId, null);
  assert.equal(run(['update', 'K8S-1', '--milestone', 'Launch', '--no-milestone']).status, 2);
  assert.equal(run(['update', 'K8S-1', '--milestone', 'other']).status, 2);
  assert.equal(run(['update', 'K8S-1', '--milestone', 'Missing']).status, 4);
  assert.equal(
    run(['update', 'K8S-1', '--milestone', 'Launch'], 'test-token', {
      env: { TEST_DUPLICATE_MILESTONE: '1' },
    }).status,
    2,
  );
  assert.equal(run(['create', 'No project', '--no-config', '--milestone', 'Launch']).status, 2);
  assert.equal(run(['update', 'K8S-1', '--project', 'none', '--milestone', 'Launch']).status, 2);
});

test('milestones show progress and revision and creation sends a retry key', () => {
  const listing = run(['milestones']);
  assert.equal(listing.status, 0, listing.stderr);
  assert.match(listing.stdout, /2 \/ 5/);
  assert.match(listing.stdout, /Revision/);
  const created = run(
    ['milestone-create', 'Launch', '--project', 'K8S', '--idempotency-key', 'launch-1'],
    'test-token',
    { env: { TEST_KEY: 'launch-1' } },
  );
  assert.equal(created.status, 0, created.stderr);
});

test('update preserves CLI item output with the v0.4 API response envelope', () => {
  const r = run(['update', 'K8S-1', '--status', 'done', '--json'], 'test-token', {
    env: { TEST_PATCH_ENVELOPE: '1' },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).revision, 4);
  assert.equal(JSON.parse(r.stdout).status, 'done');
});

test('ready sends queue filters, follows pages and uses repository project defaults', () => {
  const filtered = run(
    ['ready', '--label', 'agent', '--repository', 'acme/k8s', '--json'],
    'test-token',
    {
      env: { TEST_EXPECT_QUERY: JSON.stringify({ label: 'agent', repository: 'acme/k8s' }) },
    },
  );
  assert.equal(filtered.status, 0, filtered.stderr);
  assert.deepEqual(
    JSON.parse(filtered.stdout).map((entry) => entry.identifier),
    ['K8S-1', 'K8S-2'],
  );
  const paged = run(['ready', '--page', '--limit', '1', '--json'], 'test-token', {
    env: { TEST_EXPECT_QUERY: JSON.stringify({ limit: '1' }) },
  });
  assert.equal(paged.status, 0, paged.stderr);
  assert.equal(JSON.parse(paged.stdout).nextCursor, '1');
  const table = run(['ready']);
  assert.equal(table.status, 0, table.stderr);
  assert.match(table.stdout, /K8S-1/);
  const directory = join(testRoot, 'queue-repository');
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, '.trestl.json'), JSON.stringify({ project: 'K8S' }));
  for (const [args, projectId] of [
    [['ready', '--json'], 'K8S'],
    [['ready', '--project', 'none', '--json'], 'null'],
  ]) {
    const scoped = run(args, 'test-token', {
      cwd: directory,
      env: { TEST_EXPECT_QUERY: JSON.stringify({ projectId }) },
    });
    assert.equal(scoped.status, 0, scoped.stderr);
  }
  const everywhere = run(['ready', '--no-config', '--json'], 'test-token', {
    cwd: directory,
    env: { TEST_EXPECT_QUERY: JSON.stringify({ projectId: null }) },
  });
  assert.equal(everywhere.status, 0, everywhere.stderr);
});

test('claim, release and handoff send only supplied fields and return the queue envelope', () => {
  const claim = run(['claim', 'K8S-1', '--idempotency-key', 'claim-1', '--json'], 'test-token', {
    env: { TEST_KEY: 'claim-1', TEST_EXPECT_BODY: '{}' },
  });
  assert.equal(claim.status, 0, claim.stderr);
  assert.equal(JSON.parse(claim.stdout).item.status, 'in_progress');
  const guarded = run(['claim', 'K8S-1', '--expected-revision', '3', '--json'], 'test-token', {
    env: { TEST_EXPECT_BODY: '{"expectedRevision":3}' },
  });
  assert.equal(guarded.status, 0, guarded.stderr);
  const release = run(
    ['release', 'K8S-1', '--comment', 'Blocked on access', '--json'],
    'test-token',
    {
      env: { TEST_EXPECT_BODY: '{"comment":"Blocked on access"}' },
    },
  );
  assert.equal(release.status, 0, release.stderr);
  assert.equal(JSON.parse(release.stdout).item.status, 'todo');
  assert.equal(JSON.parse(release.stdout).comment.body, 'Blocked on access');
  const pr = 'https://github.com/acme/k8s/pull/7';
  const handoff = run(
    ['handoff', 'K8S-1', '--pr', pr, '--comment', 'Ready for review', '--json'],
    'test-token',
    {
      env: {
        TEST_EXPECT_BODY: JSON.stringify({ comment: 'Ready for review', pullRequestUrl: pr }),
      },
    },
  );
  assert.equal(handoff.status, 0, handoff.stderr);
  assert.equal(JSON.parse(handoff.stdout).item.status, 'in_review');
  assert.equal(JSON.parse(handoff.stdout).link.url, pr);
  const table = run(['handoff', 'K8S-1']);
  assert.equal(table.status, 0, table.stderr);
  assert.match(table.stdout, /in_review/);
});

test('queue commands fail cleanly on lost claims and invalid usage', () => {
  const lost = run(['claim', 'K8S-1', '--json'], 'test-token', { env: { TEST_CLAIMED: '1' } });
  assert.equal(lost.status, 5);
  assert.equal(lost.stdout, '');
  const error = JSON.parse(lost.stderr).error;
  assert.equal(error.code, 'conflict');
  assert.equal(error.status, 409);
  assert.match(error.message, /already in progress/);
  for (const args of [
    ['ready', '--status', 'todo'],
    ['ready', 'K8S-1'],
    ['claim'],
    ['claim', 'K8S-1', '--pr', 'https://example.com/pull/1'],
    ['claim', 'K8S-1', '--comment', 'note'],
    ['release', 'K8S-1', '--pr', 'https://example.com/pull/1'],
    ['handoff', 'K8S-1', '--comment', ' '],
    ['handoff', 'K8S-1', '--expected-revision', 'x'],
  ])
    assert.equal(run([...args, '--json']).status, 2, args.join(' '));
  assert.equal(run(['claim', 'missing', '--json']).status, 4);
  const help = run(['claim', '--help'], '');
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /Usage: trestl claim <id-or-identifier>/);
  assert.match(help.stdout, /--idempotency-key/);
  assert.doesNotMatch(help.stdout, /--pr |--comment /);
});
