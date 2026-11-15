// Launch the built app without Playwright, CDP or native keyboard/mouse input.
import electron from 'electron';
import { spawn, execFileSync } from 'node:child_process';
import { readFile, writeFile, mkdir, mkdtemp, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';
import { inspectProcessIdentities } from './process-check.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const settingsPath = path.join(root, 'local.config.json');
const settings = await readFile(settingsPath);
const config = JSON.parse(settings.toString().replace(/^\uFEFF/, ''));
assert.ok(typeof config.modelPath === 'string' && path.isAbsolute(config.modelPath), 'Select a local VRM first.');
const hash = async file => createHash('sha256').update(await readFile(file)).digest('hex');
const modelHash = await hash(config.modelPath);
const buildHashes = {};
for (const file of await readdir(path.join(root, 'dist'))) {
  buildHashes[file] = await hash(path.join(root, 'dist', file));
}
await mkdir(path.join(root, 'work'), { recursive: true });
const directory = await mkdtemp(path.join(root, 'work', 'window-lifecycle-'));
await writeFile(path.join(directory, 'local.config.json'), JSON.stringify({ modelPath: config.modelPath, quiet: true, scale: 100 }));
const env = { ...process.env, SHIZUKU_TEST: '1', SHIZUKU_TEST_DATA: path.basename(directory), SHIZUKU_METRICS: '0' };
for (const key of ['OPENAI_API_KEY', 'ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS']) delete env[key];
const child = spawn(electron, [path.join(root, 'scripts/fixtures/window-lifecycle.cjs')], {
  // The GUI under test must be visible. In the local comparison, windowsHide
  // left the first controls window invisible despite its show event.
  cwd: root, env, windowsHide: false, stdio: 'ignore',
});
let launchError;
child.once('error', error => { launchError = error.message; });
const closed = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
let stopRequested = false;
const stop = () => { stopRequested = true; void writeFile(path.join(directory, 'stop'), '').catch(() => {}); };
process.on('SIGINT', stop); process.on('SIGTERM', stop);
const deadline = Date.now() + 180_000;
let forced = false;
while (child.exitCode === null && child.signalCode === null && !launchError && Date.now() < deadline && !stopRequested) await delay(100);
if (child.exitCode === null && child.signalCode === null && !launchError) {
  stop();
  for (let i = 0; i < 100 && child.exitCode === null && child.signalCode === null; i++) await delay(100);
  if (child.exitCode === null && child.signalCode === null) { forced = true; child.kill(); }
}
const exit = await closed;
process.off('SIGINT', stop); process.off('SIGTERM', stop);
let fixture = {}, events = [];
try { fixture = JSON.parse(await readFile(path.join(directory, 'fixture.json'), 'utf8')); } catch { /* A crash may precede the final report. */ }
try { events = (await readFile(path.join(directory, 'events.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse); } catch { /* Preserve a missing-log failure. */ }
const observations = [{ pid: child.pid, name: path.basename(electron), parentPid: process.pid },
  ...events.filter(item => item.kind === 'pids').flatMap(item => item.processes ?? [])].filter(item => Number.isInteger(item.pid));
const exact = new Set(observations.filter(item => Number.isFinite(item.creationTime)).map(item => item.pid));
const identities = [...new Map(observations.filter(item => Number.isFinite(item.creationTime) || !exact.has(item.pid))
  .map(item => [`${item.pid}:${item.creationTime ?? item.name + ':' + item.parentPid}`, item])).values()];
let processCheck = { remainingPids: [], reusedPids: [], unverifiablePids: [] }, cleanupError;
try {
  for (let i = 0; i < 4; i++) {
    processCheck = await inspectProcessIdentities(identities, directory);
    if (!processCheck.remainingPids.length && !processCheck.unverifiablePids.length) break;
    await delay(500);
  }
} catch (error) { cleanupError = error.message; }
const { remainingPids } = processCheck;
const settingsUnchanged = settings.equals(await readFile(settingsPath));
const modelUnchanged = modelHash === await hash(config.modelPath);
let buildUnchanged = true;
for (const [file, value] of Object.entries(buildHashes)) if (value !== await hash(path.join(root, 'dist', file))) buildUnchanged = false;
const status = fixture.status === 'passed' && exit.code === 0 && exit.signal === null && !forced && !stopRequested
  && !remainingPids.length && !processCheck.unverifiablePids.length && !cleanupError && settingsUnchanged && modelUnchanged && buildUnchanged ? 'passed' : 'failed';
const result = { status, revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  mode: 'standalone-electron-no-cdp', scope: 'Own-window API and renderer DOM operations. No physical input, live AI/voice, OS sleep/lock or other-app inspection.',
  fixture, exit, launchError, forced, stopRequested, identities, processCheck, cleanupError, remainingPids,
  settingsUnchanged, modelUnchanged, buildUnchanged, buildHashes };
await writeFile(path.join(directory, 'result.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify({ directory, status, checks: fixture.checks?.length ?? 0, cycles: fixture.cycles?.length ?? 0, exit, remainingPids }));
if (status !== 'passed') process.exitCode = 1;
