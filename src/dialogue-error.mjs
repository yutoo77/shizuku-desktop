const messages = Object.freeze({
  'missing-key': 'AI接続の準備ができていないよ。起動時のAPIキー設定を確認してね。',
  auth: 'AIに接続できなかったよ。APIキーと利用権限を確認してね。',
  'rate-limit': 'AIの利用上限か混雑で接続できなかったよ。利用状況を確認して、少し待ってから送ってね。',
  unavailable: '今はAIに接続できなかったよ。少し待ってから、もう一度送ってみてね。',
  incomplete: '返事を最後まで用意できなかったよ。短い内容で、もう一度送ってみてね。',
  'invalid-response': 'AIの返事を読み取れなかったよ。もう一度送ってみてね。',
});

export const GENERIC_DIALOGUE_ERROR = '返事を用意できなかったよ。もう一度送ってみてね。';

/** Errors crossing into the view contain only this fixed local vocabulary. */
export class DialogueReplyError extends Error {
  /** @param {'missing-key' | 'auth' | 'rate-limit' | 'unavailable' | 'incomplete' | 'invalid-response'} code */
  constructor(code) {
    const safeCode = Object.hasOwn(messages, code) ? code : 'unavailable';
    super(messages[safeCode]);
    this.name = 'DialogueReplyError';
    this.code = safeCode;
    Object.freeze(this);
  }
}

/** @param {unknown} error */
export function dialogueErrorMessage(error) {
  return error instanceof DialogueReplyError && Object.hasOwn(messages, error.code)
    ? messages[error.code] : GENERIC_DIALOGUE_ERROR;
}
