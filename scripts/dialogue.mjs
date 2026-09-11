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
const lifecycle = [];
let app, appProcess, avatar, chat, failure, smallLayoutCapture, cleanupStarted = false, requestedQuit = false;
const recordLifecycle = (event, details = {}) => lifecycle.push({ event, completedChecks: checks.length, cleanupStarted, requestedQuit, ...details });
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
  // Playwright's default focus emulation masks real BrowserWindow focus changes.
  // Disable it only for this test-owned chat; its CDP session ends with the page.
  const focusSession = await app.context().newCDPSession(chat);
  await focusSession.send('Emulation.setFocusEmulationEnabled', { enabled: false });
  await waitFor(() => main(() => !!__shizuku.dialogue()?.isVisible()), 'Chat becomes visible');
  await recordPids();
}
async function focusChat() {
  // Activate only this test-owned dialogue. This is an Electron API assertion,
  // not a native-input or foreign-application focus test.
  await main(() => __shizuku.dialogue().focus());
  await chat.waitForFunction(() => document.hasFocus());
}
async function holdSendAcknowledgement() {
  await main(({ ipcMain }) => {
    const original = ipcMain._invokeHandlers.get('dialogue:send');
    globalThis.sendAcknowledgement = null;
    ipcMain._invokeHandlers.set('dialogue:send', async (event, text) => {
      ipcMain._invokeHandlers.set('dialogue:send', original);
      const accepted = await original(event, text);
      await new Promise(resolve => { globalThis.sendAcknowledgement = resolve; });
      return accepted;
    });
  });
  await chat.evaluate(() => {
    const input = document.querySelector('#message');
    const original = input.focus.bind(input);
    window.inputFocusCalls = 0;
    input.focus = (...args) => { window.inputFocusCalls++; return original(...args); };
  });
}
async function releaseSendAcknowledgement() {
  await main(() => { sendAcknowledgement(); globalThis.sendAcknowledgement = null; });
}
async function observeLifecycle() {
  appProcess = app.process();
  appProcess.on('exit', (exitCode, signalCode) => recordLifecycle('process-exit', { exitCode, signalCode }));
  app.on('close', () => recordLifecycle('playwright-application-close'));
  app.context().on('close', () => recordLifecycle('playwright-context-close'));
  let pageNumber = 0;
  const observePage = page => {
    const pageId = ++pageNumber;
    page.on('close', () => recordLifecycle('playwright-page-close', { pageId }));
    page.on('crash', () => recordLifecycle('playwright-page-crash', { pageId }));
  };
  app.on('window', observePage);
  for (const page of app.windows()) observePage(page);
  app.on('console', message => {
    const text = message.text(), prefix = '__SHIZUKU_LIFECYCLE__';
    if (!text.startsWith(prefix) || text.length > 300) return;
    try { recordLifecycle('electron', JSON.parse(text.slice(prefix.length))); } catch { /* Ignore unrelated console payloads. */ }
  });
  await main(({ app, BrowserWindow }) => {
    const emit = (kind, details = {}) => console.log('__SHIZUKU_LIFECYCLE__' + JSON.stringify({ kind, ...details }));
    const observe = win => {
      const windowId = win.id;
      win.on('close', () => emit('window-close', { windowId }));
      win.on('closed', () => emit('window-closed', { windowId }));
      win.on('unresponsive', () => emit('window-unresponsive', { windowId }));
      win.webContents.on('render-process-gone', (_event, details) => {
        const reasons = ['clean-exit', 'abnormal-exit', 'killed', 'crashed', 'oom', 'launch-failed', 'integrity-failure', 'memory-eviction'];
        emit('renderer-gone', { windowId, reason: reasons.includes(details.reason) ? details.reason : 'unknown', exitCode: details.exitCode });
      });
    };
    for (const win of BrowserWindow.getAllWindows()) observe(win);
    app.on('browser-window-created', (_event, win) => observe(win));
    app.on('before-quit', () => emit('before-quit'));
    app.on('will-quit', () => emit('will-quit'));
    app.on('window-all-closed', () => emit('window-all-closed'));
  });
}
try {
  const env = { ...process.env, SHIZUKU_TEST: '1', SHIZUKU_TEST_DATA: path.basename(directory) };
  delete env.OPENAI_API_KEY;
  app = await _electron.launch({ executablePath: electron, args: [root], cwd: root,
    env });
  await observeLifecycle();
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
  await focusChat();
  await chat.locator('#message').fill('こんにちは <img src=x onerror=alert(1)>');
  await chat.locator('#send').click();
  await waitFor(async () => (await state()).messages.length === 2, 'Local response');
  await chat.waitForFunction(() => document.activeElement === document.querySelector('#message'));
  assert.equal(await chat.locator('#messages img').count(), 0);
  assert.match(await chat.locator('#messages').innerText(), /<img/);
  assert.match((await state()).messages[1].text, /呼んでくれてありがとう/);
  await chat.screenshot({ path: path.join(directory, 'local-conversation.png') });
  checks.push('Repeated calls reuse one chat and recover an offscreen placement; local greeting works and markup is displayed as text. Clicking send in the focused test chat returns its caret to the composer after acceptance.');

  const rememberedMessages = (await state()).messages;
  await chat.locator('#message').fill('まだ送っていない一言');
  await chat.locator('#options summary').click();
  await chat.locator('#provider').focus();
  await chat.locator('#provider').press('Escape');
  assert.equal(await main(() => __shizuku.dialogue()?.id), id);
  assert.equal(await chat.locator('#options').evaluate(element => element.open), false);
  assert.equal(await chat.evaluate(() => document.activeElement === document.querySelector('#options summary')), true);
  assert.equal(await chat.locator('#message').inputValue(), 'まだ送っていない一言');
  assert.deepEqual((await state()).messages, rememberedMessages);
  await chat.locator('#options summary').click();
  await chat.locator('#message').focus();
  await chat.locator('#message').press('Escape');
  assert.equal(await chat.locator('#options').evaluate(element => element.open), false);
  assert.equal(await chat.evaluate(() => document.activeElement === document.querySelector('#message')), true);
  assert.equal(await chat.locator('#message').inputValue(), 'まだ送っていない一言');
  assert.deepEqual((await state()).messages, rememberedMessages);
  await chat.locator('#message').press('Escape').catch(error => { if (!chat.isClosed()) throw error; });
  await waitFor(() => main(() => !__shizuku.dialogue()), 'Second Escape closes chat');
  checks.push('Escape first dismisses open settings while preserving draft/history. Focus returns to the summary only from inside settings; a second Escape closes the conversation.');

  await open('held'); await focusChat();
  await chat.locator('#message').fill('返事の前に設定を見る');
  await holdSendAcknowledgement();
  await chat.locator('#send').click();
  await waitFor(() => main(() => !!sendAcknowledgement), 'Held acceptance before moving to settings');
  await chat.locator('#options summary').click();
  await releaseSendAcknowledgement();
  await chat.waitForFunction(() => document.querySelector('#message').value === '');
  assert.equal(await chat.evaluate(() => document.activeElement === document.querySelector('#options summary')), true);
  assert.equal(await chat.evaluate(() => window.inputFocusCalls), 0);
  checks.push('A delayed send acknowledgement does not move focus away from settings selected after the send click.');

  await open('held'); await focusChat();
  await chat.locator('#message').fill('送信待ちの間に窓を離れる');
  await holdSendAcknowledgement();
  await chat.locator('#send').click();
  await waitFor(() => main(() => !!sendAcknowledgement), 'Held acceptance before focusing owned controls');
  // On Windows, BrowserWindow.blur() alone can leave the document focused.
  // Move to our other test-owned window and observe the actual focus transition.
  const controlsOpened = app.waitForEvent('window');
  await main(() => __shizuku.openControls());
  const focusControls = await controlsOpened;
  await focusControls.waitForSelector('#call');
  await main(() => __shizuku.controls().focus());
  await waitFor(() => main(() => __shizuku.controls().isFocused()), 'Owned controls receive focus');
  await chat.waitForFunction(() => !document.hasFocus());
  await recordPids();
  await releaseSendAcknowledgement();
  await chat.waitForFunction(() => document.querySelector('#message').value === '');
  assert.equal(await chat.evaluate(() => document.hasFocus()), false);
  assert.equal(await main(() => __shizuku.dialogue().isFocused()), false);
  assert.equal(await main(() => __shizuku.controls().isFocused()), true);
  assert.equal(await chat.evaluate(() => window.inputFocusCalls), 0);
  await main(() => new Promise((resolve, reject) => {
    const controls = __shizuku.controls();
    // The main owner becomes null in 'close', before native destruction ends.
    // Wait for 'closed' before this test destroys the next owned window.
    const timeout = setTimeout(() => reject(new Error('Owned controls did not finish closing')), 7000);
    controls.once('closed', () => { clearTimeout(timeout); resolve(); });
    controls.close();
  }));
  assert.equal(await main(() => __shizuku.controls()), null);
  checks.push('A delayed acknowledgement after focusing test-owned controls leaves those controls focused, without focusing the chat input or reactivating its window (Electron API focus check).');

  await open('held'); await focusChat();
  await chat.locator('#message').fill('送信する最初の文');
  await holdSendAcknowledgement();
  await chat.locator('#send').click();
  await waitFor(() => main(() => !!sendAcknowledgement), 'Held acceptance before a newer draft');
  await chat.locator('#message').fill('これは次の下書き');
  await chat.evaluate(() => { window.inputFocusCalls = 0; });
  await releaseSendAcknowledgement();
  await delay(80);
  assert.equal(await chat.locator('#message').inputValue(), 'これは次の下書き');
  assert.equal(await chat.evaluate(() => window.inputFocusCalls), 0);
  checks.push('Typing a newer draft while acceptance is delayed preserves that draft and does not perform a later focus return.');

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
    const bounds = id => {
      const rect = document.querySelector(id).getBoundingClientRect();
      return { top: rect.top, left: rect.left, bottom: rect.bottom, right: rect.right, width: rect.width, height: rect.height };
    };
    return { height: innerHeight, width: innerWidth, devicePixelRatio, send: bounds('#send'), close: bounds('#close'), scroll: document.documentElement.scrollWidth };
  });
  for (const button of [layout.send, layout.close]) {
    assert.ok(button.width > 0 && button.height > 0 && button.top >= 0 && button.left >= 0
      && button.bottom <= layout.height && button.right <= layout.width);
  }
  assert.ok(layout.scroll <= layout.width);
  // Capture our complete native content surface: Playwright's screenshot crop
  // can follow CSS dimensions instead of the zoomed Electron content bounds.
  const nativeCapture = await main(async () => {
    const win = __shizuku.dialogue();
    const image = await win.webContents.capturePage();
    return {
      captureSize: image.getSize(), contentBounds: win.getContentBounds(), windowBounds: win.getBounds(),
      zoomFactor: win.webContents.getZoomFactor(), empty: image.isEmpty(), png: image.toPNG().toString('base64'),
    };
  });
  const { png, ...captureMetadata } = nativeCapture;
  smallLayoutCapture = { ...captureMetadata, css: layout };
  assert.equal(nativeCapture.empty, false);
  assert.ok(nativeCapture.captureSize.width > 0 && nativeCapture.captureSize.height > 0);
  await writeFile(path.join(directory, 'small-125-percent.png'), Buffer.from(png, 'base64'));
  checks.push('At minimum window size and 125% page zoom, send and close remain inside the CSS viewport without horizontal overflow; a complete Electron capture and native/CSS dimensions are retained for visual review.');

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
  requestedQuit = true;
  await main(() => __shizuku.action('quit'));
  await waitFor(() => appProcess.exitCode !== null, 'Normal quit'); app = null;
  const saved = JSON.parse(await readFile(path.join(directory, 'local.config.json'), 'utf8'));
  assert.deepEqual(Object.keys(saved).sort(), ['bounds', 'facing', 'favorite', 'modelPath', 'posture', 'quiet', 'scale', 'textureQuality']);
  checks.push('Normal quit closes chat and helper; saved configuration has no conversation fields.');
} catch (error) { failure = error; }
finally {
  cleanupStarted = true;
  if (app) { await recordPids().catch(() => {}); await app.close().catch(() => {}); }
  let remainingPids = [];
  for (let i = 0; i < 40; i++) {
    remainingPids = [...pids].filter(pid => { try { process.kill(pid, 0); return true; } catch { return false; } });
    if (!remainingPids.length) break; await delay(100);
  }
  const settingsUnchanged = (await readFile(normal)).equals(before);
  if (remainingPids.length || !settingsUnchanged) failure ??= new Error('Cleanup/settings invariant failed');
  await writeFile(path.join(directory, 'result.json'), JSON.stringify({ status: failure ? 'failed' : 'passed', checks, smallLayoutCapture, lifecycle, processExit: { exitCode: appProcess?.exitCode ?? null, signalCode: appProcess?.signalCode ?? null }, remainingPids, settingsUnchanged, error: failure?.stack }, null, 2));
  console.log(JSON.stringify({ directory, checks: checks.length, status: failure ? 'failed' : 'passed', remainingPids, settingsUnchanged, error: failure?.message }, null, 2));
}
if (failure) throw failure;
