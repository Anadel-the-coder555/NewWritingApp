// Runs before app.js. Replaces window.prompt(), which Electron doesn't support,
// with one that asks main.js to show a small input window.
const { ipcRenderer } = require('electron');

window.prompt = (message, defaultValue) =>
  ipcRenderer.sendSync('folio-prompt', message, defaultValue);

// Direct access to the synced folder (handled by sync-folder.js in main.js).
window.folioNative = {
  getSyncFolder: () => ipcRenderer.invoke('folio-sync:get-folder'),
  chooseSyncFolder: () => ipcRenderer.invoke('folio-sync:choose-folder'),
  clearSyncFolder: () => ipcRenderer.invoke('folio-sync:clear-folder'),
  list: () => ipcRenderer.invoke('folio-sync:list'),
  stat: name => ipcRenderer.invoke('folio-sync:stat', name),
  read: name => ipcRenderer.invoke('folio-sync:read', name),
  write: (name, text) => ipcRenderer.invoke('folio-sync:write', name, text),
  remove: name => ipcRenderer.invoke('folio-sync:remove', name),
};

// main.js asks for this before the window closes; app.js defines
// window.folioFlushBeforeQuit to finish any save to the synced folder.
ipcRenderer.on('folio-flush-before-quit', async () => {
  try {
    if (typeof window.folioFlushBeforeQuit === 'function') await window.folioFlushBeforeQuit();
  } finally {
    ipcRenderer.send('folio-flushed');
  }
});
