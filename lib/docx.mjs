// Just enough .docx for evidence search: read the zip, find the cards (tag +
// cite + the pocket/hat/block above it), and write a one-card copy of a file.
import { inflateRawSync, deflateRawSync, crc32 } from 'node:zlib';

// ---------------------------------------------------------------- zip
export function readZip(buf) {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0 || eocd + 22 > buf.length) throw new Error('bad_zip');
  const entries = new Map();
  try {
    const count = buf.readUInt16LE(eocd + 10);
    let p = buf.readUInt32LE(eocd + 16);
    for (let i = 0; i < count; i++) {
      if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('bad_zip');
      const nameLen = buf.readUInt16LE(p + 28);
      const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
      const off = buf.readUInt32LE(p + 42);
      const csize = buf.readUInt32LE(p + 20);
      // The data starts after the LOCAL header, whose name/extra lengths can differ.
      const start = off + 30 + buf.readUInt16LE(off + 26) + buf.readUInt16LE(off + 28);
      entries.set(name, {
        name, flags: buf.readUInt16LE(p + 8), method: buf.readUInt16LE(p + 10), time: buf.readUInt16LE(p + 12), date: buf.readUInt16LE(p + 14),
        crc: buf.readUInt32LE(p + 16), usize: buf.readUInt32LE(p + 24), data: buf.subarray(start, start + csize),
      });
      p += 46 + nameLen + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
    }
  } catch {
    throw new Error('bad_zip');
  }
  return entries;
}

export function unzipEntry(e) {
  if (e.method === 0) return e.data;
  if (e.method === 8) return inflateRawSync(e.data);
  throw new Error('bad_zip');
}

export function writeZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const flags = (e.flags || 0) & ~0x8 & 0xffff; // sizes are known: no data descriptor
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0); head.writeUInt16LE(20, 4); head.writeUInt16LE(flags, 6); head.writeUInt16LE(e.method, 8);
    head.writeUInt16LE(e.time || 0, 10); head.writeUInt16LE(e.date || 0x21, 12); head.writeUInt32LE(e.crc >>> 0, 14);
    head.writeUInt32LE(e.data.length, 18); head.writeUInt32LE(e.usize, 22); head.writeUInt16LE(name.length, 26);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0); cen.writeUInt16LE(20, 4); cen.writeUInt16LE(20, 6); cen.writeUInt16LE(flags, 8); cen.writeUInt16LE(e.method, 10);
    cen.writeUInt16LE(e.time || 0, 12); cen.writeUInt16LE(e.date || 0x21, 14); cen.writeUInt32LE(e.crc >>> 0, 16); cen.writeUInt32LE(e.data.length, 20);
    cen.writeUInt32LE(e.usize, 24); cen.writeUInt16LE(name.length, 28); cen.writeUInt32LE(offset, 42);
    locals.push(head, name, e.data);
    centrals.push(cen, name);
    offset += 30 + name.length + e.data.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

// ---------------------------------------------------------------- styles
// styleId → heading level 1-4 (pocket, hat, block, tag), from outlineLvl or a
// "heading N" name, following basedOn ("KindaTag" based on Heading4 is a tag).
export function headingLevels(stylesXml) {
  const own = new Map();
  const base = new Map();
  for (const m of String(stylesXml || '').matchAll(/<w:style\b([^>]*)>([\s\S]*?)<\/w:style>/g)) {
    if (!/w:type="paragraph"/.test(m[1])) continue;
    const id = /w:styleId="([^"]+)"/.exec(m[1]);
    if (!id) continue;
    const ol = /<w:outlineLvl w:val="(\d)"/.exec(m[2]);
    const name = /<w:name w:val="heading (\d)"/i.exec(m[2]);
    const lvl = ol ? Number(ol[1]) + 1 : name ? Number(name[1]) : 0;
    if (lvl) own.set(id[1], lvl);
    const b = /<w:basedOn w:val="([^"]+)"/.exec(m[2]);
    if (b) base.set(id[1], b[1]);
  }
  const levels = new Map();
  for (const id of new Set([...own.keys(), ...base.keys()])) {
    let cur = id;
    for (let hops = 0; cur && hops < 10; hops++, cur = base.get(cur)) {
      if (own.has(cur)) { if (own.get(cur) <= 4) levels.set(id, own.get(cur)); break; }
    }
  }
  if (!own.size) for (let n = 1; n <= 4; n++) levels.set(`Heading${n}`, n);
  return levels;
}

