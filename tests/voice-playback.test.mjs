import test from 'node:test';
import assert from 'node:assert/strict';
import { createVoicePlayback } from '../src/voice-playback.mjs';

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function buffer({ amplitude = 0.2, duration = 1 } = {}) {
  const data = new Float32Array(Math.round(duration * 1000)).fill(amplitude);
  return { duration, sampleRate: 1000, numberOfChannels: 1, length: data.length, getChannelData: () => data, data };
}

function packet(id = 1, cues = [{ start: 0, end: 1, vowel: 'aa' }]) {
  return { id, audio: new ArrayBuffer(16), cues, duration: 1 };
}

function fixture() {
  const contexts = [], mouths = [], states = [], intervals = new Map(), savedTicks = [];
  let intervalId = 0;
  const playback = createVoicePlayback({
    contextFactory() {
      const context = {
        state: 'suspended', currentTime: 0, destination: {}, sources: [], decodes: [], closed: 0, resumed: 0,
        resume() { this.resumed++; this.state = 'running'; return Promise.resolve(); },
        close() { this.closed++; this.state = 'closed'; return Promise.resolve(); },
        decodeAudioData(data) { const operation = deferred(); this.decodes.push({ ...operation, data }); return operation.promise; },
        createBufferSource() {
          const source = {
            buffer: null, onended: null, starts: 0, stops: 0, disconnects: 0,
            connect() {}, disconnect() { this.disconnects++; }, start() { this.starts++; }, stop() { this.stops++; },
          };
          this.sources.push(source);
          return source;
        },
      };
      contexts.push(context);
      return context;
    },
    onMouth: (...args) => mouths.push(args),
    onState: (...args) => states.push(args),
    setIntervalImpl(tick, period) {
      assert.equal(period, 50, 'speech samples use only 20 Hz');
      intervals.set(++intervalId, tick); savedTicks.push(tick); return intervalId;
    },
    clearIntervalImpl: id => intervals.delete(id),
  });
  return { playback, contexts, mouths, states, intervals, savedTicks, tick() { for (const tick of [...intervals.values()]) tick(); } };
}

test('requires explicit preparation and invokes resume before prepare yields', async () => {
  const f = fixture();
  await f.playback.play(packet());
  assert.equal(f.contexts.length, 0);
  assert.deepEqual(f.states, [[1, 'error']]);
  const prepared = f.playback.prepare();
  assert.equal(f.contexts[0].resumed, 1);
  assert.equal(await prepared, true);
  f.playback.dispose();
  assert.equal(f.contexts[0].closed, 1);
  assert.equal(await f.playback.prepare(), false);
});

test('audio clock and sample energy select vowels, silence, and bounded mouth weight', async () => {
  const f = fixture();
  await f.playback.prepare();
  const context = f.contexts[0];
  context.currentTime = 10;
  const playing = f.playback.play(packet(7, [
    { start: 0, end: 0.2, vowel: 'aa' }, { start: 0.3, end: 0.6, vowel: 'ih' }, { start: 0.6, end: 1, vowel: 'ou' },
  ]));
  const decoded = buffer();
  decoded.data.fill(0, 400, 460);
  decoded.data.fill(1, 700, 760);
  context.decodes[0].resolve(decoded);
  await playing;
  assert.deepEqual(f.states, [[7, 'playing']]);
  assert.equal(f.mouths.at(-1)[1], 'aa');
  assert.ok(f.mouths.at(-1)[2] > 0 && f.mouths.at(-1)[2] < 1);
  context.currentTime = 10.25; f.tick();
  assert.deepEqual(f.mouths.at(-1), [7, null, 0]);
  context.currentTime = 10.35; f.tick();
  assert.equal(f.mouths.at(-1)[1], 'ih');
  context.currentTime = 10.42; f.tick();
  assert.deepEqual(f.mouths.at(-1), [7, null, 0]);
  context.currentTime = 10.72; f.tick();
  assert.deepEqual(f.mouths.at(-1), [7, 'ou', 0.85]);
  context.currentTime = 11; f.tick();
  assert.deepEqual(f.states.at(-1), [7, 'ended']);
  assert.deepEqual(f.mouths.at(-1), [7, null, 0]);
  assert.equal(f.intervals.size, 0);
  assert.equal(context.sources[0].buffer, null);
  assert.equal(context.closed, 1);
});

