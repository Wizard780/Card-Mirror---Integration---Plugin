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
