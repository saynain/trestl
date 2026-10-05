import test from 'node:test';
import assert from 'node:assert/strict';
import {
  clearDraft,
  draftKey,
  hasDraftChanges,
  isRetryIntent,
  readDraft,
  retryIntent,
  retryLifetimeMs,
  saveDraft,
} from '../src/lib/drafts.ts';

test('drafts remain isolated by workspace, profile, item, and composer context', () => {
  const values = new Map<string, string>();
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    },
  });
  try {
    const profile = { id: 'user:one', workspaceId: 'workspace:one' };
    const key = draftKey(profile, 'edit:item-one');
    const intent = retryIntent({ title: 'Unfinished draft' }, null);
    saveDraft(key, intent);
    assert.deepEqual(readDraft(key, isRetryIntent), intent);
    for (const isolated of [
      draftKey({ ...profile, id: 'user:two' }, 'edit:item-one'),
      draftKey({ ...profile, workspaceId: 'workspace:two' }, 'edit:item-one'),
      draftKey(profile, 'edit:item-two'),
      draftKey(profile, 'comment:item-one'),
    ])
      assert.equal(readDraft(isolated, isRetryIntent), null);
    clearDraft(key);
    assert.equal(readDraft(key, isRetryIntent), null);
    values.set(key, '{invalid');
    assert.equal(readDraft(key, isRetryIntent), null);
    values.set(key, JSON.stringify({ fingerprint: 7, key: 'wrong shape' }));
    assert.equal(readDraft(key, isRetryIntent), null);
  } finally {
    if (original) Object.defineProperty(globalThis, 'localStorage', original);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  }
});

test('retries preserve their key across recovery and changed input creates a new operation', () => {
  const first = retryIntent({ title: 'One', description: 'Retained image markdown' }, null);
  const recovered = JSON.parse(JSON.stringify(first));
  assert.deepEqual(
    retryIntent({ title: 'One', description: 'Retained image markdown' }, recovered),
    first,
  );
  assert.notEqual(
    retryIntent({ title: 'Two', description: 'Retained image markdown' }, recovered).key,
    first.key,
  );
});

test('ambiguous-write replay expires without turning a later deliberate submit into an old operation', () => {
  const body = { title: 'Meeting follow-up' };
  const createdAt = 1_000_000;
  const attempt = retryIntent(body, null, createdAt);
  const recovered = JSON.parse(JSON.stringify(attempt));
  assert.equal(retryIntent(body, recovered, createdAt + retryLifetimeMs - 1).key, attempt.key);
  assert.notEqual(retryIntent(body, recovered, createdAt + retryLifetimeMs).key, attempt.key);
  assert.notEqual(retryIntent(body, recovered, createdAt - 1).key, attempt.key);
  // Old unbounded retry records cannot indefinitely replay deleted work.
  assert.equal(isRetryIntent({ fingerprint: JSON.stringify(body), key: 'old-key' }), false);
});

test('untouched editors have no draft and dirty drafts compare with their original editing base', () => {
  const base = { title: 'Rollout', description: 'Original plan' };
  assert.equal(hasDraftChanges({ ...base }, base), false);
  const changed = { ...base, description: 'My proposed plan' };
  assert.equal(hasDraftChanges(changed, base), true);
  // Reloading a conflicting server version must not replace the original base,
  // even if the server independently happens to choose the same draft wording.
  const serverVersion = { ...changed };
  assert.equal(hasDraftChanges(changed, base), true);
  assert.equal(hasDraftChanges(changed, serverVersion), false);
  assert.equal(hasDraftChanges(base, base), false);
});

test('disabled browser storage does not prevent editing or saving', () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    get() {
      throw new Error('Browser storage is disabled');
    },
  });
  try {
    assert.equal(readDraft('draft', isRetryIntent), null);
    assert.doesNotThrow(() => saveDraft('draft', { body: 'Still editable' }));
    assert.doesNotThrow(() => clearDraft('draft'));
  } finally {
    if (original) Object.defineProperty(globalThis, 'localStorage', original);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  }
});
