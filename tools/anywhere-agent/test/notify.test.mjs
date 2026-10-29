import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  NOTIFY_DEFAULT_LIMIT,
  NOTIFY_MAX_LIMIT,
  ackIdOf,
  badgeUrl,
  clampWatermark,
  feedUrl,
  isNotifiable,
  newNotices,
  parseFeed,
  parseRunNotice,
  parseWatermarks,
  readDecision,
  reconcileWatermark,
  summarizeFeed,
} from '../src/notify.mjs';

/** One notice as the wire carries it. */
const notice = (id, outcome, extra = {}) => ({
  id,
  at: 1760000000000 + id,
  sessionId: `session-${id}`,
  title: `第 ${id} 件事`,
  turn: id,
  reason: outcome === 'completed' ? 'completed' : outcome === 'failed' ? 'error' : 'aborted',
  outcome,
  ...extra,
});

/** A feed document. */
const feed = (latest, notices) => JSON.stringify({ origin: 'dsh.foo.netbird', latest, notices });

test('a watermark that cannot be read means nothing has been seen yet', () => {
  assert.equal(clampWatermark(7), 7);
  assert.equal(clampWatermark(7.9), 7);
  assert.equal(clampWatermark('12'), 12);
  for (const value of [undefined, null, '', 'unknown', -1, Number.NaN, Number.POSITIVE_INFINITY, {}, []]) {
    assert.equal(clampWatermark(value), 0, String(value));
  }
});

test('reconciliation keeps a watermark that is still ahead and resets a regressed one', () => {
  // First read: nothing stored, nothing to reconcile.
  assert.equal(reconcileWatermark(0, 5), 0);
  // Incremental read: the host is the same process and moved forward.
  assert.equal(reconcileWatermark(5, 9), 5);
  assert.equal(reconcileWatermark(5, 5), 5);
  // Host restart: ids start over, so the stored number would hide every new run.
  assert.equal(reconcileWatermark(50, 3), 0);
  assert.equal(reconcileWatermark(1, 0), 0);
  // A feed that cannot report a latest id cannot tell us anything changed.
  assert.equal(reconcileWatermark(5, Number.NaN), 5);
  assert.equal(reconcileWatermark(5, undefined), 5);
});

test('a first read takes everything, an incremental read takes only what is new', () => {
  const first = parseFeed(JSON.parse(feed(3, [notice(1, 'completed'), notice(2, 'stopped'), notice(3, 'failed')])));
  assert.deepEqual(newNotices(first, 0).map((item) => item.id), [1, 2, 3]);

  const later = parseFeed(JSON.parse(feed(5, [notice(4, 'completed'), notice(5, 'completed')])));
  assert.deepEqual(newNotices(later, 3).map((item) => item.id), [4, 5]);
  // Nothing new is an empty list, not a dot.
  assert.deepEqual(newNotices(later, 5), []);
});

test('a restarted host starts over, so new work cannot hide behind an old watermark', () => {
  // The stored watermark is from the previous process, whose ids went past 50.
  const restarted = feed(3, [notice(1, 'completed'), notice(2, 'completed'), notice(3, 'failed')]);
  const summary = summarizeFeed(restarted, 50);
  assert.equal(summary.reset, true, 'the caller must re-read from zero');
  assert.equal(summary.unread, 3);
  assert.equal(summary.latestNotice.id, 3);
  // The same rule through the pure helper: reconcile first, then count.
  const parsed = parseFeed(JSON.parse(restarted));
  assert.deepEqual(newNotices(parsed, reconcileWatermark(50, parsed.latest)).map((item) => item.id), [1, 2, 3]);
  // A reading taken with `since=0` after the reset agrees with the first one.
  const reread = summarizeFeed(restarted, 0);
  assert.equal(reread.reset, false);
  assert.equal(reread.unread, 3);
});

test('only outcomes worth interrupting someone for light the dot', () => {
  assert.equal(isNotifiable('completed'), true);
  assert.equal(isNotifiable('failed'), true);
  assert.equal(isNotifiable('stopped'), false);
  assert.equal(isNotifiable('something-a-plugin-added'), false);

  const summary = summarizeFeed(feed(3, [notice(1, 'stopped'), notice(2, 'completed'), notice(3, 'stopped')]), 0);
  assert.equal(summary.unread, 1, 'a run the user stopped is not news');
  // The newest unseen notice is reported whatever its outcome, because looking at a
  // machine reads all of it - see `ackIdOf` for what the look actually records.
  assert.equal(summary.latestNotice.id, 3);
  assert.equal(summary.latest, 3);

  // Work already seen contributes nothing, however it ended.
  const seen = summarizeFeed(feed(3, [notice(1, 'completed'), notice(2, 'failed'), notice(3, 'completed')]), 3);
  assert.equal(seen.unread, 0);
  assert.equal(seen.latestNotice, null);
});

