import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile, access, chmod } from 'node:fs/promises';
import { openSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
let fakeSD, helper, bridgeDir, session, sendDir, downloadDir, openLog;
let fakeCL, keyStore, helperLog;
let clRejectAll = false;
let uploads = []; let clStaleToken = false;
const received = [];

before(async () => {
  // Fake SpeechDrop: room "room1" exists; enforces cookie + form XSRF match.
  fakeSD = createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/room1') {
      res.setHeader('Set-Cookie', ['vertx-web.session=s1; Path=/', 'XSRF-TOKEN=tok123; Path=/']);
      return res.end('<html>');
    }
    if (req.method === 'GET' && req.url === '/room1/index') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(received.map((r, i) => ({ name: r.name, ctime: i }))));
    }
    const media = req.method === 'GET' && req.url.match(/^\/media\/room1\/(\d+)\/(.+)$/);
    if (media) {
      const r = received[Number(media[1])];
      if (!r || r.name !== decodeURIComponent(media[2])) { res.writeHead(404); return res.end(); }
      return res.end(r.text);
    }
    if (req.method === 'GET' && req.url.endsWith('/index')) { res.writeHead(404); return res.end('[]'); }
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
  downloadDir = await mkdtemp(join(tmpdir(), 'dl-'));
  openLog = join(downloadDir, 'open.log');
  const opener = join(downloadDir, 'fake-open.sh');
  await writeFile(opener, `#!/bin/sh\nprintf '%s|' "$@" >> '${openLog}'\necho >> '${openLog}'\n`);
  await chmod(opener, 0o755);
  // Fake openCaselist: password "right" logs in; the cookie must carry the token.
  fakeCL = createServer(async (req, res) => {
    const send = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.method === 'POST' && req.url === '/v1/login') {
      const chunks = []; for await (const c of req) chunks.push(c);
      const { password } = JSON.parse(Buffer.concat(chunks).toString());
      return password === 'right-pw-123'
        ? send(201, { message: 'Logged in', token: 'CLTOKEN0123456789abcdef01234567', expires: '2099-01-01T00:00:00Z' })
        : send(401, { message: 'Invalid username or password' });
    }
    if (clRejectAll || req.headers.cookie !== 'caselist_token=CLTOKEN0123456789abcdef01234567') return send(401, { message: 'Not Authorized' });
    if (req.url === '/v1/caselists') return send(200, [
      { name: 'hspf26', display_name: 'HS PF 2026', event: 'pf', archived: false },
      { name: 'hspf25', display_name: 'HS PF 2025', event: 'pf', archived: true },
    ]);
    if (req.url === '/v1/caselists/hspf26/schools') return send(200, [{ name: 'StMarks', display_name: "St. Mark's" }]);
    if (req.url === '/v1/caselists/hspf26/schools/StMarks/teams') return send(200, [{ name: 'StMarksAB', display_name: "St. Mark's AB" }]);
    if (req.method === 'POST' && req.url === '/v1/caselists/hspf26/schools/StMarks/teams/StMarksAB/rounds') {
      const chunks = []; for await (const c of req) chunks.push(c);
      uploads.push(JSON.parse(Buffer.concat(chunks).toString()));
      if (clStaleToken) {
        // Simulate: a newer login is saved while this request is in flight, then this request 401s.
        await writeFile(keyStore, JSON.stringify({ token: 'NEWER-TOKEN', expires: '2099-01-01T00:00:00Z' }));
        return send(401, { message: 'Not Authorized' });
      }
      return send(201, { round_id: uploads.length });
    }
    if (req.url === '/v1/tabroom/rounds?current=true') return send(200, []);
    if (req.url === '/v1/tabroom/rounds') return send(200, [{ id: 9, tournament: 'Glenbrooks', round: 'R3', side: 'Neg', opponent: 'Lexington AB', judge: 'Smith', start_time: '2026-10-10T14:00:00Z', share: 'x' }]);
    return send(404, {});
  });
  await new Promise((r) => fakeCL.listen(0, '127.0.0.1', r));

  // Fake `security`: stores the -w value in a file so tests can inspect it.
  keyStore = join(downloadDir, 'keychain.txt');
  const security = join(downloadDir, 'fake-security.sh');
  await writeFile(security, `#!/bin/sh
F='${keyStore}'
case "$1" in
  add-generic-password) while [ $# -gt 0 ]; do [ "$1" = "-w" ] && printf '%s' "$2" > "$F"; shift; done ;;
  find-generic-password) [ -f "$F" ] && cat "$F" && echo || exit 44 ;;
  delete-generic-password) rm -f "$F" ;;
esac
`);
  await chmod(security, 0o755);
  helperLog = join(downloadDir, 'helper.log');
  helper = spawn(process.execPath, [join(ROOT, 'helper.mjs')], {
    env: { ...process.env, DEBATE_UPLOADER_BRIDGE_DIR: bridgeDir, DEBATE_UPLOADER_SD_BASE: `http://127.0.0.1:${fakeSD.address().port}`,
      DEBATE_UPLOADER_SD_MEDIA: `http://127.0.0.1:${fakeSD.address().port}/media/`, DEBATE_UPLOADER_DOWNLOAD_DIR: downloadDir,
      DEBATE_UPLOADER_OPENER: opener,
      DEBATE_UPLOADER_SD_WS: `ws://127.0.0.1:${fakeSD.address().port}/sock/websocket`,
      DEBATE_UPLOADER_CASELIST_BASE: `http://127.0.0.1:${fakeCL.address().port}/v1`, DEBATE_UPLOADER_SECURITY_BIN: security },
    stdio: ['ignore', openSync(helperLog, 'w'), openSync(helperLog, 'a')],
  });
  const sessionPath = join(bridgeDir, 'debate-uploader.session.json');
  for (let i = 0; i < 50 && !session; i++) {
    try { session = JSON.parse(await readFile(sessionPath, 'utf8')); } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  assert.ok(session, 'helper never wrote its session file');
});