// ---------------------------------------------------------------- body
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const decode = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (all, e) => (e[0] === '#'
  ? String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1)))
  : ENTITIES[e] ?? all));

// Visible text: w:t only (not field codes or tracked deletions); tabs/breaks as \t.
function blockText(xml) {
  let out = '';
  for (const m of xml.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<w:(?:tab|br|cr)\/>|<w:(?:tab|br|cr)\s(?![^>]*w:val=)[^>]*\/>/g)) {
    out += m[1] !== undefined ? decode(m[1]) : '\t';
  }
  return out;
}
const clean = (s) => s.replace(/\s+/g, ' ').trim();

// Top-level body blocks (paragraphs and tables). Paragraphs nested in tables or
// text boxes belong to their block; content controls (w:sdt) are see-through.
function bodyBlocks(xml) {
  const bodyAt = xml.indexOf('<w:body>');
  const blocks = [];
  if (bodyAt < 0) return { blocks, bodyStart: -1 };
  const re = /<(\/?)w:(p|tbl)(?=[\s>/])[^>]*?(\/?)>/g;
  re.lastIndex = bodyAt;
  let depth = 0;
  let start = 0;
  let kind = '';
  for (let m; (m = re.exec(xml));) {
    const [all, close, tag, self] = m;
    if (self) { if (depth === 0) blocks.push({ kind: tag, start: m.index, end: m.index + all.length }); continue; }
    if (!close) { if (depth++ === 0) { start = m.index; kind = tag; } continue; }
    if (--depth === 0) blocks.push({ kind, start, end: m.index + all.length });
    if (depth < 0) depth = 0;
  }
  return { blocks, bodyStart: bodyAt + '<w:body>'.length };
}

function cardsWithBlocks(docXml, stylesXml) {
  const levels = headingLevels(stylesXml);
  const { blocks, bodyStart } = bodyBlocks(docXml);
  const heads = ['', '', ''];
  const cards = [];
  let card = null;
  let pos = 0;
  blocks.forEach((b, i) => {
    const xml = docXml.slice(b.start, b.end);
    const raw = blockText(xml);
    const style = b.kind === 'p' ? /<w:pStyle w:val="([^"]+)"/.exec(xml)?.[1] : null;
    const level = style ? levels.get(style) || 0 : 0;
    if (level) {
      if (card) { card.endBlock = i; card = null; }
      const text = clean(raw);
      if (level < 4) { heads[level - 1] = text; heads.fill('', level); }
      else if (text) {
        const quote = (raw.split(/[\t\n]/).find((s) => s.trim()) || '').trim().slice(0, 60);
        card = { tag: text, cite: '', headings: heads.filter(Boolean), ordinal: cards.length, quote, approxPos: pos, startBlock: i, endBlock: blocks.length };
        cards.push(card);
      }
    } else if (card && !card.cite && !/undertag/i.test(style || '')) {
      card.cite = clean(raw).slice(0, 300);
    }
    pos += raw.length + 1;
  });
  return { cards, blocks, bodyStart };
}

export function parseCards(docXml, stylesXml) {
  return cardsWithBlocks(docXml, stylesXml).cards.map(({ startBlock, endBlock, ...c }) => c);
}

