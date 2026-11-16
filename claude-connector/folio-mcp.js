#!/usr/bin/env node
/* ────────────────────────────────────────────────────────────────────────────
   Folio connector for Claude (an MCP server)

   Lets the Claude desktop app read and write your Folio projects. It works on
   the .folio files in Folio's synced folder — the same files Folio already
   writes there — so it needs nothing from the internet and no API key.

   Safety:
   • Before Claude changes a document, the old text is saved as a snapshot on
     that document, so it shows up in Folio's History panel with a Restore button.
   • A copy of the whole project file is also kept in
     ~/Library/Application Support/Folio Claude Backups/ before every change.
   • Folio notices the changed file within a few seconds and merges it in. If you
     edited the same document at the same moment, your version wins and Claude's
     is kept as a snapshot instead.

   Usage:  node folio-mcp.js "/path/to/synced folder" ["/another/folder" …]
   No dependencies — it speaks MCP (JSON-RPC over stdin/stdout) directly.
──────────────────────────────────────────────────────────────────────────── */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const FOLDERS = (process.argv.slice(2).length ? process.argv.slice(2) : (process.env.FOLIO_FOLDERS || '').split(path.delimiter))
  .map(f => f.trim()).filter(Boolean);
const BACKUP_ROOT = path.join(os.homedir(), 'Library', 'Application Support', 'Folio Claude Backups');
const BACKUPS_KEPT = 30;
const MAX_READ_CHARS = 120000;

/* ── HTML ⇄ plain text ───────────────────────────────────────────────────── */

const SCENE_BREAK_HTML = '<div class="scene-break">· · ·</div>';
const VOID_TAGS = new Set(['br', 'hr', 'img', 'input', 'meta', 'link', 'wbr']);

function decodeEntities(s) {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&');
}

function escapeHTML(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/* Text of one block of HTML (no paragraph breaks inside except <br>). */
function inlineText(html) {
  return decodeEntities(html.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '')).replace(/[ \t]+\n/g, '\n');
}

/* Splits a document's HTML into its top-level blocks (paragraphs, headings,
   scene breaks …), each with its plain text. Loose text between blocks counts
   as its own block. */
function splitBlocks(html) {
  const blocks = [];
  const tagRe = /<\/?([a-zA-Z][a-zA-Z0-9]*)\b[^>]*?(\/?)>/g;
  let depth = 0, start = 0, m;
  const pushLoose = (from, to) => {
    const chunk = html.slice(from, to);
    if (chunk.trim()) blocks.push({ html: chunk, tag: null });
  };
  while ((m = tagRe.exec(html))) {
    const tag = m[1].toLowerCase();
    const closing = m[0][1] === '/';
    const selfClosing = m[2] === '/' || VOID_TAGS.has(tag);
    if (depth === 0 && !closing) {
      if (m.index > start) pushLoose(start, m.index);
      if (selfClosing) {
        blocks.push({ html: m[0], tag });
        start = tagRe.lastIndex;
        continue;
      }
      start = m.index;
      depth = 1;
      continue;
    }
    if (selfClosing) continue;
    depth += closing ? -1 : 1;
    if (depth === 0) {
      const chunk = html.slice(start, tagRe.lastIndex);
      blocks.push({ html: chunk, tag: (chunk.match(/^<([a-zA-Z0-9]+)/) || [])[1]?.toLowerCase() || null });
      start = tagRe.lastIndex;
    }
    if (depth < 0) depth = 0;
  }
  if (start < html.length) pushLoose(start, html.length);
  return blocks.map(b => ({ ...b, text: blockText(b) }));
}

function blockText(block) {
  if (/class="[^"]*scene-break/.test(block.html)) return '* * *';
  if (block.tag === 'hr') return '* * *';
  const inner = block.tag ? block.html.replace(/^<[^>]+>/, '').replace(/<\/[^>]+>$/, '') : block.html;
  const text = inlineText(inner).trim();
  return /^h[1-6]$/.test(block.tag || '') && text ? `# ${text}` : text;
}

