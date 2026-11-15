import test from 'node:test';
import assert from 'node:assert/strict';
import { validateGpuRequest, summarizeGpuSamples, classifyGpuPhases } from '../scripts/gpu-collector.mjs';
const sample = (value, extra = {}) => ({ intervalStart: '2026-09-13T00:00:00Z', time: '2026-09-13T00:00:02Z', available: true, invalidCounters: 0, busiestEnginePercent: value, ...extra });

test('GPU input rejects arbitrary paths/strings, invalid PIDs and unbounded runs', () => {
  for (const ids of [[], ['12'], [0], [-1], [1.5], [2147483648], Array(2049).fill(1)]) assert.throws(() => validateGpuRequest(ids, 2));
  for (const count of [0, 1, 2.5, 1801, NaN, '2']) assert.throws(() => validateGpuRequest([12], count));
  assert.deepEqual(validateGpuRequest([12, 12, 13], 2), { pids: [12, 13], samples: 2 });
});
test('a missing or invalid GPU counter is never converted to a measured zero', () => {
  const rows = [sample(null, { available: false }), sample(0, { available: false }), sample(NaN), sample(-1), sample(101), sample(Infinity), sample(1, { invalidCounters: 1 })];
  assert.deepEqual(summarizeGpuSamples(rows), { samples: 7, valid: 0, unavailableSamples: 7, mean: null, max: null });
});
test('real zero and nonzero GPU samples remain distinct from unavailable samples', () => {
  assert.deepEqual(summarizeGpuSamples([sample(0), sample(4), sample(null, { available: false })]),
    { samples: 3, valid: 2, unavailableSamples: 1, mean: 2, max: 4 });
});
test('cancelled or failed collectors cannot publish an average from partial samples', () => {
  assert.deepEqual(summarizeGpuSamples([sample(4)], { completed: false }),
    { samples: 1, valid: 0, unavailableSamples: 1, mean: null, max: null });
});
test('GPU intervals crossing a phase boundary or with invalid timestamps are excluded', () => {
  const rows = [sample(2), sample(99, { intervalStart: '2026-09-12T23:59:59Z' }), sample(99, { time: '2026-09-13T00:00:03Z' }), sample(99, { time: 'bad' }), sample(99, { intervalStart: '2026-09-13T00:00:02Z' })];
  assert.deepEqual(summarizeGpuSamples(rows, { start: Date.parse('2026-09-13T00:00:00Z'), end: Date.parse('2026-09-13T00:00:02Z') }),
    { samples: 1, valid: 1, unavailableSamples: 0, mean: 2, max: 2 });
});
test('phase completeness distinguishes partial, unavailable and deliberately disabled GPU checks', () => {
  const valid = { gpu: { samples: 10, valid: 10 } };
  assert.equal(classifyGpuPhases([valid, valid, valid, valid]), 'valid');
  assert.equal(classifyGpuPhases([valid, valid, valid, { gpu: { samples: 10, valid: 0 } }]), 'partial');
  assert.equal(classifyGpuPhases([valid]), 'partial');
  assert.equal(classifyGpuPhases([{ gpu: { samples: 10, valid: 0 } }]), 'unavailable');
  assert.equal(classifyGpuPhases([], false), 'disabled');
});
