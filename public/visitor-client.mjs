import { validVisitor, visitorView } from './visitor-model.mjs';

const browserRaw = 'https://raw.githubusercontent.com/Lumichandesu/yomumi-status/main/public/visitor.json';
const httpSnapshot = 'https://yomumi-status-monitor.yomumi.workers.dev/visitor.json';

export function mountVisitorChecks(window, document, fallback) {
  const records = new Map();
  const urls = { github_hosted: fallback ? browserRaw : './visitor.json', cloudflare_public_http: httpSnapshot };
  let controller;
  let disposed = false;
  function render() {
    for (const vantage of Object.keys(urls)) {
      const row = document.getElementById('visitor-' + vantage);
      if (!row) continue;
      const view = visitorView(records.get(vantage), vantage);
      row.className = 'visitor-row status-' + view.state;
      row.querySelector('[data-verdict]').textContent = view.label;
      const time = row.querySelector('time');
      if (view.time) {
        time.dateTime = view.time;
        time.textContent = new Date(view.time).toLocaleString('en-GB', {dateStyle:'medium',timeStyle:'short',timeZone:'UTC'}) + ' UTC';
      } else {
        time.removeAttribute('datetime');
        time.textContent = 'No observation available';
      }
    }
  }
  async function refresh() {
    if (disposed || controller || !document.getElementById('visitor-checks')) return;
    controller = new AbortController();
    const signal = controller.signal;
    const timer = window.setTimeout(() => controller?.abort(), 6000);
    try {
      await Promise.all(Object.entries(urls).map(async ([vantage,url]) => {
        try {
          const response = await window.fetch(url,{signal,redirect:'error',credentials:'omit',cache:'no-store'});
          if (!response.ok) return;
          const observation = await response.json();
          if (disposed || signal.aborted || !validVisitor(observation,vantage)) return;
          const previous = records.get(vantage);
          if (previous?.checkedAt && (!observation.checkedAt || Date.parse(observation.checkedAt)<Date.parse(previous.checkedAt))) return;
          records.set(vantage,observation);
          render();
        } catch { /* The other network's observation remains independent. */ }
      }));
    } finally { window.clearTimeout(timer); controller=undefined; if(!disposed) render(); }
  }
  return {refresh,render,destroy(){ disposed=true; controller?.abort(); }};
}
