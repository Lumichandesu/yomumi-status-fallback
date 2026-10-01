import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, cp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { COMPONENTS, buildView, normalizeTimestamp, validateSnapshot } from '../public/status-model.mjs';
import { requestObservation, runChecks, recordObservation } from '../scripts/monitor-lib.mjs';

const NOW = Date.parse('2026-09-30T12:00:00.000Z');
const DAY = 86400000;
const API_BASE = 'https://yomumi-api-fixture.asia-southeast1.run.app/';
const SERVICE_PROBE_URL = 'https://yomumi-status-probe.fixture-account.workers.dev/probe';
const SERVICE_PROBE_TOKEN = 'a'.repeat(64);
const serviceConfiguration = { serviceProbeUrl: SERVICE_PROBE_URL, serviceProbeToken: SERVICE_PROBE_TOKEN };
const ids = Object.keys(COMPONENTS);
const stamp = (time) => new Date(time).toISOString();
const clone = (value) => structuredClone(value);
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
const html = (text = '<!doctype html><title>Yomumi — Coming soon</title>', status = 200) => new Response(text, { status, headers: { 'Content-Type': 'text/html' } });
const rows = (time = NOW, states = {}) => ids.map((id) => ({ id, name: COMPONENTS[id], status: states[id] ?? 'operational', checkedAt: stamp(time), latencyMs: 12, reason: null }));
const observe = (time = NOW, states = {}) => ({ checkedAt: stamp(time), components: rows(time, states) });
const row = (value, id) => value.components.find((component) => component.id === id);
function measuredReport(time = NOW) {
  return {
    schemaVersion: 2, statusScope: 'measured_components_only',
    systems: [
      { id: 'database', monitored: true, observed: true, checkedAt: stamp(time), latencyMs: 7, status: 'operational', observation: 'probe_succeeded', probe: 'select_1' },
      { id: 'cache_ratelimit', monitored: true, observed: true, checkedAt: stamp(time), latencyMs: 3, status: 'operational', observation: 'probe_succeeded', probe: 'redis_ping' },
    ],
  };
}
function bindingReport(time = NOW) {
  return { schemaVersion: 1, probe: 'worker_service_binding', checkedAt: stamp(time), systems: ['website', 'api'].map((id) => ({ id, probe: 'worker_service_binding', status: 'operational', checkedAt: stamp(time), latencyMs: id === 'website' ? 13 : 8, reasonCode: 'service_binding_passed' })) };
}
function fixtureFetch({ website = () => html(), api = () => json({ status: 'healthy', service: 'yomumi-api' }), dependencies = () => json(measuredReport()), serviceProbe } = {}) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    const target = new URL(url);
    calls.push({ url: target.href, options });
    assert.equal(options.redirect, 'manual');
    assert.equal(options.headers['User-Agent'], 'YomumiStatusProbe/1.0');
    if (target.href === SERVICE_PROBE_URL && serviceProbe) return serviceProbe(options);
    assert.equal(options.headers.Authorization, undefined, 'the private probe token must never be sent to public or database targets');
    if (target.hostname === 'yomumi.moe' && target.pathname === '/') return website();
    if (target.hostname === 'yomumi.moe' && target.pathname === '/healthz') return api();
    if (target.hostname === 'yomumi-api-fixture.asia-southeast1.run.app' && target.pathname === '/api/status') return dependencies();
    throw new Error('Unexpected fixture target');
  };
  return { calls, fetchImpl };
}
const check = (fixture, extras = {}) => runChecks({ apiBase: API_BASE, fetchImpl: fixture.fetchImpl, now: () => NOW, ...extras });

test('measured schema 2 DB SELECT 1 and Redis PING observations retain their timestamps', async () => {
  const fixture = fixtureFetch({ dependencies: () => json(measuredReport(NOW - 30000)) });
  const observation = await check(fixture);
  assert.deepEqual(observation.components.map(({ id, status }) => ({ id, status })), ids.map((id) => ({ id, status: 'operational' })));
  assert.equal(row(observation, 'database').latencyMs, 7);
  assert.equal(row(observation, 'cache').latencyMs, 3);
  assert.equal(row(observation, 'database').checkedAt, stamp(NOW - 30000));
  assert.equal(row(observation, 'cache').checkedAt, stamp(NOW - 30000));
  assert.equal(observation.checkedAt, stamp(NOW));
  assert.equal(fixture.calls[0].url, 'https://yomumi.moe/');
});

