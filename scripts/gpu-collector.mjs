import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { inspectProcessIdentities } from './process-check.mjs';
const exec = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function validateGpuRequest(pids, samples) {
  if (!Array.isArray(pids) || !pids.length || pids.length > 2048 || pids.some(pid => !Number.isSafeInteger(pid) || pid <= 0 || pid > 2147483647)) throw new Error('Expected 1–2048 positive Windows process IDs.');
  if (!Number.isSafeInteger(samples) || samples < 2 || samples > 1800) throw new Error('Samples must be an integer from 2 to 1800.');
  return { pids: [...new Set(pids)], samples };
}

export function summarizeGpuSamples(samples, { start = -Infinity, end = Infinity, completed = true } = {}) {
  const inRange = samples.filter(sample => Number.isFinite(Date.parse(sample.intervalStart)) && Number.isFinite(Date.parse(sample.time))
    && Date.parse(sample.intervalStart) >= start && Date.parse(sample.time) <= end && Date.parse(sample.intervalStart) < Date.parse(sample.time));
  const values = inRange.filter(sample => completed && sample.available === true && sample.invalidCounters === 0
    && Number.isFinite(sample.busiestEnginePercent) && sample.busiestEnginePercent >= 0 && sample.busiestEnginePercent <= 100)
    .map(sample => sample.busiestEnginePercent);
  return { samples: inRange.length, valid: values.length, unavailableSamples: inRange.length - values.length,
    mean: values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null,
    max: values.length ? Math.max(...values) : null };
}

export function classifyGpuPhases(phases, enabled = true) {
  if (!enabled) return 'disabled';
  if (phases.length === 4 && phases.every(phase => phase.gpu?.samples > 0 && phase.gpu.valid === phase.gpu.samples)) return 'valid';
  return phases.some(phase => phase.gpu?.valid > 0) ? 'partial' : 'unavailable';
}

export async function buildGpuHelper(directory) {
  if (process.platform !== 'win32') throw new Error('GPU collection requires Windows.');
  await mkdir(directory, { recursive: true });
  const source = path.join(root, 'native/GpuCounter.cs'), binary = path.join(directory, 'gpu-counter.exe');
  const sourceBefore = await readFile(source);
  const env = { ...process.env }; delete env.OPENAI_API_KEY;
  await exec(path.join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'),
    ['/nologo', '/target:winexe', '/platform:x64', '/optimize+', '/reference:System.Web.Extensions.dll', `/out:${binary}`, source],
    { env, windowsHide: true, timeout: 15_000, maxBuffer: 128 * 1024 });
  if (!sourceBefore.equals(await readFile(source))) throw new Error('GPU helper source changed during compilation.');
  return { binary, sourceSha256: createHash('sha256').update(sourceBefore).digest('hex') };
}

export async function startGpuCollector({ pids, samples, output }) {
  const request = validateGpuRequest(pids, samples);
  output = path.resolve(output); await mkdir(path.dirname(output), { recursive: true });
  const directory = await mkdtemp(path.join(path.dirname(output), 'gpu-worker-'));
  const build = await buildGpuHelper(directory);
  const input = path.join(directory, 'request.json');
  await writeFile(input, JSON.stringify({ ...request, parentPid: process.pid }));
  const env = { ...process.env }; delete env.OPENAI_API_KEY;
  const child = spawn(build.binary, [input], { env, windowsHide: true, stdio: 'ignore' });
  let exit, launchError, stoppedAt = null;
  child.once('error', error => { launchError = error.code || 'launch-failed'; });
  child.once('exit', (code, signal) => { exit = { code, signal }; });
  const stop = async () => { stoppedAt ??= Date.now(); await writeFile(path.join(directory, 'stop'), ''); };
  const done = (async () => {
    const deadline = Date.now() + samples * 2000 + 12_000;
    let forced = false, timedOut = false;
    while (!exit && !launchError) {
      if (Date.now() >= deadline || stoppedAt !== null && Date.now() - stoppedAt > 3000) {
        timedOut = stoppedAt === null; forced = true; child.kill();
        for (let i = 0; i < 20 && !exit; i++) await delay(50);
        child.unref(); break;
      }
      await delay(50);
    }
    let raw = [], stages = [], parseError;
    try {
      const lines = (await readFile(path.join(directory, 'samples.jsonl'), 'utf8')).trim();
      raw = lines ? lines.split('\n').map(line => JSON.parse(line)) : [];
    } catch { parseError = 'Samples missing or invalid'; }
    try { stages = (await readFile(path.join(directory, 'stages.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); } catch { /* Preserve launch/early failures. */ }
    let cleanup, cleanupError;
    try { cleanup = await inspectProcessIdentities([{ pid: child.pid, name: 'gpu-counter.exe', parentPid: process.pid }], directory); }
    catch { cleanupError = 'Worker cleanup could not be verified'; }
    const complete = !launchError && !parseError && !forced && stoppedAt === null && exit?.code === 0 && exit.signal === null
      && stages.some(item => item.stage === 'complete') && stages.some(item => item.stage === 'closed' && item.code === 0) && raw.length === samples
      && cleanup && cleanup.remainingPids.length === 0 && cleanup.unverifiablePids.length === 0;
    const status = complete ? 'completed' : timedOut || exit?.code === 4 ? 'timed-out' : stoppedAt !== null ? 'cancelled' : 'failed';
    const summary = summarizeGpuSamples(raw, { completed: complete });
    const result = { status, pid: child.pid, directory, sourceSha256: build.sourceSha256, requestedSamples: samples, exit, launchError, forced,
      parseError, cleanup, cleanupError, stages, summary,
      measurementStatus: !complete || !summary.valid ? 'unavailable' : summary.valid === samples ? 'available' : 'partial' };
    // Partial samples are retained, but callers must also require completed.
    await writeFile(output, JSON.stringify(raw, null, 2));
    await writeFile(`${output}.metadata.json`, JSON.stringify(result, null, 2));
    return result;
  })();
  return { pid: child.pid, directory, stop, done };
}
