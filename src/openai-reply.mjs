import { DialogueReplyError } from './dialogue-error.mjs';

export const OPENAI_DIALOGUE = Object.freeze({
  model: 'gpt-5.6-luna',
  historyTurns: 6,
  contextCharacters: 6000,
  maxOutputTokens: 400,
  replyTimeoutMs: 30000,
});

const ENDPOINT = 'https://api.openai.com/v1/responses';
const MAX_BODY_BYTES = 128 * 1024;
const INPUT_CHARACTERS = 1000;
const REPLY_CHARACTERS = 4000;
const INSTRUCTIONS = [
  'あなたは月白しずく。デスクトップで静かに寄り添う、控えめでお淑やかなAIキャラクターです。',
  '日本語で、柔らかく親しい口調の短い1〜3文を基本に返答してください。相手の話に応じ、勝手に長話を始めないでください。',
  '分からないことは分からないと伝え、何でも肯定せず、事実と想像を区別してください。',
  'あなたに見えるのは、この会話で送られた文章だけです。画面、マイク、ファイル、他のアプリを見たり操作したりする機能はありません。見た、聞いた、操作したと装わないでください。',
  '人間であると主張しないでください。必要な場面ではAIキャラクターだと率直に伝えてください。',
  '既存作品の固有設定や台詞を自分の設定として使わないでください。',
].join('\n');

/** Keep only complete adjacent pairs, then drop whole older pairs at either bound. */
function boundedHistory(history) {
  if (!Array.isArray(history)) return [];
  const pairs = [];
  for (let index = 0; index + 1 < history.length; index++) {
    const user = history[index], assistant = history[index + 1];
    if (user?.role !== 'user' || assistant?.role !== 'assistant' ||
        typeof user.text !== 'string' || !user.text.trim() || user.text.length > INPUT_CHARACTERS ||
        typeof assistant.text !== 'string' || !assistant.text.trim() || assistant.text.length > REPLY_CHARACTERS) continue;
    pairs.push([{ role: 'user', content: user.text }, { role: 'assistant', content: assistant.text }]);
    index++;
  }
  const selected = [];
  let characters = 0;
  for (const pair of pairs.slice(-OPENAI_DIALOGUE.historyTurns).reverse()) {
    const size = pair[0].content.length + pair[1].content.length;
    if (characters + size > OPENAI_DIALOGUE.contextCharacters) break;
    selected.unshift(pair);
    characters += size;
  }
  return selected.flat();
}

function abortError() { return new DOMException('The operation was aborted.', 'AbortError'); }

function discardBody(body) {
  // Cancellation must never wait for a remote stream or echo an upstream error.
  try { void body?.cancel().catch(() => {}); } catch { /* Already locked or closed. */ }
}

async function boundedJson(response, signal) {
  const declared = response.headers.get('content-length');
  if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > MAX_BODY_BYTES)) {
    discardBody(response.body);
    throw new DialogueReplyError('invalid-response');
  }
  if (!response.body || typeof response.body.getReader !== 'function') {
    throw new DialogueReplyError('invalid-response');
  }
  const reader = response.body.getReader();
  let rejectAbort;
  const aborted = new Promise((resolve, reject) => { rejectAbort = reject; });
  const onAbort = () => rejectAbort(abortError());
  signal.addEventListener('abort', onAbort, { once: true });
  const chunks = [];
  let size = 0;
  let completed = false;
  try {
    if (signal.aborted) throw abortError();
    for (;;) {
      const part = await Promise.race([reader.read(), aborted]);
      if (signal.aborted) throw abortError();
      if (part.done) break;
      if (!(part.value instanceof Uint8Array) || size + part.value.byteLength > MAX_BODY_BYTES) {
        throw new DialogueReplyError('invalid-response');
      }
      chunks.push(part.value);
      size += part.value.byteLength;
    }
    completed = true;
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
    catch { throw new DialogueReplyError('invalid-response'); }
  } finally {
    signal.removeEventListener('abort', onAbort);
    if (!completed) {
      try { void reader.cancel().catch(() => {}); } catch { /* No remote diagnostic is retained. */ }
    }
    try { reader.releaseLock(); } catch { /* Cancellation can still be settling. */ }
  }
}

