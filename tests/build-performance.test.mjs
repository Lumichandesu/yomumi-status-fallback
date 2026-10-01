import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateSnapshot } from '../public/status-model.mjs';

const sourceRoot = fileURLToPath(new URL('../', import.meta.url));
const FALLBACK_URL = 'https://raw.githubusercontent.com/Lumichandesu/yomumi-status/main/public/status.json';
const runFile = promisify(execFile);
const bunExecutable = typeof Bun === 'undefined' ? 'bun' : process.execPath;

async function withBuildFixture(callback) {
  const fixtureRoot = await mkdtemp(join(tmpdir(), 'yomumi-status-build-'));
  try {
    await mkdir(join(fixtureRoot, 'scripts'));
    await mkdir(join(fixtureRoot, 'public'));
    await cp(join(sourceRoot, 'scripts', 'build.mjs'), join(fixtureRoot, 'scripts', 'build.mjs'));
    for (const name of ['index.html', 'status.css', 'status-client.mjs', 'status-model.mjs']) {
      await cp(join(sourceRoot, 'public', name), join(fixtureRoot, 'public', name));
    }
    // Use fixture data in both repositories; the fallback deliberately has no hosted snapshot.
    await writeFile(join(fixtureRoot, 'public', 'status.json'), JSON.stringify(validateSnapshot({
      schemaVersion: 1, generatedAt: '2026-10-01T00:00:00.000Z',
      monitor: { startedAt: '2026-10-01T00:00:00.000Z', intervalSeconds: 900, staleAfterSeconds: 2700 },
      components: ['website', 'api', 'database', 'cache'].map((id) => ({
        id, status: 'unknown', checkedAt: null, latencyMs: null, reason: null,
      })), history: [], days: [], incidents: [],
    })));
    const build = (dataUrl = '', extraEnv = {}) => runFile(bunExecutable, ['--no-env-file', join(fixtureRoot, 'scripts', 'build.mjs')], {
      cwd: fixtureRoot,
      env: { ...process.env, STATUS_DATA_URL: dataUrl, ...extraEnv },
      timeout: 10_000,
    });
    await callback({ fixtureRoot, build });
  } finally {
    const ownedPath = resolve(fixtureRoot);
    const ownedRelative = relative(resolve(tmpdir()), ownedPath);
    assert.ok(ownedRelative.startsWith('yomumi-status-build-') && !ownedRelative.startsWith('..') && !isAbsolute(ownedRelative));
    await rm(ownedPath, { force: true, recursive: true });
  }
}

async function generatedAssets(fixtureRoot) {
  const output = join(fixtureRoot, 'dist');
  const html = await readFile(join(output, 'index.html'), 'utf8');
  const jsName = html.match(/<script[^>]+src="\.\/([^"]+\.js)"/u)?.[1];
  const cssName = html.match(/<link[^>]+href="\.\/([^"]+\.css)"/u)?.[1];
  assert.match(jsName ?? '', /^assets\/index-[\w-]{8,64}\.js$/u);
  assert.match(cssName ?? '', /^assets\/index-[\w-]{8,64}\.css$/u);
  return {
    html, jsName, cssName,
    js: await readFile(join(output, jsName), 'utf8'),
    css: await readFile(join(output, cssName), 'utf8'),
    names: await readdir(join(output, 'assets')),
  };
}

