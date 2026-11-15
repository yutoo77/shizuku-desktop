// Own Electron windows and isolated settings; no native input or real API calls.
import { _electron } from 'playwright';
import electron from 'electron';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { inspectProcessIdentities } from './process-check.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const settings = await readFile(path.join(root, 'local.config.json'));
const config = JSON.parse(settings.toString().replace(/^\uFEFF/, ''));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const modelHash = hash(await readFile(config.modelPath));
const directory = await mkdtemp(path.join(root, 'work', 'startup-'));
const buildHashes = {};
for (const name of await readdir(path.join(root, 'dist'))) buildHashes[name] = hash(await readFile(path.join(root, 'dist', name)));
const report = { status: 'running', directory, startedAt: new Date().toISOString(), checks: [], exits: [], buildHashes };
let app, controls, failure;
const identities = [];
const check = value => { report.checks.push(value); console.log(JSON.stringify({ check: value })); };
const main = fn => app.evaluate(fn);
async function record() {
  identities.push(...await main(({ app }) => app.getAppMetrics().map(p => ({ pid: p.pid, creationTime: p.creationTime }))));
  const pid = await main(() => __shizuku.tracking().pid);
  if (pid) identities.push({ pid, name: 'window-tracker.exe', parentPid: app.process().pid });
}
async function waitFor(fn) {
  const end = Date.now() + 20_000;
  while (Date.now() < end) { if (await fn()) return; await delay(50); }
  throw new Error('Startup condition timed out');
}
async function launch(dir, holdStartup = false) {
  const env = { ...process.env, SHIZUKU_TEST: '1', SHIZUKU_TEST_DATA: path.basename(dir), SHIZUKU_METRICS: '0' };
  delete env.SHIZUKU_TEST_STARTUP_HOLD;
  if (holdStartup) env.SHIZUKU_TEST_STARTUP_HOLD = '1';
  for (const key of ['OPENAI_API_KEY', 'ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS']) delete env[key];
  app = await _electron.launch({ executablePath: electron, args: [root], cwd: root, env });
  const child = app.process();
  identities.push({ pid: child.pid, name: path.basename(electron), parentPid: process.pid });
  child.once('exit', (code, signal) => report.exits.push({ code, signal }));
  await waitFor(() => main(() => !!globalThis.__shizuku));
  await main(() => { globalThis.__startupNetwork = 0; globalThis.fetch = async () => { __startupNetwork++; throw new Error('Network disabled'); }; });
  await record();
}
async function findControls(visible = true) {
  // Observe the actual startup result; opening controls here would hide a
  // failure to provide recovery when a previously selected model is missing.
  await waitFor(() => main(() => !!__shizuku.controls()));
  await waitFor(() => app.windows().some(p => p.url().endsWith('/controls.html')));
  controls = app.windows().find(p => p.url().endsWith('/controls.html'));
  await controls.waitForSelector('#model', { state: 'attached' });
  if (visible) await waitFor(() => main(() => __shizuku.controls()?.isVisible()));
}
async function heldStartup(modelPath) {
  const dir = await mkdtemp(path.join(root, 'work', 'startup-'));
  await writeFile(path.join(dir, 'local.config.json'), JSON.stringify({ modelPath }));
  await launch(dir, true);
  await waitFor(() => main(() => __shizuku.status().loadError === 'モデルを読み込んでいます。'));
  assert.equal(await main(() => !!__shizuku.controls()), false);
}
async function releaseStartup() {
  await main(() => __shizuku.releaseStartupRead());
}
async function avatarNotice(state) {
  const avatar = app.windows().find(p => p.url().endsWith('/index.html'));
  await avatar.evaluate(value => window.companion.ready(value), state);
  // Wait through the IPC turn before observing absence of a new window.
  await delay(100);
}
async function holdControlsReady() {
  await main(({ BrowserWindow }) => {
    const original = BrowserWindow.prototype.once;
    globalThis.__releaseControlsReady = null;
    BrowserWindow.prototype.once = function(name, callback) {
      if (name === 'ready-to-show' && this.getTitle() === 'しずく') {
        return original.call(this, name, (...args) => {
          globalThis.__releaseControlsReady = () => callback.apply(this, args);
        });
      }
      return original.call(this, name, callback);
    };
  });
}
async function close() {
  await record();
  assert.equal(await main(() => __startupNetwork), 0);
  const child = app.process();
  await main(() => __shizuku.action('quit'));
  await waitFor(() => child.exitCode !== null);
  assert.equal(child.exitCode, 0); assert.equal(child.signalCode, null);
  await app.close(); app = null;
}
async function select(file, canceled = false) {
  await app.evaluate(({ dialog }, value) => { dialog.showOpenDialog = async () => ({ canceled: value.canceled, filePaths: value.canceled ? [] : [value.file] }); }, { file, canceled });
  await controls.locator('#model-setup button').click();
  await waitFor(() => controls.locator('#model-setup button').isEnabled());
}
try {
  // A missing config must have a visible model-selection entry without expanding help.
  await launch(directory); await findControls();
  await controls.screenshot({ path: path.join(directory, 'first-start.png') });
  assert.equal(await controls.locator('#model-setup button').isVisible(), true);
  assert.equal(await controls.locator('#call').isEnabled(), false);
  await controls.screenshot({ path: path.join(directory, 'first-start.png') });
  check('Fresh settings expose model selection and keep unavailable actions disabled.');
  await select(config.modelPath, true);
  assert.equal(await controls.locator('#model-setup button').isVisible(), true);
  check('Cancelling first selection preserves the setup entry.');
  const invalid = path.join(directory, 'invalid.vrm'); await writeFile(invalid, 'not a model');
  await select(invalid);
  assert.match(await controls.locator('#model-setup-message').textContent(), /VRMは100MB以下/);
  await controls.screenshot({ path: path.join(directory, 'invalid-selection.png') });
  assert.equal(await controls.locator('#model-setup button').isVisible(), true);
  check('Invalid selection shows an error and remains recoverable.');
  await select(config.modelPath);
  await waitFor(() => main(() => __shizuku.status().modelLoaded));
  await waitFor(async () => !(await controls.locator('#model-setup').isVisible()));
  assert.equal(await controls.locator('#call').isEnabled(), true);
  await controls.screenshot({ path: path.join(directory, 'ready.png') });
  check('Explicit valid selection loads the model and removes the setup prompt.');
  await close();
  await launch(directory);
  await waitFor(() => main(() => __shizuku.status().modelLoaded));
  assert.equal(await main(() => !!__shizuku.controls()), false);
  check('Restart restores the chosen model without opening controls.');
  await close();
  const missing = path.join(directory, 'missing.vrm');
  for (const [label, content] of [['malformed', '{'], ['missing-model', JSON.stringify({ modelPath: missing })], ['invalid-model', JSON.stringify({ modelPath: invalid })]]) {
    const dir = await mkdtemp(path.join(root, 'work', 'startup-'));
    await writeFile(path.join(dir, 'local.config.json'), content);
    await launch(dir); await findControls();
    await waitFor(async () => (label === 'malformed' ? /利用条件を確認/ : /VRMを読めません/).test(await controls.locator('#model-setup-message').textContent()));
    assert.equal(await controls.locator('#model-setup button').isVisible(), true);
    assert.equal(await controls.locator('#call').isEnabled(), false);
    await select(config.modelPath);
    await waitFor(() => main(() => __shizuku.status().modelLoaded));
    check(`${label}: model can be selected again without restarting the app.`);
    await close();
  }
  await heldStartup(config.modelPath);
  await avatarNotice({ ok: false, loading: 'invalid', error: 'invalid loading flag' });
  assert.notEqual(await main(() => __shizuku.status().loadError), 'invalid loading flag');
  await avatarNotice({ ok: true, loading: true });
  assert.equal(await main(() => __shizuku.status().modelLoaded), false);
  await avatarNotice({ ok: false, loading: false, recovering: true, error: 'Waiting for drawing recovery' });
  assert.equal(await main(() => !!__shizuku.controls()), false);
  await releaseStartup();
  await waitFor(() => main(() => __shizuku.status().modelLoaded));
  assert.equal(await main(() => !!__shizuku.controls()), false);
  check('Loading and temporary context recovery do not open controls; invalid readiness flags are rejected, and successful startup remains quiet.');
  await close();

  await heldStartup(missing);
  await main(({ BrowserWindow }) => {
    globalThis.__startupFocusFixture = new BrowserWindow({ width: 300, height: 160, title: 'Startup focus fixture', show: true,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
    __startupFocusFixture.focus();
  });
  await waitFor(() => main(() => __startupFocusFixture.isFocused()));
  await releaseStartup(); await findControls();
  assert.equal(await main(() => __startupFocusFixture.isFocused()), true);
  assert.equal(await main(() => __shizuku.controls().isFocused()), false);
  await controls.screenshot({ path: path.join(directory, 'automatic-recovery.png') });
  await main(() => __shizuku.controls().close());
  await avatarNotice({ ok: false, loading: false, error: 'Repeated terminal failure' });
  assert.equal(await main(() => !!__shizuku.controls()), false);
  check('Failed startup shows recovery once without taking focus from a test-owned window; closing it suppresses repeated failure notices (Electron API focus check).');
  await close();

  for (const interruption of ['hide', 'rest', 'controls-close']) {
    await heldStartup(missing);
    if (interruption === 'hide') await main(() => __shizuku.setVisible(false));
    if (interruption === 'rest') await main(({ powerMonitor }) => powerMonitor.emit('lock-screen'));
    if (interruption === 'controls-close') {
      await main(() => __shizuku.openControls()); await findControls();
      await main(() => __shizuku.controls().close());
    }
    await releaseStartup();
    await waitFor(() => main(() => /VRMを読めません/.test(__shizuku.status().loadError)));
    assert.equal(await main(() => !!__shizuku.controls()), false);
    if (interruption === 'rest') await main(({ powerMonitor }) => powerMonitor.emit('unlock-screen'));
    if (interruption === 'hide') await main(() => __shizuku.setVisible(true));
    await avatarNotice({ ok: false, loading: false, error: 'Repeated failure after restoration' });
    assert.equal(await main(() => !!__shizuku.controls()), false);
    check(`${interruption}: a delayed startup failure and later restoration never reopen controls.`);
    await close();
  }

  await heldStartup(missing);
  await main(() => __shizuku.openControls()); await findControls();
  await select(config.modelPath);
  await waitFor(() => main(() => __shizuku.status().modelLoaded));
  await main(() => __shizuku.controls().close());
  await releaseStartup(); await delay(200);
  assert.equal(await main(() => __shizuku.status().modelLoaded), true);
  assert.equal(await main(() => __shizuku.status().loadError), '');
  assert.equal(await main(() => !!__shizuku.controls()), false);
  check('Selecting a new model supersedes a held startup load; its late failure cannot overwrite the successful model or reopen controls.');
  await main(() => __shizuku.setTextureQuality('compact'));
  await waitFor(() => main(() => __shizuku.status().modelLoaded));
  assert.equal(await main(() => !!__shizuku.controls()), false);
  check('Ordinary quality reloads do not rearm automatic startup recovery.');
  await close();

  for (const interruption of ['hide', 'explicit-open']) {
    await heldStartup(missing); await holdControlsReady();
    await releaseStartup(); await findControls(false);
    await waitFor(() => main(() => !!__releaseControlsReady));
    assert.equal(await main(() => __shizuku.controls().isVisible()), false);
    if (interruption === 'hide') await main(() => __shizuku.setVisible(false));
    else await main(() => __shizuku.openControls());
    await main(() => __releaseControlsReady());
    if (interruption === 'hide') {
      await waitFor(() => main(() => !__shizuku.controls()));
    } else {
      assert.equal(await main(() => __shizuku.controls()?.isVisible()), true);
    }
    check(`${interruption}: delayed recovery-window readiness respects newer visibility or explicit-open intent.`);
    await close();
  }

  await heldStartup(missing); await holdControlsReady();
  await releaseStartup(); await findControls(false);
  await waitFor(() => main(() => !!__releaseControlsReady));
  assert.equal(await main(() => __shizuku.controls().isVisible()), false);
  const pickerParent = await main(() => __shizuku.controls().id);
  await app.evaluate(({ dialog }, modelPath) => {
    globalThis.__startupPicker = { parent: null, parentClosed: false, resolve: null, done: false, error: null };
    dialog.showOpenDialog = async parent => {
      __startupPicker.parent = parent.id;
      parent.once('closed', () => { __startupPicker.parentClosed = true; });
      return new Promise(resolve => {
        __startupPicker.resolve = () => resolve({ canceled: false, filePaths: [modelPath] });
      });
    };
    void __shizuku.action('choose-model').then(() => { __startupPicker.done = true; }, () => { __startupPicker.error = 'Selection failed'; });
  }, config.modelPath);
  await waitFor(() => main(() => !!__startupPicker.resolve));
  assert.equal(await main(() => __startupPicker.parent), pickerParent);
  assert.equal(await main(() => __shizuku.controls().isVisible()), true);
  await main(() => __releaseControlsReady());
  assert.equal(await main(() => __startupPicker.parentClosed), false);
  assert.equal(await main(() => __shizuku.controls()?.id), pickerParent);
  assert.equal(await main(() => __startupPicker.done), false);
  await main(() => __startupPicker.resolve());
  await waitFor(() => main(() => __startupPicker.done && __shizuku.status().modelLoaded));
  assert.equal(await main(() => __startupPicker.error), null);
  assert.equal(await main(() => __startupPicker.parentClosed), false);
  check('Explicit model selection takes over a pending recovery window; delayed readiness cannot close its picker parent, and selection completes successfully.');
  await close();
} catch (error) { failure = error; report.error = error.stack; }
finally {
  if (app) { await record().catch(() => {}); await app.close().catch(() => {}); }
  report.processCheck = await inspectProcessIdentities(identities, directory);
  report.settingsUnchanged = (await readFile(path.join(root, 'local.config.json'))).equals(settings);
  report.modelUnchanged = hash(await readFile(config.modelPath)) === modelHash;
  report.buildUnchanged = true;
  for (const [name, value] of Object.entries(buildHashes)) if (hash(await readFile(path.join(root, 'dist', name))) !== value) report.buildUnchanged = false;
  if (report.processCheck.remainingPids.length || report.processCheck.unverifiablePids.length || !report.settingsUnchanged || !report.modelUnchanged || !report.buildUnchanged) failure ??= new Error('Cleanup or file identity failed');
  report.status = failure ? 'failed' : 'passed'; report.finishedAt = new Date().toISOString();
  await writeFile(path.join(directory, 'result.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ status: report.status, directory, checks: report.checks.length }));
}
if (failure) throw failure;
