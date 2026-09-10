export const VOICEVOX_SPEECH = Object.freeze({
  endpoint: 'http://127.0.0.1:50021',
  speaker: 14,
  maxTextCharacters: 1000,
  maxQueryBytes: 256 * 1024,
  maxAudioBytes: 8 * 1024 * 1024,
  maxDurationSeconds: 90,
  maxMoras: 1000,
  timeoutMs: 30000,
  speedScale: 0.96,
  pitchScale: -0.01,
  intonationScale: 0.94,
  outputSamplingRate: 24000,
  outputStereo: false,
});

const MESSAGES = Object.freeze({
  'invalid-text': '読み上げる文章は1〜1000文字にしてください。',
  unavailable: 'VOICEVOXに接続できませんでした。起動しているか確認してください。',
  timeout: '音声の準備に時間がかかったため、中止しました。',
  'invalid-response': 'VOICEVOXの音声を読み込めませんでした。',
});

export class VoicevoxSpeechError extends Error {
  constructor(code) {
    const safeCode = Object.hasOwn(MESSAGES, code) ? code : 'unavailable';
    super(MESSAGES[safeCode]);
    this.name = 'VoicevoxSpeechError';
    this.code = safeCode;
    Object.freeze(this);
  }
}

const VOWELS = new Set(['a', 'i', 'u', 'e', 'o', 'A', 'I', 'U', 'E', 'O', 'N', 'cl', 'pau']);
const CONSONANTS = new Set('b by ch d dy f g gw gy h hy j k kw ky m my n ny p py r ry s sh t ts ty v w y z'.split(' '));
/** @type {Readonly<Record<string, 'aa' | 'ih' | 'ou' | 'ee' | 'oh'>>} */
const VISEMES = Object.freeze({ a: 'aa', i: 'ih', u: 'ou', e: 'ee', o: 'oh' });
const invalid = () => new VoicevoxSpeechError('invalid-response');
const abortError = () => new DOMException('The operation was aborted.', 'AbortError');
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const finite = (value, maximum) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= maximum;

function discardBody(body) {
  try { void body?.cancel().catch(() => {}); } catch { /* Already locked or closed. */ }
}

async function boundedBytes(response, maximum, signal, aborted) {
  const declared = response.headers.get('content-length');
  if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > maximum)) throw invalid();
  if (!response.body || typeof response.body.getReader !== 'function') throw invalid();
  const reader = response.body.getReader();
  // Grow a byte buffer rather than retaining an unbounded number of tiny chunks.
  let bytes = new Uint8Array(Math.min(maximum, 64 * 1024));
  let size = 0;
  let complete = false;
  try {
    for (;;) {
      if (signal.aborted) throw abortError();
      const part = await Promise.race([reader.read(), aborted]);
      if (signal.aborted) throw abortError();
      if (part.done) break;
      if (!(part.value instanceof Uint8Array) || size + part.value.byteLength > maximum) throw invalid();
      const needed = size + part.value.byteLength;
      if (needed > bytes.byteLength) {
        const grown = new Uint8Array(Math.min(maximum, Math.max(needed, bytes.byteLength * 2)));
        grown.set(bytes.subarray(0, size));
        bytes = grown;
      }
      bytes.set(part.value, size);
      size = needed;
    }
    complete = true;
    return bytes.slice(0, size);
  } finally {
    if (!complete) {
      try { void reader.cancel().catch(() => {}); } catch { /* Do not wait on an untrusted stream. */ }
    }
    try { reader.releaseLock(); } catch { /* A canceled read can still be settling. */ }
  }
}

