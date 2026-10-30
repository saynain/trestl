import type { FastifyInstance } from 'fastify';
import type { Activity, Project, WorkItem } from '../shared/types.ts';
import { mirrors } from '../shared/repository-sync.ts';
import type { AppContext } from './context.ts';
import { makeStore, type Database } from './db.ts';
import { gitOrigins, resolveGitCredential, type GitConnection } from './git-connections.ts';
import type { SyncResult } from './integrations.ts';
import { modeOf, remoteKey, type RepositoryAttachment } from './repository-attachments.ts';
import { authorizeOutbound, OutboundRejected, type OutboundKind } from './repository-policy.ts';
import {
  claimOutbox,
  enqueueInbox,
  finishInbox,
  inboxAttachments,
  insertOutbox,
  marker,
  pendingInbox,
  recordFieldState,
  settleOutbox,
  type OutboxOperation,
} from './sync-journal.ts';
import { workspaceOf } from './workspaces.ts';

/** What a publisher needs for one operation. The marker must be embedded in created content. */
export interface OutboundContext {
  operation: OutboxOperation;
  attachment: RepositoryAttachment;
  item: WorkItem;
  activity: Activity | null;
  marker: string;
  token: string;
  options: { allowedOrigins: string[]; fetch?: typeof fetch };
}
/**
 * A provider write. Replies (#81) and field sync (#84) register these; this version
 * registers none, so nothing is published.
 */
export interface OutboundHandler {
  perform(context: OutboundContext): Promise<{ remoteId: string | null }>;
  /** After an uncertain attempt, look the operation up by its marker instead of re-posting. */
  reconcile(context: OutboundContext): Promise<{ remoteId: string | null } | null>;
}
/** `sent: false` means the provider certainly did not apply the operation. */
export class OutboundFailure extends Error {
  constructor(
    message: string,
    readonly sent: boolean | 'unknown' = 'unknown',
    readonly retryable = true,
  ) {
    super(message);
  }
}
const maxAttempts = 8;
const backoff = (attempts: number) => Math.min(3600, 30 * 2 ** Math.max(0, attempts - 1));
/** The local field an operation publishes, for the last-common journal. */
const publishedField: Partial<Record<OutboundKind, string>> = {
  'issue.state': 'state',
  'issue.assignee': 'assignee',
};

