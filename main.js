// Electron entry point for Folio.
// It opens index.html in a desktop window. Your app code (app.js, style.css) is unchanged.
const { app, BrowserWindow, ipcMain, shell, dialog, nativeImage, net } = require('electron');
const os = require('os');
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const { createSyncFolder } = require('./sync-folder');

// For testing: FOLIO_USER_DATA=/some/folder npm start runs Folio with separate,
// throwaway data instead of your real projects.
if (process.env.FOLIO_USER_DATA) app.setPath('userData', process.env.FOLIO_USER_DATA);

// Only one Folio at a time. Two copies share the same storage folder, and the
// second can't open it: its covers come back empty and its saves write
// "cover: null" over the synced files. Opening Folio again just brings the
// existing window forward.
if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}
app.on('second-instance', () => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
});

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
    // On a Mac, hide the standard title bar and set the red/yellow/green
    // buttons into Folio's own top bar so the window reads as one surface.
    ...(process.platform === 'darwin' ? {
      titleBarStyle: 'hidden',
      trafficLightPosition: { x: 18, y: 19 },
    } : {}),
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

  // The top bar leaves room for the window buttons, except in full screen
  // where macOS hides them, so tell the page when that changes.
  const sendFullScreen = () => {
    if (!mainWindow.isDestroyed()) mainWindow.webContents.send('folio-window:fullscreen', mainWindow.isFullScreen());
  };
  mainWindow.on('enter-full-screen', sendFullScreen);
  mainWindow.on('leave-full-screen', sendFullScreen);
  mainWindow.webContents.on('did-finish-load', sendFullScreen);

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

// Focus Mode hides the top bar, so it hides the window buttons with it.
ipcMain.on('folio-window:buttons', (event, visible) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win && process.platform === 'darwin') win.setWindowButtonVisibility(!!visible);
});

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

/* Gemma, running in Ollama on this Mac. Folio only ever talks to Ollama at
   localhost, so nothing about the project leaves the computer. Calls go
   through here rather than the page so Ollama's browser-origin rules don't
   get in the way. */
const OLLAMA = 'http://127.0.0.1:11434';

async function ollama(pathname, body, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(OLLAMA + pathname, body
      ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: controller.signal }
      : { signal: controller.signal });
    const text = await res.text();
    if (!res.ok) {
      let message = text;
      try { message = JSON.parse(text).error || text; } catch (e) { /* plain text */ }
      return { error: `Ollama said: ${message}` };
    }
    return { data: JSON.parse(text) };
  } catch (error) {
    if (error.name === 'AbortError') return { error: 'Gemma took too long to answer.' };
    return { error: 'Folio could not reach Ollama. Is it running?', offline: true };
  } finally {
    clearTimeout(timer);
  }
}

ipcMain.handle('folio-gemma:models', async () => {
  const r = await ollama('/api/tags', null, 5000);
  if (r.error) return r;
  return { models: (r.data.models || []).map(m => ({
    name: m.name,
    tools: !m.capabilities || m.capabilities.includes('tools'),
    size: m.details && m.details.parameter_size,
  })) };
});

ipcMain.handle('folio-gemma:chat', async (event, request) => {
  const r = await ollama('/api/chat', {
    model: request.model,
    messages: request.messages,
    tools: request.tools,
    stream: false,
    think: false,
    options: { temperature: 0.2 },
  }, 240000);
  return r.error ? r : { message: r.data.message };
});

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

// ── Pictures the page can't open by itself ──────────────────────
// Covers and backgrounds try the browser's own decoder first. Anything it can't
// read (iPhone HEIC/HEIF photos, TIFF, some camera files) comes here and is
// converted to a JPEG with macOS's image tools.
function sipsToJpeg(inputPath) {
  return new Promise(resolve => {
    if (process.platform !== 'darwin') return resolve(null);
    const out = path.join(os.tmpdir(), `folio-image-${Date.now()}-${Math.random().toString(36).slice(2)}.jpg`);
    execFile('/usr/bin/sips', ['-s', 'format', 'jpeg', '-Z', '3000', inputPath, '--out', out], error => {
      if (error) return resolve(null);
      try {
        const data = fs.readFileSync(out);
        fs.unlinkSync(out);
        resolve(`data:image/jpeg;base64,${data.toString('base64')}`);
      } catch (e) { resolve(null); }
    });
  });
}

ipcMain.handle('folio-image:decode', async (event, source) => {
  if (!source) return null;
  let image = source.path ? nativeImage.createFromPath(source.path) : null;
  if ((!image || image.isEmpty()) && source.bytes) image = nativeImage.createFromBuffer(Buffer.from(source.bytes));
  if (image && !image.isEmpty()) {
    const { width, height } = image.getSize();
    if (Math.max(width, height) > 3000) image = image.resize(width >= height ? { width: 3000, quality: 'best' } : { height: 3000, quality: 'best' });
    return `data:image/jpeg;base64,${image.toJPEG(90).toString('base64')}`;
  }
  if (source.path) return sipsToJpeg(source.path);
  if (source.bytes) {
    const tmp = path.join(os.tmpdir(), `folio-image-in-${Date.now()}`);
    try {
      fs.writeFileSync(tmp, Buffer.from(source.bytes));
      return await sipsToJpeg(tmp);
    } finally {
      try { fs.unlinkSync(tmp); } catch (e) { /* ignore */ }
    }
  }
  return null;
});

// A picture dragged in from a web page arrives as a link; fetch it here, where
// the website's cross-origin rules don't block it.
ipcMain.handle('folio-image:fetch', async (event, url) => {
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return null;
  try {
    const response = await net.fetch(url);
    if (!response.ok) return null;
    const type = (response.headers.get('content-type') || '').split(';')[0].trim();
    const data = Buffer.from(await response.arrayBuffer());
    if (!data.length || data.length > 40 * 1024 * 1024) return null;
    return { type, bytes: data };
  } catch (e) {
    return null;
  }
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
