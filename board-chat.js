/* ────────────────────────────────────────
   Ask Gemma: a chat beside the Story Board
   ────────────────────────────────────────
   You type what you want; Gemma (in Ollama, on this Mac) picks actions from
   board-assistant.js; this file carries them out on the board and shows what
   changed. Every reply that changed the board can be undone, or kept as a
   what-if arrangement with the original left as it was.

   Uses the Story Board helpers in app.js (docs, boardPos, setBoardPos …). */
(function () {
  const A = window.FolioBoardAssistant;
  const MODEL_KEY = 'folio-gemma-model';
  const MAX_ROUNDS = 8;      // action → answer round trips per message
  const KEEP_MESSAGES = 16;  // how much of the chat Gemma is shown each time

  let history = [];          // the chat as Gemma sees it (without the system message)
  let changes = [];          // one entry per reply that changed the board
  let busy = false;
  let modelsLoaded = false;
  let project = null;        // which book the chat is about

  const $ = id => document.getElementById(id);

  function savedModel() { try { return localStorage.getItem(MODEL_KEY); } catch (e) { return null; } }
  function saveModel(name) { try { localStorage.setItem(MODEL_KEY, name); } catch (e) { /* ignore */ } }

  /* ── The board as Gemma's actions see it ── */
  function boardAdapter(change) {
    boardParentIds = new Set(docs.filter(d => d.parent != null).map(d => d.parent));
    computeBoardMentions();
    const arr = change.arrangement;
    const named = new Map(docs.map(d => [d.id, d.title]));
    return {
      cards() {
        return boardEligible().map(d => {
          const kind = boardKind(d);
          const mentions = kind === 'scene'
            ? [...boardMentions].filter(([, ids]) => ids.has(d.id)).map(([id]) => named.get(id)).filter(Boolean)
            : [];
          const ch = kind === 'scene' ? boardChapterOf(d) : null;
          const pos = boardPos(d, arr);
          return { id: d.id, kind, title: d.title || '', chapter: ch ? ch.title : '', mentions, pos: pos ? { ...pos } : null };
        });
      },
      size(id) {
        const el = document.querySelector(`#board-world [data-id="${id}"]`);
        return el && el.offsetWidth ? { w: el.offsetWidth, h: el.offsetHeight } : null;
      },
      setPos(id, pos) {
        const d = docs.find(x => x.id === id);
        if (!d) return;
        if (!change.before.has(id)) {
          const was = boardPos(d, arr);
          change.before.set(id, was ? { ...was } : null);
        }
        setBoardPos(d, pos ? { ...pos } : null, arr);
        change.touched.add(id);
      },
      addCard(kind, title, pos) {
        const d = addBoardCard(kind, false);
        d.title = title;
        setBoardPos(d, { ...pos }, arr);
        change.created.push(d.id);
        change.touched.add(d.id);
        return d.id;
      },
    };
  }

  function refreshBoard(change) {
    if (boardTrial && change.touched.has(boardTrial.id)) boardTrial = null;
    if (currentMode === 'board') {
      renderBoardTray();
      if (boardLens() === 'freeform') renderBoardWorld();
    }
    schedulePersist();
  }

  function flashCards(ids) {
    ids.forEach(id => {
      const el = document.querySelector(`#board-world .bcard[data-id="${id}"], #board-world .bzone[data-id="${id}"]`);
      if (!el) return;
      el.classList.add('gemma-moved');
      setTimeout(() => el.classList.remove('gemma-moved'), 1600);
    });
  }

  /* ── Undo and what-if ── */
  function putBack(change, removeCreated) {
    change.before.forEach((pos, id) => {
      const d = docs.find(x => x.id === id);
      if (d) setBoardPos(d, pos ? { ...pos } : null, change.arrangement);
    });
    change.created.forEach(id => {
      const d = docs.find(x => x.id === id);
      if (!d) return;
      if (removeCreated) docs.splice(docs.indexOf(d), 1);
      else setBoardPos(d, null, change.arrangement);
    });
  }

  function undoChange(change) {
    if (change.state !== 'live') return;
    putBack(change, true);
    change.state = 'undone';
    refreshBoard(change);
    markChange(change, 'Undone. The board is back how it was.');
  }

  function keepAsWhatIf(change) {
    if (change.state !== 'live') return;
    const from = change.arrangement;
    const n = boardArrangements().length + 1;
    const arr = {
      id: nextId++, title: `What-if ${n}: Gemma`,
      section: 'board', boardKind: 'arrangement', content: '', synopsis: '', status: 'draft',
      target: 0, storyDate: '', banner: '', tags: [], parent: null, isFolder: false, createdAt: new Date(),
    };
    docs.push(arr);
    docs.forEach(d => {
      const p = boardPos(d, from);
      if (p) setBoardPos(d, { ...p }, String(arr.id));
    });
    putBack(change, false);
    change.state = 'whatif';
    schedulePersist();
    if (currentMode === 'board') setBoardArrangement(arr.id);
    markChange(change, `Saved as “${arr.title}”. Your ${from === 'main' ? 'main' : 'previous'} arrangement is as it was; switch between them with Arrangement at the top.`);
  }

  function markChange(change, text) {
    const box = change.el && change.el.querySelector('.bchat-undo');
    if (box) box.innerHTML = `<span class="bchat-undone">${escapeHTML(text)}</span>`;
  }

  /* ── Talking to Gemma ── */
  async function loadModels() {
    const select = $('bchat-model');
    const r = await window.folioGemma.models();
    if (r.error) {
      select.innerHTML = '<option value="">Not connected</option>';
      modelsLoaded = false;
      return r;
    }
    const usable = r.models.filter(m => m.tools);
    if (!usable.length) {
      select.innerHTML = '<option value="">No model</option>';
      return { error: 'Ollama is running but has no model that can use actions. Install Gemma with “ollama pull gemma4” in Terminal.' };
    }
    const saved = savedModel();
    const pick = usable.find(m => m.name === saved) || usable.find(m => /gemma/i.test(m.name)) || usable[0];
    select.innerHTML = usable.map(m => `<option value="${escapeHTML(m.name)}">${escapeHTML(m.name)}</option>`).join('');
    select.value = pick.name;
    modelsLoaded = true;
    return {};
  }

  function trimmedHistory() {
    if (history.length <= KEEP_MESSAGES) return history;
    // Start at a message you wrote, so actions and their results stay together.
    let start = history.length - KEEP_MESSAGES;
    while (start < history.length && history[start].role !== 'user') start++;
    return history.slice(start);
  }

  function parseArgs(raw) {
    if (raw && typeof raw === 'object') return raw;
    try { return JSON.parse(raw || '{}'); } catch (e) { return {}; }
  }

  async function send(text) {
    if (busy || !text.trim()) return;
    if (!modelsLoaded) {
      const r = await loadModels();
      if (r.error) { addMessage('error', r.error); return; }
    }
    const model = $('bchat-model').value;
    if (boardLens() !== 'freeform') { boardStore(BOARD_LENS_KEY, 'freeform'); buildBoard(); }

    if (project !== currentProjectId) { newChat(); project = currentProjectId; }
    addMessage('you', text);
    const startedAt = history.length;
    history.push({ role: 'user', content: text });
    setBusy(true);
    const change = { arrangement: boardArrangementId(), before: new Map(), created: [], touched: new Set(), done: [], failed: [], state: 'live' };
    const thinking = addMessage('note', 'Gemma is thinking…');
    thinking.classList.add('bchat-thinking');

    let reply = '';
    let failure = '';
    try {
      for (let round = 0; round < MAX_ROUNDS; round++) {
        const board = boardAdapter(change);
        const r = await window.folioGemma.chat({
          model,
          messages: [{ role: 'system', content: A.systemPrompt(board) }, ...trimmedHistory()],
          tools: A.ollamaTools(),
        });
        if (r.error) { failure = r.error; if (r.offline) modelsLoaded = false; break; }
        const msg = r.message || {};
        const calls = msg.tool_calls || [];
        history.push({ role: 'assistant', content: msg.content || '', ...(calls.length ? { tool_calls: calls } : {}) });
        if (!calls.length) { reply = (msg.content || '').trim(); break; }
        calls.forEach(call => {
          const name = call.function && call.function.name;
          const out = A.runAction(board, name, parseArgs(call.function && call.function.arguments));
          if (out.done) change.done.push({ text: out.done });
          else if (/^Not done: /.test(out.result)) {
            const why = out.result.replace(/^Not done: /, '');
            change.failed.push(why);
            change.done.push({ text: `Didn’t work: ${why}`, failed: true });
          }
          history.push({ role: 'tool', tool_name: name, content: out.result });
        });
        if (change.touched.size) refreshBoard(change);
        const made = change.done.filter(item => !item.failed).length;
        thinking.textContent = made ? `Working… ${made} change${made === 1 ? '' : 's'} so far` : 'Gemma is thinking…';
        if (round === MAX_ROUNDS - 1) reply = 'I stopped there so as not to go round in circles. Tell me what to do next.';
      }
    } catch (e) {
      failure = 'Something went wrong talking to Gemma.';
    }
    thinking.remove();
    setBusy(false);

    if (failure) {
      addMessage('error', failure);
      // Forget the unanswered exchange so a retry starts clean.
      if (!change.touched.size) history.length = startedAt;
    }
    if (change.touched.size || (!failure && (reply || !change.done.length))) {
      const fallback = change.failed.length
        ? `Some of that didn’t work: ${change.failed[change.failed.length - 1]}`
        : change.touched.size ? 'Done.' : 'I didn’t change anything.';
      showReply(reply || fallback, change);
    }
    if (change.touched.size) {
      changes.push(change);
      flashCards(change.touched);
    }
  }

  /* ── The panel ── */
  function addMessage(who, text) {
    const el = document.createElement('div');
    el.className = `bchat-msg ${who}`;
    el.textContent = text;
    $('bchat-log').appendChild(el);
    el.scrollIntoView({ block: 'end' });
    return el;
  }

  function showReply(text, change) {
    const el = addMessage('gemma', text);
    if (change.done.length) {
      const list = document.createElement('ul');
      list.className = 'bchat-done';
      change.done.forEach(item => {
        const li = document.createElement('li');
        li.textContent = item.text;
        if (item.failed) li.className = 'failed';
        list.appendChild(li);
      });
      el.appendChild(list);
    }
    if (change.touched.size) {
      const box = document.createElement('div');
      box.className = 'bchat-undo';
      box.innerHTML = `<button type="button" data-act="undo">Undo</button>
        <button type="button" data-act="whatif" title="Save this layout as a what-if arrangement and put the current one back as it was">Keep as a what-if</button>`;
      box.addEventListener('click', e => {
        const b = e.target.closest('button[data-act]');
        if (!b) return;
        if (b.dataset.act === 'undo') undoChange(change); else keepAsWhatIf(change);
      });
      el.appendChild(box);
      change.el = el;
    }
    el.scrollIntoView({ block: 'end' });
  }

  function setBusy(on) {
    busy = on;
    $('bchat-send').disabled = on;
    $('bchat-model').disabled = on;
  }

  async function openChat(open) {
    const panel = $('board-chat');
    panel.hidden = !open;
    $('board-body').classList.toggle('chat-open', open);
    $('board-btn-gemma').classList.toggle('active', open);
    $('board-btn-gemma').setAttribute('aria-pressed', String(open));
    if (typeof applyBoardTransform === 'function' && currentMode === 'board') applyBoardTransform();
    if (!open) return;
    $('bchat-input').focus();
    if (!modelsLoaded) {
      const r = await loadModels();
      if (r.error) addMessage('error', r.offline
        ? 'Folio can’t reach Ollama. Open the Ollama app (or run “ollama serve” in Terminal), then try again.'
        : r.error);
    }
  }

  function newChat() {
    if (busy) return;
    history = [];
    changes = [];
    $('bchat-log').querySelectorAll('.bchat-msg').forEach(el => el.remove());
  }

  function init() {
    if (!A || !window.folioGemma || !$('board-chat')) return;
    $('board-btn-gemma').addEventListener('click', () => openChat($('board-chat').hidden));
    $('bchat-close').addEventListener('click', () => openChat(false));
    $('bchat-clear').addEventListener('click', newChat);
    $('bchat-model').addEventListener('change', e => saveModel(e.target.value));
    $('bchat-form').addEventListener('submit', e => {
      e.preventDefault();
      const input = $('bchat-input');
      const text = input.value;
      if (busy || !text.trim()) return;
      input.value = '';
      send(text);
    });
    $('bchat-input').addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        $('bchat-form').requestSubmit();
      }
      if (e.key === 'Escape') e.stopPropagation();
    });
    // A different book has different cards: start a fresh chat.
    project = currentProjectId;
    $('board-btn-gemma').addEventListener('click', () => {
      if (project !== currentProjectId) { newChat(); project = currentProjectId; }
    }, true);
  }

  init();
})();