test('Bun ships one smaller hashed client bundle and stylesheet without a model request', async () => {
  await withBuildFixture(async ({ fixtureRoot, build }) => {
    await build();
    const generated = await generatedAssets(fixtureRoot);
    assert.equal((generated.html.match(/<script\b/gu) ?? []).length, 1);
    assert.equal((generated.html.match(/rel="stylesheet"/gu) ?? []).length, 1);
    assert.equal(generated.names.length, 2, 'No extra chunk or source map may enter the initial page');
    assert.doesNotMatch(generated.js, /import\s*\(|status-model\.mjs|sourceMappingURL/u);
    assert.doesNotMatch(generated.html, /<style\b|<script[^>]*>[^<]+<\/script>|unsafe-inline|unsafe-eval/u);
    assert.match(generated.html, /http-equiv="Content-Security-Policy"/u);
    assert.match(generated.html, /script-src 'self';/u);
    assert.match(generated.html, /<noscript>/u);
    const originalFiles = await Promise.all(['status-client.mjs', 'status-model.mjs', 'status.css'].map((name) => readFile(join(fixtureRoot, 'public', name))));
    const originalBytes = originalFiles.reduce((bytes, contents) => bytes + contents.byteLength, 0);
    const generatedBytes = Buffer.byteLength(generated.js) + Buffer.byteLength(generated.css);
    assert.ok(generatedBytes < originalBytes * 0.8, `${generatedBytes} browser bytes must beat the ${originalBytes}-byte source payload by at least 20%`);
    assert.equal(await readFile(join(fixtureRoot, 'dist', 'status.json'), 'utf8'), await readFile(join(fixtureRoot, 'public', 'status.json'), 'utf8'));
    assert.equal(await readFile(join(fixtureRoot, 'dist', 'CNAME'), 'utf8'), 'status.yomumi.moe\n');
    assert.equal(await readFile(join(fixtureRoot, 'dist', '.nojekyll'), 'utf8'), '');
    assert.match(await readFile(join(fixtureRoot, 'dist', 'robots.txt'), 'utf8'), /User-agent: \*\nAllow: \/\n/u);
    await build();
    const repeated = await generatedAssets(fixtureRoot);
    assert.equal(repeated.jsName, generated.jsName, 'Unchanged bundles retain their cacheable content hash');
    assert.equal(repeated.cssName, generated.cssName);
  });
});

test('fallback keeps hashed bundles independent and rejects arbitrary data URLs before replacing output', async () => {
  await withBuildFixture(async ({ fixtureRoot, build }) => {
    await build();
    const primary = await generatedAssets(fixtureRoot);
    await build(FALLBACK_URL);
    const fallback = await generatedAssets(fixtureRoot);
    assert.equal(fallback.jsName, primary.jsName);
    assert.equal(fallback.cssName, primary.cssName);
    assert.ok(fallback.html.includes(`name="status-data-url" content="${FALLBACK_URL}"`));
    assert.ok(fallback.html.includes(`https://yomumi-status-monitor.yomumi.workers.dev/status.json ${FALLBACK_URL};`));
    await assert.rejects(readFile(join(fixtureRoot, 'dist', 'CNAME')), { code: 'ENOENT' });
    await assert.rejects(readFile(join(fixtureRoot, 'dist', 'status.json')), { code: 'ENOENT' });
    await assert.rejects(build('https://arbitrary.invalid/private-status'));
    assert.equal(await readFile(join(fixtureRoot, 'dist', 'index.html'), 'utf8'), fallback.html);
    await writeFile(join(fixtureRoot, 'public', 'status-client.mjs'), 'export const broken = ;');
    await assert.rejects(build());
    assert.equal(await readFile(join(fixtureRoot, 'dist', 'index.html'), 'utf8'), fallback.html, 'A failed compilation must preserve the previous static output');
  });
});

test('browser build disables dotenv and environment substitution', async () => {
  await withBuildFixture(async ({ fixtureRoot, build }) => {
    const dotenvSentinel = 'STATUS_DOTENV_SECRET_MUST_STAY_PRIVATE_20261001';
    const environmentSentinel = 'STATUS_ENV_SECRET_MUST_STAY_PRIVATE_20261001';
    await writeFile(join(fixtureRoot, '.env'), `STATUS_DATA_URL=https://private.invalid/\nSTATUS_DOTENV_SECRET=${dotenvSentinel}\n`);
    await writeFile(join(fixtureRoot, 'public', 'status-client.mjs'), (await readFile(join(fixtureRoot, 'public', 'status-client.mjs'), 'utf8')) + '\nglobalThis.__statusBuildProbe = [process.env.STATUS_DOTENV_SECRET, process.env.STATUS_ENV_SECRET];\n');
    await build('', { STATUS_ENV_SECRET: environmentSentinel });
    const generated = await generatedAssets(fixtureRoot);
    for (const contents of [generated.html, generated.js, generated.css]) {
      assert.ok(!contents.includes(dotenvSentinel));
      assert.ok(!contents.includes(environmentSentinel));
      assert.ok(!contents.includes('https://private.invalid/'));
      assert.ok(!contents.includes('elysia'));
    }
    assert.match(generated.js, /process\.env\.STATUS_ENV_SECRET/u, 'Environment access must stay unsubstituted rather than embedding a build secret');
  });
});
