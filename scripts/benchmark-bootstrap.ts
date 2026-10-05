/** Run manually: node --import tsx scripts/benchmark-bootstrap.ts [1000 10000] */
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { createApp } from '../server/app.ts';
import type { AppContext } from '../server/context.ts';
import type { WorkItem } from '../shared/types.ts';

const counts = process.argv.slice(2).map(Number);
for (const count of counts.length ? counts : [1000, 10000]) {
  if (!Number.isSafeInteger(count) || count < 1 || count > 100000)
    throw new Error('Item counts must be integers between 1 and 100000');
  const app = await createApp({ dataDir: ':memory:', integrations: false });
  try {
    const setup = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/setup',
      payload: {
        name: 'Benchmark',
        email: 'benchmark@trestl.test',
        password: 'local-benchmark-password',
        seedDemo: false,
      },
    });
    if (setup.statusCode !== 201) throw new Error(setup.body);
    const session = setup.cookies.find((cookie) => cookie.name === 'trestl_session')!;
    const cookie = `${session.name}=${session.value}`;
    const user = setup.json();
    const ctx = (app as unknown as { context: AppContext }).context;
    const workspaceId = user.workspaceId;
    const stamp = new Date().toISOString();
    const items: WorkItem[] = Array.from({ length: count * 2 }, (_, index) => ({
      id: randomUUID(),
      identifier: `BENCH-${index + 1}`,
      title: `Benchmark item ${index + 1}`,
      description: 'Representative planning description. '.repeat(8),
      workspaceId: index < count ? workspaceId : 'other-benchmark-installation',
      projectId: null,
      milestoneId: null,
      parentId: null,
      creatorId: user.id,
      assigneeId: user.id,
      visibility: 'workspace',
      type: 'task',
      status: 'todo',
      priority: 'medium',
      startDate: null,
      dueDate: null,
      followUpDate: null,
      recurrence: null,
      labels: [],
      createdAt: stamp,
      updatedAt: stamp,
      completedAt: null,
      position: index,
      revision: 1,
    }));
    await ctx.db.query(
      `INSERT INTO entities(collection,id,data) SELECT 'items', item->>'id', item FROM jsonb_array_elements($1::jsonb) item`,
      [JSON.stringify(items)],
    );
    const started = performance.now();
    const cold = await app.inject({ method: 'GET', url: '/api/v1/bootstrap', headers: { cookie } });
    const coldMs = performance.now() - started;
    if (cold.statusCode !== 200 || cold.json().items.length !== count)
      throw new Error('Bootstrap returned an incorrect workspace item count');
    const timings: number[] = [];
    for (let repeat = 0; repeat < 5; repeat++) {
      const started = performance.now();
      const unchanged = await app.inject({
        method: 'GET',
        url: '/api/v1/bootstrap',
        headers: { cookie, 'if-none-match': String(cold.headers.etag) },
      });
      timings.push(performance.now() - started);
      if (unchanged.statusCode !== 304 || unchanged.body)
        throw new Error('Conditional bootstrap did not avoid the response body');
    }
    timings.sort((a, b) => a - b);
    console.log(
      JSON.stringify({
        workspaceItems: count,
        excludedItems: count,
        coldMs: Number(coldMs.toFixed(2)),
        payloadBytes: Buffer.byteLength(cold.body),
        unchangedMedianMs: Number(timings[2].toFixed(2)),
        unchangedPayloadBytes: 0,
      }),
    );
  } finally {
    await app.close();
  }
}
