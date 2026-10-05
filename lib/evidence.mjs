// Local evidence search: an index of every card (tag, cite, pocket/hat/block)
// in the folders the user picked. Rescans read only files whose mtime or size
// changed; the index is saved as JSON so a restart doesn't re-read everything.
import { readdir, readFile, stat, writeFile, rename, mkdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { readZip, unzipEntry, parseCards } from './docx.mjs';

const SEP = '\u0001';

function parseFile(buf) {
  const zip = readZip(buf);
  const doc = zip.get('word/document.xml');
  if (!doc) throw new Error('bad_zip');
  const styles = zip.get('word/styles.xml');
  const cards = parseCards(unzipEntry(doc).toString('utf8'), styles ? unzipEntry(styles).toString('utf8') : '')
    .map((c) => [c.tag.slice(0, 400), c.cite, c.headings.join(SEP), c.quote, c.approxPos]);
  // Sliced strings keep the whole document.xml alive; copy them out (GBs otherwise).
  return JSON.parse(JSON.stringify(cards));
}

async function walk(dir, out) {
  let ents;
  try { ents = await readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    if (e.name.startsWith('.') || e.isSymbolicLink()) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) await walk(p, out);
    else if (e.isFile() && /\.docx$/i.test(e.name) && !e.name.startsWith('~$')) out.push(p);
  }
}

export function createEvidenceIndex({ file, onRead = () => {} }) {
  let folders = [];
  let files = new Map(); // path → { mtime, size, bad, cards: [[tag, cite, headings, quote, approxPos]] }
  let hay = null; // lazily built: [{ path, i, text }]
  let scanning = null;
  let progress = { done: 0, total: 0 };
  let scannedAt = 0;
  let loaded = false;

  async function load() {
    if (loaded) return;
    loaded = true;
    try {
      const saved = JSON.parse(await readFile(file, 'utf8'));
      if (saved.version !== 1) return;
      folders = saved.folders || [];
      scannedAt = saved.scannedAt || 0;
      files = new Map(saved.files.map(([p, mtime, size, bad, cards]) => [p, { mtime, size, bad, cards }]));
      hay = null;
    } catch { /* no index yet */ }
  }

  async function save() {
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify({ version: 1, folders, scannedAt, files: [...files].map(([p, f]) => [p, f.mtime, f.size, f.bad, f.cards]) }), { mode: 0o600 });
    await rename(tmp, file);
  }

  async function doScan(want) {
    await load();
    folders = [...want];
    const paths = [];
    for (const dir of want) await walk(dir, paths);
    progress = { done: 0, total: paths.length };
    const next = new Map();
    for (const p of paths) {
      try {
        const st = await stat(p);
        const old = files.get(p);
        if (old && old.mtime === st.mtimeMs && old.size === st.size) next.set(p, old);
        else {
          onRead(p);
          let cards = [];
          let bad = false;
          // Sync read (async readFile is ~25x slower on big .docx files), then yield so
          // other requests keep flowing during a long scan.
          try { cards = parseFile(readFileSync(p)); } catch { bad = true; }
          await new Promise((r) => setImmediate(r));
          next.set(p, { mtime: st.mtimeMs, size: st.size, bad, cards });
        }
      } catch { /* vanished mid-scan */ }
      progress.done++;
    }
    files = next;
    hay = null;
    scannedAt = Date.now();
    await save();
  }

  // One scan at a time: a second request joins the one in flight.
  function scan(want) {
    if (!scanning) scanning = doScan(want).finally(() => { scanning = null; });
    return scanning;
  }

  function haystack() {
    if (hay) return hay;
    hay = [];
    for (const [path, f] of files) {
      const name = basename(path).toLowerCase();
      f.cards.forEach(([tag, cite, heads], i) => {
        hay.push({ path, i, tag: tag.toLowerCase(), cite: cite.toLowerCase(), heads: heads.toLowerCase(), name });
      });
    }
    return hay;
  }

  function search(query, limit = 50) {
    const words = String(query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return [];
    // A whole-word hit ("chen" in "Chen 25") outranks a fragment ("chen" in "kitchen");
    // ties go to real cards (with a cite) over analytics.
    const starts = words.map((w) => new RegExp(`(?:^|[^a-z0-9])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    const groups = new Map();
    for (const h of haystack()) {
      let score = 0;
      for (let k = 0; k < words.length; k++) {
        const w = words[k];
        let best = 0;
        for (const [text, weight] of [[h.tag, 3], [h.cite, 3], [h.heads, 1], [h.name, 1]]) {
          if (weight * 2 > best && text.includes(w)) best = Math.max(best, weight * (starts[k].test(text) ? 2 : 1));
        }
        if (!best) { score = 0; break; }
        score += best;
      }
      if (!score) continue;
      const key = `${h.tag}\n${h.cite}`;
      const g = groups.get(key);
      const mtime = files.get(h.path).mtime;
      if (!g) groups.set(key, { h, score, copies: 1, mtime });
      else {
        g.copies++;
        if (mtime > g.mtime) Object.assign(g, { h, mtime, score: Math.max(score, g.score) }); // open the newest copy
      }
    }
    return [...groups.values()]
      .sort((a, b) => b.score - a.score || !!b.h.cite - !!a.h.cite || b.copies - a.copies || a.h.tag.localeCompare(b.h.tag))
      .slice(0, limit)
      .map(({ h, copies }) => ({ ...card(h.path, h.i), copies }));
  }

  function card(path, i) {
    const [tag, cite, heads, quote, approxPos] = files.get(path).cards[i];
    return { path, ordinal: i, file: basename(path), tag, cite, headings: heads ? heads.split(SEP) : [], quote, approxPos };
  }

  function lookup(path, ordinal) {
    const f = files.get(path);
    return f && Number.isInteger(ordinal) && f.cards[ordinal] ? card(path, ordinal) : null;
  }

  function status() {
    let cards = 0;
    let unreadable = 0;
    for (const f of files.values()) { cards += f.cards.length; if (f.bad) unreadable++; }
    return { folders, files: files.size, cards, unreadable, scanning: !!scanning, ...progress, scannedAt };
  }

  return { load, scan, search, lookup, status };
}