after(() => { helper.kill('SIGKILL'); fakeSD.close(); fakeCL.close(); });

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

test('list a room: newest first with SpeechDrop positions', async () => {
  const start = await call('/speechdrop/list', { room: 'room1' });
  const done = await waitJob(start.body.job);
  assert.deepEqual(done.result.map((f) => [f.index, f.name]), [[1, 'Send 1AC.docx'], [0, 'pick.txt']]);
  const missing = await waitJob((await call('/speechdrop/list', { room: 'nope1' })).body.job);
  assert.deepEqual(missing, { state: 'error', message: 'no_room' });
});

test('watch: with no live socket it falls back to HTTP and answers within the flowPost budget', async () => {
  const t0 = Date.now();
  const r = await call('/speechdrop/watch', { room: 'room1', version: 0 });
  assert.ok(Date.now() - t0 < 2800, `answered in ${Date.now() - t0} ms`);
  assert.equal(r.status, 200);
  assert.equal(r.body.live, false);
  assert.equal(r.body.version, 1);
  assert.deepEqual(r.body.files.map((f) => [f.index, f.name]), [[1, 'Send 1AC.docx'], [0, 'pick.txt']]);
  const t1 = Date.now();
  const again = await call('/speechdrop/watch', { room: 'room1', version: 1 });
  assert.equal(again.body.version, 1);
  assert.ok(Date.now() - t1 < 2800);
});

test('watch: wrong room is no_room; bad code is bad_room', async () => {
  const r = await call('/speechdrop/watch', { room: 'nope1', version: 0 });
  assert.deepEqual([r.status, r.body], [500, { ok: false, error: 'no_room' }]);
  const b = await call('/speechdrop/watch', { room: 'a b', version: 0 });
  assert.deepEqual(b.body, { ok: false, error: 'bad_room' });
});

test('open: .docx downloads to <dir>/<room>/ and opens in CardMirror; .txt opens in default app', async () => {
  const docx = await waitJob((await call('/speechdrop/open', { room: 'room1', index: 1, name: 'Send 1AC.docx' })).body.job);
  const docxPath = join(downloadDir, 'room1', 'Send 1AC.docx');
  assert.deepEqual(docx, { state: 'done', result: { name: 'Send 1AC.docx', path: docxPath, app: 'CardMirror' } });
  assert.equal(await readFile(docxPath, 'utf8'), 'docx-bytes');
  const txt = await waitJob((await call('/speechdrop/open', { room: 'room1', index: 0, name: 'pick.txt' })).body.job);
  assert.equal(txt.result.app, 'default');
  const lines = (await readFile(openLog, 'utf8')).trim().split('\n');
  assert.deepEqual(lines, [`-b|com.cardmirror.app|${docxPath}|`, `${join(downloadDir, 'room1', 'pick.txt')}|`]);
});

