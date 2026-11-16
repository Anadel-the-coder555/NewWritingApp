/* ────────────────────────────────────────
   Board assistant: the actions Gemma may take on the Story Board
   ────────────────────────────────────────
   Gemma never touches the project directly. It asks for one of the actions
   below by name (the TOOLS list is what it sees), and runAction() carries it
   out through a small "board" adapter that app.js / board-chat.js provide:

     board.cards()            → [{ id, kind, title, chapter, mentions, pos }]
                                 pos is {x, y[, w, h]} or null for Loose cards
     board.size(id)           → { w, h } of the card as drawn (optional)
     board.setPos(id, pos)    → place a card (null sends it to Loose cards)
     board.addCard(kind, title, pos) → new card's id

   Lives in its own file, with no reference to the page, so the rules can be
   tested outside the app (run `npm test`). */
(function (root) {
  const GAP = 28;
  const DEFAULT_SIZE = { w: 184, h: 120 };
  const ZONE_PAD = 40;

  const cardList = { type: 'array', items: { type: 'string' },
    description: 'Cards, by title or by #id from the card list, in the order they should go.' };
  const mentioning = { type: 'string',
    description: 'A character or place: includes every scene that mentions them, in manuscript order. Use this rather than picking those scenes yourself.' };
  const placement = {
    next_to: { type: 'string', description: 'A card or zone to place things beside, by title or #id.' },
    side: { type: 'string', enum: ['right', 'left', 'above', 'below'], description: 'Which side of next_to. Default: right.' },
    x: { type: 'number', description: 'Board position from the left, used when next_to is not given.' },
    y: { type: 'number', description: 'Board position from the top, used when next_to is not given.' },
  };

  const TOOLS = [
    { name: 'list_cards',
      description: 'List the cards on the Story Board and in Loose cards, with ids, kinds, positions, zones and who each scene mentions.',
      parameters: { type: 'object', properties: {
        kind: { type: 'string', enum: ['scene', 'chapter', 'event', 'character', 'place', 'object', 'idea', 'question', 'zone'], description: 'Only list this kind of card.' },
      } } },
    { name: 'move_card',
      description: 'Move one card, or put a card from Loose cards onto the board. Give next_to (and side) to put it beside another card, or x and y for an exact spot.',
      parameters: { type: 'object', required: ['card'], properties: {
        card: { type: 'string', description: 'The card to move, by title or #id.' }, ...placement,
      } } },
    { name: 'arrange_cards',
      description: 'Lay several cards out together, in the order given, as a row, a column or a grid. Give next_to (and side) or x and y for where the group starts.',
      parameters: { type: 'object', required: ['layout'], properties: {
        cards: cardList,
        mentioning,
        layout: { type: 'string', enum: ['row', 'column', 'grid'] },
        columns: { type: 'number', description: 'For a grid: how many cards across. Default 3.' },
        ...placement,
      } } },
    { name: 'put_in_zone',
      description: 'Place cards inside a zone, tidily, growing the zone if they do not fit.',
      parameters: { type: 'object', required: ['zone'], properties: {
        cards: cardList,
        mentioning,
        zone: { type: 'string', description: 'The zone, by its name or #id.' },
      } } },
    { name: 'set_aside',
      description: 'Take cards off the board and put them in Loose cards. Nothing is deleted.',
      parameters: { type: 'object', properties: { cards: cardList, mentioning } } },
    { name: 'add_card',
      description: 'Add a brand-new idea, question or zone. Never use this for a card that already exists, even in Loose cards: move it with move_card instead.',
      parameters: { type: 'object', required: ['kind', 'text'], properties: {
        kind: { type: 'string', enum: ['idea', 'question', 'zone'] },
        text: { type: 'string', description: 'What the idea or question says, or the zone\'s name.' },
        ...placement,
      } } },
  ];

  const norm = s => String(s == null ? '' : s).toLowerCase().replace(/[“”"'‘’]/g, '').replace(/\s+/g, ' ').trim();

  /* Find one card from what Gemma called it: "#12", "12", an exact title, or a
     clear part of one. Anything unclear comes back as an error naming the
     candidates, so Gemma can ask or try again rather than guess. */
  function resolveCard(cards, ref, kind) {
    // When only one kind of card makes sense (a zone, say), look there first.
    if (kind) {
      const r = resolveCard(cards.filter(c => c.kind === kind), ref);
      if (r.card) return r;
    }
    const raw = String(ref == null ? '' : ref).trim();
    const idMatch = raw.match(/^#?(\d+)$/) || raw.match(/#(\d+)/);
    if (idMatch) {
      const byId = cards.find(c => String(c.id) === idMatch[1]);
      if (byId) return { card: byId };
    }
    const want = norm(raw.replace(/^(the )?(scene|chapter|idea|question|zone|character|place|event|object)[: ]+/i, ''));
    if (!want) return { error: 'No card was named.' };
    const titled = cards.filter(c => norm(c.title));
    const exact = titled.filter(c => norm(c.title) === want);
    if (exact.length === 1) return { card: exact[0] };
    const partial = exact.length ? exact : titled.filter(c => norm(c.title).includes(want) || want.includes(norm(c.title)));
    if (partial.length === 1) return { card: partial[0] };
    if (!partial.length) return { error: `No card is called "${raw}".` };
    return { error: `"${raw}" could mean ${partial.slice(0, 6).map(describeShort).join(', ')}. Say which by #id.` };
  }

  function resolveMany(cards, refs) {
    const found = [], errors = [];
    (Array.isArray(refs) ? refs : refs == null ? [] : [refs]).forEach(ref => {
      const r = resolveCard(cards, ref);
      if (r.error) errors.push(r.error);
      else if (!found.includes(r.card)) found.push(r.card);
    });
    return { found, errors };
  }

  /* The cards an action is about: the ones named, then (if asked) every
     scene that mentions a character or place. */
  function selectCards(cards, args) {
    const { found, errors } = resolveMany(cards, args.cards);
    if (args.mentioning) {
      const who = norm(args.mentioning);
      const scenes = cards.filter(c => c.kind === 'scene' && (c.mentions || []).some(m => norm(m) === who));
      if (!scenes.length) errors.push(`No scene mentions "${args.mentioning}".`);
      scenes.forEach(c => { if (!found.some(f => f.id === c.id)) found.push(c); });
    }
    return { found, errors };
  }

  const describeShort = c => `#${c.id} ${c.kind} "${c.title || '(untitled)'}"`;

  function sizeOf(board, card) {
    if (card.kind === 'zone' && card.pos) return { w: card.pos.w || 360, h: card.pos.h || 300 };
    const s = board.size && board.size(card.id);
    return s && s.w ? s : (card.kind === 'chapter' ? { w: 240, h: 60 } : DEFAULT_SIZE);
  }

  function zoneOf(cards, board, card) {
    if (!card.pos || card.kind === 'zone') return null;
    const size = sizeOf(board, card);
    const cx = card.pos.x + size.w / 2, cy = card.pos.y + size.h / 2;
    return cards.find(z => z.kind === 'zone' && z.pos &&
      cx >= z.pos.x && cx <= z.pos.x + (z.pos.w || 360) && cy >= z.pos.y && cy <= z.pos.y + (z.pos.h || 300)) || null;
  }

  function describeCards(board, kind) {
    const cards = board.cards();
    const shown = kind ? cards.filter(c => c.kind === kind) : cards;
    if (!shown.length) return kind ? `There are no ${kind} cards.` : 'The board has no cards yet.';
    return shown.map(c => {
      const bits = [describeShort(c)];
      if (c.chapter) bits.push(`in chapter "${c.chapter}"`);
      if (c.pos) {
        bits.push(`at x ${Math.round(c.pos.x)}, y ${Math.round(c.pos.y)}`);
        if (c.kind === 'zone') bits.push(`size ${c.pos.w || 360}×${c.pos.h || 300}`);
        const z = zoneOf(cards, board, c);
        if (z) bits.push(`inside zone "${z.title}"`);
      } else {
        bits.push('in Loose cards (not on the board)');
      }
      if (c.mentions && c.mentions.length) bits.push(`mentions ${c.mentions.join(', ')}`);
      return bits.join(', ');
    }).join('\n');
  }

  const overlaps = (a, b) => a.x < b.x + b.w + 8 && b.x < a.x + a.w + 8 && a.y < b.y + b.h + 8 && b.y < a.y + a.h + 8;

  /* Where a block of size w×h goes beside an anchor card. If other cards are
     already there, keep stepping out the same way until the spot is clear. */
  function spotBeside(board, cards, anchor, side, w, h, moving) {
    const a = { ...anchor.pos, ...sizeOf(board, anchor) };
    const others = cards.filter(c => c.pos && !moving.has(c.id) && c.id !== anchor.id && c.kind !== 'zone')
      .map(c => ({ ...c.pos, ...sizeOf(board, c) }));
    let x = a.x, y = a.y;
    if (side === 'left')       x = a.x - w - GAP;
    else if (side === 'above') y = a.y - h - GAP;
    else if (side === 'below') y = a.y + a.h + GAP;
    else                       x = a.x + a.w + GAP;
    for (let i = 0; i < 20; i++) {
      const box = { x, y, w, h };
      const hit = others.find(o => overlaps(box, o));
      if (!hit) break;
      if (side === 'left')       x = hit.x - w - GAP;
      else if (side === 'above') y = hit.y - h - GAP;
      else if (side === 'below') y = hit.y + hit.h + GAP;
      else                       x = hit.x + hit.w + GAP;
    }
    return { x: Math.round(x), y: Math.round(y) };
  }

  /* Offsets for each card in a row / column / grid, plus the block's size. */
  function layoutOffsets(board, cards, layout, columns) {
    const sizes = cards.map(c => sizeOf(board, c));
    const cols = layout === 'row' ? cards.length : layout === 'column' ? 1 : Math.max(1, Math.round(columns || 3));
    const colW = Math.max(...sizes.map(s => s.w)), rowH = Math.max(...sizes.map(s => s.h));
    const offsets = cards.map((c, i) => {
      if (layout === 'row')    return { x: sizes.slice(0, i).reduce((t, s) => t + s.w + GAP, 0), y: 0 };
      if (layout === 'column') return { x: 0, y: sizes.slice(0, i).reduce((t, s) => t + s.h + GAP, 0) };
      return { x: (i % cols) * (colW + GAP), y: Math.floor(i / cols) * (rowH + GAP) };
    });
    const w = Math.max(...offsets.map((o, i) => o.x + sizes[i].w));
    const h = Math.max(...offsets.map((o, i) => o.y + sizes[i].h));
    return { offsets, w, h };
  }

  function startingPoint(board, cards, args, w, h, moving) {
    if (args.next_to != null && args.next_to !== '') {
      const r = resolveCard(cards, args.next_to);
      if (r.error) return { error: r.error };
      if (!r.card.pos) return { error: `${describeShort(r.card)} is in Loose cards, so nothing can go beside it. Place it on the board first.` };
      return { point: spotBeside(board, cards, r.card, args.side || 'right', w, h, moving), anchor: r.card };
    }
    if (Number.isFinite(+args.x) && Number.isFinite(+args.y) && args.x !== '' && args.y !== '') {
      return { point: { x: Math.round(+args.x), y: Math.round(+args.y) } };
    }
    // No place given: start to the right of everything already on the board.
    const placed = cards.filter(c => c.pos && !moving.has(c.id));
    if (!placed.length) return { point: { x: 40, y: 90 } };
    const right = Math.max(...placed.map(c => c.pos.x + sizeOf(board, c).w));
    const top = Math.min(...placed.map(c => c.pos.y));
    return { point: { x: Math.round(right + GAP * 2), y: Math.round(top) } };
  }

  function place(board, card, point) {
    const pos = card.kind === 'zone' && card.pos ? { ...card.pos, x: point.x, y: point.y } : { x: point.x, y: point.y };
    board.setPos(card.id, pos);
    card.pos = pos;
  }

  const sideWords = { right: 'to the right of', left: 'to the left of', above: 'above', below: 'below' };
  const titleOf = c => `"${c.title || 'untitled ' + c.kind}"`;
  const listTitles = cs => cs.length <= 3 ? cs.map(titleOf).join(', ') : `${cs.slice(0, 2).map(titleOf).join(', ')} and ${cs.length - 2} more`;

  /* Carries out one action. Returns { result, done } — result goes back to
     Gemma, done is a plain sentence for the person (null if nothing changed). */
  function runAction(board, name, args) {
    args = args || {};
    const cards = board.cards();
    const fail = msg => ({ result: `Not done: ${msg}`, done: null });

    if (name === 'list_cards') return { result: describeCards(board, args.kind), done: null };

    if (name === 'move_card') {
      const r = resolveCard(cards, args.card);
      if (r.error) return fail(r.error);
      const card = r.card;
      const size = sizeOf(board, card);
      const start = startingPoint(board, cards, args, size.w, size.h, new Set([card.id]));
      if (start.error) return fail(start.error);
      if (start.anchor && start.anchor.id === card.id) return fail('A card cannot go beside itself.');
      place(board, card, start.point);
      const where = start.anchor ? `${sideWords[args.side || 'right']} ${titleOf(start.anchor)}` : `to x ${start.point.x}, y ${start.point.y}`;
      return { result: `Moved ${describeShort(card)} ${where}.`, done: `Moved ${titleOf(card)} ${where}.` };
    }

    if (name === 'arrange_cards') {
      const { found, errors } = selectCards(cards, args);
      if (errors.length) return fail(errors.join(' '));
      if (!found.length) return fail('No cards were given.');
      const layout = ['row', 'column', 'grid'].includes(args.layout) ? args.layout : 'row';
      const { offsets, w, h } = layoutOffsets(board, found, layout, args.columns);
      const moving = new Set(found.map(c => c.id));
      const start = startingPoint(board, cards, args, w, h, moving);
      if (start.error) return fail(start.error);
      if (start.anchor && moving.has(start.anchor.id)) return fail('The card to line up beside cannot be one of the cards being moved.');
      found.forEach((c, i) => place(board, c, { x: start.point.x + offsets[i].x, y: start.point.y + offsets[i].y }));
      const where = start.anchor ? ` ${sideWords[args.side || 'right']} ${titleOf(start.anchor)}` : '';
      return { result: `Arranged ${found.map(describeShort).join(', ')} in a ${layout}${where}.`,
               done: `Put ${listTitles(found)} in a ${layout}${where}.` };
    }

    if (name === 'put_in_zone') {
      const z = resolveCard(cards, args.zone, 'zone');
      if (z.error) return fail(z.error);
      const zone = z.card;
      if (zone.kind !== 'zone') return fail(`${describeShort(zone)} is not a zone.`);
      if (!zone.pos) return fail(`The zone ${titleOf(zone)} is in Loose cards. Place it on the board first.`);
      const { found, errors } = selectCards(cards, args);
      if (errors.length) return fail(errors.join(' '));
      const inside = found.filter(c => c.id !== zone.id && c.kind !== 'zone');
      if (!inside.length) return fail('No cards were given to put in the zone.');
      const zw = zone.pos.w || 360;
      const widest = Math.max(...inside.map(c => sizeOf(board, c).w));
      const columns = Math.max(1, Math.floor((zw - ZONE_PAD * 2 + GAP) / (widest + GAP)));
      const { offsets, w, h } = layoutOffsets(board, inside, 'grid', columns);
      inside.forEach((c, i) => place(board, c, { x: zone.pos.x + ZONE_PAD + offsets[i].x, y: zone.pos.y + ZONE_PAD + offsets[i].y }));
      const grown = { ...zone.pos, w: Math.max(zw, w + ZONE_PAD * 2), h: Math.max(zone.pos.h || 300, h + ZONE_PAD * 2) };
      if (grown.w !== zw || grown.h !== (zone.pos.h || 300)) { board.setPos(zone.id, grown); zone.pos = grown; }
      return { result: `Put ${inside.map(describeShort).join(', ')} inside zone ${titleOf(zone)}.`,
               done: `Put ${listTitles(inside)} in the zone ${titleOf(zone)}.` };
    }

    if (name === 'set_aside') {
      const { found, errors } = selectCards(cards, args);
      if (errors.length) return fail(errors.join(' '));
      const onBoard = found.filter(c => c.pos);
      if (!onBoard.length) return fail('Those cards are already in Loose cards.');
      onBoard.forEach(c => { board.setPos(c.id, null); c.pos = null; });
      return { result: `Moved ${onBoard.map(describeShort).join(', ')} to Loose cards.`,
               done: `Set ${listTitles(onBoard)} aside in Loose cards.` };
    }

    if (name === 'add_card') {
      const kind = ['idea', 'question', 'zone'].includes(args.kind) ? args.kind : null;
      if (!kind) return fail('Only ideas, questions and zones can be added.');
      const text = String(args.text || '').trim();
      if (!text) return fail('The new card needs some text.');
      const twin = cards.find(c => c.kind === kind && norm(c.title) === norm(text));
      if (twin) return fail(`That ${kind} already exists as ${describeShort(twin)}${twin.pos ? '' : ' in Loose cards'}. Use move_card to place it.`);
      const size = kind === 'zone' ? { w: 360, h: 300 } : DEFAULT_SIZE;
      const start = startingPoint(board, cards, args, size.w, size.h, new Set());
      if (start.error) return fail(start.error);
      const pos = kind === 'zone' ? { ...start.point, w: 360, h: 300 } : start.point;
      const id = board.addCard(kind, text, pos);
      return { result: `Added ${kind} #${id} "${text}".`, done: `Added the ${kind} "${text}".` };
    }

    return fail(`There is no action called ${name}.`);
  }

  function systemPrompt(board) {
    return [
      'You help a novelist arrange the Story Board in their writing app, Folio.',
      'The board is a large canvas of cards: scenes, chapters, characters, places, events, objects, ideas, questions and zones (labelled areas that hold cards). Cards not on the board sit in "Loose cards".',
      'Positions are in board pixels: x grows to the right, y grows downward. Cards are about 184 wide and 120 tall.',
      'Use the actions to change the board. Refer to cards by #id whenever you can; titles can repeat.',
      'To place a card that already exists, including one in Loose cards, use move_card. Only use add_card for a brand-new thought.',
      'When the writer means scenes featuring a character or place ("the Mara scenes", "every scene with Tom", "scenes set at the harbour"), use the mentioning option rather than choosing the scenes yourself; you will miss some otherwise.',
      'Example: "put the Mara scenes in a row under the storm idea" → arrange_cards with mentioning "Mara", layout "row", next_to the idea\'s #id, side "below".',
      'If an action comes back "Not done", fix it and try again, or tell the writer what went wrong.',
      'If a request is unclear, or you cannot tell which card the writer means, ask a short question instead of guessing.',
      'Only rearrange cards and add ideas, questions or zones. You cannot edit or delete the writing itself; say so if asked.',
      'After acting, reply in one or two plain sentences saying what you did. Do not list coordinates or ids unless asked.',
      '',
      'The board right now:',
      describeCards(board),
    ].join('\n');
  }

  const api = { TOOLS, runAction, resolveCard, describeCards, systemPrompt,
    ollamaTools: () => TOOLS.map(t => ({ type: 'function', function: t })) };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.FolioBoardAssistant = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
