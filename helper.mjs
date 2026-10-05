#!/usr/bin/env node
import { createJobStore } from './lib/jobs.mjs';
import { createHelperServer } from './lib/server.mjs';
import { writeBridgeFiles, removeSession, newToken, defaultBridgeDir } from './lib/bridge.mjs';
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { promisify } from 'node:util';
import { createKeychain } from './lib/keychain.mjs';
import { login, getRounds, CASELIST_BASE } from './lib/caselist.mjs';
import { uploadToSpeechDrop, newestDocx, listRoom, downloadFile, saveUnique, SD_BASE, SD_MEDIA } from './lib/speechdrop.mjs';

const VERSION = '0.1.0';
const bridgeDir = process.env.DEBATE_UPLOADER_BRIDGE_DIR || defaultBridgeDir();
const sdBase = process.env.DEBATE_UPLOADER_SD_BASE || SD_BASE;
const sdMedia = process.env.DEBATE_UPLOADER_SD_MEDIA || SD_MEDIA;
const downloadDir = process.env.DEBATE_UPLOADER_DOWNLOAD_DIR || join(homedir(), 'Downloads', 'SpeechDrop');
const opener = process.env.DEBATE_UPLOADER_OPENER || '/usr/bin/open';
const run = promisify(execFile);
const clBase = process.env.DEBATE_UPLOADER_CASELIST_BASE || CASELIST_BASE;
const keychain = createKeychain({ bin: process.env.DEBATE_UPLOADER_SECURITY_BIN || '/usr/bin/security' });
const token = newToken();
const jobs = createJobStore();
// Logs names, rooms and sizes only. Never tokens, cookies or contents.
const log = (...parts) => console.log(new Date().toISOString(), ...parts);

const routes = {
  '/job': ({ id }) => jobs.get(id),

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
        const inCardMirror = /\.(docx|cmir)$/i.test(entry.name);
        await run(opener, inCardMirror ? ['-b', 'com.cardmirror.app', path] : [path]);
        log('speechdrop open', room, entry.name, inCardMirror ? 'CardMirror' : 'default app');
        return { name: entry.name, path, app: inCardMirror ? 'CardMirror' : 'default' };
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
    log('tabroom logout');
    return { ok: true };
  },

  '/tabroom/rounds': () => ({
    ok: true,
    job: jobs.start(async () => {
      const session = await keychain.get();
      if (!session || (session.expires && Date.parse(session.expires) < Date.now())) {
        if (session) await keychain.remove();
        throw new Error('not_logged_in');
      }
      try {
        const out = await getRounds(session.token, { base: clBase });
        log('tabroom rounds', out.current ? 'current' : 'recent', out.rounds.length);
        return out;
      } catch (err) {
        if (err.message === 'login_expired') await keychain.remove();
        log('tabroom rounds failed', err.message);
        throw err;
      }
    }),
  }),
};

const server = createHelperServer({ token, appVersion: VERSION, routes });
server.listen(0, '127.0.0.1', async () => {
  const { port } = server.address();
  await writeBridgeFiles(bridgeDir, { port, token, pid: process.pid, appVersion: VERSION });
  log(`listening on 127.0.0.1:${port}`);
});

async function shutdown() {
  await removeSession(bridgeDir);
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
