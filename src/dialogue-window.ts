import { BrowserWindow, ipcMain } from 'electron';
import type { IpcMainInvokeEvent, NativeImage, Rectangle } from 'electron';
import { createDialogueSession } from './dialogue-session.mjs';

type Reply = (text: string, context: { signal: AbortSignal; history: unknown[] }) => Promise<string>;
type Options = {
  url: string; preload: string; icon: NativeImage;
  area: () => Rectangle; anchor: () => Rectangle; canOpen: () => boolean;
  secure: (win: BrowserWindow) => void;
  getReply?: () => Reply | undefined;
};

// Dialogue owns its own renderer and in-memory session. Its IPC never grants
// model-file access or desktop actions, and an old window cannot affect a new one.
export class DialogueWindowController {
  private win: BrowserWindow | null = null;
  private session: ReturnType<typeof createDialogueSession> | null = null;
  private readonly channels = ['dialogue:state', 'dialogue:send', 'dialogue:cancel', 'dialogue:clear', 'dialogue:close'];

  constructor(private readonly options: Options) {
    const requireOwner = (event: IpcMainInvokeEvent) => {
      if (!this.win || this.win.isDestroyed() || event.sender !== this.win.webContents
        || event.senderFrame !== this.win.webContents.mainFrame || event.senderFrame.url !== options.url) {
        throw new Error('Denied sender');
      }
    };
    ipcMain.handle('dialogue:state', event => { requireOwner(event); return this.session?.snapshot(); });
    ipcMain.handle('dialogue:send', (event, text: unknown) => {
      requireOwner(event);
      if (!options.canOpen() || !this.win?.isVisible() || typeof text !== 'string') return false;
      return this.session?.send(text) ?? false;
    });
    ipcMain.handle('dialogue:cancel', event => { requireOwner(event); this.session?.cancel(); });
    ipcMain.handle('dialogue:clear', event => { requireOwner(event); this.session?.clear(); });
    ipcMain.handle('dialogue:close', event => {
      requireOwner(event);
      // Let invoke resolve before destroying the requesting renderer.
      const owner = this.win;
      setImmediate(() => { if (this.win === owner) this.close(); });
    });
  }

  window() { return this.win; }
  snapshot() { return this.session?.snapshot() ?? null; }

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
    const session = createDialogueSession({
      reply: this.options.getReply?.(),
      onChange: (snapshot: unknown) => {
        if (this.win === win && !win.isDestroyed()) win.webContents.send('dialogue:changed', snapshot);
      },
    });
    this.session = session;
    const release = () => {
      session.dispose();
      if (this.win === win) { this.win = null; this.session = null; }
    };
    win.on('close', release);
    win.on('closed', release);
    win.webContents.on('render-process-gone', () => { if (this.win === win) this.close(); });
    win.once('ready-to-show', () => {
      if (this.win !== win || win.isDestroyed()) return;
      if (!this.options.canOpen()) { this.close(); return; }
      win.showInactive();
    });
    void win.loadURL(this.options.url).catch(() => { if (this.win === win) this.close(); });
  }

  close() {
    const win = this.win, session = this.session;
    this.win = null; this.session = null;
    session?.dispose();
    if (win && !win.isDestroyed()) win.destroy();
  }

  dispose() {
    this.close();
    for (const channel of this.channels) ipcMain.removeHandler(channel);
  }
}
