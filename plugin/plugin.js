// Debate Uploader: CardMirror plugin (API v1). Classic script: no imports.
// All network work happens in the local helper (helper.mjs) via api.flowPost.
(() => {
  const ID = 'debate-uploader';
  const MAX_BYTES = 10 * 1024 * 1024;
  const POLL_MS = 1000;
  const MAX_WAIT_MS = 90_000;
  const START_HELPER = 'launchctl kickstart gui/$(id -u)/debate-uploader';
  const SET_FOLDER_LABEL = 'Set send doc folder for SpeechDrop…';

  function message(code, ctx = {}) {
    // Browsing only reads, so a slow helper there is a plain "try again".
    if (ctx.browse && ['start_unknown', 'upload_unknown', 'unknown_job', 'still_running'].includes(code)) {
      return "The helper didn't answer in time. Try again.";
    }
    if (code.startsWith('no_docx:')) return `No .docx in ${code.slice('no_docx:'.length)}. Set your send doc folder again.`;
    switch (code) {
      case 'app-not-running':
      case 'no-such-app': return `Uploader helper isn't running. Run: ${START_HELPER}`;
      case 'timeout': return "Helper didn't answer in time. Try again.";
      case 'unsupported': return 'This CardMirror build cannot reach helper apps (desktop only).';
      case 'bad-response': return 'Helper sent a bad response. Check ~/Library/Logs/debate-uploader.log.';
      case 'bad_token': return 'Helper restarted. Try again.';
      case 'no_room': return `No SpeechDrop room "${ctx.room}". Check the code.`;
      case 'bad_type':
      case 'no_file': return `SpeechDrop rejected the file: ${code}`;
      case 'too_large': return "File is over SpeechDrop's 10 MB limit.";
      case 'no_folder': return `Set your send doc folder first: run "${SET_FOLDER_LABEL}".`;
      case 'unreachable': return "Couldn't reach speechdrop.net. Upload not sent.";
      case 'upload_unknown':
      case 'unknown_job': return "SpeechDrop didn't answer after the upload started. Check the room before re-uploading.";
      case 'start_unknown': return `The upload may have started. Check room ${ctx.room} on SpeechDrop before re-uploading.`;
      case 'read_failed': return "Couldn't read that file. Pick it again.";
      case 'removed': return `"${ctx.name}" was removed from the room.`;
      case 'download_failed': return `Couldn't download "${ctx.name}".`;
      case 'still_running': return 'Still running in helper. Check SpeechDrop before re-uploading.';
      default: return `Upload failed: ${code}`;
    }
  }

  async function call(api, route, body) {
    const r = await api.flowPost(ID, route, body);
    if (!r.ok) throw new Error(r.error);
    if (r.status === 401) throw new Error('bad_token');
    if (r.body && r.body.ok === false) throw new Error(r.body.error);
    return r.body;
  }

  const MAX_POLL_FAILURES = 5;

  async function runJob(api, route, body, sleep) {
    let job;
    try {
      ({ job } = await call(api, route, body));
    } catch (err) {
      // A timeout or garbled reply may come after the helper started the job.
      if (err.message === 'timeout' || err.message === 'bad-response') throw new Error('start_unknown');
      throw err; // helper down / restarted / unsupported: nothing was sent
    }
    let failures = 0;
    for (let waited = 0; waited < MAX_WAIT_MS; waited += POLL_MS) {
      await sleep(POLL_MS);
      let s;
      try {
        s = await call(api, '/job', { id: job });
      } catch {
        if (++failures >= MAX_POLL_FAILURES) throw new Error('upload_unknown');
        continue;
      }
      failures = 0;
      if (s.state === 'done') return s.result;
      if (s.state === 'error') throw new Error(s.message);
    }
    throw new Error('still_running');
  }

  const domUI = {
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),

    prompt(labelText, initial) {
      return new Promise((resolve) => {
        const wrap = document.createElement('div');
        wrap.style.cssText = 'position:fixed;inset:0;z-index:99999;display:flex;align-items:flex-start;justify-content:center;padding-top:15vh;background:rgba(0,0,0,.25)';
        const box = document.createElement('div');
        box.style.cssText = 'background:#fff;color:#000;padding:14px 16px;border-radius:8px;font:14px system-ui;box-shadow:0 8px 30px rgba(0,0,0,.3)';
        const label = document.createElement('div');
        label.textContent = `${labelText} (Enter to confirm, Esc to cancel)`;
        label.style.marginBottom = '6px';
        const input = document.createElement('input');
        input.value = initial || '';
        input.style.cssText = 'width:320px;font:inherit;padding:4px 6px';
        box.append(label, input);
        wrap.append(box);
        document.body.append(wrap);
        const done = (value) => { wrap.remove(); resolve(value); };
        input.addEventListener('keydown', (e) => {
          e.stopPropagation(); // keep CardMirror hotkeys out of the box
          if (e.key === 'Enter') done(input.value);
          if (e.key === 'Escape') done(null);
        });
        wrap.addEventListener('mousedown', (e) => { if (e.target === wrap) done(null); });
        input.focus();
        input.select();
      });
    },

    showList(title, items, onPick) {
      return new Promise((resolve) => {
        const prev = document.activeElement;
        const wrap = document.createElement('div');
        wrap.tabIndex = -1;
        wrap.style.cssText = 'position:fixed;inset:0;z-index:99999;display:flex;align-items:flex-start;justify-content:center;padding-top:12vh;background:rgba(0,0,0,.25);outline:none';
        const box = document.createElement('div');
        box.style.cssText = 'background:#fff;color:#000;padding:12px 0;border-radius:8px;font:14px system-ui;box-shadow:0 8px 30px rgba(0,0,0,.3);width:420px';
        const head = document.createElement('div');
        head.style.cssText = 'padding:0 16px 8px;font-weight:600';
        head.textContent = title;
        const hint = document.createElement('div');
        hint.style.cssText = 'padding:0 16px 8px;color:#666;font-size:12px';
        hint.textContent = '↑↓ + Enter or click to open in CardMirror · Esc to close';
        const list = document.createElement('div');
        list.style.cssText = 'max-height:50vh;overflow:auto';
        let sel = 0;
        const rows = items.map((it, i) => {
          const row = document.createElement('div');
          row.style.cssText = 'padding:6px 16px;cursor:pointer;display:flex;justify-content:space-between;gap:12px';
          const label = document.createElement('span');
          label.textContent = it.label;
          const detail = document.createElement('span');
          detail.style.cssText = 'color:#666;white-space:nowrap';
          detail.textContent = it.detail;
          row.append(label, detail);
          row.addEventListener('mousedown', (e) => { e.preventDefault(); sel = i; paint(); onPick(i); });
          list.append(row);
          return row;
        });
        const paint = () => rows.forEach((r, i) => { r.style.background = i === sel ? '#dbe7ff' : ''; if (i === sel) r.scrollIntoView({ block: 'nearest' }); });
        const close = () => { wrap.remove(); if (prev && prev.focus) prev.focus(); resolve(); };
        // Capture phase + focus kept on the overlay: keys never reach the document.
        wrap.addEventListener('keydown', (e) => {
          e.stopPropagation();
          e.preventDefault();
          if (e.key === 'ArrowDown') { sel = Math.min(sel + 1, rows.length - 1); paint(); }
          else if (e.key === 'ArrowUp') { sel = Math.max(sel - 1, 0); paint(); }
          else if (e.key === 'Enter') onPick(sel);
          else if (e.key === 'Escape') close();
        }, true);
        wrap.addEventListener('mousedown', (e) => { if (e.target === wrap) close(); else e.preventDefault(); });
        box.append(head, hint, list);
        wrap.append(box);
        document.body.append(wrap);
        wrap.focus();
        paint();
      });
    },

    pickFile() {
      return new Promise((resolve) => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.docx,.doc,.pdf,.txt,.rtf,.odt';
        input.addEventListener('change', () => {
          const f = input.files && input.files[0];
          if (!f) return resolve(null);
          resolve({
            name: f.name,
            size: f.size,
            read: () => new Promise((res, rej) => {
              const fr = new FileReader();
              fr.onload = () => res(String(fr.result).split(',')[1] || '');
              fr.onerror = () => rej(fr.error);
              fr.readAsDataURL(f);
            }),
          });
        });
        input.addEventListener('cancel', () => resolve(null));
        input.click();
      });
    },
  };

  const ui = () => window.__debateUploaderUI || domUI;

  // Declared setting wins (installed plugins have a gear); storage covers
  // "Load plugin from file…", which gets no settings gear.
  const sendDocFolder = (api) =>
    String(api.settings.get('sendDocFolder') || '').trim() || String(api.storage.get('sendDocFolder') || '').trim();

  function normalizeRoom(raw) {
    const last = String(raw).trim().replace(/\/+$/, '').split('/').pop();
    return /^[A-Za-z0-9]{1,32}$/.test(last) ? last : null;
  }

  async function setFolder(api) {
    const raw = await ui().prompt('Send doc folder (where Save Send Doc writes)', api.storage.get('sendDocFolder') || '');
    if (raw == null) return;
    const folder = String(raw).trim();
    if (!folder) return;
    api.storage.set('sendDocFolder', folder);
    api.showToast(`Send doc folder set to ${folder}`);
  }

  let busy = false;

  async function uploadToSpeechDrop(api, mode) {
    if (busy) return api.showToast('An upload is already in progress.');
    busy = true;
    const ctx = { room: '' };
    try {
      await upload(api, mode, ctx);
    } catch (err) {
      api.showToast(message(err.message, ctx));
    } finally {
      busy = false;
    }
  }

  async function upload(api, mode, ctx) {
    const u = ui();
    const folder = mode === 'newest' ? sendDocFolder(api) : '';
    if (mode === 'newest' && !folder) return api.showToast(message('no_folder'));

    const raw = await u.prompt('SpeechDrop room code', api.storage.get('lastRoom') || '');
    if (raw == null) return;
    const room = normalizeRoom(raw);
    ctx.room = room;
    if (!room) return api.showToast(`"${String(raw).trim()}" doesn't look like a SpeechDrop room code.`);

    let body;
    if (mode === 'newest') {
      body = { room, folder };
    } else {
      const picked = await u.pickFile();
      if (!picked) return;
      if (picked.size > MAX_BYTES) return api.showToast(message('too_large'));
      let base64;
      try { base64 = await picked.read(); } catch { throw new Error('read_failed'); }
      body = { room, file: { name: picked.name, base64 } };
    }

    api.showToast(`Uploading to SpeechDrop room ${room}…`);
    const result = await runJob(api, '/speechdrop/upload', body, u.sleep);
    api.storage.set('lastRoom', room);
    api.showToast(`Uploaded "${result.name}" to SpeechDrop room ${result.room}`);
  }

  function formatTime(ms) {
    const d = new Date(ms);
    return Number.isFinite(d.getTime())
      ? d.toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })
      : 'unknown time';
  }

  async function browse(api) {
    const u = ui();
    const ctx = { browse: true, room: '' };
    try {
      const raw = await u.prompt('SpeechDrop room code', api.storage.get('lastRoom') || '');
      if (raw == null) return;
      const room = normalizeRoom(raw);
      ctx.room = room;
      if (!room) return api.showToast(`"${String(raw).trim()}" doesn't look like a SpeechDrop room code.`);
      const files = await runJob(api, '/speechdrop/list', { room }, u.sleep);
      if (!files.length) return api.showToast(`Room ${room} has no files yet.`);
      api.storage.set('lastRoom', room);
      const items = files.map((f) => ({ label: f.name, detail: formatTime(f.ctime) }));
      await u.showList(`SpeechDrop room ${room}`, items, async (i) => {
        const f = files[i];
        api.showToast(`Opening "${f.name}"…`);
        try {
          const r = await runJob(api, '/speechdrop/open', { room, index: f.index, name: f.name }, u.sleep);
          api.showToast(`Opened "${r.name}" in ${r.app === 'CardMirror' ? 'CardMirror' : 'your default app'}`);
        } catch (err) {
          api.showToast(message(err.message, { ...ctx, name: f.name }));
        }
      });
    } catch (err) {
      api.showToast(message(err.message, ctx));
    }
  }

  window.__registerCardMirrorPlugin && window.__registerCardMirrorPlugin({
    id: ID,
    name: 'Debate Uploader',
    apiVersion: 1,
    settings: [
      {
        key: 'sendDocFolder',
        label: 'Send doc folder',
        type: 'text',
        default: '',
        description: 'Folder where Save Send Doc writes. "Upload newest send doc" sends the newest .docx in it.',
      },
    ],
    commands: [
      {
        id: `${ID}.sdNewest`,
        label: 'Upload newest send doc to SpeechDrop',
        keywords: ['speechdrop', 'upload', 'send doc', 'drop'],
        defaultKey: null,
        run: (api) => uploadToSpeechDrop(api, 'newest'),
      },
      {
        id: `${ID}.sdPick`,
        label: 'Upload file to SpeechDrop…',
        keywords: ['speechdrop', 'upload', 'file', 'drop'],
        defaultKey: null,
        run: (api) => uploadToSpeechDrop(api, 'pick'),
      },
      {
        id: `${ID}.sdBrowse`,
        label: 'Browse SpeechDrop room…',
        keywords: ['speechdrop', 'browse', 'open', 'download', 'room'],
        defaultKey: null,
        run: (api) => browse(api),
      },
      {
        id: `${ID}.setFolder`,
        label: SET_FOLDER_LABEL,
        keywords: ['speechdrop', 'send doc', 'folder'],
        defaultKey: null,
        run: (api) => setFolder(api),
      },
    ],
  });
})();