test('open: same file again reuses the path; a name not in the room is "removed"', async () => {
  const again = await waitJob((await call('/speechdrop/open', { room: 'room1', index: 1, name: 'Send 1AC.docx' })).body.job);
  assert.equal(again.result.path, join(downloadDir, 'room1', 'Send 1AC.docx'));
  const gone = await waitJob((await call('/speechdrop/open', { room: 'room1', index: 1, name: '../../evil.docx' })).body.job);
  assert.deepEqual(gone, { state: 'error', message: 'removed' });
});

test('tabroom: rounds before login is not_logged_in', async () => {
  const r = await waitJob((await call('/tabroom/rounds', {})).body.job);
  assert.deepEqual(r, { state: 'error', message: 'not_logged_in' });
});

test('tabroom: wrong password is bad_login and stores nothing', async () => {
  const r = await waitJob((await call('/tabroom/login', { username: 'me@x.com', password: 'wrong-pw-456' })).body.job);
  assert.deepEqual(r, { state: 'error', message: 'bad_login' });
  await assert.rejects(access(keyStore));
});

test('tabroom: login stores only token+expires; rounds fall back to recent', async () => {
  const r = await waitJob((await call('/tabroom/login', { username: 'me@x.com', password: 'right-pw-123' })).body.job);
  assert.deepEqual(r, { state: 'done', result: { loggedIn: true } });
  assert.deepEqual(JSON.parse(await readFile(keyStore, 'utf8')), { token: 'CLTOKEN0123456789abcdef01234567', expires: '2099-01-01T00:00:00Z' });
  const rounds = await waitJob((await call('/tabroom/rounds', {})).body.job);
  assert.equal(rounds.result.current, false);
  assert.deepEqual(rounds.result.rounds.map((x) => [x.opponent, x.judge, x.side]), [['Lexington AB', 'Smith', 'Neg']]);
});

test('tabroom: password never reaches the log or Keychain', async () => {
  const logText = await readFile(helperLog, 'utf8');
  assert.ok(!logText.includes('right-pw-123') && !logText.includes('wrong-pw-456'));
  assert.ok(!logText.includes('CLTOKEN0123456789abcdef01234567'), 'token not logged either');
  assert.ok(!(await readFile(keyStore, 'utf8')).includes('right-pw-123'));
});

test('tabroom: a 401 later deletes the stored token (login_expired); logout also clears it', async () => {
  clRejectAll = true;
  const r = await waitJob((await call('/tabroom/rounds', {})).body.job);
  assert.deepEqual(r, { state: 'error', message: 'login_expired' });
  await assert.rejects(access(keyStore));
  clRejectAll = false;
  await waitJob((await call('/tabroom/login', { username: 'me@x.com', password: 'right-pw-123' })).body.job);
  await access(keyStore);
  assert.deepEqual((await call('/tabroom/logout', {})).body, { ok: true });
  await assert.rejects(access(keyStore));
});

const loginOk = () => call('/tabroom/login', { username: 'me@x.com', password: 'right-pw-123' }).then((r) => waitJob(r.body.job));
const ROUND_IN = { tournament: 'Glenbrooks', side: 'Con', round: '3', opponent: 'Lexington AB', judge: 'Smith', report: 'Read the AI DA' };

test('caselist: not logged in → not_logged_in for lists and upload', async () => {
  await call('/tabroom/logout', {});
  assert.deepEqual(await waitJob((await call('/caselist/caselists', {})).body.job), { state: 'error', message: 'not_logged_in' });
  const up = await waitJob((await call('/caselist/upload', { caselist: 'hspf26', school: 'StMarks', team: 'StMarksAB', round: ROUND_IN, folder: sendDir })).body.job);
  assert.deepEqual(up, { state: 'error', message: 'not_logged_in' });
  assert.equal(uploads.length, 0);
});

