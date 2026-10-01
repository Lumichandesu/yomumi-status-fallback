import test from 'node:test';
import assert from 'node:assert/strict';
import { createStatusController, resolveStatusDataUrls } from '../public/status-client.mjs';
import { buildView, validateSnapshot } from '../public/status-model.mjs';

const NOW = Date.parse('2026-10-01T12:00:00.000Z');
const SCHEDULED_URL = 'https://yomumi-status-monitor.yomumi.workers.dev/status.json';
const FALLBACK_URL = 'https://raw.githubusercontent.com/Lumichandesu/yomumi-status/main/public/status.json';
const stamp = (time) => new Date(time).toISOString();
const flush = async () => { for (let index = 0; index < 12; index++) await Promise.resolve(); };
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function snapshot(time = NOW, status = 'operational') {
  return {
    schemaVersion: 1, generatedAt: stamp(time),
    monitor: { startedAt: stamp(NOW - 3_600_000), intervalSeconds: 900, staleAfterSeconds: 2700 },
    components: ['website', 'api', 'database', 'cache'].map((id) => ({
      id, status, checkedAt: stamp(time), latencyMs: 10, reason: null,
    })),
    history: [], days: [], incidents: [],
  };
}
const response = (value) => ({ ok: true, json: async () => value });
function fixture(t, dataUrls = ['./status.json', SCHEDULED_URL]) {
  let clock = NOW, nextTimer = 0, hidden = false;
  const timers = new Map(), requests = [], views = [], feedback = [], busy = [];
  const controller = createStatusController({
    now: () => clock, getHidden: () => hidden, dataUrls,
    fetchSnapshot: (url, options) => {
      const pending = deferred();
      requests.push({ url, options, ...pending });
      return pending.promise;
    },
    validateSnapshot, buildView, renderView: (view) => views.push(view),
    setFeedback: (message) => feedback.push(message), setBusy: (value) => busy.push(value),
    setTimer: (fn, delay) => { const id = ++nextTimer; timers.set(id, { fn, at: clock + delay }); return id; },
    clearTimer: (id) => timers.delete(id),
  });
  t.after(() => controller.destroy());
  return {
    controller, requests, views, feedback, busy, timers,
    setHidden: (value) => { hidden = value; },
    async advance(ms) {
      const end = clock + ms;
      for (;;) {
        const entry = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!entry) break;
        clock = entry[1].at;
        timers.delete(entry[0]);
        entry[1].fn();
        await flush();
      }
      clock = end;
      await flush();
    },
  };
}

test('the first validated source renders without waiting for a slower source', async (t) => {
  const f = fixture(t);
  const refreshing = f.controller.refresh();
  let completed = false;
  refreshing.then(() => { completed = true; });
  await flush();
  assert.equal(f.requests.length, 2);
  f.requests[0].resolve(response(snapshot(NOW - 30_000)));
  await flush();
  assert.equal(completed, false, 'the slow source remains pending');
  assert.equal(f.views.length, 1, 'a usable view is already visible');
  assert.equal(f.views[0].updatedAt, stamp(NOW - 30_000));
  assert.equal(f.views[0].overall, 'operational');
  assert.deepEqual(f.busy, [true]);
  f.requests[1].reject(new Error('Fixture source unavailable'));
  assert.equal(await refreshing, true);
  assert.equal(f.views.length, 1, 'settling the request does not redraw the same snapshot');
  assert.deepEqual(f.busy, [true, false]);
});

test('a slower newer snapshot upgrades the visible first result immediately', async (t) => {
  const f = fixture(t);
  const refreshing = f.controller.refresh();
  await flush();
  f.requests[0].resolve(response(snapshot(NOW - 30_000)));
  await flush();
  f.requests[1].resolve(response(snapshot(NOW, 'degraded')));
  assert.equal(await refreshing, true);
  assert.deepEqual(f.views.map((view) => view.updatedAt), [stamp(NOW - 30_000), stamp(NOW)]);
  assert.equal(f.views.at(-1).overall, 'degraded');
});

