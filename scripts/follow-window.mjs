// Integration against a separate, dedicated Windows fixture. No user windows.
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
const directory = await mkdtemp(path.join(root, 'work', 'follow-'));
await writeFile(path.join(directory, 'local.config.json'), JSON.stringify({ modelPath: cfg.modelPath, quiet: true }));
let app, page, fixture, fixturePage, failure;
const pids = new Set(), results = [], samples = [];
const main = fn => app.evaluate(fn);
const track = () => main(() => globalThis.__shizuku.tracking());
const act = value => app.evaluate((_e, value) => globalThis.__shizuku.action(value), value);
const diag = () => page.evaluate(() => ({ ...window.__diagnostics }));
const bounds = () => main(() => globalThis.__shizuku.avatar().getBounds());
const mutateFixture = async value => { await fixture.evaluate(({ BrowserWindow }, value) => BrowserWindow.getAllWindows()[0].setBounds(value), value); };
async function waitFor(check, label, timeout = 7000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await check()) return; await delay(60); }
  throw new Error(label + ': ' + JSON.stringify({ tracker: await track(), status: await main(() => globalThis.__shizuku.status()) }));
}
async function recordPids() {
  if (app) { pids.add(app.process().pid); const state = await track(); if (state.pid) pids.add(state.pid); for (const p of await main(() => globalThis.__shizuku.metrics())) pids.add(p.pid); }
  if (fixture) { pids.add(fixture.process().pid); for (const p of await fixture.evaluate(({ app }) => app.getAppMetrics())) pids.add(p.pid); }
}
async function launch() {
  app = await _electron.launch({ executablePath: electron, args: [root], cwd: root, env: { ...process.env, SHIZUKU_TEST: '1', SHIZUKU_TEST_DATA: path.basename(directory) } });
  page = await app.firstWindow(); await page.waitForFunction(() => window.__diagnostics?.loaded);
  await waitFor(async () => (await track()).ready, 'native helper ready');
  await recordPids();
}
async function openFixture() {
  fixture = await _electron.launch({ executablePath: electron, args: [path.join(root, 'scripts', 'fixture.cjs')], cwd: root });
  fixturePage = await fixture.firstWindow(); await fixturePage.waitForSelector('#text');
  await mutateFixture({ x: 500, y: 450, width: 650, height: 400 });
  await recordPids();
}
async function attach() {
  await fixture.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; w.restore(); w.show(); w.focus(); });
  await waitFor(() => fixture.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFocused()), 'fixture focus');
  const fixtureWindow = await fixture.evaluate(({ BrowserWindow }) => ({ handle: BrowserWindow.getAllWindows()[0].getNativeWindowHandle().readBigUInt64LE().toString(), pid: process.pid }));
  await app.evaluate((_e, fixtureWindow) => globalThis.__shizuku.startFollowing(fixtureWindow), fixtureWindow);
  await waitFor(async () => (await track()).following?.state === 'following', 'follow active');
}
async function capture(name) {
  const data = await main(async () => (await globalThis.__shizuku.avatar().webContents.capturePage()).toPNG().toString('base64'));
  await writeFile(path.join(directory, name + '.png'), Buffer.from(data, 'base64'));
}
try {
  await launch(); await openFixture(); await attach();
  assert.equal((await diag()).posture, 'sitting'); assert.equal((await diag()).quiet, true);
  const original = await bounds(); const frameCount = (await diag()).renderedFrames;
  await mutateFixture({ x: 560, y: 485, width: 650, height: 400 });
  await waitFor(async () => { const b = await bounds(); return b.x === original.x + 60 && b.y === original.y + 35; }, 'native move delta');
  await mutateFixture({ x: 560, y: 485, width: 750, height: 400 });
  await waitFor(async () => (await bounds()).x === original.x + 110, 'native resize center');
  assert.equal((await diag()).renderedFrames, frameCount, 'Moving a still avatar must not render new frames');
  assert.equal(await fixture.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFocused()), true);
  assert.equal(await main(() => globalThis.__shizuku.avatar().isFocused()), false);
  await capture('following'); samples.push({ name: 'following', state: await track(), bounds: await bounds() });
  results.push('Real Win32 metadata follows fixture movement/resize; a quiet avatar moves without extra render frames or taking fixture focus (API driven fixture).');

  await fixture.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].minimize());
  await waitFor(async () => (await track()).following?.state === 'minimized', 'minimized');
  assert.equal(await main(() => globalThis.__shizuku.status().visible), false);
  const hidden = (await diag()).renderedFrames; await delay(300); assert.equal((await diag()).renderedFrames, hidden);
  await fixture.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].restore());
  await waitFor(async () => (await track()).following?.state === 'following', 'restored');
  assert.equal(await main(() => globalThis.__shizuku.status().visible), true);
  await mutateFixture({ x: 560, y: 50, width: 750, height: 400 });
  await waitFor(async () => (await track()).following?.state === 'no-room', 'no headroom');
  assert.equal(await main(() => globalThis.__shizuku.status().visible), false);
  await mutateFixture({ x: 560, y: 470, width: 750, height: 400 });
  await waitFor(async () => (await track()).following?.state === 'following', 'headroom restored');
  await fixture.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].hide());
  await waitFor(async () => (await track()).following?.state === 'hidden', 'hidden fixture');
  await fixture.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].showInactive());
  await waitFor(async () => (await track()).following?.state === 'following', 'shown fixture');
  results.push('Minimize/hide/no headroom automatically hide; only the same selected window resumes presence when restored.');

  await act('quiet'); await page.waitForFunction(() => window.__diagnostics.animating);
  assert.equal((await track()).following.state, 'following');
  await act('call'); await page.waitForFunction(() => window.__diagnostics.reacting);
  assert.equal((await track()).following.state, 'following');
  await act('quiet'); await page.waitForFunction(() => !window.__diagnostics.animating);
  const old = (await track()).following;
  await act('hide'); assert.equal((await track()).following, null);
  await mutateFixture({ x: 600, y: 490, width: 750, height: 400 }); await delay(250);
  await app.evaluate((_e, old) => globalThis.__shizuku.onTrackedWindow({ ...old.window, y: 700 }), old);
  assert.equal(await main(() => globalThis.__shizuku.status().visible), false);
  await act('show'); await attach(); await act('size-small'); assert.equal((await track()).following, null);
  await act('size-standard'); await attach(); await act('face-left'); assert.equal((await track()).following, null);
  await attach(); await act('move-mode'); assert.equal((await track()).following, null); await act('move-mode');
  results.push('Call and quiet mode preserve following; manual hide, size, direction and drag detach; stale metadata cannot reveal a hidden avatar.');

  await attach(); await fixture.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  await waitFor(async () => !(await track()).following, 'closed target releases hook');
  assert.equal(await main(() => globalThis.__shizuku.status().visible), true);
  const recovered = await bounds(); const area = await main(({ screen }) => screen.getPrimaryDisplay().workArea);
  assert.equal(recovered.x, area.x + area.width - recovered.width - 24);
  await fixture.close(); fixture = null;
  await openFixture(); await delay(300); assert.equal((await track()).following, null, 'Replacement fixture never reattaches automatically');
  const opening = app.waitForEvent('window'); await main(() => globalThis.__shizuku.openControls()); const controls = await opening; await controls.waitForSelector('#follow');
  await main(() => { const w = globalThis.__shizuku.controls(); globalThis.__shizuku.startFollowing({ handle: w.getNativeWindowHandle().readBigUInt64LE().toString(), pid: process.pid }); });
  await waitFor(async () => !(await track()).following, 'own controls rejected');
  assert.match(await controls.locator('#move-hint').textContent(), /別の窓/);
  const selectionFixture = await fixture.evaluate(({ BrowserWindow }) => ({ handle: BrowserWindow.getAllWindows()[0].getNativeWindowHandle().readBigUInt64LE().toString(), pid: process.pid }));
  await app.evaluate((_e, value) => globalThis.__shizuku.setForegroundFixture(value), selectionFixture);
  await controls.locator('#follow').click(); await act('follow-countdown'); await delay(3200);
  assert.equal((await track()).following, null); assert.equal((await track()).countdown, 0);
  // Resolve native metadata for the pending selection using a dedicated
  // fixture. Foreground handoff is verified separately with OS input.
  await main(() => globalThis.__shizuku.controls().hide());
  await fixture.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; w.show(); w.focus(); });
  await waitFor(() => fixture.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFocused()), 'selection fixture focus');
  await app.evaluate((_e, value) => { globalThis.__shizuku.scheduleFollowing(value); globalThis.__shizuku.resolveSelectionFixture(value); }, selectionFixture);
  await waitFor(async () => (await track()).following?.state === 'following', 'selection accepts fixture metadata');
  await main(() => globalThis.__shizuku.openControls());
  await controls.screenshot({ path: path.join(directory, 'controls.png') });
  assert.equal(await controls.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  assert.equal(await controls.locator('#follow').textContent(), '窓の追従をやめる');
  results.push('Closing releases target and returns to screen edge; another window never reattaches; own controls are rejected; bounded window selection selects/cancels correctly.');

  const beforeStats = await track(); await delay(2500); const afterStats = await track();
  assert.ok(afterStats.stats?.workingSetBytes > 0);
  samples.push({ name: 'helper resident sample', before: beforeStats.stats, after: afterStats.stats, intervalApproxMs: 2500 });
  await page.evaluate(() => { window.__followContext = document.querySelector('canvas').getContext('webgl2').getExtension('WEBGL_lose_context'); window.__followContext.loseContext(); });
  await page.waitForFunction(() => window.__diagnostics.contextLost);
  assert.equal((await track()).following, null);
  await page.evaluate(() => window.__followContext.restoreContext()); await page.waitForFunction(() => !window.__diagnostics.contextLost);
  assert.equal((await track()).following, null);
  await attach();
  await main(() => process.kill(globalThis.__shizuku.tracking().pid));
  await waitFor(async () => !(await track()).ready && !(await track()).following, 'helper failure recovery');
  assert.equal(await main(() => globalThis.__shizuku.status().visible), true);
  await act('reset'); await act('call');
  await recordPids(); await app.close(); app = null;
  results.push('Context loss detaches without replay; helper death recovers to screen edge while ordinary operations and exit remain usable.');

  await launch(); assert.equal((await track()).following, null);
  await attach(); await recordPids(); await app.close(); app = null;
  await fixture.close(); fixture = null;
  results.push('Restart requires a new explicit selection; normal quit while following closes native helper, Electron children and target hooks.');
} catch (error) { failure = error; }
finally {
  try { await recordPids(); } catch { }
  if (fixture) try { await fixture.close(); } catch { }
  if (app) try { await app.close(); } catch { }
  let remaining = [];
  for (let i = 0; i < 30; i++) { remaining = [...pids].filter(pid => { try { process.kill(pid, 0); return true; } catch { return false; } }); if (!remaining.length) break; await delay(200); }
  const settingsUnchanged = (await readFile(path.join(root, 'local.config.json'))).equals(before);
  if (remaining.length || !settingsUnchanged) failure ??= new Error('Processes remain or normal settings changed');
  await writeFile(path.join(directory, 'result.json'), JSON.stringify({ status: failure ? 'failed' : 'passed', results, samples, remainingPids: remaining, settingsUnchanged, error: failure?.stack, date: new Date().toISOString() }, null, 2));
  console.log(JSON.stringify({ directory, passed: results.length, status: failure ? 'failed' : 'passed', remainingPids: remaining, settingsUnchanged, error: failure?.message }, null, 2));
}
if (failure) throw failure;
