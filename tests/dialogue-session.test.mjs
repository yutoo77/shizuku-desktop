import test from 'node:test';
import assert from 'node:assert/strict';
import { createDialogueSession, DIALOGUE_LIMITS } from '../src/dialogue-session.mjs';
import { DialogueReplyError } from '../src/dialogue-error.mjs';

const flush = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test('local demonstration identifies itself and gives original bounded-purpose replies', async () => {
  const session = createDialogueSession();
  try {
    assert.deepEqual(session.snapshot(), {
      status: 'idle', messages: [], error: null, provider: 'local-demo', inputLimit: 1000,
    });
    session.send('あなたの名前は？');
    await flush();
    assert.match(session.snapshot().messages[1].text, /月白しずく/);
    assert.match(session.snapshot().messages[1].text, /人間ではなく/);
    assert.match(session.snapshot().messages[1].text, /今はAIには接続せず/);
    for (const input of ['こんにちは', '今日は疲れた', 'ありがとう', 'またね', '画面を操作して']) {
      assert.equal(session.send(input), true);
      await flush();
    }
    assert.match(session.snapshot().messages.at(-1).text, /短い返事のお試し/);
    assert.equal(session.snapshot().status, 'idle');
  } finally { session.dispose(); }
});

test('invalid and repeated submissions do not start replies or mutate history', async () => {
  const pending = deferred();
  let calls = 0;
  const session = createDialogueSession({ reply: async () => { calls++; return pending.promise; } });
  try {
    for (const input of [null, undefined, 42, {}, [], '', ' \n\t ', 'a'.repeat(1001)]) {
      assert.equal(session.send(input), false);
    }
    assert.equal(session.snapshot().messages.length, 0);
    assert.equal(session.send('a'.repeat(1000)), true);
    assert.equal(session.send('二重送信'), false);
    await flush();
    assert.equal(calls, 1);
    assert.equal(session.snapshot().status, 'pending');
    pending.resolve('受け取ったよ。');
    await flush();
    assert.equal(session.snapshot().messages.length, 2);
  } finally { session.dispose(); }
});

test('history and emitted snapshots cannot mutate the session and history excludes the current input', async () => {
  const observed = [];
  const histories = [];
  const session = createDialogueSession({
    onChange(state) { observed.push(state.status); state.messages.splice(0); },
    async reply(text, { history }) {
      histories.push(history.map(message => message.text));
      history.forEach(message => { message.text = 'changed'; });
      history.push({ id: 'external', role: 'assistant', text: 'injected' });
      return `返事:${text}`;
    },
  });
  try {
    session.send('  最初  ');
    assert.equal(session.snapshot().status, 'pending');
    await flush();
    const copy = session.snapshot();
    copy.messages[0].text = 'changed';
    copy.messages.push({ id: 'external', role: 'user', text: 'injected' });
    session.send('次');
    await flush();
    assert.deepEqual(histories, [[], ['最初', '返事:最初']]);
    assert.deepEqual(session.snapshot().messages.map(message => message.text), ['最初', '返事:最初', '次', '返事:次']);
    assert.deepEqual(observed, ['pending', 'idle', 'pending', 'idle']);
  } finally { session.dispose(); }
});

test('cancel aborts the old reply; late success cannot replace a newer pending reply', async () => {
  const first = deferred(), second = deferred();
  const signals = [];
  const session = createDialogueSession({
    async reply(text, { signal }) { signals.push(signal); return text === '最初' ? first.promise : second.promise; },
  });
  try {
    session.send('最初');
    await flush();
    session.cancel();
    assert.equal(signals[0].aborted, true);
    assert.equal(session.snapshot().status, 'idle');
    assert.deepEqual(session.snapshot().messages.map(message => message.role), ['user']);
    session.send('次');
    await flush();
    first.resolve('古い返事');
    await flush();
    assert.equal(session.snapshot().status, 'pending');
    second.resolve('今の返事');
    await flush();
    assert.deepEqual(session.snapshot().messages.map(message => message.text), ['最初', '次', '今の返事']);
  } finally { session.dispose(); }
});

