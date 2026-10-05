import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createKeychain } from '../lib/keychain.mjs';

function fakeRun(impl) {
  const calls = [];
  const run = async (bin, args) => { calls.push([bin, ...args]); return impl(args); };
  return { run, calls };
}

test('set writes JSON under service debate-uploader / account caselist_token with -U', async () => {
  const f = fakeRun(() => ({ stdout: '' }));
  await createKeychain({ bin: '/sec', run: f.run }).set({ token: 'T', expires: '2026-10-11' });
  assert.deepEqual(f.calls, [['/sec', 'add-generic-password', '-U', '-s', 'debate-uploader', '-a', 'caselist_token', '-w', '{"token":"T","expires":"2026-10-11"}']]);
});

test('get parses the stored JSON; missing, garbage or tokenless values are null', async () => {
  const ok = fakeRun(() => ({ stdout: '{"token":"T","expires":null}\n' }));
  assert.deepEqual(await createKeychain({ run: ok.run }).get(), { token: 'T', expires: null });
  assert.deepEqual(ok.calls[0].slice(1), ['find-generic-password', '-s', 'debate-uploader', '-a', 'caselist_token', '-w']);
  const missing = fakeRun(() => { throw Object.assign(new Error('exit 44'), { code: 44 }); });
  assert.equal(await createKeychain({ run: missing.run }).get(), null);
  assert.equal(await createKeychain({ run: fakeRun(() => ({ stdout: 'not json' })).run }).get(), null);
  assert.equal(await createKeychain({ run: fakeRun(() => ({ stdout: '{"expires":1}' })).run }).get(), null);
});

test('set failure (locked keychain) is keychain_failed; remove never throws', async () => {
  const broken = fakeRun(() => { throw new Error('User interaction is not allowed.'); });
  const kc = createKeychain({ run: broken.run });
  await assert.rejects(kc.set({ token: 'T', expires: null }), /^Error: keychain_failed$/);
  await kc.remove();
  assert.deepEqual(broken.calls.at(-1).slice(1), ['delete-generic-password', '-s', 'debate-uploader', '-a', 'caselist_token']);
});
