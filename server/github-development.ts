import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppContext } from './context.ts';
import { makeStore, type Store } from './db.ts';
import { ownGitConnection, resolveGitCredential, type GitConnection } from './git-connections.ts';
import { githubApi } from './github-api.ts';
import { decryptToken } from './integration-provider.ts';
import type { ManagedGitHubApp } from './github-onboarding.ts';
import { workspaceOf, workspaceUser } from './workspaces.ts';
import type { Activity, Project, WorkItem, Status } from '../shared/types.ts';
import {
  defaultGitHubRules,
  type DevelopmentLink,
  type GitHubRepository,
  type GitHubEvent,
} from '../shared/github.ts';

interface Repository extends GitHubRepository {
  creatorId: string;
  workspaceId: string;
}
interface RemoteRepository {
  id: number;
  full_name: string;
  default_branch: string;
  private: boolean;
}
interface PullRequest {
  number: number;
  title: string;
  body: string | null;
  state: string;
  draft?: boolean;
  merged_at: string | null;
  updated_at: string;
  head: { ref: string; sha: string };
  base: { ref: string };
  user: { login: string } | null;
  requested_reviewers?: unknown[];
}
interface Snapshot {
  key: string;
  kind: DevelopmentLink['kind'];
  number: number | null;
  sha: string;
  title: string;
  branch: string;
  baseBranch: string;
  state: DevelopmentLink['state'];
  author: string;
  updatedAt: string;
  refs: Map<string, boolean>;
  review: string | null;
  checks: string | null;
  event: GitHubEvent | null;
}
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const repoName = z
  .string()
  .regex(/^[\w.-]+\/[\w.-]+$/)
  .max(200);
const status = z
  .enum(['backlog', 'todo', 'in_progress', 'in_review', 'done', 'canceled'])
  .nullable();
const rulesSchema = z
  .object({
    draft: status,
    opened: status,
    review_requested: status,
    approved: status,
    merged: status,
    closed: status,
  })
  .strict();
const configSchema = z
  .object({ branches: z.string().trim().max(500), rules: rulesSchema, enabled: z.boolean() })
  .strict();
