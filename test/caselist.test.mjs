import { test } from 'node:test';
import assert from 'node:assert/strict';
import { login, getRounds } from '../lib/caselist.mjs';

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
