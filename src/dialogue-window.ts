import { BrowserWindow, ipcMain } from 'electron';
import type { IpcMainInvokeEvent, NativeImage, Rectangle } from 'electron';
import { createDialogueSession } from './dialogue-session.mjs';
import { OPENAI_DIALOGUE } from './openai-reply.mjs';
import { createDialogueVoice } from './dialogue-voice.mjs';

type Reply = (text: string, context: { signal: AbortSignal; history: unknown[] }) => Promise<string>;
export type DialogueConnection = { available: boolean; model: string; reply: Reply };
export type SpeechSynthesizer = (text: string, context: { signal: AbortSignal }) => Promise<Omit<import('./voice-playback.mjs').VoicePacket, 'id'>>;
type Options = {
  url: string; preload: string; icon: NativeImage;
  area: () => Rectangle; anchor: () => Rectangle; canOpen: () => boolean;
  secure: (win: BrowserWindow) => void;
  getReply?: () => Reply | undefined;
  getAI?: () => DialogueConnection | undefined;
  onReply?: () => void;
  getSpeech: () => SpeechSynthesizer;
  onMouth?: (vowel: string | null, weight: number) => void;
};

// Dialogue owns its own renderer and in-memory session. Its IPC never grants
// model-file access or desktop actions, and an old window cannot affect a new one.
export class DialogueWindowController {
  private win: BrowserWindow | null = null;
  private session: ReturnType<typeof createDialogueSession> | null = null;
  private provider: 'local-demo' | 'openai' = 'local-demo';
  private connection: DialogueConnection | undefined;
  private voice: ReturnType<typeof createDialogueVoice> | null = null;
  private readonly channels = ['dialogue:state', 'dialogue:send', 'dialogue:provider', 'dialogue:cancel', 'dialogue:clear', 'dialogue:close', 'dialogue:voice', 'dialogue:voice-stop', 'dialogue:voice-state', 'dialogue:mouth'];

  constructor(private readonly options: Options) {
    const requireOwner = (event: IpcMainInvokeEvent) => {
      if (!this.win || this.win.isDestroyed() || event.sender !== this.win.webContents
        || event.senderFrame !== this.win.webContents.mainFrame || event.senderFrame.url !== options.url) {
        throw new Error('Denied sender');
      }
    };
    ipcMain.handle('dialogue:state', event => { requireOwner(event); return this.snapshot(); });
    ipcMain.handle('dialogue:provider', (event, provider: unknown) => {
      requireOwner(event);
      if (!options.canOpen() || !this.win?.isVisible() || (provider !== 'local-demo' && provider !== 'openai')) return false;
      if (provider === 'openai' && !this.connection?.available) return false;
      if (provider === this.provider) return true;
      this.voice?.stop();
      this.session?.dispose();
      this.provider = provider;
      this.session = this.createSession(this.win);
      this.win.webContents.send('dialogue:changed', this.snapshot());
      return true;
    });
    ipcMain.handle('dialogue:send', (event, text: unknown) => {
      requireOwner(event);
      if (!options.canOpen() || !this.win?.isVisible() || typeof text !== 'string') return false;
      const accepted = this.session?.send(text) ?? false;
      if (accepted && this.voice && ['synthesizing', 'ready', 'playing'].includes(this.voice.snapshot().status)) this.voice.stop();
      return accepted;
    });
    ipcMain.handle('dialogue:cancel', event => { requireOwner(event); this.voice?.stop(); this.session?.cancel(); });
    ipcMain.handle('dialogue:clear', event => { requireOwner(event); this.voice?.stop(); this.session?.clear(); });
    ipcMain.handle('dialogue:voice', (event, enabled: unknown) => {
      requireOwner(event);
      if (!options.canOpen() || !this.win?.isVisible() || typeof enabled !== 'boolean') return false;
      if (enabled && this.session?.snapshot().status === 'pending') return false;
      return this.voice?.setEnabled(enabled) ?? false;
    });
    ipcMain.handle('dialogue:voice-stop', event => { requireOwner(event); this.voice?.stop(); });
    ipcMain.handle('dialogue:voice-state', (event, id: unknown, state: unknown) => {
      requireOwner(event);
      if (!options.canOpen() || !this.win?.isVisible() || !Number.isSafeInteger(id) || !['playing', 'ended', 'error'].includes(state as string)) return false;
      return this.voice?.report(id, state) ?? false;
    });
    ipcMain.handle('dialogue:mouth', (event, id: unknown, vowel: unknown, weight: unknown) => {
      requireOwner(event);
      if (!options.canOpen() || !this.win?.isVisible()) return false;
      return this.voice?.mouth(id, vowel, weight) ?? false;
    });
    ipcMain.handle('dialogue:close', event => {
      requireOwner(event);
      // Let invoke resolve before destroying the requesting renderer.
      const owner = this.win;
      setImmediate(() => { if (this.win === owner) this.close(); });
    });
  }

  window() { return this.win; }
  stopVoice() { this.voice?.setEnabled(false); }
  snapshot() { return this.session ? this.decorate(this.session.snapshot()) : null; }

