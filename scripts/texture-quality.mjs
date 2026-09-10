// Real Electron/Three images and the actual saved quality preference. Own windows
// only: this does not certify native input, other monitors or long-term memory.
import { _electron } from 'playwright';
import electron from 'electron';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const normal = path.join(root, 'local.config.json'), before = await readFile(normal);
const selected = JSON.parse(before.toString('utf8').replace(/^\uFEFF/, ''));
assert.ok(typeof selected.modelPath === 'string' && selected.modelPath,
  'Select a local VRM with at least one embedded image larger than 1024 pixels before running these checks.');
await mkdir(path.join(root, 'work'), { recursive: true });
const directory = await mkdtemp(path.join(root, 'work', 'texture-quality-'));
const settingsPath = path.join(directory, 'local.config.json');
await writeFile(settingsPath, JSON.stringify({ modelPath: selected.modelPath, quiet: true, scale: 100, textureQuality: 'unknown-old-setting' }));
const env = { ...process.env, SHIZUKU_TEST: '1', SHIZUKU_TEST_DATA: path.basename(directory), SHIZUKU_METRICS: '0' };
delete env.OPENAI_API_KEY;
delete env.ELECTRON_RUN_AS_NODE;
const pids = new Set();
const report = { status: 'running', startedAt: new Date().toISOString(), results: [], snapshots: [], remainingPids: null, userSettingsUnchanged: null };
let application, page, controls, failure, generation = 0, perModel = 0, largeImages = 0;
const pass = message => { report.results.push(message); console.log(JSON.stringify({ passed: report.results.length, check: message })); };
const diagnostic = () => page.evaluate(() => { const { modelName, ...state } = window.__diagnostics; return state; });
const reads = () => application.evaluate(() => globalThis.__textureReadProbe.reads);
const probe = () => page.evaluate(() => {
  const p = window.__textureProbe;
  return { generation: p.generation, images: p.images.map(image => ({ ...image })), inFlight: p.inFlight,
    decodeCalls: p.decodeCalls, resizeCalls: p.resizeCalls, resizeFailures: p.resizeFailures, pending: p.pending.length };
});
const summary = state => ({ decoded: state.decodeCalls, resized: state.resizeCalls, resizeFailures: state.resizeFailures,
  created: state.images.length, closed: state.images.filter(x => x.closed === 1).length,
  open: state.images.filter(x => x.closed === 0).length, rgbaBytes: state.images.filter(x => x.closed === 0).reduce((sum, x) => sum + x.width * x.height * 4, 0), inFlight: state.inFlight });
