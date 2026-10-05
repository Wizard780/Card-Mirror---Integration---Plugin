import { parseIndex } from './speechdrop.mjs';

const ROOM_RE = /^[A-Za-z0-9]{1,32}$/;

// Live SpeechDrop room lists. One socket per watched room on SpeechDrop's
// Vert.x event-bus bridge, which pushes the whole index on every change.
// watch() is a long-poll: it answers as soon as the list is newer than
// `version`, or after `waitMs`. Without a socket it falls back to `list`
// (HTTP), at most once per `pollMs`.
export function createRoomWatcher({
  wsUrl,
  list,
  WebSocketImpl = globalThis.WebSocket,
  firstWaitMs = 1000,
  pollMs = 5000,
  pingMs = 5000,
  idleMs = 30_000,
  sweepMs = 5000,
  reconnectMs = 1000,
  now = Date.now,
}) {
  const rooms = new Map();

  const notify = (r) => { for (const done of [...r.waiters]) done(); };

  const waitFor = (r, ms) => new Promise((resolve) => {
    const done = () => { clearTimeout(timer); r.waiters.delete(done); resolve(); };
    const timer = setTimeout(done, ms);
    r.waiters.add(done);
  });

  function setFiles(r, files) {
    if (r.files && JSON.stringify(r.files) === JSON.stringify(files)) return;
    r.files = files;
    r.version++;
    notify(r);
  }

  function drop(r) {
    r.dropped = true;
    clearInterval(r.ping);
    clearTimeout(r.retry);
    rooms.delete(r.room);
    if (r.ws) { const ws = r.ws; r.ws = null; try { ws.close(); } catch {} }
    notify(r);
  }

  function connect(r) {
    let ws;
    try { ws = new WebSocketImpl(wsUrl); } catch { return; }
    r.ws = ws;
    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'register', address: `speechdrop.room.${r.room}` }));
      r.ping = setInterval(() => { try { ws.send(JSON.stringify({ type: 'ping' })); } catch {} }, pingMs);
    };
    ws.onmessage = async (e) => {
      let msg;
      try { msg = JSON.parse(typeof e.data === 'string' ? e.data : await e.data.text()); } catch { return; }
      if (msg.type === 'rec') {
        let entries;
        try { entries = JSON.parse(msg.body); } catch { return; }
        if (!Array.isArray(entries)) return;
        r.live = true;
        r.failures = 0;
        setFiles(r, parseIndex(entries));
      } else if (msg.type === 'err') {
        r.denied = true; // no such room: let the HTTP check report it
        try { ws.close(); } catch {}
      }
    };
    ws.onerror = ws.onclose = () => {
      if (r.ws !== ws) return; // already handled
      r.ws = null;
      r.live = false;
      clearInterval(r.ping);
      notify(r);
      if (r.dropped || r.denied) return;
      const delay = Math.min(30_000, reconnectMs * 2 ** Math.min(r.failures++, 5));
      r.retry = setTimeout(() => { if (!r.dropped) connect(r); }, delay);
    };
  }

  function get(room) {
    let r = rooms.get(room);
    if (!r) {
      r = { room, files: null, version: 0, live: false, waiters: new Set(), ws: null, failures: 0, lastPoll: 0, lastSeen: now() };
      rooms.set(room, r);
      connect(r);
    }
    return r;
  }

  const sweep = setInterval(() => {
    for (const r of rooms.values()) if (now() - r.lastSeen > idleMs) drop(r);
  }, sweepMs);
  sweep.unref?.();

  return {
    async watch(room, version = 0, waitMs = 2000) {
      if (!ROOM_RE.test(room ?? '')) throw new Error('bad_room');
      const r = get(room);
      r.lastSeen = now();
      if (r.files === null && r.ws) await waitFor(r, firstWaitMs); // give the socket a moment first
      if (!r.live && (r.files === null || now() - r.lastPoll >= pollMs)) {
        r.lastPoll = now();
        try {
          setFiles(r, await list(room));
        } catch (err) {
          if (r.files === null) { drop(r); throw err; }
        }
      }
      if (r.version <= version) await waitFor(r, waitMs);
      r.lastSeen = now();
      return { version: r.version, files: r.files ?? [], live: r.live };
    },
    close() {
      clearInterval(sweep);
      for (const r of [...rooms.values()]) drop(r);
    },
  };
}