// A copy of the file holding just one card (with its formatting, styles and page setup).
export function cardDocx(buf, ordinal, expectTag) {
  const zip = readZip(buf);
  const docEntry = zip.get('word/document.xml');
  if (!docEntry) throw new Error('bad_zip');
  const xml = unzipEntry(docEntry).toString('utf8');
  const styles = zip.get('word/styles.xml') ? unzipEntry(zip.get('word/styles.xml')).toString('utf8') : '';
  const { cards, blocks, bodyStart } = cardsWithBlocks(xml, styles);
  const card = cards[ordinal];
  if (!card) throw new Error('no_card');
  if (expectTag !== undefined && !card.tag.startsWith(expectTag)) throw new Error('card_changed'); // edited since indexing (index keeps the first 400 chars)
  const from = blocks[card.startBlock].start;
  const to = blocks[card.endBlock - 1].end;
  const bodyEnd = xml.lastIndexOf('</w:body>');
  const sect = xml.lastIndexOf('<w:sectPr', bodyEnd);
  const tail = sect >= blocks[blocks.length - 1].end ? xml.slice(sect, bodyEnd) : '';
  const out = Buffer.from(xml.slice(0, bodyStart) + xml.slice(from, to) + tail + xml.slice(bodyEnd), 'utf8');
  const entries = [...zip.values()].map((e) => (e.name === 'word/document.xml'
    ? { ...e, method: 8, crc: crc32(out), usize: out.length, data: deflateRawSync(out) }
    : e));
  return writeZip(entries);
}

// Pocket/hat/block headings (levels 1-3) in order, for drafting round reports.
export function headingsOf(buf) {
  const zip = readZip(buf);
  const doc = zip.get('word/document.xml');
  if (!doc) throw new Error('bad_zip');
  const xml = unzipEntry(doc).toString('utf8');
  const levels = headingLevels(zip.get('word/styles.xml') ? unzipEntry(zip.get('word/styles.xml')).toString('utf8') : '');
  const out = [];
  for (const b of bodyBlocks(xml).blocks) {
    if (b.kind !== 'p') continue;
    const part = xml.slice(b.start, b.end);
    const style = /<w:pStyle w:val="([^"]+)"/.exec(part)?.[1];
    const level = style ? levels.get(style) : 0;
    if (level && level < 4) out.push({ level, text: clean(blockText(part)) });
  }
  return out;
}

// CardMirror saves the Emphasis character style with bold switched off (w:b w:val="0"),
// relying on its own on-screen look; Word, Google Docs and Pages then show emphasis as
// plain underline. Turning bold on in that one style fixes every emphasized word.
// Returns the same buffer when there's nothing to change (not a docx, no such style, already bold).
export function boldEmphasis(buf) {
  let zip;
  try { zip = readZip(buf); } catch { return buf; }
  const entry = zip.get('word/styles.xml');
  if (!entry) return buf;
  const xml = unzipEntry(entry).toString('utf8');
  const m = /(<w:style\b[^>]*w:styleId="Emphasis"[^>]*>)([\s\S]*?)(<\/w:style>)/.exec(xml);
  if (!m) return buf;
  let body = m[2];
  const rpr = /<w:rPr>([\s\S]*?)<\/w:rPr>/.exec(body);
  if (!rpr) body = body.replace(/$/, '<w:rPr><w:b/><w:bCs/></w:rPr>');
  else {
    let inner = rpr[1];
    if (/<w:b\s*\/>|<w:b w:val="(1|true|on)"\s*\/>/.test(inner)) return buf; // already bold
    inner = /<w:b\b[^>]*\/>/.test(inner) ? inner.replace(/<w:b\b[^>]*\/>/, '<w:b/>') : `<w:b/>${inner}`;
    if (!/<w:bCs\b/.test(inner)) inner = inner.replace('<w:b/>', '<w:b/><w:bCs/>');
    body = body.replace(rpr[0], `<w:rPr>${inner}</w:rPr>`);
  }
  const out = Buffer.from(xml.slice(0, m.index) + m[1] + body + m[3] + xml.slice(m.index + m[0].length), 'utf8');
  return writeZip([...zip.values()].map((e) => (e.name === 'word/styles.xml'
    ? { ...e, method: 8, crc: crc32(out), usize: out.length, data: deflateRawSync(out) }
    : e)));
}
