// Synced-folder file access for the Electron app (runs in the main process).
//
// Folio used to reach the synced folder through the browser's File System Access
// API. Inside Electron that proved unreliable: access was forgotten on every
// restart, and saves into the Dropbox folder could fail partway, leaving
// "<name>.crswap" temp files and an out-of-date project file. Here Folio writes
// with Node's own file functions instead: no permission prompts, and every save
// is atomic (written to a temp file, then renamed over the old one).
//
// The page only ever passes bare file names; this module decides the folder, so
// the page can't read or write anything outside it.
const fs = require('fs');
const path = require('path');

const ALLOWED = /\.(folio|crswap)$/;

function createSyncFolder(configFile) {
  let folder = null;
  try {
    const saved = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    if (saved && typeof saved.folder === 'string') folder = saved.folder;
  } catch (e) { /* nothing chosen yet */ }

  function setFolder(newFolder) {
    folder = newFolder || null;
    fs.mkdirSync(path.dirname(configFile), { recursive: true });
    fs.writeFileSync(configFile, JSON.stringify({ folder }));
    return folder;
  }

  function resolve(name) {
    if (!folder) throw new Error('No synced folder chosen');
    if (typeof name !== 'string' || !ALLOWED.test(name) || name !== path.basename(name) || name.startsWith('.')) {
      throw new Error(`Not a Folio file name: ${name}`);
    }
    return path.join(folder, name);
  }

  function stat(name) {
    try {
      const s = fs.statSync(resolve(name));
      return s.isFile() ? { name, mtimeMs: s.mtimeMs, size: s.size } : null;
    } catch (e) {
      if (e.code === 'ENOENT') return null;
      throw e;
    }
  }

  function list() {
    if (!folder) return [];
    return fs.readdirSync(folder)
      .filter(name => ALLOWED.test(name) && !name.startsWith('.'))
      .map(name => { try { return stat(name); } catch (e) { return null; } })
      .filter(Boolean);
  }

  function read(name) {
    return fs.readFileSync(resolve(name), 'utf8');
  }

  function write(name, text) {
    const target = resolve(name);
    const tmp = path.join(folder, `.${name}.folio-tmp`);
    fs.writeFileSync(tmp, String(text));
    fs.renameSync(tmp, target);
    return stat(name);
  }

  function remove(name) {
    try { fs.unlinkSync(resolve(name)); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }

  return { getFolder: () => folder, setFolder, list, stat, read, write, remove };
}

module.exports = { createSyncFolder };
