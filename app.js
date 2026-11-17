/* ── State ── */
let docs = [
  {
    id: 1,
    title: 'Untitled',
    storyDate: '',
    banner: '',
    content: '',
    synopsis: '',
    status: 'draft',
    target: 0,
    tags: [],
    parent: null,
    isFolder: false,
    section: 'manuscript',
    createdAt: new Date()
  }
];

let nextId      = 2;
let activeId    = 1;
let ctxTargetId = null;
let currentMode = 'editor';
let saveTimer   = null;
let typewriterMode = false;
let proofingMode = false;
let splitMode = false;
let marginMode = false;
let splitReferenceId = null;
let commandIndex = 0;
let currentCommands = [];
let sessionBaseWords = 0;
let currentProjectId = 'default';

const STATUS_COLORS = { draft: '#879181', revision: '#5f7355', final: '#1c211a' };
const DEFAULT_FONT  = "'Playfair Display', serif";

/* ────────────────────────────────────────
   Local Storage Persistence
──────────────────────────────────────── */
const STORAGE_KEY = 'folio-project';
const EDITOR_ZOOM_KEY = 'folio-editor-zoom';
const BOOK_ZOOM_KEY = 'folio-book-zoom';
let persistTimer = null;

let editorZoom = 100;
let bookZoom = 100;

function setEditorZoom(value, persist = true) {
  editorZoom = Math.max(60, Math.min(160, Math.round(value / 10) * 10));
  const page = document.getElementById('editor-wrap');
  const readout = document.getElementById('editor-zoom-reset');
  if (page) page.style.zoom = `${editorZoom}%`;
  if (readout) {
    readout.textContent = `${editorZoom}%`;
    readout.setAttribute('aria-label', `Reset editor zoom to 100%. Current zoom ${editorZoom}%`);
  }
  const zoomOut = document.getElementById('editor-zoom-out');
  const zoomIn = document.getElementById('editor-zoom-in');
  if (zoomOut) zoomOut.disabled = editorZoom <= 60;
  if (zoomIn) zoomIn.disabled = editorZoom >= 160;
  if (persist) saveAppearance({ editorZoom }); // per project, like the page width
}

function setBookZoom(value, persist = true) {
  bookZoom = Math.max(60, Math.min(140, Math.round(value / 10) * 10));
  const bookWrap = document.getElementById('book-wrap');
  const readout = document.getElementById('book-zoom-reset');
  if (bookWrap) bookWrap.style.zoom = `${bookZoom}%`;
  if (readout) {
    readout.textContent = `${bookZoom}%`;
    readout.setAttribute('aria-label', `Reset book zoom to 100%. Current zoom ${bookZoom}%`);
  }
  const zoomOut = document.getElementById('book-zoom-out');
  const zoomIn = document.getElementById('book-zoom-in');
  if (zoomOut) zoomOut.disabled = bookZoom <= 60;
  if (zoomIn) zoomIn.disabled = bookZoom >= 140;
  if (persist) saveAppearance({ bookZoom }); // per project, like the editor zoom
}

/* ── Book storage ──
   Your books (the open one, STORAGE_KEY, and the whole shelf, 'folio-projects') live
   in IndexedDB, which holds hundreds of megabytes, not localStorage, which is capped
   near 10 MB for the whole app. Folio keeps a copy in memory so reading is instant;
   every change is also written to disk straight away, in the order it was made.
   The first time this version runs, the books are copied over from localStorage,
   and the localStorage copy is kept up to date as a fallback for as long as the
   books fit there. If IndexedDB can't be opened at all, Folio carries on with
   localStorage as before. */
const BOOK_KEYS = [STORAGE_KEY, 'folio-projects'];
const BOOK_MIGRATED = 'copied-from-local-storage';
const bookCache = new Map();
const bookPendingWrites = new Map(); // key → latest value not yet on disk
let bookDb = null;                   // null means: fall back to localStorage
let bookFlushing = null;             // the running write loop, if any

function openBookDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('folio-books', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('kv');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('Book storage is blocked'));
  });
}

function bookDbRequest(db, mode, operation) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('kv', mode, { durability: 'strict' }); // on disk before we call it saved
    const result = operation(tx.objectStore('kv'));
    tx.oncomplete = () => resolve(result && result.result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('Save was cancelled'));
  });
}

async function loadBookStore() {
  try {
    const db = await openBookDb();
    const read = key => bookDbRequest(db, 'readonly', store => store.get(key));
    if (!(await read(BOOK_MIGRATED))) {
      // First run with the bigger storage: copy the books across, then mark it done.
      await bookDbRequest(db, 'readwrite', store => {
        BOOK_KEYS.forEach(key => {
          const value = localStorage.getItem(key);
          if (value != null) store.put(value, key);
        });
        store.put(new Date().toISOString(), BOOK_MIGRATED);
      });
    }
    for (const key of BOOK_KEYS) {
      const value = await read(key);
      if (value != null) bookCache.set(key, value);
    }
    bookDb = db;
  } catch (e) {
    console.error('Could not open book storage; using the smaller fallback storage', e);
    bookDb = null;
    bookCache.clear();
    BOOK_KEYS.forEach(key => { try { const v = localStorage.getItem(key); if (v != null) bookCache.set(key, v); } catch (err) { /* unreadable */ } });
  }
}

function bookGet(key) {
  return bookCache.has(key) ? bookCache.get(key) : null;
}

/* Saves a book value. Never throws: success or failure shows in the top bar. */
function bookSet(key, value) {
  bookCache.set(key, value);
  if (!bookDb) {
    try { localStorage.setItem(key, value); reportSave('local', true); }
    catch (e) { console.error('Could not save to storage', e); reportSave('local', false); }
    return;
  }
  // Also keep the small localStorage copy current while the books still fit there, so
  // the fallback is never an old version. Once they outgrow it, drop that copy rather
  // than leave a stale one behind; the real copy is the one in IndexedDB.
  try { localStorage.setItem(key, value); } catch (e) { try { localStorage.removeItem(key); } catch (err) { /* ignore */ } }
  bookPendingWrites.set(key, value);
  if (!bookFlushing) bookFlushing = flushBookWrites().finally(() => { bookFlushing = null; });
}

async function flushBookWrites() {
  while (bookPendingWrites.size) {
    const batch = [...bookPendingWrites];
    bookPendingWrites.clear();
    try {
      await bookDbRequest(bookDb, 'readwrite', store => batch.forEach(([key, value]) => store.put(value, key)));
      if (!bookPendingWrites.size) reportSave('local', true);
    } catch (e) {
      console.error('Could not save to book storage', e);
      // Keep the unsaved values queued (newer ones win) and try again shortly.
      batch.forEach(([key, value]) => { if (!bookPendingWrites.has(key)) bookPendingWrites.set(key, value); });
      reportSave('local', false);
      await new Promise(resolve => setTimeout(resolve, 3000));
    }
  }
}

/* Resolves once everything saved so far is on disk (or has failed and been reported). */
async function bookStoreSettled() {
  for (let tries = 0; bookFlushing && tries < 3; tries++) await Promise.race([bookFlushing, new Promise(r => setTimeout(r, 1500))]);
}

function persistState() {
  bookSet(STORAGE_KEY, JSON.stringify({
    docs, nextId, activeId, currentProjectId,
    projectTitle: document.getElementById('project-title-input').value,
    preferences: { typewriterMode, proofingMode, splitMode, marginMode, splitReferenceId }
  }));
  if (syncFolderHandle) scheduleAutoSync(); // keep the synced-folder copy fresh so Claude reads what you just wrote
  scheduleBackup();
}

/* ── Save status ──
   Every save reports here, so a failed save is never silent: the top bar says
   "Saved", "Saving…" or "Not saved", and a failure explains itself once in a
   message that stays until it's dismissed. 'local' is Folio's own storage on this
   Mac; 'folder' is the copy in the synced folder (Dropbox). */
const saveHealth = { local: true, folder: true, folderBlocked: false };
let savePending = false;
let saveWarningShown = { local: false, folder: false };

function reportSave(where, ok) {
  saveHealth[where] = ok;
  if (where === 'local') savePending = false;
  if (where === 'folder' && ok) saveHealth.folderBlocked = false;
  if (ok) saveWarningShown[where] = false;
  else if (!saveWarningShown[where]) { saveWarningShown[where] = true; showSaveProblem(); }
  // Once saving works again, the warning has done its job: take it down.
  if (saveHealth.local && saveHealth.folder) hideFolioToast('save');
  renderSaveStatus();
}

/* macOS refuses access to the synced folder (it can, after Folio is rebuilt or
   updated, until the folder is chosen again). Saving there can't recover on its own. */
function isFolderBlockedError(e) {
  return /EPERM|EACCES|operation not permitted|permission denied/i.test(String(e && (e.message || e)));
}

function reportFolderBlocked() {
  if (!saveHealth.folderBlocked) {
    saveHealth.folderBlocked = true;
    saveWarningShown.folder = false; // the advice is different now, so show it
  }
  updateSyncFolderUI(true); // shows the Reconnect button
  reportSave('folder', false);
}

function saveProblemMessage() {
  if (!saveHealth.local) {
    return syncFolderHandle && saveHealth.folder
      ? "Folio couldn't save your latest changes on this Mac (it will keep trying). Your synced-folder copy is still being updated. If this keeps happening, check your Mac has free disk space."
      : "Folio couldn't save your latest changes (it will keep trying). Keep this window open and export your book from the Projects screen now, and check your Mac has free disk space.";
  }
  if (!saveHealth.folder && saveHealth.folderBlocked) return "Your Mac is blocking Folio from your synced folder. This can happen after Folio is updated. Your writing is still saved on this Mac. To fix it, open Projects, click Reconnect, then click Use This Folder.";
  if (!saveHealth.folder) return "Folio couldn't update your book's copy in the synced folder. Your writing is still saved on this Mac. Check that Dropbox is running and the folder still exists, or click Reconnect on the Projects screen.";
  return '';
}

function showSaveProblem() {
  const message = saveProblemMessage();
  if (message) showFolioToast(message, { sticky: true, warning: true, kind: 'save' });
}

function renderSaveStatus() {
  const el = document.getElementById('save-status');
  if (!el) return;
  let text = 'Saved', state = 'ok', title = syncFolderHandle ? 'Saved on this Mac and in your synced folder' : 'Saved on this Mac';
  if (!saveHealth.local) { text = 'Not saved'; state = 'error'; title = saveProblemMessage(); }
  else if (savePending) { text = 'Saving…'; state = 'pending'; title = 'Saving your latest changes'; }
  else if (syncFolderHandle && !saveHealth.folder) { text = 'Saved · folder copy failed'; state = 'warn'; title = saveProblemMessage(); }
  el.textContent = text;
  el.dataset.state = state;
  el.title = title;
}

function schedulePersist() {
  savePending = true;
  renderSaveStatus();
  clearTimeout(persistTimer);
  persistTimer = setTimeout(persistState, 300);
}

function loadPersistedState() {
  let raw;
  try {
    raw = bookGet(STORAGE_KEY);
  } catch (e) {
    return false;
  }
  if (!raw) return false;
  try {
    const data = JSON.parse(raw);
    if (!Array.isArray(data.docs) || !data.docs.length) return false;
    docs = data.docs.map(d => ({ ...d, createdAt: d.createdAt ? new Date(d.createdAt) : new Date() }));
    nextId = typeof data.nextId === 'number' ? data.nextId : Math.max(...docs.map(d => d.id)) + 1;
    activeId = docs.some(d => d.id === data.activeId) ? data.activeId : docs[0].id;
    currentProjectId = data.currentProjectId || 'default';
    if (data.projectTitle) document.getElementById('project-title-input').value = data.projectTitle;
    typewriterMode = Boolean(data.preferences && data.preferences.typewriterMode);
    proofingMode = Boolean(data.preferences && data.preferences.proofingMode);
    splitMode = Boolean(data.preferences && data.preferences.splitMode);
    marginMode = Boolean(data.preferences && data.preferences.marginMode);
    splitReferenceId = data.preferences && data.preferences.splitReferenceId;
    return true;
  } catch (e) {
    console.error('Could not load saved project', e);
    return false;
  }
}

/* ────────────────────────────────────────
   Init
──────────────────────────────────────── */
/* ── Appearance (per project) ──
   Light/dark, palette, favorite accent, page texture and the background image all
   belong to the project that's open: each novel keeps its own look. A project with
   nothing saved yet uses the defaults (Sage, light, smooth, no background). */
const APPEARANCE_PREFIX = 'folio-appearance:';
const APPEARANCE_MIGRATED_KEY = 'folio-appearance-per-project';
const APPEARANCE_DEFAULTS = { mode: 'light', theme: 'sage', paletteColor: '', accent: '', texture: 'none', pageWidth: 740, pageOpacity: null, editorZoom: 100, bookZoom: 100 };
// Before appearance was per project it lived in these app-wide keys; read once to migrate.
const LEGACY_APPEARANCE_KEYS = { theme: 'folio-theme-mode', accent: 'folio-accent-color', paletteColor: 'folio-palette-color', mode: 'folio-color-mode', texture: 'folio-page-texture' };
const PALETTE_ACCENTS = { sage: '#5f7355', slate: '#4a6fa5', sepia: '#a1662f', rose: '#a24a68', ocean: '#1f7a8c', midnight: '#6fa8dc' };
let appearance = { ...APPEARANCE_DEFAULTS };
let currentPalette = 'sage';
let colorMode = 'light';

function readAppearance(id) {
  try {
    const raw = localStorage.getItem(APPEARANCE_PREFIX + id);
    return raw ? { ...APPEARANCE_DEFAULTS, ...JSON.parse(raw) } : null;
  } catch (e) { return null; }
}

function writeAppearance(id, value) {
  try { localStorage.setItem(APPEARANCE_PREFIX + id, JSON.stringify(value)); } catch (e) { /* ignore */ }
}

function saveAppearance(patch) {
  Object.assign(appearance, patch);
  writeAppearance(currentProjectId, appearance);
}

function updateActiveSwatch(themeId) {
  document.querySelectorAll('.theme-swatch[data-theme]').forEach(btn => btn.classList.toggle('active', btn.dataset.theme === themeId));
  const customSwatch = document.getElementById('custom-theme-swatch');
  if (customSwatch) customSwatch.classList.toggle('active', themeId === 'custom');
}

function applyTexture(id, persist = true) {
  const texture = id && id !== 'none' ? id : '';
  if (texture) document.documentElement.setAttribute('data-texture', texture);
  else document.documentElement.removeAttribute('data-texture');
  if (persist) saveAppearance({ texture: texture || 'none' });
  document.querySelectorAll('.texture-swatch[data-texture]').forEach(btn => btn.classList.toggle('active', btn.dataset.texture === (texture || 'none')));
}

/* Generates a full coordinated scheme (bg/surface/text/chrome/borders/…) from one seed hue,
   in either a light (paper) or dark (ink) register. */
function generateScheme(hex, dark) {
  const root = document.documentElement.style;
  const mix = (pct, base) => `color-mix(in srgb, ${hex} ${pct}%, ${base})`;
  if (!dark) {
    root.setProperty('--color-bg', mix(12, 'white'));
    root.setProperty('--color-surface', mix(5, 'white'));
    root.setProperty('--surface', mix(5, 'white'));
    root.setProperty('--color-text', mix(24, 'black'));
    root.setProperty('--chrome', mix(18, 'white'));
    root.setProperty('--toolbar', mix(8, 'white'));
    root.setProperty('--surface2', mix(24, 'white'));
    root.setProperty('--border', mix(32, 'white'));
    root.setProperty('--border-light', mix(20, 'white'));
    root.setProperty('--annotation', mix(55, 'white'));
    root.setProperty('--current-line', mix(32, 'white'));
  } else {
    root.setProperty('--color-bg', mix(14, '#1b1f24'));
    root.setProperty('--color-surface', mix(18, '#242a31'));
    root.setProperty('--surface', mix(18, '#242a31'));
    root.setProperty('--color-text', mix(18, 'white'));
    root.setProperty('--chrome', mix(12, '#20262d'));
    root.setProperty('--toolbar', mix(18, '#242a31'));
    root.setProperty('--surface2', mix(28, '#2a313a'));
    root.setProperty('--border', mix(22, '#333b44'));
    root.setProperty('--border-light', mix(28, '#3a424d'));
    root.setProperty('--annotation', mix(70, 'black'));
    root.setProperty('--current-line', mix(55, 'black'));
  }
  root.setProperty('--color-neutral-600', 'color-mix(in srgb, var(--color-text) 46%, var(--color-bg))');
  root.setProperty('--color-neutral-700', 'color-mix(in srgb, var(--color-text) 62%, var(--color-bg))');
  root.setProperty('--color-neutral-900', 'color-mix(in srgb, var(--color-text) 92%, var(--color-bg))');
}

function applyAccentColor(hex, persist = true, dark = colorMode === 'dark') {
  const root = document.documentElement.style;
  if (!hex) {
    ['--color-accent', '--color-accent-100', '--color-accent-200', '--color-accent-400', '--color-accent-600', '--color-accent-700', '--color-accent-800'].forEach(p => root.removeProperty(p));
    if (persist) saveAppearance({ accent: '' });
  } else {
    const toward = (c, pct) => `color-mix(in srgb, ${hex} ${pct}%, ${c})`;
    root.setProperty('--color-accent', hex);
    root.setProperty('--color-accent-100', dark ? toward('black', 30) : toward('white', 22));
    root.setProperty('--color-accent-200', dark ? toward('black', 45) : toward('white', 38));
    root.setProperty('--color-accent-400', dark ? toward('black', 65) : toward('white', 70));
    root.setProperty('--color-accent-600', hex);
    root.setProperty('--color-accent-700', dark ? toward('white', 65) : toward('black', 78));
    root.setProperty('--color-accent-800', dark ? toward('white', 80) : toward('black', 62));
    if (persist) saveAppearance({ accent: hex });
  }
  const shownPalette = document.documentElement.getAttribute('data-theme') || currentPalette;
  const shown = hex || (shownPalette === 'custom' ? appearance.paletteColor : PALETTE_ACCENTS[shownPalette]) || PALETTE_ACCENTS.sage;
  const swatch = document.querySelector('.accent-color-swatch');
  const picker = document.getElementById('accent-color-picker');
  if (swatch) swatch.style.background = shown;
  if (picker) picker.value = shown;
}

/* Re-renders whatever palette is currently selected using the current light/dark mode. */
function refreshPalette() {
  // A background set to "match palette" borrows a palette without changing the saved one.
  const palette = (bgActive && bgSettings.match && bgSettings.palette) || currentPalette;
  const hex = palette === 'custom' ? (appearance.paletteColor || '#8a5fd6') : (PALETTE_ACCENTS[palette] || PALETTE_ACCENTS.sage);
  generateScheme(hex, colorMode === 'dark');
  document.documentElement.setAttribute('data-theme', palette);
  updateActiveSwatch(palette);
  applyAccentColor(appearance.accent || null, false);
}

/* Picking a palette by hand while a background is matching means "use this one instead". */
function stopBackgroundMatch() {
  if (!bgActive || !bgSettings.match) return;
  bgSettings.match = false;
  saveBackgroundSettings();
  syncBackgroundUI();
}

function applyTheme(id) {
  stopBackgroundMatch();
  currentPalette = (id && PALETTE_ACCENTS[id]) ? id : 'sage';
  saveAppearance({ theme: currentPalette });
  refreshPalette();
}

function showCustomPaletteColor(hex) {
  const dot = document.getElementById('custom-swatch-dot');
  const picker = document.getElementById('custom-theme-picker');
  if (dot) dot.style.background = hex || '';
  if (picker) picker.value = hex || '#8a5fd6';
}

function applyCustomPalette(hex) {
  stopBackgroundMatch();
  currentPalette = 'custom';
  saveAppearance({ theme: 'custom', paletteColor: hex });
  showCustomPaletteColor(hex);
  refreshPalette();
}

function setColorMode(mode) {
  colorMode = mode === 'dark' ? 'dark' : 'light';
  saveAppearance({ mode: colorMode });
  document.querySelectorAll('.mode-btn').forEach(btn => btn.classList.toggle('active', btn.dataset.mode === colorMode));
  refreshPalette();
}

/* Shows the open project's saved look (or the defaults) without saving anything. */
function loadProjectAppearance() {
  appearance = readAppearance(currentProjectId) || { ...APPEARANCE_DEFAULTS };
  colorMode = appearance.mode === 'dark' ? 'dark' : 'light';
  document.querySelectorAll('.mode-btn').forEach(btn => btn.classList.toggle('active', btn.dataset.mode === colorMode));
  showCustomPaletteColor(appearance.paletteColor);
  currentPalette = appearance.theme === 'custom' && appearance.paletteColor ? 'custom' : (PALETTE_ACCENTS[appearance.theme] ? appearance.theme : 'sage');
  applyTexture(appearance.texture, false);
  refreshPalette();
  applyPageLayout();
  setEditorZoom(Number(appearance.editorZoom) || 100, false);
  setBookZoom(Number(appearance.bookZoom) || 100, false);
}

/* Page width and opacity (per project). Opacity left unset means "automatic":
   a solid page normally, or the softer glass look over a background picture. */
function effectivePageOpacity() {
  if (appearance.pageOpacity != null) return appearance.pageOpacity;
  return bgActive ? bgSettings.clarity : 100;
}

function applyPageLayout() {
  const root = document.documentElement.style;
  const width = Number(appearance.pageWidth) || APPEARANCE_DEFAULTS.pageWidth;
  const opacity = effectivePageOpacity();
  root.setProperty('--page-width', `${width}px`);
  root.setProperty('--page-opacity', `${opacity}%`);
  const w = document.getElementById('page-width');
  if (!w) return;
  w.value = width;
  document.getElementById('page-width-out').textContent = width;
  document.getElementById('page-opacity').value = opacity;
  document.getElementById('page-opacity-out').textContent = `${opacity}%`;
}

function bindPageControls() {
  document.getElementById('page-width').addEventListener('input', e => {
    saveAppearance({ pageWidth: Number(e.target.value) });
    applyPageLayout();
  });
  document.getElementById('page-opacity').addEventListener('input', e => {
    saveAppearance({ pageOpacity: Number(e.target.value) });
    applyPageLayout();
  });
  document.getElementById('page-reset-btn').addEventListener('click', () => {
    saveAppearance({ pageWidth: APPEARANCE_DEFAULTS.pageWidth, pageOpacity: null });
    applyPageLayout();
  });
}

/* Call whenever a different project becomes the open one. */
function applyProjectAppearance() {
  loadProjectAppearance();
  loadProjectBackground();
}

/* Moves a project's look to a new id (used when the first project's 'default' id is replaced). */
function moveProjectAppearance(fromId, toId) {
  const saved = localStorage.getItem(APPEARANCE_PREFIX + fromId);
  if (saved) { localStorage.setItem(APPEARANCE_PREFIX + toId, saved); localStorage.removeItem(APPEARANCE_PREFIX + fromId); }
  const bg = localStorage.getItem(BG_SETTINGS_PREFIX + fromId);
  if (bg) { localStorage.setItem(BG_SETTINGS_PREFIX + toId, bg); localStorage.removeItem(BG_SETTINGS_PREFIX + fromId); }
  backgroundStore('get', bgKey(fromId)).then(blob => {
    if (!blob) return;
    return backgroundStore('put', bgKey(toId), blob).then(() => backgroundStore('delete', bgKey(fromId)));
  }).catch(() => { /* nothing to move */ });
}

function forgetProjectAppearance(id) {
  localStorage.removeItem(APPEARANCE_PREFIX + id);
  localStorage.removeItem(BG_SETTINGS_PREFIX + id);
  backgroundStore('delete', bgKey(id)).catch(() => { /* none saved */ });
}

/* One-time move from the old app-wide look to per-project looks: every existing
   project keeps the look it had, and the background goes to the project that was
   open when it was chosen. */
async function migrateAppearanceToProjects() {
  if (localStorage.getItem(APPEARANCE_MIGRATED_KEY)) return;
  const legacy = { ...APPEARANCE_DEFAULTS };
  Object.entries(LEGACY_APPEARANCE_KEYS).forEach(([field, key]) => {
    const value = localStorage.getItem(key);
    if (value) legacy[field] = value;
  });
  legacy.editorZoom = Number(localStorage.getItem(EDITOR_ZOOM_KEY)) || 100;
  legacy.bookZoom = Number(localStorage.getItem(BOOK_ZOOM_KEY)) || 100;
  const ids = new Set(projectArchive().map(p => p.id));
  ids.add(currentProjectId);
  ids.forEach(id => { if (!readAppearance(id)) writeAppearance(id, legacy); });

  const legacyBgSettings = localStorage.getItem('folio-background');
  try {
    const blob = await backgroundStore('get', 'background');
    if (blob && !(await backgroundStore('get', bgKey(currentProjectId)))) {
      await backgroundStore('put', bgKey(currentProjectId), blob);
      if (legacyBgSettings) localStorage.setItem(BG_SETTINGS_PREFIX + currentProjectId, legacyBgSettings);
    }
    if (blob) await backgroundStore('delete', 'background');
  } catch (e) { /* no old background */ }
  localStorage.removeItem('folio-background');
  Object.values(LEGACY_APPEARANCE_KEYS).forEach(key => localStorage.removeItem(key));
  localStorage.setItem(APPEARANCE_MIGRATED_KEY, '1');
}

/* Editor and book zoom used to be app-wide settings, so zooming one novel zoomed every
   novel. They now live with each project's look; existing projects keep the zoom they had. */
function migrateZoomToProjects() {
  [['editorZoom', EDITOR_ZOOM_KEY], ['bookZoom', BOOK_ZOOM_KEY]].forEach(([field, key]) => {
    const legacy = Number(localStorage.getItem(key));
    if (!legacy) return;
    const ids = new Set(projectArchive().map(p => p.id));
    ids.add(currentProjectId);
    ids.forEach(id => {
      let raw = null;
      try { raw = JSON.parse(localStorage.getItem(APPEARANCE_PREFIX + id) || 'null'); } catch (e) { /* unreadable */ }
      if (raw && raw[field] != null) return;
      writeAppearance(id, { ...APPEARANCE_DEFAULTS, ...(raw || {}), [field]: legacy });
    });
    localStorage.removeItem(key);
  });
}

/* ── Opening pictures ──
   Covers and backgrounds share this. It doesn't trust a file's type label: it tries
   the browser's decoder, then an <img>, then (in the desktop app) macOS's own image
   tools, so HEIC photos from an iPhone, TIFF, BMP, GIF, SVG and mislabeled files work. */
const IMAGE_NAME = /\.(png|jpe?g|jfif|pjpeg|webp|avif|gif|bmp|tiff?|heic|heif|svg|ico)$/i;
const IMAGE_ACCEPT = 'image/*,.heic,.heif,.tif,.tiff,.jfif,.avif,.webp';

function looksLikeImageFile(file) {
  return !!file && (file.type.startsWith('image/') || IMAGE_NAME.test(file.name) || (!file.type && !/\.(folio|json|txt|md|pdf|docx?)$/i.test(file.name)));
}

function loadImageElement(src, revokeAfter) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    const done = () => { if (revokeAfter) URL.revokeObjectURL(src); };
    image.onload = () => { done(); resolve(image); };
    image.onerror = () => { done(); reject(new Error('Could not decode image')); };
    image.src = src;
  });
}

async function decodeImageFile(file) {
  try { return await createImageBitmap(file); } catch (e) { /* try the next way */ }
  try { return await loadImageElement(URL.createObjectURL(file), true); } catch (e) { /* try the next way */ }
  if (window.folioImages) {
    const dataUrl = await window.folioImages.decode(file);
    if (dataUrl) return loadImageElement(dataUrl, false);
  }
  throw new Error('Unsupported image');
}

function imageSize(source) {
  const width = source.naturalWidth || source.width || 1200;
  const height = source.naturalHeight || source.height || 1200;
  return { width, height };
}

/* Draws the picture no larger than maxDimension on its longest side. */
function imageToCanvas(source, maxDimension) {
  const { width, height } = imageSize(source);
  const scale = Math.min(1, maxDimension / Math.max(width, height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  canvas.getContext('2d').drawImage(source, 0, 0, canvas.width, canvas.height);
  if (source.close) source.close();
  return canvas;
}

/* The picture from a drop: a file from Finder, or an image dragged out of Photos or a web page. */
async function imageFileFromDrop(dataTransfer) {
  const file = [...dataTransfer.files].find(looksLikeImageFile);
  if (file) return file;
  let url = (dataTransfer.getData('text/uri-list') || '').split('\n').map(s => s.trim()).find(s => s && !s.startsWith('#'));
  if (!url) {
    const match = (dataTransfer.getData('text/html') || '').match(/<img[^>]+src=["']([^"']+)["']/i);
    if (match) url = match[1];
  }
  if (!url) return null;
  try {
    if (/^https?:/i.test(url) && window.folioImages) {
      const fetched = await window.folioImages.fetch(url);
      if (!fetched) return null;
      return new File([fetched.bytes], url.split('/').pop().split('?')[0] || 'dropped-image', { type: fetched.type });
    }
    const response = await fetch(url);
    const blob = await response.blob();
    return new File([blob], url.split('/').pop().split('?')[0] || 'dropped-image', { type: blob.type });
  } catch (e) {
    return null;
  }
}

/* ── Background image (per project) ──
   The image lives in IndexedDB (too large for localStorage), one per project; its
   settings in localStorage. With no image, html[data-bg] is absent and the
   palette's own backdrop shows. */
const BG_SETTINGS_PREFIX = 'folio-background:';
const BG_DEFAULTS = { blur: 24, clarity: 86, dim: 12, match: true, palette: null, name: '', zoom: 100, x: 50, y: 50 };
let bgSettings = { ...BG_DEFAULTS };
let bgActive = false;
let bgObjectUrl = null;
let bgLoadToken = 0;
let bgImageSize = null; // the picture's own width/height, needed to zoom it while still filling the window

const bgKey = projectId => `background:${projectId}`;

function backgroundStore(op, key, value) {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open('folio-assets', 1);
    open.onupgradeneeded = () => open.result.createObjectStore('files');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction('files', op === 'get' ? 'readonly' : 'readwrite');
      const store = tx.objectStore('files');
      const req = op === 'get' ? store.get(key) : op === 'put' ? store.put(value, key) : store.delete(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
      tx.oncomplete = () => db.close();
    };
  });
}

function saveBackgroundSettings(projectId = currentProjectId) {
  try { localStorage.setItem(BG_SETTINGS_PREFIX + projectId, JSON.stringify(bgSettings)); } catch (e) { /* ignore */ }
}

function hexToHue(hex) {
  const n = parseInt(hex.slice(1), 16);
  return rgbToHsv((n >> 16) & 255, (n >> 8) & 255, n & 255).h;
}

function rgbToHsv(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), d = max - Math.min(r, g, b);
  let h = 0;
  if (d) h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return { h: (h * 60 + 360) % 360, s: max ? d / max : 0, v: max };
}

/* Picks the built-in palette whose hue the image leans toward most (null for a near-grey image). */
function matchPaletteToImage(source) {
  const size = 32;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(source, 0, 0, size, size);
  const px = ctx.getImageData(0, 0, size, size).data;
  const candidates = ['sage', 'slate', 'sepia', 'rose', 'ocean'].map(id => ({ id, hue: hexToHue(PALETTE_ACCENTS[id]), weight: 0 }));
  let total = 0;
  for (let i = 0; i < px.length; i += 4) {
    const { h, s, v } = rgbToHsv(px[i], px[i + 1], px[i + 2]);
    const w = s * v;
    if (w < 0.08) continue;
    total += w;
    let best = candidates[0], bestDist = 999;
    for (const cand of candidates) {
      const dist = Math.min(Math.abs(h - cand.hue), 360 - Math.abs(h - cand.hue));
      if (dist < bestDist) { bestDist = dist; best = cand; }
    }
    best.weight += w;
  }
  if (total < size * size * 0.04) return null;
  return candidates.sort((a, b) => b.weight - a.weight)[0].id;
}

/* Shrinks big photos so storage and repaint stay light. */
async function prepareBackgroundImage(file) {
  const source = await decodeImageFile(file);
  const palette = matchPaletteToImage(source);
  const canvas = imageToCanvas(source, 2560);
  const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.88));
  return { blob, palette };
}

function applyBackground() {
  const root = document.documentElement;
  if (bgActive && bgObjectUrl) {
    root.setAttribute('data-bg', 'image');
    root.style.setProperty('--bg-image', `url("${bgObjectUrl}")`);
    root.style.setProperty('--bg-blur', `${bgSettings.blur}px`);
    root.style.setProperty('--bg-dim', String(bgSettings.dim / 100));
    applyBackgroundFit();
  } else {
    root.removeAttribute('data-bg');
    ['--bg-image', '--bg-blur', '--bg-dim', '--bg-pos', '--bg-size'].forEach(p => root.style.removeProperty(p));
  }
  refreshPalette();
  syncBackgroundUI();
  applyPageLayout();
}

/* ── Background fit ──
   Zoom is how much bigger than "just fills the window" the picture is drawn (100% = fills it);
   x/y say which part of the picture shows, 0–100% across and down, like background-position. */
function backgroundDrawSize() {
  if (!bgImageSize) return null;
  const vw = window.innerWidth, vh = window.innerHeight;
  const scale = Math.max(vw / bgImageSize.w, vh / bgImageSize.h) * (bgSettings.zoom || 100) / 100;
  return { w: bgImageSize.w * scale, h: bgImageSize.h * scale, vw, vh };
}

function applyBackgroundFit() {
  const root = document.documentElement.style;
  const size = backgroundDrawSize();
  root.setProperty('--bg-size', size ? `${Math.ceil(size.w)}px ${Math.ceil(size.h)}px` : 'cover');
  root.setProperty('--bg-pos', `${bgSettings.x ?? 50}% ${bgSettings.y ?? 50}%`);
}

function measureBackgroundImage(url) {
  bgImageSize = null;
  if (!url) return;
  const img = new Image();
  img.onload = () => {
    if (bgObjectUrl !== url) return; // a different picture took its place meanwhile
    bgImageSize = { w: img.naturalWidth, h: img.naturalHeight };
    applyBackgroundFit();
  };
  img.src = url;
}

function setBackgroundFit(patch) {
  Object.assign(bgSettings, patch);
  bgSettings.zoom = Math.max(100, Math.min(300, Math.round(bgSettings.zoom)));
  bgSettings.x = Math.max(0, Math.min(100, bgSettings.x));
  bgSettings.y = Math.max(0, Math.min(100, bgSettings.y));
  saveBackgroundSettings();
  applyBackgroundFit();
  syncBackgroundFitUI();
}

function syncBackgroundFitUI() {
  const zoom = bgSettings.zoom || 100;
  [['bg-zoom', 'bg-zoom-out'], ['bg-adjust-zoom', 'bg-adjust-zoom-out']].forEach(([input, out]) => {
    const el = document.getElementById(input);
    if (!el) return;
    el.value = zoom;
    document.getElementById(out).textContent = `${zoom}%`;
  });
}

function openBackgroundAdjust() {
  if (!bgActive) return;
  toggleSettingsMenu(false);
  syncBackgroundFitUI();
  document.body.classList.add('bg-adjusting');
  document.getElementById('bg-adjust-overlay').hidden = false;
}

function closeBackgroundAdjust() {
  document.body.classList.remove('bg-adjusting');
  document.getElementById('bg-adjust-overlay').hidden = true;
}

function bindBackgroundFitControls() {
  const overlay = document.getElementById('bg-adjust-overlay');
  const bar = overlay.querySelector('.bg-adjust-bar');
  const resetFit = () => setBackgroundFit({ zoom: 100, x: 50, y: 50 });
  ['bg-zoom', 'bg-adjust-zoom'].forEach(id => document.getElementById(id).addEventListener('input', e => setBackgroundFit({ zoom: Number(e.target.value) })));
  document.getElementById('bg-position-btn').addEventListener('click', openBackgroundAdjust);
  document.getElementById('bg-fit-reset-btn').addEventListener('click', resetFit);
  document.getElementById('bg-adjust-reset').addEventListener('click', resetFit);
  document.getElementById('bg-adjust-done').addEventListener('click', closeBackgroundAdjust);

  // Dragging moves the picture with the pointer: a pixel of drag is a pixel of picture.
  let drag = null;
  overlay.addEventListener('pointerdown', e => {
    if (bar.contains(e.target)) return;
    drag = { x: e.clientX, y: e.clientY, startX: bgSettings.x, startY: bgSettings.y };
    overlay.setPointerCapture(e.pointerId);
    overlay.classList.add('dragging');
  });
  overlay.addEventListener('pointermove', e => {
    if (!drag) return;
    const size = backgroundDrawSize();
    if (!size) return;
    const spareW = size.w - size.vw, spareH = size.h - size.vh; // how far the picture can slide
    const patch = {};
    if (spareW > 0.5) patch.x = drag.startX - (e.clientX - drag.x) / spareW * 100;
    if (spareH > 0.5) patch.y = drag.startY - (e.clientY - drag.y) / spareH * 100;
    setBackgroundFit(patch);
  });
  const endDrag = () => { drag = null; overlay.classList.remove('dragging'); };
  overlay.addEventListener('pointerup', endDrag);
  overlay.addEventListener('pointercancel', endDrag);
  overlay.addEventListener('wheel', e => {
    e.preventDefault();
    setBackgroundFit({ zoom: (bgSettings.zoom || 100) - e.deltaY * 0.25 });
  }, { passive: false });
  document.addEventListener('keydown', e => {
    if (!overlay.hidden && (e.key === 'Escape' || e.key === 'Enter')) { e.preventDefault(); e.stopPropagation(); closeBackgroundAdjust(); }
  }, true);
  window.addEventListener('resize', () => { if (bgActive) applyBackgroundFit(); });
}