test('legacy hardcoded reports never produce green dependencies or publish their private fields', async () => {
  const legacy = {
    status: 'operational', uptime: '99.99%',
    privateUrl: 'https://fixture-user:fixture-password@private.invalid/',
    systems: [{ id: 'database', status: 'operational', uptime: 100 }, { id: 'cache_ratelimit', status: 'operational', uptime: 100 }],
  };
  const observation = await check(fixtureFetch({ dependencies: () => json(legacy) }));
  assert.equal(row(observation, 'website').status, 'operational');
  assert.equal(row(observation, 'api').status, 'operational');
  assert.equal(row(observation, 'database').status, 'unknown');
  assert.equal(row(observation, 'cache').status, 'unknown');
  const snapshot = recordObservation(null, observation);
  assert.equal(snapshot.incidents.length, 0);
  assert.doesNotMatch(JSON.stringify(snapshot), /private\.invalid|fixture-password|99\.99/);
  assert.equal(buildView(snapshot, NOW).overall, 'unknown');
});

test('blocked and redirected requests are unknown without retry or automatic outage incidents', async () => {
  for (const status of [301, 302, 401, 403, 429]) {
    const result = await requestObservation('https://fixture.invalid/', { fetchImpl: async () => new Response('blocked', { status }), now: () => NOW });
    assert.equal(result.status, 'unknown');
    assert.equal(result.reasonCode, 'probe_blocked');
  }
  const fixture = fixtureFetch({ website: () => html('blocked', 403), api: () => json({}, 429), dependencies: () => json({}, 302) });
  const observation = await check(fixture);
  assert.equal(fixture.calls.length, 3);
  assert.ok(observation.components.every((component) => component.status === 'unknown'));
  assert.equal(recordObservation(null, observation).incidents.length, 0);
});

test('HTTP 200 malformed payloads, wrong contracts, and challenge pages cannot claim availability', async () => {
  const cases = [
    { website: () => html('<title>Just a moment</title><div>cf-chl-fixture</div>') },
    { website: () => new Response('<title>Yomumi</title>', { headers: { 'Content-Type': 'text/plain' } }) },
    { api: () => new Response('{broken', { headers: { 'Content-Type': 'application/json' } }) },
    { api: () => json({ status: 'healthy', service: 'another-service' }) },
    { dependencies: () => new Response('{broken', { headers: { 'Content-Type': 'application/json' } }) },
    { dependencies: () => new Response(JSON.stringify(measuredReport()), { headers: { 'Content-Type': 'text/plain' } }) },
  ];
  for (const setup of cases) {
    const fixture = fixtureFetch(setup);
    const observation = await check(fixture);
    const affected = setup.website ? ['website'] : setup.api ? ['api'] : ['database', 'cache'];
    for (const id of affected) assert.equal(row(observation, id).status, 'unknown');
    assert.equal(fixture.calls.length, 3, 'unverified HTTP 200 content is not an outage retry');
  }
});

