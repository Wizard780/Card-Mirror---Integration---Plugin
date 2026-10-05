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

export async function getRounds(token, { fetchImpl = fetch, base = CASELIST_BASE, timeoutMs = 20_000 } = {}) {
  const get = async (path) => {
    const res = await request(fetchImpl, `${base}${path}`, { headers: { Cookie: `caselist_token=${token}` } }, timeoutMs);
    if (res.status === 401) throw new Error('login_expired');
    if (!res.ok) throw new Error(`http_${res.status}`);
    const body = await json(res);
    if (!Array.isArray(body)) throw new Error('bad_response');
    return body.map(shape);
  };
  const current = await get('/tabroom/rounds?current=true');
  if (current.length) return { current: true, rounds: current };
  const all = await get('/tabroom/rounds');
  all.sort((a, b) => (Date.parse(b.start_time) || 0) - (Date.parse(a.start_time) || 0));
  return { current: false, rounds: all.slice(0, 10) };
}
