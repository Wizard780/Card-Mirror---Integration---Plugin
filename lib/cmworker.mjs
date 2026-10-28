// Map a CardMirror docx-open worker URL to its file inside an installed app bundle, or null.
import { fileURLToPath } from 'node:url';
import { normalize } from 'node:path';

const WORKER = /\/[^/]+\.app\/Contents\/Resources\/renderer\/assets\/docx-open-worker-[\w-]+\.js$/;

export function cmWorkerPath(url) {
  if (typeof url !== 'string' || !url.startsWith('file:///')) return null;
  let path;
  try { path = normalize(fileURLToPath(url.split(/[?#]/)[0])); } catch { return null; }
  return WORKER.test(path) && !path.includes('/../') ? path : null;
}
