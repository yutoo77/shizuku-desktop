// Explicit local model only; this command never downloads assets or changes the
// normal model selection. Check that model's terms before supplying its path.
import { _electron } from 'playwright';
import electron from 'electron';
import assert from 'node:assert/strict';
import { readFile, writeFile, stat, mkdtemp } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { MAX_MODEL_BYTES, validateModel } from '../src/model-policy.mjs';
import { inspectProcessIdentities } from './process-check.mjs';

const args = process.argv.slice(2);
assert.ok(args.length === 2 && args[0] === '--model' && path.isAbsolute(args[1]), 'Use --model with an absolute path to a permitted local VRM.');
const modelPath = args[1], info = await stat(modelPath);
assert.ok(info.isFile() && info.size <= MAX_MODEL_BYTES && path.extname(modelPath).toLowerCase() === '.vrm');
const bytes = await readFile(modelPath), json = validateModel(bytes);
const hash = value => createHash('sha256').update(value).digest('hex');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const normal = path.join(root, 'local.config.json'), before = await readFile(normal);
const directory = await mkdtemp(path.join(root, 'work', 'model-compatibility-'));
await writeFile(path.join(directory, 'local.config.json'), JSON.stringify({ modelPath, quiet: true, textureQuality: 'original' }));
const env = { ...process.env, SHIZUKU_TEST: '1', SHIZUKU_TEST_DATA: path.basename(directory), SHIZUKU_METRICS: '0' };
delete env.OPENAI_API_KEY; delete env.ELECTRON_RUN_AS_NODE;
const report = { status: 'running', startedAt: new Date().toISOString(), modelSha256: hash(bytes), modelBytes: bytes.length,
  format: json.extensions.VRMC_vrm ? 'VRM 1' : 'VRM 0', images: json.images?.length ?? 0,
  buildSha256: hash(await readFile(path.join(root, 'dist/renderer.js'))),
  mainBuildSha256: hash(await readFile(path.join(root, 'dist/main.cjs'))), checks: [], snapshots: [], captures: [], rendererHttpAttempts: 0 };
