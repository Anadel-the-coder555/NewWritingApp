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
  if (persist) localStorage.setItem(EDITOR_ZOOM_KEY, String(editorZoom));
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
  if (persist) localStorage.setItem(BOOK_ZOOM_KEY, String(bookZoom));
}

function persistState() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      docs, nextId, activeId, currentProjectId,
      projectTitle: document.getElementById('project-title-input').value,
      preferences: { typewriterMode, proofingMode, splitMode, marginMode, splitReferenceId }
    }));
  } catch (e) {
    console.error('Could not save project to local storage', e);
  }
}

function schedulePersist() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(persistState, 300);
}

function loadPersistedState() {
  let raw;
  try {
    raw = localStorage.getItem(STORAGE_KEY);
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
/* Appearance / theme settings */
const THEME_KEY = 'folio-theme-mode';
const ACCENT_KEY = 'folio-accent-color';
const PALETTE_COLOR_KEY = 'folio-palette-color';
const MODE_KEY = 'folio-color-mode';
const TEXTURE_KEY = 'folio-page-texture';
const PALETTE_ACCENTS = { sage: '#5f7355', slate: '#4a6fa5', sepia: '#a1662f', rose: '#a24a68', ocean: '#1f7a8c', midnight: '#6fa8dc' };
let currentPalette = 'sage';
let colorMode = 'light';

function updateActiveSwatch(themeId) {
  document.querySelectorAll('.theme-swatch[data-theme]').forEach(btn => btn.classList.toggle('active', btn.dataset.theme === themeId));
  const customSwatch = document.getElementById('custom-theme-swatch');
  if (customSwatch) customSwatch.classList.toggle('active', themeId === 'custom');
}

function applyTexture(id, persist = true) {
  const texture = id && id !== 'none' ? id : '';
  if (texture) document.documentElement.setAttribute('data-texture', texture);
  else document.documentElement.removeAttribute('data-texture');
  if (persist) localStorage.setItem(TEXTURE_KEY, texture || 'none');
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
    if (persist) localStorage.removeItem(ACCENT_KEY);
  } else {
    const toward = (c, pct) => `color-mix(in srgb, ${hex} ${pct}%, ${c})`;
    root.setProperty('--color-accent', hex);
    root.setProperty('--color-accent-100', dark ? toward('black', 30) : toward('white', 22));
    root.setProperty('--color-accent-200', dark ? toward('black', 45) : toward('white', 38));
    root.setProperty('--color-accent-400', dark ? toward('black', 65) : toward('white', 70));
    root.setProperty('--color-accent-600', hex);
    root.setProperty('--color-accent-700', dark ? toward('white', 65) : toward('black', 78));
    root.setProperty('--color-accent-800', dark ? toward('white', 80) : toward('black', 62));
    if (persist) localStorage.setItem(ACCENT_KEY, hex);
  }
  const shown = hex || PALETTE_ACCENTS[currentPalette] || PALETTE_ACCENTS.sage;
  const swatch = document.querySelector('.accent-color-swatch');
  const picker = document.getElementById('accent-color-picker');
  if (swatch) swatch.style.background = shown;
  if (picker) picker.value = shown;
}

/* Re-renders whatever palette is currently selected using the current light/dark mode. */
function refreshPalette() {
  const hex = currentPalette === 'custom' ? (localStorage.getItem(PALETTE_COLOR_KEY) || '#8a5fd6') : (PALETTE_ACCENTS[currentPalette] || PALETTE_ACCENTS.sage);
  generateScheme(hex, colorMode === 'dark');
  document.documentElement.setAttribute('data-theme', currentPalette);
  updateActiveSwatch(currentPalette);
  applyAccentColor(localStorage.getItem(ACCENT_KEY), false);
}

function applyTheme(id) {
  currentPalette = (id && PALETTE_ACCENTS[id]) ? id : 'sage';
  localStorage.setItem(THEME_KEY, currentPalette);
  refreshPalette();
}

function applyCustomPalette(hex, persist = true) {
  currentPalette = 'custom';
  if (persist) { localStorage.setItem(THEME_KEY, 'custom'); localStorage.setItem(PALETTE_COLOR_KEY, hex); }
  const dot = document.getElementById('custom-swatch-dot');
  const picker = document.getElementById('custom-theme-picker');
  if (dot) dot.style.background = hex;
  if (picker) picker.value = hex;
  refreshPalette();
}

function setColorMode(mode, persist = true) {
  colorMode = mode === 'dark' ? 'dark' : 'light';
  if (persist) localStorage.setItem(MODE_KEY, colorMode);
  document.querySelectorAll('.mode-btn').forEach(btn => btn.classList.toggle('active', btn.dataset.mode === colorMode));
  refreshPalette();
}

function initTheme() {
  colorMode = localStorage.getItem(MODE_KEY) === 'dark' ? 'dark' : 'light';
  document.querySelectorAll('.mode-btn').forEach(btn => btn.classList.toggle('active', btn.dataset.mode === colorMode));
  const savedPaletteColor = localStorage.getItem(PALETTE_COLOR_KEY) || '';
  if (savedPaletteColor) {
    const dot = document.getElementById('custom-swatch-dot');
    const picker = document.getElementById('custom-theme-picker');
    if (dot) dot.style.background = savedPaletteColor;
    if (picker) picker.value = savedPaletteColor;
  }
  const savedTheme = localStorage.getItem(THEME_KEY) || 'sage';
  if (savedTheme === 'custom' && savedPaletteColor) applyCustomPalette(savedPaletteColor, false);
  else applyTheme(savedTheme);
  applyTexture(localStorage.getItem(TEXTURE_KEY) || 'none', false);
}

function toggleSettingsMenu(force) {
  const menu = document.getElementById('settings-menu');
  const open = typeof force === 'boolean' ? force : !menu.classList.contains('open');
  menu.classList.toggle('open', open);
}

function init() {
  initTheme();
  setEditorZoom(Number(localStorage.getItem(EDITOR_ZOOM_KEY)) || 100, false);
  setBookZoom(Number(localStorage.getItem(BOOK_ZOOM_KEY)) || 100, false);
  loadPersistedState();
  ensureUniqueProjectId(); // migrate off the generic 'default' id every install starts with, before anything can compare ids against another device's file
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
    setMode('characters', true);
    renderTree();
    return;
  }

  document.getElementById('doc-title-edit').value = d.title;
  document.getElementById('editor').innerHTML      = d.content || '';
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
  d.title     = document.getElementById('doc-title-edit').value || 'Untitled';
  d.content   = document.getElementById('editor').innerHTML;
  d.synopsis  = document.getElementById('synopsis-area').value;
  d.status    = document.getElementById('status-select').value;
  d.target    = +document.getElementById('target-input').value || 0;
  d.storyDate = document.getElementById('story-date').value || '';
  d.banner    = document.getElementById('doc-banner').dataset.url || '';
  schedulePersist();
}