test('caselist: caselist → school → team lists (archived hidden)', async () => {
  await loginOk();
  assert.deepEqual((await waitJob((await call('/caselist/caselists', {})).body.job)).result, [{ name: 'hspf26', label: 'HS PF 2026', event: 'pf' }]);
  assert.deepEqual((await waitJob((await call('/caselist/schools', { caselist: 'hspf26' })).body.job)).result, [{ name: 'StMarks', label: "St. Mark's" }]);
  assert.deepEqual((await waitJob((await call('/caselist/teams', { caselist: 'hspf26', school: 'StMarks' })).body.job)).result, [{ name: 'StMarksAB', label: "St. Mark's AB" }]);
});

test("caselist: upload a picked file sends Verbatim's body with side normalized", async () => {
  const r = await waitJob((await call('/caselist/upload', {
    caselist: 'hspf26', school: 'StMarks', team: 'StMarksAB', round: ROUND_IN, file: { name: '1NC.docx', base64: Buffer.from('DOC').toString('base64') },
  })).body.job);
  assert.deepEqual(r, { state: 'done', result: { name: '1NC.docx' } });
  assert.deepEqual(uploads.at(-1), {
    tournament: 'Glenbrooks', side: 'N', round: '3', opponent: 'Lexington AB', judge: 'Smith', report: 'Read the AI DA',
    opensource: Buffer.from('DOC').toString('base64'), filename: '1NC.docx',
  });
});

test('caselist: upload the newest send doc from a folder', async () => {
  const r = await waitJob((await call('/caselist/upload', { caselist: 'hspf26', school: 'StMarks', team: 'StMarksAB', round: ROUND_IN, folder: sendDir })).body.job);
  assert.equal(r.result.name, 'Send 1AC.docx');
  assert.equal(Buffer.from(uploads.at(-1).opensource, 'base64').toString(), 'docx-bytes');
});

test('caselist: /caselist/newest names the newest send doc without uploading', async () => {
  const r = await call('/caselist/newest', { folder: sendDir });
  assert.equal(r.status, 200);
  assert.equal(r.body.name, 'Send 1AC.docx');
  assert.equal(r.body.size, 'docx-bytes'.length);
  assert.equal(typeof r.body.mtime, 'number');
});

test('caselist: newest doc changed since the form opened → newest_changed, nothing posted', async () => {
  const before = uploads.length;
  const r = await waitJob((await call('/caselist/upload', { caselist: 'hspf26', school: 'StMarks', team: 'StMarksAB', round: ROUND_IN, folder: sendDir, expectName: 'Old 1AC.docx' })).body.job);
  assert.deepEqual(r, { state: 'error', message: 'newest_changed' });
  assert.equal(uploads.length, before);
});

test('caselist: a send doc over 10 MB is refused before posting', async () => {
  const big = await mkdtemp(join(tmpdir(), 'big-'));
  await writeFile(join(big, 'Huge.docx'), Buffer.alloc(10 * 1024 * 1024 + 1));
  const before = uploads.length;
  const r = await waitJob((await call('/caselist/upload', { caselist: 'hspf26', school: 'StMarks', team: 'StMarksAB', round: ROUND_IN, folder: big, expectName: 'Huge.docx' })).body.job);
  assert.deepEqual(r, { state: 'error', message: 'too_large' });
  assert.equal(uploads.length, before);
});

test('caselist: a stale 401 does not delete a newer saved login', async () => {
  clStaleToken = true;
  const r = await waitJob((await call('/caselist/upload', { caselist: 'hspf26', school: 'StMarks', team: 'StMarksAB', round: ROUND_IN, folder: sendDir })).body.job);
  clStaleToken = false;
  assert.deepEqual(r, { state: 'error', message: 'login_expired' });
  assert.equal(JSON.parse(await readFile(keyStore, 'utf8')).token, 'NEWER-TOKEN');
});

test('caselist: password and token never logged during caselist work', async () => {
  const logText = await readFile(helperLog, 'utf8');
  assert.ok(!logText.includes('right-pw-123'));
  assert.ok(!logText.includes('CLTOKEN0123456789abcdef01234567'));
  assert.ok(logText.includes('caselist upload ok hspf26 StMarks StMarksAB 1NC.docx'));
});

test('SIGTERM removes the session file but keeps identity', async () => {
  const sessionPath = join(bridgeDir, 'debate-uploader.session.json');
  const exited = new Promise((r) => helper.once('exit', r));
  helper.kill('SIGTERM');
  await exited;
  await assert.rejects(access(sessionPath));
  await access(join(bridgeDir, 'debate-uploader.json'));
});
