// Debate Uploader: CardMirror plugin (API v1). Classic script: no imports.
// All network work happens in the local helper (helper.mjs) via api.flowPost.
(() => {
  const ID = 'debate-uploader';
  const MAX_BYTES = 10 * 1024 * 1024;
  const POLL_MS = 1000;
  const MAX_WAIT_MS = 90_000;
  const REFRESH_MS = 5000;
  const START_HELPER = 'launchctl kickstart gui/$(id -u)/debate-uploader';
  const SET_FOLDER_LABEL = 'Set send doc folder for SpeechDrop…';

  function message(code, ctx = {}) {
    // Browsing only reads, so a slow helper there is a plain "try again".
    if (ctx.browse && ['start_unknown', 'upload_unknown', 'unknown_job', 'still_running'].includes(code)) {
      return "The helper didn't answer in time. Try again.";
    }
    if (ctx.tabroom) {
      switch (code) {
        case 'bad_login': return 'Tabroom rejected that email or password.';
        case 'not_logged_in': return 'Not logged in to Tabroom. Run "Log in to Tabroom…".';
        case 'login_expired': return 'Tabroom login expired. Run "Log in to Tabroom…".';
        case 'keychain_failed': return "Couldn't use Keychain. Is it locked?";
        case 'unreachable': return "Couldn't reach Tabroom. Try again.";
        case 'start_unknown':
        case 'upload_unknown':
        case 'unknown_job':
        case 'still_running': return "Tabroom didn't answer in time. Try again.";
        case 'app-not-running':
        case 'no-such-app':
        case 'timeout':
        case 'unsupported':
        case 'bad-response':
        case 'bad_token': break; // fall through to the shared helper messages below
        default: return `Tabroom error: ${code}`;
      }
    }
    if (ctx.caselist) {
      if (code.startsWith('caselist_rejected:')) return `The caselist rejected the upload: ${code.slice('caselist_rejected:'.length)}`;
      switch (code) {
        case 'not_logged_in': return 'Not logged in to Tabroom. Run "Log in to Tabroom…".';
        case 'login_expired': return 'Tabroom login expired. Run "Log in to Tabroom…".';
        case 'keychain_failed': return "Couldn't use Keychain. Is it locked?";
        case 'unreachable': return "Couldn't reach openCaselist. Try again.";
        case 'bad_round': return 'Tournament, side and round are required.';
        case 'too_large': return 'File is over the 10 MB upload limit.';
        case 'newest_changed': return 'The newest send doc changed after the form opened. Run Upload to Caselist again to check it.';
        case 'start_unknown':
        case 'upload_unknown':
        case 'unknown_job':
        case 'still_running':
          return ctx.uploading
            ? "The caselist didn't confirm the upload. Check your team's caselist page before uploading again."
            : "openCaselist didn't answer in time. Try again.";
        default: break; // shared messages below (helper down, no_folder, read_failed, …)
      }
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

    prompt(labelText, initial, opts = {}) {
      return new Promise((resolve) => {
        const wrap = document.createElement('div');
        wrap.style.cssText = 'position:fixed;inset:0;z-index:99999;display:flex;align-items:flex-start;justify-content:center;padding-top:15vh;background:rgba(0,0,0,.25)';
        const box = document.createElement('div');
        box.style.cssText = 'background:#fff;color:#000;padding:14px 16px;border-radius:8px;font:14px system-ui;box-shadow:0 8px 30px rgba(0,0,0,.3)';
        const label = document.createElement('div');
        label.textContent = `${labelText} (Enter to confirm, Esc to cancel)`;
        label.style.marginBottom = '6px';
        const input = document.createElement('input');
        if (opts.secret) input.type = 'password';
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

    // Returns { closed: Promise, update(items, status) }. Items carry a
    // stable `key`, so the selection follows its file across refreshes.
    showList(title, initialItems, onPick, opts = {}) {
      let resolveClosed;
      const closed = new Promise((r) => { resolveClosed = r; });
      const prev = document.activeElement;
      const HINT = '↑↓ + Enter or click to open · Esc to close · refreshes every 5 s';
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
      hint.textContent = opts.hint || HINT;
      const list = document.createElement('div');
      list.style.cssText = 'max-height:50vh;overflow:auto';
      let items = [];
      let rows = [];
      let selKey = null;
      const selIndex = () => Math.max(0, items.findIndex((it) => it.key === selKey));
      const paint = () => rows.forEach((r, i) => {
        const on = items[i].key === selKey;
        r.style.background = on ? '#dbe7ff' : '';
        if (on) r.scrollIntoView({ block: 'nearest' });
      });
      const render = () => {
        list.textContent = '';
        rows = [];
        if (!items.length) {
          const empty = document.createElement('div');
          empty.style.cssText = 'padding:6px 16px;color:#666';
          empty.textContent = 'No files yet. Waiting for uploads…';
          list.append(empty);
          return;
        }
        if (!items.some((it) => it.key === selKey)) selKey = items[0].key;
        rows = items.map((it) => {
          const row = document.createElement('div');
          row.style.cssText = `padding:6px 16px;cursor:pointer;display:flex;gap:${opts.stacked ? '2px' : '12px'};${opts.stacked ? 'flex-direction:column' : 'justify-content:space-between'}`;
          const label = document.createElement('span');
          label.textContent = it.label;
          if (it.isNew) {
            const badge = document.createElement('span');
            badge.textContent = ' new';
            badge.style.cssText = 'color:#0a7d32;font-weight:600;font-size:12px';
            label.append(badge);
          }
          const detail = document.createElement('span');
          detail.style.cssText = `color:#666;${opts.stacked ? 'font-size:12px' : 'white-space:nowrap'}`;
          detail.textContent = it.detail;
          row.append(label, detail);
          row.addEventListener('mousedown', (e) => { e.preventDefault(); selKey = it.key; paint(); onPick(it); });
          list.append(row);
          return row;
        });
        paint();
      };
      const close = () => { wrap.remove(); if (prev && prev.focus) prev.focus(); resolveClosed(); };
      // Capture phase + focus kept on the overlay: keys never reach the document.
      wrap.addEventListener('keydown', (e) => {
        e.stopPropagation();
        e.preventDefault();
        if (e.key === 'Escape') return close();
        if (!items.length) return;
        if (e.key === 'ArrowDown') { selKey = items[Math.min(selIndex() + 1, items.length - 1)].key; paint(); }
        else if (e.key === 'ArrowUp') { selKey = items[Math.max(selIndex() - 1, 0)].key; paint(); }
        else if (e.key === 'Enter') onPick(items[selIndex()]);
      }, true);
      wrap.addEventListener('mousedown', (e) => { if (e.target === wrap) close(); else e.preventDefault(); });
      box.append(head, hint, list);
      wrap.append(box);
      document.body.append(wrap);
      wrap.focus();
      items = initialItems;
      render();
      return {
        closed,
        update(next, status) {
          items = next;
          hint.textContent = status || opts.hint || HINT;
          render();
        },
      };
    },

    // Filterable single-select. Resolves with the chosen index, or null.
    choose(title, labels) {
      return new Promise((resolve) => {
        const prev = document.activeElement;
        const wrap = document.createElement('div');
        wrap.style.cssText = 'position:fixed;inset:0;z-index:99999;display:flex;align-items:flex-start;justify-content:center;padding-top:12vh;background:rgba(0,0,0,.25)';
        const box = document.createElement('div');
        box.style.cssText = 'background:#fff;color:#000;padding:12px 0;border-radius:8px;font:14px system-ui;box-shadow:0 8px 30px rgba(0,0,0,.3);width:420px';
        const head = document.createElement('div');
        head.style.cssText = 'padding:0 16px 8px;font-weight:600';
        head.textContent = title;
        const input = document.createElement('input');
        input.placeholder = 'Type to filter · ↑↓ + Enter to choose · Esc to cancel';
        input.style.cssText = 'margin:0 16px 8px;width:calc(100% - 32px);box-sizing:border-box;font:inherit;padding:4px 6px';
        const list = document.createElement('div');
        list.style.cssText = 'max-height:50vh;overflow:auto';
        let shown = [];
        let sel = 0;
        const done = (value) => { wrap.remove(); if (prev && prev.focus) prev.focus(); resolve(value); };
        const render = () => {
          const q = input.value.trim().toLowerCase();
          shown = labels.map((l, i) => i).filter((i) => labels[i].toLowerCase().includes(q));
          sel = Math.min(sel, Math.max(shown.length - 1, 0));
          list.textContent = '';
          shown.forEach((idx, pos) => {
            const row = document.createElement('div');
            row.textContent = labels[idx];
            row.style.cssText = `padding:6px 16px;cursor:pointer;${pos === sel ? 'background:#dbe7ff' : ''}`;
            row.addEventListener('mousedown', (e) => { e.preventDefault(); done(idx); });
            list.append(row);
            if (pos === sel) row.scrollIntoView({ block: 'nearest' });
          });
        };
        input.addEventListener('input', () => { sel = 0; render(); });
        input.addEventListener('keydown', (e) => {
          e.stopPropagation();
          if (e.key === 'ArrowDown') { e.preventDefault(); sel = Math.min(sel + 1, shown.length - 1); render(); }
          else if (e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(sel - 1, 0); render(); }
          else if (e.key === 'Enter') { e.preventDefault(); if (shown.length) done(shown[sel]); }
          else if (e.key === 'Escape') { e.preventDefault(); done(null); }
        });
        wrap.addEventListener('mousedown', (e) => { if (e.target === wrap) done(null); });
        box.append(head, input, list);
        wrap.append(box);
        document.body.append(wrap);
        render();
        input.focus();
      });
    },

    // Upload form. Resolves with the field values, or null on Cancel/Esc.
    form(spec) {
      return new Promise((resolve) => {
        const prev = document.activeElement;
        const wrap = document.createElement('div');
        wrap.style.cssText = 'position:fixed;inset:0;z-index:99999;display:flex;align-items:flex-start;justify-content:center;padding-top:8vh;background:rgba(0,0,0,.25)';
        const box = document.createElement('div');
        box.style.cssText = 'background:#fff;color:#000;padding:14px 16px;border-radius:8px;font:14px system-ui;box-shadow:0 8px 30px rgba(0,0,0,.3);width:460px;display:grid;grid-template-columns:110px 1fr;gap:8px 10px;align-items:center';
        const done = (value) => { wrap.remove(); if (prev && prev.focus) prev.focus(); resolve(value); };
        const add = (labelText, control) => {
          const l = document.createElement('label');
          l.textContent = labelText;
          box.append(l, control);
          return control;
        };
        const head = document.createElement('div');
        head.textContent = spec.title;
        head.style.cssText = 'grid-column:1/3;font-weight:600';
        box.append(head);
        const fill = document.createElement('select');
        fill.append(new Option('Enter manually', ''));
        spec.choices.forEach((c, i) => fill.append(new Option(c.label, String(i))));
        add('Fill from Tabroom', fill);
        const text = (key) => {
          const inp = document.createElement('input');
          inp.value = spec.fields[key] || '';
          inp.style.cssText = 'font:inherit;padding:4px 6px';
          return inp;
        };
        const tournament = add('Tournament', text('tournament'));
        const side = document.createElement('select');
        side.append(new Option('Choose…', ''), new Option(spec.sideLabels.A, 'A'), new Option(spec.sideLabels.N, 'N'));
        side.value = spec.fields.side || '';
        add('Side', side);
        const round = add('Round', text('round'));
        const opponent = add('Opponent', text('opponent'));
        const judge = add('Judge', text('judge'));
        const report = document.createElement('textarea');
        report.rows = 2;
        report.value = spec.fields.report || '';
        report.style.cssText = 'font:inherit;padding:4px 6px';
        add('Report (optional)', report);
        const fileMode = document.createElement('select');
        fileMode.append(new Option(spec.newestLabel, 'newest'), new Option('Pick a file…', 'pick'));
        fileMode.value = spec.fileMode;
        add('File', fileMode);
        fill.addEventListener('change', () => {
          const c = spec.choices[Number(fill.value)];
          if (!c) return;
          tournament.value = c.fields.tournament;
          side.value = c.fields.side;
          round.value = c.fields.round;
          opponent.value = c.fields.opponent;
          judge.value = c.fields.judge;
        });
        const err = document.createElement('div');
        err.style.cssText = 'grid-column:1/3;color:#c00;min-height:1em';
        const buttons = document.createElement('div');
        buttons.style.cssText = 'grid-column:1/3;display:flex;justify-content:flex-end;gap:8px';
        const cancel = document.createElement('button');
        cancel.textContent = 'Cancel';
        const upload = document.createElement('button');
        upload.textContent = 'Upload';
        buttons.append(cancel, upload);
        box.append(err, buttons);
        const submit = () => {
          if (!tournament.value.trim() || !side.value || !round.value.trim()) {
            err.textContent = 'Tournament, side and round are required.';
            return;
          }
          done({
            tournament: tournament.value, side: side.value, round: round.value, opponent: opponent.value,
            judge: judge.value, report: report.value, fileMode: fileMode.value,
          });
        };
        cancel.addEventListener('click', () => done(null));
        upload.addEventListener('click', submit);
        box.addEventListener('keydown', (e) => {
          e.stopPropagation(); // keep CardMirror hotkeys out of the form
          if (e.key === 'Escape') { e.preventDefault(); done(null); }
          // Enter submits only from a text box: Enter on a dropdown must never post publicly.
          if (e.key === 'Enter' && e.target.tagName === 'INPUT') { e.preventDefault(); submit(); }
        });
        wrap.addEventListener('mousedown', (e) => { if (e.target === wrap) done(null); });
        wrap.append(box);
        document.body.append(wrap);
        fill.focus();
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
      let files = await runJob(api, '/speechdrop/list', { room }, u.sleep);
      api.storage.set('lastRoom', room);
      const seen = new Set(files.map((f) => f.index));
      const toItems = () => files.map((f) => ({ key: f.index, label: f.name, detail: formatTime(f.ctime), isNew: !seen.has(f.index) }));
      const view = u.showList(`SpeechDrop room ${room}`, toItems(), async (item) => {
        const f = files.find((x) => x.index === item.key);
        if (!f) return api.showToast(message('removed', { name: item.label }));
        api.showToast(`Opening "${f.name}"…`);
        try {
          const r = await runJob(api, '/speechdrop/open', { room, index: f.index, name: f.name }, u.sleep);
          api.showToast(`Opened "${r.name}" in ${r.app === 'CardMirror' ? 'CardMirror' : 'your default app'}`);
        } catch (err) {
          api.showToast(message(err.message, { ...ctx, name: f.name }));
        }
      });
      let open = true;
      view.closed.then(() => { open = false; });
      while (open) {
        await u.sleep(REFRESH_MS);
        if (!open) break;
        try {
          const next = await runJob(api, '/speechdrop/list', { room }, u.sleep);
          if (!open) break;
          files = next;
          view.update(toItems(), '');
        } catch {
          if (open) view.update(toItems(), "Couldn't refresh, retrying…");
        }
      }
    } catch (err) {
      api.showToast(message(err.message, ctx));
    }
  }

  async function tabroomLogin(api) {
    const u = ui();
    try {
      const rawEmail = await u.prompt('Tabroom email', api.storage.get('tabroomEmail') || '');
      const email = rawEmail == null ? '' : String(rawEmail).trim();
      if (!email) return;
      const password = await u.prompt('Tabroom password', '', { secret: true });
      if (!password) return;
      api.showToast('Logging in to Tabroom…');
      await runJob(api, '/tabroom/login', { username: email, password }, u.sleep);
      api.storage.set('tabroomEmail', email);
      api.showToast('Logged in to Tabroom.');
    } catch (err) {
      api.showToast(message(err.message, { tabroom: true }));
    }
  }

  async function tabroomLogout(api) {
    try {
      await call(api, '/tabroom/logout', {});
      api.showToast('Logged out of Tabroom.');
    } catch (err) {
      api.showToast(message(err.message, { tabroom: true }));
    }
  }

  async function tabroomRounds(api) {
    const u = ui();
    try {
      const { current, rounds } = await runJob(api, '/tabroom/rounds', {}, u.sleep);
      if (!rounds.length) return api.showToast('No rounds. Is your Tabroom account linked to your student record?');
      const items = rounds.map((r, i) => ({
        key: r.id ?? i,
        label: `${r.tournament} · ${r.round}`,
        detail: [
          r.side && `${r.side} vs ${r.opponent || 'TBA'}`,
          r.judge && `judge ${r.judge}`,
          r.start_time ? formatTime(Date.parse(r.start_time)) : '',
        ].filter(Boolean).join(' · '),
      }));
      const view = u.showList(current ? 'Tabroom: current rounds' : 'Tabroom: recent rounds', items, () => {}, { hint: 'Esc to close', stacked: true });
      await view.closed;
    } catch (err) {
      api.showToast(message(err.message, { tabroom: true }));
    }
  }

  const sideNorm = (s) => {
    const v = String(s ?? '').trim().toLowerCase();
    if (['a', 'aff', 'pro'].includes(v)) return 'A';
    if (['n', 'neg', 'con'].includes(v)) return 'N';
    return '';
  };
  const roundName = (r) => (/^\d+$/.test(String(r ?? '')) ? `Round ${r}` : String(r ?? ''));

  function roundChoices(rounds, sideLabels) {
    const choices = rounds.map((r) => {
      const side = sideNorm(r.side);
      return {
        label: [r.tournament, roundName(r.round), side ? `${sideLabels[side]} vs ${r.opponent || 'TBA'}` : ''].filter(Boolean).join(' · '),
        fields: { tournament: r.tournament || '', side, round: String(r.round ?? ''), opponent: r.opponent || '', judge: r.judge || '', report: '' },
      };
    });
    choices.push({
      label: 'General disclosure (all tournaments)',
      fields: { tournament: 'All Tournaments', side: '', round: 'All', opponent: '', judge: '', report: '' },
    });
    return choices;
  }

  async function chooseTarget(api, u) {
    const caselists = await runJob(api, '/caselist/caselists', {}, u.sleep);
    if (!caselists.length) { api.showToast('No caselists are open right now.'); return null; }
    const ci = await u.choose('Pick a caselist', caselists.map((c) => c.label));
    if (ci == null) return null;
    const c = caselists[ci];
    const schools = await runJob(api, '/caselist/schools', { caselist: c.name }, u.sleep);
    if (!schools.length) { api.showToast(`No schools on ${c.label} yet. Create yours on opencaselist.com first.`); return null; }
    const si = await u.choose(`${c.label}: pick your school`, schools.map((s) => s.label));
    if (si == null) return null;
    const s = schools[si];
    const teams = await runJob(api, '/caselist/teams', { caselist: c.name, school: s.name }, u.sleep);
    if (!teams.length) { api.showToast(`No teams for ${s.label} on ${c.label} yet. Create yours on opencaselist.com first.`); return null; }
    const ti = await u.choose(`${s.label}: pick your team`, teams.map((t) => t.label));
    if (ti == null) return null;
    const t = teams[ti];
    const target = { caselist: c.name, caselistLabel: c.label, event: c.event || '', school: s.name, schoolLabel: s.label, team: t.name, teamLabel: t.label };
    api.storage.set('caselistTarget', target);
    api.showToast(`Caselist team set to ${c.label} · ${s.label} · ${t.label}`);
    return target;
  }

  async function caselistTeam(api) {
    try {
      await chooseTarget(api, ui());
    } catch (err) {
      api.showToast(message(err.message, { caselist: true }));
    }
  }

  async function caselistUpload(api) {
    if (busy) return api.showToast('An upload is already in progress.');
    busy = true;
    const ctx = { caselist: true, uploading: false };
    try {
      await caselistFlow(api, ctx);
    } catch (err) {
      api.showToast(message(err.message, ctx));
    } finally {
      busy = false;
    }
  }

  async function caselistFlow(api, ctx) {
    const u = ui();
    const target = api.storage.get('caselistTarget') || (await chooseTarget(api, u));
    if (!target) return;
    let rounds = [];
    try {
      rounds = (await runJob(api, '/tabroom/rounds', {}, u.sleep)).rounds;
    } catch (err) {
      // Login problems stop here (the upload would fail too); anything else falls back to manual entry.
      if (['not_logged_in', 'login_expired', 'keychain_failed'].includes(err.message)) throw err;
    }
    // Name the actual newest send doc in the form, so a public upload is never a surprise.
    const folder = sendDocFolder(api);
    let newest = null;
    let newestErr = 'no_folder';
    if (folder) {
      try { newest = await call(api, '/caselist/newest', { folder }); } catch (err) { newestErr = err.message; }
    }
    const newestLabel = newest
      ? `Newest send doc: ${newest.name} (${formatTime(newest.mtime)})`
      : folder ? 'Newest send doc (none found)' : 'Newest send doc (set a send doc folder first)';
    const pf = /pf|public forum/i.test(`${target.event} ${target.caselistLabel}`);
    const sideLabels = pf ? { A: 'Pro', N: 'Con' } : { A: 'Aff', N: 'Neg' };
    const values = await u.form({
      title: `Upload to ${target.caselistLabel} · ${target.schoolLabel} · ${target.teamLabel}`,
      choices: roundChoices(rounds, sideLabels),
      sideLabels,
      fields: { tournament: '', side: '', round: '', opponent: '', judge: '', report: '' },
      newestLabel,
      fileMode: newest ? 'newest' : 'pick',
    });
    if (!values) return;
    const round = {
      tournament: String(values.tournament || '').trim(),
      side: sideNorm(values.side),
      round: String(values.round || '').trim(),
      opponent: String(values.opponent || '').trim(),
      judge: String(values.judge || '').trim(),
      report: String(values.report || '').trim(),
    };
    if (!round.tournament || !round.side || !round.round) throw new Error('bad_round');
    const body = { caselist: target.caselist, school: target.school, team: target.team, round };
    if (values.fileMode === 'pick') {
      const picked = await u.pickFile();
      if (!picked) return;
      if (picked.size > MAX_BYTES) throw new Error('too_large');
      let base64;
      try { base64 = await picked.read(); } catch { throw new Error('read_failed'); }
      body.file = { name: picked.name, base64 };
    } else {
      if (!newest) throw new Error(newestErr);
      if (newest.size > MAX_BYTES) throw new Error('too_large');
      body.folder = folder;
      body.expectName = newest.name;
    }
    ctx.uploading = true;
    api.showToast('Uploading to the caselist…');
    const r = await runJob(api, '/caselist/upload', body, u.sleep);
    api.showToast(`Uploaded "${r.name}" to ${target.caselistLabel} · ${target.schoolLabel} · ${target.teamLabel}`);
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
      {
        id: `${ID}.tabroomLogin`,
        label: 'Log in to Tabroom…',
        keywords: ['tabroom', 'caselist', 'login', 'sign in'],
        defaultKey: null,
        run: (api) => tabroomLogin(api),
      },
      {
        id: `${ID}.tabroomLogout`,
        label: 'Log out of Tabroom',
        keywords: ['tabroom', 'caselist', 'logout', 'sign out'],
        defaultKey: null,
        run: (api) => tabroomLogout(api),
      },
      {
        id: `${ID}.tabroomRounds`,
        label: 'Show my Tabroom rounds',
        keywords: ['tabroom', 'rounds', 'pairings', 'opponent', 'judge'],
        defaultKey: null,
        run: (api) => tabroomRounds(api),
      },
      {
        id: `${ID}.caselistUpload`,
        label: 'Upload to Caselist…',
        keywords: ['caselist', 'opencaselist', 'disclose', 'disclosure', 'upload', 'open source'],
        defaultKey: null,
        run: (api) => caselistUpload(api),
      },
      {
        id: `${ID}.caselistTeam`,
        label: 'Change caselist team…',
        keywords: ['caselist', 'opencaselist', 'team', 'school'],
        defaultKey: null,
        run: (api) => caselistTeam(api),
      },
    ],
  });
})();
