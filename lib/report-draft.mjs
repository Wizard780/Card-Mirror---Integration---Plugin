// Draft a caselist round report ("1AC -- False Profits, Fool's Gold") from the
// round's docs. Teams label speeches in their headings, before or after the
// argument name ("1AC---False Profits", "Spark---AT: ASI---2NC"); a label on a
// parent heading covers the headings under it.

const ORDER = ['1AC', '1NC', '2AC', '2NC', '1AR', '1NR', '2AR', '2NR'];
const CODE = /(?<![A-Za-z0-9])([12])\s?(AC|NC|AR|NR)(?![A-Za-z0-9])/i;
const SEPS = /^[\s\-—–:|]+|[\s\-—–:|]+$/g;
const FILLER = /^(o\/?v|overview|top ?level|contact.*|info.*)$/i;

export function speechCode(text) {
  const m = CODE.exec(String(text ?? ''));
  if (!m) return null;
  const before = m.input.slice(0, m.index).replace(SEPS, '');
  const after = m.input.slice(m.index + m[0].length).replace(SEPS, '');
  return { code: `${m[1]}${m[2].toUpperCase()}`, name: [before, after].filter(Boolean).join('---') };
}

// headings: [{level 1-3, text}] in document order → { code: [argument names] }.
// Only the innermost headings are arguments; the ones above them are containers.
export function sectionsOf(headings, fileName = '') {
  const hs = headings.map((h) => ({ ...h, text: String(h.text ?? '').trim() }));
  const anyCode = hs.some((h) => speechCode(h.text));
  const fileCode = anyCode ? null : speechCode(fileName)?.code;
  const stack = []; // codes by level
  const out = {};
  hs.forEach((h, i) => {
    stack.length = h.level; // forget codes from this level down
    const own = speechCode(h.text);
    stack[h.level - 1] = own ? own.code : undefined;
    const code = own ? own.code : stack.slice(0, h.level - 1).reverse().find(Boolean) || fileCode;
    const next = hs[i + 1];
    if (!code || (next && next.level > h.level)) return; // container heading
    const name = own ? own.name : h.text;
    if (!name || FILLER.test(name)) return;
    (out[code] ||= []);
    if (!out[code].some((n) => n.toLowerCase() === name.toLowerCase())) out[code].push(name);
  });
  return out;
}

// docs: [{name, headings}] → { report, used: names of docs that contributed }
export function draftReport(docs) {
  const merged = {};
  const used = [];
  for (const d of docs) {
    const s = sectionsOf(d.headings, d.name);
    if (!Object.keys(s).length) continue;
    used.push(d.name);
    for (const [code, names] of Object.entries(s)) {
      merged[code] ||= [];
      for (const n of names) if (!merged[code].some((x) => x.toLowerCase() === n.toLowerCase())) merged[code].push(n);
    }
  }
  const report = ORDER.filter((c) => merged[c]).map((c) => `${c} -- ${merged[c].join(', ')}`).join('\n');
  return { report, used };
}