function htmlToText(html) {
  return splitBlocks(html || '').map(b => b.text).filter(t => t !== '').join('\n\n');
}

/* Plain text → Folio HTML. Every non-empty line becomes a paragraph (the way
   fiction is usually written), "* * *" / "***" / "#" alone is a scene break,
   **bold** and *italic* are kept. */
function inlineMarkup(s) {
  return escapeHTML(s)
    .replace(/\*\*([^*\n]+?)\*\*/g, '<b>$1</b>')
    .replace(/(^|[^*])\*([^*\n]+?)\*(?!\*)/g, '$1<i>$2</i>');
}

function textToHtml(text) {
  return String(text || '').replace(/\r\n?/g, '\n').split('\n')
    .map(line => line.trim())
    .filter(line => line !== '')
    .map(line => (/^(\*\s*\*\s*\*|#|~~~|---)$/.test(line) ? SCENE_BREAK_HTML : `<p>${inlineMarkup(line)}</p>`))
    .join('');
}

function countWords(html) {
  const text = htmlToText(html);
  const words = text.replace(/\* \* \*/g, ' ').match(/\S+/g);
  return words ? words.length : 0;
}

/* ── Project files ───────────────────────────────────────────────────────── */

function listProjectFiles() {
  const files = [];
  for (const folder of FOLDERS) {
    let names = [];
    try { names = fs.readdirSync(folder); } catch (e) { continue; }
    for (const name of names) {
      if (!name.endsWith('.folio') || name.startsWith('.')) continue;
      const file = path.join(folder, name);
      try {
        const data = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (data && data.folioFile && data.project && Array.isArray(data.project.docs)) files.push({ file, data });
      } catch (e) { /* not a readable Folio file — skip it */ }
    }
  }
  return files;
}

function findProject(ref) {
  const all = listProjectFiles();
  if (!all.length) throw new Error(`No Folio projects found in: ${FOLDERS.join(', ') || '(no folder configured)'}. In Folio, open Projects and connect a synced folder.`);
  if (ref == null || ref === '') {
    if (all.length === 1) return all[0];
    throw new Error(`Which project? Available: ${all.map(p => `"${p.data.project.title}"`).join(', ')}`);
  }
  const q = String(ref).trim().toLowerCase();
  const exact = all.filter(p => p.data.project.id.toLowerCase() === q || (p.data.project.title || '').toLowerCase() === q);
  if (exact.length === 1) return exact[0];
  const partial = all.filter(p => (p.data.project.title || '').toLowerCase().includes(q) || path.basename(p.file).toLowerCase().includes(q));
  if (partial.length === 1) return partial[0];
  if (partial.length > 1) throw new Error(`"${ref}" matches several projects: ${partial.map(p => `"${p.data.project.title}"`).join(', ')}`);
  throw new Error(`No project called "${ref}". Available: ${all.map(p => `"${p.data.project.title}"`).join(', ')}`);
}

function findDoc(project, ref) {
  const docs = project.docs;
  if (ref == null || ref === '') throw new Error('Say which document (its title or id).');
  if (typeof ref === 'number' || /^\d+$/.test(String(ref).trim())) {
    const byId = docs.find(d => d.id === Number(ref));
    if (byId) return byId;
  }
  const q = String(ref).trim().toLowerCase();
  const exact = docs.filter(d => (d.title || '').trim().toLowerCase() === q);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) throw new Error(`Several documents are titled "${ref}" (ids ${exact.map(d => d.id).join(', ')}). Use the id.`);
  const partial = docs.filter(d => (d.title || '').toLowerCase().includes(q));
  if (partial.length === 1) return partial[0];
  if (partial.length > 1) throw new Error(`"${ref}" matches several documents: ${partial.map(d => `"${d.title}" (id ${d.id})`).join(', ')}. Use the id.`);
  throw new Error(`No document called "${ref}" in "${project.title}". Use get_outline to see the documents.`);
}

/* Documents in the order Folio's binder shows them: per section, parents
   before their children, siblings in file order. */
function orderedDocs(project, section) {
  const sectionDocs = project.docs.filter(d => !section || d.section === section);
  const result = [];
  const seen = new Set();
  const walk = (parent, depth) => sectionDocs.filter(d => (d.parent || null) === parent).forEach(doc => {
    if (seen.has(doc.id)) return;
    seen.add(doc.id);
    result.push({ doc, depth });
    walk(doc.id, depth + 1);
  });
  walk(null, 0);
  sectionDocs.filter(d => !seen.has(d.id)).forEach(doc => result.push({ doc, depth: 0 }));
  return result;
}

function backup(file, data) {
  try {
    const dir = path.join(BACKUP_ROOT, path.basename(file, '.folio'));
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    fs.writeFileSync(path.join(dir, `${stamp}.folio`), JSON.stringify(data));
    const old = fs.readdirSync(dir).filter(n => n.endsWith('.folio')).sort();
    old.slice(0, Math.max(0, old.length - BACKUPS_KEPT)).forEach(n => { try { fs.unlinkSync(path.join(dir, n)); } catch (e) { /* ignore */ } });
  } catch (e) {
    process.stderr.write(`folio-mcp: backup failed: ${e.message}\n`);
  }
}

/* Same fingerprint function as Folio's folioValueHash() in app.js — keep them identical. */
function valueHash(value) {
  const s = typeof value === 'string' ? value : JSON.stringify(value === undefined ? null : value);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return `${(h >>> 0).toString(16)}:${s.length}`;
}

/* Records what Claude changed, so Folio can apply exactly those changes on top of
   whatever you have open — rather than replacing the whole project with this file.
   For each changed field it stores a fingerprint of the value Claude started from:
   if your copy still matches it, Folio takes Claude's value; if not, you were
   editing it too, and Folio keeps yours and saves Claude's as a History snapshot. */
function recordChanges(beforeProject, afterProject, previous) {
  const changes = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    at: new Date().toISOString(),
    docs: previous && previous.docs ? JSON.parse(JSON.stringify(previous.docs)) : {},
    created: previous && Array.isArray(previous.created) ? [...previous.created] : []
  };
  const beforeById = new Map(beforeProject.docs.map(d => [d.id, d]));
  for (const doc of afterProject.docs) {
    const old = beforeById.get(doc.id);
    if (!old) { if (!changes.created.includes(doc.id)) changes.created.push(doc.id); continue; }
    if (changes.created.includes(doc.id)) continue; // Folio adds the whole new document anyway
    for (const key of new Set([...Object.keys(old), ...Object.keys(doc)])) {
      if (JSON.stringify(old[key]) === JSON.stringify(doc[key])) continue;
      changes.docs[doc.id] = changes.docs[doc.id] || {};
      // Keep the earliest fingerprint: an unapplied earlier change already started from Folio's value.
      if (!(key in changes.docs[doc.id])) changes.docs[doc.id][key] = valueHash(old[key]);
    }
  }
  return changes;
}

/* Read → change → write, re-reading if Folio wrote the file in between. */
function modifyProject(projectRef, change) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const { file } = findProject(projectRef);
    const before = fs.statSync(file).mtimeMs;
    const original = fs.readFileSync(file, 'utf8');
    const data = JSON.parse(original);
    const untouched = JSON.parse(original).project;
    const result = change(data.project, data);
    if (fs.statSync(file).mtimeMs !== before) continue; // Folio just saved — redo on the fresh copy
    backup(file, JSON.parse(original));
    const now = new Date().toISOString();
    data.claudeChanges = recordChanges(untouched, data.project, data.claudeChanges);
    data.project.updatedAt = now;
    data.exportedAt = now;
    data.lastEditedBy = 'claude';
    const tmp = path.join(path.dirname(file), `.${path.basename(file)}.claude-tmp`);
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, file);
    return result;
  }
  throw new Error('Folio kept saving this project while Claude was trying to. Try again in a moment.');
}

