import { test, before } from 'node:test';
import assert from 'node:assert/strict';

let def;
before(async () => {
  globalThis.window = { __debateUploaderTest: true, __registerCardMirrorPlugin: (d) => { def = d; } };
  await import('../plugin/plugin.js');
});

const ok = (body) => ({ ok: true, status: 200, body });
const cmd = (suffix) => def.commands.find((c) => c.id === `debate-uploader.${suffix}`);

function harness({ prefs = {}, responses = [], settings = {}, storage = {}, room = 'abc12', folderAnswer = null, email = 'me@x.com', password = 'pw-secret', file = { name: 'a.docx', size: 10, read: async () => 'QUJD' } } = {}) {
  const calls = [], toasts = [], prompts = [];
  const store = new Map(Object.entries(storage));
  // The helper's settings copy (CardMirror wipes file-loaded plugin storage at launch).
  const prefsSets = [];
  const prefsReply = (route, body) => {
    if (route === '/prefs/get') return ok({ ok: true, prefs });
    if (route === '/prefs/set') { prefsSets.push([body.key, body.value]); return ok({ ok: true }); }
    return null;
  };
  const next = typeof responses === 'function' ? responses : () => responses.shift();
  window.__debateUploaderUI = {
    prompt: async (label, initial, opts = {}) => {
      prompts.push([label, initial, opts]);
      if (/email/i.test(label)) return email; // before /room/: "Tabroom email" contains "room"
      if (/password/i.test(label)) return password;
      if (/room/i.test(label)) return room;
      return folderAnswer;
    },
    pickFile: async () => file,
    sleep: () => new Promise((r) => setImmediate(r)),
  };
  const api = {
    appVersion: '1.14.0',
    flowPost: async (app, route, body) => { const pr = prefsReply(route, body); if (pr) return pr; calls.push({ app, route, body }); return next(); },
    showToast: (m) => toasts.push(m),
    storage: { get: (k) => store.get(k), set: (k, v) => store.set(k, v) },
    settings: { get: (k) => settings[k] ?? '' },
  };
  return { api, calls, toasts, prompts, store, prefsReply, prefsSets };
}

test('registers twenty-nine commands and the settings under the plugin id', () => {
  assert.equal(def.id, 'debate-uploader');
  assert.equal(def.apiVersion, 1);
  assert.deepEqual(def.commands.map((c) => c.id).sort(), ['debate-uploader.boldEmphasis', 'debate-uploader.cardCheck', 'debate-uploader.cardCheckLast', 'debate-uploader.caselistCardSearch', 'debate-uploader.caselistScout', 'debate-uploader.caselistSearch', 'debate-uploader.caselistTeam', 'debate-uploader.caselistUpload', 'debate-uploader.clearOpenCache', 'debate-uploader.emailChain', 'debate-uploader.evidenceFolders', 'debate-uploader.evidenceSearch', 'debate-uploader.gmailForget', 'debate-uploader.gmailSetup', 'debate-uploader.markCards', 'debate-uploader.quickSwitcher', 'debate-uploader.sdAutoOpen', 'debate-uploader.sdBrowse', 'debate-uploader.sdNewest', 'debate-uploader.sdOpenDrop', 'debate-uploader.sdPick', 'debate-uploader.sdUnwatch', 'debate-uploader.sdWatch', 'debate-uploader.sdZip', 'debate-uploader.setFolder',
 'debate-uploader.tabroomLogin', 'debate-uploader.tabroomLogout', 'debate-uploader.tabroomRounds', 'debate-uploader.textCompare']);
  assert.deepEqual(def.settings.find((s) => s.key === 'theme').options, ['Standard', 'Sleek', 'Liquid']);
  assert.deepEqual(def.settings.map((s) => [s.key, s.type, s.default]), [['sendDocFolder', 'text', ''], ['theme', 'select', 'Standard'], ['themeWholeApp', 'boolean', false], ['fastOpen', 'boolean', true], ['openCache', 'boolean', true], ['quickSwitcherKey', 'boolean', true]]);
});

