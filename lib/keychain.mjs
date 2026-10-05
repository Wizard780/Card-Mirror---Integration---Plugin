import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const SERVICE = 'debate-uploader';
const ACCOUNT = 'caselist_token';
const ITEM = ['-s', SERVICE, '-a', ACCOUNT];

// Holds only {token, expires}. Never the password.
export function createKeychain({ bin = '/usr/bin/security', run = promisify(execFile) } = {}) {
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
        return value && typeof value.token === 'string' && value.token ? value : null;
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
