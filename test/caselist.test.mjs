import { test } from 'node:test';
import assert from 'node:assert/strict';
import { login, getRounds, listCaselists, listSchools, listTeams, normalizeSide, createRound, searchTeams, searchCards, getTeam, downloadOpenSource, listTeamsDetailed } from '../lib/caselist.mjs';

function fake(routes) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, init });
    const r = routes[url.replace('https://cl.test', '')];
    if (r instanceof Error) throw r;
    if (!r) return new Response('{"message":"nope"}', { status: 404 });
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200 });
  };
  return { fetchImpl, calls, opts: { fetchImpl, base: 'https://cl.test' } };
}

const R = (id, start, extra = {}) => ({ id, tournament: 'Glenbrooks', round: `R${id}`, side: 'Aff', opponent: `Opp ${id}`, judge: `J ${id}`, start_time: start, share: 'abc', ...extra });

test('login posts credentials with remember:true and returns only token + expires', async () => {
  const f = fake({ '/login': { status: 201, body: { message: 'ok', token: 'T'.repeat(32), expires: '2026-10-11T00:00:00Z', userId: 7 } } });
  const out = await login({ username: 'me@x.com', password: 'pw' }, f.opts);
  assert.deepEqual(out, { token: 'T'.repeat(32), expires: '2026-10-11T00:00:00Z' });
  assert.equal(f.calls[0].init.method, 'POST');
  assert.deepEqual(JSON.parse(f.calls[0].init.body), { username: 'me@x.com', password: 'pw', remember: true });
});

test('login errors: wrong password, empty fields, network, missing token', async () => {
  await assert.rejects(login({ username: 'a', password: 'b' }, fake({ '/login': { status: 401, body: { message: 'Invalid' } } }).opts), /^Error: bad_login$/);
  const none = fake({});
  await assert.rejects(login({ username: '', password: 'b' }, none.opts), /^Error: bad_login$/);
  await assert.rejects(login({ username: 'a', password: '' }, none.opts), /^Error: bad_login$/);
  assert.equal(none.calls.length, 0);
  await assert.rejects(login({ username: 'a', password: 'b' }, fake({ '/login': new TypeError('x') }).opts), /^Error: unreachable$/);
  await assert.rejects(login({ username: 'a', password: 'b' }, fake({ '/login': { status: 201, body: { message: 'ok' } } }).opts), /^Error: bad_response$/);
});

test('getRounds: current rounds win and the token goes only in the Cookie header', async () => {
  const f = fake({ '/tabroom/rounds?current=true': { body: [R(1, '2026-10-10T14:00:00Z')] } });
  const out = await getRounds('TOK', f.opts);
  assert.equal(out.current, true);
  assert.deepEqual(out.rounds, [{ id: 1, tournament: 'Glenbrooks', round: 'R1', side: 'Aff', opponent: 'Opp 1', judge: 'J 1', start_time: '2026-10-10T14:00:00Z' }]);
  assert.equal(f.calls[0].init.headers.Cookie, 'caselist_token=TOK');
  assert.equal(f.calls.length, 1);
});

test('getRounds: no current rounds → last 10 by start time, newest first', async () => {
  const all = Array.from({ length: 12 }, (_, i) => R(i, `2026-09-${String(10 + i).padStart(2, '0')}T10:00:00Z`));
  const f = fake({ '/tabroom/rounds?current=true': { body: [] }, '/tabroom/rounds': { body: all } });
  const out = await getRounds('TOK', f.opts);
  assert.equal(out.current, false);
  assert.equal(out.rounds.length, 10);
  assert.deepEqual(out.rounds.slice(0, 2).map((r) => r.id), [11, 10]);
});

test('getRounds errors: 401 is login_expired; network is unreachable; non-array is bad_response', async () => {
  await assert.rejects(getRounds('TOK', fake({ '/tabroom/rounds?current=true': { status: 401, body: { message: 'Not Authorized' } } }).opts), /^Error: login_expired$/);
  await assert.rejects(getRounds('TOK', fake({ '/tabroom/rounds?current=true': new TypeError('x') }).opts), /^Error: unreachable$/);
  await assert.rejects(getRounds('TOK', fake({ '/tabroom/rounds?current=true': { body: { not: 'array' } } }).opts), /^Error: bad_response$/);
});

