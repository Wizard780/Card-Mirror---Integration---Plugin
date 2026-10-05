import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { buildMessage, verifyLogin, sendMail, isEmail } from '../lib/smtp.mjs';

// A fake SMTP server: password "right" works; records the conversation and the message.
async function fakeSmtp({ rejectRcpt = false, dropAfterData = false } = {}) {
  const log = { lines: [], data: '' };
  const srv = net.createServer((c) => {
    let inData = false;
    let buf = '';
    c.write('220 fake ESMTP\r\n');
    c.on('data', (d) => {
      buf += d.toString();
      if (inData) {
        const end = buf.indexOf('\r\n.\r\n');
        if (end === -1) return;
        log.data = buf.slice(0, end + 2);
        buf = buf.slice(end + 5);
        inData = false;
        if (dropAfterData) return c.destroy();
        c.write('250 2.0.0 OK queued\r\n');
      }
      let i;
      while (!inData && (i = buf.indexOf('\r\n')) !== -1) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        log.lines.push(line);
        if (line.startsWith('EHLO')) c.write('250-fake\r\n250 AUTH PLAIN\r\n');
        else if (line.startsWith('AUTH PLAIN')) {
          const [, user, pass] = Buffer.from(line.slice(11), 'base64').toString().split('\0');
          c.write(user === 'me@gmail.com' && pass === 'right' ? '235 ok\r\n' : '535 5.7.8 bad credentials\r\n');
        } else if (line.startsWith('MAIL FROM')) c.write('250 ok\r\n');
        else if (line.startsWith('RCPT TO')) c.write(rejectRcpt ? '550 5.1.1 no such user\r\n' : '250 ok\r\n');
        else if (line === 'DATA') { c.write('354 go\r\n'); inData = true; }
        else if (line === 'QUIT') { c.write('221 bye\r\n'); c.end(); }
        else c.write('502 no\r\n');
      }
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { log, opts: { host: '127.0.0.1', port: srv.address().port, secure: false }, close: () => srv.close() };
}

test('buildMessage: headers, threading, UTF-8 subject, text and a base64 .docx attachment wrapped at 76', () => {
  const raw = buildMessage({ from: 'me@gmail.com', to: ['a@x.org', 'b@y.org'], subject: 'Glenbrooks R3 — Univ AS vs Lex AB', text: 'Speech doc attached.', attachments: [{ name: '1AC Grid ✓.docx', bytes: Buffer.alloc(200, 7) }], messageId: '<m2@x>', inReplyTo: '<m1@x>', references: ['<m1@x>'], date: new Date('2026-10-05T12:00:00Z') });
  assert.match(raw, /^From: me@gmail\.com\r\nTo: a@x\.org, b@y\.org\r\nSubject: =\?UTF-8\?B\?/);
  assert.match(raw, /\r\nMessage-ID: <m2@x>\r\nIn-Reply-To: <m1@x>\r\nReferences: <m1@x>\r\n/);
  assert.match(raw, /Content-Disposition: attachment; filename="1AC Grid _\.docx"; filename\*=UTF-8''1AC%20Grid%20%E2%9C%93\.docx/);
  assert.match(raw, /Content-Type: application\/vnd\.openxmlformats-officedocument\.wordprocessingml\.document/);
  const b64 = raw.split('Content-Transfer-Encoding: base64\r\n\r\n')[2].split('\r\n--')[0];
  assert.ok(b64.split('\r\n').every((l) => l.length <= 76));
  assert.deepEqual(Buffer.from(b64.replace(/\r\n/g, ''), 'base64'), Buffer.alloc(200, 7));
});

test('verifyLogin: right app password passes; wrong one is bad_login; nothing unreachable hangs', async () => {
  const f = await fakeSmtp();
  try {
    await verifyLogin({ ...f.opts, user: 'me@gmail.com', pass: 'right' });
    await assert.rejects(verifyLogin({ ...f.opts, user: 'me@gmail.com', pass: 'wrong' }), /bad_login/);
    assert.ok(!f.log.lines.some((l) => l.includes('right')), 'the password is only ever sent base64 in AUTH');
  } finally { f.close(); }
  await assert.rejects(verifyLogin({ host: '127.0.0.1', port: 1, secure: false, user: 'a', pass: 'b' }), /smtp_unreachable/);
});

test('sendMail: one envelope per recipient, dot-stuffed body; rejected recipient and a drop after DATA are distinct errors', async () => {
  const f = await fakeSmtp();
  try {
    const raw = buildMessage({ from: 'me@gmail.com', to: ['a@x.org', 'b@y.org'], subject: 'S', text: 'line\n.starts with a dot' });
    await sendMail({ ...f.opts, user: 'me@gmail.com', pass: 'right' }, { from: 'me@gmail.com', to: ['a@x.org', 'b@y.org'], raw });
    assert.deepEqual(f.log.lines.filter((l) => /^(MAIL|RCPT)/.test(l)), ['MAIL FROM:<me@gmail.com>', 'RCPT TO:<a@x.org>', 'RCPT TO:<b@y.org>']);
    assert.match(f.log.data, /^From: me@gmail\.com/);
  } finally { f.close(); }
  const bad = await fakeSmtp({ rejectRcpt: true });
  try {
    await assert.rejects(sendMail({ ...bad.opts, user: 'me@gmail.com', pass: 'right' }, { from: 'me@gmail.com', to: ['nope@x.org'], raw: 'x' }), /smtp_rejected:550/);
  } finally { bad.close(); }
  const drop = await fakeSmtp({ dropAfterData: true });
  try {
    await assert.rejects(sendMail({ ...drop.opts, user: 'me@gmail.com', pass: 'right' }, { from: 'me@gmail.com', to: ['a@x.org'], raw: 'x' }), /send_unknown/);
  } finally { drop.close(); }
});

test('isEmail', () => {
  assert.ok(isEmail('judge@school.edu'));
  for (const bad of ['', 'a@b', 'a b@c.org', 'a@b.c', '<a@b.org>']) assert.equal(isEmail(bad), false, bad);
});
