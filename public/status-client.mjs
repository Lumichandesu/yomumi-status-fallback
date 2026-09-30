const STATES = new Set(['operational', 'degraded', 'outage', 'unknown']);
const COMPONENT_NAMES = Object.freeze({ website: 'Website', api: 'Public API', database: 'Database', cache: 'Cache' });
const FALLBACK_DATA_URL = 'https://raw.githubusercontent.com/Lumichandesu/yomumi-status/main/public/status.json';
const SCHEDULED_DATA_URL = 'https://yomumi-status-monitor.yomumi.workers.dev/status.json';
const DEFAULT_INTERVAL_MS = 900_000;
const REQUEST_TIMEOUT_MS = 6_000;

const stateClass = (state) => `status-${STATES.has(state) ? state : 'unknown'}`;
const pluralChecks = (count) => `${count.toLocaleString('en-US')} ${count === 1 ? 'check' : 'checks'}`;
const pluralDays = (count) => `${count} ${count === 1 ? 'day' : 'days'}`;

function formatTime(value) {
  const date = new Date(value);
  if (!value || !Number.isFinite(date.getTime())) return 'Not available';
  return new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }).format(date) + ' UTC';
}

function element(document, tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = String(text);
  return node;
}

function setTime(node, value) {
  node.textContent = formatTime(value);
  if (value && Number.isFinite(new Date(value).getTime())) node.setAttribute('datetime', value);
  else node.removeAttribute('datetime');
}

export function resolveStatusDataUrl(document) {
  const configured = document.querySelector('meta[name="status-data-url"]')?.content?.trim();
  // The fallback reads only the primary public status snapshot; never arbitrary URLs or the app API.
  return configured === FALLBACK_DATA_URL ? FALLBACK_DATA_URL : './status.json';
}

export function resolveStatusDataUrls(document) {
  return [resolveStatusDataUrl(document), SCHEDULED_DATA_URL];
}

export function renderStatusView(document, view) {
  const banner = document.getElementById('availability-banner');
  banner.className = `availability-banner ${stateClass(view.overall)}`;
  document.getElementById('overall-label').textContent = view.statusLabel;
  document.getElementById('overall-description').textContent = view.description;
  setTime(document.getElementById('last-updated'), view.updatedAt);

  const componentList = document.getElementById('component-list');
  const components = Array.isArray(view.components) ? view.components : [];
  const rows = Object.entries(COMPONENT_NAMES).map(([id, name]) => {
    const component = components.find((entry) => entry.id === id) ?? { id, statusLabel: 'Status unknown', days: [], observedChecks: 0 };
    const state = component.state ?? component.status;
    const row = element(document, 'article', `component-row ${stateClass(state)}`);
    const heading = element(document, 'div', 'component-heading');
    const status = element(document, 'span', 'component-status');
    const dot = element(document, 'span', 'status-dot');
    dot.setAttribute('aria-hidden', 'true');
    status.append(dot, document.createTextNode(component.statusLabel ?? 'Status unknown'));
    heading.append(element(document, 'h3', null, name), status);
    row.append(heading);
    if (component.reason) row.append(element(document, 'p', 'component-reason', component.reason));

    const days = Array.isArray(component.days) ? component.days.slice(-90) : [];
    const bars = element(document, 'div', days.length ? 'day-bars' : 'day-bars empty-history');
    bars.setAttribute('role', 'img');
    const observedChecks = Number.isSafeInteger(component.observedChecks) && component.observedChecks > 0 ? component.observedChecks : 0;
    const dayCounts = { operational: 0, degraded: 0, outage: 0, unknown: 90 - days.length };
    for (const day of days) dayCounts[day.checks > 0 && STATES.has(day.status) ? day.status : 'unknown'] += 1;
    bars.setAttribute('aria-label', `${name}: 90-day history; ${pluralChecks(observedChecks)} recorded. Operational: ${pluralDays(dayCounts.operational)}; degraded: ${pluralDays(dayCounts.degraded)}; outage: ${pluralDays(dayCounts.outage)}; unknown or missing observations: ${pluralDays(dayCounts.unknown)}.`);
    for (const day of days) {
      const dayState = day.checks > 0 && STATES.has(day.status) ? day.status : 'unknown';
      const bar = element(document, 'span', `day-bar ${stateClass(dayState)}`);
      const dayDescription = dayState !== 'unknown' ? dayState : day.checks > 0 ? 'Unknown or partial observations' : 'No recorded checks';
      const dayLabel = `${day.date}: ${dayDescription}, ${pluralChecks(Number.isSafeInteger(day.checks) && day.checks > 0 ? day.checks : 0)}; ${day.passed ?? 0} passed, ${day.failed ?? 0} failed, ${day.unknown ?? 0} unknown.`;
      bar.setAttribute('title', dayLabel);
      bar.setAttribute('aria-hidden', 'true');
      bars.append(bar);
    }
    row.append(bars);

    const caption = element(document, 'div', 'history-caption');
    const range = element(document, 'span', 'history-range');
    range.append(element(document, 'span', null, '90-day window'), element(document, 'span', null, 'Today'));
    const availability = element(document, 'span', 'observed-availability');
    const percent = component.availabilityPercent;
    if (observedChecks && typeof percent === 'number' && Number.isFinite(percent)) {
      const label = new Intl.NumberFormat('en', { maximumFractionDigits: 2, minimumFractionDigits: percent % 1 ? 2 : 0 }).format(percent);
      availability.append(element(document, 'strong', null, `${label}% checks passed`), document.createTextNode(` · ${pluralChecks(observedChecks)}`));
    } else availability.textContent = 'No usable observations';
    caption.append(range, availability);
    row.append(caption);
    return row;
  });
  componentList.replaceChildren(...rows);

  document.getElementById('monitor-note').textContent = view.startedAt
    ? `Monitor started ${formatTime(view.startedAt)}. Days before monitoring began remain gray.`
    : 'Monitor start time is not available yet.';

  const incidentList = document.getElementById('incident-list');
  const incidents = Array.isArray(view.incidents) ? view.incidents : [];
  if (!incidents.length) {
    incidentList.replaceChildren(element(document, 'p', 'empty-incidents', view.updatedAt
      ? 'No incidents recorded. Reports appear when the monitor observes a service disruption.'
      : 'No incident data available yet.'));
    return;
  }
  incidentList.replaceChildren(...incidents.map((incident) => {
    const article = element(document, 'article', 'incident');
    const header = element(document, 'div', 'incident-header');
    header.append(element(document, 'h3', null, incident.title), element(document, 'span', `incident-state${incident.resolvedAt ? ' resolved' : ''}`, incident.resolvedAt ? 'Resolved' : 'Unresolved'));
    article.append(header);
    const meta = element(document, 'p', 'incident-meta');
    meta.append(element(document, 'span', null, COMPONENT_NAMES[incident.componentId] ?? 'Service'));
    const started = element(document, 'time', null);
    setTime(started, incident.startedAt);
    meta.append(started);
    if (incident.resolvedAt) meta.append(element(document, 'span', null, `Resolved ${formatTime(incident.resolvedAt)}`));
    article.append(meta);
    if (Array.isArray(incident.updates) && incident.updates.length) {
      const details = element(document, 'details', null);
      const count = incident.updates.length;
      details.append(element(document, 'summary', null, `${count} ${count === 1 ? 'update' : 'updates'}`));
      const updates = element(document, 'ol', 'incident-updates');
      for (const update of incident.updates) {
        const item = element(document, 'li', null);
        const time = element(document, 'time', null);
        setTime(time, update.at);
        item.append(time, element(document, 'p', null, update.message));
        updates.append(item);
      }
      details.append(updates);
      article.append(details);
    }
    return article;
  }));
}