test('the number on the badge is how many finished conversations are unread', () => {
  // The row's red mark carries a number, so the number has to mean exactly one thing:
  // conversations that finished (either way) since this machine was last opened.
  const summary = summarizeFeed(
    feed(5, [notice(1, 'completed'), notice(2, 'failed'), notice(3, 'stopped'), notice(4, 'completed'), notice(5, 'failed')]),
    1,
  );
  assert.equal(summary.unread, 3, 'two completed/failed after the watermark, one stopped');
  assert.equal(summary.latestNotice.id, 5, 'looking at the machine reads all of it, stopped included');
});

test('an unusable feed response degrades to no dot and never throws', () => {
  const bodies = [
    undefined,
    null,
    '',
    'not json at all',
    '<html>404</html>',
    '[]',
    '{"notices":{}}',
    '{"latest":"soon"}',
    42,
    [],
  ];
  for (const body of bodies) {
    const summary = summarizeFeed(body, 4);
    assert.equal(summary.unread, 0, String(body));
    assert.equal(summary.latestNotice, null, String(body));
    assert.equal(summary.reset, false, String(body));
  }
  // A feed object that is well formed but empty is the same answer.
  assert.deepEqual(summarizeFeed(feed(0, []), 0), { unread: 0, failed: 0, latestNotice: null, reset: false, latest: 0 });
});

test('looking at a machine reads all of it, so the watermark is the feed newest id', () => {
  // A page that stops short of the host's newest id must not become the watermark:
  // advancing by whatever fitted in one page is what left a permanent remainder no
  // amount of looking could clear.
  const summary = summarizeFeed(feed(61, [notice(21, 'completed'), notice(40, 'completed')]), 20);
  assert.equal(summary.unread, 2);
  assert.equal(summary.latestNotice.id, 40, 'the page only reached id 40');
  assert.equal(ackIdOf(summary), 61, 'but the look reads the host up to its newest id');
  // A feed that reports no usable latest falls back to what it did carry.
  assert.equal(ackIdOf({ latest: 0, latestNotice: { id: 40 } }), 40);
  assert.equal(ackIdOf({ latest: 0, latestNotice: null }), 0);
  assert.equal(ackIdOf(undefined), 0);
});

test('a machine the user is inside carries no count and is recorded as read', () => {
  const summary = summarizeFeed(feed(61, [notice(60, 'completed'), notice(61, 'failed')]), 20);
  const away = readDecision(summary, { watching: false, known: true });
  assert.equal(away.unread, 2, 'away from the machine, both are news');
  assert.equal(away.failed, 1, 'and one of them failed, which the row is told separately');
  assert.equal(away.ackId, 61);
  const inside = readDecision(summary, { watching: true, known: true });
  assert.equal(inside.unread, 0, 'watching it finish is not work to come back for');
  assert.equal(inside.failed, 0, 'and neither is a failure the user watched happen');
  assert.equal(inside.ackId, 61, 'and the whole report counts as looked at');
  // Defensive: an unusable count is zero rather than NaN on a screen.
  assert.equal(readDecision({ unread: 'several', latest: 3 }, { known: true }).unread, 0);
  assert.equal(readDecision({ unread: -2, latest: 3 }, { known: true }).unread, 0);
  assert.equal(readDecision({ unread: 2, failed: 'lots', latest: 3 }, { known: true }).failed, 0);
});

test('a machine met for the first time is a baseline, not a backlog', () => {
  // The feed holds the host's recent history. A client that was just installed has not
  // been away from anything, so claiming that history would open every fresh install
  // with a number nobody can act on.
  const summary = summarizeFeed(
    feed(40, [notice(20, 'completed'), notice(39, 'failed'), notice(40, 'completed')]),
    0,
  );
  const first = readDecision(summary, { watching: false, known: false });
  assert.equal(first.unread, 0, 'the history is not news to a client that just arrived');
  assert.equal(first.failed, 0);
  assert.equal(first.baseline, true);
  assert.equal(first.ackId, 40, 'but the watermark is established, so the next read is measured');
  // Every read after that one is measured from where the baseline landed.
  const later = summarizeFeed(feed(41, [notice(41, 'completed')]), first.ackId);
  assert.deepEqual(
    { unread: readDecision(later, { known: true }).unread, baseline: readDecision(later, { known: true }).baseline },
    { unread: 1, baseline: false },
  );
});

