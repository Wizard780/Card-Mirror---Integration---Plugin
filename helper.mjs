#!/usr/bin/env node
import { createJobStore } from './lib/jobs.mjs';
import { createHelperServer } from './lib/server.mjs';
import { writeBridgeFiles, removeSession, newToken, defaultBridgeDir } from './lib/bridge.mjs';
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { promisify } from 'node:util';
import { createKeychain } from './lib/keychain.mjs';
import { createRoomWatcher } from './lib/roomwatch.mjs';
import { createPrefs } from './lib/prefs.mjs';
import { login, getRounds, listCaselists, listSchools, listTeams, createRound, searchTeams, getTeam, downloadOpenSource, listTeamsDetailed, CASELIST_BASE } from './lib/caselist.mjs';
import { parseOpponent, schoolScore, pickTeam } from './lib/scout.mjs';
import { uploadToSpeechDrop, newestDocx, MAX_BYTES, listRoom, downloadFile, saveUnique, expandHome, SD_BASE, SD_MEDIA } from './lib/speechdrop.mjs';
import { createEvidenceIndex } from './lib/evidence.mjs';
import { cardDocx, headingsOf } from './lib/docx.mjs';
import { draftReport } from './lib/report-draft.mjs';
import { compare, skippedQualifiers, verdict, urlsIn } from './lib/cardcheck.mjs';
import { getSource, safeFetch } from './lib/fetchsafe.mjs';
import { buildMessage, newMessageId, sendMail, verifyLogin, isEmail } from './lib/smtp.mjs';
import { readFile, stat } from 'node:fs/promises';

const VERSION = '0.1.8';
const bridgeDir = process.env.DEBATE_UPLOADER_BRIDGE_DIR || defaultBridgeDir();
const sdBase = process.env.DEBATE_UPLOADER_SD_BASE || SD_BASE;
const sdMedia = process.env.DEBATE_UPLOADER_SD_MEDIA || SD_MEDIA;
const downloadDir = process.env.DEBATE_UPLOADER_DOWNLOAD_DIR || join(homedir(), 'Downloads', 'SpeechDrop');
const caselistDir = process.env.DEBATE_UPLOADER_CASELIST_DIR || join(homedir(), 'Downloads', 'Caselist');
const dirSeg = (s) => String(s ?? '').replace(/[^A-Za-z0-9 _.-]/g, '_').replace(/^\.+/, '_') || '_';
const opener = process.env.DEBATE_UPLOADER_OPENER || '/usr/bin/open';
const run = promisify(execFile);
// Files come from strangers (SpeechDrop rooms, caselists): open only document types;
// anything else (.webloc, .terminal, .html, ...) is just revealed in Finder.
const OPENABLE = /\.(docx?|pdf|rtf|txt|odt|cmir)$/i;
async function openSafely(path) {
  const inCardMirror = /\.(docx|cmir)$/i.test(path);
  const app = inCardMirror ? 'CardMirror' : OPENABLE.test(path) ? 'default' : 'finder';
  const args = inCardMirror ? ['-b', 'com.cardmirror.app', path] : app === 'default' ? [path] : ['-R', path];
  try {
    await run(opener, args);
    return { app };
  } catch {
    return { app, opened: false }; // saved, but the open step failed
  }
}
// Evidence search: loaded on first use (≈0.5 GB for 250k cards), rescanned in the background.
const evidence = createEvidenceIndex({ file: process.env.DEBATE_UPLOADER_EVIDENCE_FILE || join(homedir(), 'Library', 'Application Support', 'debate-uploader', 'evidence-index.json') });
const cardsDir = process.env.DEBATE_UPLOADER_CARDS_DIR || join(homedir(), 'Downloads', 'Cards');
function rescan(folders) {
  if (!folders.length) return;
  const t0 = Date.now();
  evidence.scan(folders).then(
    () => { const s = evidence.status(); log('evidence scan', s.files, 'files', s.cards, 'cards', Date.now() - t0, 'ms'); },
    (err) => log('evidence scan failed', err.message),
  );
}
// Tests point Card Check at a local server; real runs only ever fetch public addresses.
const sourceOpts = process.env.DEBATE_UPLOADER_TEST_ALLOW_PRIVATE === '1' ? { fetchImpl: (u) => safeFetch(u, { allowPrivate: true }) } : {};
const cardFileName = (tag) => `${String(tag).replace(/[^A-Za-z0-9 ,'’-]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60).trim() || 'Card'}.docx`;
const clBase = process.env.DEBATE_UPLOADER_CASELIST_BASE || CASELIST_BASE;
const keychain = createKeychain({ bin: process.env.DEBATE_UPLOADER_SECURITY_BIN || '/usr/bin/security' });
const clOpts = { base: clBase };
// Gmail for email chains: {email, appPassword} in its own Keychain item. Never logged.
const gmail = createKeychain({
  bin: process.env.DEBATE_UPLOADER_SECURITY_BIN || '/usr/bin/security', account: 'gmail',
  valid: (v) => isEmail(v.email) && typeof v.appPassword === 'string' && v.appPassword.length >= 8,
});
const smtp = (() => {
  const [host, port, mode] = String(process.env.DEBATE_UPLOADER_SMTP || 'smtp.gmail.com:465:tls').split(':');
  return { host, port: Number(port), secure: mode !== 'plain' };
})();
const MAX_MAIL_BYTES = 20 * 1024 * 1024; // Gmail's limit is 25 MB including base64 overhead
const prefs = createPrefs(process.env.DEBATE_UPLOADER_PREFS_FILE || join(homedir(), 'Library', 'Application Support', 'debate-uploader', 'prefs.json'));
// Live room lists. Budget per /speechdrop/watch call must stay under CardMirror's
// 3 s flowPost limit: ≤1 s socket wait + ≤1.5 s HTTP fallback, or a ≤1 s long-poll.
const watcher = createRoomWatcher({
  wsUrl: process.env.DEBATE_UPLOADER_SD_WS || 'wss://speechdrop.net/sock/websocket',
  list: (room) => listRoom(room, { base: sdBase, timeoutMs: 1500 }),
});
const WATCH_WAIT_MS = 1000;