test('dependency measurements require unique IDs, verified flags, correct probes, and fresh ISO UTC timestamps', async () => {
  const mutations = [
    (report) => report.systems.push(clone(report.systems[0])),
    (report) => { report.systems[0].observed = false; },
    (report) => { report.systems[0].monitored = false; },
    (report) => { report.systems[0].probe = 'pretend_database'; },
    (report) => { report.systems[0].checkedAt = stamp(NOW - 120001); },
    (report) => { report.systems[0].checkedAt = stamp(NOW + 120001); },
    (report) => { report.systems[0].checkedAt = '2026-09-30 12:00:00'; },
    (report) => { report.systems[0].latencyMs = -1; },
    (report) => { report.systems[0].observation = 'unverified'; },
  ];
  for (const mutate of mutations) {
    const report = measuredReport();
    mutate(report);
    const observation = await check(fixtureFetch({ dependencies: () => json(report) }));
    assert.equal(row(observation, 'database').status, 'unknown');
    assert.equal(row(observation, 'cache').status, 'operational');
  }
  const report = measuredReport();
  Object.assign(report.systems[0], { status: 'degraded', observation: 'probe_timed_out' });
  Object.assign(report.systems[1], { status: 'degraded', observation: 'probe_failed' });
  const observation = await check(fixtureFetch({ dependencies: () => json(report) }));
  assert.equal(row(observation, 'database').status, 'degraded');
  assert.equal(row(observation, 'database').reason, 'The service check timed out.');
  assert.equal(row(observation, 'cache').status, 'degraded');
  assert.equal(row(observation, 'cache').reason, 'The service check failed.');
});

test('response bodies have a byte limit and oversized streams are cancelled', async () => {
  let cancelled = false;
  const result = await requestObservation('https://fixture.invalid/', {
    fetchImpl: async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode('12345')); },
      cancel() { cancelled = true; },
    })), limit: 4, now: () => NOW,
  });
  assert.equal(result.status, 'unknown');
  assert.equal(result.reasonCode, 'response_invalid');
  assert.equal(cancelled, true);
  const exact = await requestObservation('https://fixture.invalid/', { fetchImpl: async () => new Response('1234'), limit: 4, now: () => NOW });
  assert.equal(exact.status, 'operational');
  assert.equal(exact.text, '1234');
});

test('timeouts bound hanging fetch and hanging bodies even when cancellation never resolves', { timeout: 1500 }, async () => {
  let signal;
  const started = Date.now();
  const hangingFetch = await requestObservation('https://fixture.invalid/', {
    fetchImpl: (_url, options) => { signal = options.signal; return new Promise(() => {}); }, timeoutMs: 15,
  });
  assert.equal(hangingFetch.status, 'outage');
  assert.equal(hangingFetch.reasonCode, 'timeout');
  assert.equal(signal.aborted, true);
  let cancelled = false;
  const hangingBody = await requestObservation('https://fixture.invalid/', {
    fetchImpl: async () => new Response(new ReadableStream({ cancel() { cancelled = true; return new Promise(() => {}); } })), timeoutMs: 15,
  });
  assert.equal(hangingBody.status, 'outage');
  assert.equal(hangingBody.reasonCode, 'timeout');
  assert.equal(cancelled, true);
  assert.ok(Date.now() - started < 1000);
});

test('one outage retry can recover without declaring an incident; sustained HTTP 503 produces outage', async () => {
  let attempts = 0;
  const recovering = fixtureFetch({ website: () => ++attempts === 1 ? html('unavailable', 503) : html() });
  const recovered = await check(recovering);
  assert.equal(attempts, 2);
  assert.equal(row(recovered, 'website').status, 'operational');
  assert.equal(recordObservation(null, recovered).incidents.length, 0);
  let failures = 0;
  const sustained = await check(fixtureFetch({ website: () => { failures++; return html('private upstream response', 503); } }));
  assert.equal(failures, 2);
  assert.equal(row(sustained, 'website').status, 'outage');
  assert.equal(recordObservation(null, sustained).incidents.length, 1);
  assert.doesNotMatch(JSON.stringify(sustained), /private upstream response/);
});

test('invalid private target configuration fails generically before any network request', async () => {
  let called = false;
  for (const apiBase of ['private fixture password', 'https://fixture-user:fixture-password@private.invalid/', API_BASE + '?token=fixture-password', API_BASE.replace('.run.app/', '.run.app:8443/')]) {
    await assert.rejects(runChecks({ apiBase, fetchImpl: () => { called = true; throw new Error('unexpected'); } }), { message: 'Invalid monitor target configuration' });
  }
  assert.equal(called, false);
});

