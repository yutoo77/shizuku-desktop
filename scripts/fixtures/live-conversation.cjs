// Explicit production-mode check: one real AI response, one local synthesis.
const { app, BrowserWindow, Menu } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const copy = process.env.SHIZUKU_LIVE_ROOT;
assert.ok(copy && path.isAbsolute(copy));
const workspace = path.resolve(__dirname, '../..');
assert.ok(copy.startsWith(path.join(workspace, 'work', 'live-conversation-')) && path.basename(copy) === 'app');
assert.notEqual(process.env.SHIZUKU_TEST, '1');
assert.ok(process.env.OPENAI_API_KEY);
const directory = path.dirname(copy);
const prepareOnly = process.env.SHIZUKU_LIVE_PREPARE_ONLY === '1';
const report = { status: 'running', startedAt: new Date().toISOString(), requests: { openai: 0, query: 0, synthesis: 0, denied: 0 }, http: [], checks: [] };
let stage = 'startup', finished = false, interrupted = false, trayMenu, poll;
const event = (kind, values = {}) => fs.appendFileSync(path.join(directory, 'events.jsonl'), JSON.stringify({ time: new Date().toISOString(), stage, kind, ...values }) + '\n');
const checkpoint = () => fs.writeFileSync(path.join(directory, 'fixture.json'), JSON.stringify(report, null, 2));
const helperIdentities = [];
const originalSpawn = childProcess.spawn;
childProcess.spawn = function(file, args, options) {
  assert.equal(process.env.OPENAI_API_KEY, undefined, 'Main must remove the inherited key before launching helpers.');
  assert.equal(options?.env?.OPENAI_API_KEY, undefined);
  const result = originalSpawn.call(this, file, args, options);
  if (path.basename(file) === 'window-tracker.exe') helperIdentities.push({ pid: result.pid, name: 'window-tracker.exe', parentPid: process.pid });
  return result;
};
const nativeFetch = globalThis.fetch;
globalThis.fetch = async (input, options) => {
  const url = new URL(String(input));
  const kind = url.href === 'https://api.openai.com/v1/responses' ? 'openai'
    : url.origin === 'http://127.0.0.1:50021' && url.pathname === '/audio_query' ? 'query'
    : url.origin === 'http://127.0.0.1:50021' && url.pathname === '/synthesis' ? 'synthesis' : null;
  if (prepareOnly || !kind || options?.method !== 'POST' || report.requests[kind] !== 0) { report.requests.denied++; throw new Error('Unexpected or repeated request denied by live check'); }
  report.requests[kind]++;
  const start = performance.now();
  const response = await nativeFetch(input, options);
  report.http.push({ kind, status: response.status, elapsedMs: Math.round(performance.now() - start) }); checkpoint();
  return response;
};
const buildMenu = Menu.buildFromTemplate;
Menu.buildFromTemplate = function(...args) {
  const menu = buildMenu.apply(this, args);
  if (menu.items.some(item => item.label === '位置を動かす…')) trayMenu = menu;
  return menu;
};
app.on('browser-window-created', (_event, win) => {
  assert.equal(process.env.OPENAI_API_KEY, undefined);
  event('created', { id: win.id });
  win.on('closed', () => event('closed', { id: win.id }));
});
function pids() {
  event('pids', { processes: [...app.getAppMetrics().map(item => ({ pid: item.pid, creationTime: item.creationTime })), ...helperIdentities] });
}
const stopPoll = setInterval(() => {
  if (fs.existsSync(path.join(directory, 'stop')) && !finished) { interrupted = true; if (app.isReady()) app.quit(); }
}, 250);
app.on('before-quit', () => event('before-quit'));
app.on('will-quit', () => { event('will-quit'); clearInterval(stopPoll); clearInterval(poll); });
require(path.join(copy, 'dist/main.cjs'));
const js = (win, source, userGesture = false) => win.webContents.executeJavaScript(source, userGesture);
async function waitFor(predicate, label, timeout = 20_000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) { if (interrupted) throw new Error('Interrupted'); if (await predicate()) return; await delay(40); }
  throw new Error(`Timed out: ${label}`);
}
const windowFor = file => BrowserWindow.getAllWindows().find(win => win.webContents.getURL().endsWith('/' + file));
(async () => {
  try {
    await app.whenReady();
    assert.equal(globalThis.__shizuku, undefined, 'This must use production adapters, not test hooks.');
    assert.equal(app.commandLine.hasSwitch('remote-debugging-port'), false);
    assert.equal(app.commandLine.hasSwitch('remote-debugging-pipe'), false);
    poll = setInterval(pids, 500);
    await waitFor(() => windowFor('index.html'), 'avatar');
    const avatar = windowFor('index.html');
    await waitFor(() => js(avatar, 'globalThis.__diagnostics?.loaded === true'), 'model');
    await js(avatar, `window.__liveMouth = {max:0, renderedMax:0, events:0}; window.companion.onMouth(s => {
      __liveMouth.max = Math.max(__liveMouth.max,s.weight);
      __liveMouth.renderedMax = Math.max(__liveMouth.renderedMax,__diagnostics.mouthWeight);
      __liveMouth.events++; }); void 0;`);
    await waitFor(() => trayMenu, 'tray');
    trayMenu.items.find(item => item.label === '位置を動かす…').click();
    await waitFor(() => windowFor('controls.html'), 'controls');
    const controls = windowFor('controls.html');
    await waitFor(() => js(controls, `!!document.querySelector('#call') && !document.querySelector('#call').disabled`), 'call button');
    await js(controls, `document.querySelector('#call').click()`);
    await waitFor(() => windowFor('dialogue.html'), 'dialogue');
    const chat = windowFor('dialogue.html');
    await waitFor(() => js(chat, `!!document.querySelector('#provider') && !document.querySelector('#provider').disabled`), 'dialogue ready');
    const state = () => js(chat, 'window.dialogue.getState()');
    const first = await state();
    assert.equal(first.provider, 'local-demo'); assert.equal(first.voice.enabled, false); assert.deepEqual(first.messages, []);
    assert.equal(first.connection.available, true);
    await js(chat, `(() => {
      window.__liveAudio = {starts:0, ended:0, contextStates:[]};
      const NativeContext = window.AudioContext;
      window.AudioContext = class extends NativeContext {
        constructor(...args) { super(...args); const index = __liveAudio.contextStates.length;
          __liveAudio.contextStates.push(this.state); this.addEventListener('statechange', () => { __liveAudio.contextStates[index] = this.state; }); }
        createBufferSource() { const source = super.createBufferSource(), start = source.start.bind(source);
          source.start = (...args) => { const result = start(...args); __liveAudio.starts++; return result; };
          source.addEventListener('ended', () => { __liveAudio.ended++; }, {once:true}); return source; }
      };
      document.querySelector('#options').open = true;
      const provider = document.querySelector('#provider'); provider.value = 'openai'; provider.dispatchEvent(new Event('change',{bubbles:true}));
    })()`);
    await waitFor(async () => (await state()).provider === 'openai', 'explicit OpenAI selection');
    await waitFor(() => js(chat, `!document.querySelector('#voice').disabled`), 'voice ready');
    await js(chat, `document.querySelector('#voice').click()`, true);
    await waitFor(async () => (await state()).voice.enabled, 'explicit voice enabled');
    await js(chat, `document.querySelector('#options').open = false`);
    if (prepareOnly) {
      assert.deepEqual(report.requests, { openai: 0, query: 0, synthesis: 0, denied: 0 });
      report.checks.push('Production UI reaches explicit AI/voice selection with no AI or synthesis request; no response or playback is claimed.');
      pids(); report.status = 'passed'; return;
    }
    stage = 'single-live-send';
    await js(chat, `(() => { const input = document.querySelector('#message'); input.value = '接続の確認です。「こんにちは、ふぁるるくん。」を含む短い挨拶を一文だけ返してください。'; input.dispatchEvent(new Event('input',{bubbles:true})); })()`);
    await waitFor(() => js(chat, `!document.querySelector('#send').disabled`), 'send enabled');
    await js(chat, `document.querySelector('#send').click()`, true);
    await waitFor(async () => { const s = await state(); if (s.status === 'error' || s.voice.status === 'error') throw new Error('Production provider reported an error'); return s.status === 'idle' && s.messages.length === 2; }, 'real AI reply', 40_000);
    report.replyText = (await state()).messages.at(-1).text;
    assert.match(report.replyText, /こんにちは/);
    await waitFor(async () => { const s = await state(); if (s.voice.status === 'error') throw new Error('VOICEVOX reported an error'); return (await js(chat, '__liveAudio.starts')) === 1; }, 'actual WebAudio playback', 35_000);
    await waitFor(() => js(avatar, '__liveMouth.max > 0 && __liveMouth.renderedMax > 0'), 'positive rendered mouth movement');
    report.playback = await js(chat, '({...__liveAudio})');
    report.mouth = await js(avatar, '({...__liveMouth})');
    fs.writeFileSync(path.join(directory, 'conversation.png'), (await chat.webContents.capturePage()).toPNG());
    fs.writeFileSync(path.join(directory, 'avatar.png'), (await avatar.webContents.capturePage()).toPNG());
    await waitFor(async () => (await state()).voice.status === 'idle', 'speech ended', 30_000);
    await waitFor(() => js(avatar, '__diagnostics.mouthWeight === 0'), 'mouth neutral');
    assert.equal(chat.webContents.isAudioMuted(), true);
    await waitFor(() => js(chat, '__liveAudio.contextStates.every(value => value === "closed")'), 'audio contexts released');
    report.playbackAfter = await js(chat, '({...__liveAudio})');
    report.checks.push('One real OpenAI response reaches the real local VOICEVOX adapter, actual WebAudio start and positive avatar mouth movement, then idle/muted/closed audio contexts.');
    const contents = chat.webContents; pids();
    await js(chat, `document.querySelector('#close').click()`);
    await waitFor(() => chat.isDestroyed() && contents.isDestroyed(), 'chat destroyed');
    await js(controls, `document.querySelector('#call').click()`);
    await waitFor(() => windowFor('dialogue.html'), 'reopened chat');
    const fresh = windowFor('dialogue.html');
    await waitFor(() => js(fresh, `!!document.querySelector('#provider') && !document.querySelector('#provider').disabled`), 'fresh state');
    const reset = await js(fresh, 'window.dialogue.getState()');
    assert.equal(reset.provider, 'local-demo'); assert.equal(reset.voice.enabled, false); assert.deepEqual(reset.messages, []);
    assert.deepEqual(report.requests, { openai: 1, query: 1, synthesis: 1, denied: 0 });
    report.checks.push('Reopening restores empty local demo with voice off and sends no further request.');
    pids(); report.status = 'passed';
  } catch (error) { report.status = 'failed'; report.failure = { stage, message: error.message }; }
  finally { report.finishedAt = new Date().toISOString(); checkpoint(); finished = true; stage = 'quit'; app.quit(); }
})();
