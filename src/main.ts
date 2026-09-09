import { app, BrowserWindow, Tray, Menu, nativeImage, globalShortcut, screen, ipcMain, dialog, session } from 'electron';
import type { IpcMainEvent, IpcMainInvokeEvent, Rectangle } from 'electron';
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { defaultBounds, clampBounds, followControlMove } from './geometry.mjs';
import { MAX_MODEL_BYTES, validateModel } from './model-policy.mjs';

const root = path.resolve(__dirname, '..');
const work = path.join(root, 'work');
const configPath = path.join(root, 'local.config.json');
const avatarUrl = pathToFileURL(path.join(__dirname, 'index.html')).href;
const controlsUrl = pathToFileURL(path.join(__dirname, 'controls.html')).href;
let avatar: BrowserWindow | null = null;
let controls: BrowserWindow | null = null;
let tray: Tray | null = null;
let modelPath = '';
let savedBounds: Rectangle | undefined;
let loadError = '';
let modelLoaded = false;
let visible = true;
let shortcuts = true;
let metricsTimer: NodeJS.Timeout | undefined;
let saveTimer: NodeJS.Timeout | undefined;
let quitting = false;
let quitFlushComplete = false;
let choosing = false;
let writeQueue = Promise.resolve();
let pendingAvatarBounds: Rectangle | undefined;
let avatarPlacementGeneration = 0;
const metricSamples: unknown[] = [];
const area = () => screen.getPrimaryDisplay().workArea;