function validatedQuery(value) {
  if (!record(value) || !Array.isArray(value.accent_phrases) || value.accent_phrases.length > VOICEVOX_SPEECH.maxMoras ||
      !finite(value.prePhonemeLength, 5) || !finite(value.postPhonemeLength, 5)) throw invalid();
  let count = 0;
  const mora = (item, pause = false) => {
    if (!record(item) || ++count > VOICEVOX_SPEECH.maxMoras || typeof item.text !== 'string' || item.text.length > 32 ||
        !VOWELS.has(item.vowel) || (pause && item.vowel !== 'pau') || !finite(item.vowel_length, 5) || !finite(item.pitch, 20)) throw invalid();
    const consonant = item.consonant ?? null;
    const consonantLength = item.consonant_length ?? null;
    if (consonant === null ? consonantLength !== null : !CONSONANTS.has(consonant) || !finite(consonantLength, 5)) throw invalid();
    if (pause && consonant !== null) throw invalid();
    return { text: item.text, consonant, consonant_length: consonantLength, vowel: item.vowel, vowel_length: item.vowel_length, pitch: item.pitch };
  };
  const phrases = value.accent_phrases.map(phrase => {
    if (!record(phrase) || !Array.isArray(phrase.moras) || !phrase.moras.length || phrase.moras.length > VOICEVOX_SPEECH.maxMoras ||
        !Number.isInteger(phrase.accent) || phrase.accent < 1 || phrase.accent > phrase.moras.length ||
        (phrase.is_interrogative !== undefined && typeof phrase.is_interrogative !== 'boolean')) throw invalid();
    return {
      moras: phrase.moras.map(item => mora(item)), accent: phrase.accent,
      pause_mora: phrase.pause_mora == null ? null : mora(phrase.pause_mora, true),
      is_interrogative: phrase.is_interrogative ?? false,
    };
  });
  // Only validated phonemes and these fixed settings return to the local engine.
  // Pause controls are normalized; no upstream URL, metadata or extension is forwarded.
  const query = {
    accent_phrases: phrases,
    speedScale: VOICEVOX_SPEECH.speedScale, pitchScale: VOICEVOX_SPEECH.pitchScale,
    intonationScale: VOICEVOX_SPEECH.intonationScale, volumeScale: 1,
    prePhonemeLength: value.prePhonemeLength, postPhonemeLength: value.postPhonemeLength,
    pauseLength: null, pauseLengthScale: 1,
    outputSamplingRate: VOICEVOX_SPEECH.outputSamplingRate, outputStereo: VOICEVOX_SPEECH.outputStereo,
  };
  const cues = [];
  let cursor = query.prePhonemeLength / query.speedScale;
  for (const phrase of phrases) {
    for (const item of [...phrase.moras, ...(phrase.pause_mora ? [phrase.pause_mora] : [])]) {
      cursor += (item.consonant_length ?? 0) / query.speedScale;
      const end = cursor + item.vowel_length / query.speedScale;
      const vowel = VISEMES[item.vowel.toLowerCase()];
      if (vowel && end > cursor) cues.push({ start: cursor, end, vowel });
      cursor = end;
    }
  }
  const duration = cursor + query.postPhonemeLength / query.speedScale;
  if (!Number.isFinite(duration) || duration <= 0 || duration > VOICEVOX_SPEECH.maxDurationSeconds) throw invalid();
  return { query, cues, duration };
}

function wavDuration(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const fourcc = offset => String.fromCharCode(...bytes.subarray(offset, offset + 4));
  if (bytes.byteLength < 44 || fourcc(0) !== 'RIFF' || fourcc(8) !== 'WAVE' || view.getUint32(4, true) + 8 !== bytes.byteLength) throw invalid();
  let offset = 12;
  let format = false;
  let dataBytes = 0;
  let chunks = 0;
  while (offset < bytes.byteLength) {
    if (++chunks > 256 || offset + 8 > bytes.byteLength) throw invalid();
    const kind = fourcc(offset);
    const size = view.getUint32(offset + 4, true);
    const start = offset + 8;
    const end = start + size;
    const paddedEnd = end + size % 2;
    if (paddedEnd > bytes.byteLength) throw invalid();
    if (kind === 'fmt ') {
      if (format || (size !== 16 && size !== 18) || (size === 18 && view.getUint16(start + 16, true) !== 0) ||
          view.getUint16(start, true) !== 1 || view.getUint16(start + 2, true) !== 1 ||
          view.getUint32(start + 4, true) !== 24000 || view.getUint32(start + 8, true) !== 48000 ||
          view.getUint16(start + 12, true) !== 2 || view.getUint16(start + 14, true) !== 16) throw invalid();
      format = true;
    } else if (kind === 'data') {
      if (!format || dataBytes !== 0 || size === 0 || size % 2 !== 0) throw invalid();
      dataBytes = size;
    }
    offset = paddedEnd;
  }
  const duration = dataBytes / 48000;
  if (!format || duration <= 0 || duration > VOICEVOX_SPEECH.maxDurationSeconds) throw invalid();
  return duration;
}

