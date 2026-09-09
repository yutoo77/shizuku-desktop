import { Avatar, type AvatarDiagnostics } from './avatar';

declare global {
  interface Window {
    /** Read-only inspection surface for local acceptance checks; no IPC methods. */
    __diagnostics: AvatarDiagnostics;
  }
}

const canvas = document.getElementById('avatar');
let avatar: Avatar | null = null;
let disposed = false;
let revision = 0;
let windowVisible = true;
let moveActive = false;
let moveRevision = 0;
let moveEnding = false;
let pointerId: number | null = null;
let pendingCall: { revision: number; expires: number } | null = null;
const unsubscribers: Array<() => void> = [];

function reportError(error: unknown): void {
  pendingCall = null;
  cancelMoveMode();
  const message = error instanceof Error ? error.message : 'モデルを表示できませんでした。';
  if (avatar) avatar.diagnostics.error = message;
  window.companion.ready({ ok: false, error: message });
}

async function reload(): Promise<void> {
  pendingCall = null;
  const current = ++revision;
  cancelMoveMode();
  avatar?.clear();
  try {
    const buffer = await window.companion.getModel();
    if (disposed || current !== revision || !avatar) return;
    if (!buffer) {
      avatar.clear();
      reportError(new Error('トレイの「VRMを選ぶ…」からVRMを選んでください。'));
      return;
    }
    const loaded = await avatar.load(buffer);
    if (loaded && !disposed && current === revision) window.companion.ready({ ok: true });
  } catch (error) {
    if (!disposed && current === revision) reportError(error);
  }
}

function updateVisibility(): void {
  if (!windowVisible) pendingCall = null;
  if (!windowVisible || document.hidden) cancelMoveMode();
  avatar?.setVisible(windowVisible && !document.hidden);
  tryStartCall();
}

function tryStartCall(): void {
  if (!pendingCall) return;
  if (disposed || pendingCall.revision !== revision || Date.now() > pendingCall.expires) {
    pendingCall = null;
    return;
  }
  // Native showInactive and document.visibilitychange can arrive separately.
  // Retain only one brief request until the page is ready to draw it.
  if (!windowVisible || document.hidden || moveActive || !avatar?.diagnostics.loaded) return;
  pendingCall = null;
  avatar.call();
}

function releasePointer(): void {
  const captured = pointerId;
  pointerId = null;
  document.body.classList.remove('move-dragging');
  if (captured !== null && canvas instanceof HTMLCanvasElement && canvas.hasPointerCapture(captured)) {
    canvas.releasePointerCapture(captured);
  }
}

function clearMoveMode(): void {
  moveActive = false;
  moveEnding = false;
  releasePointer();
  document.body.classList.remove('move-mode');
  avatar?.exitMoveMode();
}

function finishMove(kind: 'end' | 'cancel', event?: PointerEvent): void {
  if (!moveActive || moveEnding) return;
  moveEnding = true;
  releasePointer();
  const point = event ? { x: event.screenX, y: event.screenY } : undefined;
  if (kind === 'end') window.companion.movePointer(moveRevision, 'move', point);
  window.companion.movePointer(moveRevision, kind, point);
  // Keep the pose frozen until main has restored the ordinary transparent window.
}

function cancelMoveMode(): void {
  finishMove('cancel');
}

async function updateMoveMode(state: {active: boolean; revision: number}): Promise<void> {
  if (disposed || state.revision < moveRevision) return;
  if (state.revision === moveRevision && state.active === moveActive) return;
  clearMoveMode();
  moveRevision = state.revision;
  if (!state.active) return;
  pendingCall = null;
  moveActive = true;
  const current = moveRevision;
  try {
    if (!avatar) throw new Error('しずくを準備できませんでした。');
    const shape = avatar.enterMoveMode();
    document.body.classList.add('move-mode');
    const accepted = await window.companion.submitMoveShape(current, shape);
    if (disposed || current !== moveRevision || !moveActive) return;
    if (!accepted) finishMove('cancel');
  } catch (error) {
    if (disposed || current !== moveRevision || !moveActive) return;
    if (avatar) avatar.diagnostics.error = error instanceof Error ? error.message : '移動を始められませんでした。';
    finishMove('cancel');
  }
}

function onPointerDown(event: PointerEvent): void {
  if (!moveActive || moveEnding || pointerId !== null || event.button !== 0 || !event.isPrimary) return;
  if (!(canvas instanceof HTMLCanvasElement)) return;
  event.preventDefault();
  pointerId = event.pointerId;
  try {
    canvas.setPointerCapture(pointerId);
    document.body.classList.add('move-dragging');
    window.companion.movePointer(moveRevision, 'start', { x: event.screenX, y: event.screenY });
  } catch {
    finishMove('cancel');
  }
}

function onPointerMove(event: PointerEvent): void {
  if (!moveActive || moveEnding || event.pointerId !== pointerId) return;
  if ((event.buttons & 1) === 0) {
    finishMove('end', event);
    return;
  }
  event.preventDefault();
  window.companion.movePointer(moveRevision, 'move', { x: event.screenX, y: event.screenY });
}

function onPointerUp(event: PointerEvent): void {
  if (event.pointerId === pointerId) finishMove('end', event);
}

function onPointerCancelled(event: PointerEvent): void {
  if (event.pointerId === pointerId) finishMove('cancel');
}

function onWindowInterruption(): void {
  finishMove('cancel');
}

try {
  if (!(canvas instanceof HTMLCanvasElement)) throw new Error('描画領域を準備できませんでした。');
  avatar = new Avatar(canvas);
  window.__diagnostics = avatar.diagnostics;
  unsubscribers.push(window.companion.onVisibility(visible => {
    windowVisible = visible;
    updateVisibility();
  }));
  unsubscribers.push(window.companion.onModelChanged(() => { void reload(); }));
  unsubscribers.push(window.companion.onCalled(expiresAt => {
    if (disposed || !windowVisible || !avatar?.diagnostics.loaded || !Number.isFinite(expiresAt)) return;
    pendingCall = { revision, expires: expiresAt };
    tryStartCall();
  }));
  unsubscribers.push(window.companion.onMoveMode(state => { void updateMoveMode(state); }));
  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerCancelled);
  canvas.addEventListener('lostpointercapture', onPointerCancelled);
  window.addEventListener('blur', onWindowInterruption);
  window.addEventListener('resize', onWindowInterruption);
  document.addEventListener('visibilitychange', updateVisibility);
  updateVisibility();
  void reload();
} catch (error) {
  reportError(error);
}

window.addEventListener('beforeunload', () => {
  cancelMoveMode();
  disposed = true;
  pendingCall = null;
  avatar?.setVisible(false);
  clearMoveMode();
  revision += 1;
  for (const unsubscribe of unsubscribers) unsubscribe();
  document.removeEventListener('visibilitychange', updateVisibility);
  canvas?.removeEventListener('pointerdown', onPointerDown as EventListener);
  canvas?.removeEventListener('pointermove', onPointerMove as EventListener);
  canvas?.removeEventListener('pointerup', onPointerUp as EventListener);
  canvas?.removeEventListener('pointercancel', onPointerCancelled as EventListener);
  canvas?.removeEventListener('lostpointercapture', onPointerCancelled as EventListener);
  window.removeEventListener('blur', onWindowInterruption);
  window.removeEventListener('resize', onWindowInterruption);
  avatar?.dispose();
}, { once: true });
