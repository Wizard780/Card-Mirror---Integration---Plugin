import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, stat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createPrefs, PREF_KEYS } from '../lib/prefs.mjs';

const tmp = async () => join(await mkdtemp(join(tmpdir(), 'prefs-')), 'sub', 'prefs.json');

test('set/get round-trips, survives a new instance, file is 0600', async () => {
  const file = await tmp();
  const a = createPrefs(file);
  assert.deepEqual(await a.getAll(), {});
  await a.set('caselistTarget', { caselist: 'hspf26', teamLabel: 'NYSI ChTa' });
  await a.set('lastRoom', 'FwaXtA');
  assert.deepEqual(await createPrefs(file).getAll(), { caselistTarget: { caselist: 'hspf26', teamLabel: 'NYSI ChTa' }, lastRoom: 'FwaXtA' });
  assert.equal((await stat(file)).mode & 0o777, 0o600);
});

test('only known keys are accepted; null removes a key; a corrupt file reads as empty', async () => {
  const file = await tmp();
  const p = createPrefs(file);
  await assert.rejects(p.set('password', 'x'), /^Error: bad_key$/);
  assert.deepEqual([...PREF_KEYS].sort(), ['caselistTarget', 'lastRoom', 'scoutCaselist', 'sendDocFolder', 'tabroomEmail']);
  await p.set('lastRoom', 'abc12');
  await p.set('lastRoom', null);
  assert.deepEqual(await p.getAll(), {});
  const { writeFile } = await import('node:fs/promises');
  await writeFile(file, '{not json');
  assert.deepEqual(await createPrefs(file).getAll(), {});
  assert.ok(!(await readFile(file, 'utf8')).includes('password'));
});
