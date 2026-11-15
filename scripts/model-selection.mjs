// Delayed native-dialog/file results are controlled inside our own Electron main
// process. No physical dialog interaction or real OS lock/suspend is performed.
import { _electron } from 'playwright';
import electron from 'electron';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { inspectProcessIdentities } from './process-check.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const normal = path.join(root, 'local.config.json'), before = await readFile(normal);
const selected = JSON.parse(before.toString('utf8').replace(/^\uFEFF/, ''));
assert.ok(selected.modelPath, 'Select a usable local model first.');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const modelBefore = hash(await readFile(selected.modelPath));
const directory = await mkdtemp(path.join(root, 'work', 'model-selection-'));
const configPath = path.join(directory, 'local.config.json');
await writeFile(configPath, JSON.stringify({ modelPath: selected.modelPath, quiet: true }));
const env = { ...process.env, SHIZUKU_TEST: '1', SHIZUKU_TEST_DATA: path.basename(directory), SHIZUKU_METRICS: '0' };
delete env.OPENAI_API_KEY; delete env.ELECTRON_RUN_AS_NODE;
const report = { status: 'running', startedAt: new Date().toISOString(), checks: [], observations: [], buildSha256: hash(await readFile(path.join(root, 'dist/main.cjs'))) };
const identities = new Map();
let app, page, failure, exit;
const main = fn => app.evaluate(fn);
const check = message => { report.checks.push(message); console.log(JSON.stringify({ check: message })); };
async function waitFor(predicate, message) {
  const deadline = performance.now() + 15_000;
  while (performance.now() < deadline) { if (await predicate()) return; await delay(50); }
  throw new Error(message);
}
async function recordProcesses() {
  const state = await main(() => ({ metrics: __shizuku.metrics(), tracker: __shizuku.tracking().pid, parent: process.pid }));
  for (const item of state.metrics) identities.set(`${item.pid}:${item.creationTime}`, { pid: item.pid, creationTime: item.creationTime });
  if (state.tracker) identities.set(`tracker:${state.tracker}`, { pid: state.tracker, name: 'window-tracker.exe', parentPid: state.parent });
}
async function prepare(stage = 'dialog') {
  await main(() => __shizuku.action('show'));
  await app.evaluate((_electron, stage) => {
    const p = globalThis.__modelSelectionProbe;
    p.stage = stage; p.resolve = null; p.readStarted = false; p.done = false; p.reloads = 0; p.error = null;
    void __shizuku.action('choose-model').then(() => { p.done = true; }, () => { p.error = 'Selection action rejected'; p.done = true; });
  }, stage);
  await waitFor(() => main(() => !!__modelSelectionProbe.resolve), 'Selection must reach the held boundary.');
}
async function release({ reject = false, canceled = false } = {}) {
  await app.evaluate((_electron, value) => __modelSelectionProbe.resolve(value), { reject, canceled });
  await waitFor(() => main(() => __modelSelectionProbe.done), 'Selection must finish after its result arrives.');
  await recordProcesses();
}
async function observe(label) {
  const state = await main(() => ({ status: __shizuku.status(), visible: __shizuku.avatar().isVisible(),
    controlsVisible: !!__shizuku.controls()?.isVisible(), reloads: __modelSelectionProbe.reloads,
    readStarted: __modelSelectionProbe.readStarted, error: __modelSelectionProbe.error }));
  report.observations.push({ label, ...state });
  assert.equal(state.error, null);
  return state;
}
async function noReplay(label, { hidden = true, readStarted = false } = {}) {
  const state = await observe(label);
  assert.equal(state.reloads, 0, `${label}: stale selection must not reload the avatar`);
  assert.equal(state.visible, !hidden, `${label}: later visibility intent must win`);
  assert.equal(state.status.modelLoaded, true, `${label}: keep the existing model`);
  assert.equal(state.status.loadError, '', `${label}: stale errors must not replace current state`);
  assert.equal(state.readStarted, readStarted);
  assert.equal(JSON.parse(await readFile(configPath, 'utf8')).modelPath, selected.modelPath);
  check(label);
}