function snapshotBeforeEdit(doc, label) {
  doc.snapshots = Array.isArray(doc.snapshots) ? doc.snapshots : [];
  doc.snapshots.unshift({
    id: Date.now(),
    title: doc.title,
    content: doc.content || '',
    words: countWords(doc.content || ''),
    createdAt: new Date().toISOString(),
    label
  });
}

function editableDoc(project, ref) {
  const doc = findDoc(project, ref);
  if (doc.isFolder) throw new Error(`"${doc.title}" is a folder, not a document.`);
  if (doc.entityType === 'character') throw new Error(`"${doc.title}" is a character card; Claude can only add notes to it.`);
  return doc;
}

/* ── Tools ───────────────────────────────────────────────────────────────── */

const projectArg = { type: 'string', description: 'Project title (or part of it). Can be left out when there is only one project.' };
const docArg = { type: 'string', description: 'Document title (or part of it), or its numeric id from get_outline.' };
const textArg = desc => ({ type: 'string', description: `${desc} Plain text: each line becomes a paragraph, a line with just "* * *" is a scene break, **bold** and *italic* are kept.` });

const TOOLS = [
  {
    name: 'list_projects',
    description: 'List the Folio writing projects Claude can see, with word counts and when each was last saved.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
    run() {
      const projects = listProjectFiles();
      if (!projects.length) return `No Folio projects found in ${FOLDERS.join(', ')}. In Folio, open Projects and connect a synced folder.`;
      return projects.map(({ file, data }) => {
        const p = data.project;
        const manuscript = p.docs.filter(d => d.section === 'manuscript' && !d.isFolder);
        const words = manuscript.reduce((n, d) => n + countWords(d.content || ''), 0);
        return `• ${p.title} — ${manuscript.length} manuscript document(s), ${words.toLocaleString()} words, last saved ${new Date(p.updatedAt).toLocaleString()} (${path.basename(file)})`;
      }).join('\n');
    }
  },
  {
    name: 'get_outline',
    description: 'Show a project\'s binder: every chapter/scene in order with its id, word count, status and synopsis, plus research and character documents.',
    inputSchema: { type: 'object', properties: { project: projectArg } },
    annotations: { readOnlyHint: true },
    run({ project }) {
      const { data } = findProject(project);
      const p = data.project;
      const lines = [`# ${p.title}`];
      for (const section of ['manuscript', 'research']) {
        const items = orderedDocs(p, section);
        lines.push('', `## ${section === 'manuscript' ? 'Manuscript' : 'Research'}`);
        if (!items.length) lines.push('(empty)');
        for (const { doc, depth } of items) {
          const kind = doc.isFolder ? 'folder' : doc.entityType ? doc.entityType : `${countWords(doc.content || '')} words, ${doc.status || 'draft'}`;
          lines.push(`${'  '.repeat(depth)}- [id ${doc.id}] ${doc.title || 'Untitled'} (${kind})${doc.synopsis ? ` — ${doc.synopsis.replace(/\s+/g, ' ').slice(0, 200)}` : ''}`);
        }
      }
      return lines.join('\n');
    }
  },
  {
    name: 'read_document',
    description: 'Read one chapter, scene or research document. Returns its text, synopsis and notes.',
    inputSchema: {
      type: 'object',
      properties: { project: projectArg, document: docArg, format: { type: 'string', enum: ['text', 'html'], description: 'text (default) or the raw HTML Folio stores.' } },
      required: ['document']
    },
    annotations: { readOnlyHint: true },
    run({ project, document, format }) {
      const { data } = findProject(project);
      const doc = findDoc(data.project, document);
      const out = [`# ${doc.title} (id ${doc.id}, ${doc.section}, ${doc.status || 'draft'}, ${countWords(doc.content || '')} words)`];
      if (doc.synopsis) out.push(`Synopsis: ${doc.synopsis}`);
      if (doc.entityType === 'character') {
        if (doc.aliases) out.push(`Aliases: ${doc.aliases}`);
        if (doc.charFields && typeof doc.charFields === 'object') {
          for (const [k, v] of Object.entries(doc.charFields)) if (v) out.push(`${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`);
        }
      }
      out.push('', format === 'html' ? (doc.content || '') : (htmlToText(doc.content || '') || '(no text yet)'));
      if (doc.documentNote) out.push('', '--- Document notes ---', doc.documentNote);
      const annotations = (doc.notes || []).filter(n => n && n.text);
      if (annotations.length) out.push('', '--- Margin notes ---', ...annotations.map(n => `• ${n.text}`));
      return out.join('\n');
    }
  },
  {
    name: 'read_manuscript',
    description: 'Read the whole manuscript (all chapters in order) as plain text, for big-picture feedback. Long books are returned in parts — use start_at to continue.',
    inputSchema: {
      type: 'object',
      properties: { project: projectArg, start_at: { type: 'number', description: 'Character offset to continue from (given at the end of the previous part).' } }
    },
    annotations: { readOnlyHint: true },
    run({ project, start_at }) {
      const { data } = findProject(project);
      const parts = orderedDocs(data.project, 'manuscript')
        .filter(({ doc }) => !doc.isFolder || doc.content)
        .map(({ doc }) => `=== ${doc.title} (id ${doc.id}) ===\n\n${htmlToText(doc.content || '') || '(empty)'}`);
      const full = parts.join('\n\n');
      const from = Math.max(0, Number(start_at) || 0);
      const chunk = full.slice(from, from + MAX_READ_CHARS);
      const end = from + chunk.length;
      return end < full.length
        ? `${chunk}\n\n[… continued — call read_manuscript again with start_at: ${end}. ${Math.round((end / full.length) * 100)}% read.]`
        : chunk || '(the manuscript is empty)';
    }
  },
  {
    name: 'search_project',
    description: 'Find every place a word or phrase appears in a project (case-insensitive), with the surrounding text.',
    inputSchema: { type: 'object', properties: { project: projectArg, query: { type: 'string' } }, required: ['query'] },
    annotations: { readOnlyHint: true },
    run({ project, query }) {
      const { data } = findProject(project);
      const q = String(query).toLowerCase();
      if (!q) throw new Error('Give something to search for.');
      const hits = [];
      for (const { doc } of [...orderedDocs(data.project, 'manuscript'), ...orderedDocs(data.project, 'research')]) {
        const text = [htmlToText(doc.content || ''), doc.synopsis || '', doc.documentNote || ''].join('\n\n');
        const lower = text.toLowerCase();
        let i = lower.indexOf(q);
        while (i !== -1 && hits.length < 60) {
          hits.push(`• ${doc.title} (id ${doc.id}): …${text.slice(Math.max(0, i - 80), i + q.length + 80).replace(/\s+/g, ' ')}…`);
          i = lower.indexOf(q, i + q.length);
        }
      }
      return hits.length ? `${hits.length}${hits.length >= 60 ? '+' : ''} match(es):\n${hits.join('\n')}` : `No matches for "${query}".`;
    }
  },
  {
    name: 'create_document',
    description: 'Add a new chapter, scene, or research document (or a folder) to a project.',
    inputSchema: {
      type: 'object',
      properties: {
        project: projectArg,
        title: { type: 'string' },
        text: textArg('The document\'s text (can be empty).'),
        section: { type: 'string', enum: ['manuscript', 'research'], description: 'Where it goes. Default: manuscript.' },
        after: { type: 'string', description: 'Put it right after this document (title or id). Default: at the end.' },
        parent: { type: 'string', description: 'Put it inside this folder/document (title or id).' },
        synopsis: { type: 'string' },
        is_folder: { type: 'boolean' }
      },
      required: ['title']
    },
    run({ project, title, text, section, after, parent, synopsis, is_folder }) {
      return modifyProject(project, p => {
        const afterDoc = after ? findDoc(p, after) : null;
        const parentDoc = parent ? findDoc(p, parent) : null;
        const sec = section || (parentDoc && parentDoc.section) || (afterDoc && afterDoc.section) || 'manuscript';
        const ids = p.docs.map(d => d.id);
        const id = Math.max(typeof p.nextId === 'number' ? p.nextId : 1, ids.length ? Math.max(...ids) + 1 : 1);
        p.nextId = id + 1;
        const doc = {
          id,
          title: String(title).trim() || 'Untitled',
          content: textToHtml(text),
          synopsis: synopsis || '',
          status: 'draft',
          target: 0,
          storyDate: '',
          banner: '',
          tags: [],
          parent: parentDoc ? parentDoc.id : afterDoc ? (afterDoc.parent || null) : null,
          isFolder: Boolean(is_folder),
          section: sec,
          createdAt: new Date().toISOString(),
          documentNote: '',
          notes: []
        };
        if (afterDoc) {
          // After that document and everything nested under it.
          const nested = new Set([afterDoc.id]);
          let grew = true;
          while (grew) { grew = false; for (const d of p.docs) if (d.parent != null && nested.has(d.parent) && !nested.has(d.id)) { nested.add(d.id); grew = true; } }
          let index = 0;
          p.docs.forEach((d, i) => { if (nested.has(d.id)) index = i; });
          p.docs.splice(index + 1, 0, doc);
        } else {
          p.docs.push(doc);
        }
        return `Created "${doc.title}" (id ${doc.id}) in ${sec}, ${countWords(doc.content)} words. It will appear in Folio within a few seconds.`;
      });
    }
  },
  {
    name: 'append_to_document',
    description: 'Add text to the end of an existing document.',
    inputSchema: { type: 'object', properties: { project: projectArg, document: docArg, text: textArg('Text to add.') }, required: ['document', 'text'] },
    run({ project, document, text }) {
      return modifyProject(project, p => {
        const doc = editableDoc(p, document);
        const added = textToHtml(text);
        if (!added) throw new Error('There is no text to add.');
        snapshotBeforeEdit(doc, 'Before Claude added text');
        doc.content = (doc.content || '') + added;
        return `Added ${countWords(added)} words to the end of "${doc.title}". The previous version is in Folio's History panel.`;
      });
    }
  },
  {
    name: 'replace_text',
    description: 'Replace a passage in a document. "find" must match the document text exactly (copy it from read_document); it can span several paragraphs. Use this for line edits and rewrites of part of a chapter.',
    inputSchema: {
      type: 'object',
      properties: {
        project: projectArg,
        document: docArg,
        find: { type: 'string', description: 'The exact existing text to replace. Include enough words to make it unique.' },
        replace: { type: 'string', description: 'The new text. Separate paragraphs with a newline. Use an empty string to delete the passage.' },
        replace_all: { type: 'boolean', description: 'Replace every occurrence (each must sit inside one paragraph). Default: false — the text must appear exactly once.' }
      },
      required: ['document', 'find', 'replace']
    },
    run({ project, document, find, replace, replace_all }) {
      return modifyProject(project, p => {
        const doc = editableDoc(p, document);
        const html = doc.content || '';
        const { content, count, simplified } = replaceInHtml(html, String(find), String(replace ?? ''), Boolean(replace_all));
        snapshotBeforeEdit(doc, 'Before Claude edit');
        doc.content = content;
        return `Replaced ${count} passage(s) in "${doc.title}".${simplified ? ' Bold/italic inside the edited paragraph(s) was simplified.' : ''} The previous version is in Folio's History panel.`;
      });
    }
  },
  {
    name: 'rewrite_document',
    description: 'Replace the entire text of a document with new text. Prefer replace_text for partial edits — this rewrites everything.',
    inputSchema: { type: 'object', properties: { project: projectArg, document: docArg, text: textArg('The complete new text.') }, required: ['document', 'text'] },
    run({ project, document, text }) {
      return modifyProject(project, p => {
        const doc = editableDoc(p, document);
        snapshotBeforeEdit(doc, 'Before Claude rewrite');
        doc.content = textToHtml(text);
        return `Rewrote "${doc.title}" (${countWords(doc.content)} words). The previous version is in Folio's History panel.`;
      });
    }
  },
  {
    name: 'update_document_details',
    description: 'Change a document\'s title, synopsis, or status (draft / revision / final).',
    inputSchema: {
      type: 'object',
      properties: { project: projectArg, document: docArg, title: { type: 'string' }, synopsis: { type: 'string' }, status: { type: 'string', enum: ['draft', 'revision', 'final'] } },
      required: ['document']
    },
    run({ project, document, title, synopsis, status }) {
      return modifyProject(project, p => {
        const doc = findDoc(p, document);
        const changed = [];
        if (title != null && String(title).trim()) { doc.title = String(title).trim(); changed.push('title'); }
        if (synopsis != null) { doc.synopsis = String(synopsis); changed.push('synopsis'); }
        if (status) { doc.status = status; changed.push('status'); }
        if (!changed.length) throw new Error('Nothing to change — give a title, synopsis or status.');
        return `Updated ${changed.join(', ')} of "${doc.title}".`;
      });
    }
  },
  {
    name: 'add_note',
    description: 'Add a note to a document\'s Notes panel in Folio (feedback, ideas, to-dos) without touching its text.',
    inputSchema: { type: 'object', properties: { project: projectArg, document: docArg, note: { type: 'string' } }, required: ['document', 'note'] },
    run({ project, document, note }) {
      return modifyProject(project, p => {
        const doc = findDoc(p, document);
        if (typeof doc.documentNote !== 'string') {
          // Same migration Folio does when it opens a document's notes.
          const legacy = (doc.notes || []).filter(n => !n.anchor && n.kind !== 'annotation');
          doc.documentNote = legacy.map(n => n.text).join('\n\n');
          doc.notes = (doc.notes || []).filter(n => n.anchor || n.kind === 'annotation');
        }
        const stamp = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
        doc.documentNote = [doc.documentNote.trim(), `Claude (${stamp}): ${String(note).trim()}`].filter(Boolean).join('\n\n');
        return `Added a note to "${doc.title}".`;
      });
    }
  }
];

