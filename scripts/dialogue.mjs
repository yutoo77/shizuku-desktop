// Isolated app/UI acceptance. Native input is evaluated separately; no network
// provider, microphone, foreign window inspection or actual OS sleep is used.
import { _electron } from 'playwright';
import electron from 'electron';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const normal = path.join(root, 'local.config.json');
const before = await readFile(normal);
const config = JSON.parse(before.toString().replace(/^\uFEFF/, ''));
await mkdir(path.join(root, 'work'), { recursive: true });
const directory = await mkdtemp(path.join(root, 'work', 'dialogue-'));
await writeFile(path.join(directory, 'local.config.json'), JSON.stringify({ modelPath: config.modelPath, quiet: true }));
const checks = [], pids = new Set();
let app, avatar, chat, failure;
const main = fn => app.evaluate(fn);
const state = () => main(() => __shizuku.dialogueState());
async function waitFor(predicate, label) {
  const end = Date.now() + 7000;
  while (Date.now() < end) { if (await predicate()) return; await delay(50); }
  throw new Error(label);
}
async function recordPids() {
  pids.add(app.process().pid);
  for (const process of await main(({ app }) => app.getAppMetrics())) pids.add(process.pid);
  pids.add(await main(() => __shizuku.tracking().pid));
}
async function open(replyMode = 'local') {
  await main(() => __shizuku.closeDialogue());
  await app.evaluate((_electron, mode) => {
    globalThis.replyQueue = [];
    __shizuku.setDialogueReply(mode === 'local' ? undefined : (text, { signal }) => new Promise((resolve, reject) => {
      globalThis.replyQueue.push({ text, signal, resolve, reject });
    }));
  }, replyMode);
  const opened = app.waitForEvent('window');
  await main(() => __shizuku.action('call'));
  chat = await opened;
  chat.setDefaultTimeout(6000);
  await chat.waitForSelector('#message');
  await waitFor(() => main(() => !!__shizuku.dialogue()?.isVisible()), 'Chat becomes visible');
  await recordPids();
}
try {
  app = await _electron.launch({ executablePath: electron, args: [root], cwd: root,
    env: { ...process.env, SHIZUKU_TEST: '1', SHIZUKU_TEST_DATA: path.basename(directory) } });
  avatar = await app.firstWindow();
  await avatar.waitForFunction(() => window.__diagnostics?.loaded);
  await open();
  assert.equal(await main(() => __shizuku.dialogue().isFocused()), false);
  assert.equal(await chat.evaluate(() => typeof window.require), 'undefined');
  assert.equal(await chat.evaluate(() => typeof window.companion), 'undefined');
  assert.equal(await chat.evaluate(() => typeof window.process), 'undefined');
  assert.equal(await chat.evaluate(async () => { try { await fetch('https://example.com'); return false; } catch { return true; } }), true);
  const bounds = await main(({ screen }) => ({ area: screen.getPrimaryDisplay().workArea, chat: __shizuku.dialogue().getBounds() }));
  assert.ok(bounds.chat.x >= bounds.area.x && bounds.chat.y >= bounds.area.y);
  assert.ok(bounds.chat.x + bounds.chat.width <= bounds.area.x + bounds.area.width);
  assert.ok(bounds.chat.y + bounds.chat.height <= bounds.area.y + bounds.area.height);
  checks.push('Call opens a sandboxed chat without focus, desktop/model bridge, Node access or external requests; placement stays in the work area.');

  const id = await main(() => __shizuku.dialogue().id);
  await main(({ screen }) => {
    const area = screen.getPrimaryDisplay().workArea;
    __shizuku.dialogue().setPosition(area.x - 1200, area.y - 1200);
  });
  await main(() => __shizuku.action('call'));
  assert.equal(await main(() => __shizuku.dialogue().id), id);
  const recovered = await main(() => __shizuku.dialogue().getBounds());
  assert.ok(recovered.x >= bounds.area.x && recovered.y >= bounds.area.y);
  await chat.locator('#message').fill('こんにちは <img src=x onerror=alert(1)>');
  await chat.locator('#send').click();
  await waitFor(async () => (await state()).messages.length === 2, 'Local response');
  assert.equal(await chat.locator('#messages img').count(), 0);
  assert.match(await chat.locator('#messages').innerText(), /<img/);
  assert.match((await state()).messages[1].text, /呼んでくれてありがとう/);
  await chat.screenshot({ path: path.join(directory, 'local-conversation.png') });
  checks.push('Repeated calls reuse one chat and recover an offscreen placement; local greeting works and markup is displayed as text.');

  await open('held');
  await chat.locator('#message').fill('日本語を確定する');
  await chat.locator('#message').evaluate(element => {
    element.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, isComposing: true }));
    element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, isComposing: true }));
  });
  assert.equal((await state()).messages.length, 0);
  assert.equal(await main(() => !!__shizuku.dialogue()), true);
  await chat.locator('#message').evaluate(element => element.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })));
  await chat.locator('#message').press('Shift+Enter');
  assert.equal((await state()).messages.length, 0);
  await chat.locator('#message').press('Enter');
  await waitFor(async () => (await state()).status === 'pending', 'IME-confirmed send');
  assert.equal(await chat.evaluate(() => window.dialogue.send('duplicate')), false);
  assert.equal(await chat.evaluate(() => window.dialogue.send('x'.repeat(1001))), false);
  checks.push('Composition Enter/Escape and Shift+Enter do not send or close; a confirmed Enter sends once and a pending duplicate is rejected (synthetic input).');

  await chat.locator('#cancel').click();
  assert.equal(await main(() => replyQueue[0].signal.aborted), true);
  await chat.locator('#message').fill('新しい返事を待つ'); await chat.locator('#send').click();
  await waitFor(() => main(() => replyQueue.length === 2), 'Second held reply');
  await main(() => replyQueue[0].resolve('古い返事'));
  await delay(80);
  assert.equal((await state()).status, 'pending');
  await main(() => replyQueue[1].resolve('新しい返事'));
  await waitFor(async () => (await state()).status === 'idle', 'New reply');
  assert.deepEqual((await state()).messages.map(message => message.text), ['日本語を確定する', '新しい返事を待つ', '新しい返事']);
  checks.push('Cancel aborts the request; its late success cannot replace or complete a newer pending reply.');

  await chat.locator('#message').fill('消してから遅れて失敗'); await chat.locator('#send').click();
  await waitFor(() => main(() => replyQueue.length === 3), 'Third held reply');
  await chat.locator('#options summary').click(); await chat.locator('#clear').click();
  await main(() => replyQueue[2].reject(new Error('private-provider-details')));
  await delay(80);
  assert.deepEqual((await state()).messages, []); assert.equal((await state()).error, null);
  await chat.locator('#message').fill('失敗のあとに戻る'); await chat.locator('#send').click();
  await waitFor(() => main(() => replyQueue.length === 4), 'Fourth held reply');
  await main(() => replyQueue[3].reject(new Error('private-provider-details')));
  await waitFor(async () => (await state()).status === 'error', 'Failure shown');
  assert.doesNotMatch(await chat.locator('#error').innerText(), /private-provider/);
  await chat.locator('#message').fill('再送'); await chat.locator('#send').click();
  await waitFor(() => main(() => replyQueue.length === 5), 'Retry after error');
  await main(() => replyQueue[4].resolve('戻ったよ。'));
  await waitFor(async () => (await state()).status === 'idle', 'Retried reply');
  checks.push('Clear drops history and ignores late failures; active errors are sanitized and a later send succeeds.');

  await main(() => { __shizuku.dialogue().setSize(320, 320); __shizuku.dialogue().webContents.setZoomFactor(1.25); });
  await delay(150);
  const layout = await chat.evaluate(() => {
    const rect = document.querySelector('#send').getBoundingClientRect();
    return { height: innerHeight, width: innerWidth, send: { bottom: rect.bottom, right: rect.right }, scroll: document.documentElement.scrollWidth };
  });
  assert.ok(layout.send.bottom <= layout.height && layout.send.right <= layout.width);
  assert.ok(layout.scroll <= layout.width);
  await chat.screenshot({ path: path.join(directory, 'small-125-percent.png') });
  checks.push('At minimum window size and 125% page zoom, the send action remains visible without horizontal overflow.');

  await open('held');
  await chat.evaluate(() => window.dialogue.send('閉じたあとには出さない'));
  await waitFor(() => main(() => replyQueue.length === 1), 'Reply started before close');
  await main(() => { globalThis.oldReply = replyQueue[0]; __shizuku.dialogue().close(); });
  await waitFor(() => main(() => !__shizuku.dialogue()), 'Native window close');
  assert.equal(await main(() => oldReply.signal.aborted), true);
  await open();
  await main(() => oldReply.resolve('閉じた窓の返事'));
  await delay(80); assert.deepEqual((await state()).messages, []);
  await chat.locator('#message').press('Escape').catch(error => { if (!chat.isClosed()) throw error; });
  await waitFor(() => main(() => !__shizuku.dialogue()), 'Escape closes chat');
  assert.equal(await main(() => __shizuku.avatar().isVisible()), true);
  checks.push('Window close and Escape dispose the conversation while the avatar remains; reopening starts empty and ignores an old reply.');

  await open('held');
  await chat.evaluate(() => window.dialogue.send('休止する'));
  await waitFor(() => main(() => replyQueue.length === 1), 'Reply before rest');
  await main(({ powerMonitor }) => powerMonitor.emit('suspend'));
  assert.equal(await main(() => !!__shizuku.dialogue()), false);
  assert.equal(await main(() => replyQueue[0].signal.aborted), true);
  await main(({ powerMonitor }) => powerMonitor.emit('resume'));
  assert.equal(await main(() => !!__shizuku.dialogue()), false);
  await open(); await main(() => __shizuku.action('hide'));
  assert.equal(await main(() => !!__shizuku.dialogue()), false);
  await main(() => __shizuku.action('show'));
  assert.equal(await main(() => !!__shizuku.dialogue()), false);
  checks.push('Explicit hide and simulated system rest close/abort chat; display recovery never reopens it or replays text.');

  await open(); await recordPids();
  const appProcess = app.process(); await main(() => __shizuku.action('quit'));
  await waitFor(() => appProcess.exitCode !== null, 'Normal quit'); app = null;
  const saved = JSON.parse(await readFile(path.join(directory, 'local.config.json'), 'utf8'));
  assert.deepEqual(Object.keys(saved).sort(), ['bounds', 'facing', 'favorite', 'modelPath', 'posture', 'quiet', 'scale']);
  checks.push('Normal quit closes chat and helper; saved configuration has no conversation fields.');
} catch (error) { failure = error; }
finally {
  if (app) { await recordPids().catch(() => {}); await app.close().catch(() => {}); }
  let remainingPids = [];
  for (let i = 0; i < 40; i++) {
    remainingPids = [...pids].filter(pid => { try { process.kill(pid, 0); return true; } catch { return false; } });
    if (!remainingPids.length) break; await delay(100);
  }
  const settingsUnchanged = (await readFile(normal)).equals(before);
  if (remainingPids.length || !settingsUnchanged) failure ??= new Error('Cleanup/settings invariant failed');
  await writeFile(path.join(directory, 'result.json'), JSON.stringify({ status: failure ? 'failed' : 'passed', checks, remainingPids, settingsUnchanged, error: failure?.stack }, null, 2));
  console.log(JSON.stringify({ directory, checks: checks.length, status: failure ? 'failed' : 'passed', remainingPids, settingsUnchanged, error: failure?.message }, null, 2));
}
if (failure) throw failure;