function syncBackgroundUI() {
  const empty = document.getElementById('bg-empty');
  const filled = document.getElementById('bg-filled');
  if (!empty || !filled) return;
  empty.hidden = bgActive;
  filled.hidden = !bgActive;
  if (!bgActive) return;
  document.getElementById('bg-thumb').src = bgObjectUrl || '';
  document.getElementById('bg-name').textContent = bgSettings.name || 'Background image';
  [['blur', 'px'], ['dim', '%']].forEach(([key, unit]) => {
    document.getElementById(`bg-${key}`).value = bgSettings[key];
    document.getElementById(`bg-${key}-out`).textContent = bgSettings[key] + (unit === 'px' ? '' : unit);
  });
  document.getElementById('bg-match').checked = bgSettings.match;
  syncBackgroundFitUI();
  const note = document.getElementById('bg-match-note');
  const matched = bgSettings.match && bgSettings.palette;
  note.hidden = !bgSettings.match;
  note.textContent = matched
    ? `${bgSettings.palette[0].toUpperCase()}${bgSettings.palette.slice(1)} picked to match your background.`
    : 'This image is mostly neutral, so your own palette stays.';
}

async function setBackgroundFromFile(file) {
  if (!file) return;
  const projectId = currentProjectId; // the novel open when the picture was chosen gets it
  try {
    const { blob, palette } = await prepareBackgroundImage(file);
    await backgroundStore('put', bgKey(projectId), blob);
    if (projectId !== currentProjectId) {
      const saved = { ...BG_DEFAULTS, palette, name: file.name };
      localStorage.setItem(BG_SETTINGS_PREFIX + projectId, JSON.stringify(saved));
      return;
    }
    bgLoadToken++; // a slower load of the old background must not replace this one
    if (bgObjectUrl) URL.revokeObjectURL(bgObjectUrl);
    bgObjectUrl = URL.createObjectURL(blob);
    measureBackgroundImage(bgObjectUrl);
    // A new picture starts centred and filling the window; the old one's fit wouldn't suit it.
    bgSettings = { ...bgSettings, palette, name: file.name, match: bgActive ? bgSettings.match : true, zoom: 100, x: 50, y: 50 };
    bgActive = true;
    saveBackgroundSettings();
    applyBackground();
  } catch (e) {
    console.error('Could not set background', e);
    alert(`Folio couldn't open "${file.name}" as a picture. If it's a photo, try exporting it from Photos as a JPEG first.`);
  }
}

async function removeBackground() {
  const projectId = currentProjectId;
  bgLoadToken++;
  try { await backgroundStore('delete', bgKey(projectId)); } catch (e) { /* ignore */ }
  localStorage.removeItem(BG_SETTINGS_PREFIX + projectId);
  if (projectId !== currentProjectId) return;
  if (bgObjectUrl) URL.revokeObjectURL(bgObjectUrl);
  bgObjectUrl = null;
  bgImageSize = null;
  bgActive = false;
  bgSettings = { ...BG_DEFAULTS };
  closeBackgroundAdjust();
  applyBackground();
}

/* Shows the open project's background, or none. Clears the previous project's
   straight away so it never lingers on a novel that doesn't have it. */
async function loadProjectBackground() {
  const token = ++bgLoadToken;
  const projectId = currentProjectId;
  if (bgObjectUrl) URL.revokeObjectURL(bgObjectUrl);
  bgObjectUrl = null;
  bgImageSize = null;
  bgActive = false;
  try { bgSettings = { ...BG_DEFAULTS, ...JSON.parse(localStorage.getItem(BG_SETTINGS_PREFIX + projectId) || '{}') }; } catch (e) { bgSettings = { ...BG_DEFAULTS }; }
  applyBackground();
  let blob = null;
  try { blob = await backgroundStore('get', bgKey(projectId)); } catch (e) { /* none saved */ }
  if (token !== bgLoadToken || !blob) return; // another project opened meanwhile, or no background
  bgObjectUrl = URL.createObjectURL(blob);
  measureBackgroundImage(bgObjectUrl);
  bgActive = true;
  applyBackground();
}

function bindBackgroundControls() {
  const input = document.getElementById('bg-file-input');
  const dropzone = document.getElementById('bg-dropzone');
  const section = document.querySelector('.bg-section');
  const choose = () => input.click();
  input.accept = IMAGE_ACCEPT;
  dropzone.addEventListener('click', choose);
  document.getElementById('bg-replace-btn').addEventListener('click', choose);
  document.getElementById('bg-remove-btn').addEventListener('click', removeBackground);
  input.addEventListener('change', () => { setBackgroundFromFile(input.files[0]); input.value = ''; });
  // Drop anywhere in the Background section — on the empty box, or on the current picture to replace it.
  section.addEventListener('dragover', e => { e.preventDefault(); dropzone.classList.add('dragover'); });
  section.addEventListener('dragleave', e => { if (!section.contains(e.relatedTarget)) dropzone.classList.remove('dragover'); });
  section.addEventListener('drop', async e => {
    e.preventDefault();
    dropzone.classList.remove('dragover');
    const file = await imageFileFromDrop(e.dataTransfer);
    if (file) setBackgroundFromFile(file);
    else alert("That didn't come through as a picture. Try saving it to your Mac first, then drop the file here.");
  });
  ['blur', 'dim'].forEach(key => {
    document.getElementById(`bg-${key}`).addEventListener('input', e => {
      bgSettings[key] = Number(e.target.value);
      saveBackgroundSettings();
      applyBackground();
    });
  });
  document.getElementById('bg-match').addEventListener('change', e => {
    bgSettings.match = e.target.checked;
    saveBackgroundSettings();
    applyBackground();
  });
  bindBackgroundFitControls();
}

function toggleSettingsMenu(force) {
  const menu = document.getElementById('settings-menu');
  const open = typeof force === 'boolean' ? force : !menu.classList.contains('open');
  menu.classList.toggle('open', open);
}

function init() {
  loadPersistedState();
  ensureUniqueProjectId(); // migrate off the generic 'default' id every install starts with, before anything can compare ids against another device's file
  // Its first, synchronous part copies the old app-wide look into each project before we show it.
  migrateAppearanceToProjects().catch(() => {}).then(loadProjectBackground);
  migrateZoomToProjects();
  loadProjectAppearance();
  renderTree();
  loadDoc(activeId);
  updateTotals();
  setupEventListeners();
  document.getElementById('btn-editor').classList.add('active');
  document.body.classList.toggle('typewriter-mode', typewriterMode);
  document.body.classList.toggle('proofing-mode', proofingMode);
  document.body.classList.toggle('split-mode', splitMode);
  document.body.classList.toggle('margin-mode', marginMode);
  sessionBaseWords = getSessionBase();
  renderSession();
  renderBeats();
  renderSnapshots();
  renderNotes();
  renderSplitReference();
  renderMarginNotes();
  updateModeButtons();
  // Electron (main.js) calls this before closing the window and waits for it, so
  // the last save to the synced folder finishes instead of being cut off.
  window.folioFlushBeforeQuit = async () => {
    try {
      saveCharacterView();
      saveProjectToArchive();
      persistState();
      clearTimeout(autoSyncTimer);
      await syncWritesSettled();
      await bookStoreSettled(); // the last change is on disk before the window closes
      clearTimeout(backupTimer);
      await Promise.race([backupAllBooks(), new Promise(r => setTimeout(r, 5000))]); // never hold up quitting for long
      syncWritesClosed = true; // the window is closing: don't start a save that would be cut off
    } catch (e) {
      console.error('Could not finish saving before quit', e);
    }
  };
  window.addEventListener('beforeunload', () => {
    saveCharacterView();
    // saveProjectToArchive() also flushes saveCurrentDoc() and, critically, updates
    // folio-projects — the archive Book Formatter, Export, and synced-folder writes
    // all read from. persistState() below only keeps the live in-progress session
    // in sync (what reopens straight into the editor); without this, closing the
    // tab or the computer sleeping mid-session left the archive stale, so newly
    // written chapters would show up fine back in the editor next time but the
    // Formatter would still be compiling from whatever was archived last.
    saveProjectToArchive();
    persistState();
  });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) scanSyncFolder(); });
  loadSyncFolderHandle();
  setTimeout(backupAllBooks, 20000); // one backup of every book per launch, once Folio has settled
  openProjects();
}

/* ────────────────────────────────────────
   Tree Rendering
──────────────────────────────────────── */
function renderTree() {
  const manuscript = visibleTreeDocs('manuscript');
  const research   = visibleTreeDocs('research');
  document.getElementById('doc-tree').innerHTML      = manuscript.map(({ doc, depth }) => docItemHTML(doc, depth)).join('');
  document.getElementById('research-tree').innerHTML = research.map(({ doc, depth }) => docItemHTML(doc, depth)).join('');
  attachTreeEvents();
  schedulePersist();
}

function visibleTreeDocs(section) {
  const sectionDocs = docs.filter(d => d.section === section);
  const result = [];
  const seen = new Set();
  const walk = (parent, depth) => sectionDocs.filter(d => (d.parent || null) === parent).forEach(doc => {
    if (seen.has(doc.id)) return;
    seen.add(doc.id);
    result.push({ doc, depth });
    if (!doc.collapsed) walk(doc.id, depth + 1);
  });
  walk(null, 0);
  sectionDocs.filter(d => !seen.has(d.id)).forEach(doc => result.push({ doc, depth: 0 }));
  return result;
}

function docItemHTML(d, depth = 0) {
  const color = STATUS_COLORS[d.status] || STATUS_COLORS.draft;
  const hasChildren = docs.some(child => child.parent === d.id);
  const icon  = hasChildren ? (d.collapsed ? '▸' : '▾') : '◦';
  const wc    = countWords(d.content);
  return `<div class="doc-item ${d.id === activeId ? 'active' : ''}" data-id="${d.id}" draggable="true" style="padding-left:${14 + depth * 14}px">
    <span class="doc-icon" style="color:var(--text-faint)">${icon}</span>
    <span class="doc-name">${d.title}</span>
    ${wc > 0 ? `<span class="doc-wc">${wc}</span>` : ''}
    <span style="width:6px;height:6px;border-radius:50%;background:${color};flex-shrink:0;display:inline-block;"></span>
  </div>`;
}

function attachTreeEvents() {
  document.querySelectorAll('.doc-item').forEach(el => {
    el.addEventListener('click',       ()  => loadDoc(+el.dataset.id));
    el.addEventListener('contextmenu', e   => { e.preventDefault(); showCtx(e, +el.dataset.id); });
    el.addEventListener('dragstart',   e   => e.dataTransfer.setData('text/plain', el.dataset.id));
    el.addEventListener('dragover',    e   => { e.preventDefault(); el.classList.add('drag-over'); });
    el.addEventListener('dragleave',   ()  => el.classList.remove('drag-over'));
    el.addEventListener('drop',        e   => {
      e.preventDefault();
      el.classList.remove('drag-over');
      const fromId = +e.dataTransfer.getData('text/plain');
      const toId   = +el.dataset.id;
      if (fromId !== toId) reorderDoc(fromId, toId);
    });
  });
  document.querySelectorAll('.doc-item').forEach(el => {
    el.querySelector('.doc-icon').addEventListener('click', e => {
      const d = docs.find(x => x.id === +el.dataset.id);
      if (!d || !docs.some(child => child.parent === d.id)) return;
      e.stopPropagation();
      d.collapsed = !d.collapsed;
      renderTree();
    });
  });
}

function reorderDoc(fromId, toId) {
  const fi = docs.findIndex(d => d.id === fromId);
  const ti = docs.findIndex(d => d.id === toId);
  const [item] = docs.splice(fi, 1);
  docs.splice(ti, 0, item);
  renderTree();
}

/* ────────────────────────────────────────
   Load / Save
──────────────────────────────────────── */
function loadDoc(id) {
  if (id !== activeId) {
    saveCurrentDoc();
    saveCharacterView();
  }
  activeId = id;
  const d = docs.find(x => x.id === id);
  if (d && d.entityType === 'character') {
    // Characters have their own card, but the writing page underneath must not keep
    // showing whatever was open before — after switching books that was the other
    // book's chapter, which then appeared (and could be typed into) under this book.
    document.getElementById('doc-title-edit').value = d.title;
    document.getElementById('editor').innerHTML = '';
    setMode('characters', true);
    renderTree();
    return;
  }

  document.getElementById('doc-title-edit').value = d.title;
  document.getElementById('editor').innerHTML      = d.content || '';
  removeStaleTranscriptionMarks(document.getElementById('editor'));
  prepareAnnotationMarks();
  document.getElementById('editor').style.fontFamily = d.font || DEFAULT_FONT;
  document.getElementById('fmt-font').value         = d.font || DEFAULT_FONT;
  document.getElementById('editor').style.fontSize   = d.fontSize || '17px';
  document.getElementById('fmt-size').value          = '';
  document.getElementById('editor').style.lineHeight = d.lineHeight || '1';
  document.getElementById('fmt-line-spacing').value  = d.lineHeight || '1';
  document.getElementById('editor').style.color      = d.textColor || '';
  document.getElementById('fmt-color').value         = d.textColor || '#000000';
  document.querySelectorAll('#editor .scene-break').forEach(sceneBreak => {
    const followingParagraph = sceneBreak.nextElementSibling;
    if (followingParagraph?.tagName === 'P') {
      followingParagraph.classList.add('scene-break-following');
      if (sceneBreak.previousElementSibling) {
        let precedingText = sceneBreak.previousElementSibling;
        while (precedingText.lastElementChild) precedingText = precedingText.lastElementChild;
        const precedingStyle = getComputedStyle(precedingText);
        if (!followingParagraph.style.fontSize) followingParagraph.style.fontSize = precedingStyle.fontSize;
        if (!followingParagraph.style.lineHeight) followingParagraph.style.lineHeight = precedingStyle.lineHeight;
        if (!sceneBreak.style.lineHeight) sceneBreak.style.lineHeight = precedingStyle.lineHeight;
        if (!followingParagraph.style.fontFamily) {
          followingParagraph.style.setProperty('font-family', precedingStyle.fontFamily, 'important');
        }
      }
    }
  });
  document.getElementById('synopsis-area').value   = d.synopsis || '';
  document.getElementById('status-select').value   = d.status || 'draft';
  updateStatusControls(d.status || 'draft');
  document.getElementById('target-input').value    = d.target || '';
  document.getElementById('story-date').value      = d.storyDate || '';
  setBanner(d.banner || '');
  document.getElementById('sub-date').textContent  = d.createdAt
    ? d.createdAt.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
    : '—';

  renderTags(d);
  updateStats();
  renderBeats();
  renderSnapshots();
  renderNotes();
  renderSplitReference();
  renderMarginNotes();
  renderTree();

  if (currentMode === 'characters') setMode('editor', true);
  if (currentMode === 'cork')     buildCork();
  if (currentMode === 'outline')  buildOutline();
  if (currentMode === 'timeline') buildTimeline();
  if (currentMode === 'board')    buildBoard();
}

function saveCurrentDoc() {
  const d = docs.find(x => x.id === activeId);
  if (!d) return;
  if (d.entityType === 'character') return;
  const fresh = {
    title:     document.getElementById('doc-title-edit').value || 'Untitled',
    content:   document.getElementById('editor').innerHTML,
    synopsis:  document.getElementById('synopsis-area').value,
    status:    document.getElementById('status-select').value,
    target:    +document.getElementById('target-input').value || 0,
    storyDate: document.getElementById('story-date').value || '',
    banner:    document.getElementById('doc-banner').dataset.url || ''
  };
  // Only save when something actually changed. The synced-folder autosave calls this
  // too, and saving unconditionally kept Folio re-saving every couple of seconds forever.
  if (Object.keys(fresh).every(key => d[key] === fresh[key])) return;
  Object.assign(d, fresh);
  schedulePersist();
}

/* ────────────────────────────────────────
   Statistics
──────────────────────────────────────── */
/* Word, character, paragraph and sentence counting lives in counting.js
   (getTextStats, countWords, wordTokens, …), loaded before this file. */

/* ── World Bible ── */
function findMentionedEntities(text) {
  return docs.filter(d => d.entityType).filter(d =>
    [d.title, ...(d.aliases || [])].some(alias =>
      text.toLowerCase().includes(alias.toLowerCase())
    )
  );
}

function renderMentions(entities) {
  const panel = document.getElementById('mentions-panel');
  if (!panel) return;
  if (!entities.length) {
    panel.innerHTML = '<span style="color:var(--text-faint);font-size:12px;">No linked entities found.</span>';
    return;
  }
  panel.innerHTML = entities.map(e => `
    <div class="mention-badge" data-id="${e.id}">
      <span class="mention-type">${e.entityType}</span>
      <span class="mention-name">${e.title}</span>
    </div>
  `).join('');

  panel.querySelectorAll('.mention-badge').forEach(badge => {
    badge.addEventListener('click', () => loadDoc(+badge.dataset.id));
  });
}

function updateStats() {
  const html    = document.getElementById('editor').innerHTML;
  const stats   = getTextStats(html);
  const text    = stats.text;
  const words   = stats.words;
  const chars   = stats.characters;
  const paras   = stats.paragraphs;
  const sentences = stats.sentences;
  const readMin = Math.max(1, Math.round(words / 250));

  document.getElementById('stat-words').textContent        = words.toLocaleString();
  document.getElementById('stat-chars').textContent        = chars.toLocaleString();
  document.getElementById('stat-paras').textContent        = paras;
  document.getElementById('stat-sentences').textContent    = sentences;
  document.getElementById('stat-read').textContent         = readMin + ' min';
  document.getElementById('sub-wc').textContent            = words.toLocaleString() + ' words';
  document.getElementById('wordcount-display').textContent = words.toLocaleString() + ' words';

  const target = +document.getElementById('target-input').value || 0;
  const pct    = target > 0 ? Math.min(100, Math.round((words / target) * 100)) : 0;
  document.getElementById('progress-fill').style.width = pct + '%';

  updateTotals();

  const mentioned = findMentionedEntities(text);
  renderMentions(mentioned);
}

function updateTotals() {
  saveCurrentDoc();
  const ms    = docs.filter(d => d.section === 'manuscript');
  const total = ms.reduce((sum, d) => sum + countWords(d.content), 0);
  document.getElementById('total-words').textContent = total.toLocaleString();
  document.getElementById('total-docs').textContent  = ms.length;
  renderSession();
}

function getProjectWordTotal() {
  return docs
    .filter(d => d.section === 'manuscript' && !d.isFolder)
    .reduce((sum, d) => sum + countWords(d.content || ''), 0);
}

function getSessionBase() {
  const today = new Date().toISOString().slice(0, 10);
  const key = `${currentProjectId}:${today}`;
  let bases;
  try { bases = JSON.parse(localStorage.getItem('folio-session-bases') || '{}'); } catch { bases = {}; }
  if (typeof bases[key] !== 'number') {
    bases[key] = getProjectWordTotal();
    localStorage.setItem('folio-session-bases', JSON.stringify(bases));
  }
  return bases[key];
}

/* ────────────────────────────────────────
   Formatting
──────────────────────────────────────── */
function fmt(cmd) {
  document.execCommand(cmd, false, null);
  document.getElementById('editor').focus();
}

/* Applies one CSS property to a selection fragment by setting it directly on each
   of the fragment's TOP-LEVEL nodes, instead of wrapping the whole fragment in a
   single new <span> — a selection spanning full paragraphs extracts actual <p>
   elements as top-level fragment children, and a <span> (inline-only) can't
   legally wrap block elements like that without corrupting the document
   structure (confirmed: selecting a whole multi-paragraph chapter and changing
   its font size produced `<span><p>…</p><p>…</p></span>` — invalid HTML that the
   book formatter's paragraph-splitting logic couldn't parse as separate
   paragraphs, which is what caused it to run off the page and lose most of the
   text). A bare top-level text node still gets wrapped in a fresh span, since
   text nodes can't carry a style of their own. */
function applyStyleToFragmentTopLevel(fragment, styleProp, styleValue) {
  Array.from(fragment.childNodes).forEach(node => {
    if (node.nodeType === Node.ELEMENT_NODE) {
      node.style[styleProp] = styleValue;
    } else if (node.nodeType === Node.TEXT_NODE && node.textContent) {
      const span = document.createElement('span');
      span.style[styleProp] = styleValue;
      node.replaceWith(span);
      span.appendChild(node);
    }
  });
}

/* Applies a font only to the current selection (e.g. a letter written in another
   character's hand within a chapter). Returns false if there's nothing selected,
   so the caller can fall back to changing the whole document's font. */
function applySelectionFont(fontValue) {
  const editor = document.getElementById('editor');
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || !editor.contains(selection.anchorNode)) return false;
  const range = selection.getRangeAt(0).cloneRange();
  let fragment;
  try { fragment = range.extractContents(); }
  catch { alert('Select text within a single paragraph to change its font.'); return true; }
  // Drop any font already set on the selection (e.g. it spanned two differently-styled
  // runs) so the newly chosen font wins uniformly across the whole selection.
  fragment.querySelectorAll('[style]').forEach(el => {
    el.style.removeProperty('font-family');
    if (!el.getAttribute('style')) el.removeAttribute('style');
  });
  fragment.querySelectorAll('span:not([style]):not([class])').forEach(el => el.replaceWith(...el.childNodes));
  applyStyleToFragmentTopLevel(fragment, 'fontFamily', fontValue);
  range.insertNode(fragment);
  selection.removeAllRanges();
  saveCurrentDoc();
  return true;
}

/* Colors every text run touched by the selection separately. This preserves the
   paragraph structure when a selection crosses blocks, while the new spans ensure
   one color wins even when the selected text previously contained several colors. */
function styleSelectedTextColor(hex) {
  const editor = document.getElementById('editor');
  const selection = window.getSelection();
  if (!selection?.rangeCount || selection.isCollapsed ||
      !editor.contains(selection.anchorNode) || !editor.contains(selection.focusNode)) return false;

  const range = selection.getRangeAt(0);
  const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
  const runs = [];
  let node;
  while ((node = walker.nextNode())) {
    if (!node.nodeValue.length) continue;
    try { if (!range.intersectsNode(node)) continue; } catch { continue; }
    const start = node === range.startContainer ? range.startOffset : 0;
    const end = node === range.endContainer ? range.endOffset : node.nodeValue.length;
    if (start < end) runs.push({ node, start, end, span: null });
  }

  // Work backwards so splitting a boundary text node cannot disturb the offsets
  // of any run that still needs to be processed.
  for (let i = runs.length - 1; i >= 0; i--) {
    const run = runs[i];
    let selectedNode = run.node;
    if (run.end < selectedNode.nodeValue.length) selectedNode.splitText(run.end);
    if (run.start > 0) selectedNode = selectedNode.splitText(run.start);
    const span = document.createElement('span');
    span.style.color = hex;
    selectedNode.before(span);
    span.appendChild(selectedNode);
    run.span = span;
  }

  if (runs.length) {
    const coloredRange = document.createRange();
    coloredRange.setStartBefore(runs[0].span);
    coloredRange.setEndAfter(runs[runs.length - 1].span);
    selection.removeAllRanges();
    selection.addRange(coloredRange);
  }
  saveCurrentDoc();
  return true;
}

/* Pure black and pure white aren't treated as "real" custom colors — picking
   either one just means "make this readable," so instead of locking in a literal
   value that could go invisible the moment the theme changes (or is already wrong
   for the CURRENT theme — e.g. picking black while already in dark mode), both
   clear any color override entirely and let the text inherit the theme's own
   color instead, which is always readable and updates automatically whenever the
   theme does. Any other color is left exactly as picked, regardless of theme —
   this is also what keeps white text impossible in light mode and black text
   impossible in dark mode, since neither can ever be locked in as a literal value. */
function isThemeSentinelColor(hex) {
  const normalized = (hex || '').toLowerCase();
  return normalized === '#000000' || normalized === '#ffffff';
}

function applySelectionColor(hex) {
  if (isThemeSentinelColor(hex)) return clearSelectionColor();
  return styleSelectedTextColor(hex);
}

/* Opening a native <input type="color"> moves focus out of the editor and some
   browsers discard the highlighted range before the picker fires `change`.
   Keep a clone of that range so the color is applied to the text the user
   actually highlighted, rather than falling back to the whole document. */
let savedColorRange = null;

function rememberColorSelection() {
  const editor = document.getElementById('editor');
  const selection = window.getSelection();
  if (!selection?.rangeCount || selection.isCollapsed) {
    savedColorRange = null;
    return;
  }
  const range = selection.getRangeAt(0);
  savedColorRange = editor.contains(range.startContainer) && editor.contains(range.endContainer)
    ? range.cloneRange()
    : null;
}

function restoreColorSelection() {
  if (!savedColorRange) return;
  const editor = document.getElementById('editor');
  if (!editor.contains(savedColorRange.startContainer) || !editor.contains(savedColorRange.endContainer)) {
    savedColorRange = null;
    return;
  }
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(savedColorRange);
}

/* Strips an explicit color back off the current selection by painting it with
   whatever color the editor would show without any override — the theme default,
   or the whole-document color if one's set. Returns false if there's nothing
   selected, so the caller can reset the whole document's color instead. */
function clearSelectionColor() {
  // Deliberately a *live* CSS variable reference, not a snapshot of its current
  // computed value — an inline color still needs to win over any colored ancestor
  // the selection sits inside (plain CSS inheritance can't skip past that), but
  // baking in today's resolved color as a fixed hex value would stop tracking the
  // theme the moment it changes again, which is exactly the bug this is fixing.
  // var(--text) keeps updating on its own whenever the theme does, same as every
  // other piece of text that was never colored in the first place.
  return styleSelectedTextColor('var(--text)');
}

/* getComputedStyle().color always comes back as "rgb(r, g, b)" (or "rgba(...)"),
   but <input type="color"> only accepts "#rrggbb" — this bridges the two so the
   swatch can be kept in sync with whatever's under the caret. */
function rgbToHex(rgb) {
  const match = rgb && rgb.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  if (!match) return null;
  const toHex = n => Number(n).toString(16).padStart(2, '0');
  return `#${toHex(match[1])}${toHex(match[2])}${toHex(match[3])}`;
}

function detectCaretColor() {
  const editor = document.getElementById('editor');
  const selection = window.getSelection();
  const node = selection?.anchorNode;
  const element = node?.nodeType === Node.TEXT_NODE ? node.parentElement : node;
  if (!(element instanceof Element) || !editor.contains(element)) return;
  const hex = rgbToHex(getComputedStyle(element).color);
  if (hex) document.getElementById('fmt-color').value = hex;
}

/* Rich text copied from Google Docs, Word, Pages, etc. always carries an explicit
   inline color on every run (almost always a hardcoded near-black, even if the
   author never touched the color themselves — it's just that app's default) and
   often a background-color too. Pasted as-is, that hardcoded color permanently
   overrides the theme, which is why pasted text stays dark in dark mode while text
   typed directly into the editor correctly follows the theme via CSS. Stripping
   just color/background on the way in — not font, size, bold, italic, etc. — keeps
   pasted text themeable by default, same as typed text, while leaving every other
   bit of pasted formatting untouched. */
function stripPastedColor(html) {
  const wrap = document.createElement('div');
  wrap.innerHTML = html;
  wrap.querySelectorAll('[style]').forEach(el => {
    el.style.removeProperty('color');
    el.style.removeProperty('background-color');
    el.style.removeProperty('background');
    if (!el.getAttribute('style')) el.removeAttribute('style');
  });
  wrap.querySelectorAll('font').forEach(el => el.removeAttribute('color'));
  return wrap.innerHTML;
}

const PASTE_BLOCK_TAGS = /^(P|DIV|H1|H2|H3|BLOCKQUOTE|UL|OL|LI)$/;

/* Inserts a list of nodes at a Range and leaves the caret right after the last
   one — the shared tail end of both paste paths below. */
function insertNodesAtRange(range, nodes, selection) {
  const fragment = document.createDocumentFragment();
  let lastNode = null;
  nodes.forEach(node => { lastNode = fragment.appendChild(node); });
  range.insertNode(fragment);
  if (lastNode) {
    const caret = document.createRange();
    caret.setStartAfter(lastNode);
    caret.collapse(true);
    selection.removeAllRanges();
    selection.addRange(caret);
  }
}

/* Inserted via the Range API rather than execCommand('insertHTML', ...) on
   purpose: execCommand's insertHTML bakes the *currently rendered* computed color
   into whatever it inserts (to keep pasted content visually self-contained at the
   moment of pasting) even when the source HTML has no color of its own — which
   would silently reintroduce this exact bug the next time the theme changes,
   since that baked-in value stops following the theme from then on (confirmed by
   testing: switching themes after a paste left the old, now-mismatched color). */
function handleThemeablePaste(e) {
  const html = e.clipboardData?.getData('text/html');
  if (!html) return; // plain text (or an image, etc.) has no color to strip — let the browser handle it normally
  e.preventDefault();

  const editor = document.getElementById('editor');
  const selection = window.getSelection();
  if (!selection?.rangeCount) return;
  const range = selection.getRangeAt(0);
  range.deleteContents();

  const wrap = document.createElement('div');
  wrap.innerHTML = stripPastedColor(html);
  const incomingNodes = Array.from(wrap.childNodes);
  const hasBlockContent = incomingNodes.some(n => n.nodeType === Node.ELEMENT_NODE && PASTE_BLOCK_TAGS.test(n.tagName));

  // Pasting block-level content (multiple paragraphs, a list, …) requires special
  // care if the caret sits in the middle of an existing paragraph's text: a plain
  // Range.insertNode would nest those new <p> elements inside the current one
  // (invalid HTML) instead of landing next to it, and every other part of the app —
  // word counts, Book Mode pagination, Compile/export — assumes #editor's children
  // are a flat sequence of top-level blocks with nothing nested inside them. So the
  // current block gets split in two at the caret first, and the pasted blocks land
  // between the two halves instead.
  const container = range.startContainer;
  const currentBlock = (container.nodeType === Node.ELEMENT_NODE ? container : container.parentElement)?.closest('#editor > *');

  if (hasBlockContent && currentBlock) {
    const afterRange = document.createRange();
    afterRange.setStart(range.startContainer, range.startOffset);
    afterRange.setEndAfter(currentBlock.lastChild || currentBlock);
    const afterHalf = currentBlock.cloneNode(false);
    afterHalf.appendChild(afterRange.extractContents());
    currentBlock.after(afterHalf);
    if (!currentBlock.hasChildNodes()) currentBlock.appendChild(document.createElement('br')); // don't let an empty "before" half collapse away
    if (!afterHalf.hasChildNodes()) afterHalf.appendChild(document.createElement('br'));

    const insertionPoint = document.createRange();
    insertionPoint.setStartBefore(afterHalf);
    insertionPoint.collapse(true);
    insertNodesAtRange(insertionPoint, incomingNodes, selection);
  } else {
    insertNodesAtRange(range, incomingNodes, selection);
  }

  editor.dispatchEvent(new Event('input', { bubbles: true }));
}

function applySelectionFontSize(sizeValue) {
  const editor = document.getElementById('editor');
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || !editor.contains(selection.anchorNode)) return false;
  const range = selection.getRangeAt(0).cloneRange();
  let fragment;
  try { fragment = range.extractContents(); }
  catch { alert('Select text within a single paragraph to change its size.'); return true; }
  fragment.querySelectorAll('[style]').forEach(el => {
    el.style.removeProperty('font-size');
    if (!el.getAttribute('style')) el.removeAttribute('style');
  });
  fragment.querySelectorAll('span:not([style]):not([class])').forEach(el => el.replaceWith(...el.childNodes));
  applyStyleToFragmentTopLevel(fragment, 'fontSize', sizeValue);
  range.insertNode(fragment);
  selection.removeAllRanges();
  saveCurrentDoc();
  return true;
}

function showDetectedFontSize(sizeValue) {
  const select = document.getElementById('fmt-size');
  if (!select || !sizeValue) return;
  const rounded = `${Math.round(parseFloat(sizeValue) * 10) / 10}px`;
  select.title = `Selected text size: ${rounded}`;
  if (select.value === rounded) return;
  let option = Array.from(select.options).find(item => item.value === rounded);
  select.querySelectorAll('option[data-detected]').forEach(item => {
    if (item.value !== rounded) item.remove();
  });
  if (!option) {
    option = new Option(rounded.replace('px', ''), rounded);
    option.dataset.detected = 'true';
    select.add(option);
  }
  select.value = rounded;
}

