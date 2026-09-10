export {};

interface DialogueSnapshot {
  status: 'idle' | 'pending' | 'error';
  messages: Array<{ id: string; role: 'user' | 'assistant'; text: string }>;
  error: string | null;
  provider: 'local-demo';
  inputLimit: number;
}

interface DialogueBridge {
  getState(): Promise<DialogueSnapshot>;
  onChanged(callback: (snapshot: DialogueSnapshot) => void): () => void;
  send(text: string): Promise<boolean>;
  cancel(): Promise<void>;
  clear(): Promise<void>;
  close(): Promise<void>;
}

const bridge = (window as unknown as { dialogue: DialogueBridge }).dialogue;
const conversation = document.querySelector<HTMLElement>('.conversation')!;
const messages = document.querySelector<HTMLElement>('#messages')!;
const input = document.querySelector<HTMLTextAreaElement>('#message')!;
const form = document.querySelector<HTMLFormElement>('#composer')!;
const send = document.querySelector<HTMLButtonElement>('#send')!;
const cancel = document.querySelector<HTMLButtonElement>('#cancel')!;
const clear = document.querySelector<HTMLButtonElement>('#clear')!;
const close = document.querySelector<HTMLButtonElement>('#close')!;
const error = document.querySelector<HTMLElement>('#error')!;
const pending = document.querySelector<HTMLElement>('#pending')!;
const empty = document.querySelector<HTMLElement>('#empty')!;
const options = document.querySelector<HTMLDetailsElement>('#options')!;

let snapshot: DialogueSnapshot | null = null;
let requestVersion = 0;
let operationVersion = 0;
let draftVersion = 0;
let submitting = false;
let changing = false;
let composing = false;
let disposed = false;
let operationError = '';
let renderedMessages: DialogueSnapshot['messages'] = [];
let scrollForSend = false;

function render(): void {
  if (disposed) return;
  const waiting = submitting || snapshot?.status === 'pending';
  const limit = snapshot?.inputLimit ?? 1000;
  input.maxLength = limit;
  send.disabled = !snapshot || waiting || changing || !input.value.trim() || input.value.length > limit;
  cancel.hidden = !waiting;
  cancel.disabled = changing;
  clear.disabled = !snapshot || changing;
  pending.textContent = waiting ? '返事を待っています…' : '';
  error.textContent = operationError || snapshot?.error || '';
  const next = snapshot?.messages ?? [];
  empty.hidden = next.length > 0;
  const prefixUnchanged = renderedMessages.every((message, index) => {
    const candidate = next[index];
    return candidate?.id === message.id && candidate.role === message.role && candidate.text === message.text;
  });
  const nearBottom = conversation.scrollHeight - conversation.scrollTop - conversation.clientHeight < 48;
  if (!prefixUnchanged) messages.replaceChildren();
  const added = next.slice(prefixUnchanged ? renderedMessages.length : 0);
  for (const message of added) {
    const bubble = document.createElement('p');
    bubble.className = `message ${message.role}`;
    bubble.dataset.messageId = message.id;
    bubble.setAttribute('aria-label', `${message.role === 'user' ? 'あなた' : 'しずく'}：${message.text}`);
    bubble.textContent = message.text;
    messages.append(bubble);
  }
  renderedMessages = next.map(message => ({ ...message }));
  if ((added.length > 0 || !prefixUnchanged) && (nearBottom || scrollForSend)) {
    conversation.scrollTop = conversation.scrollHeight;
    scrollForSend = false;
  }
}

async function refresh(): Promise<void> {
  const version = ++requestVersion;
  try {
    const value = await bridge.getState();
    if (disposed || version !== requestVersion) return;
    snapshot = value;
  } catch {
    if (disposed || version !== requestVersion) return;
    operationError ||= '会話の状態を確認できませんでした。一度閉じて、もう一度呼んでね。';
  }
  render();
}

async function submit(): Promise<void> {
  const text = input.value.trim();
  if (!snapshot || submitting || changing || snapshot.status === 'pending' || !text || input.value.length > snapshot.inputLimit) return;
  const version = ++operationVersion;
  const submittedDraft = draftVersion;
  submitting = true;
  operationError = '';
  scrollForSend = true;
  render();
  try {
    const accepted = await bridge.send(text);
    if (disposed || version !== operationVersion) return;
    if (accepted && submittedDraft === draftVersion) {
      input.value = '';
      draftVersion++;
    } else if (!accepted) {
      operationError = '送れませんでした。少し待ってから、もう一度試してね。';
    }
  } catch {
    if (disposed || version !== operationVersion) return;
    operationError = '送れませんでした。入力は残しています。';
  } finally {
    if (!disposed && version === operationVersion) {
      submitting = false;
      render();
      await refresh();
    }
  }
}

async function changeConversation(action: 'cancel' | 'clear'): Promise<void> {
  if (disposed || changing) return;
  const version = ++operationVersion;
  requestVersion++;
  changing = true;
  submitting = false;
  operationError = '';
  if (action === 'clear') {
    input.value = '';
    draftVersion++;
    options.open = false;
  }
  render();
  try {
    await bridge[action]();
  } catch {
    if (disposed || version !== operationVersion) return;
    operationError = action === 'clear' ? '会話を消せませんでした。一度閉じて、もう一度呼んでね。' : '中止できませんでした。会話の窓を閉じて止められます。';
  } finally {
    if (!disposed && version === operationVersion) {
      changing = false;
      render();
      await refresh();
    }
  }
}

async function closeConversation(): Promise<void> {
  if (disposed || close.disabled) return;
  close.disabled = true;
  try {
    await bridge.close();
  } catch {
    if (disposed) return;
    close.disabled = false;
    operationError = '閉じられませんでした。窓の閉じるボタンから閉じてね。';
    render();
  }
}

input.addEventListener('input', () => { draftVersion++; render(); });
input.addEventListener('compositionstart', () => { composing = true; });
input.addEventListener('compositionend', () => { composing = false; });
input.addEventListener('keydown', event => {
  if (event.key !== 'Enter' || event.shiftKey || event.isComposing || composing || event.keyCode === 229) return;
  event.preventDefault();
  void submit();
});
form.addEventListener('submit', event => {
  event.preventDefault();
  if (!composing) void submit();
});
cancel.addEventListener('click', () => { void changeConversation('cancel'); });
clear.addEventListener('click', () => { void changeConversation('clear'); });
close.addEventListener('click', () => { void closeConversation(); });
document.addEventListener('keydown', event => {
  if (event.key !== 'Escape' || event.isComposing || composing || event.keyCode === 229) return;
  event.preventDefault();
  void closeConversation();
});

// showInactive must leave the user's current application focused. Wait for the
// first actual focus of this window before placing the caret in the composer.
window.addEventListener('focus', () => {
  if (document.activeElement === document.body || document.activeElement === document.documentElement) input.focus();
}, { once: true });

const unsubscribe = bridge.onChanged(value => {
  if (disposed) return;
  requestVersion++;
  snapshot = value;
  render();
});
window.addEventListener('unload', () => {
  disposed = true;
  requestVersion++;
  operationVersion++;
  unsubscribe();
}, { once: true });
render();
void refresh();
