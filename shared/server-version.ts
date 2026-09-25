export interface ServerBuild {
  version: string;
  commit: string | null;
  buildId: string | null;
  builtAt: string | null;
  release: boolean;
}
export interface ServerVersion {
  running: ServerBuild;
  latest: { version: string; url: string; publishedAt: string | null } | null;
  status: 'up-to-date' | 'update-available' | 'unreleased' | 'unknown';
  checkedAt: string;
  message: string | null;
}
