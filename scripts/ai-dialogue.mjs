// Real Electron windows with injected, held replies. This is API-driven UI and
// sender-admission acceptance, not native keyboard/focus or live-provider testing.
// A fake key replaces any real key before launch; no external API is called.
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
const directory = await mkdtemp(path.join(root, 'work', 'ai-dialogue-'));
await writeFile(path.join(directory, 'local.config.json'), JSON.stringify({ modelPath: config.modelPath, quiet: true }));
const checks = [], layouts = [], pids = new Set();
const fakeKey = 'shizuku-acceptance-not-a-real-key';
let app, avatar, chat, failure;
const main = fn => app.evaluate(fn);
const state = () => main(() => __shizuku.dialogueState());
const callCount = () => main(() => aiFixture.calls.length);
async function waitFor(predicate, label) {
  const end = Date.now() + 7000;
  while (Date.now() < end) { if (await predicate()) return; await delay(50); }
  throw new Error(label);
}
async function recordPids() {
  pids.add(app.process().pid);
  for (const process of await main(({ app }) => app.getAppMetrics())) pids.add(process.pid);
  const helper = await main(() => __shizuku.tracking().pid);
  if (Number.isInteger(helper) && helper > 0) pids.add(helper);
}
async function open(available = true) {
  await main(() => __shizuku.closeDialogue());
  await app.evaluate((_electron, enabled) => {
    __shizuku.setDialogueReply(undefined);
    __shizuku.setDialogueAI(enabled ? {
      available: true, model: 'fixture',
      reply: (text, { signal, history }) => new Promise((resolve, reject) => {
        globalThis.aiFixture.calls.push({ text, signal, history, resolve, reject });
        signal.addEventListener('abort', () => { globalThis.aiFixture.aborted++; }, { once: true });
      }),
    } : undefined);
  }, available);
  const count = await callCount();
  const opened = app.waitForEvent('window');
  await main(() => __shizuku.action('call'));
  chat = await opened;
  chat.setDefaultTimeout(6000);
  await chat.waitForSelector('#message');
  await chat.waitForFunction(() => !document.querySelector('#provider').disabled);
  await waitFor(() => main(() => !!__shizuku.dialogue()?.isVisible()), 'Chat becomes visible');
  assert.equal((await state()).provider, 'local-demo');
  assert.deepEqual((await state()).messages, []);
  assert.equal(await chat.locator('#message').inputValue(), '');
  assert.equal(await callCount(), count);
  await recordPids();
}
async function options(opened) {
  if (await chat.locator('#options').evaluate(element => element.open) !== opened) {
    await chat.locator('#options summary').click();
  }
}
async function selectProvider(value) {
  await options(true);
  await chat.locator('#provider').selectOption(value);
  await waitFor(async () => (await state()).provider === value, 'Selected provider reaches main');
  await chat.waitForFunction(() => !document.querySelector('#provider').disabled);
  await options(false);
}
async function send(text) {
  const index = await callCount();
  await chat.locator('#message').fill(text);
  await chat.locator('#send').click();
  await waitFor(async () => await callCount() === index + 1, 'Exactly one fixture request starts');
  assert.equal((await state()).status, 'pending');
  return index;
}
async function resolve(index, text) {
  await app.evaluate((_electron, value) => aiFixture.calls[value.index].resolve(value.text), { index, text });
  await waitFor(async () => (await state()).status === 'idle', 'Fixture answer completes');
}
async function history(index) {
  return app.evaluate((_electron, position) => aiFixture.calls[position].history.map(({ role, text }) => ({ role, text })), index);
}
async function assertAborted(index) {
  assert.equal(await app.evaluate((_electron, position) => aiFixture.calls[position].signal.aborted, index), true);
}
async function checkLayout(width, height) {
  await app.evaluate((_electron, size) => __shizuku.dialogue().setSize(size.width, size.height), { width, height });
  await options(true);
  await delay(120);
  const layout = await chat.evaluate(() => {
    const rectangle = element => {
      const { left, top, right, bottom } = element.getBoundingClientRect();
      return { left, top, right, bottom };
    };
    const panel = document.querySelector('.options-panel');
    return {
      width: innerWidth, height: innerHeight,
      panel: rectangle(panel), send: rectangle(document.querySelector('#send')),
      pageScrollWidth: document.documentElement.scrollWidth,
      panelScrollWidth: panel.scrollWidth, panelClientWidth: panel.clientWidth,
    };
  });
  for (const rect of [layout.panel, layout.send]) {
    assert.ok(rect.left >= 0 && rect.top >= 0 && rect.right <= layout.width + 1 && rect.bottom <= layout.height + 1,
      `Controls stay within the ${width}x${height} window`);
  }
  assert.ok(layout.pageScrollWidth <= layout.width);
  assert.ok(layout.panelScrollWidth <= layout.panelClientWidth + 1);
  await chat.locator('#clear').scrollIntoViewIfNeeded();
  assert.equal(await chat.locator('#clear').isVisible(), true);
  await chat.locator('.options-panel').evaluate(element => { element.scrollTop = 0; });
  await chat.screenshot({ path: path.join(directory, `fixture-options-${width}x${height}.png`) });
  layouts.push({ window: { width, height }, ...layout });
  await options(false);
}

