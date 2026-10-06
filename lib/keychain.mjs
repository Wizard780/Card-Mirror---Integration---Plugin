import { execFile } from 'node:child_process';

// execFile as a promise, optionally writing `input` to stdin.
function execRun(bin, args, { input } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(bin, args, (err, stdout, stderr) => (err ? reject(Object.assign(err, { stderr })) : resolve({ stdout, stderr })));
    if (input !== undefined) child.stdin.end(input);
  });
}

const SERVICE = 'debate-uploader';
const hasToken = (v) => typeof v.token === 'string' && !!v.token;

// One item per account: 'caselist_token' holds {token, expires} (never the Tabroom
// password); 'gmail' holds {email, appPassword} for the email chain.
export function createKeychain({ bin = '/usr/bin/security', run = execRun, account = 'caselist_token', valid = hasToken } = {}) {
  const ITEM = ['-s', SERVICE, '-a', account];
  return {
    async get() {
      let stdout;
      try {
        ({ stdout } = await run(bin, ['find-generic-password', ...ITEM, '-w']));
      } catch (err) {
        if (err?.code === 44) return null; // errSecItemNotFound: simply logged out
        throw new Error('keychain_failed'); // locked, denied, or `security` missing
      }
      try {
        const value = JSON.parse(String(stdout).trim());
        return value && typeof value === 'object' && valid(value) ? value : null;
      } catch {
        return null;
      }
    },
    async set(value) {
      try {
        // Through `security -i` on stdin, as hex (-X): never on a command line, where `ps` shows it.
        const hex = Buffer.from(JSON.stringify(value), 'utf8').toString('hex');
        await run(bin, ['-i'], { input: `add-generic-password -U ${ITEM.join(' ')} -X ${hex}\n` });
      } catch {
        throw new Error('keychain_failed');
      }
    },
    async remove() {
      try { await run(bin, ['delete-generic-password', ...ITEM]); } catch {}
    },
  };
}
