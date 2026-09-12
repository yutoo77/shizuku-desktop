// Explicit single paid request through the production app. Never run by CI.
import electron from 'electron';
import { spawn, execFileSync } from 'node:child_process';
import { readFile, writeFile, mkdir, mkdtemp, readdir, copyFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';
import { inspectProcessIdentities } from './process-check.mjs';

const mode = process.argv.slice(2);
assert.ok(mode.length === 1 && ['--live-once', '--prepare-only'].includes(mode[0]), 'Use --prepare-only (no AI request), or --live-once (one paid AI request and playback using an already running VOICEVOX).');
const prepareOnly = mode[0] === '--prepare-only';
const key = process.env.OPENAI_API_KEY;
assert.ok(key, 'OPENAI_API_KEY must already be set.');
delete process.env.OPENAI_API_KEY;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const normal = path.join(root, 'local.config.json'), settings = await readFile(normal);
const config = JSON.parse(settings.toString().replace(/^\uFEFF/, ''));
assert.ok(typeof config.modelPath === 'string' && path.isAbsolute(config.modelPath));
const identity = async file => createHash('sha256').update(await readFile(file)).digest('hex');
const modelHash = await identity(config.modelPath);
// Version request is read-only. This script never starts or stops the engine.
const response = await fetch('http://127.0.0.1:50021/version', { signal: AbortSignal.timeout(2000) });
assert.equal(response.ok, true, 'Start VOICEVOX separately before the live check.');
const voicevoxVersion = (await response.text()).slice(0, 100);
await mkdir(path.join(root, 'work'), { recursive: true });
const directory = await mkdtemp(path.join(root, 'work', 'live-conversation-'));
const copy = path.join(directory, 'app');
await mkdir(path.join(copy, 'dist'), { recursive: true });
const hashes = {};
for (const file of await readdir(path.join(root, 'dist'))) {
  hashes[file] = await identity(path.join(root, 'dist', file));
  await copyFile(path.join(root, 'dist', file), path.join(copy, 'dist', file));
}
// Only built source and a private test configuration are copied; never the VRM.
await writeFile(path.join(copy, 'local.config.json'), JSON.stringify({ modelPath: config.modelPath, quiet: true, scale: 100 }));
const env = { ...process.env, OPENAI_API_KEY: key, SHIZUKU_LIVE_ROOT: copy, SHIZUKU_LIVE_PREPARE_ONLY: prepareOnly ? '1' : '0' };
for (const name of ['SHIZUKU_TEST', 'SHIZUKU_TEST_DATA', 'SHIZUKU_METRICS', 'NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE']) delete env[name];
const child = spawn(electron, [path.join(root, 'scripts/fixtures/live-conversation.cjs')], {
  cwd: root, env, windowsHide: false, stdio: 'ignore',
});
delete env.OPENAI_API_KEY;
const exitPromise = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
let launchError; child.once('error', error => { launchError = error.message; });
let interrupted = false, forced = false;
const stop = () => { interrupted = true; void writeFile(path.join(directory, 'stop'), '').catch(() => {}); };
process.on('SIGINT', stop); process.on('SIGTERM', stop);
const until = Date.now() + 150_000;
while (child.exitCode === null && child.signalCode === null && !launchError && Date.now() < until && !interrupted) await delay(100);
if (child.exitCode === null && child.signalCode === null && !launchError) {
  stop(); for (let i = 0; i < 100 && child.exitCode === null && child.signalCode === null; i++) await delay(100);
  if (child.exitCode === null && child.signalCode === null) { forced = true; child.kill(); }
}
const exit = await exitPromise;
process.off('SIGINT', stop); process.off('SIGTERM', stop);
let fixture = {}, events = [];
try { fixture = JSON.parse(await readFile(path.join(directory, 'fixture.json'), 'utf8')); } catch { /* Crash before completion. */ }
try { events = (await readFile(path.join(directory, 'events.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse); } catch { /* Preserve failure. */ }
const observations = [{ pid: child.pid, name: path.basename(electron), parentPid: process.pid }, ...events.flatMap(item => item.processes ?? [])];
const exact = new Set(observations.filter(item => Number.isFinite(item.creationTime)).map(item => item.pid));
const identities = [...new Map(observations.filter(item => Number.isFinite(item.creationTime) || !exact.has(item.pid))
  .map(item => [`${item.pid}:${item.creationTime ?? item.name + ':' + item.parentPid}`, item])).values()];
let cleanup, cleanupError;
try { cleanup = await inspectProcessIdentities(identities, directory); } catch (error) { cleanupError = error.message; }
const settingsUnchanged = settings.equals(await readFile(normal)), modelUnchanged = modelHash === await identity(config.modelPath);
let buildUnchanged = true;
for (const [file, hash] of Object.entries(hashes)) {
  if (hash !== await identity(path.join(root, 'dist', file)) || hash !== await identity(path.join(copy, 'dist', file))) buildUnchanged = false;
}
const status = fixture.status === 'passed' && exit.code === 0 && exit.signal === null && !interrupted && !forced && !launchError
  && cleanup && !cleanup.remainingPids.length && !cleanup.unverifiablePids.length && settingsUnchanged && modelUnchanged && buildUnchanged ? 'passed' : 'failed';
await writeFile(path.join(directory, 'result.json'), JSON.stringify({ status, prepareOnly, fixture, exit, interrupted, forced, launchError, cleanup, cleanupError,
  settingsUnchanged, modelUnchanged, buildUnchanged, hashes, voicevoxVersion,
  revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim() }, null, 2));
console.log(JSON.stringify({ directory, status, exit, apiCalls: fixture.requests?.openai, speechCalls: fixture.requests?.synthesis, remainingPids: cleanup?.remainingPids }));
if (status !== 'passed') process.exitCode = 1;