test('clear aborts work and late failure cannot contaminate a new conversation', async () => {
  const pending = deferred();
  let oldSignal;
  const session = createDialogueSession({
    async reply(text, { signal }) { if (text === '古い会話') { oldSignal = signal; return pending.promise; } return '新しい返事'; },
  });
  try {
    session.send('古い会話');
    await flush();
    const oldId = session.snapshot().messages[0].id;
    session.clear();
    assert.equal(oldSignal.aborted, true);
    assert.equal(session.snapshot().messages.length, 0);
    session.send('新しい会話');
    await flush();
    pending.reject(new Error('sensitive provider diagnostic'));
    await flush();
    assert.equal(session.snapshot().status, 'idle');
    assert.equal(session.snapshot().error, null);
    assert.deepEqual(session.snapshot().messages.map(message => message.text), ['新しい会話', '新しい返事']);
    assert.notEqual(session.snapshot().messages[0].id, oldId);
  } finally { session.dispose(); }
});

test('cancel before the first microtask prevents the reply from starting', async () => {
  let calls = 0;
  const session = createDialogueSession({ async reply() { calls++; return '返事'; } });
  try {
    session.send('送信');
    session.cancel();
    await flush();
    assert.equal(calls, 0);
    assert.equal(session.snapshot().messages.length, 1);
  } finally { session.dispose(); }
});

test('timeout aborts the request, emits a safe error, and ignores a late response', async () => {
  const pending = deferred();
  let signal;
  let notifyTimeout;
  const timedOut = new Promise(resolve => { notifyTimeout = resolve; });
  const session = createDialogueSession({
    replyTimeoutMs: 10,
    async reply(text, context) { signal = context.signal; return pending.promise; },
    onChange(state) { if (state.status === 'error') notifyTimeout(); },
  });
  try {
    session.send('送信');
    await timedOut;
    assert.equal(signal.aborted, true);
    assert.match(session.snapshot().error, /間に合わなかった/);
    pending.resolve('期限切れの返事');
    await flush();
    assert.equal(session.snapshot().status, 'error');
    assert.equal(session.snapshot().messages.length, 1);
    session.cancel();
    assert.equal(session.snapshot().error, null);
  } finally { session.dispose(); }
});

test('provider failures and malformed answers become safe errors and allow retry', async () => {
  const answers = [new Error('secret diagnostic C:\\private\\token'), 42, null, {}, ' \n ', '直ったよ'];
  const session = createDialogueSession({ async reply() {
    const answer = answers.shift();
    if (answer instanceof Error) throw answer;
    return answer;
  } });
  try {
    for (let index = 0; index < 5; index++) {
      assert.equal(session.send(`試行${index}`), true);
      await flush();
      assert.equal(session.snapshot().status, 'error');
      assert.match(session.snapshot().error, /返事を用意できなかった/);
      assert.doesNotMatch(JSON.stringify(session.snapshot()), /secret|diagnostic|private|token/);
    }
    assert.equal(session.send('もう一度'), true);
    await flush();
    assert.equal(session.snapshot().status, 'idle');
    assert.equal(session.snapshot().error, null);
    assert.equal(session.snapshot().messages.at(-1).text, '直ったよ');
  } finally { session.dispose(); }
});

test('history is bounded and removes whole older turns instead of orphaning assistant replies', async () => {
  const session = createDialogueSession({ async reply(text) { return `返事${text}`; } });
  try {
    for (let index = 0; index < 25; index++) {
      session.send(String(index));
      await flush();
      assert.ok(session.snapshot().messages.length <= DIALOGUE_LIMITS.historyMessages);
    }
    const state = session.snapshot();
    assert.equal(state.messages.length, 40);
    assert.equal(state.messages[0].text, '5');
    assert.equal(state.messages[0].role, 'user');
    assert.equal(new Set(state.messages.map(message => message.id)).size, 40);
    for (let index = 0; index < 41; index++) { session.send(`中止${index}`); session.cancel(); }
    await flush();
    assert.equal(session.snapshot().messages.length, 40);
    assert.ok(session.snapshot().messages.every(message => message.role === 'user'));
  } finally { session.dispose(); }
});

