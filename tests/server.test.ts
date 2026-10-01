import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { createStatusServer } from '../src/server';
import { validateSnapshot } from '../public/status-model.mjs';

const worker = 'https://yomumi-status-monitor.yomumi.workers.dev/status.json';
const fallback = 'https://raw.githubusercontent.com/Lumichandesu/yomumi-status/main/public/status.json';
const css = '/assets/index-12345678.css';
const js = '/assets/index-abcdefgh.js';
const fixtures: string[] = [];

async function fixture(isFallback = false) {
  const directory = await mkdtemp(join(tmpdir(), 'yomumi-status-server-'));
  fixtures.push(directory);
  await mkdir(join(directory, 'assets'));
  const policy = `default-src 'none'; style-src 'self'; script-src 'self'; connect-src 'self' ${worker}${isFallback ? ` ${fallback}` : ''}; base-uri 'none'; form-action 'none'; object-src 'none'; img-src 'none'`;
  const html = `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${policy}"><link rel="stylesheet" href=".${css}"><script type="module" src=".${js}"></script></head><body>สถานะที่ยังไม่ทราบ</body></html>`;
  // Explicitly unobserved test data: no invented healthy service or uptime.
  const snapshot = validateSnapshot({
    schemaVersion: 1, generatedAt: '2026-10-01T00:00:00.000Z',
    monitor: { startedAt: '2026-10-01T00:00:00.000Z', intervalSeconds: 900, staleAfterSeconds: 2700 },
    components: ['website', 'api', 'database', 'cache'].map((id) => ({ id, status: 'unknown', checkedAt: null, latencyMs: null, reason: 'Fixture: no observation.' })),
    history: [], days: [], incidents: [],
  });
  await Promise.all([
    writeFile(join(directory, 'index.html'), html),
    writeFile(join(directory, css), 'body { color: #333 }'),
    writeFile(join(directory, js), 'export const fixture = true;'),
    writeFile(join(directory, 'robots.txt'), 'User-agent: *\nAllow: /\n'),
    writeFile(join(directory, 'status.json'), JSON.stringify(snapshot)),
    writeFile(join(directory, '.env'), 'PRIVATE_FIXTURE_SECRET=must-not-be-served'),
    writeFile(join(directory, 'assets/index-unlisted.js'), 'must-not-be-served'),
  ]);
  return { directory, html, snapshot, policy };
}

afterEach(async () => {
  for (const directory of fixtures.splice(0)) {
    const absolute = await realpath(directory);
    const within = relative(await realpath(tmpdir()), absolute);
    if (!within.startsWith('yomumi-status-server-') || within.includes('..') || isAbsolute(within)) throw new Error('Invalid fixture cleanup target');
    await rm(absolute, { recursive: true, force: true });
  }
});

const request = (path: string, init?: RequestInit) => new Request(`http://127.0.0.1:4331${path}`, init);

