import { createVoicePlayback } from './voice-playback.mjs';

interface DialogueSnapshot {
  status: 'idle' | 'pending' | 'error';
  messages: Array<{ id: string; role: 'user' | 'assistant'; text: string }>;
  error: string | null;
  provider: 'local-demo' | 'openai';
  inputLimit: number;
  connection: { available: boolean; model: string; historyTurns: number; contextCharacters: number; maxOutputTokens: number };
  voice: { enabled: boolean; status: 'idle' | 'synthesizing' | 'ready' | 'playing' | 'error'; error: string | null; id: number };
}

interface DialogueBridge {
  getState(): Promise<DialogueSnapshot>;
  onChanged(callback: (snapshot: DialogueSnapshot) => void): () => void;
  send(text: string): Promise<boolean>;
  setProvider(provider: 'local-demo' | 'openai'): Promise<boolean>;
  cancel(): Promise<void>;
  clear(): Promise<void>;
  close(): Promise<void>;
  setVoice(enabled: boolean): Promise<boolean>;
  stopVoice(): Promise<void>;
  reportVoice(id: number, state: string): Promise<boolean>;
  mouth(id: number, vowel: string | null, weight: number): Promise<boolean>;
  onSpeech(callback: (packet: import('./voice-playback.mjs').VoicePacket) => void): () => void;
  onSpeechStop(callback: (id: number) => void): () => void;
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
const provider = document.querySelector<HTMLSelectElement>('#provider')!;
const providerStatus = document.querySelector<HTMLElement>('#provider-status')!;
const openaiOption = document.querySelector<HTMLOptionElement>('#openai-option')!;
const connectionHelp = document.querySelector<HTMLElement>('#connection-help')!;
const aiDetails = document.querySelector<HTMLElement>('#ai-details')!;
const aiLimits = document.querySelector<HTMLElement>('#ai-limits')!;
const transmission = document.querySelector<HTMLElement>('#transmission')!;
const voiceToggle = document.querySelector<HTMLInputElement>('#voice')!;
let voiceRevision = 0;
const playback = createVoicePlayback({
  onMouth: (id: number, vowel: string | null, weight: number) => { void bridge.mouth(id, vowel, weight).catch(() => {}); },
  onState: (id: number, state: string) => { void bridge.reportVoice(id, state).catch(() => {}); },
});

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
  const speaking = !!snapshot?.voice && ['synthesizing', 'ready', 'playing'].includes(snapshot.voice.status);
  const limit = snapshot?.inputLimit ?? 1000;
  const isAI = snapshot?.provider === 'openai';
  providerStatus.textContent = isAI ? 'OpenAI・従量課金' : 'お試し・AI未接続';
  send.textContent = isAI ? 'OpenAIへ送る' : '送る';
  transmission.hidden = !isAI;
  provider.disabled = !snapshot || changing || composing;
  if (!changing) provider.value = snapshot?.provider ?? 'local-demo';
  openaiOption.disabled = !snapshot?.connection?.available;
  connectionHelp.textContent = snapshot?.connection?.available
    ? 'OpenAIを選び、送信したときだけ通信します。'
    : 'OpenAIのキーが未設定です。起動手順の「AI会話」を確認してね。';
  aiDetails.hidden = !isAI;
  if (snapshot?.connection) {
    const config = snapshot.connection;
    aiLimits.textContent = `${config.model}。送信する履歴は完了した直近${config.historyTurns}往復・${config.contextCharacters}文字以内、返答は最大${config.maxOutputTokens}トークン（文字を分けた単位）です。送信ごとに料金がかかります。`;
  }
  input.disabled = changing;
  input.maxLength = limit;
  send.disabled = !snapshot || waiting || changing || !input.value.trim() || input.value.length > limit;
  voiceToggle.checked = snapshot?.voice?.enabled ?? false;
  voiceToggle.disabled = !snapshot || submitting || changing || composing || (waiting && !voiceToggle.checked);
  cancel.hidden = !waiting && !speaking;
  cancel.disabled = changing;
  clear.disabled = !snapshot || changing;
  pending.textContent = waiting ? '返事を待っています…' : speaking ? (snapshot?.voice.status === 'playing' ? '話しています…' : '声を準備しています…') : '';
  error.textContent = operationError || snapshot?.error || snapshot?.voice?.error || '';
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
    if (snapshot.voice?.enabled) {
      await bridge.stopVoice();
      if (disposed || version !== operationVersion) return;
      const ready = await playback.prepare();
      if (disposed || version !== operationVersion) { playback.stop(); return; }
      if (!ready) {
        await bridge.setVoice(false);
        if (disposed || version !== operationVersion) { playback.stop(); return; }
        operationError = '音声を準備できなかったので、今回は文字で返します。';
      }
    }
    if (disposed || version !== operationVersion) { playback.stop(); return; }
    const accepted = await bridge.send(text);
    if (disposed || version !== operationVersion) return;
    if (accepted && submittedDraft === draftVersion) {
      input.value = '';
      draftVersion++;
    } else if (!accepted) {
      playback.stop();
      operationError = '送れませんでした。少し待ってから、もう一度試してね。';
    }
  } catch {
    if (disposed || version !== operationVersion) return;
    playback.stop();
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
  playback.stop();
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
  operationVersion++; requestVersion++; submitting = false;
  playback.stop();
  try {
    await bridge.close();
  } catch {
    if (disposed) return;
    close.disabled = false;
    operationError = '閉じられませんでした。窓の閉じるボタンから閉じてね。';
    render();
  }
}

