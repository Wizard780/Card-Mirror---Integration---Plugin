import { test, before } from 'node:test';
import assert from 'node:assert/strict';

let def;
before(async () => {
  globalThis.window = { __registerCardMirrorPlugin: (d) => { def = d; } };
  await import('../plugin/plugin.js');
});

const ok = (body) => ({ ok: true, status: 200, body });
const cmd = (suffix) => def.commands.find((c) => c.id === `debate-uploader.${suffix}`);

function harness({ responses = [], settings = {}, storage = {}, room = 'abc12', folderAnswer = null, picks = [], file = { name: 'a.docx', size: 10, read: async () => 'QUJD' } } = {}) {
  const calls = [], toasts = [], prompts = [], lists = [];
  const store = new Map(Object.entries(storage));
  const next = typeof responses === 'function' ? responses : () => responses.shift();
  window.__debateUploaderUI = {
    prompt: async (label, initial) => { prompts.push([label, initial]); return /room/i.test(label) ? room : folderAnswer; },
    pickFile: async () => file,
    sleep: async () => {},
    showList: async (title, items, onPick) => { lists.push({ title, items }); for (const i of picks) await onPick(i); },
  };
  const api = {
    appVersion: '1.14.0',
    flowPost: async (app, route, body) => { calls.push({ app, route, body }); return next(); },
    showToast: (m) => toasts.push(m),
    storage: { get: (k) => store.get(k), set: (k, v) => store.set(k, v) },
    settings: { get: (k) => settings[k] ?? '' },
  };
  return { api, calls, toasts, prompts, store, lists };
}

test('registers four commands and one setting under the plugin id', () => {
  assert.equal(def.id, 'debate-uploader');
  assert.equal(def.apiVersion, 1);
  assert.deepEqual(def.commands.map((c) => c.id).sort(), ['debate-uploader.sdBrowse', 'debate-uploader.sdNewest', 'debate-uploader.sdPick', 'debate-uploader.setFolder']);
  assert.deepEqual(def.settings.map((s) => [s.key, s.type, s.default]), [['sendDocFolder', 'text', '']]);
});

test('pick: uploads, polls the job, toasts success, remembers the room', async () => {
  const h = harness({ responses: [ok({ ok: true, job: 'j1' }), ok({ state: 'running' }), ok({ state: 'done', result: { room: 'abc12', name: 'a.docx' } })] });
  await cmd('sdPick').run(h.api);
  assert.deepEqual(h.calls.map((c) => [c.app, c.route]), [
    ['debate-uploader', '/speechdrop/upload'], ['debate-uploader', '/job'], ['debate-uploader', '/job'],
  ]);
  assert.deepEqual(h.calls[0].body, { room: 'abc12', file: { name: 'a.docx', base64: 'QUJD' } });
  assert.deepEqual(h.calls[1].body, { id: 'j1' });
  assert.equal(h.toasts.at(-1), 'Uploaded "a.docx" to SpeechDrop room abc12');
  assert.equal(h.store.get('lastRoom'), 'abc12');
});

test('room code pasted as a URL with spaces is normalized; last room pre-fills', async () => {
  const h = harness({ room: '  https://speechdrop.net/abc12/ ', storage: { lastRoom: 'old99' },
    responses: [ok({ ok: true, job: 'j' }), ok({ state: 'done', result: { room: 'abc12', name: 'a.docx' } })] });
  await cmd('sdPick').run(h.api);
  assert.deepEqual(h.prompts.map((p) => p[1]), ['old99']);
  assert.equal(h.calls[0].body.room, 'abc12');
});