// Lists that barely change within a session are cached (in-flight requests shared,
// failures never cached). Team pages and Tabroom rounds (new pairings post mid-tournament)
// stay fresh. Login/logout clears everything.
const cache = new Map();
async function cached(key, ttlMs, fn) {
  const hit = cache.get(key);
  if (hit && hit.until > Date.now()) return hit.value;
  const value = fn();
  cache.set(key, { until: Date.now() + ttlMs, value });
  try {
    return await value;
  } catch (err) {
    if (cache.get(key)?.value === value) cache.delete(key);
    throw err;
  }
}
const TEN_MIN = 10 * 60_000;
const cl = {
  caselists: (t) => cached('caselists', TEN_MIN, () => listCaselists(t, clOpts)),
  schools: (t, c) => cached(`schools:${c}`, TEN_MIN, () => listSchools(t, c, clOpts)),
  teams: (t, c, s) => cached(`teams:${c}:${s}`, TEN_MIN, () => listTeams(t, c, s, clOpts)),
  teamsDetailed: (t, c, s) => cached(`teamsDetailed:${c}:${s}`, TEN_MIN, () => listTeamsDetailed(t, c, s, clOpts)),
};
const token = newToken();
const jobs = createJobStore();
// Logs names, rooms and sizes only. Never tokens, cookies or contents.
const log = (...parts) => console.log(new Date().toISOString(), ...parts);

// Runs fn(token) with the stored session. On a 401 the Keychain item is
// removed only if it still holds the token that failed (a newer login stays).
async function withSession(fn) {
  const session = await keychain.get();
  if (!session || (session.expires && Date.parse(session.expires) < Date.now())) {
    if (session) await keychain.remove();
    throw new Error('not_logged_in');
  }
  try {
    return await fn(session.token);
  } catch (err) {
    if (err.message === 'login_expired') {
      const current = await keychain.get().catch(() => null);
      if (current && current.token === session.token) await keychain.remove();
    }
    throw err;
  }
}

