// Round reports are free text, but most follow "1AC -- Arg, Arg" lines and a
// "[W]" result. Pull out what this team read: its first constructive, its
// final speech, and the decision.

const SPEECH = /^\s*([12])\s*(AC|NC|AR|NR)\s*(?:--+|[-–—:])\s*(.*)$/i;
const FILLER = /^(all( down)?|same( as .*)?|everything else.*|x|-+)$/i;

// Commas inside parentheses belong to one argument: "Efficiency (bubble, AMRs)".
const items = (text) => text.split(/,(?![^(]*\))/)
  .map((s) => s.replace(/\s+/g, ' ').trim().replace(/[.;:]+$/, '').trim())
  .filter((s) => s && !FILLER.test(s));

function result(line) {
  const m = /^\[?([WL]{1,3})\]?(?![a-z/&'])/i.exec(line.trim()); // not "w/ the perm"
  if (!m) return null;
  const letters = m[1].toUpperCase();
  const w = [...letters].filter((c) => c === 'W').length;
  return w * 2 > letters.length ? 'W' : 'L';
}

export function parseReport(report, side) {
  const out = { own: [], final: [], result: null };
  const mine = side === 'A' ? ['AC', 'AR'] : side === 'N' ? ['NC', 'NR'] : [];
  for (const line of String(report ?? '').split('\n')) {
    const m = SPEECH.exec(line);
    if (m) {
      const kind = m[2].toUpperCase();
      if (m[1] === '1' && kind === mine[0]) out.own.push(...items(m[3]));
      if (m[1] === '2' && kind === mine[1]) out.final.push(...items(m[3]));
    } else if (!out.result) {
      out.result = result(line);
    }
  }
  return out;
}
