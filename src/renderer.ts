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
const unsubscribers: Array<() => void> = [];

function reportError(error: unknown): void {
  const message = error instanceof Error ? error.message : 'モデルを表示できませんでした。';
  if (avatar) avatar.diagnostics.error = message;
  window.companion.ready({ ok: false, error: message });
}

async function reload(): Promise<void> {
  const current = ++revision;
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
  avatar?.setVisible(windowVisible && !document.hidden);
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
  document.addEventListener('visibilitychange', updateVisibility);
  updateVisibility();
  void reload();
} catch (error) {
  reportError(error);
}

window.addEventListener('beforeunload', () => {
  disposed = true;
  revision += 1;
  for (const unsubscribe of unsubscribers) unsubscribe();
  document.removeEventListener('visibilitychange', updateVisibility);
  avatar?.dispose();
}, { once: true });