test('only blocked external requests may use authenticated service-binding measurements with explicit scope', async () => {
  const fixture = fixtureFetch({ website: () => html('blocked', 403), api: () => json({}, 429), serviceProbe: () => json(bindingReport(NOW - 10000)) });
  const observation = await check(fixture, serviceConfiguration);
  assert.equal(fixture.calls.length, 4);
  const authenticated = fixture.calls.find((call) => call.url === SERVICE_PROBE_URL);
  assert.equal(authenticated.options.headers.Authorization, `Bearer ${SERVICE_PROBE_TOKEN}`);
  assert.equal(authenticated.options.redirect, 'manual');
  assert.equal(authenticated.options.headers['User-Agent'], 'YomumiStatusProbe/1.0');
  for (const id of ['website', 'api']) {
    const component = row(observation, id);
    assert.equal(component.status, 'operational');
    assert.equal(component.checkedAt, stamp(NOW - 10000));
    assert.equal(component.reason, 'Service check passed; public access could not be tested by the external monitor.');
  }
  assert.equal(row(observation, 'website').latencyMs, 13);
  assert.equal(row(observation, 'api').latencyMs, 8);
  assert.equal(row(observation, 'database').status, 'operational');
  assert.equal(row(observation, 'cache').status, 'operational');
  const snapshot = recordObservation(null, observation);
  assert.equal(buildView(snapshot, NOW).overall, 'operational');
  assert.ok(!JSON.stringify(snapshot).includes(SERVICE_PROBE_TOKEN));
  assert.ok(!JSON.stringify(snapshot).includes(SERVICE_PROBE_URL));
});

test('service binding never overrides a real public outage or unverified HTTP 200 content', async () => {
  for (const scenario of [
    { website: () => html('unavailable', 503), api: () => json({}, 403), retained: 'website', expected: 'outage' },
    { website: () => html('<title>wrong content</title>'), api: () => json({}, 403), retained: 'website', expected: 'unknown' },
    { website: () => html('blocked', 403), api: () => json({}, 503), retained: 'api', expected: 'outage' },
  ]) {
    const observation = await check(fixtureFetch({ ...scenario, serviceProbe: () => json(bindingReport()) }), serviceConfiguration);
    assert.equal(row(observation, scenario.retained).status, scenario.expected);
    assert.notEqual(row(observation, scenario.retained).reason, 'Service check passed; public access could not be tested by the external monitor.');
    assert.equal(row(observation, scenario.retained === 'website' ? 'api' : 'website').status, 'operational');
    if (scenario.expected === 'outage') assert.equal(recordObservation(null, observation).incidents.length, 1);
  }
  const healthy = fixtureFetch({ serviceProbe: () => { throw new Error('Service binding must not be queried'); } });
  await check(healthy, serviceConfiguration);
  assert.equal(healthy.calls.length, 3);
});

test('a real external timeout is retained even when the other blocked component has a passing service binding', { timeout: 1500 }, async () => {
  const fixture = fixtureFetch({ website: () => new Promise(() => {}), api: () => json({}, 403), serviceProbe: () => json(bindingReport()) });
  const observation = await check(fixture, { ...serviceConfiguration, timeoutMs: 10 });
  assert.equal(row(observation, 'website').status, 'outage');
  assert.equal(row(observation, 'website').reason, 'The monitor request timed out.');
  assert.equal(row(observation, 'api').status, 'operational');
});

test('binding report schema, markers, duplicate IDs, timestamps, and per-row success evidence are mandatory', async () => {
  const mutations = [
    (report) => { report.schemaVersion = 2; },
    (report) => { delete report.probe; },
    (report) => { report.systems[1].id = 'website'; },
    (report) => { report.systems.push(clone(report.systems[0])); },
    (report) => { report.checkedAt = stamp(NOW - 120001); },
    (report) => { report.checkedAt = stamp(NOW + 60001); },
    (report) => { report.systems[0].checkedAt = stamp(NOW - 120001); },
    (report) => { report.systems[0].checkedAt = '2026-09-30 12:00:00'; },
    (report) => { delete report.systems[0].probe; },
    (report) => { report.systems[0].reasonCode = 'pretend_success'; },
    (report) => { report.systems[0].latencyMs = -1; },
    (report) => { report.systems[0].status = 'unknown'; },
  ];
  for (const mutate of mutations) {
    const report = bindingReport();
    mutate(report);
    const fixture = fixtureFetch({ website: () => html('blocked', 403), api: () => json({}, 403), serviceProbe: () => json(report) });
    const observation = await check(fixture, serviceConfiguration);
    assert.equal(row(observation, 'website').status, 'unknown');
    assert.notEqual(buildView(recordObservation(null, observation), NOW).overall, 'operational');
  }
});

