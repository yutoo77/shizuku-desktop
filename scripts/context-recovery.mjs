// Lose only this app's WebGL context. No physical input or OS/GPU reset.
import { _electron } from 'playwright';
import electron from 'electron';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const settingsPath = path.join(root, 'local.config.json');
const before = await readFile(settingsPath);
const config = JSON.parse(before.toString('utf8').replace(/^\uFEFF/, ''));
assert.ok(typeof config.modelPath === 'string' && config.modelPath, 'Select a local VRM before running context recovery checks.');
await mkdir(path.join(root, 'work'), { recursive: true });
const directory = await mkdtemp(path.join(root, 'work', 'context-'));
await writeFile(path.join(directory, 'local.config.json'), JSON.stringify({ modelPath: config.modelPath, scale: 100 }));
const report = { startedAt: new Date().toISOString(), directory, results: [], snapshots: [], status: 'running', remainingPids: null, userSettingsUnchanged: null };
const pids = new Set();
let application;
let page;
let failure;
const inspect = fn => application.evaluate(fn);
const recordPids = async () => {
  const metrics = await inspect(() => globalThis.__shizuku.metrics());
  for (const process of metrics) {
    assert.ok(Number.isSafeInteger(process.pid) && process.pid > 0);
    pids.add(process.pid);
  }
};
const waitMain = async predicate => {
  const deadline = performance.now() + 5000;
  while (performance.now() < deadline) {
    if (await inspect(predicate)) return;
    await delay(50);
  }
  throw new Error('Main-process recovery state did not settle within five seconds.');
};
const diagnostics = () => page.evaluate(() => ({ ...window.__diagnostics }));
const probe = async () => ({
  reads: await inspect(() => globalThis.__contextReadProbe.reads),
  ...await page.evaluate(() => ({ decodedImages: window.__contextProbe.decodedImages,
    lostEvents: window.__contextProbe.lostEvents, restoredEvents: window.__contextProbe.restoredEvents })),
});
const pass = message => { report.results.push(message); console.log(JSON.stringify({ passed: report.results.length, check: message })); };
async function stoppedFrames() {
  const state = await diagnostics();
  assert.equal(state.animating, false);
  await delay(350);
  assert.equal((await diagnostics()).renderedFrames, state.renderedFrames, 'The renderer must not keep producing frames while unavailable or hidden.');
  return state.renderedFrames;
}
async function lose() {
  await page.evaluate(() => window.__contextProbe.extension.loseContext());
  await page.waitForFunction(() => window.__diagnostics.contextLost === true);
  await waitMain(() => {
    const s = globalThis.__shizuku;
    return !s.status().modelLoaded && s.status().contextRecovering === true && !s.moveState().active;
  });
  const state = await diagnostics();
  assert.equal(state.loaded, true, 'Context loss must retain the existing VRM.');
  assert.equal(state.moving, false);
  assert.equal(state.reacting, false);
  assert.equal(await page.evaluate(() => window.__contextProbe.gl.isContextLost()), true);
  const native = await inspect(() => {
    const s = globalThis.__shizuku;
    return { shape: s.moveState().shape, focusable: s.avatar().isFocusable(),
      callEnabled: s.trayMenu().items.find(item => item.label === '呼ぶ').enabled,
      moveEnabled: s.trayMenu().items.find(item => item.label === 'しずくをつかんで移動').enabled };
  });
  assert.deepEqual(native, { shape: [], focusable: false, callEnabled: false, moveEnabled: false });
  await stoppedFrames();
}
async function restore({ hidden = false } = {}) {
  const beforeFrames = (await diagnostics()).renderedFrames;
  await page.evaluate(() => window.__contextProbe.extension.restoreContext());
  await page.waitForFunction(() => window.__diagnostics.contextLost === false);
  await waitMain(() => globalThis.__shizuku.status().modelLoaded && !globalThis.__shizuku.status().contextRecovering);
  assert.equal((await diagnostics()).loaded, true);
  assert.equal((await diagnostics()).reacting, false, 'A cancelled call must not replay after restoration.');
  if (hidden) {
    assert.equal((await diagnostics()).visible, false);
    assert.equal((await diagnostics()).renderedFrames, beforeFrames);
    await stoppedFrames();
  } else {
    await page.waitForFunction(n => window.__diagnostics.renderedFrames > n, beforeFrames);
  }
  await recordPids();
}
async function capture(name) {
  const image = await inspect(async () => {
    const capture = await globalThis.__shizuku.avatar().webContents.capturePage();
    const bytes = capture.toBitmap();
    let transparent = 0, visible = 0;
    for (let index = 3; index < bytes.length; index += 4) { if (bytes[index] === 0) transparent++; else visible++; }
    return { ...capture.getSize(), transparent, visible, png: capture.toPNG().toString('base64') };
  });
  assert.equal(image.width, 300);
  assert.equal(image.height, 440);
  assert.ok(image.transparent > 100 && image.visible > 100, 'The restored native page must contain visible model pixels and transparency.');
  await writeFile(path.join(directory, name), Buffer.from(image.png, 'base64'));
  const { png, ...summary } = image;
  return summary;
}

