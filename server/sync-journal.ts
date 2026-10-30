import { createHash } from 'node:crypto';
import type { Database } from './db.ts';
import type { OutboundKind } from './repository-policy.ts';

/**
 * Durable repository sync state, kept out of the entity documents so journal
 * churn never invalidates bootstrap caches. Plain SQL works on PGlite and PostgreSQL.
 */
export async function migrateSyncJournal(db: Database) {
  await db.query(`CREATE TABLE IF NOT EXISTS sync_inbox (
    id TEXT PRIMARY KEY,
    attachment_id TEXT NOT NULL,
    delivery_id TEXT NOT NULL,
    event TEXT NOT NULL,
    issue_number INTEGER,
    received_at TIMESTAMPTZ NOT NULL,
    processed_at TIMESTAMPTZ,
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TIMESTAMPTZ NOT NULL,
    last_error TEXT,
    UNIQUE (attachment_id, delivery_id)
  )`);
  await db.query(
    `CREATE INDEX IF NOT EXISTS sync_inbox_pending ON sync_inbox(attachment_id, received_at) WHERE processed_at IS NULL`,
  );
  await db.query(`CREATE TABLE IF NOT EXISTS sync_outbox (
    id TEXT PRIMARY KEY,
    attachment_id TEXT NOT NULL,
    item_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    actor_id TEXT NOT NULL,
    payload JSONB NOT NULL,
    status TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TIMESTAMPTZ NOT NULL,
    remote_id TEXT,
    last_error TEXT,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL
  )`);
  await db.query(
    `CREATE INDEX IF NOT EXISTS sync_outbox_open ON sync_outbox(item_id, created_at, id) WHERE status IN ('pending','in_flight','uncertain')`,
  );
  await db.query(`CREATE TABLE IF NOT EXISTS sync_field_state (
    item_id TEXT NOT NULL,
    field TEXT NOT NULL,
    attachment_id TEXT NOT NULL,
    hash TEXT NOT NULL,
    operation_id TEXT,
    updated_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (item_id, field)
  )`);
  // A provider call may or may not have happened when the process stopped.
  await db.query(
    `UPDATE sync_outbox SET status='uncertain', updated_at=NOW() WHERE status='in_flight'`,
  );
}

/** Hidden in published text so retries and our own echoes can be recognized. */
export const marker = (operationId: string) => `<!-- trestl:${operationId} -->`;
export const markedOperation = (body: string) =>
  body.match(/<!-- trestl:([0-9a-f-]{36}) -->/)?.[1] ?? null;
export const fieldHash = (value: unknown) =>
  createHash('sha256')
    .update(JSON.stringify(value ?? null))
    .digest('hex');

export interface InboxEvent {
  id: string;
  attachmentId: string;
  deliveryId: string;
  event: string;
  issueNumber: number | null;
  attempts: number;
}
/** Webhooks acknowledge only after this commits. A repeated delivery ID is a no-op. */
export async function enqueueInbox(
  db: Database,
  event: {
    id: string;
    attachmentId: string;
    deliveryId: string;
    event: string;
    issueNumber?: number | null;
    now: string;
  },
) {
  const inserted = await db.query(
    `INSERT INTO sync_inbox(id,attachment_id,delivery_id,event,issue_number,received_at,next_attempt_at)
     VALUES ($1,$2,$3,$4,$5,$6,$6) ON CONFLICT (attachment_id, delivery_id) DO NOTHING RETURNING id`,
    [
      event.id,
      event.attachmentId,
      event.deliveryId.slice(0, 200),
      event.event.slice(0, 100),
      event.issueNumber ?? null,
      event.now,
    ],
  );
  return { accepted: inserted.rows.length > 0 };
}
export async function pendingInbox(db: Database, attachmentId: string, now: string) {
  return (
    await db.query<InboxEvent>(
      `SELECT id, attachment_id AS "attachmentId", delivery_id AS "deliveryId", event,
        issue_number AS "issueNumber", attempts
       FROM sync_inbox WHERE attachment_id=$1 AND processed_at IS NULL AND next_attempt_at<=$2
       ORDER BY received_at, id LIMIT 100`,
      [attachmentId, now],
    )
  ).rows;
}
export async function inboxAttachments(db: Database, now: string) {
  return (
    await db.query<{ attachmentId: string }>(
      `SELECT DISTINCT attachment_id AS "attachmentId" FROM sync_inbox
       WHERE processed_at IS NULL AND next_attempt_at<=$1`,
      [now],
    )
  ).rows.map((row) => row.attachmentId);
}
export async function finishInbox(db: Database, ids: string[], now: string, error?: string) {
  if (!ids.length) return;
  if (error === undefined)
    await db.query(
      `UPDATE sync_inbox SET processed_at=$2, last_error=NULL WHERE id = ANY($1::text[])`,
      [ids, now],
    );
  else
    await db.query(
      `UPDATE sync_inbox SET attempts=attempts+1, last_error=$3,
        next_attempt_at=$2::timestamptz + make_interval(secs => LEAST(3600, 30 * power(2, attempts)))
       WHERE id = ANY($1::text[])`,
      [ids, now, error],
    );
}

export type OutboxStatus = 'pending' | 'in_flight' | 'uncertain' | 'done' | 'failed' | 'rejected';
export interface OutboxOperation {
  id: string;
  attachmentId: string;
  itemId: string;
  kind: OutboundKind;
  actorId: string;
  payload: Record<string, unknown>;
  status: OutboxStatus;
  attempts: number;
  remoteId: string | null;
}
const outboxColumns = `id, attachment_id AS "attachmentId", item_id AS "itemId", kind,
  actor_id AS "actorId", payload, status, attempts, remote_id AS "remoteId"`;

