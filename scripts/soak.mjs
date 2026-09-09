// Windows Electron endurance check. Does not drive physical mouse/keyboard input.
import { _electron } from 'playwright';
import electron from 'electron';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rename, writeFile } from 'node:fs/promises';
import { cpus } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { summarizeSoakPhase } from '../src/soak-metrics.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const work = path.join(root, 'work');
const plan = { warmupMs: 20_000, visibleMs: 300_000, hiddenMs: 60_000, sampleIntervalMs: 2000, cycles: 15 };
const logicalProcessors = cpus().length;
assert.ok(Number.isSafeInteger(logicalProcessors) && logicalProcessors > 0);
const userConfigPath = path.join(root, 'local.config.json');
const userConfigBefore = await readFile(userConfigPath);
const userConfig = JSON.parse(userConfigBefore.toString('utf8').replace(/^\uFEFF/, ''));
assert.equal(typeof userConfig.modelPath, 'string', 'Choose a usable local VRM with npm start before running the endurance check.');
assert.ok(userConfig.modelPath, 'Choose a usable local VRM with npm start before running the endurance check.');
await mkdir(work, { recursive: true });
const directory = await mkdtemp(path.join(work, 'soak-'));
await writeFile(path.join(directory, 'local.config.json'), JSON.stringify({ modelPath: userConfig.modelPath, scale: 100 }));
const reportPath = path.join(directory, 'run.json');
const activePath = path.join(work, 'soak-active.json');
async function fileIdentity(file) {
  const bytes = await readFile(file);
  return { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
}
const report = {
  schemaVersion: 1, status: 'running', startedAt: new Date().toISOString(), directory,
  revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  workingTreeDirty: !!execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim(),
  builtMainSha256: createHash('sha256').update(await readFile(path.join(root, 'dist', 'main.cjs'))).digest('hex'),
  builtRendererSha256: createHash('sha256').update(await readFile(path.join(root, 'dist', 'renderer.js'))).digest('hex'),
  modelFile: await fileIdentity(userConfig.modelPath),
  logicalProcessors, cpuCountSource: 'os.cpus().length on the measurement host', plan,
  methodology: {
    cpu: 'Sum of app-process cumulativeCPUUsage deltas in seconds / monotonic elapsed seconds / logical processor count * 100; time-weighted whole-PC percentage. Raw percentCPUUsage is retained but not used.',
    memory: 'Sum of process memory KiB divided by 1024. Working Set can double-count shared pages; Private Bytes is allocated private memory, not resident RAM. Means are per-sample averages.',
    phases: 'Startup warmup is excluded. Visible idle and hidden idle are summarized separately. Functional cycles retain snapshots but are not treated as a stable workload or added to idle means.',
    overhead: 'Playwright queries the main process and own renderer every two seconds. No desktop capture or physical input; the Node test driver is outside app process totals.',
    sources: ['https://www.electronjs.org/docs/latest/api/structures/cpu-usage', 'https://www.electronjs.org/docs/latest/api/structures/memory-info'],
  },
  phases: [], cycles: [], checks: [], remainingPids: null, userSettingsUnchanged: null,
};
let application;
let page;
let phase = 'launch';
let failure;
let abortRequested = false;
const pids = new Set();
const abort = () => { abortRequested = true; console.log(JSON.stringify({ event: 'stopping', reason: 'interrupt', time: new Date().toISOString() })); };
process.on('SIGINT', abort);
process.on('SIGTERM', abort);
const checkAbort = () => { if (abortRequested) throw new Error('Endurance check interrupted; partial measurements are retained.'); };
const atomicJson = async (file, value) => {
  const temporary = `${file}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2));
  await rename(temporary, file);
};
const progress = (event, extra = {}) => console.log(JSON.stringify({ event, phase, time: new Date().toISOString(), ...extra }));
const checkpoint = async () => {
  await atomicJson(reportPath, report);
  await atomicJson(path.join(directory, 'pids.json'), [...pids]);
  await atomicJson(activePath, { directory, reportPath, phase, time: new Date().toISOString(), pids: [...pids], status: report.status, plan });
};
const inspect = fn => application.evaluate(fn);
async function snapshot() {
  checkAbort();
  const sample = await inspect(() => {
    const state = globalThis.__shizuku;
    const processes = state.metrics();
    const status = state.status();
    return {
      time: new Date().toISOString(), monotonicMs: performance.now(),
      visible: status.visible, loaded: status.modelLoaded, scale: status.scale,
      bounds: state.avatar().getBounds(), focused: state.avatar().isFocused(),
      focusable: state.avatar().isFocusable(), processes,
    };
  });
  sample.diagnostics = await page.evaluate(() => ({ ...window.__diagnostics }));
  assert.ok(Array.isArray(sample.processes) && sample.processes.length, 'App process metrics must be available.');
  for (const process of sample.processes) {
    assert.ok(Number.isSafeInteger(process.pid) && process.pid > 0, 'App process identifiers must be valid.');
    pids.add(process.pid);
  }
  assert.equal(sample.loaded, true, 'Model must stay loaded throughout the check.');
  assert.equal(sample.focusable, false, 'Avatar must remain nonfocusable.');
  assert.equal(sample.focused, false, 'Avatar must not report itself focused. This is not proof of external app focus.');
  return sample;
}
async function stablePhase(name, durationMs, visible, summarize) {
  phase = name;
  const phaseRecord = { name, requestedDurationMs: durationMs, startedAt: new Date().toISOString(), samples: [] };
  report.phases.push(phaseRecord);
  await checkpoint();
  progress('phase-start', { durationMs });
  const started = performance.now();
  let nextSample = started;
  let lastProgress = started;
  while (true) {
    checkAbort();
    await delay(Math.max(0, nextSample - performance.now()));
    const sample = await snapshot();
    phaseRecord.samples.push(sample);
    assert.equal(sample.visible, visible);
    assert.equal(sample.scale, 100);
    assert.equal(sample.bounds.width, 300);
    assert.equal(sample.bounds.height, 440);
    const elapsed = performance.now() - started;
    if (elapsed >= durationMs) break;
    if (performance.now() - lastProgress >= 24_000) {
      await checkpoint();
      progress('progress', { elapsedSeconds: Math.round(elapsed / 1000), samples: phaseRecord.samples.length, fps: sample.diagnostics.fps });
      lastProgress = performance.now();
    }
    // Skip a missed slot rather than overlap calls or burst to catch up.
    nextSample = started + (Math.floor((performance.now() - started) / plan.sampleIntervalMs) + 1) * plan.sampleIntervalMs;
  }
  phaseRecord.endedAt = new Date().toISOString();
  if (summarize) {
    phaseRecord.summary = summarizeSoakPhase(phaseRecord.samples, { logicalProcessors, visible });
    assert.ok(phaseRecord.summary.durationSeconds >= durationMs / 1000 - 0.25, 'Samples must cover the requested period.');
  }
  await checkpoint();
  progress('phase-complete', { samples: phaseRecord.samples.length, summary: phaseRecord.summary });
  return phaseRecord;
}

try {
  await checkpoint();
  progress('start', { directory, reportPath, plan });
  application = await _electron.launch({ executablePath: electron, args: [root], cwd: root,
    env: { ...process.env, SHIZUKU_TEST: '1', SHIZUKU_TEST_DATA: path.basename(directory), SHIZUKU_METRICS: '0' } });
  const mainPid = application.process().pid;
  assert.ok(Number.isSafeInteger(mainPid) && mainPid > 0);
  pids.add(mainPid);
  page = await application.firstWindow();
  await page.waitForFunction(() => window.__diagnostics?.loaded, null, { timeout: 20_000 });
  report.versions = await inspect(() => process.versions);
  report.display = await application.evaluate(({ screen }) => {
    const primary = screen.getPrimaryDisplay();
    return { workArea: primary.workArea, scaleFactor: primary.scaleFactor };
  });
  assert.equal(await inspect(() => globalThis.__shizuku.controls()), null, 'No controls window belongs in the steady workload.');
  await page.waitForFunction(() => window.__diagnostics.visible && innerWidth === 300 && innerHeight === 440);
  await stablePhase('warmup', plan.warmupMs, true, false);
  const visible = await stablePhase('visible', plan.visibleMs, true, true);
  report.checks.push('Standard-size loaded idle rendering remained alive for the complete five-minute visible phase.');

  await inspect(() => globalThis.__shizuku.setVisible(false));
  await page.waitForFunction(() => !window.__diagnostics.visible && !window.__diagnostics.animating);
  await delay(250); // Exclude the visibility transition from the hidden baseline.
  const hidden = await stablePhase('hidden', plan.hiddenMs, false, true);
  assert.equal(hidden.summary.processIdentities, visible.summary.processIdentities, 'Compare idle phases with the same process identities.');
  report.checks.push('The same app processes remained alive while hidden; no frames were rendered during the complete one-minute phase.');

  phase = 'cycles';
  await checkpoint();
  progress('phase-start', { cycles: plan.cycles });
  await inspect(() => globalThis.__shizuku.setVisible(true));
  await page.waitForFunction(n => window.__diagnostics.visible && window.__diagnostics.renderedFrames > n,
    hidden.summary.renderedFrames.last);
  for (let cycle = 1; cycle <= plan.cycles; cycle++) {
    checkAbort();
    const record = { cycle, startedAt: new Date().toISOString(), sizes: [] };
    report.cycles.push(record);
    await inspect(() => globalThis.__shizuku.action('call'));
    await page.waitForFunction(() => window.__diagnostics.reacting, null, { timeout: 2000 });
    await page.waitForFunction(() => !window.__diagnostics.reacting && window.__diagnostics.reactionProgress === 1,
      null, { timeout: 4000 });
    await inspect(() => globalThis.__shizuku.setVisible(false));
    await page.waitForFunction(() => !window.__diagnostics.visible && !window.__diagnostics.animating && !window.__diagnostics.reacting);
    const frames = await page.evaluate(() => window.__diagnostics.renderedFrames);
    await delay(250);
    assert.equal(await page.evaluate(() => window.__diagnostics.renderedFrames), frames);
    await inspect(() => globalThis.__shizuku.setVisible(true));
    await page.waitForFunction(n => window.__diagnostics.visible && window.__diagnostics.renderedFrames > n, frames);
    for (const [scale, width, height] of [[80, 240, 352], [120, 360, 528], [100, 300, 440]]) {
      await application.evaluate((_electron, value) => globalThis.__shizuku.setScale(value), scale);
      await page.waitForFunction(size => innerWidth === size.width && innerHeight === size.height, { width, height });
      await delay(75);
      const resized = await snapshot();
      assert.equal(resized.scale, scale);
      assert.equal(resized.bounds.width, width);
      assert.equal(resized.bounds.height, height);
      assert.equal(resized.diagnostics.loaded, true);
      assert.equal(resized.diagnostics.moving, false);
      assert.equal(resized.diagnostics.reacting, false);
      record.sizes.push(resized);
    }
    record.endedAt = new Date().toISOString();
    await checkpoint();
    progress('cycle-complete', { cycle, total: plan.cycles });
  }
  report.checks.push('Fifteen consecutive call/hide/show cycles completed; hidden frames stopped and all three sizes rendered each time.');
  phase = 'quit';
  await checkpoint();
  const closed = application.waitForEvent('close', { timeout: 15_000 });
  await inspect(() => globalThis.__shizuku.trayMenu().items.find(item => item.label === '終了').click());
  await closed;
  application = null;
  report.checks.push('The actual Electron tray exit callback completed normal app shutdown.');
} catch (error) {
  failure = error;
  report.error = { phase, message: error instanceof Error ? error.message : String(error) };
} finally {
  if (application) {
    try { await application.close(); }
    catch (error) {
      report.cleanupError = error instanceof Error ? error.message : String(error);
      failure ??= error;
    }
  }
  for (let attempt = 0; attempt < 20; attempt++) {
    report.remainingPids = [...pids].filter(pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; } });
    if (!report.remainingPids.length) break;
    await delay(250);
  }
  try { report.userSettingsUnchanged = (await readFile(userConfigPath)).equals(userConfigBefore); }
  catch (error) { report.settingsReadError = error instanceof Error ? error.message : String(error); }
  if (report.remainingPids.length) failure ??= new Error('Recorded app processes remain after exit.');
  if (report.userSettingsUnchanged !== true) failure ??= new Error('The normal user configuration changed during the check.');
  if (!failure) report.checks.push('All recorded app processes exited; normal user configuration stayed byte-for-byte unchanged.');
  report.status = failure ? 'failed' : 'passed';
  report.finishedAt = new Date().toISOString();
  phase = 'complete';
  await checkpoint();
  process.off('SIGINT', abort);
  process.off('SIGTERM', abort);
  progress('complete', { status: report.status, reportPath, checks: report.checks, remainingPids: report.remainingPids, userSettingsUnchanged: report.userSettingsUnchanged });
}
if (failure) throw failure;