try {
  const env = { ...process.env, SHIZUKU_TEST: '1', SHIZUKU_TEST_DATA: path.basename(directory) };
  delete env.OPENAI_API_KEY;
  env.OPENAI_API_KEY = fakeKey;
  app = await _electron.launch({ executablePath: electron, args: [root], cwd: root, env });
  avatar = await app.firstWindow();
  await avatar.waitForFunction(() => window.__diagnostics?.loaded);
  assert.equal(await main(() => process.env.OPENAI_API_KEY === undefined), true);
  assert.equal(await main(() => !!__shizuku.dialogue()), false);
  await main(() => {
    globalThis.aiFixture = { calls: [], aborted: 0, networkAttempts: 0 };
    globalThis.fetch = async () => {
      aiFixture.networkAttempts++;
      throw new Error('Network is disabled in this acceptance fixture');
    };
  });
  await open(false);
  assert.equal((await state()).connection.available, false);
  assert.equal(await chat.locator('#openai-option').isDisabled(), true);
  assert.equal(await chat.evaluate(() => window.dialogue.setProvider('openai')), false);
  assert.equal(await chat.evaluate(() => window.dialogue.setProvider('forged-provider')), false);
  assert.equal((await state()).provider, 'local-demo');
  checks.push('Launch uses no real key; main removes the fake environment key. A new chat defaults to local; unavailable AI and forged provider selections are rejected.');

  const rejected = await main(async ({ ipcMain }) => {
    // Exercise registered admission guards with actual Electron sender/frame
    // identities. The avatar bridge intentionally exposes no dialogue channel.
    const sender = __shizuku.avatar().webContents;
    const event = { sender, senderFrame: sender.mainFrame };
    const outcomes = [];
    for (const [channel, argument] of [['dialogue:state'], ['dialogue:provider', 'openai'], ['dialogue:send', 'unauthorized fixture']]) {
      try { await ipcMain._invokeHandlers.get(channel)(event, argument); outcomes.push(false); }
      catch (error) { outcomes.push(error.message === 'Denied sender'); }
    }
    return outcomes;
  });
  assert.deepEqual(rejected, [true, true, true]);
  assert.equal(await avatar.evaluate(() => typeof window.dialogue), 'undefined');
  checks.push('Registered dialogue state/provider/send handlers reject the actual avatar sender (API sender-admission test); the avatar has no dialogue bridge.');

  await open();
  const bridge = await chat.evaluate(async () => ({
    keys: Object.keys(window.dialogue).sort(),
    state: await window.dialogue.getState(),
    require: typeof window.require, process: typeof window.process,
    companion: typeof window.companion, ownTestHook: typeof window.__shizuku,
    text: document.body.textContent,
  }));
  assert.deepEqual(bridge.keys, ['cancel', 'clear', 'close', 'getState', 'onChanged', 'send', 'setProvider']);
  for (const key of ['require', 'process', 'companion', 'ownTestHook']) assert.equal(bridge[key], 'undefined');
  assert.ok(!JSON.stringify(bridge).includes(fakeKey));
  assert.deepEqual(Object.keys(bridge.state.connection).sort(), ['available', 'contextCharacters', 'historyTurns', 'maxOutputTokens', 'model']);
  assert.equal(await chat.evaluate(async () => { try { await fetch('https://example.com'); return false; } catch { return true; } }), true);
  await chat.locator('#message').fill('こんにちは');
  await chat.locator('#send').click();
  await waitFor(async () => (await state()).messages.length === 2, 'Local reply before AI selection');
  await chat.locator('#message').fill('この下書きは送らない');
  await selectProvider('openai');
  assert.deepEqual((await state()).messages, []);
  assert.equal(await chat.locator('#message').inputValue(), '');
  assert.equal(await callCount(), 0);
  checks.push('Local replies and provider selection alone make no AI request. Explicit selection clears local history/draft; the sandbox exposes only bounded state/actions, with no key, Node, desktop API or renderer network access.');

  assert.match(await chat.locator('#provider-status').innerText(), /OpenAI.*従量課金/u);
  assert.match(await chat.locator('#transmission').innerText(), /入力.*会話.*OpenAI/u);
  assert.equal(await chat.locator('#transmission').isVisible(), true);
  assert.equal(await chat.locator('#send').innerText(), 'OpenAIへ送る');
  await options(true);
  assert.equal(await chat.locator('#ai-details').isVisible(), true);
  assert.match(await chat.locator('#ai-limits').innerText(), /fixture.*完了.*料金/u);
  assert.match(await chat.locator('#ai-details').innerText(), /保存条件.*中止しても.*課金/u);
  await options(false);
  const firstText = 'テスト用：少し休憩しようかな。';
  const firstReply = '【テスト用の固定応答】うん、少し休もうね。';
  const first = await send(firstText);
  assert.deepEqual(await history(first), []);
  assert.equal(await chat.evaluate(() => window.dialogue.send('重複する送信')), false);
  assert.equal(await callCount(), first + 1);
  await resolve(first, firstReply);
  const secondText = 'テスト用：あとでまた呼ぶね。';
  const second = await send(secondText);
  assert.deepEqual(await history(second), [{ role: 'user', text: firstText }, { role: 'assistant', text: firstReply }]);
  const markupReply = '【テスト用の固定応答】<img src=x onerror=alert(1)> またね。';
  await resolve(second, markupReply);
  assert.equal(await chat.locator('#messages img').count(), 0);
  assert.match(await chat.locator('#messages').innerText(), /<img/u);
  await chat.screenshot({ path: path.join(directory, 'fixture-conversation.png') });
  checks.push('AI mode visibly labels provider, per-send cost, outgoing text/history, limits and provider retention/cancellation. One explicit send makes one fixture call; a second call receives only the completed turn and markup stays text.');

  await checkLayout(380, 420);
  await checkLayout(320, 320);
  checks.push('AI options and send action remain inside 380x420 and 320x320 windows with no horizontal overflow; long options scroll to the clear action. Screenshots contain fixture replies only.');

  const completed = [
    { role: 'user', text: firstText }, { role: 'assistant', text: firstReply },
    { role: 'user', text: secondText }, { role: 'assistant', text: markupReply },
  ];
  const cancelled = await send('中止した文は次回送らない');
  await chat.locator('#cancel').click();
  await assertAborted(cancelled);
  await delay(80);
  assert.equal(await callCount(), cancelled + 1);
  const failed = await send('失敗した文も次回送らない');
  assert.deepEqual(await history(failed), completed);
  await app.evaluate((_electron, index) => aiFixture.calls[index].reject(new Error('fixture-upstream-private-details')), failed);
  await waitFor(async () => (await state()).status === 'error', 'Sanitized fixture error');
  assert.doesNotMatch(await chat.locator('#error').innerText(), /fixture-upstream-private-details/u);
  await delay(80);
  assert.equal(await callCount(), failed + 1);
  const retry = await send('利用者が明示的に送った新しい文');
  assert.deepEqual(await history(retry), completed);
  await app.evaluate((_electron, index) => aiFixture.calls[index].resolve('中止済みの遅い返事'), cancelled);
  await delay(80);
  assert.equal((await state()).status, 'pending');
  await resolve(retry, '【テスト用の固定応答】新しい文に返事をしたよ。');
  assert.ok(!(await state()).messages.some(message => message.text === '中止済みの遅い返事'));
  checks.push('Cancellation and failure never retry automatically or enter later provider history; errors hide upstream detail and delayed cancelled replies cannot finish a newer request.');

  const switched = await send('切り替え前の保留中の文');
  await chat.locator('#message').fill('切り替え時に消す下書き');
  await selectProvider('local-demo');
  await assertAborted(switched);
  assert.deepEqual((await state()).messages, []);
  assert.equal(await chat.locator('#message').inputValue(), '');
  await app.evaluate((_electron, index) => aiFixture.calls[index].resolve('切り替え前の遅い返事'), switched);
  await delay(80);
  assert.deepEqual((await state()).messages, []);
  const beforeReselect = await callCount();
  await selectProvider('openai');
  assert.equal(await callCount(), beforeReselect);
  const reset = await send('切り替え後の新しい会話');
  assert.deepEqual(await history(reset), []);
  await resolve(reset, '【テスト用の固定応答】新しい会話だよ。');
  checks.push('Switching provider during a request aborts it, clears history/draft and discards its delayed result. Selecting AI again does not send and the next explicit request has empty history.');

  const closed = await send('閉じる前の保留中の文');
  await main(() => __shizuku.dialogue().close());
  await waitFor(() => main(() => !__shizuku.dialogue()), 'Window close disposes dialogue');
  await assertAborted(closed);
  await open();
  await app.evaluate((_electron, index) => aiFixture.calls[index].resolve('閉じた会話の遅い返事'), closed);
  await delay(80);
  assert.deepEqual((await state()).messages, []);
  checks.push('Window close aborts AI; reopening returns to empty local mode and ignores the old result.');

  await selectProvider('openai');
  const hidden = await send('非表示前の保留中の文');
  await main(() => __shizuku.action('hide'));
  assert.equal(await main(() => !!__shizuku.dialogue()), false);
  await assertAborted(hidden);
  await main(() => __shizuku.action('show'));
  assert.equal(await main(() => !!__shizuku.dialogue()), false);
  await open();
  checks.push('Explicit hide aborts AI and disposes chat; showing the avatar does not reopen/replay it. The next call defaults to local.');

  await selectProvider('openai');
  const resting = await send('休止前の保留中の文');
  await main(({ powerMonitor }) => powerMonitor.emit('suspend'));
  assert.equal(await main(() => !!__shizuku.dialogue()), false);
  await assertAborted(resting);
  await main(({ powerMonitor }) => powerMonitor.emit('resume'));
  assert.equal(await main(() => !!__shizuku.dialogue()), false);
  await open();
  checks.push('Simulated Electron suspend aborts AI; resume never reopens/replays chat. The next call defaults to local. Actual OS sleep is not tested.');

  await selectProvider('openai');
  await send('終了前の保留中の文');
  assert.equal(await main(() => aiFixture.networkAttempts), 0);
  await recordPids();
  const appProcess = app.process();
  // The app synchronously disposes dialogue before awaiting helper/settings
  // cleanup, allowing this snapshot without installing a before-quit callback.
  const quitEvidence = await main(() => {
    __shizuku.action('quit');
    return {
      lastRequestAborted: aiFixture.calls.at(-1).signal.aborted,
      networkAttempts: aiFixture.networkAttempts,
      dialogueDisposed: !__shizuku.dialogue(),
    };
  });
  await waitFor(() => appProcess.exitCode !== null, 'Normal quit');
  assert.equal(appProcess.exitCode, 0);
  app = null;
  assert.deepEqual(quitEvidence, {
    lastRequestAborted: true, networkAttempts: 0, dialogueDisposed: true,
  });
  await writeFile(path.join(directory, 'quit-abort.json'), JSON.stringify(quitEvidence, null, 2));
  const saved = JSON.parse(await readFile(path.join(directory, 'local.config.json'), 'utf8'));
  assert.deepEqual(Object.keys(saved).sort(), ['bounds', 'facing', 'favorite', 'modelPath', 'posture', 'quiet', 'scale']);
  assert.ok(!JSON.stringify(saved).includes(fakeKey));
  checks.push('Normal quit aborts the pending fixture request, disposes chat and exits successfully. No main-process network call occurred; saved settings contain neither provider/key nor conversation fields.');
} catch (error) { failure = error; }
finally {
  if (app) { await recordPids().catch(() => {}); await app.close().catch(() => {}); }
  let remainingPids = [];
  for (let i = 0; i < 40; i++) {
    remainingPids = [...pids].filter(pid => { try { process.kill(pid, 0); return true; } catch { return false; } });
    if (!remainingPids.length) break;
    await delay(100);
  }
  const settingsUnchanged = (await readFile(normal)).equals(before);
  if (remainingPids.length || !settingsUnchanged) failure ??= new Error('Cleanup/settings invariant failed');
  const result = {
    status: failure ? 'failed' : 'passed', checks, layouts, remainingPids, settingsUnchanged,
    scope: 'Real Electron API/UI acceptance with injected fixture replies; no live API, native input, actual OS sleep or sustained resource test.',
    error: failure?.stack,
  };
  await writeFile(path.join(directory, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ directory, checks: checks.length, status: result.status, remainingPids, settingsUnchanged, error: failure?.message }, null, 2));
}
if (failure) throw failure;