test('a measured binding failure may declare an outage but unknown cannot resolve an existing incident', async () => {
  const report = bindingReport();
  Object.assign(report.systems[0], { status: 'outage', reasonCode: 'service_unavailable' });
  const setup = (serviceProbe) => fixtureFetch({ website: () => html('blocked', 403), api: () => json({}, 403), serviceProbe });
  const failure = await check(setup(() => json(report)), serviceConfiguration);
  assert.equal(row(failure, 'website').status, 'outage');
  assert.equal(row(failure, 'website').reason, 'Service check failed; public access could not be tested by the external monitor.');
  let snapshot = recordObservation(null, failure);
  assert.equal(snapshot.incidents.length, 1);
  const unknownReport = bindingReport(NOW + 1000);
  Object.assign(unknownReport.systems[0], { status: 'unknown', reasonCode: 'response_invalid' });
  const unknown = await check(setup(() => json(unknownReport)), { ...serviceConfiguration, now: () => NOW + 1000 });
  snapshot = recordObservation(snapshot, unknown);
  assert.equal(snapshot.incidents[0].resolvedAt, null);
});

test('invalid optional binding configuration fails generically before network and never leaks supplied secrets', async () => {
  let called = false;
  const cases = [
    { serviceProbeUrl: SERVICE_PROBE_URL },
    { serviceProbeToken: SERVICE_PROBE_TOKEN },
    { ...serviceConfiguration, serviceProbeToken: 'fixture-password' },
    { ...serviceConfiguration, serviceProbeToken: SERVICE_PROBE_TOKEN + 'a' },
    { ...serviceConfiguration, serviceProbeUrl: SERVICE_PROBE_URL.replace('https:', 'http:') },
    { ...serviceConfiguration, serviceProbeUrl: 'https://private.invalid/probe' },
    { ...serviceConfiguration, serviceProbeUrl: SERVICE_PROBE_URL.replace('yomumi-status-probe.', 'another-worker.') },
    { ...serviceConfiguration, serviceProbeUrl: SERVICE_PROBE_URL + '?token=fixture-password' },
    { ...serviceConfiguration, serviceProbeUrl: SERVICE_PROBE_URL + '#fixture-password' },
    { ...serviceConfiguration, serviceProbeUrl: SERVICE_PROBE_URL.replace('/probe', '/arbitrary') },
    { ...serviceConfiguration, serviceProbeUrl: SERVICE_PROBE_URL.replace('https://', 'https://fixture-user:fixture-password@') },
    { ...serviceConfiguration, serviceProbeUrl: SERVICE_PROBE_URL.replace('/probe', ':8443/probe') },
  ];
  for (const configuration of cases) await assert.rejects(runChecks({ apiBase: API_BASE, fetchImpl: () => { called = true; }, ...configuration }), { message: 'Invalid service probe configuration' });
  assert.equal(called, false);
  const disabled = fixtureFetch({ website: () => html('blocked', 403), api: () => json({}, 403) });
  const observation = await check(disabled);
  assert.equal(disabled.calls.length, 3);
  assert.equal(row(observation, 'website').status, 'unknown');
});