/* ────────────────────────────────────────
   Statistics
──────────────────────────────────────── */
/* Strips HTML down to plain text for character/sentence counting. Decodes the one
   entity that matters here: a non-breaking space serializes back out of innerHTML as
   the literal text "&nbsp;" (not the actual space character), which would otherwise
   glue two words together — and its own letters ("nbsp") would wrongly read as a word. */
/* Strips content that's invisible on the page but would otherwise leak into raw text:
   HTML comments, and <style>/<script> blocks (pasted rich text — Word, Google Docs,
   etc. — routinely embeds a sizeable <style> block of CSS class definitions, which a
   naive tag-stripping regex has no way to know isn't visible body text). */
function stripHiddenHtml(html) {
  const hidden = '(?:<!--[\\s\\S]*?-->|<style[^>]*>[\\s\\S]*?<\\/style>|<script[^>]*>[\\s\\S]*?<\\/script>)';
  return (html || '')
    // Hidden content sitting before any real content starts isn't "between" two
    // words — it's not part of the text at all, so it shouldn't leave a stray
    // leading space once the surrounding markup is trimmed off.
    .replace(new RegExp(`^(?:\\s*${hidden})+`, 'i'), '')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ');
}

/* Converts HTML to plain text for character counting, preserving whatever whitespace
   the writer actually typed (a tab or several spaces indenting a paragraph, an old
   double-space-after-period habit, …) rather than collapsing it away. Only the
   whitespace introduced by markup itself — a paragraph boundary — gets normalized,
   to exactly one character, matching how a word processor represents a paragraph
   break rather than however many tags happen to sit at that boundary. */
/* Decodes HTML entities (&amp; &lt; &quot; &#39; …) back to real characters. Browsers
   always serialize a literal "&" in text content as "&amp;" in innerHTML — without
   this, "Mom & Dad" would be counted as "Mom &amp; Dad" (4 extra characters, plus
   "amp" reading as a fake extra word since it's a run of letters). A <textarea> is
   used rather than a generic element because assigning to its innerHTML decodes
   entities into .value without the text ever being re-parsed as markup. */
function decodeHtmlEntities(text) {
  const el = document.createElement('textarea');
  el.innerHTML = text;
  return el.value;
}

function htmlToCountableText(html) {
  const withBreaks = stripHiddenHtml(html)
    .replace(/<\/(p|div|h1|h2|h3|blockquote|li)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '');
  return decodeHtmlEntities(withBreaks)
    .replace(/\n{2,}/g, '\n')
    .replace(/\n/g, ' ')
    .trimEnd();
}