function replyText(response) {
  if (!response || typeof response !== 'object' || Array.isArray(response)) {
    throw new DialogueReplyError('invalid-response');
  }
  if (response.status === 'incomplete') throw new DialogueReplyError('incomplete');
  if (response.status !== 'completed' || response.error != null || response.incomplete_details != null ||
      !Array.isArray(response.output) || response.output.length === 0) {
    throw new DialogueReplyError('invalid-response');
  }
  const text = [];
  let length = 0;
  for (const message of response.output) {
    // Responses can include reasoning metadata. It never enters the UI or history.
    if (message?.type === 'reasoning') continue;
    if (message?.type !== 'message' || message.role !== 'assistant' || message.status !== 'completed' ||
        !Array.isArray(message.content) || message.content.length === 0) {
      throw new DialogueReplyError('invalid-response');
    }
    for (const item of message.content) {
      if (item?.type !== 'output_text' || typeof item.text !== 'string') {
        throw new DialogueReplyError('invalid-response');
      }
      length += item.text.length;
      if (length > REPLY_CHARACTERS) throw new DialogueReplyError('invalid-response');
      text.push(item.text);
    }
  }
  const result = text.join('').trim();
  if (!result) throw new DialogueReplyError('invalid-response');
  return result;
}

/**
 * Main-process only. The returned object never contains the key. No request occurs
 * until reply is called; only explicit text and a bounded conversation are sent.
 * @param {{apiKey?: unknown, fetchImpl?: typeof fetch}} [options]
 */
export function createOpenAIConnection({ apiKey, fetchImpl = globalThis.fetch } = {}) {
  const key = typeof apiKey === 'string' && /^[\x21-\x7e]{1,512}$/u.test(apiKey) ? apiKey : null;
  return Object.freeze({
    available: key !== null,
    model: OPENAI_DIALOGUE.model,
    /** @param {string} text @param {{signal?: AbortSignal, history?: unknown[]}} [context] */
    async reply(text, { signal, history = [] } = {}) {
      if (!key) throw new DialogueReplyError('missing-key');
      if (typeof text !== 'string' || text.length > INPUT_CHARACTERS || !text.trim()) {
        throw new DialogueReplyError('invalid-response');
      }
      if (signal?.aborted) throw abortError();
      const controller = new AbortController();
      const onAbort = () => controller.abort();
      signal?.addEventListener('abort', onAbort, { once: true });
      const timeout = setTimeout(() => controller.abort(), OPENAI_DIALOGUE.replyTimeoutMs);
      let response;
      try {
        response = await fetchImpl(ENDPOINT, {
          method: 'POST',
          redirect: 'error',
          signal: controller.signal,
          headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: OPENAI_DIALOGUE.model,
            instructions: INSTRUCTIONS,
            input: [...boundedHistory(history), { role: 'user', content: text.trim() }],
            reasoning: { effort: 'none' },
            max_output_tokens: OPENAI_DIALOGUE.maxOutputTokens,
            store: false,
          }),
        });
        if (controller.signal.aborted) throw abortError();
        if (!response.ok) {
          const status = response.status;
          throw new DialogueReplyError(status === 401 || status === 403 ? 'auth'
            : status === 429 ? 'rate-limit' : status >= 500 || status === 408 ? 'unavailable' : 'invalid-response');
        }
        const result = await boundedJson(response, controller.signal);
        if (controller.signal.aborted) throw abortError();
        return replyText(result);
      } catch (error) {
        if (error instanceof DialogueReplyError) throw error;
        if (controller.signal.aborted) throw abortError();
        throw new DialogueReplyError('unavailable');
      } finally {
        clearTimeout(timeout);
        signal?.removeEventListener('abort', onAbort);
        discardBody(response?.body);
        controller.abort();
      }
    },
  });
}