test('unauthorized, redirected, malformed, oversized, and hanging authenticated responses remain unknown', { timeout: 1500 }, async () => {
  const cases = [
    () => json({}, 401),
    () => json({}, 403),
    () => json({}, 302),
    () => new Response('{broken', { headers: { 'Content-Type': 'application/json' } }),
    () => new Response(JSON.stringify(bindingReport()), { headers: { 'Content-Type': 'text/plain' } }),
    () => json({ ...bindingReport(), privatePayload: 'z'.repeat(16384) }),
    () => new Promise(() => {}),
    () => new Response(new ReadableStream({ cancel() { return new Promise(() => {}); } })),
  ];
  for (const serviceProbe of cases) {
    const fixture = fixtureFetch({ website: () => html('blocked', 403), api: () => json({}, 403), serviceProbe });
    const observation = await check(fixture, { ...serviceConfiguration, timeoutMs: 10 });
    assert.equal(row(observation, 'website').status, 'unknown');
    assert.equal(row(observation, 'api').status, 'unknown');
    assert.equal(fixture.calls.filter((call) => call.url === SERVICE_PROBE_URL).length, 1);
    assert.ok(!JSON.stringify(observation).includes(SERVICE_PROBE_TOKEN));
  }
});

test('initial history has only observed checks and 90-day missing dates stay unknown', () => {
  const snapshot = recordObservation(null, observe());
  const view = buildView(snapshot, NOW);
  assert.equal(snapshot.days.length, 1);
  assert.equal(snapshot.history.length, 1);
  assert.equal(view.startedAt, stamp(NOW));
  for (const component of view.components) {
    assert.equal(component.days.length, 90);
    assert.equal(component.days.filter((day) => day.status === 'unknown').length, 89);
    assert.equal(component.observedChecks, 1);
    assert.equal(component.availabilityPercent, 100);
    assert.equal(component.days.at(-1).checks, 1);
  }
  const empty = buildView(null, NOW);
  assert.equal(empty.overall, 'unknown');
  assert.ok(empty.components.every((component) => component.availabilityPercent === null && component.observedChecks === 0 && component.days.every((day) => day.status === 'unknown' && day.checks === 0)));
});

test('availability is the observed passing-check percentage, excludes unknown, and preserves daily failures', () => {
  let snapshot = recordObservation(null, observe(NOW));
  for (let index = 1; index < 5; index++) snapshot = recordObservation(snapshot, observe(NOW + index * 1000, { website: index === 1 ? 'degraded' : index === 2 ? 'unknown' : 'operational' }));
  const website = row(buildView(snapshot, NOW + 4000), 'website');
  assert.equal(website.status, 'operational');
  assert.equal(website.availabilityPercent, 75);
  assert.equal(website.observedChecks, 4);
  assert.deepEqual(website.days.at(-1), { date: '2026-09-30', status: 'degraded', checks: 5, passed: 3, failed: 1, unknown: 1 });
});

test('an automatic incident stays open through unknown and repeated failure, then resolves on measured recovery', () => {
  let snapshot = recordObservation(null, observe(NOW, { website: 'outage', database: 'degraded' }));
  assert.equal(snapshot.incidents.length, 2);
  assert.ok(snapshot.incidents.every((incident) => incident.resolvedAt === null && /automated observation/i.test(incident.updates[0].message)));
  snapshot = recordObservation(snapshot, observe(NOW + 1000, { website: 'unknown', database: 'unknown' }));
  assert.ok(snapshot.incidents.every((incident) => incident.resolvedAt === null));
  snapshot = recordObservation(snapshot, observe(NOW + 2000, { website: 'outage', database: 'degraded' }));
  assert.equal(snapshot.incidents.length, 2);
  snapshot = recordObservation(snapshot, observe(NOW + 3000));
  assert.ok(snapshot.incidents.every((incident) => incident.resolvedAt === stamp(NOW + 3000) && incident.updates.length === 2 && /between checks is not inferred/i.test(incident.updates[1].message)));
});

test('incident retention keeps old unresolved incidents before trimming newer resolved incidents', () => {
  const snapshot = recordObservation(null, observe(NOW, { website: 'unknown' }));
  const active = { id: 'long-running-outage', componentId: 'website', title: 'Website check failed', startedAt: stamp(NOW - 120 * DAY), resolvedAt: null, updates: [] };
  snapshot.incidents = [active, ...Array.from({ length: 99 }, (_, index) => ({ id: `resolved-${index}`, componentId: 'api', title: 'API check failed', startedAt: stamp(NOW - 100000 + index), resolvedAt: stamp(NOW - 50000 + index), updates: [] }))];
  assert.ok(validateSnapshot(snapshot));
  const next = recordObservation(snapshot, observe(NOW + 1000, { website: 'unknown', database: 'degraded' }));
  assert.equal(next.incidents.length, 100);
  assert.ok(next.incidents.some((incident) => incident.id === active.id && incident.resolvedAt === null));
  assert.ok(next.incidents.some((incident) => incident.componentId === 'database' && incident.resolvedAt === null));
  assert.ok(!next.incidents.some((incident) => incident.id === 'resolved-0'));
});

