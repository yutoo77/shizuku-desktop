// Main-process voice lifetime. Only completed session replies reach synthesize;
// renderer IPC cannot choose text, a speaker, a path or a network destination.
/** @param {{synthesize:(text:string,context:{signal:AbortSignal})=>Promise<Omit<import('./voice-playback.mjs').VoicePacket,'id'>>,onChange?:(state:unknown)=>void,onAudio?:(packet:unknown)=>void,onStop?:(id:number)=>void,onMouth?:(vowel:string|null,weight:number)=>void}} options */
export function createDialogueVoice({ synthesize, onChange = () => {}, onAudio = () => {}, onStop = () => {}, onMouth = () => {} }) {
  let enabled = false, disposed = false, revision = 0, active = null;
  let status = 'idle', error = null;
  const snapshot = () => ({ enabled, status, error, id: revision });
  const emit = () => { if (!disposed) onChange(snapshot()); };
  function stop() {
    const previous = active;
    active = null;
    if (previous) { clearTimeout(previous.timer); previous.controller.abort(); }
    status = 'idle'; error = null;
    onStop(++revision);
    onMouth(null, 0);
    emit();
  }
  function fail(operation, message) {
    if (disposed || active !== operation) return;
    stop(); error = message; status = 'error'; emit();
  }
  function setEnabled(value) {
    if (disposed || typeof value !== 'boolean') return false;
    if (enabled === value) return true;
    if (!value) stop();
    enabled = value; error = null; emit(); return true;
  }
  async function speak(text) {
    if (disposed || !enabled) return;
    // The caller stops earlier speech before submitting a new conversation turn.
    if (active) stop();
    const operation = { id: ++revision, controller: new AbortController(), timer: null, lastMouth: 0, duration: 0 };
    active = operation; status = 'synthesizing'; error = null; emit();
    operation.timer = setTimeout(() => fail(operation, '声の準備が間に合いませんでした。文字で読んでね。'), 35000);
    try {
      const packet = await synthesize(text, { signal: operation.controller.signal });
      if (disposed || active !== operation) return;
      clearTimeout(operation.timer);
      operation.duration = packet.duration;
      status = 'ready'; emit();
      operation.timer = setTimeout(() => fail(operation, '音声を再生できませんでした。次の送信で再度試せます。'), 5000);
      onAudio({ ...packet, id: operation.id });
    } catch {
      fail(operation, typeof text === 'string' && text.length > 1000
        ? '長い返答は読み上げません。1000文字以内の返答に対応しています。'
        : '声を出せませんでした。VOICEVOXの起動と冥鳴ひまりの音声を確認してね。');
    }
  }
  function report(id, state) {
    const operation = active;
    if (disposed || !operation || id !== operation.id) return false;
    if (state === 'playing' && status === 'ready') {
      clearTimeout(operation.timer);
      status = 'playing';
      operation.timer = setTimeout(() => fail(operation, '読み上げを終了しました。'), Math.ceil(operation.duration * 1000) + 2000);
      emit(); return true;
    }
    if (state === 'ended' && status === 'playing') { stop(); return true; }
    if (state === 'error') { fail(operation, '音声を再生できませんでした。次の送信で再度試せます。'); return true; }
    return false;
  }
  function mouth(id, vowel, weight) {
    if (disposed || !active || status !== 'playing' || id !== active.id ||
      (vowel !== null && !['aa', 'ih', 'ou', 'ee', 'oh'].includes(vowel)) ||
      typeof weight !== 'number' || !Number.isFinite(weight) || weight < 0 || weight > 1) return false;
    // A compromised renderer cannot flood the avatar with arbitrary expressions.
    const now = performance.now();
    if (now - active.lastMouth < 35) return false;
    active.lastMouth = now;
    onMouth(vowel, vowel === null ? 0 : weight); return true;
  }
  function dispose() { if (disposed) return; stop(); enabled = false; disposed = true; }
  return { snapshot, setEnabled, speak, stop, report, mouth, dispose };
}
