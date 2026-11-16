/* ────────────────────────────────────────
   Counting: words, characters, paragraphs, sentences
   ────────────────────────────────────────
   Lives in its own file so the rules can be tested outside the app
   (run `npm test`, which checks them against tests/counting.test.js).

   Every count starts from the same step: the document's HTML is turned into a
   list of paragraphs (blocks), each holding its lines (a Shift+Enter line break
   starts a new line inside the same paragraph). Each count then works from that
   one shared picture, so the numbers can't disagree with each other about where
   a paragraph starts or ends. */
(function (root) {
  'use strict';

  /* Tags that start or end a paragraph-level block on the page. Both opening and
     closing tags count, so text that sits directly before a <div> (which Chromium's
     editor produces for the first line of a document) is still split from it. */
  const BLOCK_TAG_RE = /<\/?(?:p|div|h[1-6]|blockquote|li|ul|ol|dl|dt|dd|pre|section|article|header|footer|aside|nav|figure|figcaption|table|thead|tbody|tfoot|tr|td|th|caption|hr)\b[^>]*>/gi;

  /* Characters that are invisible and never part of a word. */
  const INVISIBLE_RE = /[\u200B-\u200D\u2060\uFEFF\u00AD]/g;
  // For character counts the zero-width joiner stays: it glues emoji like a family into one.
  const INVISIBLE_NOT_JOINER_RE = /[\u200B\u200C\u2060\uFEFF\u00AD]/g;

  /* What separates one word from the next: any whitespace (including non-breaking
     and em spaces), em/en dashes, an ellipsis, a slash, or a typed double hyphen.
     Everything else — apostrophes, periods inside "U.S." or "3.50", commas inside
     "1,000", the colon in "5:30", the @ in an email — stays inside the word, the
     way Word and Google Docs count. */
  const WORD_SEPARATOR_RE = /[\s\u2013\u2014\u2015\u2026\/]+|-{2,}|\.{3,}/u;
  const HAS_WORD_CHAR_RE = /[\p{L}\p{N}]/u;

  /* The editor's Tab key types two em spaces; count that as one character, like a
     tab in a word processor. */
  const TAB_INDENT_RE = /\u2003\u2003/g;

  /* Content that's in the HTML but never shown: comments, and <style>/<script>/<head>
     blocks that pasted rich text (Word, Google Docs, …) often carries along. */
  function stripHiddenHtml(html) {
    return String(html || '')
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<(style|script|head|template)\b[^>]*>[\s\S]*?<\/\1>/gi, '');
  }

  const NAMED_ENTITIES = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00A0',
    mdash: '\u2014', ndash: '\u2013', hellip: '\u2026', lsquo: '\u2018', rsquo: '\u2019',
    ldquo: '\u201C', rdquo: '\u201D', emsp: '\u2003', ensp: '\u2002', thinsp: '\u2009',
    shy: '\u00AD', zwj: '\u200D', zwnj: '\u200C', laquo: '\u00AB', raquo: '\u00BB',
  };

  /* Turns "&amp;", "&nbsp;", "&#8217;" … back into real characters. In the app a
     <textarea> does it (it knows every entity); elsewhere (tests) a small table and
     numeric references cover what the editor actually produces. */
  function decodeHtmlEntities(text) {
    if (!/&/.test(text)) return text;
    if (typeof document !== 'undefined') {
      const el = document.createElement('textarea');
      el.innerHTML = text;
      return el.value;
    }
    return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, code) => {
      if (code[0] === '#') {
        const n = code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
        return Number.isFinite(n) ? String.fromCodePoint(n) : m;
      }
      const named = NAMED_ENTITIES[code.toLowerCase()];
      return named === undefined ? m : named;
    });
  }

  function isHtml(s) {
    return /<[a-z!\/]/i.test(s);
  }

  /* Returns [[line, line, …], …] — one array per non-empty paragraph. */
  function toBlocks(input) {
    let s = String(input || '');
    if (isHtml(s)) {
      s = stripHiddenHtml(s)
        // Line breaks inside the HTML source aren't visible on the page; the
        // editor collapses ordinary whitespace runs to one space.
        .replace(/[ \t\r\n\f]+/g, ' ')
        .replace(BLOCK_TAG_RE, '\n\n')
        .replace(/<br\b[^>]*>/gi, '\n')
        .replace(/<[^>]*>/g, '');
      s = decodeHtmlEntities(s);
    } else {
      // Plain text (notes, book pages): a blank line separates paragraphs.
      s = decodeHtmlEntities(s).replace(/\r\n?/g, '\n').replace(/[ \t\f]+/g, ' ');
    }
    const blocks = [];
    for (const rawBlock of s.split(/\n[ \t]*\n/)) {
      const lines = rawBlock.split('\n')
        .map(line => line.replace(/^[ \t]+|[ \t]+$/g, ''))
        .filter(line => line.replace(INVISIBLE_RE, '').trim() !== '');
      if (lines.length) blocks.push(lines);
    }
    return blocks;
  }

  /* ── Words ── */
  function lineWords(line) {
    const out = [];
    for (const piece of line.replace(INVISIBLE_RE, '').split(WORD_SEPARATOR_RE)) {
      if (HAS_WORD_CHAR_RE.test(piece)) out.push(piece.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ''));
    }
    return out;
  }

  function blocksWords(blocks) {
    const out = [];
    for (const lines of blocks) for (const line of lines) out.push(...lineWords(line));
    return out;
  }

  /* ── Characters ── (with spaces, not counting paragraph breaks; an emoji or an
     accented letter is one character however many code units it takes) */
  let graphemeSegmenter = null;
  function graphemeCount(s) {
    if (!/[^\u0000-\u02FF]/.test(s)) return s.length;
    if (graphemeSegmenter === null) {
      graphemeSegmenter = (typeof Intl !== 'undefined' && Intl.Segmenter)
        ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
        : false;
    }
    if (!graphemeSegmenter) return Array.from(s).length;
    let n = 0;
    for (const _ of graphemeSegmenter.segment(s)) n++; // eslint-disable-line no-unused-vars
    return n;
  }

  function blocksCharacters(blocks) {
    let n = 0;
    for (const lines of blocks) {
      for (const line of lines) n += graphemeCount(line.replace(INVISIBLE_NOT_JOINER_RE, '').replace(TAB_INDENT_RE, '\t'));
    }
    return n;
  }

  /* ── Sentences ──
     Every paragraph, heading, and list item ends a sentence, whether or not it ends
     in punctuation. Inside a paragraph, a sentence ends at . ! ? … (or a dash that
     closes interrupted dialogue, like `“Wait—”`), plus any closing quotes or
     brackets, followed by a space — unless what follows shows it isn't an ending:

       • the next word starts lowercase       “Are you sure?” he asked.   /  etc. and
       • the period follows a title           Dr. Evendelle / Mrs. Hale
       • the period follows an initial         J. R. R. Tolkien
       • a numbered abbreviation, then a digit No. 5 / Vol. 2 / pp. 12
       • an ellipsis followed by “I”           Well… I guess so. */
  const TITLE_ABBREVIATIONS = new Set([
    'Mr', 'Mrs', 'Ms', 'Mx', 'Dr', 'Prof', 'Sr', 'Jr', 'St', 'Mt', 'Ft', 'Capt', 'Lt', 'Gen', 'Col',
    'Sgt', 'Cpl', 'Pvt', 'Cmdr', 'Adm', 'Gov', 'Sen', 'Rep', 'Pres', 'Rev', 'Fr', 'Msgr', 'Hon',
    'vs', 'Messrs', 'Mme', 'Mlle',
  ]);
  const NUMBER_ABBREVIATIONS = new Set(['No', 'no', 'Nos', 'nos', 'Vol', 'vol', 'p', 'pp', 'Ch', 'ch', 'Fig', 'fig', 'Figs', 'figs', 'Art', 'art', 'Sec', 'sec']);

  const SENTENCE_END_RE = /(\.{3,}|\u2026|[.!?]+|[\u2014\u2013])([)\]'"\u2019\u201D\u00BB]*)\s+/gu;
  const OPENERS_RE = /^[(\['"\u2018\u201C\u00AB\u00BF\u00A1]+/u;

  function endsSentence(text, match) {
    const [whole, mark, closers] = match;
    const after = text.slice(match.index + whole.length);
    const next = after.replace(OPENERS_RE, '');
    const openedQuote = next.length !== after.length;
    const nextChar = next.charAt(0);
    if (!nextChar) return false;
    if (/\p{Ll}/u.test(nextChar)) return false;

    const before = text.slice(0, match.index);
    const prevWord = (before.match(/[\p{L}\p{N}.]+$/u) || [''])[0];

    if (mark === '\u2014' || mark === '\u2013') {
      // A dash ends a sentence only when it closes a quote: `\u201CWait\u2014\u201D He ran.`
      return closers !== '' && (openedQuote || /\p{Lu}/u.test(nextChar));
    }
    if (mark === '\u2026' || /^\.{3,}$/.test(mark)) {
      if (/^I\b/.test(next) && !openedQuote) return false;
      return openedQuote || /[\p{Lu}\p{N}]/u.test(nextChar);
    }
    if (mark === '.') {
      if (TITLE_ABBREVIATIONS.has(prevWord)) return false;
      // A lone capital letter before a period is almost always an initial
      // ("J. Tolkien"). "U.S." still ends a sentence when a new one clearly starts.
      if (/^\p{Lu}$/u.test(prevWord)) return false;
      if (NUMBER_ABBREVIATIONS.has(prevWord) && /\p{N}/u.test(nextChar)) return false;
    }
    return true;
  }

  function blockSentences(lines) {
    const text = lines.join(' ');
    if (!HAS_WORD_CHAR_RE.test(text)) return 0;
    let count = 1;
    SENTENCE_END_RE.lastIndex = 0;
    let m;
    while ((m = SENTENCE_END_RE.exec(text))) {
      if (endsSentence(text, m) && HAS_WORD_CHAR_RE.test(text.slice(m.index + m[0].length))) count++;
    }
    return count;
  }

  function blocksSentences(blocks) {
    return blocks.reduce((sum, lines) => sum + blockSentences(lines), 0);
  }

  /* ── Public API ── */
  function getTextStats(html) {
    const blocks = toBlocks(html);
    return {
      words: blocksWords(blocks).length,
      characters: blocksCharacters(blocks),
      paragraphs: blocks.length,
      sentences: blocksSentences(blocks),
      text: blocks.map(lines => lines.join(' ')).join('\n'),
    };
  }

  function wordTokens(html) { return blocksWords(toBlocks(html)); }
  function countWords(html) { return wordTokens(html).length; }
  function countCharacters(html) { return blocksCharacters(toBlocks(html)); }
  function countParagraphs(html) { return toBlocks(html).length; }
  function countSentences(html) { return blocksSentences(toBlocks(html)); }
  /* Plain text of the document, one line per paragraph (used for matching names). */
  function htmlToCountableText(html) { return toBlocks(html).map(lines => lines.join(' ')).join('\n'); }

  const api = {
    getTextStats, wordTokens, countWords, countCharacters, countParagraphs, countSentences,
    htmlToCountableText, stripHiddenHtml, decodeHtmlEntities,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else Object.assign(root, api);
})(typeof globalThis !== 'undefined' ? globalThis : this);