test('calendar retention is bounded to 90 actual days and 48-hour samples without inventing skipped days', () => {
  let snapshot = null;
  const start = NOW - 90 * DAY;
  for (let index = 0; index <= 90; index++) snapshot = recordObservation(snapshot, observe(start + index * DAY));
  assert.equal(snapshot.days.length, 90);
  assert.equal(snapshot.days[0].date, stamp(start + DAY).slice(0, 10));
  assert.equal(snapshot.history.length, 3);
  assert.equal(snapshot.monitor.startedAt, stamp(start));
  let skipped = recordObservation(null, observe(NOW - 3 * DAY));
  skipped = recordObservation(skipped, observe(NOW));
  assert.equal(skipped.days.length, 2);
  const days = row(buildView(skipped, NOW), 'website').days;
  assert.equal(days.at(-2).status, 'unknown');
  assert.equal(days.at(-2).checks, 0);
  assert.equal(days.at(-3).status, 'unknown');
  assert.equal(days.reduce((total, day) => total + day.checks, 0), 2);
});

test('stale component and stale or future snapshots become unknown without erasing observed history', () => {
  const snapshot = recordObservation(null, observe());
  snapshot.components.find((component) => component.id === 'database').checkedAt = stamp(NOW - 2700001);
  const partial = buildView(snapshot, NOW);
  assert.equal(partial.overall, 'unknown');
  assert.equal(row(partial, 'database').status, 'unknown');
  assert.equal(row(partial, 'database').latencyMs, null);
  assert.equal(row(partial, 'api').status, 'operational');
  const stale = buildView(snapshot, NOW + 2700001);
  assert.ok(stale.components.every((component) => component.status === 'unknown' && component.latencyMs === null));
  assert.equal(row(stale, 'website').availabilityPercent, 100);
  assert.equal(row(stale, 'website').observedChecks, 1);
  const future = buildView(recordObservation(null, observe(NOW + 60001)), NOW);
  assert.equal(future.overall, 'unknown');
  assert.match(future.description, /not current/i);
  const refreshFailure = buildView(recordObservation(null, observe()), NOW, true);
  assert.equal(refreshFailure.overall, 'operational');
  assert.match(refreshFailure.description, /last recorded observation/i);
});

test('strict UTC timestamp validation rejects Date.parse shortcuts and invalid calendar dates', () => {
  for (const value of ['1', '2026-09-30', '2026-09-30 12:00:00', '2026-02-30T12:00:00Z', '2026-09-30T12:00:00+00:00', '2026-09-30T25:00:00Z']) assert.equal(normalizeTimestamp(value), null);
  assert.equal(normalizeTimestamp('2026-09-30T12:00:00Z'), stamp(NOW));
  assert.equal(normalizeTimestamp(stamp(NOW)), stamp(NOW));
  const snapshot = recordObservation(null, observe());
  for (const field of ['generatedAt', 'startedAt', 'checkedAt']) {
    const invalid = clone(snapshot);
    if (field === 'generatedAt') invalid.generatedAt = '1';
    else if (field === 'startedAt') invalid.monitor.startedAt = '1';
    else invalid.components[0].checkedAt = '1';
    assert.equal(validateSnapshot(invalid), null);
  }
  const invalidDate = clone(snapshot);
  invalidDate.days[0].date = '2026-02-30';
  assert.equal(validateSnapshot(invalidDate), null);
});

