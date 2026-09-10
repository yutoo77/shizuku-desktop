import { contextBridge, ipcRenderer } from 'electron';
contextBridge.exposeInMainWorld('companion', {
  onMouth: (callback: (state: {vowel: 'aa'|'ih'|'ou'|'ee'|'oh'|null; weight: number}) => void) => {
    const listener = (_event: unknown, state: {vowel?: unknown; weight?: unknown} | null) => {
      if (!state || typeof state.weight !== 'number' || !Number.isFinite(state.weight) || state.weight < 0 || state.weight > 1) return;
      const vowel = state.vowel;
      if (vowel !== null && vowel !== 'aa' && vowel !== 'ih' && vowel !== 'ou' && vowel !== 'ee' && vowel !== 'oh') return;
      callback({ vowel, weight: vowel === null ? 0 : state.weight });
    };
    ipcRenderer.on('avatar:mouth', listener);
    return () => ipcRenderer.removeListener('avatar:mouth', listener);
  },
  onPresence: (callback: (state: { facing: 'left' | 'right'; quiet: boolean }) => void) => {
    const listener = (_event: unknown, state: { facing?: unknown; quiet?: unknown } | null) => {
      if (state && (state.facing === 'left' || state.facing === 'right') && typeof state.quiet === 'boolean') callback({ facing: state.facing, quiet: state.quiet });
    };
    ipcRenderer.on('avatar:presence', listener);
    return () => ipcRenderer.removeListener('avatar:presence', listener);
  },
  onSeatRequest: (callback: (revision: number | null) => void) => {
    const listener = (_event: unknown, revision: unknown) => {
      if (revision === null || (typeof revision === 'number' && Number.isSafeInteger(revision) && revision >= 0)) callback(revision);
    };
    ipcRenderer.on('avatar:seat-request', listener);
    return () => ipcRenderer.removeListener('avatar:seat-request', listener);
  },
  submitSeatAnchor: (revision: number, point: { x: number; y: number }) => ipcRenderer.send('avatar:seat-anchor', revision, point),
  onPosture: (callback: (posture: 'standing' | 'sitting') => void) => {
    const listener = (_event: unknown, posture: unknown) => {
      if (posture === 'standing' || posture === 'sitting') callback(posture);
    };
    ipcRenderer.on('avatar:posture', listener);
    return () => ipcRenderer.removeListener('avatar:posture', listener);
  },
  getModel: () => ipcRenderer.invoke('model:read'),
  getTextureQuality: () => ipcRenderer.invoke('model:quality'),
  onCalled: (callback: (expiresAt: number) => void) => {
    const listener = (_event: unknown, expiresAt: number) => callback(expiresAt);
    ipcRenderer.on('avatar:called', listener);
    return () => ipcRenderer.removeListener('avatar:called', listener);
  },
  onMoveMode: (callback: (state: {active: boolean; revision: number}) => void) => {
    const listener = (_event: unknown, state: {active: boolean; revision: number}) => callback(state);
    ipcRenderer.on('avatar:move-mode', listener);
    return () => ipcRenderer.removeListener('avatar:move-mode', listener);
  },
  submitMoveShape: (revision: number, rects: Array<{x: number; y: number; width: number; height: number}>) => ipcRenderer.invoke('avatar:move-shape', revision, rects),
  onPointerPlacement: (callback: (active: boolean) => void) => {
    const listener = (_event: unknown, active: boolean) => callback(active);
    ipcRenderer.on('avatar:pointer-placement', listener);
    return () => ipcRenderer.removeListener('avatar:pointer-placement', listener);
  },
  movePointer: (revision: number, kind: 'start'|'move'|'end'|'cancel', point?: {x: number; y: number}) => ipcRenderer.send('avatar:move-pointer', revision, kind, point),
  ready: (state: {ok: boolean; error?: string; recovering?: boolean}) => ipcRenderer.send('avatar:ready', state),
  onVisibility: (callback: (visible: boolean) => void) => {
    const listener = (_event: unknown, visible: boolean) => callback(visible);
    ipcRenderer.on('avatar:visibility', listener);
    return () => ipcRenderer.removeListener('avatar:visibility', listener);
  },
  onModelChanged: (callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on('model:changed', listener);
    return () => ipcRenderer.removeListener('model:changed', listener);
  },
  onStatusChanged: (callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on('controls:changed', listener);
    return () => ipcRenderer.removeListener('controls:changed', listener);
  },
  action: (action: string) => ipcRenderer.invoke('controls:action', action),
  getStatus: () => ipcRenderer.invoke('controls:status'),
});