test('garbage room code is refused without calling the helper', async () => {
  const h = harness({ room: 'abc 12!' });
  await cmd('sdPick').run(h.api);
  assert.equal(h.calls.length, 0);
  assert.match(h.toasts.at(-1), /doesn't look like a SpeechDrop room code/);
});

test('cancelling the room box or the file picker does nothing', async () => {
  const a = harness({ room: null });
  await cmd('sdPick').run(a.api);
  const b = harness({ file: null });
  await cmd('sdPick').run(b.api);
  assert.deepEqual([a.calls.length, a.toasts.length, b.calls.length, b.toasts.length], [0, 0, 0, 0]);
});

test('file over 10 MB is refused before reading or sending', async () => {
  let read = false;
  const h = harness({ file: { name: 'big.docx', size: 10 * 1024 * 1024 + 1, read: async () => { read = true; return ''; } } });
  await cmd('sdPick').run(h.api);
  assert.equal(read, false);
  assert.equal(h.calls.length, 0);
  assert.equal(h.toasts.at(-1), "File is over SpeechDrop's 10 MB limit.");
});

test('newest: needs the folder setting, then sends the folder', async () => {
  const unset = harness();
  await cmd('sdNewest').run(unset.api);
  assert.equal(unset.calls.length, 0);
  assert.equal(unset.toasts.at(-1), 'Set your send doc folder first: run "Set send doc folder for SpeechDrop…".');

  const h = harness({ settings: { sendDocFolder: ' ~/Send ' },
    responses: [ok({ ok: true, job: 'j' }), ok({ state: 'done', result: { room: 'abc12', name: 'Send.docx' } })] });
  await cmd('sdNewest').run(h.api);
  assert.deepEqual(h.calls[0].body, { room: 'abc12', folder: '~/Send' });
  assert.equal(h.toasts.at(-1), 'Uploaded "Send.docx" to SpeechDrop room abc12');
});

test('error messages: helper down, restarted, job errors, still running', async () => {
  const cases = [
    [[{ ok: false, error: 'app-not-running' }], /Uploader helper isn't running\. Run: launchctl kickstart gui\/\$\(id -u\)\/debate-uploader/],
    [[{ ok: true, status: 401, body: { ok: false, error: 'bad_token' } }], /^Helper restarted\. Try again\.$/],
    [[ok({ ok: true, job: 'j' }), ok({ state: 'error', message: 'no_room' })], /^No SpeechDrop room "abc12"\. Check the code\.$/],
    [[ok({ ok: true, job: 'j' }), ok({ state: 'error', message: 'upload_unknown' })], /Check the room before re-uploading/],
    [[ok({ ok: true, job: 'j' }), ok({ state: 'error', message: 'no_docx:/x/Send' })], /^No \.docx in \/x\/Send\./],
  ];
  for (const [responses, expected] of cases) {
    const h = harness({ responses });
    await cmd('sdPick').run(h.api);
    assert.match(h.toasts.at(-1), expected);
    assert.equal(h.store.get('lastRoom'), undefined, 'room is only remembered on success');
  }
  const forever = harness({ responses: (() => { let first = true; return () => (first ? ((first = false), ok({ ok: true, job: 'j' })) : ok({ state: 'running' })); })() });
  await cmd('sdPick').run(forever.api);
  assert.equal(forever.calls.filter((c) => c.route === '/job').length, 90);
  assert.equal(forever.toasts.at(-1), 'Still running in helper. Check SpeechDrop before re-uploading.');
});

test('setFolder saves the folder to storage, and newest uses it when the setting is empty', async () => {
  const h = harness({ folderAnswer: '  ~/Send Docs  ', storage: { sendDocFolder: '/old' },
    responses: [ok({ ok: true, job: 'j' }), ok({ state: 'done', result: { room: 'abc12', name: 'S.docx' } })] });
  await cmd('setFolder').run(h.api);
  assert.deepEqual(h.prompts[0][1], '/old');
  assert.equal(h.store.get('sendDocFolder'), '~/Send Docs');
  assert.equal(h.toasts.at(-1), 'Send doc folder set to ~/Send Docs');
  await cmd('sdNewest').run(h.api);
  assert.deepEqual(h.calls[0].body, { room: 'abc12', folder: '~/Send Docs' });
});

test('setFolder: cancel keeps the old folder; the declared setting wins over storage', async () => {
  const h = harness({ folderAnswer: null, storage: { sendDocFolder: '/old' }, settings: { sendDocFolder: '/from-settings' },
    responses: [ok({ ok: true, job: 'j' }), ok({ state: 'done', result: { room: 'abc12', name: 'S.docx' } })] });
  await cmd('setFolder').run(h.api);
  assert.equal(h.store.get('sendDocFolder'), '/old');
  assert.equal(h.toasts.length, 0);
  await cmd('sdNewest').run(h.api);
  assert.equal(h.calls[0].body.folder, '/from-settings');
});

const CHECK_ROOM = /Check the room before re-uploading/;

test('I2: start call timing out says the upload may have started, not "try again"', async () => {
  const h = harness({ responses: [{ ok: false, error: 'timeout' }] });
  await cmd('sdPick').run(h.api);
  assert.match(h.toasts.at(-1), /may have started/);
  assert.match(h.toasts.at(-1), /abc12/);
  assert.doesNotMatch(h.toasts.at(-1), /Try again/);
});

test('I2: a few failed polls are tolerated and the job still completes', async () => {
  const h = harness({ responses: [ok({ ok: true, job: 'j' }), { ok: false, error: 'timeout' }, { ok: false, error: 'app-not-running' },
    ok({ state: 'done', result: { room: 'abc12', name: 'a.docx' } })] });
  await cmd('sdPick').run(h.api);
  assert.equal(h.toasts.at(-1), 'Uploaded "a.docx" to SpeechDrop room abc12');
});

test('I2: polling that never recovers, or a lost job, says check the room', async () => {
  const dead = harness({ responses: (() => { let first = true; return () => (first ? ((first = false), ok({ ok: true, job: 'j' })) : { ok: false, error: 'timeout' }); })() });
  await cmd('sdPick').run(dead.api);
  assert.match(dead.toasts.at(-1), CHECK_ROOM);
  const lost = harness({ responses: [ok({ ok: true, job: 'j' }), ok({ state: 'error', message: 'unknown_job' })] });
  await cmd('sdPick').run(lost.api);
  assert.match(lost.toasts.at(-1), CHECK_ROOM);
});

test('I3: a file that cannot be read ends in a toast, not silence', async () => {
  const h = harness({ file: { name: 'gone.docx', size: 10, read: async () => { throw new Error('NotFoundError'); } } });
  await cmd('sdPick').run(h.api);
  assert.equal(h.calls.length, 0);
  assert.equal(h.toasts.at(-1), "Couldn't read that file. Pick it again.");
});

test('I4: a second trigger while one is in progress is refused', { timeout: 2000 }, async () => {
  let release;
  const h = harness({ responses: [ok({ ok: true, job: 'j' }), ok({ state: 'done', result: { room: 'abc12', name: 'a.docx' } })] });
  window.__debateUploaderUI.prompt = (label, initial) => { h.prompts.push([label, initial]); return new Promise((r) => { release = r; }); };
  const first = cmd('sdPick').run(h.api);
  await new Promise((r) => setImmediate(r));
  await cmd('sdPick').run(h.api);
  assert.equal(h.prompts.length, 1);
  assert.equal(h.toasts.at(-1), 'An upload is already in progress.');
  release('abc12');
  await first;
  assert.equal(h.toasts.at(-1), 'Uploaded "a.docx" to SpeechDrop room abc12');
  const again = harness({ room: null });
  await cmd('sdPick').run(again.api);
  assert.equal(again.prompts.length, 1, 'guard is released after finishing');
});

const FILES = [{ index: 2, name: '1NC.docx', ctime: 1791166355023 }, { index: 0, name: 'cards.pdf', ctime: 1791166000000 }];

test('browse: lists the room newest first and opens picks (list stays usable for several)', async () => {
  const h = harness({ picks: [0, 1], responses: [
    ok({ ok: true, job: 'L' }), ok({ state: 'done', result: FILES }),
    ok({ ok: true, job: 'O1' }), ok({ state: 'done', result: { name: '1NC.docx', path: '/p/1NC.docx', app: 'CardMirror' } }),
    ok({ ok: true, job: 'O2' }), ok({ state: 'done', result: { name: 'cards.pdf', path: '/p/cards.pdf', app: 'default' } }),
  ] });
  await cmd('sdBrowse').run(h.api);
  assert.deepEqual(h.calls.filter((c) => c.route !== '/job').map((c) => [c.route, c.body]), [
    ['/speechdrop/list', { room: 'abc12' }],
    ['/speechdrop/open', { room: 'abc12', index: 2, name: '1NC.docx' }],
    ['/speechdrop/open', { room: 'abc12', index: 0, name: 'cards.pdf' }],
  ]);
  assert.equal(h.lists[0].title, 'SpeechDrop room abc12');
  assert.deepEqual(h.lists[0].items.map((i) => i.label), ['1NC.docx', 'cards.pdf']);
  assert.ok(h.lists[0].items.every((i) => typeof i.detail === 'string' && i.detail.length > 0));
  assert.deepEqual(h.toasts.filter((t) => t.startsWith('Opened')), ['Opened "1NC.docx" in CardMirror', 'Opened "cards.pdf" in your default app']);
  assert.equal(h.store.get('lastRoom'), 'abc12');
});

test('browse: empty room, wrong room, removed file, failed download each get one clear toast', async () => {
  const empty = harness({ responses: [ok({ ok: true, job: 'L' }), ok({ state: 'done', result: [] })] });
  await cmd('sdBrowse').run(empty.api);
  assert.equal(empty.toasts.at(-1), 'Room abc12 has no files yet.');
  assert.equal(empty.lists.length, 0);

  const wrong = harness({ responses: [ok({ ok: true, job: 'L' }), ok({ state: 'error', message: 'no_room' })] });
  await cmd('sdBrowse').run(wrong.api);
  assert.equal(wrong.toasts.at(-1), 'No SpeechDrop room "abc12". Check the code.');

  for (const [code, text] of [['removed', '"1NC.docx" was removed from the room.'], ['download_failed', 'Couldn\'t download "1NC.docx".']]) {
    const h = harness({ picks: [0], responses: [ok({ ok: true, job: 'L' }), ok({ state: 'done', result: FILES }),
      ok({ ok: true, job: 'O' }), ok({ state: 'error', message: code })] });
    await cmd('sdBrowse').run(h.api);
    assert.equal(h.toasts.at(-1), text);
  }
});

test('browse: cancelling the room box does nothing', async () => {
  const h = harness({ room: null });
  await cmd('sdBrowse').run(h.api);
  assert.deepEqual([h.calls.length, h.toasts.length, h.lists.length], [0, 0, 0]);
});