function normalizeFontFamily(value) {
  return value.toLowerCase().replace(/["']/g, '').replace(/\s*,\s*/g, ',').trim();
}

function showDetectedFont(fontValue) {
  const select = document.getElementById('fmt-font');
  if (!select || !fontValue) return;
  const normalized = normalizeFontFamily(fontValue);
  let option = Array.from(select.options).find(item => normalizeFontFamily(item.value) === normalized);
  select.querySelectorAll('option[data-detected-font]').forEach(item => {
    if (normalizeFontFamily(item.value) !== normalized) item.remove();
  });
  if (!option) {
    const label = fontValue.split(',')[0].replace(/["']/g, '').trim();
    option = new Option(label, fontValue);
    option.dataset.detectedFont = 'true';
    select.add(option);
  }
  select.value = option.value;
  select.title = `Selected text font: ${option.textContent}`;
}

function detectCaretFont() {
  const editor = document.getElementById('editor');
  const selection = window.getSelection();
  if (!selection?.rangeCount) return;
  if (!selection.isCollapsed) {
    const range = selection.getRangeAt(0);
    const fonts = new Map();
    const rangeRoot = range.commonAncestorContainer.nodeType === Node.TEXT_NODE
      ? range.commonAncestorContainer.parentElement
      : range.commonAncestorContainer;
    const walker = document.createTreeWalker(rangeRoot, NodeFilter.SHOW_TEXT);
    let textNode;
    while ((textNode = walker.nextNode())) {
      if (!textNode.nodeValue.trim() || !range.intersectsNode(textNode)) continue;
      const family = getComputedStyle(textNode.parentElement).fontFamily;
      fonts.set(normalizeFontFamily(family), family);
      if (fonts.size > 1) {
        document.getElementById('fmt-font').value = '';
        return;
      }
    }
    if (fonts.size === 1) {
      showDetectedFont(fonts.values().next().value);
      return;
    }
  }
  const node = selection.anchorNode;
  const element = node?.nodeType === Node.TEXT_NODE ? node.parentElement : node;
  if (element instanceof Element && editor.contains(element)) {
    showDetectedFont(getComputedStyle(element).fontFamily);
  }
}

function detectCaretFontSize() {
  const editor = document.getElementById('editor');
  const selection = window.getSelection();
  if (!selection?.rangeCount) return;
  if (!selection.isCollapsed) {
    const range = selection.getRangeAt(0);
    const sizes = new Set();
    const rangeRoot = range.commonAncestorContainer.nodeType === Node.TEXT_NODE
      ? range.commonAncestorContainer.parentElement
      : range.commonAncestorContainer;
    const walker = document.createTreeWalker(rangeRoot, NodeFilter.SHOW_TEXT);
    let textNode;
    while ((textNode = walker.nextNode())) {
      if (!textNode.nodeValue.trim() || !range.intersectsNode(textNode)) continue;
      sizes.add(getComputedStyle(textNode.parentElement).fontSize);
      if (sizes.size > 1) {
        document.getElementById('fmt-size').value = '';
        return;
      }
    }
    if (sizes.size === 1) {
      showDetectedFontSize(sizes.values().next().value);
      return;
    }
  }
  const node = selection?.anchorNode;
  const element = node?.nodeType === Node.TEXT_NODE ? node.parentElement : node;
  if (!(element instanceof Element) || !editor.contains(element)) return;
  showDetectedFontSize(getComputedStyle(element).fontSize || '17px');
}

function selectedEditorBlocks() {
  const editor = document.getElementById('editor');
  const selection = window.getSelection();
  // A collapsed selection is just the blinking caret sitting in some paragraph — it
  // still "intersects" that paragraph as far as Range.intersectsNode is concerned, so
  // without this check a plain click with nothing highlighted would look identical to
  // a real selection and silently restyle only that one paragraph instead of falling
  // through to the whole-document change the caller expects when nothing is selected.
  if (!selection?.rangeCount || selection.isCollapsed || !editor.contains(selection.anchorNode)) return [];
  const range = selection.getRangeAt(0);
  return Array.from(editor.children).filter(block => {
    try { return range.intersectsNode(block); } catch { return false; }
  });
}

function applyLineSpacing(lineHeight) {
  const editor = document.getElementById('editor');
  const blocks = selectedEditorBlocks();
  if (blocks.length) {
    blocks.forEach(block => { block.style.lineHeight = lineHeight; });
    saveCurrentDoc();
  } else {
    const d = docs.find(x => x.id === activeId);
    if (!d) return;
    d.lineHeight = lineHeight;
    editor.style.lineHeight = lineHeight;
    schedulePersist();
  }
  editor.focus();
}

function detectCaretLineSpacing() {
  const editor = document.getElementById('editor');
  const selection = window.getSelection();
  const node = selection?.anchorNode;
  let element = node?.nodeType === Node.TEXT_NODE ? node.parentElement : node;
  if (!(element instanceof Element) || !editor.contains(element)) return;
  if (element !== editor) element = element.closest('#editor > *') || element;
  const computed = getComputedStyle(element);
  const fontSize = parseFloat(computed.fontSize);
  const lineHeight = parseFloat(computed.lineHeight);
  if (!fontSize || !lineHeight) return;
  const ratio = String(Math.round((lineHeight / fontSize) * 100) / 100);
  const select = document.getElementById('fmt-line-spacing');
  let option = Array.from(select.options).find(item => item.value === ratio);
  if (!option) {
    select.querySelectorAll('option[data-detected-line]').forEach(item => item.remove());
    option = new Option(ratio, ratio);
    option.dataset.detectedLine = 'true';
    select.add(option);
  }
  select.value = ratio;
}

/* Converts a typed "--" into a real em dash (—) the moment another character is typed
   after it — the same behavior Word/Google Docs/Scrivener have. Without this, typing a
   dash the usual keyboard way (there's no em-dash key) leaves literal hyphens in the
   document, which look right at a glance but are a different character from a real
   em dash — throwing off character/sentence counts and general typography. Waits for
   a following, non-hyphen character before converting so "---" isn't clobbered mid-type. */
function setEditorCaret(node, pos) {
  const selection = window.getSelection();
  const newRange = document.createRange();
  newRange.setStart(node, pos);
  newRange.collapse(true);
  selection.removeAllRanges();
  selection.addRange(newRange);
}

function autoConvertEmDash() {
  const editor = document.getElementById('editor');
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || !selection.isCollapsed) return;
  const range = selection.getRangeAt(0);
  const node = range.startContainer;
  if (node.nodeType !== Node.TEXT_NODE || !editor.contains(node)) return;
  const offset = range.startOffset;
  const text = node.textContent;

  // "--" or "---" run, converted once a following non-hyphen character is typed.
  if (offset >= 3) {
    const justTyped = text[offset - 1];
    if (justTyped !== '-') {
      const runEnd = offset - 1;
      let runStart = runEnd;
      while (runStart > 0 && text[runStart - 1] === '-') runStart--;
      const runLength = runEnd - runStart;
      if (runLength >= 2 && runLength <= 3) {
        const before = text.slice(0, runStart);
        const after = text.slice(offset);
        node.textContent = before + '—' + justTyped + after;
        setEditorCaret(node, before.length + 2);
        return;
      }
    }
  }

  // A single hyphen with a space on each side ("word - word"), converted once the
  // trailing space has been typed.
  if (offset >= 3 && text[offset - 1] === ' ' && text[offset - 2] === '-' && text[offset - 3] === ' '
    && (offset < 4 || text[offset - 4] !== '-')) {
    const before = text.slice(0, offset - 3);
    const after = text.slice(offset);
    node.textContent = before + '—' + after;
    setEditorCaret(node, before.length + 1);
  }
}

/* One-time cleanup for dashes typed before autocorrect existed: converts "--"/"---",
   or a single hyphen with a space on each side, into a real em dash, everywhere in the
   current document. Leaves single hyphens with no surrounding spaces (compound words
   like "well-known") untouched. */
function convertTypedDashesToEmDash() {
  const editor = document.getElementById('editor');
  const before = editor.innerHTML;
  const after = before
    .replace(/(?<!-)-{2,3}(?!-)/g, '—')
    .replace(/(?<!-) - (?!-)/g, '—');
  if (after === before) { alert('No typed dashes ("--", "---", or " - ") found to convert.'); return; }
  editor.innerHTML = after;
  saveCurrentDoc();
  updateStats();
  renderTree();
  alert('Converted typed dashes to em dashes (—) in this document.');
}

/* One-time cleanup for content that was pasted in before handleThemeablePaste()
   existed (or from anywhere else a hardcoded color could have snuck in) — strips
   every inline color/background in the document so it falls back to following the
   theme, same as handleThemeablePaste() does for new pastes going forward. This
   also clears any color applied on purpose via the font-color picker, since a
   hardcoded color and an intentionally-applied one are the same style property
   and can't be told apart after the fact — it's an explicit, whole-document reset. */
function stripDocumentColors() {
  const editor = document.getElementById('editor');
  const before = editor.innerHTML;
  const after = stripPastedColor(before);
  if (after === before) { alert('No colored text found in this document.'); return; }
  editor.innerHTML = after;
  saveCurrentDoc();
  updateStats();
  renderTree();
  alert('Removed hardcoded text colors from this document — it now follows the current theme.');
}

function applyBlock(tag) {
  if (tag === 'div') {
    const editor = document.getElementById('editor');
    const selection = window.getSelection();
    if (!selection?.rangeCount || !editor.contains(selection.anchorNode)) return;
    const range = selection.getRangeAt(0);
    const anchorNode = selection?.anchorNode;
    const anchorElement = anchorNode?.nodeType === Node.TEXT_NODE ? anchorNode.parentElement : anchorNode;
    const currentBlock = anchorElement instanceof Element
      ? anchorElement.closest('#editor > *')
      : null;
    const sourceStyle = anchorElement instanceof Element && editor.contains(anchorElement)
      ? getComputedStyle(anchorElement)
      : getComputedStyle(editor);
    const sourceFontSize = sourceStyle.fontSize;
    const sourceFontFamily = sourceStyle.fontFamily;
    const sourceLineHeight = sourceStyle.lineHeight;
    range.deleteContents();
    range.collapse(true);

    const sceneBreak = document.createElement('div');
    sceneBreak.className = 'scene-break';
    sceneBreak.textContent = '· · ·';
    sceneBreak.style.lineHeight = sourceLineHeight;

    let followingParagraph;
    if (currentBlock) {
      followingParagraph = currentBlock.cloneNode(false);
      followingParagraph.removeAttribute('id');
      followingParagraph.classList.remove('current-line');
      followingParagraph.classList.add('scene-break-following');
      const remainderRange = document.createRange();
      remainderRange.setStart(range.startContainer, range.startOffset);
      remainderRange.setEnd(currentBlock, currentBlock.childNodes.length);
      followingParagraph.appendChild(remainderRange.extractContents());
      if (!followingParagraph.textContent && !followingParagraph.querySelector('br')) {
        followingParagraph.appendChild(document.createElement('br'));
      }
      currentBlock.after(sceneBreak, followingParagraph);
    } else {
      followingParagraph = document.createElement('p');
      followingParagraph.className = 'scene-break-following';
      followingParagraph.appendChild(document.createElement('br'));
      editor.append(sceneBreak, followingParagraph);
    }
    followingParagraph.style.fontSize = sourceFontSize;
    followingParagraph.style.lineHeight = sourceLineHeight;
    followingParagraph.style.setProperty('font-family', sourceFontFamily, 'important');

    const nextTextRange = document.createRange();
    nextTextRange.selectNodeContents(followingParagraph);
    nextTextRange.collapse(true);
    selection.removeAllRanges();
    selection.addRange(nextTextRange);
    editor.focus();
    saveCurrentDoc();
    updateStats();
    return;
  }
  document.execCommand('formatBlock', false, tag);
  document.getElementById('editor').focus();
}

/* ────────────────────────────────────────
   Tags
──────────────────────────────────────── */
function renderTags(d) {
  const wrap  = document.getElementById('tags-wrap');
  const input = document.getElementById('tag-input');
  wrap.innerHTML = '';
  (d.tags || []).forEach(t => {
    const el = document.createElement('span');
    el.className = 'tag';
    el.innerHTML = `${t}<span class="tag-del" data-tag="${t}">×</span>`;
    el.querySelector('.tag-del').addEventListener('click', () => removeTag(t));
    wrap.appendChild(el);
  });
  wrap.appendChild(input);
}

function removeTag(t) {
  const d = docs.find(x => x.id === activeId);
  if (!d) return;
  d.tags = (d.tags || []).filter(x => x !== t);
  renderTags(d);
  schedulePersist();
}

/* ────────────────────────────────────────
   Add Document
──────────────────────────────────────── */
function addDoc(section, parentId = null) {
  const d = {
    id: nextId++,
    title: 'New Document',
    content: '',
    synopsis: '',
    status: 'draft',
    target: 0,
    storyDate: '',
    banner: '',
    tags: [],
    parent: parentId,
    isFolder: false,
    section,
    createdAt: new Date()
  };
  docs.push(d);
  renderTree();
  loadDoc(d.id);
  setTimeout(() => {
    const ti = document.getElementById('doc-title-edit');
    ti.focus();
    ti.select();
  }, 50);
}

/* ────────────────────────────────────────
   Entity Modal
──────────────────────────────────────── */
function openEntityModal() {
  document.getElementById('entity-name').value    = '';
  document.getElementById('entity-aliases').value = '';
  document.getElementById('entity-type').value    = 'character';
  document.getElementById('entity-overlay').classList.add('open');
  setTimeout(() => document.getElementById('entity-name').focus(), 50);
}

function closeEntityModal() {
  document.getElementById('entity-overlay').classList.remove('open');
}

function createEntity() {
  const name    = document.getElementById('entity-name').value.trim();
  const type    = document.getElementById('entity-type').value;
  const aliases = document.getElementById('entity-aliases').value
    .split(',')
    .map(a => a.trim())
    .filter(a => a.length > 0);

  if (!name) {
    document.getElementById('entity-name').focus();
    return;
  }

  const d = {
    id: nextId++,
    title: name,
    entityType: type,
    aliases,
    content: '',
    synopsis: '',
    status: 'draft',
    target: 0,
    storyDate: '',
    banner: '',
    tags: [type],
    parent: null,
    isFolder: false,
    section: 'research',
    createdAt: new Date()
  };

  docs.push(d);
  closeEntityModal();
  renderTree();
  loadDoc(d.id);
}

/* ────────────────────────────────────────
   Context Menu
──────────────────────────────────────── */
function showCtx(e, id) {
  ctxTargetId = id;
  const m = document.getElementById('ctx-menu');
  m.style.display = 'block';
  m.style.left    = Math.min(e.clientX, window.innerWidth  - 180) + 'px';
  m.style.top     = Math.min(e.clientY, window.innerHeight - 150) + 'px';
}

function hideCtx() {
  document.getElementById('ctx-menu').style.display = 'none';
}

/* ────────────────────────────────────────
   View Modes
──────────────────────────────────────── */
function setMode(mode, skipSave = false) {
  currentMode = mode;
  document.body.dataset.view = mode;
  if (!skipSave) {
    saveCurrentDoc();
    saveCharacterView();
  }

  ['editor', 'cork', 'outline', 'timeline', 'board', 'bible'].forEach(m => {
    const btnId = m === 'editor'  ? 'btn-editor'
                : m === 'cork'    ? 'btn-cork'
                : m === 'outline' ? 'btn-outline'
                : m === 'timeline'? 'btn-timeline'
                : m === 'board'   ? 'btn-board'
                : 'btn-bible';
    document.getElementById(btnId).classList.toggle('active', m === mode);
  });

  document.getElementById('editor-scroll').className  = mode === 'editor'   ? '' : 'hidden';
  document.getElementById('editor-toolbar').className = mode === 'editor'   ? '' : 'hidden';
  document.getElementById('corkboard').className      = mode === 'cork'     ? 'active' : '';
  document.getElementById('outline-view').className   = mode === 'outline'  ? 'active' : '';
  document.getElementById('timeline-view').className  = mode === 'timeline' ? 'active' : '';
  document.getElementById('character-view').className  = mode === 'characters' ? 'active' : '';
  document.getElementById('board-view').className     = mode === 'board'    ? 'active' : '';
  document.getElementById('bible-view').className     = mode === 'bible'    ? 'active' : '';

  if (mode === 'cork')     buildCork();
  if (mode === 'outline')  buildOutline();
  if (mode === 'timeline') buildTimeline();
  if (mode === 'board')    buildBoard();
  if (mode === 'bible')    buildBible();
  if (mode === 'characters') loadCharacterView();

  // The writing page can't edit a character, so going to it from a character card
  // opens the book's first chapter instead of a blank page that never saves.
  if (mode === 'editor') {
    const active = docs.find(x => x.id === activeId);
    if (active && active.entityType === 'character') {
      const target = docs.find(x => x.section === 'manuscript' && !x.isFolder)
        || docs.find(x => !x.isFolder && x.entityType !== 'character');
      if (target) loadDoc(target.id);
    }
  }
}

function buildCork() {
  const ms = docs.filter(d => d.section === 'manuscript');
  document.getElementById('cork-grid').innerHTML = ms.map(d => {
    const snippet  = d.content.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 240);
    const pinColor = d.id === activeId ? 'var(--accent)' : 'var(--text-faint)';
    return `<div class="cork-card" data-id="${d.id}">
      <div class="cork-pin" style="background:${pinColor}"></div>
      <div class="cork-title">${d.title}</div>
      <div class="cork-snippet">${snippet || '(empty)'}</div>
      <div class="cork-meta">
        <span><span class="cork-status" style="background:${STATUS_COLORS[d.status]}"></span>${d.status}</span>
        <span>${countWords(d.content)} w</span>
      </div>
    </div>`;
  }).join('');

  document.querySelectorAll('.cork-card').forEach(card => {
    card.addEventListener('click', () => {
      setMode('editor');
      loadDoc(+card.dataset.id);
    });
  });
}

function buildOutline() {
  const ms = docs.filter(d => d.section === 'manuscript');
  document.getElementById('outline-list').innerHTML = ms.map((d, i) => `
    <div class="outline-row ${d.id === activeId ? 'active' : ''}" data-id="${d.id}">
      <span class="outline-num">${String(i + 1).padStart(2, '0')}</span>
      <span class="outline-name">${d.title}</span>
      <span class="outline-wc">${countWords(d.content).toLocaleString()}</span>
      <span class="outline-status" style="background:${STATUS_COLORS[d.status]}"></span>
    </div>`).join('');

  document.querySelectorAll('.outline-row').forEach(row => {
    row.addEventListener('click', () => {
      setMode('editor');
      loadDoc(+row.dataset.id);
    });
  });
}

function buildTimeline() {
  const ms      = docs.filter(d => d.section === 'manuscript');
  const dated   = ms.filter(d => d.storyDate).sort((a, b) => new Date(a.storyDate) - new Date(b.storyDate));
  const undated = ms.filter(d => !d.storyDate);

  const container = document.getElementById('timeline-view');

  const datedHTML = dated.map((d, i) => {
    const date = new Date(d.storyDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    return `
      <div class="tl-item" data-id="${d.id}">
        <div class="tl-date">${date}</div>
        <div class="tl-dot" style="background:${STATUS_COLORS[d.status]}"></div>
        <div class="tl-card ${d.id === activeId ? 'active' : ''}">
          <div class="tl-card-num">${String(i + 1).padStart(2, '0')}</div>
          <div class="tl-card-title">${d.title}</div>
          <div class="tl-card-wc">${countWords(d.content).toLocaleString()} words</div>
        </div>
      </div>`;
  }).join('');

  const undatedHTML = undated.length ? `
    <div class="tl-undated-label">Undated</div>
    <div class="tl-items">
      ${undated.map(d => `
        <div class="tl-item" data-id="${d.id}">
          <div class="tl-date">—</div>
          <div class="tl-dot" style="background:${STATUS_COLORS[d.status]}"></div>
          <div class="tl-card ${d.id === activeId ? 'active' : ''}">
            <div class="tl-card-num">—</div>
            <div class="tl-card-title">${d.title}</div>
            <div class="tl-card-wc">${countWords(d.content).toLocaleString()} words</div>
          </div>
        </div>`).join('')}
    </div>` : '';

  container.innerHTML = `
    <div class="tl-wrap">
      <div class="tl-items">${datedHTML}</div>
      <div class="tl-axis"></div>
      ${undatedHTML}
    </div>`;

  container.querySelectorAll('.tl-item').forEach(el => {
    el.addEventListener('click', () => {
      setMode('editor');
      loadDoc(+el.dataset.id);
    });
  });
}

/* ────────────────────────────────────────
   Character Sketch
──────────────────────────────────────── */
function loadCharacterView() {
  const d = docs.find(x => x.id === activeId);
  if (!d) return;
  document.getElementById('char-name-edit').value = d.title;
  const activeTab = document.querySelector('.char-tab.active');
  const field = activeTab ? activeTab.dataset.field : 'appearance';
  const label = activeTab ? activeTab.textContent : 'Physical appearance';
  document.getElementById('char-section-title').textContent = label;
  document.getElementById('char-field-area').value = (d.charFields || {})[field] || '';
  document.querySelectorAll('.char-photo-slot').forEach((slot, i) => {
    const url = (d.charPhotos || [])[i];
    slot.style.backgroundImage = url ? `url('${url}')` : ''; // clear photos left from the previous character
  });
  document.querySelectorAll('.char-tab').forEach(tab => {
    tab.onclick = () => {
      saveCharacterView();
      document.querySelectorAll('.char-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      document.getElementById('char-section-title').textContent = tab.textContent;
      const d2 = docs.find(x => x.id === activeId);
      document.getElementById('char-field-area').value = (d2.charFields || {})[tab.dataset.field] || '';
    };
  });
  document.querySelectorAll('.char-photo-input').forEach((input, i) => {
    input.onchange = e => {
      const file = e.target.files[0];
      if (!file) return;
      const docId = activeId;
      prepareStoredPicture(file, 800).then(url => {
        const d2 = docs.find(x => x.id === docId);
        if (!d2) return;
        if (!d2.charPhotos) d2.charPhotos = [];
        d2.charPhotos[i] = url;
        if (docId === activeId) {
          const slot = document.getElementById('char-photo-' + i);
          slot.style.backgroundImage = `url('${url}')`;
          slot.style.backgroundSize = 'cover';
          slot.style.backgroundPosition = 'center';
        }
        schedulePersist();
      }).catch(() => alert(`Folio couldn't open "${file.name}" as a picture. If it's a photo, try exporting it from Photos as a JPEG first.`));
    };
  });
}

function saveCharacterView() {
  const d = docs.find(x => x.id === activeId);
  if (!d || d.entityType !== 'character') return;
  const activeTab = document.querySelector('.char-tab.active');
  if (!activeTab) return;
  if (!d.charFields) d.charFields = {};
  d.charFields[activeTab.dataset.field] = document.getElementById('char-field-area').value;
  d.title = document.getElementById('char-name-edit').value || d.title;
  renderTree();
}

/* ────────────────────────────────────────
   Story Board
   A freeform board for every kind of story card. Nothing needs a date or a
   chapter to be placed or moved. Positions live on each doc as
   d.boardPos[arrangementId] = {x, y[, w, h]}, so they save and sync with the
   project like everything else. Board-only cards (ideas, questions, zones and
   what-if arrangements) are docs in section 'board', which the binder,
   manuscript tools and Claude connector all skip.
──────────────────────────────────────── */
const BOARD_ARR_KEY    = 'folio-board-arrangement';
const BOARD_LENS_KEY   = 'folio-board-lens';
const BOARD_HIDDEN_KEY = 'folio-board-hidden';
const BOARD_TRIAL_MIN  = 120;   // a drag farther than this becomes a "trying it here"
const BOARD_KINDS = {
  scene:     { label: 'Scene',     plural: 'Scenes' },
  chapter:   { label: 'Chapter',   plural: 'Chapters' },
  event:     { label: 'Event',     plural: 'Events' },
  character: { label: 'Character', plural: 'Characters' },
  place:     { label: 'Place',     plural: 'Places' },
  object:    { label: 'Object',    plural: 'Objects' },
  idea:      { label: 'Idea',      plural: 'Ideas' },
  question:  { label: 'Question',  plural: 'Questions' },
  zone:      { label: 'Zone',      plural: 'Zones' }
};
const BOARD_THREAD_COLORS = ['#4d7ea8', '#c0712f', '#8a5aa8', '#2f8a7a', '#b04a5a', '#6b7a2f'];

let boardPan            = { x: 0, y: 0 };
let boardZoom           = 1;
let boardShowThreads    = true;
let boardTrial          = null;   // { id, from: {x, y} }
let boardSelected       = null;
let boardEventsAttached = false;
let boardParentIds      = new Set();
let boardMentions       = new Map(); // character id -> Set of scene ids
let boardAddCount       = 0;

function boardStore(key, value) {
  try { localStorage.setItem(`${key}:${currentProjectId}`, value); } catch (e) { /* ignore */ }
}
function boardRead(key) {
  try { return localStorage.getItem(`${key}:${currentProjectId}`); } catch (e) { return null; }
}

function boardLens() {
  const lens = boardRead(BOARD_LENS_KEY);
  return ['freeform', 'chapters', 'timeline'].includes(lens) ? lens : 'freeform';
}
function boardHiddenKinds() {
  try { return new Set(JSON.parse(boardRead(BOARD_HIDDEN_KEY) || '[]')); } catch (e) { return new Set(); }
}
function boardArrangements() {
  return docs.filter(d => d.section === 'board' && d.boardKind === 'arrangement');
}
function boardArrangementId() {
  const id = boardRead(BOARD_ARR_KEY) || 'main';
  return id === 'main' || boardArrangements().some(a => String(a.id) === id) ? id : 'main';
}
function setBoardArrangement(id) {
  boardStore(BOARD_ARR_KEY, String(id));
  boardTrial = null;
  buildBoard();
}

function boardKind(d) {
  if (d.section === 'manuscript') return d.isFolder || boardParentIds.has(d.id) ? 'chapter' : 'scene';
  if (d.section === 'board') return ['idea', 'question', 'zone'].includes(d.boardKind) ? d.boardKind : null;
  if (d.entityType === 'character') return 'character';
  if (d.entityType === 'location')  return 'place';
  if (d.entityType === 'event')     return 'event';
  if (d.entityType === 'object')    return 'object';
  return null;
}
function boardPos(d, arr = boardArrangementId()) {
  return d.boardPos ? d.boardPos[arr] : undefined;
}
function setBoardPos(d, pos, arr = boardArrangementId()) {
  if (!d.boardPos) d.boardPos = {};
  if (pos) d.boardPos[arr] = pos; else delete d.boardPos[arr];
}
function boardText(d, max = 110) {
  const src = d.synopsis || (d.content || '').replace(/<[^>]+>/g, ' ');
  const text = src.replace(/\s+/g, ' ').trim();
  return text.length > max ? text.slice(0, max - 1) + '…' : text;
}
function boardDate(value) {
  if (!value) return '';
  const date = new Date(value + (value.length === 10 ? 'T00:00:00' : ''));
  return isNaN(date) ? value : date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}
function boardChapterOf(d) {
  const parent = d.parent != null ? docs.find(x => x.id === d.parent) : null;
  return parent && parent.section === 'manuscript' ? parent : null;
}

/* First visit: lay the manuscript out in chapter columns so the board isn't
   empty. After that, new cards wait in the Loose cards tray. */
function ensureBoardLayout() {
  if (docs.some(d => d.boardPos)) return;
  const ms = docs.filter(d => d.section === 'manuscript');
  const chapters = ms.filter(d => boardKind(d) === 'chapter');
  let col = 0;
  chapters.forEach(ch => {
    setBoardPos(ch, { x: 40 + col * 260, y: 90 }, 'main');
    ms.filter(d => d.parent === ch.id && boardKind(d) === 'scene').forEach((s, i) => {
      setBoardPos(s, { x: 40 + col * 260, y: 160 + i * 150 }, 'main');
    });
    col++;
  });
  ms.filter(d => boardKind(d) === 'scene' && !boardPos(d, 'main')).forEach((s, i) => {
    setBoardPos(s, { x: 40 + (col + (i % 3)) * 260, y: 90 + Math.floor(i / 3) * 150 }, 'main');
  });
  docs.forEach(d => { if (boardKind(d) && !d.boardPos) d.boardPos = {}; });
  schedulePersist();
}

function computeBoardMentions() {
  boardMentions = new Map();
  const scenes = docs.filter(d => d.section === 'manuscript' && !boardParentIds.has(d.id) && !d.isFolder)
    .map(d => ({ id: d.id, text: (d.title + ' ' + (d.content || '').replace(/<[^>]+>/g, ' ')).toLowerCase() }));
  docs.filter(d => d.entityType === 'character' || d.entityType === 'location').forEach(e => {
    const names = [e.title, ...(e.aliases || [])].filter(n => n && n.trim().length > 1).map(n => n.toLowerCase());
    const hits = new Set(scenes.filter(s => names.some(n => s.text.includes(n))).map(s => s.id));
    boardMentions.set(e.id, hits);
  });
}

function buildBoard() {
  boardParentIds = new Set(docs.filter(d => d.parent != null).map(d => d.parent));
  ensureBoardLayout();
  computeBoardMentions();
  const lens = boardLens();
  renderBoardTopbar(lens);
  renderBoardTray();
  document.getElementById('board-stage').hidden = lens !== 'freeform';
  document.getElementById('board-lens').hidden  = lens === 'freeform';
  if (lens === 'freeform') renderBoardWorld();
  else if (lens === 'chapters') renderChaptersLens();
  else renderTimelineLens();
  attachBoardEvents();
}

/* ── Top bar ── */
function renderBoardTopbar(lens) {
  document.querySelectorAll('#board-lens-switch button').forEach(b => {
    const on = b.dataset.lens === lens;
    b.classList.toggle('active', on);
    b.setAttribute('aria-pressed', String(on));
  });
  const arr = boardArrangementId();
  const select = document.getElementById('board-arr');
  select.innerHTML = `<option value="main">Main</option>` +
    boardArrangements().map(a => `<option value="${a.id}">${escapeHTML(a.title)}</option>`).join('');
  select.value = arr;
  const freeform = lens === 'freeform';
  document.getElementById('board-arr-wrap').hidden = !freeform;
  document.getElementById('board-arr-keep').hidden = arr === 'main';
  document.getElementById('board-arr-discard').hidden = arr === 'main';
  document.getElementById('board-btn-thread').hidden = !freeform;
  document.getElementById('board-btn-reset').hidden = !freeform;
  document.getElementById('board-btn-thread').classList.toggle('active', boardShowThreads);
  document.getElementById('board-btn-thread').setAttribute('aria-pressed', String(boardShowThreads));
}

/* ── Loose cards tray ── */
function boardEligible() {
  return docs.filter(d => boardKind(d));
}
function renderBoardTray() {
  const hidden = boardHiddenKinds();
  const all = boardEligible();
  const loose = all.filter(d => !boardPos(d) && !hidden.has(boardKind(d)));
  const order = Object.keys(BOARD_KINDS);
  loose.sort((a, b) => order.indexOf(boardKind(a)) - order.indexOf(boardKind(b)));
  const list = document.getElementById('board-tray-list');
  list.innerHTML = loose.length
    ? loose.map(d => {
        const kind = boardKind(d);
        const boardOnly = d.section === 'board';
        return `<div class="btray-item bk-${kind}" draggable="true" data-id="${d.id}">
          <span class="bcard-kind">${BOARD_KINDS[kind].label}</span>
          <span class="btray-title">${escapeHTML(d.title || (kind === 'question' ? 'Untitled question' : 'Untitled idea'))}</span>
          ${boardOnly ? `<button class="btray-del" data-del="${d.id}" title="Delete this ${BOARD_KINDS[kind].label.toLowerCase()}" aria-label="Delete ${escapeHTML(d.title || BOARD_KINDS[kind].label)}">×</button>` : ''}
        </div>`;
      }).join('')
    : `<div class="btray-empty">Everything is on the board. Drag a card here to set it aside.</div>`;

  const counts = {};
  all.forEach(d => { const k = boardKind(d); counts[k] = (counts[k] || 0) + 1; });
  document.getElementById('board-filters').innerHTML = order.filter(k => counts[k]).map(k =>
    `<button class="bfilter ${hidden.has(k) ? '' : 'on'}" data-kind="${k}" aria-pressed="${!hidden.has(k)}">${BOARD_KINDS[k].plural} ${counts[k]}</button>`
  ).join('');
}

/* ── Freeform canvas ── */
function boardCardHTML(d, kind, pos) {
  const style = `left:${pos.x}px;top:${pos.y}px`;
  const sel = boardSelected === d.id ? ' selected' : '';
  const trying = boardTrial && boardTrial.id === d.id ? ' trying' : '';
  const remove = `<button class="bcard-x" data-loose="${d.id}" title="Move to Loose cards" aria-label="Move ${escapeHTML(d.title)} to Loose cards">×</button>`;
  const cls = `bcard bk-${kind}${sel}${trying}`;
  if (kind === 'chapter') {
    const n = docs.filter(x => x.parent === d.id).length;
    return `<div class="${cls}" data-id="${d.id}" style="${style}">
      <span class="bcard-kind">Chapter</span><span class="bcard-title">${escapeHTML(d.title)}</span>
      <span class="bcard-count">${n} scene${n === 1 ? '' : 's'}</span>${remove}</div>`;
  }
  if (kind === 'character') {
    const photo = d.charPhotos && d.charPhotos.find(Boolean);
    const n = (boardMentions.get(d.id) || new Set()).size;
    const color = boardThreadColor(d.id);
    return `<div class="${cls}" data-id="${d.id}" style="${style}">
      <span class="bcard-avatar" style="background-color:${color};${photo ? `background-image:url('${photo}')` : ''}">${photo ? '' : escapeHTML((d.title || '?').trim().charAt(0).toUpperCase())}</span>
      <span class="bcard-who"><span class="bcard-title">${escapeHTML(d.title)}</span><span class="bcard-sub">in ${n} scene${n === 1 ? '' : 's'}</span></span>${remove}</div>`;
  }
  if (kind === 'idea' || kind === 'question') {
    return `<div class="${cls}" data-id="${d.id}" style="${style}">
      <span class="bcard-kind">${BOARD_KINDS[kind].label}</span>
      <span class="bcard-title bcard-editable" data-placeholder="${kind === 'idea' ? 'What if…' : 'What do I need to figure out?'}">${escapeHTML(d.title)}</span>${remove}</div>`;
  }
  const meta = [];
  if (kind === 'scene') {
    const ch = boardChapterOf(d);
    meta.push(ch ? `<span class="bchip">${escapeHTML(ch.title)}</span>` : `<span class="bchip off">no chapter</span>`);
    meta.push(d.storyDate ? `<span class="bchip">${boardDate(d.storyDate)}</span>` : `<span class="bchip off">no date</span>`);
  } else if (d.storyDate) {
    meta.push(`<span class="bchip">${boardDate(d.storyDate)}</span>`);
  }
  const snip = boardText(d, kind === 'scene' ? 110 : 70);
  const status = kind === 'scene'
    ? `<span class="bcard-status" style="background:${STATUS_COLORS[d.status] || STATUS_COLORS.draft}" title="${escapeHTML(d.status || 'draft')}"></span>` : '';
  const thread = kind === 'scene'
    ? `<button class="bcard-thread ${d.inThread ? 'on' : ''}" data-thread="${d.id}" title="${d.inThread ? 'Take off the red thread' : 'Add to the red thread'}" aria-pressed="${!!d.inThread}" aria-label="Red thread"></button>` : '';
  return `<div class="${cls}" data-id="${d.id}" style="${style}">
    <span class="bcard-kind">${BOARD_KINDS[kind].label}${status}</span>
    <span class="bcard-title">${escapeHTML(d.title)}</span>
    ${snip ? `<span class="bcard-snip">${escapeHTML(snip)}</span>` : ''}
    ${meta.length ? `<span class="bcard-meta">${meta.join('')}</span>` : ''}
    ${thread}${remove}</div>`;
}

function renderBoardWorld() {
  const world = document.getElementById('board-world');
  const hidden = boardHiddenKinds();
  const placed = boardEligible().filter(d => boardPos(d) && !hidden.has(boardKind(d)));
  const zones = placed.filter(d => boardKind(d) === 'zone');
  const cards = placed.filter(d => boardKind(d) !== 'zone');

  const zoneHTML = zones.map(z => {
    const p = boardPos(z);
    return `<div class="bzone${boardSelected === z.id ? ' selected' : ''}" data-id="${z.id}" style="left:${p.x}px;top:${p.y}px;width:${p.w || 360}px;height:${p.h || 300}px">
      <span class="bzone-label bcard-editable" data-placeholder="Name this zone">${escapeHTML(z.title)}</span>
      <button class="bcard-x" data-loose="${z.id}" title="Move to Loose cards" aria-label="Move zone ${escapeHTML(z.title)} to Loose cards">×</button>
      <span class="bzone-resize" aria-hidden="true"></span>
    </div>`;
  }).join('');

  let trialHTML = '';
  const trialDoc = boardTrial && docs.find(d => d.id === boardTrial.id);
  if (trialDoc && boardPos(trialDoc)) {
    const now = boardPos(trialDoc);
    trialHTML = `<div class="bghost" style="left:${boardTrial.from.x}px;top:${boardTrial.from.y}px">
        <span class="bcard-kind">Was here</span><span>${escapeHTML(trialDoc.title)}</span></div>
      <div class="btrial" style="left:${now.x}px;top:${now.y}px" role="group" aria-label="Trying it here">
        <span>Trying it here</span>
        <button data-trial="keep" class="primary">Keep</button>
        <button data-trial="back">Put back</button>
        <button data-trial="both" title="Save this as a what-if arrangement and keep the original too">Keep both</button>
      </div>`;
  } else {
    boardTrial = null;
  }

  world.innerHTML = `<div class="bzones">${zoneHTML}</div>
    <svg id="board-threads" class="bthreads" width="1" height="1" aria-hidden="true"></svg>
    ${trialHTML}
    ${cards.map(d => boardCardHTML(d, boardKind(d), boardPos(d))).join('')}`;

  document.getElementById('board-empty').hidden = placed.length > 0;
  applyBoardTransform();
}

function applyBoardTransform() {
  const world = document.getElementById('board-world');
  world.style.transform = `translate(${boardPan.x}px, ${boardPan.y}px) scale(${boardZoom})`;
  document.getElementById('board-zoom-level').textContent = Math.round(boardZoom * 100) + '%';
  const stage = document.getElementById('board-stage');
  stage.style.backgroundPosition = `${boardPan.x}px ${boardPan.y}px`;
  stage.style.backgroundSize = `${22 * boardZoom}px ${22 * boardZoom}px`;
  drawBoardThreads();
  drawBoardMinimap();
}

function boardThreadColor(id) {
  const chars = docs.filter(d => d.entityType === 'character');
  const i = Math.max(0, chars.findIndex(d => d.id === id));
  return BOARD_THREAD_COLORS[i % BOARD_THREAD_COLORS.length];
}

function boardCenter(el) {
  return { x: el.offsetLeft + el.offsetWidth / 2, y: el.offsetTop + el.offsetHeight / 2 };
}

function drawBoardThreads() {
  const svg = document.getElementById('board-threads');
  if (!svg) return;
  if (!boardShowThreads) { svg.innerHTML = ''; return; }
  const els = {};
  document.querySelectorAll('#board-world .bcard').forEach(el => { els[el.dataset.id] = el; });
  const paths = [];
  const curve = (a, b) => {
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2 + Math.min(80, Math.abs(a.x - b.x) * 0.15);
    return `M${a.x} ${a.y} Q${mx} ${my} ${b.x} ${b.y}`;
  };
  boardMentions.forEach((sceneIds, entityId) => {
    const from = els[entityId];
    if (!from) return;
    const entity = docs.find(d => d.id === entityId);
    const color = entity && entity.entityType === 'location' ? '#2f8a7a' : boardThreadColor(entityId);
    const focus = boardSelected == null || boardSelected === entityId || sceneIds.has(boardSelected);
    sceneIds.forEach(sid => {
      const to = els[sid];
      if (!to) return;
      paths.push(`<path d="${curve(boardCenter(from), boardCenter(to))}" stroke="${color}" stroke-width="${focus && boardSelected != null ? 2.5 : 1.75}" fill="none" opacity="${focus ? 0.75 : 0.12}"/>`);
    });
  });
  const threaded = docs.filter(d => d.section === 'manuscript' && d.inThread && els[d.id]);
  for (let i = 0; i < threaded.length - 1; i++) {
    paths.push(`<path d="${curve(boardCenter(els[threaded[i].id]), boardCenter(els[threaded[i + 1].id]))}" stroke="#b04a3a" stroke-width="2" stroke-dasharray="6 6" fill="none" opacity=".85"/>`);
  }
  if (boardTrial) {
    const el = els[boardTrial.id];
    if (el) {
      const to = boardCenter(el);
      const from = { x: boardTrial.from.x + 90, y: boardTrial.from.y + 40 };
      paths.push(`<path d="${curve(from, to)}" stroke="var(--accent)" stroke-width="2" stroke-dasharray="5 5" fill="none"/>`);
    }
  }
  svg.innerHTML = paths.join('');
}

function drawBoardMinimap() {
  const c = document.getElementById('board-mm-canvas');
  const stage = document.getElementById('board-stage');
  if (!c || !stage) return;
  const ctx = c.getContext('2d');
  const W = c.width, H = c.height;
  ctx.clearRect(0, 0, W, H);
  const rects = [...document.querySelectorAll('#board-world .bcard, #board-world .bzone')]
    .map(el => ({ x: el.offsetLeft, y: el.offsetTop, w: el.offsetWidth, h: el.offsetHeight, zone: el.classList.contains('bzone') }));
  const view = { x: -boardPan.x / boardZoom, y: -boardPan.y / boardZoom, w: stage.clientWidth / boardZoom, h: stage.clientHeight / boardZoom };
  const all = [...rects, view];
  const minX = Math.min(...all.map(r => r.x)), minY = Math.min(...all.map(r => r.y));
  const maxX = Math.max(...all.map(r => r.x + r.w)), maxY = Math.max(...all.map(r => r.y + r.h));
  const s = Math.min((W - 8) / (maxX - minX || 1), (H - 8) / (maxY - minY || 1));
  const tx = x => 4 + (x - minX) * s, ty = y => 4 + (y - minY) * s;
  const css = getComputedStyle(document.documentElement);
  rects.forEach(r => {
    ctx.fillStyle = r.zone ? 'rgba(127,140,120,.18)' : (css.getPropertyValue('--text-faint').trim() || '#879181');
    ctx.fillRect(tx(r.x), ty(r.y), Math.max(2, r.w * s), Math.max(2, r.h * s));
  });
  ctx.strokeStyle = css.getPropertyValue('--accent').trim() || '#5f7355';
  ctx.lineWidth = 1.5;
  ctx.strokeRect(tx(view.x), ty(view.y), view.w * s, view.h * s);
}

/* Screen point → board coordinates */
function boardWorldPoint(clientX, clientY) {
  const r = document.getElementById('board-stage').getBoundingClientRect();
  return { x: (clientX - r.left - boardPan.x) / boardZoom, y: (clientY - r.top - boardPan.y) / boardZoom };
}

function boardOverTray(clientX, clientY) {
  const r = document.getElementById('board-tray').getBoundingClientRect();
  return clientX >= r.left && clientX <= r.right && clientY >= r.top && clientY <= r.bottom;
}

function startBoardDrag(e, d, el, mode) {
  const pos = boardPos(d);
  if (!pos) return;
  const start = { x: e.clientX, y: e.clientY };
  const orig = { ...pos };
  const tray = document.getElementById('board-tray');
  let moved = false;
  // Moving a zone carries the cards sitting inside it.
  let riders = [];
  if (mode === 'move' && boardKind(d) === 'zone') {
    const w = pos.w || 360, h = pos.h || 300;
    riders = [...document.querySelectorAll('#board-world .bcard')].map(cardEl => {
      const c = boardCenter(cardEl);
      if (c.x < pos.x || c.x > pos.x + w || c.y < pos.y || c.y > pos.y + h) return null;
      const doc = docs.find(x => x.id === +cardEl.dataset.id);
      return doc ? { doc, el: cardEl, orig: { ...boardPos(doc) } } : null;
    }).filter(Boolean);
  }

  const onMove = ev => {
    const dx = (ev.clientX - start.x) / boardZoom, dy = (ev.clientY - start.y) / boardZoom;
    if (!moved && Math.hypot(dx, dy) < 3) return;
    if (!moved) {
      moved = true;
      el.classList.add('dragging');
      document.querySelectorAll('#board-world .btrial').forEach(t => t.remove());
    }
    if (mode === 'resize') {
      pos.w = Math.max(160, Math.round(orig.w + dx));
      pos.h = Math.max(120, Math.round(orig.h + dy));
      el.style.width = pos.w + 'px';
      el.style.height = pos.h + 'px';
    } else {
      pos.x = Math.round(orig.x + dx);
      pos.y = Math.round(orig.y + dy);
      el.style.left = pos.x + 'px';
      el.style.top = pos.y + 'px';
      riders.forEach(r => {
        const rp = boardPos(r.doc);
        rp.x = r.orig.x + Math.round(dx);
        rp.y = r.orig.y + Math.round(dy);
        r.el.style.left = rp.x + 'px';
        r.el.style.top = rp.y + 'px';
      });
      tray.classList.toggle('drop-target', boardOverTray(ev.clientX, ev.clientY));
    }
    drawBoardThreads();
  };

  const onUp = ev => {
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('mouseup', onUp);
    el.classList.remove('dragging');
    tray.classList.remove('drop-target');
    if (!moved) return;
    if (mode === 'move' && boardOverTray(ev.clientX, ev.clientY)) {
      setBoardPos(d, null);
      if (boardTrial && boardTrial.id === d.id) boardTrial = null;
      renderBoardTray();
    } else if (mode === 'move' && boardKind(d) !== 'zone') {
      const from = boardTrial && boardTrial.id === d.id ? boardTrial.from : orig;
      const far = Math.hypot(pos.x - from.x, pos.y - from.y) > BOARD_TRIAL_MIN;
      // Starting to try a different card keeps whatever the last try was.
      boardTrial = far ? { id: d.id, from } : (boardTrial && boardTrial.id === d.id ? null : boardTrial);
    }
    renderBoardWorld();
    schedulePersist();
  };
  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);
}

function resolveBoardTrial(action) {
  if (!boardTrial) return;
  const d = docs.find(x => x.id === boardTrial.id);
  if (d && action === 'back') {
    const pos = boardPos(d);
    pos.x = boardTrial.from.x;
    pos.y = boardTrial.from.y;
  }
  if (d && action === 'both') {
    const current = boardArrangementId();
    const n = boardArrangements().length + 1;
    const arr = {
      id: nextId++, title: `What-if ${n}: ${(d.title || 'card').slice(0, 30)} moved`,
      section: 'board', boardKind: 'arrangement', content: '', synopsis: '', status: 'draft',
      target: 0, storyDate: '', banner: '', tags: [], parent: null, isFolder: false, createdAt: new Date()
    };
    docs.push(arr);
    docs.forEach(x => {
      const p = boardPos(x, current);
      if (p) setBoardPos(x, { ...p }, String(arr.id));
    });
    const original = boardPos(d, current);
    original.x = boardTrial.from.x;
    original.y = boardTrial.from.y;
    boardTrial = null;
    schedulePersist();
    setBoardArrangement(arr.id);
    return;
  }
  boardTrial = null;
  renderBoardWorld();
  schedulePersist();
}

function editBoardText(el, d) {
  el.contentEditable = 'true';
  el.focus();
  const range = document.createRange();
  range.selectNodeContents(el);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
  const before = d.title;
  const finish = cancel => {
    el.contentEditable = 'false';
    el.removeEventListener('blur', onBlur);
    el.removeEventListener('keydown', onKey);
    d.title = cancel ? before : el.textContent.trim();
    if (!cancel && !d.title && d.section !== 'board') d.title = before || 'Untitled';
    el.textContent = d.title;
    if (d.section !== 'board') renderTree();
    renderBoardTray();
    drawBoardThreads();
    schedulePersist();
  };
  const onBlur = () => finish(false);
  const onKey = ev => {
    if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); el.blur(); }
    if (ev.key === 'Escape') { ev.preventDefault(); finish(true); }
  };
  el.addEventListener('blur', onBlur);
  el.addEventListener('keydown', onKey);
}

function openFromBoard(d) {
  if (d.section === 'board') return;
  if (d.entityType === 'character') { loadDoc(d.id); return; }
  setMode('editor');
  loadDoc(d.id);
}

function addBoardCard(kind, placeAt) {
  const base = { content: '', synopsis: '', status: 'draft', target: 0, storyDate: '', banner: '', tags: [], parent: null, isFolder: false, createdAt: new Date(), boardPos: {} };
  let d;
  if (kind === 'scene')   d = { ...base, title: 'New scene', section: 'manuscript' };
  if (kind === 'chapter') d = { ...base, title: 'New chapter', section: 'manuscript', isFolder: true };
  if (['character', 'place', 'event', 'object'].includes(kind)) {
    const type = kind === 'place' ? 'location' : kind;
    d = { ...base, title: `New ${BOARD_KINDS[kind].label.toLowerCase()}`, entityType: type, aliases: [], tags: [type], section: 'research' };
  }
  if (['idea', 'question', 'zone'].includes(kind)) {
    d = { ...base, title: kind === 'zone' ? 'New zone' : '', section: 'board', boardKind: kind };
  }
  if (!d) return;
  d.id = nextId++;
  docs.push(d);
  if (placeAt !== false) {
    const stage = document.getElementById('board-stage');
    const offset = (boardAddCount++ % 6) * 24;
    const p = placeAt || {
      x: Math.round((stage.clientWidth / 2 - boardPan.x) / boardZoom - 100 + offset),
      y: Math.round((stage.clientHeight / 2 - boardPan.y) / boardZoom - 60 + offset)
    };
    setBoardPos(d, kind === 'zone' ? { x: p.x - 80, y: p.y - 80, w: 360, h: 300 } : p);
  }
  if (d.section !== 'board') renderTree();
  schedulePersist();
  return d;
}

/* ── Chapters lens: the only place the board changes the manuscript ── */
function renderChaptersLens() {
  const lens = document.getElementById('board-lens');
  const ms = docs.filter(d => d.section === 'manuscript');
  const chapters = ms.filter(d => boardKind(d) === 'chapter');
  const scenes = ms.filter(d => boardKind(d) === 'scene');
  const chapterIds = new Set(chapters.map(c => c.id));
  const columns = chapters.map(ch => ({ id: ch.id, title: ch.title, items: scenes.filter(s => s.parent === ch.id) }));
  columns.push({ id: '', title: 'No chapter yet', items: scenes.filter(s => !chapterIds.has(s.parent)), loose: true });
  const card = s => `<div class="blens-card" draggable="true" data-id="${s.id}">
      <span class="bcard-kind">Scene<span class="bcard-status" style="background:${STATUS_COLORS[s.status] || STATUS_COLORS.draft}"></span></span>
      <span class="bcard-title">${escapeHTML(s.title)}</span>
      ${s.storyDate ? `<span class="bcard-meta"><span class="bchip">${boardDate(s.storyDate)}</span></span>` : ''}
    </div>`;
  lens.innerHTML = `<p class="blens-hint">Drag scenes between chapters to change the manuscript. Scenes without a chapter have their own column.</p>
    <div class="blens-cols">${columns.map(col => `
      <section class="blens-col${col.loose ? ' loose' : ''}" data-chapter="${col.id}">
        <h3>${escapeHTML(col.title)}<span>${col.items.length}</span></h3>
        <div class="blens-list">${col.items.map(card).join('') || '<div class="blens-empty">Drop scenes here</div>'}</div>
      </section>`).join('')}</div>`;
}

function moveSceneToChapter(id, chapterId, beforeId) {
  const d = docs.find(x => x.id === id);
  if (!d || d.id === beforeId) return;
  docs.splice(docs.indexOf(d), 1);
  d.parent = chapterId || null;
  let at;
  if (beforeId) at = docs.findIndex(x => x.id === beforeId);
  else {
    const siblings = docs.filter(x => x.section === 'manuscript' && (x.parent || null) === d.parent && !x.isFolder && !boardParentIds.has(x.id));
    const last = siblings[siblings.length - 1];
    at = last ? docs.indexOf(last) + 1 : (chapterId ? docs.findIndex(x => x.id === chapterId) + 1 : docs.length);
  }
  docs.splice(at < 0 ? docs.length : at, 0, d);
  renderTree();
  buildBoard();
}

/* ── Timeline lens: dates are optional ── */
function renderTimelineLens() {
  const lens = document.getElementById('board-lens');
  const items = docs.filter(d => ['scene', 'event'].includes(boardKind(d)));
  const dated = items.filter(d => d.storyDate).sort((a, b) => String(a.storyDate).localeCompare(String(b.storyDate)));
  const undated = items.filter(d => !d.storyDate && boardKind(d) === 'scene');
  const card = d => {
    const kind = boardKind(d);
    return `<button class="blens-card bk-${kind}" data-open="${d.id}">
      <span class="bcard-kind">${BOARD_KINDS[kind].label}</span>
      <span class="bcard-title">${escapeHTML(d.title)}</span>
    </button>`;
  };
  lens.innerHTML = `<p class="blens-hint">Dated scenes and events sit on the line. Scenes without a date stay in story order underneath. Nothing has to have a date.</p>
    <div class="btl">
      ${dated.length ? `<div class="btl-row">${dated.map(d => `<div class="btl-stop"><span class="btl-date">${boardDate(d.storyDate)}</span><span class="btl-dot bk-${boardKind(d)}"></span>${card(d)}</div>`).join('')}</div>`
        : '<div class="blens-empty">No dates yet. Add a story date to any scene or event to place it here.</div>'}
      <section class="btl-sometime">
        <h3>Sometime · in story order<span>${undated.length}</span></h3>
        <div class="btl-row">${undated.map(card).join('') || '<div class="blens-empty">Every scene has a date.</div>'}</div>
      </section>
    </div>`;
}

/* ── Events (attached once) ── */
function attachBoardEvents() {
  if (boardEventsAttached) return;
  boardEventsAttached = true;
  const view  = document.getElementById('board-view');
  const stage = document.getElementById('board-stage');
  const world = document.getElementById('board-world');
  const tray  = document.getElementById('board-tray');
  const lens  = document.getElementById('board-lens');

  document.getElementById('board-lens-switch').addEventListener('click', e => {
    const b = e.target.closest('button[data-lens]');
    if (!b) return;
    boardStore(BOARD_LENS_KEY, b.dataset.lens);
    buildBoard();
  });
  document.getElementById('board-arr').addEventListener('change', e => setBoardArrangement(e.target.value));
  document.getElementById('board-arr-keep').addEventListener('click', () => {
    const arr = boardArrangementId();
    if (arr === 'main') return;
    if (!confirm('Make this what-if the main arrangement? The current main layout will be replaced.')) return;
    docs.forEach(d => { if (d.boardPos) { const p = d.boardPos[arr]; setBoardPos(d, p ? { ...p } : null, 'main'); delete d.boardPos[arr]; } });
    docs = docs.filter(d => String(d.id) !== arr);
    schedulePersist();
    setBoardArrangement('main');
  });
  document.getElementById('board-arr-discard').addEventListener('click', () => {
    const arr = boardArrangementId();
    if (arr === 'main' || !confirm('Discard this what-if arrangement? The main arrangement stays as it is.')) return;
    docs.forEach(d => { if (d.boardPos) delete d.boardPos[arr]; });
    docs = docs.filter(d => String(d.id) !== arr);
    schedulePersist();
    setBoardArrangement('main');
  });
  document.getElementById('board-btn-thread').addEventListener('click', () => {
    boardShowThreads = !boardShowThreads;
    renderBoardTopbar(boardLens());
    drawBoardThreads();
  });
  document.getElementById('board-btn-reset').addEventListener('click', () => {
    boardPan = { x: 0, y: 0 };
    boardZoom = 1;
    applyBoardTransform();
  });
  document.getElementById('board-zoom-out').addEventListener('click', () => zoomBoardAt(boardZoom / 1.2));
  document.getElementById('board-zoom-in').addEventListener('click', () => zoomBoardAt(boardZoom * 1.2));
  document.getElementById('board-zoom-level').addEventListener('click', () => zoomBoardAt(1));

  document.getElementById('board-addbar').addEventListener('click', e => {
    const b = e.target.closest('button[data-add]');
    if (!b) return;
    if (boardLens() !== 'freeform') boardStore(BOARD_LENS_KEY, 'freeform');
    const d = addBoardCard(b.dataset.add);
    buildBoard();
    const el = world.querySelector(`[data-id="${d.id}"] .bcard-title, [data-id="${d.id}"] .bzone-label`);
    if (el) editBoardText(el, d);
  });

  // Quick add: Enter makes an idea in the tray; start with "?" for a question.
  document.getElementById('board-quick').addEventListener('keydown', e => {
    if (e.key !== 'Enter') return;
    const text = e.target.value.trim();
    if (!text) return;
    const isQ = text.startsWith('?') || text.endsWith('?');
    const d = addBoardCard(isQ ? 'question' : 'idea', false);
    d.title = text.replace(/^\?\s*/, '');
    e.target.value = '';
    schedulePersist();
    renderBoardTray();
  });

  document.getElementById('board-filters').addEventListener('click', e => {
    const b = e.target.closest('button[data-kind]');
    if (!b) return;
    const hidden = boardHiddenKinds();
    if (hidden.has(b.dataset.kind)) hidden.delete(b.dataset.kind); else hidden.add(b.dataset.kind);
    boardStore(BOARD_HIDDEN_KEY, JSON.stringify([...hidden]));
    buildBoard();
  });

  // Tray: drag cards out onto the board, delete board-only cards.
  tray.addEventListener('dragstart', e => {
    const item = e.target.closest('.btray-item');
    if (!item) return;
    e.dataTransfer.setData('text/folio-board', item.dataset.id);
    e.dataTransfer.effectAllowed = 'move';
  });
  tray.addEventListener('click', e => {
    const del = e.target.closest('[data-del]');
    if (!del) return;
    const d = docs.find(x => x.id === +del.dataset.del);
    if (!d || d.section !== 'board') return;
    if (!confirm(`Delete this ${BOARD_KINDS[boardKind(d)].label.toLowerCase()}? This can't be undone.`)) return;
    docs = docs.filter(x => x.id !== d.id);
    schedulePersist();
    renderBoardTray();
  });
  stage.addEventListener('dragover', e => {
    if (e.dataTransfer.types.includes('text/folio-board')) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; }
  });
  stage.addEventListener('drop', e => {
    const id = +e.dataTransfer.getData('text/folio-board');
    const d = docs.find(x => x.id === id);
    if (!d) return;
    e.preventDefault();
    const p = boardWorldPoint(e.clientX, e.clientY);
    const at = { x: Math.round(p.x - 90), y: Math.round(p.y - 30) };
    setBoardPos(d, boardKind(d) === 'zone' ? { ...at, w: 360, h: 300 } : at);
    schedulePersist();
    buildBoard();
  });

  // Canvas: drag cards and zones, pan the background.
  stage.addEventListener('mousedown', e => {
    if (e.button !== 0 || e.target.closest('button, [contenteditable="true"], #board-addbar, #board-zoom, #board-minimap')) return;
    // preventDefault below stops the browser moving focus, so commit any open card edit first.
    if (document.activeElement && document.activeElement.isContentEditable && stage.contains(document.activeElement)) document.activeElement.blur();
    const resize = e.target.closest('.bzone-resize');
    const card = e.target.closest('.bcard');
    const zoneLabel = e.target.closest('.bzone-label');
    const zone = e.target.closest('.bzone');
    const target = card || (zone && (zoneLabel || resize) ? zone : null);
    if (target) {
      e.preventDefault();
      const d = docs.find(x => x.id === +target.dataset.id);
      if (!d) return;
      if (boardSelected !== d.id) {
        boardSelected = d.id;
        document.querySelectorAll('#board-world .selected').forEach(x => x.classList.remove('selected'));
        target.classList.add('selected');
        drawBoardThreads();
      }
      startBoardDrag(e, d, target, resize ? 'resize' : 'move');
      return;
    }
    // Background (or a zone's body): pan.
    e.preventDefault();
    const start = { x: e.clientX, y: e.clientY }, orig = { ...boardPan };
    let moved = false;
    stage.classList.add('grabbing');
    const onMove = ev => {
      if (!moved && Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < 3) return;
      moved = true;
      boardPan = { x: orig.x + ev.clientX - start.x, y: orig.y + ev.clientY - start.y };
      applyBoardTransform();
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      stage.classList.remove('grabbing');
      if (!moved && boardSelected != null) {
        boardSelected = null;
        document.querySelectorAll('#board-world .selected').forEach(x => x.classList.remove('selected'));
        drawBoardThreads();
      }
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  });

  stage.addEventListener('click', e => {
    const trial = e.target.closest('[data-trial]');
    if (trial) { resolveBoardTrial(trial.dataset.trial); return; }
    const loose = e.target.closest('[data-loose]');
    if (loose) {
      const d = docs.find(x => x.id === +loose.dataset.loose);
      if (d) setBoardPos(d, null);
      if (boardTrial && d && boardTrial.id === d.id) boardTrial = null;
      schedulePersist();
      renderBoardWorld();
      renderBoardTray();
      return;
    }
    const thread = e.target.closest('[data-thread]');
    if (thread) {
      const d = docs.find(x => x.id === +thread.dataset.thread);
      if (!d) return;
      d.inThread = !d.inThread;
      thread.classList.toggle('on', d.inThread);
      thread.setAttribute('aria-pressed', String(d.inThread));
      thread.title = d.inThread ? 'Take off the red thread' : 'Add to the red thread';
      drawBoardThreads();
      schedulePersist();
    }
  });

  stage.addEventListener('dblclick', e => {
    const item = e.target.closest('.bcard, .bzone');
    if (!item || e.target.closest('button')) return;
    const d = docs.find(x => x.id === +item.dataset.id);
    if (!d) return;
    if (d.section === 'board') {
      const el = item.querySelector('.bcard-editable');
      if (el && (item.classList.contains('bcard') || e.target.closest('.bzone-label'))) editBoardText(el, d);
      return;
    }
    openFromBoard(d);
  });

  // Trackpad: two-finger scroll pans, pinch (or ⌘/Ctrl + scroll) zooms.
  stage.addEventListener('wheel', e => {
    if (boardLens() !== 'freeform') return;
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) {
      zoomBoardAt(boardZoom * Math.exp(-e.deltaY * 0.01), e.clientX, e.clientY);
    } else {
      boardPan.x -= e.deltaX;
      boardPan.y -= e.deltaY;
      applyBoardTransform();
    }
  }, { passive: false });

  // Lenses
  lens.addEventListener('click', e => {
    const open = e.target.closest('[data-open]');
    if (open) { const d = docs.find(x => x.id === +open.dataset.open); if (d) openFromBoard(d); }
  });
  lens.addEventListener('dblclick', e => {
    const card = e.target.closest('.blens-card[data-id]');
    if (card) { const d = docs.find(x => x.id === +card.dataset.id); if (d) openFromBoard(d); }
  });
  lens.addEventListener('dragstart', e => {
    const card = e.target.closest('.blens-card[data-id]');
    if (!card) return;
    e.dataTransfer.setData('text/folio-scene', card.dataset.id);
    e.dataTransfer.effectAllowed = 'move';
    card.classList.add('dragging');
  });
  lens.addEventListener('dragend', e => {
    lens.querySelectorAll('.dragging, .drop-before, .drop-col').forEach(x => x.classList.remove('dragging', 'drop-before', 'drop-col'));
  });
  lens.addEventListener('dragover', e => {
    if (!e.dataTransfer.types.includes('text/folio-scene')) return;
    const col = e.target.closest('.blens-col');
    if (!col) return;
    e.preventDefault();
    lens.querySelectorAll('.drop-before, .drop-col').forEach(x => x.classList.remove('drop-before', 'drop-col'));
    const card = e.target.closest('.blens-card[data-id]');
    if (card && !card.classList.contains('dragging')) card.classList.add('drop-before');
    else col.classList.add('drop-col');
  });
  lens.addEventListener('drop', e => {
    const id = +e.dataTransfer.getData('text/folio-scene');
    const col = e.target.closest('.blens-col');
    if (!id || !col) return;
    e.preventDefault();
    const card = e.target.closest('.blens-card[data-id]');
    moveSceneToChapter(id, col.dataset.chapter ? +col.dataset.chapter : null, card ? +card.dataset.id : null);
  });

  window.addEventListener('resize', () => { if (currentMode === 'board') drawBoardMinimap(); });
  view.addEventListener('keydown', e => {
    if (e.key === 'Escape' && boardTrial && !e.target.closest('[contenteditable="true"], input, textarea, select')) resolveBoardTrial('back');
  });
}