/** Must run in the same transaction as the local change it publishes. */
export async function insertOutbox(
  db: Database,
  operation: Omit<OutboxOperation, 'status' | 'attempts' | 'remoteId'> & { now: string },
) {
  await db.query(
    `INSERT INTO sync_outbox(id,attachment_id,item_id,kind,actor_id,payload,status,next_attempt_at,created_at,updated_at)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb,'pending',$7,$7,$7)`,
    [
      operation.id,
      operation.attachmentId,
      operation.itemId,
      operation.kind,
      operation.actorId,
      JSON.stringify(operation.payload),
      operation.now,
    ],
  );
}
export async function outboxOperation(db: Database, id: string) {
  return (
    (await db.query<OutboxOperation>(`SELECT ${outboxColumns} FROM sync_outbox WHERE id=$1`, [id]))
      .rows[0] ?? null
  );
}
/**
 * Claims the oldest due operation whose item has no earlier open operation, so
 * each item's operations reach the provider one at a time and in order.
 */
export async function claimOutbox(db: Database, now: string, uncertain = false) {
  return db.transaction(async (tx) => {
    const next = (
      await tx.query<OutboxOperation>(
        `SELECT ${outboxColumns} FROM sync_outbox o
         WHERE o.status=$2 AND o.next_attempt_at<=$1
           AND NOT EXISTS (
             SELECT 1 FROM sync_outbox p WHERE p.item_id=o.item_id AND p.id<>o.id AND (
               p.status IN ('in_flight','uncertain') AND $2='pending'
               OR p.status IN ('pending','in_flight','uncertain') AND (p.created_at,p.id) < (o.created_at,o.id)))
         ORDER BY o.created_at, o.id LIMIT 1 FOR UPDATE SKIP LOCKED`,
        [now, uncertain ? 'uncertain' : 'pending'],
      )
    ).rows[0];
    if (!next) return null;
    await tx.query(
      `UPDATE sync_outbox SET status='in_flight', attempts=attempts+1, updated_at=$2 WHERE id=$1`,
      [next.id, now],
    );
    return { ...next, attempts: next.attempts + 1 };
  });
}
export async function settleOutbox(
  db: Database,
  id: string,
  now: string,
  result:
    | { status: 'done'; remoteId: string | null }
    | {
        status: 'pending' | 'uncertain' | 'failed' | 'rejected';
        error: string;
        retryInSeconds?: number;
      },
) {
  if (result.status === 'done')
    await db.query(
      `UPDATE sync_outbox SET status='done', remote_id=$3, last_error=NULL, updated_at=$2 WHERE id=$1`,
      [id, now, result.remoteId],
    );
  else
    await db.query(
      `UPDATE sync_outbox SET status=$3, last_error=$4, updated_at=$2,
        next_attempt_at=$2::timestamptz + make_interval(secs => $5::integer) WHERE id=$1`,
      [id, now, result.status, result.error.slice(0, 500), result.retryInSeconds ?? 0],
    );
}

/** The last value both sides agreed on, per synced field. */
export async function recordFieldState(
  db: Database,
  state: {
    itemId: string;
    attachmentId: string;
    fields: Record<string, unknown>;
    operationId?: string | null;
    now: string;
  },
) {
  for (const [field, value] of Object.entries(state.fields))
    await db.query(
      `INSERT INTO sync_field_state(item_id,field,attachment_id,hash,operation_id,updated_at)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (item_id, field) DO UPDATE SET attachment_id=EXCLUDED.attachment_id,
         hash=EXCLUDED.hash, operation_id=EXCLUDED.operation_id, updated_at=EXCLUDED.updated_at
       WHERE sync_field_state.hash<>EXCLUDED.hash OR sync_field_state.attachment_id<>EXCLUDED.attachment_id`,
      [
        state.itemId,
        field,
        state.attachmentId,
        fieldHash(value),
        state.operationId ?? null,
        state.now,
      ],
    );
}
/** False when a received value is the last common one: unchanged, or our own echo. */
export async function remoteChanged(db: Database, itemId: string, field: string, value: unknown) {
  const row = (
    await db.query<{ hash: string }>(
      'SELECT hash FROM sync_field_state WHERE item_id=$1 AND field=$2',
      [itemId, field],
    )
  ).rows[0];
  return !row || row.hash !== fieldHash(value);
}

export async function journalCounts(db: Database, attachmentIds: string[]) {
  const counts = new Map<string, { inbound: number; outbound: number; failed: number }>();
  for (const id of attachmentIds) counts.set(id, { inbound: 0, outbound: 0, failed: 0 });
  if (!attachmentIds.length) return counts;
  for (const row of (
    await db.query<{ id: string; n: number }>(
      `SELECT attachment_id AS id, COUNT(*)::integer AS n FROM sync_inbox
       WHERE processed_at IS NULL AND attachment_id = ANY($1::text[]) GROUP BY attachment_id`,
      [attachmentIds],
    )
  ).rows)
    counts.get(row.id)!.inbound = row.n;
  for (const row of (
    await db.query<{ id: string; status: string; n: number }>(
      `SELECT attachment_id AS id, status, COUNT(*)::integer AS n FROM sync_outbox
       WHERE status IN ('pending','in_flight','uncertain','failed') AND attachment_id = ANY($1::text[])
       GROUP BY attachment_id, status`,
      [attachmentIds],
    )
  ).rows) {
    const count = counts.get(row.id)!;
    if (row.status === 'failed') count.failed += row.n;
    else count.outbound += row.n;
  }
  return counts;
}
