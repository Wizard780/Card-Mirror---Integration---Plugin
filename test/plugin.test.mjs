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

test('registers seven commands and one setting under the plugin id', () => {
  assert.equal(def.id, 'debate-uploader');
  assert.equal(def.apiVersion, 1);
  assert.deepEqual(def.commands.map((c) => c.id).sort(), ['debate-uploader.sdBrowse', 'debate-uploader.sdNewest', 'debate-uploader.sdPick', 'debate-uploader.setFolder',
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


// Browse harness: /speechdrop/list answers with the next entry of `lists`
// (an array of files, or an Error for a failed refresh); /speechdrop/open
// answers from `opens` by name. `script(view, n)` runs after the list is
// shown (n = 0) and after each refresh (n = 1, 2, ...); it can pick and close.
function browseHarness({ lists, opens = {}, script, room = 'abc12' }) {
  const h = harness({ room });
  const jobs = new Map();
  let listN = 0;
  h.api.flowPost = async (app, route, body) => {
    h.calls.push({ app, route, body });
    if (route === '/speechdrop/list') {
      const id = `L${listN}`;
      jobs.set(id, lists[Math.min(listN, lists.length - 1)]);
      listN++;
      return ok({ ok: true, job: id });
    }
    if (route === '/speechdrop/open') { jobs.set(`O:${body.name}`, opens[body.name]); return ok({ ok: true, job: `O:${body.name}` }); }
    const r = jobs.get(body.id);
    return ok(r instanceof Error ? { state: 'error', message: r.message } : { state: 'done', result: r });
  };
  h.views = [];
  window.__debateUploaderUI.showList = (title, items, onPick) => {
    let close;
    const closed = new Promise((r) => { close = r; });
    const view = { title, renders: [{ items, status: '' }], onPick, close,
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

test('browse: shows the room newest first and opens picks', async () => {
  const h = browseHarness({
    lists: [[B, A]],
    opens: { '1NC.docx': { name: '1NC.docx', path: '/p', app: 'CardMirror' }, 'cards.pdf': { name: 'cards.pdf', path: '/p2', app: 'default' } },
    script: async (view, n) => { if (n === 0) { await view.pick('1NC.docx'); await view.pick('cards.pdf'); view.close(); } },
  });
  await cmd('sdBrowse').run(h.api);
  assert.equal(h.views[0].title, 'SpeechDrop room abc12');
  assert.deepEqual(labels(h.views[0].renders[0]), ['1NC.docx', 'cards.pdf']);
  assert.ok(h.views[0].renders[0].items.every((i) => typeof i.detail === 'string' && i.detail.length > 0));
  assert.deepEqual(h.calls.filter((c) => c.route === '/speechdrop/open').map((c) => c.body), [
    { room: 'abc12', index: 2, name: '1NC.docx' }, { room: 'abc12', index: 0, name: 'cards.pdf' },
  ]);
  assert.deepEqual(h.toasts.filter((t) => t.startsWith('Opened')), ['Opened "1NC.docx" in CardMirror', 'Opened "cards.pdf" in your default app']);
  assert.equal(h.store.get('lastRoom'), 'abc12');
});

test('browse refresh: a new upload appears on top marked new; polling stops when closed', async () => {
  const h = browseHarness({ lists: [[B, A], [C, B, A]], script: (view, n) => { if (n === 2) view.close(); } });
  await cmd('sdBrowse').run(h.api);
  const r = h.views[0].renders;
  assert.deepEqual(labels(r[1]), ['2NR.docx*', '1NC.docx', 'cards.pdf']);
  assert.equal(r[1].status, '');
  const listCalls = h.calls.filter((c) => c.route === '/speechdrop/list').length;
  assert.equal(listCalls, 3, 'initial + 2 refreshes, then stop');
  await new Promise((res) => setTimeout(res, 20));
  assert.equal(h.calls.filter((c) => c.route === '/speechdrop/list').length, listCalls, 'no refresh after close');
});

test('browse refresh: picking after rows shift opens the right file', async () => {
  const h = browseHarness({ lists: [[B, A], [C, B, A]],
    opens: { '1NC.docx': { name: '1NC.docx', path: '/p', app: 'CardMirror' } },
    script: async (view, n) => { if (n === 1) { await view.pick('1NC.docx'); view.close(); } } });
  await cmd('sdBrowse').run(h.api);
  assert.deepEqual(h.calls.filter((c) => c.route === '/speechdrop/open').map((c) => c.body), [{ room: 'abc12', index: 2, name: '1NC.docx' }]);
});

test('browse: an empty room still opens the list and fills in on refresh', async () => {
  const h = browseHarness({ lists: [[], [A]], script: (view, n) => { if (n === 1) view.close(); } });
  await cmd('sdBrowse').run(h.api);
  assert.deepEqual(h.views[0].renders[0].items, []);
  assert.deepEqual(labels(h.views[0].renders[1]), ['cards.pdf*']);
  assert.equal(h.toasts.length, 0);
});

test('browse refresh: a failed refresh keeps the rows and shows a status; the next success clears it', async () => {
  const h = browseHarness({ lists: [[A], new Error('unreachable'), [B, A]], script: (view, n) => { if (n === 2) view.close(); } });
  await cmd('sdBrowse').run(h.api);
  const r = h.views[0].renders;
  assert.deepEqual(labels(r[1]), ['cards.pdf']);
  assert.match(r[1].status, /Couldn't refresh, retrying/);
  assert.deepEqual(labels(r[2]), ['1NC.docx*', 'cards.pdf']);
  assert.equal(r[2].status, '');
  assert.equal(h.toasts.length, 0, 'no toast per failed refresh');
});

test('browse: wrong room toasts without a list; cancel does nothing; open errors toast', async () => {
  const wrong = browseHarness({ lists: [new Error('no_room')], script: () => {} });
  await cmd('sdBrowse').run(wrong.api);
  assert.equal(wrong.toasts.at(-1), 'No SpeechDrop room "abc12". Check the code.');
  assert.equal(wrong.views.length, 0);

  const cancel = browseHarness({ room: null, lists: [[A]], script: () => {} });
  await cmd('sdBrowse').run(cancel.api);
  assert.deepEqual([cancel.calls.length, cancel.toasts.length, cancel.views.length], [0, 0, 0]);

  for (const [err, text] of [['removed', '"1NC.docx" was removed from the room.'], ['download_failed', 'Couldn\'t download "1NC.docx".']]) {
    const h = browseHarness({ lists: [[B]], opens: { '1NC.docx': new Error(err) },
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
