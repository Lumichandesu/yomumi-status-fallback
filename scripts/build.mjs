import { cp, mkdir, writeFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, relative, isAbsolute, join } from 'node:path';
const root = fileURLToPath(new URL('../', import.meta.url));
const output = fileURLToPath(new URL('../dist/', import.meta.url));
const serviceRoot = resolve(root);
const resolvedOutput = resolve(output);
const outputRelative = relative(serviceRoot, resolvedOutput);
if (resolvedOutput !== join(serviceRoot, 'dist') || dirname(resolvedOutput) !== serviceRoot || outputRelative !== 'dist' || isAbsolute(outputRelative)) throw new Error('Invalid status build output directory');
const fallbackUrl = 'https://raw.githubusercontent.com/Lumichandesu/yomumi-status/main/public/status.json';
const fallback = process.env.STATUS_DATA_URL;
if (fallback && fallback !== fallbackUrl) throw new Error('Invalid fallback status URL');
if (typeof Bun === 'undefined') throw new Error('Build status assets with Bun: bun --no-env-file run scripts/build.mjs');

// Bundle the model into the client so opening this static page never needs a second
// JavaScript request. No server dependency or environment value enters the browser.
const result = await Bun.build({
  entrypoints: [join(serviceRoot, 'public', 'index.html')],
  target: 'browser',
  minify: true,
  splitting: false,
  env: 'disable',
  naming: {
    entry: '[name].[ext]',
    chunk: 'assets/[name]-[hash].[ext]',
    asset: 'assets/[name]-[hash].[ext]',
  },
});
if (!result.success) throw new AggregateError(result.logs, 'Unable to build independent status assets');
// Omitting outdir keeps Bun artifacts in memory until validation is complete.
const htmlAsset = result.outputs.find((artifact) => resolve(resolvedOutput, artifact.path) === join(resolvedOutput, 'index.html'));
if (!htmlAsset) throw new Error('Status build did not produce an HTML entry point');
for (const artifact of result.outputs) {
  if (isAbsolute(artifact.path)) throw new Error('Invalid absolute status build artifact path');
  const artifactPath = resolve(resolvedOutput, artifact.path);
  const artifactRelative = relative(resolvedOutput, artifactPath);
  if (!artifactRelative || artifactRelative.startsWith('..') || isAbsolute(artifactRelative)) throw new Error('Invalid status build artifact path');
}
let html = await htmlAsset.text();
// This exact fixed directory is the disposable status output, never the shared checkout.
// Invalid configuration or a bundler failure leaves the previous build intact.
await rm(resolvedOutput, { force: true, recursive: true });
await mkdir(output, { recursive: true });
for (const artifact of result.outputs) {
  if (artifact === htmlAsset) continue;
  const artifactPath = resolve(resolvedOutput, artifact.path);
  await mkdir(dirname(artifactPath), { recursive: true });
  await writeFile(artifactPath, new Uint8Array(await artifact.arrayBuffer()));
}
if (fallback) {
  html = html.replace('content="./status.json"', `content="${fallbackUrl}"`);
} else {
  await cp(root + 'public/status.json', output + 'status.json');
  await writeFile(output + 'CNAME', 'status.yomumi.moe\n');
}
html = html.replace('<meta name="referrer"', '<meta name="robots" content="noai, noimageai"><meta name="referrer"');
const policy = `default-src 'none'; style-src 'self'; script-src 'self'; connect-src 'self' https://yomumi-status-monitor.yomumi.workers.dev/status.json${fallback ? ' ' + fallbackUrl : ''}; base-uri 'none'; form-action 'none'; object-src 'none'; img-src 'none'`;
html = html.replace('<head>', `<head>\n  <meta http-equiv="Content-Security-Policy" content="${policy}">`);
// Remove indentation between tags, preserving text, attributes and readable names.
html = html.replace(/>\s+</gu, '><').trim() + '\n';
await writeFile(output + 'index.html', html);
await writeFile(output + '.nojekyll', '');
await writeFile(output + 'robots.txt', 'User-agent: *\nAllow: /\n\nUser-agent: GPTBot\nUser-agent: CCBot\nUser-agent: ClaudeBot\nUser-agent: Google-Extended\nDisallow: /\n');
const browserBytes = result.outputs.filter((artifact) => artifact !== htmlAsset).reduce((bytes, artifact) => bytes + artifact.size, 0);
console.log(`Built independent status assets with Bun (${browserBytes} bytes of browser JavaScript and CSS).`);
