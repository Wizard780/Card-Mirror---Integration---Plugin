import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import net from 'node:net';
import { mkdtemp, readFile, writeFile, access, chmod, mkdir, readdir } from 'node:fs/promises';
import { deflateRawSync, crc32 } from 'node:zlib';
import { writeZip, readZip, unzipEntry } from '../lib/docx.mjs';
import { openSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
let fakeSD, helper, bridgeDir, session, sendDir, downloadDir, openLog;
const headingDoc = (...heads) => {
  const xml = `<w:document><w:body>${heads.map(([lvl, text]) => `<w:p><w:pPr><w:pStyle w:val="Heading${lvl}"/></w:pPr><w:r><w:t>${text}</w:t></w:r></w:p>`).join('')}</w:body></w:document>`;
  const raw = Buffer.from(xml);
  return writeZip([{ name: 'word/document.xml', method: 8, crc: crc32(raw), usize: raw.length, data: deflateRawSync(raw) }]);
};
const ROOM2 = [
  { name: 'Old round.docx', ctime: 1, bytes: headingDoc([2, '1AC---Stale']) },
  { name: 'Univ 1AC.docx', ctime: Date.now(), bytes: headingDoc([1, 'Round 6'], [2, '1AC---False Profits'], [2, '1AC---Fool’s Gold']) },
  { name: 'Acton 1NC.docx', ctime: Date.now(), bytes: headingDoc([2, '1NC---Econ'], [2, '1NC---O/V']) },
  { name: 'cards.pdf', ctime: Date.now(), bytes: Buffer.from('%PDF') },
];
let fakeCL, keyStore, helperLog;
// Fake Gmail SMTP: app password "abcdefghijklmnop" works; records each message.
const mail = [];
let smtpServer, imapServer;
const CHAIN_HDR = 'From: Judge Lee <lee@school.edu>\r\nTo: opp1@x.org, me@gmail.com\r\nCc: opp2@x.org\r\nSubject: Glenbrooks R3 chain\r\nDate: Sun, 05 Oct 2026 14:00:00 +0000\r\nMessage-ID: <chain-1@school.edu>\r\n\r\n';
let clRejectAll = false;
let uploads = []; let clStaleToken = false;
const upstream = {}; // fake caselist request counts by URL
const received = [];

before(async () => {
  // Fake SpeechDrop: room "room1" exists; enforces cookie + form XSRF match.
  fakeSD = createServer(async (req, res) => {
    // room2: one round's docs from both teams (plus an old doc and a PDF) for report drafting
    if (req.method === 'GET' && req.url === '/room2/index') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(ROOM2.map((f) => ({ name: f.name, ctime: f.ctime }))));
    }
    const m2 = req.method === 'GET' && req.url.match(/^\/media\/room2\/(\d+)\/(.+)$/);
    if (m2) return res.end(ROOM2[Number(m2[1])].bytes);
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
  await writeFile(opener, `#!/bin/sh\ncase "$*" in *FAILOPEN*) exit 1;; esac\nprintf '%s|' "$@" >> '${openLog}'\necho >> '${openLog}'\n`);
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
    upstream[req.url] = (upstream[req.url] || 0) + 1;
    if (clRejectAll || req.headers.cookie !== 'caselist_token=CLTOKEN0123456789abcdef01234567') return send(401, { message: 'Not Authorized' });
    if (req.url === '/v1/caselists') return send(200, [
      { name: 'hspf26', display_name: 'HS PF 2026', event: 'pf', archived: false },
      { name: 'hspf25', display_name: 'HS PF 2025', event: 'pf', archived: true },
    ]);
    if (req.url === '/v1/caselists/hspf26/schools') return send(200, [{ name: 'StMarks', display_name: "St. Mark's" }, { name: 'Lexington', display_name: 'Lexington' }, { name: 'LexingtonCath', display_name: 'Lexington Catholic' }]);
    if (req.url === '/v1/caselists/hspf26/schools/Lexington/teams') return send(200, [
      { name: 'AlHu', display_name: 'Lexington AlHu', debater1_first: 'Simal', debater1_last: 'Ali', debater2_first: 'Christina', debater2_last: 'Hu' },
      { name: 'All', display_name: 'Lexington All', debater1_first: 'All', debater1_last: 'Teams' },
    ]);
    if (req.url === '/v1/caselists/hspf26/schools/LexingtonCath/teams') return send(200, [
      { name: 'AnHa', display_name: 'Lexington Catholic AnHa', debater1_first: 'Ava', debater1_last: 'Ang', debater2_first: 'Hal', debater2_last: 'Hart' },
    ]);
    if (req.url === '/v1/caselists/hspf26/schools/StMarks/teams') return send(200, [{ name: 'StMarksAB', display_name: "St. Mark's AB" }]);
    if (req.url === '/v1/caselists?archived=true') return send(200, [
      { name: 'hspolicy13', display_name: 'HS Policy 2013-14', event: 'cx', year: 2013, archived: true, archive_url: 'https://hspolicy13.paperlessdebate.com' },
      { name: 'hspf25', display_name: 'HS PF 2025', event: 'pf', year: 2025, archived: true },
      { name: 'hspf26', display_name: 'HS PF 2026', event: 'pf', year: 2026, archived: false },
    ]);
    if (req.url.startsWith('/v1/search?q=%22winter%22&')) {
      const shard = new URL(req.url, 'http://x').searchParams.get('shard');
      if (shard === 'bad') return send(500, { message: 'boom' });
      if (shard === 'hspf25' && upstream[req.url] === 1) return send(429, { message: 'You can only run 4 searches per minute.' });
      if (shard.startsWith('slow')) await new Promise((r) => setTimeout(r, 150));
      return send(200, [
        { type: 'file', caselist: shard, caselist_display_name: shard, school: 'Lexington', team: 'AlHu', team_display_name: 'Lexington AlHu', download_path: `${shard}/Lexington/AlHu/a.docx`, title: 'a.docx', snippet: 'nuclear <b>winter</b>\n kills' },
        { type: 'team', school: 'Lexington', team: 'AlHu' },
      ]);
    }
    if (req.url.startsWith('/v1/search?')) return send(200, [
      { type: 'team', school: 'Lexington', team: 'AlHu', team_display_name: 'Lexington AlHu', school_display_name: 'Lexington' },
      { type: 'cite', school: 'Lexington', team: 'KaRo' },
    ]);
    if (req.url === '/v1/caselists/hspf26/schools/Lexington/teams/AlHu/rounds') return send(200, [
      { round_id: 11, side: 'N', tournament: '03---Glenbrooks', round: '3', opponent: 'Strake KM', judge: 'Smith', report: 'AI DA, Econ', opensource: 'hspf26/Lexington/AlHu/Lexington-AlHu-Con-Glenbrooks-Round3.docx', video: null, updated_at: '2026-10-04 10:00:00' },
      { round_id: 12, side: 'A', tournament: '01---Yale', round: '2', opponent: 'X', judge: 'Y', report: '', opensource: null, video: null, updated_at: '2026-09-20 10:00:00' },
      { round_id: 13, side: 'A', tournament: '01---Yale', round: '1', opponent: 'Z', judge: '', report: '', opensource: 'hspf26/Lexington/AlHu/notes.webloc', video: null, updated_at: '2026-08-02 10:00:00' },
      { round_id: 14, side: 'N', tournament: '01---Yale', round: '3', opponent: 'W', judge: '', report: '', opensource: 'hspf26/Lexington/AlHu/FAILOPEN.docx', video: null, updated_at: '2026-08-01 10:00:00' },
    ]);
    if (req.url === '/v1/caselists/hspf26/schools/Lexington/teams/AlHu/cites') return send(200, [{ cite_id: 5, round_id: 11, title: '1NC', cites: 'Smith 24 — data centers' }]);
    if (req.url.startsWith('/v1/download?')) {
      const p = new URL(req.url, 'http://x').searchParams.get('path');
      if (!p.startsWith('hspf26/Lexington/AlHu/')) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename="${p.split('/').pop()}"` });
      return res.end('LEXDOC');
    }
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

  // Fake `security`: stores the value written with `-i … -X <hex>` in a file so tests can inspect it.
  keyStore = join(downloadDir, 'keychain.txt');
  const security = join(downloadDir, 'fake-security.sh');
  // One file per account, like separate Keychain items: caselist_token → keyStore, gmail → keyStore.gmail
  await writeFile(security, `#!/bin/sh
F='${keyStore}'
A=caselist_token
for arg in "$@"; do [ "$prev" = "-a" ] && A="$arg"; prev="$arg"; done
[ "$A" != caselist_token ] && F="$F.$A"
case "$1" in
  -i) read -r line; A=$(printf '%s' "$line" | sed -n 's/.* -a \\([^ ]*\\).*/\\1/p'); F='${keyStore}'; [ "$A" != caselist_token ] && F="$F.$A"
      printf '%s' "$line" | sed -n 's/.* -X \\([0-9a-f]*\\).*/\\1/p' | xxd -r -p > "$F" ;;
  find-generic-password) [ -f "$F" ] && cat "$F" && echo || exit 44 ;;
  delete-generic-password) rm -f "$F" ;;
esac
`);
  await chmod(security, 0o755);
  smtpServer = net.createServer((c) => {
    let inData = false;
    let buf = '';
    let cur = null;
    c.write('220 fake\r\n');
    c.on('data', (d) => {
      buf += d.toString();
      if (inData) {
        const end = buf.indexOf('\r\n.\r\n');
        if (end === -1) return;
        cur.data = buf.slice(0, end + 2); buf = buf.slice(end + 5); inData = false; mail.push(cur);
        c.write('250 ok\r\n');
      }
      let i;
      while (!inData && (i = buf.indexOf('\r\n')) !== -1) {
        const line = buf.slice(0, i); buf = buf.slice(i + 2);
        if (line.startsWith('EHLO')) c.write('250-fake\r\n250 AUTH PLAIN\r\n');
        else if (line.startsWith('AUTH PLAIN')) {
          const [, user, pass] = Buffer.from(line.slice(11), 'base64').toString().split('\0');
          cur = { user, rcpt: [] };
          c.write(pass === 'abcdefghijklmnop' ? '235 ok\r\n' : '535 bad\r\n');
        } else if (line.startsWith('MAIL FROM')) c.write('250 ok\r\n');
        else if (line.startsWith('RCPT TO')) { cur.rcpt.push(line.slice(9, -1)); c.write('250 ok\r\n'); }
        else if (line === 'DATA') { c.write('354 go\r\n'); inData = true; }
        else if (line === 'QUIT') { c.write('221 bye\r\n'); c.end(); }
      }
    });
  });
  await new Promise((r) => smtpServer.listen(0, '127.0.0.1', r));
  imapServer = net.createServer((c) => {
    c.write('* OK ready\r\n');
    let buf = '';
    c.on('data', (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf('\r\n')) !== -1) {
        const line = buf.slice(0, i); buf = buf.slice(i + 2);
        const [tag, cmd] = line.split(' ');
        if (cmd === 'LOGIN') c.write(line.includes('"abcdefghijklmnop"') ? `${tag} OK\r\n` : `${tag} NO bad\r\n`);
        else if (cmd === 'LIST') c.write(`* LIST (\\All) "/" "[Gmail]/All Mail"\r\n${tag} OK\r\n`);
        else if (cmd === 'EXAMINE') c.write(`${tag} OK\r\n`);
        else if (line.includes('SEARCH')) c.write(`* SEARCH 7\r\n${tag} OK\r\n`);
        else if (line.includes('FETCH')) { const b = Buffer.from(CHAIN_HDR); c.write(Buffer.concat([Buffer.from(`* 1 FETCH (UID 7 BODY[HEADER] {${b.length}}\r\n`), b, Buffer.from(`)\r\n${tag} OK\r\n`)])); }
        else if (cmd === 'LOGOUT') { c.write(`${tag} OK\r\n`); c.end(); }
      }
    });
  });
  await new Promise((r) => imapServer.listen(0, '127.0.0.1', r));
  helperLog = join(downloadDir, 'helper.log');
  helper = spawn(process.execPath, [join(ROOT, 'helper.mjs')], {
    env: { ...process.env, DEBATE_UPLOADER_BRIDGE_DIR: bridgeDir, DEBATE_UPLOADER_SD_BASE: `http://127.0.0.1:${fakeSD.address().port}`,
      DEBATE_UPLOADER_SD_MEDIA: `http://127.0.0.1:${fakeSD.address().port}/media/`, DEBATE_UPLOADER_DOWNLOAD_DIR: downloadDir,
      DEBATE_UPLOADER_OPENER: opener,
      DEBATE_UPLOADER_CASELIST_DIR: join(downloadDir, 'caselist'),
      DEBATE_UPLOADER_PREFS_FILE: join(downloadDir, 'prefs', 'prefs.json'),
      DEBATE_UPLOADER_TEST_ALLOW_PRIVATE: '1',
      DEBATE_UPLOADER_SMTP: `127.0.0.1:${smtpServer.address().port}:plain`,
      DEBATE_UPLOADER_IMAP: `127.0.0.1:${imapServer.address().port}:plain`,
      DEBATE_UPLOADER_EVIDENCE_FILE: join(downloadDir, 'prefs', 'evidence-index.json'), DEBATE_UPLOADER_CARDS_DIR: join(downloadDir, 'cards'),
      DEBATE_UPLOADER_SD_WS: `ws://127.0.0.1:${fakeSD.address().port}/sock/websocket`,
      DEBATE_UPLOADER_SEARCH_WINDOW_MS: '200', DEBATE_UPLOADER_CASELIST_BASE: `http://127.0.0.1:${fakeCL.address().port}/v1`, DEBATE_UPLOADER_SECURITY_BIN: security },
    stdio: ['ignore', openSync(helperLog, 'w'), openSync(helperLog, 'a')],
  });
  const sessionPath = join(bridgeDir, 'debate-uploader.session.json');
  for (let i = 0; i < 50 && !session; i++) {
    try { session = JSON.parse(await readFile(sessionPath, 'utf8')); } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  assert.ok(session, 'helper never wrote its session file');
});

