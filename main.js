// Electron entry point for Folio.
// It opens index.html in a desktop window. Your app code (app.js, style.css) is unchanged.
const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const fs = require('fs');
const path = require('path');
const { createSyncFolder } = require('./sync-folder');

// For testing: FOLIO_USER_DATA=/some/folder npm start runs Folio with separate,
// throwaway data instead of your real projects.
if (process.env.FOLIO_USER_DATA) app.setPath('userData', process.env.FOLIO_USER_DATA);

let mainWindow = null;
let isQuitting = false;
app.on('before-quit', () => { isQuitting = true; });

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

  // Before the window closes, let Folio finish saving to the synced folder.
  // Without this, quitting mid-save cut the save off and left a ".crswap" temp
  // file behind with the real project file never updated.
  let flushed = false;
  mainWindow.on('close', (event) => {
    if (flushed) return;
    event.preventDefault();
    const win = mainWindow;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      ipcMain.removeListener('folio-flushed', onFlushed);
      flushed = true;
      if (!win.isDestroyed()) win.close();
      if (isQuitting) app.quit();
    };
    const onFlushed = (e) => { if (e.sender === win.webContents) finish(); };
    ipcMain.on('folio-flushed', onFlushed);
    win.webContents.send('folio-flush-before-quit');
    setTimeout(finish, 5000); // never hang on quit if something goes wrong
  });

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

// ── Synced folder ───────────────────────────────────────────────
// app.js reaches the synced folder through these (see sync-folder.js).
// Failures are also written to sync.log in Folio's data folder for debugging.
let syncFolder = null;

function logSyncError(action, name, error) {
  try {
    fs.appendFileSync(path.join(app.getPath('userData'), 'sync.log'),
      `${new Date().toISOString()} ${action} ${name || ''}: ${error && error.message}\n`);
  } catch (e) { /* ignore */ }
}

function syncHandler(channel, action) {
  ipcMain.handle(channel, async (event, ...args) => {
    try {
      return await action(...args);
    } catch (error) {
      logSyncError(channel, args[0], error);
      throw error;
    }
  });
}

syncHandler('folio-sync:get-folder', () => syncFolder.getFolder());
syncHandler('folio-sync:clear-folder', () => { syncFolder.setFolder(null); });
syncHandler('folio-sync:list', () => syncFolder.list());
syncHandler('folio-sync:stat', name => syncFolder.stat(name));
syncHandler('folio-sync:read', name => syncFolder.read(name));
syncHandler('folio-sync:write', (name, text) => syncFolder.write(name, text));
syncHandler('folio-sync:remove', name => syncFolder.remove(name));
ipcMain.handle('folio-sync:choose-folder', async (event) => {
  const result = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender), {
    title: 'Choose the folder Folio saves your projects to',
    buttonLabel: 'Use This Folder',
    properties: ['openDirectory', 'createDirectory'],
    defaultPath: syncFolder.getFolder() || app.getPath('home'),
  });
  if (result.canceled || !result.filePaths[0]) return null;
  return syncFolder.setFolder(result.filePaths[0]);
});

app.whenReady().then(() => {
  syncFolder = createSyncFolder(path.join(app.getPath('userData'), 'sync-folder.json'));

  // When testing with `npm start`, show the Folio icon in the Dock too.
  // (The packaged Folio.app gets its icon from forge.config.js instead.)
  if (process.platform === 'darwin' && !app.isPackaged) {
    app.dock.setIcon(path.join(__dirname, 'icon', 'icon.png'));
  }
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
