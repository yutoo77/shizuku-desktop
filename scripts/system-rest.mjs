// Emit power events only inside the test Electron process. Never lock/suspend
// Windows, inspect user windows or change the user's normal configuration.
import { _electron } from 'playwright';
import electron from 'electron';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const before = await readFile(path.join(root, 'local.config.json'));
const config = JSON.parse(before.toString().replace(/^\uFEFF/, ''));
const directory = await mkdtemp(path.join(root, 'work', 'system-rest-'));
await writeFile(path.join(directory, 'local.config.json'), JSON.stringify({ modelPath: config.modelPath, quiet: false }));
const pids = new Set(), checks = [];
let app, page, controls, fixture, failure, failureState;
const main = fn => app.evaluate(fn);
const act = value => app.evaluate((_e, value) => __shizuku.action(value), value);
const power = event => app.evaluate(({ powerMonitor }, event) => powerMonitor.emit(event), event);
const state = () => main(() => ({ rest: __shizuku.restState(), status: __shizuku.status(),
  tracking: __shizuku.tracking(), selection: __shizuku.selection(), pointer: __shizuku.pointerState(),
  bounds: __shizuku.avatar().getBounds(), nativeVisible: __shizuku.avatar().isVisible(),
  controlsVisible: !!__shizuku.controls()?.isVisible() }));