test('a slower older or equal observation cannot replace the first visible observation', async (t) => {
  for (const time of [NOW - 1_000, NOW]) {
    const f = fixture(t);
    const refreshing = f.controller.refresh();
    await flush();
    f.requests[0].resolve(response(snapshot(NOW)));
    await flush();
    f.requests[1].resolve(response(snapshot(time, 'outage')));
    assert.equal(await refreshing, true);
    assert.equal(f.views.length, 1);
    assert.equal(f.views.at(-1).overall, 'operational');
  }
});

test('a future-dated source is rejected while a valid second source still renders', async (t) => {
  const f = fixture(t);
  const refreshing = f.controller.refresh();
  await flush();
  f.requests[0].resolve(response(snapshot(NOW + 60_001, 'outage')));
  await flush();
  assert.equal(f.views.length, 0);
  f.requests[1].resolve(response(snapshot(NOW, 'unknown')));
  assert.equal(await refreshing, true);
  assert.equal(f.views.length, 1);
  assert.equal(f.views[0].overall, 'unknown', 'a retrieved snapshot is not automatically green');
});

test('later refreshes never regress an existing observation and report a failed refresh honestly', async (t) => {
  const f = fixture(t);
  let refreshing = f.controller.refresh();
  await flush();
  f.requests[0].resolve(response(snapshot(NOW)));
  f.requests[1].reject(new Error('Unavailable'));
  assert.equal(await refreshing, true);
  refreshing = f.controller.refresh();
  await flush();
  f.requests[2].resolve(response(snapshot(NOW - 1_000, 'outage')));
  await flush();
  assert.equal(f.views.length, 1, 'an older source does not flash before the second source arrives');
  f.requests[3].resolve(response(snapshot(NOW + 60_001)));
  assert.equal(await refreshing, false);
  assert.equal(f.views.at(-1).updatedAt, stamp(NOW));
  assert.equal(f.views.at(-1).overall, 'operational');
  assert.match(f.views.at(-1).description, /latest refresh could not be retrieved/);
  assert.match(f.feedback.at(-1), /last available observation/);
});

test('the six-second deadline retains an already rendered source and ignores late responses', async (t) => {
  const f = fixture(t);
  const refreshing = f.controller.refresh();
  await flush();
  f.requests[0].resolve(response(snapshot(NOW - 30_000)));
  await flush();
  await f.advance(5_999);
  assert.equal(f.requests[1].options.signal.aborted, false);
  await f.advance(1);
  assert.equal(await refreshing, true);
  assert.equal(f.requests[1].options.signal.aborted, true);
  assert.equal(f.views.length, 1);
  f.requests[1].resolve(response(snapshot(NOW, 'outage')));
  await flush();
  assert.equal(f.views.length, 1, 'an abort-ignoring source cannot render after the deadline');
  assert.equal(f.views.at(-1).overall, 'operational');
  assert.doesNotMatch(f.feedback.at(-1), /Unable/);
});

test('the deadline without a usable source shows unknown instead of unverified availability', async (t) => {
  const f = fixture(t);
  const refreshing = f.controller.refresh();
  await flush();
  await f.advance(6_000);
  assert.equal(await refreshing, false);
  assert.equal(f.views.at(-1).overall, 'unknown');
  assert.equal(f.views.at(-1).updatedAt, null);
  assert.ok(f.requests.every((request) => request.options.signal.aborted));
});

test('pausing or destroying a pending refresh prevents all late renders', async (t) => {
  for (const action of ['pause', 'destroy']) {
    const f = fixture(t);
    const refreshing = f.controller.refresh();
    await flush();
    f.controller[action]();
    assert.equal(await refreshing, false);
    f.requests[0].resolve(response(snapshot(NOW)));
    f.requests[1].resolve(response(snapshot(NOW + 1_000)));
    await flush();
    await f.advance(60_000);
    assert.equal(f.views.length, 0);
    assert.equal(f.requests.length, 2);
    assert.equal(f.timers.size, 0);
    assert.ok(f.requests.every((request) => request.options.signal.aborted));
  }
});

