export const VISITOR_STALE_MS = 45 * 60_000;
const states = { coming_soon: 'operational', unexpected_page: 'degraded', challenge: 'unknown', unavailable: 'outage', unverified: 'unknown' };
const labels = { coming_soon: 'Coming Soon verified', unexpected_page: 'Unexpected page', challenge: 'Access challenge', unavailable: 'Unreachable', unverified: 'Unverified' };
export const visitorSources = {
  github_hosted: { label: 'External browser', detail: 'Signed-out Chrome on a GitHub-hosted runner.' },
  cloudflare_public_http: { label: 'External HTTP check', detail: 'A public Internet request from the Cloudflare monitor.' },
};
export function visitorObservation(vantage, result, checkedAt) {
  return { schemaVersion: 1, checkedAt, status: states[result], result, vantage };
}
export function validVisitor(value, vantage, now = Date.now()) {
  if (!Object.hasOwn(visitorSources, vantage) || value?.schemaVersion !== 1 || Object.keys(value).length !== 5 || value.vantage !== vantage ||
      !Object.hasOwn(states, value.result) || states[value.result] !== value.status) return false;
  if (value.checkedAt === null) return value.result === 'unverified';
  if (typeof value.checkedAt !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value.checkedAt)) return false;
  const time = Date.parse(value.checkedAt);
  return Number.isFinite(time) && new Date(time).toISOString() === value.checkedAt && time <= now + 60_000;
}
export function visitorView(value, vantage, now = Date.now()) {
  if (!validVisitor(value, vantage, now) || !value.checkedAt) return { state: 'unknown', label: 'Awaiting observation', time: null };
  const stale = now - Date.parse(value.checkedAt) > VISITOR_STALE_MS;
  return { state: stale ? 'unknown' : value.status, label: stale ? 'Observation expired' : labels[value.result], time: value.checkedAt };
}
