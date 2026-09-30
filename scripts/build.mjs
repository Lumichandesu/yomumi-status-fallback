import { cp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
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
// This exact fixed directory is the disposable status output, never the shared checkout.
await rm(resolvedOutput, { force: true, recursive: true });
await mkdir(output, { recursive: true });
for (const name of ['index.html', 'status.css', 'status-client.mjs', 'status-model.mjs']) await cp(root + 'public/' + name, output + name);
let html = await readFile(output + 'index.html', 'utf8');
if (fallback) {
  html = html.replace('content="./status.json"', `content="${fallbackUrl}"`);
} else {
  await cp(root + 'public/status.json', output + 'status.json');
  await writeFile(output + 'CNAME', 'status.yomumi.moe\n');
}
html = html.replace('<meta name="referrer"', '<meta name="robots" content="noai, noimageai"><meta name="referrer"');
const policy = `default-src 'none'; style-src 'self'; script-src 'self'; connect-src 'self'${fallback ? ' ' + fallbackUrl : ''}; base-uri 'none'; form-action 'none'; object-src 'none'; img-src 'none'`;
html = html.replace('<head>', `<head>\n  <meta http-equiv="Content-Security-Policy" content="${policy}">`);
await writeFile(output + 'index.html', html);
await writeFile(output + '.nojekyll', '');
await writeFile(output + 'robots.txt', 'User-agent: *\nAllow: /\n\nUser-agent: GPTBot\nUser-agent: CCBot\nUser-agent: ClaudeBot\nUser-agent: Google-Extended\nDisallow: /\n');
console.log('Built independent status assets.');
