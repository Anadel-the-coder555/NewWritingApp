// Runs before app.js. Replaces window.prompt(), which Electron doesn't support,
// with one that asks main.js to show a small input window.
const { ipcRenderer } = require('electron');

window.prompt = (message, defaultValue) =>
  ipcRenderer.sendSync('folio-prompt', message, defaultValue);
