import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';

export interface ChatEvent {
  type: 'note' | 'tool' | 'assistant';
  content?: string;
  name?: string;
  detail?: string;
  ok?: boolean;
  output?: string;
}

let chatHandler: ((event: ChatEvent) => void) | null = null;

ipcRenderer.on('chat:event', (_event: IpcRendererEvent, payload: ChatEvent) => {
  chatHandler?.(payload);
});

contextBridge.exposeInMainWorld('ghost', {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (settings: { apiKey?: string; model?: string }) =>
    ipcRenderer.invoke('settings:set', settings),
  clearKey: () => ipcRenderer.invoke('settings:clear-key'),
  listModels: () => ipcRenderer.invoke('models:list'),
  reflect: () => ipcRenderer.invoke('harness:reflect'),
  propose: () => ipcRenderer.invoke('harness:propose'),
  status: () => ipcRenderer.invoke('harness:status'),
  sendChat: (text: string) => ipcRenderer.invoke('chat:send', text),
  clearChat: () => ipcRenderer.invoke('chat:clear'),
  openKeyPage: () => ipcRenderer.invoke('app:open-key-page'),
  setChatHandler: (callback: (event: ChatEvent) => void) => {
    chatHandler = callback;
  },
});
