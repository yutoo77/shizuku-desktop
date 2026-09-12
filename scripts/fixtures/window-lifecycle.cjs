// This separate test entry point is never included by the production build.
const { app, BrowserWindow, powerMonitor } = require('electron');
const { appendFileSync, writeFileSync, existsSync } = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { setTimeout: delay } = require('node:timers/promises');
assert.equal(process.env.SHIZUKU_TEST, '1');
assert.match(process.env.SHIZUKU_TEST_DATA ?? '', /^window-lifecycle-[A-Za-z0-9_-]+$/);
const directory = path.resolve(__dirname, '../../work', process.env.SHIZUKU_TEST_DATA);
const report = { status: 'running', checks: [], cycles: [], networkAttempts: 0, startedAt: new Date().toISOString() };
let stage = 'startup', interrupted = false, finished = false, poll;
const event = (kind, values = {}) => appendFileSync(path.join(directory, 'events.jsonl'), JSON.stringify({ time: new Date().toISOString(), stage, kind, ...values }) + '\n');
const checkpoint = () => writeFileSync(path.join(directory, 'fixture.json'), JSON.stringify(report, null, 2));
function pids() {
  const processes = app.getAppMetrics().map(item => ({ pid: item.pid, creationTime: item.creationTime }));
  const helper = globalThis.__shizuku?.tracking().pid;
  if (Number.isInteger(helper)) processes.push({ pid: helper, name: 'window-tracker.exe', parentPid: process.pid });
  event('pids', { processes });
}
function observe(win) {
  const id = win.id;
  event('created', { id });
  win.on('close', () => event('close', { id }));
  win.on('closed', () => event('closed', { id }));
  win.on('show', () => event('show', { id }));
  win.webContents.on('did-finish-load', () => event('loaded', { id }));
  win.webContents.on('render-process-gone', (_event, details) => event('renderer-gone', { id, reason: details.reason, code: details.exitCode }));
}
app.on('browser-window-created', (_event, win) => observe(win));
app.on('before-quit', () => event('before-quit'));
app.on('will-quit', () => { event('will-quit'); clearInterval(poll); clearInterval(stopPoll); });
globalThis.fetch = async () => { report.networkAttempts++; throw new Error('Network disabled in standalone lifecycle check'); };
// Windows GUI Electron has no reliable console stdin. Use an owned stop marker.
const stopPoll = setInterval(() => {
  if (!existsSync(path.join(directory, 'stop')) || finished) return;
  interrupted = true; report.status = 'interrupted'; checkpoint();
  if (app.isReady()) app.quit();
}, 250);
require('../../dist/main.cjs');