export function createStatusController(options) {
  const {
    fetchSnapshot, validateSnapshot, buildView, renderView,
    setFeedback = () => {}, setBusy = () => {}, setIntervalLabel = () => {},
    now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout,
    getHidden = () => false, dataUrl = './status.json', dataUrls = [dataUrl],
  } = options;
  let snapshot = null;
  let updateFailed = false;
  let destroyed = false;
  let paused = false;
  let inFlight = null;
  let pollTimer = null;
  let ageTimer = null;
  let abortController = null;
  let cancelRequest = null;
  let intervalMs = DEFAULT_INTERVAL_MS;

  function render() { renderView(buildView(snapshot, now(), updateFailed)); }
  function stopTimers() {
    if (pollTimer !== null) clearTimer(pollTimer);
    if (ageTimer !== null) clearTimer(ageTimer);
    pollTimer = ageTimer = null;
  }
  function scheduleAge() {
    if (destroyed || paused || getHidden()) return;
    ageTimer = setTimer(() => {
      ageTimer = null;
      if (!destroyed && !paused && !getHidden()) { render(); scheduleAge(); }
    }, 60_000);
  }
  function schedule() {
    stopTimers();
    if (destroyed || paused || getHidden()) return;
    pollTimer = setTimer(() => { pollTimer = null; void refresh(); }, intervalMs);
    scheduleAge();
  }
  function refresh() {
    if (destroyed || paused || getHidden()) return Promise.resolve(false);
    if (inFlight) return inFlight;
    stopTimers();
    setBusy(true);
    setFeedback('Checking status…');
    abortController = new AbortController();
    const requestAbortController = abortController;
    let timeout;
    let cancelled = false;
    const request = new Promise((resolve, reject) => {
      const candidates = [];
      const urls = [...new Set(dataUrls)].filter((url) => ['./status.json', FALLBACK_DATA_URL, SCHEDULED_DATA_URL].includes(url));
      let remaining = urls.length;
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        requestAbortController.abort();
        const newest = candidates.sort((left, right) => (Date.parse(right.generatedAt) || 0) - (Date.parse(left.generatedAt) || 0))[0];
        if (newest) resolve(newest);
        else reject(new Error('No valid status snapshot'));
      };
      cancelRequest = () => { cancelled = true; requestAbortController.abort(); reject(new Error('Request paused')); };
      timeout = setTimer(finish, REQUEST_TIMEOUT_MS);
      if (!remaining) finish();
      for (const url of urls) {
        Promise.resolve().then(() => fetchSnapshot(url, { cache: 'no-store', credentials: 'omit', redirect: 'error', signal: requestAbortController.signal }))
          .then(async (response) => {
            if (!response.ok) throw new Error('Status snapshot unavailable');
            const validated = validateSnapshot(await response.json());
            if (!validated || typeof validated !== 'object') throw new Error('Invalid status snapshot');
            const at = Date.parse(validated.generatedAt);
            if (validated.generatedAt !== null && (!Number.isFinite(at) || at > now() + 60_000)) throw new Error('Invalid observation time');
            if (!settled && !cancelled) candidates.push(validated);
          }).catch(() => {}).finally(() => { remaining -= 1; if (!remaining) finish(); });
      }
    });
    inFlight = request.then((validated) => {
      if (destroyed || cancelled) return false;
      if (snapshot?.generatedAt && (!validated.generatedAt || Date.parse(validated.generatedAt) < Date.parse(snapshot.generatedAt))) throw new Error('Older status snapshot');
      snapshot = validated;
      updateFailed = false;
      const seconds = snapshot.monitor?.intervalSeconds;
      intervalMs = Number.isFinite(seconds) && seconds >= 60 ? seconds * 1_000 : DEFAULT_INTERVAL_MS;
      setIntervalLabel(seconds >= 60 ? seconds : DEFAULT_INTERVAL_MS / 1_000);
      render();
      setFeedback('Status refreshed.');
      return true;
    }).catch(() => {
      if (destroyed || cancelled) return false;
      updateFailed = true;
      render();
      setFeedback(snapshot ? 'Unable to refresh. Showing the last available observation.' : 'Unable to load status. No current observation is available.');
      return false;
    }).finally(() => {
      clearTimer(timeout);
      cancelRequest = null;
      abortController = null;
      inFlight = null;
      if (!destroyed) { setBusy(false); schedule(); }
    });
    return inFlight;
  }
  function pause() {
    paused = true;
    stopTimers();
    cancelRequest?.();
  }
  function resume() {
    if (destroyed || getHidden()) return;
    paused = false;
    render();
    if (inFlight) void inFlight.then(() => { if (!destroyed && !getHidden()) void refresh(); });
    else void refresh();
  }
  function destroy() {
    destroyed = true;
    pause();
  }
  function start() {
    if (destroyed) return;
    paused = getHidden();
    render();
    if (!getHidden()) void refresh();
  }
  return { start, refresh, pause, resume, destroy };
}