test('listCaselists hides archived ones and maps display_name/name/event; token only in Cookie', async () => {
  const f = fake({ '/caselists': { body: [
    { name: 'hspf26', display_name: 'HS PF 2026', event: 'pf', archived: false },
    { name: 'hspf25', display_name: 'HS PF 2025', event: 'pf', archived: true },
    { slug: 'ndtceda26', name: 'NDT CEDA 2026', event: 'cx' },
  ] } });
  assert.deepEqual(await listCaselists('TOK', f.opts), [
    { name: 'hspf26', label: 'HS PF 2026', event: 'pf' },
    { name: 'NDT CEDA 2026', label: 'NDT CEDA 2026', event: 'cx' },
  ]);
  assert.equal(f.calls[0].init.headers.Cookie, 'caselist_token=TOK');
});

test('listCaselists archived: past years too, open first then newest year; old-site caselists dropped', async () => {
  const f = fake({ '/caselists?archived=true': { body: [
    { name: 'hspolicy13', display_name: 'HS Policy 2013-14', event: 'cx', year: 2013, archived: true, archive_url: 'https://hspolicy13.paperlessdebate.com' },
    { name: 'hspf24', display_name: 'HS PF 2024-25', event: 'pf', year: 2024, archived: true },
    { name: 'hspf25', display_name: 'HS PF 2025-26', event: 'pf', year: 2025, archived: true },
    { name: 'hspf26', display_name: 'HS PF 2026-27', event: 'pf', year: 2026, archived: false },
  ] } });
  assert.deepEqual((await listCaselists('TOK', f.opts, { archived: true })).map((c) => [c.name, c.year, c.archived]), [['hspf26', 2026, false], ['hspf25', 2025, true], ['hspf24', 2024, true]]);
});

test('searchCards: one caselist or an OR group in one search; full at 100 hits; file and cite hits with ids, cleaned text', async () => {
  const f = fake({ '/search?q=nuclear%20winter&shard=hspf24': { body: [
    { type: 'file', caselist: 'hspf24', caselist_display_name: 'HS PF 2024-25', school: 'Hawken', team: 'JoMi', team_display_name: 'Hawken JoMi', download_path: 'hspf24/Hawken/JoMi/a.docx', title: 'a.docx', snippet: '[bookmark: _x1]a <b>nuclear winter</b>\n would' },
    { type: 'cite', caselist: 'hspf24', school: 'Interlake', team: 'WuZh', title: '5 - Feb - DA', snippet: '(\\*Matt **Starr 15**', path: 'hspf24/Interlake/WuZh#591912' },
    { type: 'team', school: 'X', team: 'Y' },
  ] } });
  assert.deepEqual(await searchCards('TOK', 'hspf24', 'nuclear winter', f.opts), { full: false, hits: [
    { id: 'hspf24/Hawken/JoMi/a.docx', type: 'file', caselist: 'hspf24', caselistLabel: 'HS PF 2024-25', school: 'Hawken', team: 'JoMi', teamLabel: 'Hawken JoMi', title: 'a.docx', snippet: 'a nuclear winter would', path: 'hspf24/Hawken/JoMi/a.docx' },
    { id: 'hspf24/Interlake/WuZh#591912', type: 'cite', caselist: 'hspf24', caselistLabel: 'hspf24', school: 'Interlake', team: 'WuZh', teamLabel: 'Interlake WuZh', title: '5 - Feb - DA', snippet: '(Matt Starr 15', path: null },
  ] });
  const many = Array.from({ length: 100 }, (_, i) => ({ type: 'file', caselist: 'hspf25', school: 'S', team: 'T', download_path: `hspf25/S/T/${i}.docx`, title: `${i}.docx`, snippet: 'x' }));
  const g = fake({ '/search?q=x&shard=(hspf26%20OR%20hspf25)': { body: many } });
  const r = await searchCards('TOK', ['hspf26', 'hspf25'], 'x', g.opts);
  assert.equal(r.full, true, '100 hits: there may be more');
  assert.equal(r.hits.length, 100);
  const bare = fake({ '/search?q=x&shard=(hspf26%20OR%20hspf25)': { body: [
    { type: 'file', school: 'S', team: 'T', download_path: 'hspf25/S/T/a.docx', title: 'a.docx', snippet: 'x' },
    { type: 'cite', school: 'S', team: 'T', title: '1NC', snippet: 'y' },
    { type: 'cite', school: 'S', team: 'T', title: '2NR', snippet: 'z' },
  ] } });
  const b = await searchCards('TOK', ['hspf26', 'hspf25'], 'x', bare.opts);
  assert.deepEqual(b.hits.map((h) => h.caselist), ['hspf25', '', ''], 'caselist from the path, never guessed in a group');
  assert.equal(new Set(b.hits.map((h) => h.id)).size, 3, 'rows without a path still get distinct ids');
  await assert.rejects(searchCards('TOK', ['hspf26', 'x) OR (y'], 'x', g.opts), /^Error: bad_caselist$/, 'only plain caselist names go into the filter');
  await assert.rejects(searchCards('TOK', 'hspf24', 'x', fake({ '/search?q=x&shard=hspf24': { status: 429, body: {} } }).opts), /^Error: http_429$/);
});

