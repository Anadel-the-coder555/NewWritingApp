const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createBackups, backupsToKeep } = require('../backups');

const book = (words, exportedAt = 'x') => JSON.stringify({ folioFile: true, exportedAt, project: { id: 'project-123456', updatedAt: exportedAt, docs: [{ content: words }] } });
const tempRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), 'folio-backups-'));
const DAY = 24 * 60 * 60 * 1000;

test('writes a dated backup into a folder named after the book', () => {
  const root = tempRoot();
  const backups = createBackups(root);
  assert.strictEqual(backups.save({ id: 'project-123456', title: 'Gravity Thief', text: book('one') }), 'saved');
  const [folder] = fs.readdirSync(root);
  assert.strictEqual(folder, 'Gravity Thief (123456)');
  const files = fs.readdirSync(path.join(root, folder));
  assert.strictEqual(files.length, 1);
  assert.match(files[0], /^\d{4}-\d{2}-\d{2} \d{2}-\d{2}-\d{2}\.folio$/);
  assert.strictEqual(fs.readFileSync(path.join(root, folder, files[0]), 'utf8'), book('one'));
});

test('skips a backup when only the save times changed', () => {
  const root = tempRoot();
  const backups = createBackups(root);
  const now = Date.now();
  backups.save({ id: 'project-123456', title: 'Book', text: book('one', 'a') }, now);
  assert.strictEqual(backups.save({ id: 'project-123456', title: 'Book', text: book('one', 'b') }, now + 60000), 'unchanged');
  assert.strictEqual(backups.save({ id: 'project-123456', title: 'Book', text: book('two', 'c') }, now + 120000), 'saved');
  assert.strictEqual(fs.readdirSync(path.join(root, 'Book (123456)')).length, 2);
});

test('never overwrites a backup made in the same second', () => {
  const root = tempRoot();
  const backups = createBackups(root);
  const now = Date.now();
  backups.save({ id: 'p1', title: 'Book', text: book('one') }, now);
  backups.save({ id: 'p1', title: 'Book', text: book('two') }, now);
  assert.strictEqual(fs.readdirSync(path.join(root, 'Book (p1)')).length, 2);
});

test('renaming a book renames its backup folder', () => {
  const root = tempRoot();
  const backups = createBackups(root);
  const now = Date.now();
  backups.save({ id: 'p1', title: 'Old Name', text: book('one') }, now);
  backups.save({ id: 'p1', title: 'New Name', text: book('two') }, now + 1000);
  assert.deepStrictEqual(fs.readdirSync(root), ['New Name (p1)']);
  assert.strictEqual(fs.readdirSync(path.join(root, 'New Name (p1)')).length, 2);
});

test('titles cannot escape the backups folder', () => {
  const root = tempRoot();
  createBackups(root).save({ id: 'p1', title: '../../etc/passwd', text: book('one') });
  assert.deepStrictEqual(fs.readdirSync(root), ['-..-etc-passwd (p1)']);
});

test('keeps the last day, then one a day for 90 days, then one a month', () => {
  const now = new Date(2026, 10, 17, 12, 0, 0).getTime();
  const name = t => { const d = new Date(t); const p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}.folio`; };
  const recentA = name(now - 60000), recentB = name(now - 2 * 3600000);
  const twoDaysMorning = name(now - 2 * DAY - 3600000), twoDaysEvening = name(now - 2 * DAY + 3600000);
  const oldA = name(new Date(2026, 0, 5).getTime()), oldB = name(new Date(2026, 0, 20).getTime());
  const keep = backupsToKeep([recentA, recentB, twoDaysMorning, twoDaysEvening, oldA, oldB, 'notes.txt'], now);
  assert.deepStrictEqual([...keep].sort(), [recentA, recentB, twoDaysEvening, oldB].sort());
});
