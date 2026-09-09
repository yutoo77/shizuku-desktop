// Own Electron windows only; physical shortcut/focus checks are recorded separately.
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
const directory = await mkdtemp(path.join(root, 'work', 'placement-'));
await writeFile(path.join(directory, 'local.config.json'), JSON.stringify({ modelPath: config.modelPath, quiet: 'invalid', facing: 'invalid', favorite: { bounds: { x: 'bad', y: 0 } } }));
let application, page, failure;
const pids = new Set(), results = [], frames = [];
const main = fn => application.evaluate(fn);
const diag = () => page.evaluate(() => ({ ...window.__diagnostics }));
const bounds = () => main(() => globalThis.__shizuku.avatar().getBounds());
const act = value => application.evaluate((_e, value) => globalThis.__shizuku.action(value), value);
const settled = () => page.waitForFunction(() => window.__diagnostics.loaded && !window.__diagnostics.changingPosture && !window.__diagnostics.changingFacing);
const recordPids = async () => { pids.add(application.process().pid); for (const p of await main(() => globalThis.__shizuku.metrics())) pids.add(p.pid); };
async function launch() {
  application = await _electron.launch({ executablePath: electron, args: [root], cwd: root, env: { ...process.env, SHIZUKU_TEST: '1', SHIZUKU_TEST_DATA: path.basename(directory) } });
  page = await application.firstWindow(); await page.waitForFunction(() => window.__diagnostics?.loaded); await recordPids();
}
async function capture(name) {
  const result = await main(async () => {
    const image = await globalThis.__shizuku.avatar().webContents.capturePage();
    const { width, height } = image.getSize(), pixels = image.toBitmap();
    let count = 0, minX = width, maxX = 0, minY = height, maxY = 0;
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) if (pixels[(y * width + x) * 4 + 3]) {
      count++; minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    }
    return { width, height, count, minX, maxX, minY, maxY, png: image.toPNG().toString('base64') };
  });
  const { png, ...info } = result;
  assert.ok(info.count > 100 && info.minX > 1 && info.minY > 1 && info.maxX < info.width - 2 && info.maxY < info.height - 2);
  assert.equal((await diag()).drawCalls, 20, 'Sample avatar must keep every part, including shoes');
  await writeFile(path.join(directory, name + '.png'), Buffer.from(png, 'base64'));
  frames.push({ name, ...info, diagnostics: await diag() });
}
async function seatAt(point) {
  await application.evaluate((_e, point) => globalThis.__shizuku.seatAtPoint(point), point);
  await settled();
  for (let i = 0; i < 80 && await main(() => !!globalThis.__shizuku.status().pendingSeat); i++) await delay(50);
  assert.equal(await main(() => globalThis.__shizuku.status().pendingSeat), null);
  const b = await bounds(), anchor = (await diag()).seatAnchor;
  assert.ok(anchor);
  assert.ok(Math.abs(b.x + anchor.x * b.width - point.x) < 2);
  assert.ok(Math.abs(b.y + anchor.y * b.height - point.y) < 2);
}
try {
  await launch(); await page.emulateMedia({ reducedMotion: 'no-preference' }); await settled();
  assert.equal((await diag()).quiet, false); assert.equal((await diag()).facing, 'right');
  assert.equal(await main(() => globalThis.__shizuku.status().favorite), null);
  const opening = application.waitForEvent('window'); await main(() => globalThis.__shizuku.openControls());
  const controls = await opening; await controls.waitForSelector('#seat');
  assert.equal(await controls.locator('[data-action="restore-favorite"]').isDisabled(), true);
  const s = await main(({ screen }) => screen.getPrimaryDisplay().workArea);
  const target = { x: s.x + Math.floor(s.width / 2), y: s.y + Math.floor(s.height / 2) };
  for (const scale of [80, 120, 100]) {
    await application.evaluate((_e, scale) => globalThis.__shizuku.setScale(scale), scale);
    await delay(100); await seatAt(target); await capture('seated-' + scale);
  }
  assert.equal(await main(() => globalThis.__shizuku.avatar().isFocusable()), false);
  assert.equal(await main(() => globalThis.__shizuku.moveState().active), false);
  results.push('Corrupt preferences recover; all sizes align the seat to an explicit point and keep a nonfocusable window.');

  await controls.locator('input[name="facing"][value="left"]').check(); await settled(); await capture('left');
  assert.equal((await diag()).facing, 'left');
  await act('face-right'); await delay(100); await act('face-left'); await settled();
  assert.equal((await diag()).facing, 'left');
  await main(() => globalThis.__shizuku.setMoveMode(true)); await page.waitForFunction(() => window.__diagnostics.moving);
  await act('face-right'); await settled(); assert.equal(await main(() => globalThis.__shizuku.moveState().active), false);
  await capture('right');
  results.push('Facing radios turn the actual model; reversal settles and changing direction releases move mode.');

  await controls.locator('#quiet').click(); await page.waitForFunction(() => window.__diagnostics.quiet && !window.__diagnostics.animating);
  let still = (await diag()).renderedFrames; await delay(650); assert.equal((await diag()).renderedFrames, still);
  await act('call'); await page.waitForFunction(() => window.__diagnostics.reacting);
  assert.equal((await diag()).animating, false); await page.waitForFunction(() => !window.__diagnostics.reacting);
  assert.equal((await diag()).renderedFrames, still + 2);
  await act('stand'); await settled(); await seatAt(target);
  assert.equal((await diag()).animating, false); still = (await diag()).renderedFrames;
  await delay(300); assert.equal((await diag()).renderedFrames, still);
  await controls.screenshot({ path: path.join(directory, 'controls.png') });
  const layout = await controls.evaluate(() => ({ horizontal: document.documentElement.scrollWidth > innerWidth,
    fits: [...document.querySelectorAll('body > .row button, .appearance-options input, .arrows button, summary')].every(el => el.getBoundingClientRect().bottom < innerHeight) }));
  assert.deepEqual(layout, { horizontal: false, fits: true });
  results.push('Quiet display uses no repeating frames; call is two static frames; seating works while quiet; controls fit.');

  await act('face-left'); await settled(); await act('save-favorite');
  const saved = await main(() => globalThis.__shizuku.status().favorite);
  await act('reset'); await act('stand'); await act('size-small'); await act('face-right'); await act('hide');
  await act('restore-favorite'); await settled(); await delay(150);
  assert.deepEqual(await bounds(), saved.bounds); assert.equal((await diag()).posture, 'sitting');
  assert.equal((await diag()).facing, 'left'); assert.equal((await diag()).quiet, true);
  assert.equal(await main(() => globalThis.__shizuku.status().visible), true);
  results.push('Favorite stores position, size, posture and facing; recall reveals and restores it without changing quiet mode.');

  await act('seat-countdown'); assert.equal(await main(() => globalThis.__shizuku.status().seatCountdown), 3);
  await act('seat-countdown'); const cancelledBounds = await bounds(); await delay(3200);
  assert.deepEqual(await bounds(), cancelledBounds); assert.equal(await main(() => globalThis.__shizuku.status().seatCountdown), 0);
  await act('seat-countdown'); await act('hide'); await delay(3200);
  assert.equal(await main(() => globalThis.__shizuku.status().visible), false);
  assert.equal(await main(() => globalThis.__shizuku.status().pendingSeat), null);
  await act('show'); await act('quiet'); await act('stand'); await settled();
  await application.evaluate((_e, point) => globalThis.__shizuku.seatAtPoint(point), target);
  const pending = await main(() => globalThis.__shizuku.status().pendingSeat);
  assert.ok(pending); await act('hide');
  await page.evaluate(revision => window.companion.submitSeatAnchor(revision, { x: 0, y: 0 }), pending.revision);
  await delay(800); assert.equal(await main(() => globalThis.__shizuku.status().visible), false);
  await act('show'); await settled();
  const safeBounds = await bounds();
  await page.evaluate(() => window.companion.submitSeatAnchor(999999, { x: 0, y: 0 })); await delay(100);
  assert.deepEqual(await bounds(), safeBounds);
  await assert.rejects(page.evaluate(() => window.companion.action('seat-here')));
  await assert.rejects(main(() => globalThis.__shizuku.setPresence('up', true)));
  results.push('Countdown cancellation and hide prevent late moves or reveal; stale responses and unauthorized renderer actions are rejected.');

  await act('seat-countdown'); await delay(3200); await settled();
  for (let i = 0; i < 80 && await main(() => !!globalThis.__shizuku.status().pendingSeat); i++) await delay(50);
  assert.equal(await main(() => globalThis.__shizuku.status().pendingSeat), null);
  assert.match(await controls.locator('#move-hint').textContent(), /合わせました/);
  results.push('The three-second countdown completes using one actual Electron cursor-position read.');

  await act('quiet'); await page.waitForFunction(() => !window.__diagnostics.animating);
  await page.evaluate(() => { window.__loss = document.querySelector('canvas').getContext('webgl2').getExtension('WEBGL_lose_context'); window.__loss.loseContext(); });
  await page.waitForFunction(() => window.__diagnostics.contextLost);
  await act('face-left'); await act('seat-countdown');
  assert.equal(await main(() => globalThis.__shizuku.status().seatCountdown), 0);
  await page.evaluate(() => window.__loss.restoreContext()); await page.waitForFunction(() => !window.__diagnostics.contextLost);
  await settled(); still = (await diag()).renderedFrames; await delay(300);
  assert.equal((await diag()).renderedFrames, still); await capture('restored-quiet');
  await act('hide'); still = (await diag()).renderedFrames; await act('face-right'); await act('quiet'); await delay(300);
  assert.equal((await diag()).renderedFrames, still);
  await act('quiet'); await act('restore-favorite'); await settled();
  await main(() => globalThis.__shizuku.avatar().webContents.send('model:changed')); await delay(200); await settled();
  assert.equal((await diag()).quiet, true); assert.equal((await diag()).facing, 'left'); await capture('favorite');
  results.push('Context restoration, hidden changes and model reload preserve stillness/facing and do not restart rendering.');

  await recordPids(); await application.close(); application = null;
  await launch(); await settled(); assert.equal((await diag()).quiet, true); assert.equal((await diag()).facing, 'left');
  assert.deepEqual(await main(() => globalThis.__shizuku.status().favorite), saved);
  assert.deepEqual(await bounds(), saved.bounds);
  await act('seat-countdown'); await recordPids(); await application.close(); application = null; await delay(3200);
  results.push('Preferences and favorite persist through restart; quitting cancels an active placement countdown.');
} catch (error) { failure = error; }
finally {
  if (application) { try { await recordPids(); await application.close(); } catch (error) { failure ??= error; } }
  let remaining = [];
  for (let i = 0; i < 20; i++) { remaining = [...pids].filter(pid => { try { process.kill(pid, 0); return true; } catch { return false; } }); if (!remaining.length) break; await delay(250); }
  const settingsUnchanged = (await readFile(path.join(root, 'local.config.json'))).equals(before);
  if (remaining.length || !settingsUnchanged) failure ??= new Error('Processes remain or normal settings changed');
  await writeFile(path.join(directory, 'result.json'), JSON.stringify({ status: failure ? 'failed' : 'passed', date: new Date().toISOString(), results, frames, remainingPids: remaining, settingsUnchanged, error: failure?.stack }, null, 2));
  console.log(JSON.stringify({ directory, passed: results.length, status: failure ? 'failed' : 'passed', remainingPids: remaining, settingsUnchanged, error: failure?.message }, null, 2));
}
if (failure) throw failure;
