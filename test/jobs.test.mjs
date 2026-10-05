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
