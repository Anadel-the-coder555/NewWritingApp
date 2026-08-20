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
let persistTimer = null;

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
function init() {
  loadPersistedState();
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
    saveCurrentDoc();
    saveCharacterView();
    persistState();
  });
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
function countWords(html) {
  const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  return text ? text.split(' ').filter(w => w.length > 0).length : 0;
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
  const text    = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  const words   = text ? text.split(' ').filter(w => w.length > 0).length : 0;
  const chars   = text.replace(/\s/g, '').length;
  const paras   = (html.match(/<p[^>]*>/gi) || []).length || (text ? 1 : 0);
  const sentences = text ? (text.match(/[^.!?]+[.!?]+(?:\s|$)|[^.!?]+$/g) || []).length : 0;
  const readMin = Math.max(1, Math.round(words / 200));

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

function applyBlock(tag) {
  if (tag === 'div') {
    document.execCommand('insertHTML', false, '<div class="scene-break">· · ·</div><p><br></p>');
    document.getElementById('fmt-block').value = 'p';
    document.getElementById('editor').focus();
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

function toggleSidebar(open) {
  document.body.classList.toggle('sidebar-collapsed', !open);
  localStorage.setItem('folio-sidebar-open', String(open));
}

function toggleInspector(open) {
  document.body.classList.toggle('inspector-collapsed', !open);
  localStorage.setItem('folio-inspector-open', String(open));
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
  const request = indexedDB.open('folio-media', 1);
  request.onupgradeneeded = () => request.result.createObjectStore('project-covers');
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});

async function coverStore(mode, operation) {
  const database = await coverDatabase;
  return new Promise((resolve, reject) => {
    const transaction = database.transaction('project-covers', mode);
    const store = transaction.objectStore('project-covers');
    const request = operation(store);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

const getStoredCover = id => coverStore('readonly', store => store.get(id));
const setStoredCover = (id, value) => coverStore('readwrite', store => store.put(value, id));
const deleteStoredCover = id => coverStore('readwrite', store => store.delete(id));

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

function saveProjectToArchive() {
  saveCurrentDoc();
  const archive = projectArchive();
  const state = { id: currentProjectId, title: document.getElementById('project-title-input').value || 'Untitled Project', docs: JSON.parse(JSON.stringify(docs)), nextId, activeId, updatedAt: new Date().toISOString() };
  const index = archive.findIndex(p => p.id === state.id);
  if (index >= 0) archive[index] = state; else archive.push(state);
  writeProjectArchive(archive);
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
      if (!overflows(current.page)) return;
      block.remove();
      if (current.prose.childNodes.length) current = createPage(chapter, true);
      block = original.cloneNode(true);
      current.prose.appendChild(block);
      if (blockIndex === 0 && settings.dropcaps) applyFormatterDropCap(current.prose);
      if (!overflows(current.page)) return;

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

function openProjects() { saveProjectToArchive(); renderProjects(); document.getElementById('projects-overlay').classList.add('open'); }

function renderProjects() {
  const archive = projectArchive().sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
  const allWords = archive.reduce((total, p) => total + (p.docs || []).filter(d => d.section === 'manuscript').reduce((sum, d) => sum + countWords(d.content || ''), 0), 0);
  document.getElementById('projects-summary').textContent = `${archive.length} project${archive.length === 1 ? '' : 's'} · ${allWords.toLocaleString()} words`;
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
  saveProjectToArchive(); currentProjectId = `project-${Date.now()}`;
  docs = [{ id: 1, title: 'Untitled', storyDate: '', banner: '', content: '', synopsis: '', status: 'draft', target: 0, tags: [], parent: null, isFolder: false, section: 'manuscript', createdAt: new Date() }];
  nextId = 2; activeId = 1; sessionBaseWords = getSessionBase();
  document.getElementById('project-title-input').value = title.trim();
  persistState(); saveProjectToArchive(); document.getElementById('projects-overlay').classList.remove('open'); renderTree(); loadDoc(activeId);
}

/* ────────────────────────────────────────
   Event Listeners
──────────────────────────────────────── */
function setupEventListeners() {

  /* Toolbar format buttons */
  document.querySelectorAll('.fmt-btn[data-cmd]').forEach(btn => {
    btn.addEventListener('click', () => fmt(btn.dataset.cmd));
  });

  /* Block format select */
  document.getElementById('fmt-block').addEventListener('change', function() {
    applyBlock(this.value);
  });

  /* Font select */
  document.getElementById('fmt-font').addEventListener('change', function() {
    const d = docs.find(x => x.id === activeId);
    if (!d) return;
    d.font = this.value;
    document.getElementById('editor').style.fontFamily = this.value;
    schedulePersist();
  });

  /* Editor input */
  document.getElementById('editor').addEventListener('input', () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { saveCurrentDoc(); renderTree(); }, 400);
    updateStats();
    centerCurrentLine();
  });
  document.getElementById('editor').addEventListener('keyup', centerCurrentLine);
  document.getElementById('editor').addEventListener('click', centerCurrentLine);
  document.addEventListener('selectionchange', () => {
    if (typewriterMode) centerCurrentLine();
  });

  /* Revision and writing-mode toolbar */
  document.getElementById('typewriter-btn').addEventListener('click', () => setTypewriterMode());
  document.getElementById('proofing-btn').addEventListener('click', toggleProofing);
  document.getElementById('split-btn').addEventListener('click', () => toggleSplit());
  document.getElementById('split-close').addEventListener('click', () => toggleSplit(false));
  document.getElementById('split-doc-select').addEventListener('change', e => { saveSplitReference(); splitReferenceId = +e.target.value; renderSplitReference(); schedulePersist(); });
  document.getElementById('split-reference-content').addEventListener('input', saveSplitReference);
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
  /* Primary navigation and synopsis start visible; collapse is session-only. */
  toggleSidebar(true);
  toggleInspector(true);

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
    const actions = { typewriter: () => setTypewriterMode(), proofing: toggleProofing, beats: toggleBeats, template: applyBeatTemplate, split: () => toggleSplit(), margin: () => toggleMargin(), compile: openCompile, snapshot: takeSnapshot, book: openBookMode, focus: toggleFocus };
    actions[btn.dataset.option](); toggleOptionsMenu(false);
  }));
  document.addEventListener('click', e => { if (!e.target.closest('#options-menu') && !e.target.closest('#btn-menu')) toggleOptionsMenu(false); });
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
  document.getElementById('book-next').addEventListener('click', bookFlipForward);
  document.getElementById('book-prev').addEventListener('click', bookFlipBackward);
  document.getElementById('book-curl').addEventListener('click', bookFlipForward);
  document.getElementById('book-editor').addEventListener('input', bookUpdateWC);
  document.addEventListener('keydown', e => {
    if (!document.getElementById('book-overlay').classList.contains('open')) return;
    if (e.key === 'PageDown') { e.preventDefault(); bookFlipForward(); }
    if (e.key === 'PageUp')   { e.preventDefault(); bookFlipBackward(); }
    if (e.key === 'Escape')   { closeBookMode(); }
  });

  document.getElementById('book-editor').addEventListener('paste', e => {
  e.preventDefault();
  const text = e.clipboardData.getData('text/plain');
  const el = document.getElementById('book-editor');
  const paras = text.split('\n').filter(p => p.trim().length > 0);
  paras.forEach(p => {
    const para = document.createElement('p');
    para.textContent = p;
    el.appendChild(para);
  });
  setTimeout(() => bookReSplitCurrentPage('right'), 100);
});

document.getElementById('book-left-content').addEventListener('paste', e => {
  e.preventDefault();
  const text = e.clipboardData.getData('text/plain');
  const el = document.getElementById('book-left-content');
  const paras = text.split('\n').filter(p => p.trim().length > 0);
  paras.forEach(p => {
    const para = document.createElement('p');
    para.textContent = p;
    el.appendChild(para);
  });
  setTimeout(() => bookReSplitCurrentPage('left'), 100);
});
}
/* ────────────────────────────────────────
   Book Mode
──────────────────────────────────────── */
const BOOK_CHAPTER_LABEL = () => document.getElementById('doc-title-edit').value || 'Untitled';
const CHARS_PER_PAGE = 2800; // Adjust as needed for page length

let bookPages    = [];
let bookSpread   = 0;
let bookFlipping = false;

function openBookMode() {
  const d = docs.find(x => x.id === activeId);
  if (!d) return;

  const plain = d.content
  .replace(/<p[^>]*>/gi, '\n')
  .replace(/<\/p>/gi, '')
  .replace(/<br\s*\/?>/gi, '\n')
  .replace(/<[^>]+>/g, '')
  .replace(/&nbsp;/gi, ' ')
  .replace(/\n{3,}/g, '\n\n')
  .trim();

  bookPages = [];
  const paras = plain.split('\n').filter(p => p.trim().length > 0);
  let currentPage = [];
  let currentLen  = 0;

  paras.forEach(para => {
    if (currentLen + para.length > CHARS_PER_PAGE && currentPage.length > 0) {
      bookPages.push(currentPage);
      currentPage = [];
      currentLen  = 0;
    }
    currentPage.push(para);
    currentLen += para.length;
  });

  if (currentPage.length > 0) bookPages.push(currentPage);

  while (bookPages.length < 2) bookPages.push([]);

  bookSpread   = -1;
  bookFlipping = false;

  document.getElementById('book-overlay').classList.add('open');
  bookRenderSpread();
}

function closeBookMode() {
  if (bookSpread >= 0) bookSaveBothPages();

  const allParas = bookPages.flat();
  const html = allParas.map(p => `<p>${p}</p>`).join('');

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
    ? leftPage.map((p, i) => `<p style="text-indent:${i === 0 ? '0' : '1.8em'};margin-bottom:0;">${p}</p>`).join('')
    : '';

  // Right page — fully editable
  const rightEl   = document.getElementById('book-editor');
  const rightPage = bookPages[rightIdx] || [];
  rightEl.contentEditable = 'true';
  rightEl.style.cursor    = 'text';
  rightEl.innerHTML = rightPage.length > 0
    ? rightPage.map((p, i) => `<p style="text-indent:${i === 0 ? '0' : '1.8em'};margin-bottom:0;">${p}</p>`).join('')
    : '';

  rightEl.focus();
  bookUpdateWC();
}

function bookSaveBothPages() {
  if (bookSpread < 0) return;

  const leftIdx  = bookSpread * 2;
  const rightIdx = bookSpread * 2 + 1;

  while (bookPages.length <= rightIdx) bookPages.push([]);

  // Save left page
  const leftEl = document.getElementById('book-left-content');
  const leftParas = Array.from(leftEl.querySelectorAll('p'))
    .map(p => p.textContent.trim())
    .filter(p => p.length > 0);
  bookPages[leftIdx] = leftParas.length > 0
    ? leftParas
    : leftEl.innerText.split('\n').filter(l => l.trim().length > 0);

  // Save right page
  const rightEl = document.getElementById('book-editor');
  const rightParas = Array.from(rightEl.querySelectorAll('p'))
    .map(p => p.textContent.trim())
    .filter(p => p.length > 0);
  bookPages[rightIdx] = rightParas.length > 0
    ? rightParas
    : rightEl.innerText.split('\n').filter(l => l.trim().length > 0);
}

function bookUpdateWC() {
  const allText = bookPages.flat().join(' ');
  const words   = allText.trim().split(/\s+/).filter(w => w.length > 0).length;
  document.getElementById('book-wc').textContent = words.toLocaleString() + ' words';
}

function bookReSplitCurrentPage(side) {
  bookSaveBothPages();

  // Grab all content from current page onward
  const leftIdx  = bookSpread * 2;
  const rightIdx = bookSpread * 2 + 1;
  const idx      = side === 'left' ? leftIdx : rightIdx;

  // Pull all text from the pasted page to the end
  const remainingPages = bookPages.slice(idx);
  const allText = remainingPages.flat().join('\n');

  if (allText.length <= CHARS_PER_PAGE) {
    bookRenderSpread();
    return;
  }

  // Resplit all that text into pages
  const paras = allText.split('\n').filter(p => p.trim().length > 0);
  const newPages = [];
  let currentPage = [];
  let currentLen  = 0;

  paras.forEach(para => {
    if (currentLen + para.length > CHARS_PER_PAGE && currentPage.length > 0) {
      newPages.push(currentPage);
      currentPage = [];
      currentLen  = 0;
    }
    currentPage.push(para);
    currentLen += para.length;
  });

  if (currentPage.length > 0) newPages.push(currentPage);

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