async function changeProvider(): Promise<void> {
  const value = provider.value;
  if (disposed || changing || composing || (value !== 'local-demo' && value !== 'openai')) return;
  const version = ++operationVersion;
  requestVersion++;
  changing = true; submitting = false; operationError = '';
  playback.stop();
  render();
  try {
    const accepted = await bridge.setProvider(value);
    if (disposed || version !== operationVersion) return;
    if (accepted) { input.value = ''; draftVersion++; }
    else operationError = '切り替えられませんでした。接続設定を確認してね。';
  } catch {
    if (disposed || version !== operationVersion) return;
    operationError = '切り替えられませんでした。一度閉じて、もう一度呼んでね。';
  } finally {
    if (!disposed && version === operationVersion) {
      changing = false;
      await refresh();
    }
  }
}

async function changeVoice(): Promise<void> {
  const enabled = voiceToggle.checked;
  if (disposed || changing || composing) return;
  const version = ++operationVersion;
  changing = true; operationError = '';
  if (!enabled) playback.stop();
  render();
  try {
    if (!await bridge.setVoice(enabled)) operationError = '声の設定を切り替えられませんでした。';
  } catch { if (!disposed) operationError = '声の設定を切り替えられませんでした。'; }
  finally {
    if (!disposed && version === operationVersion) { changing = false; await refresh(); }
  }
}

input.addEventListener('input', () => { draftVersion++; render(); });
input.addEventListener('compositionstart', () => { composing = true; render(); });
input.addEventListener('compositionend', () => { composing = false; render(); });
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
provider.addEventListener('change', () => { void changeProvider(); });
voiceToggle.addEventListener('change', () => { void changeVoice(); });
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
  if (value.status === 'error' || value.voice?.status === 'error' || !value.voice?.enabled) playback.stop();
  render();
});
const unsubscribeSpeech = bridge.onSpeech(packet => {
  if (disposed || !Number.isSafeInteger(packet.id) || packet.id <= voiceRevision) return;
  voiceRevision = packet.id;
  void playback.play(packet);
});
const unsubscribeSpeechStop = bridge.onSpeechStop(id => {
  if (disposed || !Number.isSafeInteger(id) || id < voiceRevision) return;
  voiceRevision = id;
  playback.stop();
});
window.addEventListener('unload', () => {
  disposed = true;
  requestVersion++;
  operationVersion++;
  unsubscribe();
  unsubscribeSpeech(); unsubscribeSpeechStop(); playback.dispose();
}, { once: true });
render();
void refresh();
