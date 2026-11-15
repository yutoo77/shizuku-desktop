import { dialogueErrorMessage } from './dialogue-error.mjs';

/** Sessions own cancellation and RAM-only history; providers own transport. */
export const DIALOGUE_LIMITS = Object.freeze({
  inputCharacters: 1000,
  replyCharacters: 4000,
  historyMessages: 40,
  replyTimeoutMs: 15000,
});

/** @typedef {{id: string, role: 'user' | 'assistant', text: string}} DialogueMessage */
/** @typedef {{status: 'idle' | 'pending' | 'error', messages: DialogueMessage[], error: string | null, provider: 'local-demo' | 'openai', inputLimit: number}} DialogueSnapshot */
/** @typedef {(text: string, context: {signal: AbortSignal, history: DialogueMessage[]}) => Promise<string>} Reply */

/** @type {Reply} */
async function localReply(text) {
  if (/名前|だれ|誰|自己紹介|人間|\bai\b|人工知能/iu.test(text)) {
    return '月白しずくだよ。人間ではなく、AIと会話するためのキャラクターなの。今はAIには接続せず、用意した短い返事だけを返しているよ。';
  }
  if (/疲れ|つかれ|眠い|ねむい/u.test(text)) {
    return 'おつかれさま。少し休むなら、わたしはここで静かに待っているね。';
  }
  if (/ありがとう|ありがと|助かった/u.test(text)) {
    return 'こちらこそ、話しかけてくれてありがとう。';
  }
  if (/おやすみ|またね|さようなら|バイバイ/u.test(text)) {
    return 'うん、またね。わたしは静かに待っているね。';
  }
  if (/こんにちは|こんばんは|おはよう|はじめまして/u.test(text)) {
    return 'こんにちは。呼んでくれてありがとう。';
  }
  return 'うん、聞いたよ。今は短い返事のお試しだけれど、ここにいるね。';
}

/**
 * Replies receive the earlier messages, excluding the new text passed separately.
 * replyTimeoutMs is injectable for deterministic tests; production uses the default.
 * Input length uses UTF-16 code units, matching a textarea's maxlength.
 * @param {{reply?: Reply, provider?: 'local-demo' | 'openai', onChange?: (state: DialogueSnapshot) => void, replyTimeoutMs?: number}} [options]
 */
export function createDialogueSession(options = {}) {
  const reply = options.reply ?? localReply;
  const provider = options.provider ?? 'local-demo';
  if (provider !== 'local-demo' && provider !== 'openai') throw new TypeError('Invalid provider');
  if (provider === 'openai' && !options.reply) throw new TypeError('External provider requires a reply adapter');
  const timeoutMs = options.replyTimeoutMs ?? DIALOGUE_LIMITS.replyTimeoutMs;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError('replyTimeoutMs must be a positive finite number');
  }
  /** @type {DialogueMessage[]} */
  let messages = [];
  /** @type {DialogueSnapshot['status']} */
  let status = 'idle';
  /** @type {string | null} */
  let error = null;
  let nextId = 0;
  let disposed = false;
  /** @type {{controller: AbortController, timer: ReturnType<typeof setTimeout> | null} | null} */
  let active = null;

  /** @returns {DialogueSnapshot} */
  function snapshot() {
    return {
      status, messages: messages.map(message => ({ ...message })), error,
      provider, inputLimit: DIALOGUE_LIMITS.inputCharacters,
    };
  }

  function emit() {
    // A failing view must not leave a live request or break cancellation.
    try { options.onChange?.(snapshot()); } catch { /* No user text is logged. */ }
  }

  function pruneHistory() {
    while (messages.length > DIALOGUE_LIMITS.historyMessages) {
      const nextUser = messages.findIndex((message, index) => index > 0 && message.role === 'user');
      messages.splice(0, nextUser < 0 ? 1 : nextUser);
    }
  }

  function stopActive() {
    const operation = active;
    active = null;
    if (!operation) return;
    if (operation.timer !== null) clearTimeout(operation.timer);
    operation.controller.abort();
  }

  /** @param {unknown} text */
  function send(text) {
    if (disposed || active || typeof text !== 'string' ||
        text.length > DIALOGUE_LIMITS.inputCharacters || text.trim().length === 0) return false;
    const input = text.trim();
    // Aborted and failed user entries remain visible, but must never be replayed
    // into a later request. Only adjacent completed turns form provider context.
    const history = [];
    for (let index = 0; index + 1 < messages.length; index++) {
      if (messages[index].role === 'user' && messages[index + 1].role === 'assistant') {
        history.push({ ...messages[index] }, { ...messages[++index] });
      }
    }
    const operation = { controller: new AbortController(), timer: /** @type {ReturnType<typeof setTimeout> | null} */ (null) };
    active = operation;
    status = 'pending';
    error = null;
    messages.push({ id: String(++nextId), role: 'user', text: input });
    pruneHistory();
    operation.timer = setTimeout(() => {
      if (disposed || active !== operation) return;
      stopActive();
      status = 'error';
      error = '返事が間に合わなかったよ。もう一度送ってみてね。';
      emit();
    }, timeoutMs);
    emit();

    void Promise.resolve().then(async () => {
      if (disposed || active !== operation) return;
      try {
        const answer = await reply(input, { signal: operation.controller.signal, history });
        if (disposed || active !== operation) return;
        if (typeof answer !== 'string' || answer.length > DIALOGUE_LIMITS.replyCharacters ||
            answer.trim().length === 0) throw new TypeError('Invalid reply');
        if (operation.timer !== null) clearTimeout(operation.timer);
        active = null;
        messages.push({ id: String(++nextId), role: 'assistant', text: answer.trim() });
        pruneHistory();
        status = 'idle';
        emit();
      } catch (failure) {
        if (disposed || active !== operation) return;
        stopActive();
        status = 'error';
        error = dialogueErrorMessage(failure);
        emit();
      }
    });
    return true;
  }

  function cancel() {
    if (disposed) return;
    stopActive();
    status = 'idle';
    error = null;
    emit();
  }

  function clear() {
    if (disposed) return;
    stopActive();
    messages = [];
    status = 'idle';
    error = null;
    emit();
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    stopActive();
    messages = [];
    status = 'idle';
    error = null;
  }

  return { snapshot, send, cancel, clear, dispose };
}
