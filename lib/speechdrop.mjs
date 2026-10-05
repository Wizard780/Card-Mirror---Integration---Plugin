import { readdir, stat, readFile } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { homedir } from 'node:os';

export const SD_BASE = 'https://speechdrop.net';
export const MAX_BYTES = 10 * 1024 * 1024;

const MIME = {
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.doc': 'application/msword',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.rtf': 'application/rtf',
  '.odt': 'application/vnd.oasis.opendocument.text',
};

export function mimeFor(name) {
  const mime = MIME[extname(String(name)).toLowerCase()];
  if (!mime) throw new Error('bad_type');
  return mime;
}

export function expandHome(p, home = homedir()) {
  if (p === '~') return home;
  if (p.startsWith('~/')) return join(home, p.slice(2));
  return p;
}

export async function newestDocx(folder) {
  const raw = String(folder ?? '').trim();
  if (!raw) throw new Error('no_folder');
  const dir = expandHome(raw);
  let names;
  try {
    names = await readdir(dir);
  } catch {
    throw new Error(`no_docx:${raw}`);
  }
  let best = null;
  for (const name of names) {
    if (!name.toLowerCase().endsWith('.docx') || name.startsWith('~$')) continue;
    const s = await stat(join(dir, name));
    if (s.isFile() && (!best || s.mtimeMs > best.mtimeMs)) best = { name, mtimeMs: s.mtimeMs };
  }
  if (!best) throw new Error(`no_docx:${raw}`);
  return { name: best.name, bytes: await readFile(join(dir, best.name)) };
}

export async function uploadToSpeechDrop({ room, name, bytes }, { fetchImpl = fetch, base = SD_BASE, timeoutMs = 20_000 } = {}) {
  if (!/^[A-Za-z0-9]{1,32}$/.test(room ?? '')) throw new Error('bad_room');
  if (bytes.length > MAX_BYTES) throw new Error('too_large');
  const type = mimeFor(name);

  let page;
  try {
    page = await fetchImpl(`${base}/${room}`, { redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
  } catch {
    throw new Error('unreachable');
  }
  if (page.status >= 300 && page.status < 400) throw new Error('no_room');
  if (!page.ok) throw new Error(`http_${page.status}`);

  const cookies = page.headers.getSetCookie().map((c) => c.split(';')[0]);
  const xsrf = cookies.find((c) => c.startsWith('XSRF-TOKEN='))?.slice('XSRF-TOKEN='.length);
  if (!xsrf) throw new Error('no_csrf');

  const form = new FormData();
  form.append('X-XSRF-TOKEN', xsrf);
  form.append('file', new Blob([bytes], { type }), name);

  let up;
  try {
    up = await fetchImpl(`${base}/${room}/upload`, {
      method: 'POST',
      body: form,
      headers: { Cookie: cookies.join('; '), 'X-XSRF-TOKEN': xsrf },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new Error('upload_unknown');
  }
  // From here the file may already be stored, so anything unclear is
  // upload_unknown ("check the room"), never a plain failure.
  let text;
  try { text = await up.text(); } catch { throw new Error('upload_unknown'); }
  if (up.status === 400) {
    let err = 'rejected';
    try { err = JSON.parse(text).err ?? err; } catch {}
    throw new Error(err);
  }
  if (up.status >= 500) throw new Error('upload_unknown');
  if (!up.ok) throw new Error(`http_${up.status}`);
  let index;
  try { index = JSON.parse(text); } catch { throw new Error('upload_unknown'); }
  if (!Array.isArray(index)) throw new Error('upload_unknown');
  return { room, name };
}
