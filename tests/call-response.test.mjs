import assert from 'node:assert/strict';
import test from 'node:test';
import { CALL_RESPONSE_MS, callExpression, sampleCallResponse } from '../src/call-response.mjs';

test('a call begins and ends at the exact neutral pose within a short fixed duration', () => {
  assert.ok(CALL_RESPONSE_MS >= 1800 && CALL_RESPONSE_MS <= 2400);
  assert.deepEqual(sampleCallResponse(0), { progress: 0, done: false, nod: 0, turn: 0, tilt: 0, expression: 0 });
  const completed = { progress: 1, done: true, nod: 0, turn: 0, tilt: 0, expression: 0 };
  assert.deepEqual(sampleCallResponse(CALL_RESPONSE_MS), completed);
  assert.deepEqual(sampleCallResponse(CALL_RESPONSE_MS * 100), completed);
});

test('acknowledgement makes one small nod with a bounded, soft expression', () => {
  const samples = Array.from({ length: 211 }, (_, index) => sampleCallResponse(index * 10));
  assert.ok(samples.some(sample => sample.nod > 0.07));
  assert.ok(samples.some(sample => sample.expression > 0.17));
  let peaks = 0;
  for (let index = 1; index < samples.length - 1; index += 1) {
    const previous = samples[index - 1];
    const sample = samples[index];
    const next = samples[index + 1];
    assert.ok(sample.progress >= previous.progress);
    assert.ok(sample.nod >= 0 && sample.nod <= 0.075);
    assert.ok(Math.abs(sample.turn) <= 0.035 && Math.abs(sample.tilt) <= 0.025);
    assert.ok(sample.expression >= 0 && sample.expression <= 0.18);
    if (sample.nod > previous.nod && sample.nod >= next.nod) peaks += 1;
  }
  assert.equal(peaks, 1);
});

test('a bad or delayed timestamp cannot leave invalid weights or a continuing reaction', () => {
  for (const value of [NaN, Infinity, -Infinity]) {
    const sample = sampleCallResponse(value);
    assert.equal(sample.done, true);
    assert.equal(sample.expression, 0);
    assert.ok(Object.values(sample).every(value => typeof value === 'boolean' || Number.isFinite(value)));
  }
  assert.deepEqual(sampleCallResponse(-100), sampleCallResponse(0));
});

test('uses only a supported calm expression, falling back to a nod when neither exists', () => {
  assert.equal(callExpression(['happy', 'relaxed']), 'happy');
  assert.equal(callExpression(['relaxed']), 'relaxed');
  assert.equal(callExpression(['angry', 'customSmile']), null);
  assert.equal(callExpression([]), null);
});
