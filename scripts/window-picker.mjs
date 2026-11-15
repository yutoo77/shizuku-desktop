// API-driven acceptance checks with a guarded, dedicated fixture.
// Physical clicks and OS window-move gestures are verified separately.
import { _electron } from 'playwright';
import electron from 'electron';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const before = await readFile(path.join(root, 'local.config.json'));
const config = JSON.parse(before.toString().replace(/^\uFEFF/, ''));
const directory = await mkdtemp(path.join(root, 'work', 'window-picker-'));
await writeFile(path.join(directory, 'local.config.json'), JSON.stringify({ modelPath: config.modelPath, quiet: true }));
const pids = new Set(), checks = [], nativeEvents = [];
let app, fixture, page, controls, standalone, failure, failureState;
const main = fn => app.evaluate(fn);
const selection = () => main(() => globalThis.__shizuku.selection());
const tracking = () => main(() => globalThis.__shizuku.tracking());
const act = value => app.evaluate((_e, value) => globalThis.__shizuku.action(value), value);
async function waitFor(test, label, timeout = 6000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) { if (await test()) return; await delay(50); }
  throw new Error(label);
}
async function focusControls() {
  await main(() => { const w = globalThis.__shizuku.controls(); w.show(); w.focus(); });
  await waitFor(() => main(() => globalThis.__shizuku.controls().isFocused()), 'Controls focus');
}
async function begin() {
  await focusControls(); await controls.locator('#follow').click();
  assert.equal((await selection()).active, true);
}
async function recordPids() {
  for (const client of [app, fixture].filter(Boolean)) {
    pids.add(client.process().pid);
    for (const item of await client.evaluate(({ app }) => app.getAppMetrics())) pids.add(item.pid);
  }
  if (app) { const pid = (await tracking()).pid; if (pid) pids.add(pid); }
}
try {
  fixture = await _electron.launch({ executablePath: electron, args: [path.join(root, 'scripts', 'fixture.cjs')], cwd: root });
  await (await fixture.firstWindow()).waitForSelector('#text');
  const target = await fixture.evaluate(({ BrowserWindow }) => {
    globalThis.target = BrowserWindow.getAllWindows()[0];
    globalThis.target.setBounds({ x: 500, y: 470, width: 700, height: 420 });
    return { handle: globalThis.target.getNativeWindowHandle().readBigUInt64LE().toString(), pid: process.pid };
  });
  app = await _electron.launch({ executablePath: electron, args: [root], cwd: root, env: { ...process.env, SHIZUKU_TEST: '1', SHIZUKU_TEST_DATA: path.basename(directory) } });
  page = await app.firstWindow(); await page.waitForFunction(() => window.__diagnostics?.loaded);
  await waitFor(async () => (await tracking()).ready, 'Helper ready');
  await app.evaluate((_e, value) => globalThis.__shizuku.setForegroundFixture(value), target);
  const opening = app.waitForEvent('window'); await main(() => globalThis.__shizuku.openControls()); controls = await opening;
  await controls.waitForSelector('#follow'); await recordPids();
  const initial = await main(() => ({ bounds: globalThis.__shizuku.avatar().getBounds(), posture: globalThis.__shizuku.status().posture }));
  await begin(); await delay(3500);
  assert.equal((await selection()).active, true); assert.equal((await tracking()).following, null);
  assert.deepEqual(await main(() => ({ bounds: globalThis.__shizuku.avatar().getBounds(), posture: globalThis.__shizuku.status().posture })), initial);
  assert.equal(await controls.locator('#follow').textContent(), '窓の選択をやめる');
  const layout = await controls.evaluate(() => ({ width: innerWidth, height: innerHeight, scrollWidth: document.documentElement.scrollWidth, scrollHeight: document.documentElement.scrollHeight }));
  assert.equal(layout.width, layout.scrollWidth); assert.equal(layout.height, layout.scrollHeight);
  await controls.screenshot({ path: path.join(directory, 'picker-controls.png') });
  checks.push('Own controls remain unselected after 3.5 seconds; choosing preserves the avatar and the UI fits without scroll.');
  // Windows may refuse foreground transfer through BrowserWindow.focus while
  // another process owns an active controls window. Native clicks are separate.
  await main(() => globalThis.__shizuku.controls().hide());
  await fixture.evaluate(() => { globalThis.target.show(); globalThis.target.focus(); });
  await app.evaluate((_e, value) => globalThis.__shizuku.resolveSelectionFixture(value), target);
  await waitFor(async () => (await tracking()).following?.state === 'following', 'Fixture metadata resolves pending selection');
  assert.equal((await tracking()).following.window.sourceId, `window:${target.handle}:0`);
  assert.equal((await selection()).active, false); assert.equal((await selection()).escape, false);
  assert.equal(await fixture.evaluate(() => globalThis.target.isFocused()), true);
  assert.equal(await main(() => globalThis.__shizuku.avatar().isFocused()), false);
  checks.push('Native fixture metadata resolves pending selection, releases selection/Escape and preserves API fixture focus; foreground handoff is tested separately with OS input.');
  const old = (await tracking()).following.window;
  await main(() => globalThis.__shizuku.stopFollowing(true));
  await begin(); const cancelledId = (await selection()).id;
  await controls.locator('#follow').click();
  assert.equal((await selection()).active, false); assert.equal((await selection()).escape, false);
  await app.evaluate((_e, value) => globalThis.__shizuku.onTrackedWindow(value), { ...old, id: cancelledId });
  assert.equal((await tracking()).following, null);
  await act('hide'); const hiddenBounds = await main(() => globalThis.__shizuku.avatar().getBounds());
  await begin(); await main(() => globalThis.__shizuku.tickWindowSelection(Number.MAX_VALUE));
  assert.equal((await selection()).active, false); assert.equal(await main(() => globalThis.__shizuku.status().visible), false);
  assert.deepEqual(await main(() => globalThis.__shizuku.avatar().getBounds()), hiddenBounds);
  checks.push('Cancel ignores stale selection results; the deadline preserves a deliberately hidden avatar and its position.');
  await act('show');
  // Opening the picker from a tray would otherwise accept the old foreground
  // app as the menu dismisses. This entry only opens controls, without polling.
  await main(() => globalThis.__shizuku.trayMenu().items.find(item => item.label === '座る窓を選ぶ…').click());
  assert.equal((await selection()).active, false);
  assert.equal(await main(() => globalThis.__shizuku.controls().isVisible()), true);
  await main(({ globalShortcut }) => { if (!globalShortcut.register('Escape', () => {})) throw new Error('Fixture Escape reservation failed'); });
  await begin(); assert.equal((await selection()).escape, false); await controls.locator('#follow').click();
  assert.equal(await main(({ globalShortcut }) => globalShortcut.isRegistered('Escape')), true);
  await main(({ globalShortcut }) => globalShortcut.unregister('Escape'));
  for (const action of ['pointer-place', 'seat-countdown', 'hide', 'reset', 'call', 'quiet']) {
    await begin(); await act(action); assert.equal((await selection()).active, false);
    await main(() => { globalThis.__shizuku.setMoveMode(false); globalThis.__shizuku.cancelSeat(); });
    await act('show');
  }
  checks.push('Tray entry opens controls without selecting; Escape conflicts preserve existing registration; movement, fixed seating, hide, reset, call and quiet interrupt choosing.');
  await begin(); await main(() => globalThis.__shizuku.controls().close());
  assert.equal((await selection()).active, false); assert.equal((await selection()).escape, false);
  const reopening = app.waitForEvent('window'); await main(() => globalThis.__shizuku.openControls()); controls = await reopening;
  await controls.waitForSelector('#follow');
  checks.push('Closing the controls cancels selection, and reopening does not resume it.');
  assert.equal(await page.evaluate(async () => { try { await window.companion.action('follow-countdown'); return false; } catch { return true; } }), true);
  checks.push('The avatar renderer cannot start window selection through controls IPC.');

  // Test the native deadline independently of the main-process timer. The
  // fixture is hidden, so no foreground window can be accepted by this guard.
  await fixture.evaluate(() => globalThis.target.hide());
  standalone = spawn(path.join(root, 'dist', 'window-tracker.exe'), [String(process.pid), '--fixture-tests'], { windowsHide: true, stdio: 'pipe' });
  pids.add(standalone.pid); standalone.stdin.on('error', () => {}); standalone.stderr.resume();
  let buffer = ''; standalone.stdout.setEncoding('utf8');
  standalone.stdout.on('data', text => {
    buffer += text; let end;
    while ((end = buffer.indexOf('\n')) !== -1) { nativeEvents.push(JSON.parse(buffer.slice(0, end))); buffer = buffer.slice(end + 1); }
  });
  await waitFor(() => nativeEvents.some(e => e.type === 'ready'), 'Standalone helper ready');
  const start = performance.now();
  standalone.stdin.write(`test-pick 77 ${target.handle} ${target.pid}\n`);
  console.log('Checking the native 20-second picker deadline.');
  await waitFor(() => nativeEvents.some(e => e.type === 'end' && e.id === 77 && e.reason === 'timeout'), 'Native selection deadline', 23000);
  assert.ok(performance.now() - start >= 19500);
  assert.equal(nativeEvents.some(e => e.type === 'window'), false);
  standalone.stdin.end('quit\n'); await waitFor(() => standalone.exitCode !== null, 'Standalone helper exits');
  checks.push('The native picker times out after 20 seconds independently of main; guarded non-target windows yield no metadata.');
  await begin(); await recordPids(); await app.close(); app = null;
  checks.push('Quit while choosing closes Electron and its native helper without saving a target.');
} catch (error) {
  failure = error;
  if (app) failureState = { selection: await selection(), tracking: await tracking(), status: await main(() => globalThis.__shizuku.status()), fixtureFocused: fixture && await fixture.evaluate(() => globalThis.target.isFocused()) };
}
finally {
  if (standalone && standalone.exitCode === null) standalone.kill();
  if (app) await app.close().catch(() => {});
  if (fixture) await fixture.close().catch(() => {});
  let remainingPids = [];
  for (let i = 0; i < 40; i++) {
    remainingPids = [...pids].filter(pid => { try { process.kill(pid, 0); return true; } catch { return false; } });
    if (!remainingPids.length) break; await delay(100);
  }
  const settingsUnchanged = (await readFile(path.join(root, 'local.config.json'))).equals(before);
  if (remainingPids.length || !settingsUnchanged) failure ??= new Error('Cleanup/settings invariant failed');
  await writeFile(path.join(directory, 'result.json'), JSON.stringify({ status: failure ? 'failed' : 'passed', checks, nativeEvents, remainingPids, settingsUnchanged, failureState, error: failure?.stack }, null, 2));
  console.log(JSON.stringify({ directory, status: failure ? 'failed' : 'passed', checks: checks.length, remainingPids, settingsUnchanged, error: failure?.message }, null, 2));
}
if (failure) throw failure;