test('natural end releases source, timer and context once; retained end and tick callbacks are inert', async () => {
  const f = fixture();
  await f.playback.prepare();
  const context = f.contexts[0];
  const playing = f.playback.play(packet());
  context.decodes[0].resolve(buffer()); await playing;
  const source = context.sources[0], ended = source.onended, tick = f.savedTicks[0];
  ended(); ended(); tick();
  assert.deepEqual(f.states, [[1, 'playing'], [1, 'ended']]);
  assert.equal(source.stops, 1);
  assert.equal(source.disconnects, 1);
  assert.equal(source.onended, null);
  assert.equal(source.buffer, null);
  assert.equal(context.closed, 1);
  assert.equal(f.intervals.size, 0);
});

test('stop during decode prevents delayed audio and permits only a fresh prepared request', async () => {
  const f = fixture();
  await f.playback.prepare();
  const old = f.contexts[0];
  const first = f.playback.play(packet(1));
  f.playback.stop();
  assert.equal(old.closed, 1);
  await f.playback.prepare();
  const next = f.contexts[1];
  const second = f.playback.play(packet(2));
  next.decodes[0].resolve(buffer()); await second;
  old.decodes[0].resolve(buffer()); await first;
  assert.equal(old.sources.length, 0);
  assert.equal(next.sources.length, 1);
  assert.equal(next.closed, 0);
  assert.deepEqual(f.states, [[2, 'playing']]);
  assert.equal(f.intervals.size, 1);
  f.playback.dispose();
});

test('new play supersedes decode in the same context; stale decode success cannot start', async () => {
  const f = fixture();
  await f.playback.prepare();
  const context = f.contexts[0];
  const first = f.playback.play(packet(1)), second = f.playback.play(packet(2));
  context.decodes[1].resolve(buffer()); await second;
  context.decodes[0].resolve(buffer()); await first;
  assert.equal(context.sources.length, 1);
  assert.deepEqual(f.states, [[2, 'playing']]);
  assert.equal(context.closed, 0);
  f.playback.dispose();
});

test('late decode rejection cannot clear a newer mouth or close its context', async () => {
  const f = fixture();
  await f.playback.prepare();
  const context = f.contexts[0];
  const first = f.playback.play(packet(1)), second = f.playback.play(packet(2));
  context.decodes[1].resolve(buffer()); await second;
  const mouthCount = f.mouths.length;
  context.decodes[0].reject(new Error('old private error')); await first;
  assert.equal(f.mouths.length, mouthCount);
  assert.deepEqual(f.states, [[2, 'playing']]);
  assert.equal(context.closed, 0);
  f.playback.dispose();
});

test('late source end and timer from replaced playback cannot stop the new source', async () => {
  const f = fixture();
  await f.playback.prepare();
  const context = f.contexts[0];
  const first = f.playback.play(packet(1));
  context.decodes[0].resolve(buffer()); await first;
  const oldSource = context.sources[0], oldEnd = oldSource.onended, oldTick = f.savedTicks[0];
  const second = f.playback.play(packet(2));
  context.decodes[1].resolve(buffer()); await second;
  const mouthCount = f.mouths.length;
  oldEnd(); oldTick();
  assert.equal(f.mouths.length, mouthCount);
  assert.equal(oldSource.buffer, null);
  assert.equal(context.sources[1].stops, 0);
  assert.deepEqual(f.states, [[1, 'playing'], [2, 'playing']]);
  assert.equal(f.intervals.size, 1);
  f.playback.dispose();
});

test('packet cues and audio are snapshotted before decode yields', async () => {
  const f = fixture();
  await f.playback.prepare();
  const context = f.contexts[0], input = packet();
  const playing = f.playback.play(input);
  assert.notEqual(context.decodes[0].data, input.audio);
  input.cues[0].vowel = 'oh'; input.cues[0].end = 0.01;
  context.decodes[0].resolve(buffer()); await playing;
  assert.equal(f.mouths.at(-1)[1], 'aa');
  context.currentTime = 0.5; f.tick();
  assert.equal(f.mouths.at(-1)[1], 'aa');
  f.playback.dispose();
});

