import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile, access } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
let fakeSD, helper, bridgeDir, session, sendDir;
const received = [];

before(async () => {
  // Fake SpeechDrop: room "room1" exists; enforces cookie + form XSRF match.
  fakeSD = createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/room1') {
      res.setHeader('Set-Cookie', ['vertx-web.session=s1; Path=/', 'XSRF-TOKEN=tok123; Path=/']);
      return res.end('<html>');
    }
    if (req.method === 'GET') { res.writeHead(302, { Location: '/' }); return res.end(); }
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const fd = await new Request('http://local', {
      method: 'POST', headers: { 'content-type': req.headers['content-type'] }, body: Buffer.concat(chunks),
    }).formData();
    if (fd.get('X-XSRF-TOKEN') !== 'tok123' || !String(req.headers.cookie).includes('XSRF-TOKEN=tok123')) {
      res.writeHead(403); return res.end();
    }
    const file = fd.get('file');
    received.push({ name: file.name, type: file.type, text: await file.text() });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify([{ name: file.name, ctime: Date.now() }]));
  });
  await new Promise((r) => fakeSD.listen(0, '127.0.0.1', r));

  bridgeDir = await mkdtemp(join(tmpdir(), 'bridge-'));
  sendDir = await mkdtemp(join(tmpdir(), 'send-'));
  await writeFile(join(sendDir, 'Send 1AC.docx'), 'docx-bytes');
  helper = spawn(process.execPath, [join(ROOT, 'helper.mjs')], {
    env: { ...process.env, DEBATE_UPLOADER_BRIDGE_DIR: bridgeDir, DEBATE_UPLOADER_SD_BASE: `http://127.0.0.1:${fakeSD.address().port}` },
    stdio: 'ignore',
  });
  const sessionPath = join(bridgeDir, 'debate-uploader.session.json');
  for (let i = 0; i < 50 && !session; i++) {
    try { session = JSON.parse(await readFile(sessionPath, 'utf8')); } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  assert.ok(session, 'helper never wrote its session file');
});

after(() => { helper.kill('SIGKILL'); fakeSD.close(); });

const call = (route, body, token = session.token) =>
  fetch(`http://127.0.0.1:${session.port}${route}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Bridge-Token': token }, body: JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, body: await r.json() }));

async function waitJob(id) {
  for (let i = 0; i < 100; i++) {
    const { body } = await call('/job', { id });
    if (body.state !== 'running') return body;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('job never finished');
}

test('session file points at a live helper; wrong token is rejected', async () => {
  const ping = await fetch(`http://127.0.0.1:${session.port}/ping`);
  assert.equal(ping.status, 200);
  assert.equal((await call('/job', { id: 'x' }, 'wrong')).status, 401);
});

test('upload a picked file (base64) end to end', async () => {
  const start = await call('/speechdrop/upload', {
    room: 'room1', file: { name: 'pick.txt', base64: Buffer.from('hello').toString('base64') },
  });
  assert.equal(start.body.ok, true);
  assert.deepEqual(await waitJob(start.body.job), { state: 'done', result: { room: 'room1', name: 'pick.txt' } });
  assert.deepEqual(received.at(-1), { name: 'pick.txt', type: 'text/plain', text: 'hello' });
});

test('upload newest .docx from a folder end to end', async () => {
  const start = await call('/speechdrop/upload', { room: 'room1', folder: sendDir });
  const done = await waitJob(start.body.job);
  assert.equal(done.result.name, 'Send 1AC.docx');
  assert.equal(received.at(-1).text, 'docx-bytes');
});

test('bad room code finishes as a no_room job error', async () => {
  const start = await call('/speechdrop/upload', { room: 'nope1', file: { name: 'a.txt', base64: '' } });
  assert.deepEqual(await waitJob(start.body.job), { state: 'error', message: 'no_room' });
});

test('SIGTERM removes the session file but keeps identity', async () => {
  const sessionPath = join(bridgeDir, 'debate-uploader.session.json');
  const exited = new Promise((r) => helper.once('exit', r));
  helper.kill('SIGTERM');
  await exited;
  await assert.rejects(access(sessionPath));
  await access(join(bridgeDir, 'debate-uploader.json'));
});