test('backgrounding between fetch and JSON completion suppresses late paint', async (t) => {
  const f = fixture(t), body = deferred();
  const refreshing = f.controller.refresh();
  await flush();
  f.requests[0].resolve({ ok: true, json: () => body.promise });
  await flush();
  f.setHidden(true);
  f.controller.pause();
  assert.equal(await refreshing, false);
  body.resolve(snapshot(NOW));
  f.requests[1].resolve(response(snapshot(NOW + 1_000)));
  await flush();
  assert.equal(f.views.length, 0);
});

test('a hidden document does not paint a timeout failure even before its visibility handler runs', async (t) => {
  const f = fixture(t);
  const refreshing = f.controller.refresh();
  await flush();
  f.setHidden(true);
  await f.advance(6_000);
  assert.equal(await refreshing, false);
  assert.equal(f.views.length, 0);
  assert.equal(f.timers.size, 0);
});

test('pause or destroy after the first paint cannot allow a pending source to upgrade it', async (t) => {
  for (const action of ['pause', 'destroy']) {
    const f = fixture(t);
    const refreshing = f.controller.refresh();
    await flush();
    f.requests[0].resolve(response(snapshot(NOW - 1_000)));
    await flush();
    assert.equal(f.views.length, 1);
    f.controller[action]();
    assert.equal(await refreshing, false);
    f.requests[1].resolve(response(snapshot(NOW, 'outage')));
    await flush();
    assert.equal(f.views.length, 1);
    assert.equal(f.views[0].updatedAt, stamp(NOW - 1_000));
    assert.equal(f.timers.size, 0);
  }
});

test('resuming a paused request starts a fresh cycle without letting the old cycle advance it', async (t) => {
  const f = fixture(t);
  const firstRefresh = f.controller.refresh();
  await flush();
  f.controller.pause();
  f.controller.resume();
  assert.equal(await firstRefresh, false);
  await flush();
  assert.equal(f.requests.length, 4);
  f.requests[2].resolve(response(snapshot(NOW - 1_000)));
  await flush();
  assert.equal(f.views.at(-1).updatedAt, stamp(NOW - 1_000));
  const visibleCount = f.views.length;
  f.requests[0].resolve(response(snapshot(NOW, 'outage')));
  f.requests[1].resolve(response(snapshot(NOW + 1_000, 'outage')));
  await flush();
  assert.equal(f.views.length, visibleCount);
  f.requests[3].resolve(response(snapshot(NOW)));
  await flush();
  assert.equal(f.views.at(-1).updatedAt, stamp(NOW));
  assert.equal(f.views.at(-1).overall, 'operational');
});

test('stale snapshots render promptly but retain the existing unknown semantics', async (t) => {
  const f = fixture(t);
  const refreshing = f.controller.refresh();
  await flush();
  f.requests[0].resolve(response(snapshot(NOW - 2_700_001)));
  await flush();
  assert.equal(f.views.length, 1);
  assert.equal(f.views[0].overall, 'unknown');
  assert.match(f.views[0].description, /not current/);
  f.requests[1].reject(new Error('Unavailable'));
  assert.equal(await refreshing, true);
});

test('source allowlists and request privacy options remain unchanged', async (t) => {
  const f = fixture(t, ['./status.json', './status.json', FALLBACK_URL, SCHEDULED_URL, 'https://private.invalid/probe', '/api/status']);
  const refreshing = f.controller.refresh();
  await flush();
  assert.deepEqual(f.requests.map((request) => request.url), ['./status.json', FALLBACK_URL, SCHEDULED_URL]);
  for (const request of f.requests) {
    assert.equal(request.options.cache, 'no-store');
    assert.equal(request.options.credentials, 'omit');
    assert.equal(request.options.redirect, 'error');
    request.resolve(response(snapshot()));
  }
  assert.equal(await refreshing, true);
  const configuredDocument = (content) => ({ querySelector: () => ({ content }) });
  assert.deepEqual(resolveStatusDataUrls(configuredDocument(FALLBACK_URL)), [FALLBACK_URL, SCHEDULED_URL]);
  assert.deepEqual(resolveStatusDataUrls(configuredDocument('https://private.invalid/probe')), ['./status.json', SCHEDULED_URL]);
});