after(() => { helper.kill('SIGKILL'); fakeSD.close(); fakeCL.close(); smtpServer.close(); imapServer.close(); });

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
  const { stdout } = await promisify(execFile)('/usr/bin/xattr', ['-p', 'com.apple.quarantine', docxPath]);
  assert.match(stdout, /^0081;[0-9a-f]+;Debate Uploader;/, 'files from a room are marked as downloaded');
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

test('caselist: all:true lists past years newest first, minus the old-site ones', async () => {
  await loginOk();
  assert.deepEqual((await waitJob((await call('/caselist/caselists', { all: true })).body.job)).result, [
    { name: 'hspf26', label: 'HS PF 2026', event: 'pf', year: 2026, archived: false },
    { name: 'hspf25', label: 'HS PF 2025', event: 'pf', year: 2025, archived: true },
  ]);
});

async function waitLong(id) {
  for (let i = 0; i < 200; i++) {
    const { body } = await call('/job', { id, waitMs: 500 });
    if (body.state !== 'running') return body;
  }
  throw new Error('job never finished');
}

test('card search: a plain query is a phrase; every caselist, hits in the order given; a 429 is retried, a failure skipped; hits are file/cite rows only', async () => {
  await loginOk();
  const r = await waitLong((await call('/caselist/card-search', { q: 'winter', caselists: ['hspf26', 'hspf25', 'bad', 'x1', 'x2'] })).body.job);
  assert.equal(r.state, 'done');
  assert.equal(r.result.done, 5);
  assert.deepEqual(r.result.failed, ['bad']);
  assert.deepEqual(r.result.searched, ['hspf26', 'hspf25', 'x1', 'x2'], 'the plugin re-offers the rest');
  assert.deepEqual(r.result.hits.map((h) => h.caselist), ['hspf26', 'hspf25', 'x1', 'x2']);
  assert.deepEqual(r.result.hits[0], { type: 'file', caselist: 'hspf26', caselistLabel: 'hspf26', school: 'Lexington', team: 'AlHu', teamLabel: 'Lexington AlHu', title: 'a.docx', snippet: 'nuclear winter kills', path: 'hspf26/Lexington/AlHu/a.docx' });
  assert.equal(upstream['/v1/search?q=%22winter%22&shard=hspf25'], 2, 'the 429 was retried once');
  assert.deepEqual(await waitJob((await call('/caselist/card-search', { q: '  ', caselists: ['hspf26'] })).body.job), { state: 'error', message: 'no_query' });
  const before = upstream['/v1/search?q=%22winter%22&shard=hspf26'];
  const again = await waitLong((await call('/caselist/card-search', { q: 'winter', caselists: ['hspf26'] })).body.job);
  assert.equal(again.result.hits.length, 1);
  assert.equal(upstream['/v1/search?q=%22winter%22&shard=hspf26'], before, 'a repeat within 30 min spends no search');
});

