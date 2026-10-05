import { mkdir, writeFile, rename, rm } from 'node:fs/promises';
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

export async function removeSession(dir) {
  await rm(join(dir, `${APP_ID}.session.json`), { force: true });
}

export function tokenMatches(given, expected) {
  if (typeof given !== 'string') return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
