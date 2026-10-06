import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync, crc32 } from 'node:zlib';
import { readZip, unzipEntry, writeZip, headingLevels, parseCards, cardDocx, headingsOf, boldEmphasis } from '../lib/docx.mjs';

// A minimal docx: [name, text] entries, deflated.
function docx(files) {
  return writeZip(Object.entries(files).map(([name, text]) => {
    const raw = Buffer.from(text, 'utf8');
    return { name, method: 8, crc: crc32(raw), usize: raw.length, data: deflateRawSync(raw), time: 0, date: 0x21 };
  }));
}
const STYLES = `<w:styles>
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:pPr><w:outlineLvl w:val="0"/></w:pPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/></w:style>
<w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:pPr><w:outlineLvl w:val="2"/></w:pPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading4"><w:name w:val="heading 4"/><w:basedOn w:val="Normal"/><w:pPr><w:outlineLvl w:val="3"/></w:pPr></w:style>
<w:style w:type="paragraph" w:styleId="KindaTag"><w:name w:val="Kinda Tag"/><w:basedOn w:val="Heading4"/></w:style>
<w:style w:type="paragraph" w:styleId="Undertag"><w:name w:val="Undertag"/><w:basedOn w:val="Normal"/></w:style>
<w:style w:type="character" w:styleId="Heading4Char"><w:name w:val="Heading 4 Char"/></w:style>
</w:styles>`;
const p = (style, ...runs) => `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/><w:tabs><w:tab w:val="left" w:pos="720"/></w:tabs></w:pPr>` : ''}${runs.map((r) => `<w:r><w:t xml:space="preserve">${r}</w:t></w:r>`).join('')}</w:p>`;
const BODY = [
  p('Heading1', 'AFF'),
  p('Heading2', 'Grid'),
  p('Heading3', 'AT: Offshoring'),
  p('Heading4', 'Data centers stay ', 'onshore &amp; grow'),
  p('Undertag', 'context line'),
  '<w:p><w:r><w:t>Rogan </w:t></w:r><w:r><w:instrText> HYPERLINK "http://x" </w:instrText></w:r><w:r><w:delText>gone</w:delText></w:r><w:r><w:t>26</w:t></w:r><w:r><w:tab/><w:t>Reuters</w:t></w:r></w:p>',
  p(null, 'Body text of the card.'),
  '<w:p/>',
  '<w:tbl><w:tr><w:tc><w:p><w:pPr><w:pStyle w:val="Heading4"/></w:pPr><w:r><w:t>not a tag (table)</w:t></w:r></w:p></w:tc></w:tr></w:tbl>',
  p('KindaTag', 'Second tag'),
  '<w:sdt><w:sdtContent>' + p(null, 'Smith &#8217;24') + '</w:sdtContent></w:sdt>',
  p('Heading3', 'Next block'),
  p('Heading4', ''),
  p('Heading4', 'Third tag'),
].join('');
const DOC = `<?xml version="1.0"?><w:document xmlns:w="w"><w:body>${BODY}<w:sectPr><w:pgSz w:w="12240"/></w:sectPr></w:body></w:document>`;

test('heading levels come from styles.xml: outlineLvl, "heading N" names, and basedOn chains', () => {
  const lv = headingLevels(STYLES);
  assert.deepEqual([lv.get('Heading1'), lv.get('Heading2'), lv.get('Heading3'), lv.get('Heading4'), lv.get('KindaTag')], [1, 2, 3, 4, 4]);
  assert.equal(lv.get('Undertag'), undefined);
  assert.equal(lv.get('Heading4Char'), undefined, 'character styles are not paragraph headings');
  assert.equal(headingLevels('').get('Heading4'), 4, 'no styles.xml: fall back to HeadingN ids');
});

test('parseCards: tags with their cite and block path; field codes, deletions, tables and empty tags skipped', () => {
  const cards = parseCards(DOC, STYLES);
  assert.deepEqual(cards.map((c) => [c.tag, c.cite, c.headings]), [
    ['Data centers stay onshore & grow', 'Rogan 26 Reuters', ['AFF', 'Grid', 'AT: Offshoring']],
    ['Second tag', 'Smith ’24', ['AFF', 'Grid', 'AT: Offshoring']],
    ['Third tag', '', ['AFF', 'Grid', 'Next block']],
  ]);
  assert.deepEqual(cards.map((c) => c.ordinal), [0, 1, 2]);
  assert.equal(cards[0].quote, 'Data centers stay onshore & grow');
  assert.ok(cards[1].approxPos > cards[0].approxPos);
});

test('zip round trip, and a non-zip file is an error, not a crash', () => {
  const buf = docx({ 'word/document.xml': DOC, 'word/styles.xml': STYLES, '[Content_Types].xml': '<Types/>' });
  const z = readZip(buf);
  assert.deepEqual([...z.keys()].sort(), ['[Content_Types].xml', 'word/document.xml', 'word/styles.xml']);
  assert.equal(unzipEntry(z.get('word/document.xml')).toString(), DOC);
  assert.throws(() => readZip(Buffer.from('not a zip at all')), /bad_zip/);
});

test('cardDocx keeps only that card (tag to the next heading) plus page setup; everything else copied', () => {
  const buf = docx({ 'word/document.xml': DOC, 'word/styles.xml': STYLES, '[Content_Types].xml': '<Types/>' });
  const out = readZip(cardDocx(buf, 0));
  const xml = unzipEntry(out.get('word/document.xml')).toString();
  assert.match(xml, /^<\?xml version="1.0"\?><w:document xmlns:w="w"><w:body><w:p>/);
  assert.match(xml, /onshore &amp; grow/);
  assert.match(xml, /Body text of the card/);
  assert.match(xml, /not a tag \(table\)/, 'tables inside the card stay');
  assert.doesNotMatch(xml, /AT: Offshoring|Second tag|AFF/);
  assert.match(xml, /<w:sectPr><w:pgSz w:w="12240"\/><\/w:sectPr><\/w:body><\/w:document>$/);
  assert.equal(unzipEntry(out.get('word/styles.xml')).toString(), STYLES);
  const second = unzipEntry(readZip(cardDocx(buf, 1)).get('word/document.xml')).toString();
  assert.match(second, /Second tag[\s\S]*Smith &#8217;24/);
  assert.doesNotMatch(second, /Next block/);
  assert.throws(() => cardDocx(buf, 9), /no_card/);
  assert.throws(() => cardDocx(buf, 1, 'Data centers stay onshore & grow'), /card_changed/);
  assert.ok(cardDocx(buf, 1, 'Second tag'));
});

test('headingsOf lists pocket/hat/block headings in order with their levels', () => {
  const buf = docx({ 'word/document.xml': DOC, 'word/styles.xml': STYLES });
  assert.deepEqual(headingsOf(buf), [{ level: 1, text: 'AFF' }, { level: 2, text: 'Grid' }, { level: 3, text: 'AT: Offshoring' }, { level: 3, text: 'Next block' }]);
});

test('boldEmphasis: CardMirror\'s Emphasis becomes bold in the document\'s font with no italics; nothing else changes', () => {
  const CM = `<w:styles><w:style w:type="character" w:styleId="Emphasis"><w:name w:val="Emphasis"/><w:rPr>
      <w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:cs="Times New Roman"/>
      <w:b w:val="0"/>
      <w:i w:val="0"/>
      <w:iCs/>
      <w:sz w:val="22"/>
      <w:u w:val="single"/>
      <w:bdr w:val="single" w:sz="8" w:space="0" w:color="auto"/>
    </w:rPr></w:style><w:style w:type="character" w:styleId="StyleUnderline"><w:rPr><w:rFonts w:ascii="Times New Roman"/><w:b w:val="0"/><w:u w:val="single"/></w:rPr></w:style></w:styles>`;
  const buf = docx({ 'word/document.xml': DOC, 'word/styles.xml': CM });
  const out = boldEmphasis(buf);
  const styles = unzipEntry(readZip(out).get('word/styles.xml')).toString();
  const emph = /w:styleId="Emphasis">[\s\S]*?<\/w:style>/.exec(styles)[0];
  assert.match(emph, /<w:b\/><w:bCs\/>/);
  assert.match(emph, /<w:i w:val="0"\/>/);
  assert.match(emph, /<w:u w:val="single"\/>[\s\S]*<w:bdr /, 'underline and box kept');
  assert.doesNotMatch(emph, /rFonts|iCs|Times New Roman/, 'no forced font, no complex-script italics');
  assert.match(styles, /w:styleId="StyleUnderline"><w:rPr><w:rFonts w:ascii="Times New Roman"\/><w:b w:val="0"\/>/, 'other styles untouched');
  assert.equal(unzipEntry(readZip(out).get('word/document.xml')).toString(), DOC);
  assert.equal(boldEmphasis(out), out, 'already fixed: unchanged');
  const noRpr = docx({ 'word/document.xml': DOC, 'word/styles.xml': '<w:styles><w:style w:type="character" w:styleId="Emphasis"><w:name w:val="Emphasis"/></w:style></w:styles>' });
  assert.match(unzipEntry(readZip(boldEmphasis(noRpr)).get('word/styles.xml')).toString(), /<w:rPr><w:b\/><w:bCs\/><w:i w:val="0"\/><\/w:rPr><\/w:style>/);
  const plain = docx({ 'word/document.xml': DOC, 'word/styles.xml': STYLES });
  assert.equal(boldEmphasis(plain), plain, 'no Emphasis style: unchanged');
  const notZip = Buffer.from('docx-bytes');
  assert.equal(boldEmphasis(notZip), notZip);
});