test('listSchools / listTeams build encoded paths; 401 is login_expired', async () => {
  const f = fake({
    '/caselists/hspf26/schools': { body: [{ name: 'StMarks', display_name: "St. Mark's" }] },
    "/caselists/hspf26/schools/St%20Mark's/teams": { body: [{ name: 'StMarksAB', display_name: "St. Mark's AB" }] },
  });
  assert.deepEqual(await listSchools('TOK', 'hspf26', f.opts), [{ name: 'StMarks', label: "St. Mark's" }]);
  assert.deepEqual(await listTeams('TOK', 'hspf26', "St Mark's", f.opts), [{ name: 'StMarksAB', label: "St. Mark's AB" }]);
  await assert.rejects(listSchools('TOK', 'x', fake({ '/caselists/x/schools': { status: 401, body: {} } }).opts), /^Error: login_expired$/);
});

test('normalizeSide maps Aff/Pro → A and Neg/Con → N, anything else null', () => {
  for (const s of ['A', 'a', 'Aff', 'AFF', 'Pro', ' pro ']) assert.equal(normalizeSide(s), 'A', s);
  for (const s of ['N', 'Neg', 'con', 'CON']) assert.equal(normalizeSide(s), 'N', s);
  for (const s of ['', null, undefined, 'both', 'Affirmative']) assert.equal(normalizeSide(s), null, String(s));
});

const TARGET = { caselist: 'hspf26', school: "St Mark's", team: 'AB' };
const ROUND = { tournament: ' Glenbrooks ', side: 'Con', round: '3', opponent: 'Lexington AB', judge: 'Smith', report: '', filename: '1NC.docx', base64: 'RE9D' };
const ROUNDS_PATH = "/caselists/hspf26/schools/St%20Mark's/teams/AB/rounds";

test("createRound posts Verbatim's exact body to the encoded team path", async () => {
  const f = fake({ [ROUNDS_PATH]: { status: 201, body: { round_id: 5 } } });
  assert.deepEqual(await createRound('TOK', TARGET, ROUND, f.opts), { filename: '1NC.docx' });
  const c = f.calls[0];
  assert.equal(c.init.method, 'POST');
  assert.equal(c.init.headers.Cookie, 'caselist_token=TOK');
  assert.deepEqual(JSON.parse(c.init.body), {
    tournament: 'Glenbrooks', side: 'N', round: '3', opponent: 'Lexington AB', judge: 'Smith', report: '', opensource: 'RE9D', filename: '1NC.docx',
  });
});

test('createRound validates before sending', async () => {
  for (const [patch, err] of [
    [{ tournament: '' }, 'bad_round'], [{ round: ' ' }, 'bad_round'], [{ side: 'both' }, 'bad_round'],
    [{ base64: '' }, 'no_file'], [{ filename: '' }, 'no_file'],
  ]) {
    const f = fake({});
    await assert.rejects(createRound('TOK', TARGET, { ...ROUND, ...patch }, f.opts), new RegExp(`^Error: ${err}$`));
    assert.equal(f.calls.length, 0, err);
  }
  await assert.rejects(createRound('TOK', { ...TARGET, team: '' }, ROUND, fake({}).opts), /^Error: no_team$/);
});

