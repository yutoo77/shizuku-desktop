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
let loading = false;
let windowVisible = true;
let moveActive = false;
let moveRevision = 0;
let moveEnding = false;
let pointerId: number | null = null;
let pendingCall: { revision: number; expires: number } | null = null;
let pendingSeat: number | null = null;
const unsubscribers: Array<() => void> = [];

function trySeat(): void {
  const state = avatar?.diagnostics;
  if (pendingSeat === null || disposed || loading || !state?.loaded || !state.visible || state.contextLost || state.moving
    || state.changingPosture || state.changingFacing || state.posture !== 'sitting' || !state.seatAnchor) return;
  const request = pendingSeat;
  pendingSeat = null;
  window.companion.submitSeatAnchor(request, state.seatAnchor);
}

function publishAvailability(): void {
  if (disposed || !avatar) return;
  const { contextLost, loaded, error } = avatar.diagnostics;
  window.companion.ready({
    ok: !contextLost && !loading && loaded,
    recovering: contextLost,
    error: error ?? (contextLost ? '描画の復旧を待っています。' : loading ? 'モデルを読み込んでいます。' : undefined),
  });
}

function onContextAvailabilityChanged(available: boolean): void {
  if (disposed) return;
  pendingCall = null;
  pendingSeat = null;
  if (!available) cancelMoveMode();
  // A replacement model may still be parsing. Keep native actions unavailable
  // until that load's current revision completes, even if the GPU returns first.
  if (!available || !loading) publishAvailability();
}

function reportError(error: unknown): void {
  pendingCall = null;
  pendingSeat = null;
  cancelMoveMode();
  const message = error instanceof Error ? error.message : 'モデルを表示できませんでした。';
  if (avatar) avatar.diagnostics.error = message;
  if (avatar) publishAvailability();
  else window.companion.ready({ ok: false, error: message });
}

async function reload(): Promise<void> {
  pendingCall = null;
  pendingSeat = null;
  const current = ++revision;
  loading = true;
  cancelMoveMode();
  avatar?.clear();
  publishAvailability();
  try {
    const buffer = await window.companion.getModel().catch(() => {
      // Electron's rejected-IPC wrapper is an implementation detail, not useful
      // recovery guidance in the tray or the small controls window.
      throw new Error('VRMを読めません。通知領域から選び直してください。');
    });
    if (disposed || current !== revision || !avatar) return;
    if (!buffer) {
      avatar.clear();
      reportError(new Error('トレイの「VRMを選ぶ…」からVRMを選んでください。'));
      return;
    }
    await avatar.load(buffer);
  } catch (error) {
    if (!disposed && current === revision) reportError(error);
  } finally {
    if (!disposed && current === revision) {
      loading = false;
      publishAvailability();
    }
  }
}

function updateVisibility(): void {
  if (!windowVisible) { pendingCall = null; pendingSeat = null; }
  if (!windowVisible || document.hidden) cancelMoveMode();
  avatar?.setVisible(windowVisible && !document.hidden);
  tryStartCall();
  trySeat();
}

function tryStartCall(): void {
  if (!pendingCall) return;
  if (disposed || pendingCall.revision !== revision || Date.now() > pendingCall.expires) {
    pendingCall = null;
    return;
  }
  // Native showInactive and document.visibilitychange can arrive separately.
  // Retain only one brief request until the page is ready to draw it.
  if (!windowVisible || document.hidden || moveActive || loading || !avatar?.diagnostics.loaded || avatar.diagnostics.contextLost) return;
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
  pendingSeat = null;
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
  avatar = new Avatar(canvas, onContextAvailabilityChanged, trySeat);
  window.__diagnostics = avatar.diagnostics;
  unsubscribers.push(window.companion.onVisibility(visible => {
    windowVisible = visible;
    updateVisibility();
  }));
  unsubscribers.push(window.companion.onModelChanged(() => { void reload(); }));
  unsubscribers.push(window.companion.onPosture(posture => {
    if (disposed || avatar?.diagnostics.posture === posture) return;
    pendingCall = null;
    pendingSeat = null;
    cancelMoveMode();
    avatar?.setPosture(posture);
  }));
  unsubscribers.push(window.companion.onPresence(state => {
    if (disposed || (avatar?.diagnostics.facing === state.facing && avatar?.diagnostics.quiet === state.quiet)) return;
    pendingCall = null;
    pendingSeat = null;
    cancelMoveMode();
    avatar?.setPresence(state.facing, state.quiet);
  }));
  unsubscribers.push(window.companion.onSeatRequest(request => {
    pendingSeat = request;
    if (request !== null) { pendingCall = null; trySeat(); }
  }));
  unsubscribers.push(window.companion.onCalled(expiresAt => {
    if (disposed || loading || !windowVisible || !avatar?.diagnostics.loaded || avatar.diagnostics.contextLost || !Number.isFinite(expiresAt)) return;
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
  pendingSeat = null;
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
