// Own-process lifecycle acceptance; no Electron, model, AI or OS input needed.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir, mkdtemp } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startGpuCollector } from './gpu-collector.mjs';
import { inspectProcessIdentities } from './process-check.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
await mkdir(path.join(root, 'work'), { recursive: true });
const directory = await mkdtemp(path.join(root, 'work/gpu-check-'));
const report = { status: 'running', checks: [] }; let collector, parent;
async function waitFor(check, label) {
  for (let i = 0; i < 200; i++) { if (await check()) return; await delay(50); }
  throw new Error(label);
}
try {
  collector = await startGpuCollector({ pids: [process.pid], samples: 2, output: path.join(directory, 'empty.json') });
  report.empty = await collector.done;
  assert.equal(report.empty.status, 'completed'); assert.equal(report.empty.measurementStatus, 'unavailable');
  assert.equal(report.empty.summary.mean, null); assert.equal(report.empty.summary.valid, 0);
  report.checks.push('A live Node process without a GPU instance yields unavailable, not zero.');
  collector = await startGpuCollector({ pids: [2147483647], samples: 2, output: path.join(directory, 'missing.json') });
  report.missing = await collector.done;
  assert.equal(report.missing.status, 'failed'); assert.equal(report.missing.summary.mean, null);
  assert.deepEqual(report.missing.cleanup.remainingPids, []);
  report.checks.push('A missing target fails promptly and releases its worker.');
  collector = await startGpuCollector({ pids: [process.pid], samples: 60, output: path.join(directory, 'cancelled.json') });
  await waitFor(async () => (await readFile(path.join(collector.directory, 'stages.jsonl'), 'utf8').catch(() => '')).includes('sampling'), 'Worker did not reach sampling');
  await collector.stop(); report.cancelled = await collector.done;
  assert.equal(report.cancelled.status, 'cancelled'); assert.equal(report.cancelled.forced, false);
  assert.equal(report.cancelled.measurementStatus, 'unavailable'); assert.deepEqual(report.cancelled.cleanup.remainingPids, []);
  assert.ok(report.cancelled.stages.some(item => item.stage === 'closed' && item.code === 0));
  report.checks.push('Explicit cancellation closes the PDH query and exits without forced termination.');
  const env = { ...process.env }; delete env.OPENAI_API_KEY;
  parent = spawn(process.execPath, [path.join(root, 'scripts/fixtures/gpu-parent.mjs'), directory], { env, windowsHide: true, stdio: 'ignore' });
  let parentExit; parent.once('exit', (code, signal) => { parentExit = { code, signal }; });
  parent.once('error', () => { parentExit = { code: -1, signal: null }; });
  let worker;
  await waitFor(async () => { try { worker = JSON.parse(await readFile(path.join(directory, 'parent-worker.json'), 'utf8')); return true; } catch { return false; } }, 'Parent fixture did not launch');
  await waitFor(async () => (await readFile(path.join(worker.directory, 'stages.jsonl'), 'utf8').catch(() => '')).includes('sampling'), 'Parent fixture worker did not start');
  await writeFile(path.join(directory, 'exit-parent'), '');
  await waitFor(() => parentExit, 'Fixture parent did not exit');
  assert.deepEqual(parentExit, { code: 0, signal: null });
  await delay(500);
  report.parentLoss = await inspectProcessIdentities([
    { pid: worker.pid, name: 'gpu-counter.exe', parentPid: parent.pid },
    { pid: parent.pid, name: path.basename(process.execPath), parentPid: process.pid },
  ], directory);
  assert.deepEqual(report.parentLoss.remainingPids, []); assert.deepEqual(report.parentLoss.unverifiablePids, []);
  report.checks.push('A running worker exits when its sacrificial parent exits, without requiring that parent to run cleanup.');
  report.status = 'passed';
} catch (error) { report.status = 'failed'; report.error = error.message; }
finally {
  if (collector) { await collector.stop(); await collector.done; }
  if (parent && parent.exitCode === null) { await writeFile(path.join(directory, 'exit-parent'), ''); await delay(1000); if (parent.exitCode === null) parent.kill(); }
  await writeFile(path.join(directory, 'result.json'), JSON.stringify(report, null, 2));
}
console.log(JSON.stringify({ directory, status: report.status, checks: report.checks }));
if (report.status !== 'passed') process.exitCode = 1;