test('createRound errors: 401 login_expired, 4xx rejected with message, 5xx and network upload_unknown', async () => {
  await assert.rejects(createRound('TOK', TARGET, ROUND, fake({ [ROUNDS_PATH]: { status: 401, body: {} } }).opts), /^Error: login_expired$/);
  await assert.rejects(createRound('TOK', TARGET, ROUND, fake({ [ROUNDS_PATH]: { status: 400, body: { message: 'Round already exists' } } }).opts), /^Error: caselist_rejected:Round already exists$/);
  await assert.rejects(createRound('TOK', TARGET, ROUND, fake({ [ROUNDS_PATH]: { status: 502, body: {} } }).opts), /^Error: upload_unknown$/);
  await assert.rejects(createRound('TOK', TARGET, ROUND, fake({ [ROUNDS_PATH]: new TypeError('x') }).opts), /^Error: upload_unknown$/);
});

test('searchTeams keeps team rows only, de-duplicated, and skips empty queries', async () => {
  const f = fake({ '/search?q=Lexington%20AlHu&shard=hspf26': { body: [
    { type: 'team', school: 'Lexington', team: 'AlHu', team_display_name: 'Lexington AlHu', school_display_name: 'Lexington' },
    { type: 'cite', school: 'Lexington', team: 'KaRo' },
    { type: 'team', school: 'Lexington', team: 'AlHu', team_display_name: 'Lexington AlHu', school_display_name: 'Lexington' },
    { type: 'file', path: 'x' },
  ] } });
  assert.deepEqual(await searchTeams('TOK', 'hspf26', ' Lexington AlHu ', f.opts), [{ school: 'Lexington', team: 'AlHu', label: 'Lexington AlHu', schoolLabel: 'Lexington' }]);
  assert.equal(f.calls[0].init.headers.Cookie, 'caselist_token=TOK');
  const none = fake({});
  assert.deepEqual(await searchTeams('TOK', 'hspf26', '  ', none.opts), []);
  assert.equal(none.calls.length, 0);
});

test('getTeam returns rounds newest first and cites, shaped', async () => {
  const f = fake({
    '/caselists/hspf26/schools/Lexington/teams/AlHu/rounds': { body: [
      { round_id: 1, side: 'A', tournament: '01---Yale', round: '2', opponent: 'X', judge: 'J', report: 'r1', opensource: null, video: null, updated_at: '2026-09-20 10:00:00' },
      { round_id: 2, side: 'N', tournament: '03---Glenbrooks', round: '3', opponent: 'Y', judge: 'K', report: '1NC - Econ, Midterms\n2NR - Econ\n[W]', opensource: 'hspf26/Lexington/AlHu/a.docx', video: null, updated_at: '2026-10-04 10:00:00' },
    ] },
    '/caselists/hspf26/schools/Lexington/teams/AlHu/cites': { body: [{ cite_id: 7, round_id: 2, title: '1NC', cites: 'Smith 24', side: 'N', tournament: '03---Glenbrooks', round: '3' }] },
  });
  const t = await getTeam('TOK', 'hspf26', 'Lexington', 'AlHu', f.opts);
  assert.deepEqual(t.rounds.map((r) => r.id), [2, 1]);
  assert.deepEqual(t.rounds[0], { id: 2, side: 'N', tournament: '03---Glenbrooks', round: '3', opponent: 'Y', judge: 'K', report: '1NC - Econ, Midterms\n2NR - Econ\n[W]', opensource: 'hspf26/Lexington/AlHu/a.docx', video: null, updated: '2026-10-04 10:00:00', parsed: { own: ['Econ', 'Midterms'], final: ['Econ'], result: 'W' } });
  assert.deepEqual(t.cites, [{ id: 7, roundId: 2, title: '1NC', cites: 'Smith 24', side: 'N', tournament: '03---Glenbrooks', round: '3' }]);
});

test('downloadOpenSource returns bytes and a safe filename; failures are download_failed / login_expired', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (url.includes('bad')) return new Response('', { status: 404 });
    if (url.includes('expired')) return new Response('', { status: 401 });
    return new Response('DOCX', { status: 200, headers: { 'content-disposition': 'attachment; filename="../../evil/Lex-AlHu.docx"' } });
  };
  const opts = { fetchImpl, base: 'https://cl.test' };
  const out = await downloadOpenSource('TOK', 'hspf26/Lexington/AlHu/a b.docx', opts);
  assert.deepEqual({ filename: out.filename, text: out.bytes.toString() }, { filename: 'Lex-AlHu.docx', text: 'DOCX' });
  assert.equal(calls[0].url, 'https://cl.test/download?path=hspf26%2FLexington%2FAlHu%2Fa%20b.docx');
  assert.equal(calls[0].init.headers.Cookie, 'caselist_token=TOK');
  await assert.rejects(downloadOpenSource('TOK', 'bad', opts), /^Error: download_failed$/);
  await assert.rejects(downloadOpenSource('TOK', 'expired', opts), /^Error: login_expired$/);
});

