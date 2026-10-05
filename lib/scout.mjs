// Matching a Tabroom opponent ("Cranbrook FZ": school + debater initials) to a
// caselist team ("Cranbrook FoZh", debaters Fox & Zhang). Names rarely match
// exactly, so match on the debater pair and use the school only to break ties.

export function parseOpponent(opponent) {
  const words = String(opponent ?? '').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return { school: '', code: '' };
  const code = words.pop();
  return { school: words.join(' '), code };
}

// "FZ" → [F, Z]; "AlHu" → [A, H]; lowercase codes are read letter by letter.
function codeInitials(code) {
  const s = String(code ?? '');
  const chunks = /[A-Z]/.test(s) ? s.match(/[A-Z][a-z]*/g) || [] : s.split('');
  return chunks.map((c) => c[0].toUpperCase());
}

const sameLetters = (a, b) => a.length === b.length && [...a].sort().join() === [...b].sort().join();

export function codeMatches(code, team) {
  const want = codeInitials(code);
  if (want.length < 2) return false; // single letters (or the "All Teams" placeholder) are too loose
  const names = (team.debaters || []).filter(Boolean).map((n) => String(n).trim()[0].toUpperCase());
  if (names.length >= 2 && sameLetters(want, names)) return true;
  return sameLetters(want, codeInitials(team.team));
}

const FILLER = new Set(['high', 'school', 'hs', 'the', 'of', 'and', 'academy', 'prep', 'preparatory', 'independent', 'debate', 'speech', 'club', 'team', 'center']);
const words = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ').filter(Boolean);
const acronym = (ws) => ws.map((w) => w[0]).join('');

export function schoolScore(tabSchool, schoolLabel) {
  const allA = words(tabSchool);
  const allB = words(schoolLabel);
  const a = allA.filter((w) => !FILLER.has(w));
  const b = allB.filter((w) => !FILLER.has(w));
  if (!a.length || !b.length) return 0;
  const ja = a.join('');
  const jb = b.join('');
  let score = 0;
  if (ja === jb) score += 10;
  else if (ja.includes(jb) || jb.includes(ja)) score += 6;
  score += a.filter((w) => b.includes(w)).length * 3;
  if (allB.length > 1 && a.includes(acronym(allB))) score += 4; // "VDA" ↔ "Vancouver Debate Academy"
  if (allA.length > 1 && b.includes(acronym(allA))) score += 4;
  return score;
}

// teams: [{school, schoolLabel, team, label, debaters}] from the likeliest schools.
export function pickTeam(opponent, teams) {
  const { school, code } = parseOpponent(opponent);
  const scored = teams.map((t, i) => ({ t, i, s: schoolScore(school, t.schoolLabel) }));
  const bySchool = (x, y) => y.s - x.s || x.i - y.i;
  const matches = scored.filter(({ t }) => codeMatches(code, t)).sort(bySchool);
  if (matches.length === 1) return { match: matches[0].t, candidates: [matches[0].t] };
  if (matches.length > 1) {
    if (matches[0].s > matches[1].s) return { match: matches[0].t, candidates: matches.map(({ t }) => t) };
    return { match: null, candidates: matches.map(({ t }) => t) };
  }
  return { match: null, candidates: scored.sort(bySchool).map(({ t }) => t) };
}
