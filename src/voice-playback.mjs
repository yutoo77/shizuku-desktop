/** @typedef {'aa'|'ih'|'ou'|'ee'|'oh'} MouthVowel */
/** @typedef {{id:number, audio:ArrayBuffer, cues:Array<{start:number,end:number,vowel:MouthVowel}>, duration:number}} VoicePacket */

const VOWELS = new Set(['aa', 'ih', 'ou', 'ee', 'oh']);
const MAX_AUDIO_BYTES = 8 * 1024 * 1024;
const MAX_DURATION = 90;

/**
 * Plays one explicitly requested reply. The audio clock drives the mouth; no
 * microphone, media URL, network request, or timer survives a finished reply.
 * @param {{contextFactory?:()=>AudioContext,onMouth?:(id:number,vowel:MouthVowel|null,weight:number)=>void,onState?:(id:number,state:'playing'|'ended'|'error')=>void,setIntervalImpl?:typeof setInterval,clearIntervalImpl?:typeof clearInterval,setTimeoutImpl?:typeof setTimeout,clearTimeoutImpl?:typeof clearTimeout}} options
 */
export function createVoicePlayback({
  contextFactory = () => new AudioContext(),
  onMouth = () => {},
  onState = () => {},
  setIntervalImpl = setInterval,
  clearIntervalImpl = clearInterval,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
} = {}) {
  let context = null;
  let source = null;
  let timer = null;
  let currentId = null;
  let revision = 0;
  let disposed = false;
  const preparations = new Set();

  function emitMouth(id, vowel, weight) {
    try { onMouth(id, vowel, weight); } catch { /* UI teardown cannot retain audio. */ }
  }

  function emitState(id, state) {
    try { onState(id, state); } catch { /* Keep cleanup independent of the consumer. */ }
  }

  function releaseSource() {
    if (timer !== null) clearIntervalImpl(timer);
    timer = null;
    const previous = source;
    const previousId = currentId;
    source = null;
    currentId = null;
    if (previous) {
      previous.onended = null;
      try { previous.stop(); } catch { /* A source can already have ended. */ }
      try { previous.disconnect(); } catch { /* Already disconnected. */ }
      previous.buffer = null;
    }
    if (previousId !== null) emitMouth(previousId, null, 0);
  }

  function releaseContext() {
    const previous = context;
    context = null;
    for (const finish of preparations) finish(false);
    if (previous && previous.state !== 'closed') {
      try { void previous.close().catch(() => {}); } catch { /* Already closing. */ }
    }
  }

  function resumeBounded(prepared) {
    return new Promise(resolve => {
      let settled = false, timeout = null;
      const finish = success => {
        if (settled) return;
        settled = true;
        if (timeout !== null) clearTimeoutImpl(timeout);
        preparations.delete(finish);
        resolve(success);
      };
      preparations.add(finish);
      try {
        // A blocked browser autoplay/device promise can remain pending forever.
        // Preserve the current gesture while bounding text-send waiting time.
        const resumed = prepared.resume();
        timeout = setTimeoutImpl(() => finish(false), 1500);
        Promise.resolve(resumed).then(() => finish(true), () => finish(false));
      } catch { finish(false); }
    });
  }

  /** Invoke directly from the voice checkbox or explicit send event. */
  async function prepare() {
    if (disposed) return false;
    let prepared;
    try {
      if (!context || context.state === 'closed') context = contextFactory();
      prepared = context;
      // Call resume before yielding so the browser can use the current gesture.
      if (!await resumeBounded(prepared)) throw new Error('audio unavailable');
      return !disposed && context === prepared && prepared.state === 'running';
    } catch {
      if (context === prepared) {
        revision += 1;
        releaseSource();
        releaseContext();
      }
      return false;
    }
  }

  /** Resolves after starting (or discarding) this packet, never waits for its end.
   * @param {VoicePacket} packet
   */
  async function play(packet) {
    if (disposed) return;
    const operation = ++revision;
    releaseSource();
    const id = packet?.id;
    if (!Number.isSafeInteger(id) || id < 0) { releaseContext(); return; }
    currentId = id;
    const playbackContext = context;
    const current = () => !disposed && revision === operation && context === playbackContext;
    try {
      if (!validPacket(packet) || !playbackContext || playbackContext.state !== 'running') throw new Error('unprepared');
      // Snapshot cue values before decoding yields. decodeAudioData may detach its
      // input; keep the caller's packet independent of this operation.
      const cues = packet.cues.map(cue => ({ ...cue }));
      const buffer = await playbackContext.decodeAudioData(packet.audio.slice(0));
      if (!current()) return;
      if (!Number.isFinite(buffer.duration) || buffer.duration <= 0 || buffer.duration > MAX_DURATION
        || !Number.isFinite(buffer.sampleRate) || buffer.sampleRate <= 0
        || !Number.isSafeInteger(buffer.length) || buffer.length <= 0
        || !Number.isSafeInteger(buffer.numberOfChannels) || buffer.numberOfChannels < 1 || buffer.numberOfChannels > 2) throw new Error('invalid audio');
      const channels = Array.from({ length: buffer.numberOfChannels }, (_, channel) => buffer.getChannelData(channel));
      const playingSource = playbackContext.createBufferSource();
      source = playingSource;
      playingSource.buffer = buffer;
      playingSource.connect(playbackContext.destination);
      const started = playbackContext.currentTime;
      let cueIndex = 0;
      const ownsSource = () => current() && source === playingSource;
      const finish = state => {
        if (!ownsSource()) return;
        revision += 1;
        releaseSource();
        releaseContext();
        emitState(id, state);
      };
      const tick = () => {
        if (!ownsSource()) return;
        const elapsed = Math.max(0, playbackContext.currentTime - started);
        if (playbackContext.state !== 'running') { finish('error'); return; }
        if (elapsed >= buffer.duration) { finish('ended'); return; }
        while (cueIndex < cues.length && cues[cueIndex].end <= elapsed) cueIndex += 1;
        const cue = cues[cueIndex];
        if (!cue || elapsed < cue.start) { emitMouth(id, null, 0); return; }
        const from = Math.min(buffer.length, Math.floor(elapsed * buffer.sampleRate));
        const to = Math.min(buffer.length, from + Math.min(2048, Math.ceil(buffer.sampleRate * 0.025)));
        let energy = 0;
        for (const channel of channels) {
          for (let index = from; index < to; index += 1) energy += channel[index] * channel[index];
        }
        const rms = Math.sqrt(energy / Math.max(1, (to - from) * channels.length));
        const weight = Number.isFinite(rms) ? Math.min(0.85, Math.max(0, (rms - 0.012) * 3.2)) : 0;
        emitMouth(id, weight > 0 ? cue.vowel : null, weight);
      };
      playingSource.onended = () => finish('ended');
      playingSource.start();
      emitState(id, 'playing');
      if (!ownsSource()) return;
      tick();
      if (ownsSource()) timer = setIntervalImpl(tick, 50);
    } catch {
      if (!current()) return;
      revision += 1;
      releaseSource();
      releaseContext();
      emitState(id, 'error');
    }
  }

  function stop() {
    revision += 1;
    releaseSource();
    releaseContext();
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    stop();
  }

  return Object.freeze({ prepare, play, stop, dispose });
}

function validPacket(packet) {
  if (!(packet.audio instanceof ArrayBuffer) || packet.audio.byteLength === 0 || packet.audio.byteLength > MAX_AUDIO_BYTES
    || !Number.isFinite(packet.duration) || packet.duration <= 0 || packet.duration > MAX_DURATION
    || !Array.isArray(packet.cues) || packet.cues.length > 6000) return false;
  let end = 0;
  for (const cue of packet.cues) {
    if (!cue || !Number.isFinite(cue.start) || !Number.isFinite(cue.end) || cue.start < end
      || cue.end <= cue.start || cue.end > packet.duration + 0.5 || !VOWELS.has(cue.vowel)) return false;
    end = cue.end;
  }
  return true;
}