test('oversized replies are rejected before rendering or retaining them, and the boundary is accepted', async () => {
  const responses = [
    '機密'.repeat(DIALOGUE_LIMITS.replyCharacters),
    ' '.repeat(DIALOGUE_LIMITS.replyCharacters) + '返事',
    'あ'.repeat(DIALOGUE_LIMITS.replyCharacters),
  ];
  const emitted = [];
  const session = createDialogueSession({
    async reply() { return responses.shift(); },
    onChange(state) { emitted.push(state); },
  });
  try {
    for (let index = 0; index < 2; index++) {
      session.send(`試行${index}`);
      await flush();
      assert.equal(session.snapshot().status, 'error');
      assert.match(session.snapshot().error, /返事を用意できなかった/);
      assert.ok(session.snapshot().messages.every(message => message.role === 'user'));
    }
    assert.ok(emitted.every(state => state.messages.every(message => message.role === 'user')));
    assert.doesNotMatch(JSON.stringify(emitted), /機密/);
    session.send('上限ちょうど');
    await flush();
    assert.equal(session.snapshot().status, 'idle');
    assert.equal(session.snapshot().messages.at(-1).text.length, DIALOGUE_LIMITS.replyCharacters);
  } finally { session.dispose(); }
});

test('dispose aborts work, removes messages, rejects new sends, and never emits late changes', async () => {
  const pending = deferred();
  let signal;
  let notifications = 0;
  const session = createDialogueSession({
    async reply(text, context) { signal = context.signal; return pending.promise; },
    onChange() { notifications++; },
  });
  session.send('送信');
  await flush();
  session.dispose();
  assert.equal(signal.aborted, true);
  assert.equal(session.send('次'), false);
  session.cancel();
  session.clear();
  session.dispose();
  pending.reject(new Error('late failure'));
  await flush();
  assert.equal(notifications, 1);
  assert.equal(session.snapshot().messages.length, 0);
  assert.equal(session.snapshot().status, 'idle');
});

test('a failing view callback does not prevent cancellation', async () => {
  const session = createDialogueSession({ onChange() { throw new Error('detached view'); } });
  try {
    assert.equal(session.send('送信'), true);
    assert.doesNotThrow(() => session.cancel());
    await flush();
    assert.equal(session.snapshot().status, 'idle');
    assert.equal(session.snapshot().messages.length, 1);
  } finally { session.dispose(); }
});

test('external sessions require an adapter and identify their provider', () => {
  assert.throws(() => createDialogueSession({ provider: 'openai' }), /adapter/);
  assert.throws(() => createDialogueSession({ provider: 'untrusted' }), /provider/);
  const session = createDialogueSession({ provider: 'openai', reply: async () => '返事' });
  assert.equal(session.snapshot().provider, 'openai');
  session.dispose();
});

test('canceled and failed entries are visible but never sent as context in a later request', async () => {
  const pending = deferred();
  const histories = [];
  const session = createDialogueSession({
    provider: 'openai',
    async reply(text, { history }) {
      histories.push(history.map(message => message.text));
      if (text === '中止する文') return pending.promise;
      if (text === '失敗する文') throw new Error('upstream private diagnostic');
      return `返事:${text}`;
    },
  });
  try {
    session.send('完了した文'); await flush();
    session.send('中止する文'); await flush(); session.cancel();
    session.send('失敗する文'); await flush();
    session.send('次の文'); await flush();
    pending.resolve('中止した古い返事'); await flush();
    assert.deepEqual(histories.at(-1), ['完了した文', '返事:完了した文']);
    assert.match(JSON.stringify(session.snapshot().messages), /中止する文/);
    assert.doesNotMatch(JSON.stringify(session.snapshot()), /中止した古い返事|private diagnostic/);
    session.clear(); session.send('新しい会話'); await flush();
    assert.deepEqual(histories.at(-1), []);
  } finally { session.dispose(); }
});

test('provider failures use trusted error codes without displaying upstream diagnostic text', async () => {
  const answers = [new DialogueReplyError('auth'), { code: 'auth', message: 'private key' }];
  const session = createDialogueSession({ provider: 'openai', async reply() { throw answers.shift(); } });
  try {
    session.send('確認'); await flush();
    assert.match(session.snapshot().error, /キー|認証/);
    session.send('確認'); await flush();
    assert.equal(session.snapshot().error, '返事を用意できなかったよ。もう一度送ってみてね。');
    assert.doesNotMatch(JSON.stringify(session.snapshot()), /private key/);
  } finally { session.dispose(); }
});