async function waitFor(test, label, timeout = 6000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await test()) return; await delay(50); }
  throw new Error(label);
}
async function recordPids() {
  for (const client of [app, fixture].filter(Boolean)) {
    pids.add(client.process().pid);
    for (const p of await client.evaluate(({ app }) => app.getAppMetrics())) pids.add(p.pid);
  }
  if (app) pids.add((await state()).tracking.pid);
}
async function stopped() {
  // Hidden pages stop animation frames, so an rAF-based assertion can itself
  // stop polling even after the requested state has already been reached.
  await page.waitForFunction(() => !window.__diagnostics.visible && !window.__diagnostics.animating && !window.__diagnostics.reacting, null, { polling: 100 });
  const count = await page.evaluate(() => window.__diagnostics.renderedFrames);
  await delay(250);
  assert.equal(await page.evaluate(() => window.__diagnostics.renderedFrames), count);
  assert.equal((await state()).nativeVisible, false);
}
async function launch() {
  app = await _electron.launch({ executablePath: electron, args: [root], cwd: root,
    env: { ...process.env, SHIZUKU_TEST: '1', SHIZUKU_TEST_DATA: path.basename(directory) } });
  page = await app.firstWindow(); page.setDefaultTimeout(6000); await page.waitForFunction(() => window.__diagnostics?.loaded);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await waitFor(async () => (await state()).tracking.ready, 'Helper ready');
  const opening = app.waitForEvent('window'); await main(() => __shizuku.openControls()); controls = await opening;
  await controls.waitForSelector('#follow');
  await main(({ screen }) => {
    __shizuku.controls().setBounds({ x: 50, y: 50, width: 360, height: 600 }); __shizuku.reset();
    globalThis.restCursor = { x: 700, y: 850 };
    screen.getCursorScreenPoint = () => ({ ...globalThis.restCursor });
  });
  await recordPids();
}
try {
  await launch();
  await act('call'); await page.waitForFunction(() => window.__diagnostics.reacting);
  const initial = await state();
  await power('lock-screen'); await stopped();
  assert.equal((await state()).controlsVisible, false);
  for (const action of ['show', 'reset', 'call', 'pointer-place', 'follow-countdown', 'seat-countdown', 'right']) await act(action);
  await stopped(); assert.deepEqual((await state()).bounds, initial.bounds);
  await power('unlock-screen');
  await page.waitForFunction(() => window.__diagnostics.visible && window.__diagnostics.animating);
  assert.equal(await page.evaluate(() => window.__diagnostics.reacting), false);
  assert.equal((await state()).controlsVisible, true);
  assert.equal(await main(() => __shizuku.avatar().isFocused()), false);
  checks.push('Lock hides both own windows, stops rendering and cancels a call; unlock restores visibility without replaying input (simulated OS events).');

  await act('hide'); await power('lock-screen'); await power('lock-screen'); await power('suspend');
  await power('resume'); assert.deepEqual((await state()).rest.reasons, ['lock']); await stopped();
  await power('unlock-screen'); await stopped(); assert.equal((await state()).rest.snapshot, null);
  await act('show'); await power('suspend'); await power('lock-screen'); await power('unlock-screen'); await stopped();
  await power('resume'); assert.equal((await state()).nativeVisible, true);
  await power('resume'); assert.equal((await state()).nativeVisible, true);
  await power('lock-screen'); await act('hide'); await power('unlock-screen'); await stopped();
  checks.push('Overlapping lock/suspend reasons work in both orders; duplicates do not overwrite intent, and explicit hiding survives restoration.');

  await act('show'); const origin = (await state()).bounds; await act('pointer-place');
  await main(() => { globalThis.restCursor.x += 70; __shizuku.tickPointerPlacement(globalThis.restCursor); });
  assert.notDeepEqual((await state()).bounds, origin);
  await power('suspend'); await stopped();
  assert.deepEqual((await state()).bounds, origin);
  assert.deepEqual((await state()).pointer, { active: false, escape: false, timer: false, origin: undefined });
  await power('resume'); assert.deepEqual((await state()).bounds, origin);
  checks.push('Suspend rolls back an unfinished pointer move and releases its timer and Escape; resume never commits its preview.');

  fixture = await _electron.launch({ executablePath: electron, args: [path.join(root, 'scripts', 'fixture.cjs')], cwd: root,
    env: { ...process.env, SHIZUKU_FIXTURE_INACTIVE: '1' } });
  await (await fixture.firstWindow()).waitForSelector('#text');
  const target = await fixture.evaluate(({ BrowserWindow }) => {
    globalThis.target = BrowserWindow.getAllWindows()[0]; target.setBounds({ x: 500, y: 470, width: 700, height: 420 });
    return { handle: target.getNativeWindowHandle().readBigUInt64LE().toString(), pid: process.pid };
  });
  await app.evaluate((_e, value) => __shizuku.setForegroundFixture(value), target);
  await recordPids();
  for (const action of ['seat-countdown', 'follow-countdown']) {
    await act(action); await power('lock-screen'); await power('unlock-screen');
    const s = await state();
    assert.equal(s.status.seatCountdown, 0); assert.equal(s.status.pendingSeat, null);
    assert.equal(s.selection.active, false); assert.equal(s.selection.escape, false);
  }
  await delay(3200); assert.equal((await state()).tracking.following, null);
  checks.push('Fixed seating and window selection are cancelled on lock; their old deadlines cannot start a placement after unlock.');

  await app.evaluate((_e, value) => __shizuku.startFollowing(value), target);
  await waitFor(async () => (await state()).tracking.following?.state === 'following', 'Fixture follows');
  const oldWindow = (await state()).tracking.following.window;
  await power('lock-screen');
  await fixture.evaluate(() => target.setBounds({ x: 600, y: 500, width: 700, height: 420 }));
  await app.evaluate((_e, value) => __shizuku.onTrackedWindow(value), oldWindow);
  await stopped(); await power('unlock-screen');
  const recovered = await state();
  assert.equal(recovered.tracking.following, null);
  const edge = await main(({ screen }) => screen.getPrimaryDisplay().workArea);
  assert.equal(recovered.bounds.x, edge.x + edge.width - recovered.bounds.width - 24);
  assert.equal(recovered.nativeVisible, true);
  checks.push('Rest detaches the dedicated window; late metadata is ignored and restoration returns to the screen edge without selecting again.');

  await power('lock-screen');
  await page.evaluate(() => { window.restExtension = document.querySelector('canvas').getContext('webgl2').getExtension('WEBGL_lose_context'); window.restExtension.loseContext(); });
  await page.waitForFunction(() => window.__diagnostics.contextLost, null, { polling: 100 });
  await page.evaluate(() => window.restExtension.restoreContext());
  await page.waitForFunction(() => !window.__diagnostics.contextLost, null, { polling: 100 });
  await waitFor(async () => (await state()).status.modelLoaded, 'Model available again');
  await stopped(); await power('unlock-screen');
  await page.waitForFunction(() => window.__diagnostics.visible && window.__diagnostics.animating);
  await controls.screenshot({ path: path.join(directory, 'controls-restored.png') });
  checks.push('WebGL loss and recovery during lock retain the hidden state; unlock restores the model without an old response.');

  const helper = (await state()).tracking.pid;
  await power('suspend'); await main(() => __shizuku.setHelperOutputPaused(true));
  console.log('Checking a heartbeat gap longer than the normal 5-second watchdog.');
  await delay(6200);
  assert.equal((await state()).tracking.ready, true);
  await power('resume'); await delay(1200);
  assert.equal((await state()).tracking.ready, true);
  assert.equal((await state()).tracking.pid, helper);
  await main(() => __shizuku.setHelperOutputPaused(false));
  const previousStats = (await state()).tracking.stats.receivedAtMs;
  await waitFor(async () => (await state()).tracking.stats.receivedAtMs > previousStats, 'Fresh heartbeat');
  checks.push('A simulated sleeping heartbeat gap does not kill the helper; resuming resets the watchdog grace and accepts fresh reports.');

  await main(() => __shizuku.setHelperOutputPaused(true));
  await waitFor(async () => !(await state()).tracking.ready, 'Awake watchdog remains enabled', 7000);
  await main(() => __shizuku.setHelperOutputPaused(false));
  await act('hide'); await act('show'); assert.equal((await state()).nativeVisible, true);
  assert.match((await state()).status.placementMessage, /再起動/);
  checks.push('The same heartbeat gap while awake still detects helper failure; normal hide/show remains usable.');
  await recordPids(); await app.close(); app = null;
  await launch(); await power('lock-screen'); await recordPids();
  const appProcess = app.process(); await act('quit');
  await waitFor(() => appProcess.exitCode !== null, 'Quit during rest'); app = null;
  checks.push('Quit remains available during rest and closes the live helper and Electron children.');
} catch (error) {
  failure = error;
  if (app) failureState = { main: await state(), renderer: await page.evaluate(() => ({ ...window.__diagnostics })) };
}
finally {
  if (app) { await main(() => __shizuku.setHelperOutputPaused(false)).catch(() => {}); await app.close().catch(() => {}); }
  if (fixture) await fixture.close().catch(() => {});
  let remainingPids = [];
  for (let i = 0; i < 40; i++) {
    remainingPids = [...pids].filter(pid => { try { process.kill(pid, 0); return true; } catch { return false; } });
    if (!remainingPids.length) break; await delay(100);
  }
  const settingsUnchanged = (await readFile(path.join(root, 'local.config.json'))).equals(before);
  if (remainingPids.length || !settingsUnchanged) failure ??= new Error('Cleanup/settings invariant failed');
  await writeFile(path.join(directory, 'result.json'), JSON.stringify({ status: failure ? 'failed' : 'passed', checks, remainingPids, settingsUnchanged, failureState, error: failure?.stack }, null, 2));
  console.log(JSON.stringify({ directory, checks: checks.length, status: failure ? 'failed' : 'passed', remainingPids, settingsUnchanged, error: failure?.message }, null, 2));
}
if (failure) throw failure;
