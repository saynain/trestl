import test from 'node:test';
import assert from 'node:assert/strict';
import {
  matchesStroke,
  ShortcutMatcher,
  formatShortcut,
  type KeyInput,
  type ShortcutId,
} from '../src/lib/shortcuts.ts';
const key = (key: string, overrides: Partial<KeyInput> = {}): KeyInput => ({
  key,
  code: '',
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  isComposing: false,
  repeat: false,
  ...overrides,
});
test('mod follows the platform without accepting extra modifiers', () => {
  assert.equal(matchesStroke(key('k', { metaKey: true }), 'mod+k', true), true);
  assert.equal(matchesStroke(key('k', { ctrlKey: true }), 'mod+k', false), true);
  assert.equal(matchesStroke(key('k', { ctrlKey: true }), 'mod+k', true), false);
  assert.equal(matchesStroke(key('k', { metaKey: true, ctrlKey: true }), 'mod+k', true), false);
  assert.equal(matchesStroke(key('k', { metaKey: true, altKey: true }), 'mod+k', true), false);
});
test('navigation sequences win over item actions and expire after one second', () => {
  const matcher = new ShortcutMatcher();
  const ids: ShortcutId[] = ['priority', 'projects', 'inbox', 'assignMe'];
  assert.deepEqual(matcher.match(key('g'), ids, true, 0), { prefix: 'g' });
  assert.deepEqual(matcher.match(key('p'), ids, true, 500), { id: 'projects' });
  matcher.match(key('g'), ids, true, 1000);
  assert.deepEqual(matcher.match(key('i'), ids, true, 2001), { id: 'assignMe' });
});

test('Home has a navigation chord alongside Inbox and My work', () => {
  const matcher = new ShortcutMatcher();
  const ids: ShortcutId[] = ['home', 'inbox', 'myWork'];
  assert.deepEqual(matcher.match(key('g'), ids, true, 0), { prefix: 'g' });
  assert.deepEqual(matcher.match(key('h'), ids, true, 100), { id: 'home' });
});
test('canceling or changing context cannot carry a navigation prefix into an item action', () => {
  const matcher = new ShortcutMatcher();
  matcher.match(key('g'), ['inbox'], true, 0);
  matcher.reset();
  assert.deepEqual(matcher.match(key('i'), ['inbox', 'assignMe'], true, 50), { id: 'assignMe' });
  matcher.match(key('g'), ['inbox'], true, 100);
  assert.deepEqual(matcher.match(key('Escape'), ['inbox'], true, 150), {});
  assert.deepEqual(matcher.match(key('i'), ['inbox'], true, 200), {});
  assert.deepEqual(matcher.match(key('p'), [], true, 300), {});
});
test('composition and held keys cannot trigger creation or assignment', () => {
  const matcher = new ShortcutMatcher();
  assert.deepEqual(matcher.match(key('c', { isComposing: true }), ['create'], true, 0), {});
  assert.deepEqual(matcher.match(key('c', { repeat: true }), ['create'], true, 10), {});
  assert.deepEqual(matcher.match(key('i', { repeat: true }), ['assignMe'], true, 20), {});
  assert.deepEqual(matcher.match(key('j', { repeat: true }), ['next'], true, 30), { id: 'next' });
  assert.equal(matchesStroke(key('Dead'), 'd', true), false);
});
test('shifted letters, punctuation and composer shortcuts match exactly', () => {
  assert.equal(matchesStroke(key('P', { shiftKey: true }), 'shift+p', true), true);
  assert.equal(matchesStroke(key('P', { shiftKey: true }), 'p', true), false);
  assert.equal(matchesStroke(key('?', { shiftKey: true }), '?', true), true);
  assert.equal(
    matchesStroke(key('<', { code: 'Comma', metaKey: true, shiftKey: true }), 'mod+shift+,', true),
    true,
  );
  assert.equal(
    matchesStroke(
      key('>', { code: 'Period', ctrlKey: true, shiftKey: true }),
      'mod+shift+.',
      false,
    ),
    true,
  );
  assert.equal(
    matchesStroke(key('S', { ctrlKey: true, shiftKey: true }), 'ctrl+shift+s', true),
    true,
  );
  assert.equal(
    matchesStroke(key('S', { metaKey: true, shiftKey: true }), 'ctrl+shift+s', true),
    false,
  );
});
test('help formats platform modifiers and sequential chords', () => {
  assert.equal(formatShortcut('mod+shift+enter', true), '⌘ ⇧ ↵');
  assert.equal(formatShortcut('mod+shift+enter', false), 'Ctrl + Shift + ↵');
  assert.equal(formatShortcut('g i', true), 'G then I');
});
test('zen mode owns mod+b without switching list layout', () => {
  const matcher = new ShortcutMatcher();
  const ids: ShortcutId[] = ['layout', 'sidebar'];
  assert.deepEqual(matcher.match(key('b', { metaKey: true }), ids, true, 0), { id: 'sidebar' });
  assert.deepEqual(matcher.match(key('b', { ctrlKey: true }), ids, false, 1), { id: 'sidebar' });
  assert.deepEqual(matcher.match(key('B', { shiftKey: true }), ids, true, 2), { id: 'layout' });
  assert.deepEqual(matcher.match(key('b', { metaKey: true, repeat: true }), ids, true, 3), {});
});
