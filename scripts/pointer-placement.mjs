// Main-process integration; physical pointer/focus checks are recorded separately.
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
const directory = await mkdtemp(path.join(root, 'work', 'pointer-'));
await writeFile(path.join(directory, 'local.config.json'), JSON.stringify({ modelPath: cfg.modelPath, quiet: true, bounds: { x: 600, y: 300 } }));
const checks = [], pids = new Set(); let app, page, failure;
const act = value => app.evaluate((_e, value) => globalThis.__shizuku.action(value), value);
const inspect = fn => app.evaluate(fn);
const bounds = () => inspect(() => globalThis.__shizuku.avatar().getBounds());
const state = () => inspect(() => globalThis.__shizuku.pointerState());
const stop = async commit => { await app.evaluate((_e, commit) => globalThis.__shizuku.finishPointerPlacement(commit), commit); await page.waitForFunction(() => !window.__diagnostics.moving); };
async function begin() { await act('pointer-place'); await page.waitForFunction(() => window.__diagnostics.moving); assert.equal((await state()).active, true); }
async function offset(x, y) {
  // Override cursor sampling only inside this isolated test process, briefly.
  await app.evaluate(({ screen }, { x, y }) => {
    const point = screen.getCursorScreenPoint(); const original = screen.getCursorScreenPoint;
    screen.getCursorScreenPoint = () => ({ x: point.x + x, y: point.y + y });
    globalThis.__shizuku.tickPointerPlacement(); screen.getCursorScreenPoint = original;
    globalThis.__shizuku.finishPointerPlacement(true);
  }, { x, y });
  await delay(80);
}
try {
  app = await _electron.launch({ executablePath: electron, args: [root], cwd: root, env: { ...process.env, SHIZUKU_TEST: '1', SHIZUKU_TEST_DATA: path.basename(directory) } });
  page = await app.firstWindow(); await page.waitForFunction(() => window.__diagnostics?.loaded);
  // Isolate programmatic movement assertions from the user's physical pointer.
  await app.evaluate(({ screen }) => { screen.getCursorScreenPoint = () => ({ x: 500, y: 500 }); });
  pids.add(app.process().pid);
  for (const p of await inspect(() => globalThis.__shizuku.metrics())) pids.add(p.pid);
  pids.add(await inspect(() => globalThis.__shizuku.tracking().pid));
  const original = await bounds(); await begin();
  assert.equal(await inspect(() => globalThis.__shizuku.avatar().isFocusable()), false);
  assert.equal(await inspect(() => globalThis.__shizuku.moveState().active), false);
  const frames = await page.evaluate(() => window.__diagnostics.renderedFrames);
  await delay(160); assert.equal(await page.evaluate(() => window.__diagnostics.renderedFrames), frames);
  await page.screenshot({ path: path.join(directory, 'placement-cue.png'), omitBackground: true });
  await offset(70, 35);
  assert.deepEqual(await bounds(), { ...original, x: original.x + 70, y: original.y + 35 });
  assert.deepEqual(await state(), { active: false, escape: false, timer: false, origin: undefined });
  checks.push('M placement translates without changing size/posture, freezes frames and cleans up on commit.');
  const committed = await bounds(); await begin(); await stop(false); assert.deepEqual(await bounds(), committed);
  await begin(); await inspect(() => globalThis.__shizuku.tickPointerPlacement({ x: 1, y: 1 }, Number.MAX_VALUE));
  await delay(100); assert.equal((await state()).timer, false); assert.deepEqual(await bounds(), committed);
  checks.push('Cancel and elapsed deadline restore the origin and release the temporary Escape binding.');
  await inspect(({ globalShortcut }) => { if (!globalShortcut.register('Escape', () => {})) throw new Error('Could not reserve fixture Escape'); });
  await begin(); assert.equal((await state()).escape, false); await stop(false);
  assert.equal(await inspect(({ globalShortcut }) => globalShortcut.isRegistered('Escape')), true);
  await inspect(({ globalShortcut }) => globalShortcut.unregister('Escape'));
  checks.push('If Escape is already owned, placement leaves the existing binding intact and cancellation still works.');
  for (const action of ['hide', 'reset', 'sit', 'face-left', 'move-mode']) {
    await begin(); await act(action); assert.equal((await state()).active, false); assert.equal((await state()).timer, false);
    await inspect(() => globalThis.__shizuku.setMoveMode(false)); await act('show');
  }
  checks.push('Hide, reset, posture, facing and legacy drag interrupt placement.');
  await act('pointer-place'); await page.waitForFunction(() => window.__diagnostics.moving);
  await page.evaluate(() => { window.__loss = document.querySelector('canvas').getContext('webgl2').getExtension('WEBGL_lose_context'); window.__loss.loseContext(); });
  await page.waitForFunction(() => window.__diagnostics.contextLost);
  for (let i = 0; i < 50 && (await state()).active; i++) await delay(50);
  assert.equal((await state()).active, false);
  await page.evaluate(() => window.__loss.restoreContext());
  await page.waitForFunction(() => !window.__diagnostics.contextLost && window.__diagnostics.loaded);
  checks.push('GPU context loss cancels placement; recovery does not restart it.');
  assert.equal(await page.evaluate(async () => { try { await window.companion.action('pointer-place'); return false; } catch { return true; } }), true);
  const opened = app.waitForEvent('window');
  await inspect(() => globalThis.__shizuku.openControls());
  const controls = await opened;
  await controls.waitForSelector('#pointer-place');
  const layout = await controls.evaluate(() => ({ width: innerWidth, height: innerHeight, scrollWidth: document.documentElement.scrollWidth, scrollHeight: document.documentElement.scrollHeight }));
  assert.equal(layout.width, layout.scrollWidth); assert.equal(layout.height, layout.scrollHeight);
  await controls.screenshot({ path: path.join(directory, 'controls.png') });
  checks.push('Avatar renderer cannot start placement through controls IPC; ordinary controls fit without scrolling.');
  await inspect(() => globalThis.__shizuku.controls().close());
  await begin(); await app.close(); app = null;
  checks.push('Quitting during placement closes timers and the native helper.');
} catch (error) { failure = error; }
finally {
  if (app) await app.close().catch(() => {});
  for (let i = 0; i < 40 && [...pids].some(pid => { try { process.kill(pid, 0); return true; } catch { return false; } }); i++) await delay(100);
  const remainingPids = [...pids].filter(pid => { try { process.kill(pid, 0); return true; } catch { return false; } });
  const userSettingsUnchanged = (await readFile(path.join(root, 'local.config.json'))).equals(before);
  if (remainingPids.length || !userSettingsUnchanged) failure ??= new Error('Cleanup/settings invariant failed');
  await writeFile(path.join(directory, 'result.json'), JSON.stringify({ status: failure ? 'failed' : 'passed', checks, remainingPids, userSettingsUnchanged, error: failure?.stack }, null, 2));
  console.log(JSON.stringify({ directory, checks, remainingPids, userSettingsUnchanged, error: failure?.message }));
}
if (failure) throw failure;
