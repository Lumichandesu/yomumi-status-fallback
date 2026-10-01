import { COMPONENTS, normalizeTimestamp, validateSnapshot } from '../public/status-model.mjs';
const ids = Object.keys(COMPONENTS);
const reasons = Object.freeze({ timeout: 'The monitor request timed out.', unreachable: 'The monitor could not reach this service.', response_invalid: 'The response did not contain a valid service observation.', probe_blocked: 'The monitor was blocked or rate limited; availability could not be verified.', report_unavailable: 'The dependency report could not be retrieved.', not_configured: 'This check is not configured.', probe_failed: 'The service check failed.', probe_timed_out: 'The service check timed out.', service_probe_passed: 'Service check passed; public access could not be tested by the external monitor.', service_probe_failed: 'Service check failed; public access could not be tested by the external monitor.' });
const iso = (now) => new Date(now).toISOString();
function serviceProbeConfiguration(url, token) {
  if (!url && !token) return null;
  let target;
  try { target = new URL(url); } catch { throw new Error('Invalid service probe configuration'); }
  if (typeof url !== 'string' || target.protocol !== 'https:' || !/^yomumi-status-probe\.[a-z0-9-]+\.workers\.dev$/u.test(target.hostname) || target.port || target.username || target.password || target.search || target.hash || target.pathname !== '/probe' || target.href !== url || typeof token !== 'string' || !/^[a-f0-9]{64}$/iu.test(token)) throw new Error('Invalid service probe configuration');
  return { url: target.href, token };
}
function serviceProbeObservations(result, now) {
  if (result.status !== 'operational' || !result.type.includes('json')) return null;
  let report;
  try { report = JSON.parse(result.text); } catch { return null; }
  const fresh = (timestamp) => {
    const age = now() - Date.parse(timestamp);
    return age >= -60000 && age <= 120000;
  };
  const reportTime = normalizeTimestamp(report?.checkedAt);
  if (report?.schemaVersion !== 1 || report.probe !== 'worker_service_binding' || !reportTime || !fresh(reportTime) || !Array.isArray(report.systems) || report.systems.length !== 2 || new Set(report.systems.map((item) => item?.id)).size !== 2 || !report.systems.every((item) => ['website', 'api'].includes(item?.id))) return null;
  return report.systems.filter((item) => {
    const checkedAt = normalizeTimestamp(item.checkedAt);
    return item.probe === 'worker_service_binding' && checkedAt && fresh(checkedAt) && Number.isFinite(item.latencyMs) && item.latencyMs >= 0 && item.latencyMs <= 120000 && (item.status === 'operational' && ['service_binding_passed', 'probe_succeeded'].includes(item.reasonCode) || item.status === 'outage' && ['service_unavailable', 'probe_failed', 'probe_timed_out'].includes(item.reasonCode));
  }).map((item) => ({ id: item.id, status: item.status, checkedAt: normalizeTimestamp(item.checkedAt), latencyMs: item.latencyMs }));
}
async function limitedText(response, limit, signal) {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0, text = '';
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) return text + decoder.decode();
      bytes += value.byteLength;
      if (bytes > limit) throw new Error('response_invalid');
      text += decoder.decode(value, { stream: true });
    }
  } finally { signal.removeEventListener('abort', cancel); cancel(); reader.releaseLock(); }
}
export async function requestObservation(url, { fetchImpl = fetch, now = Date.now, timeoutMs = 7000, limit = 524288, bearerToken } = {}) {
  const start = now();
  const controller = new AbortController();
  let timer, response;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => { reject(new Error('deadline')); controller.abort(); }, timeoutMs);
  });
  try {
    response = await Promise.race([fetchImpl(url, { signal: controller.signal, redirect: 'manual', headers: { 'User-Agent': 'YomumiStatusProbe/1.0', Accept: 'text/html, application/json', 'Cache-Control': 'no-cache', ...(bearerToken ? { Authorization: `Bearer ${bearerToken}` } : {}) } }), deadline]);
    if ([401, 403, 429].includes(response.status) || response.status >= 300 && response.status < 400) return { status: 'unknown', reasonCode: 'probe_blocked', latencyMs: Math.max(0, now() - start) };
    if (response.status !== 200) return { status: response.status >= 500 ? 'outage' : 'unknown', reasonCode: 'response_invalid', latencyMs: Math.max(0, now() - start) };
    const text = await Promise.race([limitedText(response, limit, controller.signal), deadline]);
    return { status: 'operational', text, type: response.headers.get('content-type') ?? '', latencyMs: Math.max(0, now() - start) };
  } catch (error) {
    const reasonCode = controller.signal.aborted ? 'timeout' : error?.message === 'response_invalid' ? 'response_invalid' : 'unreachable';
    return { status: reasonCode === 'response_invalid' ? 'unknown' : 'outage', reasonCode, latencyMs: Math.min(120000, Math.max(0, now() - start)) };
  } finally { clearTimeout(timer); controller.abort(); void response?.body?.cancel().catch(() => {}); }
}
export async function runChecks({ apiBase, websiteUrl = 'https://yomumi.moe/', publicApiUrl = 'https://yomumi.moe/healthz', serviceProbeUrl, serviceProbeToken, fetchImpl = fetch, now = Date.now, timeoutMs = 7000 } = {}) {
  let base;
  try { base = new URL(apiBase); } catch { throw new Error('Invalid monitor target configuration'); }
  if (base.protocol !== 'https:' || !/^yomumi-api-[a-z0-9-]+\.(?:asia-southeast1\.run\.app|as\.a\.run\.app)$/u.test(base.hostname) || base.port || base.username || base.password || base.search || base.hash || base.pathname !== '/') throw new Error('Invalid monitor target configuration');
  const serviceProbe = serviceProbeConfiguration(serviceProbeUrl, serviceProbeToken);
  const options = { fetchImpl, now, timeoutMs };
  const retry = async (url, limit) => {
    const first = await requestObservation(url, { ...options, limit });
    return first.status === 'outage' ? requestObservation(url, { ...options, limit }) : first;
  };
  const [website, api, dependencies] = await Promise.all([retry(websiteUrl, 1048576), retry(publicApiUrl, 65536), retry(new URL('/api/status', base).href, 65536)]);
  let checkedAt = iso(now());
  const row = (id, result) => ({ id, name: COMPONENTS[id], status: result.status, checkedAt, latencyMs: result.latencyMs ?? null, reason: reasons[result.reasonCode] ?? null });
  if (website.status === 'operational' && (!website.type.includes('text/html') || !/<title[^>]*>[^<]*yomumi/iu.test(website.text ?? '') || /cf-chl-|just a moment/iu.test(website.text ?? ''))) Object.assign(website, { status: 'unknown', reasonCode: 'response_invalid' });
  let apiJson, report;
  try { apiJson = JSON.parse(api.text); } catch {}
  if (api.status === 'operational' && (!api.type.includes('json') || apiJson?.status !== 'healthy' || apiJson.service !== 'yomumi-api')) Object.assign(api, { status: 'unknown', reasonCode: 'response_invalid' });
  try { report = JSON.parse(dependencies.text); } catch {}
  const components = [row('website', website), row('api', api)];
  if (serviceProbe && [website, api].some((result) => result.reasonCode === 'probe_blocked')) {
    const result = await requestObservation(serviceProbe.url, { ...options, limit: 16384, bearerToken: serviceProbe.token });
    const observations = serviceProbeObservations(result, now);
    for (const [id, external] of [['website', website], ['api', api]]) {
      if (external.reasonCode !== 'probe_blocked') continue;
      const service = observations?.find((item) => item.id === id);
      if (service) Object.assign(components.find((component) => component.id === id), row(id, { status: service.status, latencyMs: service.latencyMs, reasonCode: service.status === 'operational' ? 'service_probe_passed' : 'service_probe_failed' }), { checkedAt: service.checkedAt });
    }
    checkedAt = iso(now());
  }
  for (const [id, reportId, probe] of [['database', 'database', 'select_1'], ['cache', 'cache_ratelimit', 'redis_ping']]) {
    const reported = report?.schemaVersion === 2 && report.statusScope === 'measured_components_only' && Array.isArray(report.systems) ? report.systems.filter((v) => v?.id === reportId) : [];
    const observation = reported.length === 1 ? reported[0] : null;
    const observedTimestamp = normalizeTimestamp(observation?.checkedAt);
    const observedTime = observedTimestamp ? Date.parse(observedTimestamp) : NaN;
    const timeValid = Number.isFinite(observedTime) && Math.abs(now() - observedTime) <= 120000;
    const validLatency = Number.isFinite(observation?.latencyMs) && observation.latencyMs >= 0 && observation.latencyMs <= 120000;
    const usable = dependencies.status === 'operational' && dependencies.type?.includes('json') && observation?.monitored === true && observation.observed === true && observation.probe === probe && timeValid && validLatency;
    if (usable && observation.status === 'operational' && observation.observation === 'probe_succeeded') components.push({ ...row(id, { status: 'operational', latencyMs: observation.latencyMs }), checkedAt: iso(observedTime) });
    else if (usable && observation.status === 'degraded' && ['probe_failed', 'probe_timed_out'].includes(observation.observation)) components.push({ ...row(id, { status: 'degraded', latencyMs: observation.latencyMs, reasonCode: observation.observation }), checkedAt: iso(observedTime) });
    else components.push(row(id, { status: 'unknown', reasonCode: observation?.observation === 'not_configured' ? 'not_configured' : dependencies.status === 'operational' ? 'response_invalid' : 'report_unavailable' }));
  }
  return { checkedAt, components };
}
export function recordObservation(previousInput, observation) {
  const previous = validateSnapshot(previousInput);
  if (previousInput != null && !previous) throw new Error('Existing monitor snapshot is invalid');
  const current = validateSnapshot({ schemaVersion: 1, generatedAt: observation?.checkedAt,
    monitor: { startedAt: observation?.checkedAt, intervalSeconds: 900, staleAfterSeconds: 2700 },
    components: observation?.components, history: [], days: [], incidents: [] });
  if (!current) throw new Error('Invalid observation');
  observation = { checkedAt: current.generatedAt, components: current.components };
  const time = Date.parse(observation.checkedAt);
  if (previous && time <= Date.parse(previous.generatedAt)) throw new Error('Non-increasing observation timestamp');
  const date = iso(time).slice(0, 10);
  const days = (previous?.days ?? []).filter((d) => d.date >= iso(time - 89 * 86400000).slice(0, 10) && d.date <= date);
  let day = days.find((v) => v.date === date);
  if (!day) { day = { date, components: ids.map((id) => ({ id, status: 'unknown', checks: 0, passed: 0, failed: 0, unknown: 0 })) }; days.push(day); }
  for (const c of observation.components) {
    const d = day.components.find((v) => v.id === c.id);
    d.checks += 1;
    if (c.status === 'operational') d.passed += 1;
    else if (c.status === 'unknown') d.unknown += 1;
    else d.failed += 1;
    // Unknown cannot hide an actual failure, but prevents an unverified all-green day.
    d.status = d.failed > 0 ? (d.status === 'outage' || c.status === 'outage' ? 'outage' : 'degraded') : d.unknown > 0 ? 'unknown' : 'operational';
  }
  const incidents = (previous?.incidents ?? []).filter((v) => !v.resolvedAt || Date.parse(v.resolvedAt) >= time - 90 * 86400000).map((v) => ({ ...v, updates: [...v.updates] }));
  for (const c of observation.components) {
    const active = incidents.find((v) => v.componentId === c.id && !v.resolvedAt);
    if (['outage', 'degraded'].includes(c.status) && !active) incidents.push({ id: `${c.id}-${time}`, componentId: c.id, title: `${COMPONENTS[c.id]} check failed`, startedAt: observation.checkedAt, resolvedAt: null, updates: [{ at: observation.checkedAt, message: 'The independent monitor observed a failed service check. This is an automated observation.' }] });
    else if (c.status === 'operational' && active) { active.resolvedAt = observation.checkedAt; active.updates.push({ at: observation.checkedAt, message: 'A subsequent service check passed. Availability between checks is not inferred.' }); }
  }
  const active = incidents.filter((incident) => !incident.resolvedAt);
  const resolved = incidents.filter((incident) => incident.resolvedAt).sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, Math.max(0, 100 - active.length));
  const next = { schemaVersion: 1, generatedAt: observation.checkedAt, monitor: { startedAt: previous?.monitor.startedAt ?? observation.checkedAt, intervalSeconds: 900, staleAfterSeconds: 2700 }, components: observation.components, history: [...(previous?.history ?? []).filter((h) => Date.parse(h.checkedAt) >= time - 48 * 3600000), { checkedAt: observation.checkedAt, components: observation.components }].slice(-220), days: days.sort((a, b) => a.date.localeCompare(b.date)), incidents: [...active, ...resolved].sort((a, b) => b.startedAt.localeCompare(a.startedAt)) };
  const validated = validateSnapshot(next);
  if (!validated) throw new Error('Monitor generated invalid snapshot');
  return validated;
}
