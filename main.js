// Electron entry point for Folio.
// It opens index.html in a desktop window. Your app code (app.js, style.css) is unchanged.
const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 700,
    minHeight: 500,
    title: 'Folio',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      // The page only loads your own local files, so it is safe to let preload.js
      // replace window.prompt() (which Electron does not support) directly.
      contextIsolation: false,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));

  // Any web link opens in your normal browser instead of inside Folio.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

// ── prompt() stand-in ───────────────────────────────────────────
// Electron has no built-in prompt(), so app.js calls like prompt('Project name')
// would silently return nothing. preload.js routes them here and we show a small
// input window instead.
ipcMain.on('folio-prompt', (event, message, defaultValue) => {
  const parent = BrowserWindow.fromWebContents(event.sender);
  const win = new BrowserWindow({
    parent,
    modal: true,
    width: 420,
    height: 170,
    resizable: false,
    minimizable: false,
    maximizable: false,
    show: false,
    title: 'Folio',
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  });

  let answered = false;
  const reply = (value) => {
    if (answered) return;
    answered = true;
    event.returnValue = value;
  };

  const onAnswer = (e, value) => {
    if (e.sender !== win.webContents) return;
    reply(value);
    if (!win.isDestroyed()) win.close();
  };
  ipcMain.on('folio-prompt-answer', onAnswer);

  win.on('closed', () => {
    ipcMain.removeListener('folio-prompt-answer', onAnswer);
    reply(null); // closing the box counts as Cancel
  });

  win.loadFile(path.join(__dirname, 'prompt.html'), {
    query: { message: String(message ?? ''), value: String(defaultValue ?? '') },
  });
  win.once('ready-to-show', () => win.show());
});

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