try {
  application = await _electron.launch({ executablePath: electron, args: [root], cwd: root,
    env: { ...process.env, SHIZUKU_TEST: '1', SHIZUKU_TEST_DATA: path.basename(directory), SHIZUKU_METRICS: '0' } });
  const launchPid = application.process().pid;
  assert.ok(Number.isSafeInteger(launchPid) && launchPid > 0);
  pids.add(launchPid);
  page = await application.firstWindow();
  page.setDefaultTimeout(10_000);
  await page.waitForFunction(() => window.__diagnostics?.loaded && window.__diagnostics.contextLost === false, null, { timeout: 20_000 });
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.waitForFunction(() => window.__diagnostics.animating && !window.__diagnostics.reducedMotion);
  await recordPids();
  // Count actual selected-file reads without replacing the IPC handler or its policy.
  // The deliberate reload below must increment this counter, validating the probe.
  await application.evaluate((_electron, selected) => {
    const fs = process.getBuiltinModule('fs/promises');
    const paths = process.getBuiltinModule('path');
    const original = fs.readFile;
    const probe = { reads: 0, original, hold: false, pending: [], fail: false };
    globalThis.__contextReadProbe = probe;
    const expected = paths.resolve(selected).toLowerCase();
    fs.readFile = async function(file, ...args) {
      if (typeof file === 'string' && paths.resolve(file).toLowerCase() === expected) {
        probe.reads++;
        if (probe.fail) throw Object.assign(new Error('Controlled selected-model read failure'), { code: 'EIO' });
        if (probe.hold) await new Promise(resolve => probe.pending.push(resolve));
      }
      return original.call(this, file, ...args);
    };
  }, config.modelPath);
  await page.evaluate(() => {
    const canvas = document.querySelector('canvas');
    const gl = canvas.getContext('webgl2');
    const extension = gl?.getExtension('WEBGL_lose_context');
    if (!extension) throw new Error('The renderer does not expose WEBGL_lose_context; this check cannot run on this GPU.');
    const probe = { gl, extension, decodedImages: 0, lostEvents: 0, restoredEvents: 0 };
    window.__contextProbe = probe;
    canvas.addEventListener('webglcontextlost', () => { probe.lostEvents++; });
    canvas.addEventListener('webglcontextrestored', () => { probe.restoredEvents++; });
    const create = window.createImageBitmap;
    window.createImageBitmap = async function(...args) {
      const bitmap = await create.apply(this, args);
      probe.decodedImages++;
      return bitmap;
    };
  });
  const initial = await diagnostics();
  report.baseline = { diagnostics: initial, image: await capture('before-loss.png') };

  await inspect(() => globalThis.__shizuku.setMoveMode(true));
  await waitMain(() => globalThis.__shizuku.moveState().active && globalThis.__shizuku.moveState().shape.length > 0);
  const oldMove = await inspect(() => globalThis.__shizuku.moveState());
  await lose();
  await inspect(() => { const s = globalThis.__shizuku; void s.action('call'); s.setMoveMode(true); });
  await delay(100);
  assert.equal(await inspect(() => globalThis.__shizuku.controls()), null, 'Disabled call/move must not create a controls window during recovery.');
  assert.equal(await inspect(() => globalThis.__shizuku.moveState().active), false);
  assert.equal((await diagnostics()).reacting, false);
  assert.equal(await page.evaluate(({ revision, shape }) => window.companion.submitMoveShape(revision, shape), oldMove), false);
  await inspect(() => globalThis.__shizuku.avatar().webContents.send('avatar:called', Date.now() + 1000));
  pass('Losing the own WebGL context stops frames, releases the move region, disables call/move, and ignores call/move handlers without opening controls.');
  await restore();
  assert.equal((await probe()).reads, 0);
  assert.equal((await probe()).decodedImages, 0);
  assert.equal((await diagnostics()).loadTimeMs, initial.loadTimeMs);
  assert.equal((await diagnostics()).modelName, initial.modelName);
  assert.equal(await page.evaluate(({ revision, shape }) => window.companion.submitMoveShape(revision, shape), oldMove), false);
  report.snapshots.push({ stage: 'first-restoration', diagnostics: await diagnostics(), probe: await probe(), image: await capture('after-first-restoration.png') });
  pass('Restoration renders the retained model without another selected-file read or image decode; stale move regions stay rejected.');

  for (let cycle = 1; cycle <= 3; cycle++) {
    await inspect(() => globalThis.__shizuku.action('call'));
    await page.waitForFunction(() => window.__diagnostics.reacting);
    await lose();
    await restore();
    assert.equal((await probe()).reads, 0);
    assert.equal((await probe()).decodedImages, 0);
    report.snapshots.push({ stage: `repeat-${cycle}`, diagnostics: await diagnostics(), probe: await probe() });
  }
  pass('Three further loss/restore cycles cancel active calls, keep the model, and resume idle rendering without replaying responses.');

  await lose();
  await inspect(() => globalThis.__shizuku.setVisible(false));
  await page.waitForFunction(() => !window.__diagnostics.visible);
  await restore({ hidden: true });
  assert.equal(await inspect(() => globalThis.__shizuku.avatar().isVisible()), false);
  const hiddenFrames = (await diagnostics()).renderedFrames;
  await inspect(() => globalThis.__shizuku.setVisible(true));
  await page.waitForFunction(n => window.__diagnostics.visible && window.__diagnostics.renderedFrames > n, hiddenFrames);
  pass('Hiding during loss keeps restoration hidden and frame-free; an explicit show resumes the retained model.');

  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.waitForFunction(() => window.__diagnostics.reducedMotion && !window.__diagnostics.animating);
  await stoppedFrames();
  await inspect(() => globalThis.__shizuku.action('call'));
  await page.waitForFunction(() => window.__diagnostics.reacting);
  await lose();
  const beforeStillRestore = (await diagnostics()).renderedFrames;
  await restore();
  const afterStillRestore = await stoppedFrames();
  assert.equal((await diagnostics()).reacting, false);
  assert.equal((await probe()).reads, 0);
  assert.equal((await probe()).decodedImages, 0);
  report.snapshots.push({ stage: 'reduced-motion-restoration', framesRendered: afterStillRestore - beforeStillRestore,
    diagnostics: await diagnostics(), bounds: await inspect(() => globalThis.__shizuku.avatar().getBounds()), probe: await probe() });
  pass('Reduced-motion restoration draws a still frame and stops again; a cancelled expression response does not resume its timer.');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.waitForFunction(() => window.__diagnostics.animating);

  await lose();
  await inspect(() => globalThis.__shizuku.avatar().webContents.send('model:changed'));
  await waitMain(() => globalThis.__contextReadProbe.reads === 1);
  await page.waitForFunction(() => window.__diagnostics.loaded && window.__diagnostics.contextLost);
  assert.equal(await inspect(() => globalThis.__shizuku.status().modelLoaded), false);
  assert.equal(await inspect(() => globalThis.__shizuku.status().contextRecovering), true);
  const afterReload = await probe();
  await stoppedFrames();
  await restore();
  assert.equal((await probe()).reads, 1);
  assert.equal((await probe()).decodedImages, afterReload.decodedImages);
  report.snapshots.push({ stage: 'reload-during-loss', diagnostics: await diagnostics(), probe: await probe(), image: await capture('after-reload-and-restoration.png') });
  pass('A deliberate model reload during loss reads once but stays unavailable and frame-free until restoration; the new model then renders.');

  await lose();
  await inspect(() => {
    globalThis.__contextReadProbe.hold = true;
    globalThis.__shizuku.avatar().webContents.send('model:changed');
  });
  await waitMain(() => globalThis.__contextReadProbe.pending.length === 1);
  await page.waitForFunction(() => !window.__diagnostics.loaded && window.__diagnostics.contextLost);
  await page.evaluate(() => window.__contextProbe.extension.restoreContext());
  await page.waitForFunction(() => !window.__diagnostics.contextLost);
  await stoppedFrames();
  assert.equal(await inspect(() => globalThis.__shizuku.status().modelLoaded), false);
  assert.equal(await inspect(() => globalThis.__shizuku.status().contextRecovering), true);
  await inspect(() => { const s = globalThis.__shizuku; void s.action('call'); s.setMoveMode(true); });
  assert.equal(await inspect(() => globalThis.__shizuku.controls()), null);
  const heldFrames = (await diagnostics()).renderedFrames;
  await inspect(() => {
    const probe = globalThis.__contextReadProbe;
    probe.hold = false;
    for (const resolve of probe.pending.splice(0)) resolve();
  });
  await page.waitForFunction(n => window.__diagnostics.loaded && !window.__diagnostics.contextLost && window.__diagnostics.renderedFrames > n, heldFrames);
  await waitMain(() => globalThis.__shizuku.status().modelLoaded && !globalThis.__shizuku.status().contextRecovering);
  assert.equal((await probe()).reads, 2);
  assert.equal((await diagnostics()).reacting, false);
  report.snapshots.push({ stage: 'restored-before-replacement-read-finishes', diagnostics: await diagnostics(), probe: await probe() });
  pass('When the context returns before a held replacement-model read finishes, actions stay disabled until that load completes.');

  await lose();
  await inspect(() => {
    globalThis.__contextReadProbe.fail = true;
    globalThis.__shizuku.avatar().webContents.send('model:changed');
  });
  await waitMain(() => globalThis.__contextReadProbe.reads === 3 && !globalThis.__shizuku.status().modelLoaded
    && globalThis.__shizuku.status().loadError.includes('VRMを読めません'));
  await page.waitForFunction(() => !window.__diagnostics.loaded && window.__diagnostics.contextLost);
  const readError = await inspect(() => globalThis.__shizuku.status().loadError);
  await page.evaluate(() => window.__contextProbe.extension.restoreContext());
  await page.waitForFunction(() => !window.__diagnostics.contextLost);
  await waitMain(() => !globalThis.__shizuku.status().modelLoaded && !globalThis.__shizuku.status().contextRecovering);
  assert.equal(await inspect(() => globalThis.__shizuku.status().loadError), readError);
  assert.equal((await diagnostics()).loaded, false);
  await stoppedFrames();
  report.snapshots.push({ stage: 'read-error-after-context-restoration', diagnostics: await diagnostics(), status: await inspect(() => globalThis.__shizuku.status()), probe: await probe() });
  await inspect(() => {
    globalThis.__contextReadProbe.fail = false;
    globalThis.__shizuku.avatar().webContents.send('model:changed');
  });
  await page.waitForFunction(() => window.__diagnostics.loaded && !window.__diagnostics.contextLost);
  await waitMain(() => globalThis.__shizuku.status().modelLoaded && globalThis.__shizuku.status().loadError === '');
  assert.equal((await probe()).reads, 4);
  report.snapshots.push({ stage: 'valid-reload-after-read-error', diagnostics: await diagnostics(), probe: await probe(), image: await capture('after-read-error-recovery.png') });
  pass('A model-read failure during loss remains an error after context restoration; a later valid reload explicitly recovers.');

  await lose();
  report.shutdownWhileLost = { diagnostics: await diagnostics(), probe: await probe() };
  await recordPids();
  await application.close(); application = null;
  pass('Normal shutdown succeeds while the own WebGL context is lost.');
} catch (error) {
  failure = error;
  report.error = error instanceof Error ? error.message : String(error);
} finally {
  if (application) {
    try {
      await inspect(() => {
        if (globalThis.__contextReadProbe) {
          const probe = globalThis.__contextReadProbe;
          probe.hold = false;
          for (const resolve of probe.pending.splice(0)) resolve();
          process.getBuiltinModule('fs/promises').readFile = probe.original;
        }
      });
      await recordPids();
    } catch { /* A failed renderer/main may already be gone; recorded PIDs remain checked below. */ }
    try { await application.close(); }
    catch (error) { report.cleanupError = String(error); failure ??= error; }
  }
  for (let attempt = 0; attempt < 20; attempt++) {
    report.remainingPids = [...pids].filter(pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; } });
    if (!report.remainingPids.length) break;
    await delay(250);
  }
  try { report.userSettingsUnchanged = (await readFile(settingsPath)).equals(before); }
  catch (error) { report.settingsReadError = String(error); }
  if (report.remainingPids.length) failure ??= new Error('Recorded processes remain after the context recovery checks.');
  if (report.userSettingsUnchanged !== true) failure ??= new Error('Normal user settings changed during the context recovery checks.');
  if (!failure) pass('All recorded app and launcher processes exit, and normal user settings remain byte-for-byte unchanged.');
  report.status = failure ? 'failed' : 'passed';
  report.finishedAt = new Date().toISOString();
  await writeFile(path.join(directory, 'result.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ directory, status: report.status, passed: report.results.length, remainingPids: report.remainingPids, userSettingsUnchanged: report.userSettingsUnchanged }, null, 2));
}
if (failure) throw failure;