function zoomBoardAt(z, clientX, clientY) {
  const stage = document.getElementById('board-stage');
  const r = stage.getBoundingClientRect();
  const cx = clientX == null ? r.width / 2 : clientX - r.left;
  const cy = clientY == null ? r.height / 2 : clientY - r.top;
  const next = Math.max(0.3, Math.min(2, z));
  boardPan.x = cx - (cx - boardPan.x) * (next / boardZoom);
  boardPan.y = cy - (cy - boardPan.y) * (next / boardZoom);
  boardZoom = next;
  applyBoardTransform();
}

/* ────────────────────────────────────────
   Banner
──────────────────────────────────────── */
const BANNER_IMAGES = [
  { label: 'Fog & Mountains', url: 'https://images.unsplash.com/photo-1464822759023-fed622ff2c3b?w=1200&q=80' },
  { label: 'Old Library',     url: 'https://images.unsplash.com/photo-1521587760476-6c12a4b040da?w=1200&q=80' },
  { label: 'Candlelight',     url: 'https://images.unsplash.com/photo-1508193638397-1c4234db14d8?w=1200&q=80' },
  { label: 'Rainy Window',    url: 'https://images.unsplash.com/photo-1501999635878-71cb5379c2d8?w=1200&q=80' },
  { label: 'Forest Path',     url: 'https://images.unsplash.com/photo-1448375240586-882707db888b?w=1200&q=80' },
  { label: 'Old House',       url: 'https://images.unsplash.com/photo-1480074568708-e7b720bb3f09?w=1200&q=80' },
  { label: 'Winter Field',    url: 'https://images.unsplash.com/photo-1418985991508-e47386d96a71?w=1200&q=80' },
  { label: 'Stormy Sea',      url: 'https://images.unsplash.com/photo-1505118380757-91f5f5632de0?w=1200&q=80' },
  { label: 'Autumn Leaves',   url: 'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=1200&q=80' },
  { label: 'Mountain Lake',   url: 'https://images.unsplash.com/photo-1439853949212-36089c09ee30?w=1200&q=80' },
  { label: 'Cobblestone',     url: 'https://images.unsplash.com/photo-1467803738586-46b7eb7b16a1?w=1200&q=80' },
  { label: 'Typewriter',      url: 'https://images.unsplash.com/photo-1455390582262-044cdead277a?w=1200&q=80' },
];

function setBanner(url) {
  const banner = document.getElementById('doc-banner');
  if (!banner) return;
  if (url) {
    banner.style.backgroundImage = `url('${url}')`;
    banner.dataset.url = url;
    banner.classList.add('has-banner');
  } else {
    banner.style.backgroundImage = '';
    banner.dataset.url = '';
    banner.classList.remove('has-banner');
  }
}

function openBannerPicker() {
  const grid = document.getElementById('banner-grid');
  grid.innerHTML = BANNER_IMAGES.map(img => `
    <div class="banner-option" data-url="${img.url}" title="${img.label}">
      <img src="${img.url.replace('w=1200', 'w=300')}" alt="${img.label}">
      <div class="banner-option-label">${img.label}</div>
    </div>
  `).join('');

  grid.querySelectorAll('.banner-option').forEach(el => {
    el.addEventListener('click', () => {
      const d = docs.find(x => x.id === activeId);
      if (d) d.banner = el.dataset.url;
      setBanner(el.dataset.url);
      closeBannerPicker();
      schedulePersist();
    });
  });

  document.getElementById('banner-overlay').classList.add('open');
}

function closeBannerPicker() {
  document.getElementById('banner-overlay').classList.remove('open');
}

function removeBanner() {
  const d = docs.find(x => x.id === activeId);
  if (d) d.banner = '';
  setBanner('');
  closeBannerPicker();
  schedulePersist();
}

function handleBannerUpload(e) {
  const file = e.target.files[0];
  if (!file) return;
  const docId = activeId;
  // Shrunk like covers: a full-size photo here could fill Folio's storage by itself.
  prepareStoredPicture(file, 1800).then(url => {
    const d = docs.find(x => x.id === docId);
    if (d) d.banner = url;
    if (docId === activeId) setBanner(url);
    closeBannerPicker();
    schedulePersist();
  }).catch(() => alert(`Folio couldn't open "${file.name}" as a picture. If it's a photo, try exporting it from Photos as a JPEG first.`));
}

/* Any picture Folio can open, no bigger than maxDimension, as compact WebP text for storage. */
async function prepareStoredPicture(file, maxDimension) {
  const source = await decodeImageFile(file);
  return imageToCanvas(source, maxDimension).toDataURL('image/webp', 0.85);
}

/* ────────────────────────────────────────
   Focus Mode
──────────────────────────────────────── */
function toggleFocus() {
  const on = document.body.classList.toggle('focus-mode');
  window.folioWindow?.setButtonsVisible(!on);
}

/* ────────────────────────────────────────
   Search
──────────────────────────────────────── */
function openSearch() {
  document.getElementById('search-overlay').classList.add('open');
  document.getElementById('search-input').value = '';
  document.getElementById('search-results').innerHTML = '';
  document.getElementById('search-input').focus();
}

function closeSearch() {
  document.getElementById('search-overlay').classList.remove('open');
}

function runSearch(q) {
  const container = document.getElementById('search-results');
  if (!q) { container.innerHTML = ''; return; }

  const results = docs.filter(d =>
    d.title.toLowerCase().includes(q)   ||
    d.content.toLowerCase().includes(q) ||
    d.synopsis.toLowerCase().includes(q)
  );

  if (!results.length) {
    container.innerHTML = `<div id="search-empty">No results for "${q}"</div>`;
    return;
  }

  container.innerHTML = results.map(d => {
    const plain = d.content.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    const idx   = plain.toLowerCase().indexOf(q);
    let snippet = '';
    if (idx >= 0) {
      const start = Math.max(0, idx - 40);
      const end   = Math.min(plain.length, idx + q.length + 60);
      snippet = (start > 0 ? '…' : '')
        + plain.slice(start, idx)
        + '<em>' + plain.slice(idx, idx + q.length) + '</em>'
        + plain.slice(idx + q.length, end)
        + (end < plain.length ? '…' : '');
    }
    return `<div class="search-result" data-id="${d.id}">
      <div class="search-result-title">${d.title}</div>
      ${snippet ? `<div class="search-result-snippet">${snippet}</div>` : ''}
    </div>`;
  }).join('');

  container.querySelectorAll('.search-result').forEach(el => {
    el.addEventListener('click', () => {
      closeSearch();
      loadDoc(+el.dataset.id);
    });
  });
}

/* ────────────────────────────────────────
   Redesign functionality
──────────────────────────────────────── */
function escapeHTML(value) {
  const div = document.createElement('div');
  div.textContent = String(value || '');
  return div.innerHTML;
}

function isPhoneWidth() {
  return window.matchMedia('(max-width: 640px)').matches;
}

function syncPanelToggles() {
  const pairs = [['toggle-sidebar', 'sidebar-collapsed'], ['toggle-inspector', 'inspector-collapsed']];
  pairs.forEach(([id, cls]) => {
    const btn = document.getElementById(id);
    if (btn) btn.setAttribute('aria-pressed', String(!document.body.classList.contains(cls)));
  });
}

function toggleSidebar(open) {
  if (typeof open !== 'boolean') open = document.body.classList.contains('sidebar-collapsed');
  document.body.classList.toggle('sidebar-collapsed', !open);
  localStorage.setItem('folio-sidebar-open', String(open));
  // On a phone-width screen the sidebar and inspector are both full fixed-width
  // columns fighting for the same tiny viewport — having both open at once leaves
  // no room for the editor, so opening one closes the other.
  if (open && isPhoneWidth()) {
    document.body.classList.add('inspector-collapsed');
    localStorage.setItem('folio-inspector-open', 'false');
  }
  syncPanelToggles();
}

function toggleInspector(open) {
  if (typeof open !== 'boolean') open = document.body.classList.contains('inspector-collapsed');
  document.body.classList.toggle('inspector-collapsed', !open);
  localStorage.setItem('folio-inspector-open', String(open));
  if (open && isPhoneWidth()) {
    document.body.classList.add('sidebar-collapsed');
    localStorage.setItem('folio-sidebar-open', 'false');
  }
  syncPanelToggles();
}

function showInspectorPanel(name) {
  document.querySelectorAll('.inspector-tab').forEach(btn => btn.classList.toggle('active', btn.dataset.panel === name));
  document.querySelectorAll('.inspector-panel').forEach(panel => panel.classList.toggle('active', panel.id === `inspector-${name}-panel`));
  toggleInspector(true);
  if (name === 'history') renderSnapshots();
  if (name === 'notes') renderNotes();
}

function renderSession() {
  const wordsEl = document.getElementById('session-words');
  if (!wordsEl) return;
  const words = Math.max(0, getProjectWordTotal() - sessionBaseWords);
  wordsEl.textContent = words.toLocaleString();
  document.getElementById('session-progress-fill').style.width = Math.min(100, words / 10) + '%';
  const history = JSON.parse(localStorage.getItem('folio-session-history') || '{}');
  const today = new Date().toISOString().slice(0, 10);
  history[today] = Math.max(history[today] || 0, words);
  localStorage.setItem('folio-session-history', JSON.stringify(history));
  const days = Array.from({ length: 14 }, (_, i) => {
    const date = new Date();
    date.setDate(date.getDate() - (13 - i));
    return history[date.toISOString().slice(0, 10)] || 0;
  });
  document.getElementById('session-days').innerHTML = days.map(n => `<span class="${n ? 'written' : ''}" title="${n.toLocaleString()} words"></span>`).join('');
  let streak = 0;
  for (let i = days.length - 1; i >= 0 && days[i] > 0; i--) streak++;
  let best = 0;
  let run = 0;
  days.forEach(words => { run = words > 0 ? run + 1 : 0; best = Math.max(best, run); });
  document.getElementById('session-streak').textContent = `${streak} day${streak === 1 ? '' : 's'}`;
  document.getElementById('session-best').textContent = `${best} day${best === 1 ? '' : 's'}`;
}

function toggleSession() {
  const el = document.getElementById('writing-session');
  const open = !el.classList.contains('open');
  el.classList.toggle('open', open);
  el.setAttribute('aria-expanded', String(open));
  document.getElementById('session-toggle-mark').textContent = open ? '−' : '+';
}

function renderBeats() {
  const d = docs.find(x => x.id === activeId);
  const list = document.getElementById('beats-list');
  if (!list) return;
  const beats = d && d.beats ? d.beats : [];
  list.innerHTML = beats.map((beat, i) => `<button class="beat-chip ${beat.done ? 'done' : ''}" data-index="${i}" title="Click to complete · right-click to remove">${escapeHTML(beat.label)}</button>`).join('');
  list.querySelectorAll('.beat-chip').forEach(btn => {
    btn.addEventListener('click', () => { d.beats[+btn.dataset.index].done = !d.beats[+btn.dataset.index].done; renderBeats(); schedulePersist(); });
    btn.addEventListener('contextmenu', e => { e.preventDefault(); d.beats.splice(+btn.dataset.index, 1); renderBeats(); schedulePersist(); });
  });
}

function addBeat() {
  const label = prompt('Beat name');
  if (!label || !label.trim()) return;
  const d = docs.find(x => x.id === activeId);
  if (!d) return;
  d.beats = d.beats || [];
  d.beats.push({ label: label.trim(), done: false });
  renderBeats();
  schedulePersist();
}

function toggleBeats() {
  document.body.classList.toggle('beats-open');
  updateOptionChecks();
}

function setTypewriterMode(on = !typewriterMode) {
  typewriterMode = on;
  document.body.classList.toggle('typewriter-mode', on);
  if (on) requestAnimationFrame(centerCurrentLine);
  else document.querySelectorAll('#editor .current-line, #editor.current-line').forEach(el => el.classList.remove('current-line'));
  updateOptionChecks();
  updateModeButtons();
  schedulePersist();
}

