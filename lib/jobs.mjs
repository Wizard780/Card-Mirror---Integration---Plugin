import { randomUUID } from 'node:crypto';

export function createJobStore({ ttlMs = 10 * 60_000, now = Date.now } = {}) {
  const jobs = new Map();

  function sweep() {
    for (const [id, job] of jobs) {
      if (job.state !== 'running' && now() - job.finishedAt > ttlMs) jobs.delete(id);
    }
  }

  return {
    start(fn) {
      sweep();
      const id = randomUUID();
      const job = { state: 'running' };
      jobs.set(id, job);
      // `settled` lets wait() answer the moment the job finishes (not exposed by get()).
      Object.defineProperty(job, 'settled', {
        enumerable: false,
        value: Promise.resolve()
          .then(fn)
          .then(
            (result) => { Object.assign(job, { state: 'done', result, finishedAt: now() }); },
            (err) => { Object.assign(job, { state: 'error', message: err?.message ?? String(err), finishedAt: now() }); },
          ),
      });
      return id;
    },
    // Long-poll: the job's state as soon as it finishes, or after `ms` if still running.
    async wait(id, ms) {
      const job = jobs.get(id);
      if (job && job.state === 'running') {
        let timer;
        await Promise.race([job.settled, new Promise((r) => { timer = setTimeout(r, ms); })]);
        clearTimeout(timer);
      }
      return this.get(id);
    },
    get(id) {
      sweep();
      const job = jobs.get(id);
      if (!job) return { state: 'error', message: 'unknown_job' };
      const { finishedAt, ...visible } = job;
      return visible;
    },
  };
}
