// Card Check: compare a card with the source its cite links to. Reports what it
// sees (text not found, joins, highlighting that skips a qualifier, cite vs page);
// it never calls a card fake. Pure functions; fetching lives in fetchsafe.mjs.

// ---------------------------------------------------------------- text
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', hellip: '…' };
const safeChar = (n) => (Number.isInteger(n) && n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '\ufffd');
export const decodeEntities = (s) => String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, e) => (e[0] === '#'
  ? safeChar(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1)))
  : ENT[e.toLowerCase()] ?? all));

// Words for matching: case, quotes, dashes, ligatures, soft hyphens, line-break
// hyphenation and footnote numbers glued to words all stop mattering.
export function words(text) {
  return String(text ?? '')
    .normalize('NFKC')
    .replace(/­/g, '')
    .replace(/(\w)-\s*\n\s*(\w)/g, '$1$2')
    .toLowerCase()
    .replace(/[’‘`´]/g, "'")
    .replace(/([a-z][.,;:]?)\d{1,3}(?=\s|$)/g, '$1') // "growth.12" / "growth12" footnote markers
    .match(/[a-z0-9]+(?:'[a-z]+)?/g) || [];
}

// Drops comments and script/style/svg/... blocks. A linear scan: the lazy-regex version
// rescanned to the end of the page for every unclosed tag (seconds on hostile pages).
function stripBlocks(html) {
  const open = /<!--|<(script|style|noscript|svg|template|iframe)\b/gi;
  let out = '';
  let at = 0;
  for (let m; (m = open.exec(html));) {
    // Case-insensitive search on the page itself (lowercasing can change string length).
    const closeRe = m[1] ? new RegExp(`</${m[1]}\\s*>`, 'gi') : /-->/g;
    closeRe.lastIndex = m.index + m[0].length;
    const hit = closeRe.exec(html);
    const end = hit ? hit.index : -1;
    out += `${html.slice(at, m.index)} `;
    at = end === -1 ? html.length : end + hit[0].length;
    if (end === -1) break; // unclosed: the rest is inside it
    open.lastIndex = at;
  }
  return out + html.slice(at);
}

export function htmlToText(html) {
  return decodeEntities(stripBlocks(String(html))
    .replace(/<(br|\/p|\/div|\/li|\/h\d|\/tr)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' '))
    .replace(/[ \t\r\f\v]+/g, ' ');
}

// Publication year from page metadata (meta tags or JSON-LD), when the page has one.
export function pageYear(html) {
  const s = String(html);
  const pats = [
    /<meta[^>]+(?:property|name|itemprop)=["'](?:article:published_time|citation_publication_date|citation_date|dc\.date|datePublished|date|pubdate|publish-date|sailthru\.date|parsely-pub-date)["'][^>]*content=["']([^"']+)/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]*(?:property|name|itemprop)=["'](?:article:published_time|citation_publication_date|citation_date|dc\.date|datePublished|date|pubdate)["']/i,
    /"datePublished"\s*:\s*"([^"]+)"/i,
  ];
  for (const p of pats) {
    const m = p.exec(s);
    const y = m && /\b(19|20)\d{2}\b/.exec(m[1]);
    if (y) return Number(y[0]);
  }
  return null;
}

export function urlsIn(text) {
  return [...new Set((String(text ?? '').match(/https?:\/\/[^\s<>"'\]]+/g) || []).map((u) => u.replace(/[.,;:)\]]+$/, '')))];
}

// ---------------------------------------------------------------- cite
// "Chen et al. '25 [Xin; …]" → { author: 'chen', year: 2025 }
export function citeParts(cite) {
  const s = String(cite ?? '').trim();
  const a = /^[^A-Za-z]*([A-Z][A-Za-z'’-]{1,})/.exec(s);
  const short = /(?:’|'|‘)(\d{2})\b/.exec(s);
  const long = /\b(19\d{2}|20\d{2})\b/.exec(s);
  let year = null;
  if (short && (!long || short.index < long.index)) year = 2000 + Number(short[1]) > new Date().getFullYear() + 1 ? 1900 + Number(short[1]) : 2000 + Number(short[1]);
  else if (long) year = Number(long[1]);
  else { const bare = /\b(\d{2})\b/.exec(s.slice(0, 40)); if (bare && a && bare.index < 30) year = 2000 + Number(bare[1]); }
  return { author: a ? a[1].toLowerCase().replace(/[’']s$/, '') : null, year };
}

// ---------------------------------------------------------------- compare
const sentences = (text) => String(text).split(/(?<=[.!?…])\s+|\n+/).map((s) => s.trim()).filter(Boolean);
const grams = (ws, n = 3) => { const out = []; for (let i = 0; i + n <= ws.length; i++) out.push(ws.slice(i, i + n).join(' ')); return out; };

// What the card claims the source says: drop condense notes (<<TEXT CONDENSED…>>),
// bracketed insertions ([the US]) and the cutter's own "---" note lines.
export function cardProse(text) {
  return String(text ?? '')
    .split('\n')
    .filter((line) => !/^\s*(---|—|–)/.test(line))
    .join('\n')
    .replace(/<<+[^<>]*>>+/g, ' ')
    .replace(/\[[^\]]{0,200}\]/g, ' ');
}

export function compare(cardText, sourceText) {
  cardText = cardProse(cardText);
  const src = words(sourceText);
  const index = new Map();
  grams(src).forEach((g, i) => { if (!index.has(g)) index.set(g, []); index.get(g).push(i); });
  let total = 0;
  let hit = 0;
  const parts = [];
  for (const sent of sentences(cardText)) {
    const ws = words(sent);
    if (ws.length < 4) continue;
    const gs = grams(ws);
    const at = [];
    for (const g of gs) { const pos = index.get(g); if (pos) at.push(pos); }
    total += gs.length;
    hit += at.length;
    const share = at.length / gs.length;
    // Where in the source: candidate start positions (each 3-gram votes for one), keeping
    // those with strong support; the nearest to where the previous sentence ended wins,
    // so text repeated in an abstract doesn't look out of order.
    let where = null;
    if (at.length) {
      const votes = new Map();
      gs.forEach((g, k) => { for (const p of index.get(g) || []) { const start = p - k; votes.set(start, (votes.get(start) || 0) + 1); } });
      const best = Math.max(...votes.values());
      const strong = [...votes].filter(([, v]) => v >= best * 0.6).map(([p]) => p);
      const prev = parts.filter((x) => x.where !== null).at(-1);
      const expect = prev ? prev.where + prev.words : 0;
      where = strong.sort((a, b) => Math.abs(a - expect) - Math.abs(b - expect))[0];
    }
    parts.push({ text: sent, share, where, words: ws.length });
  }
  const coverage = total ? hit / total : 0;
  const missing = parts.filter((p) => p.share < 0.5).map((p) => p.text);
  // Text the card runs together that sits far apart (or out of order) in the source.
  const joins = [];
  // Only full sentences count: list fragments and headings repeat too often to place.
  const found = parts.filter((p) => p.share >= 0.8 && p.where !== null && p.words >= 10);
  for (let i = 1; i < found.length; i++) {
    const gap = found[i].where - (found[i - 1].where + found[i - 1].words);
    if (gap < -300 || gap > 400) joins.push({ after: found[i - 1].text, next: found[i].text, gapWords: gap });
  }
  // Sentences found whole: proof this page is the card's source even when much else is missing.
  const anchored = parts.filter((p) => p.share >= 0.8 && p.words >= 5).length;
  return { coverage, missing, joins, anchored, checked: parts.length, srcWords: src.length };
}

// ---------------------------------------------------------------- highlighting
const QUALIFIERS = new Set(['not', 'no', 'never', 'unless', 'except', 'might', 'may', 'could', 'unlikely', 'rarely', 'without', 'nor', 'neither', 'cannot', 'hardly']);
const isQualifier = (w) => QUALIFIERS.has(w) || /n't$/.test(w);

// runs: [{t, h}] (h = read aloud). Flags a qualifier left unread with read words
// close on both sides of it in the same sentence: "AI will [not] cause war".
export function skippedQualifiers(runs) {
  const toks = [];
  for (const r of runs) {
    for (const piece of String(r.t).split(/(\s+|(?<=[.!?])(?=\s))/)) {
      if (/[.!?]$/.test(piece.trim())) { for (const w of words(piece)) toks.push({ w, h: !!r.h }); toks.push({ stop: true }); continue; }
      for (const w of words(piece)) toks.push({ w, h: !!r.h });
    }
  }
  const out = [];
  toks.forEach((t, i) => {
    if (t.stop || t.h || !isQualifier(t.w)) return;
    if (t.w === 'not' && toks[i + 1] && toks[i + 1].w === 'only') return; // "not only X but also Y" keeps its meaning
    const near = (dir) => { for (let k = 1; k <= 3; k++) { const n = toks[i + dir * k]; if (!n || n.stop) return false; if (n.h) return true; } return false; };
    if (near(-1) && near(1)) {
      const ctx = toks.slice(Math.max(0, i - 5), i + 6).filter((x) => !x.stop).map((x) => (x === t ? `[${x.w}]` : x.w)).join(' ');
      out.push({ word: t.w, context: ctx });
    }
  });
  return out;
}

// ---------------------------------------------------------------- verdict
export function verdict({ result, source, cite }) {
  const issues = [];
  if (!result) return { status: source && source.error ? 'unreachable' : 'no_link', issues };
  const pct = Math.round(result.coverage * 100);
  if (!result.checked) return { status: 'unverified', issues: ['The card has no full sentences to compare with the source.'] };
  if (result.coverage < 0.5 && !result.anchored) {
    return { status: 'unverified', issues: [`Only ${pct}% of the card was found on the page (paywall, a different version, or the wrong link).`] };
  }
  for (const m of result.missing.slice(0, 5)) issues.push(`Not found in the source: "${m.length > 140 ? `${m.slice(0, 140)}…` : m}"`);
  for (const j of result.joins.slice(0, 3)) {
    issues.push(j.gapWords < 0
      ? `Out of source order: "${short(j.next)}" comes before "${short(j.after)}" in the source.`
      : `Joins text ~${j.gapWords} words apart in the source after "${short(j.after)}".`);
  }
  const { author, year } = citeParts(cite);
  const apos = (x) => x.replace(/[’‘`´]/g, "'");
  const page = apos(source.textLower || '');
  if (author && author.length > 2 && page && !page.includes(apos(author))) issues.push(`Author "${author}" isn't named on the page.`);
  if (year >= 1990 && source.year && source.year !== year) issues.push(`Cite says ${year}; the page is dated ${source.year}.`);
  return { status: issues.length ? 'differences' : 'matches', issues, coverage: pct };
}
const short = (s) => (s.length > 60 ? `${s.slice(0, 60)}…` : s);
