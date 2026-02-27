const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  getConfig: () => ipcRenderer.invoke('get-config'),
  saveConfig: (config) => ipcRenderer.invoke('save-config', config),
  toggleBot: () => ipcRenderer.invoke('toggle-bot'),
  getBotStatus: () => ipcRenderer.invoke('get-bot-status'),
  onBotLog: (callback) => ipcRenderer.on('bot-log', callback),
  onBotStatus: (callback) => ipcRenderer.on('bot-status', callback)
});
