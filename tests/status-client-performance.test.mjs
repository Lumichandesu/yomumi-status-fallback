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


test('fresh Cloudflare makes one private-safe GET and skips GitHub', async (t)=>{
  const f=fixture(t);
  const p=f.controller.refresh();
  assert.deepEqual(f.requests.map(r=>r.url), [SCHEDULED_URL]);
  assert.equal(f.requests[0].options.credentials, 'omit');
  assert.equal(f.requests[0].options.redirect, 'error');
  assert.equal(f.requests[0].options.cache, 'no-store');
  f.requests[0].resolve(response(snapshot()));
  assert.equal(await p,true);
  assert.equal(f.views[0].overall,'operational');
  assert.equal(f.requests.length,1);
});
for (const mode of ['unreachable','invalid','future','stale','timeout','body-timeout']) {
  test('Cloudflare '+mode+' uses only the fallback and ignores late primary', async (t)=>{
    const f=fixture(t,[FALLBACK_URL,SCHEDULED_URL]);
    const p=f.controller.refresh();
    const primary=f.requests[0];
    if (mode==='unreachable') primary.reject(new Error('unreachable'));
    if (mode==='invalid') primary.resolve(response({schemaVersion:99}));
    if (mode==='future') primary.resolve(response(snapshot(NOW+61_000)));
    if (mode==='stale') primary.resolve(response(snapshot(NOW-3_600_000)));
    const body=deferred();
    if (mode==='body-timeout') primary.resolve({ok:true,json:()=>body.promise});
    if (mode.endsWith('timeout')) { await f.advance(1999); assert.equal(f.requests.length,1); await f.advance(1); }
    else await flush();
    assert.deepEqual(f.requests.map(r=>r.url),[SCHEDULED_URL,FALLBACK_URL]);
    assert.equal(primary.options.signal.aborted,true);
    f.requests[1].resolve(response(snapshot(NOW)));
    assert.equal(await p,true);
    if (mode==='timeout') primary.resolve(response(snapshot(NOW+10_000,'outage')));
    if (mode==='body-timeout') body.resolve(snapshot(NOW+10_000,'outage'));
    await flush();
    assert.equal(f.views.length,1);
    assert.equal(f.views[0].overall,'operational');
  });
}
test('overall deadline retains stale evidence but never shows it as current', async(t)=>{
  const f=fixture(t);
  const p=f.controller.refresh();
  f.requests[0].resolve(response(snapshot(NOW-3_600_000)));
  await flush();
  await f.advance(6000);
  assert.equal(await p,true);
  assert.equal(f.requests[1].options.signal.aborted,true);
  assert.equal(f.views[0].overall,'unknown');
});
test('when both sources hang hard deadline returns unknown', async(t)=>{
  const f=fixture(t);
  const p=f.controller.refresh();
  await f.advance(6000);
  assert.equal(await p,false);
  assert.equal(f.views[0].updatedAt,null);
  assert.ok(f.requests.every(r=>r.options.signal.aborted));
});
test('rollback in timestamps requires standby and cannot overwrite last observation', async(t)=>{
  const f=fixture(t);
  let p=f.controller.refresh();
  f.requests[0].resolve(response(snapshot()));
  assert.equal(await p,true);
  p=f.controller.refresh();
  f.requests[1].resolve(response(snapshot(NOW-1000,'outage')));
  await flush();
  f.requests[2].resolve(response(snapshot(NOW-2000,'outage')));
  assert.equal(await p,false);
  assert.equal(f.views.at(-1).updatedAt,stamp(NOW));
  assert.equal(f.views.at(-1).overall,'operational');
  assert.match(f.feedback.at(-1),/last available observation/);
});
for (const action of ['pause','destroy','hidden']) {
  test(action+' cannot let a late snapshot paint', async(t)=>{
    const f=fixture(t);
    const p=f.controller.refresh();
    await f.advance(2000);
    if(action==='hidden') { f.setHidden(true); await f.advance(4000); } else f.controller[action]();
    assert.equal(await p,false);
    f.requests[1].resolve(response(snapshot()));
    await flush();
    assert.equal(f.views.length,0);
    assert.equal(f.timers.size,0);
  });
}
test('resume isolates pending and subsequent request cycles',async(t)=>{
  const f=fixture(t);
  const p=f.controller.refresh();
  f.controller.pause();
  f.controller.resume();
  assert.equal(await p,false);
  await flush();
  assert.equal(f.requests.length,2);
  f.requests[1].resolve(response(snapshot(NOW)));
  await flush();
  f.requests[0].resolve(response(snapshot(NOW+1000,'outage')));
  await flush();
  assert.equal(f.views.at(-1).updatedAt,stamp(NOW));
  assert.equal(f.views.at(-1).overall,'operational');
});
test('restricts sources to known URLs and launches no backup for a fresh result',async(t)=>{
  const f=fixture(t, ['https://invalid.example/', './status.json', SCHEDULED_URL,SCHEDULED_URL]);
  const p=f.controller.refresh();
  f.requests[0].resolve(response(snapshot()));
  assert.equal(await p,true);
  assert.deepEqual(f.requests.map(r=>r.url),[SCHEDULED_URL]);
  assert.deepEqual(resolveStatusDataUrls({querySelector:()=>({content:FALLBACK_URL})}),[FALLBACK_URL,SCHEDULED_URL]);
});