export function branchMatches(patterns: string, branch: string) {
  return patterns
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)
    .some((p) =>
      new RegExp(
        `^${p
          .split('*')
          .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
          .join('.*')}$`,
      ).test(branch),
    );
}
/** Bare identifiers in titles/branches close work; body references require an explicit relationship. */
export function githubReferences(title: string, branch: string, body: string) {
  const refs = new Map<string, boolean>();
  const matches = (text: string) => [
    ...text.matchAll(/(?<![A-Za-z0-9])([A-Za-z][A-Za-z0-9]{0,19}-\d+)(?![A-Za-z0-9])/g),
  ];
  for (const match of matches(`${title}\n${branch}`)) refs.set(match[1].toUpperCase(), true);
  for (const line of body.split('\n')) {
    const magic = /\b(close[sd]?|fix(?:e[sd])?|resolve[sd]?|relates? to|references?|part of)\b/gi;
    const words = [...line.matchAll(magic)];
    for (let index = 0; index < words.length; index++) {
      const word = words[index];
      const closing = /^(close|fix|resolve)/i.test(word[1]);
      const part = line.slice(word.index! + word[0].length, words[index + 1]?.index ?? line.length);
      for (const match of matches(part))
        refs.set(match[1].toUpperCase(), (refs.get(match[1].toUpperCase()) ?? false) || closing);
    }
  }
  return refs;
}
export function githubBranchName(item: Pick<WorkItem, 'identifier' | 'title'>) {
  const slug = item.title
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 70)
    .replace(/-$/, '');
  return `${item.identifier.toLowerCase()}${slug ? `-${slug}` : ''}`;
}
export async function githubRepositories(ctx: AppContext, connection: GitConnection) {
  const { token } = await resolveGitCredential(ctx, connection);
  const all: RemoteRepository[] = [];
  for (let page = 1; page <= 20; page++) {
    const data = await githubApi<{ repositories: RemoteRepository[] }>(
      ctx,
      `/installation/repositories?per_page=100&page=${page}`,
      token,
    );
    if (!Array.isArray(data.repositories)) ctx.fail(502, 'GitHub returned invalid repositories.');
    all.push(...data.repositories);
    if (data.repositories.length < 100)
      return all.map((r) => ({
        id: r.id,
        repository: r.full_name,
        defaultBranch: r.default_branch,
        private: r.private,
      }));
  }
  ctx.fail(400, 'Select fewer than 2,000 repositories for this app installation.');
}
export function registerGitHubDevelopment(
  app: FastifyInstance,
  ctx: AppContext,
  syncIssues: (connectionId: string, repository: string) => Promise<void>,
) {
  let stopping = false;
  let running: Promise<void> | null = null;
  const busy = new Set<string>();
  const root = '/api/v1/github';
  function admin(request: FastifyRequest) {
    const user = ctx.requireUser(request);
    if (user.role !== 'admin' || request.tokenScope)
      ctx.fail(403, 'Administrator browser access is required.');
    return user;
  }
  async function authorized(request: FastifyRequest, id: string) {
    const user = ctx.requireUser(request);
    const repo = await ctx.store.get<Repository>('githubRepositories', id);
    if (
      !repo ||
      repo.workspaceId !== workspaceOf(user) ||
      !(await ctx.canProject(user, repo.projectId))
    )
      ctx.fail(404, 'Repository connection not found.');
    return repo;
  }
  async function connectionFor(userId: string, id: string) {
    const connection = await ownGitConnection(ctx, userId, id);
    if (!connection.githubInstallation?.development)
      ctx.fail(400, 'Use the guided GitHub App setup to enable development access.');
    return connection;
  }
  async function pages<T>(path: string, token: string) {
    const all: T[] = [];
    for (let page = 1; page <= 20; page++) {
      const rows = await githubApi<T[]>(
        ctx,
        `${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`,
        token,
      );
      if (!Array.isArray(rows)) ctx.fail(502, 'GitHub returned an invalid list.');
      all.push(...rows);
      if (rows.length < 100) return all;
    }
    ctx.fail(
      400,
      'GitHub history exceeds the current 2,000-record sync limit. Narrow the repository history before retrying.',
    );
  }
  async function pullSnapshot(
    pr: PullRequest,
    repository: string,
    token: string,
  ): Promise<Snapshot> {
    let review: string | null = null;
    let checks: string | null = null;
    if (pr.state === 'open') {
      const [reviews, result] = await Promise.all([
        pages<{ user: { login: string } | null; state: string; submitted_at: string }>(
          `/repos/${repository}/pulls/${pr.number}/reviews`,
          token,
        ),
        githubApi<{
          check_runs: { status: string; conclusion: string | null }[];
          total_count: number;
        }>(
          ctx,
          `/repos/${repository}/commits/${encodeURIComponent(pr.head.sha)}/check-runs?per_page=100`,
          token,
        ),
      ]);
      const latest = new Map<string, string>();
      for (const r of reviews.sort((a, b) => a.submitted_at.localeCompare(b.submitted_at)))
        if (r.user && ['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(r.state))
          latest.set(r.user.login, r.state);
      review = [...latest.values()].includes('CHANGES_REQUESTED')
        ? 'Changes requested'
        : [...latest.values()].includes('APPROVED')
          ? 'Approved'
          : pr.requested_reviewers?.length
            ? 'Review requested'
            : null;
      const runs = result.check_runs ?? [];
      checks = runs.some((r) =>
        ['failure', 'timed_out', 'cancelled', 'action_required', 'startup_failure'].includes(
          r.conclusion ?? '',
        ),
      )
        ? 'Checks failing'
        : runs.some((r) => r.status !== 'completed') || result.total_count > runs.length
          ? 'Checks pending'
          : runs.length
            ? 'Checks passed'
            : null;
    }
    const state = pr.merged_at
      ? 'merged'
      : pr.state === 'closed'
        ? 'closed'
        : pr.draft
          ? 'draft'
          : 'open';
    const event: GitHubEvent =
      state === 'merged' || state === 'closed' || state === 'draft'
        ? state
        : review === 'Approved'
          ? 'approved'
          : review === 'Review requested'
            ? 'review_requested'
            : 'opened';
    return {
      key: `pull:${pr.number}`,
      kind: 'pull_request',
      number: pr.number,
      sha: pr.head.sha,
      title: pr.title,
      branch: pr.head.ref,
      baseBranch: pr.base.ref,
      state,
      author: pr.user?.login ?? 'GitHub',
      updatedAt: pr.updated_at,
      refs: githubReferences(pr.title, pr.head.ref, pr.body ?? ''),
      review,
      checks,
      event,
    };
  }
  async function apply(
    repo: Repository,
    snapshots: Snapshot[],
    connection: GitConnection,
    manual?: { itemId: string; closing: boolean },
  ) {
    await ctx.db.transaction(async (db) => {
      const store = makeStore(db);
      await db.query(
        "SELECT id FROM entities WHERE collection='system' AND id='mutation-lock' FOR UPDATE",
      );
      const current = await store.get<Repository>('githubRepositories', repo.id);
      const credential = await store.get<GitConnection>('gitConnections', connection.id);
      const owner = await workspaceUser(store, repo.creatorId, repo.workspaceId);
      if (
        !current ||
        !current.enabled ||
        current.connectionId !== connection.id ||
        !credential ||
        credential.githubInstallation?.encryptedPrivateKey !==
          connection.githubInstallation?.encryptedPrivateKey
      )
        ctx.fail(409, 'The repository connection changed during synchronization.');
      if (
        !owner ||
        owner.disabledAt ||
        owner.role !== 'admin' ||
        !(await ctx.canProject(owner, repo.projectId, store))
      )
        ctx.fail(403, 'The connection owner no longer has access to this project.');
      const items = (await store.list<WorkItem>('items')).filter(
        (i) => i.projectId === repo.projectId && workspaceOf(i) === repo.workspaceId,
      );
      const prior = new Map(
        (await store.list<DevelopmentLink>('githubLinks')).map((link) => [link.id, link]),
      );
      const changes = new Map<string, { event: GitHubEvent; at: string }>();
      for (const snap of snapshots) {
        if (!branchMatches(current.branches, snap.baseBranch)) continue;
        for (const item of items) {
          const linkId = hash(`${repo.id}:${snap.key}:${item.id}`);
          const existing = prior.get(linkId);
          const manuallyLinked = manual?.itemId === item.id;
          if (manuallyLinked) await store.remove('githubLinkExclusions', linkId);
          else if (await store.get('githubLinkExclusions', linkId)) continue;
          const closing = manuallyLinked
            ? manual.closing
            : snap.refs.get(item.identifier.toUpperCase());
          if (closing === undefined && !existing?.manual) {
            if (existing && Date.parse(snap.updatedAt) >= Date.parse(existing.updatedAt))
              await store.remove('githubLinks', existing.id);
            continue;
          }
          if (!(await ctx.canItem(owner, item.id, store))) continue;
          if (existing && Date.parse(snap.updatedAt) < Date.parse(existing.updatedAt)) continue;
          const link: DevelopmentLink = {
            id: linkId,
            itemId: item.id,
            repositoryId: repo.id,
            kind: snap.kind,
            number: snap.number,
            sha: snap.sha,
            title: snap.title,
            branch: snap.branch,
            baseBranch: snap.baseBranch,
            state: snap.state,
            author: snap.author,
            closing: manuallyLinked
              ? manual.closing
              : existing?.manual
                ? existing.closing
                : !!closing,
            manual: manuallyLinked || !!existing?.manual,
            review: snap.review,
            checks: snap.checks,
            updatedAt: snap.updatedAt,
            syncedAt: ctx.now(),
            url: `https://github.com/${repo.repository}/${snap.kind === 'pull_request' ? `pull/${snap.number}` : snap.kind === 'commit' ? `commit/${snap.sha}` : `tree/${encodeURIComponent(snap.branch)}`}`,
          };
          await store.put('githubLinks', link);
          if (!existing)
            await store.put<Activity>('activity', {
              id: ctx.id(),
              itemId: item.id,
              userId: owner.id,
              kind: 'event',
              body: `Linked GitHub ${snap.kind.replace('_', ' ')} ${snap.kind === 'pull_request' ? `#${snap.number}` : snap.title}`,
              createdAt: ctx.now(),
              source: { provider: 'github', author: snap.author },
            });
          if (
            snap.event &&
            link.closing &&
            (!existing || existing.state !== link.state || existing.review !== link.review)
          ) {
            const last = changes.get(item.id);
            if (!last || Date.parse(snap.updatedAt) >= Date.parse(last.at))
              changes.set(item.id, { event: snap.event, at: snap.updatedAt });
          }
        }
      }
      const allLinks = await store.list<DevelopmentLink>('githubLinks');
      const repositories = new Map(
        (await store.list<Repository>('githubRepositories')).map((r) => [r.id, r]),
      );
      const connections = new Set(
        (await store.list<GitConnection>('gitConnections')).map((c) => c.id),
      );
      for (const [itemId, change] of changes) {
        const item = await store.get<WorkItem>('items', itemId);
        const target = current.rules[change.event];
        if (
          !item ||
          !target ||
          target === item.status ||
          item.status === 'canceled' ||
          (item.status === 'done' && change.event !== 'merged')
        )
          continue;
        if (
          target === 'done' &&
          allLinks.some((l) => {
            const linkedRepo = repositories.get(l.repositoryId);
            return (
              l.itemId === item.id &&
              l.kind === 'pull_request' &&
              l.closing &&
              ['open', 'draft'].includes(l.state) &&
              linkedRepo?.enabled &&
              linkedRepo.projectId === item.projectId &&
              connections.has(linkedRepo.connectionId) &&
              branchMatches(linkedRepo.branches, l.baseBranch)
            );
          })
        )
          continue;
        await store.put('items', {
          ...item,
          status: target,
          updatedAt: ctx.now(),
          completedAt: target === 'done' ? ctx.now() : null,
        });
        await store.put<Activity>('activity', {
          id: ctx.id(),
          itemId,
          userId: owner.id,
          kind: 'event',
          body: `GitHub automation: ${item.status.replaceAll('_', ' ')} → ${target.replaceAll('_', ' ')} (${change.event.replaceAll('_', ' ')})`,
          createdAt: ctx.now(),
        });
      }
      await store.put('githubRepositories', {
        ...current,
        lastSyncedAt: ctx.now(),
        lastError: null,
      });
    });
  }
  async function sync(repo: Repository) {
    if (busy.has(repo.id)) ctx.fail(409, 'This repository is already synchronizing.');
    busy.add(repo.id);
    try {
      const owner = await workspaceUser(ctx.store, repo.creatorId, repo.workspaceId);
      if (
        !owner ||
        owner.disabledAt ||
        owner.role !== 'admin' ||
        !(await ctx.canProject(owner, repo.projectId))
      )
        ctx.fail(403, 'The connection owner no longer has access to this project.');
      const connection = await connectionFor(repo.creatorId, repo.connectionId);
      const { token } = await resolveGitCredential(ctx, connection);
      const pulls = await pages<PullRequest>(
        `/repos/${repo.repository}/pulls?state=all&sort=updated&direction=desc`,
        token,
      );
      const snapshots: Snapshot[] = [];
      const items = (await ctx.store.list<WorkItem>('items')).filter(
        (i) => i.projectId === repo.projectId,
      );
      const identifiers = new Set(items.map((i) => i.identifier.toUpperCase()));
      const linked = (await ctx.store.list<DevelopmentLink>('githubLinks')).filter(
        (l) => l.repositoryId === repo.id,
      );
      for (const pr of pulls) {
        const refs = githubReferences(pr.title, pr.head.ref, pr.body ?? '');
        if (
          ![...refs.keys()].some((k) => identifiers.has(k)) &&
          !linked.some((l) => l.number === pr.number)
        )
          continue;
        if (!branchMatches(repo.branches, pr.base.ref)) continue;
        snapshots.push(await pullSnapshot(pr, repo.repository, token));
      }
      const since = repo.lastSyncedAt
        ? new Date(Date.parse(repo.lastSyncedAt) - 300_000).toISOString()
        : new Date(Date.now() - 30 * 86400_000).toISOString();
      const commits = await pages<{
        sha: string;
        commit: { message: string; committer: { date: string } };
        author: { login: string } | null;
      }>(
        `/repos/${repo.repository}/commits?sha=${encodeURIComponent(repo.defaultBranch)}&since=${encodeURIComponent(since)}`,
        token,
      );
      for (const c of commits)
        snapshots.push({
          key: `commit:${c.sha}`,
          kind: 'commit',
          number: null,
          sha: c.sha,
          title: c.commit.message.split('\n')[0].slice(0, 500),
          branch: repo.defaultBranch,
          baseBranch: repo.defaultBranch,
          state: 'committed',
          author: c.author?.login ?? 'GitHub',
          updatedAt: c.commit.committer.date,
          refs: githubReferences('', '', c.commit.message),
          review: null,
          checks: null,
          event: null,
        });
      const branches = await pages<{ name: string; commit: { sha: string } }>(
        `/repos/${repo.repository}/branches`,
        token,
      );
      const branchNames = new Set(branches.map((b) => b.name));
      for (const branch of branches)
        snapshots.push({
          key: `branch:${branch.name}`,
          kind: 'branch',
          number: null,
          sha: branch.commit.sha,
          title: branch.name,
          branch: branch.name,
          baseBranch: repo.defaultBranch,
          state: 'active',
          author: 'GitHub',
          updatedAt: ctx.now(),
          refs: githubReferences('', branch.name, ''),
          review: null,
          checks: null,
          event: null,
        });
      for (const old of linked.filter((l) => l.kind === 'branch' && !branchNames.has(l.branch)))
        snapshots.push({
          key: `branch:${old.branch}`,
          kind: 'branch',
          number: null,
          sha: old.sha,
          title: old.title,
          branch: old.branch,
          baseBranch: old.baseBranch,
          state: 'deleted',
          author: old.author,
          updatedAt: ctx.now(),
          refs: githubReferences('', old.branch, ''),
          review: null,
          checks: null,
          event: null,
        });
      await apply(repo, snapshots, connection);
      await syncIssues(repo.connectionId, repo.repository);
    } catch (error) {
      const current = await ctx.store.get<Repository>('githubRepositories', repo.id);
      if (current)
        await ctx.store.put('githubRepositories', {
          ...current,
          lastError:
            (error as { expose?: boolean }).expose ||
            (error as { statusCode?: number }).statusCode === 403
              ? (error as Error).message
              : 'Synchronization failed. Check repository access and retry.',
        });
      throw error;
    } finally {
      busy.delete(repo.id);
    }
  }
  app.get<{ Params: { id: string } }>(`${root}/connections/:id/repositories`, async (request) => {
    const user = admin(request);
    return githubRepositories(ctx, await connectionFor(user.id, request.params.id));
  });
  app.get(root + '/repositories', async (request) => {
    const user = ctx.requireUser(request);
    const result: GitHubRepository[] = [];
    for (const repo of await ctx.store.list<Repository>('githubRepositories'))
      if (repo.workspaceId === workspaceOf(user) && (await ctx.canProject(user, repo.projectId))) {
        const { creatorId: _creator, workspaceId: _workspace, ...data } = repo;
        result.push(data);
      }
    return result;
  });
  app.post(root + '/repositories', async (request, reply) => {
    const user = admin(request);
    const input = z
      .object({
        connectionId: z.string().max(200),
        repository: repoName,
        projectId: z.string().uuid(),
      })
      .strict()
      .parse(request.body);
    if (!(await ctx.canProject(user, input.projectId))) ctx.fail(404, 'Project not found.');
    const connection = await connectionFor(user.id, input.connectionId);
    const remote = (await githubRepositories(ctx, connection)).find(
      (r) => r.repository.toLowerCase() === input.repository.toLowerCase(),
    );
    if (!remote) ctx.fail(400, 'This repository is not available to the GitHub App.');
    const repo: Repository = {
      id: hash(`${connection.id}:${remote.repository.toLowerCase()}:${input.projectId}`),
      connectionId: connection.id,
      repository: remote.repository,
      projectId: input.projectId,
      defaultBranch: remote.defaultBranch,
      branches: '*',
      rules: defaultGitHubRules,
      enabled: true,
      lastSyncedAt: null,
      lastError: null,
      creatorId: user.id,
      workspaceId: workspaceOf(user),
      createdAt: ctx.now(),
    };
    await ctx.db.transaction(async (db) => {
      await db.query(
        "SELECT id FROM entities WHERE collection='system' AND id='mutation-lock' FOR UPDATE",
      );
      const store = makeStore(db);
      if (
        !(await ctx.canProject(user, input.projectId, store)) ||
        !(await store.get('gitConnections', connection.id))
      )
        ctx.fail(409, 'The project or Git connection changed.');
      if (
        (await store.list<Repository>('githubRepositories')).some(
          (r) =>
            r.workspaceId === repo.workspaceId &&
            r.repository.toLowerCase() === repo.repository.toLowerCase() &&
            r.projectId === repo.projectId,
        )
      )
        ctx.fail(409, 'This repository is already connected to this project.');
      await store.put('githubRepositories', repo);
    });
    return reply.code(201).send(repo);
  });
  app.patch<{ Params: { id: string } }>(root + '/repositories/:id', async (request) => {
    admin(request);
    const repo = await authorized(request, request.params.id);
    const input = configSchema.parse(request.body);
    if (!input.branches.split(',').some((b) => b.trim()))
      ctx.fail(400, 'Enter at least one target branch, or * for all branches.');
    return ctx.db.transaction(async (db) => {
      await db.query(
        "SELECT id FROM entities WHERE collection='system' AND id='mutation-lock' FOR UPDATE",
      );
      const store = makeStore(db);
      const current = await store.get<Repository>('githubRepositories', repo.id);
      if (!current) ctx.fail(404, 'Repository connection not found.');
      return store.put('githubRepositories', { ...current, ...input });
    });
  });
  app.post<{ Params: { id: string } }>(root + '/repositories/:id/sync', async (request) => {
    admin(request);
    const repo = await authorized(request, request.params.id);
    if (!repo.enabled) ctx.fail(400, 'Resume this connection before synchronizing.');
    await sync(repo);
    return ctx.store.get('githubRepositories', repo.id);
  });
  app.delete<{ Params: { id: string } }>(root + '/repositories/:id', async (request, reply) => {
    admin(request);
    const repo = await authorized(request, request.params.id);
    await ctx.db.transaction(async (db) => {
      await db.query(
        "SELECT id FROM entities WHERE collection='system' AND id='mutation-lock' FOR UPDATE",
      );
      const store = makeStore(db);
      await store.remove('githubRepositories', repo.id);
      await store.remove('githubJobs', repo.id);
    });
    return reply.code(204).send();
  });
  app.get<{ Params: { id: string } }>(root + '/items/:id', async (request) => {
    const user = ctx.requireUser(request);
    if (!(await ctx.canItem(user, request.params.id))) ctx.fail(404, 'Work item not found.');
    const item = (await ctx.store.get<WorkItem>('items', request.params.id))!;
    const repos = (await ctx.store.list<Repository>('githubRepositories')).filter(
      (r) => r.projectId === item.projectId && r.workspaceId === workspaceOf(user),
    );
    const repoIds = new Set(repos.map((r) => r.id));
    return {
      branchName: githubBranchName(item),
      repositories: repos.map((r) => ({ id: r.id, repository: r.repository })),
      links: (await ctx.store.list<DevelopmentLink>('githubLinks'))
        .filter((l) => l.itemId === item.id && repoIds.has(l.repositoryId))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    };
  });
  app.delete<{ Params: { id: string; linkId: string } }>(
    root + '/items/:id/links/:linkId',
    async (request, reply) => {
      const user = ctx.requireUser(request);
      if (request.tokenScope) ctx.fail(403, 'Manage development links from a browser session.');
      await ctx.db.transaction(async (db) => {
        const store = makeStore(db);
        await db.query(
          "SELECT id FROM entities WHERE collection='system' AND id='mutation-lock' FOR UPDATE",
        );
        if (!(await ctx.canItem(user, request.params.id, store)))
          ctx.fail(404, 'Work item not found.');
        const link = await store.get<DevelopmentLink>('githubLinks', request.params.linkId);
        if (!link || link.itemId !== request.params.id)
          ctx.fail(404, 'Development link not found.');
        await store.remove('githubLinks', link.id);
        await store.put('githubLinkExclusions', {
          id: link.id,
          itemId: link.itemId,
          createdAt: ctx.now(),
        });
        await store.put<Activity>('activity', {
          id: ctx.id(),
          itemId: link.itemId,
          userId: user.id,
          kind: 'event',
          body: `Unlinked GitHub ${link.kind.replace('_', ' ')} ${link.title}`,
          createdAt: ctx.now(),
        });
      });
      return reply.code(204).send();
    },
  );
  app.post<{ Params: { id: string } }>(root + '/items/:id/pull-request', async (request) => {
    const user = ctx.requireUser(request);
    if (request.tokenScope) ctx.fail(403, 'Link pull requests from a browser session.');
    if (!(await ctx.canItem(user, request.params.id))) ctx.fail(404, 'Work item not found.');
    const input = z
      .object({
        repositoryId: z.string().max(200),
        number: z.number().int().positive().max(2147483647),
        closing: z.boolean(),
      })
      .strict()
      .parse(request.body);
    const repo = await authorized(request, input.repositoryId);
    const item = (await ctx.store.get<WorkItem>('items', request.params.id))!;
    if (item.projectId !== repo.projectId)
      ctx.fail(400, 'Choose a repository connected to this project.');
    const connection = await connectionFor(user.id, repo.connectionId);
    const { token } = await resolveGitCredential(ctx, connection);
    const pr = await githubApi<PullRequest>(
      ctx,
      `/repos/${repo.repository}/pulls/${input.number}`,
      token,
    );
    const snapshot = await pullSnapshot(pr, repo.repository, token);
    if (!repo.enabled || !branchMatches(repo.branches, snapshot.baseBranch))
      ctx.fail(
        400,
        'This PR targets a branch excluded by the repository workflow, or synchronization is paused.',
      );
    const owner = await workspaceUser(ctx.store, repo.creatorId, repo.workspaceId);
    if (!owner || !(await ctx.canItem(owner, item.id)))
      ctx.fail(
        403,
        'The repository connection owner needs access to this task before it can be linked.',
      );
    await apply(repo, [snapshot], connection, { itemId: item.id, closing: input.closing });
    return { linked: true };
  });
  // Keep raw bytes in a route-scoped parser; browser/API authentication remains unchanged.
  app.register(async (hooks) => {
    hooks.removeContentTypeParser('application/json');
    hooks.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_request, body, done) =>
      done(null, body),
    );
    hooks.post<{ Params: { id: string } }>(
      '/hooks/github/:id',
      { config: { rateLimit: { max: 600, timeWindow: '1 minute' } } },
      async (request, reply) => {
        const saved = await ctx.store.get<ManagedGitHubApp>('githubManagedApps', request.params.id);
        if (!saved || saved.mode !== 'webhook') ctx.fail(404, 'Webhook not found.');
        const signature = request.headers['x-hub-signature-256'];
        const delivery = request.headers['x-github-delivery'];
        const event = request.headers['x-github-event'];
        if (
          !Buffer.isBuffer(request.body) ||
          typeof signature !== 'string' ||
          !/^sha256=[a-f0-9]{64}$/.test(signature) ||
          typeof delivery !== 'string' ||
          !/^[\w-]{1,100}$/.test(delivery) ||
          typeof event !== 'string'
        )
          ctx.fail(401, 'Invalid GitHub webhook.');
        const key = decryptToken(
          saved.encryptedWebhookSecret,
          process.env.APP_SECRET ?? '',
          `${saved.id}:webhook`,
        );
        const expected = createHmac('sha256', key).update(request.body).digest();
        if (!timingSafeEqual(expected, Buffer.from(signature.slice(7), 'hex')))
          ctx.fail(401, 'Invalid GitHub webhook signature.');
        let payload: { installation?: { id: number }; repository?: { full_name: string } };
        try {
          payload = z
            .object({
              installation: z.object({ id: z.number().int().positive() }).optional(),
              repository: z.object({ full_name: repoName }).optional(),
            })
            .parse(JSON.parse(request.body.toString()));
        } catch {
          ctx.fail(400, 'Invalid JSON.');
        }
        await ctx.db.transaction(async (db) => {
          const store = makeStore(db);
          await db.query(
            "SELECT id FROM entities WHERE collection='system' AND id='mutation-lock' FOR UPDATE",
          );
          const id = hash(`${saved.id}:${delivery}`);
          if (await store.get('githubDeliveries', id)) return;
          await store.put('githubDeliveries', { id, createdAt: ctx.now() });
          const current = await store.get<ManagedGitHubApp>('githubManagedApps', saved.id);
          if (!current) return;
          await store.put('githubManagedApps', { ...current, lastWebhookAt: ctx.now() });
          if (
            ![
              'pull_request',
              'pull_request_review',
              'push',
              'create',
              'delete',
              'issues',
              'issue_comment',
              'check_run',
              'check_suite',
              'installation',
              'installation_repositories',
            ].includes(event)
          )
            return;
          const connections = (await store.list<GitConnection>('gitConnections')).filter(
            (c) =>
              c.githubInstallation?.managedAppId === saved.id &&
              c.githubInstallation.installationId === String(payload.installation?.id),
          );
          const ids = new Set(connections.map((c) => c.id));
          for (const imported of await store.list<{
            id: string;
            connectionId?: string;
            repository: string;
          }>('integrations')) {
            if (
              imported.connectionId &&
              ids.has(imported.connectionId) &&
              (!payload.repository ||
                imported.repository.toLowerCase() === payload.repository.full_name.toLowerCase())
            )
              await store.put('githubIssueJobs', {
                id: imported.id,
                connectionId: imported.connectionId,
                repository: imported.repository,
                queuedAt: ctx.now(),
                nextAt: ctx.now(),
                attempts: 0,
              });
          }
          for (const repo of await store.list<Repository>('githubRepositories')) {
            if (
              !ids.has(repo.connectionId) ||
              !repo.enabled ||
              (payload.repository &&
                repo.repository.toLowerCase() !== payload.repository.full_name.toLowerCase())
            )
              continue;
            await store.put('githubJobs', {
              id: repo.id,
              queuedAt: ctx.now(),
              attempts: 0,
              nextAt: ctx.now(),
            });
          }
        });
        return reply.code(202).send({ accepted: true });
      },
    );
  });
  async function processJobs() {
    const interval = Math.max(60_000, Number(process.env.GITHUB_SYNC_INTERVAL_MS) || 300_000);
    for (const repo of await ctx.store.list<Repository>('githubRepositories')) {
      if (stopping) return;
      if (!repo.enabled || busy.has(repo.id)) continue;
      const job = await ctx.store.get<{
        id: string;
        queuedAt: string;
        attempts: number;
        nextAt: string;
      }>('githubJobs', repo.id);
      if (
        job
          ? Date.parse(job.nextAt) > Date.parse(ctx.now())
          : repo.lastSyncedAt && Date.parse(ctx.now()) - Date.parse(repo.lastSyncedAt) < interval
      )
        continue;
      try {
        await sync(repo);
        if (job)
          await ctx.db.query(
            "DELETE FROM entities WHERE collection='githubJobs' AND id=$1 AND data->>'queuedAt'=$2",
            [repo.id, job.queuedAt],
          );
      } catch {
        const attempts = (job?.attempts ?? 0) + 1;
        const nextAt = new Date(
          Date.parse(ctx.now()) + Math.min(3600_000, 30_000 * 2 ** Math.min(attempts, 7)),
        ).toISOString();
        // Preserve a newer event that arrived while this attempt was in flight.
        const current = await ctx.store.get<typeof job>('githubJobs', repo.id);
        if (!current || current.queuedAt === job?.queuedAt)
          await ctx.store.put('githubJobs', {
            id: repo.id,
            queuedAt: job?.queuedAt ?? ctx.now(),
            attempts,
            nextAt,
          });
      }
    }
    for (const job of await ctx.store.list<{
      id: string;
      connectionId: string;
      repository: string;
      queuedAt: string;
      nextAt: string;
      attempts: number;
    }>('githubIssueJobs')) {
      if (stopping) return;
      if (Date.parse(job.nextAt) > Date.parse(ctx.now())) continue;
      try {
        await syncIssues(job.connectionId, job.repository);
        await ctx.db.query(
          "DELETE FROM entities WHERE collection='githubIssueJobs' AND id=$1 AND data->>'queuedAt'=$2",
          [job.id, job.queuedAt],
        );
      } catch {
        const current = await ctx.store.get<typeof job>('githubIssueJobs', job.id);
        if (current?.queuedAt === job.queuedAt)
          await ctx.store.put('githubIssueJobs', {
            ...job,
            attempts: job.attempts + 1,
            nextAt: new Date(
              Date.parse(ctx.now()) +
                Math.min(3600_000, 30_000 * 2 ** Math.min(job.attempts + 1, 7)),
            ).toISOString(),
          });
      }
    }
    await ctx.db.query(
      "DELETE FROM entities WHERE collection='githubDeliveries' AND data->>'createdAt'<$1",
      [new Date(Date.parse(ctx.now()) - 7 * 86400_000).toISOString()],
    );
  }
  const timer = setInterval(() => {
    if (!running && !stopping)
      running = processJobs()
        .catch(() => {})
        .finally(() => {
          running = null;
        });
  }, 5_000);
  timer.unref();
  app.addHook('preClose', async () => {
    stopping = true;
    clearInterval(timer);
    await running;
  });
}
