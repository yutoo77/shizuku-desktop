import { contextBridge, ipcRenderer } from 'electron';

// This bridge deliberately exposes no avatar, filesystem or desktop operations.
contextBridge.exposeInMainWorld('dialogue', {
  getState: () => ipcRenderer.invoke('dialogue:state'),
  send: (text: string) => ipcRenderer.invoke('dialogue:send', text),
  setProvider: (provider: 'local-demo' | 'openai') => ipcRenderer.invoke('dialogue:provider', provider),
  setVoice: (enabled: boolean) => ipcRenderer.invoke('dialogue:voice', enabled),
  stopVoice: () => ipcRenderer.invoke('dialogue:voice-stop'),
  reportVoice: (id: number, state: string) => ipcRenderer.invoke('dialogue:voice-state', id, state),
  mouth: (id: number, vowel: string | null, weight: number) => ipcRenderer.invoke('dialogue:mouth', id, vowel, weight),
  onSpeech: (callback: (packet: unknown) => void) => {
    const listener = (_event: unknown, packet: unknown) => callback(packet);
    ipcRenderer.on('dialogue:speech', listener);
    return () => ipcRenderer.removeListener('dialogue:speech', listener);
  },
  onSpeechStop: (callback: (id: number) => void) => {
    const listener = (_event: unknown, id: number) => callback(id);
    ipcRenderer.on('dialogue:speech-stop', listener);
    return () => ipcRenderer.removeListener('dialogue:speech-stop', listener);
  },
  cancel: () => ipcRenderer.invoke('dialogue:cancel'),
  clear: () => ipcRenderer.invoke('dialogue:clear'),
  close: () => ipcRenderer.invoke('dialogue:close'),
  onChanged: (callback: (snapshot: unknown) => void) => {
    const listener = (_event: unknown, snapshot: unknown) => callback(snapshot);
    ipcRenderer.on('dialogue:changed', listener);
    return () => ipcRenderer.removeListener('dialogue:changed', listener);
  },
});
