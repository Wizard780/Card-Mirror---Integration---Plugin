// Sending one email with an attachment over SMTP (Gmail: smtp.gmail.com:465, TLS,
// AUTH PLAIN with an app password). No dependencies; never retried automatically.
import net from 'node:net';
import tls from 'node:tls';
import { randomUUID } from 'node:crypto';

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const wrap = (b64) => b64.replace(/.{1,76}/g, '$&\r\n');
const header = (s) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`);
const asciiName = (s) => s.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');

export const newMessageId = (domain = 'debate-uploader.local') => `<${randomUUID()}@${domain}>`;

export function buildMessage({ from, to, subject, text, attachments = [], messageId = newMessageId(), inReplyTo, references, date = new Date() }) {
  const boundary = `du-${randomUUID()}`;
  const lines = [
    `From: ${from}`,
    `To: ${to.join(', ')}`,
    `Subject: ${header(subject)}`,
    `Date: ${date.toUTCString().replace('GMT', '+0000')}`,
    `Message-ID: ${messageId}`,
    ...(inReplyTo ? [`In-Reply-To: ${inReplyTo}`] : []),
    ...(references && references.length ? [`References: ${references.join(' ')}`] : []),
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    wrap(Buffer.from(text || '', 'utf8').toString('base64')),
  ];
  for (const a of attachments) {
    lines.push(
      `--${boundary}`,
      `Content-Type: ${a.type || DOCX}; name="${asciiName(a.name)}"`,
      `Content-Disposition: attachment; filename="${asciiName(a.name)}"; filename*=UTF-8''${encodeURIComponent(a.name)}`,
      'Content-Transfer-Encoding: base64',
      '',
      wrap(Buffer.from(a.bytes).toString('base64')),
    );
  }
  lines.push(`--${boundary}--`, '');
  return lines.join('\r\n');
}

// A tiny SMTP conversation. secure:false is for tests against a local fake server.
function session({ host, port, secure = true, timeoutMs = 30_000 }) {
  return new Promise((resolve, reject) => {
    const sock = secure ? tls.connect({ host, port, servername: host }) : net.connect({ host, port });
    let buf = '';
    let waiting = null;
    const fail = (err) => { if (waiting) { const w = waiting; waiting = null; w.reject(err); } };
    sock.setTimeout(timeoutMs, () => { sock.destroy(); fail(new Error('smtp_timeout')); });
    sock.on('error', (e) => { fail(new Error('smtp_unreachable')); reject(Object.assign(new Error('smtp_unreachable'), { cause: e })); });
    sock.on('close', () => fail(new Error('smtp_closed')));
    sock.on('data', (d) => {
      buf += d.toString('utf8');
      // A reply ends with a line "NNN text" (no dash after the code).
      const m = /(?:^|\r\n)(\d{3}) [^\r\n]*\r\n$/.exec(buf);
      if (m && waiting) { const w = waiting; waiting = null; const text = buf; buf = ''; w.resolve({ code: Number(m[1]), text }); }
    });
    const reply = () => new Promise((res, rej) => { waiting = { resolve: res, reject: rej }; });
    const send = async (line) => { const r = reply(); sock.write(`${line}\r\n`); return r; };
    reply().then((greet) => resolve({ greet, send, reply, sock, close: () => sock.end() }), reject);
  });
}

const expect = (r, ok, code) => { if (!ok.includes(r.code)) throw new Error(code || `smtp_rejected:${r.code} ${r.text.trim().split('\r\n').pop().slice(4, 120)}`); return r; };

async function login(opts) {
  const s = await session(opts);
  try {
    expect(s.greet, [220]);
    expect(await s.send('EHLO debate-uploader.local'), [250]);
    const auth = Buffer.from(`\0${opts.user}\0${opts.pass}`, 'utf8').toString('base64');
    expect(await s.send(`AUTH PLAIN ${auth}`), [235], 'bad_login');
    return s;
  } catch (err) {
    s.close();
    throw err;
  }
}

export async function verifyLogin(opts) {
  const s = await login(opts);
  try { await s.send('QUIT'); } catch { /* fine */ }
  s.close();
}

// Throws send_unknown when the connection breaks after the message went out,
// so the caller tells the user to check Sent rather than resending.
export async function sendMail(opts, { from, to, raw }) {
  const s = await login(opts);
  let dataSent = false;
  try {
    expect(await s.send(`MAIL FROM:<${from}>`), [250]);
    for (const r of to) expect(await s.send(`RCPT TO:<${r}>`), [250, 251]);
    expect(await s.send('DATA'), [354]);
    const body = raw.replace(/\r?\n/g, '\r\n').replace(/^\./gm, '..');
    const done = s.reply();
    dataSent = true;
    s.sock.write(`${body}${body.endsWith('\r\n') ? '' : '\r\n'}.\r\n`);
    expect(await done, [250]);
    try { await s.send('QUIT'); } catch { /* already sent */ }
  } catch (err) {
    if (dataSent && !/^smtp_rejected/.test(err.message)) throw new Error('send_unknown');
    throw err;
  } finally {
    s.close();
  }
}

export const isEmail = (s) => /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[A-Za-z]{2,}$/.test(String(s).trim());