try {
  app = await _electron.launch({ executablePath: electron, args: [root], cwd: root, env, timeout: 20_000 });
  const child = app.process();
  identities.set(`launcher:${child.pid}`, { pid: child.pid, name: path.basename(electron), parentPid: process.pid });
  child.once('exit', (code, signal) => { exit = { code, signal }; });
  page = await app.firstWindow();
  await page.waitForFunction(() => window.__diagnostics?.loaded, null, { timeout: 20_000 });
  await recordProcesses();
  await app.evaluate(({ dialog }, modelPath) => {
    const fs = process.getBuiltinModule('fs/promises');
    const originalRead = fs.readFile, originalWrite = fs.writeFile, originalDialog = dialog.showOpenDialog;
    const p = globalThis.__modelSelectionProbe = { stage: 'dialog', resolve: null, reloads: 0,
      readStarted: false, done: false, error: null, originalRead, originalDialog, networkCalls: 0 };
    globalThis.fetch = async () => { p.networkCalls++; throw new Error('Network disabled in model selection checks'); };
    dialog.showOpenDialog = async () => {
      if (p.stage === 'dialog') {
        const result = await new Promise(resolve => { p.resolve = resolve; });
        if (result.reject) throw new Error('Controlled dialog failure');
        return { canceled: result.canceled, filePaths: result.canceled ? [] : [modelPath] };
      }
      return { canceled: false, filePaths: [modelPath] };
    };
    fs.readFile = async function(file, ...args) {
      if (file === modelPath && p.stage === 'read') {
        p.readStarted = true;
        const result = await new Promise(resolve => { p.resolve = resolve; });
        p.stage = 'pass';
        if (result.reject) throw new Error('Controlled file failure');
      } else if (file === modelPath) p.readStarted = true;
      return originalRead.call(this, file, ...args);
    };
    fs.writeFile = async function(file, ...args) {
      if (p.stage === 'write' && p.reloads === 1) {
        await new Promise(resolve => { p.resolve = resolve; });
        p.stage = 'pass';
      }
      return originalWrite.call(this, file, ...args);
    };
    const wc = __shizuku.avatar().webContents, send = wc.send.bind(wc);
    wc.send = (channel, ...args) => { if (channel === 'model:changed') p.reloads++; return send(channel, ...args); };
  }, selected.modelPath);

  await prepare(); await main(() => __shizuku.action('hide')); await release();
  await noReplay('Hide cancels a held model dialog without reading or reopening the model.');

  for (const stage of ['dialog', 'read']) {
    await prepare(stage);
    await main(({ powerMonitor }) => { powerMonitor.emit('lock-screen'); powerMonitor.emit('unlock-screen'); });
    await release();
    await noReplay(`Lock and unlock cancel a pending ${stage} even when the result arrives after resume.`, { hidden: false, readStarted: stage === 'read' });
  }

  await prepare('read'); await main(() => __shizuku.action('hide')); await release();
  await noReplay('Hide during a held file read keeps the existing model and hidden state.', { readStarted: true });

  await prepare('read'); await main(() => __shizuku.action('hide')); await release({ reject: true });
  await noReplay('A stale file error after hiding does not open controls or overwrite model status.', { readStarted: true });
  assert.equal((await observe('controls remain closed')).controlsVisible, false);

  await prepare();
  await main(({ powerMonitor }) => { powerMonitor.emit('suspend'); powerMonitor.emit('lock-screen'); });
  await release();
  await main(({ powerMonitor }) => { powerMonitor.emit('resume'); });
  assert.equal((await observe('one rest reason remains')).visible, false);
  await main(() => __shizuku.action('hide'));
  await main(({ powerMonitor }) => powerMonitor.emit('unlock-screen'));
  await noReplay('Overlapping rest reasons discard the selection and preserve manual hiding after resume.');

  await prepare(); await release({ canceled: true });
  await noReplay('Ordinary dialog cancellation leaves the current visible model intact.', { hidden: false });

  await prepare('read'); await release();
  await page.waitForFunction(() => window.__diagnostics?.loaded, null, { timeout: 20_000 });
  const accepted = await observe('fresh explicit selection');
  assert.equal(accepted.reloads, 1); assert.equal(accepted.visible, true);
  check('A new explicit selection still reloads normally after cancelled operations.');
  await page.screenshot({ path: path.join(directory, 'avatar-after-selection.png') });

  await prepare('write');
  assert.equal((await observe('selection committed before saving')).reloads, 1);
  await main(() => __shizuku.action('hide')); await release();
  assert.equal((await observe('hide while saving')).visible, false);
  assert.equal((await observe('no replay after saving')).reloads, 1);
  check('Hide during saving is preserved; completing the write does not show or reload again.');

  assert.equal(await main(() => __modelSelectionProbe.networkCalls), 0);
  await prepare(); await recordProcesses();
  await main(() => __shizuku.action('quit'));
  await waitFor(() => child.exitCode !== null, 'Normal quit with a pending selection');
  assert.deepEqual(exit, { code: 0, signal: null });
  await app.close(); app = null;
  check('Normal quit exits even while a controlled model dialog is pending.');
} catch (error) { failure = error; }
finally {
  if (app) {
    // A failed assertion must not leave our synthetic disk write blocking quit.
    await main(() => globalThis.__modelSelectionProbe?.resolve?.({ canceled: true })).catch(() => {});
    await app.close().catch(error => { failure ??= error; });
  }
  try {
    const all = [...identities.values()], exact = new Set(all.filter(p => Number.isFinite(p.creationTime)).map(p => p.pid));
    report.processCheck = await inspectProcessIdentities(all.filter(p => Number.isFinite(p.creationTime) || !exact.has(p.pid)), directory);
    assert.deepEqual(report.processCheck.remainingPids, []); assert.deepEqual(report.processCheck.unverifiablePids, []);
    report.settingsUnchanged = (await readFile(normal)).equals(before);
    report.modelUnchanged = hash(await readFile(selected.modelPath)) === modelBefore;
    assert.equal(report.settingsUnchanged, true); assert.equal(report.modelUnchanged, true);
  } catch (error) { failure ??= error; }
  report.exit = exit; report.status = failure ? 'failed' : 'passed'; report.error = failure?.stack;
  report.finishedAt = new Date().toISOString();
  await writeFile(path.join(directory, 'result.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ directory, status: report.status, checks: report.checks.length, error: failure?.message }));
}
if (failure) throw failure;
