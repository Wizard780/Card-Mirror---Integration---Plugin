import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const SERVICE = 'debate-uploader';
const hasToken = (v) => typeof v.token === 'string' && !!v.token;

// One item per account: 'caselist_token' holds {token, expires} (never the Tabroom
// password); 'gmail' holds {email, appPassword} for the email chain.
export function createKeychain({ bin = '/usr/bin/security', run = promisify(execFile), account = 'caselist_token', valid = hasToken } = {}) {
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
        await run(bin, ['add-generic-password', '-U', ...ITEM, '-w', JSON.stringify(value)]);
      } catch {
        throw new Error('keychain_failed');
      }
    },
    async remove() {
      try { await run(bin, ['delete-generic-password', ...ITEM]); } catch {}
    },
  };
}
