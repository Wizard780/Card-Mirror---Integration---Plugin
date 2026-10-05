import { parseReport } from './report.mjs';

export const CASELIST_BASE = 'https://api.opencaselist.com/v1';

async function request(fetchImpl, url, init, timeoutMs) {
  try {
    return await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch {
    throw new Error('unreachable');
  }
}

async function json(res) {
  try { return await res.json(); } catch { throw new Error('bad_response'); }
}

export async function login({ username, password }, { fetchImpl = fetch, base = CASELIST_BASE, timeoutMs = 20_000 } = {}) {
  if (!username || !password) throw new Error('bad_login');
  const res = await request(fetchImpl, `${base}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password, remember: true }),
  }, timeoutMs);
  if ([400, 401, 403].includes(res.status)) throw new Error('bad_login');
  if (!res.ok) throw new Error(`http_${res.status}`);
  const body = await json(res);
  if (typeof body?.token !== 'string' || !body.token) throw new Error('bad_response');
  return { token: body.token, expires: body.expires ?? null };
}

const shape = (r) => ({
  id: r.id, tournament: r.tournament ?? '', round: r.round ?? '', side: r.side ?? '',
  opponent: r.opponent ?? '', judge: r.judge ?? '', start_time: r.start_time ?? null,
});

const defaults = ({ fetchImpl = fetch, base = CASELIST_BASE, timeoutMs = 20_000 } = {}) => ({ fetchImpl, base, timeoutMs });
const seg = (s) => encodeURIComponent(String(s ?? ''));

async function authedList({ fetchImpl, base, timeoutMs }, token, path) {
  const res = await request(fetchImpl, `${base}${path}`, { headers: { Cookie: `caselist_token=${token}` } }, timeoutMs);
  if (res.status === 401) throw new Error('login_expired');
  if (!res.ok) throw new Error(`http_${res.status}`);
  const body = await json(res);
  if (!Array.isArray(body)) throw new Error('bad_response');
  return body;
}

export async function getRounds(token, opts) {
  const o = defaults(opts);
  const current = (await authedList(o, token, '/tabroom/rounds?current=true')).map(shape);
  if (current.length) return { current: true, rounds: current };
  const all = (await authedList(o, token, '/tabroom/rounds')).map(shape);
  all.sort((a, b) => (Date.parse(b.start_time) || 0) - (Date.parse(a.start_time) || 0));
  return { current: false, rounds: all.slice(0, 10) };
}

const choice = (x) => {
  const name = String(x?.name ?? x?.slug ?? '');
  const out = { name, label: String(x?.display_name ?? name) };
  if (x?.event) out.event = String(x.event);
  return out;
};

export async function listCaselists(token, opts) {
  return (await authedList(defaults(opts), token, '/caselists'))
    .filter((c) => c && !c.archived).map(choice).filter((c) => c.name);
}

export async function listSchools(token, caselist, opts) {
  return (await authedList(defaults(opts), token, `/caselists/${seg(caselist)}/schools`)).map(choice).filter((c) => c.name);
}

export async function listTeams(token, caselist, school, opts) {
  return (await authedList(defaults(opts), token, `/caselists/${seg(caselist)}/schools/${seg(school)}/teams`)).map(choice).filter((c) => c.name);
}

export function normalizeSide(side) {
  const s = String(side ?? '').trim().toLowerCase();
  if (['a', 'aff', 'pro'].includes(s)) return 'A';
  if (['n', 'neg', 'con'].includes(s)) return 'N';
  return null;
}

// Body matches Verbatim's UploadToCaselist exactly (opensource + filename).
export async function createRound(token, { caselist, school, team }, { tournament, side, round, opponent, judge, report, filename, base64 }, opts) {
  const o = defaults({ timeoutMs: 60_000, ...opts });
  const t = String(tournament ?? '').trim();
  const r = String(round ?? '').trim();
  const sd = normalizeSide(side);
  if (!t || !r || !sd) throw new Error('bad_round');
  if (!filename || !base64) throw new Error('no_file');
  if (!caselist || !school || !team) throw new Error('no_team');
  const body = {
    tournament: t, side: sd, round: r,
    opponent: String(opponent ?? '').trim(), judge: String(judge ?? '').trim(), report: String(report ?? '').trim(),
    opensource: base64, filename,
  };
  let res;
  try {
    res = await o.fetchImpl(`${o.base}/caselists/${seg(caselist)}/schools/${seg(school)}/teams/${seg(team)}/rounds`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: `caselist_token=${token}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(o.timeoutMs),
    });
  } catch {
    throw new Error('upload_unknown');
  }
  if (res.status === 401) throw new Error('login_expired');
  if (res.status === 200 || res.status === 201) return { filename };
  if (res.status >= 500) throw new Error('upload_unknown');
  let msg = `http_${res.status}`;
  try { const b = await res.json(); if (b?.message) msg = String(b.message); } catch {}
  throw new Error(`caselist_rejected:${msg}`);
}

