// Reading recent email HEADERS over IMAP (Gmail: imap.gmail.com:993) so the email
// chain can reply-all. Read-only (EXAMINE, BODY.PEEK): nothing is marked read or changed,
// and message bodies are never fetched.
import net from 'node:net';
import tls from 'node:tls';

const quote = (s) => `"${String(s).replace(/(["\\])/g, '\\$1')}"`;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const imapDate = (d) => `${d.getUTCDate()}-${MONTHS[d.getUTCMonth()]}-${d.getUTCFullYear()}`;

function connect({ host, port, secure = true, timeoutMs = 20_000 }) {
  return new Promise((resolve, reject) => {
    const sock = secure ? tls.connect({ host, port, servername: host }) : net.connect({ host, port });
    let buf = Buffer.alloc(0);
    let pending = null; // { tag, resolve, reject } or { greeting }
    let n = 0;
    const settle = (fn, v) => { const p = pending; pending = null; if (p) p[fn](v); };
    sock.setTimeout(timeoutMs, () => { sock.destroy(); settle('reject', new Error('imap_timeout')); });
    sock.on('error', () => { settle('reject', new Error('imap_unreachable')); reject(new Error('imap_unreachable')); });
    sock.on('close', () => settle('reject', new Error('imap_closed')));
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      if (!pending) return;
      const text = buf.toString('latin1');
      if (pending.greeting) {
        if (/\r\n/.test(text)) { const out = buf; buf = Buffer.alloc(0); settle('resolve', out); }
        return;
      }
      const m = new RegExp(`(?:^|\\r\\n)${pending.tag} (OK|NO|BAD)[^\\r\\n]*\\r\\n$`).exec(text);
      if (m) {
        const out = buf;
        buf = Buffer.alloc(0);
        if (m[1] === 'OK') settle('resolve', out); else settle('reject', Object.assign(new Error('imap_rejected'), { reply: text.slice(-200) }));
      }
    });
    const cmd = (line) => new Promise((res, rej) => {
      const tag = `A${++n}`;
      pending = { tag, resolve: res, reject: rej };
      sock.write(`${tag} ${line}\r\n`);
    });
    pending = { greeting: true, resolve: () => resolve({ cmd, close: () => sock.end() }), reject };
  });
}

// "=?UTF-8?B?…?=" / "=?utf-8?Q?…?=" words in headers.
export function decodeWords(s) {
  // Whitespace is dropped only BETWEEN two encoded words (RFC 2047), never after the last one.
  return String(s ?? '').replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=(?:\s+(?==\?))?/g, (_, cs, enc, data) => {
    const bytes = enc.toUpperCase() === 'B'
      ? Buffer.from(data, 'base64')
      : Buffer.from(data.replace(/_/g, ' ').replace(/=([0-9A-F]{2})/gi, (x, h) => String.fromCharCode(parseInt(h, 16))), 'latin1');
    try { return new TextDecoder(cs).decode(bytes); } catch { return bytes.toString('utf8'); }
  });
}

const ADDR = /[^\s<>(),;:"]+@[^\s<>(),;:"]+\.[A-Za-z]{2,}/g;
// Real mailboxes only: what's inside <…>, plus bare addresses. An address-looking display
// name ("john@gmail.com" <john@school.org>) is ignored.
export function addresses(s) {
  const out = [];
  // Each comma-separated mailbox: its <address> if it has one, else the bare address.
  for (const entry of String(s ?? '').replace(/"(?:[^"\\]|\\.)*"/g, ' ').split(',')) {
    const inside = /<([^<>]*)>/.exec(entry);
    for (const a of (inside ? inside[1] : entry.replace(/\([^()]*\)/g, ' ')).match(ADDR) || []) out.push(a.toLowerCase());
  }
  return [...new Set(out)];
}
const displayName = (s) => decodeWords(String(s ?? '').replace(/<[^>]*>/, '').replace(/"/g, '').trim()) || addresses(s)[0] || '';

export function parseHeaders(block) {
  const unfolded = String(block).replace(/\r?\n[ \t]+/g, ' ');
  const h = {};
  for (const line of unfolded.split(/\r?\n/)) {
    const m = /^([A-Za-z-]+):\s*(.*)$/.exec(line);
    if (m) h[m[1].toLowerCase()] = m[2];
  }
  return {
    messageId: (h['message-id'] || '').trim(),
    subject: decodeWords(h.subject || '').trim(),
    from: addresses(h.from)[0] || '',
    fromName: displayName(h.from),
    to: addresses(h.to),
    cc: addresses(h.cc),
    date: Date.parse(h.date || '') || null,
    references: (h.references || '').match(/<[^>]+>/g) || [],
  };
}

// The newest messages from the last `days` days in All Mail (falls back to INBOX).
export async function recentMessages({ user, pass, days = 3, limit = 40, now = new Date(), ...conn }) {
  const s = await connect(conn);
  try {
    try { await s.cmd(`LOGIN ${quote(user)} ${quote(pass)}`); } catch { throw new Error('bad_login'); }
    const list = (await s.cmd('LIST "" "*"')).toString('utf8');
    const all = /\\All\b[^\r\n]*?"[^"]*" ("(?:[^"\\]|\\.)*"|\S+)\r\n/.exec(list);
    const box = all ? all[1] : '"INBOX"';
    await s.cmd(`EXAMINE ${box}`);
    const since = new Date(now.getTime() - days * 86_400_000);
    const found = /\* SEARCH([\d ]*)/.exec((await s.cmd(`UID SEARCH SINCE ${imapDate(since)}`)).toString('latin1'));
    const uids = (found ? found[1].trim().split(/\s+/).filter(Boolean) : []).slice(-limit);
    if (!uids.length) return [];
    const raw = await s.cmd(`UID FETCH ${uids.join(',')} (UID BODY.PEEK[HEADER.FIELDS (FROM TO CC SUBJECT DATE MESSAGE-ID REFERENCES)])`);
    // Each header block arrives as a literal: "{123}\r\n" followed by exactly 123 bytes.
    const out = [];
    let at = 0;
    const text = raw.toString('latin1');
    for (let m; (m = /\{(\d+)\}\r\n/g.exec(text.slice(at)));) {
      const start = at + m.index + m[0].length;
      const len = Number(m[1]);
      out.push(parseHeaders(raw.subarray(start, start + len).toString('utf8')));
      at = start + len;
    }
    try { await s.cmd('LOGOUT'); } catch { /* closing anyway */ }
    return out.filter((x) => x.messageId).sort((a, b) => (b.date || 0) - (a.date || 0));
  } finally {
    s.close();
  }
}
