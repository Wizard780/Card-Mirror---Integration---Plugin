// Fetching URLs that come from other people's documents. Only http(s) to public
// addresses: every hop (redirects included) is resolved and checked, and the
// connection is pinned to the address that was checked. Size and time capped.
import http from 'node:http';
import tls from 'node:tls';
import https from 'node:https';
import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { gunzipSync, inflateSync, brotliDecompressSync } from 'node:zlib';
import { execFile } from 'node:child_process';
import { writeFile, rm, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { htmlToText, pageYear, decodeEntities } from './cardcheck.mjs';

// Node's bundled CAs plus the Mac's own store (some .gov/.mil chains need it).
let caList;
const cas = () => {
  if (caList === undefined) {
    try { caList = [...new Set([...tls.getCACertificates('default'), ...tls.getCACertificates('system')])]; } catch { caList = null; }
  }
  return caList || undefined;
};
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';

export function isPublicAddress(ip) {
  const v = isIP(ip);
  if (v === 4) {
    const [a, b] = ip.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || (a === 198 && (b === 18 || b === 19))
      || /^192\.0\.[02]\./.test(ip)); // 192.0.0/24 and 192.0.2/24 only; the rest of 192.0/16 is public
  }
  if (v === 6) {
    const w = v6Words(ip);
    if (!w) return false;
    const v4 = (hi, lo) => `${w[hi] >> 8}.${w[hi] & 255}.${w[lo] >> 8}.${w[lo] & 255}`;
    const zero = (n) => w.slice(0, n).every((x) => x === 0);
    // IPv4 hidden inside IPv6 ("::ffff:7f00:1", "::127.0.0.1", NAT64, 6to4) is judged as that IPv4.
    if (zero(5) && (w[5] === 0xffff || w[5] === 0)) return isPublicAddress(v4(6, 7));
    if (w[0] === 0x64 && w[1] === 0xff9b && w.slice(2, 6).every((x) => x === 0)) return isPublicAddress(v4(6, 7));
    if (w[0] === 0x2002) return isPublicAddress(v4(1, 2));
    return !((w[0] & 0xfe00) === 0xfc00 // unique local fc00::/7
      || (w[0] & 0xff80) === 0xfe80 // link-local fe80::/10 and site-local fec0::/10
      || (w[0] & 0xff00) === 0xff00 // multicast
      || (w[0] === 0x64 && w[1] === 0xff9b) // local-use NAT64 64:ff9b:1::/48
      || (w[0] === 0x2001 && (w[1] === 0 || w[1] === 0xdb8)) // Teredo, documentation
      || (w[0] === 0x100 && w.slice(1, 4).every((x) => x === 0))); // discard 100::/64
  }
  return false;
}