test('pick: uploads, polls the job, toasts success, remembers the room', async () => {
  const h = harness({ responses: [ok({ ok: true, job: 'j1' }), ok({ state: 'running' }), ok({ state: 'done', result: { room: 'abc12', name: 'a.docx' } })] });
  await cmd('sdPick').run(h.api);
  assert.deepEqual(h.calls.map((c) => [c.app, c.route]), [
    ['debate-uploader', '/speechdrop/upload'], ['debate-uploader', '/job'], ['debate-uploader', '/job'],
  ]);
  assert.deepEqual(h.calls[0].body, { room: 'abc12', file: { name: 'a.docx', base64: 'QUJD' } });
  assert.deepEqual(h.calls[1].body, { id: 'j1', waitMs: 1000 }, 'the helper is asked to wait for the job (long-poll)');
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


// Browse harness: /speechdrop/watch answers with the next entry of `watches`
// ({version, files, live} or an Error), repeating the last one; each answer
// yields a macrotask, like the helper's real long-poll. /speechdrop/open is a
// job answered from `opens` by name. `script(view, n)` runs after the list is
// shown (n = 0) and after each update (n = 1, 2, ...); it can pick and close.
function browseHarness({ watches, opens = {}, script, room = 'abc12' }) {
  const h = harness({ room });
  const jobs = new Map();
  let w = 0;
  h.api.flowPost = async (app, route, body) => {
    const pr = h.prefsReply(route, body); if (pr) return pr;
    h.calls.push({ app, route, body });
    if (route === '/speechdrop/watch') {
      await new Promise((r) => setImmediate(r));
      const r = watches[Math.min(w++, watches.length - 1)];
      return r instanceof Error ? { ok: true, status: 500, body: { ok: false, error: r.message } } : ok({ ok: true, ...r });
    }
    if (route === '/speechdrop/open') { jobs.set(`O:${body.name}`, opens[body.name]); return ok({ ok: true, job: `O:${body.name}` }); }
    const r = jobs.get(body.id);
    return ok(r instanceof Error ? { state: 'error', message: r.message } : { state: 'done', result: r });
  };
  h.views = [];
  window.__debateUploaderUI.showList = (title, items, onPick, opts = {}) => {
    let close;
    const closed = new Promise((r) => { close = r; });
    const view = { title, opts, renders: [{ items, status: '' }], onPick, close,
      pick: (label) => onPick(view.renders.at(-1).items.find((it) => it.label === label)) };
    h.views.push(view);
    setImmediate(() => script(view, 0));
    return { closed, update: (next, status) => { view.renders.push({ items: next, status }); setImmediate(() => script(view, view.renders.length - 1)); } };
  };
  return h;
}

const A = { index: 0, name: 'cards.pdf', ctime: 1791166000000 };
const B = { index: 2, name: '1NC.docx', ctime: 1791166355023 };
const C = { index: 3, name: '2NR.docx', ctime: 1791166999000 };
const labels = (render) => render.items.map((i) => i.label + (i.isNew ? '*' : ''));
test('zip: downloads the whole room and says where it went; empty room and failures read plainly', async () => {
  const h = harness({ storage: { lastRoom: 'old99' },
    responses: [ok({ ok: true, job: 'j' }), ok({ state: 'running', progress: { done: 40, total: 100 } }), ok({ state: 'done', result: { name: 'abc12.zip', path: '/d/abc12.zip', count: 3, skipped: 0, app: 'finder' } })] });
  await cmd('sdZip').run(h.api);
  assert.ok(h.toasts.includes('Downloading room abc12: 40 of 100 files…'));
  assert.deepEqual(h.prompts.map((p) => p[1]), ['old99']);
  assert.deepEqual([h.calls[0].route, h.calls[0].body], ['/speechdrop/zip', { room: 'abc12' }]);
  assert.equal(h.toasts.at(-1), 'Saved 3 files to "abc12.zip" and showed it in Finder.');
  assert.equal(h.store.get('lastRoom'), 'abc12');
  const sk = harness({ responses: [ok({ ok: true, job: 'j' }), ok({ state: 'done', result: { name: 'abc12 (2).zip', count: 5, skipped: 2, app: 'finder' } })] });
  await cmd('sdZip').run(sk.api);
  assert.equal(sk.toasts.at(-1), 'Saved 5 files to "abc12 (2).zip" and showed it in Finder. 2 files are no longer on SpeechDrop and were skipped.');
  for (const [code, expected] of [['empty_room', 'SpeechDrop room abc12 has no files yet.'], ['download_failed', "Couldn't download any file in the room. Try again."], ['unreachable', "Couldn't reach speechdrop.net. Try again."]]) {
    const e = harness({ responses: [ok({ ok: true, job: 'j' }), ok({ state: 'error', message: code })] });
    await cmd('sdZip').run(e.api);
    assert.equal(e.toasts.at(-1), expected);
  }
});

const W = (version, files, live = true) => ({ version, files, live });

test('browse: shows the room newest first, says it is live, and opens picks', async () => {
  const h = browseHarness({
    watches: [W(1, [B, A])],
    opens: { '1NC.docx': { name: '1NC.docx', path: '/p', app: 'CardMirror' }, 'cards.pdf': { name: 'cards.pdf', path: '/p2', app: 'default' } },
    script: async (view, n) => { if (n === 0) { await view.pick('1NC.docx'); await view.pick('cards.pdf'); view.close(); } },
  });
  await cmd('sdBrowse').run(h.api);
  assert.equal(h.views[0].title, 'SpeechDrop room abc12');
  assert.match(h.views[0].opts.hint, /^Live/);
  assert.deepEqual(labels(h.views[0].renders[0]), ['1NC.docx', 'cards.pdf']);
  assert.ok(h.views[0].renders[0].items.every((i) => typeof i.detail === 'string' && i.detail.length > 0));
  assert.deepEqual(h.calls.find((c) => c.route === '/speechdrop/watch').body, { room: 'abc12', version: 0 });
  assert.deepEqual(h.calls.filter((c) => c.route === '/speechdrop/open').map((c) => c.body), [
    { room: 'abc12', index: 2, name: '1NC.docx' }, { room: 'abc12', index: 0, name: 'cards.pdf' },
  ]);
  assert.deepEqual(h.toasts.filter((t) => t.startsWith('Opened')), ['Opened "1NC.docx" in CardMirror', 'Opened "cards.pdf" in your default app']);
  assert.equal(h.store.get('lastRoom'), 'abc12');
});

test('browse live: each long-poll passes the last version; a new version appears on top marked new; same version re-renders nothing', async () => {
  const h = browseHarness({ watches: [W(1, [B, A]), W(1, [B, A]), W(1, [B, A]), W(2, [C, B, A])], script: (view, n) => { if (n === 1) view.close(); } });
  await cmd('sdBrowse').run(h.api);
  const r = h.views[0].renders;
  assert.equal(r.length, 2, 'unchanged answers do not re-render');
  assert.deepEqual(labels(r[1]), ['2NR.docx*', '1NC.docx', 'cards.pdf']);
  assert.match(r[1].status, /^Live/);
  const versions = h.calls.filter((c) => c.route === '/speechdrop/watch').map((c) => c.body.version);
  assert.deepEqual(versions.slice(0, 4), [0, 1, 1, 1]);
  const n = versions.length;
  await new Promise((res) => setTimeout(res, 20));
  assert.equal(h.calls.filter((c) => c.route === '/speechdrop/watch').length, n, 'no polling after close');
});

test('browse live: picking after rows shift opens the right file', async () => {
  const h = browseHarness({ watches: [W(1, [B, A]), W(2, [C, B, A])],
    opens: { '1NC.docx': { name: '1NC.docx', path: '/p', app: 'CardMirror' } },
    script: async (view, n) => { if (n === 1) { await view.pick('1NC.docx'); view.close(); } } });
  await cmd('sdBrowse').run(h.api);
  assert.deepEqual(h.calls.filter((c) => c.route === '/speechdrop/open').map((c) => c.body), [{ room: 'abc12', index: 2, name: '1NC.docx' }]);
});

test('browse: an empty room still opens the list and fills in when a file arrives', async () => {
  const h = browseHarness({ watches: [W(1, []), W(2, [A])], script: (view, n) => { if (n === 1) view.close(); } });
  await cmd('sdBrowse').run(h.api);
  assert.deepEqual(h.views[0].renders[0].items, []);
  assert.deepEqual(labels(h.views[0].renders[1]), ['cards.pdf*']);
  assert.equal(h.toasts.length, 0);
});

test('browse fallback: no live socket says "Refreshing every 5 s"; going live updates the hint', async () => {
  const h = browseHarness({ watches: [W(1, [A], false), W(1, [A], true)], script: (view, n) => { if (n === 1) view.close(); } });
  await cmd('sdBrowse').run(h.api);
  assert.match(h.views[0].opts.hint, /^Refreshing every 5 s/);
  assert.match(h.views[0].renders[1].status, /^Live/);
});

test('browse: a failed poll keeps the rows and shows a status; the next answer clears it', async () => {
  const h = browseHarness({ watches: [W(1, [A]), new Error('unreachable'), W(2, [B, A])], script: (view, n) => { if (n === 2) view.close(); } });
  await cmd('sdBrowse').run(h.api);
  const r = h.views[0].renders;
  assert.deepEqual(labels(r[1]), ['cards.pdf']);
  assert.match(r[1].status, /Couldn't refresh, retrying/);
  assert.deepEqual(labels(r[2]), ['1NC.docx*', 'cards.pdf']);
  assert.match(r[2].status, /^Live/);
  assert.equal(h.toasts.length, 0, 'no toast per failed poll');
});

test('browse: wrong room toasts without a list; cancel does nothing; open errors toast', async () => {
  const wrong = browseHarness({ watches: [new Error('no_room')], script: () => {} });
  await cmd('sdBrowse').run(wrong.api);
  assert.equal(wrong.toasts.at(-1), 'No SpeechDrop room "abc12". Check the code.');
  assert.equal(wrong.views.length, 0);

  const down = browseHarness({ watches: [new Error('unreachable')], script: () => {} });
  await cmd('sdBrowse').run(down.api);
  assert.equal(down.toasts.at(-1), "Couldn't reach speechdrop.net. Try again.");

  const cancel = browseHarness({ room: null, watches: [W(1, [A])], script: () => {} });
  await cmd('sdBrowse').run(cancel.api);
  assert.deepEqual([cancel.calls.length, cancel.toasts.length, cancel.views.length], [0, 0, 0]);

  for (const [err, text] of [['removed', '"1NC.docx" was removed from the room.'], ['download_failed', 'Couldn\'t download "1NC.docx".']]) {
    const h = browseHarness({ watches: [W(1, [B])], opens: { '1NC.docx': new Error(err) },
      script: async (view, n) => { if (n === 0) { await view.pick('1NC.docx'); view.close(); } } });
    await cmd('sdBrowse').run(h.api);
    assert.equal(h.toasts.at(-1), text);
  }
});

// Watch harness: /speechdrop/watch answers from `h.state[room]`, which the test
// changes over time ({version, files, live} or an Error); every answer yields a
// macrotask, like the helper's long-poll. /speechdrop/open and /speechdrop/upload
// are jobs. The fake UI records drop toast specs, chip states and beside-picks.
function watchHarness({ room = 'abc12', storage = {}, uploadDuring } = {}) {
  const h = harness({ room, storage });
  h.state = { abc12: W(1, [B, A]), xyz99: W(1, []) };
  const jobs = new Map();
  let n = 0;
  h.api.flowPost = async (app, route, body) => {
    const pr = h.prefsReply(route, body); if (pr) return pr;
    h.calls.push({ app, route, body });
    await new Promise((r) => setImmediate(r));
    if (route === '/speechdrop/watch') {
      const r = h.state[body.room];
      return r instanceof Error ? { ok: false, error: r.message } : ok({ ok: true, ...r });
    }
    if (route === '/speechdrop/open') { jobs.set(`O${++n}`, { name: body.name, path: `/d/${body.name}`, app: 'CardMirror' }); return ok({ ok: true, job: `O${n}` }); }
    if (route === '/speechdrop/upload') { jobs.set(`U${++n}`, { room: body.room, name: body.file.name }); return ok({ ok: true, job: `U${n}` }); }
    if (route === '/job') {
      if (uploadDuring && body.id.startsWith('U')) {
        uploadDuring(h);
        await spin(); // the watch loop sees the push before the upload job answers
      }
      return ok({ state: 'done', result: jobs.get(body.id) });
    }
    return ok({ ok: true });
  };
  h.drops = []; h.chips = []; h.besides = [];
  Object.assign(window.__debateUploaderUI, {
    dropToast: (spec) => { if (spec) h.drops.push(spec); h.toast = spec; },
    watchStatus: (spec) => h.chips.push(spec && { room: spec.room, state: spec.state, auto: spec.auto }),
    armBesidePick: (name) => { h.besides.push(name); return () => {}; },
  });
  h.watchCalls = (r) => h.calls.filter((c) => c.route === '/speechdrop/watch' && (!r || c.body.room === r));
  h.opens = () => h.calls.filter((c) => c.route === '/speechdrop/open').map((c) => c.body);
  return h;
}
const spin = async (n = 20) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };
const drop = (h) => h.toast && h.toast.files.map((f) => f.name);

test('watch: starts from the last room, ignores files already there, toasts a new drop, Open opens it, stop ends polling', async () => {
  const h = watchHarness({ storage: { lastRoom: 'abc12' } });
  await cmd('sdWatch').run(h.api);
  try {
    assert.deepEqual(h.prompts.map((p) => p[1]), ['abc12']);
    assert.equal(h.toasts.at(-1), 'Watching room abc12 for new drops.');
    assert.deepEqual(h.chips.at(-1), { room: 'abc12', state: 'live', auto: false });
    await spin();
    assert.equal(h.drops.length, 0, 'files already in the room are not news');
    assert.ok(h.watchCalls().length > 2, 'keeps long-polling after the command returns');
    assert.ok(h.watchCalls().slice(1).every((c) => c.body.version === 1), 'passes the last version');
    h.state.abc12 = W(2, [C, B, A]);
    await spin();
    assert.deepEqual(drop(h), ['2NR.docx']);
    assert.equal(h.toast.room, 'abc12');
    await h.toast.onOpen(h.toast.files[0].key);
    assert.deepEqual(h.opens(), [{ room: 'abc12', index: 3, name: '2NR.docx' }]);
    assert.equal(h.toasts.at(-1), 'Opened "2NR.docx" in CardMirror');
    assert.equal(h.toast, null, 'opening the only drop hides the toast');
    assert.deepEqual(h.besides, [], 'a manual Open goes through CardMirror as usual');
  } finally {
    await cmd('sdUnwatch').run(h.api);
  }
  assert.equal(h.toasts.at(-1), 'Stopped watching room abc12.');
  assert.equal(h.chips.at(-1), null);
  await spin(5);
  const n = h.watchCalls().length;
  await spin();
  assert.equal(h.watchCalls().length, n, 'no polling after stop');
  await cmd('sdUnwatch').run(h.api);
  assert.equal(h.toasts.at(-1), 'Not watching a SpeechDrop room.');
});

test('watch: several files at once are one toast, newest first; a later drop joins it; dismiss clears it', async () => {
  const h = watchHarness();
  h.state.abc12 = W(1, []);
  await cmd('sdWatch').run(h.api);
  try {
    h.state.abc12 = W(2, [C, B, A]);
    await spin();
    assert.equal(h.drops.length, 1, 'one toast for the burst');
    assert.deepEqual(drop(h), ['2NR.docx', '1NC.docx', 'cards.pdf']);
    const D = { index: 4, name: '1AR.docx', ctime: 1 };
    h.state.abc12 = W(3, [D, C, B, A]);
    await spin();
    assert.deepEqual(drop(h), ['1AR.docx', '2NR.docx', '1NC.docx', 'cards.pdf']);
    h.toast.onDismiss();
    assert.equal(h.toast, null);
    await cmd('sdOpenDrop').run(h.api);
    assert.deepEqual(h.opens(), [{ room: 'abc12', index: 4, name: '1AR.docx' }], 'the keyboard command still opens the newest after a dismiss');
  } finally {
    await cmd('sdUnwatch').run(h.api);
  }
});

test('watch: our own upload to the watched room is not announced, whether the push comes during or after it', async () => {
  const mine = { index: 5, name: 'a.docx', ctime: 1 };
  const theirs = { index: 6, name: 'Smith R2 1NC.docx', ctime: 2 };
  // The socket push lands while the upload job is still running.
  const during = watchHarness({ uploadDuring: (h) => { h.state.abc12 = W(2, [mine, B, A]); } });
  await cmd('sdWatch').run(during.api);
  try {
    await spin();
    await cmd('sdPick').run(during.api);
    await spin();
    assert.ok(during.watchCalls().some((c) => c.body.version === 2), 'the push was seen');
    assert.equal(during.drops.length, 0, 'held during the upload, then recognized as ours');
    during.state.abc12 = W(3, [theirs, mine, B, A]);
    await spin();
    assert.deepEqual(drop(during), ['Smith R2 1NC.docx']);
  } finally {
    await cmd('sdUnwatch').run(during.api);
  }
  // The push lands after the upload finished.
  const after = watchHarness();
  await cmd('sdWatch').run(after.api);
  try {
    await cmd('sdPick').run(after.api);
    after.state.abc12 = W(2, [mine, B, A]);
    await spin();
    assert.equal(after.drops.length, 0);
    // A second file with the same name later is someone else's.
    after.state.abc12 = W(3, [{ ...mine, index: 7, ctime: 9 }, mine, B, A]);
    await spin();
    assert.deepEqual(drop(after), ['a.docx']);
  } finally {
    await cmd('sdUnwatch').run(after.api);
  }
});

test('watch: a deleted file shifting the others to new slots is not news', async () => {
  const h = watchHarness();
  h.state.abc12 = W(1, [C, B, A]);
  await cmd('sdWatch').run(h.api);
  try {
    h.state.abc12 = W(2, [{ ...C, index: 1 }, { ...B, index: 0 }]);
    await spin();
    assert.equal(h.drops.length, 0);
  } finally {
    await cmd('sdUnwatch').run(h.api);
  }
});

test('watch: helper down or restarted retries quietly, shows it in the chip, and re-announces nothing', async () => {
  const h = watchHarness();
  h.state.abc12 = W(5, [B, A]);
  await cmd('sdWatch').run(h.api);
  try {
    const toasts = h.toasts.length;
    h.state.abc12 = new Error('app-not-running');
    await spin();
    assert.equal(h.chips.at(-1).state, 'retrying');
    // Restarted helper: its room counts from version 1 again, polling over HTTP at first.
    h.state.abc12 = W(1, [B, A], false);
    await spin();
    assert.equal(h.chips.at(-1).state, 'polling');
    assert.equal(h.watchCalls().at(-1).body.version, 1, 'adopts the new helper version');
    h.state.abc12 = W(2, [C, B, A], true);
    await spin();
    assert.equal(h.chips.at(-1).state, 'live');
    assert.deepEqual(drop(h), ['2NR.docx'], 'only the file that is really new');
    assert.equal(h.toasts.length, toasts, 'no toast per failed poll');
  } finally {
    await cmd('sdUnwatch').run(h.api);
  }
});

test('watch: switching rooms stops the old one; same room says so; a bad room never starts', async () => {
  const h = watchHarness();
  await cmd('sdWatch').run(h.api);
  try {
    await cmd('sdWatch').run(h.api);
    assert.equal(h.toasts.at(-1), 'Already watching room abc12.');
    assert.equal(h.prompts.at(-1)[1], 'abc12', 'pre-filled with the watched room');
    window.__debateUploaderUI.prompt = async () => 'xyz99';
    await cmd('sdWatch').run(h.api);
    assert.equal(h.toasts.at(-1), 'Watching room xyz99 for new drops (stopped watching abc12).');
    assert.deepEqual(h.chips.at(-1), { room: 'xyz99', state: 'live', auto: false });
    await spin(5);
    const n = h.watchCalls('abc12').length;
    h.state.abc12 = W(2, [C, B, A]);
    await spin();
    assert.equal(h.watchCalls('abc12').length, n, 'the old room is no longer polled');
    assert.equal(h.drops.length, 0);
    assert.equal(h.store.get('lastRoom'), 'xyz99');
  } finally {
    await cmd('sdUnwatch').run(h.api);
  }
  const bad = watchHarness();
  bad.state.abc12 = new Error('no_room');
  await cmd('sdWatch').run(bad.api);
  assert.equal(bad.toasts.at(-1), 'No SpeechDrop room "abc12". Check the code.');
  assert.deepEqual(bad.chips, []);
  await cmd('sdOpenDrop').run(bad.api);
  assert.match(bad.toasts.at(-1), /^Not watching a SpeechDrop room/);
});

test('auto-open: off by default; the toggle is saved; new docs open beside the current doc, one at a time; other files still toast', async () => {
  const h = watchHarness();
  h.state.abc12 = W(1, []);
  await cmd('sdWatch').run(h.api);
  try {
    assert.equal(h.chips.at(-1).auto, false);
    await cmd('sdAutoOpen').run(h.api);
    assert.equal(h.store.get('autoOpenDrops'), true);
    assert.deepEqual(h.prefsSets.at(-1), ['autoOpenDrops', true], 'mirrored to the helper');
    assert.match(h.toasts.at(-1), /^Auto-open is on/);
    assert.equal(h.chips.at(-1).auto, true);
    h.state.abc12 = W(2, [C, B, A]);
    await spin(40);
    assert.deepEqual(h.opens().map((o) => o.name), ['2NR.docx', '1NC.docx'], 'docs open in drop order, newest first');
    assert.deepEqual(h.besides, ['2NR.docx', '1NC.docx']);
    assert.deepEqual(drop(h), ['cards.pdf'], 'a PDF is offered, not opened');
    await cmd('sdAutoOpen').run(h.api);
    assert.equal(h.store.get('autoOpenDrops'), false);
    assert.equal(h.toasts.at(-1), 'Auto-open is off: new drops show a toast with Open.');
  } finally {
    await cmd('sdUnwatch').run(h.api);
  }
});

test('auto-open: the pane picker match and the slot beside the focused one', () => {
  const { pickerFor, besideSlot } = window.__debateUploaderWatch;
  assert.equal(pickerFor('Open Smith R2 1NC.docx into…', 'Smith R2 1NC.docx'), true);
  assert.equal(pickerFor('Open Smith R2 1NC (2).docx into…', 'Smith R2 1NC.docx'), true, 'a re-download saved as "(2)"');
  assert.equal(pickerFor('Open Smith R2 1NC v2.docx into…', 'Smith R2 1NC.docx'), false);
  assert.equal(pickerFor('Open 2 files into…', 'Smith R2 1NC.docx'), false);
  assert.equal(pickerFor('Open Untitled into…', 'Smith R2 1NC.docx'), false);
  const all = [true, true, true];
  assert.deepEqual([besideSlot(0, all), besideSlot(1, all), besideSlot(2, all), besideSlot(-1, all)], [1, 0, 1, 1]);
  assert.equal(besideSlot(0, [true, false, true]), 2, 'skips a slot that is not on screen');
});

test('DOM drop toast: one file reads "X dropped in room R · Open"; a burst lists rows keyed by data, three at most', () => {
  const dom = fakeDom();
  const saved = globalThis.document;
  globalThis.document = dom.doc;
  const { domUI } = window.__debateUploaderWatch;
  try {
    const got = [];
    const spec = (files) => ({ room: 'ab12', files, onOpen: (k) => got.push(['open', k]), onDismiss: () => got.push(['x']), onBrowse: () => got.push(['browse']), onTimeout: () => {} });
    domUI.dropToast(spec([{ key: '3:Smith R2 1NC.docx', name: 'Smith R2 1NC.docx' }]));
    const toasts = () => dom.all(dom.doc.body).filter((n) => n.dataset.du === 'drop');
    const toast = toasts()[0];
    const text = (n) => n._text + n.children.map(text).join('');
    assert.equal(toast.attrs.role, 'status');
    assert.equal(text(toast.children[0]), 'Smith R2 1NC.docx dropped in room ab12Open×');
    dom.button('Open').dispatch('click');
    dom.button('×').dispatch('click');
    assert.deepEqual(got, [['open', '3:Smith R2 1NC.docx'], ['x']]);
    const five = [1, 2, 3, 4, 5].map((i) => ({ key: `f${i}.docx|${i}`, name: `f${i}.docx` }));
    domUI.dropToast(spec(five));
    assert.equal(toasts().length, 1, 'still one toast');
    assert.deepEqual(dom.all(toast).filter((n) => n.dataset.key).map((n) => n.dataset.key), ['f1.docx|1', 'f2.docx|2', 'f3.docx|3']);
    assert.equal(text(toast.children[0]), '5 files dropped in room ab12×');
    dom.button('2 more · Browse room').dispatch('click');
    assert.deepEqual(got.at(-1), ['browse']);
    domUI.dropToast(null);
    assert.equal(toasts().length, 0);
    // Removed while hovered (an Open click): the next toast still fades on its own.
    const realSet = globalThis.setTimeout;
    const timers = [];
    globalThis.setTimeout = (fn, ms) => { timers.push(ms); return 0; };
    try {
      domUI.dropToast(spec(five.slice(0, 1)));
      toasts()[0].dispatch('mouseenter');
      domUI.dropToast(null);
      timers.length = 0;
      domUI.dropToast(spec(five.slice(1, 2)));
      assert.deepEqual(timers, [20000]);
      domUI.dropToast(null);
    } finally {
      globalThis.setTimeout = realSet;
    }
  } finally {
    globalThis.document = saved;
  }
});

test('tabroom login: email pre-fills, password is a secret prompt, only the email is remembered', async () => {
  const h = harness({ storage: { tabroomEmail: 'old@x.com' },
    responses: [ok({ ok: true, job: 'j' }), ok({ state: 'done', result: { loggedIn: true } })] });
  await cmd('tabroomLogin').run(h.api);
  assert.deepEqual(h.prompts.map(([label, initial, opts]) => [/email/i.test(label), initial, !!opts.secret]), [[true, 'old@x.com', false], [false, '', true]]);
  assert.deepEqual(h.calls[0], { app: 'debate-uploader', route: '/tabroom/login', body: { username: 'me@x.com', password: 'pw-secret' } });
  assert.equal(h.toasts.at(-1), 'Logged in to Tabroom.');
  assert.equal(h.store.get('tabroomEmail'), 'me@x.com');
  assert.ok(![...h.store.values()].some((v) => JSON.stringify(v).includes('pw-secret')));
});

test('tabroom login: cancel at either prompt sends nothing; wrong password and locked keychain get clear toasts', async () => {
  for (const opts of [{ email: null }, { password: null }, { password: '' }]) {
    const h = harness(opts);
    await cmd('tabroomLogin').run(h.api);
    assert.equal(h.calls.length, 0);
  }
  for (const [code, text] of [['bad_login', 'Tabroom rejected that email or password.'], ['keychain_failed', "Couldn't use Keychain. Is it locked?"], ['unreachable', "Couldn't reach Tabroom. Try again."]]) {
    const h = harness({ responses: [ok({ ok: true, job: 'j' }), ok({ state: 'error', message: code })] });
    await cmd('tabroomLogin').run(h.api);
    assert.equal(h.toasts.at(-1), text);
  }
});

test('tabroom rounds: current rounds show tournament, round, side, opponent, judge, time in a stacked list', async () => {
  const h = harness({ responses: [ok({ ok: true, job: 'j' }), ok({ state: 'done', result: { current: true, rounds: [
    { id: 9, tournament: 'Glenbrooks', round: 'R3', side: 'Neg', opponent: 'Lexington AB', judge: 'Smith', start_time: '2026-10-10T14:00:00Z' },
  ] } })] });
  let shown;
  window.__debateUploaderUI.showList = (title, items, onPick, opts) => { shown = { title, items, opts }; return { closed: Promise.resolve(), update() {} }; };
  await cmd('tabroomRounds').run(h.api);
  assert.equal(shown.title, 'Tabroom: current rounds');
  assert.equal(shown.opts.stacked, true);
  assert.equal(shown.items[0].label, 'Glenbrooks · R3');
  assert.match(shown.items[0].detail, /^Neg vs Lexington AB · judge Smith · /);
  assert.equal(h.toasts.length, 0);
});

test('tabroom rounds: none, not logged in, expired each toast; recent rounds get a different title', async () => {
  for (const [state, text] of [
    [{ state: 'done', result: { current: false, rounds: [] } }, 'No rounds. Is your Tabroom account linked to your student record?'],
    [{ state: 'error', message: 'not_logged_in' }, 'Not logged in to Tabroom. Run "Log in to Tabroom…".'],
    [{ state: 'error', message: 'login_expired' }, 'Tabroom login expired. Run "Log in to Tabroom…".'],
    [{ state: 'error', message: 'keychain_failed' }, "Couldn't use Keychain. Is it locked?"],
  ]) {
    const h = harness({ responses: [ok({ ok: true, job: 'j' }), ok(state)] });
    await cmd('tabroomRounds').run(h.api);
    assert.equal(h.toasts.at(-1), text);
  }
  const h = harness({ responses: [ok({ ok: true, job: 'j' }), ok({ state: 'done', result: { current: false, rounds: [{ id: 1, tournament: 'T', round: 'R1', side: '', opponent: '', judge: '', start_time: null }] } })] });
  let title;
  window.__debateUploaderUI.showList = (t) => { title = t; return { closed: Promise.resolve(), update() {} }; };
  await cmd('tabroomRounds').run(h.api);
  assert.equal(title, 'Tabroom: recent rounds');
});

test('tabroom logout calls the helper and confirms', async () => {
  const h = harness({ responses: [ok({ ok: true })] });
  await cmd('tabroomLogout').run(h.api);
  assert.deepEqual(h.calls.map((c) => c.route), ['/tabroom/logout']);
  assert.equal(h.toasts.at(-1), 'Logged out of Tabroom.');
});

// Caselist harness: each route's job answers from `results[route]`
// (a value, an Error, or a function of the request body).
function caselistHarness({ results = {}, direct = {}, choose = [], form = () => null, storage = {}, settings = {}, file, prefs = {} } = {}) {
  const h = harness({ storage, settings, file, prefs });
  const jobs = new Map();
  let n = 0;
  h.api.flowPost = async (app, route, body) => {
    const pr = h.prefsReply(route, body); if (pr) return pr;
    h.calls.push({ app, route, body });
    if (route === '/job') {
      const r = jobs.get(body.id);
      return ok(r instanceof Error ? { state: 'error', message: r.message } : { state: 'done', result: r });
    }
    if (route in direct) {
      const d = typeof direct[route] === 'function' ? direct[route](body) : direct[route];
      return d instanceof Error ? { ok: true, status: 500, body: { ok: false, error: d.message } } : ok({ ok: true, ...d });
    }
    const id = `J${n++}`;
    const r = results[route];
    jobs.set(id, typeof r === 'function' ? r(body) : r);
    return ok({ ok: true, job: id });
  };
  h.chooseTitles = [];
  h.forms = [];
  const picks = [...choose];
  window.__debateUploaderUI.choose = async (title, labels) => { h.chooseTitles.push([title, labels]); return picks.shift() ?? null; };
  window.__debateUploaderUI.form = async (spec) => { h.forms.push(spec); return form(spec); };
  return h;
}

const LISTS = {
  '/caselist/caselists': [{ name: 'hspf26', label: 'HS PF 2026', event: 'pf' }, { name: 'ndt26', label: 'NDT 2026', event: 'cx' }],
  '/caselist/schools': [{ name: 'StMarks', label: "St. Mark's" }],
  '/caselist/teams': [{ name: 'StMarksAB', label: "St. Mark's AB" }],
};
const TARGET = { caselist: 'hspf26', caselistLabel: 'HS PF 2026', event: 'pf', school: 'StMarks', schoolLabel: "St. Mark's", team: 'StMarksAB', teamLabel: "St. Mark's AB" };
const TAB = { current: true, rounds: [{ id: 9, tournament: 'Glenbrooks', round: '3', side: 'Neg', opponent: 'Lexington AB', judge: 'Smith', start_time: null }] };
const uploadCall = (h) => h.calls.find((c) => c.route === '/caselist/upload');

test('caselist first run: choose caselist → school → team, then the form; team is remembered', async () => {
  const h = caselistHarness({
    results: { ...LISTS, '/tabroom/rounds': TAB, '/caselist/upload': { name: '1NC.docx' } },
    choose: [0, 0, 0],
    form: (spec) => ({ ...spec.choices[0].fields, fileMode: 'pick' }),
  });
  await cmd('caselistUpload').run(h.api);
  assert.deepEqual(h.chooseTitles.map(([t, l]) => [t, l]), [
    ['Pick a caselist', ['HS PF 2026', 'NDT 2026']],
    ['HS PF 2026: pick your school', ["St. Mark's"]],
    ["St. Mark's: pick your team", ["St. Mark's AB"]],
  ]);
  assert.deepEqual(h.store.get('caselistTarget'), TARGET);
  assert.deepEqual(uploadCall(h).body, {
    caselist: 'hspf26', school: 'StMarks', team: 'StMarksAB',
    round: { tournament: 'Glenbrooks', side: 'N', round: '3', opponent: 'Lexington AB', judge: 'Smith', report: '' },
    file: { name: 'a.docx', base64: 'QUJD' },
  });
  assert.equal(h.toasts.at(-1), `Uploaded "1NC.docx" to HS PF 2026 · St. Mark's · St. Mark's AB`);
});

test('caselist form: Tabroom rounds become fill choices (PF shows Pro/Con) plus General disclosure; fields start empty', async () => {
  const h = caselistHarness({ storage: { caselistTarget: TARGET }, results: { '/tabroom/rounds': TAB } });
  await cmd('caselistUpload').run(h.api);
  const spec = h.forms[0];
  assert.equal(spec.title, 'Upload to Caselist');
  assert.equal(spec.subtitle, "St. Mark's AB · HS PF 2026");
  assert.deepEqual(spec.sideLabels, { A: 'Pro', N: 'Con' });
  assert.deepEqual(spec.fields, { tournament: '', side: '', round: '', opponent: '', judge: '', report: '' });
  assert.deepEqual(spec.choices.map((c) => c.label), ['Glenbrooks · Round 3 · Con vs Lexington AB', 'General disclosure (all tournaments)']);
  assert.deepEqual(spec.choices[0].fields, { tournament: 'Glenbrooks', side: 'N', round: '3', opponent: 'Lexington AB', judge: 'Smith', report: '' });
  assert.deepEqual(spec.choices[1].fields, { tournament: 'All Tournaments', side: '', round: 'All', opponent: '', judge: '', report: '' });
  assert.equal(spec.fileMode, 'pick', 'no send doc folder → pick is the default');
  assert.equal(spec.newestLabel, 'Newest send doc (set a send doc folder first)');
  assert.equal(uploadCall(h), undefined, 'form cancelled → nothing sent');
});

test('caselist form: manual entry with a policy caselist (Aff/Neg) and the newest send doc', async () => {
  const h = caselistHarness({
    storage: { caselistTarget: { ...TARGET, event: 'cx', caselistLabel: 'NDT 2026' }, sendDocFolder: '~/Send' },
    results: { '/tabroom/rounds': { current: false, rounds: [] }, '/caselist/upload': { name: 'Send.docx' } },
    direct: { '/caselist/newest': { name: 'Send.docx', size: 10, mtime: 1791166355023 } },
    form: () => ({ tournament: ' Harvard ', side: 'A', round: 'Octas', opponent: 'X', judge: '', report: '', fileMode: 'newest' }),
  });
  await cmd('caselistUpload').run(h.api);
  assert.deepEqual(h.forms[0].sideLabels, { A: 'Aff', N: 'Neg' });
  assert.deepEqual(h.forms[0].choices.map((c) => c.label), ['General disclosure (all tournaments)']);
  assert.deepEqual(uploadCall(h).body, {
    caselist: 'hspf26', school: 'StMarks', team: 'StMarksAB',
    round: { tournament: 'Harvard', side: 'A', round: 'Octas', opponent: 'X', judge: '', report: '' }, folder: '~/Send', expectName: 'Send.docx',
  });
  assert.match(h.forms[0].newestLabel, /^Newest send doc: Send\.docx \(.+\)$/);
  assert.equal(h.forms[0].fileMode, 'newest');
});

test('caselist form: Tabroom unreachable still allows manual entry; not logged in stops early', async () => {
  const down = caselistHarness({ storage: { caselistTarget: TARGET }, results: { '/tabroom/rounds': new Error('unreachable') } });
  await cmd('caselistUpload').run(down.api);
  assert.equal(down.forms.length, 1);
  assert.deepEqual(down.forms[0].choices.map((c) => c.label), ['General disclosure (all tournaments)']);

  const out = caselistHarness({ storage: { caselistTarget: TARGET }, results: { '/tabroom/rounds': new Error('not_logged_in') } });
  await cmd('caselistUpload').run(out.api);
  assert.equal(out.forms.length, 0);
  assert.equal(out.toasts.at(-1), 'Not logged in to Tabroom. Run "Log in to Tabroom…".');
});

test('caselist form: missing tournament/side/round or send doc folder is refused before upload', async () => {
  for (const [values, storage, text] of [
    [{ tournament: 'T', side: '', round: '1', fileMode: 'pick' }, {}, 'Tournament, side and round are required.'],
    [{ tournament: '', side: 'N', round: '1', fileMode: 'pick' }, {}, 'Tournament, side and round are required.'],
    [{ tournament: 'T', side: 'N', round: '1', fileMode: 'newest' }, {}, 'Set your send doc folder first: run "Set send doc folder for SpeechDrop…".'],
  ]) {
    const h = caselistHarness({ storage: { caselistTarget: TARGET, ...storage }, results: { '/tabroom/rounds': TAB }, form: () => values });
    await cmd('caselistUpload').run(h.api);
    assert.equal(uploadCall(h), undefined);
    assert.equal(h.toasts.at(-1), text);
  }
});

test('caselist upload errors: ambiguous result says check the page; rejection shows the reason; expired login', async () => {
  for (const [err, text] of [
    ['upload_unknown', "The caselist didn't confirm the upload. Check your team's caselist page before uploading again."],
    ['caselist_rejected:Round already exists', 'The caselist rejected the upload: Round already exists'],
    ['login_expired', 'Tabroom login expired. Run "Log in to Tabroom…".'],
  ]) {
    const h = caselistHarness({ storage: { caselistTarget: TARGET }, results: { '/tabroom/rounds': TAB, '/caselist/upload': new Error(err) },
      form: (spec) => ({ ...spec.choices[0].fields, fileMode: 'pick' }) });
    await cmd('caselistUpload').run(h.api);
    assert.equal(h.toasts.at(-1), text);
  }
});

test('caselist team chooser: cancel keeps the old team; empty school list explains; Change team overwrites', async () => {
  const cancel = caselistHarness({ storage: { caselistTarget: TARGET }, results: LISTS, choose: [null] });
  await cmd('caselistTeam').run(cancel.api);
  assert.deepEqual(cancel.store.get('caselistTarget'), TARGET);

  const empty = caselistHarness({ results: { ...LISTS, '/caselist/schools': [] }, choose: [0] });
  await cmd('caselistUpload').run(empty.api);
  assert.equal(empty.toasts.at(-1), 'No schools on HS PF 2026 yet. Create yours on opencaselist.com first.');
  assert.equal(empty.forms.length, 0);

  const change = caselistHarness({ storage: { caselistTarget: TARGET }, results: LISTS, choose: [1, 0, 0] });
  await cmd('caselistTeam').run(change.api);
  assert.equal(change.store.get('caselistTarget').caselist, 'ndt26');
  assert.equal(change.toasts.at(-1), `Caselist team set to NDT 2026 · St. Mark's · St. Mark's AB`);
});

test('caselist newest: a too-big or missing newest doc is refused before upload; a changed one explains', async () => {
  const big = caselistHarness({ storage: { caselistTarget: TARGET, sendDocFolder: '/s' }, results: { '/tabroom/rounds': TAB },
    direct: { '/caselist/newest': { name: 'Huge.docx', size: 10 * 1024 * 1024 + 1, mtime: 1 } },
    form: (spec) => ({ ...spec.choices[0].fields, fileMode: 'newest' }) });
  await cmd('caselistUpload').run(big.api);
  assert.equal(uploadCall(big), undefined);
  assert.equal(big.toasts.at(-1), 'File is over the 10 MB upload limit.');

  const none = caselistHarness({ storage: { caselistTarget: TARGET, sendDocFolder: '/s' }, results: { '/tabroom/rounds': TAB },
    direct: { '/caselist/newest': new Error('no_docx:/s') }, form: (spec) => ({ ...spec.choices[0].fields, fileMode: 'newest' }) });
  await cmd('caselistUpload').run(none.api);
  assert.equal(none.forms[0].newestLabel, 'Newest send doc (none found)');
  assert.equal(uploadCall(none), undefined);
  assert.match(none.toasts.at(-1), /^No \.docx in \/s\./);

  const changed = caselistHarness({ storage: { caselistTarget: TARGET, sendDocFolder: '/s' },
    results: { '/tabroom/rounds': TAB, '/caselist/upload': new Error('newest_changed') },
    direct: { '/caselist/newest': { name: 'A.docx', size: 1, mtime: 1 } }, form: (spec) => ({ ...spec.choices[0].fields, fileMode: 'newest' }) });
  await cmd('caselistUpload').run(changed.api);
  assert.equal(changed.toasts.at(-1), 'The newest send doc changed after the form opened. Run Upload to Caselist again to check it.');
});

// ---- Minimal fake DOM, enough to drive the real form() overlay ----
function fakeDom() {
  const doc = { activeElement: null };
  class El {
    constructor(tag) { this.tagName = tag.toUpperCase(); this.children = []; this.listeners = {}; this.style = { setProperty() {} }; this.value = ''; this._text = ''; this.dataset = {}; this.attrs = {}; }
    get textContent() { return this._text; }
    get parentNode() { return this.parent || null; }
    set textContent(v) { this._text = String(v); for (const c of this.children) c.parent = null; this.children = []; }
    setAttribute(k, v) { this.attrs[k] = String(v); }
    contains(n) { for (let x = n; x; x = x.parent) if (x === this) return true; return false; }
    getAttribute(k) { return this.attrs[k] ?? null; }
    append(...kids) { for (const k of kids) { k.parent = this; this.children.push(k); } }
    remove() { if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this); this.parent = null; this.removed = true; }
    addEventListener(t, f) { (this.listeners[t] ||= []).push(f); }
    dispatch(t, ev = {}) {
      const e = { target: this, key: undefined, preventDefault() {}, stopPropagation() { this.stopped = true; }, ...ev };
      for (let n = this; n && !e.stopped; n = n.parent) for (const f of n.listeners[t] || []) f(e);
    }
    focus() { doc.activeElement = this; }
    scrollIntoView() {}
  }
  doc.createElement = (t) => new El(t);
  doc.body = new El('body');
  doc.head = new El('head');
  doc.getElementById = (id) => [...all(doc.head), ...all(doc.body)].find((n) => n.id === id) || null;
  const Option = function (text, value) { const o = new El('option'); o.textContent = text; o.value = value; return o; };
  function all(n) { return [n, ...n.children.flatMap(all)]; }
  const byField = (name) => all(doc.body).find((n) => n.dataset.field === name);
  const button = (text) => all(doc.body).find((n) => n.tagName === 'BUTTON' && n.textContent === text);
  return { doc, Option, byField, button, all };
}

async function withDom(fn) {
  const dom = fakeDom();
  const saved = { document: globalThis.document, Option: globalThis.Option, ui: window.__debateUploaderUI };
  globalThis.document = dom.doc; globalThis.Option = dom.Option;
  let captured;
  try {
    // Reach the real domUI.form through the plugin: run a caselist upload whose form step we drive.
    const h = harness({ storage: { caselistTarget: TARGET, sendDocFolder: '/s' } });
    delete window.__debateUploaderUI; // harness() installs the fake UI; drive the real DOM UI instead
    h.api.flowPost = async (app, route, body) => {
      h.calls.push({ app, route, body });
      if (route === '/caselist/newest') return ok({ ok: true, name: 'Send 1AC.docx', size: 5, mtime: 1791166355023 });
      if (route === '/tabroom/rounds') return ok({ ok: true, job: 'R' });
      if (route === '/job' && body.id === 'R') return ok({ state: 'done', result: TAB });
      if (route === '/caselist/upload') return ok({ ok: true, job: 'U' });
      return ok({ state: 'done', result: { name: 'Send 1AC.docx' } });
    };
    const running = cmd('caselistUpload').run(h.api);
    // The real UI polls jobs with real 1 s sleeps, so the form appears after ~1 s.
    for (let i = 0; i < 150 && !dom.doc.body.children.length; i++) await new Promise((r) => setTimeout(r, 20));
    captured = await fn(dom, h);
    if (dom.doc.body.children.length) dom.button('Cancel')?.dispatch('click'); // close a form the test left open
    await running; // let the command finish so the plugin's busy flag is released
    return { captured, h };
  } finally {
    for (const n of dom.doc.body.children) n.remove();
    globalThis.document = saved.document; globalThis.Option = saved.Option; window.__debateUploaderUI = saved.ui;
  }
}

test('DOM form: the File choice names the actual newest send doc', async () => {
  const { captured } = await withDom(async (dom) => ({
    files: dom.byField('file').children.map((b) => b.ariaLabel),
    style: !!dom.doc.getElementById('du-style'),
    sub: dom.all(dom.doc.body).find((n) => n.className === 'du-sub')?.textContent,
  }));
  assert.match(captured.files[0], /^Newest send doc: Send 1AC\.docx \(.+\)$/);
  assert.equal(captured.files[1], 'Pick a file…');
  assert.equal(captured.style, true, 'shared stylesheet injected once');
  assert.equal(captured.sub, "St. Mark's AB · HS PF 2026", 'destination on its own line, team first');
});

test('DOM form: Enter on the Fill dropdown fills nothing and never submits; Enter in a text box submits', async () => {
  const { h } = await withDom(async (dom) => {
    const fill = dom.byField('fill');
    fill.value = '0';
    fill.dispatch('change');
    assert.equal(dom.byField('opponent').value, 'Lexington AB', 'choosing a round auto-fills');
    assert.deepEqual(dom.byField('side').children.map((b) => [b.textContent, b.getAttribute('aria-pressed')]), [['Pro', 'false'], ['Con', 'true']], 'side toggle follows the round');
    dom.byField('opponent').value = 'Edited Opp';
    fill.dispatch('keydown', { key: 'Enter' });
    assert.equal(dom.doc.body.children.length, 1, 'Enter on a select must not submit');
    dom.byField('judge').dispatch('keydown', { key: 'Enter' });
    assert.equal(dom.doc.body.children.length, 0, 'Enter in a text input submits');
  });
  const up = h.calls.find((c) => c.route === '/caselist/upload');
  assert.equal(up.body.round.opponent, 'Edited Opp', 'edits after auto-fill are kept');
  assert.equal(up.body.expectName, 'Send 1AC.docx');
});

test('DOM form: Upload with missing side shows an error and posts nothing', async () => {
  const { h } = await withDom(async (dom) => {
    dom.byField('tournament').value = 'Harvard';
    dom.byField('round').value = '2';
    dom.button('Upload').dispatch('click');
    assert.equal(dom.doc.body.children.length, 1);
    assert.equal(dom.all(dom.doc.body).find((n) => n.textContent === 'Tournament, side and round are required.') !== undefined, true);
    dom.button('Cancel').dispatch('click');
  });
  assert.equal(h.calls.find((c) => c.route === '/caselist/upload'), undefined);
});

function scoutHarness({ results = {}, choose = [], storage = {}, prompt = null, prefs = {} } = {}) {
  const h = caselistHarness({ results, choose, storage, prefs });
  h.pages = [];
  window.__debateUploaderUI.teamPage = async (spec) => { h.pages.push(spec); if (h.onPage) await h.onPage(spec); };
  if (prompt !== null) window.__debateUploaderUI.prompt = async (label, initial) => { h.prompts.push([label, initial]); return prompt; };
  return h;
}
const TEAM = { rounds: [
  { id: 11, side: 'N', tournament: '03---Glenbrooks', round: '3', opponent: 'Strake KM', judge: 'Smith', report: 'AI DA, Econ', opensource: 'hspf26/Lexington/AlHu/a.docx', video: null, updated: '2026-10-04 10:00:00' },
  { id: 12, side: 'A', tournament: '01---Yale', round: '2', opponent: '', judge: '', report: '', opensource: null, video: null, updated: '2026-09-20 10:00:00' },
], cites: [{ id: 5, roundId: 11, title: '1NC', cites: 'Smith 24', side: 'N', tournament: '03---Glenbrooks', round: '3' }] };
const LEX = [{ school: 'Lexington', team: 'AlHu', label: 'Lexington AlHu', schoolLabel: 'Lexington' }];
const LEXT = { school: 'Lexington', team: 'AlHu', label: 'Lexington AlHu', schoolLabel: 'Lexington', debaters: ['Ali', 'Hu'], names: ['Simal Ali', 'Christina Hu'] };
const SCOUT_HIT = { match: LEXT, candidates: [LEXT] };
const ONE_ROUND = { current: true, rounds: [{ id: 9, tournament: 'Glenbrooks', round: '4', side: 'Pro', opponent: 'lexington-alhu', judge: 'Lee', start_time: null }] };

test('scout: single current round → helper matches the debater pair → team page with details', async () => {
  const h = scoutHarness({ storage: { caselistTarget: TARGET }, results: { '/tabroom/rounds': ONE_ROUND, '/caselist/scout': SCOUT_HIT, '/caselist/team': TEAM, '/caselist/open': { name: 'a.docx', path: '/p', app: 'CardMirror' } } });
  await cmd('caselistScout').run(h.api);
  assert.equal(h.chooseTitles.length, 0, 'no pickers needed');
  assert.deepEqual(h.calls.find((c) => c.route === '/caselist/scout').body, { caselist: 'hspf26', opponent: 'lexington-alhu' });
  const p = h.pages[0];
  assert.equal(p.title, 'Lexington AlHu');
  assert.equal(p.subtitle, 'HS PF 2026 · 2 rounds · 1 cite entry');
  assert.deepEqual(p.rounds.map((r) => [r.label, r.detail, r.hasFile]), [
    ['Glenbrooks · Round 3 · Con vs Strake KM', p.rounds[0].detail, true],
    ['Yale · Round 2 · Pro', 'cites only', false],
  ]);
  assert.deepEqual(p.rounds[0].info.map(([k]) => k), ['Tournament', 'Round', 'Side', 'Opponent', 'Judge', 'Uploaded', 'File']);
  assert.equal(p.rounds[0].report, 'AI DA, Econ');
  assert.deepEqual(p.rounds[0].cites, [{ title: '1NC', text: 'Smith 24' }]);
  assert.deepEqual(p.cites.map((c) => [c.label, c.detail, c.text]), [['1NC', 'Glenbrooks · Round 3', 'Smith 24']]);
  assert.equal(p.pageUrl, 'https://opencaselist.com/hspf26/Lexington/AlHu');
  await p.onOpen(11);
  assert.deepEqual(h.calls.find((c) => c.route === '/caselist/open').body, { caselist: 'hspf26', school: 'Lexington', team: 'AlHu', path: 'hspf26/Lexington/AlHu/a.docx' });
  assert.equal(h.toasts.at(-1), 'Opened "a.docx" in CardMirror');
  await p.onOpen(12);
  assert.equal(h.calls.filter((c) => c.route === '/caselist/open').length, 1, 'cites-only round opens nothing');
});

test('scout: several rounds → pick one; no unique match → pick a team (debater names shown); nothing found → toast', async () => {
  const two = { current: false, rounds: [ONE_ROUND.rounds[0], { ...ONE_ROUND.rounds[0], id: 10, round: '5', opponent: 'Strake KM' }] };
  const other = { ...LEXT, school: 'StrakeJesuit', team: 'KaMo', label: 'Strake Jesuit KaMo', names: ['Kai Kim', 'Mo Ma'] };
  const pick = scoutHarness({ storage: { caselistTarget: TARGET }, choose: [1, 1], results: { '/tabroom/rounds': two, '/caselist/scout': { match: null, candidates: [LEXT, other] }, '/caselist/team': TEAM } });
  await cmd('caselistScout').run(pick.api);
  assert.deepEqual(pick.chooseTitles.map(([t, l]) => [t, l]), [
    ['Scout which round?', ['Glenbrooks · Round 4 · vs lexington-alhu', 'Glenbrooks · Round 5 · vs Strake KM']],
    ['Which team is Strake KM?', ['Lexington AlHu (Simal Ali & Christina Hu)', 'Strake Jesuit KaMo (Kai Kim & Mo Ma)']],
  ]);
  assert.deepEqual(pick.calls.find((c) => c.route === '/caselist/team').body, { caselist: 'hspf26', school: 'StrakeJesuit', team: 'KaMo' });

  const none = scoutHarness({ storage: { caselistTarget: TARGET }, results: { '/tabroom/rounds': ONE_ROUND, '/caselist/scout': { match: null, candidates: [] } } });
  await cmd('caselistScout').run(none.api);
  assert.equal(none.toasts.at(-1), 'No caselist page for lexington-alhu on HS PF 2026 yet. Try Search the caselist…');

  const out = scoutHarness({ results: { '/tabroom/rounds': new Error('not_logged_in') } });
  await cmd('caselistScout').run(out.api);
  assert.equal(out.toasts.at(-1), 'Not logged in to Tabroom. Run "Log in to Tabroom…".');
});

test('search: pick a caselist (yours first) → a school from the list → a team → team page; no text box', async () => {
  const h = scoutHarness({ storage: { caselistTarget: { ...TARGET, caselist: 'ndt26', caselistLabel: 'NDT 2026' } }, choose: [0, 1, 0],
    results: { '/caselist/caselists': LISTS['/caselist/caselists'], '/caselist/schools': [{ name: 'Acton', label: 'Acton-Boxborough' }, { name: 'Lexington', label: 'Lexington' }],
      '/caselist/teams': [{ name: 'AlHu', label: 'Lexington AlHu' }, { name: 'ChLi', label: 'Lexington ChLi' }], '/caselist/team': TEAM } });
  await cmd('caselistSearch').run(h.api);
  assert.deepEqual(h.chooseTitles.map(([t, l]) => [t, l]), [
    ['Pick a caselist', ['NDT 2026', 'HS PF 2026']],
    ['NDT 2026: pick a school', ['Acton-Boxborough', 'Lexington']],
    ['Lexington: pick a team', ['Lexington AlHu', 'Lexington ChLi']],
  ]);
  assert.deepEqual(h.store.get('scoutCaselist'), { name: 'ndt26', label: 'NDT 2026', event: 'cx' });
  assert.deepEqual(h.calls.find((c) => c.route === '/caselist/teams').body, { caselist: 'ndt26', school: 'Lexington' });
  assert.deepEqual(h.calls.find((c) => c.route === '/caselist/team').body, { caselist: 'ndt26', school: 'Lexington', team: 'AlHu' });
  assert.equal(h.pages[0].title, 'Lexington AlHu');
  assert.equal(h.pages[0].rounds[0].label, 'Glenbrooks · Round 3 · Neg vs Strake KM', 'policy caselist shows Aff/Neg');
  assert.equal(h.prompts.length, 0, 'no free-text search box');

  const one = scoutHarness({ choose: [0, 0], results: { '/caselist/caselists': LISTS['/caselist/caselists'], '/caselist/schools': [{ name: 'Lexington', label: 'Lexington' }], '/caselist/teams': [{ name: 'AlHu', label: 'Lexington AlHu' }], '/caselist/team': TEAM } });
  await cmd('caselistSearch').run(one.api);
  assert.equal(one.chooseTitles.length, 2, 'a school with one team opens it directly');
  assert.equal(one.pages.length, 1);

  const cancel = scoutHarness({ choose: [0, null], results: { '/caselist/caselists': LISTS['/caselist/caselists'], '/caselist/schools': [{ name: 'Lexington', label: 'Lexington' }] } });
  await cmd('caselistSearch').run(cancel.api);
  assert.equal(cancel.pages.length, 0);
  assert.equal(cancel.calls.filter((c) => c.route === '/caselist/teams').length, 0);
});

const ALL_LISTS = [
  { name: 'hspf26', label: 'HS PF 2026-27', event: 'pf', year: 2026, archived: false },
  { name: 'hsld26', label: 'HS LD 2026-27', event: 'ld', year: 2026, archived: false },
  { name: 'hspf25', label: 'HS PF 2025-26', event: 'pf', year: 2025, archived: true },
  { name: 'hspf24', label: 'HS PF 2024-25', event: 'pf', year: 2024, archived: true },
];

test('search the caselist lists past years too; a past year is never remembered for Scout; upload stays on open caselists', async () => {
  const h = scoutHarness({ choose: [2, 0], results: { '/caselist/caselists': ALL_LISTS, '/caselist/schools': [{ name: 'Lexington', label: 'Lexington' }], '/caselist/teams': [{ name: 'AlHu', label: 'Lexington AlHu' }], '/caselist/team': TEAM } });
  await cmd('caselistSearch').run(h.api);
  assert.deepEqual(h.calls.find((c) => c.route === '/caselist/caselists').body, { all: true });
  assert.deepEqual(h.chooseTitles[0][1], ['HS PF 2026-27', 'HS LD 2026-27', 'HS PF 2025-26', 'HS PF 2024-25']);
  assert.deepEqual(h.calls.find((c) => c.route === '/caselist/team').body, { caselist: 'hspf25', school: 'Lexington', team: 'AlHu' });
  assert.equal(h.store.get('scoutCaselist'), undefined);
  assert.deepEqual(h.prefsSets, []);

  const up = caselistHarness({ results: { ...LISTS, '/tabroom/rounds': TAB }, choose: [null] });
  await cmd('caselistUpload').run(up.api);
  assert.deepEqual(up.calls.find((c) => c.route === '/caselist/caselists').body, {});
});

test('card search: query → scope (your event, each of its years, this year, other events, everything, single caselists) → deduped rows; retry what failed; file hit opens the doc, cite hit the team page', async () => {
  const LISTS6 = [
    ...ALL_LISTS,
    { name: 'hspf23', label: 'HS PF 2023-24', event: 'pf', year: 2023, archived: true },
    { name: 'hsld25', label: 'HS LD 2025-26', event: 'ld', year: 2025, archived: true },
  ];
  const hit = (caselist, snippet, extra = {}) => ({ id: `${caselist}/Hawken/JoMi/${snippet}`, type: 'file', caselist, caselistLabel: caselist, school: 'Hawken', team: 'JoMi', teamLabel: 'Hawken JoMi', title: 'a.docx', snippet, path: `${caselist}/Hawken/JoMi/a.docx`, ...extra });
  const h = scoutHarness({ prompt: 'Starr 15', choose: [0], storage: { caselistTarget: TARGET },
    results: {
      '/caselist/caselists': LISTS6,
      '/caselist/card-search': (body) => (body.caselists.length > 1
        ? { done: 3, total: 4, hits: [hit('hspf26', 'Nuclear war causes extinction. Starr 15'), hit('hspf25', 'Nuclear war causes extinction — Starr 15!'), hit('hspf24', 'Starr 15 cite', { type: 'cite', school: 'Interlake', team: 'WuZh', teamLabel: 'Interlake WuZh', title: '1NC', path: null })], failed: ['hspf23'], searched: ['hspf26', 'hspf25', 'hspf24'], stopped: false }
        : { done: 1, total: 1, hits: [hit('hspf26', 'Nuclear war causes extinction. Starr 15'), hit('hspf23', 'Older Starr 15 card')], failed: [], searched: ['hspf23'], stopped: false }),
      '/caselist/open': { name: 'a.docx', path: '/p', app: 'CardMirror' }, '/caselist/team': TEAM,
    } });
  h.lists = [];
  let close;
  window.__debateUploaderUI.showList = (title, items, onPick, opts) => {
    const l = { title, items, onPick, opts, statuses: [] };
    h.lists.push(l);
    return { closed: new Promise((r) => { close = r; }), close() {}, update: (next, status) => { l.items = next; l.statuses.push(status); } };
  };
  await cmd('caselistCardSearch').run(h.api);
  assert.deepEqual(h.chooseTitles[0], ['Search for "Starr 15" in…', [
    'HS PF, every year (4 caselists)', 'HS PF 2026-27', 'HS PF 2025-26', 'HS PF 2024-25', 'HS PF 2023-24',
    'This year, every event (2 caselists)', 'HS LD, every year (2 caselists)', 'Every caselist (6 caselists)', 'HS LD 2026-27', 'HS LD 2025-26',
  ]]);
  assert.deepEqual(h.calls.find((c) => c.route === '/caselist/card-search').body, { q: 'Starr 15', caselists: ['hspf26', 'hspf25', 'hspf24', 'hspf23'] });
  const l = h.lists[0];
  assert.equal(l.title, '"Starr 15" on every HS PF year');
  assert.deepEqual(l.items.map((it) => [it.label, it.detail]), [
    ['Nuclear war causes extinction. Starr 15', 'Hawken JoMi · HS PF 2026-27 · +1 more'],
    ['Starr 15 cite', 'cites: 1NC · Interlake WuZh · HS PF 2024-25'],
    ["Retry 1 caselist that didn't finish…", ''],
  ]);
  assert.equal(l.statuses.at(-1), '2 cards · 3 of 4 caselists complete · 1 failed · Enter opens the doc');
  await l.onPick(l.items[0]);
  assert.deepEqual(h.calls.find((c) => c.route === '/caselist/open').body, { caselist: 'hspf26', school: 'Hawken', team: 'JoMi', path: 'hspf26/Hawken/JoMi/a.docx' });
  await l.onPick(l.items[1]);
  assert.equal(h.pages[0].title, 'Interlake WuZh');
  await l.onPick(l.items[2]);
  assert.deepEqual(h.calls.filter((c) => c.route === '/caselist/card-search').at(-1).body, { q: 'Starr 15', caselists: ['hspf23'] }, 'retry searches only the failed caselist');
  assert.deepEqual(l.items.map((it) => [it.label, it.detail.endsWith('+1 more')]), [['Nuclear war causes extinction. Starr 15', true], ['Starr 15 cite', false], ['Older Starr 15 card', false]], 'retried hits append once (a hit seen before is not another copy); no retry row left');
  assert.equal(l.statuses.at(-1), '3 cards · every match · Enter opens the doc', 'a retried caselist is counted once');
  close();
  await new Promise((r) => setImmediate(r));
  assert.ok(h.calls.some((c) => c.route === '/caselist/card-search/stop'), 'closing the list stops the helper search');

  const single = scoutHarness({ prompt: 'x', choose: [9], storage: { caselistTarget: TARGET }, results: { '/caselist/caselists': LISTS6, '/caselist/card-search': { done: 1, total: 1, hits: [], failed: [], searched: ['hsld25'], capped: ['hsld25'], stopped: false } } });
  let singleStatus = null;
  window.__debateUploaderUI.showList = () => ({ closed: new Promise(() => {}), close() {}, update: (items, status) => { singleStatus = status; } });
  await cmd('caselistCardSearch').run(single.api);
  assert.equal(singleStatus, '0 cards · 1 of 1 caselist complete · 1 caselist had over 100 matches: add words to narrow it · Enter opens the doc');
  assert.deepEqual(single.calls.find((c) => c.route === '/caselist/card-search').body.caselists, ['hsld25'], 'a single past year of another event');

  const fail = scoutHarness({ prompt: 'x', choose: [0], storage: { caselistTarget: TARGET }, results: { '/caselist/caselists': ALL_LISTS, '/caselist/card-search': new Error('login_expired') } });
  let failStatus = null;
  let failItems = [];
  window.__debateUploaderUI.showList = () => ({ closed: new Promise(() => {}), close() {}, update: (items, status) => { failStatus = status; failItems = items; } });
  await cmd('caselistCardSearch').run(fail.api);
  assert.equal(failStatus, 'Search stopped: Tabroom login expired. Run "Log in to Tabroom…".', 'a failed search never leaves the list saying Searching…');
  assert.ok(fail.calls.some((c) => c.route === '/caselist/card-search/stop'), 'and the helper search is stopped');
  assert.equal(failItems.at(-1).label, "Retry 3 caselists that didn't finish…", 'unfinished caselists are offered again');

  const cancel = scoutHarness({ prompt: '  ', results: {} });
  await cmd('caselistCardSearch').run(cancel.api);
  assert.equal(cancel.calls.length, 0, 'an empty query sends nothing');
});

test('team page actions: copy without a clipboard explains; a vanished file says so', async () => {
  const h = scoutHarness({ storage: { caselistTarget: TARGET }, results: { '/tabroom/rounds': ONE_ROUND, '/caselist/scout': SCOUT_HIT, '/caselist/team': TEAM, '/caselist/open': new Error('removed') } });
  await cmd('caselistScout').run(h.api);
  await h.pages[0].onCopy('text', 'report');
  assert.equal(h.toasts.at(-1), "Couldn't copy to the clipboard.");
  await h.pages[0].onOpen(11);
  assert.equal(h.toasts.at(-1), "That round's file is no longer on the caselist.");
});

test('DOM team page: selecting a round shows its report and cites; Enter opens only rounds with files; tabs switch', async () => {
  const dom = fakeDom();
  const saved = { document: globalThis.document, Option: globalThis.Option, ui: window.__debateUploaderUI };
  globalThis.document = dom.doc; globalThis.Option = dom.Option;
  const h = scoutHarness({ storage: { caselistTarget: TARGET }, results: { '/tabroom/rounds': ONE_ROUND, '/caselist/scout': SCOUT_HIT, '/caselist/team': TEAM, '/caselist/open': { name: 'a.docx', path: '/p', app: 'CardMirror' } } });
  delete window.__debateUploaderUI; // drive the real DOM UI (one current round: no pickers needed)
  try {
    const running = cmd('caselistScout').run(h.api);
    for (let i = 0; i < 300 && !dom.all(dom.doc.body).some((n) => n.dataset.field === 'pane'); i++) await new Promise((r) => setTimeout(r, 20));
    const dialog = dom.all(dom.doc.body).find((n) => typeof n.className === 'string' && n.className.startsWith('du-dialog'));
    const paneText = () => dom.all(dom.byField('pane')).map((n) => n.textContent).join('|');
    assert.match(paneText(), /AI DA, Econ/);
    assert.match(paneText(), /Smith 24/);
    dialog.dispatch('keydown', { key: 'ArrowDown' });
    assert.match(paneText(), /None \(cites only\)/);
    const before = h.calls.filter((c) => c.route === '/caselist/open').length;
    dialog.dispatch('keydown', { key: 'Enter' });
    assert.equal(h.calls.filter((c) => c.route === '/caselist/open').length, before, 'Enter on a cites-only round opens nothing');
    dialog.dispatch('keydown', { key: 'ArrowRight' });
    assert.match(paneText(), /Smith 24/);
    assert.equal(dom.byField('tabs').children.map((b) => b.getAttribute('aria-selected')).join(), 'false,true');
    dialog.dispatch('keydown', { key: 'Escape' });
    await running;
    assert.equal(dom.doc.body.children.length, 0);
  } finally {
    globalThis.document = saved.document; globalThis.Option = saved.Option; window.__debateUploaderUI = saved.ui;
  }
});

test('scouting toasts: read errors never say "Upload failed"; saved-not-opened and Finder reveals explain', async () => {
  const load = scoutHarness({ storage: { caselistTarget: TARGET }, results: { '/tabroom/rounds': ONE_ROUND, '/caselist/scout': SCOUT_HIT, '/caselist/team': new Error('http_500') } });
  await cmd('caselistScout').run(load.api);
  assert.equal(load.toasts.at(-1), "Couldn't load from openCaselist (http_500).");
  for (const [result, text] of [
    [new Error('bad_name'), 'Couldn\'t download "a.docx".'],
    [{ name: 'a.docx', path: '/p', app: 'CardMirror', opened: false }, 'Saved "a.docx" but couldn\'t open it.'],
    [{ name: 'notes.webloc', path: '/p', app: 'finder' }, 'Saved "notes.webloc" and showed it in Finder (not opened: unusual file type).'],
  ]) {
    const h = scoutHarness({ storage: { caselistTarget: TARGET }, results: { '/tabroom/rounds': ONE_ROUND, '/caselist/scout': SCOUT_HIT, '/caselist/team': TEAM, '/caselist/open': result } });
    await cmd('caselistScout').run(h.api);
    await h.pages[0].onOpen(11);
    assert.equal(h.toasts.at(-1), text);
  }
});

test('DOM team page: Enter on a button never opens the doc; row clicks keep focus in the dialog; double-click opens once', async () => {
  const dom = fakeDom();
  const saved = { document: globalThis.document, Option: globalThis.Option, ui: window.__debateUploaderUI };
  globalThis.document = dom.doc; globalThis.Option = dom.Option;
  const h = scoutHarness({ storage: { caselistTarget: TARGET }, results: { '/tabroom/rounds': ONE_ROUND, '/caselist/scout': SCOUT_HIT, '/caselist/team': TEAM, '/caselist/open': { name: 'a.docx', path: '/p', app: 'CardMirror' } } });
  delete window.__debateUploaderUI;
  try {
    const running = cmd('caselistScout').run(h.api);
    for (let i = 0; i < 300 && !dom.all(dom.doc.body).some((n) => n.dataset.field === 'pane'); i++) await new Promise((r) => setTimeout(r, 20));
    const dialog = dom.all(dom.doc.body).find((n) => typeof n.className === 'string' && n.className.startsWith('du-dialog'));
    const opens = () => h.calls.filter((c) => c.route === '/caselist/open').length;
    dom.byField('tabs').children[1].dispatch('keydown', { key: 'Enter' });
    assert.equal(opens(), 0, 'Enter on the Cites tab button must not open the doc');
    const list = dom.byField('list');
    const rowsBefore = [...list.children];
    dom.button('Copy report').focus();
    rowsBefore[1].dispatch('mousedown');
    assert.equal(dom.doc.activeElement, dialog, 'focus returns to the dialog after the footer is rebuilt');
    assert.deepEqual(list.children, rowsBefore, 'selecting a row repaints in place (rows are not rebuilt)');
    rowsBefore[0].dispatch('mousedown');
    list.dispatch('dblclick');
    await new Promise((r) => setTimeout(r, 1300));
    assert.equal(opens(), 1, 'double-click on the list opens the selected round once');
    dialog.dispatch('keydown', { key: 'Escape' });
    await running;
  } finally {
    globalThis.document = saved.document; globalThis.Option = saved.Option; window.__debateUploaderUI = saved.ui;
  }
});

test('settings survive CardMirror wiping plugin storage: restored from the helper before a command runs', async () => {
  const h = scoutHarness({ storage: {}, prefs: { caselistTarget: TARGET }, results: { '/tabroom/rounds': ONE_ROUND, '/caselist/scout': SCOUT_HIT, '/caselist/team': TEAM } });
  await cmd('caselistScout').run(h.api);
  assert.equal(h.chooseTitles.length, 0, 'no event picker');
  assert.equal(h.calls.find((c) => c.route === '/caselist/scout').body.caselist, 'hspf26');
  assert.deepEqual(h.store.get('caselistTarget'), TARGET);
});

test('saving a setting also saves it to the helper', async () => {
  const h = harness({ folderAnswer: ' ~/Send Docs ' });
  await cmd('setFolder').run(h.api);
  assert.deepEqual(h.prefsSets, [['sendDocFolder', '~/Send Docs']]);
});

test('scout with no saved caselist: the helper finds the event; no picker; it is remembered', async () => {
  const h = scoutHarness({ storage: {}, results: { '/tabroom/rounds': ONE_ROUND, '/caselist/scout': { caselist: { name: 'hspf26', label: 'HS PF 2026', event: 'pf' }, ...SCOUT_HIT }, '/caselist/team': TEAM } });
  await cmd('caselistScout').run(h.api);
  assert.equal(h.chooseTitles.length, 0, 'never asks which event');
  assert.deepEqual(h.calls.find((c) => c.route === '/caselist/scout').body, { opponent: 'lexington-alhu' });
  assert.equal(h.pages[0].subtitle, 'HS PF 2026 · 2 rounds · 1 cite entry');
  assert.deepEqual(h.store.get('scoutCaselist'), { name: 'hspf26', label: 'HS PF 2026', event: 'pf' });
  assert.deepEqual(h.prefsSets, [['scoutCaselist', { name: 'hspf26', label: 'HS PF 2026', event: 'pf' }]]);

  const none = scoutHarness({ storage: {}, results: { '/tabroom/rounds': ONE_ROUND, '/caselist/scout': { caselist: null, match: null, candidates: [] } } });
  await cmd('caselistScout').run(none.api);
  assert.equal(none.toasts.at(-1), 'No caselist page for lexington-alhu yet. Try Search the caselist…');
});

test('team page hides the caselist sort prefix in every spelling ("03 -- Name", "03---Name")', async () => {
  const team = { rounds: [
    { ...TEAM.rounds[0], id: 21, tournament: '03 -- Mid America Cup' },
    { ...TEAM.rounds[1], id: 22, tournament: '01---Harvard Union Season Opener' },
  ], cites: [{ ...TEAM.cites[0], roundId: 21, tournament: '03 -- Mid America Cup' }] };
  const h = scoutHarness({ storage: { caselistTarget: TARGET }, results: { '/tabroom/rounds': ONE_ROUND, '/caselist/scout': SCOUT_HIT, '/caselist/team': team } });
  await cmd('caselistScout').run(h.api);
  assert.deepEqual(h.pages[0].rounds.map((r) => r.label.split(' · ')[0]), ['Mid America Cup', 'Harvard Union Season Opener']);
  assert.equal(h.pages[0].rounds[0].info[0][1], 'Mid America Cup');
  assert.equal(h.pages[0].cites[0].detail, 'Mid America Cup · Round 3');
});

test('team page spec carries tournament and side on rounds and cites, plus side labels, for filtering', async () => {
  const h = scoutHarness({ storage: { caselistTarget: TARGET }, results: { '/tabroom/rounds': ONE_ROUND, '/caselist/scout': SCOUT_HIT, '/caselist/team': TEAM } });
  await cmd('caselistScout').run(h.api);
  const p = h.pages[0];
  assert.deepEqual(p.sideLabels, { A: 'Pro', N: 'Con' });
  assert.deepEqual(p.rounds.map((r) => [r.tournament, r.side]), [['Glenbrooks', 'N'], ['Yale', 'A']]);
  assert.deepEqual(p.cites.map((c) => [c.tournament, c.side]), [['Glenbrooks', 'N']]);
});

test('DOM team page filters: tournament + side narrow rounds and cites; counts show "x of y"; dropdown keys stay in the dropdown', async () => {
  const dom = fakeDom();
  const saved = { document: globalThis.document, Option: globalThis.Option, ui: window.__debateUploaderUI };
  globalThis.document = dom.doc; globalThis.Option = dom.Option;
  const team = { rounds: [
    { ...TEAM.rounds[0], id: 31, tournament: '03 -- Yale', side: 'N', round: '5' },
    { ...TEAM.rounds[0], id: 32, tournament: '03 -- Yale', side: 'A', round: '4' },
    { ...TEAM.rounds[0], id: 33, tournament: '02 - Mid America', side: 'N', round: 'Finals' },
  ], cites: [{ ...TEAM.cites[0], roundId: 33, tournament: '02 - Mid America', side: 'N' }] };
  const h = scoutHarness({ storage: { caselistTarget: TARGET }, results: { '/tabroom/rounds': ONE_ROUND, '/caselist/scout': SCOUT_HIT, '/caselist/team': team } });
  delete window.__debateUploaderUI;
  try {
    const running = cmd('caselistScout').run(h.api);
    for (let i = 0; i < 300 && !dom.all(dom.doc.body).some((n) => n.dataset.field === 'pane'); i++) await new Promise((r) => setTimeout(r, 20));
    const dialog = dom.all(dom.doc.body).find((n) => typeof n.className === 'string' && n.className.startsWith('du-dialog'));
    const rows = () => dom.byField('list').children.filter((n) => n.className.startsWith('du-row'));
    const tabs = () => dom.byField('tabs').children.map((b) => b.textContent);
    const tourn = dom.byField('filter-tournament');
    assert.deepEqual(tourn.children.map((o) => o.textContent), ['All tournaments', 'Yale', 'Mid America']);
    assert.equal(rows().length, 3);
    tourn.value = 'Yale'; tourn.dispatch('change');
    assert.equal(rows().length, 2);
    assert.deepEqual(tabs(), ['Rounds (2 of 3)', 'Cites (0 of 1)']);
    const side = dom.byField('filter-side');
    assert.deepEqual(side.children.map((b) => b.textContent), ['All', 'Pro', 'Con']);
    side.children[2].dispatch('click');
    assert.equal(rows().length, 1);
    assert.match(dom.all(dom.byField('pane')).map((n) => n.textContent).join('|'), /Round 5/);
    tourn.dispatch('keydown', { key: 'ArrowRight' });
    assert.equal(dom.byField('tabs').children[0].getAttribute('aria-selected'), 'true', 'arrow keys in the dropdown do not switch tabs');
    tourn.value = 'Mid America'; tourn.dispatch('change');
    side.children[1].dispatch('click');
    assert.equal(rows().length, 0);
    assert.ok(dom.all(dom.byField('list')).some((n) => n.textContent === 'No rounds match these filters.'));
    side.children[0].dispatch('click');
    tourn.value = ''; tourn.dispatch('change');
    assert.deepEqual(tabs(), ['Rounds (3)', 'Cites (1)']);
    dialog.dispatch('keydown', { key: 'Escape' });
    await running;
  } finally {
    globalThis.document = saved.document; globalThis.Option = saved.Option; window.__debateUploaderUI = saved.ui;
  }
});

test('speed: no sleep before the first status check; the helper answers when the job is done', async () => {
  const h = harness({ responses: [ok({ ok: true, job: 'j1' }), ok({ state: 'done', result: { room: 'abc12', name: 'a.docx' } })] });
  let slept = 0;
  window.__debateUploaderUI.sleep = async () => { slept++; };
  await cmd('sdPick').run(h.api);
  assert.equal(slept, 0, 'no fixed 1 s sleep any more');
  assert.equal(h.toasts.at(-1), 'Uploaded "a.docx" to SpeechDrop room abc12');
});

// ---------------------------------------------------------------- What they run + paradigms
const withExternal = async (fn) => {
  const opened = [];
  const saved = window.electronAPI;
  window.electronAPI = { openExternal: (url) => { opened.push(url); } };
  try { await fn(opened); } finally { window.electronAPI = saved; }
};

test('tabroom rounds: Enter on a round opens each judge\'s paradigm search in the browser', async () => {
  await withExternal(async (opened) => {
    const h = harness({ responses: [ok({ ok: true, job: 'j' }), ok({ state: 'done', result: { current: true, rounds: [
      { id: 9, tournament: 'Glenbrooks', round: 'Octas', side: 'Neg', opponent: 'Lexington AB', judge: 'Habib,Patel, Sortland', start_time: null },
    ] } })] });
    let shown;
    window.__debateUploaderUI.showList = (title, items, onPick, opts) => { shown = { items, onPick, opts }; return { closed: Promise.resolve(), update() {} }; };
    await cmd('tabroomRounds').run(h.api);
    assert.match(shown.opts.hint, /paradigm/);
    shown.onPick(shown.items[0]);
    assert.deepEqual(opened, ['Habib', 'Patel', 'Sortland'].map((j) => `https://www.tabroom.com/index/paradigm.mhtml?search_first=&search_last=${j}`));
  });
});

test('scout: the team page shows your pairing, and each judge links to their paradigm', async () => {
  await withExternal(async (opened) => {
    const pairing = { current: true, rounds: [{ ...ONE_ROUND.rounds[0], judge: 'Lee,Van Dyke' }] };
    const h = scoutHarness({ storage: { caselistTarget: TARGET }, results: { '/tabroom/rounds': pairing, '/caselist/scout': SCOUT_HIT, '/caselist/team': TEAM } });
    await cmd('caselistScout').run(h.api);
    const p = h.pages[0];
    assert.deepEqual(p.round, { text: "Glenbrooks · Round 4 · you're Pro", judges: ['Lee', 'Van Dyke'] });
    p.onParadigm('Van Dyke');
    assert.deepEqual(opened, ['https://www.tabroom.com/index/paradigm.mhtml?search_first=&search_last=Van%20Dyke']);
  });
  const search = scoutHarness({ choose: [0, 0], results: { '/caselist/caselists': LISTS['/caselist/caselists'], '/caselist/schools': [{ name: 'Lexington', label: 'Lexington' }], '/caselist/teams': [{ name: 'AlHu', label: 'Lexington AlHu' }], '/caselist/team': TEAM } });
  await cmd('caselistSearch').run(search.api);
  assert.equal(search.pages[0].round, null, 'searching has no pairing');
});

test('DOM team page summary: tallies their case and last speech per side, respects filters, opens first', async () => {
  const dom = fakeDom();
  const saved = { document: globalThis.document, Option: globalThis.Option, ui: window.__debateUploaderUI };
  globalThis.document = dom.doc; globalThis.Option = dom.Option;
  const R = (id, tournament, side, own, final, result) => ({ ...TEAM.rounds[0], id, tournament, side, round: String(id), parsed: { own, final, result } });
  const team = { rounds: [
    R(41, '03 -- Yale', 'A', ['Efficiency'], ['Efficiency'], 'W'),
    R(42, '03 -- Yale', 'N', ['Econ', 'Midterms'], ['Midterms'], 'L'),
    R(43, '02 -- Opener', 'N', ['econ', 'Econ'], ['Econ'], 'W'),
    R(44, '02 -- Opener', 'N', [], [], null),
  ], cites: [] };
  const h = scoutHarness({ storage: { caselistTarget: TARGET }, results: { '/tabroom/rounds': ONE_ROUND, '/caselist/scout': SCOUT_HIT, '/caselist/team': team } });
  delete window.__debateUploaderUI;
  try {
    const running = cmd('caselistScout').run(h.api);
    for (let i = 0; i < 300 && !dom.all(dom.doc.body).some((n) => n.dataset.field === 'pane'); i++) await new Promise((r) => setTimeout(r, 20));
    const dialog = dom.all(dom.doc.body).find((n) => typeof n.className === 'string' && n.className.startsWith('du-dialog'));
    const tabs = () => dom.byField('tabs').children;
    const rows = () => dom.byField('list').children.filter((n) => n.className.startsWith('du-row'));
    const pane = () => dom.all(dom.byField('pane')).map((n) => n.textContent).filter(Boolean).join('|');
    assert.deepEqual(tabs().map((b) => b.textContent), ['Summary', 'Rounds (4)', 'Cites (0)']);
    assert.equal(tabs()[0].getAttribute('aria-selected'), 'true', 'summary opens first');
    assert.match(dom.all(dom.byField('round')).map((n) => n.textContent).join(''), /Round 4 · you're Pro · Judge: Lee/);
    assert.equal(rows().length, 2);
    assert.match(pane(), /^Pro\|1 of 1 round with a readable report · 1-0 where reported\|Case \(1AC\)\|1×\|Efficiency\|1-0\|Last speech \(2AR\)/);
    dialog.dispatch('keydown', { key: 'ArrowDown' });
    assert.match(pane(), /Con\|2 of 3 rounds with a readable report · 1-1 where reported\|Case \(1NC\)\|2×\|Econ\|1-1\|1×\|Midterms\|0-1\|Last speech \(2NR\)\|1×\|Econ\|1-0\|1×\|Midterms\|0-1/);
    const tourn = dom.byField('filter-tournament');
    tourn.value = 'Opener'; tourn.dispatch('change');
    assert.equal(rows().length, 1, 'no Pro rounds at the Opener');
    assert.match(pane(), /Con\|1 of 2 rounds .*\|1×\|Econ\|1-0/);
    dialog.dispatch('keydown', { key: 'ArrowRight' });
    assert.equal(tabs()[1].getAttribute('aria-selected'), 'true');
    dialog.dispatch('keydown', { key: 'Escape' });
    await running;
  } finally {
    globalThis.document = saved.document; globalThis.Option = saved.Option; window.__debateUploaderUI = saved.ui;
  }
});

// ---------------------------------------------------------------- Search my files
const CARD = { path: '/ev/Grid.docx', ordinal: 3, file: 'Grid.docx', tag: 'Data centers stay onshore', cite: 'Rogan 26', headings: ['AFF', 'AT: Offshoring'], quote: 'Data centers stay onshore', approxPos: 120, copies: 2 };
const IDLE = { folders: ['/ev'], files: 2535, cards: 254415, unreadable: 2, scanning: false, done: 2535, total: 2535, scannedAt: 1 };

function evidenceHarness({ status = IDLE, search = () => ({ results: [CARD], ...IDLE }), promptAnswer = null, docInfo = () => null, jump } = {}) {
  const h = caselistHarness({ direct: {
    '/evidence/status': status, '/evidence/search': search, '/evidence/folders': (b) => ({ ...IDLE, folders: b.folders, scanning: true, done: 0, total: 0 }),
    '/evidence/open': { name: 'Grid.docx', app: 'CardMirror', quote: CARD.quote, approxPos: 120 },
    '/evidence/card': { name: 'Data centers stay onshore.docx', path: '/cards/x.docx', app: 'CardMirror' },
  } });
  h.prompts = [];
  h.searches = [];
  window.__debateUploaderUI.prompt = async (label, initial) => { h.prompts.push([label, initial]); return promptAnswer; };
  window.__debateUploaderUI.search = async (spec) => { h.searches.push(spec); };
  window.__debateUploaderUI.sleep = async () => {};
  h.api.docInfo = docInfo;
  if (jump) h.api.jumpToSource = jump;
  return h;
}

test('search my files: first run asks for folders (; separated), then opens the search with the index status', async () => {
  const h = evidenceHarness({ status: { ...IDLE, folders: [] }, promptAnswer: ' ~/Ryan Files ; ~/Downloads/Caselist ;' });
  await cmd('evidenceSearch').run(h.api);
  assert.deepEqual(h.calls.find((c) => c.route === '/evidence/status').body, { refresh: true });
  assert.deepEqual(h.calls.find((c) => c.route === '/evidence/folders').body, { folders: ['~/Ryan Files', '~/Downloads/Caselist'] });
  assert.equal(h.toasts.at(-1), 'Indexing 2 folders. Search works while it runs.');
  assert.equal(h.searches[0].status, 'Indexing… 0 of 0 files');

  const cancel = evidenceHarness({ status: { ...IDLE, folders: [] } });
  await cmd('evidenceSearch').run(cancel.api);
  assert.equal(cancel.searches.length, 0);

  const bad = evidenceHarness();
  bad.api.flowPost = async () => ({ ok: true, status: 500, body: { ok: false, error: 'no_folder:/nope' } });
  await cmd('evidenceFolders').run(bad.api);
  assert.equal(bad.toasts.at(-1), 'No folder at /nope.');
});

test('search my files: results show tag, cite, and block over file (with copies); status counts cards; analytics are labeled', async () => {
  const h = evidenceHarness({ search: (b) => ({ results: b.query === 'none' ? [] : [CARD, { ...CARD, ordinal: 4, cite: '', copies: 1, headings: [] }], ...IDLE }) });
  await cmd('evidenceSearch').run(h.api);
  const spec = h.searches[0];
  assert.equal(spec.status, '254,415 cards in 2,535 files · 2 unreadable');
  const r = await spec.onQuery('onshore');
  assert.deepEqual(h.calls.find((c) => c.route === '/evidence/search').body, { query: 'onshore', limit: 60 });
  assert.deepEqual(r.items.map((i) => [i.label, i.sub, i.where]), [
    ['Data centers stay onshore', 'Rogan 26', ['AT: Offshoring', 'Grid.docx · 2 copies']],
    ['Data centers stay onshore', 'Analytic', ['Grid.docx']],
  ]);
  assert.equal((await spec.onQuery('none')).empty, 'No matches.');
  assert.equal((await spec.onQuery('  ')).empty, 'Type to search your cards.');
});

test('search my files: open jumps to the card once CardMirror shows the file; otherwise names the card', async () => {
  let n = 0;
  const jumps = [];
  const h = evidenceHarness({ docInfo: () => (++n < 3 ? { docId: 'old', docTitle: 'Other' } : { docId: 'd1', docTitle: 'Grid' }), jump: async (src) => { jumps.push(src); return { ok: true }; } });
  await cmd('evidenceSearch').run(h.api);
  await h.searches[0].onOpen({ card: CARD });
  assert.deepEqual(h.calls.find((c) => c.route === '/evidence/open').body, { path: '/ev/Grid.docx', ordinal: 3 });
  assert.equal(jumps.length, 1);
  assert.match(jumps[0], /^cmsrc1\./);
  const decoded = JSON.parse(Buffer.from(jumps[0].slice(7).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
  assert.deepEqual(decoded, { docId: 'd1', docTitle: 'Grid', headingId: null, anchor: { quote: 'Data centers stay onshore', prefix: '', suffix: '', approxPos: 120 } });
  assert.equal(h.toasts.at(-1), 'Opened "Grid.docx" at "Data centers stay onshore"');

  const nojump = evidenceHarness();
  await cmd('evidenceSearch').run(nojump.api);
  await nojump.searches[0].onOpen({ card: CARD });
  assert.equal(nojump.toasts.at(-1), 'Opened "Grid.docx". The card: "Data centers stay onshore"');

  await nojump.searches[0].onCard({ card: CARD });
  assert.deepEqual(nojump.calls.find((c) => c.route === '/evidence/card').body, { path: '/ev/Grid.docx', ordinal: 3 });
  assert.equal(nojump.toasts.at(-1), 'Opened just the card: "Data centers stay onshore.docx"');
});

test('DOM search: typing queries the helper, arrows move, Enter opens, ⌘Enter opens the card', async () => {
  const dom = fakeDom();
  const saved = { document: globalThis.document, Option: globalThis.Option, ui: window.__debateUploaderUI };
  globalThis.document = dom.doc; globalThis.Option = dom.Option;
  const h = evidenceHarness({ search: (b) => ({ results: b.query ? [CARD, { ...CARD, ordinal: 4, tag: `Second ${b.query}` }] : [], ...IDLE }) });
  delete window.__debateUploaderUI;
  try {
    const running = cmd('evidenceSearch').run(h.api);
    for (let i = 0; i < 300 && !dom.byField('query'); i++) await new Promise((r) => setTimeout(r, 20));
    const input = dom.byField('query');
    const rows = () => dom.byField('list').children.filter((n) => n.className.startsWith('du-row'));
    const settle = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 20)); };
    await settle();
    assert.ok(dom.all(dom.byField('list')).some((n) => n.textContent === 'Type to search your cards.'));
    input.value = 'grid'; input.dispatch('input');
    await settle();
    assert.equal(rows().length, 2);
    assert.match(dom.all(rows()[1]).map((n) => n.textContent).join('|'), /Second grid/);
    input.dispatch('keydown', { key: 'ArrowDown' });
    assert.equal(rows()[1].getAttribute('aria-selected'), 'true');
    input.dispatch('keydown', { key: 'Enter', metaKey: true });
    await settle();
    assert.deepEqual(h.calls.find((c) => c.route === '/evidence/card').body, { path: '/ev/Grid.docx', ordinal: 4 });
    await running;
    assert.equal(dom.doc.body.children.length, 0, 'dialog closed');
  } finally {
    globalThis.document = saved.document; globalThis.Option = saved.Option; window.__debateUploaderUI = saved.ui;
  }
});

test('DOM search: an indexing refresh keeps the highlighted row; Enter right after typing opens a row of the new text', async () => {
  const dom = fakeDom();
  const saved = { document: globalThis.document, Option: globalThis.Option, ui: window.__debateUploaderUI };
  globalThis.document = dom.doc; globalThis.Option = dom.Option;
  let scans = 2; // still indexing for the first answers, so the dialog re-queries
  const h = evidenceHarness({ search: (b) => ({ results: b.query ? [{ ...CARD, ordinal: 1, tag: `A ${b.query}` }, { ...CARD, ordinal: 2, tag: `B ${b.query}` }] : [], ...IDLE, scanning: b.query ? scans-- > 0 : false }) });
  delete window.__debateUploaderUI;
  try {
    const running = cmd('evidenceSearch').run(h.api);
    for (let i = 0; i < 300 && !dom.byField('query'); i++) await new Promise((r) => setTimeout(r, 20));
    const input = dom.byField('query');
    const rows = () => dom.byField('list').children.filter((n) => n.className.startsWith('du-row'));
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    input.value = 'grid'; input.dispatch('input');
    await wait(400);
    input.dispatch('keydown', { key: 'ArrowDown' });
    assert.equal(rows()[1].getAttribute('aria-selected'), 'true');
    await wait(1800); // one refresh lands
    assert.equal(rows()[1].getAttribute('aria-selected'), 'true', 'refresh kept the selection');
    input.value = 'econ'; input.dispatch('input');
    input.dispatch('keydown', { key: 'Enter' }); // before the 120 ms debounce fires
    await wait(400);
    await running;
    const opened = h.calls.find((c) => c.route === '/evidence/open');
    assert.deepEqual(opened.body, { path: '/ev/Grid.docx', ordinal: 1 }, 'the first row of the "econ" results');
    assert.ok(h.calls.some((c) => c.route === '/evidence/search' && c.body.query === 'econ'));
  } finally {
    globalThis.document = saved.document; globalThis.Option = saved.Option; window.__debateUploaderUI = saved.ui;
  }
});

// ---------------------------------------------------------------- Mark cards
// A ProseMirror-shaped fake: positions, descendants, nodesBetween, marks, transactions.
function pm(name, kids = [], text = null, marks = []) {
  const n = { type: { name }, isText: text !== null, text, marks, kids };
  n.nodeSize = n.isText ? text.length : 2 + kids.reduce((a, k) => a + k.nodeSize, 0);
  n.textContent = n.isText ? text : kids.map((k) => k.textContent).join('');
  n.firstChild = kids[0] || null;
  n.content = { size: n.isText ? 0 : n.nodeSize - 2 };
  n.forEach = (f) => { let p = 0; for (const k of kids) { f(k, p); p += k.nodeSize; } };
  const walk = (node, base, f, from = -Infinity, to = Infinity) => {
    let p = base;
    for (const k of node.kids) {
      const end = p + k.nodeSize;
      if (end > from && p < to && f(k, p) !== false && !k.isText) walk(k, p + 1, f, from, to);
      p = end;
    }
  };
  n.descendants = (f) => walk(n, 0, f);
  n.nodeAt = (pos) => { let found = null; walk(n, 0, (k, p) => { if (p === pos && !found) found = k; return p < pos; }); return found; };
  n.nodesBetween = (from, to, f) => walk(n, 0, f, from, to);
  return n;
}
const RED = { type: { name: 'font_color' }, attrs: { color: 'ff0000' } };
const BLUE = { type: { name: 'font_color' }, attrs: { color: '0000FF' } };
const txt = (s, ...marks) => pm('text', [], s, marks);
const card = (tag, cite, ...body) => pm('card', [pm('tag', [tag]), pm('cite_paragraph', [txt(cite)]), pm('card_body', body)]);
function fakeView(doc) {
  const v = { dispatched: [], calls: [] };
  v.state = {
    doc,
    schema: { marks: { font_color: { create: (attrs) => ({ type: { name: 'font_color' }, attrs }) } } },
    get tr() {
      const tr = { docChanged: false };
      tr.addMark = (f, t, m) => { v.calls.push(['add', f, t, m.attrs.color]); tr.docChanged = true; return tr; };
      tr.removeMark = (f, t, m) => { v.calls.push(['remove', f, t, m.attrs.color]); tr.docChanged = true; return tr; };
      return tr;
    },
  };
  v.dispatch = (tr) => v.dispatched.push(tr);
  return v;
}
const MARK_DOC = () => pm('doc', [
  pm('block', [txt('AT: Grid')]),
  card(txt('Grid is resilient', RED), 'Avila 12', txt('Body', RED)),
  card(txt('Grid collapses'), 'Chen 25', txt('half ', RED), txt('read')),
  card(txt('Blackouts are rare'), 'Niiler 19', txt('Body')),
  pm('block', [txt('Econ')]),
  card(txt('Recession causes war'), 'Royal 10', txt('Body ', BLUE), txt('more')),
]);

function markHarness(view, pick) {
  const h = harness();
  h.picks = [];
  window.__debateUploaderUI.editorView = async () => view;
  window.__debateUploaderUI.pickCards = async (spec) => { h.picks.push(spec); return pick(spec); };
  h.api.docInfo = () => ({ docId: 'd', docTitle: 'Grid Aff' });
  return h;
}

test('mark cards: lists every card under its block, checked when it has any red, partly red noted', async () => {
  const view = fakeView(MARK_DOC());
  const h = markHarness(view, () => null);
  await cmd('markCards').run(h.api);
  const spec = h.picks[0];
  assert.equal(spec.title, 'Mark cards');
  assert.equal(spec.subtitle, 'Grid Aff · checked cards turn red');
  assert.deepEqual(spec.cards.map((c) => [c.label, c.sub, c.group, c.checked, c.partial]), [
    ['Grid is resilient', 'Avila 12', 'AT: Grid', true, true],
    ['Grid collapses', 'Chen 25', 'AT: Grid', true, true],
    ['Blackouts are rare', 'Niiler 19', 'AT: Grid', false, false],
    ['Recession causes war', 'Royal 10', 'Econ', false, false],
  ]);
  assert.equal(view.dispatched.length, 0, 'cancel changes nothing');
});

test('mark cards: checked cards turn wholly red, unchecked ones lose only marker red, in one undoable transaction', async () => {
  const doc = pm('doc', [
    card(txt('A', RED), 'cite a', txt('all red', RED)),
    card(txt('B'), 'cite b', txt('plain')),
    card(txt('C'), 'cite c', txt('blue', BLUE), txt('red', RED)),
  ]);
  // cite paragraphs aren't red in card A, so make it fully red for the "already marked" case
  doc.kids[0].kids[1] = pm('cite_paragraph', [txt('cite a', RED)]);
  const fixed = pm('doc', doc.kids);
  const view = fakeView(fixed);
  const h = markHarness(view, (spec) => {
    assert.deepEqual(spec.cards.map((c) => c.checked), [true, false, true], 'C is partly red: checked');
    return [false, true, true]; // C left as is keeps its partial red
  });
  await cmd('markCards').run(h.api);
  assert.equal(view.dispatched.length, 1);
  const a = [];
  fixed.forEach((n, p) => a.push([p, p + n.nodeSize]));
  assert.deepEqual(view.calls.filter((c) => c[0] === 'add'), [['add', a[1][0], a[1][1], 'FF0000']]);
  const removed = view.calls.filter((c) => c[0] === 'remove');
  assert.ok(removed.length >= 3 && removed.every((c) => c[1] >= a[0][0] && c[2] <= a[0][1] && c[3] === 'ff0000'), 'only card A, only the red marks');
  assert.equal(h.toasts.at(-1), 'Marked 1 card, unmarked 1 card (⌘Z to undo)');
});

test('mark cards: no editor, no cards, and a doc whose cards changed meanwhile each explain', async () => {
  const none = markHarness(null, () => null);
  await cmd('markCards').run(none.api);
  assert.equal(none.toasts.at(-1), "Couldn't reach the editor. Click into your document, then run Mark cards again.");

  const empty = markHarness(fakeView(pm('doc', [pm('block', [txt('x')])])), () => null);
  await cmd('markCards').run(empty.api);
  assert.equal(empty.toasts.at(-1), 'No cards in this document.');

  const view = fakeView(MARK_DOC());
  const moved = markHarness(view, () => { view.state.doc = pm('doc', [card(txt('New'), 'x', txt('y'))]); return [true]; });
  await cmd('markCards').run(moved.api);
  assert.equal(moved.toasts.at(-1), 'The cards changed while the list was open. Run Mark cards again.');
  assert.equal(view.dispatched.length, 0);
});

test('DOM mark cards: the editor view is picked up from ProseMirror; filter, Enter checks, Apply counts, ⌘Enter applies', async () => {
  const dom = fakeDom();
  const saved = { document: globalThis.document, Option: globalThis.Option, ui: window.__debateUploaderUI, getSelection: window.getSelection };
  globalThis.document = dom.doc; globalThis.Option = dom.Option;
  const view = fakeView(MARK_DOC());
  // ProseMirror's shape: the editor element's view description gets the view in setSelection().
  class ViewDesc { setSelection(anchor, head, v) { this.seen = v; } update(node, outer, inner, v) { this.seen = v; } }
  const editorEl = { pmViewDesc: new ViewDesc(), isConnected: true, offsetParent: {}, parentElement: null, scrollTop: 0, focus() {} };
  view.dom = editorEl;
  view.docView = {};
  const ranges = [];
  dom.doc.querySelectorAll = (sel) => (sel === '.ProseMirror' ? [editorEl] : []);
  dom.doc.createRange = () => ({ selectNodeContents() {}, collapse() {}, cloneRange() { return this; } });
  window.getSelection = () => ({
    get rangeCount() { return ranges.length; },
    getRangeAt: (i) => ranges[i],
    removeAllRanges: () => { ranges.length = 0; },
    addRange: (r) => { ranges.push(r); editorEl.pmViewDesc.setSelection(0, 0, view); }, // ProseMirror syncing the caret
  });
  const h = harness();
  delete window.__debateUploaderUI; // real DOM UI, real editor lookup
  try {
    const running = cmd('markCards').run(h.api);
    for (let i = 0; i < 300 && !dom.byField('query'); i++) await new Promise((r) => setTimeout(r, 20));
    const input = dom.byField('query');
    assert.ok(input, 'picker opened, so the view was found');
    const rows = () => dom.byField('list').children.filter((n) => n.className.startsWith('du-row'));
    const groups = () => dom.byField('list').children.filter((n) => n.className === 'du-group').map((n) => n.textContent);
    assert.deepEqual(groups(), ['AT: Grid', 'Econ']);
    assert.equal(rows().length, 4);
    input.value = 'econ'; input.dispatch('input');
    assert.equal(rows().length, 1);
    input.dispatch('keydown', { key: 'Enter' });
    assert.equal(rows()[0].getAttribute('aria-checked'), 'true');
    assert.ok(dom.all(dom.doc.body).some((n) => n.tagName === 'BUTTON' && n.textContent === 'Mark 1'), 'Apply reads "Mark 1"');
    input.dispatch('keydown', { key: 'Enter', metaKey: true });
    await running;
    assert.equal(view.dispatched.length, 1);
    assert.equal(h.toasts.at(-1), 'Marked 1 card (⌘Z to undo)');
  } finally {
    globalThis.document = saved.document; globalThis.Option = saved.Option; window.__debateUploaderUI = saved.ui; window.getSelection = saved.getSelection;
  }
});

test('caselist form: the round report is drafted from the room and send doc, with a note naming the sources', async () => {
  const h = caselistHarness({ storage: { caselistTarget: TARGET, lastRoom: 'abc12', sendDocFolder: '/send' },
    results: { '/tabroom/rounds': { current: false, rounds: [] }, '/caselist/report-draft': { report: '1AC -- Grid\n1NC -- Econ', used: ['1AC.docx', '1NC.docx'], skipped: 1 } },
    direct: { '/caselist/newest': { name: 'Send.docx', size: 5, mtime: 1 } } });
  await cmd('caselistUpload').run(h.api);
  assert.deepEqual(h.calls.find((c) => c.route === '/caselist/report-draft').body, { room: 'abc12', folder: '/send' });
  assert.equal(h.forms[0].fields.report, '1AC -- Grid\n1NC -- Econ');
  assert.equal(h.forms[0].reportNote, 'Drafted from 2 docs (1AC.docx, 1NC.docx); 1 non-.docx file skipped. Edit before uploading.');

  const none = caselistHarness({ storage: { caselistTarget: TARGET }, results: { '/tabroom/rounds': { current: false, rounds: [] }, '/caselist/report-draft': new Error('boom') } });
  await cmd('caselistUpload').run(none.api);
  assert.equal(none.forms[0].fields.report, '');
  assert.equal(none.forms[0].reportNote, '', 'a failed draft never blocks the form');
});

// ---------------------------------------------------------------- Card Check
const LINK = (href) => ({ type: { name: 'link' }, attrs: { href } });
const HL = { type: { name: 'highlight' }, attrs: { color: 'yellow' } };
const CHECK_DOC = () => pm('doc', [
  pm('block', [txt('AT: Grid')]),
  pm('card', [pm('tag', [txt('Grid collapses')]), pm('cite_paragraph', [txt('Chen 25 '), txt('arxiv', LINK('https://arxiv.org/pdf/1'))]), pm('card_body', [txt('Loads ', HL), txt('may '), txt('trip the grid.', HL)])]),
  pm('card', [pm('tag', [txt('No link card')]), pm('cite_paragraph', [txt('Smith 19, https://x.org/a')]), pm('card_body', [txt('Text.')])]),
]);

test('card check: sends each card\'s cite links and highlighted runs; results fill in; Go to card finds it by tag', async () => {
  const view = fakeView(CHECK_DOC());
  const h = harness();
  const jobs = [];
  h.api.flowPost = async (app, route, body) => {
    const pr = h.prefsReply(route, body); if (pr) return pr;
    h.calls.push({ route, body });
    if (route === '/cardcheck/run') return ok({ ok: true, job: 'cc' });
    if (route === '/job') {
      jobs.push(1);
      const r1 = { key: 0, status: 'differences', issues: ['Not found in the source: "x"'], url: 'https://arxiv.org/pdf/1', qualifiers: [{ word: 'may', context: 'loads [may] trip the' }] };
      if (jobs.length === 1) return ok({ state: 'running', progress: { done: 1, total: 2, results: [r1, null] } });
      return ok({ state: 'done', result: { done: 2, total: 2, results: [r1, { key: 1, status: 'unreachable', issues: [], url: 'https://x.org/a', reason: 'http_403', qualifiers: [] }] } });
    }
    return ok({ ok: true });
  };
  const updates = [];
  let spec;
  window.__debateUploaderUI.editorView = async () => view;
  window.__debateUploaderUI.sleep = async () => {};
  window.__debateUploaderUI.checkResults = (s) => { spec = s; return { closed: Promise.resolve(), update: (items, sub) => updates.push([items, sub]) }; };
  h.api.docInfo = () => ({ docId: 'd', docTitle: 'Grid Aff' });
  await cmd('cardCheck').run(h.api);
  const sent = h.calls.find((c) => c.route === '/cardcheck/run').body.cards;
  assert.deepEqual(sent.map((c) => [c.key, c.cite, c.urls]), [[0, 'Chen 25 arxiv', ['https://arxiv.org/pdf/1']], [1, 'Smith 19, https://x.org/a', []]]);
  assert.deepEqual(sent[0].runs, [{ t: 'Loads ', h: true }, { t: 'may ', h: false }, { t: 'trip the grid.', h: true }, { t: '\n', h: false }]);
  assert.equal(spec.title, 'Card Check: Grid Aff');
  assert.deepEqual(spec.items.map((i) => i.statusText), ['Checking…', 'Checking…']);
  assert.equal(updates[0][1], 'Checked 1 of 2 · 1 with differences');
  const [final, sub] = updates.at(-1);
  assert.equal(sub, "1 with differences · 1 couldn't check");
  assert.deepEqual(final.map((i) => [i.glyph, i.statusText]), [['!', 'Differences found · check highlighting'], ['×', "Couldn't reach the source (http_403)"]]);
  assert.deepEqual(final[0].notes, ['"loads [may] trip the": the highlighting skips "may".']);

  view.state.selection = { constructor: { near: ($pos) => ({ near: $pos }) } };
  view.state.doc.resolve = (p) => ({ pos: p });
  const sels = [];
  const origTr = Object.getOwnPropertyDescriptor(view.state, 'tr').get;
  Object.defineProperty(view.state, 'tr', { get() { const tr = origTr(); tr.setSelection = (sel) => { sels.push(sel); return tr; }; tr.scrollIntoView = () => tr; return tr; } });
  spec.onGo(final[1]);
  assert.equal(sels.length, 1, 'selection moved to the card');
  const second = []; view.state.doc.forEach((n, p) => second.push(p));
  assert.equal(sels[0].near.pos, second[2] + 2, 'lands inside the second card');

  // Results stay available
  let again;
  window.__debateUploaderUI.checkResults = (s) => { again = s; return { closed: Promise.resolve(), update() {} }; };
  await cmd('cardCheckLast').run(h.api);
  assert.equal(again.subtitle, "1 with differences · 1 couldn't check");
});

test('card check: a card without a marked cite uses its first unhighlighted paragraph as the cite', async () => {
  const doc = pm('doc', [pm('card', [pm('tag', [txt('T')]), pm('card_body', [txt('Chen 25 '), txt('link', LINK('https://a.org/1'))]), pm('card_body', [txt('Read this.', HL)])])]);
  const view = fakeView(doc);
  const h = harness();
  h.api.flowPost = async (app, route, body) => { const pr = h.prefsReply(route, body); if (pr) return pr; h.calls.push({ route, body }); return route === '/job' ? ok({ state: 'done', result: { results: [] } }) : ok({ ok: true, job: 'j' }); };
  window.__debateUploaderUI.editorView = async () => view;
  window.__debateUploaderUI.checkResults = () => ({ closed: Promise.resolve(), update() {} });
  await cmd('cardCheck').run(h.api);
  const [c] = h.calls.find((x) => x.route === '/cardcheck/run').body.cards;
  assert.deepEqual([c.cite, c.urls, c.runs.map((r) => r.t).join('')], ['Chen 25 link', ['https://a.org/1'], 'Read this.\n']);
});

// ---------------------------------------------------------------- Email chain
function mailHarness({ status = { email: 'me@gmail.com' }, prompts = [], form = (spec) => ({ to: ['j@s.edu', 'o@x.org'], subject: spec.subject, body: spec.body, replyTo: null }), send = { name: 'Send 1AC.docx', recipients: 2, reply: false }, rounds = { current: true, rounds: [{ id: 1, tournament: 'Glenbrooks', round: '3', side: 'A', opponent: 'Cranbrook FZ', judge: 'Lee' }] }, storage = {}, recent = { me: 'me@gmail.com', messages: [] } } = {}) {
  const h = caselistHarness({ storage: { caselistTarget: TARGET, sendDocFolder: '/send', ...storage },
    results: { '/tabroom/rounds': rounds, '/gmail/send': send, '/gmail/recent': recent, '/gmail/setup': (b) => (b.appPassword === 'abcd efgh ijkl mnop' ? { email: b.email } : new Error('bad_login')) },
    direct: { '/gmail/status': status, '/caselist/newest': { name: 'Send 1AC.docx', size: 5, mtime: 1 } } });
  h.prompts = [];
  const answers = [...prompts];
  window.__debateUploaderUI.prompt = async (label, initial, opts) => { h.prompts.push([label, initial, !!(opts && opts.secret)]); return answers.shift() ?? null; };
  h.mailForms = [];
  window.__debateUploaderUI.emailForm = async (spec) => { h.mailForms.push(spec); return form(spec); };
  return h;
}

test('email chain: subject from the Tabroom pairing, last chain prefilled, sends the newest send doc, remembers the chain', async () => {
  const h = mailHarness({ storage: { emailChain: { to: ['old@x.org'], subject: 'Old' } } });
  await cmd('emailChain').run(h.api);
  const spec = h.mailForms[0];
  assert.deepEqual([spec.from, spec.to, spec.subject], ['me@gmail.com', 'old@x.org', "Glenbrooks · Round 3 · St. Mark's AB vs Cranbrook FZ"]);
  assert.match(spec.attached, /^Send 1AC\.docx \(newest send doc/);
  assert.deepEqual(h.calls.find((c) => c.route === '/gmail/send').body, { to: ['j@s.edu', 'o@x.org'], subject: "Glenbrooks · Round 3 · St. Mark's AB vs Cranbrook FZ", text: 'Speech doc attached.', replyTo: null, folder: '/send', expectName: 'Send 1AC.docx' });
  assert.deepEqual(h.store.get('emailChain'), { to: ['j@s.edu', 'o@x.org'], subject: "Glenbrooks · Round 3 · St. Mark's AB vs Cranbrook FZ" });
  assert.equal(h.toasts.at(-1), 'Sent "Send 1AC.docx" to 2 people.');
});

test('email chain: first use sets up Gmail (password prompt is secret); cancel sends nothing; errors explain', async () => {
  const h = mailHarness({ status: { email: null }, prompts: ['me@gmail.com', 'abcd efgh ijkl mnop'] });
  await cmd('emailChain').run(h.api);
  assert.deepEqual(h.prompts.map(([, , secret]) => secret), [false, true]);
  assert.deepEqual(h.calls.find((c) => c.route === '/gmail/setup').body, { email: 'me@gmail.com', appPassword: 'abcd efgh ijkl mnop' });
  assert.ok(h.toasts.includes('Gmail ready: chains send from me@gmail.com.'));
  assert.ok(h.calls.some((c) => c.route === '/gmail/send'));

  const wrong = mailHarness({ status: { email: null }, prompts: ['me@gmail.com', 'nope'] });
  await cmd('emailChain').run(wrong.api);
  assert.match(wrong.toasts.at(-1), /^Gmail rejected that address or app password/);
  assert.equal(wrong.calls.filter((c) => c.route === '/gmail/send').length, 0);

  const cancel = mailHarness({ form: () => null });
  await cmd('emailChain').run(cancel.api);
  assert.equal(cancel.calls.filter((c) => c.route === '/gmail/send').length, 0);

  const unsure = mailHarness({ send: new Error('send_unknown') });
  await cmd('emailChain').run(unsure.api);
  assert.equal(unsure.toasts.at(-1), "Gmail didn't confirm. Check your Sent folder before sending again.");
});

test('email chain: reply all to a recent email (everyone but me, its thread); the message is editable and remembered', async () => {
  const recent = { me: 'me@gmail.com', messages: [
    { messageId: '<c2@x.org>', subject: 'Re: Glenbrooks R3 chain', from: 'opp1@x.org', fromName: 'Opp One', to: ['lee@school.edu', 'Me@Gmail.com'], cc: ['opp2@x.org'], date: Date.parse('2026-10-05T14:20:00Z'), references: ['<c1@school.edu>'] },
    { messageId: '<news@y>', subject: 'Newsletter', from: 'me@gmail.com', fromName: 'Me', to: [], cc: [], date: 1, references: [] },
  ] };
  const h = mailHarness({ recent, storage: { emailBody: 'Our 1AC, thanks!' },
    form: (spec) => ({ to: spec.replies[0].to, subject: spec.replies[0].subject, body: 'Here is the 1AC.', replyTo: spec.replies[0].replyTo }) });
  await cmd('emailChain').run(h.api);
  const spec = h.mailForms[0];
  assert.equal(spec.body, 'Our 1AC, thanks!');
  assert.equal(spec.replies.length, 1, 'emails with nobody else on them are not reply targets');
  assert.match(spec.replies[0].label, /^Re: Glenbrooks R3 chain · Opp One · /);
  assert.deepEqual(spec.replies[0].to, ['opp1@x.org', 'lee@school.edu', 'opp2@x.org']);
  assert.deepEqual(h.calls.find((c) => c.route === '/gmail/send').body, { to: ['opp1@x.org', 'lee@school.edu', 'opp2@x.org'], subject: 'Re: Glenbrooks R3 chain', text: 'Here is the 1AC.', replyTo: { messageId: '<c2@x.org>', references: ['<c1@school.edu>'] }, folder: '/send', expectName: 'Send 1AC.docx' });
  assert.equal(h.store.get('emailBody'), 'Here is the 1AC.');

  const noInbox = mailHarness({ recent: new Error('imap_unreachable') });
  await cmd('emailChain').run(noInbox.api);
  assert.deepEqual(noInbox.mailForms[0].replies, []);
  assert.match(noInbox.mailForms[0].replyNote, /^Couldn't read your recent emails/);
  assert.ok(noInbox.calls.some((c) => c.route === '/gmail/send'), 'a new email still works');
});

test('mark cards: unchecking a partly red card clears its red', async () => {
  const doc = pm('doc', [card(txt('C'), 'cite c', txt('blue', BLUE), txt('red', RED))]);
  const view = fakeView(doc);
  const h = markHarness(view, () => [false]);
  await cmd('markCards').run(h.api);
  assert.ok(view.calls.some((c) => c[0] === 'remove' && c[3] === 'ff0000'));
  assert.equal(h.toasts.at(-1), 'Unmarked 1 card (⌘Z to undo)');
});

test('email chain: a send-doc change, a lost connection and a slow helper each say what happened', async () => {
  for (const [code, want] of [['newest_changed', /changed after the form opened\. Nothing was sent/], ['smtp_closed', /^Couldn't reach Gmail/], ['still_running', /Check your Sent folder/]]) {
    const h = mailHarness({ send: new Error(code) });
    await cmd('emailChain').run(h.api);
    assert.match(h.toasts.at(-1), want, code);
  }
});

test('DOM email form: "New email" is a new thread even with recent emails; switching back restores the fields', async () => {
  const dom = fakeDom();
  const saved = { document: globalThis.document, Option: globalThis.Option, ui: window.__debateUploaderUI };
  const recent = { me: 'me@gmail.com', messages: [{ messageId: '<c2@x.org>', subject: 'Re: R3 chain', from: 'opp1@x.org', fromName: 'Opp', to: ['lee@s.edu'], cc: [], date: 1, references: [] }] };
  const h = mailHarness({ recent, storage: { emailChain: { to: ['old@x.org'], subject: 'Old' } } });
  globalThis.document = dom.doc; globalThis.Option = dom.Option;
  delete window.__debateUploaderUI; // drive the real DOM email form
  try {
    const running = cmd('emailChain').run(h.api);
    for (let i = 0; i < 150 && !dom.doc.body.children.length; i++) await new Promise((r) => setTimeout(r, 20));
    const reply = dom.byField('reply');
    assert.equal(reply.value, '', 'starts on New email');
    reply.value = '0'; reply.dispatch('change');
    assert.equal(dom.byField('to').value, 'opp1@x.org, lee@s.edu');
    reply.value = ''; reply.dispatch('change');
    assert.equal(dom.byField('to').value, 'old@x.org', 'back to New email restores the prefilled To');
    dom.button('Send').dispatch('click');
    await running;
    const sent = h.calls.find((c) => c.route === '/gmail/send').body;
    assert.equal(sent.replyTo, null, 'New email never replies to the latest message');
    assert.deepEqual(sent.to, ['old@x.org']);
  } finally {
    for (const n of dom.doc.body.children) n.remove();
    globalThis.document = saved.document; globalThis.Option = saved.Option; window.__debateUploaderUI = saved.ui;
  }
});

test('DOM form: going back to "Enter manually" keeps what was typed', async () => {
  await withDom(async (dom) => {
    const fill = dom.byField('fill');
    fill.value = '0'; fill.dispatch('change');
    dom.byField('opponent').value = 'Typed Opp';
    fill.value = ''; fill.dispatch('change');
    assert.equal(dom.byField('opponent').value, 'Typed Opp');
  });
});

test('copy: only the exact pmd-cite / pmd-emphasis classes are bolded; "$&" in CSS survives the round trip', () => {
  const { boldCopiedHTML, unboldCopiedHTML } = window.__debateUploaderClipboard;
  const other = '<span class="pmd-cite-author">x</span><span class="a pmd-emphasis-like">y</span>';
  assert.equal(boldCopiedHTML(other), other);
  const html = '<span class="x pmd-cite" style="font-family: a$&b$\'c">z</span>';
  const out = boldCopiedHTML(html);
  assert.match(out, /style="font-family: a\$&b\$'c; font-weight: 700;"/);
  assert.equal(unboldCopiedHTML(out), html);
});

test('search my files: a same-named doc that was already open is not the new one; the jump waits for the switch', async () => {
  let n = 0;
  const jumps = [];
  // Before the open, a different "Grid" (d0) is active; the opened one (d1) shows up a bit later.
  const h = evidenceHarness({ docInfo: () => (++n < 4 ? { docId: 'd0', docTitle: 'Grid' } : { docId: 'd1', docTitle: 'Grid' }), jump: async (src) => { jumps.push(src); return { ok: true }; } });
  await cmd('evidenceSearch').run(h.api);
  await h.searches[0].onOpen({ card: CARD });
  const decoded = JSON.parse(Buffer.from(jumps[0].slice(7).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
  assert.equal(decoded.docId, 'd1');
});

test('card check: only the first 400 cards are sent; the rest say "not checked"', async () => {
  const many = pm('doc', Array.from({ length: 402 }, (_, i) => card(txt(`Tag ${i}`), `Cite ${i} https://x.org/${i}`, txt('Body text here.'))));
  const view = fakeView(many);
  const h = harness();
  let sent;
  h.api.flowPost = async (app, route, body) => {
    const pr = h.prefsReply(route, body); if (pr) return pr;
    if (route === '/cardcheck/run') { sent = body.cards; return ok({ ok: true, job: 'cc' }); }
    if (route === '/job') return ok({ state: 'done', result: { results: sent.map((c) => ({ key: c.key, status: 'matches', issues: [], qualifiers: [] })) } });
    return ok({ ok: true });
  };
  let last;
  window.__debateUploaderUI.editorView = async () => view;
  window.__debateUploaderUI.sleep = async () => {};
  window.__debateUploaderUI.checkResults = () => ({ closed: Promise.resolve(), update: (items, sub) => { last = [items, sub]; } });
  await cmd('cardCheck').run(h.api);
  assert.equal(sent.length, 400);
  assert.equal(last[0][399].status, 'matches');
  assert.equal(last[0][400].status, 'skipped');
  assert.match(last[1], /400 match · 2 not checked \(over 400\)$/);
});

test('email chain: between tournaments the subject is not a stale past round', async () => {
  const h = mailHarness({ rounds: { current: false, rounds: [{ id: 1, tournament: 'Old Tourney', round: '6', side: 'A', opponent: 'X AB' }] }, storage: { emailChain: { to: ['a@b.org'], subject: 'Last chain' } } });
  await cmd('emailChain').run(h.api);
  assert.equal(h.mailForms[0].subject, 'Last chain');
});

test('caselist form: a report draft that never finishes does not hold the form', async () => {
  const h = caselistHarness({ storage: { caselistTarget: TARGET, lastRoom: 'abc12', sendDocFolder: '/send' },
    results: { '/tabroom/rounds': { current: false, rounds: [] } },
    direct: { '/caselist/newest': { name: 'Send.docx', size: 5, mtime: 1 } } });
  const plain = h.api.flowPost;
  h.api.flowPost = async (app, route, body) => {
    if (route === '/caselist/report-draft') return ok({ ok: true, job: 'slow' });
    if (route === '/job' && body.id === 'slow') return new Promise(() => {}); // the helper never answers
    return plain(app, route, body);
  };
  await cmd('caselistUpload').run(h.api);
  assert.equal(h.forms.length, 1);
  assert.equal(h.forms[0].fields.report, '');
});

test('team page link encodes the caselist, school and team', async () => {
  const h = caselistHarness({ storage: { caselistTarget: TARGET }, results: { ...LISTS, '/caselist/schools': [{ name: "St Mark's", label: "St. Mark's" }], '/caselist/teams': [{ name: 'A#B', label: 'AB' }], '/caselist/team': { rounds: [], cites: [] } } });
  let spec;
  window.__debateUploaderUI.teamPage = async (x) => { spec = x; };
  window.__debateUploaderUI.choose = async () => 0;
  await cmd('caselistSearch').run(h.api);
  assert.equal(spec.pageUrl, "https://opencaselist.com/hspf26/St%20Mark's/A%23B");
});

test('set send doc folder: when the settings gear has a different folder, the toast says the gear wins', async () => {
  const h = harness({ settings: { sendDocFolder: '/gear' }, folderAnswer: '/typed' });
  await cmd('setFolder').run(h.api);
  assert.match(h.toasts.at(-1), /gear says \/gear, and that one is used/);
});

// ---------------------------------------------------------------- Copy into Google Docs / Word
test('copy: cite and emphasis get bold (tagged) for other apps; pasting back into CardMirror removes exactly that', () => {
  const { boldCopiedHTML, unboldCopiedHTML } = window.__debateUploaderClipboard;
  const html = '<p class="pmd-cite-para" style="font-size: 11pt"><span class="pmd-cite" style="font-size: 13pt">Galka Reczko ’9-17</span> [Aleksandra]</p>'
    + '<p class="pmd-card-body"><span class="pmd-underline" style="font-size: 11pt; text-decoration: underline">Prime Minister</span> said <span class="pmd-emphasis" style="font-size: 11pt; text-decoration: underline; border: 1pt solid #333">most probable</span> <span class="pmd-emphasis">x</span></p>';
  const out = boldCopiedHTML(html);
  assert.match(out, /<span class="pmd-cite" style="font-size: 13pt; font-weight: 700;" data-du-bold="font-size: 13pt">Galka/);
  assert.match(out, /<span class="pmd-emphasis" style="font-size: 11pt; text-decoration: underline; border: 1pt solid #333; font-weight: 700;" data-du-bold="font-size: 11pt; text-decoration: underline; border: 1pt solid #333">most probable/);
  assert.match(out, /<span class="pmd-emphasis" style="font-weight: 700;" data-du-bold="-">x/);
  assert.match(out, /<span class="pmd-underline" style="font-size: 11pt; text-decoration: underline">Prime/, 'underline is not bolded');
  assert.equal(boldCopiedHTML(out), out, 'idempotent');
  assert.equal(unboldCopiedHTML(out), html, 'pasting back restores CardMirror\'s own HTML exactly');
});

// ---------------------------------------------------------------- Compare text
const compare = (...a) => window.__debateUploaderCompare(...a);
const marked = (pieces) => pieces.filter((p) => p.kind).map((p) => (p.kind === 3 ? '|' : p.text));
const joined = (pieces) => pieces.map((p) => p.text).join('');

test('compare: identical texts have no differences', () => {
  const r = compare('Same text.\nTwo lines.', 'Same text.\nTwo lines.');
  assert.equal(r.diffs, 0);
  assert.deepEqual(r.left, [{ text: 'Same text.\nTwo lines.', kind: 0, g: -1 }]);
});

test('compare: each side always rebuilds its own text exactly', () => {
  const pairs = [['The big red dog ran home.', 'The small blue dog ran.'], ['', 'only right'], ['only left', ''],
    ['Hello  World\nagain', 'hello World again'], ['a b c d e f', 'f e d c b a'], ['don’t — stop', "don't - stop!"]];
  for (const [a, b] of pairs) for (const o of [{}, { mode: 'chars' }, { ignoreCase: true, ignoreSpace: true }, { mode: 'chars', ignoreSpace: true }]) {
    const r = compare(a, b, o);
    assert.equal(joined(r.left), a, JSON.stringify([a, b, o]));
    assert.equal(joined(r.right), b, JSON.stringify([a, b, o]));
  }
});

test('compare: a rewritten phrase is one difference, an insertion leaves a marker on the other side', () => {
  const r = compare('The big red dog ran home.', 'The small blue dog ran home.');
  assert.equal(r.diffs, 1);
  assert.deepEqual([marked(r.left), marked(r.right)], [['big red'], ['small blue']]);
  assert.deepEqual([r.removed, r.added, r.unit], [2, 2, 'word']);
  const merged = compare('hyperscalers a recession', 'investors a slowdown');
  assert.equal(merged.diffs, 1, 'the short shared "a" joins the change');
  assert.deepEqual([merged.removed, merged.added], [2, 2], 'but it is not counted as only in one text');
  const ins = compare('cause a recession.', 'could cause a severe recession.');
  assert.equal(ins.diffs, 2);
  assert.deepEqual([marked(ins.left), marked(ins.right)], [['|', '|'], ['could ', ' severe']]);
});

test('compare: Characters mode marks the exact byte when the words mostly match, whole words otherwise', () => {
  const quote = compare("don’t stop", "don't stop", { mode: 'chars' });
  assert.deepEqual([marked(quote.left), marked(quote.right)], [['don', '’', 't'], ['don', "'", 't']]);
  assert.deepEqual(quote.left.filter((p) => p.kind === 2).map((p) => p.text), ['’'], 'only the apostrophe is a changed byte');
  assert.deepEqual([quote.removed, quote.added, quote.unit], [1, 1, 'character']);
  const swap = compare('nearly all', 'almost all', { mode: 'chars' });
  assert.deepEqual([marked(swap.left), marked(swap.right)], [['nearly'], ['almost']]);
  assert.deepEqual(swap.left.find((p) => p.kind).kind, 2);
});

test('compare: Words mode flags spacing and case; the Ignore options hide only those', () => {
  assert.equal(compare('Data  center', 'Data center').diffs, 1, 'a double space is a difference by default');
  assert.equal(compare('Data center', 'data center').diffs, 1);
  assert.equal(compare('Data  center\nboom', 'Data center boom', { ignoreSpace: true }).diffs, 0);
  assert.equal(compare('DATA center', 'data Center', { ignoreCase: true }).diffs, 0);
  assert.equal(compare('Data center', 'Datacenter', { ignoreSpace: true }).diffs, 1, 'a missing space between words still differs');
  const comma = compare('a, b', 'a b');
  assert.deepEqual([comma.diffs, comma.removed, comma.added], [1, 0, 0], 'punctuation is a difference, not a word');
});

test('compare: a card against its whole source article stays fast and exact', () => {
  const words = Array.from({ length: 9000 }, (_, i) => `w${(i * 7919) % 1000}`);
  const card = words.slice(4000, 4300).join(' ');
  const t = Date.now();
  const r = compare(card, words.join(' '));
  assert.ok(Date.now() - t < 1000, 'well under a second');
  assert.equal(r.timedOut, false);
  assert.equal(r.removed, 0, 'every card word is in the source');
});

test('Compare text: the selection becomes Text 1; texts and options are kept for the session', async () => {
  const h = harness();
  const specs = [];
  let selection = '  Card text from the doc  ';
  window.__debateUploaderUI = { selectedText: () => selection, compareText: async (spec) => { specs.push(spec); } };
  await cmd('textCompare').run(h.api);
  assert.equal(h.calls.length, 0, 'never calls the helper');
  assert.deepEqual(specs[0].texts, ['  Card text from the doc  ', '']);
  assert.deepEqual(specs[0].opts, { mode: 'words', ignoreCase: false, ignoreSpace: false });
  assert.equal(specs[0].compare('a', 'b').diffs, 1);
  specs[0].onChange({ texts: ['Card text from the doc', 'Source paragraph'], opts: { mode: 'chars', ignoreCase: true, ignoreSpace: false } });
  selection = 'A different card';
  await cmd('textCompare').run(h.api);
  assert.deepEqual(specs[1].texts, ['A different card', 'Source paragraph'], 'Text 2 is kept so one source checks several cards');
  assert.equal(specs[1].opts.mode, 'chars');
  selection = '   ';
  await cmd('textCompare').run(h.api);
  assert.deepEqual(specs[2].texts, ['A different card', 'Source paragraph'], 'no selection keeps Text 1 too');
  assert.equal(specs[2].readSelection(), '   ');
});

// ---------------------------------------------------------------- open cache
const openCache = () => window.__debateUploaderOpenCache;
function fakeWorkerClass() {
  class FakeWorker extends EventTarget {
    constructor() { super(); this.posted = []; }
    reply(data) { this.dispatchEvent(new MessageEvent('message', { data })); }
  }
  FakeWorker.prototype.postMessage = function (m) { this.posted.push(m); };
  return FakeWorker;
}
function memStore() {
  const m = new Map();
  return { m, puts: 0, async get(k) { return m.get(k); }, async put(k, v) { this.puts++; m.set(k, v); }, async touch() {}, async clear() { m.clear(); } };
}
const tick = () => new Promise((r) => setTimeout(r, 5));
const big = (fill) => new Uint8Array(600 * 1024).fill(fill);
const patch = (W, store, extra = {}) => openCache().patchWorkerPostMessage(W.prototype, { store, version: () => 'v1', hash: async (b) => `h${b[0]}`, idle: (fn) => fn(), ...extra });

test('open cache: a miss parses in the worker, then the reply is stored and served on reopen', async () => {
  const W = fakeWorkerClass();
  const early = new W(); // made before the plugin loaded: still covered
  const store = memStore();
  patch(W, store);
  const got = [];
  early.onmessage = (e) => got.push(e.data);
  early.addEventListener('message', (e) => got.push(e.data));
  early.postMessage({ id: 1, bytes: big(7) });
  await tick();
  assert.equal(early.posted.length, 1, 'miss goes to the real worker');
  early.reply({ id: 1, ok: true, docJson: { type: 'doc' }, threads: [], docId: 'd1' });
  await tick();
  assert.equal(store.puts, 1);
  assert.deepEqual([...store.m.keys()], ['v1|h7']);
  got.length = 0;
  early.postMessage({ id: 2, bytes: big(7) });
  await tick();
  assert.equal(early.posted.length, 1, 'hit never reaches the worker');
  assert.deepEqual(got[0], { id: 2, ok: true, docJson: { type: 'doc' }, threads: [], docId: 'd1' });
  assert.equal(store.puts, 1, 'a cached reply is not stored again');
});

test('open cache: different bytes or a new CardMirror build miss', async () => {
  const W = fakeWorkerClass();
  const store = memStore();
  let version = 'v1';
  patch(W, store, { version: () => version });
  const w = new W();
  w.postMessage({ id: 1, bytes: big(1) });
  await tick();
  w.reply({ id: 1, ok: true, docJson: { a: 1 }, threads: [], docId: null });
  await tick();
  w.postMessage({ id: 2, bytes: big(2) });
  await tick();
  assert.equal(w.posted.length, 2, 'changed file parses fresh');
  version = 'v2';
  w.postMessage({ id: 3, bytes: big(1) });
  await tick();
  assert.equal(w.posted.length, 3, 'new build parses fresh');
});

test('open cache: failed parses, small files, other messages and the off switch are untouched', async () => {
  const W = fakeWorkerClass();
  const store = memStore();
  let on = true;
  patch(W, store, { hash: async () => 'h', enabled: () => on });
  const w = new W();
  w.postMessage({ id: 1, bytes: big(1) });
  await tick();
  w.reply({ id: 1, ok: false, error: 'bad zip' });
  await tick();
  assert.equal(store.puts, 0, 'errors are never cached');
  w.postMessage({ id: 2, bytes: new Uint8Array(10) });
  assert.equal(w.posted.length, 2, 'small file posts synchronously');
  w.postMessage({ id: 3, bytes: big(1), format: 'docx', kinds: ['tag'] });
  assert.equal(w.posted.length, 3, 'quick-card parse request posts synchronously');
  w.postMessage('hello');
  assert.equal(w.posted.length, 4);
  on = false;
  w.postMessage({ id: 4, bytes: big(1) });
  assert.equal(w.posted.length, 5, 'setting off: straight to the worker');
  on = true;
  patch(W, store, { hash: async () => 'other' });
  w.postMessage({ id: 5, bytes: big(1) });
  await tick();
  assert.equal(w.posted.length, 6, 'patching twice is a no-op: one post, keyed by the first patch');
  w.reply({ id: 5, ok: true, docJson: { b: 1 }, threads: [], docId: null });
  await tick();
  assert.deepEqual([...store.m.keys()], ['v1|h'], 'first patch\'s hash and version are used');
});

test('open cache: a stalled cache lookup gives up and lets the worker parse', async () => {
  const W = fakeWorkerClass();
  const store = { get: () => new Promise(() => {}), async put() {}, async touch() {} };
  patch(W, store, { lookupMs: 20 });
  const w = new W();
  w.postMessage({ id: 1, bytes: big(1) });
  await tick();
  assert.equal(w.posted.length, 0, 'waits for the lookup a little');
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(w.posted.length, 1, 'then parses as usual');
});

test('open cache: two opens in flight each get their own reply and key', async () => {
  const W = fakeWorkerClass();
  const store = memStore();
  patch(W, store);
  const w = new W();
  const got = [];
  w.addEventListener('message', (e) => got.push(e.data.id));
  w.postMessage({ id: 1, bytes: big(1) });
  w.postMessage({ id: 2, bytes: big(2) });
  await tick();
  assert.deepEqual(w.posted.map((m) => m.id), [1, 2]);
  w.reply({ id: 2, ok: true, docJson: { n: 2 }, threads: [], docId: null });
  w.reply({ id: 1, ok: true, docJson: { n: 1 }, threads: [], docId: null });
  await tick();
  assert.deepEqual(store.m.get('v1|h1').docJson, { n: 1 });
  assert.deepEqual(store.m.get('v1|h2').docJson, { n: 2 });
  w.postMessage({ id: 3, bytes: big(2) });
  await tick();
  assert.equal(got.at(-1), 3);
  assert.equal(w.posted.length, 2, 'the second file now opens from the cache');
});

test('open cache: LRU order keeps the newest ten and names what falls off', () => {
  const { lruOrder } = openCache();
  assert.deepEqual(lruOrder(undefined, 'a', 3), { keys: ['a'], evicted: [] });
  assert.deepEqual(lruOrder(['b', 'a', 'c'], 'a', 3), { keys: ['a', 'b', 'c'], evicted: [] });
  assert.deepEqual(lruOrder(['b', 'c', 'd'], 'a', 3), { keys: ['a', 'b', 'c'], evicted: ['d'] });
  assert.deepEqual(lruOrder('junk', 'a', 3), { keys: ['a'], evicted: [] });
});

test('open cache: an unreadable cache falls back to the worker', async () => {
  const W = fakeWorkerClass();
  const store = { async get() { throw new Error('quota'); }, async put() { throw new Error('quota'); }, async touch() {} };
  patch(W, store);
  const w = new W();
  w.postMessage({ id: 1, bytes: big(1) });
  await tick();
  assert.equal(w.posted.length, 1);
  const got = [];
  w.addEventListener('message', (e) => got.push(e.data.id));
  w.reply({ id: 1, ok: true, docJson: {}, threads: [], docId: null }); // put rejects: swallowed
  await tick();
  assert.deepEqual(got, [1], 'the real reply still reaches CardMirror');
});


// ---- fast first open
// Expected trees are fast-xml-parser 4.5.6's output with CardMirror's options (captured once).
const FXP_CASES = [["<?xml version=\"1.0\" standalone=\"yes\"?>\r\n<a x=\"1\"><b/>  <c>t &amp; &#65; &nbsp;</c>\n</a>",[{"?xml":[{"#text":""}],":@":{"version":"1.0","standalone":"yes"}},{"a":[{"b":[]},{"#text":"  "},{"c":[{"#text":"t & &#65; &nbsp;"}]},{"#text":"\n"}],":@":{"x":"1"}}]],["<a>&amp;lt; &apos;&#x26;&#x3E;&#x3e;</a>",[{"a":[{"#text":"&lt; '&>&#x3e;"}]}]],["<a>a<!--c-->b</a>",[{"a":[{"#text":"ab"}]}]],["x<a>y</a>",[{"a":[{"#text":"y"}]}]],["x<?pi a=\"1\"?><a/>",[{"#text":"x"},{"?pi":[{"#text":""}],":@":{"a":"1"}},{"a":[]}]],["<w:p><w:r><w:rPr><w:highlight w:val=\"cyan\"/></w:rPr><w:t xml:space=\"preserve\"> hi </w:t></w:r></w:p>",[{"w:p":[{"w:r":[{"w:rPr":[{"w:highlight":[],":@":{"w:val":"cyan"}}]},{"w:t":[{"#text":" hi "}],":@":{"xml:space":"preserve"}}]}]}]],["<a b='s&quot;' c=\"x>y\"/>",[{"a":[],":@":{"b":"s\"","c":"x>y"}}]]];

test('makeFastXml: same tree as fast-xml-parser, null for what it leaves to it', () => {
  const fast = openCache().makeFastXml();
  for (const [xml, want] of FXP_CASES) assert.equal(JSON.stringify(fast(xml)), JSON.stringify(want), xml);
  for (const xml of ['<!DOCTYPE a><a/>', '<a><![CDATA[x]]></a>', '<a><b></a>', '<a>', '<a b/>', '<a x = "1"/>', '<a"b>x</a"b>', '<__proto__/>', '<' + 'd>'.repeat(102) + '</d>'.repeat(102)]) {
    assert.equal(fast(xml), null, xml);
  }
});

test('patchParserSource: wraps the one parser built with the exact options, else null', () => {
  const { patchParserSource, PARSER_OPTS } = openCache();
  const worker = (opts) => `(function(){"use strict";const Yo={XMLParser:class{constructor(o){this.o=o}parse(x){return 'slow:'+x}}};const Zo=new Yo.XMLParser(${opts});self.ze=function(n){return Zo.parse(n)};})();`;
  const src = patchParserSource(worker(PARSER_OPTS));
  assert.ok(src);
  const posted = [];
  const self = { postMessage: (m) => posted.push(m) };
  new Function('self', src)(self);
  assert.deepEqual(self.ze('<a>x</a>'), [{ a: [{ '#text': 'x' }] }]);
  assert.equal(self.ze('<!DOCTYPE a><a/>'), 'slow:<!DOCTYPE a><a/>');
  // The worker posts the first blocks of a long doc before the full reply.
  const block = (n) => ({ type: 'paragraph', content: [{ type: 'text', text: 'x'.repeat(n) }] });
  self.postMessage({ id: 7, ok: true, docJson: { type: 'doc', content: [block(7000), block(7000), block(10)] } });
  assert.equal(posted.length, 2);
  assert.deepEqual(posted[0].duPreview.content.length, 2);
  assert.equal(posted[0].id, 7);
  assert.equal(posted[1].docJson.content.length, 3);
  // A short doc has no preview.
  self.postMessage({ id: 8, ok: true, docJson: { type: 'doc', content: [block(10)] } });
  assert.equal(posted.length, 3);
  assert.equal(patchParserSource(worker(PARSER_OPTS.replace('trimValues:!1', 'trimValues:!0'))), null);
  assert.equal(patchParserSource(worker(PARSER_OPTS) + worker(PARSER_OPTS)), null);
  assert.equal(patchParserSource(null), null);
});

test('open hook: a cache miss goes to route first; the fast worker itself is never routed', async () => {
  const { patchWorkerPostMessage } = openCache();
  const sent = [];
  const proto = { postMessage(m) { sent.push([this.name, m]); } };
  const routed = [];
  let take = true;
  patchWorkerPostMessage(proto, { store: null, version: () => 'v', route: async (w, m) => { routed.push([w.name, m.id]); return take; } });
  const cm = Object.assign(Object.create(proto), { name: 'cm' });
  const fast = Object.assign(Object.create(proto), { name: 'fast', __duFastWorker: true });
  const bytes = new Uint8Array(10);
  cm.postMessage({ id: 1, bytes });
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(routed, [['cm', 1]]);
  assert.deepEqual(sent, []);
  take = false;
  cm.postMessage({ id: 2, bytes });
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(sent.map(([w, m]) => [w, m.id]), [['cm', 2]]);
  fast.postMessage({ id: 3, bytes });
  assert.deepEqual(sent.map(([w, m]) => [w, m.id]), [['cm', 2], ['fast', 3]]);
  cm.postMessage({ id: 4, bytes, format: 'docx' }); // not an open request
  assert.equal(sent.length, 3);
});

// ---------------------------------------------------------------- Quick switcher
const SW = () => window.__debateUploaderSwitcher;
const SWITCH_DOC = () => pm('doc', [
  pm('pocket', [txt('AFF')]),
  pm('hat', [txt('Case')]),
  pm('block', [txt('AT: Offshoring')]),
  card(txt('Data centers stay onshore'), 'Rogan 26', txt('Body')),
  pm('block', [txt('')]), // an empty heading is skipped but still ends the block above
  card(txt('Grid collapses'), 'Chen 25', txt('Body')),
  pm('analytic_unit', [pm('analytic', [txt('Offshoring is a myth')])]),
  pm('pocket', [txt('NEG')]),
  pm('block', [txt('Econ DA')]),
]);
const FAVS = [{ handle: '/f/AT Offshoring---MBA.docx', filename: 'AT Offshoring---MBA.docx', format: 'docx' }];
const RECENTS = [FAVS[0], { handle: '/f/NATO Bad.docx', filename: 'NATO Bad.docx', format: 'docx' }];

test('quick switcher: headings are pockets, hats, blocks and card tags in order, each with its parent', () => {
  const doc = SWITCH_DOC();
  const hs = SW().headingsIn(doc);
  assert.deepEqual(hs.map((h) => [h.name, h.text, h.parent]), [
    ['pocket', 'AFF', ''], ['hat', 'Case', 'AFF'], ['block', 'AT: Offshoring', 'Case'],
    ['tag', 'Data centers stay onshore', 'AT: Offshoring'], ['tag', 'Grid collapses', 'Case'],
    ['pocket', 'NEG', ''], ['block', 'Econ DA', 'NEG'],
  ]);
  assert.deepEqual(hs.map((h) => doc.nodeAt(h.pos).type.name), ['pocket', 'hat', 'block', 'tag', 'tag', 'pocket', 'block'], 'positions point at the heading nodes');
});

test('quick switcher: "AT offshoring" ranks the open doc\'s block, the same block in another file, the favorite, then a card', () => {
  const headings = SW().headingsIn(SWITCH_DOC());
  const evidence = SW().evidenceRows('AT offshoring', [
    { ...CARD, path: '/ev/Neg.docx', file: 'Neg.docx', ordinal: 9, tag: 'Reshoring fails', headings: ['NEG', 'AT Offshoring'] },
    { ...CARD, path: '/ev/Neg.docx', file: 'Neg.docx', ordinal: 7, tag: 'Tariffs fail', headings: ['NEG', 'AT Offshoring'] },
    { ...CARD, path: '/ev/Grid.docx', file: 'Grid.docx', ordinal: 3, tag: 'AT offshoring: they stay', cite: 'Rogan 26', headings: ['AFF'] },
    { ...CARD, path: '/ev/Data.docx', file: 'Data.docx', ordinal: 1, tag: 'Onshore', headings: ['AT: Offshoring'] }, // the open doc itself
  ], 'Data');
  assert.deepEqual(evidence.map((r) => [r.kind, r.label, r.sub, r.card.ordinal]), [
    ['Heading', 'AT Offshoring', 'Block · 2 matching cards', 7], // one row for the block, opening at its first card
    ['File card', 'AT offshoring: they stay', 'Rogan 26 · AFF', 3],
  ]);
  const items = SW().switcherItems('AT offshoring', { favs: FAVS, recents: RECENTS, headings, docTitle: 'Data', evidence });
  assert.deepEqual(items.map((i) => [i.label, i.where]), [
    ['AT: Offshoring', ['Heading', 'Data']],
    ['AT Offshoring', ['Heading', 'Neg.docx']],
    ['AT Offshoring---MBA', ['Favorite', 'AT Offshoring---MBA.docx']],
    ['AT offshoring: they stay', ['File card', 'Grid.docx']],
    ['Data centers stay onshore', ['Heading', 'Data']], // a tag found through its block comes last
  ]);
  assert.equal(items[0].heading.name, 'block');
  assert.equal(new Set(items.map((i) => i.key)).size, items.length, 'keys are unique');
  assert.deepEqual(SW().switcherItems('zzz', { favs: FAVS, recents: RECENTS, headings }), []);
});

test('quick switcher: an empty box lists favorites, recents (a starred one once), then the outline without tags', () => {
  const headings = SW().headingsIn(SWITCH_DOC());
  const items = SW().switcherItems('  ', { favs: FAVS, recents: RECENTS, headings, docTitle: 'Data' });
  assert.deepEqual(items.map((i) => [i.kind, i.label]), [
    ['Favorite', 'AT Offshoring---MBA'], ['Recent', 'NATO Bad'],
    ['Heading', 'AFF'], ['Heading', 'Case'], ['Heading', 'AT: Offshoring'], ['Heading', 'NEG'], ['Heading', 'Econ DA'],
  ]);
});

test('quick switcher: on a tie a starred file beats a card tag, and a shorter label beats a longer one', () => {
  const doc = pm('doc', [card(txt('NATO resilient: Trump cannot break the alliance'), 'X 26', txt('b')), pm('block', [txt('NATO bad---long version of the block')]), pm('block', [txt('NATO bad')])]);
  const items = SW().switcherItems('nato', { favs: [{ handle: '/f/NATO.docx', filename: 'NATO.docx' }], headings: SW().headingsIn(doc), docTitle: 'D' });
  assert.deepEqual(items.map((i) => i.label), ['NATO bad', 'NATO bad---long version of the block', 'NATO', 'NATO resilient: Trump cannot break the alliance']);
});

test('quick switcher: scoring needs every word, prefers word starts, the label, and the whole phrase', () => {
  const { switcherScore } = SW();
  assert.equal(switcherScore('at offshoring', 'AT: Offshoring'), 6 + 6 + 4);
  assert.equal(switcherScore('at off', 'AT: Offshoring'), 6 + 6);
  assert.equal(switcherScore('shoring', 'AT: Offshoring'), 3);
  assert.equal(switcherScore('econ chen', 'Grid collapses', ['Chen 25']), 0);
  assert.ok(switcherScore('chen', 'Grid', ['Chen 25']) < switcherScore('chen', 'Chen grid'));
  assert.equal(switcherScore('a(b', 'x a(b'), 6 + 4, 'regex characters are literal');
});

test('quick switcher: ⌘P on a Mac, Ctrl+P elsewhere, nothing else held', () => {
  const { isSwitcherKey } = SW();
  const k = (o) => ({ key: 'p', code: 'KeyP', ...o });
  assert.equal(isSwitcherKey(k({ metaKey: true }), true), true);
  assert.equal(isSwitcherKey(k({ ctrlKey: true }), true), false);
  assert.equal(isSwitcherKey(k({ ctrlKey: true }), false), true);
  assert.equal(isSwitcherKey(k({ metaKey: true }), false), false);
  assert.equal(isSwitcherKey(k({ metaKey: true, shiftKey: true }), true), false, "⌘⇧P is the command's own binding");
  assert.equal(isSwitcherKey(k({ metaKey: true, altKey: true }), true), false, '⌘⌥P stays Insert Received Card (At End)');
  assert.equal(isSwitcherKey({ key: 'π', code: 'KeyP', metaKey: true }, true), true, 'a non-Latin layout goes by position');
  assert.equal(isSwitcherKey({ key: 'l', code: 'KeyP', metaKey: true }, true), false, "Dvorak's ⌘L is not ⌘P");
  assert.equal(isSwitcherKey({ key: 'p', code: 'KeyR', metaKey: true }, true), true, "Dvorak's ⌘P is");
  assert.equal(isSwitcherKey({ key: 'o', code: 'KeyO', metaKey: true }, true), false);
});

function switcherHarness({ search = () => ({ results: [], ...IDLE }) } = {}) {
  const h = evidenceHarness({ search, docInfo: () => ({ docId: 'd1', docTitle: 'Data' }) });
  const view = fakeView(SWITCH_DOC());
  window.__debateUploaderUI.editorView = async () => view;
  view.state.selection = { constructor: { near: ($pos) => ({ near: $pos }) } };
  h.setDoc = (doc) => { doc.resolve = (p) => ({ pos: p }); view.state.doc = doc; };
  h.setDoc(view.state.doc);
  h.sels = [];
  h.focused = 0;
  const origTr = Object.getOwnPropertyDescriptor(view.state, 'tr').get;
  Object.defineProperty(view.state, 'tr', { get() { const tr = origTr(); tr.setSelection = (sel) => { h.sels.push(sel.near.pos); return tr; }; tr.scrollIntoView = () => tr; return tr; } });
  view.focus = () => { h.focused++; };
  h.view = view;
  return h;
}

test('quick switcher command: asks Search my files, Enter on a heading puts the caret in it, on a card opens the file there', async () => {
  const h = switcherHarness({ search: (b) => ({ results: [{ ...CARD, tag: `Reshoring ${b.query}`, headings: [] }], ...IDLE }) });
  await cmd('quickSwitcher').run(h.api);
  const spec = h.searches[0];
  assert.equal(spec.title, 'Quick switcher');
  assert.equal(spec.openLabel, 'Go');
  assert.equal(spec.onCard, undefined, 'no "Open card only" button');
  const r = await spec.onQuery('econ');
  assert.deepEqual(h.calls.find((c) => c.route === '/evidence/search').body, { query: 'econ', limit: 60 });
  assert.deepEqual(r.items.map((i) => [i.kind, i.label]), [['Heading', 'Econ DA'], ['File card', 'Reshoring econ']]);
  spec.onOpen(r.items[0]);
  const econ = SW().headingsIn(h.view.state.doc).find((x) => x.text === 'Econ DA');
  assert.deepEqual(h.sels, [econ.pos + 1]);
  assert.equal(h.focused, 1, 'focus goes back to the doc');
  await spec.onOpen(r.items[1]);
  assert.deepEqual(h.calls.find((c) => c.route === '/evidence/open').body, { path: '/ev/Grid.docx', ordinal: 3 });
  const before = h.calls.length;
  const empty = await spec.onQuery('');
  assert.equal(h.calls.length, before, 'an empty box never asks the helper');
  assert.deepEqual(empty.items.map((i) => i.label), ['AFF', 'Case', 'AT: Offshoring', 'NEG', 'Econ DA']);
});

test('quick switcher command: helper down keeps the headings and says so; a heading that moved is found by its text', async () => {
  const h = switcherHarness();
  h.api.flowPost = async () => ({ ok: false, error: 'app-not-running' });
  await cmd('quickSwitcher').run(h.api);
  const spec = h.searches[0];
  const r = await spec.onQuery('grid');
  assert.deepEqual(r.items.map((i) => [i.kind, i.label]), [['Heading', 'Grid collapses']]);
  assert.match(r.status, /Search my files is off$/);
  h.setDoc(pm('doc', [pm('block', [txt('New block')]), ...SWITCH_DOC().kids]));
  spec.onOpen(r.items[0]);
  const now = SW().headingsIn(h.view.state.doc).find((x) => x.text === 'Grid collapses');
  assert.deepEqual(h.sels, [now.pos + 1]);
  h.setDoc(pm('doc', []));
  spec.onOpen(r.items[0]);
  assert.equal(h.toasts.at(-1), 'Couldn\'t find "Grid collapses" any more.');
});

test('quick switcher: ⌘P opens it and CardMirror never sees the key; not again while a plugin dialog is up', async () => {
  const h = switcherHarness();
  await cmd('quickSwitcher').run(h.api); // CardMirror has handed over the api
  const saved = globalThis.document;
  let scrim = false;
  globalThis.document = { querySelector: (sel) => (sel === '.du-scrim' && scrim ? {} : null) };
  const mac = /mac/i.test(globalThis.navigator?.platform || '');
  const press = (o = {}) => ({ key: 'p', code: 'KeyP', metaKey: mac, ctrlKey: !mac, prevented: 0, stopped: 0,
    preventDefault() { this.prevented++; }, stopPropagation() { this.stopped++; }, ...o });
  const tick = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); };
  try {
    const ev = press();
    SW().onSwitcherKey(ev);
    await tick();
    assert.equal(h.searches.length, 2);
    assert.deepEqual([ev.prevented, ev.stopped], [1, 1]);
    scrim = true;
    const again = press();
    SW().onSwitcherKey(again);
    await tick();
    assert.equal(h.searches.length, 2, 'a second ⌘P over a dialog opens nothing');
    assert.equal(again.prevented, 1, 'and still never reaches CardMirror');
    const other = press({ key: 's', code: 'KeyS' });
    SW().onSwitcherKey(other);
    assert.equal(other.prevented, 0, 'other keys pass through');
    scrim = false;
    const field = { tagName: 'INPUT', closest: () => null };
    const inField = press({ target: field });
    SW().onSwitcherKey(inField);
    const modal = press({ target: { tagName: 'DIV', closest: (sel) => (sel.includes('dialog') ? {} : null) } });
    SW().onSwitcherKey(modal);
    await tick();
    assert.deepEqual([inField.prevented, modal.prevented, h.searches.length], [0, 0, 2], "CardMirror's own fields and dialogs keep ⌘P");
    // Two quick presses before the dialog is up open one switcher.
    let release;
    window.__debateUploaderUI.editorView = () => new Promise((r) => { release = r; });
    SW().onSwitcherKey(press());
    await tick();
    SW().onSwitcherKey(press());
    release(null);
    await tick();
    assert.equal(h.searches.length, 3, 'one switcher for two quick presses');
  } finally {
    globalThis.document = saved;
  }
});

test('DOM quick switcher: one Go button; ⌘Enter goes like Enter', async () => {
  const dom = fakeDom();
  const saved = { document: globalThis.document, Option: globalThis.Option, ui: window.__debateUploaderUI };
  globalThis.document = dom.doc; globalThis.Option = dom.Option;
  dom.doc.querySelector = () => null; // no home screen
  dom.doc.querySelectorAll = () => []; // and no editor: only Search my files rows
  const h = switcherHarness({ search: (b) => ({ results: b.query ? [CARD, { ...CARD, ordinal: 4, tag: `Second ${b.query}` }] : [], ...IDLE }) });
  delete window.__debateUploaderUI;
  try {
    const running = cmd('quickSwitcher').run(h.api);
    for (let i = 0; i < 300 && !dom.byField('query'); i++) await new Promise((r) => setTimeout(r, 20));
    const input = dom.byField('query');
    const rows = () => dom.byField('list').children.filter((n) => n.className.startsWith('du-row'));
    const settle = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 20)); };
    assert.ok(dom.button('Go'), 'Go button');
    assert.equal(dom.button('Open card only'), undefined);
    input.value = 'grid'; input.dispatch('input');
    await settle();
    assert.equal(rows().length, 2);
    assert.match(dom.all(rows()[0]).map((n) => n.textContent).join('|'), /Second grid\|.*File card\|Grid\.docx/, 'the tag match outranks a file-name match');
    input.dispatch('keydown', { key: 'ArrowDown' });
    input.dispatch('keydown', { key: 'ArrowUp' });
    input.dispatch('keydown', { key: 'Enter', metaKey: true });
    await settle();
    assert.deepEqual(h.calls.find((c) => c.route === '/evidence/open').body, { path: '/ev/Grid.docx', ordinal: 4 });
    assert.equal(h.calls.find((c) => c.route === '/evidence/card'), undefined);
    await running;
    assert.equal(dom.doc.body.children.length, 0, 'dialog closed');
  } finally {
    globalThis.document = saved.document; globalThis.Option = saved.Option; window.__debateUploaderUI = saved.ui;
  }
});
