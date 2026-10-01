import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { runChecks, recordObservation } from './monitor-lib.mjs';
const snapshotPath = fileURLToPath(new URL('../public/status.json', import.meta.url));
const apiBase = process.env.STATUS_API_BASE_URL;
if (!apiBase) throw new Error('STATUS_API_BASE_URL must be configured for the independent monitor');
let previous = null;
try { previous = JSON.parse(await readFile(snapshotPath, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw new Error('Existing monitor snapshot is unreadable'); }
const observation = await runChecks({ apiBase, serviceProbeUrl: process.env.STATUS_SERVICE_PROBE_URL, serviceProbeToken: process.env.STATUS_SERVICE_PROBE_TOKEN });
const snapshot = recordObservation(previous, observation);
await mkdir(fileURLToPath(new URL('../public/', import.meta.url)), { recursive: true });
await writeFile(snapshotPath + '.tmp', JSON.stringify(snapshot, null, 2) + '\n', { mode: 0o644 });
await rename(snapshotPath + '.tmp', snapshotPath);
// Deliberately omit infrastructure URLs, response bodies and raw exception messages.
console.log(JSON.stringify({ checkedAt: snapshot.generatedAt, components: snapshot.components.map(({ id, status }) => ({ id, status })) }));