export async function searchTeams(token, caselist, q, opts) {
  const query = String(q ?? '').trim();
  if (!query) return [];
  const rows = await authedList(defaults(opts), token, `/search?q=${encodeURIComponent(query)}&shard=${encodeURIComponent(caselist)}`);
  const seen = new Set();
  const out = [];
  for (const r of rows) {
    if (!r || r.type !== 'team' || !r.school || !r.team) continue;
    const key = `${r.school}/${r.team}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ school: String(r.school), team: String(r.team), label: String(r.team_display_name ?? `${r.school} ${r.team}`), schoolLabel: String(r.school_display_name ?? r.school) });
  }
  return out;
}

const roundShape = (r) => ({
  id: r.round_id, side: r.side ?? '', tournament: r.tournament ?? '', round: r.round ?? '', opponent: r.opponent ?? '',
  judge: r.judge ?? '', report: r.report ?? '', opensource: r.opensource || null, video: r.video || null,
  updated: r.updated_at || r.created_at || null,
  parsed: parseReport(r.report, r.side),
});
const citeShape = (c) => ({
  id: c.cite_id, roundId: c.round_id ?? null, title: c.title ?? '', cites: c.cites ?? '',
  side: c.side ?? '', tournament: c.tournament ?? '', round: c.round ?? '',
});

// openCaselist's own order: tournaments carry a sequence prefix ("03 -- Mid America Cup",
// "03---Jack Howe"); newest tournament first, then the latest round first.
const ELIMS = ['triples', 'doubles', 'octas', 'quarters', 'semis', 'finals'];
const tournamentNo = (t) => { const m = /^\s*(\d+)/.exec(String(t ?? '')); return m ? Number(m[1]) : -1; };
function roundRank(round) {
  const r = String(round ?? '').trim().toLowerCase();
  if (/^\d+$/.test(r)) return Number(r);
  const e = ELIMS.findIndex((x) => r.startsWith(x));
  if (e !== -1) return 100 + e; // every elim after every prelim
  if (r === 'runoff' || r === 'runoffs') return 99;
  return 0; // "All", unknown
}
const caselistOrder = (a, b) => tournamentNo(b.tournament) - tournamentNo(a.tournament)
  || roundRank(b.round) - roundRank(a.round)
  || (Date.parse(b.updated) || 0) - (Date.parse(a.updated) || 0);

export async function getTeam(token, caselist, school, team, opts) {
  const o = defaults(opts);
  const base = `/caselists/${seg(caselist)}/schools/${seg(school)}/teams/${seg(team)}`;
  const [rounds, cites] = await Promise.all([authedList(o, token, `${base}/rounds`), authedList(o, token, `${base}/cites`)]);
  return {
    rounds: rounds.map(roundShape).sort(caselistOrder),
    cites: cites.map(citeShape),
  };
}

export async function downloadOpenSource(token, path, opts) {
  const o = defaults({ timeoutMs: 60_000, ...opts });
  let res;
  try {
    res = await o.fetchImpl(`${o.base}/download?path=${encodeURIComponent(path)}`, { headers: { Cookie: `caselist_token=${token}` }, signal: AbortSignal.timeout(o.timeoutMs) });
  } catch {
    throw new Error('download_failed');
  }
  if (res.status === 401) throw new Error('login_expired');
  if (!res.ok) throw new Error('download_failed');
  const header = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') || '');
  const raw = header ? header[1] : String(path);
  const filename = raw.split(/[\\/]/).pop() || 'caselist.docx';
  return { filename, bytes: Buffer.from(await res.arrayBuffer()) };
}

// Teams with their debaters, for matching Tabroom codes ("Cranbrook FZ") to caselist teams.
export async function listTeamsDetailed(token, caselist, school, opts) {
  const rows = await authedList(defaults(opts), token, `/caselists/${seg(caselist)}/schools/${seg(school)}/teams`);
  const slots = [1, 2, 3, 4];
  return rows.filter((r) => r && r.name).map((r) => ({
    school: String(school),
    team: String(r.name),
    label: String(r.display_name ?? r.name),
    debaters: slots.map((n) => r[`debater${n}_last`]).filter(Boolean).map(String),
    names: slots.map((n) => [r[`debater${n}_first`], r[`debater${n}_last`]].filter(Boolean).join(' ')).filter(Boolean),
  }));
}
