import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHelperServer } from '../lib/server.mjs';

let server, base;
before(async () => {
  server = createHelperServer({
    token: 'secret-token',
    appVersion: '0.1.0',
    routes: {
      '/echo': (body) => ({ ok: true, got: body }),
      '/boom': () => { throw new Error('kaboom'); },
    },
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const post = (path, body, token = 'secret-token') =>
  fetch(base + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { 'X-Bridge-Token': token } : {}) },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

test('ping needs no token', async () => {
  const r = await fetch(base + '/ping');
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true, app: 'debate-uploader', appVersion: '0.1.0' });
});

test('missing or wrong token is 401', async () => {
  assert.equal((await post('/echo', {}, null)).status, 401);
  const r = await post('/echo', {}, 'wrong');
  assert.equal(r.status, 401);
  assert.deepEqual(await r.json(), { ok: false, error: 'bad_token' });
});

test('POST route gets the parsed body', async () => {
  const r = await post('/echo', { room: 'abc12' });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true, got: { room: 'abc12' } });
});

test('unknown route and GET on a route are 404', async () => {
  assert.equal((await post('/nope', {})).status, 404);
  const g = await fetch(base + '/echo', { headers: { 'X-Bridge-Token': 'secret-token' } });
  assert.equal(g.status, 404);
});

test('bad JSON is 400, throwing route is 500 with message', async () => {
  const bad = await post('/echo', '{not json');
  assert.equal(bad.status, 400);
  assert.deepEqual(await bad.json(), { ok: false, error: 'bad_json' });
  const boom = await post('/boom', {});
  assert.equal(boom.status, 500);
  assert.deepEqual(await boom.json(), { ok: false, error: 'kaboom' });
});
