import { contextBridge, ipcRenderer } from 'electron';
contextBridge.exposeInMainWorld('companion', {
  getModel: () => ipcRenderer.invoke('model:read'),
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
