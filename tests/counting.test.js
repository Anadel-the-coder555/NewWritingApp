/* Checks the word / character / paragraph / sentence counts against hand-counted
   examples. Run with:  npm test */
const test = require('node:test');
const assert = require('node:assert');
const c = require('../counting.js');

const sentenceCases = [
  ['"no." as an ordinary word', '<p>I told him no. Then I left the room.</p>', 2],
  ['"etc." ending a sentence', '<p>We packed bread, cheese, etc. Then we drove off.</p>', 2],
  ['heading without punctuation', '<h1>Chapter One</h1><p>It was dark. The rain fell.</p>', 3],
  ['paragraph without end punctuation', '<p>She looked up</p><p>Nothing was there.</p>', 2],
  ['dialogue cut off with dash and quote', '<p>“Wait—”</p><p>He ran.</p>', 2],
  ['interrupted dialogue then a tag', '<p>“Wait—” she said. He ran.</p>', 2],
  ['interrupted dialogue then new sentence', '<p>“Wait—” He ran.</p>', 2],
  ['paragraph ending in a dash', '<p>He started to say—</p><p>She cut him off.</p>', 2],
  ['mid-sentence dashes', '<p>He turned— slowly —and walked away.</p>', 1],
  ['two quoted sentences', '<p>“Go home,” she said. “Now.”</p>', 2],
  ['question in quotes then tag', '<p>“Are you sure?” he asked.</p>', 1],
  ['exclamation then new sentence', '<p>“Run!” They ran.</p>', 2],
  ['ellipsis then I', '<p>Well… I guess so.</p>', 1],
  ['three dots then I', '<p>Well... I guess so.</p>', 1],
  ['ellipsis between sentences', '<p>He waited… Nothing happened.</p>', 2],
  ['initials', '<p>J. R. R. Tolkien wrote it.</p>', 1],
  ['titles', '<p>Dr. Evendelle met Mrs. Hale. They talked.</p>', 2],
  ['No. with a number', '<p>He lived at No. 5 Baker Street. It was cold.</p>', 2],
  ['U.S. mid-sentence', '<p>The U.S. army arrived. Everyone cheered.</p>', 2],
  ['U.S. ending a sentence', '<p>He moved to the U.S. Then he left.</p>', 2],
  ['decimal number', '<p>It cost 3.50 dollars. Cheap.</p>', 2],
  ['line break inside a paragraph', '<p>Line one.<br>Line two.</p>', 2],
  ['list items', '<ul><li>eggs</li><li>milk</li></ul><p>Buy them.</p>', 3],
  ['tab indent', '<p>  It began. Then ended.</p>', 2],
  ['non-breaking space', '<p>One&nbsp;two. Three.</p>', 2],
  ['scene break is not a sentence', '<p>End.</p><div class="scene-break">· · ·</div><p>Start.</p>', 2],
  ['emoji', '<p>Great 🎉 day.</p>', 1],
  ['empty paragraphs', '<p><br></p><p>Hi.</p><p><br></p>', 1],
  ['quote then lowercase after period', '<p>He said “fine.” and left.</p>', 1],
  ['several ?! marks', '<p>What?! No way!! Really?</p>', 3],
];