/* Replace `find` with `replacement` in a document's HTML. Tries to keep the
   paragraph's formatting by replacing inside the HTML; falls back to rebuilding
   the affected paragraph(s) from plain text. */
function replaceInHtml(html, find, replacement, replaceAll) {
  const findNorm = find.replace(/\r\n?/g, '\n').trim();
  if (!findNorm) throw new Error('"find" is empty.');
  const blocks = splitBlocks(html);

  if (replaceAll) {
    if (findNorm.includes('\n')) throw new Error('replace_all only works for text inside a single paragraph.');
    let count = 0, simplified = false;
    for (const b of blocks) {
      if (!b.text.includes(findNorm)) continue;
      const escFind = escapeHTML(findNorm);
      if (b.html.includes(escFind)) {
        const n = b.html.split(escFind).length - 1;
        b.html = b.html.split(escFind).join(inlineMarkup(replacement));
        count += n;
      } else {
        count += b.text.split(findNorm).length - 1;
        b.html = rebuildBlock(b, b.text.split(findNorm).join(replacement));
        simplified = true;
      }
    }
    if (!count) throw new Error(notFoundMessage(findNorm));
    return { content: blocks.map(b => b.html).join(''), count, simplified };
  }

  // Locate the passage in the text of all blocks joined by blank lines.
  const texts = blocks.map(b => b.text);
  let joined = '';
  const offsets = texts.map(t => { const start = joined.length; joined += t + '\n\n'; return start; });
  const findJoined = findNorm.replace(/\n\s*\n?/g, '\n\n');
  let at = joined.indexOf(findJoined);
  let len = findJoined.length;
  if (at === -1) { at = joined.indexOf(findNorm); len = findNorm.length; }
  if (at === -1) throw new Error(notFoundMessage(findNorm));
  if (joined.indexOf(joined.slice(at, at + len), at + 1) !== -1) throw new Error('That text appears more than once. Include more of the surrounding words so it is unique, or set replace_all.');

  const first = offsets.findIndex((o, i) => at >= o && at < o + texts[i].length + 2);
  let last = first;
  while (last + 1 < blocks.length && offsets[last + 1] < at + len) last++;

  // Single paragraph, and the text sits in the HTML as-is: swap it in place.
  if (first === last) {
    const b = blocks[first];
    const escFind = escapeHTML(findNorm);
    if (!findNorm.includes('\n') && b.html.split(escFind).length === 2) {
      b.html = b.html.replace(escFind, () => inlineMarkup(replacement).replace(/\n/g, ' '));
      if (!inlineText(b.html).trim()) b.html = ''; // the whole paragraph was deleted
      if (!replacement.includes('\n')) return { content: blocks.map(x => x.html).join(''), count: 1, simplified: false };
    }
  }

  const before = texts[first].slice(0, at - offsets[first]);
  const lastEnd = at + len - offsets[last];
  const after = texts[last].slice(Math.min(lastEnd, texts[last].length));
  const newText = `${before}${replacement}${after}`;
  const newHtml = newText.trim() ? textToHtml(newText) : '';
  const out = [...blocks.slice(0, first).map(b => b.html), newHtml, ...blocks.slice(last + 1).map(b => b.html)].join('');
  const simplified = blocks.slice(first, last + 1).some(b => /<(b|i|strong|em|u|span|mark|a)\b/i.test(b.html));
  return { content: out, count: 1, simplified };
}