function avatarBounds(win: BrowserWindow): Rectangle {
  return { ...(pendingAvatarBounds ?? win.getBounds()) };
}
function placeAvatar(bounds: Rectangle) {
  if (quitting || !avatar || avatar.isDestroyed()) return;
  const win = avatar;
  const target = clampBounds(bounds, area());
  const generation = ++avatarPlacementGeneration;
  pendingAvatarBounds = target;
  const verify = (retriesRemaining: number) => setImmediate(() => {
    if (quitting || avatar !== win || win.isDestroyed() || generation !== avatarPlacementGeneration) return;
    const actual = win.getBounds();
    if (actual.x === target.x && actual.y === target.y && actual.width === target.width && actual.height === target.height) {
      pendingAvatarBounds = undefined;
      return;
    }
    if (retriesRemaining === 0) {
      pendingAvatarBounds = undefined;
      return;
    }
    // Windows mixed-DPI recovery can resize the first placement while changing displays.
    win.setBounds(target);
    verify(retriesRemaining - 1);
  });
  win.setBounds(target);
  verify(2);
}
function save() {
  if (avatar && !avatar.isDestroyed()) savedBounds = avatarBounds(avatar);
  const value = JSON.stringify({ modelPath, bounds: savedBounds }, null, 2);
  writeQueue = writeQueue.then(() => writeFile(configPath, value, 'utf8')).catch(error => console.error('Configuration could not be saved:', error.code));
  return writeQueue;
}
function saveSoon() {
  if (quitting) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => void save(), 400);
}
function setVisible(next: boolean) {
  if (quitting || !avatar || avatar.isDestroyed()) return;
  visible = next;
  if (next) {
    placeAvatar(avatarBounds(avatar));
    avatar.showInactive();
  } else avatar.hide();
  avatar.webContents.send('avatar:visibility', next);
  updateMenu();
}
function reset() {
  if (quitting) return;
  setVisible(true);
  placeAvatar(defaultBounds(area()));
  saveSoon();
}
function trusted(event: IpcMainInvokeEvent | IpcMainEvent, owner: BrowserWindow | null, expected: string) {
  return !!owner && !owner.isDestroyed() && event.sender === owner.webContents && event.senderFrame === owner.webContents.mainFrame && event.senderFrame.url === expected;
}
function secureWindow(win: BrowserWindow) {
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', event => event.preventDefault());
  win.webContents.on('will-attach-webview', event => event.preventDefault());
}
function icon() {
  const size = 32;
  const pixels = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const inMoon = (x - 15) ** 2 + (y - 16) ** 2 < 13 ** 2 && (x - 21) ** 2 + (y - 11) ** 2 > 11 ** 2;
    if (inMoon) { const i = (y * size + x) * 4; pixels[i] = 214; pixels[i+1] = 159; pixels[i+2] = 99; pixels[i+3] = 255; }
  }
  return nativeImage.createFromBitmap(pixels, { width: size, height: size, scaleFactor: 1 });
}
function updateMenu() {
  if (controls && !controls.isDestroyed()) controls.webContents.send('controls:changed');
  tray?.setContextMenu(Menu.buildFromTemplate([
    { label: '月白 しずく', enabled: false },
    ...(loadError ? [{ label: loadError.slice(0, 65), enabled: false }] : []),
    { label: visible ? '隠す' : '表示する', click: () => setVisible(!visible) },
    { label: '位置を動かす…', click: openControls },
    { label: '画面端に戻す', click: reset },
    { type: 'separator' as const },
    { label: 'VRMを選ぶ…', click: () => void chooseModel() },
    { label: '終了', click: () => app.quit() },
  ]));
  tray?.setToolTip(`月白しずく — ${loadError || (visible ? '表示中' : '非表示')}`);
}
function openControls() {
  if (quitting) return;
  if (controls && !controls.isDestroyed()) { controls.show(); controls.focus(); return; }
  controls = new BrowserWindow({
    width: 360, height: 480, title: 'しずくの位置', resizable: false,
    backgroundColor: '#f8fbff', autoHideMenuBar: true, icon: icon(),
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true, spellcheck: false },
  });
  secureWindow(controls);
  let previous = controls.getBounds();
  controls.on('move', () => {
    if (quitting || !controls || !avatar) return;
    const next = controls.getBounds();
    placeAvatar(followControlMove(avatarBounds(avatar), previous, next, area()));
    previous = next;
    saveSoon();
  });
  controls.on('closed', () => { controls = null; });
  void controls.loadURL(controlsUrl);
}
async function chooseModel() {
  if (choosing || quitting) return;
  choosing = true;
  try {
    const options = { title: '利用条件を確認したVRMを選ぶ', filters: [{ name: 'VRM', extensions: ['vrm'] }], properties: ['openFile' as const] };
    const result = controls ? await dialog.showOpenDialog(controls, options) : await dialog.showOpenDialog(options);
    if (quitting || result.canceled || !result.filePaths[0]) return;
    const next = result.filePaths[0];
    await readModel(next);
    if (quitting) return;
    modelPath = next;
    modelLoaded = false;
    loadError = '';
    await save();
    if (quitting) return;
    avatar?.webContents.send('model:changed');
    setVisible(true);
  } catch (error) {
    if (quitting) return;
    loadError = error instanceof Error ? error.message : 'モデルを読めませんでした。';
    updateMenu();
    openControls();
  } finally { choosing = false; }
}
async function readModel(selected: string): Promise<ArrayBuffer> {
  if (!path.isAbsolute(selected) || path.extname(selected).toLowerCase() !== '.vrm') throw new Error('ローカルのVRMファイルを選んでください。');
  try {
    const info = await stat(selected);
    if (!info.isFile() || info.size > MAX_MODEL_BYTES) throw new Error('VRMは100MB以下にしてください。');
    const buffer = await readFile(selected);
    validateModel(buffer);
    return Uint8Array.from(buffer).buffer;
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error) throw new Error('VRMを読めません。通知領域から選び直してください。');
    throw error;
  }
}
async function action(value: string) {
  if (quitting) return;
  if (value === 'show') setVisible(true);
  else if (value === 'hide') setVisible(false);
  else if (value === 'reset') reset();
  else if (value === 'choose-model') await chooseModel();
  else if (value === 'quit') app.quit();
  else if (['left', 'right', 'up', 'down'].includes(value) && avatar) {
    const bounds = avatarBounds(avatar);
    bounds.x += value === 'left' ? -16 : value === 'right' ? 16 : 0;
    bounds.y += value === 'up' ? -16 : value === 'down' ? 16 : 0;
    placeAvatar(bounds);
    saveSoon();
  } else throw new Error('Unknown action');
}
async function start() {
  await mkdir(work, { recursive: true });
  try {
    const config = JSON.parse(await readFile(configPath, 'utf8'));
    if (typeof config.modelPath === 'string') modelPath = config.modelPath;
    if (config.bounds && typeof config.bounds === 'object') savedBounds = clampBounds(config.bounds, area());
  } catch { /* Missing or malformed local config returns to safe defaults. */ }
  const allowedFiles = new Set(['index.html','controls.html','renderer.js','controls.js','style.css'].map(file => pathToFileURL(path.join(__dirname,file)).href));
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  session.defaultSession.on('will-download', event => event.preventDefault());
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: !allowedFiles.has(details.url) && !details.url.startsWith('blob:') && !details.url.startsWith('data:') });
  });
  avatar = new BrowserWindow({
    ...clampBounds(savedBounds ?? defaultBounds(area()), area()), title: '月白しずく',
    transparent: true, backgroundColor: '#00000000', frame: false, hasShadow: false,
    resizable: false, maximizable: false, minimizable: false, fullscreenable: false,
    focusable: false, skipTaskbar: true, alwaysOnTop: true, show: false,
    webPreferences: { preload: path.join(__dirname,'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true, spellcheck: false, backgroundThrottling: true },
  });
  avatar.setIgnoreMouseEvents(true);
  secureWindow(avatar);
  avatar.on('closed', () => { avatarPlacementGeneration++; pendingAvatarBounds = undefined; avatar = null; if (!quitting) app.quit(); });
  avatar.webContents.on('render-process-gone', () => { loadError = '描画が停止しました。終了して再起動してください。'; updateMenu(); });
  ipcMain.handle('model:read', async event => {
    if (!trusted(event, avatar, avatarUrl)) throw new Error('Denied sender');
    return modelPath ? readModel(modelPath) : null;
  });
  ipcMain.on('avatar:ready', (event, state) => {
    if (!trusted(event, avatar, avatarUrl) || !state || typeof state.ok !== 'boolean') return;
    modelLoaded = state.ok;
    loadError = state.ok ? '' : String(state.error ?? 'モデル未選択').slice(0, 180);
    avatar?.webContents.send('avatar:visibility', visible);
    updateMenu();
  });
  ipcMain.handle('controls:action', async (event, value) => {
    if (!trusted(event, controls, controlsUrl) || typeof value !== 'string') throw new Error('Denied sender');
    await action(value);
  });
  ipcMain.handle('controls:status', event => {
    if (!trusted(event, controls, controlsUrl)) throw new Error('Denied sender');
    return { model: modelPath ? path.basename(modelPath) : '', error: loadError, shortcuts };
  });
  tray = new Tray(icon());
  tray.on('double-click', () => setVisible(!visible));
  const bindings: Array<[string, () => void]> = [
    ['CommandOrControl+Alt+Shift+S', () => setVisible(!visible)],
    ['CommandOrControl+Alt+Shift+R', reset],
    ['CommandOrControl+Alt+Shift+Q', () => app.quit()],
  ];
  shortcuts = bindings.map(([key, handler]) => globalShortcut.register(key, handler)).every(Boolean);
  updateMenu();
  screen.on('display-metrics-changed', () => { if (avatar && !avatar.isDestroyed()) placeAvatar(avatarBounds(avatar)); });
  await avatar.loadURL(avatarUrl);
  if (quitting || !avatar || avatar.isDestroyed()) return;
  if (visible) setVisible(true);
  if (!modelPath) openControls();
  if (process.env.SHIZUKU_METRICS === '1') {
    metricsTimer = setInterval(() => {
      metricSamples.push({ time: new Date().toISOString(), visible, loaded: modelLoaded, processes: app.getAppMetrics() });
      if (metricSamples.length > 1800) metricSamples.shift();
    }, 2000);
  }
  // Development-only inspection inside the main process; not exposed through IPC.
  if (process.env.SHIZUKU_TEST === '1') (globalThis as any).__shizuku = {
    avatar: () => avatar, controls: () => controls, setVisible, reset, openControls, action,
    status: () => ({ visible, modelLoaded, loadError, shortcuts }), metrics: () => app.getAppMetrics(),
  };
}

app.setName('shizuku-desktop');
app.setPath('userData', path.join(work, 'userdata'));
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (avatar) reset(); });
  app.on('window-all-closed', () => { /* tray owns lifetime */ });
  app.on('before-quit', event => {
    if (quitFlushComplete) return;
    event.preventDefault();
    if (quitting) return;
    quitting = true;
    avatarPlacementGeneration++;
    clearInterval(metricsTimer);
    clearTimeout(saveTimer);
    globalShortcut.unregisterAll();
    tray?.destroy(); tray = null;
    void (async () => {
      await save();
      if (metricSamples.length) await writeFile(path.join(work, 'metrics.json'), JSON.stringify(metricSamples, null, 2));
    })().catch(() => {}).finally(() => {
      quitFlushComplete = true;
      app.quit();
    });
  });
  app.whenReady().then(start).catch(error => { console.error(error); app.quit(); });
}