const wordCases = [
  ['em dashes between words', '<p>He turned—slowly—away.</p>', 4],
  ['hyphenated word', '<p>A well-known fact.</p>', 3],
  ['non-breaking hyphen', '<p>A well‑known fact.</p>', 3],
  ['decimal', '<p>It cost 3.50 today.</p>', 4],
  ['U.S.', '<p>The U.S. army.</p>', 3],
  ['accent written as two characters', '<p>café au lait</p>', 3],
  ['email address', '<p>mail me at a@b.com now</p>', 5],
  ['small heading boundary', '<h4>Title</h4><p>Body</p>', 2],
  ['table cells', '<table><tr><td>one</td><td>two</td></tr></table>', 2],
  ['list then text', '<ul><li>one</li></ul>two', 2],
  ['first line before a div', 'one<div>two</div>', 2],
  ['ampersand', '<p>Mom &amp; Dad</p>', 2],
  ['slash', '<p>and/or</p>', 2],
  ['thousands separator', '<p>1,000 people</p>', 2],
  ['time', '<p>at 5:30 pm</p>', 3],
  ['leading apostrophes', '<p>’Twas rock ’n’ roll</p>', 4],
  ['contraction and possessive', '<p>Don’t take Ellis’s car</p>', 4],
  ['ellipsis without spaces', '<p>Well...I don’t know…maybe</p>', 5],
  ['typed double hyphen', '<p>wait--what</p>', 2],
  ['stray punctuation', '<p>Yes , no ; maybe — fine !</p>', 4],
  ['scene break dots', '<div class="scene-break">· · ·</div>', 0],
  ['bold in the middle of a word', '<p>Hel<b>lo</b> there</p>', 2],
  ['zero-width space', '<p>one​two three</p>', 2],
  ['hidden style block from a paste', '<style>p.x { color: red; }</style><p>Hi there</p>', 2],
  ['HTML comment', '<p>Hi<!-- secret words here --> there</p>', 2],
  ['source newlines between tags', '<p>one</p>\n<p>two</p>', 2],
  ['plain text with newlines', 'one two\nthree\n\nfour', 4],
  ['empty', '', 0],
];

const characterCases = [
  ['paragraph breaks are not characters', '<p>Hello there.</p><p>Bye.</p>', 16],
  ['emoji is one character', '<p>End 🎉</p>', 5],
  ['family emoji is one character', '<p>👨‍👩‍👧</p>', 1],
  ['accent written as two characters is one', '<p>café</p>', 4],
  ['tab indent is one character', '<p>  Hi</p>', 3],
  ['non-breaking space counts', '<p>a&nbsp;b</p>', 3],
  ['ampersand is one character', '<p>Mom &amp; Dad</p>', 9],
  ['empty paragraphs add nothing', '<p><br></p><p>ab</p><p><br></p>', 2],
  ['source whitespace is not counted', '<p>\n  ab\n</p>', 2],
];

const paragraphCases = [
  ['basic', '<p>a</p><p>b</p>', 2],
  ['empty paragraph ignored', '<p>a</p><p><br></p><p>b</p>', 2],
  ['nbsp-only paragraph ignored', '<p>&nbsp;</p><p>x</p>', 1],
  ['line break stays in one paragraph', '<p>Line one<br>Line two</p>', 1],
  ['blank line made of two breaks splits', '<p>One<br><br>Two</p>', 2],
  ['headings and quotes', '<h2>T</h2><blockquote>q</blockquote><p>p</p>', 3],
  ['list items', '<ul><li>a</li><li>b</li></ul>', 2],
  ['scene break counts', '<p>a</p><div class="scene-break">· · ·</div><p>b</p>', 3],
  ['first line before a div', 'one<div>two</div>', 2],
];

for (const [name, html, want] of sentenceCases) test(`sentences: ${name}`, () => assert.strictEqual(c.countSentences(html), want));
for (const [name, html, want] of wordCases) test(`words: ${name}`, () => assert.strictEqual(c.countWords(html), want));
for (const [name, html, want] of characterCases) test(`characters: ${name}`, () => assert.strictEqual(c.countCharacters(html), want));
for (const [name, html, want] of paragraphCases) test(`paragraphs: ${name}`, () => assert.strictEqual(c.countParagraphs(html), want));

test('getTextStats agrees with the single counts', () => {
  const html = '<h1>Chapter One</h1><p>  “Are you sure?” he asked. Dr. Hale nodded.</p><p>No.</p>';
  const s = c.getTextStats(html);
  assert.deepStrictEqual(
    [s.words, s.characters, s.paragraphs, s.sentences],
    [c.countWords(html), c.countCharacters(html), c.countParagraphs(html), c.countSentences(html)],
  );
  assert.deepStrictEqual([s.words, s.paragraphs, s.sentences], [11, 3, 4]);
});
