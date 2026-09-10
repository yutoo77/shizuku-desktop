// Real Electron/WebAudio with held, synthetic speech. No live provider, HTTP,
// microphone, native input, OS sleep, or listening-quality claim is involved.
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
assert.ok(typeof config.modelPath === 'string' && config.modelPath, 'Select a local VRM before running voice acceptance.');
await mkdir(path.join(root, 'work'), { recursive: true });
const directory = await mkdtemp(path.join(root, 'work', 'voice-dialogue-'));
await writeFile(path.join(directory, 'local.config.json'), JSON.stringify({ modelPath: config.modelPath, quiet: true }));
const checks = [], pids = new Set(), playbackEvidence = [];
let app, avatar, chat, failure;
const main = fn => app.evaluate(fn);
const state = () => main(() => __shizuku.dialogueState());
const count = () => main(() => voiceFixture.calls.length);
const pass = message => { checks.push(message); console.log(JSON.stringify({ passed: checks.length, check: message })); };
async function waitFor(predicate, label, timeout = 8000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await predicate()) return; await delay(50); }
  throw new Error(label);
}
async function recordPids() {
  pids.add(app.process().pid);
  for (const process of await main(({ app }) => app.getAppMetrics())) pids.add(process.pid);
  const helper = await main(() => __shizuku.tracking().pid);
  if (Number.isInteger(helper) && helper > 0) pids.add(helper);
}
async function probePlayback() {
  await chat.evaluate(() => {
    if (window.__voiceProbe) return;
    const NativeContext = window.AudioContext;
    const probe = window.__voiceProbe = { contexts: [], starts: 0, stops: 0, ended: 0 };
    window.AudioContext = class extends NativeContext {
      constructor(...args) { super(...args); probe.contexts.push(this); }
      createBufferSource() {
        const source = super.createBufferSource();
        const start = source.start.bind(source), stop = source.stop.bind(source);
        source.start = (...args) => { const result = start(...args); probe.starts++; return result; };
        source.stop = (...args) => { const result = stop(...args); probe.stops++; return result; };
        source.addEventListener('ended', () => { probe.ended++; }, { once: true });
        return source;
      }
    };
  });
}
async function probeState() {
  return chat.evaluate(() => ({
    starts: __voiceProbe.starts, stops: __voiceProbe.stops, ended: __voiceProbe.ended,
    contexts: __voiceProbe.contexts.map(context => context.state),
  }));
}
async function open() {
  await main(() => __shizuku.closeDialogue());
  const previous = await count();
  const opened = app.waitForEvent('window');
  await main(() => __shizuku.action('call'));
  chat = await opened;
  chat.setDefaultTimeout(7000);
  await chat.waitForSelector('#message');
  await chat.waitForFunction(() => !document.querySelector('#voice').disabled);
  await waitFor(() => main(() => !!__shizuku.dialogue()?.isVisible()), 'Chat visible');
  await probePlayback();
  const snapshot = await state();
  assert.equal(snapshot.provider, 'local-demo');
  assert.equal(snapshot.voice.enabled, false);
  assert.equal(snapshot.voice.status, 'idle');
  assert.deepEqual(snapshot.messages, []);
  assert.equal(await count(), previous);
  await recordPids();
}
async function options(opened) {
  if (await chat.locator('#options').evaluate(element => element.open) !== opened) await chat.locator('#options summary').click();
}
async function enable(value = true) {
  await options(true);
  await chat.locator('#voice').setChecked(value);
  await waitFor(async () => (await state()).voice.enabled === value, 'Voice selection acknowledged');
  await chat.waitForFunction(() => !document.querySelector('#voice').disabled);
  await options(false);
}
async function send(text) {
  await chat.locator('#message').fill(text);
  await chat.locator('#send').click();
  await waitFor(async () => (await state()).messages.at(-1)?.role === 'assistant', 'Text reply completed');
}
async function held(label = 'テスト用：短く話して。') {
  if (!(await state()).voice.enabled) await enable();
  const index = await count();
  await send(label);
  await waitFor(async () => await count() === index + 1, 'One completed assistant reply starts one synthesis');
  assert.equal((await state()).voice.status, 'synthesizing');
  assert.equal(await main(() => voiceFixture.calls.at(-1).text), '【音声確認用の固定応答】うん、ここにいるよ。');
  return index;
}
async function resolve(index, duration = 10) {
  await app.evaluate((_electron, value) => voiceFixture.calls[value.index].resolve(voiceFixture.packet(value.duration)), { index, duration });
}
async function playing(duration = 10) {
  const before = (await probeState()).starts;
  const index = await held();
  await resolve(index, duration);
  await waitFor(async () => (await state()).voice.status === 'playing', 'Real WebAudio reports playing');
  await waitFor(async () => (await probeState()).starts === before + 1, 'Actual AudioBufferSourceNode.start was called once');
  await avatar.waitForFunction(() => window.__diagnostics.mouthWeight > 0);
  return index;
}
async function neutral() {
  await avatar.waitForFunction(() => window.__diagnostics.mouthWeight === 0 && window.__diagnostics.mouthVowel === null);
  const mouths = await avatar.evaluate(() => window.__diagnostics.mouthWeights);
  assert.ok(Object.values(mouths).every(value => value === 0));
}
async function stopped() {
  await waitFor(async () => ['idle', 'error'].includes((await state()).voice.status), 'Voice stopped');
  await neutral();
  await waitFor(async () => (await probeState()).contexts.every(value => value === 'closed'), 'All playback AudioContexts closed');
  assert.equal(await main(() => __shizuku.dialogue().webContents.isAudioMuted()), true);
}
async function aborted(index) {
  assert.equal(await app.evaluate((_electron, index) => voiceFixture.calls[index].signal.aborted, index), true);
}
async function noReplay(index) {
  const before = (await probeState()).starts;
  await resolve(index);
  await delay(150);
  assert.equal((await probeState()).starts, before, 'A delayed result must not start another source');
}
async function holdPreparation() {
  await chat.evaluate(() => {
    window.__heldResume = [];
    AudioContext.prototype.resume = function() {
      return new Promise((resolve, reject) => __heldResume.push({ resolve, reject }));
    };
  });
  await enable();
  const before = await main(() => ({ replies: voiceFixture.replyCalls, speech: voiceFixture.calls.length }));
  await chat.locator('#message').fill('音声の準備中にはまだ送信しない。');
  await chat.locator('#send').click();
  await chat.waitForFunction(() => __heldResume.length === 1);
  return before;
}
async function unchangedRequests(before) {
  await delay(120);
  assert.deepEqual(await main(() => ({ replies: voiceFixture.replyCalls, speech: voiceFixture.calls.length })), before);
}