describe('independent Bun + Elysia status server', () => {
  test('GET and HEAD serve preloaded built bytes with correct UTF-8 size and no listening socket', async () => {
    const data = await fixture();
    const app = await createStatusServer({ directory: data.directory });
    expect(app.server == null).toBe(true);
    const get = await app.handle(request('/'));
    expect(get.status).toBe(200);
    expect(await get.text()).toBe(data.html);
    expect(get.headers.get('Content-Length')).toBe(String(new TextEncoder().encode(data.html).length));
    expect(get.headers.get('Content-Type')).toBe('text/html; charset=utf-8');
    expect(get.headers.get('Cache-Control')).toBe('no-cache');
    const head = await app.handle(request('/index.html', { method: 'HEAD' }));
    expect(head.status).toBe(200);
    expect(await head.text()).toBe('');
    expect(head.headers.get('Content-Length')).toBe(get.headers.get('Content-Length'));
    expect(head.headers.get('ETag')).toBe(get.headers.get('ETag'));
    await writeFile(join(data.directory, 'index.html'), 'changed on disk');
    expect(await (await app.handle(request('/'))).text()).toBe(data.html);
  });

  test('conditional GET and HEAD support weak, list and wildcard validators without a response body', async () => {
    const data = await fixture();
    const app = await createStatusServer({ directory: data.directory });
    const get = await app.handle(request(css));
    const etag = get.headers.get('ETag')!;
    expect(etag).toMatch(/^"[a-f0-9]{64}"$/u);
    for (const validator of [etag, `W/${etag}`, `"other", W/${etag}`, '*']) {
      for (const method of ['GET', 'HEAD']) {
        const response = await app.handle(request(css, { method, headers: { 'If-None-Match': validator } }));
        expect(response.status).toBe(304);
        expect(await response.text()).toBe('');
        expect(response.headers.get('ETag')).toBe(etag);
        expect(response.headers.get('Content-Length')).toBeNull();
        expect(response.headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable');
      }
    }
    expect((await app.handle(request(css, { headers: { 'If-None-Match': '"different"' } }))).status).toBe(200);
    expect((await app.handle(request(js))).headers.get('Content-Type')).toBe('text/javascript; charset=utf-8');
  });

  test('status snapshot is validated, no-store and read-only; no request starts probes or proxy fetches', async () => {
    const data = await fixture();
    const app = await createStatusServer({ directory: data.directory });
    const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(() => { throw new Error('No network permitted by fixture'); });
    try {
      const response = await app.handle(request('/status.json?url=https://private.invalid/probe'));
      expect(response.status).toBe(200);
      expect(response.headers.get('Cache-Control')).toBe('no-store');
      expect(await response.json()).toEqual(data.snapshot);
      const etag = response.headers.get('ETag')!;
      const unchanged = await app.handle(request('/status.json', { headers: { 'If-None-Match': etag } }));
      expect(unchanged.status).toBe(304);
      expect(unchanged.headers.get('Cache-Control')).toBe('no-store');
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally { fetchSpy.mockRestore(); }
  });

  test('security headers match static CSP and do not add cookies or permissive CORS', async () => {
    const data = await fixture();
    const app = await createStatusServer({ directory: data.directory });
    for (const path of ['/', css, js, '/status.json', '/robots.txt', '/missing']) {
      const response = await app.handle(request(path, { headers: { Origin: 'https://untrusted.invalid' } }));
      expect(response.headers.get('Content-Security-Policy')).toBe(`${data.policy}; frame-ancestors 'none'`);
      expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
      expect(response.headers.get('X-Frame-Options')).toBe('DENY');
      expect(response.headers.get('Referrer-Policy')).toBe('no-referrer');
      expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();
      expect(response.headers.get('Set-Cookie')).toBeNull();
    }
  });

  test('only declared generated assets are served; paths cannot expose source, secrets or arbitrary files', async () => {
    const data = await fixture();
    const app = await createStatusServer({ directory: data.directory });
    for (const path of ['/.env', '/src/server.ts', '/scripts/monitor.mjs', '/package.json', '/CNAME', '/.nojekyll', '/assets/index-unlisted.js', '/assets/%2e%2e/.env', '/%2fstatus.json', '/status.json/', '/api/health', '/probe', '/monitor']) {
      const response = await app.handle(request(path));
      expect(response.status).toBe(404);
      expect(response.headers.get('Cache-Control')).toBe('no-store');
      expect(await response.text()).toBe('Not found');
    }
    const response = await app.handle(request('/missing', { method: 'HEAD' }));
    expect(response.status).toBe(404);
    expect(await response.text()).toBe('');
  });

  test('write and preflight methods are rejected before parsing malformed payloads', async () => {
    const data = await fixture();
    const app = await createStatusServer({ directory: data.directory });
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
      const response = await app.handle(request('/status.json', { method, headers: { 'Content-Type': 'application/json' }, body: '{ invalid payload' }));
      expect(response.status).toBe(405);
      expect(response.headers.get('Allow')).toBe('GET, HEAD');
      expect(response.headers.get('Cache-Control')).toBe('no-store');
      expect(await response.text()).toBe('Method not allowed');
    }
  });

  test('fallback build stays snapshot-independent without fabricating a local JSON response', async () => {
    const data = await fixture(true);
    const app = await createStatusServer({ directory: data.directory });
    expect((await app.handle(request('/'))).status).toBe(200);
    expect((await app.handle(request('/status.json'))).status).toBe(404);
  });

  test('startup rejects malformed or unsanitized snapshots and unsafe CSP', async () => {
    const data = await fixture();
    await writeFile(join(data.directory, 'status.json'), '{invalid');
    await expect(createStatusServer({ directory: data.directory })).rejects.toThrow('Invalid built status snapshot');
    await writeFile(join(data.directory, 'status.json'), JSON.stringify({ ...data.snapshot, privateKey: 'must-not-be-served' }));
    await expect(createStatusServer({ directory: data.directory })).rejects.toThrow('unsanitized built status snapshot');
    await writeFile(join(data.directory, 'status.json'), JSON.stringify(data.snapshot));
    await writeFile(join(data.directory, 'index.html'), data.html.replace("script-src 'self'", "script-src 'unsafe-inline'"));
    await expect(createStatusServer({ directory: data.directory })).rejects.toThrow('Invalid built status Content Security Policy');
  });

  test('startup rejects missing generated assets instead of serving source assets', async () => {
    const data = await fixture();
    const html = await readFile(join(data.directory, 'index.html'), 'utf8');
    await writeFile(join(data.directory, 'index.html'), html.replace(`.${js}`, './status-client.mjs'));
    await expect(createStatusServer({ directory: resolve(data.directory) })).rejects.toThrow('Build the two hashed status assets');
  });
});
