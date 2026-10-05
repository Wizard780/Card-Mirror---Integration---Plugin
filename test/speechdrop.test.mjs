import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mimeFor, expandHome, newestDocx, uploadToSpeechDrop, MAX_BYTES } from '../lib/speechdrop.mjs';

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

function fakeSD({ page = 200, uploadStatus = 200, uploadBody = '[{"name":"a.docx","ctime":1}]', throwOn = null, cookies = true } = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, init });
    if (!init.method) {
      if (throwOn === 'page') throw new TypeError('fetch failed');
      if (page === 302) return new Response(null, { status: 302, headers: { location: '/' } });
      const headers = cookies
        ? [['set-cookie', 'vertx-web.session=s1; Path=/'], ['set-cookie', 'XSRF-TOKEN=tok/1+2=; Path=/']]
        : [];
      return new Response('<html>', { status: page, headers });
    }
    if (throwOn === 'upload') throw new TypeError('fetch failed');
    return new Response(uploadBody, { status: uploadStatus });
  };
  return { fetchImpl, calls };
}

const doc = (name = 'a.docx', size = 5) => ({ room: 'abc12', name, bytes: Buffer.alloc(size, 1) });
const opts = (sd) => ({ fetchImpl: sd.fetchImpl, base: 'https://sd.test' });

test('mimeFor maps allowed extensions and rejects others', () => {
  assert.equal(mimeFor('1AC.DOCX'), DOCX);
  assert.equal(mimeFor('x.pdf'), 'application/pdf');
  assert.equal(mimeFor('x.txt'), 'text/plain');
  assert.throws(() => mimeFor('x.exe'), /bad_type/);
});

test('expandHome expands ~ and ~/ only', () => {
  assert.equal(expandHome('~', '/Users/me'), '/Users/me');
  assert.equal(expandHome('~/Send', '/Users/me'), '/Users/me/Send');
  assert.equal(expandHome('/abs/~x', '/Users/me'), '/abs/~x');
});

test('newestDocx picks newest real .docx, skipping lock files, folders and other types', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'send-'));
  const files = { 'old.docx': 1000, 'new.docx': 2000, '~$new.docx': 3000, 'notes.txt': 4000 };
  for (const [n, t] of Object.entries(files)) {
    await writeFile(join(dir, n), n);
    await utimes(join(dir, n), t, t);
  }
  await mkdir(join(dir, 'folder.docx'));
  await utimes(join(dir, 'folder.docx'), 5000, 5000);
  const got = await newestDocx(dir + '/');
  assert.equal(got.name, 'new.docx');
  assert.equal(got.bytes.toString(), 'new.docx');
});

test('newestDocx errors: unset folder, empty or missing folder', async () => {
  await assert.rejects(newestDocx(''), /^Error: no_folder$/);
  await assert.rejects(newestDocx('   '), /^Error: no_folder$/);
  const empty = await mkdtemp(join(tmpdir(), 'empty-'));
  await assert.rejects(newestDocx(empty), new RegExp(`no_docx:${empty}`));
  await assert.rejects(newestDocx('/definitely/not/here'), /no_docx:\/definitely\/not\/here/);
});

test('upload: forwards cookies + XSRF token and sends the file with its mime type', async () => {
  const sd = fakeSD();
  const result = await uploadToSpeechDrop(doc(), opts(sd));
  assert.deepEqual(result, { room: 'abc12', name: 'a.docx' });
  assert.equal(sd.calls[0].url, 'https://sd.test/abc12');
  assert.equal(sd.calls[0].init.redirect, 'manual');
  const up = sd.calls[1];
  assert.equal(up.url, 'https://sd.test/abc12/upload');
  assert.equal(up.init.method, 'POST');
  assert.equal(up.init.headers.Cookie, 'vertx-web.session=s1; XSRF-TOKEN=tok/1+2=');
  assert.equal(up.init.headers['X-XSRF-TOKEN'], 'tok/1+2=');
  assert.equal(up.init.body.get('X-XSRF-TOKEN'), 'tok/1+2=');
  const file = up.init.body.get('file');
  assert.equal(file.name, 'a.docx');
  assert.equal(file.type, DOCX);
  assert.equal(file.size, 5);
});

test('upload: nonexistent room (302) is no_room and nothing is posted', async () => {
  const sd = fakeSD({ page: 302 });
  await assert.rejects(uploadToSpeechDrop(doc(), opts(sd)), /^Error: no_room$/);
  assert.equal(sd.calls.length, 1);
});

test('upload: SpeechDrop 400 surfaces its err code', async () => {
  const sd = fakeSD({ uploadStatus: 400, uploadBody: '{"err":"bad_type"}' });
  await assert.rejects(uploadToSpeechDrop(doc(), opts(sd)), /^Error: bad_type$/);
});

test('upload: failure before sending is unreachable; after sending is upload_unknown', async () => {
  await assert.rejects(uploadToSpeechDrop(doc(), opts(fakeSD({ throwOn: 'page' }))), /^Error: unreachable$/);
  await assert.rejects(uploadToSpeechDrop(doc(), opts(fakeSD({ throwOn: 'upload' }))), /^Error: upload_unknown$/);
});

test('upload: local validation happens before any request', async () => {
  for (const [args, err] of [
    [{ ...doc(), room: 'ab c' }, 'bad_room'],
    [{ ...doc(), room: '' }, 'bad_room'],
    [doc('a.docx', MAX_BYTES + 1), 'too_large'],
    [doc('virus.exe'), 'bad_type'],
  ]) {
    const sd = fakeSD();
    await assert.rejects(uploadToSpeechDrop(args, opts(sd)), new RegExp(`^Error: ${err}$`));
    assert.equal(sd.calls.length, 0, err);
  }
});

test('upload: missing XSRF cookie is no_csrf', async () => {
  await assert.rejects(uploadToSpeechDrop(doc(), opts(fakeSD({ cookies: false }))), /^Error: no_csrf$/);
});

test('upload: 200 with an index counts as success even if the name is spelled differently', async () => {
  const sd = fakeSD({ uploadBody: '[{"name":"1AC ? Ports.docx","ctime":1}]' });
  const r = await uploadToSpeechDrop(doc('1AC — Ports.docx'), opts(sd));
  assert.deepEqual(r, { room: 'abc12', name: '1AC — Ports.docx' });
});

test('upload: ambiguous answers after the POST are upload_unknown (non-JSON 200, 5xx, broken body)', async () => {
  await assert.rejects(uploadToSpeechDrop(doc(), opts(fakeSD({ uploadBody: '<html>' }))), /^Error: upload_unknown$/);
  await assert.rejects(uploadToSpeechDrop(doc(), opts(fakeSD({ uploadStatus: 502, uploadBody: 'bad gateway' }))), /^Error: upload_unknown$/);
  const broken = new ReadableStream({ start(c) { c.error(new TypeError('terminated')); } });
  await assert.rejects(uploadToSpeechDrop(doc(), opts(fakeSD({ uploadBody: broken }))), /^Error: upload_unknown$/);
});
