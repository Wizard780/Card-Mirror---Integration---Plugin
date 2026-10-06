import { mkdir, writeFile, rename, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes, timingSafeEqual } from 'node:crypto';

export const APP_ID = 'debate-uploader';

export const defaultBridgeDir = () =>
  join(homedir(), 'Library', 'Application Support', 'cardmirror-bridge');

export const newToken = () => randomBytes(24).toString('base64url');

async function atomicWriteJson(path, obj) {
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(obj), { mode: 0o600 });
  await rename(tmp, path);
}

export async function writeBridgeFiles(dir, { port, token, pid, appVersion }) {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await atomicWriteJson(join(dir, `${APP_ID}.json`), { schema: 1, app: 'Debate Uploader', appVersion, kind: 'flow' });
  await atomicWriteJson(join(dir, `${APP_ID}.session.json`), { port, token, pid });
}

// With a pid, only that process's session is removed: a second helper that took over the
// file keeps it when this one stops.
export async function removeSession(dir, pid) {
  const file = join(dir, `${APP_ID}.session.json`);
  if (pid !== undefined) {
    try { if (JSON.parse(await readFile(file, 'utf8')).pid !== pid) return; } catch { return; }
  }
  await rm(file, { force: true });
}

export function tokenMatches(given, expected) {
  if (typeof given !== 'string') return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
