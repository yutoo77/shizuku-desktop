import test from 'node:test';
import assert from 'node:assert/strict';
import { createDialogueVoice } from '../src/dialogue-voice.mjs';

function fixture() {
  const calls = [], packets = [], mouths = [], stops = [];
  const voice = createDialogueVoice({
    synthesize: (text, { signal }) => new Promise((resolve, reject) => calls.push({ text, signal, resolve, reject })),
    onAudio: packet => packets.push(packet), onMouth: (...args) => mouths.push(args), onStop: id => stops.push(id),
  });
  const packet = { audio: new ArrayBuffer(44), cues: [], duration: .01 };
  return { voice, calls, packets, mouths, stops, packet };
}

test('voice is opt-in; enabling never reads previous replies', async () => {
  const f = fixture();
  await f.voice.speak('無音');
  assert.equal(f.calls.length, 0);
  assert.equal(f.voice.setEnabled('true'), false);
  f.voice.setEnabled(true);
  assert.equal(f.calls.length, 0);
  f.voice.dispose();
});

test('cancel aborts synthesis and discards a late result, without replay', async () => {
  const f = fixture(); f.voice.setEnabled(true);
  const pending = f.voice.speak('最初');
  f.voice.stop();
  assert.equal(f.calls[0].signal.aborted, true);
  f.calls[0].resolve(f.packet); await pending;
  assert.equal(f.packets.length, 0);
  assert.equal(f.voice.snapshot().status, 'idle');
  assert.deepEqual(f.mouths.at(-1), [null, 0]);
  f.voice.dispose();
});

test('only current playback can animate or finish; stale errors do not affect new speech', async () => {
  const f = fixture(); f.voice.setEnabled(true);
  let pending = f.voice.speak('最初'); f.calls[0].resolve(f.packet); await pending;
  const old = f.packets[0].id;
  assert.equal(f.voice.mouth(old, 'aa', .5), false);
  assert.equal(f.voice.report(old, 'playing'), true);
  assert.equal(f.voice.mouth(old, 'aa', .5), true);
  assert.equal(f.voice.mouth(old, 'malicious-expression', .5), false);
  assert.equal(f.voice.mouth(old, 'aa', NaN), false);
  assert.equal(f.voice.mouth(old, 'aa', 2), false);
  f.voice.stop(); pending = f.voice.speak('次'); f.calls[1].resolve(f.packet); await pending;
  const current = f.packets[1].id;
  assert.equal(f.voice.report(old, 'error'), false);
  assert.equal(f.voice.report(old, 'ended'), false);
  assert.equal(f.voice.report(current, 'playing'), true);
  assert.equal(f.voice.report(current, 'ended'), true);
  assert.equal(f.voice.snapshot().status, 'idle');
  f.voice.dispose();
});

test('voice off and dispose discard errors and prevent future synthesis', async () => {
  const f = fixture(); f.voice.setEnabled(true);
  const pending = f.voice.speak('秘密ではない確認文');
  f.voice.setEnabled(false);
  f.calls[0].reject(new Error('raw private server body')); await pending;
  assert.equal(f.voice.snapshot().error, null);
  await f.voice.speak('無音'); assert.equal(f.calls.length, 1);
  f.voice.dispose(); assert.equal(f.voice.setEnabled(true), false);
});

test('synthesis failures expose a fixed error and leave text conversation independent', async () => {
  const f = fixture(); f.voice.setEnabled(true);
  const pending = f.voice.speak('返答'); f.calls[0].reject(new Error('http://secret/body')); await pending;
  assert.equal(f.voice.snapshot().status, 'error');
  assert.match(f.voice.snapshot().error, /VOICEVOX/);
  assert.doesNotMatch(f.voice.snapshot().error, /secret/);
  f.voice.stop(); assert.equal(f.voice.snapshot().error, null);
  f.voice.dispose();
});
