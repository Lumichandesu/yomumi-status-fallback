import { Elysia } from 'elysia';
import { createHash } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { validateSnapshot } from '../public/status-model.mjs';

const defaultDirectory = fileURLToPath(new URL('../dist/', import.meta.url));
const workerSnapshot = 'https://yomumi-status-monitor.yomumi.workers.dev/status.json';
const fallbackSnapshot = 'https://raw.githubusercontent.com/Lumichandesu/yomumi-status/main/public/status.json';
const policyFor = (fallback: boolean) => `default-src 'none'; style-src 'self'; script-src 'self'; connect-src 'self' ${workerSnapshot}${fallback ? ` ${fallbackSnapshot}` : ''}; base-uri 'none'; form-action 'none'; object-src 'none'; img-src 'none'`;
const assetName = /^\.\/assets\/(index-[A-Za-z0-9_-]{8,64}\.(?:css|js))$/u;

type Asset = {
  bytes: Uint8Array<ArrayBuffer>;
  contentType: string;
  cacheControl: string;
  etag: string;
};

export type StatusServerOptions = { directory?: string };

function ifNoneMatch(value: string | null, etag: string): boolean {
  if (!value) return false;
  return value.split(',').some((entry) => {
    const tag = entry.trim();
    return tag === '*' || tag.replace(/^W\//u, '') === etag;
  });
}

// Only prebuilt, declared public assets are read. Requests never touch the filesystem,
// refresh observations, contact the application, or start the separate monitor.
export async function createStatusServer({ directory = defaultDirectory }: StatusServerOptions = {}) {
  const root = await realpath(resolve(directory));
  const assets = new Map<string, Asset>();

  async function load(name: string, contentType: string, cacheControl: string, maxBytes: number) {
    const filename = await realpath(join(root, name));
    const within = relative(root, filename);
    if (!within || isAbsolute(within) || within === '..' || within.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)) {
      throw new Error('Built status asset escapes output directory');
    }
    const info = await stat(filename);
    if (!info.isFile() || info.size > maxBytes) throw new Error('Invalid built status asset');
    const bytes = new Uint8Array(await readFile(filename));
    if (bytes.byteLength > maxBytes) throw new Error('Built status asset is too large');
    return {
      bytes,
      contentType,
      cacheControl,
      etag: `"${createHash('sha256').update(bytes).digest('hex')}"`,
    } satisfies Asset;
  }

  const html = await load('index.html', 'text/html; charset=utf-8', 'no-cache', 256_000);
  const document = new TextDecoder('utf-8', { fatal: true }).decode(html.bytes);
  const policy = /<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]+)"\s*\/?>/iu.exec(document)?.[1];
  if (policy !== policyFor(false) && policy !== policyFor(true)) throw new Error('Invalid built status Content Security Policy');

  const declared = [...document.matchAll(/(?:src|href)="([^"<>]+)"/gu)]
    .map((match) => assetName.exec(match[1])?.[1]).filter((name): name is string => Boolean(name));
  if (new Set(declared).size !== 2 || !declared.some((name) => name.endsWith('.css')) || !declared.some((name) => name.endsWith('.js'))) {
    throw new Error('Build the two hashed status assets before starting the server');
  }
  assets.set('/', html);
  assets.set('/index.html', html);
  for (const name of new Set(declared)) {
    assets.set(`/assets/${name}`, await load(`assets/${name}`, name.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8', 'public, max-age=31536000, immutable', 256_000));
  }
  assets.set('/robots.txt', await load('robots.txt', 'text/plain; charset=utf-8', 'no-cache', 16_000));

  // Fallback builds deliberately have no local snapshot; the browser uses its fixed
  // independent public source. Never manufacture a healthy snapshot in its place.
  if (policy === policyFor(false)) {
    const snapshot = await load('status.json', 'application/json; charset=utf-8', 'no-store', 512_000);
    let raw: unknown;
    try { raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(snapshot.bytes)); }
    catch { throw new Error('Invalid built status snapshot'); }
    const validated = validateSnapshot(raw);
    if (!validated || !isDeepStrictEqual(raw, validated)) throw new Error('Invalid or unsanitized built status snapshot');
    assets.set('/status.json', snapshot);
  }

  const securityHeaders = {
    'Content-Security-Policy': `${policy}; frame-ancestors 'none'`,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  };
  function respond(request: Request): Response {
    const headers = new Headers(securityHeaders);
    headers.set('Cache-Control', 'no-store');
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      headers.set('Allow', 'GET, HEAD');
      headers.set('Content-Type', 'text/plain; charset=utf-8');
      return new Response('Method not allowed', { status: 405, headers });
    }
    const path = new URL(request.url).pathname;
    const asset = assets.get(path);
    if (!asset) {
      headers.set('Content-Type', 'text/plain; charset=utf-8');
      return new Response(request.method === 'HEAD' ? null : 'Not found', { status: 404, headers });
    }
    headers.set('Content-Type', asset.contentType);
    headers.set('Cache-Control', asset.cacheControl);
    headers.set('ETag', asset.etag);
    if (ifNoneMatch(request.headers.get('If-None-Match'), asset.etag)) return new Response(null, { status: 304, headers });
    headers.set('Content-Length', String(asset.bytes.byteLength));
    return new Response(request.method === 'HEAD' ? null : asset.bytes, { headers });
  }

  // onRequest runs before body parsing, so even invalid write payloads are rejected
  // without parsing, exposing application routes, or creating side effects.
  return new Elysia({ name: 'yomumi-status-static' }).onRequest(({ request }) => respond(request));
}

if (import.meta.main) {
  const suppliedPort = process.env.STATUS_PORT ?? process.env.PORT;
  const port = suppliedPort === undefined ? 4331 : Number(suppliedPort);
  if ((suppliedPort !== undefined && !/^\d{1,5}$/u.test(suppliedPort)) || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('STATUS_PORT (or PORT) must be an integer from 1 to 65535');
  }
  const app = await createStatusServer();
  app.listen({ hostname: '127.0.0.1', port });
  console.log(`Independent status preview: http://127.0.0.1:${port}/`);
}
