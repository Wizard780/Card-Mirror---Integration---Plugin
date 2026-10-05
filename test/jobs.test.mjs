import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createJobStore } from '../lib/jobs.mjs';

const settle = () => new Promise((r) => setImmediate(r));

test('a job is running, then done with its result', async () => {
  const jobs = createJobStore();
  let release;
  const id = jobs.start(() => new Promise((r) => { release = r; }));
  await settle();
  assert.deepEqual(jobs.get(id), { state: 'running' });
  release({ name: 'a.docx' });
  await settle();
  assert.deepEqual(jobs.get(id), { state: 'done', result: { name: 'a.docx' } });
});

test('a throwing job reports its message', async () => {
  const jobs = createJobStore();
  const id = jobs.start(async () => { throw new Error('no_room'); });
  await settle();
  assert.deepEqual(jobs.get(id), { state: 'error', message: 'no_room' });
});

test('unknown and missing ids are errors, not crashes', () => {
  const jobs = createJobStore();
  assert.deepEqual(jobs.get('nope'), { state: 'error', message: 'unknown_job' });
  assert.deepEqual(jobs.get(undefined), { state: 'error', message: 'unknown_job' });
});

test('finished jobs are evicted after the ttl; running jobs never are', async () => {
  let t = 0;
  const jobs = createJobStore({ ttlMs: 1000, now: () => t });
  const done = jobs.start(async () => 1);
  const running = jobs.start(() => new Promise(() => {}));
  await settle();
  t = 1001;
  assert.deepEqual(jobs.get(done), { state: 'error', message: 'unknown_job' });
  assert.deepEqual(jobs.get(running), { state: 'running' });
});

test('wait(): resolves as soon as the job finishes, or after the timeout while still running', async () => {
  const jobs = createJobStore();
  let release;
  const id = jobs.start(() => new Promise((r) => { release = r; }));
  const t0 = Date.now();
  const p = jobs.wait(id, 1000);
  setTimeout(() => release('ok'), 30);
  assert.deepEqual(await p, { state: 'done', result: 'ok' });
  assert.ok(Date.now() - t0 < 500, 'answered when the job finished, not at the timeout');
  const slow = jobs.start(() => new Promise(() => {}));
  const t1 = Date.now();
  assert.deepEqual(await jobs.wait(slow, 60), { state: 'running' });
  assert.ok(Date.now() - t1 >= 55);
  assert.deepEqual(await jobs.wait('nope', 1000), { state: 'error', message: 'unknown_job' });
  const fin = jobs.start(async () => 7);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(await jobs.wait(fin, 1000), { state: 'done', result: 7 }, 'already finished → immediate');
});
