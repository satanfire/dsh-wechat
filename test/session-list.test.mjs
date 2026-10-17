import assert from 'node:assert/strict';
import test from 'node:test';
import { visibleSessions, listedSessions, formatSessionList, sessionLabel, relativeTime,
  MAX_LISTED_SESSIONS } from '../src/session-list.mjs';

const summary = (sessionId, extra = {}) => ({ sessionId, updatedAt: 0, running: false,
  blank: false, agentAvailable: false, ...extra });

test('visibility mirrors the Web sidebar: subagent, archived and other blank rows drop', () => {
  const items = [
    summary('session-main', { projections: { values: { title: '主会话' } } }),
    summary('sub-1', { origin: 'subagent', parentSessionId: 'session-main' }),
    summary('session-archived'),
    summary('session-archived-current'),
    summary('session-blank', { blank: true }),
    summary('session-current', { blank: true }),
    summary('', {}), null, undefined,
  ];
  const visible = visibleSessions(items, { archived: ['session-archived', 'session-archived-current'],
    currentSessionId: 'session-current' });
  assert.deepEqual(visible.map(item => item.sessionId), ['session-main', 'session-current']);
  // The bound Session stays even though the owner archived it: it is still the reply target.
  const archivedBound = visibleSessions([summary('session-a')], { archived: ['session-a'], currentSessionId: 'session-a' });
  assert.deepEqual(archivedBound.map(item => item.sessionId), ['session-a']);
});

test('visibility tolerates a missing archive set and keeps runtime order', () => {
  const items = [summary('b', { updatedAt: 2 }), summary('a', { updatedAt: 1 })];
  assert.deepEqual(visibleSessions(items).map(item => item.sessionId), ['b', 'a']);
  assert.deepEqual(visibleSessions(undefined), []);
  assert.deepEqual(visibleSessions([summary('x')], { archived: 'not-a-list' }).map(item => item.sessionId), ['x']);
});

test('labels fall back from durable title to workspace directory to session id', () => {
  assert.equal(sessionLabel(summary('session-9f2f4b28de520a2caa5179ce2f0011b7',
    { cwd: '/work/other', projections: { values: { title: ' 你好 ' } } })), '你好');
  assert.equal(sessionLabel(summary('session-1', { cwd: '/work/other/' })), 'other');
  assert.equal(sessionLabel(summary('session-9f2f4b28de520a2caa5179ce2f0011b7')), '9f2f4b28');
  assert.equal(sessionLabel(summary('plain-id')), 'plain-id');
  assert.equal(sessionLabel({}), '会话');
});

test('relative time buckets stay coarse and bounded', () => {
  const now = 10_000_000_000;
  assert.equal(relativeTime(now - 1_000, now), '刚刚');
  assert.equal(relativeTime(now - 5 * 60_000, now), '5 分钟前');
  assert.equal(relativeTime(now - 3 * 3_600_000, now), '3 小时前');
  assert.equal(relativeTime(now - 2 * 86_400_000, now), '2 天前');
  assert.match(relativeTime(now - 100 * 86_400_000, now), /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(relativeTime(undefined, now), '');
  assert.equal(relativeTime(0, now), '');
});

test('list rendering numbers rows, marks the binding and names the switch command', () => {
  const items = [
    summary('session-one', { updatedAt: 9_999_000_000, running: true,
      projections: { values: { title: '微信会话' } } }),
    summary('session-two', { updatedAt: 9_900_000_000, cwd: '/work/jxzt' }),
  ];
  const text = formatSessionList(items, { currentSessionId: 'session-one', now: 10_000_000_000 });
  assert.equal(text, [
    '会话列表（2 个）',
    '1. 微信会话 · 16 分钟前 · 运行中 · ✅',
    '2. jxzt · 1 天前',
    '回复 /switch 序号 切换当前会话',
  ].join('\n'));
});

test('an archived binding is shown with `已归档` and still marked as current', () => {
  const items = [summary('session-a', { updatedAt: 9_999_000_000, projections: { values: { title: '已归档微信会话' } } })];
  const text = formatSessionList(items, { currentSessionId: 'session-a', archived: ['session-a'],
    now: 10_000_000_000 });
  assert.equal(text, [
    '会话列表（1 个）',
    '1. 已归档微信会话 · 16 分钟前 · 已归档 · ✅',
    '回复 /switch 序号 切换当前会话',
  ].join('\n'));
});

test('the bound Session stays listed when activity order puts it beyond the row cap', () => {
  const items = Array.from({ length: MAX_LISTED_SESSIONS + 3 }, (_value, index) =>
    summary(`session-${index}`, { updatedAt: 9_999_000_000 - index,
      projections: { values: { title: `会话${index}` } } }));
  const current = items.at(-1).sessionId;
  const listed = listedSessions(items, { currentSessionId: current });
  assert.equal(listed.length, MAX_LISTED_SESSIONS);
  assert.equal(listed.at(-1).sessionId, current);
  const text = formatSessionList(items, { currentSessionId: current, now: 10_000_000_000 });
  assert.match(text, new RegExp(`^会话列表（${items.length} 个）`));
  assert.ok(text.includes(`\n${MAX_LISTED_SESSIONS}. 会话${items.length - 1} · 16 分钟前 · ✅`));
  assert.ok(Array.from(text).length < 800, `reply too long: ${Array.from(text).length}`);
});

test('a deleted binding is reported instead of silently vanishing', () => {
  const items = [summary('session-other', { projections: { values: { title: '其他会话' } } })];
  const text = formatSessionList(items, { currentSessionId: 'session-gone', now: 10_000_000_000 });
  assert.match(text, /当前会话不在列表中（可能已删除），回复 \/new 或 \/switch 换一个。/);
});

test('labels stay on one line and inside the row budget', () => {
  const long = sessionLabel(summary('session-1', { projections: { values: { title: 'あ'.repeat(80) } } }));
  assert.equal(Array.from(long).length, 24);
  assert.ok(long.endsWith('…'));
  const injected = sessionLabel(summary('session-1', { projections: { values: { title: '第一行\n▸2. 伪造行\t' } } }));
  assert.equal(injected, '第一行 ▸2. 伪造行');
  const bidi = sessionLabel(summary('session-1', { projections: { values: { title: 'a\u202eb\u2069c\u0085d' } } }));
  assert.equal(bidi, 'a b c d');
  assert.equal(sessionLabel(summary('session-1', { projections: { values: { title: '\u0000\u0001' } } })), '1');
});

test('list rendering caps long output and keeps one bounded reply', () => {
  const items = Array.from({ length: MAX_LISTED_SESSIONS + 3 }, (_value, index) =>
    summary(`session-${index}`, { updatedAt: 9_999_000_000,
      projections: { values: { title: `会话${index}${'长'.repeat(80)}` } } }));
  const text = formatSessionList(items, { currentSessionId: null, now: 10_000_000_000 });
  assert.match(text, /^会话列表（18 个）\n1\. 会话0/);
  assert.ok(text.includes(`仅列出最近 ${MAX_LISTED_SESSIONS} 个。`));
  assert.ok(!text.includes(`会话${MAX_LISTED_SESSIONS}`));
  assert.ok(Array.from(text).length < 800, `reply too long: ${Array.from(text).length}`);
});