test('only a failure is worth the alarm colour', () => {
  // A host that restarted counts as known, not as a baseline: its ids began again, so
  // what it now reports really is new work.
  const restarted = summarizeFeed(feed(2, [notice(1, 'completed'), notice(2, 'completed')]), 0);
  const after = readDecision(restarted, { watching: false, known: true });
  assert.equal(after.unread, 2, 'a zero watermark that exists is not a first contact');
  assert.equal(after.failed, 0, 'two clean finishes, so the row stays quiet');

  const withFailure = summarizeFeed(feed(3, [notice(1, 'completed'), notice(2, 'failed'), notice(3, 'failed')]), 0);
  const decision = readDecision(withFailure, { known: true });
  assert.equal(decision.unread, 3);
  assert.equal(decision.failed, 2, 'the row reports how many of them failed');
});

test('a badge read asks for everything the host retains, not its first page', () => {
  // The count is the whole backlog, so the request is not the default page: twenty
  // notices is what made a host with more than twenty finished runs unreadable.
  assert.equal(NOTIFY_MAX_LIMIT, 100, 'the contract ceiling, which is also the host retention');
  assert.equal(
    badgeUrl('http://dsh.foo.netbird/', 12),
    `http://dsh.foo.netbird/api/dsh-notify/feed?since=12&limit=${NOTIFY_MAX_LIMIT}`,
  );
  assert.equal(badgeUrl('http://dsh.foo.netbird', 0).endsWith(`limit=${NOTIFY_MAX_LIMIT}`), true);
});

test('a notice is rebuilt field by field, so a truncated one cannot reach the screen', () => {
  assert.equal(parseRunNotice(null), null);
  assert.equal(parseRunNotice('notice'), null);
  assert.equal(parseRunNotice([1]), null);
  const blank = parseRunNotice({});
  assert.deepEqual(blank, { id: 0, at: 0, sessionId: '', title: '', turn: 0, reason: '', outcome: 'stopped' });
  // An unknown outcome is derived from the reason rather than assumed successful.
  assert.equal(parseRunNotice({ id: 1, reason: 'error' }).outcome, 'failed');
  assert.equal(parseRunNotice({ id: 1, reason: 'max-tokens' }).outcome, 'completed');
  assert.equal(parseRunNotice({ id: 1, reason: 'aborted' }).outcome, 'stopped');
  assert.equal(parseRunNotice({ id: 1, reason: 'plugin-invented-this' }).outcome, 'stopped');
  // An outcome the wire states wins over the reason.
  assert.equal(parseRunNotice({ id: 1, reason: 'error', outcome: 'completed' }).outcome, 'completed');
  assert.equal(parseRunNotice({ id: '4', at: '5' }).id, 4);
  assert.equal(parseRunNotice({ id: '4', at: '5' }).at, 5);
});

test('a feed document is narrowed, and its newest id survives a missing field', () => {
  assert.equal(parseFeed(null), null);
  assert.equal(parseFeed([1]), null);
  const parsed = parseFeed({ origin: 'dsh.foo.netbird', latest: 7, notices: [notice(1, 'completed'), 'junk', null] });
  assert.equal(parsed.origin, 'dsh.foo.netbird');
  assert.equal(parsed.latest, 7);
  assert.deepEqual(parsed.notices.map((item) => item.id), [1], 'junk elements are dropped');
  // Without a latest the newest notice is the best answer, rather than zero.
  assert.equal(parseFeed({ notices: [notice(2, 'completed'), notice(5, 'completed')] }).latest, 5);
  assert.equal(parseFeed({ latest: 'nonsense', notices: [] }).latest, 0);
});

test('the feed address carries the watermark the machine should answer from', () => {
  assert.equal(feedUrl('http://dsh.foo.netbird/', 12), 'http://dsh.foo.netbird/api/dsh-notify/feed?since=12&limit=20');
  assert.equal(feedUrl('http://dsh.foo.netbird', 0), 'http://dsh.foo.netbird/api/dsh-notify/feed?since=0&limit=20');
  assert.equal(feedUrl('http://dsh.foo.netbird/', 3, 5), 'http://dsh.foo.netbird/api/dsh-notify/feed?since=3&limit=5');
  // A watermark the machine cannot parse is asked from the beginning, not dropped.
  assert.equal(feedUrl('http://dsh.foo.netbird/', 'unknown'), `http://dsh.foo.netbird/api/dsh-notify/feed?since=0&limit=${NOTIFY_DEFAULT_LIMIT}`);
});

test('the stored watermark file tolerates absence, corruption and junk entries', () => {
  assert.deepEqual(parseWatermarks({}), {});
  for (const value of [null, undefined, 'watermarks', 3, []]) {
    assert.deepEqual(parseWatermarks(value), {}, String(value));
  }
  assert.deepEqual(parseWatermarks({ 'dsh.studio-mac.netbird': 4, 'dsh.tower-lab.netbird': '9' }), {
    'dsh.studio-mac.netbird': 4,
    'dsh.tower-lab.netbird': 9,
  });
  assert.deepEqual(parseWatermarks({ '': 4, 'dsh.tower-lab.netbird': -1, 'dsh.imac-office.netbird': 'later' }), {});
});