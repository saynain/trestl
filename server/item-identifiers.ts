import type { Database } from './db.ts';

/** Minimum width only: 99 is followed by 100, without truncation. */
export const formatItemIdentifier = (prefix: string, number: string | number) =>
  `${prefix}-${String(number).padStart(2, '0')}`;

/** The UPSERT reserves a number atomically and keeps deleted numbers consumed. */
export async function nextItemIdentifier(
  db: Database,
  projectId: string | null,
  workspaceId: string,
): Promise<string> {
  const project = projectId
    ? (
        await db.query<{ key: string }>(
          `SELECT data->>'key' AS key FROM entities WHERE collection='projects' AND id=$1`,
          [projectId],
        )
      ).rows[0]
    : null;
  const { rows } = await db.query<{ number: string }>(
    `INSERT INTO item_counters(workspace_id, project_id, last_number) VALUES ($1,$2,1)
     ON CONFLICT(workspace_id, project_id) DO UPDATE
     SET last_number=item_counters.last_number+1
     RETURNING last_number::text AS number`,
    [workspaceId, projectId ?? ''],
  );
  return formatItemIdentifier(project?.key ?? 'INBOX', rows[0]!.number);
}

/** One-time renumbering, with an audit map and counters committed together. */
export async function migrateItemIdentifiers(db: Database): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.query(`CREATE TABLE IF NOT EXISTS item_counters (
      workspace_id TEXT NOT NULL, project_id TEXT NOT NULL, last_number BIGINT NOT NULL,
      PRIMARY KEY(workspace_id,project_id)
    )`);
    await tx.query(`CREATE TABLE IF NOT EXISTS item_identifier_changes (
      item_id TEXT PRIMARY KEY, old_identifier TEXT NOT NULL, new_identifier TEXT NOT NULL
    )`);
    await tx.query(`INSERT INTO entities(collection,id,data)
      VALUES ('system','project-item-numbering-v1','{}') ON CONFLICT DO NOTHING`);
    const marker = (
      await tx.query<{ data: { complete?: boolean } }>(
        `SELECT data FROM entities WHERE collection='system' AND id='project-item-numbering-v1' FOR UPDATE`,
      )
    ).rows[0]!;
    if (marker.data.complete) return;

    // Preserve the old numeric order within each project (including gaps), with
    // deterministic fallbacks for legacy identifiers without a numeric suffix.
    await tx.query(`CREATE TEMP TABLE renumbered_items ON COMMIT DROP AS
      SELECT i.id, i.data->>'identifier' AS old_identifier,
        COALESCE(i.data->>'workspaceId','default') AS workspace_id,
        COALESCE(i.data->>'projectId','') AS project_id,
        COALESCE(p.data->>'key','INBOX') AS prefix,
        row_number() OVER (
          PARTITION BY COALESCE(i.data->>'workspaceId','default'), COALESCE(i.data->>'projectId','')
          ORDER BY substring(i.data->>'identifier' from '([0-9]+)$')::numeric NULLS LAST,
            i.data->>'createdAt', i.id
        ) AS number
      FROM entities i LEFT JOIN entities p
        ON p.collection='projects' AND p.id=i.data->>'projectId'
      WHERE i.collection='items'`);
    await tx.query(`INSERT INTO item_identifier_changes(item_id,old_identifier,new_identifier)
      SELECT id,old_identifier,prefix || '-' || CASE WHEN number<10 THEN '0' ELSE '' END || number::text
      FROM renumbered_items`);
    await tx.query(`UPDATE entities e SET data=jsonb_set(e.data,'{identifier}',to_jsonb(c.new_identifier))
      || jsonb_build_object('revision',COALESCE((e.data->>'revision')::integer,0)+1)
      FROM item_identifier_changes c WHERE e.collection='items' AND e.id=c.item_id`);
    // Creation retries must return the migrated identifier, too.
    await tx.query(`UPDATE entities e SET data=jsonb_set(e.data,'{result,identifier}',to_jsonb(c.new_identifier))
      FROM item_identifier_changes c
      WHERE e.collection='idempotency' AND e.data->'result'->>'id'=c.item_id
        AND e.data->'result' ? 'identifier'`);
    await tx.query(`INSERT INTO item_counters(workspace_id,project_id,last_number)
      SELECT workspace_id,project_id,max(number) FROM renumbered_items GROUP BY workspace_id,project_id
      ON CONFLICT(workspace_id,project_id) DO UPDATE SET last_number=EXCLUDED.last_number`);
    await tx.query(`UPDATE entities SET data='{"complete":true}'
      WHERE collection='system' AND id='project-item-numbering-v1'`);
  });
}
