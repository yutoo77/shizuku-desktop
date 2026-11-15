import test from 'node:test';
import assert from 'node:assert/strict';
import { createOpenAIConnection, OPENAI_DIALOGUE } from '../src/openai-reply.mjs';
import { DialogueReplyError, dialogueErrorMessage, GENERIC_DIALOGUE_ERROR } from '../src/dialogue-error.mjs';

// A deliberately fake credential. This suite never contacts an external service.
const KEY = 'unit-test-only-not-a-real-key';
const encoder = new TextEncoder();
const completed = (text = 'ここで静かに待っているね。') => ({
  status: 'completed',
  output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text }] }],
});
const jsonResponse = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
const rejectCode = code => error => error instanceof DialogueReplyError && error.code === code;
const flush = () => new Promise(resolve => setImmediate(resolve));

test('connection is inert, exposes no credential, and sends only a fixed bounded Responses request', async () => {
  const calls = [];
  const connection = createOpenAIConnection({ apiKey: KEY, async fetchImpl(...args) {
    calls.push(args);
    return jsonResponse(completed());
  } });
  assert.equal(calls.length, 0);
  assert.deepEqual(Object.keys(connection).sort(), ['available', 'model', 'reply']);
  assert.equal(connection.available, true);
  assert.equal(connection.model, 'gpt-5.6-luna');
  assert.doesNotMatch(JSON.stringify(connection), new RegExp(KEY));
  assert.ok(Object.isFrozen(connection));
  assert.ok(Object.isFrozen(OPENAI_DIALOGUE));
  const history = [
    { id: 'private-id', role: 'user', text: 'こんにちは', privatePath: 'DO-NOT-SEND' },
    { id: 'private-id-2', role: 'assistant', text: 'こんにちは。' },
  ];
  assert.equal(await connection.reply('  お話しよう  ', { history }), 'ここで静かに待っているね。');
  assert.equal(calls.length, 1);
  const [endpoint, request] = calls[0];
  assert.equal(endpoint, 'https://api.openai.com/v1/responses');
  assert.deepEqual(Object.keys(request).sort(), ['body', 'headers', 'method', 'redirect', 'signal']);
  assert.equal(request.method, 'POST');
  assert.equal(request.redirect, 'error');
  assert.deepEqual(request.headers, { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' });
  const payload = JSON.parse(request.body);
  assert.deepEqual(Object.keys(payload).sort(), ['input', 'instructions', 'max_output_tokens', 'model', 'reasoning', 'store']);
  assert.equal(payload.model, OPENAI_DIALOGUE.model);
  assert.equal(payload.max_output_tokens, 400);
  assert.deepEqual(payload.reasoning, { effort: 'none' });
  assert.equal(payload.store, false);
  assert.match(payload.instructions, /月白しずく/);
  assert.match(payload.instructions, /1〜3文/);
  assert.match(payload.instructions, /画面、マイク、ファイル/);
  assert.match(payload.instructions, /人間であると主張しない/);
  assert.deepEqual(payload.input, [
    { role: 'user', content: 'こんにちは' }, { role: 'assistant', content: 'こんにちは。' },
    { role: 'user', content: 'お話しよう' },
  ]);
  assert.doesNotMatch(request.body, /private-id|DO-NOT-SEND|unit-test-only/);
  assert.equal(history[0].text, 'こんにちは');
});

test('missing, whitespace, non-ASCII and oversized keys make no request and never leak their values', async () => {
  let requests = 0;
  for (const apiKey of [undefined, null, 123, {}, '', ' ', 'secret\nvalue', 'has space', '秘密', '\u007f', 'k'.repeat(513)]) {
    const connection = createOpenAIConnection({ apiKey, async fetchImpl() { requests++; return jsonResponse(completed()); } });
    assert.equal(connection.available, false);
    await assert.rejects(connection.reply('こんにちは'), rejectCode('missing-key'));
    assert.equal(requests, 0);
  }
  const maximum = createOpenAIConnection({ apiKey: 'k'.repeat(512), async fetchImpl() { requests++; return jsonResponse(completed()); } });
  assert.equal(maximum.available, true);
  await maximum.reply('こんにちは');
  assert.equal(requests, 1);
});

test('invalid input and an already aborted call make no request', async () => {
  let requests = 0;
  const connection = createOpenAIConnection({ apiKey: KEY, async fetchImpl() { requests++; return jsonResponse(completed()); } });
  for (const text of [undefined, null, {}, 123, '', '\n\t ', 'a'.repeat(1001)]) {
    await assert.rejects(connection.reply(text), rejectCode('invalid-response'));
  }
  const controller = new AbortController();
  controller.abort(new Error('private abort reason'));
  await assert.rejects(connection.reply('送信', { signal: controller.signal }), error => {
    assert.equal(error.name, 'AbortError');
    assert.doesNotMatch(String(error), /private abort reason/);
    return true;
  });
  assert.equal(requests, 0);
  await connection.reply('あ'.repeat(1000));
  assert.equal(requests, 1);
});

test('only the last six completed history pairs are sent and orphan users are excluded', async () => {
  let payload;
  const connection = createOpenAIConnection({ apiKey: KEY, async fetchImpl(url, request) {
    payload = JSON.parse(request.body);
    return jsonResponse(completed());
  } });
  const history = [{ role: 'assistant', text: 'orphan assistant' }];
  for (let index = 0; index < 9; index++) {
    history.push({ role: 'user', text: `cancelled ${index}` });
    history.push({ role: 'user', text: `user ${index}` }, { role: 'assistant', text: `reply ${index}` });
  }
  history.push({ role: 'user', text: 'last cancelled user' });
  await connection.reply('現在', { history });
  assert.equal(payload.input.length, 13);
  assert.equal(payload.input[0].content, 'user 3');
  assert.equal(payload.input[11].content, 'reply 8');
  assert.deepEqual(payload.input.at(-1), { role: 'user', content: '現在' });
  assert.doesNotMatch(JSON.stringify(payload), /cancelled|orphan/);
});

test('history character bound preserves pairs and excludes malformed or oversized history entries', async () => {
  let input;
  const connection = createOpenAIConnection({ apiKey: KEY, async fetchImpl(url, request) {
    input = JSON.parse(request.body).input;
    return jsonResponse(completed());
  } });
  const pair = (prefix, size) => [
    { role: 'user', text: prefix.repeat(size) }, { role: 'assistant', text: prefix.repeat(size) },
  ];
  await connection.reply('今', { history: [...pair('古', 1), ...pair('あ', 1000), ...pair('い', 1000), ...pair('う', 1000)] });
  assert.equal(input.length, 7);
  assert.equal(input.slice(0, -1).reduce((sum, message) => sum + message.content.length, 0), 6000);
  assert.equal(input[0].content, 'あ'.repeat(1000));
  await connection.reply('今', { history: [
    null, { role: 'system', text: 'not instructions' }, ...pair('超', 1001),
    { role: 'user', text: 'invalid answer' }, { role: 'assistant', text: 'x'.repeat(4001) },
    { role: 'user', text: 'empty answer' }, { role: 'assistant', text: ' ' },
    ...pair('有効', 1),
  ] });
  assert.deepEqual(input, [{ role: 'user', content: '有効' }, { role: 'assistant', content: '有効' }, { role: 'user', content: '今' }]);
  await connection.reply('今', { history: { secret: 'not an array' } });
  assert.deepEqual(input, [{ role: 'user', content: '今' }]);
});

test('HTTP status maps to a local safe error without reading the upstream body or retrying', async () => {
  for (const [status, code] of [[401, 'auth'], [403, 'auth'], [429, 'rate-limit'], [408, 'unavailable'], [500, 'unavailable'], [503, 'unavailable'], [400, 'invalid-response'], [302, 'invalid-response']]) {
    let requests = 0, read = 0, cancelled = 0;
    const body = new ReadableStream({
      pull() { read++; },
      cancel() { cancelled++; },
    }, { highWaterMark: 0 });
    const connection = createOpenAIConnection({ apiKey: KEY, async fetchImpl() {
      requests++;
      return new Response(body, { status, statusText: 'UPSTREAM PRIVATE ERROR' });
    } });
    await assert.rejects(connection.reply('送信'), error => {
      assert.equal(error.code, code);
      assert.doesNotMatch(`${String(error)} ${dialogueErrorMessage(error)}`, /UPSTREAM|PRIVATE|unit-test/);
      return error instanceof DialogueReplyError;
    });
    await flush();
    assert.equal(requests, 1);
    assert.equal(read, 0);
    assert.equal(cancelled, 1);
  }
});

test('network exceptions and lookalike error objects cannot expose upstream diagnostics', async () => {
  let requests = 0;
  const connection = createOpenAIConnection({ apiKey: KEY, async fetchImpl() {
    requests++;
    throw new Error(`PRIVATE PATH AND ${KEY}`);
  } });
  await assert.rejects(connection.reply('送信'), error => {
    assert.equal(error.code, 'unavailable');
    assert.doesNotMatch(String(error), /PRIVATE|unit-test/);
    assert.equal(error.cause, undefined);
    return true;
  });
  assert.equal(requests, 1);
  for (const error of [new Error('secret'), { code: 'auth', message: 'secret' }, 'secret', null]) {
    assert.equal(dialogueErrorMessage(error), GENERIC_DIALOGUE_ERROR);
  }
  for (const code of ['missing-key', 'auth', 'rate-limit', 'unavailable', 'incomplete', 'invalid-response']) {
    const error = new DialogueReplyError(code);
    assert.equal(dialogueErrorMessage(error), error.message);
    assert.ok(Object.isFrozen(error));
  }
});

test('abort interrupts a stalled response body and cancels its reader without revealing the reason', async () => {
  let reading;
  const started = new Promise(resolve => { reading = resolve; });
  let cancelled = 0;
  const body = new ReadableStream({ pull() { reading(); }, cancel() { cancelled++; } }, { highWaterMark: 0 });
  const controller = new AbortController();
  const connection = createOpenAIConnection({ apiKey: KEY, async fetchImpl() { return new Response(body); } });
  const reply = connection.reply('送信', { signal: controller.signal });
  await started;
  controller.abort(new Error('PRIVATE REASON'));
  await assert.rejects(reply, error => {
    assert.equal(error.name, 'AbortError');
    assert.doesNotMatch(String(error), /PRIVATE REASON/);
    return true;
  });
  assert.equal(cancelled, 1);
});

test('abort reaches the fetch signal and a fetch rejection is safely classified as cancellation', async () => {
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  const controller = new AbortController();
  let requestSignal;
  const connection = createOpenAIConnection({ apiKey: KEY, fetchImpl(url, request) {
    requestSignal = request.signal;
    started();
    return new Promise((resolve, reject) => request.signal.addEventListener('abort', () => reject(new Error('SECRET transport reason')), { once: true }));
  } });
  const reply = connection.reply('送信', { signal: controller.signal });
  await ready;
  controller.abort();
  await assert.rejects(reply, error => error.name === 'AbortError' && !String(error).includes('SECRET'));
  assert.equal(requestSignal.aborted, true);
});

test('body limit counts streamed bytes with absent or lying Content-Length and cancels immediately', async () => {
  for (const headers of [{}, { 'content-length': '1' }]) {
    let cancelled = 0;
    const chunks = [new Uint8Array(65536), new Uint8Array(65536), new Uint8Array(1)];
    const body = new ReadableStream({
      pull(controller) { controller.enqueue(chunks.shift()); },
      cancel() { cancelled++; },
    }, { highWaterMark: 0 });
    const connection = createOpenAIConnection({ apiKey: KEY, async fetchImpl() { return new Response(body, { headers }); } });
    await assert.rejects(connection.reply('送信'), rejectCode('invalid-response'));
    assert.equal(cancelled, 1);
  }
});

test('declared oversized bodies are cancelled without reading and exact byte boundary is accepted', async () => {
  let reads = 0, cancelled = 0;
  const body = new ReadableStream({ pull() { reads++; }, cancel() { cancelled++; } }, { highWaterMark: 0 });
  const blocked = createOpenAIConnection({ apiKey: KEY, async fetchImpl() {
    return new Response(body, { headers: { 'content-length': String(128 * 1024 + 1) } });
  } });
  await assert.rejects(blocked.reply('送信'), rejectCode('invalid-response'));
  assert.equal(reads, 0);
  assert.equal(cancelled, 1);
  const serialized = encoder.encode(JSON.stringify(completed('上限内')));
  const bytes = new Uint8Array(128 * 1024).fill(32);
  bytes.set(serialized);
  const accepted = createOpenAIConnection({ apiKey: KEY, async fetchImpl() { return new Response(bytes); } });
  assert.equal(await accepted.reply('送信'), '上限内');
});

test('invalid JSON and UTF-8 are rejected without reflecting their contents', async () => {
  for (const body of ['PRIVATE malformed {', new Uint8Array([0xff, 0xfe, 0x61])]) {
    const connection = createOpenAIConnection({ apiKey: KEY, async fetchImpl() { return new Response(body); } });
    await assert.rejects(connection.reply('送信'), error => {
      assert.equal(error.code, 'invalid-response');
      assert.doesNotMatch(String(error), /PRIVATE malformed/);
      return true;
    });
  }
});

test('only completed assistant output text is accepted; refusal, tool output and incomplete content are rejected', async () => {
  const cases = [
    null, [], {}, { status: 'queued', output: [] },
    { status: 'completed', output: [] },
    { ...completed(), error: { message: 'PRIVATE' } },
    { ...completed(), incomplete_details: {} },
    { ...completed(), output: [{ type: 'function_call', name: 'private-tool' }] },
    { ...completed(), output: [{ ...completed().output[0], role: 'user' }] },
    { ...completed(), output: [{ ...completed().output[0], status: 'incomplete' }] },
    { ...completed(), output: [{ ...completed().output[0], content: [{ type: 'refusal', refusal: 'PRIVATE' }] }] },
    { ...completed(), output: [{ ...completed().output[0], content: [{ type: 'output_text', text: 42 }] }] },
    completed('  \n\t  '), completed('あ'.repeat(4001)),
  ];
  for (const value of cases) {
    const connection = createOpenAIConnection({ apiKey: KEY, async fetchImpl() { return jsonResponse(value); } });
    await assert.rejects(connection.reply('送信'), rejectCode('invalid-response'));
  }
  const incomplete = createOpenAIConnection({ apiKey: KEY, async fetchImpl() {
    return jsonResponse({ status: 'incomplete', output: completed('途中の返事').output, incomplete_details: { reason: 'max_output_tokens' } });
  } });
  await assert.rejects(incomplete.reply('送信'), rejectCode('incomplete'));
});

test('reply length is bounded across all content parts and a valid split Unicode reply is joined', async () => {
  const value = completed();
  value.output[0].content = [{ type: 'output_text', text: 'あ'.repeat(2000) }, { type: 'output_text', text: 'い'.repeat(2000) }];
  const connection = createOpenAIConnection({ apiKey: KEY, async fetchImpl() { return jsonResponse(value); } });
  assert.equal((await connection.reply('送信')).length, 4000);
  value.output[0].content.push({ type: 'output_text', text: '超' });
  await assert.rejects(connection.reply('送信'), rejectCode('invalid-response'));
  const bytes = encoder.encode(JSON.stringify(completed('こんにちは🌙')));
  let offset = 0;
  const stream = new ReadableStream({ pull(controller) {
    if (offset === bytes.length) controller.close();
    else controller.enqueue(bytes.slice(offset, ++offset));
  } });
  const split = createOpenAIConnection({ apiKey: KEY, async fetchImpl() { return new Response(stream); } });
  assert.equal(await split.reply('送信'), 'こんにちは🌙');
});

test('reasoning metadata is ignored, but reasoning alone never becomes an answer', async () => {
  const metadata = { type: 'reasoning', id: 'private-metadata-id', summary: [{ type: 'summary_text', text: 'PRIVATE REASONING' }] };
  let response = completed('表示してよい返事');
  response.output.unshift(metadata);
  const connection = createOpenAIConnection({ apiKey: KEY, async fetchImpl() { return jsonResponse(response); } });
  assert.equal(await connection.reply('送信'), '表示してよい返事');
  response = { status: 'completed', output: [metadata] };
  await assert.rejects(connection.reply('送信'), rejectCode('invalid-response'));
});
