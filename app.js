/* ── State ── */
let docs = [
  {
    id: 1,
    title: 'Chapter One',
    storyDate: '1943-03-12',
    content: '<p>The morning arrived with the kind of stillness that precedes important things. She stood at the window, watching the fog settle into the valley below, feeling that particular mixture of anticipation and dread that she had come to recognize as the sensation of beginnings.</p><p>Three years had passed since she left. Three years of smaller rooms, borrowed daylight, and the slow accumulation of a different kind of life. She had not expected to return.</p>',
    synopsis: 'Opening scene. Establish setting and protagonist.',
    status: 'revision',
    target: 800,
    tags: ['POV: Sarah', 'Setting: Mountain house'],
    parent: null,
    isFolder: false,
    section: 'manuscript',
    createdAt: new Date('2024-01-15')
  },
  {
    id: 2,
    title: 'Chapter Two',
    storyDate: '1943-03-15',
    content: '<p>The letters arrived in a shoebox — forty-seven of them, each sealed with the kind of careful precision that speaks of restraint. She had discovered them that afternoon in the back of the wardrobe, behind a coat that still held the faint ghost of cedar and old wool.</p>',
    synopsis: 'Discovery of the letters. Inciting incident.',
    status: 'draft',
    target: 1000,
    tags: ['Letters', 'Mystery'],
    parent: null,
    isFolder: false,
    section: 'manuscript',
    createdAt: new Date('2024-01-18')
  },
  {
    id: 3,
    title: 'Chapter Three',
    storyDate: '',
    content: '',
    synopsis: '',
    status: 'draft',
    target: 0,
    tags: [],
    parent: null,
    isFolder: false,
    section: 'manuscript',
    createdAt: new Date('2024-01-20')
  },
  {
    id: 4,
    title: 'Research Notes',
    content: '<p>Mountain geography of the region: elevation approximately 2,400 feet. Fog patterns common October through March. Local infrastructure — single road in/out, no rail connection until 1962.</p>',
    synopsis: 'Geographic and historical research.',
    status: 'final',
    target: 0,
    tags: ['Research'],
    parent: null,
    isFolder: false,
    section: 'research',
    createdAt: new Date('2024-01-10')
  },
  {
    id: 5,
    title: 'Sarah Ellwood',
    entityType: 'character',
    aliases: ['Sarah', 'Ellwood'],
    content: '<p>Sarah Ellwood, 34. Born in the house she returns to. Left after the funeral — her mother\'s — to take a teaching position in the city. Has not spoken to her father in three years.</p><p>Physical: dark hair, sharp angles, moves quickly. Habit of pressing her thumb to her lips when thinking.</p>',
    synopsis: 'Character notes for Sarah.',
    status: 'final',
    target: 0,
    tags: ['Character'],
    parent: null,
    isFolder: false,
    section: 'research',
    createdAt: new Date('2024-01-11')
  }
];

let nextId      = 6;
let activeId    = 1;
let ctxTargetId = null;
let currentMode = 'editor';
let saveTimer   = null;

const STATUS_COLORS = { draft: '#B0ADA5', revision: '#E6A820', final: '#4CAF50' };

/* ────────────────────────────────────────
   Init
──────────────────────────────────────── */
function init() {
  renderTree();
  loadDoc(activeId);
  updateTotals();
  setupEventListeners();
  document.getElementById('btn-editor').classList.add('active');
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
  saveCurrentDoc();
  activeId = id;
  const d = docs.find(x => x.id === id);
  if (!d) return;

  document.getElementById('doc-title-edit').value = d.title;
  document.getElementById('editor').innerHTML      = d.content || '';
  document.getElementById('synopsis-area').value   = d.synopsis || '';
  document.getElementById('status-select').value   = d.status || 'draft';
  document.getElementById('target-input').value    = d.target || '';
  document.getElementById('story-date').value      = d.storyDate || '';
  document.getElementById('sub-date').textContent  = d.createdAt
    ? d.createdAt.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
    : '—';

  renderTags(d);
  updateStats();
  renderTree();

  if (currentMode === 'cork')     buildCork();
  if (currentMode === 'outline')  buildOutline();
  if (currentMode === 'timeline') buildTimeline();
}

function saveCurrentDoc() {
  const d = docs.find(x => x.id === activeId);
  if (!d) return;
  d.title     = document.getElementById('doc-title-edit').value || 'Untitled';
  d.content   = document.getElementById('editor').innerHTML;
  d.synopsis  = document.getElementById('synopsis-area').value;
  d.status    = document.getElementById('status-select').value;
  d.target    = +document.getElementById('target-input').value || 0;
  d.storyDate = document.getElementById('story-date').value || '';
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
function setMode(mode) {
  currentMode = mode;
  saveCurrentDoc();

  ['editor', 'cork', 'outline', 'timeline'].forEach(m => {
    const btnId = m === 'editor'  ? 'btn-editor'
                : m === 'cork'    ? 'btn-cork'
                : m === 'outline' ? 'btn-outline'
                : 'btn-timeline';
    document.getElementById(btnId).classList.toggle('active', m === mode);
  });

  document.getElementById('editor-scroll').className  = mode === 'editor'   ? '' : 'hidden';
  document.getElementById('editor-toolbar').className = mode === 'editor'   ? '' : 'hidden';
  document.getElementById('corkboard').className      = mode === 'cork'     ? 'active' : '';
  document.getElementById('outline-view').className   = mode === 'outline'  ? 'active' : '';
  document.getElementById('timeline-view').className  = mode === 'timeline' ? 'active' : '';

  if (mode === 'cork')     buildCork();
  if (mode === 'outline')  buildOutline();
  if (mode === 'timeline') buildTimeline();
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
    if (d) d.synopsis = document.getElementById('synopsis-area').value;
  });

  document.getElementById('status-select').addEventListener('change', function() {
    const d = docs.find(x => x.id === activeId);
    if (d) { d.status = this.value; renderTree(); }
  });

  document.getElementById('target-input').addEventListener('input', updateStats);

  document.getElementById('story-date').addEventListener('change', function() {
    const d = docs.find(x => x.id === activeId);
    if (d) d.storyDate = this.value;
  });

  /* Tag input */
  document.getElementById('tag-input').addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      const val = e.target.value.trim().replace(/,/g, '');
      if (!val) return;
      const d = docs.find(x => x.id === activeId);
      if (d && !d.tags.includes(val)) { d.tags.push(val); renderTags(d); }
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
    const ti = document.getElementById('doc-title-edit');
    ti.focus();
    ti.select();
  });

  document.getElementById('ctx-duplicate').addEventListener('click', () => {
    hideCtx();
    const src = docs.find(d => d.id === ctxTargetId);
    if (!src) return;
    const copy = { ...src, id: nextId++, title: src.title + ' (copy)', createdAt: new Date() };
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
}

/* ── Start ── */
init();