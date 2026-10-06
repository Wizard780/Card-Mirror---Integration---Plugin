import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { recentMessages, parseHeaders, decodeWords, addresses } from '../lib/imap.mjs';

const H1 = 'From: "Judge Lee" <lee@school.edu>\r\nTo: opp1@x.org, me@gmail.com\r\nCc: =?UTF-8?B?w4lsaXNl?= <elise@y.org>\r\nSubject: =?UTF-8?Q?Glenbrooks_R3_=E2=80=94_chain?=\r\nDate: Sun, 05 Oct 2026 14:00:00 +0000\r\nMessage-ID: <chain-1@school.edu>\r\n\r\n';
const H2 = 'From: Opp One <opp1@x.org>\r\nTo: lee@school.edu\r\nSubject: Re: Glenbrooks R3 — chain\r\nDate: Sun, 05 Oct 2026 14:20:00 +0000\r\nMessage-ID: <chain-2@x.org>\r\nReferences: <chain-1@school.edu>\r\n\r\n';

async function fakeImap({ allMail = true } = {}) {
  const seen = [];
  const srv = net.createServer((c) => {
    c.write('* OK fake IMAP ready\r\n');
    let buf = '';
    c.on('data', (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf('\r\n')) !== -1) {
        const line = buf.slice(0, i); buf = buf.slice(i + 2);
        const [tag, cmd] = line.split(' ');
        seen.push(line.replace(/LOGIN .*/, 'LOGIN …'));
        if (cmd === 'LOGIN') c.write(line.includes('"right"') ? `${tag} OK logged in\r\n` : `${tag} NO [AUTHENTICATIONFAILED] bad\r\n`);
        else if (cmd === 'LIST') c.write(`${allMail ? '* LIST (\\HasNoChildren \\All) "/" "[Gmail]/All Mail"\r\n' : ''}* LIST (\\HasNoChildren) "/" "INBOX"\r\n${tag} OK done\r\n`);
        else if (cmd === 'EXAMINE') c.write(`* 2 EXISTS\r\n${tag} OK [READ-ONLY] examined\r\n`);
        else if (cmd === 'UID' && line.includes('SEARCH')) c.write(`* SEARCH 41 42\r\n${tag} OK done\r\n`);
        else if (cmd === 'UID' && line.includes('FETCH')) {
          const b1 = Buffer.from(H1); const b2 = Buffer.from(H2);
          c.write(Buffer.concat([Buffer.from(`* 1 FETCH (UID 41 BODY[HEADER.FIELDS (FROM TO CC SUBJECT DATE MESSAGE-ID REFERENCES)] {${b1.length}}\r\n`), b1, Buffer.from(')\r\n'),
            Buffer.from(`* 2 FETCH (UID 42 BODY[HEADER.FIELDS (FROM TO CC SUBJECT DATE MESSAGE-ID REFERENCES)] {${b2.length}}\r\n`), b2, Buffer.from(`)\r\n${tag} OK done\r\n`)]));
        } else if (cmd === 'LOGOUT') { c.write(`* BYE\r\n${tag} OK bye\r\n`); c.end(); }
        else c.write(`${tag} BAD ?\r\n`);
      }
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { seen, conn: { host: '127.0.0.1', port: srv.address().port, secure: false }, close: () => srv.close() };
}

test('headers: encoded words, addresses, references', () => {
  assert.equal(decodeWords('=?UTF-8?Q?Glenbrooks_R3_=E2=80=94_chain?='), 'Glenbrooks R3 — chain');
  assert.deepEqual(addresses('"Judge Lee" <Lee@School.edu>, opp1@x.org'), ['lee@school.edu', 'opp1@x.org']);
  const h = parseHeaders(H2);
  assert.deepEqual([h.from, h.fromName, h.to, h.references], ['opp1@x.org', 'Opp One', ['lee@school.edu'], ['<chain-1@school.edu>']]);
});

test('recentMessages: read-only look at All Mail headers, newest first; wrong password is bad_login', async () => {
  const f = await fakeImap();
  try {
    const list = await recentMessages({ ...f.conn, user: 'me@gmail.com', pass: 'right', now: new Date('2026-10-05T15:00:00Z') });
    assert.deepEqual(list.map((m) => [m.messageId, m.subject, m.from]), [['<chain-2@x.org>', 'Re: Glenbrooks R3 — chain', 'opp1@x.org'], ['<chain-1@school.edu>', 'Glenbrooks R3 — chain', 'lee@school.edu']]);
    assert.deepEqual(list[1].cc, ['elise@y.org']);
    assert.ok(f.seen.includes('A3 EXAMINE "[Gmail]/All Mail"'), 'EXAMINE (read-only), not SELECT');
    assert.ok(f.seen.some((l) => l === 'A4 UID SEARCH SINCE 2-Oct-2026'));
    assert.ok(f.seen.some((l) => l.includes('BODY.PEEK[HEADER.FIELDS')), 'headers only, never marks read');
    await assert.rejects(recentMessages({ ...f.conn, user: 'me@gmail.com', pass: 'wrong' }), /bad_login/);
  } finally { f.close(); }
  const inbox = await fakeImap({ allMail: false });
  try {
    await recentMessages({ ...inbox.conn, user: 'me@gmail.com', pass: 'right' });
    assert.ok(inbox.seen.includes('A3 EXAMINE "INBOX"'));
  } finally { inbox.close(); }
});

test('decodeWords keeps the space after an encoded word; addresses ignore address-looking display names', () => {
  assert.equal(decodeWords('=?UTF-8?Q?Caf=C3=A9?= round'), 'Café round');
  assert.equal(decodeWords('=?UTF-8?Q?a?= =?UTF-8?Q?b?= c'), 'ab c');
  assert.deepEqual(addresses('"john@gmail.com" <john@school.org>, jim@gmail.com <jim@s.org>, bob@y.org (Bob), "Doe, J" <jd@z.org>'), ['john@school.org', 'jim@s.org', 'bob@y.org', 'jd@z.org']);
  assert.equal(parseHeaders('From: "john@gmail.com" <John@School.org>\r\nMessage-ID: <x@y>\r\n').from, 'john@school.org');
});
