export const COMPONENTS = Object.freeze({ website: 'Website', api: 'Public API', database: 'Database', cache: 'Cache' });
export const STATES = Object.freeze(['operational', 'degraded', 'outage', 'unknown']);
const ids = Object.keys(COMPONENTS);
export const normalizeTimestamp = (v) => {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(v) || !Number.isFinite(Date.parse(v))) return null;
  const normalized = new Date(v).toISOString();
  return normalized === (v.includes('.') ? v : v.replace('Z', '.000Z')) ? normalized : null;
};
const iso = normalizeTimestamp;
const integer = (v, max = 10000000) => Number.isSafeInteger(v) && v >= 0 && v <= max;
const safeText = (v, max) => typeof v === 'string' && v.length <= max && !/[\u0000-\u001f<>]/u.test(v);
export function worstStatus(states) {
  if (states.includes('outage')) return 'outage';
  if (states.includes('degraded')) return 'degraded';
  if (states.includes('unknown') || states.length === 0) return 'unknown';
  return 'operational';
}
function observation(v, full = false) {
  if (!v || !ids.includes(v.id) || !STATES.includes(v.status)) return null;
  if (v.latencyMs != null && !(Number.isFinite(v.latencyMs) && v.latencyMs >= 0 && v.latencyMs <= 120000)) return null;
  if (v.reason != null && !safeText(v.reason, 180)) return null;
  const result = { id: v.id, status: v.status, latencyMs: v.latencyMs ?? null, reason: v.reason ?? null };
  if (full) {
    if (v.checkedAt != null && !iso(v.checkedAt)) return null;
    result.checkedAt = iso(v.checkedAt);
    result.name = COMPONENTS[v.id];
  }
  return result;
}
function uniqueComponents(values, full = false) {
  if (!Array.isArray(values) || values.length !== ids.length) return null;
  const parsed = values.map((v) => observation(v, full));
  return parsed.every(Boolean) && new Set(parsed.map((v) => v.id)).size === ids.length ? parsed : null;
}
export function validateSnapshot(input) {
  if (!input || input.schemaVersion !== 1 || !iso(input.generatedAt) || !input.monitor || !iso(input.monitor.startedAt)) return null;
  const { intervalSeconds, staleAfterSeconds } = input.monitor;
  if (!integer(intervalSeconds, 86400) || intervalSeconds < 300 || !integer(staleAfterSeconds, 172800) || staleAfterSeconds < intervalSeconds) return null;
  const components = uniqueComponents(input.components, true);
  if (!components || !Array.isArray(input.history) || input.history.length > 220 || !Array.isArray(input.days) || input.days.length > 90 || !Array.isArray(input.incidents) || input.incidents.length > 100) return null;
  const history = [];
  for (const item of input.history) {
    const components = uniqueComponents(item?.components);
    if (!iso(item?.checkedAt) || !components) return null;
    history.push({ checkedAt: iso(item.checkedAt), components });
  }
  const days = [];
  for (const item of input.days) {
    if (!item || !/^\d{4}-\d{2}-\d{2}$/u.test(item.date) || iso(`${item.date}T00:00:00.000Z`)?.slice(0, 10) !== item.date || !Array.isArray(item.components) || item.components.length !== ids.length) return null;
    const components = [];
    for (const c of item.components) {
      if (!ids.includes(c?.id) || !STATES.includes(c.status) || !['checks', 'passed', 'failed', 'unknown'].every((k) => integer(c[k])) || c.checks !== c.passed + c.failed + c.unknown) return null;
      const expected = c.failed > 0 ? (c.status === 'outage' ? 'outage' : 'degraded') : c.unknown > 0 || c.checks === 0 ? 'unknown' : 'operational';
      if (c.status !== expected) return null;
      components.push({ id: c.id, status: c.status, checks: c.checks, passed: c.passed, failed: c.failed, unknown: c.unknown });
    }
    if (new Set(components.map((c) => c.id)).size !== ids.length) return null;
    days.push({ date: item.date, components });
  }
  if (new Set(days.map((v) => v.date)).size !== days.length) return null;
  const incidents = [];
  for (const item of input.incidents) {
    if (!item || !safeText(item.id, 100) || !ids.includes(item.componentId) || !safeText(item.title, 180) || !iso(item.startedAt) || (item.resolvedAt != null && (!iso(item.resolvedAt) || Date.parse(item.resolvedAt) < Date.parse(item.startedAt))) || !Array.isArray(item.updates) || item.updates.length > 12) return null;
    const updates = [];
    for (const u of item.updates) {
      if (!iso(u?.at) || !safeText(u.message, 360)) return null;
      updates.push({ at: iso(u.at), message: u.message });
    }
    incidents.push({ id: item.id, componentId: item.componentId, title: item.title, startedAt: iso(item.startedAt), resolvedAt: iso(item.resolvedAt), updates });
  }
  if (new Set(incidents.map((v) => v.id)).size !== incidents.length) return null;
  return { schemaVersion: 1, generatedAt: iso(input.generatedAt), monitor: { startedAt: iso(input.monitor.startedAt), intervalSeconds, staleAfterSeconds }, components, history, days: days.sort((a, b) => a.date.localeCompare(b.date)), incidents };
}
const labels = { operational: 'Operational', degraded: 'Degraded', outage: 'Unavailable', unknown: 'Status unknown' };
export function buildView(snapshot, now = Date.now(), updateFailed = false) {
  const parsed = validateSnapshot(snapshot);
  const age = parsed ? now - Date.parse(parsed.generatedAt) : Infinity;
  const stale = !parsed || age > parsed.monitor.staleAfterSeconds * 1000 || age < -60000;
  const dates = Array.from({ length: 90 }, (_, i) => new Date(Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), new Date(now).getUTCDate()) - (89 - i) * 86400000).toISOString().slice(0, 10));
  const components = ids.map((id) => {
    const c = parsed?.components.find((v) => v.id === id);
    const componentStale = !c?.checkedAt || now - Date.parse(c.checkedAt) > (parsed?.monitor.staleAfterSeconds ?? 2700) * 1000 || Date.parse(c.checkedAt) > now + 60000;
    const status = stale || componentStale ? 'unknown' : c.status;
    const days = dates.map((date) => {
      const d = parsed?.days.find((v) => v.date === date)?.components.find((v) => v.id === id);
      return { date, status: d?.status ?? 'unknown', checks: d?.checks ?? 0, passed: d?.passed ?? 0, failed: d?.failed ?? 0, unknown: d?.unknown ?? 0 };
    });
    const passed = days.reduce((n, d) => n + d.passed, 0);
    const observedChecks = passed + days.reduce((n, d) => n + d.failed, 0);
    return { id, name: COMPONENTS[id], status, state: status, statusLabel: labels[status], checkedAt: c?.checkedAt ?? null, latencyMs: stale || componentStale ? null : c?.latencyMs ?? null, reason: stale ? 'No current monitor observation.' : componentStale ? 'No current component observation.' : c.reason, days, observedChecks, availabilityPercent: observedChecks ? passed / observedChecks * 100 : null };
  });
  const overall = worstStatus(components.map((c) => c.status));
  const statusLabel = overall === 'operational' ? 'All monitored services operational' : overall === 'outage' ? 'Some services unavailable' : overall === 'degraded' ? 'Some services degraded' : 'Status unknown';
  const description = stale ? (parsed ? 'Monitoring data is not current. Current availability is unknown.' : 'Waiting for the first independent monitor observation.') : updateFailed ? 'Showing the last recorded observation; the latest refresh could not be retrieved.' : overall === 'operational' ? 'The most recent recorded checks passed.' : overall === 'unknown' ? 'One or more services could not be verified by the latest checks.' : 'The monitor observed a service failure. See individual services below.';
  return { overall, statusLabel, description, updatedAt: parsed?.generatedAt ?? null, startedAt: parsed?.monitor.startedAt ?? null, components, incidents: parsed?.incidents ?? [] };
}