test('card search: stop ends a running search at the next caselist', async () => {
  await loginOk();
  const shards = Array.from({ length: 30 }, (_, i) => `slow${i}`);
  const { job } = (await call('/caselist/card-search', { q: 'winter', caselists: shards })).body;
  for (let i = 0; i < 100; i++) {
    const { body } = await call('/job', { id: job });
    if (body.progress && body.progress.done >= 1) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.deepEqual((await call('/caselist/card-search/stop', {})).body, { ok: true });
  const r = await waitLong(job);
  assert.equal(r.result.stopped, true);
  assert.ok(r.result.done < 30, `stopped after ${r.result.done}`);
});

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
  assert.deepEqual((await waitJob((await call('/caselist/schools', { caselist: 'hspf26' })).body.job)).result.map((x) => x.name), ['StMarks', 'Lexington', 'LexingtonCath']);
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

test('scouting: search returns teams; team returns rounds newest first with cites', async () => {
  await loginOk();
  const s = await waitJob((await call('/caselist/search', { caselist: 'hspf26', q: 'Lexington AlHu' })).body.job);
  assert.deepEqual(s.result, [{ school: 'Lexington', team: 'AlHu', label: 'Lexington AlHu', schoolLabel: 'Lexington' }]);
  const t = await waitJob((await call('/caselist/team', { caselist: 'hspf26', school: 'Lexington', team: 'AlHu' })).body.job);
  assert.deepEqual(t.result.rounds.map((r) => r.id), [11, 14, 12, 13], "openCaselist order: newest tournament, then latest round");
  assert.equal(t.result.cites[0].roundId, 11);
});

test('scouting: open downloads a listed doc into the team folder and opens it in CardMirror', async () => {
  const path = 'hspf26/Lexington/AlHu/Lexington-AlHu-Con-Glenbrooks-Round3.docx';
  const r = await waitJob((await call('/caselist/open', { caselist: 'hspf26', school: 'Lexington', team: 'AlHu', path })).body.job);
  const saved = join(downloadDir, 'caselist', 'hspf26', 'Lexington-AlHu', 'Lexington-AlHu-Con-Glenbrooks-Round3.docx');
  assert.deepEqual(r, { state: 'done', result: { name: 'Lexington-AlHu-Con-Glenbrooks-Round3.docx', path: saved, app: 'CardMirror' } });
  assert.equal(await readFile(saved, 'utf8'), 'LEXDOC');
  assert.equal((await readFile(openLog, 'utf8')).trim().split('\n').at(-1), `-b|com.cardmirror.app|${saved}|`);
});

test('scouting: an unusual file type is saved and revealed in Finder, never opened', async () => {
  const r = await waitJob((await call('/caselist/open', { caselist: 'hspf26', school: 'Lexington', team: 'AlHu', path: 'hspf26/Lexington/AlHu/notes.webloc' })).body.job);
  const saved = join(downloadDir, 'caselist', 'hspf26', 'Lexington-AlHu', 'notes.webloc');
  assert.deepEqual(r, { state: 'done', result: { name: 'notes.webloc', path: saved, app: 'finder' } });
  assert.equal((await readFile(openLog, 'utf8')).trim().split('\n').at(-1), `-R|${saved}|`);
});

test('scouting: if opening fails the file is still saved and the result says so', async () => {
  const r = await waitJob((await call('/caselist/open', { caselist: 'hspf26', school: 'Lexington', team: 'AlHu', path: 'hspf26/Lexington/AlHu/FAILOPEN.docx' })).body.job);
  assert.equal(r.state, 'done');
  assert.equal(r.result.opened, false);
  assert.equal(await readFile(r.result.path, 'utf8'), 'LEXDOC');
});

test('scout match: Tabroom "Lexington AH" → the team whose debaters are A… & H…, the closer school wins a tie', async () => {
  const r = await waitJob((await call('/caselist/scout', { caselist: 'hspf26', opponent: 'Lexington AH' })).body.job);
  assert.equal(r.state, 'done');
  assert.deepEqual(r.result.match, { school: 'Lexington', team: 'AlHu', label: 'Lexington AlHu', debaters: ['Ali', 'Hu'], names: ['Simal Ali', 'Christina Hu'], schoolLabel: 'Lexington' });
  const none = await waitJob((await call('/caselist/scout', { caselist: 'hspf26', opponent: 'Nowhere ZZ' })).body.job);
  assert.deepEqual(none.result, { caselist: null, match: null, candidates: [] });
});

test('scout with no caselist given tries every open caselist and reports which one matched', async () => {
  const r = await waitJob((await call('/caselist/scout', { opponent: 'Lexington AH' })).body.job);
  assert.equal(r.state, 'done');
  assert.deepEqual(r.result.caselist, { name: 'hspf26', label: 'HS PF 2026', event: 'pf' });
  assert.equal(r.result.match.team, 'AlHu');
  const none = await waitJob((await call('/caselist/scout', { opponent: 'Nowhere ZZ' })).body.job);
  assert.deepEqual(none.result, { caselist: null, match: null, candidates: [] });
});

test('prefs: set then get round-trips through the helper; unknown keys are refused', async () => {
  assert.deepEqual((await call('/prefs/get', {})).body, { ok: true, prefs: {} });
  assert.deepEqual((await call('/prefs/set', { key: 'lastRoom', value: 'FwaXtA' })).body, { ok: true });
  assert.deepEqual((await call('/prefs/get', {})).body, { ok: true, prefs: { lastRoom: 'FwaXtA' } });
  assert.deepEqual((await call('/prefs/set', { key: 'password', value: 'x' })).body, { ok: false, error: 'bad_key' });
});

test('speed: one /job call with waitMs returns the finished result (no client-side sleeps needed)', async () => {
  const start = await call('/caselist/caselists', {});
  const t0 = Date.now();
  const r = await call('/job', { id: start.body.job, waitMs: 2000 });
  assert.equal(r.body.state, 'done');
  assert.ok(Date.now() - t0 < 1500, `answered in ${Date.now() - t0} ms`);
});

test('speed: school lists are cached; logging in clears the cache', async () => {
  const key = '/v1/caselists/hspf26/schools';
  await loginOk(); // start from an empty cache (earlier tests may have filled it)
  const before = upstream[key] || 0;
  await waitJob((await call('/caselist/schools', { caselist: 'hspf26' })).body.job);
  await waitJob((await call('/caselist/schools', { caselist: 'hspf26' })).body.job);
  await waitJob((await call('/caselist/scout', { caselist: 'hspf26', opponent: 'Lexington AH' })).body.job);
  assert.ok((upstream[key] || 0) - before <= 1, `fetched ${(upstream[key] || 0) - before} times`);
  await loginOk();
  await waitJob((await call('/caselist/schools', { caselist: 'hspf26' })).body.job);
  assert.equal((upstream[key] || 0) - before, 2, 'refetched after login');
});

test('scouting: a path not in the team round list is refused without downloading', async () => {
  const r = await waitJob((await call('/caselist/open', { caselist: 'hspf26', school: 'Lexington', team: 'AlHu', path: 'hspf26/Other/Team/secret.docx' })).body.job);
  assert.deepEqual(r, { state: 'error', message: 'removed' });
});

test('evidence: set folders → background scan → search → open the file or just the card', async () => {
  const dir = join(downloadDir, 'evidence');
  await mkdir(dir, { recursive: true });
  const xml = '<w:document><w:body><w:p><w:pPr><w:pStyle w:val="Heading3"/></w:pPr><w:r><w:t>AT: Offshoring</w:t></w:r></w:p>'
    + '<w:p><w:pPr><w:pStyle w:val="Heading4"/></w:pPr><w:r><w:t>Data centers stay onshore</w:t></w:r></w:p><w:p><w:r><w:t>Rogan 26</w:t></w:r></w:p>'
    + '<w:p><w:pPr><w:pStyle w:val="Heading4"/></w:pPr><w:r><w:t>Other card</w:t></w:r></w:p></w:body></w:document>';
  const raw = Buffer.from(xml);
  await writeFile(join(dir, 'Grid.docx'), writeZip([{ name: 'word/document.xml', method: 8, crc: crc32(raw), usize: raw.length, data: deflateRawSync(raw) }]));

  assert.equal((await call('/evidence/folders', { folders: [join(downloadDir, 'missing')] })).body.error, `no_folder:${join(downloadDir, 'missing')}`);
  assert.equal((await call('/evidence/folders', { folders: [dir, dir] })).body.ok, true);
  let st;
  for (let i = 0; i < 100; i++) { st = (await call('/evidence/status', {})).body; if (!st.scanning && st.files) break; await new Promise((r) => setTimeout(r, 50)); }
  assert.deepEqual([st.folders, st.files, st.cards], [[dir], 1, 2]);

  const { results } = (await call('/evidence/search', { query: 'onshore rogan' })).body;
  assert.deepEqual(results.map((r) => [r.tag, r.cite, r.headings, r.file]), [['Data centers stay onshore', 'Rogan 26', ['AT: Offshoring'], 'Grid.docx']]);
  assert.equal((await call('/evidence/open', { path: '/etc/hosts', ordinal: 0 })).body.error, 'not_indexed');

  const opened = (await call('/evidence/open', { path: results[0].path, ordinal: results[0].ordinal })).body;
  assert.deepEqual([opened.name, opened.app, opened.quote], ['Grid.docx', 'CardMirror', 'Data centers stay onshore']);
  const card = (await call('/evidence/card', { path: results[0].path, ordinal: results[0].ordinal })).body;
  assert.equal(card.name, 'Data centers stay onshore.docx');
  assert.deepEqual(await readdir(join(downloadDir, 'cards')), ['Data centers stay onshore.docx']);
  const out = unzipEntry(readZip(await readFile(card.path)).get('word/document.xml')).toString();
  assert.match(out, /Rogan 26/);
  assert.doesNotMatch(out, /Other card|AT: Offshoring/);
  const lines = (await readFile(openLog, 'utf8')).trim().split('\n');
  assert.equal(lines.at(-1), `-b|com.cardmirror.app|${card.path}|`);
  assert.equal(lines.at(-2), `-b|com.cardmirror.app|${join(dir, 'Grid.docx')}|`);
});

test('report draft: the round\'s room docs from both teams, in speech order; old docs and PDFs left out', async () => {
  const start = await call('/caselist/report-draft', { room: 'room2' });
  const done = await waitJob(start.body.job);
  assert.equal(done.state, 'done');
  assert.deepEqual(done.result, { report: '1AC -- False Profits, Fool’s Gold\n1NC -- Econ', used: ['Acton 1NC.docx', 'Univ 1AC.docx'], skipped: 1 });
  const none = await waitJob((await call('/caselist/report-draft', { room: 'nope' })).body.job);
  assert.deepEqual(none.result, { report: '', used: [], skipped: 0 });
});

test('card check: each card against its linked page, with progress; no link and dead links are reported, not guessed', async () => {
  const article = '<html><head><meta property="article:published_time" content="2025-02-01"></head><body><p>By Xin Chen.</p><p>Hyperscale loads trigger cascading collapse across the regional grid during peak demand.</p><p>Operators cannot see these loads coming.</p></body></html>';
  const page = createServer((req, res) => {
    if (req.url === '/a') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end(article); }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => page.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${page.address().port}`;
  try {
    const cards = [
      { key: 0, cite: "Chen '25", urls: [`${base}/a`], runs: [{ t: 'Hyperscale loads trigger cascading collapse across the regional grid during peak demand.', h: true }] },
      { key: 1, cite: "Chen '25", urls: [`${base}/a`], runs: [{ t: 'Hyperscale loads trigger cascading collapse. Experts agree every grid will certainly fail within the year.', h: true }] },
      { key: 2, cite: 'Smith 19, no link', urls: [], runs: [{ t: 'Text.', h: true }] },
      { key: 3, cite: `Doe 20 ${base}/gone`, urls: [], runs: [{ t: 'Text.', h: true }] },
    ];
    const { body } = await call('/cardcheck/run', { cards });
    const done = await waitJob(body.job);
    assert.equal(done.state, 'done');
    assert.deepEqual(done.result.results.map((r) => r.status), ['matches', 'differences', 'no_link', 'unreachable']);
    assert.deepEqual(done.result.results[1].issues, ['Not found in the source: "Experts agree every grid will certainly fail within the year."']);
    assert.equal(done.result.results[3].reason, 'http_404');
  } finally { page.close(); }
});

test('gmail: a wrong app password is never saved; the right one is; sends attach the newest send doc and reply in one thread', async () => {
  assert.equal((await call('/gmail/status', {})).body.email, null);
  const bad = await waitJob((await call('/gmail/setup', { email: 'me@gmail.com', appPassword: 'wrong-password' })).body.job);
  assert.deepEqual([bad.state, bad.message], ['error', 'bad_login']);
  await assert.rejects(access(`${keyStore}.gmail`));
  const ok = await waitJob((await call('/gmail/setup', { email: 'me@gmail.com', appPassword: 'abcd efgh ijkl mnop' })).body.job);
  assert.equal(ok.state, 'done');
  assert.deepEqual(JSON.parse(await readFile(`${keyStore}.gmail`, 'utf8')), { email: 'me@gmail.com', appPassword: 'abcdefghijklmnop' });
  assert.equal((await call('/gmail/status', {})).body.email, 'me@gmail.com');
  assert.ok(!(await readFile(helperLog, 'utf8')).includes('abcdefghijklmnop'), 'never logged');

  const first = await waitJob((await call('/gmail/send', { to: ['judge@s.edu', 'opp@x.org'], subject: 'Glenbrooks R3', folder: sendDir })).body.job);
  assert.deepEqual(first.result, { name: 'Send 1AC.docx', recipients: 2, reply: false });
  const m1 = mail.at(-1);
  assert.deepEqual(m1.rcpt, ['judge@s.edu', 'opp@x.org']);
  assert.match(m1.data, /^From: me@gmail\.com\r\nTo: judge@s\.edu, opp@x\.org\r\nSubject: Glenbrooks R3\r\n/);
  const att = m1.data.split('Content-Transfer-Encoding: base64\r\n\r\n')[2].split('\r\n--')[0];
  assert.equal(Buffer.from(att.replace(/\r\n/g, ''), 'base64').toString(), 'docx-bytes');
  const id1 = /Message-ID: (<[^>]+>)/.exec(m1.data)[1];

  const second = await waitJob((await call('/gmail/send', { to: ['judge@s.edu'], subject: 'Glenbrooks R3', folder: sendDir })).body.job);
  assert.equal(second.result.reply, true);
  assert.match(mail.at(-1).data, new RegExp(`Subject: Re: Glenbrooks R3\\r\\n[\\s\\S]*In-Reply-To: ${id1.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));

  // Reply all into a chain someone else started.
  const recent = await waitJob((await call('/gmail/recent', {})).body.job);
  assert.deepEqual(recent.result.messages.map((m) => [m.messageId, m.from, m.cc]), [['<chain-1@school.edu>', 'lee@school.edu', ['opp2@x.org']]]);
  const m = recent.result.messages[0];
  const replied = await waitJob((await call('/gmail/send', { to: ['lee@school.edu', 'opp1@x.org', 'opp2@x.org'], subject: m.subject, text: 'Our 1AC.', replyTo: { messageId: m.messageId, references: m.references }, folder: sendDir })).body.job);
  assert.equal(replied.result.reply, true);
  const r = mail.at(-1).data;
  assert.match(r, /Subject: Re: Glenbrooks R3 chain\r\n/);
  assert.match(r, /In-Reply-To: <chain-1@school\.edu>\r\nReferences: <chain-1@school\.edu>\r\n/);
  assert.match(Buffer.from(r.split('Content-Transfer-Encoding: base64\r\n\r\n')[1].split('\r\n--')[0].replace(/\r\n/g, ''), 'base64').toString(), /^Our 1AC\.$/);

  const mailsBefore = mail.length;
  const changed = await waitJob((await call('/gmail/send', { to: ['a@b.org'], subject: 'x', folder: sendDir, expectName: 'Older 1AC.docx' })).body.job);
  assert.deepEqual([changed.state, changed.message, mail.length], ['error', 'newest_changed', mailsBefore], 'only the doc the form named is sent');

  const badTo = await waitJob((await call('/gmail/send', { to: ['not an email'], subject: 'x', folder: sendDir })).body.job);
  assert.equal(badTo.message, 'bad_recipients');
  await call('/gmail/forget', {});
  await assert.rejects(access(`${keyStore}.gmail`));
  assert.equal((await waitJob((await call('/gmail/send', { to: ['a@b.org'], subject: 'x', folder: sendDir })).body.job)).message, 'gmail_not_set_up');
});

test('bold emphasis: sent docs and the in-place fix turn CardMirror\'s Emphasis style bold', async () => {
  const dir = join(downloadDir, 'emph');
  await mkdir(dir, { recursive: true });
  const styles = '<w:styles><w:style w:type="character" w:styleId="Emphasis"><w:rPr><w:b w:val="0"/><w:u w:val="single"/></w:rPr></w:style></w:styles>';
  const mk = (name, text) => { const raw = Buffer.from(text); return { name, method: 8, crc: crc32(raw), usize: raw.length, data: deflateRawSync(raw) }; };
  await writeFile(join(dir, 'Send 2AC.docx'), writeZip([mk('word/document.xml', '<w:document><w:body/></w:document>'), mk('word/styles.xml', styles)]));
  const first = await call('/docx/bold-emphasis', { folder: dir });
  assert.deepEqual([first.body.name, first.body.changed], ['Send 2AC.docx', true]);
  const fixed = unzipEntry(readZip(await readFile(join(dir, 'Send 2AC.docx'))).get('word/styles.xml')).toString();
  assert.match(fixed, /<w:b\/><w:bCs\/><w:i w:val="0"\/><w:u w:val="single"\/>/);
  assert.equal((await call('/docx/bold-emphasis', { folder: dir })).body.changed, false);
});

test('SIGTERM removes the session file but keeps identity', async () => {
  const sessionPath = join(bridgeDir, 'debate-uploader.session.json');
  const exited = new Promise((r) => helper.once('exit', r));
  helper.kill('SIGTERM');
  await exited;
  await assert.rejects(access(sessionPath));
  await access(join(bridgeDir, 'debate-uploader.json'));
});
