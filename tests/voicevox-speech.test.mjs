import test from 'node:test';
import assert from 'node:assert/strict';
import { createVoicevoxSpeech, VoicevoxSpeechError, VOICEVOX_SPEECH } from '../src/voicevox-speech.mjs';

const encoder = new TextEncoder();
const json = value => new Response(JSON.stringify(value));
const mora = (vowel = 'a', length = 0.192, consonant = null, consonantLength = null) => ({
  text: 'ア', consonant, consonant_length: consonantLength, vowel, vowel_length: length, pitch: 5.2,
});
const query = () => ({
  accent_phrases: [{ moras: [mora()], accent: 1, pause_mora: null, is_interrogative: false }],
  prePhonemeLength: 0.096, postPhonemeLength: 0.096,
  speedScale: 1, pitchScale: 0, intonationScale: 1, volumeScale: 1,
  outputSamplingRate: 44100, outputStereo: true, kana: 'IGNORED-READING',
});
function wav(duration = 0.4) {
  const samples = Math.round(duration * 24000);
  const bytes = new Uint8Array(44 + samples * 2);
  const view = new DataView(bytes.buffer);
  bytes.set(encoder.encode('RIFF'), 0); view.setUint32(4, bytes.length - 8, true);
  bytes.set(encoder.encode('WAVEfmt '), 8); view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, 24000, true); view.setUint32(28, 48000, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  bytes.set(encoder.encode('data'), 36); view.setUint32(40, samples * 2, true);
  return bytes;
}
const code = expected => error => error instanceof VoicevoxSpeechError && error.code === expected;
const aborted = error => error.name === 'AbortError' && !String(error).includes('PRIVATE');
const flush = () => new Promise(resolve => setImmediate(resolve));
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} != ${expected}`);
function fake(queryValue = query(), audio = wav()) {
  const calls = [];
  const adapter = createVoicevoxSpeech({ async fetchImpl(url, request) {
    calls.push({ url, request });
    return calls.length === 1 ? json(queryValue) : new Response(audio);
  } });
  return { adapter, calls };
}

test('adapter is inert and makes exactly two fixed local requests with normalized settings', async () => {
  const input = query();
  input.privateExtension = { url: 'https://private.invalid', text: 'DO-NOT-FORWARD' };
  input.accent_phrases[0].moras[0].extra = 'DO-NOT-FORWARD';
  input.pauseLength = 900;
  input.pauseLengthScale = 900;
  const { adapter, calls } = fake(input);
  assert.ok(Object.isFrozen(adapter)); assert.ok(Object.isFrozen(VOICEVOX_SPEECH));
  assert.equal(calls.length, 0);
  const output = await adapter.synthesize('  こんにちは & またね？  ');
  assert.equal(calls.length, 2);
  const url = new URL(calls[0].url);
  assert.equal(url.origin, 'http://127.0.0.1:50021'); assert.equal(url.pathname, '/audio_query');
  assert.deepEqual([...url.searchParams], [['speaker', '14'], ['text', 'こんにちは & またね？']]);
  assert.equal(calls[0].request.body, undefined);
  assert.equal(calls[1].url, 'http://127.0.0.1:50021/synthesis?speaker=14&enable_interrogative_upspeak=false');
  for (const call of calls) {
    assert.equal(call.request.method, 'POST'); assert.equal(call.request.redirect, 'error');
    assert.equal(call.request.signal.aborted, true);
    assert.doesNotMatch(JSON.stringify(call.request), /Authorization|Bearer/);
  }
  const body = JSON.parse(calls[1].request.body);
  assert.equal(body.speedScale, 0.96); assert.equal(body.pitchScale, -0.01);
  assert.equal(body.intonationScale, 0.94); assert.equal(body.volumeScale, 1);
  assert.equal(body.outputSamplingRate, 24000); assert.equal(body.outputStereo, false);
  assert.equal(body.pauseLength, null); assert.equal(body.pauseLengthScale, 1);
  assert.doesNotMatch(calls[1].request.body, /DO-NOT-FORWARD|IGNORED-READING|private/);
  assert.equal(input.speedScale, 1);
  assert.deepEqual(new Uint8Array(output.audio), wav());
  assert.ok(output.audio instanceof ArrayBuffer);
  assert.equal(output.duration, 0.4); assert.equal(output.cues.length, 1);
  near(output.cues[0].start, 0.1); near(output.cues[0].end, 0.3);
  assert.equal(output.cues[0].vowel, 'aa');
});

test('cue timeline includes consonants, pauses, pre/post silence, speed and final WAV duration', async () => {
  const input = query();
  input.accent_phrases = [
    { moras: [mora('a', 0.192, 'k', 0.096)], accent: 1, pause_mora: { ...mora('pau', 0.096), pitch: 0 } },
    { moras: [mora('u', 0.096), mora('N', 0.096), mora('cl', 0.096), mora('I', 0.192)], accent: 2, is_interrogative: true },
  ];
  const output = await fake(input, wav(2.2)).adapter.synthesize('短い確認');
  assert.equal(output.duration, 2.2);
  assert.deepEqual(output.cues.map(cue => cue.vowel), ['aa', 'ou', 'ih']);
  for (const [index, expected] of [[0, [0.4, 0.8]], [1, [1, 1.2]], [2, [1.6, 2]]]) {
    near(output.cues[index].start, expected[0]); near(output.cues[index].end, expected[1]);
  }
  for (const cue of output.cues) assert.ok(cue.start >= 0 && cue.start < cue.end && cue.end <= output.duration);
});

test('all five mouth shapes are mapped, unvoiced vowels preserve shape, zero lengths and silence do not open the mouth', async () => {
  const input = query();
  input.accent_phrases[0].moras = ['a', 'I', 'u', 'E', 'o', 'N', 'cl', 'pau'].map(vowel => mora(vowel, 0.05));
  input.accent_phrases[0].moras.push(mora('a', 0));
  const output = await fake(input).adapter.synthesize('確認');
  assert.deepEqual(output.cues.map(cue => cue.vowel), ['aa', 'ih', 'ou', 'ee', 'oh']);
  input.accent_phrases = [];
  assert.deepEqual((await fake(input).adapter.synthesize('。')).cues, []);
});

test('blank, non-string and oversized UTF16 input is rejected before any request; boundary text is never truncated', async () => {
  let calls = 0;
  const adapter = createVoicevoxSpeech({ async fetchImpl() { calls++; throw new Error('unexpected'); } });
  for (const input of ['', ' \n\t', undefined, null, 4, {}, 'あ'.repeat(1001), '🌙'.repeat(501)]) {
    await assert.rejects(adapter.synthesize(input), code('invalid-text'));
  }
  assert.equal(calls, 0);
  const boundary = fake();
  await boundary.adapter.synthesize('🌙'.repeat(500));
  assert.equal(new URL(boundary.calls[0].url).searchParams.get('text'), '🌙'.repeat(500));
});

test('invalid query fields, phonemes, durations and accent structures never reach synthesis', async () => {
  const mutations = [
    value => { value.prePhonemeLength = -1; }, value => { value.postPhonemeLength = 6; },
    value => { value.accent_phrases = {}; }, value => { value.accent_phrases[0].accent = 0; },
    value => { value.accent_phrases[0].accent = 2; }, value => { value.accent_phrases[0].is_interrogative = 'false'; },
    value => { value.accent_phrases[0].moras = []; }, value => { value.accent_phrases[0].moras[0].vowel = 'private'; },
    value => { value.accent_phrases[0].moras[0].vowel_length = '0.1'; }, value => { value.accent_phrases[0].moras[0].vowel_length = -0.1; },
    value => { value.accent_phrases[0].moras[0].vowel_length = 6; }, value => { value.accent_phrases[0].moras[0].pitch = null; },
    value => { value.accent_phrases[0].moras[0].pitch = 21; }, value => { value.accent_phrases[0].moras[0].text = 'x'.repeat(33); },
    value => { value.accent_phrases[0].moras[0].consonant_length = 0.1; },
    value => { value.accent_phrases[0].moras[0].consonant = 'k'; },
    value => { Object.assign(value.accent_phrases[0].moras[0], { consonant: 'private', consonant_length: 0.1 }); },
    value => { value.accent_phrases[0].pause_mora = mora('a'); },
    value => { value.accent_phrases[0].pause_mora = mora('pau', 0.1, 'k', 0.1); },
  ];
  for (const mutate of mutations) {
    const value = query(); mutate(value);
    const { adapter, calls } = fake(value);
    await assert.rejects(adapter.synthesize('確認'), code('invalid-response'));
    assert.equal(calls.length, 1);
  }
  for (const value of [null, [], 4, 'private']) {
    const fixture = fake(value);
    await assert.rejects(fixture.adapter.synthesize('確認'), code('invalid-response'));
    assert.equal(fixture.calls.length, 1);
  }
});

test('mora count and estimated 90 second duration are bounded before synthesis', async () => {
  for (const count of [1001, 1000]) {
    const value = query(); value.accent_phrases[0].moras = Array.from({ length: count }, () => mora('a', 0.096));
    const fixture = fake(value);
    await assert.rejects(fixture.adapter.synthesize('確認'), code('invalid-response'));
    assert.equal(fixture.calls.length, 1);
  }
  const value = query(); value.prePhonemeLength = 0; value.postPhonemeLength = 0;
  value.accent_phrases[0].moras = Array.from({ length: 1000 }, () => mora('a', 0.001));
  const output = await fake(value).adapter.synthesize('確認');
  assert.equal(output.cues.length, 1000);
});

test('malformed JSON and UTF8 are rejected and unknown query keys are not trusted', async () => {
  for (const body of ['{', '{"prePhonemeLength": 1e999}', new Uint8Array([0xff, 0xfe])]) {
    let calls = 0;
    const adapter = createVoicevoxSpeech({ async fetchImpl() { calls++; return new Response(body); } });
    await assert.rejects(adapter.synthesize('確認'), code('invalid-response'));
    assert.equal(calls, 1);
  }
});

test('declared and streamed query/audio byte limits reject without trusting content-length', async () => {
  for (const phase of ['query', 'audio']) {
    const maximum = phase === 'query' ? VOICEVOX_SPEECH.maxQueryBytes : VOICEVOX_SPEECH.maxAudioBytes;
    for (const mode of ['declared-large', 'declared-invalid', 'stream-large']) {
      let calls = 0, reads = 0, canceled = 0;
      const stream = new ReadableStream({
        pull(controller) { reads++; controller.enqueue(new Uint8Array(maximum + 1)); },
        cancel() { canceled++; },
      }, { highWaterMark: 0 });
      const adapter = createVoicevoxSpeech({ async fetchImpl() {
        calls++;
        if (phase === 'audio' && calls === 1) return json(query());
        return new Response(stream, { headers: { 'content-length': mode === 'declared-large' ? String(maximum + 1) : mode === 'declared-invalid' ? '-1' : '1' } });
      } });
      await assert.rejects(adapter.synthesize('確認'), code('invalid-response'));
      await flush();
      assert.equal(calls, phase === 'audio' ? 2 : 1);
      assert.equal(reads, mode === 'stream-large' ? 1 : 0);
      assert.equal(canceled, 1);
    }
  }
});

test('exact query byte boundary is accepted without forwarding its padding', async () => {
  const value = query(); value.padding = '';
  value.padding = 'x'.repeat(VOICEVOX_SPEECH.maxQueryBytes - encoder.encode(JSON.stringify(value)).length);
  assert.equal(encoder.encode(JSON.stringify(value)).length, VOICEVOX_SPEECH.maxQueryBytes);
  const fixture = fake(value);
  await fixture.adapter.synthesize('確認');
  assert.doesNotMatch(fixture.calls[1].request.body, /padding/);
});

test('only structurally valid PCM mono 24000 Hz 16 bit WAV is accepted', async () => {
  const corruptions = [
    bytes => { bytes[0] = 0; }, bytes => { bytes[8] = 0; },
    bytes => new DataView(bytes.buffer).setUint32(4, bytes.length - 7, true),
    bytes => new DataView(bytes.buffer).setUint16(20, 3, true),
    bytes => new DataView(bytes.buffer).setUint16(22, 2, true),
    bytes => new DataView(bytes.buffer).setUint32(24, 48000, true),
    bytes => new DataView(bytes.buffer).setUint32(28, 96000, true),
    bytes => new DataView(bytes.buffer).setUint16(32, 4, true),
    bytes => new DataView(bytes.buffer).setUint16(34, 32, true),
    bytes => new DataView(bytes.buffer).setUint32(16, 15, true),
    bytes => new DataView(bytes.buffer).setUint32(40, bytes.length, true),
    bytes => new DataView(bytes.buffer).setUint32(40, 1, true),
    bytes => { bytes.set(encoder.encode('junk'), 36); },
  ];
  for (const corrupt of corruptions) {
    const bytes = wav(); corrupt(bytes);
    await assert.rejects(fake(query(), bytes).adapter.synthesize('確認'), code('invalid-response'));
  }
  for (const bytes of [new Uint8Array(0), new Uint8Array(43), wav(0), wav(90.001)]) {
    await assert.rejects(fake(query(), bytes).adapter.synthesize('確認'), code('invalid-response'));
  }
  assert.equal((await fake(query(), wav(90)).adapter.synthesize('確認')).duration, 90);
});

test('WAV padding is parsed safely and duplicate chunks or truncated padding are rejected', async () => {
  const original = wav();
  const withChunk = (kind, content, pad = true) => {
    const result = new Uint8Array(original.length + 8 + content.length + (pad ? content.length % 2 : 0));
    result.set(original.subarray(0, 36));
    result.set(encoder.encode(kind), 36);
    new DataView(result.buffer).setUint32(40, content.length, true);
    result.set(content, 44);
    result.set(original.subarray(36), 44 + content.length + (pad ? content.length % 2 : 0));
    new DataView(result.buffer).setUint32(4, result.length - 8, true);
    return result;
  };
  assert.equal((await fake(query(), withChunk('JUNK', new Uint8Array([1]))).adapter.synthesize('確認')).duration, 0.4);
  for (const bytes of [
    withChunk('fmt ', original.subarray(20, 36)), withChunk('data', new Uint8Array([0, 0])),
    withChunk('JUNK', new Uint8Array([1]), false),
  ]) await assert.rejects(fake(query(), bytes).adapter.synthesize('確認'), code('invalid-response'));
});

test('HTTP and network failures yield only fixed local errors and never read diagnostics or retry', async () => {
  for (const phase of ['query', 'audio']) {
    for (const status of [302, 400, 422, 500, 503]) {
      let calls = 0, reads = 0, canceled = 0;
      const stream = new ReadableStream({ pull() { reads++; }, cancel() { canceled++; } }, { highWaterMark: 0 });
      const adapter = createVoicevoxSpeech({ async fetchImpl() {
        calls++;
        if (phase === 'audio' && calls === 1) return json(query());
        return new Response(stream, { status, statusText: 'PRIVATE PATH AND TEXT' });
      } });
      await assert.rejects(adapter.synthesize('確認'), error => {
        assert.ok(error instanceof VoicevoxSpeechError);
        assert.equal(error.code, status >= 500 ? 'unavailable' : 'invalid-response');
        assert.doesNotMatch(String(error), /PRIVATE|PATH|TEXT/);
        return true;
      });
      await flush();
      assert.equal(calls, phase === 'query' ? 1 : 2); assert.equal(reads, 0); assert.equal(canceled, 1);
    }
  }
  const adapter = createVoicevoxSpeech({ async fetchImpl() { throw new Error('PRIVATE localhost path and text'); } });
  await assert.rejects(adapter.synthesize('確認'), error => {
    assert.equal(error.code, 'unavailable'); assert.equal(error.cause, undefined);
    assert.doesNotMatch(String(error), /PRIVATE|path|text/); return true;
  });
  assert.equal(new VoicevoxSpeechError('made-up-private').code, 'unavailable');
  assert.ok(Object.isFrozen(new VoicevoxSpeechError('unavailable')));
});

test('already aborted requests never fetch and caller reasons do not escape', async () => {
  const controller = new AbortController(); controller.abort(new Error('PRIVATE'));
  let calls = 0;
  const adapter = createVoicevoxSpeech({ async fetchImpl() { calls++; } });
  await assert.rejects(adapter.synthesize('確認', { signal: controller.signal }), aborted);
  assert.equal(calls, 0);
});

test('abort settles even if fetch ignores the signal; a late response is canceled and cannot launch synthesis', async () => {
  const controller = new AbortController();
  let resolveFetch, started, calls = 0, canceled = 0;
  const ready = new Promise(resolve => { started = resolve; });
  const adapter = createVoicevoxSpeech({ fetchImpl() {
    calls++; started(); return new Promise(resolve => { resolveFetch = resolve; });
  } });
  const operation = adapter.synthesize('確認', { signal: controller.signal });
  await ready; controller.abort(new Error('PRIVATE'));
  await assert.rejects(operation, aborted);
  resolveFetch(new Response(new ReadableStream({ cancel() { canceled++; } }, { highWaterMark: 0 })));
  await flush();
  assert.equal(calls, 1); assert.equal(canceled, 1);
});

test('abort cancels stalled query and WAV readers, without replaying text', async () => {
  for (const phase of ['query', 'audio']) {
    const controller = new AbortController();
    let started, calls = 0, canceled = 0;
    const ready = new Promise(resolve => { started = resolve; });
    const adapter = createVoicevoxSpeech({ async fetchImpl() {
      calls++;
      if (phase === 'audio' && calls === 1) return json(query());
      return new Response(new ReadableStream({ pull() { started(); }, cancel() { canceled++; } }, { highWaterMark: 0 }));
    } });
    const operation = adapter.synthesize('確認', { signal: controller.signal });
    await ready; controller.abort(new Error('PRIVATE'));
    await assert.rejects(operation, aborted); await flush();
    assert.equal(calls, phase === 'query' ? 1 : 2); assert.equal(canceled, 1);
  }
});

test('one timeout bounds both fetch and body reads, with fixed timeout feedback', async () => {
  for (const mode of ['fetch', 'query-body', 'audio-body']) {
    let calls = 0, canceled = 0;
    const adapter = createVoicevoxSpeech({ timeoutMs: 15, async fetchImpl() {
      calls++;
      if (mode === 'fetch') return new Promise(() => {});
      if (mode === 'audio-body' && calls === 1) return json(query());
      return new Response(new ReadableStream({ cancel() { canceled++; } }, { highWaterMark: 0 }));
    } });
    await assert.rejects(adapter.synthesize('確認'), code('timeout'));
    await flush();
    assert.equal(calls, mode === 'audio-body' ? 2 : 1);
    assert.equal(canceled, mode === 'fetch' ? 0 : 1);
  }
});
