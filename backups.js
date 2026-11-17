// Automatic dated backups of every book (runs in the main process).
//
// Folio's own storage and the synced folder each hold only the latest version of
// a book. This keeps a trail of older ones in a plain folder on this Mac, apart
// from Dropbox, so a bad save, a sync mix-up or a damaged store can always be
// undone: open the Backups folder and Import the .folio file you want back.
//
// Layout: <backups>/<Book title> (<id tail>)/<YYYY-MM-DD HH-MM-SS>.folio
// Each file is a normal .folio project file. A new one is only written when the
// book has actually changed since the last backup.
//
// Kept: everything from the last day, then the last backup of each day for 90
// days, then the last backup of each month for good.
const fs = require('fs');
const path = require('path');

const DAY = 24 * 60 * 60 * 1000;
const STAMP = /^(\d{4})-(\d{2})-(\d{2}) (\d{2})-(\d{2})-(\d{2})\.folio$/;

const pad = n => String(n).padStart(2, '0');
function stampFor(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
    + `${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}.folio`;
}
function timeOf(name) {
  const m = STAMP.exec(name);
  return m ? new Date(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime() : null;
}

function idTail(id) {
  return String(id).replace(/[^a-z0-9]/gi, '').slice(-6) || 'book';
}
function folderTitle(title) {
  // Finder-safe: no slashes or colons, no leading dot, not too long.
  return String(title || 'Untitled').replace(/[\/\\:\u0000-\u001f]/g, '-').replace(/^\.+/, '').trim().slice(0, 80) || 'Untitled';
}

/* Which backups to keep, given their file names, newest wins within each slot. */
function backupsToKeep(names, now) {
  const dated = names.map(name => ({ name, time: timeOf(name) })).filter(f => f.time !== null)
    .sort((a, b) => b.time - a.time);
  const keep = new Set();
  const seenSlots = new Set();
  for (const f of dated) {
    const age = now - f.time;
    if (age < DAY) { keep.add(f.name); continue; }
    const d = new Date(f.time);
    const slot = age < 90 * DAY
      ? `day ${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`
      : `month ${d.getFullYear()}-${d.getMonth()}`;
    if (!seenSlots.has(slot)) { seenSlots.add(slot); keep.add(f.name); }
  }
  return keep;
}

/* The same book, ignoring when the file was made or last saved. */
function sameBook(a, b) {
  try {
    const x = JSON.parse(a); const y = JSON.parse(b);
    for (const f of [x, y]) { delete f.exportedAt; if (f.project) delete f.project.updatedAt; }
    return JSON.stringify(x) === JSON.stringify(y);
  } catch (e) {
    return false;
  }
}

function createBackups(root) {
  function folderFor(id, title) {
    fs.mkdirSync(root, { recursive: true });
    const wanted = `${folderTitle(title)} (${idTail(id)})`;
    const suffix = ` (${idTail(id)})`;
    const existing = fs.readdirSync(root).find(name => name.endsWith(suffix));
    if (existing && existing !== wanted) {
      // The book was renamed: rename its folder too, so it stays easy to find.
      try { fs.renameSync(path.join(root, existing), path.join(root, wanted)); }
      catch (e) { return path.join(root, existing); }
    }
    const dir = path.join(root, wanted);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  function prune(dir, now) {
    const names = fs.readdirSync(dir).filter(n => timeOf(n) !== null);
    const keep = backupsToKeep(names, now);
    for (const name of names) {
      if (!keep.has(name)) { try { fs.unlinkSync(path.join(dir, name)); } catch (e) { /* ignore */ } }
    }
  }

  /* Saves a backup of one book. Returns 'saved' or 'unchanged'. */
  function save({ id, title, text }, now = Date.now()) {
    if (!id || typeof text !== 'string' || !text) throw new Error('Nothing to back up');
    const dir = folderFor(id, title);
    const latest = fs.readdirSync(dir).filter(n => timeOf(n) !== null).sort().pop();
    if (latest) {
      let previous = null;
      try { previous = fs.readFileSync(path.join(dir, latest), 'utf8'); } catch (e) { /* unreadable: write a fresh one */ }
      if (previous !== null && sameBook(previous, text)) return 'unchanged';
    }
    let name = stampFor(new Date(now));
    if (latest && name <= latest) name = stampFor(new Date(timeOf(latest) + 1000)); // never overwrite one
    const tmp = path.join(dir, `.${name}.tmp`);
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, path.join(dir, name));
    prune(dir, now);
    return 'saved';
  }

  return { root, save };
}

module.exports = { createBackups, backupsToKeep };
