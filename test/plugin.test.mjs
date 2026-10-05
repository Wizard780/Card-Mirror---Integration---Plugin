import { test, before } from 'node:test';
import assert from 'node:assert/strict';

let def;
before(async () => {
  globalThis.window = { __registerCardMirrorPlugin: (d) => { def = d; } };
  await import('../plugin/plugin.js');
});

const ok = (body) => ({ ok: true, status: 200, body });
const cmd = (suffix) => def.commands.find((c) => c.id === `debate-uploader.${suffix}`);

function harness({ responses = [], settings = {}, storage = {}, room = 'abc12', folderAnswer = null, email = 'me@x.com', password = 'pw-secret', file = { name: 'a.docx', size: 10, read: async () => 'QUJD' } } = {}) {
  const calls = [], toasts = [], prompts = [];
  const store = new Map(Object.entries(storage));
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
    flowPost: async (app, route, body) => { calls.push({ app, route, body }); return next(); },
    showToast: (m) => toasts.push(m),
    storage: { get: (k) => store.get(k), set: (k, v) => store.set(k, v) },
    settings: { get: (k) => settings[k] ?? '' },
  };
  return { api, calls, toasts, prompts, store };
}

test('registers nine commands and one setting under the plugin id', () => {
  assert.equal(def.id, 'debate-uploader');
  assert.equal(def.apiVersion, 1);
  assert.deepEqual(def.commands.map((c) => c.id).sort(), ['debate-uploader.caselistTeam', 'debate-uploader.caselistUpload', 'debate-uploader.sdBrowse', 'debate-uploader.sdNewest', 'debate-uploader.sdPick', 'debate-uploader.setFolder',
 'debate-uploader.tabroomLogin', 'debate-uploader.tabroomLogout', 'debate-uploader.tabroomRounds']);
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
function caselistHarness({ results = {}, direct = {}, choose = [], form = () => null, storage = {}, settings = {}, file } = {}) {
  const h = harness({ storage, settings, file });
  const jobs = new Map();
  let n = 0;
  h.api.flowPost = async (app, route, body) => {
    h.calls.push({ app, route, body });
    if (route === '/job') {
      const r = jobs.get(body.id);
      return ok(r instanceof Error ? { state: 'error', message: r.message } : { state: 'done', result: r });
    }
    if (route in direct) {
      const d = direct[route];
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
  assert.equal(spec.title, `Upload to HS PF 2026 · St. Mark's · St. Mark's AB`);
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
    constructor(tag) { this.tagName = tag.toUpperCase(); this.children = []; this.listeners = {}; this.style = {}; this.value = ''; this.textContent = ''; }
    append(...kids) { for (const k of kids) { k.parent = this; this.children.push(k); } }
    remove() { if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this); this.removed = true; }
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
  const Option = function (text, value) { const o = new El('option'); o.textContent = text; o.value = value; return o; };
  const all = (n) => [n, ...n.children.flatMap(all)];
  const byLabel = (text) => { const kids = doc.body.children[0].children[0].children; return kids[kids.findIndex((k) => k.tagName === 'LABEL' && k.textContent === text) + 1]; };
  const button = (text) => all(doc.body).find((n) => n.tagName === 'BUTTON' && n.textContent === text);
  return { doc, Option, byLabel, button, all };
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
  const { captured } = await withDom(async (dom) => dom.byLabel('File').children.map((o) => o.textContent));
  assert.match(captured[0], /^Newest send doc: Send 1AC\.docx \(.+\)$/);
  assert.equal(captured[1], 'Pick a file…');
});

test('DOM form: Enter on the Fill dropdown fills nothing and never submits; Enter in a text box submits', async () => {
  const { h } = await withDom(async (dom) => {
    const fill = dom.byLabel('Fill from Tabroom');
    fill.value = '0';
    fill.dispatch('change');
    assert.equal(dom.byLabel('Opponent').value, 'Lexington AB', 'choosing a round auto-fills');
    dom.byLabel('Opponent').value = 'Edited Opp';
    fill.dispatch('keydown', { key: 'Enter' });
    assert.equal(dom.doc.body.children.length, 1, 'Enter on a select must not submit');
    dom.byLabel('Judge').dispatch('keydown', { key: 'Enter' });
    assert.equal(dom.doc.body.children.length, 0, 'Enter in a text input submits');
  });
  const up = h.calls.find((c) => c.route === '/caselist/upload');
  assert.equal(up.body.round.opponent, 'Edited Opp', 'edits after auto-fill are kept');
  assert.equal(up.body.expectName, 'Send 1AC.docx');
});

test('DOM form: Upload with missing side shows an error and posts nothing', async () => {
  const { h } = await withDom(async (dom) => {
    dom.byLabel('Tournament').value = 'Harvard';
    dom.byLabel('Round').value = '2';
    dom.button('Upload').dispatch('click');
    assert.equal(dom.doc.body.children.length, 1);
    assert.equal(dom.all(dom.doc.body).find((n) => n.textContent === 'Tournament, side and round are required.') !== undefined, true);
    dom.button('Cancel').dispatch('click');
  });
  assert.equal(h.calls.find((c) => c.route === '/caselist/upload'), undefined);
});