async function waitFor(predicate, label) {
  const end = Date.now() + 20_000;
  while (Date.now() < end) {
    if (interrupted) throw new Error('Interrupted');
    if (await predicate()) return;
    await delay(20);
  }
  throw new Error(`Timed out: ${label}`);
}
const js = (win, source) => win.webContents.executeJavaScript(source);
async function ready(win) {
  await waitFor(() => win.isVisible() && !win.webContents.isLoading(), 'window visible and loaded');
  assert.equal(win.webContents.debugger.isAttached(), false);
  await waitFor(() => js(win, `!!document.querySelector('#message') && !document.querySelector('#provider').disabled`), 'chat ready');
  pids();
}
async function destroyed(win, contents) {
  await waitFor(() => win.isDestroyed() && contents.isDestroyed(), 'actual window and WebContents destruction');
  assert.equal(__shizuku.dialogueState(), null);
}
async function submit(win, value = 'こんにちは') {
  await js(win, `(() => { const input = document.querySelector('#message'); input.value = ${JSON.stringify(value)};
    input.dispatchEvent(new Event('input', {bubbles:true})); document.querySelector('#send').focus(); document.querySelector('#send').click(); })()`);
}
(async () => {
  try {
    await app.whenReady();
    await waitFor(() => globalThis.__shizuku?.status().modelLoaded, 'selected model');
    assert.equal(app.commandLine.hasSwitch('remote-debugging-port'), false);
    assert.equal(app.commandLine.hasSwitch('remote-debugging-pipe'), false);
    assert.ok(!process.execArgv.some(value => value.startsWith('--inspect')));
    report.versions = { electron: process.versions.electron, chrome: process.versions.chrome };
    poll = setInterval(pids, 500); pids();
    __shizuku.setDialogueAI(undefined);
    __shizuku.setDialogueSpeech(async () => { report.networkAttempts++; throw new Error('Voice disabled'); });
    // Confirm ordinary focus semantics without any emulation command.
    stage = 'focus-and-draft';
    __shizuku.openControls();
    let controls = __shizuku.controls();
    await waitFor(() => controls.isVisible() && !controls.webContents.isLoading(), 'controls');
    controls.focus();
    await waitFor(() => controls.isFocused(), 'controls focused');
    __shizuku.action('call');
    let win = __shizuku.dialogue(); await ready(win);
    assert.equal(controls.isFocused(), true); assert.equal(win.isFocused(), false);
    assert.equal(await js(win, 'document.hasFocus()'), false);
    report.checks.push('Calling keeps the owned controls window focused; chat document is unfocused without CDP.');
    win.focus(); await waitFor(() => js(win, 'document.hasFocus()'), 'chat focused');
    await submit(win);
    await waitFor(() => js(win, `document.querySelector('#message').value === '' && document.activeElement.id === 'message'`), 'caret restored');
    await waitFor(() => __shizuku.dialogueState().messages.length === 2, 'local reply');
    await js(win, `(() => { document.querySelector('#message').value = '残したい下書き'; document.querySelector('#message').dispatchEvent(new Event('input',{bubbles:true}));
      document.querySelector('#options').open = true; document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})); })()`);
    assert.equal(await js(win, `!document.querySelector('#options').open && document.querySelector('#message').value === '残したい下書き'`), true);
    assert.equal(__shizuku.dialogueState().messages.length, 2);
    report.checks.push('DOM send restores caret and synthetic Esc closes settings while preserving draft and history.');
    let contents = win.webContents; __shizuku.closeDialogue(); await destroyed(win, contents);
    const controlsContents = controls.webContents; controls.close();
    await waitFor(() => controls.isDestroyed() && controlsContents.isDestroyed(), 'initial controls destroyed');
    win = contents = controls = null;

    for (let index = 0; index < 20; index++) {
      stage = `overlap-${index + 1}`;
      let held;
      __shizuku.setDialogueReply((_text, { signal }) => new Promise(resolve => { held = { signal, resolve }; }));
      __shizuku.action('call'); win = __shizuku.dialogue(); await ready(win);
      const old = win, oldContents = win.webContents;
      win.focus(); await waitFor(() => js(win, 'document.hasFocus()'), 'pending chat focused');
      await submit(win, '検査用の返答待ち');
      await waitFor(() => held && __shizuku.dialogueState().status === 'pending', 'pending reply');
      __shizuku.openControls(); controls = __shizuku.controls();
      await waitFor(() => controls.isVisible() && !controls.webContents.isLoading(), 'controls ready');
      controls.focus(); await waitFor(() => controls.isFocused() && !win.isFocused(), 'focus moved to controls');
      assert.equal(await js(win, 'document.hasFocus()'), false);
      const oldControls = controls, oldControlsContents = controls.webContents;
      let controlsClosed = false, overlap = false;
      controls.once('closed', () => { controlsClosed = true; });
      old.once('closed', () => { overlap = !controlsClosed; });
      pids();
      controls.close();
      // Intentionally overlap closures, without sleeping or waiting for closed.
      __shizuku.closeDialogue();
      assert.equal(held.signal.aborted, true);
      held.resolve('この古い返事は表示しない'); held = null;
      __shizuku.setDialogueReply(undefined);
      __shizuku.action('call'); win = __shizuku.dialogue(); await ready(win);
      assert.deepEqual(__shizuku.dialogueState().messages, []);
      assert.equal(__shizuku.dialogueState().voice.enabled, false);
      await waitFor(() => old.isDestroyed() && oldContents.isDestroyed() && oldControls.isDestroyed() && oldControlsContents.isDestroyed(), 'both old windows destroyed');
      const record = { number: index + 1, overlap, oldWindowDestroyed: old.isDestroyed(), oldContentsDestroyed: oldContents.isDestroyed(), controlsDestroyed: oldControls.isDestroyed() };
      contents = win.webContents; __shizuku.closeDialogue(); await destroyed(win, contents);
      assert.deepEqual(BrowserWindow.getAllWindows().map(item => item.id), [__shizuku.avatar().id]);
      report.cycles.push(record); checkpoint();
      win = contents = controls = null;
    }
    assert.ok(report.cycles.some(item => item.overlap), 'The intended close overlap must actually occur.');
    report.checks.push('20 control/chat close cycles abort pending replies, destroy old windows and reopen empty with voice off; actual overlap observed.');

    stage = 'simulated-rest';
    __shizuku.action('call'); win = __shizuku.dialogue(); await ready(win); contents = win.webContents;
    powerMonitor.emit('suspend'); await destroyed(win, contents);
    assert.equal(__shizuku.status().visible, false);
    powerMonitor.emit('resume');
    await waitFor(() => __shizuku.status().visible, 'simulated resume');
    assert.equal(__shizuku.dialogueState(), null);
    report.checks.push('Simulated suspend disposes chat; resume restores only avatar. No OS sleep or lock performed.');
    win = contents = null;
    const avatar = __shizuku.avatar();
    const capture = await avatar.webContents.capturePage();
    writeFileSync(path.join(directory, 'avatar.png'), capture.toPNG());
    assert.equal(report.networkAttempts, 0);
    pids(); report.status = 'passed';
  } catch (error) {
    report.status = 'failed'; report.failure = { stage, message: error.message };
    report.appState = globalThis.__shizuku?.status();
    report.windows = BrowserWindow.getAllWindows().map(item => ({ id: item.id, visible: item.isVisible(), loading: item.webContents.isLoading(), focused: item.isFocused() }));
    const ownAvatar = globalThis.__shizuku?.avatar();
    if (ownAvatar && !ownAvatar.isDestroyed()) {
      report.avatarState = { loading: ownAvatar.webContents.isLoading(), visible: ownAvatar.isVisible(),
        rendererPid: ownAvatar.webContents.getOSProcessId() };
      try { report.diagnostics = await js(ownAvatar, 'globalThis.__diagnostics ?? null'); } catch { /* Renderer may have failed. */ }
    }
  } finally {
    report.finishedAt = new Date().toISOString(); checkpoint(); finished = true;
    stage = 'quit'; app.quit();
  }
})();