function centerCurrentLine() {
  if (!typewriterMode) return;
  const selection = window.getSelection();
  const node = selection && selection.anchorNode;
  const element = node && (node.nodeType === 1 ? node : node.parentElement);
  const editor = document.getElementById('editor');
  if (!element || !editor.contains(element)) return;
  const block = element === editor ? editor : element.closest('#editor > *');
  document.querySelectorAll('#editor > .current-line, #editor.current-line').forEach(el => el.classList.remove('current-line'));
  if (block) { block.classList.add('current-line'); block.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
}

function toggleProofing() {
  proofingMode = !proofingMode;
  document.body.classList.toggle('proofing-mode', proofingMode);
  const editor = document.getElementById('editor');
  editor.spellcheck = true;
  if (proofingMode) editor.focus();
  updateOptionChecks();
  updateModeButtons();
  schedulePersist();
}

function takeSnapshot() {
  saveCurrentDoc();
  const d = docs.find(x => x.id === activeId);
  if (!d || d.entityType) return;
  d.snapshots = d.snapshots || [];
  d.snapshots.unshift({ id: Date.now(), title: d.title, content: d.content, words: countWords(d.content), createdAt: new Date().toISOString() });
  renderSnapshots();
  showInspectorPanel('history');
  schedulePersist();
}

function renderSnapshots() {
  const list = document.getElementById('snapshot-list');
  if (!list) return;
  const d = docs.find(x => x.id === activeId);
  const snapshots = d && d.snapshots ? d.snapshots : [];
  list.innerHTML = snapshots.length ? snapshots.map(s => `<div class="snapshot-item" data-id="${s.id}"><div><strong>${new Date(s.createdAt).toLocaleString()}</strong><span>${s.label ? `${escapeHTML(s.label)} · ` : ''}${(s.words || 0).toLocaleString()} words</span></div><div><button data-action="compare">Compare</button><button data-action="restore">Restore</button></div></div>`).join('') : '<div class="panel-empty">No snapshots yet.</div>';
  list.querySelectorAll('.snapshot-item button').forEach(btn => btn.addEventListener('click', () => {
    const snap = snapshots.find(s => s.id === +btn.closest('.snapshot-item').dataset.id);
    if (!snap) return;
    if (btn.dataset.action === 'compare') {
      const delta = countWords(d.content || '') - snap.words;
      alert(`Current draft is ${Math.abs(delta).toLocaleString()} word${Math.abs(delta) === 1 ? '' : 's'} ${delta >= 0 ? 'longer' : 'shorter'} than this snapshot.`);
    } else if (confirm('Restore this snapshot? A snapshot of the current version will be kept first.')) {
      d.snapshots.unshift({ id: Date.now(), title: d.title, content: d.content, words: countWords(d.content), createdAt: new Date().toISOString() });
      d.title = snap.title; d.content = snap.content; loadDoc(d.id); renderSnapshots(); schedulePersist();
    }
  }));
}

function compareLastSnapshot() {
  saveCurrentDoc();
  const d = docs.find(x => x.id === activeId);
  const snap = d && d.snapshots && d.snapshots[0];
  if (!snap) { alert('Take a snapshot first.'); return; }
  const currentWords = countWords(d.content || '');
  const delta = currentWords - snap.words;
  showInspectorPanel('history');
  alert(`Since ${new Date(snap.createdAt).toLocaleString()}: ${delta >= 0 ? '+' : ''}${delta.toLocaleString()} words (${currentWords.toLocaleString()} total).`);
}

function renderNotes() {
  const notepad = document.getElementById('document-notepad');
  const textArea = document.getElementById('notepad-text');
  if (!notepad || !textArea) return;
  const d = docs.find(x => x.id === activeId);
  if (!d) return;
  if (typeof d.documentNote !== 'string') {
    const legacyNotes = (d.notes || []).filter(n => !n.anchor && n.kind !== 'annotation');
    d.documentNote = legacyNotes.map(n => n.text).join('\n\n');
    d.notes = (d.notes || []).filter(n => n.anchor || n.kind === 'annotation');
  }
  textArea.value = d.documentNote;
  const lined = d.notepadLined !== false;
  notepad.classList.toggle('lined', lined);
  document.getElementById('notepad-lines').textContent = lined ? 'No lines' : 'Show lines';
  renderNotesSummary();
}

function renderNotesSummary() {
  const button = document.getElementById('doc-notes-summary');
  if (!button) return;
  const d = docs.find(x => x.id === activeId);
  const text = d && d.documentNote ? d.documentNote.trim() : '';
  const words = countWords(text);
  button.hidden = !text;
  button.textContent = `Document notepad · ${words} word${words === 1 ? '' : 's'}`;
}

function updateStatusControls(status) {
  document.querySelectorAll('#status-segmented button').forEach(btn => btn.classList.toggle('active', btn.dataset.status === status));
}

function buildBible(filter = '') {
  const query = filter.trim().toLowerCase();
  const entities = docs.filter(d => d.entityType && (!query || [d.title, d.entityType, ...(d.aliases || [])].join(' ').toLowerCase().includes(query)));
  const labels = { character: 'Characters', location: 'Places', event: 'Events', object: 'Objects & motifs' };
  const container = document.getElementById('bible-groups');
  container.innerHTML = Object.keys(labels).map(type => {
    const items = entities.filter(e => e.entityType === type);
    if (!items.length) return '';
    return `<section class="bible-group"><h3>${labels[type]}</h3><div>${items.map(e => {
      const note = e.charFields ? Object.values(e.charFields).find(Boolean) : e.synopsis;
      const names = [e.title, ...(e.aliases || [])].filter(Boolean).map(name => name.toLowerCase());
      const mentions = docs.filter(d => !d.entityType).reduce((total, d) => {
        const text = (d.content || '').replace(/<[^>]+>/g, ' ').toLowerCase();
        return total + names.reduce((count, name) => count + (text.split(name).length - 1), 0);
      }, 0);
      return `<button class="bible-card" data-id="${e.id}"><strong>${escapeHTML(e.title)}</strong><span>${mentions} mention${mentions === 1 ? '' : 's'}</span><p>${escapeHTML(note || 'No notes yet.')}</p></button>`;
    }).join('')}</div></section>`;
  }).join('') || '<div class="panel-empty">No matching entities.</div>';
  container.querySelectorAll('.bible-card').forEach(card => card.addEventListener('click', () => loadDoc(+card.dataset.id)));
}

function annotateSelection() {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || !document.getElementById('editor').contains(selection.anchorNode)) {
    alert('Select text in the manuscript first.');
    return;
  }
  const anchor = selection.toString().slice(0, 120);
  const range = selection.getRangeAt(0).cloneRange();
  const text = prompt(`Annotation on “${anchor}”`);
  if (!text || !text.trim()) return;
  const id = Date.now();
  const mark = document.createElement('span');
  mark.className = 'annotation';
  mark.dataset.annotationId = id;
  mark.contentEditable = 'false';
  try { range.surroundContents(mark); } catch { alert('Select text within a single paragraph to annotate it.'); return; }
  const boundary = document.createElement('span');
  boundary.className = 'annotation-boundary';
  boundary.setAttribute('aria-hidden', 'true');
  boundary.contentEditable = 'false';
  mark.after(boundary);
  const caret = document.createRange();
  caret.setStartAfter(boundary);
  caret.collapse(true);
  selection.removeAllRanges();
  selection.addRange(caret);
  const d = docs.find(x => x.id === activeId);
  if (d) {
    d.notes = d.notes || [];
    d.notes.unshift({ id, kind: 'annotation', text: text.trim(), anchor, createdAt: new Date().toISOString() });
  }
  saveCurrentDoc(); renderNotes(); renderMarginNotes(); schedulePersist();
}

function prepareAnnotationMarks() {
  const editor = document.getElementById('editor');
  if (!editor) return;
  editor.querySelectorAll('.annotation').forEach(mark => {
    mark.contentEditable = 'false';
    const next = mark.nextElementSibling;
    if (next && next.classList.contains('annotation-boundary')) return;
    const boundary = document.createElement('span');
    boundary.className = 'annotation-boundary';
    boundary.setAttribute('aria-hidden', 'true');
    boundary.contentEditable = 'false';
    mark.after(boundary);
  });
}

function focusAnnotation(note) {
  const editor = document.getElementById('editor');
  let mark = editor.querySelector(`[data-annotation-id="${note.id}"]`);
  if (!mark && note.anchor) {
    const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const index = node.nodeValue.indexOf(note.anchor);
      if (index < 0) continue;
      const range = document.createRange();
      range.setStart(node, index);
      range.setEnd(node, index + note.anchor.length);
      mark = document.createElement('span');
      mark.className = 'annotation';
      mark.dataset.annotationId = note.id;
      mark.contentEditable = 'false';
      range.surroundContents(mark);
      prepareAnnotationMarks();
      saveCurrentDoc();
      break;
    }
  }
  if (!mark) { alert('The annotated passage may have been edited or removed.'); return; }
  mark.scrollIntoView({ behavior: 'smooth', block: 'center' });
  mark.classList.remove('annotation-focus');
  requestAnimationFrame(() => mark.classList.add('annotation-focus'));
  setTimeout(() => mark.classList.remove('annotation-focus'), 1800);
}

function applyBeatTemplate() {
  const d = docs.find(x => x.id === activeId);
  if (!d) return;
  const template = ['Setup', 'Inciting incident', 'First turn', 'Midpoint', 'Dark night', 'Climax'];
  if (d.beats && d.beats.length && !confirm('Replace this document’s existing beats with the Three-Act template?')) return;
  d.beats = template.map(label => ({ label, done: false }));
  document.body.classList.add('beats-open');
  renderBeats(); updateOptionChecks(); schedulePersist();
}

function toggleSplit(on = !splitMode) {
  splitMode = on;
  document.body.classList.toggle('split-mode', on);
  renderSplitReference(); updateModeButtons(); schedulePersist();
}

function renderSplitReference() {
  const select = document.getElementById('split-doc-select');
  if (!select) return;
  const choices = docs.filter(d => d.section === 'manuscript' && !d.isFolder && d.id !== activeId);
  if (!choices.some(d => d.id === splitReferenceId)) splitReferenceId = choices[0] ? choices[0].id : null;
  select.innerHTML = choices.map(d => `<option value="${d.id}" ${d.id === splitReferenceId ? 'selected' : ''}>${escapeHTML(d.title)}</option>`).join('');
  const ref = docs.find(d => d.id === splitReferenceId);
  document.getElementById('split-reference-title').textContent = ref ? ref.title : 'No other manuscript document';
  document.getElementById('split-reference-content').innerHTML = ref ? ref.content || '' : '';
}

function saveSplitReference() {
  const ref = docs.find(d => d.id === splitReferenceId);
  if (!ref) return;
  ref.content = document.getElementById('split-reference-content').innerHTML;
  schedulePersist();
}

function toggleMargin(on = !marginMode) {
  marginMode = on;
  document.body.classList.toggle('margin-mode', on);
  renderMarginNotes(); updateModeButtons(); schedulePersist();
}

function renderMarginNotes() {
  const list = document.getElementById('margin-notes-list');
  if (!list) return;
  const d = docs.find(x => x.id === activeId);
  const notes = d && d.notes ? d.notes.filter(n => n.anchor || n.kind === 'annotation') : [];
  list.innerHTML = notes.length ? notes.map(n => `<button data-id="${n.id}"><strong>${escapeHTML(n.text)}</strong><span>on “${escapeHTML(n.anchor)}”</span></button>`).join('') : '<div class="panel-empty">Select manuscript text, then choose Annotate.</div>';
  list.querySelectorAll('button').forEach(btn => btn.addEventListener('click', () => focusAnnotation(notes.find(n => n.id === +btn.dataset.id))));
}

function updateModeButtons() {
  const states = { 'typewriter-btn': typewriterMode, 'proofing-btn': proofingMode, 'split-btn': splitMode };
  Object.entries(states).forEach(([id, on]) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.classList.toggle('active', on);
    el.setAttribute('aria-pressed', String(on));
  });
  const marginToggle = document.getElementById('margin-toggle');
  if (marginToggle) marginToggle.textContent = marginMode ? 'Annotations shown ✓' : 'Show annotations';
}

function commandItems() {
  const actions = [
    ['Writing', 'Toggle typewriter scroll', () => setTypewriterMode()],
    ['Writing', 'Toggle proofing pass', toggleProofing],
    ['Writing', 'Toggle beat sheet', toggleBeats],
    ['Writing', 'Toggle split reference', () => toggleSplit()],
    ['Writing', 'Toggle margin notes', () => toggleMargin()],
    ['Writing', 'Focus mode', toggleFocus],
    ['Revision', 'Take a snapshot', takeSnapshot],
    ['Revision', 'Open margin notes', () => showInspectorPanel('notes')],
    ['Revision', 'Compare with last snapshot', () => compareLastSnapshot()],
    ['Structure', 'Apply beat template: Three-Act', applyBeatTemplate],
    ['Project', 'Compile manuscript', openCompile],
    ['Project', 'Open projects', openProjects],
    ['View', 'World Bible', () => setMode('bible')]
  ].map(([group, label, run]) => ({ group, label, run }));
  return actions.concat(docs.map(d => ({ group: 'Go to', label: d.title, run: () => loadDoc(d.id) })));
}

function openCommandPalette() {
  document.getElementById('command-overlay').classList.add('open');
  document.getElementById('command-input').value = '';
  commandIndex = 0;
  renderCommands('');
  setTimeout(() => document.getElementById('command-input').focus(), 0);
}

function closeCommandPalette() { document.getElementById('command-overlay').classList.remove('open'); }

function renderCommands(query) {
  const q = query.trim().toLowerCase();
  currentCommands = commandItems().filter(item => !q || `${item.group} ${item.label}`.toLowerCase().includes(q));
  commandIndex = Math.max(0, Math.min(commandIndex, currentCommands.length - 1));
  document.getElementById('command-results').innerHTML = currentCommands.map((item, i) => `<button class="command-result ${i === commandIndex ? 'selected' : ''}" data-index="${i}"><span>${item.group}</span><strong>${escapeHTML(item.label)}</strong></button>`).join('') || '<div class="panel-empty">No matching commands.</div>';
  document.querySelectorAll('.command-result').forEach(btn => btn.addEventListener('click', () => runCommand(+btn.dataset.index)));
}

function runCommand(index) {
  const item = currentCommands[index];
  if (!item) return;
  closeCommandPalette(); item.run();
}

function toggleOptionsMenu(force) {
  const menu = document.getElementById('options-menu');
  const open = typeof force === 'boolean' ? force : !menu.classList.contains('open');
  menu.classList.toggle('open', open); updateOptionChecks();
}

function updateOptionChecks() {
  const states = { typewriter: typewriterMode, proofing: proofingMode, beats: document.body.classList.contains('beats-open'), split: splitMode, margin: marginMode };
  Object.entries(states).forEach(([name, on]) => { const btn = document.querySelector(`[data-option="${name}"]`); if (btn) btn.classList.toggle('checked', on); });
}

function openCompile() {
  saveCurrentDoc();
  const manuscript = docs.filter(d => d.section === 'manuscript' && !d.isFolder);
  document.getElementById('compile-summary').textContent = `${manuscript.length} scenes · ${getProjectWordTotal().toLocaleString()} words`;
  document.getElementById('compile-overlay').classList.add('open');
}

function closeCompile() { document.getElementById('compile-overlay').classList.remove('open'); }

function exportManuscript() {
  saveCurrentDoc();
  const includeDrafts = document.getElementById('compile-drafts').checked;
  const includeTitles = document.getElementById('compile-titles').checked;
  const includeBreaks = document.getElementById('compile-breaks').checked;
  const includeNotes = document.getElementById('compile-notes').checked;
  const format = document.querySelector('[name="compile-format"]:checked').value;
  const chosen = docs.filter(d => d.section === 'manuscript' && !d.isFolder && (includeDrafts || d.status !== 'draft'));
  const title = document.getElementById('project-title-input').value || 'Untitled Project';
  let content;
  let type;
  if (format !== 'txt') {
    content = `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHTML(title)}</title></head><body class="${format}"><h1>${escapeHTML(title)}</h1>${chosen.map(d => `${includeTitles ? `<h2>${escapeHTML(d.title)}</h2>` : ''}${d.content || ''}${includeNotes && d.notes && d.notes.length ? `<section><h3>Notes</h3><ul>${d.notes.map(n => `<li>${escapeHTML(n.text)}${n.anchor ? ` — “${escapeHTML(n.anchor)}”` : ''}</li>`).join('')}</ul></section>` : ''}`).join(includeBreaks ? '<p style="text-align:center">· · ·</p>' : '')}</body></html>`;
    type = 'text/html';
  } else {
    const toText = html => { const div = document.createElement('div'); div.innerHTML = html; return div.innerText; };
    const separator = includeBreaks ? '\n\n· · ·\n\n' : '\n\n\n';
    content = [title, ...chosen.map(d => `${includeTitles ? d.title + '\n\n' : ''}${toText(d.content || '')}${includeNotes && d.notes && d.notes.length ? `\n\nNOTES\n${d.notes.map(n => `- ${n.text}${n.anchor ? ` — “${n.anchor}”` : ''}`).join('\n')}` : ''}`)].join(separator);
    type = 'text/plain';
  }
  const blob = new Blob([content], { type: `${type};charset=utf-8` });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  const extension = format === 'txt' ? 'txt' : 'html';
  link.download = `${title.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase() || 'manuscript'}-${format}.${extension}`;
  link.click(); URL.revokeObjectURL(link.href); closeCompile();
}

function projectArchive() {
  try { return JSON.parse(bookGet('folio-projects') || '[]'); } catch { return []; }
}

const coverDatabase = new Promise((resolve, reject) => {
  const request = indexedDB.open('folio-media', 2);
  request.onupgradeneeded = () => {
    const db = request.result;
    if (!db.objectStoreNames.contains('project-covers')) db.createObjectStore('project-covers');
    if (!db.objectStoreNames.contains('handles')) db.createObjectStore('handles'); // holds the synced-folder FileSystemDirectoryHandle
  };
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});

async function mediaStore(storeName, mode, operation) {
  const database = await coverDatabase;
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(storeName, mode);
    const store = transaction.objectStore(storeName);
    const request = operation(store);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

const getStoredCover = id => mediaStore('project-covers', 'readonly', store => store.get(id));
const setStoredCover = (id, value) => mediaStore('project-covers', 'readwrite', store => store.put(value, id));
const deleteStoredCover = id => mediaStore('project-covers', 'readwrite', store => store.delete(id));

const getSyncFolderHandle = () => mediaStore('handles', 'readonly', store => store.get('sync-folder'));
const setSyncFolderHandle = handle => mediaStore('handles', 'readwrite', store => store.put(handle, 'sync-folder'));
const clearSyncFolderHandle = () => mediaStore('handles', 'readwrite', store => store.delete('sync-folder'));

function writeProjectArchive(projects) {
  bookSet('folio-projects', JSON.stringify(projects)); // a failure shows in the top bar and explains itself
  return true;
}

/* Any picture Folio can open (see decodeImageFile), shrunk to cover size. */
async function prepareCoverImage(file) {
  const source = await decodeImageFile(file);
  return imageToCanvas(source, 900).toDataURL('image/webp', 0.82);
}

async function saveProjectCoverFile(id, file) {
  try {
    const cover = await prepareCoverImage(file);
    await setStoredCover(id, cover);
    const projects = projectArchive();
    const project = projects.find(p => p.id === id);
    if (project) {
      delete project.cover;
      project.updatedAt = new Date().toISOString();
      writeProjectArchive(projects);
      if (syncFolderHandle) writeProjectToSyncFolder(project); // put the new cover in the synced file now, not at the next edit
    }
    renderProjects();
  } catch (error) {
    console.error('Could not save cover', error);
    if (error.message !== 'Project not found') alert(`Folio couldn't open "${file.name}" as a picture. If it's a photo, try exporting it from Photos as a JPEG first.`);
  }
}

/* True only for the untouched project every fresh install bootstraps into memory
   before the user has done anything — no content, still the default doc title and
   project title. Used to stop that bootstrap project from being archived (and so
   showing up as a spurious blank "Untitled Project" card) purely because the app
   loaded, on this device or any other. The instant the user actually types a title
   or any content, this stops being true and the very next save archives it as
   normal — this only ever skips a project that's never been touched at all. */
function isProjectPristine() {
  return docs.length === 1
    && !docs[0].content
    && docs[0].title === 'Untitled'
    && (document.getElementById('project-title-input').value || 'Untitled Project') === 'Untitled Project';
}

function saveProjectToArchive() {
  saveCurrentDoc();
  const archive = projectArchive();
  const alreadyArchived = archive.some(p => p.id === currentProjectId);
  if (!alreadyArchived && isProjectPristine()) return;
  const state = { id: currentProjectId, title: document.getElementById('project-title-input').value || 'Untitled Project', docs: JSON.parse(JSON.stringify(docs)), nextId, activeId, updatedAt: new Date().toISOString() };
  const index = archive.findIndex(p => p.id === state.id);
  if (index >= 0) archive[index] = state; else archive.push(state);
  writeProjectArchive(archive);
  if (syncFolderHandle) writeProjectToSyncFolder(state); // fire-and-forget; failures are logged, never block the save
}

function formatterSettings() {
  return {
    layoutVersion: 3,
    trim: document.getElementById('formatter-trim').value,
    theme: document.getElementById('formatter-theme').value,
    opening: document.getElementById('formatter-opening').value,
    dropcaps: document.getElementById('formatter-dropcaps').checked,
    drafts: document.getElementById('formatter-drafts').checked
  };
}

function openFormatter() {
  saveProjectToArchive();
  const projects = projectArchive().sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
  const select = document.getElementById('formatter-project');
  select.innerHTML = projects.map(p => `<option value="${escapeHTML(p.id)}">${escapeHTML(p.title)}</option>`).join('');
  select.value = projects.some(p => p.id === currentProjectId) ? currentProjectId : (projects[0] ? projects[0].id : '');
  document.getElementById('formatter-overlay').classList.add('open');
  loadFormatterSettings();
  renderFormatter();
}

function closeFormatter() { document.getElementById('formatter-overlay').classList.remove('open'); }

function loadFormatterSettings() {
  const id = document.getElementById('formatter-project').value;
  let settings = {};
  try { settings = JSON.parse(localStorage.getItem(`folio-formatter:${id}`) || '{}'); } catch { settings = {}; }
  document.getElementById('formatter-trim').value = settings.layoutVersion === 3 ? (settings.trim || '6x9') : '6x9';
  document.getElementById('formatter-theme').value = settings.theme || 'classic';
  document.getElementById('formatter-opening').value = settings.opening || 'centered';
  document.getElementById('formatter-dropcaps').checked = settings.layoutVersion === 3 && settings.dropcaps === true;
  document.getElementById('formatter-drafts').checked = settings.drafts !== false;
}

function selectedFormatterProject() {
  const id = document.getElementById('formatter-project').value;
  return projectArchive().find(p => p.id === id);
}

function formatterDocuments(project, settings) {
  return project ? (project.docs || []).filter(d => d.section === 'manuscript' && !d.isFolder && (settings.drafts || d.status !== 'draft')) : [];
}

const FORMATTER_TYPESETTING_PROPS = [
  'text-indent',
  'margin', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
  'padding', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
  'font-size', 'font-family', 'font-weight',
];

/* Strips typesetting properties — indent, margin, padding, font size, font
   family, font weight — that either Word/Google Docs/Pages bake into every
   paragraph and run on paste, or that a font-size/font selection in the editor
   embeds directly into that stretch of text. Left in place, any of these fight
   the formatter's own uniform typesetting the same way a pasted hardcoded color
   used to fight the app's theme: nothing enforces a single consistent value, so
   text comes out sized, spaced, and weighted arbitrarily instead of in an even,
   book-typeset rhythm — font-weight specifically is why bold and regular text
   could appear to alternate with no relationship to anything the writer actually
   emphasized: pasted content routinely carries an explicit font-weight on every
   run (400 here, 700 there) as a side effect of the source app, never as
   intentional bold. Genuine emphasis the writer actually applied — via Folio's
   own Bold button, which always produces a real <b> tag — is unaffected, since
   this only ever touches the "style" attribute, not tag names. A big enough
   leftover font-size has a second, worse consequence too — a paragraph that
   can't fit on any single page even on its own falls back to a plain-text
   word-by-word layout that drops all formatting, which is the "chapter title
   alone on one page, unformatted text on the next" symptom this was reported as. */
function stripInlineSpacing(el) {
  [el, ...el.querySelectorAll('[style]')].forEach(node => {
    if (!node.hasAttribute('style')) return;
    FORMATTER_TYPESETTING_PROPS.forEach(prop => node.style.removeProperty(prop));
    if (!node.getAttribute('style')) node.removeAttribute('style');
  });
}

const TAB_INDENT = '\u2003\u2003';

function stripLeadingIndent(el) {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  const node = walker.nextNode();
  if (!node) return;
  node.textContent = node.textContent.replace(/^[ \t \u2003]+/, '');
}

function cleanBookHTML(html) {
  const wrap = document.createElement('div');
  wrap.innerHTML = html || '';
  wrap.querySelectorAll('.annotation-boundary').forEach(el => el.remove());
  wrap.querySelectorAll('.annotation').forEach(el => el.replaceWith(...el.childNodes));
  wrap.querySelectorAll('[contenteditable]').forEach(el => el.removeAttribute('contenteditable'));
  [...wrap.childNodes].forEach(node => {
    if (node.nodeType === Node.TEXT_NODE && node.textContent.trim()) {
      const paragraph = document.createElement('p');
      paragraph.textContent = node.textContent;
      node.replaceWith(paragraph);
    } else if (node.nodeType === Node.ELEMENT_NODE && node.matches('div:not(.scene-break)')) {
      const paragraph = document.createElement('p');
      paragraph.innerHTML = node.innerHTML;
      node.replaceWith(paragraph);
    }
  });
  // The formatter gives every paragraph its own consistent text-indent via CSS —
  // any indentation the writer typed by hand (leading spaces, tabs, &nbsp; — never
  // exactly the same amount twice, since nothing enforced a fixed width) stacks on
  // top of that instead of being replaced by it, which is exactly why paragraphs
  // were coming out indented by wildly different amounts instead of the even,
  // book-typeset look a formatter is supposed to produce.
  [...wrap.children].forEach(block => {
    if (block.classList.contains('scene-break') || block.classList.contains('book-scene-break')) return;
    stripLeadingIndent(block);
    stripInlineSpacing(block);
  });
  return wrap.innerHTML;
}

function applyFormatterDropCap(prose) {
  if (!prose || prose.querySelector('.formatter-dropcap')) return;
  const firstBlock = prose.querySelector('p, div, blockquote');
  if (!firstBlock) return;
  const walker = document.createTreeWalker(firstBlock, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode())) {
    const index = node.nodeValue.search(/\S/);
    if (index < 0) continue;
    const before = node.nodeValue.slice(0, index);
    const letter = node.nodeValue[index];
    const after = node.nodeValue.slice(index + 1);
    const dropCap = document.createElement('span');
    dropCap.className = 'formatter-dropcap';
    dropCap.textContent = letter;
    const fragment = document.createDocumentFragment();
    if (before) fragment.appendChild(document.createTextNode(before));
    fragment.appendChild(dropCap);
    if (after) fragment.appendChild(document.createTextNode(after));
    node.replaceWith(fragment);
    return;
  }
}

/* Appends `original` (a block that didn't fit whole on the current page) into
   the formatter output word by word, splitting across as many pages as it takes
   — but unlike a plain-text rebuild, it walks the block's actual DOM and keeps
   every inline tag (bold, italic, underline, …) wrapped around exactly the words
   it belongs to, reopening whatever tags were "in progress" at the top of each
   new page it spans. Without this, a paragraph that happened to straddle a page
   break would silently lose any bold/italic sitting right at the split — rare at
   normal text sizes, but the split point falls inside *some* paragraph on nearly
   every page once the text is large enough that most paragraphs need splitting,
   which is exactly why the loss went from unnoticeable to constant.
   pageCtx = { current } is mutated in place so the caller sees whichever page
   things ended up on. */
