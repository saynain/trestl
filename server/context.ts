import type { FastifyRequest } from 'fastify';
import type { User } from '../shared/types.ts';
import type { Database, Store } from './db.ts';
export interface AppContext {
  /** Explicit dependency injection for GitHub provider tests; production uses fetch. */
  githubFetch?: typeof fetch;
  db: Database;
  store: Store;
  requireUser(request: FastifyRequest): User;
  canProject(user: User, projectId: string, source?: Store): Promise<boolean>;
  canItem(user: User, itemId: string, source?: Store): Promise<boolean>;
  fail(status: number, message: string): never;
  id(): string;
  now(): string;
}
declare module 'fastify' {
  interface FastifyRequest {
    user: User | null;
    tokenScope: string | null;
  }
}
