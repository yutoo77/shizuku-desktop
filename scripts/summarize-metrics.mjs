import { readFile, writeFile } from 'node:fs/promises';
import { availableParallelism } from 'node:os';

const read = async file => JSON.parse((await readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
const WARMUP_MS = 10_000;
const COVERAGE_TOLERANCE_MS = 5_000; // The app records every two seconds.
const MAX_SAMPLE_GAP_MS = 10_000;
const cpuOverride = process.env.SHIZUKU_CPU_COUNT;
const cores = cpuOverride === undefined ? availableParallelism() : Number(cpuOverride);
if (!Number.isSafeInteger(cores) || cores < 1 || (cpuOverride !== undefined && !/^\d+$/.test(cpuOverride))) {
  throw new Error('SHIZUKU_CPU_COUNT must be a positive integer logical processor count.');
}
const cpuCountSource = cpuOverride === undefined ? 'os.availableParallelism (same measurement host)' : 'SHIZUKU_CPU_COUNT';
const samples = await read('work/metrics.json');
const periods = await read('work/measurement-periods.json');
if (!Array.isArray(samples) || samples.length < 2) throw new Error('metrics.json needs at least two samples.');

function timestamp(value, label) {
  const parsed = typeof value === 'string' ? Date.parse(value) : NaN;
  if (!Number.isFinite(parsed)) throw new Error(`${label} must be a valid timestamp.`);
  return parsed;
}
const phases = Object.fromEntries(['visible', 'hidden'].map(name => {
  const start = timestamp(periods[`${name}Start`], `${name}Start`);
  const end = timestamp(periods[`${name}End`], `${name}End`);
  if (end <= start + WARMUP_MS) throw new Error(`${name} period must exceed the 10-second warmup.`);
  return [name, { start, afterWarmup: start + WARMUP_MS, end }];
}));
if (phases.hidden.start < phases.visible.end) throw new Error('Visible and hidden measurement periods must be ordered and non-overlapping.');

let previousTime = -Infinity;
const timedSamples = samples.map((sample, index) => {
  const time = timestamp(sample?.time, `metrics[${index}].time`);
  if (time <= previousTime) throw new Error(`metrics timestamps must strictly increase (sample ${index}).`);
  previousTime = time;
  return { sample, time, index };
});

function stats(data, mean) {
  if (!data.length || !data.every(Number.isFinite) || (mean !== undefined && !Number.isFinite(mean))) throw new Error('Cannot summarize empty or nonfinite measurements.');
  return { mean: mean ?? data.reduce((a, b) => a + b, 0) / data.length,
    min: Math.min(...data), max: Math.max(...data), samples: data.length };
}
const finiteNonnegative = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const identity = process => `${process.pid}:${process.creationTime}`;
const identities = row => row.processes.map(identity).sort().join('|');
function validProcesses(processes) {
  return Array.isArray(processes) && processes.length > 0
    && processes.every(process => process && Number.isSafeInteger(process.pid) && process.pid > 0
      && finiteNonnegative(process.creationTime)
      && finiteNonnegative(process.cpu?.cumulativeCPUUsage)
      && finiteNonnegative(process.memory?.workingSetSize)
      && finiteNonnegative(process.memory?.privateBytes))
    && new Set(processes.map(identity)).size === processes.length;
}

function summarize(name) {
  const phase = phases[name];
  const visible = name === 'visible';
  if (timedSamples[0].time > phase.afterWarmup + COVERAGE_TOLERANCE_MS
    || timedSamples.at(-1).time < phase.end - COVERAGE_TOLERANCE_MS) {
    throw new Error(`${name}: metrics.json is stale or does not cover this measurement period. Exit the measured app normally to flush its current samples.`);
  }
  const excluded = { outsidePeriod: 0, warmup: 0, wrongVisibility: 0, notLoaded: 0, invalidProcesses: 0, cpuIntervalsWithGap: 0, cpuIntervalsAcrossExcludedRows: 0 };
  const rows = [];
  for (const row of timedSamples) {
    if (row.time < phase.start || row.time > phase.end) { excluded.outsidePeriod++; continue; }
    if (row.time < phase.afterWarmup) { excluded.warmup++; continue; }
    if (row.sample.visible !== visible) { excluded.wrongVisibility++; continue; }
    if (Object.hasOwn(row.sample, 'loaded') && row.sample.loaded !== true) { excluded.notLoaded++; continue; }
    if (!validProcesses(row.sample.processes)) { excluded.invalidProcesses++; continue; }
    rows.push(row);
  }
  if (rows.length < 2) throw new Error(`${name}: not enough valid loaded samples: ${JSON.stringify(excluded)}`);
  if (rows[0].time > phase.afterWarmup + COVERAGE_TOLERANCE_MS || rows.at(-1).time < phase.end - COVERAGE_TOLERANCE_MS) {
    throw new Error(`${name}: valid samples do not cover the expected period after warmup.`);
  }
  if (excluded.wrongVisibility > 0) throw new Error(`${name}: visibility changed inside the declared measurement period.`);
  const processIdentities = identities(rows[0].sample);
  if (rows.some(row => identities(row.sample) !== processIdentities)) {
    throw new Error(`${name}: process pid/creationTime identities changed; repeat a stable measurement period.`);
  }
  const cpu = [];
  let totalCpuSeconds = 0;
  let cpuDurationSeconds = 0;
  for (let index = 1; index < rows.length; index++) {
    const a = rows[index - 1], b = rows[index];
    if (b.index !== a.index + 1) { excluded.cpuIntervalsAcrossExcludedRows++; continue; }
    if (b.time - a.time > MAX_SAMPLE_GAP_MS) { excluded.cpuIntervalsWithGap++; continue; }
    const elapsed = (b.time - a.time) / 1000;
    let seconds = 0;
    for (const process of b.sample.processes) {
      const prior = a.sample.processes.find(value => identity(value) === identity(process));
      const delta = process.cpu.cumulativeCPUUsage - prior.cpu.cumulativeCPUUsage;
      if (!finiteNonnegative(delta)) throw new Error(`${name}: cumulative CPU time decreased or became invalid.`);
      seconds += delta;
    }
    cpu.push(seconds / elapsed / cores * 100);
    totalCpuSeconds += seconds;
    cpuDurationSeconds += elapsed;
  }
  const memory = key => rows.map(row => row.sample.processes.reduce((sum, process) => sum + process.memory[key], 0) / 1024);
  return {
    start: rows[0].sample.time, end: rows.at(-1).sample.time,
    durationSeconds: (rows.at(-1).time - rows[0].time) / 1000,
    requestedDurationSeconds: (phase.end - phase.start) / 1000,
    warmupSeconds: WARMUP_MS / 1000,
    cpuDurationSeconds, totalCpuSeconds,
    cpuPercentOfPC: stats(cpu, totalCpuSeconds / cpuDurationSeconds / cores * 100),
    workingSetMiB: stats(memory('workingSetSize')),
    privateMiB: stats(memory('privateBytes')),
    processIdentities, memorySamples: rows.length,
    samplesWithoutLoadedFlag: rows.filter(row => !Object.hasOwn(row.sample, 'loaded')).length,
    excluded,
  };
}

function summarizeGpu(raw, name) {
  if (!Array.isArray(raw)) throw new Error(`${name} GPU samples must be an array.`);
  const phase = phases[name];
  const excluded = { outsidePeriod: 0, warmup: 0, invalidTimestamp: 0, unavailable: 0, invalidValue: 0, outOfRange: 0 };
  const rows = [];
  let priorTime = -Infinity;
  for (const sample of raw) {
    const time = typeof sample?.time === 'string' ? Date.parse(sample.time) : NaN;
    if (!Number.isFinite(time)) { excluded.invalidTimestamp++; continue; }
    if (time <= priorTime) throw new Error(`${name}: GPU timestamps must strictly increase.`);
    priorTime = time;
    if (time < phase.start || time > phase.end) { excluded.outsidePeriod++; continue; }
    if (time < phase.afterWarmup) { excluded.warmup++; continue; }
    const engines = sample.engines && typeof sample.engines === 'object' ? Object.values(sample.engines) : [];
    if ((sample.available !== undefined && sample.available !== true) || !engines.length) { excluded.unavailable++; continue; }
    if (!finiteNonnegative(sample.busiestEnginePercent) || !engines.every(finiteNonnegative)) { excluded.invalidValue++; continue; }
    if (sample.busiestEnginePercent > 100 || engines.some(value => value > 100)) { excluded.outOfRange++; continue; }
    rows.push({ sample, time });
  }
  if (rows.length < 2) throw new Error(`${name}: not enough valid GPU samples for the expected period: ${JSON.stringify(excluded)}`);
  return { ...stats(rows.map(row => row.sample.busiestEnginePercent)),
    start: rows[0].sample.time, end: rows.at(-1).sample.time,
    durationSeconds: (rows.at(-1).time - rows[0].time) / 1000,
    warmupSeconds: WARMUP_MS / 1000,
    samplesWithoutAvailableFlag: rows.filter(row => row.sample.available === undefined).length,
    excluded };
}

const visible = summarize('visible');
const hidden = summarize('hidden');
if (visible.processIdentities !== hidden.processIdentities) {
  throw new Error('Visible and hidden process identities differ; compare phases with the same app processes.');
}
const summary = {
  cores, cpuCountSource,
  methodology: {
    cpu: 'Time-weighted cumulative CPU seconds / measured interval seconds / logical processor count × 100. Auto detection assumes this is the measurement host; set SHIZUKU_CPU_COUNT explicitly when processing data from another host.',
    memory: 'Sum of process KiB converted to MiB. Working Set can double-count shared pages; Private Bytes is allocated private memory, not resident RAM.',
    gpu: 'Maximum app-attributed physical engine utilization per sample. Range violations are excluded, not clamped. GPU sampling may cover a shorter subset of each CPU measurement period.',
  },
  visible, hidden,
  visibleGpuPercent: summarizeGpu(await read('work/gpu-visible-final.json'), 'visible'),
  hiddenGpuPercent: summarizeGpu(await read('work/gpu-hidden-final.json'), 'hidden'),
  diagnostics: periods.finalDiagnostics,
};
await writeFile('work/performance-summary.json', JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
