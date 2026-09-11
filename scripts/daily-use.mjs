// Longer own-app residency and local-dialogue exercise. No native input, live
// provider, microphone, voice engine, OS sleep or other-application inspection.
import { _electron } from 'playwright';
import electron from 'electron';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, mkdir, rename } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { cpus, release, totalmem } from 'node:os';
import { spawn, execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { summarizeCompanionPhase } from '../src/soak-metrics.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dryValue = process.env.SHIZUKU_DAILY_DRY_RUN_SECONDS;
const drySeconds = dryValue === undefined ? null : Number(dryValue);
if (drySeconds !== null && (!Number.isSafeInteger(drySeconds) || drySeconds < 30 || drySeconds > 120)) {
  throw new Error('SHIZUKU_DAILY_DRY_RUN_SECONDS must be an integer from 30 to 120; omit it for the full run.');
}
if (process.env.SHIZUKU_DAILY_GPU !== undefined && !['0', '1'].includes(process.env.SHIZUKU_DAILY_GPU)) {
  throw new Error('SHIZUKU_DAILY_GPU must be 0 or 1 when set.');
}
const plan = { mode: drySeconds === null ? 'full' : 'dry-run', originalMs: (drySeconds ?? 300) * 1000,
  compactMs: (drySeconds ?? 300) * 1000, afterDialogueMs: (drySeconds ?? 120) * 1000,
  hiddenMs: (drySeconds ?? 60) * 1000, dialogueCycles: 20, sampleIntervalMs: 2000, settleMs: 8000,
  gpu: process.platform === 'win32' && process.env.SHIZUKU_DAILY_GPU !== '0' };
const normal = path.join(root, 'local.config.json'), before = await readFile(normal);
const config = JSON.parse(before.toString('utf8').replace(/^\uFEFF/, ''));
assert.ok(typeof config.modelPath === 'string' && config.modelPath, 'Select a usable local VRM before running daily-use acceptance.');
await mkdir(path.join(root, 'work'), { recursive: true });
const directory = await mkdtemp(path.join(root, 'work', 'daily-use-'));
const reportPath = path.join(directory, 'run.json'), activePath = path.join(root, 'work', 'daily-use-active.json');
await writeFile(path.join(directory, 'local.config.json'), JSON.stringify({ modelPath: config.modelPath, quiet: true,
  scale: 100, posture: 'standing', textureQuality: 'original' }));
const env = { ...process.env, SHIZUKU_TEST: '1', SHIZUKU_TEST_DATA: path.basename(directory), SHIZUKU_METRICS: '0' };
delete env.OPENAI_API_KEY; delete env.ELECTRON_RUN_AS_NODE;
async function fileIdentity(file) {
  const bytes = await readFile(file);
  return { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
}
const report = {
  schemaVersion: 1, status: 'running', functionalStatus: 'running', measurementStatus: 'pending', startedAt: new Date().toISOString(), directory, plan,
  revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  workingTreeDirty: !!execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim(),
  host: { platform: process.platform, release: release(), logicalProcessors: cpus().length,
    cpu: cpus()[0]?.model, totalMemoryMiB: totalmem() / 1048576 },
  modelBefore: await fileIdentity(config.modelPath), builtFiles: {}, phases: [], cycles: [], checks: [],
  script: { path: 'scripts/daily-use.mjs', ...await fileIdentity(fileURLToPath(import.meta.url)) },
  network: { rendererHttpAttempts: 0 }, remainingPids: null, userSettingsUnchanged: null,
  methodology: {
    workload: 'One application process sequence: original quality, actual compact preference switch, 20 local dialogue cycles, compact idle after dialogue, hidden idle, exit. This is a longer residency exercise, not a fresh-start A/B memory comparison or proof of all-day stability.',
    phases: 'Original and compact are quiet, standing, scale 100. Eight seconds of settling are excluded before each stable phase. Dialogue process changes and transition frames are retained separately and never mixed into stable-phase means. No forced garbage collection or arbitrary memory-growth pass threshold.',
    measurements: 'Two-second Playwright samples use summarizeCompanionPhase. CPU uses cumulative process deltas; helper uses its own timestamps with endpoint skew. Working sets may double-count shared pages. Private bytes are allocated private memory, not resident RAM. The Node driver and GPU collector are excluded from app/helper totals.',
    gpu: 'Optional existing Windows GPU counter collector runs separately per stable phase with that phase\'s fixed app/helper PIDs. Only counter intervals wholly inside a process-stable phase are accepted. Missing/invalid counters remain unavailable, never zero; values are reference measurements, not a driver-stability guarantee.',
    network: 'SHIZUKU_TEST=1 is forced and inherited OpenAI keys are removed. AI is unavailable, speech uses a rejecting counted fixture, and main fetch is guarded. HTTP(S) requests observed by Playwright are counted. These are application-level guards/observations, not packet capture.',
    images: 'Model bytes are only read and hashed. Avatar createImageBitmap/file-read counts detect reloads caused by dialogue; the probe retains no bitmap references. Screenshots contain only this app\'s own first dialogue and final avatar. Native keyboard/focus behavior is not certified.',
    windows: 'One owned dialogue BrowserWindow/WebContents pair is retained until both report destroyed and Playwright Page reports closed. The reference is then cleared before the next cycle or stable measurement; only the avatar may remain in this app\'s window list.',
  },
};
for (const file of ['main.cjs', 'renderer.js', 'dialogue.js', 'window-tracker.exe']) report.builtFiles[file] = await fileIdentity(path.join(root, 'dist', file));
let app, avatar, chat, failure, activePhase = 'launch', aborted = false, lastNotice = performance.now();
let checkpointQueue = Promise.resolve();
const pids = new Set(), collectors = [];
const abort = () => { aborted = true; console.log(JSON.stringify({ event: 'interrupt', phase: activePhase, time: new Date().toISOString() })); };
process.on('SIGINT', abort); process.on('SIGTERM', abort);
const checkAbort = () => { if (aborted) throw new Error('Daily-use check interrupted; partial measurements are retained.'); };
const progress = (event, extra = {}) => { lastNotice = performance.now(); console.log(JSON.stringify({ event, phase: activePhase, time: new Date().toISOString(), ...extra })); };
async function atomicJson(file, value) {
  const temporary = `${file}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2)); await rename(temporary, file);
}
function checkpoint() {
  // Heartbeats and phase/cycle boundaries share one serialized writer. They
  // cannot replace the same temporary checkpoint file concurrently.
  const save = async () => {
    await atomicJson(reportPath, report);
    await atomicJson(path.join(directory, 'pids.json'), [...pids]);
    await atomicJson(activePath, { directory, reportPath, phase: activePhase, status: report.status,
      time: new Date().toISOString(), pids: [...pids], plan });
  };
  checkpointQueue = checkpointQueue.then(save, save); return checkpointQueue;
}
const main = fn => app.evaluate(fn);
const dialogueState = () => main(() => __shizuku.dialogueState());
const diagnostic = () => avatar.evaluate(() => { const { modelName, ...value } = __diagnostics; return value; });
const bitmapCounts = () => avatar.evaluate(() => ({ ...window.__dailyImages }));
async function recordProcesses() {
  if (!app) return;
  pids.add(app.process().pid);
  const value = await main(() => ({ processes: __shizuku.metrics(), helper: __shizuku.tracking().pid }));
  for (const item of value.processes) if (Number.isSafeInteger(item.pid) && item.pid > 0) pids.add(item.pid);
  if (Number.isSafeInteger(value.helper) && value.helper > 0) pids.add(value.helper);
}
async function waitFor(predicate, label, timeoutMs = 8000) {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) { checkAbort(); if (await predicate()) return; await delay(50); }
  throw new Error(label);
}
async function snapshot() {
  checkAbort();
  const value = await main(() => {
    const s = __shizuku, status = s.status(), tracker = s.tracking();
    return { time: new Date().toISOString(), monotonicMs: performance.now(), visible: status.visible,
      loaded: status.modelLoaded, scale: status.scale, textureQuality: status.textureQuality,
      bounds: s.avatar().getBounds(), focused: s.avatar().isFocused(), focusable: s.avatar().isFocusable(),
      processes: s.metrics(), windowTracker: { pid: tracker.pid, ready: tracker.ready, stats: tracker.stats },
      dialogueOpen: !!s.dialogue(), hasSession: s.dialogueState() !== null,
      retainedDialogueReference: !!globalThis.__dailyProbe?.ownedDialogue };
  });
  value.diagnostics = await diagnostic();
  pids.add(app.process().pid);
  for (const item of value.processes) { assert.ok(Number.isSafeInteger(item.pid) && item.pid > 0); pids.add(item.pid); }
  if (Number.isSafeInteger(value.windowTracker.pid) && value.windowTracker.pid > 0) pids.add(value.windowTracker.pid);
  return value;
}
async function installProbes() {
  await app.evaluate((_electron, modelPath) => {
    if (process.env.SHIZUKU_TEST !== '1' || process.env.OPENAI_API_KEY) throw new Error('Unsafe test environment.');
    const fs = process.getBuiltinModule('fs/promises'), paths = process.getBuiltinModule('path');
    const originalRead = fs.readFile, expected = paths.resolve(modelPath).toLowerCase();
    globalThis.__dailyProbe = { originalRead, originalFetch: globalThis.fetch, modelReads: 0, mainFetchAttempts: 0,
      speechCalls: 0, localHeldCalls: 0, held: null, ownedDialogue: null };
    fs.readFile = async function(file, ...args) {
      if (typeof file === 'string' && paths.resolve(file).toLowerCase() === expected) __dailyProbe.modelReads++;
      return originalRead.call(this, file, ...args);
    };
    globalThis.fetch = async () => { __dailyProbe.mainFetchAttempts++; throw new Error('Network is disabled in daily-use acceptance.'); };
    __shizuku.setDialogueAI(undefined);
    __shizuku.setDialogueSpeech(async () => { __dailyProbe.speechCalls++; throw new Error('Speech is disabled in daily-use acceptance.'); });
    __shizuku.setDialogueReply(undefined);
  }, config.modelPath);
  await avatar.evaluate(() => {
    const create = window.createImageBitmap;
    window.__dailyImages = { decoded: 0, resized: 0, failed: 0, inFlight: 0 };
    window.createImageBitmap = async function(...args) {
      const probe = window.__dailyImages;
      if (args[0] instanceof ImageBitmap) probe.resized++; else probe.decoded++;
      probe.inFlight++;
      try { return await create.apply(this, args); }
      catch (error) { probe.failed++; throw error; }
      finally { probe.inFlight--; }
    };
  });
  app.context().on('request', request => { if (/^https?:/i.test(request.url())) report.network.rendererHttpAttempts++; });
}
async function startGpu(item, firstSample) {
  if (!plan.gpu) { item.gpu = { enabled: false, reason: 'Disabled by platform or SHIZUKU_DAILY_GPU=0.' }; return null; }
  const ids = [...new Set([...firstSample.processes.map(p => p.pid), firstSample.windowTracker.pid])];
  const pidFile = path.join(directory, `${item.name}-gpu-pids.json`), output = path.join(directory, `${item.name}-gpu.json`);
  await writeFile(pidFile, JSON.stringify(ids));
  const collector = { output, phase: item.name, process: null, closed: false, exitCode: null, stdout: '', error: null };
  collectors.push(collector);
  const child = spawn('pwsh.exe', ['-NoProfile', '-File', path.join(root, 'scripts', 'measure-gpu.ps1'),
    '-Samples', String(Math.max(2, Math.floor(item.requestedDurationMs / 2000) - 2)), '-PidsFile', pidFile, '-Output', output],
  { windowsHide: true, env, stdio: ['ignore', 'pipe', 'pipe'] });
  collector.process = child; if (child.pid) pids.add(child.pid);
  child.stdout.on('data', data => { if (collector.stdout.length < 16_384) collector.stdout += data.toString().slice(0, 16_384 - collector.stdout.length); });
  child.stderr.on('data', () => {});
  child.once('error', error => { collector.error = error.message; collector.closed = true; });
  child.once('close', code => { collector.closed = true; collector.exitCode = code; });
  item.gpu = { enabled: true, fixedPids: ids, samples: 0, valid: 0, mean: null, max: null, stablePhase: false };
  return collector;
}
async function finishGpu(item, collector, stablePhase) {
  if (!collector) return;
  const deadline = performance.now() + 8000;
  while (!collector.closed && performance.now() < deadline && !aborted) await delay(100);
  if (!collector.closed) { collector.process.kill(); collector.error ??= 'Collector exceeded its stable phase.'; }
  item.gpu.stablePhase = stablePhase; item.gpu.exitCode = collector.exitCode;
  if (collector.error) item.gpu.error = collector.error;
  try {
    const samples = JSON.parse((await readFile(collector.output, 'utf8')).replace(/^\uFEFF/, ''));
    const inPhase = samples.filter(sample => Date.parse(sample.time) >= Date.parse(item.startedAt) + 2000
      && Date.parse(sample.time) <= Date.parse(item.endedAt));
    const valid = stablePhase && collector.closed && collector.exitCode === 0
      ? inPhase.filter(sample => sample.available === true && Number.isFinite(sample.busiestEnginePercent)
        && sample.busiestEnginePercent >= 0 && sample.busiestEnginePercent <= 100) : [];
    Object.assign(item.gpu, { samples: inPhase.length, valid: valid.length,
      mean: valid.length ? valid.reduce((sum, sample) => sum + sample.busiestEnginePercent, 0) / valid.length : null,
      max: valid.length ? Math.max(...valid.map(sample => sample.busiestEnginePercent)) : null });
  } catch (error) { item.gpu.error ??= error.message; }
}
async function stablePhase(name, durationMs, quality, visible) {
  activePhase = name; progress('settling', { seconds: plan.settleMs / 1000 });
  await waitFor(async () => { const d = await diagnostic(); return d.loaded && d.quiet && !d.reacting && !d.moving && !d.contextLost; }, 'Avatar did not return to a settled quiet state.');
  await delay(plan.settleMs); checkAbort();
  const initialImages = await bitmapCounts();
  const item = { name, quality, visible, requestedDurationMs: durationMs, startedAt: new Date().toISOString(), samples: [], imagesBefore: initialImages };
  report.phases.push(item); await checkpoint(); progress('phase-start', { durationSeconds: durationMs / 1000 });
  let collector;
  try {
    const start = performance.now(); let next = start, lastProgress = start;
    while (true) {
      await delay(Math.max(0, next - performance.now()));
      const sample = await snapshot(); item.samples.push(sample);
      assert.equal(sample.dialogueOpen, false); assert.equal(sample.hasSession, false); assert.equal(sample.retainedDialogueReference, false);
      assert.equal(sample.loaded, true); assert.equal(sample.visible, visible);
      assert.equal(sample.diagnostics.loaded, true); assert.equal(sample.diagnostics.visible, visible);
      assert.equal(sample.textureQuality, quality); assert.equal(sample.diagnostics.textureQuality, quality);
      assert.equal(sample.diagnostics.quiet, true); assert.equal(sample.diagnostics.posture, 'standing');
      assert.equal(sample.diagnostics.moving, false); assert.equal(sample.diagnostics.reacting, false);
      assert.equal(sample.diagnostics.contextLost, false); assert.equal(sample.diagnostics.animating, false);
      assert.equal(sample.diagnostics.renderedFrames, item.samples[0].diagnostics.renderedFrames, 'A stable quiet/hidden phase must not add frames.');
      assert.equal(sample.bounds.width, 300); assert.equal(sample.bounds.height, 440); assert.equal(sample.focusable, false);
      if (item.samples.length === 1) collector = await startGpu(item, sample);
      const elapsed = performance.now() - start;
      if (elapsed >= durationMs) break;
      if (performance.now() - lastProgress >= 24_000) {
        await checkpoint(); progress('phase-progress', { elapsedSeconds: Math.round(elapsed / 1000), samples: item.samples.length }); lastProgress = performance.now();
      }
      next = start + (Math.floor((performance.now() - start) / plan.sampleIntervalMs) + 1) * plan.sampleIntervalMs;
    }
    item.endedAt = new Date().toISOString();
    try {
      item.summary = summarizeCompanionPhase(item.samples, { logicalProcessors: report.host.logicalProcessors, visible });
      assert.ok(item.summary.electron.durationSeconds >= durationMs / 1000 - 0.25, 'Samples must cover the requested stable duration.');
      assert.equal(item.summary.electron.observedFps, 0); item.measurementValid = true;
    } catch (error) {
      // Functional conditions were checked for every sample above. A process
      // replacement or invalid measurement must not become an invented mean or
      // prevent the remaining independent dialogue/recovery checks from running.
      delete item.summary; item.measurementValid = false; item.measurementError = error.message;
    }
    item.imagesAfter = await bitmapCounts(); assert.deepEqual(item.imagesAfter, initialImages);
    progress('phase-sampling-complete', { measurementValid: item.measurementValid, measurementError: item.measurementError });
    await finishGpu(item, collector, item.measurementValid);
    report.checks.push(`${name}: quiet frames zero, no dialogue session or avatar image re-decode; measurement ${item.measurementValid ? 'valid' : 'invalid (raw samples retained)'}.`);
    await checkpoint(); progress('phase-complete', { measurementValid: item.measurementValid, summary: item.summary?.total, gpu: item.gpu });
  } catch (error) {
    item.endedAt ??= new Date().toISOString(); item.error = error.message;
    await finishGpu(item, collector, false); await checkpoint(); throw error;
  }
}
async function confirmChatDestroyed(record) {
  const closingPage = chat;
  await waitFor(async () => closingPage.isClosed() && await main(() => {
    const owned = __dailyProbe.ownedDialogue;
    return !!owned && owned.win.isDestroyed() && owned.contents.isDestroyed();
  }), 'The previous dialogue Page, BrowserWindow or WebContents has not finished closing.');
  const evidence = await main(({ BrowserWindow }) => {
    const owned = __dailyProbe.ownedDialogue;
    return { windowId: owned.id, webContentsId: owned.contentsId, windowDestroyed: owned.win.isDestroyed(),
      webContentsDestroyed: owned.contents.isDestroyed(), avatarId: __shizuku.avatar().id,
      remainingWindowIds: BrowserWindow.getAllWindows().map(win => win.id),
      controllerOwnsWindow: !!__shizuku.dialogue(), sessionPresent: __shizuku.dialogueState() !== null };
  });
  assert.equal(evidence.windowDestroyed, true); assert.equal(evidence.webContentsDestroyed, true);
  assert.equal(evidence.controllerOwnsWindow, false); assert.equal(evidence.sessionPresent, false);
  assert.deepEqual(evidence.remainingWindowIds, [evidence.avatarId], 'Only this app\'s avatar window may remain after a dialogue cycle.');
  record.destroyed = { ...evidence, pageClosed: closingPage.isClosed() };
  // Retain at most one old native window until it is actually destroyed. Clear
  // both main and driver references before the next cycle or measured phase.
  await main(() => { __dailyProbe.ownedDialogue = null; });
  chat = null;
}
async function closeChat(record) {
  await chat.locator('#close').click().catch(error => { if (!chat.isClosed()) throw error; });
  await waitFor(() => main(() => !__shizuku.dialogue() && __shizuku.dialogueState() === null), 'Closed dialogue still owns a window or session.');
  await confirmChatDestroyed(record);
}
async function dialogueCycles() {
  activePhase = 'dialogue-cycles'; progress('cycles-start', { count: plan.dialogueCycles });
  const initialImages = await bitmapCounts(), initialReads = await main(() => __dailyProbe.modelReads);
  for (let index = 0; index < plan.dialogueCycles; index++) {
    checkAbort();
    const mode = ['complete', 'pending-close', 'pending-cancel', 'pending-hide', 'complete'][index % 5];
    const record = { number: index + 1, mode, startedAt: new Date().toISOString() }; report.cycles.push(record);
    await app.evaluate((_electron, held) => {
      if (__dailyProbe.held !== null) throw new Error('The previous held fixture was retained.');
      __shizuku.setDialogueReply(held ? (_text, { signal }) => new Promise(resolve => {
        __dailyProbe.localHeldCalls++; __dailyProbe.held = { signal, resolve };
      }) : undefined);
    }, mode !== 'complete');
    const opened = app.waitForEvent('window', { timeout: 15_000 });
    await main(() => __shizuku.action('call')); chat = await opened; chat.setDefaultTimeout(7000);
    await main(() => {
      if (__dailyProbe.ownedDialogue !== null) throw new Error('The previous native dialogue reference was retained.');
      const win = __shizuku.dialogue(), contents = win.webContents;
      __dailyProbe.ownedDialogue = { win, contents, id: win.id, contentsId: contents.id };
    });
    await chat.waitForSelector('#message');
    await chat.waitForFunction(() => !document.querySelector('#provider').disabled && !document.querySelector('#voice').disabled);
    const fresh = await dialogueState();
    assert.equal(fresh.provider, 'local-demo'); assert.equal(fresh.voice.enabled, false); assert.equal(fresh.voice.status, 'idle');
    assert.deepEqual(fresh.messages, []); assert.equal(await chat.locator('#message').inputValue(), '');
    assert.equal(await chat.locator('#send').isDisabled(), true);
    record.opened = await snapshot();
    await chat.locator('#message').fill('こんにちは。');
    await chat.waitForFunction(() => !document.querySelector('#send').disabled);
    await chat.locator('#send').click();
    if (mode === 'complete') {
      await waitFor(async () => { const s = await dialogueState(); return s.status === 'idle' && s.messages.length === 2; }, 'Local reply did not finish.');
      assert.match((await dialogueState()).messages[1].text, /呼んでくれてありがとう/);
      if (index === 0) await chat.screenshot({ path: path.join(directory, 'first-local-dialogue.png') });
      await closeChat(record);
    } else {
      await waitFor(() => main(() => __dailyProbe.held !== null && __shizuku.dialogueState()?.status === 'pending'), 'Held local request did not become pending.');
      if (mode === 'pending-close') await closeChat(record);
      else if (mode === 'pending-cancel') {
        await chat.locator('#cancel').click();
        await waitFor(async () => (await dialogueState()).status === 'idle', 'Cancel did not leave pending state.');
      } else {
        await main(() => __shizuku.action('hide'));
        await waitFor(() => main(() => !__shizuku.dialogue() && __shizuku.dialogueState() === null && !__shizuku.status().visible), 'Hide did not close the pending dialogue.');
        await confirmChatDestroyed(record);
      }
      assert.equal(await main(() => __dailyProbe.held.signal.aborted), true);
      await main(() => { const held = __dailyProbe.held; __dailyProbe.held = null; held.resolve('検査用の遅い返事です。'); });
      await delay(150);
      if (mode === 'pending-cancel') {
        const after = await dialogueState(); assert.equal(after.status, 'idle'); assert.equal(after.messages.filter(message => message.role === 'assistant').length, 0);
        await closeChat(record);
      } else assert.equal(await dialogueState(), null);
      if (mode === 'pending-hide') {
        await main(() => __shizuku.action('show'));
        await avatar.waitForFunction(() => __diagnostics.visible);
        assert.equal(await dialogueState(), null);
      }
      record.aborted = true; record.lateReplyDiscarded = true;
    }
    await waitFor(() => main(() => !__shizuku.dialogue() && __shizuku.dialogueState() === null), 'Dialogue did not dispose after cycle.');
    assert.equal(chat, null); assert.equal(await main(() => __dailyProbe.ownedDialogue), null);
    assert.deepEqual(await bitmapCounts(), initialImages); assert.equal(await main(() => __dailyProbe.modelReads), initialReads);
    record.closed = await snapshot(); record.finishedAt = new Date().toISOString();
    await checkpoint(); progress('cycle-complete', { number: index + 1, mode });
  }
  await main(() => __shizuku.setDialogueReply(undefined));
  report.dialogueImages = { before: initialImages, after: await bitmapCounts(), modelReadsBefore: initialReads,
    modelReadsAfter: await main(() => __dailyProbe.modelReads) };
  report.checks.push('All 20 local dialogue openings start empty with voice off; close/cancel/hide discard pending results. Each old Page, BrowserWindow and WebContents is destroyed, only the avatar window remains, native references are released, and avatar images never re-decode.');
}
async function captureAvatar() {
  const image = await main(async () => {
    const captured = await __shizuku.avatar().webContents.capturePage(), pixels = captured.toBitmap(); let visible = 0, transparent = 0;
    for (let i = 3; i < pixels.length; i += 4) { if (pixels[i] === 0) transparent++; else visible++; }
    return { ...captured.getSize(), visible, transparent, png: captured.toPNG().toString('base64') };
  });
  assert.ok(image.visible > 100 && image.transparent > 100);
  await writeFile(path.join(directory, 'final-compact-avatar.png'), Buffer.from(image.png, 'base64'));
  delete image.png; report.finalAvatar = image;
}
async function recordGuards() {
  if (!app) return;
  Object.assign(report.network, await main(() => ({ mainFetchAttempts: globalThis.__dailyProbe?.mainFetchAttempts ?? 0,
    speechCalls: globalThis.__dailyProbe?.speechCalls ?? 0, localHeldCalls: globalThis.__dailyProbe?.localHeldCalls ?? 0 })));
}
async function closeApp({ normalQuit = false } = {}) {
  if (!app) return;
  try {
    await recordProcesses(); await recordGuards();
    await main(() => {
      if (globalThis.__dailyProbe) {
        const held = __dailyProbe.held; __dailyProbe.held = null; held?.resolve('検査を終了します。');
        __dailyProbe.ownedDialogue = null;
        process.getBuiltinModule('fs/promises').readFile = __dailyProbe.originalRead;
        // Keep the network guard active until this owned process exits.
      }
    });
  } catch { /* Preserve every identity recorded before a main/renderer failure. */ }
  const current = app;
  if (normalQuit) {
    const child = current.process();
    report.exit = { requestedAt: new Date().toISOString(), method: 'controls action quit', exitCode: null, signalCode: null };
    try {
      report.exit.beforeQuit = await main(() => ({ dialoguePresent: !!__shizuku.dialogue(), sessionAbsent: __shizuku.dialogueState() === null }));
      assert.deepEqual(report.exit.beforeQuit, { dialoguePresent: false, sessionAbsent: true });
      const evidence = await main(() => {
        __shizuku.action('quit');
        const state = __shizuku.dialogueState();
        return { dialogueDisposed: !__shizuku.dialogue() && (state === null || state === undefined),
          afterQuit: { dialoguePresent: !!__shizuku.dialogue(), sessionAbsent: state === null || state === undefined,
            sessionResult: state === undefined ? 'undefined (controller disposed)' : state === null ? 'null (no session)' : 'active session' } };
      });
      await waitFor(() => child.exitCode !== null || child.signalCode !== null, 'Normal quit did not terminate the app process.');
      Object.assign(report.exit, evidence, { exitCode: child.exitCode, signalCode: child.signalCode, finishedAt: new Date().toISOString() });
      assert.equal(report.exit.dialogueDisposed, true);
      assert.equal(child.exitCode, 0, 'Normal quit must exit successfully rather than disappear after a crash.');
      assert.equal(child.signalCode, null, 'Normal quit must not require a termination signal.');
    } catch (error) {
      Object.assign(report.exit, { exitCode: child.exitCode, signalCode: child.signalCode, error: error.message });
      throw error;
    }
  } else await current.close();
  // Preserve the handle if quitting/close rejects, allowing finally to retry
  // cleanup and inspect every recorded process instead of losing this app.
  app = null;
}

const heartbeat = setInterval(() => {
  if (performance.now() - lastNotice < 24_000) return;
  progress('heartbeat');
  void checkpoint().catch(error => { failure ??= error; aborted = true; });
}, 1000);

try {
  await checkpoint(); progress('launch', { directory, mode: plan.mode });
  app = await _electron.launch({ executablePath: electron, args: [root], cwd: root, env, timeout: 20_000 });
  pids.add(app.process().pid); avatar = await app.firstWindow(); avatar.setDefaultTimeout(15_000);
  await avatar.waitForFunction(() => window.__diagnostics?.loaded && window.__diagnostics.quiet && window.__diagnostics.textureQuality === 'original');
  report.versions = await main(() => process.versions);
  report.display = await main(({ screen }) => ({ count: screen.getAllDisplays().length, primary: { workArea: screen.getPrimaryDisplay().workArea, scaleFactor: screen.getPrimaryDisplay().scaleFactor } }));
  await installProbes(); report.initialSnapshot = await snapshot(); await checkpoint();
  await stablePhase('original-quiet', plan.originalMs, 'original', true);
  activePhase = 'compact-switch'; progress('quality-switch');
  await main(() => __shizuku.setTextureQuality('compact'));
  await avatar.waitForFunction(() => __diagnostics.loaded && __diagnostics.textureQuality === 'compact');
  report.compactLoaded = await diagnostic(); report.compactImages = await bitmapCounts();
  assert.equal(report.compactImages.failed, 0); assert.equal(report.compactImages.inFlight, 0);
  await stablePhase('compact-quiet', plan.compactMs, 'compact', true);
  await dialogueCycles();
  await stablePhase('compact-after-dialogue', plan.afterDialogueMs, 'compact', true);
  await captureAvatar();
  await main(() => __shizuku.action('hide')); await avatar.waitForFunction(() => !__diagnostics.visible);
  await stablePhase('hidden-after-dialogue', plan.hiddenMs, 'compact', false);
  await recordGuards();
  assert.equal(report.network.rendererHttpAttempts, 0); assert.equal(report.network.mainFetchAttempts, 0); assert.equal(report.network.speechCalls, 0);
  assert.equal(report.network.localHeldCalls, 12);
  report.checks.push('No observed renderer HTTP(S), main fetch or speech-provider calls occurred.');
  activePhase = 'exit'; progress('closing'); await closeApp({ normalQuit: true });
  report.checks.push('The app\'s normal quit action disposes dialogue and exits with code 0 and no termination signal.');
} catch (error) {
  failure = error; report.error = error instanceof Error ? error.stack : String(error);
} finally {
  try { await closeApp(); } catch (error) { failure ??= error; report.cleanupError = String(error); }
  for (const collector of collectors) if (!collector.closed) collector.process?.kill();
  for (let attempt = 0; attempt < 40; attempt++) {
    report.remainingPids = [...pids].filter(pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; } });
    if (!report.remainingPids.length) break;
    await delay(100);
  }
  try {
    report.userSettingsUnchanged = (await readFile(normal)).equals(before);
    report.modelAfter = await fileIdentity(config.modelPath); report.modelUnchanged = report.modelAfter.sha256 === report.modelBefore.sha256 && report.modelAfter.bytes === report.modelBefore.bytes;
    report.scriptAfter = await fileIdentity(fileURLToPath(import.meta.url)); report.scriptUnchanged = report.scriptAfter.sha256 === report.script.sha256;
    report.buildUnchanged = true;
    for (const [file, expected] of Object.entries(report.builtFiles)) if ((await fileIdentity(path.join(root, 'dist', file))).sha256 !== expected.sha256) report.buildUnchanged = false;
  } catch (error) { failure ??= error; report.identityCheckError = String(error); }
  if (aborted) failure ??= new Error('Daily-use check interrupted.');
  if (report.remainingPids.length || report.userSettingsUnchanged !== true || report.modelUnchanged !== true || report.buildUnchanged !== true || report.scriptUnchanged !== true) failure ??= new Error('Process, settings, model, build or script identity invariant failed.');
  if (!failure) report.checks.push('All recorded launcher, Electron, tracker and GPU collector processes exit; normal settings, selected model bytes, measured build hashes and the acceptance script remain unchanged.');
  report.status = failure ? 'failed' : 'passed'; report.functionalStatus = report.status;
  report.measurementStatus = report.phases.length === 4 && report.phases.every(item => item.measurementValid === true) ? 'valid' : 'incomplete';
  report.finishedAt = new Date().toISOString(); report.recordedPids = [...pids];
  clearInterval(heartbeat); await checkpoint(); process.off('SIGINT', abort); process.off('SIGTERM', abort);
  progress('finished', { status: report.status, directory, mode: plan.mode, cycles: report.cycles.length, remainingPids: report.remainingPids,
    measurementStatus: report.measurementStatus, userSettingsUnchanged: report.userSettingsUnchanged, modelUnchanged: report.modelUnchanged,
    buildUnchanged: report.buildUnchanged, scriptUnchanged: report.scriptUnchanged });
}
if (failure) throw failure;
