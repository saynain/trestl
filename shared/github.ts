import type { Status } from './types.ts';

export type GitHubEvent =
  'draft' | 'opened' | 'review_requested' | 'approved' | 'merged' | 'closed';
export type GitHubRules = Record<GitHubEvent, Status | null>;
export const defaultGitHubRules: GitHubRules = {
  draft: 'in_progress',
  opened: 'in_review',
  review_requested: 'in_review',
  approved: null,
  merged: 'done',
  closed: null,
};
export const githubEventLabels: Record<GitHubEvent, string> = {
  draft: 'Draft pull request',
  opened: 'Ready for review',
  review_requested: 'Review requested',
  approved: 'Review approved',
  merged: 'Pull request merged',
  closed: 'Closed without merging',
};
export interface GitHubRepository {
  id: string;
  connectionId: string;
  projectId: string;
  repository: string;
  defaultBranch: string;
  branches: string;
  rules: GitHubRules;
  enabled: boolean;
  lastSyncedAt: string | null;
  lastError: string | null;
  createdAt: string;
}
export interface DevelopmentLink {
  id: string;
  itemId: string;
  repositoryId: string;
  kind: 'pull_request' | 'commit' | 'branch';
  number: number | null;
  sha: string;
  title: string;
  url: string;
  branch: string;
  baseBranch: string;
  state: 'open' | 'draft' | 'merged' | 'closed' | 'committed' | 'active' | 'deleted';
  closing: boolean;
  manual: boolean;
  author: string;
  review: string | null;
  checks: string | null;
  updatedAt: string;
  syncedAt: string;
}