  private decorate(snapshot: ReturnType<ReturnType<typeof createDialogueSession>['snapshot']>) {
    return { ...snapshot, voice: this.voice?.snapshot(), connection: {
      available: this.connection?.available ?? false,
      model: this.connection?.model ?? OPENAI_DIALOGUE.model,
      historyTurns: OPENAI_DIALOGUE.historyTurns, contextCharacters: OPENAI_DIALOGUE.contextCharacters,
      maxOutputTokens: OPENAI_DIALOGUE.maxOutputTokens,
    } };
  }

  private createSession(win: BrowserWindow) {
    let lastReply = '';
    const session = createDialogueSession({
      provider: this.provider,
      reply: this.provider === 'openai' ? this.connection?.reply : this.options.getReply?.(),
      replyTimeoutMs: this.provider === 'openai' ? OPENAI_DIALOGUE.replyTimeoutMs : undefined,
      onChange: snapshot => {
        if (this.win !== win || win.isDestroyed() || this.session !== session) return;
        win.webContents.send('dialogue:changed', this.decorate(snapshot));
        const message = snapshot.messages.at(-1);
        if (snapshot.status === 'idle' && message?.role === 'assistant' && message.id !== lastReply) {
          lastReply = message.id;
          this.options.onReply?.();
          void this.voice?.speak(message.text);
        }
      },
    });
    return session;
  }

  open() {
    if (!this.options.canOpen()) return;
    if (this.win && !this.win.isDestroyed()) {
      const area = this.options.area(), current = this.win.getBounds();
      const width = Math.min(current.width, area.width), height = Math.min(current.height, area.height);
      const x = Math.max(area.x, Math.min(current.x, area.x + area.width - width));
      const y = Math.max(area.y, Math.min(current.y, area.y + area.height - height));
      this.win.setBounds({ x, y, width, height });
      this.win.showInactive();
      return;
    }
    const area = this.options.area(), anchor = this.options.anchor();
    const width = Math.min(380, area.width), height = Math.min(420, area.height);
    const left = anchor.x - width - 12;
    const x = Math.max(area.x, Math.min(left >= area.x ? left : anchor.x + anchor.width + 12, area.x + area.width - width));
    const y = Math.max(area.y, Math.min(anchor.y + anchor.height - height, area.y + area.height - height));
    const win = new BrowserWindow({
      x, y, width, height, minWidth: Math.min(320, width), minHeight: Math.min(320, height),
      title: 'しずくとの会話', show: false, backgroundColor: '#f8fbff', icon: this.options.icon,
      autoHideMenuBar: true, maximizable: false, minimizable: false, fullscreenable: false,
      webPreferences: { preload: this.options.preload, nodeIntegration: false, contextIsolation: true, sandbox: true, spellcheck: false },
    });
    this.win = win;
    this.options.secure(win);
    win.webContents.setAudioMuted(true);
    const voice = createDialogueVoice({
      synthesize: this.options.getSpeech(),
      onChange: () => { if (this.win === win && !win.isDestroyed() && this.session) win.webContents.send('dialogue:changed', this.snapshot()); },
      onAudio: (packet: unknown) => {
        if (this.win !== win || win.isDestroyed() || !win.isVisible() || !this.options.canOpen()) { voice.stop(); return; }
        win.webContents.setAudioMuted(false);
        win.webContents.send('dialogue:speech', packet);
      },
      onStop: (id: number) => {
        if (!win.isDestroyed()) { win.webContents.setAudioMuted(true); win.webContents.send('dialogue:speech-stop', id); }
      },
      onMouth: (vowel: string | null, weight: number) => { this.options.onMouth?.(vowel, weight); },
    });
    this.voice = voice;
    this.provider = 'local-demo';
    this.connection = this.options.getAI?.();
    const session = this.createSession(win);
    this.session = session;
    const release = () => {
      voice.dispose();
      session.dispose();
      if (this.win === win) {
        this.session?.dispose();
        this.win = null; this.session = null; this.voice = null; this.provider = 'local-demo'; this.connection = undefined;
      }
    };
    win.on('close', release);
    win.on('closed', release);
    // A stalled chat cannot process its own stop button. Close from main so
    // audio, outstanding replies and the renderer are released together.
    win.on('unresponsive', () => { if (this.win === win) this.close(); });
    win.webContents.on('render-process-gone', () => { if (this.win === win) this.close(); });
    // Reloading must not replay replies or retain an enabled audio session.
    win.webContents.on('did-start-navigation', (_event, url, _inPlace, mainFrame) => {
      if (mainFrame && this.win === win && url === this.options.url) this.voice?.setEnabled(false);
    });
    win.once('ready-to-show', () => {
      if (this.win !== win || win.isDestroyed()) return;
      if (!this.options.canOpen()) { this.close(); return; }
      win.showInactive();
    });
    void win.loadURL(this.options.url).catch(() => { if (this.win === win) this.close(); });
  }

  close() {
    const win = this.win, session = this.session;
    this.voice?.dispose(); this.voice = null;
    this.win = null; this.session = null;
    this.provider = 'local-demo'; this.connection = undefined;
    session?.dispose();
    if (win && !win.isDestroyed()) win.destroy();
  }

  dispose() {
    this.close();
    for (const channel of this.channels) ipcMain.removeHandler(channel);
  }
}