async function recordPids() {
  if (!application) return;
  pids.add(application.process().pid);
  const state = await application.evaluate(() => ({ processes: __shizuku.metrics(), helper: __shizuku.tracking().pid }));
  for (const item of state.processes) pids.add(item.pid);
  if (Number.isSafeInteger(state.helper) && state.helper > 0) pids.add(state.helper);
}
async function launch({ testData = path.basename(directory), hasModel = true } = {}) {
  application = await _electron.launch({ executablePath: electron, args: [root], cwd: root,
    env: { ...env, SHIZUKU_TEST_DATA: testData } });
  pids.add(application.process().pid);
  page = await application.firstWindow(); page.setDefaultTimeout(20_000);
  await page.waitForFunction(hasModel => window.__diagnostics?.quiet
    && (hasModel ? window.__diagnostics.loaded : !window.__diagnostics.loaded && !!window.__diagnostics.error), hasModel);
  await recordPids();
}
async function installProbes() {
  // Observe selected-file reads without replacing the model IPC handler or gate.
  await application.evaluate((_electron, selectedPath) => {
    const fs = process.getBuiltinModule('fs/promises'), paths = process.getBuiltinModule('path');
    const original = fs.readFile, expected = paths.resolve(selectedPath).toLowerCase();
    globalThis.__textureReadProbe = { original, reads: 0 };
    fs.readFile = async function(file, ...args) {
      if (typeof file === 'string' && paths.resolve(file).toLowerCase() === expected) __textureReadProbe.reads++;
      return original.call(this, file, ...args);
    };
  }, selected.modelPath);
  await page.evaluate(() => {
    const create = window.createImageBitmap, close = ImageBitmap.prototype.close, ids = new WeakMap();
    const p = window.__textureProbe = { generation: 0, images: [], inFlight: 0, decodeCalls: 0, resizeCalls: 0,
      resizeFailures: 0, failResize: false, holdResize: false, pending: [] };
    ImageBitmap.prototype.close = function() {
      const image = ids.get(this); if (image) image.closed++;
      return close.call(this);
    };
    window.createImageBitmap = async function(...args) {
      const generation = p.generation, kind = args[0] instanceof ImageBitmap ? 'resized' : 'decoded';
      const hold = kind === 'resized' && p.holdResize;
      p.inFlight++;
      if (kind === 'resized') p.resizeCalls++; else p.decodeCalls++;
      try {
        if (kind === 'resized' && p.failResize) { p.resizeFailures++; throw new Error('Controlled resize failure'); }
        const bitmap = await create.apply(this, args);
        const image = { id: p.images.length, generation, kind, width: bitmap.width, height: bitmap.height, closed: 0 };
        p.images.push(image); ids.set(bitmap, image);
        if (hold) await new Promise(resolve => p.pending.push(resolve));
        return bitmap;
      } finally { p.inFlight--; }
    };
  });
}
async function nextGeneration() {
  generation++;
  await page.evaluate(value => { window.__textureProbe.generation = value; }, generation);
  return generation;
}
async function waitLoaded(quality) {
  await page.waitForFunction(({ quality, generation }) => window.__diagnostics.loaded
    && window.__diagnostics.textureQuality === quality && window.__textureProbe.inFlight === 0
    && window.__textureProbe.images.some(image => image.generation === generation), { quality, generation });
  await recordPids();
}
async function actionQuality(quality) {
  await nextGeneration();
  await application.evaluate((_electron, quality) => __shizuku.setTextureQuality(quality), quality);
  await waitLoaded(quality);
}
async function checkCurrent(quality, { fallback = false } = {}) {
  const state = await probe(), current = state.images.filter(x => x.generation === generation), open = state.images.filter(x => x.closed === 0);
  const d = await diagnostic();
  assert.equal(open.length, perModel);
  assert.ok(state.images.filter(x => x.generation !== generation).every(x => x.closed === 1), 'Every discarded model image must close once.');
  assert.ok(current.every(x => x.closed === 0 || x.closed === 1), 'Images must not close twice.');
  assert.equal(state.inFlight, 0);
  if (quality === 'compact' && !fallback) {
    assert.ok(open.every(x => Math.max(x.width, x.height) <= 1024));
    assert.equal(current.filter(x => x.kind === 'resized' && x.closed === 0).length, largeImages);
    assert.equal(current.filter(x => x.kind === 'decoded' && x.closed === 1).length, largeImages);
    assert.equal(d.resizedImages, largeImages); assert.equal(d.imageResizeFallbacks, 0);
  } else {
    assert.equal(open.filter(x => Math.max(x.width, x.height) > 1024).length, largeImages);
    assert.ok(open.every(x => x.kind === 'decoded'));
    assert.equal(d.resizedImages, 0); assert.equal(d.imageResizeFallbacks, fallback ? largeImages : 0);
  }
  report.snapshots.push({ generation, quality, fallback, diagnostics: d, ...summary(state) });
  return state;
}
async function capture(name) {
  const image = await application.evaluate(async () => {
    const captured = await __shizuku.avatar().webContents.capturePage(), pixels = captured.toBitmap();
    let transparent = 0, visible = 0;
    for (let i = 3; i < pixels.length; i += 4) { if (pixels[i] === 0) transparent++; else visible++; }
    return { ...captured.getSize(), transparent, visible, png: captured.toPNG().toString('base64') };
  });
  assert.ok(image.transparent > 100 && image.visible > 100, 'Capture must contain the model and transparency.');
  await writeFile(path.join(directory, name), Buffer.from(image.png, 'base64'));
  delete image.png; return image;
}
async function openControls() {
  controls = application.windows().find(candidate => candidate.url().endsWith('/controls.html'));
  if (!controls) {
    const opened = application.waitForEvent('window');
    await application.evaluate(() => __shizuku.openControls());
    controls = await opened;
  }
  controls.setDefaultTimeout(20_000);
  await controls.waitForSelector('input[name="texture-quality"]', { state: 'attached' });
  if (!await controls.locator('details').evaluate(element => element.open)) await controls.locator('summary').click();
}
async function waitMain(predicate) {
  const deadline = performance.now() + 5000;
  while (performance.now() < deadline) {
    if (await application.evaluate(predicate)) return;
    await delay(50);
  }
  throw new Error('Main-process availability did not settle within five seconds.');
}
async function savedQuality(quality) {
  const deadline = performance.now() + 5000;
  while (performance.now() < deadline) {
    const saved = JSON.parse((await readFile(settingsPath)).toString('utf8').replace(/^\uFEFF/, ''));
    assert.equal(saved.modelPath, selected.modelPath, 'Quality changes must never change the selected model path.');
    if (saved.textureQuality === quality) return;
    await delay(50);
  }
  throw new Error('Quality preference did not reach the isolated settings file.');
}
async function close() {
  if (!application) return;
  try {
    await page.evaluate(() => { if (window.__textureProbe) { __textureProbe.holdResize = false; for (const resolve of __textureProbe.pending.splice(0)) resolve(); } });
    await application.evaluate(() => { if (globalThis.__textureReadProbe) process.getBuiltinModule('fs/promises').readFile = __textureReadProbe.original; });
    await recordPids();
  } catch { /* Preserve every PID collected before a renderer or main failure. */ }
  const current = application; application = null;
  await current.close();
}

