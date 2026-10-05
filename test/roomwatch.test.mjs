import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRoomWatcher } from '../lib/roomwatch.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const entries = (...names) => names.map((name, i) => (name ? { name, ctime: i } : null));

// Fake SpeechDrop socket: opens on the next tick; tests push index frames.
function fakeSockets({ failOpen = false } = {}) {
  const all = [];
  class FakeWS {
    constructor(url) {
      this.url = url; this.sent = []; this.closed = false; all.push(this);
      setTimeout(() => (failOpen ? (this.onerror?.({}), this.onclose?.({})) : this.onopen?.({})), 1);
    }
    send(d) { this.sent.push(JSON.parse(d)); }
    close() { if (this.closed) return; this.closed = true; this.onclose?.({}); }
    push(list, { blob = false } = {}) {
      const text = JSON.stringify({ type: 'rec', address: 'x', body: JSON.stringify(list) });
      this.onmessage?.({ data: blob ? new Blob([text]) : text });
    }
    deny() { this.onmessage?.({ data: JSON.stringify({ type: 'err', body: 'access_denied' }) }); }
    drop() { this.onclose?.({}); }
  }
  return { FakeWS, all, last: () => all.at(-1) };
}

function watcher(sockets, listImpl, opts = {}) {
  const calls = [];
  const w = createRoomWatcher({
    wsUrl: 'wss://sd.test/sock/websocket', WebSocketImpl: sockets.FakeWS,
    list: async (room) => { calls.push(room); return listImpl(room); },
    firstWaitMs: 40, pollMs: 80, pingMs: 20, idleMs: 120, sweepMs: 20, reconnectMs: 10, ...opts,
  });
  return { w, calls };
}

test('first watch registers for the room and returns the pushed list, newest first, live', async () => {
  const s = fakeSockets();
  const { w, calls } = watcher(s, () => { throw new Error('should not poll'); });
  const p = w.watch('abc12', 0, 200);
  await sleep(5);
  assert.equal(s.last().url, 'wss://sd.test/sock/websocket');
  assert.deepEqual(s.last().sent[0], { type: 'register', address: 'speechdrop.room.abc12' });
  s.last().push(entries('a.docx', null, 'b.pdf'));
  assert.deepEqual(await p, { version: 1, live: true, files: [{ index: 2, name: 'b.pdf', ctime: 2 }, { index: 0, name: 'a.docx', ctime: 0 }] });
  assert.equal(calls.length, 0);
  w.close();
});

test('long-poll: resolves as soon as a push lands, or unchanged after the wait', async () => {
  const s = fakeSockets();
  const { w } = watcher(s, () => []);
  const first = w.watch('abc12', 0, 200);
  await sleep(5); s.last().push(entries('a.docx'));
  assert.equal((await first).version, 1);
  const t0 = Date.now();
  const next = w.watch('abc12', 1, 500);
  setTimeout(() => s.last().push(entries('a.docx', 'b.docx'), { blob: true }), 20);
  const r = await next;
  assert.equal(r.version, 2);
  assert.ok(Date.now() - t0 < 300, 'answered on push, not at the end of the wait');
  assert.deepEqual(r.files.map((f) => f.name), ['b.docx', 'a.docx']);
  const t1 = Date.now();
  assert.equal((await w.watch('abc12', 2, 60)).version, 2);
  assert.ok(Date.now() - t1 >= 55, 'no change → waits the full window');
  w.close();
});

test('an identical push does not bump the version', async () => {
  const s = fakeSockets();
  const { w } = watcher(s, () => []);
  const first = w.watch('abc12', 0, 200);
  await sleep(5); s.last().push(entries('a.docx'));
  await first;
  s.last().push(entries('a.docx'));
  assert.equal((await w.watch('abc12', 1, 30)).version, 1);
  w.close();
});

test('pings keep the socket alive while watched', async () => {
  const s = fakeSockets();
  const { w } = watcher(s, () => []);
  w.watch('abc12', 0, 10);
  await sleep(70);
  assert.ok(s.last().sent.filter((m) => m.type === 'ping').length >= 2);
  w.close();
});

test('no socket → falls back to HTTP, at most once per pollMs, live:false', async () => {
  const s = fakeSockets({ failOpen: true });
  let n = 0;
  const { w, calls } = watcher(s, () => entries(`v${++n}.docx`).map((e, index) => ({ index, ...e })).reverse());
  const r1 = await w.watch('abc12', 0, 10);
  assert.equal(r1.live, false);
  assert.deepEqual(r1.files.map((f) => f.name), ['v1.docx']);
  await w.watch('abc12', r1.version, 10);
  assert.equal(calls.length, 1, 'within pollMs → no second HTTP call');
  await sleep(90);
  const r3 = await w.watch('abc12', r1.version, 10);
  assert.equal(calls.length, 2);
  assert.deepEqual(r3.files.map((f) => f.name), ['v2.docx']);
  w.close();
});

test('wrong room: socket denied → HTTP error is thrown and the room is dropped', async () => {
  const s = fakeSockets();
  const { w } = watcher(s, () => { throw new Error('no_room'); });
  const p = w.watch('nope1', 0, 200);
  await sleep(5); s.last().deny();
  await assert.rejects(p, /^Error: no_room$/);
  assert.equal(s.last().closed, true);
  await assert.rejects(w.watch('ab c', 0, 10), /^Error: bad_room$/);
  w.close();
});

test('a dropped socket reconnects while the room is watched', async () => {
  const s = fakeSockets();
  const { w } = watcher(s, () => []);
  const first = w.watch('abc12', 0, 200);
  await sleep(5); s.last().push(entries('a.docx'));
  await first;
  const before = s.all.length;
  s.last().drop();
  await sleep(40);
  assert.ok(s.all.length > before, 'a new socket was opened');
  assert.deepEqual(s.last().sent[0], { type: 'register', address: 'speechdrop.room.abc12' });
  w.close();
});

test('an unwatched room closes its socket after idleMs; close() closes everything', async () => {
  const s = fakeSockets();
  const { w } = watcher(s, () => []);
  const first = w.watch('abc12', 0, 200);
  await sleep(5); s.last().push(entries('a.docx'));
  await first;
  const sock = s.last();
  await sleep(200);
  assert.equal(sock.closed, true);
  const again = w.watch('abc12', 0, 200);
  await sleep(5); s.last().push(entries('a.docx'));
  await again;
  w.close();
  assert.equal(s.last().closed, true);
});