export function createRepositorySync(
  app: FastifyInstance,
  ctx: AppContext,
  engine: {
    sync(attachment: RepositoryAttachment, options?: { numbers?: number[] }): Promise<SyncResult>;
    syncing(id: string): boolean;
  },
) {
  const handlers = new Map<OutboundKind, OutboundHandler>();
  // Inbox and outbox work runs one batch at a time within this process.
  let chain: Promise<unknown> = Promise.resolve();
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const run = chain.then(work, work);
    chain = run.catch(() => undefined);
    return run;
  };

  async function processInbox() {
    for (const attachmentId of await inboxAttachments(ctx.db, ctx.now())) {
      if (engine.syncing(attachmentId)) continue;
      const events = await pendingInbox(ctx.db, attachmentId, ctx.now());
      const ids = events.map((event) => event.id);
      const attachment = await ctx.store.get<RepositoryAttachment>('integrations', attachmentId);
      // Events for detached or reference repositories have nothing left to import.
      if (!attachment || !mirrors(modeOf(attachment))) {
        await finishInbox(ctx.db, ids, ctx.now());
        continue;
      }
      // Payloads are only hints: re-read the named issues, or everything if unsure.
      const numbers = events.every((event) => event.issueNumber)
        ? events.map((event) => event.issueNumber!)
        : undefined;
      try {
        await engine.sync(attachment, numbers ? { numbers } : {});
        await finishInbox(ctx.db, ids, ctx.now());
      } catch (error) {
        if ((error as { statusCode?: number }).statusCode === 409 && engine.syncing(attachmentId))
          continue;
        await finishInbox(
          ctx.db,
          ids,
          ctx.now(),
          error instanceof Error ? error.message : 'Repository synchronization failed.',
        );
      }
    }
  }

  async function context(operation: OutboxOperation): Promise<OutboundContext> {
    // Consent, capability and permission are checked again when the operation is sent.
    const allowed = await authorizeOutbound(ctx, ctx.store, {
      attachmentId: operation.attachmentId,
      itemId: operation.itemId,
      kind: operation.kind,
      actorId: operation.actorId,
      activityId:
        typeof operation.payload.activityId === 'string' ? operation.payload.activityId : undefined,
    });
    let resolved: { connection: GitConnection; token: string };
    try {
      resolved = await resolveGitCredential(ctx, allowed.connection);
    } catch {
      throw new OutboundFailure('Repository credentials could not be resolved.', false);
    }
    return {
      operation,
      attachment: allowed.attachment,
      item: allowed.item,
      activity: allowed.activity,
      marker: marker(operation.id),
      token: resolved.token,
      options: {
        allowedOrigins: gitOrigins(resolved.connection),
        ...(resolved.connection.githubApp || resolved.connection.githubInstallation
          ? { fetch: ctx.githubFetch }
          : {}),
      },
    };
  }

  async function complete(operation: OutboxOperation, remoteId: string | null) {
    await ctx.db.transaction(async (db) => {
      await settleOutbox(db, operation.id, ctx.now(), { status: 'done', remoteId });
      const store = makeStore(db);
      const attachment = await store.get<RepositoryAttachment>(
        'integrations',
        operation.attachmentId,
      );
      const project = attachment && (await store.get<Project>('projects', attachment.projectId));
      // Link the created comment so the inbound echo is recognized, never imported twice.
      if (
        operation.kind === 'comment.create' &&
        remoteId &&
        attachment &&
        project &&
        typeof operation.payload.activityId === 'string'
      )
        await store.put('importedComments', {
          id: remoteKey(workspaceOf(project), attachment, 'comment', remoteId),
          itemId: operation.itemId,
          activityId: operation.payload.activityId,
          local: true,
        });
      const field = publishedField[operation.kind];
      if (field)
        await recordFieldState(db, {
          itemId: operation.itemId,
          attachmentId: operation.attachmentId,
          fields: { [field]: operation.payload.value },
          operationId: operation.id,
          now: ctx.now(),
        });
    });
  }

  async function fail(operation: OutboxOperation, error: unknown) {
    const message = error instanceof Error ? error.message : 'Publishing failed.';
    if (error instanceof OutboundRejected)
      return settleOutbox(ctx.db, operation.id, ctx.now(), { status: 'rejected', error: message });
    const certain = error instanceof OutboundFailure && error.sent === false;
    if (operation.attempts >= maxAttempts || (error instanceof OutboundFailure && !error.retryable))
      return settleOutbox(ctx.db, operation.id, ctx.now(), {
        status: certain ? 'failed' : 'uncertain',
        error: message,
        retryInSeconds: certain ? 0 : 3600,
      });
    await settleOutbox(ctx.db, operation.id, ctx.now(), {
      // An unknown outcome is reconciled by marker before any retry.
      status: certain ? 'pending' : 'uncertain',
      error: message,
      retryInSeconds: certain ? backoff(operation.attempts) : 0,
    });
  }

  async function dispatchOutbox(limit = 50) {
    for (let sent = 0; sent < limit; sent++) {
      const uncertain = await claimOutbox(ctx.db, ctx.now(), true);
      const operation = uncertain ?? (await claimOutbox(ctx.db, ctx.now()));
      if (!operation) return;
      const handler = handlers.get(operation.kind);
      if (!handler) {
        await settleOutbox(ctx.db, operation.id, ctx.now(), {
          status: uncertain ? 'uncertain' : 'pending',
          error: 'This server cannot publish this kind of change.',
          retryInSeconds: 3600,
        });
        continue;
      }
      try {
        const current = await context(operation);
        if (uncertain) {
          const found = await handler.reconcile(current);
          if (found) await complete(operation, found.remoteId);
          // Confirmed absent: sending it again cannot create a duplicate.
          else
            await settleOutbox(ctx.db, operation.id, ctx.now(), {
              status: 'pending',
              error: 'Not found at the provider after an uncertain attempt; retrying.',
            });
        } else await complete(operation, (await handler.perform(current)).remoteId);
      } catch (error) {
        await fail(operation, error);
      }
    }
  }

  const sweep = () =>
    serial(async () => {
      await processInbox();
      await dispatchOutbox();
    });
  const timer = setInterval(() => {
    sweep().catch(() => app.log.warn('Repository sync journal sweep failed.'));
  }, 30_000);
  timer.unref();
  app.addHook('onClose', async () => clearInterval(timer));

  return {
    registerHandler(kind: OutboundKind, handler: OutboundHandler) {
      handlers.set(kind, handler);
    },
    /** For webhooks (#77): durable before acknowledging; duplicates are ignored. */
    enqueueInbox(event: {
      attachmentId: string;
      deliveryId: string;
      event: string;
      issueNumber?: number | null;
    }) {
      return enqueueInbox(ctx.db, { ...event, id: ctx.id(), now: ctx.now() });
    },
    /**
     * Records an outbound operation in the caller's transaction, after the publication
     * rules allow it. Call `kick()` once that transaction commits.
     */
    async enqueueOutbound(
      db: Database,
      request: {
        attachmentId: string;
        itemId: string;
        kind: OutboundKind;
        actorId: string;
        tokenScope?: string | null;
        activityId?: string;
        payload?: Record<string, unknown>;
      },
    ) {
      await authorizeOutbound(ctx, makeStore(db), request);
      if (!handlers.has(request.kind))
        throw new OutboundRejected('capability', 'This server cannot publish this kind of change.');
      const id = ctx.id();
      await insertOutbox(db, {
        id,
        attachmentId: request.attachmentId,
        itemId: request.itemId,
        kind: request.kind,
        actorId: request.actorId,
        payload: {
          ...request.payload,
          ...(request.activityId ? { activityId: request.activityId } : {}),
        },
        now: ctx.now(),
      });
      return id;
    },
    processInbox: () => serial(processInbox),
    dispatchOutbox: () => serial(() => dispatchOutbox()),
    kick: () => void sweep().catch(() => undefined),
  };
}
export type RepositorySync = ReturnType<typeof createRepositorySync>;
