import { contextBridge, ipcRenderer } from 'electron';
contextBridge.exposeInMainWorld('companion', {
  getModel: () => ipcRenderer.invoke('model:read'),
  onMoveMode: (callback: (state: {active: boolean; revision: number}) => void) => {
    const listener = (_event: unknown, state: {active: boolean; revision: number}) => callback(state);
    ipcRenderer.on('avatar:move-mode', listener);
    return () => ipcRenderer.removeListener('avatar:move-mode', listener);
  },
  submitMoveShape: (revision: number, rects: Array<{x: number; y: number; width: number; height: number}>) => ipcRenderer.invoke('avatar:move-shape', revision, rects),
  movePointer: (revision: number, kind: 'start'|'move'|'end'|'cancel', point?: {x: number; y: number}) => ipcRenderer.send('avatar:move-pointer', revision, kind, point),
  ready: (state: {ok: boolean; error?: string}) => ipcRenderer.send('avatar:ready', state),
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