const authedJob = (label, fn) => ({
  ok: true,
  job: jobs.start(async () => {
    try {
      return await withSession(fn);
    } catch (err) {
      log(`${label} failed`, err.message);
      throw err;
    }
  }),
});

async function scoutIn(t, caselist, opponent) {
  const { school } = parseOpponent(opponent);
  const schools = await cl.schools(t, caselist);
  const likely = schools
    .map((s, i) => ({ s, i, score: schoolScore(school, s.label) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .slice(0, 6)
    .map((x) => x.s);
  const teams = (await Promise.all(likely.map((s) =>
    cl.teamsDetailed(t, caselist, s.name).then((ts) => ts.map((x) => ({ ...x, schoolLabel: s.label })))))).flat();
  const { match, candidates } = pickTeam(opponent, teams);
  log('caselist scout', caselist, opponent, match ? `${match.school}/${match.team}` : `${candidates.length} candidates`);
  return { match, candidates: candidates.slice(0, 15) };
}

const routes = {
  // Long-poll (≤2 s, inside CardMirror's 3 s flowPost limit): answers the moment the job ends.
  '/job': ({ id, waitMs }) => {
    const ms = Math.min(Math.max(Number(waitMs) || 0, 0), 2000);
    return ms ? jobs.wait(id, ms) : jobs.get(id);
  },

  '/speechdrop/upload': ({ room, file, folder }) => {
    const id = jobs.start(async () => {
      try {
        const doc = file
          ? { name: String(file.name), bytes: Buffer.from(String(file.base64 ?? ''), 'base64') }
          : await newestDocx(folder);
        log('speechdrop upload', room, doc.name, `${doc.bytes.length} bytes`);
        const result = await uploadToSpeechDrop({ room, ...doc }, { base: sdBase });
        log('speechdrop ok', room, result.name);
        return result;
      } catch (err) {
        log('speechdrop failed', room, err.message);
        throw err;
      }
    });
    return { ok: true, job: id };
  },

  '/speechdrop/watch': async ({ room, version }) => ({
    ok: true,
    ...(await watcher.watch(room, Number(version) || 0, WATCH_WAIT_MS)),
  }),

  '/speechdrop/list': ({ room }) => ({ ok: true, job: jobs.start(() => listRoom(room, { base: sdBase })) }),

  '/speechdrop/open': ({ room, index, name }) => {
    const id = jobs.start(async () => {
      try {
        // Only names SpeechDrop itself lists for that slot: blocks "../" names.
        const files = await listRoom(room, { base: sdBase });
        const entry = files.find((f) => f.index === Number(index) && f.name === name);
        if (!entry) throw new Error('removed');
        const bytes = await downloadFile({ room, index: entry.index, name: entry.name }, { mediaBase: sdMedia });
        const path = await saveUnique(join(downloadDir, room), entry.name, bytes);
        const how = await openSafely(path);
        log('speechdrop open', room, entry.name, how.app, how.opened === false ? '(open failed)' : '');
        return { name: entry.name, path, ...how };
      } catch (err) {
        log('speechdrop open failed', room, err.message);
        throw err;
      }
    });
    return { ok: true, job: id };
  },

  // The password lives only in this request; only {token, expires} is kept.
  '/tabroom/login': ({ username, password }) => ({
    ok: true,
    job: jobs.start(async () => {
      try {
        const session = await login({ username, password }, { base: clBase });
        await keychain.set(session);
        cache.clear();
        log('tabroom login ok');
        return { loggedIn: true };
      } catch (err) {
        log('tabroom login failed', err.message);
        throw err;
      }
    }),
  }),

  '/tabroom/logout': async () => {
    await keychain.remove();
    cache.clear();
    log('tabroom logout');
    return { ok: true };
  },

  '/tabroom/rounds': () => authedJob('tabroom rounds', async (t) => {
    const out = await getRounds(t, clOpts);
    log('tabroom rounds', out.current ? 'current' : 'recent', out.rounds.length);
    return out;
  }),

  '/caselist/caselists': () => authedJob('caselist list', (t) => cl.caselists(t)),
  '/caselist/schools': ({ caselist }) => authedJob('caselist schools', (t) => cl.schools(t, caselist)),
  '/caselist/teams': ({ caselist, school }) => authedJob('caselist teams', (t) => cl.teams(t, caselist, school)),

  // Local only (no network): lets the form show which file "newest send doc" means.
  // Round report draft: the round's docs in the SpeechDrop room (both teams), else the newest send doc.
  '/caselist/report-draft': ({ room, since, folder }) => ({
    ok: true,
    job: jobs.start(async () => {
      const docs = [];
      let pdfs = 0;
      if (room && /^[A-Za-z0-9]{1,32}$/.test(room)) {
        const from = Number(since) || Date.now() - 4 * 3600_000;
        try {
          const files = (await listRoom(room, { base: sdBase })).filter((f) => !f.ctime || f.ctime >= from);
          pdfs = files.filter((f) => !/\.docx$/i.test(f.name)).length;
          for (const f of files.filter((x) => /\.docx$/i.test(x.name)).slice(0, 12)) {
            try { docs.push({ name: f.name, headings: headingsOf(await downloadFile({ room, index: f.index, name: f.name }, { mediaBase: sdMedia })) }); } catch { /* unreadable: skip */ }
          }
        } catch { /* room gone or offline: fall back to the send doc */ }
      }
      if (folder) {
        try {
          const doc = await newestDocx(folder);
          if (!docs.some((d) => d.name === doc.name)) docs.push({ name: doc.name, headings: headingsOf(doc.bytes) });
        } catch { /* no send doc */ }
      }
      const { report, used } = draftReport(docs);
      log('caselist report draft', `${used.length} of ${docs.length} docs`, pdfs ? `${pdfs} non-docx skipped` : '');
      return { report, used, skipped: pdfs };
    }),
  }),

  // Card Check: each card against the page its cite links to. 4 sources at a time;
  // results stream out through the job's progress.
  '/cardcheck/run': ({ cards }) => ({
    ok: true,
    job: jobs.start(async (report) => {
      const list = (Array.isArray(cards) ? cards : []).slice(0, 400);
      const sources = new Map();
      const source = (url) => { if (!sources.has(url)) sources.set(url, getSource(url, sourceOpts)); return sources.get(url); };
      const results = new Array(list.length).fill(null);
      let next = 0;
      const t0 = Date.now();
      async function worker() {
        while (next < list.length) {
          const i = next++;
          const c = list[i] || {};
          const runs = Array.isArray(c.runs) ? c.runs.map((r) => ({ t: String(r.t ?? ''), h: !!r.h })) : [];
          const text = runs.map((r) => r.t).join('');
          const url = [...(Array.isArray(c.urls) ? c.urls : []), ...urlsIn(c.cite)].find((u) => /^https?:\/\//i.test(u));
          let src = null;
          let result = null;
          if (url) {
            src = await source(url);
            if (!src.error) result = compare(text, src.text);
          }
          const v = verdict({ result, source: src, cite: c.cite });
          results[i] = {
            key: c.key, ...v, url: url || null, archived: !!(src && src.archived), pdf: !!(src && src.pdf),
            reason: src && src.error ? src.error : null, qualifiers: skippedQualifiers(runs).slice(0, 5),
          };
          report({ done: results.filter(Boolean).length, total: list.length, results });
        }
      }
      await Promise.all([worker(), worker(), worker(), worker()]);
      const tally = results.reduce((m, r) => ({ ...m, [r.status]: (m[r.status] || 0) + 1 }), {});
      log('cardcheck', list.length, 'cards', sources.size, 'sources', JSON.stringify(tally), Date.now() - t0, 'ms');
      return { done: list.length, total: list.length, results };
    }),
  }),

  '/caselist/newest': async ({ folder }) => {
    const doc = await newestDocx(folder);
    return { ok: true, name: doc.name, size: doc.bytes.length, mtime: doc.mtimeMs };
  },

  '/caselist/upload': ({ caselist, school, team, round, file, folder, expectName }) => authedJob('caselist upload', async (t) => {
    const doc = file
      ? { name: String(file.name), bytes: Buffer.from(String(file.base64 ?? ''), 'base64') }
      : await newestDocx(folder);
    // Public and permanent: post only the file the user saw in the form, and nothing oversized.
    if (!file && expectName && doc.name !== expectName) throw new Error('newest_changed');
    if (doc.bytes.length > MAX_BYTES) throw new Error('too_large');
    log('caselist upload', caselist, school, team, doc.name, `${doc.bytes.length} bytes`);
    await createRound(t, { caselist, school, team }, { ...(round || {}), filename: doc.name, base64: doc.bytes.toString('base64') }, clOpts);
    log('caselist upload ok', caselist, school, team, doc.name);
    return { name: doc.name };
  }),

  // Tabroom "School CODE" → caselist team: rank schools by name, then match the debater pair.
  // With no caselist given, every open caselist is tried and the matching one is reported.
  '/caselist/scout': ({ caselist, opponent }) => authedJob('caselist scout', async (t) => {
    if (caselist) return { caselist: null, ...(await scoutIn(t, caselist, opponent)) };
    const open = await cl.caselists(t);
    const tries = await Promise.all(open.map((c) => scoutIn(t, c.name, opponent).then((r) => ({ c, r }), () => ({ c, r: { match: null, candidates: [] } }))));
    const { school } = parseOpponent(opponent);
    const hits = tries.filter((x) => x.r.match).sort((a, b) => schoolScore(school, b.r.match.schoolLabel) - schoolScore(school, a.r.match.schoolLabel));
    if (!hits.length) return { caselist: null, match: null, candidates: [] };
    const { c, r } = hits[0];
    return { caselist: { name: c.name, label: c.label, event: c.event || '' }, ...r };
  }),

  '/evidence/folders': async ({ folders }) => {
    const list = [];
    for (const raw of Array.isArray(folders) ? folders : []) {
      const dir = expandHome(String(raw).trim());
      if (!dir) continue;
      let st;
      try { st = await stat(dir); } catch { throw new Error(`no_folder:${dir}`); }
      if (!st.isDirectory()) throw new Error(`no_folder:${dir}`);
      if (!list.includes(dir)) list.push(dir);
    }
    if (!list.length) throw new Error('no_folder');
    rescan(list);
    return { ok: true, ...evidence.status() };
  },
  '/evidence/status': async ({ refresh }) => {
    await evidence.load();
    const s = evidence.status();
    if (refresh && !s.scanning && Date.now() - s.scannedAt > 60_000) rescan(s.folders);
    return { ok: true, ...evidence.status() };
  },
  '/evidence/search': async ({ query, limit }) => {
    await evidence.load();
    return { ok: true, results: evidence.search(query, Math.min(Number(limit) || 50, 200)), ...evidence.status() };
  },
  '/evidence/open': async ({ path, ordinal }) => {
    const card = evidence.lookup(path, ordinal);
    if (!card) throw new Error('not_indexed');
    const how = await openSafely(card.path);
    log('evidence open', card.file, how.app);
    return { ok: true, name: card.file, ...how, quote: card.quote, approxPos: card.approxPos };
  },
  '/evidence/card': async ({ path, ordinal }) => {
    const card = evidence.lookup(path, ordinal);
    if (!card) throw new Error('not_indexed');
    let bytes;
    try { bytes = cardDocx(await readFile(card.path), ordinal, card.tag); } catch {
      rescan(evidence.status().folders);
      throw new Error('card_changed');
    }
    const where = await saveUnique(cardsDir, cardFileName(card.tag), bytes);
    const how = await openSafely(where);
    log('evidence card', card.file, ordinal);
    return { ok: true, name: where.split('/').pop(), path: where, ...how };
  },
  '/gmail/status': async () => {
    const g = await gmail.get();
    return { ok: true, email: g ? g.email : null };
  },
  '/gmail/setup': ({ email, appPassword }) => ({
    ok: true,
    job: jobs.start(async () => {
      const address = String(email ?? '').trim();
      const pass = String(appPassword ?? '').replace(/\s+/g, ''); // Google shows it in groups of 4
      if (!isEmail(address)) throw new Error('bad_email');
      if (pass.length < 8) throw new Error('bad_login');
      await verifyLogin({ ...smtp, user: address, pass }); // never saved unless Gmail accepts it
      await gmail.set({ email: address, appPassword: pass });
      log('gmail setup', address);
      return { email: address };
    }),
  }),
  '/gmail/forget': async () => { await gmail.remove(); log('gmail forget'); return { ok: true }; },
  // One email to the chain with the doc attached. Same subject = same thread (In-Reply-To).
  '/gmail/send': ({ to, subject, folder, file, text }) => ({
    ok: true,
    job: jobs.start(async () => {
      const g = await gmail.get();
      if (!g) throw new Error('gmail_not_set_up');
      const list = [...new Set((Array.isArray(to) ? to : []).map((x) => String(x).trim()).filter(Boolean))];
      if (!list.length || list.length > 30 || !list.every(isEmail)) throw new Error('bad_recipients');
      const doc = file
        ? { name: String(file.name), bytes: Buffer.from(String(file.base64 ?? ''), 'base64') }
        : await newestDocx(folder);
      if (doc.bytes.length > MAX_MAIL_BYTES) throw new Error('too_large');
      const subj = String(subject ?? '').trim() || doc.name.replace(/\.docx$/i, '');
      const threads = (await prefs.getAll()).emailThreads || {};
      const key = subj.toLowerCase();
      const prior = Array.isArray(threads[key]) ? threads[key] : [];
      const messageId = newMessageId();
      const raw = buildMessage({
        from: g.email, to: list, subject: prior.length ? `Re: ${subj}` : subj, text: String(text ?? '') || `${doc.name} attached.`,
        attachments: [{ name: doc.name, bytes: doc.bytes }], messageId, inReplyTo: prior.at(-1), references: prior.slice(-10),
      });
      await sendMail({ ...smtp, user: g.email, pass: g.appPassword }, { from: g.email, to: list, raw });
      log('gmail send', doc.name, `${list.length} recipients`, prior.length ? 'reply' : 'new thread');
      const keep = Object.fromEntries(Object.entries({ ...threads, [key]: [...prior, messageId].slice(-20) }).slice(-30));
      await prefs.set('emailThreads', keep);
      return { name: doc.name, recipients: list.length, reply: prior.length > 0 };
    }),
  }),
  '/prefs/get': async () => ({ ok: true, prefs: await prefs.getAll() }),
  '/prefs/set': async ({ key, value }) => {
    try {
      await prefs.set(key, value);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  },

  '/caselist/search': ({ caselist, q }) => authedJob('caselist search', (t) => searchTeams(t, caselist, q, clOpts)),
  '/caselist/team': ({ caselist, school, team }) => authedJob('caselist team', (t) => getTeam(t, caselist, school, team, clOpts)),

  // Read-only: downloads only a file listed on that team's own page.
  '/caselist/open': ({ caselist, school, team, path }) => authedJob('caselist open', async (t) => {
    const { rounds } = await getTeam(t, caselist, school, team, clOpts);
    if (!path || !rounds.some((r) => r.opensource === path)) throw new Error('removed');
    const { filename, bytes } = await downloadOpenSource(t, path, clOpts);
    const where = await saveUnique(join(caselistDir, dirSeg(caselist), `${dirSeg(school)}-${dirSeg(team)}`), filename, bytes);
    const how = await openSafely(where);
    log('caselist open', caselist, school, team, filename, how.app, how.opened === false ? '(open failed)' : '');
    return { name: filename, path: where, ...how };
  }),
};

const server = createHelperServer({ token, appVersion: VERSION, routes });
server.listen(0, '127.0.0.1', async () => {
  const { port } = server.address();
  await writeBridgeFiles(bridgeDir, { port, token, pid: process.pid, appVersion: VERSION });
  log(`listening on 127.0.0.1:${port}`);
});

async function shutdown() {
  watcher.close();
  await removeSession(bridgeDir);
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