function splitBlockPreservingFormatting(original, chapter, pageCtx, createPage, overflows, wantsDropCap, isChapterOpening) {
  let current = pageCtx.current;
  const topTag = original.tagName || 'P';
  let topParagraph = document.createElement(topTag);
  // Whether any of THIS block's words have successfully landed anywhere yet —
  // false the whole time this is really just "the paragraph didn't fit at all on
  // the old page, so it's starting fresh on this one" (a genuine new paragraph,
  // just delayed to a later page — should indent normally), true only once it's
  // truly a continuation of content that already exists on an earlier page.
  let hasPlacedAnyContent = false;
  // The chapter's true opening paragraph is flush no matter which page it lands
  // on; every later page this SAME split block continues onto — once it's
  // actually placed something — is flush too, since that's a continuation, not a
  // new paragraph, and shouldn't re-indent either.
  if (isChapterOpening) topParagraph.classList.add('formatter-flush');
  current.prose.appendChild(topParagraph);
  const openChain = []; // inline tag names currently open, outer to inner
  let dropCapPending = Boolean(wantsDropCap);

  function maybeApplyDropCap() {
    if (!dropCapPending) return;
    applyFormatterDropCap(current.prose);
    dropCapPending = false;
  }

  /* The insertion point for whatever gets appended next, derived fresh from
     topParagraph + openChain every time rather than cached — a cached reference
     goes stale the instant a page break happens partway through a nested run
     (bold, italic, …): after finishing that run and returning to its parent
     level, the naive fix ("restore whatever the target was before entering this
     tag") points at a wrapper on the OLD page, not the page things have actually
     advanced to since. Content appended through it then silently lands back on
     that old page — sometimes back inside that very same now-finished inline
     wrapper — which is exactly how plain text could end up rendered bold with no
     visible pattern to it. Deriving the target fresh, every time, from the
     current page's own topParagraph makes that impossible: there's no stale
     reference left to restore. */
  function currentTarget() {
    let t = topParagraph;
    openChain.forEach(tagName => {
      let last = t.lastElementChild;
      if (!last || last.tagName !== tagName) {
        last = document.createElement(tagName);
        t.appendChild(last);
      }
      t = last;
    });
    return t;
  }

  function newPage() {
    // An empty topParagraph means nothing from this block ever landed on the
    // page being left behind (the very first word didn't fit) — nothing to
    // clean up otherwise, since a topParagraph that DID receive content stays
    // right where it is.
    if (!topParagraph.hasChildNodes()) topParagraph.remove();
    current = createPage(chapter, true);
    pageCtx.current = current;
    topParagraph = document.createElement(topTag);
    if (hasPlacedAnyContent || isChapterOpening) topParagraph.classList.add('formatter-flush');
    current.prose.appendChild(topParagraph);
  }

  function walkText(node) {
    const tokens = node.textContent.split(/(\s+)/).filter(Boolean);
    if (!tokens.length) return;
    let idx = 0;
    let textNode = document.createTextNode('');
    currentTarget().appendChild(textNode);
    let fitted = '';
    while (idx < tokens.length) {
      const attempt = fitted + tokens[idx];
      textNode.textContent = attempt;
      if (overflows(current.page)) {
        textNode.textContent = fitted;
        if (fitted) { maybeApplyDropCap(); hasPlacedAnyContent = true; }
        if (!fitted) textNode.remove();
        newPage(); // reads hasPlacedAnyContent as it stands right now, before it's touched again below
        textNode = document.createTextNode('');
        currentTarget().appendChild(textNode);
        fitted = '';
        continue; // retry this same token on the fresh page
      }
      fitted = attempt;
      idx++;
    }
    if (fitted) { maybeApplyDropCap(); hasPlacedAnyContent = true; } else { textNode.remove(); }
  }

  function walk(node) {
    if (node.nodeType === Node.TEXT_NODE) {
      if (node.textContent) walkText(node);
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    openChain.push(node.tagName);
    Array.from(node.childNodes).forEach(walk);
    const wrap = currentTarget();
    openChain.pop();
    if (!wrap.hasChildNodes()) wrap.remove();
  }

  if (original.nodeType === Node.TEXT_NODE) walkText(original);
  else Array.from(original.childNodes).forEach(walk);

  if (!topParagraph.hasChildNodes()) topParagraph.remove();
  pageCtx.current = current;
}

function renderFormatter() {
  const project = selectedFormatterProject();
  const settings = formatterSettings();
  const preview = document.getElementById('formatter-preview');
  if (!project) { preview.innerHTML = '<div class="formatter-empty">Create a project before opening the formatter.</div>'; return; }
  localStorage.setItem(`folio-formatter:${project.id}`, JSON.stringify(settings));
  const chapters = formatterDocuments(project, settings);
  const words = chapters.reduce((sum, d) => sum + countWords(d.content || ''), 0);
  preview.innerHTML = '';
  let pageNumber = 0;

  const createPage = (chapter, continuation = false) => {
    pageNumber += 1;
    const page = document.createElement('article');
    page.className = `formatter-page trim-${settings.trim} theme-${settings.theme} opening-${settings.opening} ${settings.dropcaps && !continuation ? 'dropcaps' : ''}`;
    page.innerHTML = `${continuation ? '' : `<h1>${escapeHTML(chapter.title)}</h1>`}<div class="formatter-prose"></div><div class="formatter-page-number">${pageNumber}</div>`;
    preview.appendChild(page);
    return { page, prose: page.querySelector('.formatter-prose') };
  };

  const overflows = page => page.scrollHeight > page.clientHeight + 1;

  chapters.forEach(chapter => {
    const source = document.createElement('div');
    source.innerHTML = cleanBookHTML(chapter.content);
    let current = createPage(chapter);
    [...source.childNodes].filter(node => node.nodeType === 1 || node.textContent.trim()).forEach((original, blockIndex) => {
      let block = original.cloneNode(true);
      current.prose.appendChild(block);
      if (blockIndex === 0) {
        // The chapter's true opening paragraph never indents, no matter which
        // page it visually lands on — CSS :first-child can't tell "the actual
        // start of the chapter" apart from "just happens to be first on this
        // particular page", which was stripping the indent from a genuine new
        // paragraph any time an earlier one filled a page exactly.
        block.classList.add('formatter-flush');
        if (settings.dropcaps) applyFormatterDropCap(current.prose);
      }
      if (!overflows(current.page)) return; // whole block fit — done, full formatting kept

      // Doesn't fit whole. Split it right here on THIS page rather than moving the
      // whole thing to a fresh one — real books routinely run a paragraph across a
      // page break, filling each page with as much as fits; moving it wholesale
      // instead left the chapter's title page (or any page a block didn't quite
      // fit) completely empty of body text, with everything starting on the next
      // page instead. splitBlockPreservingFormatting keeps every word's bold,
      // italic, etc. intact across the split, rather than flattening to plain text.
      block.remove();
      const pageCtx = { current };
      splitBlockPreservingFormatting(original, chapter, pageCtx, createPage, overflows, blockIndex === 0 && settings.dropcaps, blockIndex === 0);
      current = pageCtx.current;
    });
  });

  if (!pageNumber) preview.innerHTML = '<div class="formatter-empty">This book has no chapters included in the current settings.</div>';
  document.getElementById('formatter-summary').textContent = `${chapters.length} chapter${chapters.length === 1 ? '' : 's'} · ${words.toLocaleString()} words · ${pageNumber} page${pageNumber === 1 ? '' : 's'}`;
}

function legacyExportFormattedBook() {
  const project = selectedFormatterProject();
  if (!project) return;
  const settings = formatterSettings();
  const chapters = formatterDocuments(project, settings);
  if (!chapters.length) { alert('This book has no chapters included in the current settings.'); return; }
  if (!window.jspdf || !window.jspdf.jsPDF) { alert('The PDF formatter could not load. Reload the page and try again.'); return; }
  const sizes = { '5x8': [360, 576], '5.5x8.5': [396, 612], '6x9': [432, 648], '8.5x11': [612, 792] };
  const [pageWidth, pageHeight] = sizes[settings.trim] || sizes['8.5x11'];
  const { jsPDF } = window.jspdf;
  const pdf = new jsPDF({ orientation: 'portrait', unit: 'pt', format: [pageWidth, pageHeight], compress: true, putOnlyUsedFonts: true });
  const bodyFont = settings.theme === 'modern' ? 'helvetica' : 'times';
  const bodySize = settings.trim === '8.5x11'
    ? (settings.theme === 'modern' ? 11 : 11.5)
    : (settings.theme === 'modern' ? 10 : 10.5);
  const leading = bodySize * 1.48;
  const bottomMargin = settings.trim === '8.5x11' ? 66 : 48;
  let pageNumber = 1;

  const margins = () => settings.trim === '8.5x11'
    ? { left: 72, right: 72 }
    : settings.trim === '6x9' ? { left: 54, right: 54 }
    : pageNumber % 2 ? { left: 52, right: 44 } : { left: 44, right: 52 };
  const drawFolio = () => {
    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(8);
    pdf.setTextColor(70);
    pdf.text(String(pageNumber), pageWidth / 2, pageHeight - 25, { align: 'center' });
    pdf.setTextColor(28);
  };
  const addPage = (continuation = true) => {
    drawFolio();
    pdf.addPage([pageWidth, pageHeight], 'portrait');
    pageNumber += 1;
    return continuation ? (settings.trim === '8.5x11' ? 78 : 66) : 50;
  };
  const sourceParagraphs = chapter => {
    const source = document.createElement('div');
    source.innerHTML = cleanBookHTML(chapter.content);
    const blocks = [...source.childNodes].map(node => node.textContent.replace(/\s+/g, ' ').trim()).filter(Boolean);
    return blocks.length ? blocks : [source.textContent.replace(/\s+/g, ' ').trim()].filter(Boolean);
  };

  chapters.forEach((chapter, chapterIndex) => {
    if (chapterIndex) {
      drawFolio();
      pdf.addPage([pageWidth, pageHeight], 'portrait');
      pageNumber += 1;
    }
    const margin = margins();
    const contentWidth = pageWidth - margin.left - margin.right;
    const titleY = settings.opening === 'high' ? pageHeight * .2 : settings.opening === 'low' ? pageHeight * .38 : pageHeight * .29;
    pdf.setFont(bodyFont, 'bold');
    pdf.setFontSize(20);
    pdf.setTextColor(28);
    const titleLines = pdf.splitTextToSize(chapter.title, contentWidth * .82);
    pdf.text(titleLines, pageWidth / 2, titleY, { align: 'center', lineHeightFactor: 1.15 });
    let y = titleY + titleLines.length * 23 + 60;
    const paragraphs = sourceParagraphs(chapter);

    paragraphs.forEach((paragraph, paragraphIndex) => {
      let currentMargin = margins();
      let width = pageWidth - currentMargin.left - currentMargin.right;
      pdf.setFont(bodyFont, 'normal');
      pdf.setFontSize(bodySize);
      const hasDropCap = paragraphIndex === 0 && settings.dropcaps && paragraph.length > 1;
      const paragraphText = hasDropCap ? paragraph.slice(1).trimStart() : paragraph;
      let lines = pdf.splitTextToSize(paragraphText, width - (hasDropCap ? 24 : paragraphIndex ? 14 : 0));
      const availableLines = Math.floor((pageHeight - bottomMargin - y) / leading);
      if (availableLines < Math.min(3, lines.length)) {
        y = addPage(true);
        currentMargin = margins();
        width = pageWidth - currentMargin.left - currentMargin.right;
        pdf.setFont(bodyFont, 'normal');
        pdf.setFontSize(bodySize);
        pdf.setTextColor(28);
        lines = pdf.splitTextToSize(paragraphText, width - (hasDropCap ? 24 : paragraphIndex ? 14 : 0));
      }
      let firstLine = true;
      while (lines.length) {
        if (y + leading > pageHeight - bottomMargin) {
          y = addPage(true);
          currentMargin = margins();
          width = pageWidth - currentMargin.left - currentMargin.right;
          pdf.setFont(bodyFont, 'normal');
          pdf.setFontSize(bodySize);
          pdf.setTextColor(28);
        }
        const line = lines.shift();
        const indent = firstLine && hasDropCap ? 24 : firstLine && paragraphIndex ? 14 : 0;
        if (firstLine && hasDropCap) {
          pdf.setFont(bodyFont, 'bold');
          pdf.setFontSize(28);
          pdf.text(paragraph[0], currentMargin.left, y + 4);
          pdf.setFont(bodyFont, 'normal');
          pdf.setFontSize(bodySize);
        }
        pdf.text(line, currentMargin.left + indent, y, { maxWidth: width - indent, align: 'left' });
        y += leading;
        firstLine = false;
      }
      y += 1.5;
    });
  });
  drawFolio();
  pdf.setProperties({ title: project.title, subject: 'Formatted book interior', creator: 'Folio' });
  pdf.save(`${project.title.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase() || 'book'}-formatted.pdf`);
}

async function exportFormattedBook() {
  const project = selectedFormatterProject();
  if (!project) return;
  if (!window.jspdf || !window.jspdf.jsPDF || !window.html2canvas) {
    alert('The PDF formatter could not load. Reload the page and try again.');
    return;
  }
  renderFormatter();
  const pages = [...document.querySelectorAll('#formatter-preview .formatter-page')];
  if (!pages.length) { alert('This book has no pages included in the current settings.'); return; }
  const settings = formatterSettings();
  const sizes = { '5x8': [360, 576], '5.5x8.5': [396, 612], '6x9': [432, 648], '8.5x11': [612, 792] };
  const [pageWidth, pageHeight] = sizes[settings.trim] || sizes['6x9'];
  const button = document.getElementById('formatter-export');
  const originalLabel = button.textContent;
  button.disabled = true;
  button.textContent = 'Formatting…';
  try {
    if (document.fonts && document.fonts.ready) await document.fonts.ready;
    const { jsPDF } = window.jspdf;
    const pdf = new jsPDF({ orientation: 'portrait', unit: 'pt', format: [pageWidth, pageHeight], compress: true });
    for (let index = 0; index < pages.length; index += 1) {
      button.textContent = `Formatting ${index + 1} of ${pages.length}…`;
      const page = pages[index];
      const previousShadow = page.style.boxShadow;
      page.style.boxShadow = 'none';
      let canvas;
      try {
        canvas = await window.html2canvas(page, {
          backgroundColor: '#f7faf5',
          scale: 3,
          logging: false,
          useCORS: true,
          allowTaint: false,
          width: page.offsetWidth,
          height: page.offsetHeight,
          onclone: clonedDocument => {
            const clonedPage = clonedDocument.querySelectorAll('#formatter-preview .formatter-page')[index];
            if (clonedPage) {
              clonedPage.style.boxShadow = 'none';
              clonedPage.style.backgroundColor = '#f7faf5';
              clonedPage.style.color = '#1c211a';
            }
          }
        });
      } finally {
        page.style.boxShadow = previousShadow;
      }
      if (index) pdf.addPage([pageWidth, pageHeight], 'portrait');
      pdf.addImage(canvas.toDataURL('image/jpeg', .98), 'JPEG', 0, 0, pageWidth, pageHeight, undefined, 'FAST');
    }
    pdf.setProperties({ title: project.title, subject: 'Formatted book interior', creator: 'Folio' });
    pdf.save(`${project.title.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase() || 'book'}-formatted.pdf`);
  } catch (error) {
    console.error('Could not export formatted PDF', error);
    alert(`The formatted PDF could not be created${error && error.message ? `: ${error.message}` : '.'}`);
  } finally {
    button.disabled = false;
    button.textContent = originalLabel;
  }
}

function openProjects() { saveProjectToArchive(); renderProjects(); document.getElementById('projects-overlay').classList.add('open'); scanSyncFolder(); }

// Muted cloth colours for projects that have no cover image yet. Each project
// keeps the same colour every time, picked from a hash of its id.
const SHELF_CLOTHS = ['#3d4a57', '#8a6b36', '#46543d', '#6b4552', '#4f5d6b', '#7a5a44'];
function shelfCloth(id) {
  let hash = 0;
  for (const ch of String(id)) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return SHELF_CLOTHS[hash % SHELF_CLOTHS.length];
}

function shelfRelativeTime(value) {
  const then = new Date(value);
  const minutes = Math.round((Date.now() - then) / 60000);
  if (!isFinite(minutes)) return '';
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days} days ago`;
  return then.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: then.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });
}

function projectWords(p) {
  return (p.docs || []).filter(d => d.section === 'manuscript').reduce((sum, d) => sum + countWords(d.content || ''), 0);
}

function shelfCoverHTML(p) {
  return `<span class="project-cover" data-cover-id="${escapeHTML(p.id)}" style="--cloth: ${shelfCloth(p.id)}">
    <span class="project-cover-placeholder">
      <span class="cover-title">${escapeHTML(p.title)}</span>
      <span class="cover-rule"></span>
    </span>
  </span>`;
}

function renderProjectsGreeting() {
  const now = new Date();
  const hour = now.getHours();
  const part = hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'evening';
  document.getElementById('projects-date').textContent = now.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
  document.getElementById('projects-hello').innerHTML = `Good ${part}. <em>Shall we write?</em>`;
}

function renderContinueCard(archive) {
  const section = document.getElementById('projects-continue');
  const p = archive[0];
  if (!p || archive.length < 2) { section.hidden = true; section.innerHTML = ''; return; }
  const lastDoc = (p.docs || []).find(d => d.id === p.activeId);
  const lastLine = lastDoc && !lastDoc.isFolder ? `Last open: ${escapeHTML(lastDoc.title || 'Untitled')} · ` : '';
  section.hidden = false;
  section.innerHTML = `
    <button class="continue-cover" type="button" data-continue="open" aria-label="Open ${escapeHTML(p.title)}">${shelfCoverHTML(p)}</button>
    <div class="continue-body">
      <span class="projects-eyebrow">Continue writing</span>
      <h2>${escapeHTML(p.title)}</h2>
      <p>${lastLine}edited ${shelfRelativeTime(p.updatedAt)}</p>
      <div class="continue-words"><strong>${projectWords(p).toLocaleString()}</strong><span>words in the manuscript</span></div>
      <div class="continue-actions">
        <button class="shelf-primary" type="button" data-continue="open">Resume writing</button>
        <button class="shelf-ghost" type="button" data-continue="compile">Compile</button>
      </div>
    </div>`;
  section.querySelectorAll('[data-continue]').forEach(button => button.addEventListener('click', () => {
    switchProject(p.id);
    if (button.dataset.continue === 'compile') openCompile();
  }));
}

function renderProjects() {
  const archive = projectArchive().sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
  const allWords = archive.reduce((total, p) => total + projectWords(p), 0);
  document.getElementById('projects-summary').textContent = `${archive.length} project${archive.length === 1 ? '' : 's'} · ${allWords.toLocaleString()} words`;
  renderProjectsGreeting();
  renderContinueCard(archive);
  document.getElementById('projects-overlay').classList.toggle('is-empty', !archive.length);
  if (!archive.length) {
    document.getElementById('projects-grid').innerHTML = `<div class="projects-empty">
      <div class="empty-books" aria-hidden="true"><span></span><span></span><span></span></div>
      <h1>An empty shelf, <em>for now.</em></h1>
      <p>Start your first project, or bring one in from a .folio file. Everything you write is saved as you go.</p>
      <div class="continue-actions">
        <button class="shelf-primary" type="button" data-empty="new">Start a new project</button>
        <button class="shelf-ghost" type="button" data-empty="import">Import project…</button>
      </div>
    </div>`;
    document.querySelector('[data-empty="new"]').addEventListener('click', createProject);
    document.querySelector('[data-empty="import"]').addEventListener('click', () => document.getElementById('import-project-input').click());
    return;
  }
  document.getElementById('projects-grid').innerHTML = archive.map(p => {
    const words = projectWords(p);
    return `<div class="project-card ${p.id === currentProjectId ? 'active' : ''}" data-id="${escapeHTML(p.id)}">
      <button class="project-open" type="button" aria-label="Open ${escapeHTML(p.title)}">
        ${shelfCoverHTML(p)}
      </button>
      <div class="project-title-row">
        <div class="project-meta">
          <strong>${escapeHTML(p.title)}</strong>
          <small>${words.toLocaleString()} words · ${shelfRelativeTime(p.updatedAt)}</small>
        </div>
        <button class="project-more" type="button" title="Project options" aria-label="Options for ${escapeHTML(p.title)}">⋯</button>
        <div class="project-card-menu">
          <button data-project-action="edit" type="button">Open &amp; edit</button>
          <button data-project-action="compile" type="button">Compile</button>
          <button data-project-action="rename" type="button">Rename</button>
          <button data-project-action="cover" type="button">Upload cover image</button>
          <button data-project-action="export" type="button">Export project file…</button>
          <button data-project-action="delete" type="button" class="danger">Delete project…</button>
        </div>
      </div>
      <input class="project-cover-input" type="file" accept="${IMAGE_ACCEPT}">
    </div>`;
  }).join('') + `<div class="shelf-new">
      <button class="shelf-new-tile" type="button">
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>
        Start a new project
      </button>
      <small>or drop a .folio file here</small>
    </div>`;
  document.querySelector('.shelf-new-tile').addEventListener('click', createProject);
  document.querySelectorAll('.project-card').forEach(card => card.addEventListener('click', e => {
    if (e.target.closest('.project-more, .project-card-menu, .project-cover-input')) return;
    switchProject(card.dataset.id);
  }));
  document.querySelectorAll('.project-more').forEach(button => button.addEventListener('click', e => {
    e.stopPropagation();
    const menu = button.parentElement.querySelector('.project-card-menu');
    const card = button.closest('.project-card');
    const opening = !menu.classList.contains('open');
    document.querySelectorAll('.project-card-menu.open').forEach(item => item.classList.remove('open'));
    document.querySelectorAll('.project-card.menu-open').forEach(item => item.classList.remove('menu-open'));
    menu.classList.toggle('open', opening);
    card.classList.toggle('menu-open', opening);
    if (opening) {
      const trigger = button.getBoundingClientRect();
      const menuWidth = menu.offsetWidth;
      const menuHeight = menu.offsetHeight;
      const left = Math.min(window.innerWidth - menuWidth - 8, Math.max(8, trigger.right - menuWidth));
      const roomBelow = window.innerHeight - trigger.bottom;
      const top = roomBelow >= menuHeight + 8
        ? trigger.bottom + 4
        : Math.max(8, trigger.top - menuHeight - 4);
      menu.style.left = `${left}px`;
      menu.style.top = `${top}px`;
    }
  }));
  document.querySelectorAll('[data-project-action]').forEach(button => button.addEventListener('click', e => {
    e.stopPropagation();
    const id = button.closest('.project-card').dataset.id;
    const action = button.dataset.projectAction;
    if (action === 'edit') switchProject(id);
    if (action === 'compile') { switchProject(id); openCompile(); }
    if (action === 'rename') renameProject(id);
    if (action === 'cover') button.closest('.project-card').querySelector('.project-cover-input').click();
    if (action === 'export') exportProjectFile(id);
    if (action === 'delete') deleteProject(id);
  }));
  document.querySelectorAll('.project-cover-input').forEach(input => {
    input.addEventListener('click', e => e.stopPropagation());
    input.addEventListener('change', e => {
      const file = e.target.files[0];
      if (!file) return;
      const id = e.target.closest('.project-card').dataset.id;
      saveProjectCoverFile(id, file);
    });
  });
  // Drop a picture anywhere on a project's card (not just the cover itself) to make it the cover.
  // A .folio file dropped on a card still imports, as it does on the empty shelf.
  document.querySelectorAll('.project-card, .continue-cover').forEach(card => {
    const cover = card.querySelector('.project-cover');
    const projectId = card.dataset.id || (cover && cover.dataset.coverId);
    card.addEventListener('dragover', e => { e.preventDefault(); if (cover) cover.classList.add('drag-over'); });
    card.addEventListener('dragleave', e => { if (cover && !card.contains(e.relatedTarget)) cover.classList.remove('drag-over'); });
    card.addEventListener('drop', async e => {
      e.preventDefault(); e.stopPropagation();
      if (cover) cover.classList.remove('drag-over');
      const folio = [...e.dataTransfer.files].find(f => f.name.endsWith('.folio'));
      if (folio) { importProjectFile(folio); return; }
      const file = await imageFileFromDrop(e.dataTransfer);
      if (file) saveProjectCoverFile(projectId, file);
      else alert("That didn't come through as a picture. Try saving it to your Mac first, then drop the file on the cover.");
    });
  });
  hydrateProjectCovers(archive);
}

function renameProject(id) {
  const projects = projectArchive();
  const project = projects.find(p => p.id === id);
  if (!project) return;
  const title = prompt('Rename project', project.title);
  if (!title || !title.trim()) return;
  project.title = title.trim();
  project.updatedAt = new Date().toISOString();
  if (!writeProjectArchive(projects)) return;
  if (id === currentProjectId) {
    document.getElementById('project-title-input').value = project.title;
    persistState();
  }
  renderProjects();
}

async function deleteProject(id) {
  const projects = projectArchive();
  const project = projects.find(p => p.id === id);
  if (!project) return;
  if (!confirm(`Delete "${project.title}"?\n\nThis permanently deletes every chapter, note, and image in this project. This can't be undone.`)) return;

  const remaining = projects.filter(p => p.id !== id);
  if (!writeProjectArchive(remaining)) return;

  try { await deleteStoredCover(id); } catch (e) { /* no cover to remove */ }
  forgetProjectAppearance(id);
  localStorage.removeItem(`folio-formatter:${id}`);
  rememberDeletedProject(id);
  await removeProjectFromSyncFolder(id);

  // If the deleted project was the one currently open in the editor (it always is,
  // since the shelf this menu lives in is the app's default view), swap in another
  // project — or a fresh blank one if that was the last project — so nothing keeps
  // pointing at the id we just removed. Left untouched, the next autosave anywhere
  // in the app would call saveProjectToArchive() and silently resurrect it.
  if (id === currentProjectId) {
    const next = remaining.slice().sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))[0];
    if (next) {
      docs = next.docs.map(d => ({ ...d, createdAt: d.createdAt ? new Date(d.createdAt) : new Date() }));
      nextId = next.nextId;
      activeId = docs.some(d => d.id === next.activeId) ? next.activeId : docs[0].id;
      currentProjectId = next.id;
      document.getElementById('project-title-input').value = next.title;
    } else {
      currentProjectId = `project-${Date.now()}`;
      docs = [{ id: 1, title: 'Untitled', storyDate: '', banner: '', content: '', synopsis: '', status: 'draft', target: 0, tags: [], parent: null, isFolder: false, section: 'manuscript', createdAt: new Date() }];
      nextId = 2; activeId = 1;
      document.getElementById('project-title-input').value = 'Untitled Project';
    }
    sessionBaseWords = getSessionBase();
    renderTree(); loadDoc(activeId); persistState();
    if (!next) saveProjectToArchive();
    applyProjectAppearance();
  }

  renderProjects();
}

async function hydrateProjectCovers(projects) {
  await Promise.all(projects.map(async project => {
    try {
      let cover = await getStoredCover(project.id);
      if (!cover && project.cover) {
        cover = project.cover;
        await setStoredCover(project.id, cover);
      }
      if (!cover) return;
      document.querySelectorAll(`.project-cover[data-cover-id="${CSS.escape(project.id)}"]`).forEach(coverElement => {
        coverElement.style.backgroundImage = `url("${cover}")`;
        coverElement.classList.add('has-image');
        coverElement.querySelector('.project-cover-placeholder').hidden = true;
      });
      const card = document.querySelector(`.project-card[data-id="${CSS.escape(project.id)}"]`);
      if (!card) return;
      card.querySelector('[data-project-action="cover"]').textContent = 'Change cover image';
    } catch (error) {
      console.error('Could not load project cover', error);
    }
  }));
}

function switchProject(id) {
  saveProjectToArchive();
  const project = projectArchive().find(p => p.id === id);
  if (!project) return;
  docs = project.docs.map(d => ({ ...d, createdAt: d.createdAt ? new Date(d.createdAt) : new Date() }));
  nextId = project.nextId; activeId = docs.some(d => d.id === project.activeId) ? project.activeId : docs[0].id; currentProjectId = project.id;
  document.getElementById('project-title-input').value = project.title;
  document.getElementById('projects-overlay').classList.remove('open');
  sessionBaseWords = getSessionBase(); renderTree(); loadDoc(activeId); persistState();
  applyProjectAppearance();
}

function createProject() {
  const title = prompt('Project name', 'Untitled Project');
  if (!title || !title.trim()) return;
  saveProjectToArchive(); // flush whatever was being edited in the previous project
  currentProjectId = `project-${Date.now()}`;
  docs = [{ id: 1, title: 'Untitled', storyDate: '', banner: '', content: '', synopsis: '', status: 'draft', target: 0, tags: [], parent: null, isFolder: false, section: 'manuscript', createdAt: new Date() }];
  nextId = 2; activeId = 1; sessionBaseWords = getSessionBase();
  document.getElementById('project-title-input').value = title.trim();
  document.getElementById('projects-overlay').classList.remove('open');
  renderTree();
  loadDoc(activeId); // refresh the editor DOM to the new blank doc BEFORE anything below reads it back out
  persistState();
  saveProjectToArchive();
  applyProjectAppearance(); // a new novel starts with the default look
}

/* ────────────────────────────────────────
   Automatic backups
   In the desktop app, every book is also copied, as a dated .folio file, into a
   Backups folder on this Mac, apart from Dropbox (backups.js keeps the trail and
   thins out old copies). A copy is made about every ten minutes while you write,
   when Folio starts, and when it quits, and only if the book changed. To go back
   to one: Projects → Backups, then Import the file you want.
──────────────────────────────────────── */
const BACKUP_EVERY_MS = 10 * 60 * 1000;
let backupTimer = null;
let backupChain = Promise.resolve();
let backupWarned = false;

function scheduleBackup() {
  if (!window.folioBackups || backupTimer) return;
  backupTimer = setTimeout(() => { backupTimer = null; backupAllBooks(); }, BACKUP_EVERY_MS);
}

function backupAllBooks() {
  if (!window.folioBackups) return Promise.resolve();
  backupChain = backupChain.then(async () => {
    try { saveProjectToArchive(); } catch (e) { /* back up what's archived */ }
    for (const project of projectArchive()) {
      try {
        const payload = await buildProjectFilePayload(project.id, project);
        if (!payload) continue;
        await window.folioBackups.save({ id: project.id, title: project.title, text: JSON.stringify(payload) });
      } catch (e) {
        console.error(`Could not back up "${project.title}"`, e);
        if (!backupWarned) {
          backupWarned = true;
          showFolioToast("Folio couldn't make its automatic backup. Your writing is still saved; check your Mac has free disk space.", { warning: true });
        }
      }
    }
  });
  return backupChain;
}

/* ────────────────────────────────────────
   Project File Export / Import
   A project is packaged as a single .folio file (JSON under the hood) containing
   everything needed to reopen it on another device with no account or login: every
   doc's content, the project's cover image (pulled out of IndexedDB, since covers
   aren't part of the archived project record), and saved Book Formatter settings.
──────────────────────────────────────── */
const FOLIO_FILE_VERSION = 1;

async function buildProjectFilePayload(id, projectOverride) {
  const project = projectOverride || projectArchive().find(p => p.id === id);
  if (!project) return null;

  let cover = null;
  let coverUnreadable = false;
  try { cover = (await getStoredCover(project.id)) || null; } catch (e) { coverUnreadable = true; }

  let formatterSettings = null;
  try { formatterSettings = JSON.parse(localStorage.getItem(`folio-formatter:${project.id}`) || 'null'); } catch (e) { formatterSettings = null; }

  const payload = {
    folioFile: true,
    version: FOLIO_FILE_VERSION,
    exportedAt: new Date().toISOString(),
    project: { id: project.id, title: project.title, docs: project.docs, nextId: project.nextId, activeId: project.activeId, updatedAt: project.updatedAt },
    cover,
    formatterSettings
  };
  // Not written to the file: tells the synced-folder save that "no cover" here means
  // "couldn't read it", so it keeps the cover already in the file instead of erasing it.
  Object.defineProperty(payload, 'coverUnreadable', { value: coverUnreadable });
  return payload;
}

function safeFileSlug(title) {
  return (title || 'project').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase() || 'project';
}

async function exportProjectFile(id) {
  if (id === currentProjectId) saveProjectToArchive();
  const payload = await buildProjectFilePayload(id);
  if (!payload) { alert('That project could not be found.'); return; }

  const blob = new Blob([JSON.stringify(payload)], { type: 'application/json;charset=utf-8' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `${safeFileSlug(payload.project.title)}.folio`;
  link.click();
  URL.revokeObjectURL(link.href);
}

function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Could not read file'));
    reader.onload = () => resolve(reader.result);
    reader.readAsText(file);
  });
}

async function importProjectFile(file) {
  if (!file) return;
  let data;
  try {
    data = JSON.parse(await readFileAsText(file));
  } catch (e) {
    alert('That file could not be read. Choose a .folio project file exported from Folio.');
    return;
  }
  if (!data || !data.folioFile || !data.project || !Array.isArray(data.project.docs) || !data.project.id) {
    alert('That file is not a valid Folio project file.');
    return;
  }

  saveProjectToArchive(); // flush the currently open project before switching away from it

  // A file re-exported from a project already on this device (from an earlier import,
  // or from the synced folder) carries that same project's id — matching on it here,
  // instead of always minting a new id, is what lets re-importing update the existing
  // project in place rather than piling up duplicate copies every time.
  const archive = projectArchive();
  const existing = archive.find(p => p.id === data.project.id);
  const wasCurrent = data.project.id === currentProjectId;

  if (existing && !confirm(`"${existing.title}" already exists on this device (from an earlier import or sync).\n\nReplace it with this file's version? This can't be undone.`)) return;

  const importedDocs = data.project.docs.map(d => ({ ...d }));
  let title = data.project.title || 'Imported Project';
  if (!existing && archive.some(p => p.title === title)) title = `${title} (imported)`;

  const normalized = {
    ...data,
    project: {
      id: data.project.id,
      title,
      docs: importedDocs,
      nextId: typeof data.project.nextId === 'number' ? data.project.nextId : Math.max(0, ...importedDocs.map(d => d.id)) + 1,
      activeId: importedDocs.some(d => d.id === data.project.activeId) ? data.project.activeId : (importedDocs[0] ? importedDocs[0].id : 1),
      updatedAt: new Date().toISOString()
    }
  };

  forgetDeletedProject(normalized.project.id); // importing on purpose brings a deleted project back
  const entry = await upsertSyncedProject(normalized);

  if (wasCurrent) {
    // switchProject() always flushes the in-memory doc to the archive first, which
    // would clobber the version we just imported — so when re-importing an update to
    // the project you're already editing, load it in place instead.
    docs = entry.docs.map(d => ({ ...d, createdAt: d.createdAt ? new Date(d.createdAt) : new Date() }));
    nextId = entry.nextId;
    activeId = docs.some(d => d.id === entry.activeId) ? entry.activeId : (docs[0] ? docs[0].id : 1);
    document.getElementById('project-title-input').value = entry.title;
    document.getElementById('projects-overlay').classList.remove('open');
    sessionBaseWords = getSessionBase();
    renderTree(); loadDoc(activeId); persistState();
  } else {
    switchProject(entry.id);
  }
  renderProjects();
}

/* ────────────────────────────────────────
   Synced Folder
   An alternative to manual Export/Import: point Folio at a folder your OS already
   syncs (Dropbox, iCloud Drive, …) via the File System Access API, and every save
   writes a .folio file there automatically — so the *transfer* between devices
   happens for free, and only loading it back in on the other device stays manual.
   Desktop Chrome/Edge only; the API doesn't exist in Safari or on iOS, so this is
   silently unavailable there and Export/Import remains the cross-platform path.
──────────────────────────────────────── */
let syncFolderHandle = null;

function syncFolderSupported() { return Boolean(window.folioNative) || 'showDirectoryPicker' in window; }

async function ensureSyncFolderPermission(handle, requestIfNeeded) {
  if (!handle) return false;
  const opts = { mode: 'readwrite' };
  try {
    if ((await handle.queryPermission(opts)) === 'granted') return true;
    if (!requestIfNeeded) return false;
    return (await handle.requestPermission(opts)) === 'granted';
  } catch (e) {
    return false;
  }
}

function syncFilenameMap() {
  try { return JSON.parse(localStorage.getItem('folio-sync-filenames') || '{}'); } catch (e) { return {}; }
}
function setSyncFilenameMap(map) {
  try { localStorage.setItem('folio-sync-filenames', JSON.stringify(map)); } catch (e) { /* ignore */ }
}

/* Ids of projects the user deleted. Without this, scanSyncFolder() would find the
   deleted project's leftover .folio file, see a project it doesn't know, and
   import it straight back. */
function deletedProjectIds() {
  try { return JSON.parse(localStorage.getItem('folio-deleted-projects') || '[]'); } catch (e) { return []; }
}
function rememberDeletedProject(id) {
  const ids = deletedProjectIds();
  if (!ids.includes(id)) ids.push(id);
  try { localStorage.setItem('folio-deleted-projects', JSON.stringify(ids)); } catch (e) { /* ignore */ }
}
function forgetDeletedProject(id) {
  const ids = deletedProjectIds().filter(x => x !== id);
  try { localStorage.setItem('folio-deleted-projects', JSON.stringify(ids)); } catch (e) { /* ignore */ }
}

async function removeProjectFromSyncFolder(id) {
  const map = syncFilenameMap();
  const name = map[id];
  delete map[id];
  setSyncFilenameMap(map);
  if (!name || !syncFolderHandle) return;
  if (!(await ensureSyncFolderPermission(syncFolderHandle, false))) return; // scanSyncFolder() cleans it up later
  try { await syncFolderHandle.removeEntry(name); } catch (e) { /* already gone */ }
}

/* Folder writes run one at a time. Several things can ask for a write within the
   same second (auto-save, merging Claude's edits, quitting); letting them overlap
   could leave a half-finished save behind. */
let syncWriteChain = Promise.resolve();
let syncWritesInFlight = 0;
let syncWritesClosed = false;

function writeProjectToSyncFolder(project) {
  if (syncWritesClosed) return Promise.resolve();
  syncWritesInFlight++;
  const run = syncWriteChain.then(() => writeProjectFileNow(project)).finally(() => { syncWritesInFlight--; });
  syncWriteChain = run.catch(() => {});
  return run;
}

/* Resolves once every folder write asked for so far has finished. */
function syncWritesSettled() {
  return syncWriteChain;
}

async function writeProjectFileNow(project) {
  if (!syncFolderHandle) return;
  if (!(await ensureSyncFolderPermission(syncFolderHandle, false))) { warnSyncFolderNeedsAccess(); return; } // never prompt during a background autosave
  let writable = null;
  try {
    const map = syncFilenameMap();
    let newName = `${safeFileSlug(project.title)}.folio`;
    // Two projects with the same title must not share (and overwrite) one file.
    if (Object.entries(map).some(([id, name]) => id !== project.id && name === newName)) {
      newName = `${safeFileSlug(project.title)}-${safeFileSlug(String(project.id)).slice(-6)}.folio`;
    }
    const oldName = map[project.id];

    // If Claude changed this file and Folio hasn't merged that in yet, writing now
    // would wipe Claude's edits. Merge first — that saves and writes again itself.
    const pending = await readSyncFile(oldName || newName);
    if (pending && pending.claudeChanges && pending.project && pending.project.id === project.id
        && !appliedClaudeChangeIds().includes(pending.claudeChanges.id)) {
      // Run it after this write slot is released — it queues its own write.
      setTimeout(() => applyClaudeChanges(pending), 0);
      return;
    }

    const payload = await buildProjectFilePayload(project.id, project);
    if (!payload.cover && payload.coverUnreadable && pending && pending.cover) payload.cover = pending.cover;
    const fileHandle = await syncFolderHandle.getFileHandle(newName, { create: true });
    writable = await fileHandle.createWritable();
    await writable.write(JSON.stringify(payload));
    await writable.close();
    writable = null;
    // Only drop the old file (after a rename) once the new one is safely written.
    if (oldName && oldName !== newName) {
      try { await syncFolderHandle.removeEntry(oldName); } catch (e) { /* already gone */ }
    }
    map[project.id] = newName;
    setSyncFilenameMap(map);
    reportSave('folder', true);
  } catch (e) {
    console.error('Could not write to synced folder', e);
    if (isFolderBlockedError(e)) reportFolderBlocked(); else reportSave('folder', false);
    // A save that fails partway leaves a "<name>.crswap" temp file behind unless aborted.
    if (writable) { try { await writable.abort(); } catch (abortError) { /* ignore */ } }
  }
}

/* Removes "<name>.crswap" temp files left by saves that were cut off (for example
   by quitting mid-save). Only runs when no save is in progress, since a running
   save owns its temp file. */
async function removeStaleSwapFiles() {
  if (!syncFolderHandle || syncWritesInFlight > 0) return;
  try {
    const stale = [];
    for await (const entry of syncFolderHandle.values()) {
      if (entry.kind === 'file' && entry.name.endsWith('.crswap')) stale.push(entry.name);
    }
    for (const name of stale) {
      if (syncWritesInFlight > 0) return;
      try { await syncFolderHandle.removeEntry(name); } catch (e) { /* in use or gone */ }
    }
  } catch (e) { /* ignore */ }
}

/* Electron forgets folder access every time Folio restarts. Asking again needs
   a click or key press, so the first time you touch Folio after it opens, it
   quietly asks then (Electron grants it without a dialog). Without this, every
   save to the synced folder was silently skipped until you clicked Reconnect. */
let syncAccessListenerArmed = false;
let syncAccessWarned = false;

function armSyncFolderReconnectOnInteraction() {
  if (syncAccessListenerArmed || !syncFolderHandle) return;
  syncAccessListenerArmed = true;
  const onInteract = async () => {
    document.removeEventListener('pointerdown', onInteract, true);
    document.removeEventListener('keydown', onInteract, true);
    syncAccessListenerArmed = false;
    const granted = await ensureSyncFolderPermission(syncFolderHandle, true);
    updateSyncFolderUI(!granted);
    if (!granted) { warnSyncFolderNeedsAccess(true); return; }
    syncAccessWarned = false;
    await scanSyncFolder();
    await writeMissingProjectsToSyncFolder();
    delete lastAutoSyncedSignature[currentProjectId];
    autoSyncCurrentProject(); // write anything that piled up while access was missing
  };
  document.addEventListener('pointerdown', onInteract, true);
  document.addEventListener('keydown', onInteract, true);
}

function warnSyncFolderNeedsAccess(force) {
  if (!syncFolderHandle) return;
  armSyncFolderReconnectOnInteraction();
  if (syncAccessWarned && !force) return;
  syncAccessWarned = true;
  if (force) showFolioToast("Folio can't save to your synced folder. Open Projects and click Reconnect.");
}

/* Writes or replaces one project's archive entry from data read out of the synced
   folder, restoring its cover and formatter settings alongside it. Shared by both
   the "never seen this project before" and "found a newer version" paths below. */
async function upsertSyncedProject(data) {
  const archive = projectArchive();
  const index = archive.findIndex(p => p.id === data.project.id);
  const entry = {
    id: data.project.id,
    title: data.project.title,
    docs: data.project.docs,
    nextId: data.project.nextId,
    activeId: data.project.activeId,
    updatedAt: data.project.updatedAt || new Date().toISOString()
  };
  if (index >= 0) archive[index] = entry; else archive.push(entry);
  writeProjectArchive(archive);
  if (data.cover) { try { await setStoredCover(entry.id, data.cover); } catch (e) { /* ignore */ } }
  if (data.formatterSettings) { try { localStorage.setItem(`folio-formatter:${entry.id}`, JSON.stringify(data.formatterSettings)); } catch (e) { /* ignore */ } }
  return entry;
}

async function applySyncedUpdate(data) {
  const entry = await upsertSyncedProject(data);
  if (entry.id === currentProjectId) {
    docs = entry.docs.map(d => ({ ...d, createdAt: d.createdAt ? new Date(d.createdAt) : new Date() }));
    nextId = entry.nextId;
    activeId = docs.some(d => d.id === entry.activeId) ? entry.activeId : (docs[0] ? docs[0].id : 1);
    document.getElementById('project-title-input').value = entry.title;
    renderTree(); loadDoc(activeId); persistState();
  }
  renderProjects();
  scanSyncFolder(); // clears the resolved conflict out of the list
}

function updateSyncFolderUI(reconnectNeeded) {
  const text = document.getElementById('sync-status-text');
  const chooseBtn = document.getElementById('sync-choose-btn');
  const reconnectBtn = document.getElementById('sync-reconnect-btn');
  const disconnectBtn = document.getElementById('sync-disconnect-btn');
  if (!text) return;

  if (!syncFolderSupported()) {
    text.textContent = 'Folder sync needs Chrome or Edge on desktop — use Export/Import here instead.';
    chooseBtn.hidden = true; reconnectBtn.hidden = true; disconnectBtn.hidden = true;
    return;
  }
  if (!syncFolderHandle) {
    text.textContent = 'Synced folder: not connected';
    chooseBtn.hidden = false; reconnectBtn.hidden = true; disconnectBtn.hidden = true;
    return;
  }
  text.textContent = reconnectNeeded
    ? `Synced folder: ${syncFolderHandle.name} — access needs to be reconfirmed`
    : `Synced folder: ${syncFolderHandle.name}`;
  chooseBtn.hidden = true;
  reconnectBtn.hidden = !reconnectNeeded;
  disconnectBtn.hidden = false;
}