// "::ffff:7f00:1" → eight 16-bit words (a dotted IPv4 tail counts as two). null if malformed.
function v6Words(ip) {
  let s = String(ip).toLowerCase().replace(/%.*$/, '');
  const tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (tail) {
    const b = tail[1].split('.').map(Number);
    if (b.some((x) => x > 255)) return null;
    s = `${s.slice(0, tail.index)}${((b[0] << 8) | b[1]).toString(16)}:${((b[2] << 8) | b[3]).toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const part = (x) => (x ? x.split(':') : []);
  const head = part(halves[0]);
  const rest = halves.length === 2 ? part(halves[1]) : [];
  const fill = halves.length === 2 ? 8 - head.length - rest.length : 0;
  if (fill < 0 || (halves.length === 1 && head.length !== 8)) return null;
  const words = [...head, ...Array(fill).fill('0'), ...rest].map((x) => parseInt(x, 16));
  return words.length === 8 && words.every((x) => x >= 0 && x <= 0xffff) ? words : null;
}

async function publicAddress(host, resolve) {
  const literal = host.replace(/^\[|\]$/g, '');
  const addrs = isIP(literal) ? [{ address: literal, family: isIP(literal) }] : await resolve(literal);
  if (!addrs.length || !addrs.every((a) => isPublicAddress(a.address))) throw new Error('blocked_address');
  return addrs[0];
}

export async function safeFetch(url, { timeoutMs = 15_000, maxBytes = 8 * 1024 * 1024, maxRedirects = 5, resolve = (h) => dnsLookup(h, { all: true }), allowPrivate = false } = {}) {
  let current = url;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    let u;
    try { u = new URL(current); } catch { throw new Error('bad_url'); }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('bad_url');
    const addr = allowPrivate ? null : await publicAddress(u.hostname, resolve);
    const res = await new Promise((ok, fail) => {
      const req = (u.protocol === 'https:' ? https : http).request(u, {
        method: 'GET',
        headers: { 'User-Agent': UA, Accept: 'text/html,application/pdf,*/*;q=0.8', 'Accept-Encoding': 'gzip, deflate, br', 'Accept-Language': 'en' },
        // Pin to the checked address so DNS can't change between check and connect.
        lookup: addr ? (_h, opts, cb) => (opts && opts.all ? cb(null, [{ address: addr.address, family: addr.family }]) : cb(null, addr.address, addr.family)) : undefined,
        timeout: timeoutMs,
        ca: u.protocol === 'https:' ? cas() : undefined,
      }, (r) => {
        if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location) { r.resume(); return ok({ redirect: new URL(r.headers.location, u).href }); }
        const chunks = [];
        let size = 0;
        r.on('data', (c) => { size += c.length; if (size > maxBytes) { req.destroy(new Error('too_large')); return; } chunks.push(c); });
        r.on('end', () => ok({ status: r.statusCode, headers: r.headers, raw: Buffer.concat(chunks) }));
        r.on('error', fail);
      });
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.on('error', fail);
      req.end();
    });
    if (res.redirect) { current = res.redirect; continue; }
    let body = res.raw;
    const enc = String(res.headers['content-encoding'] || '').toLowerCase();
    // Capped like the download itself: 8 MB of gzip must not inflate to gigabytes.
    const cap = { maxOutputLength: maxBytes * 4 };
    try {
      if (enc === 'gzip') body = gunzipSync(body, cap);
      else if (enc === 'deflate') body = inflateSync(body, cap);
      else if (enc === 'br') body = brotliDecompressSync(body, cap);
    } catch (err) {
      if (err && err.code === 'ERR_BUFFER_TOO_LARGE') throw new Error('too_large');
      /* otherwise leave as-is */
    }
    return { status: res.status, type: String(res.headers['content-type'] || ''), body, url: current };
  }
  throw new Error('too_many_redirects');
}

// ---------------------------------------------------------------- PDFs
const run = promisify(execFile);
const PYTHONS = [process.env.DEBATE_UPLOADER_PYTHON, '/opt/homebrew/Caskroom/miniconda/base/bin/python3', '/opt/homebrew/bin/python3', '/usr/local/bin/python3', '/usr/bin/python3'].filter(Boolean);
const PDFTOTEXT = ['/opt/homebrew/bin/pdftotext', '/usr/local/bin/pdftotext'];
let reader; // found once: { kind, bin } or null

async function pdfReader() {
  if (reader !== undefined) return reader;
  for (const bin of PYTHONS) {
    try { await run(bin, ['-c', 'import fitz'], { timeout: 10_000 }); return (reader = { kind: 'fitz', bin }); } catch { /* next */ }
  }
  for (const bin of PDFTOTEXT) {
    try { await run(bin, ['-v'], { timeout: 5_000 }); return (reader = { kind: 'pdftotext', bin }); } catch (e) { if (e && e.code !== 'ENOENT' && e.stderr) return (reader = { kind: 'pdftotext', bin }); }
  }
  return (reader = null);
}

export async function pdfText(bytes) {
  const r = await pdfReader();
  if (!r) throw new Error('no_pdf_reader');
  const dir = await mkdtemp(join(tmpdir(), 'cardcheck-'));
  const file = join(dir, 'source.pdf');
  try {
    await writeFile(file, bytes);
    const { stdout } = r.kind === 'fitz'
      ? await run(r.bin, ['-c', 'import fitz,sys\nd=fitz.open(sys.argv[1])\nsys.stdout.write("\\n".join(p.get_text() for p in d))', file], { timeout: 60_000, maxBuffer: 64 * 1024 * 1024 })
      : await run(r.bin, ['-enc', 'UTF-8', file, '-'], { timeout: 60_000, maxBuffer: 64 * 1024 * 1024 });
    return stdout;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------- source
async function readResponse(res) {
  const isPdf = /pdf/i.test(res.type) || res.body.subarray(0, 5).toString() === '%PDF-';
  if (isPdf) {
    const text = await pdfText(res.body);
    return { text, textLower: text.toLowerCase(), year: null, pdf: true };
  }
  const html = res.body.toString('utf8');
  // textLower is for "is the author named": the whole page incl. meta/JSON-LD bylines, entities decoded
  // ("O&#8217;Brien" matches the cite's "O’Brien").
  return { text: htmlToText(html), textLower: decodeEntities(html).toLowerCase(), year: pageYear(html), pdf: false };
}

let archiveChain = Promise.resolve();
function archiveQueue(fn) {
  const next = archiveChain.then(fn, fn);
  archiveChain = next.then(() => new Promise((r) => setTimeout(r, 800)), () => {});
  return next;
}

// The page's text, or the Wayback Machine's copy when the link is dead or blocked.
export async function getSource(url, { fetchImpl = safeFetch } = {}) {
  let direct;
  try {
    const res = await fetchImpl(url);
    if (res.status >= 200 && res.status < 300) direct = { ...(await readResponse(res)), url };
    else direct = { error: `http_${res.status}` };
  } catch (err) {
    direct = { error: err.message };
  }
  if (!direct.error && direct.text.trim().length > 400) return direct;
  // The archive's newest copy, raw ("id_": no Wayback toolbar). One at a time: it rate-limits.
  const archived = await archiveQueue(async () => {
    const raw = `https://web.archive.org/web/${new Date().toISOString().slice(0, 10).replace(/-/g, '')}id_/${url}`;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await fetchImpl(raw);
        if (res.status === 429) { await new Promise((r) => setTimeout(r, 3000)); continue; }
        if (res.status >= 200 && res.status < 300) return { ...(await readResponse(res)), url: res.url || raw, archived: true };
        return null;
      } catch { return null; }
    }
    return null;
  });
  if (archived && archived.text.trim().length > 200) return archived;
  return direct.error ? direct : { ...direct, thin: true };
}