test('malformed or unbounded packets fail closed before decoding', async () => {
  for (const change of [
    { audio: new Uint8Array(4) }, { audio: new ArrayBuffer(0) }, { audio: new ArrayBuffer(8 * 1024 * 1024 + 1) },
    { duration: NaN }, { duration: 91 }, { cues: [{ start: -1, end: 1, vowel: 'aa' }] },
    { cues: [{ start: 0, end: 1, vowel: 'javascript' }] },
    { cues: [{ start: 0, end: 0.8, vowel: 'aa' }, { start: 0.7, end: 1, vowel: 'ih' }] },
    { cues: Array(6001).fill({ start: 0, end: 1, vowel: 'aa' }) },
  ]) {
    const f = fixture();
    await f.playback.prepare();
    await f.playback.play({ ...packet(), ...change });
    assert.equal(f.contexts[0].decodes.length, 0);
    assert.equal(f.contexts[0].closed, 1);
    assert.deepEqual(f.states, [[1, 'error']]);
    assert.deepEqual(f.mouths.at(-1), [1, null, 0]);
  }
});

test('decode failure, invalid decoded length, and audio suspension release resources with a fixed error state', async () => {
  for (const failure of ['decode', 'length', 'suspend']) {
    const f = fixture();
    await f.playback.prepare();
    const context = f.contexts[0], playing = f.playback.play(packet());
    if (failure === 'decode') context.decodes[0].reject(new Error('private implementation detail'));
    else context.decodes[0].resolve(buffer({ duration: failure === 'length' ? 91 : 1 }));
    await playing;
    if (failure === 'suspend') { context.state = 'suspended'; f.tick(); }
    assert.deepEqual(f.states.at(-1), [1, 'error']);
    assert.equal(context.closed, 1);
    assert.equal(f.intervals.size, 0);
    assert.deepEqual(f.mouths.at(-1), [1, null, 0]);
  }
});

test('dispose is permanent and a pending prepare/decode cannot resurrect playback', async () => {
  const f = fixture();
  const prepared = f.playback.prepare();
  f.playback.dispose();
  assert.equal(await prepared, false);
  await f.playback.play(packet());
  assert.equal(await f.playback.prepare(), false);
  f.playback.dispose();
  assert.equal(f.contexts[0].closed, 1);
  assert.equal(f.contexts[0].decodes.length, 0);
  assert.equal(f.states.length, 0);

  const decoding = fixture();
  await decoding.playback.prepare();
  const playing = decoding.playback.play(packet());
  decoding.playback.dispose();
  decoding.contexts[0].decodes[0].reject(new Error('discard me'));
  await playing;
  assert.equal(decoding.states.length, 0);
  assert.equal(decoding.contexts[0].sources.length, 0);
  assert.equal(decoding.intervals.size, 0);
});

test('prepare failure returns false and closes its context without emitting private errors', async () => {
  let closed = 0;
  const playback = createVoicePlayback({ contextFactory: () => ({
    state: 'suspended', resume: () => Promise.reject(new Error('private device detail')),
    close: async () => { closed++; },
  }) });
  assert.equal(await playback.prepare(), false);
  assert.equal(closed, 1);
  playback.dispose();
});

test('an unresolved resume is bounded and a late resolution cannot reopen the context', async () => {
  const pending = deferred(), timers = new Map();
  let closed = 0, nextTimer = 0;
  const context = {
    state: 'suspended', resume: () => pending.promise,
    close: async () => { context.state = 'closed'; closed++; },
  };
  const playback = createVoicePlayback({
    contextFactory: () => context,
    setTimeoutImpl: (callback, timeout) => { assert.equal(timeout, 1500); timers.set(++nextTimer, callback); return nextTimer; },
    clearTimeoutImpl: id => timers.delete(id),
  });
  const prepared = playback.prepare();
  assert.equal(timers.size, 1);
  [...timers.values()][0]();
  assert.equal(await prepared, false);
  assert.equal(closed, 1);
  assert.equal(timers.size, 0);
  pending.resolve();
  await Promise.resolve();
  assert.equal(closed, 1);
  assert.equal(context.state, 'closed');
  playback.dispose();
});

test('stop settles an unresolved prepare immediately and clears its timeout', async () => {
  const pending = deferred(), timers = new Map();
  let closed = 0;
  const playback = createVoicePlayback({
    contextFactory: () => ({ state: 'suspended', resume: () => pending.promise, close: async () => { closed++; } }),
    setTimeoutImpl: callback => { timers.set(1, callback); return 1; },
    clearTimeoutImpl: id => timers.delete(id),
  });
  const prepared = playback.prepare();
  playback.stop();
  assert.equal(await prepared, false);
  assert.equal(closed, 1);
  assert.equal(timers.size, 0);
  pending.reject(new Error('late device failure'));
  await Promise.resolve();
  playback.dispose();
});
