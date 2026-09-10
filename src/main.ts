import { app, BrowserWindow, Tray, Menu, nativeImage, globalShortcut, screen, ipcMain, dialog, session, powerMonitor } from 'electron';
import type { IpcMainEvent, IpcMainInvokeEvent, Rectangle } from 'electron';
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { defaultBounds, clampBounds, followControlMove, normalizeScale, avatarSize, resizeAvatarBounds } from './geometry.mjs';
import { MAX_MODEL_BYTES, validateModel } from './model-policy.mjs';
import { validateShape, containsPoint, dragBounds } from './move-policy.mjs';
import { normalizePosture } from './posture.mjs';
import { normalizeFacing, normalizeFavorite, seatBounds, validateAnchor } from './placement.mjs';
import { followPlacement } from './follow-policy.mjs';
import { WindowTracker, type TrackedWindow, type TrackingEvent, type FixtureWindow } from './window-tracker';
import { DialogueWindowController, type DialogueConnection } from './dialogue-window';
import { createOpenAIConnection } from './openai-reply.mjs';

// A user-owned key is captured only by the main-process adapter. Do not pass it
// to renderer/native children or persist it. Test launches cannot use this key.
const dialogueAI = createOpenAIConnection({ apiKey: process.env.SHIZUKU_TEST === '1' ? undefined : process.env.OPENAI_API_KEY });
delete process.env.OPENAI_API_KEY;

const root = path.resolve(__dirname, '..');
const work = path.join(root, 'work');
const testDataName = process.env.SHIZUKU_TEST === '1' ? process.env.SHIZUKU_TEST_DATA : undefined;
if (testDataName !== undefined && !/^[A-Za-z0-9_-]{1,80}$/.test(testDataName)) throw new Error('Invalid test data directory name');
const dataRoot = testDataName ? path.join(work, testDataName) : work;
const configPath = path.join(testDataName ? dataRoot : root, 'local.config.json');
const avatarUrl = pathToFileURL(path.join(__dirname, 'index.html')).href;
const controlsUrl = pathToFileURL(path.join(__dirname, 'controls.html')).href;
let avatar: BrowserWindow | null = null;
let controls: BrowserWindow | null = null;
let dialogue: DialogueWindowController | null = null;
let dialogueTestReply: ((text: string, context: { signal: AbortSignal; history: unknown[] }) => Promise<string>) | undefined;
let dialogueTestAI: DialogueConnection | undefined;
let tray: Tray | null = null;
let trayMenu: Menu | null = null;
let modelPath = '';
let scale = 100;
let posture: 'standing' | 'sitting' = 'standing';
let facing: 'left' | 'right' = 'right';
let quiet = false;
let favorite: ReturnType<typeof normalizeFavorite> = null;
let seatRevision = 0;
let pendingSeat: { revision: number; point: { x: number; y: number }; followId?: number } | null = null;
let seatTimer: NodeJS.Timeout | undefined;
let seatCountdown = 0;
let placementMessage = '';
let tracker: WindowTracker | null = null;
let followSequence = 0;
let following: { id: number; window: TrackedWindow | null; anchor: { x: number; y: number } | null; state: string; layerAttempts: number } | null = null;
let followCountdown = 0;
let followTimer: NodeJS.Timeout | undefined;
let windowSelection: { id: number; deadline: number } | null = null;
let selectionEscape = false;
let savedBounds: Rectangle | undefined;
let loadError = '';
let modelLoaded = false;
let contextRecovering = false;
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
let moveMode = false;
let moveRevision = 0;
let moveShape: Rectangle[] = [];
let moveTimeout: NodeJS.Timeout | undefined;
let moveStart: { bounds: Rectangle; cursor: { x: number; y: number } } | null = null;
let pointerPlacement: { bounds: Rectangle; cursor: { x: number; y: number }; deadline: number } | null = null;
let pointerTimer: NodeJS.Timeout | undefined;
let placementEscape = false;
const restReasons = new Set<'suspend' | 'lock'>();
let restSnapshot: { visible: boolean; controlsVisible: boolean; following: boolean } | null = null;
const systemResting = () => restReasons.size > 0;
const metricSamples: unknown[] = [];
const area = () => screen.getPrimaryDisplay().workArea;

function beginSystemRest(reason: 'suspend' | 'lock') {
  if (quitting || restReasons.has(reason)) return;
  restReasons.add(reason);
  if (restSnapshot) return;
  restSnapshot = { visible, controlsVisible: !!controls?.isVisible(), following: !!following };
  dialogue?.close();
  stopFollowing(false); cancelSeat(); setMoveMode(false);
  tracker?.setPaused(true);
  applyVisibility(false);
  controls?.hide();
  placementMessage = '';
  updateMenu();
}
function endSystemRest(reason: 'suspend' | 'lock') {
  if (quitting || !restReasons.delete(reason) || systemResting() || !restSnapshot) return;
  const previous = restSnapshot;
  restSnapshot = null;
  tracker?.setPaused(false);
  // A formerly followed window may have moved or disappeared while away.
  // Return to the edge and require a new selection; never replay old input.
  if (previous.following) placeAvatar(defaultBounds(area(), scale));
  applyVisibility(previous.visible);
  if (previous.controlsVisible && controls && !controls.isDestroyed()) controls.showInactive();
  placementMessage = previous.following ? '窓の追従を解除しました。必要なら選び直してね。' : '';
  if (tracker && !tracker.ready) placementMessage = '窓の追従を使うには、アプリを再起動してください。';
  saveSoon(); updateMenu();
}

