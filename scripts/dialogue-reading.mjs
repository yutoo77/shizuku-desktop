// Own Electron dialogue only, with deterministic in-memory replies. Run after
// residency measurements; no native focus claims or live service calls.
import { _electron } from 'playwright';
import electron from 'electron';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { inspectProcessIdentities } from './process-check.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const active = await readFile(path.join(root, 'work/daily-use-active.json'), 'utf8').catch(error => {
  if (error.code === 'ENOENT') return '{}';
  throw error;
});
assert.notEqual(JSON.parse(active.replace(/^\uFEFF/, '')).status, 'running', 'Wait for the active residency measurement before running another Electron test.');
const normal = path.join(root, 'local.config.json'), before = await readFile(normal);
const config = JSON.parse(before.toString().replace(/^\uFEFF/, ''));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const modelHash = hash(await readFile(config.modelPath));
const directory = await mkdtemp(path.join(root, 'work/dialogue-reading-'));
await writeFile(path.join(directory, 'local.config.json'), JSON.stringify({ modelPath: config.modelPath, quiet: true }));
const env = { ...process.env, SHIZUKU_TEST: '1', SHIZUKU_TEST_DATA: path.basename(directory), SHIZUKU_METRICS: '0' };
delete env.OPENAI_API_KEY; delete env.ELECTRON_RUN_AS_NODE;
const report = { status: 'running', startedAt: new Date().toISOString(), checks: [],
  buildSha256: hash(await readFile(path.join(root, 'dist/dialogue.js'))), rendererHttpAttempts: 0 };
