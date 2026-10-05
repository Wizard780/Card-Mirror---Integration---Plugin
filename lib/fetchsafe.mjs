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
import { htmlToText, pageYear } from './cardcheck.mjs';

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
    const s = ip.toLowerCase();
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(s);
    if (mapped) return isPublicAddress(mapped[1]);
    return !(s === '::' || s === '::1' || /^f[cd]/.test(s) || /^fe[89ab]/.test(s) || /^ff/.test(s));
  }
  return false;
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
    try {
      if (enc === 'gzip') body = gunzipSync(body);
      else if (enc === 'deflate') body = inflateSync(body);
      else if (enc === 'br') body = brotliDecompressSync(body);
    } catch { /* leave as-is */ }
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
  return { text: htmlToText(html), textLower: html.toLowerCase(), year: pageYear(html), pdf: false };
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
