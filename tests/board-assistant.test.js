/* Checks the Story Board actions Gemma can ask for, against a pretend board.
   Run with:  npm test */
const test = require('node:test');
const assert = require('node:assert');
const a = require('../board-assistant.js');

function makeBoard() {
  const cards = [
    { id: 1, kind: 'scene', title: 'Lighthouse', chapter: 'One', mentions: ['Mara'], pos: { x: 0, y: 0 } },
    { id: 2, kind: 'scene', title: 'The Storm', chapter: 'One', mentions: ['Mara', 'Tom'], pos: { x: 300, y: 0 } },
    { id: 3, kind: 'idea', title: 'Storm idea', pos: { x: 600, y: 0 } },
    { id: 4, kind: 'scene', title: 'Harbour at dawn', chapter: 'Two', mentions: [], pos: null },
    { id: 5, kind: 'zone', title: 'Act one', pos: { x: 0, y: 400, w: 360, h: 300 } },
    { id: 6, kind: 'scene', title: 'Lighthouse keeper', chapter: 'Two', mentions: [], pos: { x: 900, y: 0 } },
  ];
  let next = 10;
  return {
    data: cards,
    cards: () => cards.map(c => ({ ...c, pos: c.pos && { ...c.pos } })),
    setPos(id, pos) { cards.find(c => c.id === id).pos = pos && { ...pos }; },
    addCard(kind, title, pos) { const id = next++; cards.push({ id, kind, title, pos }); return id; },
    get: id => cards.find(c => c.id === id),
  };
}

test('finds cards by id, exact title, or a clear part of one', () => {
  const b = makeBoard();
  assert.strictEqual(a.resolveCard(b.cards(), '#4').card.id, 4);
  assert.strictEqual(a.resolveCard(b.cards(), 'lighthouse').card.id, 1, 'exact title wins over a longer one');
  assert.strictEqual(a.resolveCard(b.cards(), 'harbour').card.id, 4);
  assert.strictEqual(a.resolveCard(b.cards(), 'Scene: The Storm').card.id, 2);
});

test('asks instead of guessing when a name fits several cards', () => {
  const r = a.resolveCard(makeBoard().cards(), 'storm');
  assert.ok(r.error && r.error.includes('#2') && r.error.includes('#3'));
});

test('moving beside a card steps past cards already there', () => {
  const b = makeBoard();
  const r = a.runAction(b, 'move_card', { card: 'Harbour at dawn', next_to: '#1', side: 'right' });
  assert.ok(r.done);
  const p = b.get(4).pos;
  assert.strictEqual(p.y, 0);
  assert.ok(p.x > 600 + 184, `should land clear of the cards to the right, got x ${p.x}`);
});

test('arranges cards in a row below another card, in the order given', () => {
  const b = makeBoard();
  const r = a.runAction(b, 'arrange_cards', { cards: ['#4', '#2', '#1'], layout: 'row', next_to: '#3', side: 'below' });
  assert.ok(r.done, r.result);
  const [p4, p2, p1] = [4, 2, 1].map(id => b.get(id).pos);
  assert.ok(p4.y === p2.y && p2.y === p1.y && p4.y > 120);
  assert.ok(p4.x < p2.x && p2.x < p1.x);
});

test('putting cards in a zone places them inside it and grows it if needed', () => {
  const b = makeBoard();
  a.runAction(b, 'put_in_zone', { cards: ['#1', '#2', '#4', '#6'], zone: 'Act one' });
  const z = b.get(5).pos;
  [1, 2, 4, 6].forEach(id => {
    const p = b.get(id).pos;
    assert.ok(p.x >= z.x && p.x + 184 <= z.x + z.w && p.y >= z.y && p.y + 120 <= z.y + z.h, `card ${id} inside`);
  });
});

test('setting aside sends cards to Loose cards; adding makes a new card', () => {
  const b = makeBoard();
  a.runAction(b, 'set_aside', { cards: ['#1'] });
  assert.strictEqual(b.get(1).pos, null);
  const r = a.runAction(b, 'add_card', { kind: 'question', text: 'Why does Tom lie?', next_to: '#2', side: 'below' });
  assert.ok(r.done);
  assert.deepStrictEqual(b.get(10).pos, { x: 300, y: 148 });
});

test('unknown cards and actions change nothing', () => {
  const b = makeBoard();
  const before = JSON.stringify(b.data);
  assert.strictEqual(a.runAction(b, 'move_card', { card: 'Nowhere', next_to: '#1' }).done, null);
  assert.strictEqual(a.runAction(b, 'arrange_cards', { cards: ['#1', 'storm'], layout: 'row' }).done, null);
  assert.strictEqual(a.runAction(b, 'delete_everything', {}).done, null);
  assert.strictEqual(JSON.stringify(b.data), before);
});

test('"scenes that mention" picks every one, in order', () => {
  const b = makeBoard();
  const r = a.runAction(b, 'arrange_cards', { mentioning: 'mara', layout: 'column', x: 0, y: 1000 });
  assert.ok(r.done, r.result);
  assert.deepStrictEqual(b.get(1).pos, { x: 0, y: 1000 });
  assert.strictEqual(b.get(2).pos.x, 0);
  assert.ok(b.get(2).pos.y > 1000);
});

test('will not add a second copy of an existing card', () => {
  const b = makeBoard();
  const r = a.runAction(b, 'add_card', { kind: 'idea', text: 'storm idea', next_to: '#1' });
  assert.strictEqual(r.done, null);
  assert.match(r.result, /#3/);
});

test('a zone named like a character is still found as the zone', () => {
  const b = makeBoard();
  b.data.push({ id: 7, kind: 'character', title: 'Act one', pos: null });
  const r = a.runAction(b, 'put_in_zone', { cards: ['#1'], zone: 'Act one' });
  assert.ok(r.done, r.result);
});
