// Windows integration using dedicated fixture windows. Real input/occlusion
// screenshots are evaluated separately; this reads actual native order metadata.
import { _electron } from 'playwright';
import electron from 'electron';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const before = await readFile(path.join(root, 'local.config.json'));
const cfg = JSON.parse(before.toString().replace(/^\uFEFF/, ''));
const directory = await mkdtemp(path.join(root, 'work', 'window-order-'));
await writeFile(path.join(directory, 'local.config.json'), JSON.stringify({ modelPath: cfg.modelPath, quiet: true }));
let app, fixture, page, failure;
const pids = new Set(), checks = [], samples = [];
const main = fn => app.evaluate(fn);
const state = () => main(() => ({ tracker: globalThis.__shizuku.tracking(), visible: globalThis.__shizuku.status().visible, topmost: globalThis.__shizuku.avatar().isAlwaysOnTop(), focused: globalThis.__shizuku.avatar().isFocused() }));
async function waitFor(test, label) {
  for (let i = 0; i < 100; i++) { if (await test()) return; await delay(60); }
  throw new Error(label + ': ' + JSON.stringify({ app: await state(), target: fixture && await fixture.evaluate(() => ({ topmost: globalThis.target.isAlwaysOnTop(), focused: globalThis.target.isFocused() })) }));
}
async function attached() {
  await waitFor(async () => { const s = await state(); return s.tracker.following?.state === 'following' && s.tracker.following.window.adjacent && s.tracker.following.layerAttempts === 0; }, 'native order settles');
}
async function attach() {
  const target = await fixture.evaluate(() => ({ handle: globalThis.target.getNativeWindowHandle().readBigUInt64LE().toString(), pid: process.pid }));
  await app.evaluate((_e, target) => globalThis.__shizuku.startFollowing(target), target);
  await attached();
}
async function still(label) {
  // The preceding API change can finish before the helper's next 50 ms poll.
  await delay(200);
  await attached();
  const a = await state(), frames = await page.evaluate(() => window.__diagnostics.renderedFrames);
  await delay(600);
  const b = await state();
  assert.equal(b.tracker.following.window.orderVersion, a.tracker.following.window.orderVersion, 'Order retries must stop once aligned');
  assert.equal(await page.evaluate(() => window.__diagnostics.renderedFrames), frames);
  assert.equal(b.focused, false);
  samples.push({ label, before: a, after: b });
}
async function collectPids() {
  for (const client of [app, fixture].filter(Boolean)) {
    pids.add(client.process().pid);
    for (const p of await client.evaluate(({ app }) => app.getAppMetrics())) pids.add(p.pid);
  }
  const pid = app && (await state()).tracker.pid; if (pid) pids.add(pid);
}
try {
  app = await _electron.launch({ executablePath: electron, args: [root], cwd: root, env: { ...process.env, SHIZUKU_TEST: '1', SHIZUKU_TEST_DATA: path.basename(directory) } });
  page = await app.firstWindow(); await page.waitForFunction(() => window.__diagnostics?.loaded);
  await waitFor(async () => (await state()).tracker.ready, 'helper ready');
  fixture = await _electron.launch({ executablePath: electron, args: [path.join(root, 'scripts', 'fixture.cjs')], cwd: root });
  await (await fixture.firstWindow()).waitForSelector('#text');
  await fixture.evaluate(({ BrowserWindow }) => {
    globalThis.target = BrowserWindow.getAllWindows()[0];
    globalThis.target.setBounds({ x: 500, y: 470, width: 700, height: 420 });
    globalThis.cover = new BrowserWindow({ x: 600, y: 240, width: 700, height: 500, show: false, backgroundColor: '#e9f2ff', webPreferences: { sandbox: true, nodeIntegration: false, contextIsolation: true } });
    globalThis.cover.loadURL('data:text/html,<title>しずく・重なり確認</title><body style="background:%23e9f2ff;font:24px sans-serif;padding:48px">重なり確認用の窓</body>');
  });
  await collectPids(); await attach(); await still('ordinary target');
  assert.equal((await state()).topmost, false);
  checks.push('Ordinary target: native predecessor equals the avatar; desktop topmost is released and quiet frames stay stopped.');

  await fixture.evaluate(() => { globalThis.cover.show(); globalThis.cover.focus(); });
  await still('ordinary cover raised');
  assert.equal(await fixture.evaluate(() => globalThis.cover.isFocused()), true);
  await fixture.evaluate(() => globalThis.target.focus());
  await still('target raised again');
  assert.equal(await fixture.evaluate(() => globalThis.target.isFocused()), true);
  checks.push('Raising a dedicated cover then target keeps native adjacency, stops retries and preserves fixture focus (API driven).');

  samples.push({ label: 'target topmost immediate', value: await fixture.evaluate(() => {
    // Explicitly establish this fixture condition. On this PC, setting only
    // true after focus changes sometimes left the native topmost flag false.
    globalThis.target.setAlwaysOnTop(false);
    globalThis.target.setAlwaysOnTop(true, 'pop-up-menu');
    return globalThis.target.isAlwaysOnTop();
  }) });
  await waitFor(async () => (await state()).topmost, 'topmost target adopted');
  await still('topmost target');
  await fixture.evaluate(() => globalThis.target.setAlwaysOnTop(false));
  await waitFor(async () => !(await state()).topmost, 'ordinary target restored');
  await still('topmost released');
  checks.push('Changing the selected target between topmost and ordinary updates only the avatar layer and settles without redraw.');

  await fixture.evaluate(() => globalThis.target.setBounds({ x: 500, y: 30, width: 700, height: 420 }));
  await waitFor(async () => (await state()).tracker.following?.state === 'no-room', 'headroom absent');
  await delay(200); const hidden = await state(); await delay(600);
  assert.equal((await state()).visible, false);
  assert.equal((await state()).tracker.following.window.orderVersion, hidden.tracker.following.window.orderVersion);
  await fixture.evaluate(() => { globalThis.target.setAlwaysOnTop(false); globalThis.target.setAlwaysOnTop(true, 'pop-up-menu'); globalThis.cover.focus(); });
  await delay(300); assert.equal((await state()).visible, false, 'Order changes must not reveal a hidden avatar');
  await fixture.evaluate(() => globalThis.target.setBounds({ x: 500, y: 470, width: 700, height: 420 }));
  await still('revealed after no-room'); assert.equal((await state()).topmost, true);
  checks.push('No-room wait stays hidden across order changes and stops retries; headroom restoration adopts the current target layer.');

  await main(() => globalThis.__shizuku.stopFollowing(true));
  assert.equal((await state()).topmost, true); assert.equal((await state()).tracker.following, null);
  await fixture.evaluate(() => globalThis.target.setAlwaysOnTop(false));
  await attach();
  await main(() => globalThis.__shizuku.action('hide'));
  assert.equal((await state()).topmost, true); assert.equal((await state()).visible, false);
  await main(() => globalThis.__shizuku.action('show'));
  assert.equal((await state()).topmost, true);
  checks.push('Detach restores desktop topmost; manual hide remains hidden and show reliably returns.');

  await attach();
  await main(() => {
    const w = globalThis.__shizuku.avatar(), original = w.moveAbove;
    w.moveAbove = () => { throw new Error('Injected unavailable target'); };
    try { globalThis.__shizuku.onTrackedWindow({ ...globalThis.__shizuku.tracking().following.window, adjacent: false }); }
    finally { w.moveAbove = original; }
  });
  assert.equal((await state()).tracker.following, null); assert.equal((await state()).topmost, true);
  assert.equal((await state()).visible, true);
  await attach();
  await main(() => {
    const w = globalThis.__shizuku.avatar(), original = w.moveAbove;
    const metadata = { ...globalThis.__shizuku.tracking().following.window, adjacent: false };
    w.moveAbove = () => {};
    try { for (let i = 0; i < 10; i++) globalThis.__shizuku.onTrackedWindow(metadata); }
    finally { w.moveAbove = original; }
  });
  assert.equal((await state()).tracker.following, null); assert.equal((await state()).topmost, true);
  assert.equal((await state()).visible, true);
  checks.push('Unavailable target and persistent order conflict detach with bounded retries and recover visible at the screen edge.');
  await attach(); await collectPids();
} catch (error) { failure = error; }
finally {
  if (app) try { await app.close(); } catch { }
  if (fixture) try { await fixture.close(); } catch { }
  for (let i = 0; i < 40 && [...pids].some(pid => { try { process.kill(pid, 0); return true; } catch { return false; } }); i++) await delay(100);
  const remainingPids = [...pids].filter(pid => { try { process.kill(pid, 0); return true; } catch { return false; } });
  const settingsUnchanged = (await readFile(path.join(root, 'local.config.json'))).equals(before);
  if (remainingPids.length || !settingsUnchanged) failure ??= new Error('Cleanup/settings invariant failed');
  await writeFile(path.join(directory, 'result.json'), JSON.stringify({ status: failure ? 'failed' : 'passed', checks, samples, remainingPids, settingsUnchanged, error: failure?.stack }, null, 2));
  console.log(JSON.stringify({ directory, checks: checks.length, status: failure ? 'failed' : 'passed', remainingPids, settingsUnchanged, error: failure?.message }, null, 2));
}
if (failure) throw failure;