function rebuildBlock(block, text) {
  const open = block.tag ? (block.html.match(/^<[^>]+>/) || ['<p>'])[0] : '<p>';
  const tag = block.tag || 'p';
  return `${open}${inlineMarkup(text.replace(/^# /, ''))}</${tag}>`;
}

function notFoundMessage(find) {
  return `Couldn't find that text: "${find.slice(0, 80)}${find.length > 80 ? '…' : ''}". Read the document again and copy the passage exactly (it may have changed).`;
}

/* ── MCP over stdio ──────────────────────────────────────────────────────── */

const SERVER_INFO = { name: 'folio', version: '1.0.0' };

function send(msg) { process.stdout.write(JSON.stringify(msg) + '\n'); }

function handle(msg) {
  const { id, method, params } = msg;
  const reply = result => { if (id !== undefined) send({ jsonrpc: '2.0', id, result }); };
  const fail = (code, message) => { if (id !== undefined) send({ jsonrpc: '2.0', id, error: { code, message } }); };

  switch (method) {
    case 'initialize':
      return reply({
        protocolVersion: (params && params.protocolVersion) || '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
        instructions: 'Tools for reading and editing the user\'s novels in their Folio writing app. Start with list_projects / get_outline. Read a document before editing it, and prefer replace_text for targeted edits. Every edit keeps the old version in Folio\'s History panel.'
      });
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({ tools: TOOLS.map(({ name, description, inputSchema, annotations }) => ({ name, description, inputSchema, ...(annotations ? { annotations } : {}) })) });
    case 'tools/call': {
      const tool = TOOLS.find(t => t.name === (params && params.name));
      if (!tool) return fail(-32602, `Unknown tool: ${params && params.name}`);
      try {
        const text = tool.run((params && params.arguments) || {});
        return reply({ content: [{ type: 'text', text: String(text) }] });
      } catch (e) {
        return reply({ content: [{ type: 'text', text: e.message || String(e) }], isError: true });
      }
    }
    default:
      if (method && method.startsWith('notifications/')) return; // nothing to do
      return fail(-32601, `Method not found: ${method}`);
  }
}

if (require.main === module) {
  let buffer = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch (e) { send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); continue; }
      try { handle(msg); } catch (e) { process.stderr.write(`folio-mcp: ${e.stack || e}\n`); }
    }
  });
  // When Claude closes the connection, just stop reading — calling process.exit()
  // here could cut off a long reply that's still being written out.
  process.stdin.on('end', () => process.stdin.pause());
  process.stderr.write(`folio-mcp: watching ${FOLDERS.join(', ') || '(no folders)'}\n`);
}

module.exports = { htmlToText, textToHtml, replaceInHtml, splitBlocks, countWords, TOOLS };