/** Main-process only; constructing this adapter performs no discovery or startup. */
export function createVoicevoxSpeech({ fetchImpl = globalThis.fetch, timeoutMs = VOICEVOX_SPEECH.timeoutMs } = {}) {
  const deadline = Number.isInteger(timeoutMs) && timeoutMs >= 1 && timeoutMs <= VOICEVOX_SPEECH.timeoutMs ? timeoutMs : VOICEVOX_SPEECH.timeoutMs;
  return Object.freeze({
    /**
     * @param {string} text
     * @param {{signal?: AbortSignal}} [context]
     * @returns {Promise<{audio: ArrayBuffer, cues: {start: number, end: number, vowel: 'aa' | 'ih' | 'ou' | 'ee' | 'oh'}[], duration: number}>}
     */
    async synthesize(text, { signal } = {}) {
      if (typeof text !== 'string' || !text.trim() || text.length > VOICEVOX_SPEECH.maxTextCharacters) throw new VoicevoxSpeechError('invalid-text');
      if (signal?.aborted) throw abortError();
      const controller = new AbortController();
      let timedOut = false;
      let rejectAbort;
      const aborted = new Promise((resolve, reject) => { rejectAbort = reject; });
      const onInternalAbort = () => rejectAbort(abortError());
      controller.signal.addEventListener('abort', onInternalAbort, { once: true });
      const onAbort = () => controller.abort();
      signal?.addEventListener('abort', onAbort, { once: true });
      const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, deadline);
      async function request(url, body, maximum) {
        let response;
        try {
          if (controller.signal.aborted) throw abortError();
          const pending = Promise.resolve().then(() => {
            if (controller.signal.aborted) throw abortError();
            return fetchImpl(url, {
              method: 'POST', redirect: 'error', signal: controller.signal,
              ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body }),
            });
          }).then(value => {
            if (controller.signal.aborted) { discardBody(value?.body); throw abortError(); }
            return value;
          });
          response = await Promise.race([pending, aborted]);
          if (!response.ok || response.redirected) throw new VoicevoxSpeechError(response.status >= 500 ? 'unavailable' : 'invalid-response');
          return await boundedBytes(response, maximum, controller.signal, aborted);
        } finally { discardBody(response?.body); }
      }
      try {
        const queryURL = new URL('/audio_query', VOICEVOX_SPEECH.endpoint);
        queryURL.searchParams.set('speaker', String(VOICEVOX_SPEECH.speaker));
        queryURL.searchParams.set('text', text.trim());
        const bytes = await request(queryURL.href, undefined, VOICEVOX_SPEECH.maxQueryBytes);
        let value;
        try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
        catch { throw invalid(); }
        const timing = validatedQuery(value);
        // Disable the engine's extra question-ending mora, absent from audio_query.
        const synthesisURL = `${VOICEVOX_SPEECH.endpoint}/synthesis?speaker=${VOICEVOX_SPEECH.speaker}&enable_interrogative_upspeak=false`;
        const audio = await request(synthesisURL, JSON.stringify(timing.query), VOICEVOX_SPEECH.maxAudioBytes);
        const duration = wavDuration(audio);
        if (controller.signal.aborted) throw abortError();
        const scale = duration / timing.duration;
        return {
          audio: audio.buffer,
          cues: timing.cues.map(cue => ({ start: cue.start * scale, end: Math.min(duration, cue.end * scale), vowel: cue.vowel })),
          duration,
        };
      } catch (error) {
        if (signal?.aborted) throw abortError();
        if (timedOut) throw new VoicevoxSpeechError('timeout');
        if (error instanceof VoicevoxSpeechError) throw error;
        throw new VoicevoxSpeechError('unavailable');
      } finally {
        clearTimeout(timeout);
        signal?.removeEventListener('abort', onAbort);
        controller.signal.removeEventListener('abort', onInternalAbort);
        controller.abort();
      }
    },
  });
}
