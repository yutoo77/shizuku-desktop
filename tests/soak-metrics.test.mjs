import assert from 'node:assert/strict';
import test from 'node:test';
import { summarizeSoakPhase } from '../src/soak-metrics.mjs';

const options = { logicalProcessors: 4, visible: true };
function row(ms, cpu, frames, extra = {}) {
  return {
    time: new Date(1_700_000_000_000 + ms).toISOString(), monotonicMs: ms,
    visible: true, loaded: true, scale: 100,
    diagnostics: { visible: true, loaded: true, moving: false, reacting: false, reducedMotion: false, fps: 25, renderedFrames: frames },
    processes: [
      { pid: 10, creationTime: 10, cpu: { cumulativeCPUUsage: cpu }, memory: { workingSetSize: 1024, privateBytes: 512 } },
      { pid: 20, creationTime: 20, cpu: { cumulativeCPUUsage: 1 }, memory: { workingSetSize: 2048, privateBytes: 1536 } },
    ], ...extra,
  };
}
const rows = () => [row(0, 1, 0), row(2000, 3, 50), row(8000, 6, 200)];

test('soak CPU uses cumulative time and time weighting with explicit logical processors', () => {
  const result = summarizeSoakPhase(rows(), options);
  assert.equal(result.cpuPercentOfPC.mean, 15.625);
  assert.equal(result.cpuPercentOfPC.min, 12.5);
  assert.equal(result.cpuPercentOfPC.max, 25);
  assert.equal(result.totalCpuSeconds, 5);
  assert.equal(result.durationSeconds, 8);
  assert.equal(result.workingSetMiB.mean, 3);
  assert.equal(result.privateMiB.mean, 2);
  assert.equal(result.workingSetMiB.change, 0);
  assert.equal(result.observedFps, 25);
  assert.equal(result.processCount, 2);
});

test('hidden phase keeps frames still and can report a measured zero CPU delta', () => {
  const samples = [row(0, 1, 80), row(2000, 1, 80)].map(sample => ({
    ...sample, visible: false, diagnostics: { ...sample.diagnostics, visible: false, fps: 0 },
  }));
  const result = summarizeSoakPhase(samples, { ...options, visible: false });
  assert.equal(result.cpuPercentOfPC.mean, 0);
  assert.equal(result.observedFps, 0);
  samples[1].diagnostics.renderedFrames++;
  assert.throws(() => summarizeSoakPhase(samples, { ...options, visible: false }), /Rendering/);
});

test('missing and nonfinite metrics never become zero load', () => {
  for (const value of [undefined, null, NaN, Infinity, -1]) {
    for (const [group, key] of [['cpu', 'cumulativeCPUUsage'], ['memory', 'workingSetSize'], ['memory', 'privateBytes']]) {
      const samples = rows();
      samples[1].processes[0][group][key] = value;
      assert.throws(() => summarizeSoakPhase(samples, options), /invalid process/);
    }
  }
  assert.throws(() => summarizeSoakPhase([], options), /two samples/);
  for (const logicalProcessors of [0, NaN, null, '4', 2.5]) {
    assert.throws(() => summarizeSoakPhase(rows(), { ...options, logicalProcessors }), TypeError);
  }
});

test('phase mixing, process restart and CPU reset invalidate comparisons', () => {
  for (const mutate of [
    sample => { sample.visible = false; },
    sample => { sample.loaded = false; },
    sample => { sample.scale = 80; },
    sample => { sample.diagnostics.reacting = true; },
    sample => { sample.diagnostics.reducedMotion = true; },
    sample => { sample.processes[0].creationTime++; },
    sample => { sample.processes.pop(); },
    sample => { sample.processes.push(sample.processes[0]); },
    sample => { sample.processes[0].cpu.cumulativeCPUUsage = 0; },
  ]) {
    const samples = rows(); mutate(samples[1]);
    assert.throws(() => summarizeSoakPhase(samples, options));
  }
});

test('time gaps, stopped frames and impossible CPU capacity fail explicitly', () => {
  const samples = rows();
  assert.throws(() => summarizeSoakPhase(samples, { ...options, maxGapMs: 5000 }), /gap/);
  samples[1].monotonicMs = 0;
  assert.throws(() => summarizeSoakPhase(samples, options), /timestamps/);
  const frozen = rows(); frozen[1].diagnostics.renderedFrames = 0;
  assert.throws(() => summarizeSoakPhase(frozen, options), /Rendering/);
  const impossible = rows(); impossible[1].processes[0].cpu.cumulativeCPUUsage = 100;
  assert.throws(() => summarizeSoakPhase(impossible, options), /processor capacity/);
});