test('listTeamsDetailed returns each team with its debaters (last names and full names)', async () => {
  const f = fake({ '/caselists/hspf26/schools/Lexington/teams': { body: [
    { name: 'AlHu', display_name: 'Lexington AlHu', debater1_first: 'Simal', debater1_last: 'Ali', debater2_first: 'Christina', debater2_last: 'Hu', debater3_first: null, debater3_last: null },
    { name: 'All', display_name: 'Lexington All', debater1_first: 'All', debater1_last: 'Teams', debater2_first: null, debater2_last: null },
  ] } });
  assert.deepEqual(await listTeamsDetailed('TOK', 'hspf26', 'Lexington', f.opts), [
    { school: 'Lexington', team: 'AlHu', label: 'Lexington AlHu', debaters: ['Ali', 'Hu'], names: ['Simal Ali', 'Christina Hu'] },
    { school: 'Lexington', team: 'All', label: 'Lexington All', debaters: ['Teams'], names: ['All Teams'] },
  ]);
});

test('getTeam orders like openCaselist: newest tournament first, latest round first (elims before prelims), general disclosure last', async () => {
  const R = (round_id, tournament, round, updated_at) => ({ round_id, side: 'A', tournament, round, opponent: '', judge: '', report: '', opensource: null, video: null, updated_at });
  const f = fake({
    '/caselists/hspf26/schools/S/teams/T/rounds': { body: [
      R(1, '01 -- Harvard Union Season Opener', '1', '2026-09-26 20:00:00'),
      R(2, '01 -- Harvard Union Season Opener', 'Doubles', '2026-09-26 09:00:00'),
      R(3, '03 -- Mid America Cup', '4', '2026-09-27 18:00:00'),
      R(4, '03 -- Mid America Cup', '6', '2026-09-27 10:00:00'),
      R(5, '0---All Tournaments', 'All', '2026-10-01 10:00:00'),
      R(6, '03 -- Mid America Cup', '5', '2026-09-26 23:00:00'),
      R(7, '01 -- Harvard Union Season Opener', '6', '2026-09-26 12:00:00'),
      R(8, '01 -- Harvard Union Season Opener', 'Octas', '2026-09-26 08:00:00'),
    ] },
    '/caselists/hspf26/schools/S/teams/T/cites': { body: [] },
  });
  const t = await getTeam('TOK', 'hspf26', 'S', 'T', f.opts);
  assert.deepEqual(t.rounds.map((r) => r.id), [4, 6, 3, 8, 2, 7, 1, 5]);
});

test('createRound: any 2xx is success; a redirect is "check the page" (never followed as a GET)', async () => {
  const seen = [];
  const reply = (status) => ({ fetchImpl: async (url, init) => { seen.push(init.redirect); return new Response(null, { status }); }, base: 'https://cl.test' });
  assert.deepEqual(await createRound('TOK', TARGET, ROUND, reply(204)), { filename: '1NC.docx' });
  await assert.rejects(createRound('TOK', TARGET, ROUND, reply(302)), /^Error: upload_unknown$/);
  assert.deepEqual(seen, ['manual', 'manual']);
});

test('getTeam orders full elim names ("Quarterfinals", "Double Octafinals") after prelims', async () => {
  const base = '/caselists/hspf26/schools/Lexington/teams/AlHu';
  const rounds = ['Semifinals', '2', 'Double Octafinals', 'Quarterfinals', '1'].map((round, i) => ({ round_id: i, tournament: '03 -- X', side: 'A', round }));
  const f = fake({ [`${base}/rounds`]: { body: rounds }, [`${base}/cites`]: { body: [] } });
  const t = await getTeam('TOK', 'hspf26', 'Lexington', 'AlHu', f.opts);
  assert.deepEqual(t.rounds.map((r) => r.round), ['Semifinals', 'Quarterfinals', 'Double Octafinals', '2', '1']);
});