/* Finds actual word tokens: runs of letters/digits, with an internal apostrophe
   allowed so contractions and possessives ("don't", "Ellis's") count as one word.
   Deliberately does NOT split on whitespace — instead it defines what a word IS and
   treats literally everything else (spaces, em/en dashes, stray quotes and commas,
   zero-width joiners, scene-break dots, …) as a separator. That makes it immune to
   the whole class of "some odd character glues two words together" or "a stray
   punctuation mark gets counted as its own word" bugs, rather than requiring each
   troublesome character to be special-cased as it's discovered. */
function wordTokens(html) {
  const text = htmlToCountableText(html);
  return text.match(/[\p{L}\p{N}]+(?:['’\u00AD-][\p{L}\p{N}]+)*/gu) || [];
}

function countWords(html) {
  return wordTokens(html).length;
}

/* Counts paragraphs as non-empty top-level blocks (p, headings, blockquotes, scene
   breaks, …) — a blank line from an empty <p><br></p> shouldn't count as a paragraph,
   which raw <p>-tag counting doesn't know to exclude. */
function countParagraphs(html) {
  const normalized = stripHiddenHtml(html)
    .replace(/<\/(p|div|h1|h2|h3|blockquote|li)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ');
  return normalized.split('\n').map(l => l.trim()).filter(Boolean).length;
}

/* Counts sentences. A period/!/? is only a sentence boundary once any closing quotes
   or brackets after it are accounted for — dialogue routinely ends like `while.”`
   with no space between the period and the closing quote, which a naive
   "punctuation then whitespace" split misses, silently merging several sentences
   into one. */
/* Common titles/abbreviations whose period isn't a sentence-ender ("Dr. Evendelle
   said..." is one sentence, not two). Their periods are masked before splitting. */
const SENTENCE_ABBREVIATIONS = /\b(?:Mr|Mrs|Ms|Mx|Dr|Prof|Sr|Jr|St|Capt|Lt|Gen|Col|Sgt|Cmdr|Adm|Gov|Sen|Rep|Pres|Rev|Fr|Msgr|vs|etc|approx|no|vol|ch|fig|figs|pp|Inc|Ltd|Co)\./g;

function countSentences(text) {
  if (!text) return 0;
  let masked = text.replace(SENTENCE_ABBREVIATIONS, m => m.slice(0, -1) + ' ');
  // Mark an em dash immediately followed by closing quotes/brackets and then a
  // boundary (interrupted dialogue: `"Wait—" she said.`) as a sentence end, using a
  // placeholder so the match below can treat it as one more ordinary terminator
  // instead of needing dash-specific logic. A plain mid-sentence dash ("he turned—
  // slowly—and walked away") is deliberately left untouched: earlier versions of this
  // regex excluded "—" from the "ordinary content" character class outright, which
  // meant any dash NOT immediately followed by closing punctuation had nowhere to
  // match at all, and the text around it was silently skipped rather than counted.
  masked = masked.replace(/—([)\]'"’”]+)(?=\s|$)/g, '—$1 ');
  return (masked.match(/[^.!?… ]+(?:[.!?…]+[)\]'"’”]*| )(?:\s|$)|[^.!?… ]+$/g) || []).length;
}

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
  const text    = htmlToCountableText(html);
  const words   = wordTokens(html).length;
  const chars   = text.length;
  const paras   = countParagraphs(html);
  const sentences = countSentences(text);
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
  const span = document.createElement('span');
  span.style.fontFamily = fontValue;
  span.appendChild(fragment);
  range.insertNode(span);
  const caret = document.createRange();
  caret.selectNodeContents(span);
  selection.removeAllRanges();
  selection.addRange(caret);
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
  const span = document.createElement('span');
  span.style.fontSize = sizeValue;
  span.appendChild(fragment);
  range.insertNode(span);
  const selectedRange = document.createRange();
  selectedRange.selectNodeContents(span);
  selection.removeAllRanges();
  selection.addRange(selectedRange);
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
  (d.charPhotos || []).forEach((url, i) => {
    const slot = document.getElementById('char-photo-' + i);
    if (slot && url) slot.style.backgroundImage = `url('${url}')`;
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
      const reader = new FileReader();
      reader.onload = evt => {
        const d2 = docs.find(x => x.id === activeId);
        if (!d2.charPhotos) d2.charPhotos = [];
        d2.charPhotos[i] = evt.target.result;
        const slot = document.getElementById('char-photo-' + i);
        slot.style.backgroundImage = `url('${evt.target.result}')`;
        slot.style.backgroundSize = 'cover';
        slot.style.backgroundPosition = 'center';
        schedulePersist();
      };
      reader.readAsDataURL(file);
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
   Storyboard Room
──────────────────────────────────────── */
let boardPan        = { x: 0, y: 0 };
let boardShowThread = true;
let boardPositions  = {};
let boardIsPanning  = false;
let boardPanStart   = { x: 0, y: 0 };
let boardPanOrigin  = { x: 0, y: 0 };

function boardDefaultPositions() {
  const ms = docs.filter(d => d.section === 'manuscript');
  ms.forEach((d, i) => {
    if (!boardPositions[d.id]) {
      const col = i % 3;
      const row = Math.floor(i / 3);
      boardPositions[d.id] = {
        x: 60 + col * 240,
        y: 60 + row * 320
      };
    }
  });
}

let boardEventsAttached = false;

function buildBoard() {
  boardDefaultPositions();

  const view     = document.getElementById('board-view');
  const canvasEl = document.getElementById('board-canvas');
  const threadC  = document.getElementById('board-thread');

  const W = view.offsetWidth  || window.innerWidth;
  const H = view.offsetHeight || window.innerHeight;
  threadC.width  = W;
  threadC.height = H;
  threadC.style.width  = W + 'px';
  threadC.style.height = H + 'px';

  canvasEl.innerHTML = '';
  buildBoardCards(canvasEl);
  drawBoardThread();
  drawBoardMinimap();

  if (boardEventsAttached) return;
  boardEventsAttached = true;

  canvasEl.addEventListener('mousedown', e => {
    if (e.target !== canvasEl) return;
    boardIsPanning = true;
    boardPanStart  = { x: e.clientX, y: e.clientY };
    boardPanOrigin = { ...boardPan };
    canvasEl.classList.add('grabbing');
  });

  window.addEventListener('mousemove', e => {
    if (!boardIsPanning) return;
    boardPan.x = boardPanOrigin.x + (e.clientX - boardPanStart.x);
    boardPan.y = boardPanOrigin.y + (e.clientY - boardPanStart.y);
    updateBoardCardPositions();
  });

  window.addEventListener('mouseup', () => {
    if (boardIsPanning) {
      boardIsPanning = false;
      canvasEl.classList.remove('grabbing');
    }
  });

  document.getElementById('board-btn-thread').addEventListener('click', function() {
    boardShowThread = !boardShowThread;
    this.classList.toggle('active', boardShowThread);
    drawBoardThread();
  });

  document.getElementById('board-btn-reset').addEventListener('click', () => {
    boardPan = { x: 0, y: 0 };
    updateBoardCardPositions();
  });
}

function buildBoardCards(canvasEl) {
  const ms     = docs.filter(d => d.section === 'manuscript');
  const dated  = ms.filter(d => d.storyDate).sort((a,b) => new Date(a.storyDate) - new Date(b.storyDate));
  const undated= ms.filter(d => !d.storyDate);
  const ordered= [...dated, ...undated];

  ordered.forEach((d, i) => {
    const el  = document.createElement('div');
    const pos = boardPositions[d.id];
    const wc  = countWords(d.content);
    const num = dated.findIndex(x => x.id === d.id);
    const numLabel = num >= 0 ? String(num + 1).padStart(2, '0') : '—';

    el.className = 'board-card' + (d.storyDate ? '' : ' undated') +
                   (d.id === activeId ? ' active' : '');
    el.dataset.id = d.id;
    el.style.left = (pos.x + boardPan.x) + 'px';
    el.style.top  = (pos.y + boardPan.y) + 'px';

    const snippet = d.content.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);

    el.innerHTML = `
      <div class="board-card-header">
        <span class="board-card-num">${numLabel}</span>
        <span class="board-card-title">${d.title}</span>
        <button class="board-card-thread-btn ${d.inThread ? 'active' : ''}" title="${d.inThread ? 'Remove from red thread' : 'Add to red thread'}"></button>
        <span class="board-card-pin" style="background:${STATUS_COLORS[d.status]}"></span>
      </div>
      ${d.banner
        ? `<img class="board-card-image" src="${d.banner}" draggable="false">`
        : `<div class="board-card-no-image"><span class="board-card-no-image-text">no banner</span></div>`
      }
      <div class="board-card-body">
        <div class="board-card-date">${d.storyDate ? new Date(d.storyDate).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'}) : 'undated'}</div>
        <div class="board-card-synopsis">${snippet || '(empty)'}</div>
      </div>
      <div class="board-card-footer">
        <span class="board-card-wc">${wc > 0 ? wc + ' words' : '—'}</span>
        <span class="board-card-status">${d.status}</span>
        <span class="board-card-dot" style="background:${STATUS_COLORS[d.status]}"></span>
      </div>`;

    makeBoardCardDraggable(el, d.id);

    el.querySelector('.board-card-thread-btn').addEventListener('click', e => {
      e.stopPropagation();
      d.inThread = !d.inThread;
      e.target.classList.toggle('active', d.inThread);
      e.target.title = d.inThread ? 'Remove from red thread' : 'Add to red thread';
      drawBoardThread();
      schedulePersist();
    });

    el.addEventListener('click', e => {
      e.stopPropagation();
      document.querySelectorAll('.board-card').forEach(c => c.classList.remove('active'));
      el.classList.add('active');
    });

    el.addEventListener('dblclick', () => {
      setMode('editor');
      loadDoc(d.id);
    });

    canvasEl.appendChild(el);
  });
}

function makeBoardCardDraggable(el, id) {
  let dragging = false;
  let startX, startY, startPosX, startPosY;

  el.addEventListener('mousedown', e => {
    if (e.button !== 0) return;
    if (e.target.closest('.board-card-thread-btn')) return;
    e.stopPropagation();
    dragging  = true;
    startX    = e.clientX;
    startY    = e.clientY;
    startPosX = boardPositions[id].x;
    startPosY = boardPositions[id].y;
    el.classList.add('dragging');

    const onMove = e => {
      if (!dragging) return;
      boardPositions[id].x = startPosX + (e.clientX - startX);
      boardPositions[id].y = startPosY + (e.clientY - startY);
      el.style.left = (boardPositions[id].x + boardPan.x) + 'px';
      el.style.top  = (boardPositions[id].y + boardPan.y) + 'px';
      drawBoardThread();
      drawBoardMinimap();
    };

    const onUp = () => {
      dragging = false;
      el.classList.remove('dragging');
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  });
}

function updateBoardCardPositions() {
  document.querySelectorAll('.board-card').forEach(el => {
    const id  = +el.dataset.id;
    const pos = boardPositions[id];
    if (!pos) return;
    el.style.left = (pos.x + boardPan.x) + 'px';
    el.style.top  = (pos.y + boardPan.y) + 'px';
  });
  drawBoardThread();
  drawBoardMinimap();
}

function getBoardCardCenter(id) {
  const pos = boardPositions[id];
  if (!pos) return null;
  return {
    x: pos.x + boardPan.x + 100,
    y: pos.y + boardPan.y + 80
  };
}

function drawBoardThread() {
  const threadC = document.getElementById('board-thread');
  if (!threadC) return;
  const ctx = threadC.getContext('2d');
  ctx.clearRect(0, 0, threadC.width, threadC.height);
  if (!boardShowThread) return;

  const threaded = docs.filter(d => d.section === 'manuscript' && d.inThread);

  for (let i = 0; i < threaded.length - 1; i++) {
    const a = getBoardCardCenter(threaded[i].id);
    const b = getBoardCardCenter(threaded[i + 1].id);
    if (!a || !b) continue;

    const mx = (a.x + b.x) / 2;
    const my = (a.y + b.y) / 2 + 20;

    // Thick shadow thread
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.quadraticCurveTo(mx, my, b.x, b.y);
    ctx.strokeStyle = 'rgba(38,42,36,0.35)';
    ctx.lineWidth   = 5;
    ctx.lineCap     = 'round';
    ctx.stroke();

    // Main thread
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.quadraticCurveTo(mx, my, b.x, b.y);
    ctx.strokeStyle = 'rgba(95,115,85,0.8)';
    ctx.lineWidth   = 1.5;
    ctx.setLineDash([5, 7]);
    ctx.stroke();
    ctx.setLineDash([]);

    // Pin dots
    [a, b].forEach(pt => {
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, 4.5, 0, Math.PI * 2);
      ctx.fillStyle = '#5f7355';
      ctx.fill();
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, 2, 0, Math.PI * 2);
      ctx.fillStyle = '#f7faf5';
      ctx.fill();
    });
  }
}

function drawBoardMinimap() {
  const mmC  = document.getElementById('board-mm-canvas');
  const view = document.getElementById('board-view');
  if (!mmC || !view) return;

  const ctx   = mmC.getContext('2d');
  const W     = view.offsetWidth  || 600;
  const H     = view.offsetHeight || 400;
  const scaleX = 110 / W;
  const scaleY = 70  / H;

  ctx.fillStyle = '#262a24';
  ctx.fillRect(0, 0, 110, 70);

  docs.filter(d => d.section === 'manuscript').forEach(d => {
    const pos = boardPositions[d.id];
    if (!pos) return;
    const mx = (pos.x + boardPan.x) * scaleX;
    const my = (pos.y + boardPan.y) * scaleY;
    ctx.fillStyle  = STATUS_COLORS[d.status];
    ctx.globalAlpha = d.storyDate ? 0.85 : 0.3;
    ctx.fillRect(mx, my, 10, 6);
    ctx.globalAlpha = 1;
  });
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
  const reader = new FileReader();
  reader.onload = evt => {
    const url = evt.target.result;
    const d = docs.find(x => x.id === activeId);
    if (d) d.banner = url;
    setBanner(url);
    closeBannerPicker();
    schedulePersist();
  };
  reader.readAsDataURL(file);
}

/* ────────────────────────────────────────
   Focus Mode
──────────────────────────────────────── */
function toggleFocus() {
  document.body.classList.toggle('focus-mode');
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

function toggleSidebar(open) {
  document.body.classList.toggle('sidebar-collapsed', !open);
  localStorage.setItem('folio-sidebar-open', String(open));
  // On a phone-width screen the sidebar and inspector are both full fixed-width
  // columns fighting for the same tiny viewport — having both open at once leaves
  // no room for the editor, so opening one closes the other.
  if (open && isPhoneWidth()) {
    document.body.classList.add('inspector-collapsed');
    localStorage.setItem('folio-inspector-open', 'false');
  }
}

function toggleInspector(open) {
  document.body.classList.toggle('inspector-collapsed', !open);
  localStorage.setItem('folio-inspector-open', String(open));
  if (open && isPhoneWidth()) {
    document.body.classList.add('sidebar-collapsed');
    localStorage.setItem('folio-sidebar-open', 'false');
  }
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
  list.innerHTML = snapshots.length ? snapshots.map(s => `<div class="snapshot-item" data-id="${s.id}"><div><strong>${new Date(s.createdAt).toLocaleString()}</strong><span>${s.words.toLocaleString()} words</span></div><div><button data-action="compare">Compare</button><button data-action="restore">Restore</button></div></div>`).join('') : '<div class="panel-empty">No snapshots yet.</div>';
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
  try { return JSON.parse(localStorage.getItem('folio-projects') || '[]'); } catch { return []; }
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
  try {
    localStorage.setItem('folio-projects', JSON.stringify(projects));
    return true;
  } catch (error) {
    console.error('Could not save project covers', error);
    alert('The cover could not be saved because browser storage is full. Try a smaller image or remove an older cover.');
    return false;
  }
}

function prepareCoverImage(file) {
  const accepted = ['image/png', 'image/jpeg', 'image/webp', 'image/avif'];
  if (!accepted.includes(file.type)) return Promise.reject(new Error('Unsupported image type'));
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Could not read image'));
    reader.onload = () => {
      const image = new Image();
      image.onerror = () => reject(new Error('Could not decode image'));
      image.onload = () => {
        const maxDimension = 900;
        const scale = Math.min(1, maxDimension / Math.max(image.naturalWidth, image.naturalHeight));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
        canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
        canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL('image/webp', 0.78));
      };
      image.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
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
    }
    renderProjects();
  } catch (error) {
    console.error('Could not save cover', error);
    if (error.message !== 'Project not found') alert('That image could not be used. Choose a PNG, JPEG, WebP, or AVIF file.');
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
  'font-size', 'font-family',
];

/* Strips typesetting properties — indent, margin, padding, font size, font
   family; deliberately NOT bold/italic/underline/color, which are the writer's
   actual emphasis choices — that either Word/Google Docs/Pages bake into every
   paragraph on paste, or that a font-size/font selection in the editor embeds
   directly into that stretch of text. Left in place, either one fights the
   formatter's own uniform typesetting the same way a pasted hardcoded color used
   to fight the app's theme: nothing enforces a single consistent value, so
   paragraphs come out sized and spaced arbitrarily instead of in an even,
   book-typeset rhythm. A big enough leftover font-size has a second, worse
   consequence too — a paragraph that can't fit on any single page even on its
   own falls back to a plain-text word-by-word layout that drops all formatting,
   which is the "chapter title alone on one page, unformatted text on the next"
   symptom this was reported as. */
function stripInlineSpacing(el) {
  [el, ...el.querySelectorAll('[style]')].forEach(node => {
    if (!node.hasAttribute('style')) return;
    FORMATTER_TYPESETTING_PROPS.forEach(prop => node.style.removeProperty(prop));
    if (!node.getAttribute('style')) node.removeAttribute('style');
  });
}

function stripLeadingIndent(el) {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  const node = walker.nextNode();
  if (!node) return;
  node.textContent = node.textContent.replace(/^[ \t ]+/, '');
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
      if (blockIndex === 0 && settings.dropcaps) applyFormatterDropCap(current.prose);
      if (!overflows(current.page)) return; // whole block fit — done, full formatting kept

      // Doesn't fit whole. Split it right here on THIS page rather than moving the
      // whole thing to a fresh one — real books routinely run a paragraph across a
      // page break, filling each page with as much as fits; moving it wholesale
      // instead left the chapter's title page (or any page a block didn't quite
      // fit) completely empty of body text, with everything starting on the next
      // page instead. Word-by-word plain-text chunking only visibly costs inline
      // formatting for the sliver of text that happens to straddle the exact page
      // break, which is far better than losing an entire page's worth of layout.
      block.remove();
      const remaining = original.textContent.trim().split(/\s+/).filter(Boolean);
      let needsDropCap = blockIndex === 0 && settings.dropcaps;
      while (remaining.length) {
        const paragraph = document.createElement('p');
        current.prose.appendChild(paragraph);
        let fitted = 0;
        while (fitted < remaining.length) {
          paragraph.textContent = remaining.slice(0, fitted + 1).join(' ');
          if (overflows(current.page)) break;
          fitted += 1;
        }
        if (fitted === 0) {
          paragraph.remove();
          current = createPage(chapter, true);
          continue;
        }
        paragraph.textContent = remaining.splice(0, fitted).join(' ');
        if (needsDropCap) {
          applyFormatterDropCap(current.prose);
          needsDropCap = false;
        }
        if (remaining.length) current = createPage(chapter, true);
      }
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

function renderProjects() {
  const archive = projectArchive().sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
  const allWords = archive.reduce((total, p) => total + (p.docs || []).filter(d => d.section === 'manuscript').reduce((sum, d) => sum + countWords(d.content || ''), 0), 0);
  document.getElementById('projects-summary').textContent = `${archive.length} project${archive.length === 1 ? '' : 's'} · ${allWords.toLocaleString()} words`;
  if (!archive.length) {
    document.getElementById('projects-grid').innerHTML = `<div class="projects-empty">No projects yet — click "New project" to start writing, or "Import project…" to bring one in.</div>`;
    return;
  }
  document.getElementById('projects-grid').innerHTML = archive.map(p => {
    const words = (p.docs || []).filter(d => d.section === 'manuscript').reduce((sum, d) => sum + countWords(d.content || ''), 0);
    return `<div class="project-card ${p.id === currentProjectId ? 'active' : ''}" data-id="${p.id}">
      <button class="project-open">
        <span class="project-cover">
          <span class="project-cover-placeholder">▧<em>Drop a cover image</em></span>
        </span>
        <small>${words.toLocaleString()} words · ${new Date(p.updatedAt).toLocaleDateString()}</small>
      </button>
      <div class="project-title-row">
        <strong>${escapeHTML(p.title)}</strong>
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
      <input class="project-cover-input" type="file" accept="image/png,image/jpeg,image/webp,image/avif">
    </div>`;
  }).join('');
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
  document.querySelectorAll('.project-cover').forEach(cover => {
    cover.addEventListener('dragover', e => { e.preventDefault(); cover.classList.add('drag-over'); });
    cover.addEventListener('dragleave', () => cover.classList.remove('drag-over'));
    cover.addEventListener('drop', e => {
      e.preventDefault(); cover.classList.remove('drag-over');
      const file = [...e.dataTransfer.files].find(f => f.type.startsWith('image/'));
      if (!file) return;
      const id = cover.closest('.project-card').dataset.id;
      saveProjectCoverFile(id, file);
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
  localStorage.removeItem(`folio-formatter:${id}`);

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
      const card = document.querySelector(`.project-card[data-id="${CSS.escape(project.id)}"]`);
      if (!card) return;
      const coverElement = card.querySelector('.project-cover');
      coverElement.style.backgroundImage = `url("${cover}")`;
      coverElement.querySelector('.project-cover-placeholder').hidden = true;
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
  try { cover = await getStoredCover(project.id); } catch (e) { /* no cover saved */ }

  let formatterSettings = null;
  try { formatterSettings = JSON.parse(localStorage.getItem(`folio-formatter:${project.id}`) || 'null'); } catch (e) { formatterSettings = null; }

  return {
    folioFile: true,
    version: FOLIO_FILE_VERSION,
    exportedAt: new Date().toISOString(),
    project: { id: project.id, title: project.title, docs: project.docs, nextId: project.nextId, activeId: project.activeId, updatedAt: project.updatedAt },
    cover,
    formatterSettings
  };
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

function syncFolderSupported() { return 'showDirectoryPicker' in window; }

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

async function writeProjectToSyncFolder(project) {
  if (!syncFolderHandle) return;
  if (!(await ensureSyncFolderPermission(syncFolderHandle, false))) return; // never prompt during a background autosave
  try {
    const map = syncFilenameMap();
    const newName = `${safeFileSlug(project.title)}.folio`;
    const oldName = map[project.id];
    if (oldName && oldName !== newName) {
      try { await syncFolderHandle.removeEntry(oldName); } catch (e) { /* already gone */ }
    }
    const payload = await buildProjectFilePayload(project.id, project);
    const fileHandle = await syncFolderHandle.getFileHandle(newName, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(JSON.stringify(payload));
    await writable.close();
    map[project.id] = newName;
    setSyncFilenameMap(map);
  } catch (e) {
    console.error('Could not write to synced folder', e);
  }
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
  if (!granted) return;

  const archive = projectArchive();
  const conflicts = [];
  let importedAny = false;

  try {
    for await (const entry of syncFolderHandle.values()) {
      if (entry.kind !== 'file' || !entry.name.endsWith('.folio')) continue;
      let data;
      try { data = JSON.parse(await (await entry.getFile()).text()); } catch (e) { continue; }
      if (!data || !data.folioFile || !data.project || !data.project.id) continue;

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
  if (currentProjectId === 'default') { currentProjectId = newId; persistState(); }
}

async function chooseSyncFolder() {
  if (!syncFolderSupported()) {
    alert("Folder sync needs the File System Access API, which only Chrome and Edge on desktop support right now — Safari and iPhone browsers don't have it. Use Export/Import to move projects between those.");
    return;
  }
  try {
    const handle = await window.showDirectoryPicker({ id: 'folio-sync', mode: 'readwrite' });
    await setSyncFolderHandle(handle);
    syncFolderHandle = handle;
    updateSyncFolderUI();
    ensureUniqueProjectId();
    saveProjectToArchive(); // writes the current project into the folder immediately
    await scanSyncFolder();
  } catch (e) {
    if (e.name !== 'AbortError') console.error('Could not choose synced folder', e);
  }
}

async function reconnectSyncFolder() {
  if (!syncFolderHandle) return;
  const granted = await ensureSyncFolderPermission(syncFolderHandle, true);
  updateSyncFolderUI(!granted);
  if (granted) { ensureUniqueProjectId(); await scanSyncFolder(); }
}

async function disconnectSyncFolder() {
  syncFolderHandle = null;
  await clearSyncFolderHandle();
  updateSyncFolderUI();
  renderSyncConflicts([]);
}

async function loadSyncFolderHandle() {
  if (!syncFolderSupported()) { updateSyncFolderUI(); return; }
  try {
    const handle = await getSyncFolderHandle();
    if (!handle) { updateSyncFolderUI(); return; }
    syncFolderHandle = handle;
    ensureUniqueProjectId();
    await scanSyncFolder();
  } catch (e) {
    console.error('Could not load synced folder handle', e);
  }
}

/* ────────────────────────────────────────
   Event Listeners
──────────────────────────────────────── */
function setupEventListeners() {

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
  document.getElementById('sidebar-collapse').addEventListener('click', () => toggleSidebar(false));
  document.getElementById('sidebar-expand').addEventListener('click', () => toggleSidebar(true));
  document.getElementById('inspector-collapse').addEventListener('click', () => toggleInspector(false));
  document.getElementById('inspector-expand').addEventListener('click', () => toggleInspector(true));
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
  document.addEventListener('click', e => { if (!e.target.closest('#settings-menu') && !e.target.closest('#btn-settings')) toggleSettingsMenu(false); });
  document.addEventListener('click', e => {
    if (!e.target.closest('.project-more') && !e.target.closest('.project-card-menu')) {
      document.querySelectorAll('.project-card-menu.open').forEach(menu => menu.classList.remove('open'));
      document.querySelectorAll('.project-card.menu-open').forEach(card => card.classList.remove('menu-open'));
    }
  });
  document.getElementById('projects-grid').addEventListener('scroll', () => {
    document.querySelectorAll('.project-card-menu.open').forEach(menu => menu.classList.remove('open'));
    document.querySelectorAll('.project-card.menu-open').forEach(card => card.classList.remove('menu-open'));
  }, { passive: true });

  /* Project shelf and compilation */
  document.getElementById('btn-projects').addEventListener('click', openProjects);
  document.getElementById('new-project-btn').addEventListener('click', createProject);
  document.getElementById('import-project-btn').addEventListener('click', () => document.getElementById('import-project-input').click());
  document.getElementById('import-project-input').addEventListener('change', e => {
    const file = e.target.files[0];
    e.target.value = '';
    if (file) importProjectFile(file);
  });
  document.getElementById('projects-grid').addEventListener('dragover', e => {
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

/* ── Start ── */
init();