try {
  await launch();
  assert.equal((await diagnostic()).textureQuality, 'original');
  assert.equal(await application.evaluate(() => __shizuku.status().textureQuality), 'original');
  await installProbes(); await nextGeneration();
  await application.evaluate(() => __shizuku.avatar().webContents.send('model:changed'));
  await waitLoaded('original');
  const first = await probe(); perModel = first.images.length;
  largeImages = first.images.filter(x => Math.max(x.width, x.height) > 1024).length;
  assert.ok(perModel > 0 && largeImages > 0,
    'This check requires a selected VRM with ImageBitmap textures and at least one embedded image larger than 1024 pixels.');
  await checkCurrent('original'); assert.equal(await reads(), 1);
  report.original = await capture('original-standing.png');
  pass('An unknown saved preference defaults to original image dimensions through the real model read and decoder.');

  await openControls();
  assert.equal(await controls.locator('input[name="texture-quality"][value="original"]').isChecked(), true);
  const security = {
    controlsModelQualityDenied: await controls.evaluate(async () => { try { await companion.getTextureQuality(); return false; } catch { return true; } }),
    controlsModelReadDenied: await controls.evaluate(async () => { try { await companion.getModel(); return false; } catch { return true; } }),
    avatarControlsActionDenied: await page.evaluate(async () => { try { await companion.action('texture-compact'); return false; } catch { return true; } }),
    unknownActionDenied: await controls.evaluate(async () => { try { await companion.action('texture-invalid'); return false; } catch { return true; } }),
    unknownQualityDenied: await application.evaluate(() => { try { __shizuku.setTextureQuality('invalid'); return false; } catch { return true; } }),
  };
  assert.ok(Object.values(security).every(Boolean)); report.security = security;
  assert.equal(await reads(), 1); assert.equal((await diagnostic()).textureQuality, 'original');
  pass('Model reads/quality remain avatar-only, setting actions remain controls-only, and unknown quality values/actions are rejected.');

  await nextGeneration();
  await controls.locator('input[name="texture-quality"][value="compact"]').check();
  await waitLoaded('compact'); await checkCurrent('compact'); await savedQuality('compact');
  assert.equal(await controls.locator('input[name="texture-quality"][value="compact"]').isChecked(), true);
  await capture('compact-standing.png');
  await controls.locator('#texture-hint').scrollIntoViewIfNeeded();
  await controls.screenshot({ path: path.join(directory, 'controls-quality-viewport.png') });
  assert.equal(await controls.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  pass('The real controls radio enables compact images, releases full-size originals and previous models, saves the choice, and fits the window width.');

  const sameReads = await reads(), sameProbe = await probe();
  await controls.evaluate(() => companion.action('texture-compact'));
  await delay(350);
  assert.equal(await reads(), sameReads); assert.deepEqual(await probe(), sameProbe);
  pass('Selecting the current quality performs no file read or image decode.');

  await nextGeneration();
  await controls.locator('input[name="texture-quality"][value="original"]').check();
  await waitLoaded('original'); await checkCurrent('original'); await savedQuality('original');
  pass('The original-quality radio restores original dimensions and releases the compact model images.');

  await page.evaluate(() => { __textureProbe.failResize = true; });
  await actionQuality('compact'); await checkCurrent('compact', { fallback: true });
  await page.evaluate(() => { __textureProbe.failResize = false; });
  assert.equal((await probe()).resizeFailures, largeImages);
  pass('A controlled browser-resize rejection falls back to the still-live original images without losing the model.');

  await application.evaluate(() => __shizuku.setVisible(false));
  await page.waitForFunction(() => !__diagnostics.visible);
  const hiddenFrames = (await diagnostic()).renderedFrames;
  await actionQuality('original'); await checkCurrent('original');
  await actionQuality('compact'); await checkCurrent('compact');
  assert.equal((await diagnostic()).renderedFrames, hiddenFrames);
  assert.equal(await application.evaluate(() => __shizuku.avatar().isVisible()), false);
  await application.evaluate(() => __shizuku.setVisible(true));
  await page.waitForFunction(count => __diagnostics.visible && __diagnostics.renderedFrames > count, hiddenFrames);
  await capture('compact-after-hidden-change.png');
  pass('Changing quality while hidden stays hidden and frame-free; explicit show renders the latest compact model.');

  const contextProbe = await probe();
  await page.evaluate(() => {
    const gl = document.querySelector('canvas').getContext('webgl2');
    window.__textureContext = gl.getExtension('WEBGL_lose_context');
    if (!__textureContext) throw new Error('The own renderer has no context-loss extension.');
    __textureContext.loseContext();
  });
  await page.waitForFunction(() => __diagnostics.contextLost);
  const lostFrames = (await diagnostic()).renderedFrames;
  await delay(250); assert.equal((await diagnostic()).renderedFrames, lostFrames);
  await page.evaluate(() => __textureContext.restoreContext());
  await page.waitForFunction(count => !__diagnostics.contextLost && __diagnostics.loaded && __diagnostics.visible
    && __diagnostics.renderedFrames > count, lostFrames);
  assert.deepEqual(await probe(), contextProbe); await checkCurrent('compact');
  await capture('compact-context-restored.png');
  assert.equal(await application.evaluate(() => __shizuku.avatar().isFocusable()), false);
  pass('Compact images survive own WebGL context loss/restoration without any additional bitmap creation; visibility and a non-focusable avatar recover.');

  await page.evaluate(() => __textureContext.loseContext());
  await page.waitForFunction(() => __diagnostics.contextLost);
  await waitMain(() => __shizuku.status().contextRecovering && !__shizuku.status().modelLoaded);
  const changingDuringLossFrames = (await diagnostic()).renderedFrames;
  for (const quality of ['original', 'compact']) {
    await actionQuality(quality); await checkCurrent(quality);
    await waitMain(() => __shizuku.status().contextRecovering && !__shizuku.status().modelLoaded);
    assert.equal((await diagnostic()).contextLost, true);
    assert.equal((await diagnostic()).renderedFrames, changingDuringLossFrames);
    assert.equal(await application.evaluate(() => __shizuku.trayMenu().items.find(item => item.label === '呼ぶ').enabled), false);
    await application.evaluate(() => __shizuku.action('call'));
    assert.equal(await application.evaluate(() => __shizuku.dialogue()), null);
  }
  const changedWhileLost = await probe();
  await page.evaluate(() => __textureContext.restoreContext());
  await page.waitForFunction(count => !__diagnostics.contextLost && __diagnostics.loaded
    && __diagnostics.renderedFrames > count, changingDuringLossFrames);
  await waitMain(() => !__shizuku.status().contextRecovering && __shizuku.status().modelLoaded);
  assert.deepEqual(await probe(), changedWhileLost); await capture('compact-changed-during-context-loss.png');
  pass('Quality changes during context loss preserve the unavailable state, disabled call and stopped frames until the latest compact model restores.');

  await actionQuality('original');
  await page.evaluate(() => { __textureProbe.holdResize = true; });
  await nextGeneration();
  await application.evaluate(() => __shizuku.setTextureQuality('compact'));
  await page.waitForFunction(() => __textureProbe.pending.length > 0);
  await page.evaluate(() => { __textureProbe.holdResize = false; });
  await nextGeneration();
  await application.evaluate(() => __shizuku.setTextureQuality('original'));
  // A held obsolete resize keeps inFlight positive, so wait for the current
  // original model itself and retain its exact image IDs before releasing it.
  await page.waitForFunction(generation => __diagnostics.loaded && __diagnostics.textureQuality === 'original'
    && __textureProbe.images.filter(x => x.generation === generation && x.kind === 'decoded' && !x.closed).length > 0, generation);
  const currentIds = (await probe()).images.filter(x => x.generation === generation && x.closed === 0).map(x => x.id);
  assert.equal(currentIds.length, perModel);
  await page.evaluate(() => { for (const resolve of __textureProbe.pending.splice(0)) resolve(); });
  await page.waitForFunction(ids => __textureProbe.inFlight === 0 && __textureProbe.images.every(x => ids.includes(x.id) ? x.closed === 0 : x.closed === 1), currentIds);
  const overlapped = await probe(); assert.equal((await diagnostic()).textureQuality, 'original');
  assert.equal((await diagnostic()).loaded, true); report.overlap = { currentIds, ...summary(overlapped) };
  await capture('original-after-obsolete-resize.png');
  pass('An obsolete held compact resize cannot replace or close the newer original model; all late and discarded images close exactly once.');

  await actionQuality('compact'); await checkCurrent('compact'); await savedQuality('compact');
  await application.evaluate(() => { __shizuku.setPosture('sitting'); __shizuku.setScale(120); });
  await page.waitForFunction(() => __diagnostics.posture === 'sitting' && !__diagnostics.changingPosture);
  await delay(250); await capture('compact-sitting-large.png');
  await close(); await launch();
  const restarted = await diagnostic();
  assert.equal(restarted.textureQuality, 'compact'); assert.equal(restarted.resizedImages, largeImages);
  assert.equal(restarted.imageResizeFallbacks, 0);
  await savedQuality('compact'); await openControls();
  assert.equal(await controls.locator('input[name="texture-quality"][value="compact"]').isChecked(), true);
  report.restarted = restarted; await capture('compact-after-restart.png');
  pass('A new app process reads the saved compact preference and renders resized images, with the controls radio restored.');

  await close();
  const emptyDirectory = await mkdtemp(path.join(root, 'work', 'texture-quality-empty-'));
  const emptySettings = path.join(emptyDirectory, 'local.config.json');
  await writeFile(emptySettings, JSON.stringify({ quiet: true }));
  report.emptyTestData = path.basename(emptyDirectory);
  await launch({ testData: path.basename(emptyDirectory), hasModel: false });
  await installProbes(); await openControls();
  const emptyFrames = (await diagnostic()).renderedFrames;
  assert.equal(await controls.locator('input[name="texture-quality"][value="compact"]').isEnabled(), true);
  await controls.locator('input[name="texture-quality"][value="compact"]').check();
  await waitMain(() => __shizuku.status().textureQuality === 'compact' && !__shizuku.status().modelLoaded && !!__shizuku.status().loadError);
  await delay(650);
  const savedEmpty = JSON.parse(await readFile(emptySettings, 'utf8'));
  assert.equal(savedEmpty.textureQuality, 'compact'); assert.equal(savedEmpty.modelPath, '');
  assert.equal(await page.evaluate(() => companion.getTextureQuality()), 'compact');
  assert.equal(await reads(), 0); assert.equal((await probe()).images.length, 0);
  assert.equal((await diagnostic()).renderedFrames, emptyFrames);
  assert.equal(await controls.locator('[data-action="choose-model"]').isEnabled(), true);
  assert.equal(await controls.locator('[data-action="quit"]').isEnabled(), true);
  pass('With no model selected, compact quality remains selectable and saved; no model reads, image creation or repeating frames occur, and model selection/exit stay available.');
} catch (error) {
  failure = error; report.failure = error instanceof Error ? error.message : String(error);
  if (page) { try { report.failureProbe = await probe(); report.failureDiagnostics = await diagnostic(); } catch { /* The renderer may already be gone. */ } }
} finally {
  try { await close(); } catch (error) { failure ??= error; report.cleanupFailure = String(error); }
  for (let attempt = 0; attempt < 20; attempt++) {
    report.remainingPids = [...pids].filter(pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; } });
    if (!report.remainingPids.length) break;
    await delay(250);
  }
  try { report.userSettingsUnchanged = (await readFile(normal)).equals(before); }
  catch (error) { report.settingsReadFailure = String(error); }
  report.recordedPids = [...pids];
  if (report.remainingPids.length || report.userSettingsUnchanged !== true) failure ??= new Error('Recorded processes remain or normal user settings changed.');
  if (!failure) pass('All recorded launcher, Electron and helper processes exit; normal user settings remain byte-for-byte unchanged.');
  report.status = failure ? 'failed' : 'passed'; report.finishedAt = new Date().toISOString();
  await writeFile(path.join(directory, 'result.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ directory, status: report.status, passed: report.results.length, remainingPids: report.remainingPids, userSettingsUnchanged: report.userSettingsUnchanged, failure: report.failure }));
}
if (failure) throw failure;