const identities = new Map();
let app, chat, child, exit, failure;
const main = fn => app.evaluate(fn);
const check = message => { report.checks.push(message); console.log(JSON.stringify({ check: message })); };
async function processes() {
  const value = await main(() => ({ metrics: __shizuku.metrics(), helper: __shizuku.tracking().pid, parent: process.pid }));
  for (const item of value.metrics) identities.set(`${item.pid}:${item.creationTime}`, { pid: item.pid, creationTime: item.creationTime });
  identities.set(`helper:${value.helper}`, { pid: value.helper, name: 'window-tracker.exe', parentPid: value.parent });
}
async function waitState(status, length) {
  await chat.waitForFunction(async ({ status, length }) => {
    const value = await window.dialogue.getState();
    return value.status === status && value.messages.length === length && document.querySelector('#messages').children.length === length;
  }, { status, length }, { polling: 50, timeout: 8000 });
}
async function sendHeld(text, length) {
  assert.equal(await chat.evaluate(text => window.dialogue.send(text), text), true);
  await waitState('pending', length);
  assert.equal(await main(() => __readingReplies.length), 1);
}
async function reply(text, length) {
  await app.evaluate((_e, text) => __readingReplies.shift().resolve(text), text);
  await waitState('idle', length);
}
try {
  app = await _electron.launch({ executablePath: electron, args: [root], cwd: root, env, timeout: 20_000 });
  child = app.process();
  identities.set(`launcher:${child.pid}`, { pid: child.pid, name: path.basename(electron), parentPid: process.pid });
  child.once('exit', (code, signal) => { exit = { code, signal }; });
  app.context().on('request', request => { if (/^https?:/i.test(request.url())) report.rendererHttpAttempts++; });
  const avatar = await app.firstWindow();
  await avatar.waitForFunction(() => __diagnostics.loaded && __diagnostics.quiet);
  await main(() => {
    globalThis.__readingReplies = [];
    __shizuku.setDialogueReply((text, { signal }) => new Promise(resolve => __readingReplies.push({ resolve, signal })));
  });
  const opened = app.waitForEvent('window');
  await main(() => __shizuku.action('call'));
  chat = await opened; chat.setDefaultTimeout(8000);
  await chat.waitForSelector('#message'); await waitState('idle', 0); await processes();
  assert.equal(await chat.locator('#latest').isHidden(), true);
  // Fixture history: 19 completed turns plus one cancelled input. The next
  // pending input fills the 40-message display; its reply then prunes a pair.
  for (let index = 0; index < 19; index++) {
    await sendHeld(`確認用の話 ${index + 1}。読んでいる途中の文章を残します。`.repeat(3), index * 2 + 1);
    await reply(`確認用の返事 ${index + 1}。ここで少し振り返っているところだよ。`.repeat(3), index * 2 + 2);
  }
  await sendHeld('この返事は途中で中止します。', 39);
  await chat.evaluate(() => window.dialogue.cancel()); await waitState('idle', 39);
  assert.equal(await main(() => __readingReplies[0].signal.aborted), true);
  await reply('取り消した古い返事。表示しません。', 39);
  await sendHeld('返事を待つ間に、以前の話を読み返します。', 40);
  check('A cancelled turn and a pending reply reach the real 40-message display boundary without a live provider.');
  report.readingBefore = await chat.evaluate(() => {
    const viewport = document.querySelector('.conversation');
    const node = document.querySelector('[data-message-id="17"]');
    window.__readingNode = node;
    viewport.scrollTop += node.getBoundingClientRect().top - viewport.getBoundingClientRect().top - 12;
    const range = document.createRange(); range.setStart(node.firstChild, 2); range.setEnd(node.firstChild, 16);
    const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
    return { selected: selection.toString(), top: node.getBoundingClientRect().top - viewport.getBoundingClientRect().top,
      scrollTop: viewport.scrollTop, firstId: document.querySelector('#messages').firstElementChild.dataset.messageId };
  });
  assert.ok(report.readingBefore.selected.length > 0);
  await chat.screenshot({ path: path.join(directory, 'reading-before.png') });
  await reply('読み返しているあいだに届いた、新しい返事です。'.repeat(3), 39);
  report.readingAfter = await chat.evaluate(() => {
    const viewport = document.querySelector('.conversation'), node = document.querySelector('[data-message-id="17"]');
    return { retainedNode: node === window.__readingNode, selected: getSelection().toString(),
      top: node.getBoundingClientRect().top - viewport.getBoundingClientRect().top, scrollTop: viewport.scrollTop,
      firstId: document.querySelector('#messages').firstElementChild.dataset.messageId };
  });
  await chat.screenshot({ path: path.join(directory, 'reading-after.png') });
  assert.notEqual(report.readingAfter.firstId, report.readingBefore.firstId, 'The fixture must actually prune old history.');
  assert.equal(report.readingAfter.retainedNode, true, 'A surviving message must retain its DOM node when older history is pruned.');
  assert.equal(report.readingAfter.selected, report.readingBefore.selected, 'A selection in retained history must survive the reply.');
  assert.ok(Math.abs(report.readingAfter.top - report.readingBefore.top) <= 1, 'The retained reading position must not jump.');
  check('Pruning older history retains the selected message node, selected text and reading position.');

  assert.equal(await chat.locator('#latest').isVisible(), true);
  assert.ok(await chat.evaluate(() => {
    const cue = document.querySelector('#latest').getBoundingClientRect();
    return cue.top >= document.querySelector('.conversation').getBoundingClientRect().bottom
      && cue.bottom <= document.querySelector('#composer').getBoundingClientRect().top;
  }), 'The new reply cue must not cover conversation text or the composer.');
  await chat.locator('#latest').press('Enter');
  await chat.waitForFunction(() => document.querySelector('#latest').hidden);
  assert.equal(await chat.evaluate(() => document.activeElement === document.querySelector('.conversation')), true);
  assert.ok(await chat.evaluate(() => { const v = document.querySelector('.conversation'); return v.scrollHeight - v.scrollTop - v.clientHeight < 2; }));
  await chat.evaluate(() => { document.querySelector('.conversation').scrollTop = 100; });
  assert.equal(await chat.locator('#latest').isHidden(), true);
  check('An offscreen new reply offers a conditional action; Enter reaches it, keeps keyboard focus in the conversation and does not revive the cue after reading.');

  await chat.evaluate(() => { const viewport = document.querySelector('.conversation'); getSelection().removeAllRanges(); viewport.scrollTop = viewport.scrollHeight; });
  await sendHeld('一番下で次の返事を待ちます。', 40);
  await reply('今届いた最後の返事も、そのまま読めるよ。'.repeat(4), 39);
  assert.ok(await chat.evaluate(() => { const v = document.querySelector('.conversation'); return v.scrollHeight - v.scrollTop - v.clientHeight < 2; }));
  assert.equal(await chat.locator('#latest').isHidden(), true);
  check('A reader already at the bottom continues to see the latest reply.');

  await sendHeld('返事を待ちながら、もう一度読み返します。', 40);
  await chat.evaluate(() => { document.querySelector('.conversation').scrollTop = 100; });
  await reply('画面の下に届いた返事。', 39);
  assert.equal(await chat.locator('#latest').isVisible(), true);
  const originalSize = await main(() => ({ size: __shizuku.dialogue().getSize(), zoom: __shizuku.dialogue().webContents.getZoomFactor() }));
  await main(() => { __shizuku.dialogue().setSize(320, 320); __shizuku.dialogue().webContents.setZoomFactor(1.25); });
  await delay(150);
  report.smallLayout = await chat.evaluate(() => {
    const rect = selector => { const r = document.querySelector(selector).getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, width: r.width, height: r.height }; };
    return { width: innerWidth, height: innerHeight, cue: rect('#latest'), viewport: rect('.conversation'), composer: rect('#composer'),
      send: rect('#send'), close: rect('#close'), scrollWidth: document.documentElement.scrollWidth };
  });
  const layout = report.smallLayout;
  assert.ok(layout.cue.top >= layout.viewport.bottom && layout.cue.bottom <= layout.composer.top && layout.viewport.height > 0);
  for (const button of [layout.cue, layout.send, layout.close]) assert.ok(button.width > 0 && button.height > 0
    && button.left >= 0 && button.right <= layout.width && button.top >= 0 && button.bottom <= layout.height);
  assert.ok(layout.scrollWidth <= layout.width);
  const smallPng = await main(async () => (await __shizuku.dialogue().webContents.capturePage()).toPNG().toString('base64'));
  await writeFile(path.join(directory, 'reading-small-125-percent.png'), Buffer.from(smallPng, 'base64'));
  await app.evaluate((_e, original) => { __shizuku.dialogue().setSize(...original.size); __shizuku.dialogue().webContents.setZoomFactor(original.zoom); }, originalSize);
  await delay(150);
  check('At 320 by 320 and 125% page zoom, the cue, send and close fit, and the cue does not overlap the text or composer.');
  await chat.evaluate(() => { const v = document.querySelector('.conversation'); v.scrollTop = v.scrollHeight; });
  await chat.waitForFunction(() => document.querySelector('#latest').hidden);
  check('Manually scrolling to the new reply also clears the cue.');

  // Explicit composer submission still follows the user's own new message,
  // even if they were previously reading older history.
  await chat.evaluate(() => { const v = document.querySelector('.conversation'); v.scrollTop = 100; });
  await chat.locator('#message').fill('ここから新しく話しかけるよ。');
  await chat.evaluate(() => document.querySelector('#composer').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  await waitState('pending', 40);
  assert.ok(await chat.evaluate(() => { const v = document.querySelector('.conversation'); return v.scrollHeight - v.scrollTop - v.clientHeight < 2; }));
  await reply('うん、新しい話を聞いているよ。', 39);
  check('Explicitly submitting from the composer still follows the new message.');
  await chat.evaluate(() => window.dialogue.clear()); await waitState('idle', 0);
  assert.equal(await chat.locator('#latest').isHidden(), true);
  assert.equal(await chat.locator('#empty').isVisible(), true);
  assert.equal(await chat.evaluate(() => window.__readingNode.isConnected), false);
  await sendHeld('消したあとの新しい会話。', 1); await reply('前の履歴は戻らないよ。', 2);
  assert.deepEqual(await chat.locator('#messages .message').allTextContents(), ['消したあとの新しい会話。', '前の履歴は戻らないよ。']);
  check('Clearing removes retained nodes and starts a fresh bounded conversation.');

  await chat.evaluate(() => window.dialogue.clear()); await waitState('idle', 0);
  await main(() => __shizuku.dialogue().setSize(360, 320));
  for (let index = 0; index < 2; index++) {
    await sendHeld(`窓の大きさを変える確認 ${index + 1}。前の話を読んでいます。`.repeat(2), index * 2 + 1);
    await reply('うん、窓を広げたら届いた返事をそのまま読めるようにするね。'.repeat(2), index * 2 + 2);
  }
  await sendHeld('少し前の話を読みながら待っています。', 5);
  await chat.evaluate(() => { document.querySelector('.conversation').scrollTop = 0; });
  await reply('窓を広げたときの案内も確認するね。', 6);
  assert.equal(await chat.locator('#latest').isVisible(), true);
  await main(({ screen }) => {
    const area = screen.getPrimaryDisplay().workArea;
    __shizuku.dialogue().setBounds({ x: area.x + 20, y: area.y + 20, width: 360, height: Math.min(900, area.height - 40) });
  });
  await chat.waitForFunction(() => { const v = document.querySelector('.conversation'); return v.scrollHeight <= v.clientHeight; });
  await delay(100);
  assert.equal(await chat.locator('#latest').isHidden(), true, 'Enlarging the window until all replies fit must dismiss the unread cue.');
  check('Enlarging the window until the reply is visible dismisses the cue without an extra click or scroll.');
  assert.equal(report.rendererHttpAttempts, 0); await processes();
} catch (error) { failure = error; }
finally {
  if (app) {
    try {
      await processes(); await main(() => __shizuku.action('quit'));
      for (let i = 0; child.exitCode === null && i < 150; i++) await delay(100);
      assert.deepEqual(exit, { code: 0, signal: null });
    } catch (error) { failure ??= error; }
    await app.close().catch(error => { failure ??= error; });
  }
  try {
    const all = [...identities.values()], exact = new Set(all.filter(p => Number.isFinite(p.creationTime)).map(p => p.pid));
    report.processCheck = await inspectProcessIdentities(all.filter(p => Number.isFinite(p.creationTime) || !exact.has(p.pid)), directory);
    assert.deepEqual(report.processCheck.remainingPids, []); assert.deepEqual(report.processCheck.unverifiablePids, []);
    report.settingsUnchanged = (await readFile(normal)).equals(before);
    report.modelUnchanged = hash(await readFile(config.modelPath)) === modelHash;
    assert.equal(report.settingsUnchanged, true); assert.equal(report.modelUnchanged, true);
  } catch (error) { failure ??= error; }
  report.exit = exit; report.status = failure ? 'failed' : 'passed'; report.error = failure?.stack;
  report.finishedAt = new Date().toISOString();
  await writeFile(path.join(directory, 'result.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ directory, status: report.status, checks: report.checks.length, error: failure?.message }));
}
if (failure) throw failure;