function avatarBounds(win: BrowserWindow): Rectangle {
  return { ...(pendingAvatarBounds ?? win.getBounds()) };
}
function placeAvatar(bounds: Rectangle) {
  if (quitting || !avatar || avatar.isDestroyed()) return;
  const win = avatar;
  const target = clampBounds({ ...bounds, ...avatarSize(scale, area()) }, area());
  const current = avatarBounds(win);
  if (current.x === target.x && current.y === target.y && current.width === target.width && current.height === target.height) return;
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
  if (avatar && !avatar.isDestroyed()) savedBounds = pointerPlacement ? { ...pointerPlacement.bounds } : avatarBounds(avatar);
  const value = JSON.stringify({ modelPath, bounds: savedBounds, scale, posture, facing, quiet, favorite }, null, 2);
  writeQueue = writeQueue.then(() => writeFile(configPath, value, 'utf8')).catch(error => console.error('Configuration could not be saved:', error.code));
  return writeQueue;
}
function saveSoon() {
  if (quitting) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => void save(), 400);
}
function setVisible(next: boolean) {
  if (!next) dialogue?.close();
  if (systemResting()) { if (!next && restSnapshot) restSnapshot.visible = false; return; }
  stopFollowing(false);
  applyVisibility(next);
}
function applyVisibility(next: boolean) {
  if (quitting || !avatar || avatar.isDestroyed()) return;
  next = next && !systemResting();
  if (!next) { cancelSeat(); setMoveMode(false); }
  visible = next;
  if (next) {
    placeAvatar(avatarBounds(avatar));
    avatar.showInactive();
  } else avatar.hide();
  avatar.webContents.send('avatar:visibility', next);
  updateMenu();
}
function reset() {
  if (quitting || systemResting()) return;
  stopFollowing(false);
  cancelSeat();
  setMoveMode(false);
  setVisible(true);
  placeAvatar(defaultBounds(area(), scale));
  saveSoon();
}
function callAvatar() {
  if (quitting || systemResting() || !avatar || avatar.isDestroyed()) return;
  cancelWindowSelection('');
  cancelSeat();
  if (following && (!visible || !following.anchor)) stopFollowing(true);
  if (contextRecovering) return;
  if (!modelLoaded) { openControls(); return; }
  setMoveMode(false);
  if (!visible) setVisible(true);
  avatar.webContents.send('avatar:called', Date.now() + 1000);
  dialogue?.open();
}
function setScale(value: unknown) {
  if (typeof value !== 'number' || ![80, 100, 120].includes(value)) throw new Error('Unknown size');
  if (quitting || systemResting() || !avatar || avatar.isDestroyed() || value === scale) return;
  stopFollowing(false);
  cancelSeat();
  setMoveMode(false);
  const bounds = resizeAvatarBounds(avatarBounds(avatar), value, area());
  scale = value;
  placeAvatar(bounds);
  saveSoon();
  updateMenu();
}
function setPosture(value: unknown, keepFollowing = false) {
  if (value !== 'standing' && value !== 'sitting') throw new Error('Unknown posture');
  if (quitting || systemResting() || !avatar || avatar.isDestroyed() || value === posture) return;
  if (!keepFollowing) stopFollowing(false);
  cancelSeat();
  setMoveMode(false);
  posture = value;
  avatar.webContents.send('avatar:posture', posture);
  saveSoon();
  updateMenu();
}
function setPresence(nextFacing: unknown, nextQuiet: unknown) {
  if ((nextFacing !== 'left' && nextFacing !== 'right') || typeof nextQuiet !== 'boolean') throw new Error('Unknown presence');
  if (quitting || systemResting() || !avatar || avatar.isDestroyed() || (nextFacing === facing && nextQuiet === quiet)) return;
  cancelWindowSelection('');
  if (nextFacing !== facing || (following && !following.anchor)) stopFollowing(false);
  cancelSeat();
  setMoveMode(false);
  facing = nextFacing; quiet = nextQuiet;
  avatar.webContents.send('avatar:presence', { facing, quiet });
  saveSoon(); updateMenu();
}
function cancelSeat() {
  clearTimeout(seatTimer);
  seatCountdown = 0;
  pendingSeat = null;
  seatRevision++;
  if (avatar && !avatar.isDestroyed()) avatar.webContents.send('avatar:seat-request', null);
}
function seatAtPoint(point: { x: number; y: number }) {
  if (systemResting()) return;
  stopFollowing(false);
  cancelSeat();
  if (quitting || !modelLoaded || contextRecovering || !avatar || avatar.isDestroyed()) { updateMenu(); return; }
  setMoveMode(false);
  setPosture('sitting');
  setVisible(true);
  const revision = ++seatRevision;
  pendingSeat = { revision, point: { ...point } };
  placementMessage = '';
  avatar.webContents.send('avatar:seat-request', revision);
  seatTimer = setTimeout(() => {
    if (pendingSeat?.revision !== revision) return;
    cancelSeat(); placementMessage = '座る位置を確認できませんでした。矢印で調整できます。'; updateMenu();
  }, 4000);
  updateMenu();
}
function scheduleSeat() {
  if (systemResting()) return;
  stopFollowing(false);
  if (seatCountdown || pendingSeat) { cancelSeat(); updateMenu(); return; }
  if (quitting || !modelLoaded || contextRecovering) return;
  setMoveMode(false);
  placementMessage = '';
  seatCountdown = 3;
  const tick = () => {
    if (quitting || seatCountdown === 0) return;
    seatCountdown--;
    if (seatCountdown === 0) { seatAtPoint(screen.getCursorScreenPoint()); return; }
    updateMenu(); seatTimer = setTimeout(tick, 1000);
  };
  updateMenu(); seatTimer = setTimeout(tick, 1000);
}
function saveFavorite() {
  if (quitting || systemResting() || !avatar || avatar.isDestroyed()) return;
  stopFollowing(false); cancelSeat(); setMoveMode(false);
  favorite = normalizeFavorite({ bounds: avatarBounds(avatar), scale, posture, facing }, area());
  placementMessage = 'この位置を覚えました。';
  saveSoon(); updateMenu();
}
function restoreFavorite() {
  if (quitting || systemResting() || !favorite || !avatar || avatar.isDestroyed()) return;
  stopFollowing(false); cancelSeat(); setMoveMode(false);
  const spot = normalizeFavorite(favorite, area());
  if (!spot) return;
  setScale(spot.scale); setPosture(spot.posture); setPresence(spot.facing, quiet);
  placeAvatar(spot.bounds); setVisible(true);
  placementMessage = ''; saveSoon(); updateMenu();
}
function stopFollowing(recover: boolean) {
  if (!following && !followCountdown) return;
  const attached = !!following;
  following = null;
  if (attached && avatar && !avatar.isDestroyed()) avatar.setAlwaysOnTop(true, 'pop-up-menu');
  followCountdown = 0;
  windowSelection = null;
  if (selectionEscape) globalShortcut.unregister('Escape');
  selectionEscape = false;
  clearTimeout(followTimer);
  tracker?.stop();
  if (attached) clearTimeout(seatTimer);
  if (pendingSeat?.followId) cancelSeat();
  if (recover && attached && !quitting) {
    applyVisibility(true);
    placeAvatar(defaultBounds(area(), scale));
    saveSoon();
  }
  updateMenu();
}
function startFollowing(fixture?: FixtureWindow) {
  if (systemResting()) return;
  if (fixture && process.env.SHIZUKU_TEST !== '1') return;
  if (following) { stopFollowing(true); return; }
  if (quitting || !modelLoaded || contextRecovering || !tracker?.ready || !avatar) return;
  stopFollowing(false); cancelSeat(); setMoveMode(false);
  const id = ++followSequence;
  placementMessage = '';
  prepareFollowing(id);
  try { tracker.select(id, fixture); }
  catch { stopFollowing(true); placementMessage = '追従を始められませんでした。再起動して試してください。'; }
  updateMenu();
}
function prepareFollowing(id: number) {
  following = { id, window: null, anchor: null, state: 'preparing', layerAttempts: 0 };
  seatTimer = setTimeout(() => {
    if (following?.id === id && !following.anchor) { stopFollowing(true); placementMessage = '座る位置を確認できませんでした。'; updateMenu(); }
  }, 4000);
}
function scheduleFollowing(fixture?: FixtureWindow) {
  if (systemResting()) return;
  if (fixture && process.env.SHIZUKU_TEST !== '1') return;
  if (following || followCountdown) { stopFollowing(true); return; }
  if (quitting || !modelLoaded || contextRecovering || !tracker?.ready) return;
  cancelSeat(); setMoveMode(false);
  placementMessage = ''; followCountdown = 20;
  windowSelection = { id: ++followSequence, deadline: Date.now() + 20_000 };
  selectionEscape = globalShortcut.register('Escape', () => cancelWindowSelection());
  try { tracker.pick(windowSelection.id, fixture); }
  catch { cancelWindowSelection('窓を選べませんでした。再起動して試してください。'); return; }
  updateMenu(); followTimer = setTimeout(tickWindowSelection, 250);
}
function cancelWindowSelection(message = '窓の選択を取り消しました。') {
  if (!windowSelection) return;
  stopFollowing(false); placementMessage = message; updateMenu();
}
function tickWindowSelection(now = Date.now()) {
  if (quitting || !windowSelection) return;
  const remaining = Math.max(0, Math.ceil((windowSelection.deadline - now) / 1000));
  if (!remaining) { cancelWindowSelection(); return; }
  if (remaining !== followCountdown) { followCountdown = remaining; updateMenu(); }
  followTimer = setTimeout(tickWindowSelection, 250);
}
function updateFollowing() {
  const target = following;
  if (!target?.window || !target.anchor || !avatar || quitting) return;
  const previous = target.state;
  let bounds: Rectangle | null = null;
  if (target.window.state !== 'visible') target.state = target.window.state;
  else {
    const physical = { x: target.window.x, y: target.window.y, width: target.window.width, height: target.window.height };
    const rect = screen.screenToDipRect(null, physical);
    if (screen.getDisplayMatching(rect).id !== screen.getPrimaryDisplay().id) target.state = 'other-screen';
    else {
      bounds = followPlacement(rect, target.anchor, scale, area());
      target.state = bounds ? 'following' : 'no-room';
    }
  }
  if (bounds) {
    const changingLayer = avatar.isAlwaysOnTop() !== target.window.topmost;
    const revealing = !visible;
    if (changingLayer) avatar.setAlwaysOnTop(target.window.topmost, 'pop-up-menu');
    placeAvatar(bounds);
    if (!visible) applyVisibility(true);
    if (changingLayer || revealing || !target.window.adjacent) {
      try {
        if (++target.layerAttempts > 4) throw new Error('Window order did not settle');
        // Electron moves only our window, with SWP_NOACTIVATE. It does not
        // capture the source or alter the target window's bounds/focus.
        avatar.moveAbove(target.window.sourceId);
      } catch {
        stopFollowing(true); placementMessage = '窓の重なりを合わせられないため、画面端へ戻りました。'; updateMenu(); return;
      }
    } else target.layerAttempts = 0;
  } else {
    target.layerAttempts = 0;
    if (visible) applyVisibility(false);
  }
  if (previous !== target.state) updateMenu();
}
function onTrackedWindow(event: TrackingEvent) {
  if (quitting || systemResting()) return;
  if (windowSelection?.id === event.id) {
    if (Date.now() >= windowSelection.deadline) { cancelWindowSelection(); return; }
    if (event.type === 'end') { cancelWindowSelection(); return; }
    clearTimeout(followTimer); followCountdown = 0; windowSelection = null;
    if (selectionEscape) globalShortcut.unregister('Escape');
    selectionEscape = false;
    prepareFollowing(event.id);
    updateMenu();
  }
  if (!following || event.id !== following.id) return;
  if (event.type === 'end') {
    const reason = event.reason;
    stopFollowing(true);
    placementMessage = reason === 'closed' ? '窓を閉じたので、画面端に戻りました。'
      : reason === 'ineligible' ? '座らせたい別の窓を選んで、もう一度試してください。'
      : '窓を確認できないため、画面端に戻りました。';
    updateMenu(); return;
  }
  following.window = event;
  if (!following.anchor && !pendingSeat?.followId && event.state === 'visible') {
    // Capture the selected native window BEFORE showing or changing our own
    // windows; otherwise focus transitions could change the selection.
    setPosture('sitting', true);
    applyVisibility(true);
    const revision = ++seatRevision;
    pendingSeat = { revision, point: { x: 0, y: 0 }, followId: following.id };
    avatar?.webContents.send('avatar:seat-request', revision);
    clearTimeout(seatTimer);
    seatTimer = setTimeout(() => {
      if (following?.id === event.id && !following.anchor) { stopFollowing(true); placementMessage = '座る位置を確認できませんでした。'; updateMenu(); }
    }, 4000);
  }
  updateFollowing();
}
function followMessage(): string {
  if (followCountdown) return `座らせたい窓をクリックしてね。${selectionEscape ? 'Escで取消。' : ''}あと${followCountdown}秒`;
  if (!following) return '';
  if (following.state === 'following') return '窓の動きについていきます。';
  if (following.state === 'preparing') return '座る位置を合わせています。';
  if (following.state === 'no-room') return '窓の上に余白ができるまで、隠れて待ちます。';
  if (following.state === 'other-screen') return '窓が主画面へ戻るまで、隠れて待ちます。';
  return '窓を戻すまで、隠れて待ちます。';
}
function renewMoveTimeout() {
  clearTimeout(moveTimeout);
  // A lost release or abandoned move mode must never leave an input-catching window.
  moveTimeout = setTimeout(() => setMoveMode(false), 30_000);
}
function finishPointerPlacement(commit: boolean, message = '') {
  if (!pointerPlacement) return;
  const origin = pointerPlacement.bounds;
  pointerPlacement = null;
  clearInterval(pointerTimer); pointerTimer = undefined;
  if (placementEscape) globalShortcut.unregister('Escape');
  placementEscape = false;
  if (!commit) placeAvatar(origin);
  avatar?.webContents.send('avatar:pointer-placement', false);
  placementMessage = message;
  saveSoon(); updateMenu();
}
function tickPointerPlacement(point = screen.getCursorScreenPoint(), now = performance.now()) {
  const move = pointerPlacement;
  if (!move || quitting) return;
  if (now >= move.deadline) { finishPointerPlacement(false, '移動を取り消し、元の位置へ戻しました。'); return; }
  // Keep the preview steady while using our own confirm/cancel buttons.
  if (controls && !controls.isDestroyed() && controls.isVisible() && containsPoint([controls.getBounds()], point)) return;
  try { placeAvatar(dragBounds(move.bounds, move.cursor, point, area())); }
  catch { finishPointerPlacement(false); }
}
function togglePointerPlacement() {
  if (systemResting()) return;
  if (pointerPlacement) { tickPointerPlacement(); finishPointerPlacement(true, 'この位置に置きました。'); return; }
  if (quitting || !modelLoaded || contextRecovering || !avatar || avatar.isDestroyed()) return;
  stopFollowing(false); cancelSeat(); setMoveMode(false);
  if (!visible) applyVisibility(true);
  pointerPlacement = { bounds: avatarBounds(avatar), cursor: screen.getCursorScreenPoint(), deadline: performance.now() + 30_000 };
  placementEscape = globalShortcut.register('Escape', () => finishPointerPlacement(false, '元の位置へ戻しました。'));
  placementMessage = '';
  // The entire avatar stays click-through; no pointer capture or foreign focus changes.
  avatar.setIgnoreMouseEvents(true);
  avatar.webContents.send('avatar:pointer-placement', true);
  pointerTimer = setInterval(tickPointerPlacement, 33);
  updateMenu();
}
function setMoveMode(next: boolean) {
  if (next && systemResting()) return;
  finishPointerPlacement(false);
  if (quitting || !avatar || avatar.isDestroyed()) return;
  if (next) { stopFollowing(false); cancelSeat(); }
  if (next && contextRecovering) return;
  if (next && !modelLoaded) { openControls(); return; }
  if (next && !visible) setVisible(true);
  if (moveMode === next) return;
  moveMode = next;
  moveRevision++;
  moveShape = [];
  moveStart = null;
  clearTimeout(moveTimeout);
  // Ignore first, then clear the shape: [] restores a rectangular native window.
  avatar.setIgnoreMouseEvents(true);
  avatar.setShape([]);
  avatar.webContents.send('avatar:move-mode', { active: next, revision: moveRevision });
  if (next) renewMoveTimeout();
  else saveSoon();
  updateMenu();
}
function movePointer(revision: unknown, kind: unknown, point?: unknown) {
  if (quitting || !moveMode || revision !== moveRevision || !avatar || avatar.isDestroyed()) return;
  if (kind === 'cancel') { setMoveMode(false); return; }
  if (kind !== 'start' && kind !== 'move' && kind !== 'end') return;
  if (!point || typeof point !== 'object' || !('x' in point) || !('y' in point)
    || typeof point.x !== 'number' || typeof point.y !== 'number'
    || !Number.isFinite(point.x) || !Number.isFinite(point.y)
    || Math.abs(point.x) > 1_000_000 || Math.abs(point.y) > 1_000_000) { setMoveMode(false); return; }
  // Use event-time DIP coordinates; reading the global cursor here races queued IPC.
  const cursor = { x: point.x, y: point.y };
  if (kind === 'start') {
    if (moveStart || !moveShape.length) return;
    const bounds = avatarBounds(avatar);
    if (!containsPoint(moveShape, { x: cursor.x - bounds.x, y: cursor.y - bounds.y })) return;
    moveStart = { bounds, cursor };
  } else if (moveStart) {
    try { placeAvatar(dragBounds(moveStart.bounds, moveStart.cursor, cursor, area())); }
    catch { setMoveMode(false); return; }
  }
  if (kind === 'end') { setMoveMode(false); return; }
  renewMoveTimeout();
}
function trusted(event: IpcMainInvokeEvent | IpcMainEvent, owner: BrowserWindow | null, expected: string) {
  return !!owner && !owner.isDestroyed() && event.sender === owner.webContents && event.senderFrame === owner.webContents.mainFrame && event.senderFrame.url === expected;
}
function secureWindow(win: BrowserWindow) {
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', event => event.preventDefault());
  win.webContents.on('will-attach-webview', event => event.preventDefault());
  win.webContents.on('content-bounds-updated', event => event.preventDefault());
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
  trayMenu = Menu.buildFromTemplate([
    { label: '月白 しずく', enabled: false },
    ...(loadError ? [{ label: loadError.slice(0, 65), enabled: false }] : []),
    { label: '呼ぶ', enabled: modelLoaded, click: callAvatar },
    { label: visible ? '隠す' : '表示する', click: () => setVisible(!visible) },
    { label: pointerPlacement ? 'この位置に置く' : 'ポインターで移動', enabled: modelLoaded, click: togglePointerPlacement },
    { label: '位置を動かす…', click: openControls },
    { label: seatCountdown || pendingSeat ? '座る場所の指定をやめる' : '3秒後のポインター位置に座る', enabled: modelLoaded, click: scheduleSeat },
    // A tray menu can dismiss back to the previously focused app. Start the
    // picker from our controls so that this cannot silently select that app.
    { label: following ? '窓の追従をやめる' : followCountdown ? '窓の選択をやめる' : '座る窓を選ぶ…', enabled: modelLoaded && !!tracker?.ready, click: () => following || followCountdown ? stopFollowing(true) : openControls() },
    { label: 'お気に入りの位置', submenu: [
      { label: '今の位置を覚える', click: saveFavorite },
      { label: '覚えた位置へ戻る', enabled: !!favorite, click: restoreFavorite },
    ] },
    { label: '姿勢', submenu: [
      { label: '立つ', type: 'radio', checked: posture === 'standing', click: () => setPosture('standing') },
      { label: '座る', type: 'radio', checked: posture === 'sitting', click: () => setPosture('sitting') },
    ] },
    { label: '大きさ', submenu: [
      { label: '小', type: 'radio', checked: scale === 80, click: () => setScale(80) },
      { label: '標準', type: 'radio', checked: scale === 100, click: () => setScale(100) },
      { label: '大', type: 'radio', checked: scale === 120, click: () => setScale(120) },
    ] },
    { label: '向き', submenu: [
      { label: '左', type: 'radio', checked: facing === 'left', click: () => setPresence('left', quiet) },
      { label: '右', type: 'radio', checked: facing === 'right', click: () => setPresence('right', quiet) },
    ] },
    { label: '動きを休める', type: 'checkbox', checked: quiet, click: () => setPresence(facing, !quiet) },
    { label: '画面端に戻す', click: reset },
    { type: 'separator' as const },
    { label: 'VRMを選ぶ…', click: () => void chooseModel() },
    { label: '終了', click: () => app.quit() },
  ]);
  if (systemResting()) for (const item of trayMenu.items) if (item.label !== '終了') item.enabled = false;
  tray?.setContextMenu(trayMenu);
  tray?.setToolTip(`月白しずく — ${systemResting() ? 'Windowsの復帰を待っています' : loadError || followMessage() || (pointerPlacement ? 'Mで位置を決定・30秒で取消' : moveMode ? 'つかんで移動できます' : visible ? '表示中' : '非表示')}`);
}
function openControls() {
  if (quitting || systemResting()) return;
  if (controls && !controls.isDestroyed()) { controls.show(); controls.focus(); return; }
  const win = new BrowserWindow({
    width: 360, height: 600, title: 'しずく', resizable: false,
    backgroundColor: '#f8fbff', autoHideMenuBar: true, icon: icon(),
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true, spellcheck: false },
  });
  controls = win;
  secureWindow(win);
  let previous = win.getBounds();
  win.on('move', () => {
    if (quitting || controls !== win || win.isDestroyed() || !avatar) return;
    if (systemResting()) { previous = win.getBounds(); return; }
    stopFollowing(false);
    cancelSeat();
    setMoveMode(false);
    const next = win.getBounds();
    placeAvatar(followControlMove(avatarBounds(avatar), previous, next, area()));
    previous = next;
    saveSoon();
  });
  // An older window can finish closing after its replacement has opened.
  win.on('close', () => { if (controls === win) { controls = null; cancelWindowSelection(''); } });
  win.on('closed', () => { if (controls === win) controls = null; });
  void win.loadURL(controlsUrl);
}
async function chooseModel() {
  if (choosing || quitting || systemResting()) return;
  stopFollowing(true);
  cancelSeat();
  setMoveMode(false);
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
  if (systemResting() && value !== 'hide' && value !== 'quit') return;
  if (value === 'show') setVisible(true);
  else if (value === 'hide') setVisible(false);
  else if (value === 'reset') reset();
  else if (value === 'call') callAvatar();
  else if (value === 'choose-model') await chooseModel();
  else if (value === 'move-mode') setMoveMode(!moveMode);
  else if (value === 'pointer-place') togglePointerPlacement();
  else if (value === 'cancel-placement') finishPointerPlacement(false, '元の位置へ戻しました。');
  else if (value === 'size-small') setScale(80);
  else if (value === 'size-standard') setScale(100);
  else if (value === 'size-large') setScale(120);
  else if (value === 'stand') setPosture('standing');
  else if (value === 'sit') setPosture('sitting');
  else if (value === 'face-left') setPresence('left', quiet);
  else if (value === 'face-right') setPresence('right', quiet);
  else if (value === 'quiet') setPresence(facing, !quiet);
  else if (value === 'seat-countdown') scheduleSeat();
  else if (value === 'seat-here') seatAtPoint(screen.getCursorScreenPoint());
  else if (value === 'follow-window') startFollowing();
  else if (value === 'follow-countdown') scheduleFollowing();
  else if (value === 'stop-following') stopFollowing(true);
  else if (value === 'save-favorite') saveFavorite();
  else if (value === 'restore-favorite') restoreFavorite();
  else if (value === 'quit') app.quit();
  else if (['left', 'right', 'up', 'down'].includes(value) && avatar) {
    stopFollowing(false);
    cancelSeat();
    setMoveMode(false);
    const bounds = avatarBounds(avatar);
    bounds.x += value === 'left' ? -16 : value === 'right' ? 16 : 0;
    bounds.y += value === 'up' ? -16 : value === 'down' ? 16 : 0;
    placeAvatar(bounds);
    saveSoon();
  } else throw new Error('Unknown action');
}
async function start() {
  await mkdir(dataRoot, { recursive: true });
  try {
    const config = JSON.parse((await readFile(configPath, 'utf8')).replace(/^\uFEFF/, ''));
    if (typeof config.modelPath === 'string') modelPath = config.modelPath;
    scale = normalizeScale(config.scale);
    posture = normalizePosture(config.posture);
    facing = normalizeFacing(config.facing);
    quiet = config.quiet === true;
    favorite = normalizeFavorite(config.favorite, area());
    if (config.bounds && typeof config.bounds === 'object') savedBounds = clampBounds({ ...config.bounds, ...avatarSize(scale, area()) }, area());
  } catch { /* Missing or malformed local config returns to safe defaults. */ }
  const allowedFiles = new Set(['index.html','controls.html','renderer.js','controls.js','style.css','dialogue.html','dialogue.js','dialogue.css'].map(file => pathToFileURL(path.join(__dirname,file)).href));
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  session.defaultSession.on('will-download', event => event.preventDefault());
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: !allowedFiles.has(details.url) && !details.url.startsWith('blob:') && !details.url.startsWith('data:') });
  });
  avatar = new BrowserWindow({
    ...clampBounds(savedBounds ?? defaultBounds(area(), scale), area()), title: '月白しずく',
    transparent: true, backgroundColor: '#00000000', frame: false, hasShadow: false,
    resizable: false, maximizable: false, minimizable: false, fullscreenable: false,
    focusable: false, skipTaskbar: true, alwaysOnTop: true, show: false,
    webPreferences: { preload: path.join(__dirname,'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true, spellcheck: false, backgroundThrottling: true },
  });
  // On this Windows setup, the default below-taskbar "floating" level loses
  // topmost status. Keep the avatar inside workArea and use the next native level.
  avatar.setAlwaysOnTop(true, 'pop-up-menu');
  avatar.setIgnoreMouseEvents(true);
  secureWindow(avatar);
  avatar.on('closed', () => { avatarPlacementGeneration++; pendingAvatarBounds = undefined; avatar = null; if (!quitting) app.quit(); });
  avatar.webContents.on('render-process-gone', () => { stopFollowing(true); cancelSeat(); setMoveMode(false); modelLoaded = false; contextRecovering = false; loadError = '描画が停止しました。終了して再起動してください。'; updateMenu(); });
  avatar.webContents.on('unresponsive', () => { stopFollowing(true); cancelSeat(); setMoveMode(false); updateMenu(); });
  ipcMain.on('avatar:seat-anchor', (event, revision, anchor) => {
    if (!trusted(event, avatar, avatarUrl) || !pendingSeat || revision !== pendingSeat.revision || !modelLoaded || !visible || !avatar) return;
    const { point, followId } = pendingSeat;
    cancelSeat();
    try {
      if (followId) {
        if (following?.id === followId) { following.anchor = validateAnchor(anchor); updateFollowing(); }
        return;
      }
      placeAvatar(seatBounds(point, anchor, scale, area()));
      placementMessage = '座る位置を合わせました。矢印で微調整できます。';
      saveSoon();
    } catch { stopFollowing(true); placementMessage = '座る位置を確認できませんでした。'; }
    updateMenu();
  });
  ipcMain.handle('avatar:move-shape', (event, revision, value) => {
    if (!trusted(event, avatar, avatarUrl)) throw new Error('Denied sender');
    if (!moveMode || revision !== moveRevision || !modelLoaded || !visible || !avatar || moveStart) return false;
    try {
      const { width, height } = avatar.getContentBounds();
      moveShape = validateShape(value, width, height);
      avatar.setShape(moveShape);
      avatar.setIgnoreMouseEvents(false);
      return true;
    } catch { setMoveMode(false); return false; }
  });
  ipcMain.on('avatar:move-pointer', (event, revision, kind, point) => {
    if (trusted(event, avatar, avatarUrl)) movePointer(revision, kind, point);
  });
  ipcMain.handle('model:read', async event => {
    if (!trusted(event, avatar, avatarUrl)) throw new Error('Denied sender');
    return modelPath ? readModel(modelPath) : null;
  });
  ipcMain.on('avatar:ready', (event, state) => {
    if (!trusted(event, avatar, avatarUrl) || !state || typeof state.ok !== 'boolean') return;
    if (state.recovering !== undefined && typeof state.recovering !== 'boolean') return;
    if (state.ok && state.recovering) return;
    contextRecovering = state.recovering === true;
    modelLoaded = state.ok;
    if (!state.ok) { stopFollowing(true); cancelSeat(); setMoveMode(false); }
    loadError = state.ok ? '' : String(state.error ?? 'モデル未選択').slice(0, 180);
    avatar?.webContents.send('avatar:visibility', visible);
    avatar?.webContents.send('avatar:posture', posture);
    avatar?.webContents.send('avatar:presence', { facing, quiet });
    updateMenu();
  });
  ipcMain.handle('controls:action', async (event, value) => {
    if (!trusted(event, controls, controlsUrl) || typeof value !== 'string') throw new Error('Denied sender');
    await action(value);
  });
  ipcMain.handle('controls:status', event => {
    if (!trusted(event, controls, controlsUrl)) throw new Error('Denied sender');
    return { model: modelPath ? path.basename(modelPath) : '', error: loadError, shortcuts, moving: moveMode, pointerPlacing: !!pointerPlacement, placementEscape, loaded: modelLoaded, scale, posture, facing, quiet, hasFavorite: !!favorite, seatCountdown, seating: !!pendingSeat, placementMessage, following: !!following, followCountdown, followReady: !!tracker?.ready, followMessage: followMessage() };
  });
  dialogue = new DialogueWindowController({
    url: pathToFileURL(path.join(__dirname, 'dialogue.html')).href,
    preload: path.join(__dirname, 'dialogue-preload.cjs'), icon: icon(), area,
    anchor: () => avatar ? avatarBounds(avatar) : defaultBounds(area(), scale),
    canOpen: () => !quitting && !systemResting(), secure: secureWindow,
    getReply: () => process.env.SHIZUKU_TEST === '1' ? dialogueTestReply : undefined,
    getAI: () => process.env.SHIZUKU_TEST === '1' ? dialogueTestAI : dialogueAI,
    onReply: () => {
      if (visible && modelLoaded && !systemResting() && avatar && !avatar.isDestroyed()) {
        avatar.webContents.send('avatar:called', Date.now() + 2600);
      }
    },
  });
  tray = new Tray(icon());
  tray.on('double-click', () => setVisible(!visible));
  const bindings: Array<[string, () => void]> = [
    ['CommandOrControl+Alt+Shift+S', () => setVisible(!visible)],
    ['CommandOrControl+Alt+Shift+R', reset],
    ['CommandOrControl+Alt+Shift+C', callAvatar],
    ['CommandOrControl+Alt+Shift+P', () => setPosture(posture === 'standing' ? 'sitting' : 'standing')],
    ['CommandOrControl+Alt+Shift+E', () => seatAtPoint(screen.getCursorScreenPoint())],
    ['CommandOrControl+Alt+Shift+W', () => startFollowing()],
    ['CommandOrControl+Alt+Shift+B', restoreFavorite],
    ['CommandOrControl+Alt+Shift+F', () => setPresence(facing === 'left' ? 'right' : 'left', quiet)],
    ['CommandOrControl+Alt+Shift+Z', () => setPresence(facing, !quiet)],
    ['CommandOrControl+Alt+Shift+M', togglePointerPlacement],
    ['CommandOrControl+Alt+Shift+Q', () => app.quit()],
  ];
  shortcuts = bindings.map(([key, handler]) => globalShortcut.register(key, () => {
    if (!systemResting() || key.endsWith('+Q')) handler();
  })).every(Boolean);
  updateMenu();
  screen.on('display-metrics-changed', () => { dialogue?.close(); stopFollowing(true); cancelSeat(); setMoveMode(false); if (avatar && !avatar.isDestroyed()) placeAvatar(avatarBounds(avatar)); updateMenu(); });
  tracker = new WindowTracker(onTrackedWindow, available => {
    if (quitting) return;
    if (!available) { stopFollowing(true); placementMessage = '窓の追従を使うには、アプリを再起動してください。'; }
    updateMenu();
  });
  if (process.platform === 'win32') tracker.start(path.join(__dirname, 'window-tracker.exe'), process.env.SHIZUKU_TEST === '1', avatar.getNativeWindowHandle().readBigUInt64LE().toString());
  powerMonitor.on('suspend', () => beginSystemRest('suspend'));
  powerMonitor.on('resume', () => endSystemRest('suspend'));
  powerMonitor.on('lock-screen', () => beginSystemRest('lock'));
  powerMonitor.on('unlock-screen', () => endSystemRest('lock'));
  await avatar.loadURL(avatarUrl);
  if (quitting || !avatar || avatar.isDestroyed()) return;
  if (visible) setVisible(true);
  if (!modelPath) openControls();
  if (process.env.SHIZUKU_METRICS === '1') {
    metricsTimer = setInterval(() => {
      metricSamples.push({ time: new Date().toISOString(), visible, loaded: modelLoaded, scale, processes: app.getAppMetrics(), windowTracker: { pid: tracker?.pid, ready: tracker?.ready, stats: tracker?.stats } });
      if (metricSamples.length > 1800) metricSamples.shift();
    }, 2000);
  }
  // Development-only inspection inside the main process; not exposed through IPC.
  if (process.env.SHIZUKU_TEST === '1') (globalThis as any).__shizuku = {
    avatar: () => avatar, controls: () => controls, setVisible, reset, openControls, action,
    dialogue: () => dialogue?.window(), dialogueState: () => dialogue?.snapshot(),
    openDialogue: () => dialogue?.open(), closeDialogue: () => dialogue?.close(),
    setDialogueReply: (reply: typeof dialogueTestReply) => { dialogueTestReply = reply; },
    setDialogueAI: (connection: DialogueConnection | undefined) => { dialogueTestAI = connection; },
    tray: () => tray, trayMenu: () => trayMenu,
    setMoveMode, moveState: () => ({ active: moveMode, revision: moveRevision, shape: moveShape, dragging: !!moveStart }),
    togglePointerPlacement, finishPointerPlacement, tickPointerPlacement,
    pointerState: () => ({ active: !!pointerPlacement, escape: placementEscape, timer: !!pointerTimer, origin: pointerPlacement?.bounds }),
    setScale, setPosture, setPresence, seatAtPoint, cancelSeat,
    startFollowing, scheduleFollowing, stopFollowing, onTrackedWindow,
    setForegroundFixture: (fixture: FixtureWindow) => tracker?.setForegroundFixture(fixture),
    // API checks exercise native metadata -> selection handoff independently
    // of Windows foreground transfer. Physical selection is checked separately.
    resolveSelectionFixture: (fixture: FixtureWindow) => {
      if (!windowSelection || !fixture) throw new Error('No fixture selection pending');
      tracker?.select(windowSelection.id, fixture);
    },
    cancelWindowSelection, tickWindowSelection,
    selection: () => ({ active: !!windowSelection, id: windowSelection?.id, seconds: followCountdown, escape: selectionEscape }),
    restState: () => ({ reasons: [...restReasons], snapshot: restSnapshot }),
    setHelperOutputPaused: (paused: boolean) => {
      const output = (tracker as any)?.child?.stdout;
      if (paused) output?.pause(); else output?.resume();
    },
    tracking: () => ({ following, countdown: followCountdown, ready: !!tracker?.ready, pid: tracker?.pid, stats: tracker?.stats }),
    status: () => ({ visible, modelLoaded, contextRecovering, loadError, shortcuts, scale, posture, facing, quiet, favorite, seatCountdown, pendingSeat, placementMessage }), metrics: () => app.getAppMetrics(),
  };
}

app.setName('shizuku-desktop');
app.setPath('userData', path.join(dataRoot, 'userdata'));
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (avatar) reset(); });
  app.on('window-all-closed', () => { /* tray owns lifetime */ });
  app.on('before-quit', event => {
    if (quitFlushComplete) return;
    event.preventDefault();
    if (quitting) return;
    stopFollowing(false); cancelSeat(); setMoveMode(false);
    quitting = true;
    dialogue?.dispose(); dialogue = null;
    avatarPlacementGeneration++;
    clearInterval(metricsTimer);
    clearTimeout(saveTimer);
    clearTimeout(moveTimeout);
    globalShortcut.unregisterAll();
    tray?.destroy(); tray = null; trayMenu = null;
    void (async () => {
      await tracker?.close();
      await save();
      if (metricSamples.length) await writeFile(path.join(dataRoot, 'metrics.json'), JSON.stringify(metricSamples, null, 2));
    })().catch(() => {}).finally(() => {
      quitFlushComplete = true;
      app.quit();
    });
  });
  app.whenReady().then(start).catch(error => { console.error(error); app.quit(); });
}