test('invalid saved snapshots and observations fail closed without mutating existing history', () => {
  assert.throws(() => recordObservation({ schemaVersion: 1 }, observe()), /Existing monitor snapshot is invalid/);
  const observation = observe();
  observation.components[1].id = 'website';
  assert.throws(() => recordObservation(null, observation), /Invalid observation/);
  const snapshot = recordObservation(null, observe());
  const before = JSON.stringify(snapshot);
  assert.throws(() => recordObservation(snapshot, observe(NOW)), /Non-increasing/);
  assert.throws(() => recordObservation(snapshot, observe(NOW - 1000)), /Non-increasing/);
  recordObservation(snapshot, observe(NOW + 1000, { website: 'outage' }));
  assert.equal(JSON.stringify(snapshot), before);
  const extra = clone(snapshot);
  extra.providerToken = 'fixture-private';
  extra.components[0].privateUrl = 'https://private.invalid/';
  assert.doesNotMatch(JSON.stringify(validateSnapshot(extra)), /fixture-private|private\.invalid/);
});

test('primary and fallback builds enforce scoped CSP and publish only their intended data source', async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), 'yomumi-status-fixture-'));
  const sourceRoot = fileURLToPath(new URL('../', import.meta.url));
  try {
    await mkdir(join(fixtureRoot, 'scripts'));
    await mkdir(join(fixtureRoot, 'public'));
    await cp(join(sourceRoot, 'scripts/build.mjs'), join(fixtureRoot, 'scripts/build.mjs'));
    for (const name of ['index.html', 'status.css', 'status-client.mjs', 'status-model.mjs']) await cp(join(sourceRoot, 'public', name), join(fixtureRoot, 'public', name));
    await writeFile(join(fixtureRoot, 'public/status.json'), JSON.stringify(recordObservation(null, observe())));
    const runBuild = (fallback = '') => promisify(execFile)(process.env.BUN_BIN || 'bun', ['--no-env-file', 'run', join(fixtureRoot, 'scripts/build.mjs')], { env: { ...process.env, STATUS_DATA_URL: fallback }, timeout: 10000 });
    await runBuild();
    const primary = await readFile(join(fixtureRoot, 'dist/index.html'), 'utf8');
    assert.match(primary, /http-equiv="Content-Security-Policy"/);
    const scheduledUrl = 'https://yomumi-status-monitor.yomumi.workers.dev/status.json';
    assert.ok(primary.includes(`default-src 'none'; style-src 'self'; script-src 'self'; connect-src 'self' ${scheduledUrl}; base-uri 'none'; form-action 'none'; object-src 'none'; img-src 'none'`));
    assert.match(primary, /name="status-data-url" content="\.\/status\.json"/);
    assert.equal(await readFile(join(fixtureRoot, 'dist/CNAME'), 'utf8'), 'status.yomumi.moe\n');
    assert.ok(validateSnapshot(JSON.parse(await readFile(join(fixtureRoot, 'dist/status.json'), 'utf8'))));
    const fallbackUrl = 'https://raw.githubusercontent.com/Lumichandesu/yomumi-status/main/public/status.json';
    await runBuild(fallbackUrl);
    const fallback = await readFile(join(fixtureRoot, 'dist/index.html'), 'utf8');
    assert.ok(fallback.includes(`connect-src 'self' ${scheduledUrl} ${fallbackUrl};`));
    assert.ok(fallback.includes(`name="status-data-url" content="${fallbackUrl}"`));
    await assert.rejects(readFile(join(fixtureRoot, 'dist/CNAME')), { code: 'ENOENT' });
    await assert.rejects(readFile(join(fixtureRoot, 'dist/status.json')), { code: 'ENOENT' });
    await assert.rejects(runBuild('https://private.invalid/fixture-token'));
    assert.equal(await readFile(join(fixtureRoot, 'dist/index.html'), 'utf8'), fallback, 'invalid configuration must fail before deleting an existing build');
  } finally {
    const temporaryBase = resolve(tmpdir());
    const ownedPath = resolve(fixtureRoot);
    assert.ok(relative(temporaryBase, ownedPath).startsWith('yomumi-status-fixture-'));
    await rm(ownedPath, { recursive: true, force: true });
  }
});