try {
  const env = { ...process.env, SHIZUKU_TEST: '1', SHIZUKU_TEST_DATA: path.basename(directory), SHIZUKU_METRICS: '0' };
  delete env.OPENAI_API_KEY;
  app = await _electron.launch({ executablePath: electron, args: [root], cwd: root, env });
  avatar = await app.firstWindow();
  avatar.setDefaultTimeout(15000);
  await avatar.waitForFunction(() => window.__diagnostics?.loaded);
  await main(() => {
    globalThis.voiceFixture = { calls: [], replyCalls: 0, networkAttempts: 0, aborted: 0 };
    globalThis.fetch = async () => { voiceFixture.networkAttempts++; throw new Error('No network in voice acceptance'); };
    voiceFixture.packet = duration => {
      const rate = 24000, samples = Math.round(rate * duration), bytes = new ArrayBuffer(44 + samples * 2), view = new DataView(bytes);
      const ascii = (offset, text) => { for (let index = 0; index < text.length; index++) view.setUint8(offset + index, text.charCodeAt(index)); };
      ascii(0, 'RIFF'); view.setUint32(4, 36 + samples * 2, true); ascii(8, 'WAVE'); ascii(12, 'fmt ');
      view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
      view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
      ascii(36, 'data'); view.setUint32(40, samples * 2, true);
      for (let index = 0; index < samples; index++) {
        const ramp = Math.min(1, index / 240, (samples - 1 - index) / 240);
        view.setInt16(44 + index * 2, Math.round(Math.sin(index / rate * Math.PI * 440) * 0.025 * ramp * 32767), true);
      }
      return { audio: bytes, duration, cues: [{ start: 0, end: duration, vowel: 'aa' }] };
    };
    const reply = async () => { voiceFixture.replyCalls++; return '【音声確認用の固定応答】うん、ここにいるよ。'; };
    __shizuku.setDialogueReply(reply);
    __shizuku.setDialogueAI({ available: true, model: 'fixture', reply });
    __shizuku.setDialogueSpeech((text, { signal }) => new Promise((resolve, reject) => {
      voiceFixture.calls.push({ text, signal, resolve, reject });
      signal.addEventListener('abort', () => { voiceFixture.aborted++; }, { once: true });
    }));
  });
  await open();
  await send('この返答は読み上げない。');
  assert.equal(await count(), 0);
  await enable();
  await delay(120);
  assert.equal(await count(), 0);
  assert.equal((await probeState()).starts, 0);
  await options(true);
  assert.match(await chat.locator('#options').innerText(), /VOICEVOX:冥鳴ひまり/u);
  await options(false);
  assert.equal(await main(() => voiceFixture.networkAttempts), 0);
  pass('Voice defaults off. Text replies and enabling voice make no synthesis or network call, and enabling does not replay the existing reply; the setting displays its voice credit.');

  const denied = await main(async ({ ipcMain }) => {
    const sender = __shizuku.avatar().webContents, event = { sender, senderFrame: sender.mainFrame };
    const results = [];
    for (const [channel, ...args] of [['dialogue:voice', true], ['dialogue:voice-stop'], ['dialogue:voice-state', 1, 'playing'], ['dialogue:mouth', 1, 'aa', 1]]) {
      try { await ipcMain._invokeHandlers.get(channel)(event, ...args); results.push(false); }
      catch (error) { results.push(error.message === 'Denied sender'); }
    }
    return results;
  });
  assert.deepEqual(denied, [true, true, true, true]);
  assert.equal(await avatar.evaluate(() => typeof window.dialogue), 'undefined');
  assert.equal(await chat.evaluate(async () => { try { await fetch('http://127.0.0.1:50021/version'); return false; } catch { return true; } }), true);
  assert.equal(await chat.evaluate(() => window.dialogue.setVoice('yes')), false);
  assert.equal(await chat.evaluate(() => window.dialogue.reportVoice(999999, 'playing')), false);
  assert.equal(await chat.evaluate(() => window.dialogue.mouth(999999, 'aa', 1)), false);
  pass('Actual avatar sender is rejected by all four voice IPC handlers. Renderer localhost fetch, forged voice values and stale playback IDs cannot reach speech or mouth control.');

  await playing(1.1);
  const mouth = await avatar.evaluate(() => ({ weight: __diagnostics.mouthWeight, vowel: __diagnostics.mouthVowel, quiet: __diagnostics.quiet, animating: __diagnostics.animating }));
  assert.equal(mouth.quiet, true); assert.equal(mouth.animating, false); assert.equal(mouth.vowel, 'aa'); assert.ok(mouth.weight > 0);
  playbackEvidence.push({ phase: 'playing', mouth, playback: await probeState() });
  await chat.screenshot({ path: path.join(directory, 'fixture-speaking.png') });
  await stopped();
  await avatar.waitForFunction(() => !window.__diagnostics.reacting);
  await delay(80);
  const frames = await avatar.evaluate(() => __diagnostics.renderedFrames);
  await delay(350);
  assert.equal(await avatar.evaluate(() => __diagnostics.renderedFrames), frames, 'Quiet avatar returns to no repeating render work');
  playbackEvidence.push({ phase: 'ended', playback: await probeState() });
  pass('A completed assistant reply produces one real decoded WebAudio source and positive VRM mouth weight. Natural end closes the context, mutes the chat and resets every mouth weight; quiet mode returns to no repeating frames.');

  const stale = await held('中止する音声。');
  await chat.locator('#cancel').click(); await stopped(); await aborted(stale);
  const current = await held('新しい音声。');
  await noReplay(stale);
  assert.equal((await state()).voice.status, 'synthesizing');
  await resolve(current);
  await waitFor(async () => (await state()).voice.status === 'playing', 'Newer speech survives old result');
  await chat.locator('#cancel').click(); await stopped();
  const countAfterCancel = await count();
  await chat.evaluate(() => window.dialogue.cancel()); await delay(100);
  assert.equal(await count(), countAfterCancel, 'Cancelling an idle completed turn cannot replay its assistant');
  pass('Cancelling held synthesis aborts its signal. A late result cannot start audio or replace newer synthesis; cancelling active playback stops it, and repeated cancel never rereads the completed assistant.');

  await playing();
  const activeId = (await state()).voice.id;
  const invalid = await chat.evaluate(async id => [
    await window.dialogue.reportVoice(id - 1, 'ended'),
    await window.dialogue.reportVoice(id, 'forged'),
    await window.dialogue.mouth(id, 'happy', 1),
    await window.dialogue.mouth(id, 'aa', NaN),
    await window.dialogue.mouth(id, 'aa', 2),
  ], activeId);
  assert.deepEqual(invalid, [false, false, false, false, false]);
  assert.equal((await state()).voice.status, 'playing');
  await enable(false); await stopped();
  assert.equal((await state()).voice.enabled, false);
  await enable(); await delay(120);
  assert.equal((await state()).voice.status, 'idle');
  pass('During real playback stale IDs, forged state/vowel and nonfinite/out-of-range weights are rejected. Voice OFF closes audio and neutralizes the mouth; turning it on again does not replay.');

  await playing();
  await options(true); await chat.locator('#provider').selectOption('openai');
  await waitFor(async () => (await state()).provider === 'openai', 'Provider switched');
  await stopped(); assert.deepEqual((await state()).messages, []); await options(false);
  const afterSwitch = await count(); await delay(120); assert.equal(await count(), afterSwitch);
  await playing();
  await options(true); await chat.locator('#clear').click(); await stopped();
  assert.deepEqual((await state()).messages, []);
  pass('Provider switch and clear during real playback both stop audio and reset the mouth; their cleared histories do not trigger synthesis.');

  await playing();
  const previousSource = (await probeState()).starts;
  const next = await held('再生中に次の文を送る。');
  assert.equal((await state()).voice.status, 'synthesizing');
  assert.equal((await probeState()).starts, previousSource);
  await neutral();
  await chat.locator('#cancel').click(); await stopped(); await aborted(next);
  pass('Submitting the next turn during playback stops the prior source and mouth before the new held synthesis; cancelling then stops the new request too.');

  const hidden = await held('非表示前の合成。');
  await main(() => __shizuku.action('hide'));
  await waitFor(() => main(() => !__shizuku.dialogue()), 'Hide disposes dialogue');
  await aborted(hidden); await neutral();
  await main(() => __shizuku.action('show'));
  assert.equal(await main(() => !!__shizuku.dialogue()), false);
  await open(); await noReplay(hidden);
  await playing();
  await chat.locator('#close').click();
  await waitFor(() => main(() => !__shizuku.dialogue()), 'Close disposes dialogue');
  await neutral(); await open();
  pass('Explicit hide aborts held speech and showing never reopens the chat. Closing during playback resets the mouth; each reopened chat is empty with voice off and ignores old results.');

  const resting = await held('休止前の合成。');
  await main(({ powerMonitor }) => powerMonitor.emit('suspend'));
  await waitFor(() => main(() => !__shizuku.dialogue()), 'Simulated suspend disposes dialogue');
  await aborted(resting); await neutral();
  await main(({ powerMonitor }) => powerMonitor.emit('resume'));
  assert.equal(await main(() => !!__shizuku.dialogue()), false);
  await open(); await noReplay(resting);
  pass('Simulated Electron suspend aborts synthesis and neutralizes the mouth; resume never reopens or replays dialogue. Actual OS sleep was not performed.');

  const reloaded = await held('再読込前の合成。');
  await chat.reload(); await chat.waitForSelector('#voice', { state: 'attached' });
  await probePlayback(); await aborted(reloaded); await stopped();
  assert.equal((await state()).voice.enabled, false); await noReplay(reloaded);
  await playing();
  await avatar.reload();
  await avatar.waitForFunction(() => window.__diagnostics?.loaded);
  await stopped(); assert.equal((await state()).voice.enabled, false);
  pass('Chat reload aborts pending synthesis and clears its enabled flag. Avatar renderer reload stops real playback, closes audio and resets mouth; neither reload replays speech.');

  await playing();
  await avatar.evaluate(() => {
    const gl = document.querySelector('canvas').getContext('webgl2');
    window.__voiceContextExtension = gl.getExtension('WEBGL_lose_context');
    if (!window.__voiceContextExtension) throw new Error('WEBGL_lose_context unavailable');
    window.__voiceContextExtension.loseContext();
  });
  await avatar.waitForFunction(() => __diagnostics.contextLost);
  await stopped(); assert.equal((await state()).voice.enabled, false);
  await avatar.evaluate(() => __voiceContextExtension.restoreContext());
  await avatar.waitForFunction(() => !__diagnostics.contextLost && __diagnostics.loaded);
  await delay(150); await neutral();
  assert.equal((await state()).voice.status, 'idle');
  pass('App-local WebGL context loss stops playback and turns voice off. GPU-context restoration keeps the mouth neutral and never replays speech; no OS/GPU reset was used.');

  await playing();
  await main(() => __shizuku.avatar().webContents.emit('unresponsive'));
  await stopped(); assert.equal((await state()).voice.enabled, false);
  const unresponsiveCount = await count(); await delay(150); assert.equal(await count(), unresponsiveCount);
  pass('A simulated avatar unresponsive event stops the independent chat playback and turns voice off without retry. The renderer was not physically stalled.');

  const failed = await held('音声エラーの確認。');
  await app.evaluate((_electron, index) => voiceFixture.calls[index].reject(new Error('fixture-private-engine-response')), failed);
  await waitFor(async () => (await state()).voice.status === 'error', 'Safe voice error displayed');
  await stopped();
  assert.match(await chat.locator('#messages').innerText(), /音声確認用の固定応答/u);
  assert.doesNotMatch(await chat.locator('#error').innerText(), /fixture-private-engine-response/u);
  assert.match(await chat.locator('#error').innerText(), /VOICEVOX/u);
  const errorCount = await count(); await delay(150); assert.equal(await count(), errorCount);
  pass('Synthesis failure leaves the completed text visible, shows a fixed recovery message, hides engine details and makes no automatic retry.');

  await open();
  const cancelPreparation = await holdPreparation();
  await chat.locator('#cancel').click();
  await chat.evaluate(() => __heldResume[0].resolve());
  await unchangedRequests(cancelPreparation); await stopped();
  assert.deepEqual((await state()).messages, []);
  assert.match(await chat.locator('#message').inputValue(), /準備中/u);
  pass('Cancel during a held AudioContext.resume closes the context before any text/provider or synthesis request. A late resume resolution cannot send the retained draft.');

  await open();
  const closePreparation = await holdPreparation();
  await chat.locator('#close').click();
  await waitFor(() => main(() => !__shizuku.dialogue()), 'Close during pre-send audio preparation');
  await unchangedRequests(closePreparation); await open();
  assert.deepEqual((await state()).messages, []);
  pass('Closing while audio preparation is unresolved dispatches neither a text/provider request nor synthesis; reopening remains empty with voice off.');

  await open();
  await main(({ ipcMain }) => {
    const original = ipcMain._invokeHandlers.get('dialogue:voice');
    voiceFixture.voiceGate = null;
    ipcMain._invokeHandlers.set('dialogue:voice', async (event, enabled) => {
      const result = await original(event, enabled);
      if (enabled === false) {
        ipcMain._invokeHandlers.set('dialogue:voice', original);
        await new Promise(resolve => { voiceFixture.voiceGate = resolve; });
      }
      return result;
    });
  });
  const failedPreparation = await holdPreparation();
  await chat.evaluate(() => __heldResume[0].reject(new Error('private-device-detail')));
  await waitFor(() => main(() => !!voiceFixture.voiceGate), 'Failed prepare reaches held voice-disable acknowledgement');
  await chat.locator('#cancel').click();
  await main(() => { voiceFixture.voiceGate(); voiceFixture.voiceGate = null; });
  await unchangedRequests(failedPreparation); await stopped();
  assert.deepEqual((await state()).messages, []);
  await chat.locator('#message').fill('中止後の新しい下書き。');
  assert.equal(await chat.locator('#error').innerText(), '', 'A cancelled preparation cannot install its fallback warning in a newer render');
  pass('Cancel during the delayed voice-disable acknowledgement after preparation failure prevents the later text-send continuation, preserves an empty session and cannot replace a newer render with stale fallback/device errors.');

  await open();
  await chat.evaluate(() => { AudioContext.prototype.resume = async () => { throw new Error('private-device-detail'); }; });
  await enable();
  const beforeFallback = await main(() => ({ replies: voiceFixture.replyCalls, speech: voiceFixture.calls.length }));
  await send('音声が使えない場合の文字での返答。');
  assert.equal((await state()).voice.enabled, false);
  assert.deepEqual(await main(() => ({ replies: voiceFixture.replyCalls, speech: voiceFixture.calls.length })), { replies: beforeFallback.replies + 1, speech: beforeFallback.speech });
  assert.match(await chat.locator('#messages').innerText(), /音声確認用の固定応答/u);
  assert.doesNotMatch(await chat.locator('#error').innerText(), /private-device-detail/u);
  await stopped();
  pass('Without interruption, audio preparation failure disables voice and allows exactly one requested text reply with no synthesis; its device details stay private.');

  await open();
  const quitting = await held('終了前の合成。');
  await recordPids();
  const appProcess = app.process();
  const quitEvidence = await main(() => {
    __shizuku.action('quit');
    return { lastSpeechAborted: voiceFixture.calls.at(-1).signal.aborted, networkAttempts: voiceFixture.networkAttempts, dialogueDisposed: !__shizuku.dialogue() };
  });
  await waitFor(() => appProcess.exitCode !== null, 'Normal exit');
  assert.equal(appProcess.exitCode, 0); app = null;
  assert.deepEqual(quitEvidence, { lastSpeechAborted: true, networkAttempts: 0, dialogueDisposed: true });
  await writeFile(path.join(directory, 'quit-abort.json'), JSON.stringify({ ...quitEvidence, speechIndex: quitting }, null, 2));
  const saved = JSON.parse(await readFile(path.join(directory, 'local.config.json'), 'utf8'));
  assert.deepEqual(Object.keys(saved).sort(), ['bounds', 'facing', 'favorite', 'modelPath', 'posture', 'quiet', 'scale']);
  pass('Normal exit aborts pending speech, disposes dialogue and exits successfully. No main network call occurred and saved settings contain no speech, provider, conversation or audio fields.');
} catch (error) { failure = error; }
finally {
  if (app) { await recordPids().catch(() => {}); await app.close().catch(() => {}); }
  let remainingPids = [];
  for (let index = 0; index < 40; index++) {
    remainingPids = [...pids].filter(pid => { try { process.kill(pid, 0); return true; } catch { return false; } });
    if (!remainingPids.length) break;
    await delay(100);
  }
  const settingsUnchanged = (await readFile(normal)).equals(before);
  if (remainingPids.length || !settingsUnchanged) failure ??= new Error('Cleanup/settings invariant failed');
  const result = { status: failure ? 'failed' : 'passed', checks, playbackEvidence, remainingPids, settingsUnchanged,
    scope: 'Real Electron and WebAudio source/mouth acceptance with held synthetic PCM tones and fixed text replies. No HTTP, live AI, VOICEVOX synthesis, native input, actual OS sleep or perceptual speech-quality claim.', error: failure?.stack };
  await writeFile(path.join(directory, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ directory, status: result.status, checks: checks.length, remainingPids, settingsUnchanged, error: failure?.message }, null, 2));
}
if (failure) throw failure;