function renderSyncConflicts(conflicts) {
  const el = document.getElementById('sync-conflicts');
  if (!el) return;
  if (!conflicts.length) { el.innerHTML = ''; el.hidden = true; return; }
  el.hidden = false;
  el.innerHTML = conflicts.map(({ local, data }) => `
    <div class="sync-conflict" data-id="${escapeHTML(local.id)}">
      <span>“${escapeHTML(local.title)}” has newer edits in the synced folder, from ${new Date(data.project.updatedAt).toLocaleString()}.</span>
      <button type="button" data-sync-load="${escapeHTML(local.id)}">Load newer version</button>
      <button type="button" data-sync-ignore="${escapeHTML(local.id)}">Ignore</button>
    </div>`).join('');
  el.querySelectorAll('[data-sync-load]').forEach(btn => btn.addEventListener('click', () => {
    const conflict = conflicts.find(c => c.local.id === btn.dataset.syncLoad);
    if (conflict) applySyncedUpdate(conflict.data);
  }));
  el.querySelectorAll('[data-sync-ignore]').forEach(btn => btn.addEventListener('click', () => {
    btn.closest('.sync-conflict').remove();
    if (!el.querySelector('.sync-conflict')) el.hidden = true;
  }));
}

async function scanSyncFolder() {
  if (!syncFolderHandle) return;
  const granted = await ensureSyncFolderPermission(syncFolderHandle, false);
  updateSyncFolderUI(!granted);
  if (!granted) { armSyncFolderReconnectOnInteraction(); return; }
  await removeStaleSwapFiles();

  const archive = projectArchive();
  const deletedIds = deletedProjectIds();
  const conflicts = [];
  let importedAny = false;

  try {
    for await (const entry of syncFolderHandle.values()) {
      if (entry.kind !== 'file' || !entry.name.endsWith('.folio')) continue;
      let data;
      try { data = JSON.parse(await (await entry.getFile()).text()); } catch (e) { continue; }
      if (!data || !data.folioFile || !data.project || !data.project.id) continue;

      // A project the user deleted: clear out its leftover file instead of re-importing it.
      if (deletedIds.includes(data.project.id)) {
        try { await syncFolderHandle.removeEntry(entry.name); } catch (e) { /* ignore */ }
        continue;
      }

      // Edits Claude made through the Folio connector are merged in automatically.
      if (data.claudeChanges && !appliedClaudeChangeIds().includes(data.claudeChanges.id)) {
        await applyClaudeChanges(data);
        continue;
      }

      const local = archive.find(p => p.id === data.project.id);
      if (!local) {
        await upsertSyncedProject(data);
        importedAny = true;
        continue;
      }
      const remoteTime = new Date(data.project.updatedAt || 0).getTime();
      const localTime  = new Date(local.updatedAt || 0).getTime();
      if (remoteTime > localTime + 1000) conflicts.push({ local, data }); // meaningfully newer, not just clock jitter
    }
  } catch (e) {
    console.error('Could not scan synced folder', e);
    if (isFolderBlockedError(e)) reportFolderBlocked();
  }

  if (importedAny) renderProjects();
  renderSyncConflicts(conflicts);
}

/* Every fresh install's very first project is bootstrapped with the literal id
   'default' (see the top-level `let currentProjectId = 'default'`) — harmless on
   a single device, but two devices each have their OWN unrelated 'default'
   project, and both scanSyncFolder() and importProjectFile() now match projects
   by id (so re-importing/re-syncing updates the same project instead of creating
   a duplicate each time). Without this, two devices' first-ever projects would
   look like the same project to that matching — either flagged as a stale/newer
   copy of each other over a synced folder, or silently overwritten by a plain
   file import — instead of the two separate, unrelated projects they actually
   are. Called once at startup, before anything can ever compare ids. */
function ensureUniqueProjectId() {
  // Checks the whole archive, not just whichever project happens to be open right
  // now — someone with several pre-existing projects might not currently have their
  // very first one (the one actually carrying the old 'default' id) active, and it
  // would otherwise sit in the list indefinitely still vulnerable to the collision.
  const archive = projectArchive();
  const staleEntry = archive.find(p => p.id === 'default');
  if (!staleEntry && currentProjectId !== 'default') return;

  const newId = `project-${Date.now()}`;
  if (staleEntry) { staleEntry.id = newId; writeProjectArchive(archive); }
  moveProjectAppearance('default', newId);
  // The cover is stored by project id, so carry it over to the new id.
  getStoredCover('default').then(cover => {
    if (!cover) return;
    return setStoredCover(newId, cover).then(() => deleteStoredCover('default')).then(() => renderProjects());
  }).catch(() => { /* no cover to move */ });
  const formatter = localStorage.getItem('folio-formatter:default');
  if (formatter) { localStorage.setItem(`folio-formatter:${newId}`, formatter); localStorage.removeItem('folio-formatter:default'); }
  if (currentProjectId === 'default') { currentProjectId = newId; persistState(); }
}

/* In the desktop app, the synced folder is reached through Electron (preload.js →
   sync-folder.js) rather than the browser's File System Access API, which kept
   losing access and leaving half-finished saves behind. This wraps those calls in
   the same shape as a browser folder handle, so the rest of the sync code works
   unchanged with either. */
function nativeSyncFolderHandle(folderPath) {
  const api = window.folioNative;
  const notFound = name => new DOMException(`${name} not found`, 'NotFoundError');
  const fileFrom = (name, info) => ({ name, lastModified: info.mtimeMs, text: () => api.read(name) });
  const fileHandle = (name, knownInfo) => ({
    kind: 'file',
    name,
    async getFile() {
      const info = knownInfo || await api.stat(name);
      if (!info) throw notFound(name);
      return fileFrom(name, info);
    },
    async createWritable() {
      let parts = [];
      return {
        async write(data) { parts.push(String(data)); },
        async close() { await api.write(name, parts.join('')); parts = []; }, // written atomically by sync-folder.js
        async abort() { parts = []; }
      };
    }
  });
  return {
    kind: 'directory',
    native: true,
    name: folderPath.split(/[\\/]/).filter(Boolean).pop() || folderPath,
    path: folderPath,
    async queryPermission() { return 'granted'; },
    async requestPermission() { return 'granted'; },
    async *values() { for (const info of await api.list()) yield fileHandle(info.name, info); },
    async getFileHandle(name, options = {}) {
      if (!options.create && !(await api.stat(name))) throw notFound(name);
      return fileHandle(name);
    },
    async removeEntry(name) { await api.remove(name); }
  };
}

async function chooseSyncFolder() {
  if (!syncFolderSupported()) {
    alert("Folder sync needs the File System Access API, which only Chrome and Edge on desktop support right now — Safari and iPhone browsers don't have it. Use Export/Import to move projects between those.");
    return;
  }
  try {
    let handle;
    if (window.folioNative) {
      const folderPath = await window.folioNative.chooseSyncFolder();
      if (!folderPath) return; // cancelled
      handle = nativeSyncFolderHandle(folderPath);
      try { await clearSyncFolderHandle(); } catch (e) { /* no old browser handle */ }
    } else {
      handle = await window.showDirectoryPicker({ id: 'folio-sync', mode: 'readwrite' });
      await setSyncFolderHandle(handle);
    }
    syncFolderHandle = handle;
    updateSyncFolderUI();
    ensureUniqueProjectId();
    saveProjectToArchive(); // writes the current project into the folder immediately
    await scanSyncFolder();
    await writeMissingProjectsToSyncFolder();
    startSyncPolling();
  } catch (e) {
    if (e.name !== 'AbortError') console.error('Could not choose synced folder', e);
  }
}

async function reconnectSyncFolder() {
  if (!syncFolderHandle) return;
  // In the desktop app, macOS gives the access back when you pick the folder
  // yourself; the dialog opens on the current folder, so it's one click.
  if (syncFolderHandle.native) { await chooseSyncFolder(); return; }
  const granted = await ensureSyncFolderPermission(syncFolderHandle, true);
  updateSyncFolderUI(!granted);
  if (granted) { ensureUniqueProjectId(); await scanSyncFolder(); }
}

async function disconnectSyncFolder() {
  stopSyncPolling();
  syncFolderHandle = null;
  if (window.folioNative) { try { await window.folioNative.clearSyncFolder(); } catch (e) { /* ignore */ } }
  await clearSyncFolderHandle();
  updateSyncFolderUI();
  renderSyncConflicts([]);
}

async function loadSyncFolderHandle() {
  if (!syncFolderSupported()) { updateSyncFolderUI(); return; }
  try {
    let handle = null;
    if (window.folioNative) {
      const folderPath = await window.folioNative.getSyncFolder();
      if (folderPath) {
        handle = nativeSyncFolderHandle(folderPath);
      } else if (await getSyncFolderHandle().catch(() => null)) {
        // Connected the old way, which doesn't work reliably in the desktop app.
        showFolioToast('Folio now saves to your synced folder a more reliable way. Open Projects and choose the folder once more.');
      }
    } else {
      handle = await getSyncFolderHandle();
    }
    if (!handle) { updateSyncFolderUI(); return; }
    syncFolderHandle = handle;
    ensureUniqueProjectId();
    await scanSyncFolder();
    await writeMissingProjectsToSyncFolder();
    startSyncPolling();
  } catch (e) {
    console.error('Could not load synced folder handle', e);
  }
}

/* ────────────────────────────────────────
   Claude connector support
   The Folio connector (claude-connector/folio-mcp.js) lets the Claude desktop app
   read and edit projects through the .folio files in the synced folder. Three
   things make that work smoothly while Folio is open:
   1. Auto-sync: a couple of seconds after you stop typing, the open project is
      written to the synced folder, so Claude always reads your latest text.
   2. Polling: every few seconds Folio looks for files Claude changed.
   3. Merging: Claude's file says exactly which fields of which documents it
      changed, and a fingerprint of the value it started from. Folio applies
      only those changes on top of what's open. If you changed the same thing in
      the meantime, your version stays and Claude's is saved as a History
      snapshot on that document — nothing is ever silently lost.
──────────────────────────────────────── */
let autoSyncTimer = null;
let syncPollTimer = null;
let syncPollBusy = false;
const lastAutoSyncedSignature = {};
const seenSyncFileTimes = {};

function scheduleAutoSync() {
  clearTimeout(autoSyncTimer);
  autoSyncTimer = setTimeout(autoSyncCurrentProject, 2000);
}

function autoSyncCurrentProject() {
  if (!syncFolderHandle) return;
  saveCurrentDoc();
  const signature = JSON.stringify({ title: document.getElementById('project-title-input').value, docs, nextId });
  if (lastAutoSyncedSignature[currentProjectId] === signature) return; // nothing new since the last write
  lastAutoSyncedSignature[currentProjectId] = signature;
  saveProjectToArchive();
}

function startSyncPolling() {
  stopSyncPolling();
  syncPollTimer = setInterval(pollSyncFolderForClaudeChanges, 3000);
}

function stopSyncPolling() {
  clearInterval(syncPollTimer);
  syncPollTimer = null;
}

async function readSyncFile(name) {
  if (!syncFolderHandle || !name) return null;
  try {
    const file = await (await syncFolderHandle.getFileHandle(name)).getFile();
    return JSON.parse(await file.text());
  } catch (e) {
    return null; // missing or unreadable
  }
}

async function pollSyncFolderForClaudeChanges() {
  if (!syncFolderHandle || syncPollBusy) return;
  syncPollBusy = true;
  try {
    if (!(await ensureSyncFolderPermission(syncFolderHandle, false))) return;
    for await (const entry of syncFolderHandle.values()) {
      if (saveHealth.folderBlocked) {
        // The folder can be read again, so access is back: write what piled up meanwhile.
        saveHealth.folderBlocked = false;
        updateSyncFolderUI();
        delete lastAutoSyncedSignature[currentProjectId];
        autoSyncCurrentProject();
      }
      if (entry.kind !== 'file' || !entry.name.endsWith('.folio')) continue;
      const file = await entry.getFile();
      if (seenSyncFileTimes[entry.name] === file.lastModified) continue;
      seenSyncFileTimes[entry.name] = file.lastModified;
      let data;
      try { data = JSON.parse(await file.text()); } catch (e) { continue; }
      if (data && data.folioFile && data.project && data.claudeChanges && !appliedClaudeChangeIds().includes(data.claudeChanges.id)) {
        await applyClaudeChanges(data);
      }
    }
  } catch (e) {
    console.error('Could not check synced folder for Claude edits', e);
    if (isFolderBlockedError(e)) reportFolderBlocked();
  } finally {
    syncPollBusy = false;
  }
}

/* Every project should have a file in the synced folder — otherwise Claude can't see it. */
async function writeMissingProjectsToSyncFolder() {
  if (!syncFolderHandle || !(await ensureSyncFolderPermission(syncFolderHandle, false))) return;
  const map = syncFilenameMap();
  for (const project of projectArchive()) {
    if (map[project.id] && (await readSyncFile(map[project.id]))) continue;
    await writeProjectToSyncFolder(project);
  }
}

function appliedClaudeChangeIds() {
  try { return JSON.parse(localStorage.getItem('folio-claude-applied') || '[]'); } catch (e) { return []; }
}
function rememberAppliedClaudeChange(id) {
  const ids = appliedClaudeChangeIds().filter(x => x !== id);
  ids.push(id);
  try { localStorage.setItem('folio-claude-applied', JSON.stringify(ids.slice(-200))); } catch (e) { /* ignore */ }
}

/* Same fingerprint function as valueHash() in claude-connector/folio-mcp.js — keep them identical. */
function folioValueHash(value) {
  const s = typeof value === 'string' ? value : JSON.stringify(value === undefined ? null : value);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return `${(h >>> 0).toString(16)}:${s.length}`;
}

/* Applies Claude's recorded changes (see the connector's recordChanges()) to a
   list of documents. Returns new document objects; never mutates the input. */
function mergeClaudeChanges(localDocs, remoteProject, changes, localNextId) {
  const out = localDocs.map(d => ({ ...d }));
  const byId = new Map(out.map(d => [d.id, d]));
  const remoteById = new Map(remoteProject.docs.map(d => [d.id, d]));
  const touched = new Set();
  const updated = [];
  const conflicts = [];

  for (const [idKey, fields] of Object.entries(changes.docs || {})) {
    const local = byId.get(Number(idKey));
    const remote = remoteById.get(Number(idKey));
    if (!local || !remote) continue; // you deleted it meanwhile, or the file is odd
    let changed = false, conflicted = false;
    for (const [field, beforeHash] of Object.entries(fields)) {
      if (field === 'snapshots') {
        const have = new Set((local.snapshots || []).map(s => s.id));
        const added = (remote.snapshots || []).filter(s => !have.has(s.id));
        if (added.length) { local.snapshots = [...added, ...(local.snapshots || [])].sort((a, b) => b.id - a.id); changed = true; }
        continue;
      }
      const localHash = folioValueHash(local[field]);
      if (localHash === folioValueHash(remote[field])) continue; // already the same
      if (localHash === beforeHash) { local[field] = remote[field]; changed = true; continue; }
      // You changed this too since Claude read it — keep yours.
      conflicted = true;
      if (field === 'content') {
        local.snapshots = [{
          id: Date.now(), title: remote.title, content: remote.content || '', words: countWords(remote.content || ''),
          createdAt: new Date().toISOString(), label: "Claude's version (you were editing at the same time)"
        }, ...(local.snapshots || [])];
        changed = true;
      } else if (field === 'documentNote' && typeof remote.documentNote === 'string') {
        const claudeNotes = remote.documentNote.split('\n\n').filter(p => p.startsWith('Claude (') && !(local.documentNote || '').includes(p));
        if (claudeNotes.length) { local.documentNote = [(local.documentNote || '').trim(), ...claudeNotes].filter(Boolean).join('\n\n'); changed = true; }
      }
    }
    if (changed) touched.add(local.id);
    if (conflicted) conflicts.push(local.title); else if (changed) updated.push(local.title);
  }

  // New documents Claude created, placed after the same neighbour as in Claude's file.
  let maxId = Math.max(0, ...out.map(d => d.id));
  const renumbered = new Map();
  for (const createdId of changes.created || []) {
    const remote = remoteById.get(createdId);
    if (!remote) continue;
    const existing = byId.get(createdId);
    if (existing && existing.title === remote.title && existing.content === remote.content) continue; // already here
    const doc = { ...remote };
    if (existing) { doc.id = ++maxId; renumbered.set(createdId, doc.id); } // you created a document with the same id meanwhile
    maxId = Math.max(maxId, doc.id);
    const remoteIndex = remoteProject.docs.findIndex(d => d.id === createdId);
    let insertAt = out.length;
    for (let i = remoteIndex - 1; i >= 0; i--) {
      const neighbourId = renumbered.get(remoteProject.docs[i].id) ?? remoteProject.docs[i].id;
      const at = out.findIndex(d => d.id === neighbourId);
      if (at !== -1) { insertAt = at + 1; break; }
    }
    out.splice(insertAt, 0, doc);
    byId.set(doc.id, doc);
    touched.add(doc.id);
    updated.push(`${doc.title} (new)`);
  }
  const createdIds = new Set((changes.created || []).map(id => renumbered.get(id) ?? id));
  for (const doc of out) {
    if (createdIds.has(doc.id) && renumbered.has(doc.parent)) doc.parent = renumbered.get(doc.parent);
    if (doc.parent != null && !byId.has(doc.parent)) doc.parent = null;
  }

  const nextIdOut = Math.max(localNextId || 1, remoteProject.nextId || 1, maxId + 1);
  return { docs: out, nextId: nextIdOut, touched, updated, conflicts };
}

async function applyClaudeChanges(data) {
  const changes = data.claudeChanges;
  if (!changes || appliedClaudeChangeIds().includes(changes.id)) return false;
  rememberAppliedClaudeChange(changes.id);
  const id = data.project.id;
  if (deletedProjectIds().includes(id)) return false;

  let result;
  if (id === currentProjectId) {
    saveCurrentDoc(); // capture what's in the editor right now
    result = mergeClaudeChanges(docs, data.project, changes, nextId);
    docs = result.docs.map(d => ({ ...d, createdAt: d.createdAt ? new Date(d.createdAt) : new Date() }));
    nextId = result.nextId;
    if (!docs.some(d => d.id === activeId)) activeId = docs[0].id;
    if (result.touched.has(activeId)) loadDoc(activeId); else { renderTree(); renderSnapshots(); }
    updateTotals();
    saveProjectToArchive(); // writes the merged project back, which also clears Claude's change record from the file
    persistState();
  } else {
    const archive = projectArchive();
    const entry = archive.find(p => p.id === id);
    if (!entry) {
      await upsertSyncedProject(data);
      renderProjects();
      return true;
    }
    result = mergeClaudeChanges(entry.docs, data.project, changes, entry.nextId);
    entry.docs = result.docs;
    entry.nextId = result.nextId;
    entry.updatedAt = new Date().toISOString();
    writeProjectArchive(archive);
    await writeProjectToSyncFolder(entry);
    renderProjects();
  }

  const name = list => list.slice(0, 3).map(t => `“${t}”`).join(', ') + (list.length > 3 ? ` and ${list.length - 3} more` : '');
  if (result.conflicts.length) {
    showFolioToast(`Claude edited ${name(result.conflicts)} while you were too — your version was kept, and Claude's is in History.`);
  } else if (result.updated.length) {
    showFolioToast(`Claude updated ${name(result.updated)}${id === currentProjectId ? '' : ` in “${data.project.title}”`}. Earlier versions are in History.`);
  }
  return true;
}

function hideFolioToast(kind) {
  const toast = document.getElementById('folio-toast');
  if (toast && (!kind || toast.dataset.kind === kind)) toast.classList.remove('show');
}

function showFolioToast(message, { sticky = false, warning = false, kind = '' } = {}) {
  let toast = document.getElementById('folio-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'folio-toast';
    toast.setAttribute('role', 'status');
    document.body.appendChild(toast);
  }
  toast.textContent = message;
  toast.dataset.kind = kind;
  toast.classList.toggle('warning', warning);
  if (sticky) { // stays until dismissed, so a save problem can't flash by unseen
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'folio-toast-close';
    close.textContent = 'OK';
    close.addEventListener('click', () => toast.classList.remove('show'));
    toast.appendChild(close);
  }
  toast.classList.add('show');
  clearTimeout(toast.hideTimer);
  if (!sticky) toast.hideTimer = setTimeout(() => toast.classList.remove('show'), 6000);
}

/* ────────────────────────────────────────
   Transcribe audio into the story
   The microphone button (or dropping an audio file on the page) transcribes the
   file with transcribe.js and puts the text where the cursor was. While it works,
   a small "Transcribing…" marker holds that spot, so you can keep writing (or even
   switch documents) and the text still lands in the right place.
──────────────────────────────────────── */
const activeTranscriptions = new Set();
let nextTranscriptionId = 1;
let audioInsertRange = null;

function rememberAudioInsertPoint() {
  const editor = document.getElementById('editor');
  const selection = window.getSelection();
  if (selection?.rangeCount) {
    const range = selection.getRangeAt(0);
    if (editor.contains(range.startContainer) && editor.contains(range.endContainer)) {
      audioInsertRange = range.cloneRange();
      return;
    }
  }
  audioInsertRange = null;
}

/* A marker left behind by a transcription that is no longer running (Folio was
   closed mid-way) would otherwise sit in the story forever. */
function removeStaleTranscriptionMarks(root) {
  root.querySelectorAll('.folio-transcribing').forEach(mark => {
    if (!activeTranscriptions.has(mark.dataset.tid)) mark.remove();
  });
}

function placeTranscriptionMark(range, fileName) {
  const editor = document.getElementById('editor');
  const mark = document.createElement('span');
  mark.className = 'folio-transcribing';
  mark.contentEditable = 'false';
  mark.dataset.tid = String(nextTranscriptionId++);
  mark.dataset.label = fileName;
  mark.textContent = `Transcribing ${fileName}…`;

  if (range && editor.contains(range.startContainer)) {
    range = range.cloneRange();
    range.collapse(false); // never replace selected text; insert after it
  } else {
    // No cursor in the story: add to the end.
    range = document.createRange();
    const last = editor.lastElementChild;
    if (last && /^(P|H1|H2|H3|BLOCKQUOTE|DIV)$/.test(last.tagName) && !last.classList.contains('scene-break')) {
      range.selectNodeContents(last);
      range.collapse(false);
    } else {
      const p = document.createElement('p');
      editor.appendChild(p);
      range.selectNodeContents(p);
    }
  }

  // Keep #editor a flat list of blocks: a marker at the top level gets its own paragraph.
  if (range.startContainer === editor) {
    const p = document.createElement('p');
    p.appendChild(mark);
    range.insertNode(p);
  } else {
    range.insertNode(mark);
  }
  // An empty paragraph's placeholder <br> would push the marker onto its own line.
  const block = mark.parentElement;
  if (block && block.lastChild?.nodeName === 'BR' && block.childNodes.length === 2) block.lastChild.remove();

  const after = document.createRange();
  after.setStartAfter(mark);
  after.collapse(true);
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(after);
  editor.dispatchEvent(new Event('input', { bubbles: true }));
  return mark;
}

/* Swap the marker for the transcript. Returns false if the marker is gone. */
function replaceTranscriptionMark(mark, text) {
  if (!mark.isConnected) return false;
  const prev = mark.previousSibling, next = mark.nextSibling;
  const prevText = prev && prev.nodeType === Node.TEXT_NODE ? prev.textContent : (prev ? prev.textContent : '');
  const nextText = next && next.nodeType === Node.TEXT_NODE ? next.textContent : (next ? next.textContent : '');
  let out = text;
  // Mid-sentence (after a comma, a word…): Whisper's leading capital doesn't belong.
  if (prevText.trim() && !/[.!?…:"“]\s*$/.test(prevText) && /^[A-Z][a-z]/.test(out) && !/^I\b/.test(out)) {
    out = out[0].toLowerCase() + out.slice(1);
  }
  if (prevText && !/\s$/.test(prevText)) out = ' ' + out;
  if (nextText && !/^[\s.,;:!?)\]”’]/.test(nextText)) out = out + ' ';
  mark.replaceWith(document.createTextNode(out));
  return true;
}

function finishTranscription(tid, text) {
  const editor = document.getElementById('editor');
  const live = editor.querySelector(`.folio-transcribing[data-tid="${tid}"]`);
  if (live) {
    if (text) replaceTranscriptionMark(live, text); else live.remove();
    editor.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  }
  // You moved to another document: put it into that document's saved text.
  for (const d of docs) {
    if (!d.content || !d.content.includes(`data-tid="${tid}"`)) continue;
    const wrap = document.createElement('div');
    wrap.innerHTML = d.content;
    const mark = wrap.querySelector(`.folio-transcribing[data-tid="${tid}"]`);
    if (!mark) continue;
    if (text) replaceTranscriptionMark(mark, text); else mark.remove();
    d.content = wrap.innerHTML;
    schedulePersist();
    renderTree();
    return true;
  }
  return false;
}

async function transcribeAudioIntoStory(file, range) {
  if (!window.FolioTranscribe) { alert('The transcriber did not load.'); return; }
  if (!window.FolioTranscribe.isAudioFile(file)) {
    showFolioToast(`“${file.name}” doesn’t look like an audio file.`);
    return;
  }
  const mark = placeTranscriptionMark(range, file.name);
  const tid = mark.dataset.tid;
  activeTranscriptions.add(tid);
  const update = (message, pct) => {
    const current = document.querySelector(`#editor .folio-transcribing[data-tid="${tid}"]`);
    if (!current) return;
    // Show the overall percentage; drop any per-step number the message carries.
    const label = message.replace(/\s*\d+%$/, '').replace(/…$/, '');
    current.textContent = typeof pct === 'number' ? `${label}… ${Math.round(pct)}%` : `${label}…`;
    current.title = file.name;
  };
  try {
    const text = (await window.FolioTranscribe.transcribeFile(file, update)).trim();
    if (!text) {
      finishTranscription(tid, '');
      showFolioToast(`No speech was found in “${file.name}”.`);
    } else if (finishTranscription(tid, text)) {
      showFolioToast(`Transcribed “${file.name}” — ${text.split(/\s+/).length} words added.`);
    } else {
      // The marker was deleted while it worked; don't lose the text.
      try { await navigator.clipboard.writeText(text); } catch { /* ignore */ }
      showFolioToast(`Transcript of “${file.name}” is ready, but its spot in the story was removed — it’s been copied to your clipboard.`);
    }
  } catch (err) {
    console.warn('Transcription failed:', err);
    finishTranscription(tid, '');
    showFolioToast(`Couldn’t transcribe “${file.name}”: ${err.message}`);
  } finally {
    activeTranscriptions.delete(tid);
  }
}

function setupAudioTranscription() {
  const btn = document.getElementById('fmt-audio');
  const input = document.getElementById('audio-file-input');
  // Grab the cursor before the click moves focus out of the editor.
  btn.addEventListener('pointerdown', rememberAudioInsertPoint);
  btn.addEventListener('keydown', rememberAudioInsertPoint);
  btn.addEventListener('click', () => {
    input.value = '';
    input.click();
  });
  input.addEventListener('change', () => {
    const files = Array.from(input.files || []);
    let range = audioInsertRange;
    audioInsertRange = null;
    files.forEach(file => {
      transcribeAudioIntoStory(file, range);
      range = null; // further files follow the first one's marker via the caret
      const sel = window.getSelection();
      if (sel?.rangeCount) range = sel.getRangeAt(0).cloneRange();
    });
  });

  // Drop an audio file onto the page: the text goes where you dropped it.
  const editor = document.getElementById('editor');
  const hasFiles = e => Array.from(e.dataTransfer?.types || []).includes('Files');
  editor.addEventListener('dragover', e => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });
  editor.addEventListener('drop', e => {
    const files = Array.from(e.dataTransfer?.files || []).filter(f => window.FolioTranscribe?.isAudioFile(f));
    if (!files.length) return;
    e.preventDefault();
    let range = document.caretRangeFromPoint ? document.caretRangeFromPoint(e.clientX, e.clientY) : null;
    files.forEach(file => {
      transcribeAudioIntoStory(file, range);
      const sel = window.getSelection();
      range = sel?.rangeCount ? sel.getRangeAt(0).cloneRange() : null;
    });
  });
}

