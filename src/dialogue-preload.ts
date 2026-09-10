import { contextBridge, ipcRenderer } from 'electron';

// This bridge deliberately exposes no avatar, filesystem or desktop operations.
contextBridge.exposeInMainWorld('dialogue', {
  getState: () => ipcRenderer.invoke('dialogue:state'),
  send: (text: string) => ipcRenderer.invoke('dialogue:send', text),
  cancel: () => ipcRenderer.invoke('dialogue:cancel'),
  clear: () => ipcRenderer.invoke('dialogue:clear'),
  close: () => ipcRenderer.invoke('dialogue:close'),
  onChanged: (callback: (snapshot: unknown) => void) => {
    const listener = (_event: unknown, snapshot: unknown) => callback(snapshot);
    ipcRenderer.on('dialogue:changed', listener);
    return () => ipcRenderer.removeListener('dialogue:changed', listener);
  },
});