export function mountStatusPage(window, document, model) {
  const refreshButton = document.getElementById('refresh-status');
  const observationNote = document.getElementById('observation-note');
  let refreshing = false;
  const controller = createStatusController({
    fetchSnapshot: window.fetch.bind(window),
    validateSnapshot: model.validateSnapshot,
    buildView: model.buildView,
    renderView: (view) => renderStatusView(document, view),
    setFeedback: (message) => { document.getElementById('refresh-feedback').textContent = message; },
    setBusy: (busy) => {
      refreshing = busy;
      // Keep the button in the tab order while waiting, so a keyboard refresh does not lose focus.
      refreshButton.setAttribute('aria-disabled', String(busy));
      refreshButton.setAttribute('aria-busy', String(busy));
    },
    setIntervalLabel: (seconds) => {
      const interval = seconds % 60 === 0 ? `${seconds / 60} minutes` : `${seconds} seconds`;
      observationNote.textContent = `Checks every ${interval}. Percentages use recorded checks, not continuous uptime. Gray marks unknown or missing observations.`;
    },
    getHidden: () => document.hidden,
    dataUrls: resolveStatusDataUrls(document),
    setTimer: window.setTimeout.bind(window),
    clearTimer: window.clearTimeout.bind(window),
  });
  const onRefresh = () => { if (!refreshing) void controller.refresh(); };
  const onVisibility = () => document.hidden ? controller.pause() : controller.resume();
  const onOnline = () => controller.resume();
  const onPageHide = (event) => {
    if (event.persisted) controller.pause();
    else cleanup();
  };
  const onPageShow = (event) => { if (event.persisted) controller.resume(); };
  function cleanup() {
    controller.destroy();
    refreshButton.removeEventListener('click', onRefresh);
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('online', onOnline);
    window.removeEventListener('pagehide', onPageHide);
    window.removeEventListener('pageshow', onPageShow);
  }
  refreshButton.addEventListener('click', onRefresh);
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('online', onOnline);
  window.addEventListener('pagehide', onPageHide);
  window.addEventListener('pageshow', onPageShow);
  controller.start();
  return cleanup;
}

if (typeof window !== 'undefined' && typeof document !== 'undefined' && document.getElementById('status-page')) {
  import('./status-model.mjs').then((model) => mountStatusPage(window, document, model)).catch(() => {
    document.getElementById('refresh-feedback').textContent = 'Status data is unavailable. Please try again later.';
    document.getElementById('refresh-status').disabled = true;
  });
}
