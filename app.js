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

const STATUS_COLORS = { draft: '#B0ADA5', revision: '#E6A820', final: '#4CAF50' };

/* ────────────────────────────────────────
   Local Storage Persistence
──────────────────────────────────────── */
const STORAGE_KEY = 'folio-project';
let persistTimer = null;

function persistState() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ docs, nextId, activeId }));
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
  window.addEventListener('beforeunload', () => {
    saveCurrentDoc();
    saveCharacterView();
    persistState();
  });
}

/* ────────────────────────────────────────
   Tree Rendering
──────────────────────────────────────── */
function renderTree() {
  const manuscript = docs.filter(d => d.section === 'manuscript');
  const research   = docs.filter(d => d.section === 'research');
  document.getElementById('doc-tree').innerHTML      = manuscript.map(docItemHTML).join('');
  document.getElementById('research-tree').innerHTML = research.map(docItemHTML).join('');
  attachTreeEvents();
  schedulePersist();
}

function docItemHTML(d) {
  const color = STATUS_COLORS[d.status] || STATUS_COLORS.draft;
  const icon  = d.isFolder ? '▸' : '◦';
  const wc    = countWords(d.content);
  return `<div class="doc-item ${d.id === activeId ? 'active' : ''}" data-id="${d.id}" draggable="true">
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
  document.getElementById('synopsis-area').value   = d.synopsis || '';
  document.getElementById('status-select').value   = d.status || 'draft';
  document.getElementById('target-input').value    = d.target || '';
  document.getElementById('story-date').value      = d.storyDate || '';
  setBanner(d.banner || '');
  document.getElementById('sub-date').textContent  = d.createdAt
    ? d.createdAt.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
    : '—';

  renderTags(d);
  updateStats();
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
  const readMin = Math.max(1, Math.round(words / 200));

  document.getElementById('stat-words').textContent        = words.toLocaleString();
  document.getElementById('stat-chars').textContent        = chars.toLocaleString();
  document.getElementById('stat-paras').textContent        = paras;
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
}

/* ────────────────────────────────────────
   Formatting
──────────────────────────────────────── */
function fmt(cmd) {
  document.execCommand(cmd, false, null);
  document.getElementById('editor').focus();
}

function applyBlock(tag) {
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
  if (!skipSave) {
    saveCurrentDoc();
    saveCharacterView();
  }

  ['editor', 'cork', 'outline', 'timeline', 'board'].forEach(m => {
    const btnId = m === 'editor'  ? 'btn-editor'
                : m === 'cork'    ? 'btn-cork'
                : m === 'outline' ? 'btn-outline'
                : m === 'timeline'? 'btn-timeline'
                : 'btn-board';
    document.getElementById(btnId).classList.toggle('active', m === mode);
  });

  document.getElementById('editor-scroll').className  = mode === 'editor'   ? '' : 'hidden';
  document.getElementById('editor-toolbar').className = mode === 'editor'   ? '' : 'hidden';
  document.getElementById('corkboard').className      = mode === 'cork'     ? 'active' : '';
  document.getElementById('outline-view').className   = mode === 'outline'  ? 'active' : '';
  document.getElementById('timeline-view').className  = mode === 'timeline' ? 'active' : '';
  document.getElementById('character-view').className  = mode === 'characters' ? 'active' : '';
  document.getElementById('board-view').className     = mode === 'board'    ? 'active' : '';

  if (mode === 'cork')     buildCork();
  if (mode === 'outline')  buildOutline();
  if (mode === 'timeline') buildTimeline();
  if (mode === 'board')    buildBoard();
  if (mode === 'characters') loadCharacterView();
}

function buildCork() {
  const ms = docs.filter(d => d.section === 'manuscript');
  document.getElementById('cork-grid').innerHTML = ms.map(d => {
    const snippet  = d.content.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 240);
    const pinColor = d.id === activeId ? '#C9462A' : '#8B7EC8';
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

  const dated = docs
    .filter(d => d.section === 'manuscript' && d.storyDate)
    .sort((a, b) => new Date(a.storyDate) - new Date(b.storyDate));

  for (let i = 0; i < dated.length - 1; i++) {
    const a = getBoardCardCenter(dated[i].id);
    const b = getBoardCardCenter(dated[i + 1].id);
    if (!a || !b) continue;

    const mx = (a.x + b.x) / 2;
    const my = (a.y + b.y) / 2 + 20;

    // Thick shadow thread
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.quadraticCurveTo(mx, my, b.x, b.y);
    ctx.strokeStyle = 'rgba(160,40,20,0.2)';
    ctx.lineWidth   = 5;
    ctx.lineCap     = 'round';
    ctx.stroke();

    // Main thread
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.quadraticCurveTo(mx, my, b.x, b.y);
    ctx.strokeStyle = 'rgba(201,70,42,0.75)';
    ctx.lineWidth   = 1.5;
    ctx.setLineDash([5, 7]);
    ctx.stroke();
    ctx.setLineDash([]);

    // Pin dots
    [a, b].forEach(pt => {
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, 4.5, 0, Math.PI * 2);
      ctx.fillStyle = '#C9462A';
      ctx.fill();
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, 2, 0, Math.PI * 2);
      ctx.fillStyle = '#F5F2ED';
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

  ctx.fillStyle = '#0A0908';
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

  /* Editor input */
  document.getElementById('editor').addEventListener('input', () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { saveCurrentDoc(); renderTree(); }, 400);
    updateStats();
  });

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
    if (d) { d.status = this.value; renderTree(); }
  });

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

  /* View mode buttons */
  document.getElementById('btn-editor').addEventListener('click',   () => setMode('editor'));
  document.getElementById('btn-cork').addEventListener('click',     () => setMode('cork'));
  document.getElementById('btn-outline').addEventListener('click',  () => setMode('outline'));
  document.getElementById('btn-timeline').addEventListener('click', () => setMode('timeline'));
  document.getElementById('btn-board').addEventListener('click', () => setMode('board'));

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
    if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
      e.preventDefault();
      openSearch();
    }
    if (e.key === 'F11') {
      e.preventDefault();
      toggleFocus();
    }
    if (e.key === 'Escape') {
      if (document.body.classList.contains('focus-mode')) toggleFocus();
      closeSearch();
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
        <div style="font-family:'EB Garamond',serif;font-size:26px;font-weight:600;color:#2A2520;letter-spacing:0.03em;margin-bottom:16px;line-height:1.2;">${chapter}</div>
        <div style="width:50px;height:1px;background:#C4B89A;margin:0 auto 16px;"></div>
        <div style="font-family:'DM Mono',monospace;font-size:9px;color:#9A9080;letter-spacing:0.18em;text-transform:uppercase;">Turn the page to begin</div>
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