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
async function launch(dir) {
  const env = { ...process.env, SHIZUKU_TEST: '1', SHIZUKU_TEST_DATA: path.basename(dir), SHIZUKU_METRICS: '0' };
  for (const key of ['OPENAI_API_KEY', 'ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS']) delete env[key];
  app = await _electron.launch({ executablePath: electron, args: [root], cwd: root, env });
  const child = app.process();
  identities.push({ pid: child.pid, name: path.basename(electron), parentPid: process.pid });
  child.once('exit', (code, signal) => report.exits.push({ code, signal }));
  await waitFor(() => main(() => !!globalThis.__shizuku));
  await main(() => { globalThis.__startupNetwork = 0; globalThis.fetch = async () => { __startupNetwork++; throw new Error('Network disabled'); }; });
  await record();
}
async function openControls() {
  await main(() => __shizuku.openControls());
  const id = await main(() => __shizuku.controls().id);
  await waitFor(() => app.windows().some(p => p.url().endsWith('/controls.html')));
  controls = app.windows().find(p => p.url().endsWith('/controls.html'));
  await controls.waitForSelector('#model', { state: 'attached' });
  assert.ok(id);
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
  await launch(directory); await openControls();
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
  for (const [label, content] of [['malformed', '{'], ['missing-model', JSON.stringify({ modelPath: path.join(directory, 'missing.vrm') })]]) {
    const dir = await mkdtemp(path.join(root, 'work', 'startup-'));
    await writeFile(path.join(dir, 'local.config.json'), content);
    await launch(dir); await openControls();
    await waitFor(async () => (label === 'missing-model' ? /VRMを読めません/ : /利用条件を確認/).test(await controls.locator('#model-setup-message').textContent()));
    assert.equal(await controls.locator('#model-setup button').isVisible(), true);
    assert.equal(await controls.locator('#call').isEnabled(), false);
    await select(config.modelPath);
    await waitFor(() => main(() => __shizuku.status().modelLoaded));
    check(`${label}: model can be selected again without restarting the app.`);
    await close();
  }
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