/* ────────────────────────────────────────
   Event Listeners
──────────────────────────────────────── */
function setupEventListeners() {

  setupAudioTranscription();

  document.getElementById('editor-zoom-out').addEventListener('click', () => setEditorZoom(editorZoom - 10));
  document.getElementById('editor-zoom-in').addEventListener('click', () => setEditorZoom(editorZoom + 10));
  document.getElementById('editor-zoom-reset').addEventListener('click', () => setEditorZoom(100));

  /* Toolbar format buttons */
  document.querySelectorAll('.fmt-btn[data-cmd]').forEach(btn => {
    btn.addEventListener('click', () => fmt(btn.dataset.cmd));
  });

  /* One-click paragraph styles */
  document.querySelectorAll('[data-block]').forEach(btn => {
    btn.addEventListener('click', () => applyBlock(btn.dataset.block));
  });

  /* Font select — applies to the selection if there is one, otherwise sets the document's font */
  document.getElementById('fmt-font').addEventListener('change', function() {
    const d = docs.find(x => x.id === activeId);
    if (!d) return;
    if (!applySelectionFont(this.value)) {
      d.font = this.value;
      document.getElementById('editor').style.fontFamily = this.value;
      schedulePersist();
    }
    document.getElementById('editor').focus();
  });

  /* Font size — selection first, otherwise the full document */
  document.getElementById('fmt-size').addEventListener('change', function() {
    const d = docs.find(x => x.id === activeId);
    if (!d) return;
    if (!applySelectionFontSize(this.value)) {
      d.fontSize = this.value;
      document.getElementById('editor').style.fontSize = this.value;
      schedulePersist();
    }
    document.getElementById('editor').focus();
  });

  document.getElementById('fmt-line-spacing').addEventListener('change', function() {
    applyLineSpacing(this.value);
  });

  const textColorPicker = document.getElementById('fmt-color');
  textColorPicker.addEventListener('pointerdown', rememberColorSelection);
  textColorPicker.addEventListener('keydown', rememberColorSelection);
  textColorPicker.addEventListener('change', function() {
    const d = docs.find(x => x.id === activeId);
    if (!d) return;
    restoreColorSelection();
    if (!applySelectionColor(this.value)) {
      if (isThemeSentinelColor(this.value)) {
        delete d.textColor;
        document.getElementById('editor').style.color = '';
        document.getElementById('fmt-color').value = '#000000';
      } else {
        d.textColor = this.value;
        document.getElementById('editor').style.color = this.value;
      }
      schedulePersist();
    }
    savedColorRange = null;
    document.getElementById('editor').focus();
  });

  const textColorReset = document.getElementById('fmt-color-reset');
  textColorReset.addEventListener('pointerdown', rememberColorSelection);
  textColorReset.addEventListener('click', () => {
    const d = docs.find(x => x.id === activeId);
    if (!d) return;
    restoreColorSelection();
    if (!clearSelectionColor()) {
      delete d.textColor;
      document.getElementById('editor').style.color = '';
      document.getElementById('fmt-color').value = '#000000';
      schedulePersist();
    }
    savedColorRange = null;
    document.getElementById('editor').focus();
  });

  /* Editor input */
  document.getElementById('editor').addEventListener('input', () => {
    autoConvertEmDash();
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { saveCurrentDoc(); renderTree(); }, 400);
    updateStats();
    centerCurrentLine();
  });
  document.getElementById('editor').addEventListener('keyup', centerCurrentLine);
  document.getElementById('editor').addEventListener('click', centerCurrentLine);
  document.getElementById('editor').addEventListener('keyup', detectCaretFontSize);
  document.getElementById('editor').addEventListener('click', detectCaretFontSize);
  document.getElementById('editor').addEventListener('keyup', detectCaretFont);
  document.getElementById('editor').addEventListener('click', detectCaretFont);
  document.getElementById('editor').addEventListener('keyup', detectCaretLineSpacing);
  document.getElementById('editor').addEventListener('click', detectCaretLineSpacing);
  document.getElementById('editor').addEventListener('keyup', detectCaretColor);
  document.getElementById('editor').addEventListener('click', detectCaretColor);
  document.getElementById('editor').addEventListener('paste', handleThemeablePaste);
  document.addEventListener('selectionchange', () => {
    if (typewriterMode) centerCurrentLine();
    detectCaretFontSize();
    detectCaretFont();
    detectCaretLineSpacing();
    detectCaretColor();
  });

  /* Revision and writing-mode toolbar */
  document.getElementById('typewriter-btn').addEventListener('click', () => setTypewriterMode());
  document.getElementById('proofing-btn').addEventListener('click', toggleProofing);
  document.getElementById('split-btn').addEventListener('click', () => toggleSplit());
  document.getElementById('split-close').addEventListener('click', () => toggleSplit(false));
  document.getElementById('split-doc-select').addEventListener('change', e => { saveSplitReference(); splitReferenceId = +e.target.value; renderSplitReference(); schedulePersist(); });
  document.getElementById('split-reference-content').addEventListener('input', saveSplitReference);
  document.getElementById('split-reference-content').addEventListener('paste', handleThemeablePaste);
  document.getElementById('margin-note-add').addEventListener('click', annotateSelection);
  document.getElementById('doc-notes-summary').addEventListener('click', () => showInspectorPanel('notes'));

  /* Title input */
  document.getElementById('doc-title-edit').addEventListener('input', () => {
    const d = docs.find(x => x.id === activeId);
    if (d) {
      d.title = document.getElementById('doc-title-edit').value || 'Untitled';
      renderTree();
    }
  });

  /* Inspector inputs */
  document.getElementById('synopsis-area').addEventListener('input', () => {
    const d = docs.find(x => x.id === activeId);
    if (d) { d.synopsis = document.getElementById('synopsis-area').value; schedulePersist(); }
  });

  document.getElementById('status-select').addEventListener('change', function() {
    const d = docs.find(x => x.id === activeId);
    if (d) { d.status = this.value; updateStatusControls(this.value); renderTree(); schedulePersist(); }
  });
  document.querySelectorAll('#status-segmented button').forEach(btn => btn.addEventListener('click', () => {
    const d = docs.find(x => x.id === activeId);
    if (!d) return;
    d.status = btn.dataset.status;
    document.getElementById('status-select').value = d.status;
    updateStatusControls(d.status);
    renderTree(); schedulePersist();
  }));

  document.getElementById('target-input').addEventListener('input', updateStats);

  document.getElementById('story-date').addEventListener('change', function() {
    const d = docs.find(x => x.id === activeId);
    if (d) { d.storyDate = this.value; schedulePersist(); }
  });

  /* Tag input */
  document.getElementById('tag-input').addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      const val = e.target.value.trim().replace(/,/g, '');
      if (!val) return;
      const d = docs.find(x => x.id === activeId);
      if (d && !d.tags.includes(val)) { d.tags.push(val); renderTags(d); schedulePersist(); }
      e.target.value = '';
    }
  });

  /* Sidebar add buttons */
  document.getElementById('add-doc-btn').addEventListener('click',      () => addDoc('manuscript'));
  document.getElementById('add-research-btn').addEventListener('click', openEntityModal);
  document.getElementById('cork-add-scene').addEventListener('click', () => { addDoc('manuscript'); setMode('editor'); });

  /* View mode buttons */
  document.getElementById('btn-editor').addEventListener('click',   () => setMode('editor'));
  document.getElementById('btn-cork').addEventListener('click',     () => setMode('cork'));
  document.getElementById('btn-outline').addEventListener('click',  () => setMode('outline'));
  document.getElementById('btn-timeline').addEventListener('click', () => setMode('timeline'));
  document.getElementById('btn-board').addEventListener('click', () => setMode('board'));
  document.getElementById('btn-bible').addEventListener('click', () => setMode('bible'));

  /* Collapsible panels and inspector tabs */
  document.getElementById('toggle-sidebar').addEventListener('click', () => toggleSidebar());
  document.getElementById('toggle-inspector').addEventListener('click', () => toggleInspector());
  bindPageControls();
  document.querySelectorAll('.inspector-tab').forEach(btn => btn.addEventListener('click', () => showInspectorPanel(btn.dataset.panel)));
  /* Primary navigation and synopsis start visible on desktop; on a phone-width screen
     the sidebar and inspector are fixed-width columns that would otherwise squeeze the
     editor itself down to nothing, so both start collapsed and open on demand instead. */
  toggleSidebar(!isPhoneWidth());
  toggleInspector(!isPhoneWidth());

  /* Session, beats, revisions, and notes */
  document.getElementById('writing-session').addEventListener('click', toggleSession);
  document.getElementById('writing-session').addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleSession(); } });
  document.getElementById('add-beat-btn').addEventListener('click', addBeat);
  document.getElementById('take-snapshot').addEventListener('click', takeSnapshot);
  document.getElementById('inspector-annotate').addEventListener('click', annotateSelection);
  document.getElementById('margin-toggle').addEventListener('click', () => toggleMargin());
  document.getElementById('notepad-text').addEventListener('input', e => {
    const d = docs.find(x => x.id === activeId);
    if (!d) return;
    d.documentNote = e.target.value;
    renderNotesSummary();
    schedulePersist();
  });
  document.getElementById('notepad-lines').addEventListener('click', () => {
    const d = docs.find(x => x.id === activeId);
    if (!d) return;
    d.notepadLined = d.notepadLined === false;
    renderNotes();
    schedulePersist();
  });
  document.getElementById('notepad-expand').addEventListener('click', () => {
    const notepad = document.getElementById('document-notepad');
    const expanded = notepad.classList.toggle('fullscreen');
    document.getElementById('notepad-expand').textContent = expanded ? 'Close' : 'Full screen';
    if (expanded) document.getElementById('notepad-text').focus();
  });
  document.getElementById('bible-filter').addEventListener('input', e => buildBible(e.target.value));

  /* Command palette and options */
  document.getElementById('btn-command').addEventListener('click', openCommandPalette);
  document.getElementById('command-overlay').addEventListener('click', e => { if (e.target === e.currentTarget) closeCommandPalette(); });
  document.getElementById('command-input').addEventListener('input', e => { commandIndex = 0; renderCommands(e.target.value); });
  document.getElementById('command-input').addEventListener('keydown', e => {
    if (e.key === 'ArrowDown') { e.preventDefault(); commandIndex = Math.min(currentCommands.length - 1, commandIndex + 1); renderCommands(e.currentTarget.value); }
    if (e.key === 'ArrowUp') { e.preventDefault(); commandIndex = Math.max(0, commandIndex - 1); renderCommands(e.currentTarget.value); }
    if (e.key === 'Enter') { e.preventDefault(); runCommand(commandIndex); }
  });
  document.getElementById('btn-menu').addEventListener('click', e => { e.stopPropagation(); toggleOptionsMenu(); });
  document.querySelectorAll('#options-menu [data-option]').forEach(btn => btn.addEventListener('click', () => {
    const actions = { typewriter: () => setTypewriterMode(), proofing: toggleProofing, beats: toggleBeats, template: applyBeatTemplate, split: () => toggleSplit(), margin: () => toggleMargin(), fixdashes: convertTypedDashesToEmDash, fixcolors: stripDocumentColors, compile: openCompile, snapshot: takeSnapshot, book: openBookMode, focus: toggleFocus };
    actions[btn.dataset.option](); toggleOptionsMenu(false);
  }));
  document.addEventListener('click', e => { if (!e.target.closest('#options-menu') && !e.target.closest('#btn-menu')) toggleOptionsMenu(false); });
  document.getElementById('btn-settings').addEventListener('click', e => { e.stopPropagation(); toggleSettingsMenu(); });
  document.querySelectorAll('.mode-btn').forEach(btn => btn.addEventListener('click', () => setColorMode(btn.dataset.mode)));
  document.querySelectorAll('.theme-swatch[data-theme]').forEach(btn => btn.addEventListener('click', () => applyTheme(btn.dataset.theme)));
  document.getElementById('custom-theme-picker').addEventListener('input', e => applyCustomPalette(e.target.value));
  document.getElementById('accent-color-picker').addEventListener('input', e => applyAccentColor(e.target.value));
  document.getElementById('accent-reset-btn').addEventListener('click', () => applyAccentColor(null));
  document.querySelectorAll('.texture-swatch[data-texture]').forEach(btn => btn.addEventListener('click', () => applyTexture(btn.dataset.texture)));
  bindBackgroundControls();
  document.getElementById('save-status').addEventListener('click', showSaveProblem);
  renderSaveStatus();
  document.addEventListener('click', e => { if (!e.target.closest('#settings-menu') && !e.target.closest('#btn-settings')) toggleSettingsMenu(false); });
  document.addEventListener('click', e => {
    if (!e.target.closest('.project-more') && !e.target.closest('.project-card-menu')) {
      document.querySelectorAll('.project-card-menu.open').forEach(menu => menu.classList.remove('open'));
      document.querySelectorAll('.project-card.menu-open').forEach(card => card.classList.remove('menu-open'));
    }
  });
  document.getElementById('projects-scroll').addEventListener('scroll', () => {
    document.querySelectorAll('.project-card-menu.open').forEach(menu => menu.classList.remove('open'));
    document.querySelectorAll('.project-card.menu-open').forEach(card => card.classList.remove('menu-open'));
  }, { passive: true });

  /* Project shelf and compilation */
  document.getElementById('btn-projects').addEventListener('click', openProjects);
  document.getElementById('new-project-btn').addEventListener('click', createProject);
  document.getElementById('import-project-btn').addEventListener('click', () => document.getElementById('import-project-input').click());
  const backupsBtn = document.getElementById('show-backups-btn');
  if (backupsBtn) {
    backupsBtn.hidden = !window.folioBackups;
    backupsBtn.addEventListener('click', () => window.folioBackups && window.folioBackups.show());
  }
  document.getElementById('import-project-input').addEventListener('change', e => {
    const file = e.target.files[0];
    e.target.value = '';
    if (file) importProjectFile(file);
  });
  document.getElementById('projects-grid').addEventListener('dragover', e => {
    if (e.target.closest('.project-card, .continue-cover')) return; // cards handle their own drops
    if (![...e.dataTransfer.items].some(item => item.kind === 'file')) return;
    e.preventDefault();
    document.getElementById('projects-grid').classList.add('drag-over');
  });
  document.getElementById('projects-grid').addEventListener('dragleave', e => {
    if (e.target === document.getElementById('projects-grid')) document.getElementById('projects-grid').classList.remove('drag-over');
  });
  document.getElementById('projects-grid').addEventListener('drop', e => {
    if (e.target.closest('.project-card')) return; // let the per-cover drop handler deal with cover images
    e.preventDefault();
    document.getElementById('projects-grid').classList.remove('drag-over');
    const file = [...e.dataTransfer.files].find(f => f.name.endsWith('.folio') || f.type === 'application/json');
    if (file) importProjectFile(file);
  });
  document.getElementById('sync-choose-btn').addEventListener('click', chooseSyncFolder);
  document.getElementById('sync-reconnect-btn').addEventListener('click', reconnectSyncFolder);
  document.getElementById('sync-disconnect-btn').addEventListener('click', () => {
    if (confirm('Disconnect this synced folder? Nothing already saved there is deleted — Folio just stops writing to it.')) disconnectSyncFolder();
  });
  document.getElementById('book-formatter-btn').addEventListener('click', openFormatter);
  document.getElementById('formatter-back').addEventListener('click', closeFormatter);
  document.getElementById('formatter-export').addEventListener('click', exportFormattedBook);
  document.getElementById('formatter-project').addEventListener('change', () => { loadFormatterSettings(); renderFormatter(); });
  ['formatter-trim', 'formatter-theme', 'formatter-opening', 'formatter-dropcaps', 'formatter-drafts'].forEach(id => document.getElementById(id).addEventListener('change', renderFormatter));
  document.getElementById('project-title-input').addEventListener('input', schedulePersist);
  document.getElementById('compile-cancel').addEventListener('click', closeCompile);
  document.getElementById('compile-export').addEventListener('click', exportManuscript);
  document.getElementById('compile-overlay').addEventListener('click', e => { if (e.target === e.currentTarget) closeCompile(); });

  /* Focus */
  document.getElementById('btn-focus').addEventListener('click', toggleFocus);
  document.getElementById('focus-exit').addEventListener('click', toggleFocus);

  /* Search */
  document.getElementById('btn-search').addEventListener('click', openSearch);
  document.getElementById('search-overlay').addEventListener('click', e => {
    if (e.target === e.currentTarget) closeSearch();
  });
  document.getElementById('search-input').addEventListener('input', function() {
    runSearch(this.value.trim().toLowerCase());
  });

  /* Context menu actions */
  document.getElementById('ctx-rename').addEventListener('click', () => {
    hideCtx();
    loadDoc(ctxTargetId);
    const target = docs.find(d => d.id === ctxTargetId);
    const ti = document.getElementById(target && target.entityType === 'character' ? 'char-name-edit' : 'doc-title-edit');
    ti.focus();
    ti.select();
  });

  document.getElementById('ctx-duplicate').addEventListener('click', () => {
    hideCtx();
    const src = docs.find(d => d.id === ctxTargetId);
    if (!src) return;
    const copy = { ...structuredClone(src), id: nextId++, title: src.title + ' (copy)', createdAt: new Date() };
    docs.splice(docs.indexOf(src) + 1, 0, copy);
    renderTree();
    loadDoc(copy.id);
  });

  document.getElementById('ctx-add-child').addEventListener('click', () => {
    hideCtx();
    const parent = docs.find(d => d.id === ctxTargetId);
    if (parent) { parent.isFolder = true; parent.collapsed = false; }
    addDoc(parent?.section || 'manuscript', ctxTargetId);
  });

  document.getElementById('ctx-delete').addEventListener('click', () => {
    hideCtx();
    if (docs.length <= 1) return;
    const idx = docs.findIndex(d => d.id === ctxTargetId);
    docs.splice(idx, 1);
    activeId = docs[Math.max(0, idx - 1)].id;
    renderTree();
    loadDoc(activeId);
  });

  document.addEventListener('click', e => {
    if (!e.target.closest('#ctx-menu')) hideCtx();
  });

  /* Entity modal */
  document.getElementById('entity-cancel').addEventListener('click', closeEntityModal);
  document.getElementById('entity-confirm').addEventListener('click', createEntity);
  document.getElementById('entity-overlay').addEventListener('click', e => {
    if (e.target === e.currentTarget) closeEntityModal();
  });

  /* Banner */
  document.getElementById('doc-banner').addEventListener('click', openBannerPicker);
  document.getElementById('banner-overlay').addEventListener('click', e => {
    if (e.target === e.currentTarget) closeBannerPicker();
  });
  document.getElementById('banner-remove').addEventListener('click', removeBanner);
  document.getElementById('banner-upload').addEventListener('change', handleBannerUpload);

  /* Tab indents while writing (instead of jumping to the next button).
     In a list it nests the item; elsewhere it types an indent of two em spaces. */
  document.addEventListener('keydown', e => {
    if (e.key !== 'Tab' || e.ctrlKey || e.metaKey || e.altKey) return;
    const target = e.target;
    if (!target || !target.isContentEditable) return;
    e.preventDefault();
    const sel = window.getSelection();
    const anchor = sel && sel.anchorNode;
    const inList = anchor && (anchor.nodeType === 1 ? anchor : anchor.parentElement)?.closest('li');
    if (inList) { document.execCommand(e.shiftKey ? 'outdent' : 'indent'); return; }
    if (!e.shiftKey) { document.execCommand('insertText', false, TAB_INDENT); return; }
    // Shift+Tab removes an indent just before the cursor, if there is one.
    if (sel.isCollapsed && anchor.nodeType === 3) {
      const before = anchor.textContent.slice(0, sel.anchorOffset);
      if (before.endsWith(TAB_INDENT)) {
        for (let i = 0; i < TAB_INDENT.length; i++) sel.modify('extend', 'backward', 'character');
        document.execCommand('delete');
      }
    }
  });

  /* Keyboard shortcuts */
  document.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      document.getElementById('command-overlay').classList.contains('open') ? closeCommandPalette() : openCommandPalette();
    }
    if (e.ctrlKey && e.key.toLowerCase() === 't') { e.preventDefault(); setTypewriterMode(); }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'r') { e.preventDefault(); toggleProofing(); }
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'e') { e.preventDefault(); openCompile(); }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); takeSnapshot(); }
    if ((e.ctrlKey || e.metaKey) && e.code === 'Backslash') { e.preventDefault(); e.shiftKey ? toggleInspector() : toggleSidebar(); }
    if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
      e.preventDefault();
      openSearch();
    }
    if (e.key === 'F11') {
      e.preventDefault();
      toggleFocus();
    }
    if (e.key === 'Escape') {
      const notepad = document.getElementById('document-notepad');
      if (notepad.classList.contains('fullscreen')) {
        notepad.classList.remove('fullscreen');
        document.getElementById('notepad-expand').textContent = 'Full screen';
      }
      if (document.body.classList.contains('focus-mode')) toggleFocus();
      closeSearch();
      closeCommandPalette();
      closeCompile();
      toggleOptionsMenu(false);
    }
  });

  /* Book Mode listeners — ADD THESE */
  document.getElementById('btn-book').addEventListener('click', openBookMode);
  document.getElementById('book-close').addEventListener('click', closeBookMode);
  document.getElementById('book-zoom-out').addEventListener('click', () => setBookZoom(bookZoom - 10));
  document.getElementById('book-zoom-in').addEventListener('click', () => setBookZoom(bookZoom + 10));
  document.getElementById('book-zoom-reset').addEventListener('click', () => setBookZoom(100));
  document.getElementById('book-next').addEventListener('click', () => { if (isPhoneWidth()) bookPhoneNext(); else bookFlipForward(); });
  document.getElementById('book-prev').addEventListener('click', () => { if (isPhoneWidth()) bookPhonePrev(); else bookFlipBackward(); });
  document.getElementById('book-curl').addEventListener('click', () => { if (isPhoneWidth()) bookPhoneNext(); else bookFlipForward(); });
  document.getElementById('book-editor').addEventListener('input', () => scheduleBookOverflowCheck('right'));
  document.getElementById('book-left-content').addEventListener('input', () => scheduleBookOverflowCheck('left'));
  document.addEventListener('keydown', e => {
    if (!document.getElementById('book-overlay').classList.contains('open')) return;
    if (e.key === 'PageDown') { e.preventDefault(); if (isPhoneWidth()) bookPhoneNext(); else bookFlipForward(); }
    if (e.key === 'PageUp')   { e.preventDefault(); if (isPhoneWidth()) bookPhonePrev(); else bookFlipBackward(); }
    if (e.key === 'Escape')   { closeBookMode(); }
  });

  document.getElementById('book-editor').addEventListener('paste', e => {
  e.preventDefault();
  const text = e.clipboardData.getData('text/plain');
  const el = document.getElementById('book-editor');
  const paras = text.split('\n').filter(p => p.trim().length > 0);
  if (paras.length === 0) return;
  bookInsertParagraphsAtCursor(el, paras);
  if (isPhoneWidth()) setTimeout(() => bookPhoneResplit(), 100);
  else setTimeout(() => bookReSplitCurrentPage('right'), 100);
});

document.getElementById('book-left-content').addEventListener('paste', e => {
  e.preventDefault();
  if (isPhoneWidth()) return; // left page is unused/hidden in the phone single-page layout
  const text = e.clipboardData.getData('text/plain');
  const el = document.getElementById('book-left-content');
  const paras = text.split('\n').filter(p => p.trim().length > 0);
  if (paras.length === 0) return;
  bookInsertParagraphsAtCursor(el, paras);
  setTimeout(() => bookReSplitCurrentPage('left'), 100);
});
}
/* ────────────────────────────────────────
   Book Mode
──────────────────────────────────────── */
const BOOK_CHAPTER_LABEL = () => document.getElementById('doc-title-edit').value || 'Untitled';
const BOOK_SCENE_BREAK = ' scene-break ';
const BOOK_PAGE_MAX_WORDS = 320;
const BOOK_PAGE_MAX_CHARS = 1850;

/* A page must satisfy both the editorial length target and its actual rendered
   dimensions. The physical check remains essential for larger fonts, dialogue,
   and unusually wide words, which may fill the page before either count limit. */
function bookPageFits(measurer) {
  const text = measurer.innerText || measurer.textContent || '';
  return measurer.scrollHeight <= measurer.clientHeight + 1 &&
    wordTokens(text).length <= BOOK_PAGE_MAX_WORDS &&
    text.length <= BOOK_PAGE_MAX_CHARS;
}

/* Splits manuscript HTML into paragraph strings, one per top-level block, keeping
   each paragraph's inline formatting (font spans, bold, italic, …) intact so Book
   Mode looks the same as the editor instead of flattening everything to plain text. */
function htmlToBookParagraphs(html) {
  const container = document.createElement('div');
  container.innerHTML = html || '';
  const paras = [];
  container.childNodes.forEach(node => {
    if (node.nodeType === Node.TEXT_NODE) {
      const t = node.textContent.trim();
      if (t) paras.push(escapeHTML(t));
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    if (node.classList && node.classList.contains('scene-break')) { paras.push(BOOK_SCENE_BREAK); return; }
    const inner = node.innerHTML.trim();
    if (inner && node.textContent.trim()) paras.push(inner);
  });
  return paras;
}

/* Reads a book page's current DOM back into paragraph strings. Works whether the
   browser wrapped each line in <p> or <div> (contentEditable's native Enter-key
   behavior varies by browser), so nothing typed or pasted is ever silently dropped. */
function bookSerializePage(el) {
  const paras = [];
  el.childNodes.forEach(node => {
    if (node.nodeType === Node.ELEMENT_NODE && (node.tagName === 'P' || node.tagName === 'DIV')) {
      if (node.classList && node.classList.contains('book-scene-break')) { paras.push(BOOK_SCENE_BREAK); return; }
      const inner = node.innerHTML.trim();
      if (inner && node.textContent.trim()) paras.push(inner);
    } else if (node.nodeType === Node.TEXT_NODE) {
      const t = node.textContent.trim();
      if (t) paras.push(escapeHTML(t));
    }
  });
  if (paras.length === 0) {
    return el.innerText.split('\n').map(s => s.trim()).filter(Boolean).map(escapeHTML);
  }
  return paras;
}

/* Returns the inner HTML for a character slice of a paragraph while retaining
   spans, emphasis, and other inline formatting that crosses the split point. */
function bookParagraphSlice(source, start, end) {
  const range = document.createRange();
  range.selectNodeContents(source);
  const walker = document.createTreeWalker(source, NodeFilter.SHOW_TEXT);
  let node;
  let offset = 0;
  let startSet = start === 0;
  while ((node = walker.nextNode())) {
    const next = offset + node.nodeValue.length;
    if (!startSet && start <= next) {
      range.setStart(node, Math.max(0, start - offset));
      startSet = true;
    }
    if (end <= next) {
      range.setEnd(node, Math.max(0, end - offset));
      break;
    }
    offset = next;
  }
  const holder = document.createElement('div');
  holder.appendChild(range.cloneContents());
  return holder.innerHTML.trim();
}

/* Finds the largest word-boundary prefix of an overflowing paragraph that fits
   in the page's remaining space. Character boundaries are the final fallback for
   an unusually long unbroken word on an otherwise empty page. */
function splitBookParagraphToFit(para, measurer, indent = false) {
  const holder = document.createElement('div');
  holder.innerHTML = bookParagraphHTML(para, indent);
  const source = holder.firstElementChild;
  const text = source?.textContent || '';
  if (!text) return [para, ''];
  const existingMarkup = measurer.innerHTML;
  const pageWasEmpty = !measurer.children.length;

  let boundaries = [...text.matchAll(/\s+/g)].map(match => match.index + match[0].length);
  boundaries.push(text.length);

  const prefixFits = end => {
    measurer.innerHTML = existingMarkup + bookParagraphHTML(bookParagraphSlice(source, 0, end), indent);
    return bookPageFits(measurer);
  };

  let low = 0;
  let high = boundaries.length - 1;
  let best = 0;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    if (prefixFits(boundaries[mid])) { best = boundaries[mid]; low = mid + 1; }
    else high = mid - 1;
  }

  if (!best && pageWasEmpty) {
    low = 1;
    high = text.length;
    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      if (prefixFits(mid)) { best = mid; low = mid + 1; }
      else high = mid - 1;
    }
  }

  if (!best && pageWasEmpty) best = 1;
  return [bookParagraphSlice(source, 0, best), bookParagraphSlice(source, best, text.length)];
}

/* Visible character count of a paragraph, ignoring markup — used to keep pagination
   based on actual prose length instead of counting style-attribute characters. */
/* Paginates paragraphs by actually rendering them into a hidden measuring element
   sized exactly like the real page's content area, and checking precisely when
   that overflows — rather than guessing a fixed character budget per page. A raw
   character count has no idea how much vertical space a paragraph actually takes:
   short, dialogue-heavy paragraphs with lots of line breaks eat far more room per
   character than dense prose does, so a fixed budget can let a page's worth of
   text run well past what actually fits, silently clipped by the page's
   overflow:hidden while the next page sits empty. Measuring against a clone of the
   live #book-editor means this automatically matches whatever's actually on
   screen — the desktop two-page spread's dimensions, or the phone single-page
   layout's, whichever is currently active — with no separate figure to keep in
   sync by hand. */
function bookPaginate(paras) {
  const reference = document.getElementById('book-editor');
  const computed = getComputedStyle(reference);
  const width = reference.clientWidth;
  const height = reference.clientHeight;

  const measurer = document.createElement('div');
  measurer.style.position = 'fixed';
  measurer.style.visibility = 'hidden';
  measurer.style.pointerEvents = 'none';
  measurer.style.top = '0';
  measurer.style.left = '-9999px';
  measurer.style.width = `${width}px`;
  measurer.style.height = `${height}px`;
  measurer.style.overflow = 'hidden';
  measurer.style.boxSizing = computed.boxSizing;
  measurer.style.fontFamily = computed.fontFamily;
  measurer.style.fontSize = computed.fontSize;
  measurer.style.fontWeight = computed.fontWeight;
  measurer.style.lineHeight = computed.lineHeight;
  measurer.style.letterSpacing = computed.letterSpacing;
  measurer.style.padding = computed.padding;
  document.body.appendChild(measurer);

  const fits = () => bookPageFits(measurer);

  const pages = [];
  let currentPage = [];
  const pending = [...paras];

  while (pending.length) {
    const para = pending.shift();
    measurer.insertAdjacentHTML('beforeend', bookParagraphHTML(para, currentPage.length !== 0));
    if (fits()) {
      currentPage.push(para);
      continue;
    }

    // Back out the overflowing whole paragraph, then use as much of it as will
    // fit in the page's remaining lines. This avoids large page-to-page word-count
    // swings caused by always moving an entire long paragraph forward.
    measurer.lastElementChild.remove();
    const [fittingPart, remainder] = splitBookParagraphToFit(para, measurer, currentPage.length !== 0);
    if (fittingPart) currentPage.push(fittingPart);
    pages.push(currentPage);
    currentPage = [];
    measurer.innerHTML = '';
    if (remainder) pending.unshift(remainder);
    else if (!fittingPart) pending.unshift(para);
  }

  if (currentPage.length > 0) pages.push(currentPage);
  measurer.remove();
  return pages;
}

function bookParagraphHTML(para, indent) {
  if (para === BOOK_SCENE_BREAK) return `<div class="book-scene-break" style="margin:20px 0;text-align:center;letter-spacing:0.4em;color:var(--text-faint);">· · ·</div>`;
  return `<p style="text-indent:${indent ? '1.8em' : '0'};margin-bottom:0;">${para}</p>`;
}

/* Inserts pasted paragraphs at the caret (replacing any selection) instead of always
   dumping them at the end of the page, so paste never lands somewhere the user didn't
   click, and never leaves existing text stranded. */
function bookInsertParagraphsAtCursor(el, paras) {
  const selection = window.getSelection();
  let range;
  if (selection && selection.rangeCount > 0 && el.contains(selection.anchorNode) && el.contains(selection.focusNode)) {
    range = selection.getRangeAt(0);
  } else {
    range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
  }
  range.deleteContents();
  const frag = document.createDocumentFragment();
  let lastNode = null;
  paras.forEach(p => {
    const para = document.createElement('p');
    para.textContent = p;
    frag.appendChild(para);
    lastNode = para;
  });
  range.insertNode(frag);
  if (lastNode && selection) {
    const caret = document.createRange();
    caret.setStartAfter(lastNode);
    caret.collapse(true);
    selection.removeAllRanges();
    selection.addRange(caret);
  }
}

let bookPages    = [];
let bookSpread   = 0;
let bookFlipping = false;
let bookPhoneIdx = -1; // single-page index used instead of bookSpread when isPhoneWidth()
let bookOverflowTimer = null;

function placeCaretAtEnd(el) {
  const selection = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(el);
  range.collapse(false);
  selection.removeAllRanges();
  selection.addRange(range);
  el.focus();
}

/* Reflows only when the editable surface has genuinely run out of vertical room.
   The continuation is shown on the following page immediately, so no prose can
   remain concealed behind the page's overflow boundary. */
function scheduleBookOverflowCheck(side) {
  bookUpdateWC();
  clearTimeout(bookOverflowTimer);
  bookOverflowTimer = setTimeout(() => {
    const phone = isPhoneWidth();
    const el = document.getElementById(phone || side === 'right' ? 'book-editor' : 'book-left-content');
    if (bookPageFits(el)) return;

    if (phone) {
      const previousIndex = bookPhoneIdx;
      bookPhoneResplit();
      if (previousIndex < bookPages.length - 1) {
        bookPhoneIdx = previousIndex + 1;
        bookRenderPhonePage();
        placeCaretAtEnd(document.getElementById('book-editor'));
      }
      return;
    }

    bookReSplitCurrentPage(side);
    if (side === 'right') {
      bookSpread++;
      bookRenderSpread();
      placeCaretAtEnd(document.getElementById('book-left-content'));
    } else {
      placeCaretAtEnd(document.getElementById('book-editor'));
    }
  }, 80);
}

function openBookMode() {
  saveCurrentDoc(); // flush any edit still sitting in the debounced autosave before reading d.content
  const d = docs.find(x => x.id === activeId);
  if (!d) return;

  // Opened before pagination runs, not after — bookPaginate() measures against the
  // live #book-editor's real rendered width/height, which reads as zero while the
  // overlay is still display:none. Nothing paints in between: the render calls
  // below run synchronously in the same tick, so there's no flash of stale content.
  document.getElementById('book-overlay').classList.add('open');

  // Match the manuscript's document-level typography before measuring. Inline
  // font and size spans remain intact and are accounted for by the paginator too.
  const bookFont = d.font || "'EB Garamond', serif";
  const bookFontSize = d.fontSize || '14px';
  ['book-left-content', 'book-editor'].forEach(id => {
    const pageContent = document.getElementById(id);
    pageContent.style.fontFamily = bookFont;
    pageContent.style.fontSize = bookFontSize;
  });

  const paras = htmlToBookParagraphs(d.content || '');
  bookPages = bookPaginate(paras);
  while (bookPages.length < 2) bookPages.push([]); // the desktop spread always needs a left+right pair

  bookSpread   = -1;
  bookPhoneIdx = -1;
  bookFlipping = false;

  if (isPhoneWidth()) bookRenderPhonePage(); else bookRenderSpread();
}

function closeBookMode() {
  if (isPhoneWidth()) bookPhoneSaveCurrentPage();
  else if (bookSpread >= 0) bookSaveBothPages();

  const allParas = bookPages.flat();
  const html = allParas.map(p => p === BOOK_SCENE_BREAK ? '<div class="scene-break">· · ·</div>' : `<p>${p}</p>`).join('');

  const d = docs.find(x => x.id === activeId);
  if (d) {
    d.content = html;
    document.getElementById('editor').innerHTML = html;
    saveCurrentDoc();
    schedulePersist(); // d.content was set above, so saveCurrentDoc may see nothing new to save
    updateStats();
    renderTree();
  }

  document.getElementById('book-overlay').classList.remove('open');
}

function bookRenderSpread() {
  const chapter = BOOK_CHAPTER_LABEL();

  // Title spread
  if (bookSpread < 0) {
    document.getElementById('book-left-num').textContent      = '';
    document.getElementById('book-right-num').textContent     = '';
    document.getElementById('book-left-chapter').textContent  = '';
    document.getElementById('book-right-chapter').textContent = '';
    document.getElementById('book-spread-label').textContent  = 'Title page';

    // Left page — blank
    const leftEl = document.getElementById('book-left-content');
    leftEl.contentEditable = 'false';
    leftEl.style.cursor    = 'default';
    leftEl.innerHTML       = '';

    // Right page — title
    const rightEl = document.getElementById('book-editor');
    rightEl.contentEditable = 'false';
    rightEl.style.cursor    = 'default';
    rightEl.innerHTML = `
      <div style="height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:20px;opacity:0.75;">
        <div style="font-family:'EB Garamond',serif;font-size:26px;font-weight:600;color:var(--text);letter-spacing:0.03em;margin-bottom:16px;line-height:1.2;">${chapter}</div>
        <div style="width:50px;height:1px;background:var(--border);margin:0 auto 16px;"></div>
        <div style="font-family:'DM Mono',monospace;font-size:9px;color:var(--text-faint);letter-spacing:0.18em;text-transform:uppercase;">Turn the page to begin</div>
      </div>`;

    bookUpdateWC();
    return;
  }

  const leftIdx  = bookSpread * 2;
  const rightIdx = bookSpread * 2 + 1;

  document.getElementById('book-left-num').textContent      = leftIdx + 1;
  document.getElementById('book-right-num').textContent     = rightIdx + 1;
  document.getElementById('book-left-chapter').textContent  = chapter;
  document.getElementById('book-right-chapter').textContent = chapter;
  document.getElementById('book-spread-label').textContent  = `Pages ${leftIdx + 1} – ${rightIdx + 1}`;

  // Left page — fully editable
  const leftEl   = document.getElementById('book-left-content');
  const leftPage = bookPages[leftIdx] || [];
  leftEl.contentEditable = 'true';
  leftEl.style.cursor    = 'text';
  leftEl.style.outline   = 'none';
  leftEl.innerHTML = leftPage.length > 0
    ? leftPage.map((p, i) => bookParagraphHTML(p, i !== 0)).join('')
    : '';

  // Right page — fully editable
  const rightEl   = document.getElementById('book-editor');
  const rightPage = bookPages[rightIdx] || [];
  rightEl.contentEditable = 'true';
  rightEl.style.cursor    = 'text';
  rightEl.innerHTML = rightPage.length > 0
    ? rightPage.map((p, i) => bookParagraphHTML(p, i !== 0)).join('')
    : '';

  rightEl.focus();
  bookUpdateWC();
}

/* Phone layout: the two-page spread's fixed 480px-wide pages can't be laid side
   by side on a ~375px screen, so on phone Book Mode shows bookPages one at a time
   in the same #book-editor surface, keyed by bookPhoneIdx instead of bookSpread. */
function bookRenderPhonePage() {
  const chapter = BOOK_CHAPTER_LABEL();
  const rightEl = document.getElementById('book-editor');

  if (bookPhoneIdx < 0) {
    document.getElementById('book-right-chapter').textContent = '';
    document.getElementById('book-right-num').textContent     = '';
    document.getElementById('book-spread-label').textContent  = 'Title page';
    rightEl.contentEditable = 'false';
    rightEl.style.cursor    = 'default';
    rightEl.innerHTML = `
      <div style="height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:20px;opacity:0.75;">
        <div style="font-family:'EB Garamond',serif;font-size:22px;font-weight:600;color:var(--text);letter-spacing:0.03em;margin-bottom:16px;line-height:1.2;">${chapter}</div>
        <div style="width:50px;height:1px;background:var(--border);margin:0 auto 16px;"></div>
        <div style="font-family:'DM Mono',monospace;font-size:9px;color:var(--text-faint);letter-spacing:0.18em;text-transform:uppercase;">Tap Next to begin</div>
      </div>`;
    bookUpdateWC();
    return;
  }

  document.getElementById('book-right-chapter').textContent = chapter;
  document.getElementById('book-right-num').textContent     = bookPhoneIdx + 1;
  document.getElementById('book-spread-label').textContent  = `Page ${bookPhoneIdx + 1} of ${bookPages.length}`;

  const page = bookPages[bookPhoneIdx] || [];
  rightEl.contentEditable = 'true';
  rightEl.style.cursor    = 'text';
  rightEl.innerHTML = page.length > 0
    ? page.map((p, i) => bookParagraphHTML(p, i !== 0)).join('')
    : '';

  rightEl.focus();
  bookUpdateWC();
}

function bookPhoneSaveCurrentPage() {
  if (bookPhoneIdx < 0) return;
  bookPages[bookPhoneIdx] = bookSerializePage(document.getElementById('book-editor'));
}

function bookPhoneNext() {
  bookPhoneSaveCurrentPage();
  if (bookPhoneIdx < 0) { bookPhoneIdx = 0; bookRenderPhonePage(); return; }
  if (bookPhoneIdx >= bookPages.length - 1) bookPages.push([]);
  bookPhoneIdx++;
  bookRenderPhonePage();
}

function bookPhonePrev() {
  if (bookPhoneIdx <= -1) return;
  bookPhoneSaveCurrentPage();
  bookPhoneIdx--;
  bookRenderPhonePage();
}

/* Mirrors bookReSplitCurrentPage but re-splits from a single bookPhoneIdx onward
   instead of from a spread's left/right index. */
function bookPhoneResplit() {
  bookPhoneSaveCurrentPage();
  const paras = bookPages.slice(bookPhoneIdx).flat();
  const newPages = bookPaginate(paras);
  bookPages.splice(bookPhoneIdx, bookPages.length - bookPhoneIdx, ...newPages);
  bookRenderPhonePage();
}

function bookSaveBothPages() {
  if (bookSpread < 0) return;

  const leftIdx  = bookSpread * 2;
  const rightIdx = bookSpread * 2 + 1;

  while (bookPages.length <= rightIdx) bookPages.push([]);

  bookPages[leftIdx]  = bookSerializePage(document.getElementById('book-left-content'));
  bookPages[rightIdx] = bookSerializePage(document.getElementById('book-editor'));
}

function bookUpdateWC() {
  const words = wordTokens(bookPages.flat().join(' ')).length;
  document.getElementById('book-wc').textContent = words.toLocaleString() + ' words';
}

function bookReSplitCurrentPage(side) {
  bookSaveBothPages();

  // Grab all paragraphs from the current page onward
  const leftIdx  = bookSpread * 2;
  const rightIdx = bookSpread * 2 + 1;
  const idx      = side === 'left' ? leftIdx : rightIdx;

  const paras = bookPages.slice(idx).flat();
  const newPages = bookPaginate(paras);

  // Replace from the pasted page onward with the newly split pages
  bookPages.splice(idx, bookPages.length - idx, ...newPages);

  // Make sure there are always enough pages
  while (bookPages.length <= rightIdx + 1) bookPages.push([]);

  bookRenderSpread();
}

function bookFlipForward() {
  if (bookFlipping) return;

  // Title page — just advance without animation
  if (bookSpread < 0) {
    bookSpread = 0;
    bookRenderSpread();
    return;
  }

  bookSaveBothPages();

  const rightIdx     = bookSpread * 2 + 1;
  const nextRightIdx = rightIdx + 1;
  while (bookPages.length <= nextRightIdx) bookPages.push([]);

  const chapter = BOOK_CHAPTER_LABEL();
  const flip    = document.getElementById('book-flip');

  const rightEl = document.getElementById('book-editor');
  document.getElementById('book-ff-chapter').textContent = chapter;
  document.getElementById('book-ff-num').textContent     = rightIdx + 1;
  document.getElementById('book-ff-content').innerHTML   = rightEl.innerHTML;

  document.getElementById('book-fb-chapter').textContent = chapter;
  document.getElementById('book-fb-num').textContent     = rightIdx + 2;
  document.getElementById('book-fb-content').innerHTML   =
    (bookPages[rightIdx + 1] || []).map(p => `<p>${p}</p>`).join('');

  flip.style.display = 'block';
  flip.className     = '';
  bookFlipping       = true;

  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      flip.classList.add('flip-forward');
    });
  });

  setTimeout(() => {
    flip.style.display = 'none';
    flip.className     = '';
    bookFlipping       = false;
    bookSpread++;
    bookRenderSpread();
  }, 760);
}

function bookFlipBackward() {
  if (bookFlipping || bookSpread <= -1) return;

  // First spread — go back to title page without animation
  if (bookSpread === 0) {
    bookSaveBothPages();
    bookSpread = -1;
    bookRenderSpread();
    return;
  }

  bookSaveBothPages();

  const leftIdx  = bookSpread * 2;
  const chapter  = BOOK_CHAPTER_LABEL();
  const flip     = document.getElementById('book-flip');

  const leftEl = document.getElementById('book-left-content');
  document.getElementById('book-ff-chapter').textContent = chapter;
  document.getElementById('book-ff-num').textContent     = leftIdx;
  document.getElementById('book-ff-content').innerHTML   = leftEl.innerHTML;

  document.getElementById('book-fb-chapter').textContent = chapter;
  document.getElementById('book-fb-num').textContent     = leftIdx;
  document.getElementById('book-fb-content').innerHTML   =
    (bookPages[leftIdx - 1] || []).map(p => `<p>${p}</p>`).join('');

  flip.style.display = 'block';
  flip.className     = '';
  bookFlipping       = true;

  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      flip.classList.add('flip-backward');
    });
  });

  setTimeout(() => {
    flip.style.display = 'none';
    flip.className     = '';
    bookFlipping       = false;
    bookSpread--;
    bookRenderSpread();
  }, 760);
}

/* ── Start ── (the books are read from storage first) */
loadBookStore().then(init);
