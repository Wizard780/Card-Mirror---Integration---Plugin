import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { writeBridgeFiles, removeSession, tokenMatches, newToken, APP_ID } from '../lib/bridge.mjs';

const tmp = () => mkdtemp(join(tmpdir(), 'bridge-'));

test('writes identity + session files with 0600 perms in a 0700 dir', async () => {
  const dir = join(await tmp(), 'cardmirror-bridge');
  await writeBridgeFiles(dir, { port: 4321, token: 'abc', pid: 99, appVersion: '0.1.0' });
  const identity = JSON.parse(await readFile(join(dir, `${APP_ID}.json`), 'utf8'));
  const session = JSON.parse(await readFile(join(dir, `${APP_ID}.session.json`), 'utf8'));
  assert.deepEqual(identity, { schema: 1, app: 'Debate Uploader', appVersion: '0.1.0', kind: 'flow' });
  assert.deepEqual(session, { port: 4321, token: 'abc', pid: 99 });
  assert.equal((await stat(join(dir, `${APP_ID}.session.json`))).mode & 0o777, 0o600);
  assert.equal((await stat(join(dir, `${APP_ID}.json`))).mode & 0o777, 0o600);
  assert.equal((await stat(dir)).mode & 0o777, 0o700);
  assert.deepEqual((await readdir(dir)).filter((n) => n.endsWith('.tmp')), []);
});

test('removeSession deletes only the session file and is idempotent', async () => {
  const dir = await tmp();
  await writeBridgeFiles(dir, { port: 1, token: 't', pid: 1, appVersion: '0.1.0' });
  await removeSession(dir);
  await removeSession(dir);
  assert.deepEqual((await readdir(dir)).sort(), [`${APP_ID}.json`]);
});

test('tokenMatches compares exactly and rejects non-strings', () => {
  assert.equal(tokenMatches('abc', 'abc'), true);
  assert.equal(tokenMatches('abd', 'abc'), false);
  assert.equal(tokenMatches('ab', 'abc'), false);
  assert.equal(tokenMatches(undefined, 'abc'), false);
  assert.equal(tokenMatches(['abc'], 'abc'), false);
});

test('newToken is long and different each time', () => {
  const a = newToken(), b = newToken();
  assert.ok(a.length >= 24);
  assert.notEqual(a, b);
});
