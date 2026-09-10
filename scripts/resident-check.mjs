// App/helper resource measurements. Fixture/test-driver CPU is excluded.
import { _electron } from 'playwright';
import electron from 'electron';
import { readFile, writeFile, mkdtemp, rename } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { cpus } from 'node:os';
import { spawn, execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import assert from 'node:assert/strict';
import { summarizeCompanionPhase } from '../src/soak-metrics.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const before = await readFile(path.join(root, 'local.config.json'));
const cfg = JSON.parse(before.toString().replace(/^\uFEFF/, ''));
const directory = await mkdtemp(path.join(root, 'work', 'resident-'));
const durationMs = Number(process.env.SHIZUKU_RESIDENT_SECONDS ?? 120) * 1000;
if (!Number.isSafeInteger(durationMs) || durationMs < 30_000 || durationMs > 3_600_000) throw new Error('Phase duration must be 30..3600 seconds.');
await writeFile(path.join(directory, 'local.config.json'), JSON.stringify({ modelPath: cfg.modelPath, quiet: false, scale: 100 }));
let app, page, fixture, failure, gpu, gpuDone;
let aborted = false;
const abort = () => { aborted = true; gpu?.kill(); };
process.on('SIGINT', abort); process.on('SIGTERM', abort);
const pids = new Set(), appPids = new Set();
const report = { status: 'running', directory, startedAt: new Date().toISOString(), durationMs, logicalProcessors: cpus().length,
  revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  dirty: !!execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim(),
  methodology: '2-second Playwright samples. Electron CPU from cumulative seconds; helper CPU from its own monotonic timestamps (1-second reports, endpoint skew disclosed). Memory sums process working sets/private bytes; shared pages may be counted twice. Total CPU is approximate because helper endpoint times differ. Test driver and separate fixture are excluded. GPU uses only recorded app/helper PIDs. This is a short run, not proof of all-day stability.',
  hashes: {}, phases: [], remainingPids: null, userSettingsUnchanged: null };
for (const file of ['main.cjs', 'renderer.js', 'window-tracker.exe']) report.hashes[file] = createHash('sha256').update(await readFile(path.join(root, 'dist', file))).digest('hex');
const checkpoint = async () => {
  await writeFile(path.join(directory, 'run.tmp.json'), JSON.stringify(report, null, 2));
  await rename(path.join(directory, 'run.tmp.json'), path.join(directory, 'run.json'));
};
const act = value => app.evaluate((_e, value) => globalThis.__shizuku.action(value), value);
async function snapshot() {
  if (aborted) throw new Error('Measurement interrupted; partial samples retained.');
  const sample = await app.evaluate(() => {
    const s = globalThis.__shizuku, status = s.status(), tracked = s.tracking();
    return { time: new Date().toISOString(), monotonicMs: performance.now(), visible: status.visible, loaded: status.modelLoaded,
      scale: status.scale, processes: s.metrics(), windowTracker: { pid: tracked.pid, ready: tracked.ready, stats: tracked.stats }, following: tracked.following?.state ?? null };
  });
  sample.diagnostics = await page.evaluate(() => ({ ...window.__diagnostics }));
  for (const p of sample.processes) { pids.add(p.pid); appPids.add(p.pid); }
  pids.add(sample.windowTracker.pid); appPids.add(sample.windowTracker.pid);
  return sample;
}
async function phase(name, visible, quiet, following = false) {
  await delay(2500); // Exclude visibility/pose/quiet transition frames.
  const item = { name, startedAt: new Date().toISOString(), samples: [] };
  report.phases.push(item); console.log(JSON.stringify({ phase: name, directory }));
  const start = performance.now(); let next = start, lastProgress = start;
  while (true) {
    await delay(Math.max(0, next - performance.now()));
    const s = await snapshot();
    assert.equal(s.diagnostics.quiet, quiet);
    if (following) assert.equal(s.following, 'following');
    item.samples.push(s);
    if (performance.now() - start >= durationMs) break;
    if (performance.now() - lastProgress >= 25000) { await checkpoint(); console.log(JSON.stringify({ phase: name, elapsed: Math.round((performance.now() - start) / 1000) })); lastProgress = performance.now(); }
    next = start + (Math.floor((performance.now() - start) / 2000) + 1) * 2000;
  }
  item.endedAt = new Date().toISOString();
  item.summary = summarizeCompanionPhase(item.samples, { logicalProcessors: report.logicalProcessors, visible });
  await checkpoint(); console.log(JSON.stringify({ phase: name, summary: item.summary }));
}
try {
  await checkpoint();
  app = await _electron.launch({ executablePath: electron, args: [root], cwd: root, env: { ...process.env, SHIZUKU_TEST: '1', SHIZUKU_TEST_DATA: path.basename(directory) } });
  pids.add(app.process().pid); page = await app.firstWindow(); await page.waitForFunction(() => window.__diagnostics?.loaded);
  report.versions = await app.evaluate(() => process.versions);
  await delay(15_000); await snapshot();
  await writeFile(path.join(directory, 'pids.json'), JSON.stringify([...appPids]));
  if (process.platform === 'win32') {
    gpu = spawn('pwsh.exe', ['-NoProfile', '-File', path.join(root, 'scripts', 'measure-gpu.ps1'), '-Samples', String(Math.min(1800, Math.ceil((durationMs * 4 + 60_000) / 2000))), '-PidsFile', path.join(directory, 'pids.json'), '-Output', path.join(directory, 'gpu.json')], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    if (gpu.pid) pids.add(gpu.pid);
    let output = ''; gpu.stdout.on('data', data => { output += data; }); gpu.stderr.resume();
    gpuDone = new Promise(resolve => { gpu.once('error', e => { report.gpuError = e.message; resolve(); }); gpu.once('close', code => { report.gpuExit = code; report.gpuOutput = output.trim(); resolve(); }); });
  }
  await phase('normal', true, false);
  await act('quiet'); await phase('quiet', true, true);
  // A fixture window is necessary only for this explicit follow phase.
  fixture = await _electron.launch({ executablePath: electron, args: [path.join(root, 'scripts', 'fixture.cjs')], cwd: root, env: { ...process.env, SHIZUKU_FIXTURE_INACTIVE: '1' } });
  pids.add(fixture.process().pid); await fixture.firstWindow();
  const target = await fixture.evaluate(({ BrowserWindow, app }) => {
    const w = BrowserWindow.getAllWindows()[0]; w.setBounds({ x: 500, y: 450, width: 650, height: 400 });
    w.showInactive(); return { handle: w.getNativeWindowHandle().readBigUInt64LE().toString(), pid: process.pid, pids: app.getAppMetrics().map(p => p.pid) };
  });
  target.pids.forEach(pid => pids.add(pid));
  await app.evaluate((_e, target) => globalThis.__shizuku.startFollowing(target), { handle: target.handle, pid: target.pid });
  await phase('quiet-follow', true, true, true);
  await act('hide'); await fixture.close(); fixture = null;
  await phase('hidden', false, true);
  await app.close(); app = null;
} catch (error) { failure = error; report.error = error.stack; }
finally {
  if (app) await app.close().catch(() => {});
  if (fixture) await fixture.close().catch(() => {});
  if (failure && gpu) gpu.kill();
  if (gpuDone) await gpuDone;
  if (aborted) failure ??= new Error('Measurement interrupted; partial samples retained.');
  for (let i = 0; i < 40 && [...pids].some(pid => { try { process.kill(pid, 0); return true; } catch { return false; } }); i++) await delay(100);
  report.remainingPids = [...pids].filter(pid => { try { process.kill(pid, 0); return true; } catch { return false; } });
  report.userSettingsUnchanged = (await readFile(path.join(root, 'local.config.json'))).equals(before);
  if (report.remainingPids.length || !report.userSettingsUnchanged) failure ??= new Error('Cleanup/settings invariant failed');
  try {
    const gpuSamples = JSON.parse((await readFile(path.join(directory, 'gpu.json'), 'utf8')).replace(/^\uFEFF/, ''));
    for (const item of report.phases) {
      // Counters describe the preceding 2-second interval; exclude the first interval.
      const values = gpuSamples.filter(s => Date.parse(s.time) >= Date.parse(item.startedAt) + 2000 && Date.parse(s.time) <= Date.parse(item.endedAt));
      const valid = values.filter(s => s.available);
      item.gpu = { samples: values.length, valid: valid.length, mean: valid.length ? valid.reduce((s, v) => s + v.busiestEnginePercent, 0) / valid.length : null, max: valid.length ? Math.max(...valid.map(v => v.busiestEnginePercent)) : null };
    }
  } catch (error) { report.gpuError = error.message; }
  report.status = failure ? 'failed' : 'passed'; report.finishedAt = new Date().toISOString(); await checkpoint();
  process.off('SIGINT', abort); process.off('SIGTERM', abort);
  console.log(JSON.stringify({ status: report.status, directory, remainingPids: report.remainingPids, userSettingsUnchanged: report.userSettingsUnchanged }));
}
if (failure) throw failure;
