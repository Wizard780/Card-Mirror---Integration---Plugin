import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { dirname } from 'node:path';

// Plugin settings kept by the helper. CardMirror wipes a file-loaded plugin's own
// storage at every launch, so the plugin mirrors these here and restores them.
// Never a password or token: only the keys below.
export const PREF_KEYS = new Set(['caselistTarget', 'scoutCaselist', 'sendDocFolder', 'lastRoom', 'tabroomEmail', 'emailChain', 'emailThreads']);

export function createPrefs(file) {
  let queue = Promise.resolve(); // serialize writes
  async function getAll() {
    try {
      const v = JSON.parse(await readFile(file, 'utf8'));
      return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
    } catch {
      return {};
    }
  }
  function set(key, value) {
    if (!PREF_KEYS.has(key)) return Promise.reject(new Error('bad_key'));
    queue = queue.then(async () => {
      const all = await getAll();
      if (value === null || value === undefined) delete all[key];
      else all[key] = value;
      await mkdir(dirname(file), { recursive: true, mode: 0o700 });
      const tmp = `${file}.${process.pid}.tmp`;
      await writeFile(tmp, JSON.stringify(all), { mode: 0o600 });
      await rename(tmp, file);
    });
    return queue;
  }
  return { getAll, set };
}