const identities = new Map();
let app, page, exit, failure;
const main = fn => app.evaluate(fn);
const check = message => { report.checks.push(message); console.log(JSON.stringify({ check: message })); };
async function processes() {
  const value = await main(() => ({ metrics: __shizuku.metrics(), helper: __shizuku.tracking().pid, parent: process.pid }));
  for (const item of value.metrics) identities.set(`${item.pid}:${item.creationTime}`, { pid: item.pid, creationTime: item.creationTime });
  if (value.helper) identities.set(`helper:${value.helper}`, { pid: value.helper, name: 'window-tracker.exe', parentPid: value.parent });
}
async function settled(quality) {
  await page.waitForFunction(quality => __diagnostics.loaded && __diagnostics.textureQuality === quality
    && !__diagnostics.contextLost && !__diagnostics.reacting && !__diagnostics.animating, quality, { polling: 100, timeout: 20_000 });
  await processes();
  const state = await page.evaluate(() => { const { modelName, ...d } = __diagnostics; return d; });
  report.snapshots.push(state); return state;
}
async function capture(name) {
  const value = await main(async () => {
    const img = await __shizuku.avatar().webContents.capturePage();
    const rgba = img.toBitmap(); let transparent = 0, visible = 0;
    for (let i = 3; i < rgba.length; i += 4) { if (rgba[i]) visible++; else transparent++; }
    return { ...img.getSize(), transparent, visible, png: img.toPNG().toString('base64') };
  });
  assert.ok(value.transparent > 100 && value.visible > 100, 'Model and transparency must both be present.');
  await writeFile(path.join(directory, name), Buffer.from(value.png, 'base64'));
  const fingerprint = hash(Buffer.from(value.png, 'base64')); delete value.png;
  report.captures.push({ name, ...value, sha256: fingerprint }); return fingerprint;
}
try {
  app = await _electron.launch({ executablePath: electron, args: [root], cwd: root, env, timeout: 20_000 });
  const child = app.process();
  identities.set(`launcher:${child.pid}`, { pid: child.pid, name: path.basename(electron), parentPid: process.pid });
  child.once('exit', (code, signal) => { exit = { code, signal }; });
  page = await app.firstWindow();
  app.context().on('request', request => { if (/^https?:/i.test(request.url())) report.rendererHttpAttempts++; });
  const original = await settled('original');
  await capture('original-standing.png');
  assert.equal(await main(() => __shizuku.avatar().isFocusable()), false);
  check('The explicit local model loads with transparency and a nonfocusable avatar window.');

  await main(() => __shizuku.setTextureQuality('compact'));
  const compact = await settled('compact');
  assert.equal(compact.imageResizeFallbacks, 0);
  await capture('compact-standing.png');
  check('The actual compact setting reloads without image resize fallbacks.');

  await main(() => __shizuku.action('sit'));
  await main(() => __shizuku.action('face-left'));
  await settled('compact'); await capture('compact-sitting-left.png');
  await main(() => __shizuku.action('face-right'));
  await settled('compact'); await capture('compact-sitting-right.png');
  check('Sitting and both facings render through the normal app actions. Visual inspection remains separate.');

  await main(() => __shizuku.action('call'));
  await page.waitForFunction(() => __diagnostics.reacting, null, { polling: 50 });
  await processes();
  await main(() => __shizuku.dialogue().close());
  await settled('compact');
  const capturedBefore = await capture('before-context-recovery.png');
  await main(() => __shizuku.action('hide'));
  await page.waitForFunction(() => !__diagnostics.visible, null, { polling: 100 });
  await page.evaluate(() => {
    window.__compatibilityContext = document.querySelector('canvas').getContext('webgl2').getExtension('WEBGL_lose_context');
    if (!window.__compatibilityContext) throw new Error('Context loss fixture unavailable');
    window.__compatibilityContext.loseContext();
  });
  await page.waitForFunction(() => __diagnostics.contextLost, null, { polling: 100 });
  await page.evaluate(() => window.__compatibilityContext.restoreContext());
  await settled('compact');
  assert.equal(await main(() => __shizuku.avatar().isVisible()), false);
  await main(() => __shizuku.action('show'));
  await page.waitForFunction(() => __diagnostics.visible, null, { polling: 100 });
  await settled('compact');
  assert.equal(await capture('after-context-recovery.png'), capturedBefore);
  check('Call completion and hidden WebGL recovery retain the model; restored static pixels match.');

  await main(() => __shizuku.setTextureQuality('original'));
  const restored = await settled('original');
  assert.equal(restored.resizedImages, original.resizedImages);
  await capture('restored-original-sitting.png');
  assert.equal(report.rendererHttpAttempts, 0);
  check('Original quality can be restored; no renderer HTTP requests were observed.');
  await processes(); await main(() => __shizuku.action('quit'));
  for (let i = 0; child.exitCode === null && i < 150; i++) await delay(100);
  assert.deepEqual(exit, { code: 0, signal: null });
  await app.close(); app = null;
} catch (error) { failure = error; }
finally {
  if (app) await app.close().catch(error => { failure ??= error; });
  try {
    const all = [...identities.values()], exact = new Set(all.filter(p => Number.isFinite(p.creationTime)).map(p => p.pid));
    report.processCheck = await inspectProcessIdentities(all.filter(p => Number.isFinite(p.creationTime) || !exact.has(p.pid)), directory);
    assert.deepEqual(report.processCheck.remainingPids, []); assert.deepEqual(report.processCheck.unverifiablePids, []);
    report.settingsUnchanged = (await readFile(normal)).equals(before);
    report.modelUnchanged = hash(await readFile(modelPath)) === report.modelSha256;
    assert.equal(report.settingsUnchanged, true); assert.equal(report.modelUnchanged, true);
  } catch (error) { failure ??= error; }
  report.exit = exit; report.status = failure ? 'failed' : 'passed'; report.error = failure?.stack;
  report.finishedAt = new Date().toISOString();
  await writeFile(path.join(directory, 'result.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ directory, status: report.status, checks: report.checks.length, error: failure?.message }));
}
if (failure) throw failure;
