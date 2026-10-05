// Debate Uploader: CardMirror plugin (API v1). Classic script: no imports.
// All network work happens in the local helper (helper.mjs) via api.flowPost.
(() => {
  const ID = 'debate-uploader';
  const MAX_BYTES = 10 * 1024 * 1024;
  const POLL_WAIT_MS = 1000; // the helper holds each status check up to this long (long-poll)
  const MAX_POLLS = 90;
  const START_HELPER = 'launchctl kickstart gui/$(id -u)/debate-uploader';
  const SET_FOLDER_LABEL = 'Set send doc folder for SpeechDrop…';

  function message(code, ctx = {}) {
    // Browsing only reads, so a slow helper there is a plain "try again".
    if (ctx.browse && ['start_unknown', 'upload_unknown', 'unknown_job', 'still_running'].includes(code)) {
      return "The helper didn't answer in time. Try again.";
    }
    if (ctx.browse && code === 'unreachable') return "Couldn't reach speechdrop.net. Try again.";
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
        case 'removed': return "That round's file is no longer on the caselist.";
        case 'bad_name': return `Couldn't download "${ctx.name}".`;
        case 'newest_changed': return 'The newest send doc changed after the form opened. Run Upload to Caselist again to check it.';
        case 'start_unknown':
        case 'upload_unknown':
        case 'unknown_job':
        case 'still_running':
          return ctx.uploading
            ? "The caselist didn't confirm the upload. Check your team's caselist page before uploading again."
            : "openCaselist didn't answer in time. Try again.";
        default:
          // Scouting only reads: never let an unknown code read as "Upload failed".
          if (ctx.scouting && !['app-not-running', 'no-such-app', 'timeout', 'unsupported', 'bad-response', 'bad_token', 'download_failed'].includes(code)) {
            return `Couldn't load from openCaselist (${code}).`;
          }
          break; // shared messages below (helper down, no_folder, read_failed, …)
      }
    }
    if (ctx.evidence) {
      if (code.startsWith('no_folder:')) return `No folder at ${code.slice('no_folder:'.length)}.`;
      switch (code) {
        case 'no_folder': return 'Enter at least one folder.';
        case 'not_indexed': return 'That file is no longer in the index. Search again.';
        case 'card_changed': return 'That file changed since it was indexed. Re-indexing now; search again in a moment.';
        case 'bad_name': return "Couldn't save the card as its own file.";
        default: break;
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

  // CardMirror wipes a file-loaded plugin's storage at every launch, so settings are
  // mirrored to the helper and restored before each command.
  const PREF_KEYS = ['caselistTarget', 'scoutCaselist', 'sendDocFolder', 'lastRoom', 'tabroomEmail'];
  const restored = new WeakSet();
  async function restorePrefs(api) {
    if (restored.has(api)) return;
    try {
      const r = await api.flowPost(ID, '/prefs/get', {});
      const prefs = r && r.ok && r.body && r.body.prefs;
      if (!prefs) return;
      for (const k of PREF_KEYS) if (prefs[k] != null && api.storage.get(k) == null) api.storage.set(k, prefs[k]);
      restored.add(api);
    } catch {
      // helper down: the command itself will say so
    }
  }
  function remember(api, key, value) {
    api.storage.set(key, value);
    Promise.resolve().then(() => api.flowPost(ID, '/prefs/set', { key, value })).catch(() => {});
  }
  const withPrefs = async (api, fn) => { await restorePrefs(api); return fn(); };

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
    for (let polls = 0; polls < MAX_POLLS; polls++) {
      const asked = Date.now();
      let s;
      try {
        s = await call(api, '/job', { id: job, waitMs: POLL_WAIT_MS });
      } catch {
        if (++failures >= MAX_POLL_FAILURES) throw new Error('upload_unknown');
        await sleep(250);
        continue;
      }
      failures = 0;
      if (s.state === 'done') return s.result;
      if (s.state === 'error') throw new Error(s.message);
      if (Date.now() - asked < 100) await sleep(250); // an older helper answers at once: don't spin
    }
    throw new Error('still_running');
  }

  // ---------------------------------------------------------------- UI layer
  // Every color, font and shadow comes from CardMirror's own --pmd-* tokens,
  // so the overlays follow its light/dark theme and look built-in.
  const CSS = `
.du-scrim{position:fixed;inset:0;z-index:99999;display:flex;align-items:flex-start;justify-content:center;
  padding:11vh 16px 16px;background:var(--pmd-c-overlay,rgba(0,0,0,.4));font-family:var(--pmd-ui-font,system-ui,sans-serif)}
.du-dialog{box-sizing:border-box;width:min(var(--du-w,520px),100%);max-height:80vh;display:flex;flex-direction:column;
  background:var(--pmd-c-bg);color:var(--pmd-c-text);border:1px solid var(--pmd-c-border-soft);border-radius:10px;
  box-shadow:0 18px 50px var(--pmd-c-shadow-deep,rgba(0,0,0,.28));overflow:hidden;outline:none;
  animation:du-in .18s cubic-bezier(.25,1,.5,1)}
@keyframes du-in{from{opacity:0;transform:translateY(6px)}}
@media (prefers-reduced-motion:reduce){.du-dialog{animation:none}}
.du-dialog *{box-sizing:border-box}
.du-head{padding:16px 20px 10px}
.du-title{margin:0;font-size:1.05rem;font-weight:600;line-height:1.3}
.du-sub{margin:3px 0 0;font-size:.82rem;line-height:1.35;color:var(--pmd-c-text-muted);overflow-wrap:anywhere}
.du-body{padding:6px 20px 18px;overflow:auto;min-height:0}
.du-foot{display:flex;align-items:center;gap:8px;padding:11px 20px;border-top:1px solid var(--pmd-c-divider);background:var(--pmd-c-bg-soft)}
.du-note{flex:1;min-width:0;display:flex;align-items:center;gap:7px;font-size:.8rem;color:var(--pmd-c-text-muted);
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.du-note.du-warn{color:var(--pmd-c-warning)}
.du-dot{flex:none;width:7px;height:7px;border-radius:50%;background:var(--pmd-c-success)}
.du-field{display:flex;flex-direction:column;gap:5px;min-width:0}
.du-label{font-size:.8rem;font-weight:500;color:var(--pmd-c-text-secondary)}
.du-input{width:100%;min-width:0;font:inherit;font-size:.9rem;line-height:1.35;padding:7px 10px;border:1px solid var(--pmd-c-border);
  border-radius:6px;background:var(--pmd-c-bg);color:var(--pmd-c-text)}
.du-input::placeholder{color:var(--pmd-c-text-faint)}
.du-input:focus{outline:none;border-color:var(--pmd-c-focus);box-shadow:0 0 0 3px var(--pmd-c-accent-soft)}
textarea.du-input{resize:vertical;min-height:3.4em}
.du-grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:14px 12px}
.du-span{grid-column:1/-1}
.du-fill{margin:4px 0 18px;padding:12px;border-radius:8px;background:var(--pmd-c-bg-soft);border:1px solid var(--pmd-c-divider)}
.du-seg{display:flex;min-width:0;border:1px solid var(--pmd-c-border);border-radius:6px;overflow:hidden}
.du-seg button{flex:1;min-width:0;font:inherit;font-size:.9rem;line-height:1.35;padding:7px 10px;border:0;
  background:var(--pmd-c-bg);color:var(--pmd-c-text);cursor:pointer}
.du-seg button+button{border-left:1px solid var(--pmd-c-border)}
.du-seg button:hover{background:var(--pmd-c-hover)}
.du-seg button[aria-pressed="true"]{background:var(--pmd-c-accent);color:var(--pmd-c-text-on-accent);font-weight:600}
.du-seg button:focus-visible{outline:2px solid var(--pmd-c-focus);outline-offset:-2px}
.du-choices{display:flex;flex-direction:column;gap:6px}
.du-choice{display:flex;align-items:center;gap:10px;width:100%;min-width:0;text-align:left;font:inherit;font-size:.9rem;
  padding:8px 10px;border:1px solid var(--pmd-c-border);border-radius:6px;background:var(--pmd-c-bg);color:var(--pmd-c-text);cursor:pointer}
.du-choice:hover{background:var(--pmd-c-hover)}
.du-choice[aria-checked="true"]{border-color:var(--pmd-c-accent);background:var(--pmd-c-accent-soft)}
.du-choice:focus-visible{outline:2px solid var(--pmd-c-focus);outline-offset:1px}
.du-choice[aria-disabled="true"]{opacity:.55;cursor:default}
.du-radio{flex:none;width:14px;height:14px;border-radius:50%;border:1.5px solid var(--pmd-c-border)}
.du-choice[aria-checked="true"] .du-radio{border:4px solid var(--pmd-c-accent)}
.du-choice-text{flex:1;min-width:0;display:flex;flex-direction:column;gap:1px}
.du-choice-main{font-weight:500}
.du-choice-detail{color:var(--pmd-c-text-muted);font-size:.82rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.du-choice-detail:empty{display:none}
.du-btn{flex:none;font:inherit;font-size:.88rem;line-height:1.3;padding:7px 14px;border-radius:6px;border:1px solid var(--pmd-c-border-soft);
  background:var(--pmd-c-bg);color:var(--pmd-c-text);cursor:pointer}
.du-btn:hover{background:var(--pmd-c-hover)}
.du-btn:focus-visible{outline:2px solid var(--pmd-c-accent);outline-offset:2px}
.du-primary{background:var(--pmd-c-accent);border-color:var(--pmd-c-accent);color:var(--pmd-c-text-on-accent);font-weight:600}
.du-primary:hover{background:var(--pmd-c-accent-hover)}
.du-error{margin:12px 0 0;font-size:.82rem;color:var(--pmd-c-error)}
.du-error:empty{display:none}
.du-search{display:block;margin:0 20px 10px;width:calc(100% - 40px)}
.du-list{overflow:auto;min-height:0;max-height:52vh;padding:0 8px 8px}
.du-row{display:flex;align-items:baseline;gap:12px;padding:8px 12px;border-radius:6px;cursor:pointer}
.du-row:hover{background:var(--pmd-c-hover)}
.du-row[aria-selected="true"]{background:var(--pmd-c-accent-soft)}
.du-row-main{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:.92rem}
.du-row-detail{flex:none;color:var(--pmd-c-text-muted);font-size:.82rem;white-space:nowrap;font-variant-numeric:tabular-nums}
.du-stacked .du-row{flex-direction:column;align-items:stretch;gap:2px}
.du-stacked .du-row-detail{white-space:normal}
.du-new{margin-left:8px;font-size:.72rem;font-weight:600;letter-spacing:.02em;color:var(--pmd-c-success)}
.du-empty{padding:22px 12px;text-align:center;font-size:.88rem;color:var(--pmd-c-text-muted)}
.du-tabs{margin-top:12px;width:max-content}
.du-filters{display:flex;align-items:center;flex-wrap:wrap;gap:8px 10px;margin-top:10px}
.du-filters select.du-input{width:auto;min-width:200px;max-width:100%;padding:5px 8px;font-size:.85rem}
.du-filters .du-seg button{flex:none;padding:5px 12px;font-size:.85rem}
.du-tabs button{flex:none;padding:5px 14px;font-size:.85rem}
.du-tabs button[aria-selected="true"]{background:var(--pmd-c-accent);color:var(--pmd-c-text-on-accent);font-weight:600}
.du-team{height:min(86vh,680px)}
.du-split{display:grid;grid-template-columns:minmax(0,5fr) minmax(0,6fr);flex:1 1 auto;min-height:0;border-top:1px solid var(--pmd-c-divider)}
.du-split .du-list{max-height:none;min-height:0;padding:8px;border-right:1px solid var(--pmd-c-divider)}
.du-foot.du-foot-end{justify-content:flex-end;flex-wrap:wrap}
.du-row.du-dim .du-row-main{color:var(--pmd-c-text-muted)}
.du-row-text{flex:1;min-width:0;display:flex;flex-direction:column;gap:1px}
.du-row-sub{font-size:.8rem;color:var(--pmd-c-text-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.du-row-sub:empty{display:none}
.du-pane{overflow:auto;padding:14px 18px;font-size:.88rem;line-height:1.45}
.du-info{display:grid;grid-template-columns:max-content minmax(0,1fr);gap:4px 14px;margin:0}
.du-info dt{color:var(--pmd-c-text-muted)}
.du-info dd{margin:0;overflow-wrap:anywhere}
.du-pane h3{margin:16px 0 6px;font-size:.8rem;font-weight:600;color:var(--pmd-c-text-secondary)}
.du-pane h3:first-child{margin-top:0}
.du-pre{margin:0;white-space:pre-wrap;overflow-wrap:anywhere;font:inherit;color:var(--pmd-c-text)}
.du-cite + .du-cite{margin-top:12px}
.du-pane-title{margin:0 0 2px;font-size:1rem;font-weight:600;line-height:1.3}
.du-pane-meta{margin:0 0 12px;font-size:.82rem;color:var(--pmd-c-text-muted)}
.du-cite-title{font-weight:600;margin-bottom:2px}
@media (max-width:640px){.du-split{grid-template-columns:1fr;grid-template-rows:minmax(0,2fr) minmax(0,3fr)}.du-split .du-list{border-right:0;border-bottom:1px solid var(--pmd-c-divider)}}
.du-tally{display:grid;grid-template-columns:max-content minmax(0,1fr) max-content;gap:4px 14px;margin:0}
.du-tally .du-n,.du-tally .du-rec{color:var(--pmd-c-text-muted);font-variant-numeric:tabular-nums}
.du-round{margin:6px 0 0;font-size:.85rem;color:var(--pmd-c-text-secondary)}
.du-link{font:inherit;padding:0;border:0;background:none;color:var(--pmd-c-accent);cursor:pointer;text-decoration:underline;text-underline-offset:2px}
.du-link:focus-visible{outline:2px solid var(--pmd-c-accent);outline-offset:2px}
.du-find .du-list{max-height:min(60vh,520px);min-height:120px}
.du-find .du-row{align-items:flex-start}
.du-where{flex:0 1 34%;min-width:0;display:flex;flex-direction:column;align-items:flex-end;gap:1px;font-size:.8rem;color:var(--pmd-c-text-muted)}
.du-where span{max-width:100%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.du-marks .du-list{max-height:min(60vh,520px);min-height:120px}
.du-group{padding:10px 12px 4px;font-size:.75rem;font-weight:600;letter-spacing:.02em;color:var(--pmd-c-text-secondary);
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.du-check{flex:none;width:15px;height:15px;margin-top:2px;border-radius:4px;border:1.5px solid var(--pmd-c-border);display:grid;place-items:center;
  font-size:11px;line-height:1;color:var(--pmd-c-text-on-accent)}
.du-row[aria-checked="true"] .du-check{background:#d81e1e;border-color:#d81e1e}
.du-row[aria-checked="true"] .du-row-main{color:#d81e1e}
.du-marks .du-row{align-items:flex-start}
.du-btn:disabled{opacity:.5;cursor:default}
.du-btn:disabled:hover{background:var(--pmd-c-bg)}
`;

  function el(tag, props = {}, kids = []) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === 'class') n.className = v;
      else if (k === 'data') Object.assign(n.dataset, v);
      else if (k === 'attrs') for (const [a, val] of Object.entries(v)) n.setAttribute(a, val);
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else n[k] = v;
    }
    for (const kid of kids) if (kid) n.append(kid);
    return n;
  }

  // "What they run": tally the parsed reports per side. Each argument counts
  // once per round, with the record of the rounds it was read in.
  const reported = (r) => !!(r.parsed && (r.parsed.own.length || r.parsed.final.length));
  const record = (rs) => {
    const w = rs.filter((r) => r.parsed && r.parsed.result === 'W').length;
    const l = rs.filter((r) => r.parsed && r.parsed.result === 'L').length;
    return w + l ? `${w}-${l}` : '';
  };
  function tally(rounds, pick) {
    const m = new Map();
    for (const r of rounds) {
      const seen = new Set();
      for (const name of r.parsed[pick]) {
        const key = name.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        if (!m.has(key)) m.set(key, { name, rounds: [] });
        m.get(key).rounds.push(r);
      }
    }
    return [...m.values()]
      .map((e) => ({ name: e.name, count: e.rounds.length, record: record(e.rounds) }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  }
  function summarize(rounds, sideLabels) {
    return ['A', 'N'].map((side) => {
      const all = rounds.filter((r) => r.side === side);
      if (!all.length) return null;
      const read = all.filter(reported);
      return { key: side, side, label: sideLabels[side], total: all.length, read: read.length, record: record(all), own: tally(read, 'own'), final: tally(read, 'final') };
    }).filter(Boolean);
  }

  function ensureStyle() {
    if (document.getElementById('du-style')) return;
    (document.head || document.body).append(el('style', { id: 'du-style', textContent: CSS }));
  }

  // Scrim + dialog shell. Keys stay inside the overlay; Esc and a click on
  // the scrim dismiss; focus returns to where it was.
  function openDialog({ title, subtitle, width, stacked }) {
    ensureStyle();
    const prev = document.activeElement;
    const dialog = el('div', { class: `du-dialog${stacked ? ' du-stacked' : ''}`, tabIndex: -1, attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-label': title } });
    if (width) dialog.style.setProperty('--du-w', width);
    const head = el('div', { class: 'du-head' }, [
      el('h2', { class: 'du-title', textContent: title }),
      subtitle ? el('p', { class: 'du-sub', textContent: subtitle, title: subtitle }) : null,
    ]);
    const body = el('div', { class: 'du-body' });
    const foot = el('div', { class: 'du-foot' });
    dialog.append(head, body, foot);
    const scrim = el('div', { class: 'du-scrim' }, [dialog]);
    let onDismiss = () => {};
    scrim.addEventListener('mousedown', (e) => { if (e.target === scrim) onDismiss(); });
    dialog.addEventListener('keydown', (e) => {
      e.stopPropagation(); // CardMirror hotkeys never see keys typed here
      if (e.key === 'Escape') { e.preventDefault(); onDismiss(); }
    });
    document.body.append(scrim);
    return {
      dialog, head, body, foot,
      onDismiss: (fn) => { onDismiss = fn; },
      close: () => { scrim.remove(); if (prev && prev.focus) prev.focus(); },
    };
  }

  const button = (text, primary, onclick) =>
    el('button', { type: 'button', class: `du-btn${primary ? ' du-primary' : ''}`, textContent: text, onclick });

  function note(text) {
    const n = el('div', { class: 'du-note' });
    const set = (t) => {
      n.textContent = '';
      n.className = `du-note${/^Couldn't/.test(t) ? ' du-warn' : ''}`;
      if (/^Live/.test(t)) n.append(el('span', { class: 'du-dot', attrs: { 'aria-hidden': 'true' } }));
      n.append(el('span', { textContent: t }));
    };
    set(text);
    return { node: n, set };
  }

  const domUI = {
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),

    prompt(labelText, initial, opts = {}) {
      return new Promise((resolve) => {
        const d = openDialog({ title: labelText, width: '420px' });
        const input = el('input', { class: 'du-input', value: initial || '', type: opts.secret ? 'password' : 'text', attrs: { 'aria-label': labelText } });
        const done = (v) => { d.close(); resolve(v); };
        d.onDismiss(() => done(null));
        input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); done(input.value); } });
        d.body.append(input);
        d.foot.append(note('Enter to confirm · Esc to cancel').node, button('Cancel', false, () => done(null)), button('OK', true, () => done(input.value)));
        input.focus();
        if (input.select) input.select();
      });
    },

    // Returns { closed, update(items, status), close() }. Items carry a stable
    // `key`, so the selection follows its file across refreshes.
    showList(title, initialItems, onPick, opts = {}) {
      const HINT = '↑↓ + Enter or click to open · Esc to close';
      const d = openDialog({ title, stacked: opts.stacked, width: '560px' });
      let resolveClosed;
      const closed = new Promise((r) => { resolveClosed = r; });
      const list = el('div', { class: 'du-list', attrs: { role: 'listbox', 'aria-label': title } });
      d.body.remove();
      d.dialog.insertBefore ? d.dialog.insertBefore(list, d.foot) : d.dialog.append(list);
      const status = note(opts.hint || HINT);
      d.foot.append(status.node);
      let items = [];
      let rows = [];
      let selKey = null;
      const selIndex = () => Math.max(0, items.findIndex((it) => it.key === selKey));
      const paint = () => rows.forEach((r, i) => {
        const on = items[i].key === selKey;
        r.setAttribute('aria-selected', on ? 'true' : 'false');
        if (on && r.scrollIntoView) r.scrollIntoView({ block: 'nearest' });
      });
      const render = () => {
        list.textContent = '';
        rows = [];
        if (!items.length) {
          list.append(el('div', { class: 'du-empty', textContent: 'No files yet. Waiting for uploads…' }));
          return;
        }
        if (!items.some((it) => it.key === selKey)) selKey = items[0].key;
        rows = items.map((it) => {
          const main = el('span', { class: 'du-row-main', textContent: it.label, title: it.label });
          if (it.isNew) main.append(el('span', { class: 'du-new', textContent: 'new' }));
          const row = el('div', { class: 'du-row', attrs: { role: 'option' } }, [main, el('span', { class: 'du-row-detail', textContent: it.detail })]);
          row.addEventListener('mousedown', (e) => { e.preventDefault(); selKey = it.key; paint(); onPick(it); });
          list.append(row);
          return row;
        });
        paint();
      };
      const close = () => { d.close(); resolveClosed(); };
      d.onDismiss(close);
      d.dialog.addEventListener('keydown', (e) => {
        if (!items.length) return;
        if (e.key === 'ArrowDown') { e.preventDefault(); selKey = items[Math.min(selIndex() + 1, items.length - 1)].key; paint(); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); selKey = items[Math.max(selIndex() - 1, 0)].key; paint(); }
        else if (e.key === 'Enter') { e.preventDefault(); onPick(items[selIndex()]); }
      });
      items = initialItems;
      render();
      d.dialog.focus();
      return {
        closed,
        close,
        update(next, statusText) {
          items = next;
          status.set(statusText || opts.hint || HINT);
          render();
        },
      };
    },

    // Live search: the query goes to spec.onQuery (debounced; stale answers dropped).
    // Enter opens the file, ⌘Enter just the card. Resolves when closed.
    search(spec) {
      return new Promise((resolve) => {
        const d = openDialog({ title: spec.title, width: '760px' });
        d.dialog.className += ' du-find';
        const input = el('input', { class: 'du-input du-search', placeholder: spec.placeholder, data: { field: 'query' }, attrs: { 'aria-label': spec.title } });
        const list = el('div', { class: 'du-list', data: { field: 'list' }, attrs: { role: 'listbox', 'aria-label': spec.title } });
        d.body.remove();
        if (d.dialog.insertBefore) { d.dialog.insertBefore(input, d.foot); d.dialog.insertBefore(list, d.foot); } else d.dialog.append(input, list);
        const status = note(spec.status || '');
        let items = [];
        let rows = [];
        let sel = 0;
        let seq = 0;
        let timer = null;
        let closed = false;
        const done = () => { if (closed) return; closed = true; clearTimeout(timer); d.close(); resolve(); };
        const pick = (how) => {
          const it = items[sel];
          if (!it) return;
          done();
          (how === 'card' ? spec.onCard : spec.onOpen)(it);
        };
        const cardBtn = button('Open card only', false, () => pick('card'));
        const openBtn = button('Open file', true, () => pick('file'));
        cardBtn.title = '⌘Enter: just this card, as its own doc';
        openBtn.title = 'Enter';
        d.foot.append(status.node, cardBtn, openBtn);
        d.onDismiss(done);
        const paint = () => rows.forEach((r, i) => {
          r.setAttribute('aria-selected', i === sel ? 'true' : 'false');
          if (i === sel && r.scrollIntoView) r.scrollIntoView({ block: 'nearest' });
        });
        const render = (empty) => {
          list.textContent = '';
          cardBtn.disabled = openBtn.disabled = !items.length;
          if (!items.length) { list.append(el('div', { class: 'du-empty', textContent: empty || '' })); rows = []; return; }
          rows = items.map((it, i) => {
            const row = el('div', { class: 'du-row', attrs: { role: 'option' } }, [
              el('span', { class: 'du-row-text' }, [
                el('span', { class: 'du-row-main', textContent: it.label, title: it.label }),
                el('span', { class: 'du-row-sub', textContent: it.sub, title: it.sub }),
              ]),
              el('span', { class: 'du-where' }, (it.where || []).map((w) => el('span', { textContent: w, title: w }))),
            ]);
            row.addEventListener('mousedown', (e) => { e.preventDefault(); sel = i; paint(); });
            row.addEventListener('dblclick', () => { sel = i; pick('file'); });
            list.append(row);
            return row;
          });
          paint();
        };
        const run = async () => {
          clearTimeout(timer);
          const mine = ++seq;
          const r = await spec.onQuery(input.value);
          if (closed || mine !== seq) return; // a newer query is on its way
          items = r.items;
          sel = 0;
          status.set(r.status || '');
          render(r.empty);
          if (r.again) timer = setTimeout(run, 1500); // still indexing: refresh as it grows
        };
        input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(run, 120); });
        input.addEventListener('keydown', (e) => {
          if (e.key === 'ArrowDown' && items.length) { e.preventDefault(); sel = Math.min(sel + 1, items.length - 1); paint(); }
          else if (e.key === 'ArrowUp' && items.length) { e.preventDefault(); sel = Math.max(sel - 1, 0); paint(); }
          else if (e.key === 'Enter') { e.preventDefault(); pick(e.metaKey || e.ctrlKey ? 'card' : 'file'); }
        });
        render(spec.empty);
        run();
        input.focus();
      });
    },

    // Checklist of the doc's cards. Resolves with the new checked state per card, or null.
    pickCards(spec) {
      return new Promise((resolve) => {
        const d = openDialog({ title: spec.title, subtitle: spec.subtitle, width: '640px' });
        d.dialog.className += ' du-marks';
        const input = el('input', { class: 'du-input du-search', placeholder: 'Type to filter by tag, cite or block', data: { field: 'query' }, attrs: { 'aria-label': 'Filter cards' } });
        const list = el('div', { class: 'du-list', data: { field: 'list' }, attrs: { role: 'listbox', 'aria-multiselectable': 'true', 'aria-label': spec.title } });
        d.body.remove();
        if (d.dialog.insertBefore) { d.dialog.insertBefore(input, d.foot); d.dialog.insertBefore(list, d.foot); } else d.dialog.append(input, list);
        const checked = spec.cards.map((c) => !!c.checked);
        let shown = [];
        let rows = [];
        let boxes = [];
        let cur = 0;
        const done = (v) => { d.close(); resolve(v); };
        d.onDismiss(() => done(null));
        const changes = () => {
          let mark = 0;
          let unmark = 0;
          checked.forEach((on, i) => { if (on !== !!spec.cards[i].checked) on ? mark++ : unmark++; });
          return { mark, unmark };
        };
        const apply = button('Apply', true, () => { if (changes().mark || changes().unmark) done(checked.slice()); });
        const allBtn = button('Check shown', false, () => { const on = !shown.every((i) => checked[i]); for (const i of shown) checked[i] = on; render(); });
        d.foot.append(note('Enter check · ⌘Enter apply').node, allBtn, apply);
        const paintFoot = () => {
          const { mark, unmark } = changes();
          apply.textContent = mark || unmark ? [mark && `Mark ${mark}`, unmark && `Unmark ${unmark}`].filter(Boolean).join(' · ') : 'No changes';
          apply.disabled = !(mark || unmark);
          allBtn.textContent = shown.length && shown.every((i) => checked[i]) ? 'Uncheck shown' : 'Check shown';
          allBtn.disabled = !shown.length;
        };
        const paint = () => {
          rows.forEach((r, k) => {
            const i = shown[k];
            r.setAttribute('aria-checked', checked[i] ? 'true' : 'false');
            r.setAttribute('aria-selected', k === cur ? 'true' : 'false');
            boxes[k].textContent = checked[i] ? '✓' : '';
            if (k === cur && r.scrollIntoView) r.scrollIntoView({ block: 'nearest' });
          });
          paintFoot();
        };
        const toggle = (k) => { const i = shown[k]; if (i === undefined) return; checked[i] = !checked[i]; paint(); };
        const render = () => {
          const words = input.value.toLowerCase().split(/\s+/).filter(Boolean);
          shown = spec.cards.map((c, i) => i).filter((i) => {
            const hay = `${spec.cards[i].label}\n${spec.cards[i].sub}\n${spec.cards[i].group}`.toLowerCase();
            return words.every((w) => hay.includes(w));
          });
          cur = Math.min(cur, Math.max(shown.length - 1, 0));
          list.textContent = '';
          rows = [];
          boxes = [];
          let group = null;
          shown.forEach((i, k) => {
            const c = spec.cards[i];
            if (c.group !== group) { group = c.group; if (group) list.append(el('div', { class: 'du-group', textContent: group, title: group })); }
            const box = el('span', { class: 'du-check', attrs: { 'aria-hidden': 'true' } });
            boxes.push(box);
            const row = el('div', { class: 'du-row', attrs: { role: 'option' } }, [
              box,
              el('span', { class: 'du-row-text' }, [
                el('span', { class: 'du-row-main', textContent: c.label, title: c.label }),
                el('span', { class: 'du-row-sub', textContent: [c.sub, c.partial ? 'partly red' : ''].filter(Boolean).join(' · ') }),
              ]),
            ]);
            row.addEventListener('mousedown', (e) => { e.preventDefault(); cur = k; toggle(k); });
            list.append(row);
            rows.push(row);
          });
          if (!shown.length) list.append(el('div', { class: 'du-empty', textContent: spec.cards.length ? 'No cards match.' : 'No cards in this document.' }));
          paint();
        };
        input.addEventListener('input', () => { cur = 0; render(); });
        input.addEventListener('keydown', (e) => {
          if (e.key === 'ArrowDown' && shown.length) { e.preventDefault(); cur = Math.min(cur + 1, shown.length - 1); paint(); }
          else if (e.key === 'ArrowUp' && shown.length) { e.preventDefault(); cur = Math.max(cur - 1, 0); paint(); }
          else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); apply.click ? apply.click() : apply.dispatch('click'); }
          else if (e.key === 'Enter') { e.preventDefault(); toggle(cur); }
        });
        render();
        input.focus();
      });
    },

    // Filterable single-select. Resolves with the chosen index, or null.
    choose(title, labels) {
      return new Promise((resolve) => {
        const d = openDialog({ title, width: '440px' });
        const input = el('input', { class: 'du-input du-search', placeholder: 'Type to filter', attrs: { 'aria-label': `Filter: ${title}` } });
        const list = el('div', { class: 'du-list', attrs: { role: 'listbox', 'aria-label': title } });
        d.body.remove();
        if (d.dialog.insertBefore) { d.dialog.insertBefore(input, d.foot); d.dialog.insertBefore(list, d.foot); } else d.dialog.append(input, list);
        d.foot.append(note('↑↓ + Enter to choose · Esc to cancel').node);
        let shown = [];
        let sel = 0;
        const done = (v) => { d.close(); resolve(v); };
        d.onDismiss(() => done(null));
        const render = () => {
          const q = input.value.trim().toLowerCase();
          shown = labels.map((l, i) => i).filter((i) => labels[i].toLowerCase().includes(q));
          sel = Math.min(sel, Math.max(shown.length - 1, 0));
          list.textContent = '';
          if (!shown.length) list.append(el('div', { class: 'du-empty', textContent: 'No matches.' }));
          shown.forEach((idx, pos) => {
            const row = el('div', { class: 'du-row', attrs: { role: 'option', 'aria-selected': pos === sel ? 'true' : 'false' } },
              [el('span', { class: 'du-row-main', textContent: labels[idx], title: labels[idx] })]);
            row.addEventListener('mousedown', (e) => { e.preventDefault(); done(idx); });
            list.append(row);
            if (pos === sel && row.scrollIntoView) row.scrollIntoView({ block: 'nearest' });
          });
        };
        input.addEventListener('input', () => { sel = 0; render(); });
        input.addEventListener('keydown', (e) => {
          if (e.key === 'ArrowDown') { e.preventDefault(); sel = Math.min(sel + 1, shown.length - 1); render(); }
          else if (e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(sel - 1, 0); render(); }
          else if (e.key === 'Enter') { e.preventDefault(); if (shown.length) done(shown[sel]); }
        });
        render();
        input.focus();
      });
    },

    // Upload form. Resolves with the field values, or null on Cancel/Esc.
    form(spec) {
      return new Promise((resolve) => {
        const d = openDialog({ title: spec.title, subtitle: spec.subtitle, width: '560px' });
        const done = (v) => { d.close(); resolve(v); };
        d.onDismiss(() => done(null));
        const field = (label, control, span) =>
          el('label', { class: `du-field${span ? ' du-span' : ''}` }, [el('span', { class: 'du-label', textContent: label }), control]);
        const text = (key, placeholder) => el('input', { class: 'du-input', value: spec.fields[key] || '', placeholder, data: { field: key } });

        const fill = el('select', { class: 'du-input', data: { field: 'fill' } });
        fill.append(new Option('Enter manually', ''));
        spec.choices.forEach((c, i) => fill.append(new Option(c.label, String(i))));
        const fillPanel = el('div', { class: 'du-fill' }, [field('Fill from a Tabroom round', fill)]);

        const tournament = text('tournament', 'e.g. Glenbrooks');
        const round = text('round', 'e.g. 3 or Octas');
        const opponent = text('opponent', 'Optional');
        const judge = text('judge', 'Optional');
        const report = el('textarea', { class: 'du-input', rows: 2, value: spec.fields.report || '', placeholder: 'Optional: what was read', data: { field: 'report' } });

        let side = spec.fields.side || '';
        const sideSeg = el('div', { class: 'du-seg', data: { field: 'side' }, attrs: { role: 'group', 'aria-label': 'Side' } });
        const sideBtns = ['A', 'N'].map((v) => {
          const b = el('button', { type: 'button', textContent: spec.sideLabels[v], data: { value: v } });
          b.addEventListener('click', () => { side = v; paintSide(); });
          sideSeg.append(b);
          return b;
        });
        const paintSide = () => sideBtns.forEach((b) => b.setAttribute('aria-pressed', b.dataset.value === side ? 'true' : 'false'));
        paintSide();

        let fileMode = spec.fileMode;
        const files = el('div', { class: 'du-choices', data: { field: 'file' }, attrs: { role: 'radiogroup', 'aria-label': 'File' } });
        const newestDetail = String(spec.newestLabel || '').replace(/^Newest send doc:?\s*/, '');
        const fileBtns = [
          { mode: 'newest', main: 'Newest send doc', detail: newestDetail, aria: spec.newestLabel, disabled: !spec.newestLabel || /\((none found|set a send doc folder first)\)$/.test(spec.newestLabel) },
          { mode: 'pick', main: 'Choose a file…', detail: '', aria: 'Pick a file…', disabled: false },
        ].map((f) => {
          const b = el('button', { type: 'button', class: 'du-choice', ariaLabel: f.aria, data: { value: f.mode }, attrs: { role: 'radio', 'aria-disabled': f.disabled ? 'true' : 'false' } },
            [el('span', { class: 'du-radio', attrs: { 'aria-hidden': 'true' } }), el('span', { class: 'du-choice-text' }, [el('span', { class: 'du-choice-main', textContent: f.main }), el('span', { class: 'du-choice-detail', textContent: f.detail, title: f.detail })])]);
          b.addEventListener('click', () => { if (!f.disabled) { fileMode = f.mode; paintFiles(); } });
          files.append(b);
          return b;
        });
        const paintFiles = () => fileBtns.forEach((b) => b.setAttribute('aria-checked', b.dataset.value === fileMode ? 'true' : 'false'));
        paintFiles();

        fill.addEventListener('change', () => {
          const c = spec.choices[Number(fill.value)];
          if (!c) return;
          tournament.value = c.fields.tournament;
          round.value = c.fields.round;
          opponent.value = c.fields.opponent;
          judge.value = c.fields.judge;
          side = c.fields.side;
          paintSide();
        });

        const err = el('p', { class: 'du-error', attrs: { role: 'alert' } });
        d.body.append(
          fillPanel,
          el('div', { class: 'du-grid' }, [
            field('Tournament', tournament, true),
            el('div', { class: 'du-field' }, [el('span', { class: 'du-label', textContent: 'Side' }), sideSeg]),
            field('Round', round),
            field('Opponent', opponent),
            field('Judge', judge),
            field('Round report', report, true),
            el('div', { class: 'du-field du-span' }, [el('span', { class: 'du-label', textContent: 'File' }), files]),
          ]),
          err,
        );
        const submit = () => {
          if (!tournament.value.trim() || !side || !round.value.trim()) {
            err.textContent = 'Tournament, side and round are required.';
            return;
          }
          done({
            tournament: tournament.value, side, round: round.value, opponent: opponent.value,
            judge: judge.value, report: report.value, fileMode,
          });
        };
        d.foot.append(
          note('Posts publicly to openCaselist').node,
          button('Cancel', false, () => done(null)),
          button('Upload', true, submit),
        );
        d.dialog.addEventListener('keydown', (e) => {
          // Enter submits only from a text box: Enter on a dropdown must never post publicly.
          if (e.key === 'Enter' && e.target.tagName === 'INPUT') { e.preventDefault(); submit(); }
        });
        fill.focus();
      });
    },

    // Caselist team page: list on the left, details of the selected item on the right.
    teamPage(spec) {
      return new Promise((resolve) => {
        const d = openDialog({ title: spec.title, subtitle: spec.subtitle, width: '780px' });
        d.dialog.className += ' du-team';
        d.foot.className += ' du-foot-end';
        const tabs = el('div', { class: 'du-seg du-tabs', data: { field: 'tabs' }, attrs: { role: 'tablist' } });
        const list = el('div', { class: 'du-list', data: { field: 'list' }, attrs: { role: 'listbox' } });
        const pane = el('div', { class: 'du-pane', data: { field: 'pane' } });
        const split = el('div', { class: 'du-split' }, [list, pane]);
        d.body.remove();
        if (d.dialog.insertBefore) d.dialog.insertBefore(split, d.foot); else d.dialog.append(split);
        if (spec.round) {
          // Scouting from a Tabroom pairing: the round, and a paradigm link per judge.
          const text = (t) => el('span', { textContent: t });
          const line = el('p', { class: 'du-round', data: { field: 'round' } }, [text(spec.round.text)]);
          if (spec.round.judges.length) {
            line.append(text(` · Judge${spec.round.judges.length > 1 ? 's' : ''}: `));
            spec.round.judges.forEach((j, i) => {
              if (i) line.append(text(', '));
              line.append(spec.onParadigm
                ? el('button', { type: 'button', class: 'du-link', textContent: j, title: `Open ${j}'s paradigm on Tabroom`, onclick: () => spec.onParadigm(j) })
                : text(j));
            });
          }
          d.head.append(line);
        }
        d.head.append(tabs);
        const sideLabels = { A: 'Aff', N: 'Neg', ...(spec.sideLabels || {}) };
        const TABS = [...(spec.rounds.some(reported) ? [['summary', 'Summary']] : []), ['rounds', 'Rounds'], ['cites', 'Cites']];
        let tab = TABS[0][0];
        const sel = { summary: 0, rounds: 0, cites: 0 };
        // Filters apply to both tabs.
        const filter = { tournament: '', side: '' };
        const matches = (it) => (!filter.tournament || it.tournament === filter.tournament) && (!filter.side || it.side === filter.side);
        const filtering = () => !!(filter.tournament || filter.side);
        const items = () => (tab === 'summary' ? summarize(spec.rounds.filter(matches), sideLabels) : spec[tab].filter(matches));
        const tournaments = [...new Set([...spec.rounds, ...spec.cites].map((it) => it.tournament).filter(Boolean))];
        const tournSel = el('select', { class: 'du-input', data: { field: 'filter-tournament' }, attrs: { 'aria-label': 'Filter by tournament' } });
        tournSel.append(new Option('All tournaments', ''));
        for (const t of tournaments) tournSel.append(new Option(t, t));
        tournSel.addEventListener('change', () => { filter.tournament = tournSel.value; sel.rounds = 0; sel.cites = 0; sel.summary = 0; render(); });
        const sideSeg = el('div', { class: 'du-seg', data: { field: 'filter-side' }, attrs: { role: 'group', 'aria-label': 'Filter by side' } });
        const sideBtns = [['', 'All'], ['A', (spec.sideLabels || {}).A || 'Aff'], ['N', (spec.sideLabels || {}).N || 'Neg']].map(([v, text]) => {
          const b = el('button', { type: 'button', textContent: text, data: { value: v } });
          b.addEventListener('click', () => { filter.side = v; sel.rounds = 0; sel.cites = 0; sel.summary = 0; render(); });
          sideSeg.append(b);
          return b;
        });
        const filters = el('div', { class: 'du-filters' }, [tournSel, sideSeg]);
        d.head.append(filters);
        const current = () => items()[sel[tab]];
        const tabBtns = TABS.map(([key, text]) => {
          const b = el('button', { type: 'button', textContent: text, data: { value: key }, attrs: { role: 'tab' } });
          b.addEventListener('click', () => { tab = key; render(); });
          tabs.append(b);
          return b;
        });
        const section = (title, kids) => [el('h3', { textContent: title }), ...kids];
        const renderPane = () => {
          pane.textContent = '';
          const it = current();
          if (!it) {
            pane.append(el('div', { class: 'du-empty', textContent: tab === 'cites' ? 'No cite entries yet.' : 'No rounds disclosed yet.' }));
            return;
          }
          if (tab === 'summary') {
            const speech = (n, kind) => `${n}${it.side === 'A' ? 'A' : 'N'}${kind}`;
            const list = (entries, none) => (entries.length
              ? el('div', { class: 'du-tally' }, entries.flatMap((e) => [
                el('span', { class: 'du-n', textContent: `${e.count}×` }), el('span', { textContent: e.name }), el('span', { class: 'du-rec', textContent: e.record }),
              ]))
              : el('p', { class: 'du-pre du-muted', textContent: none }));
            pane.append(
              el('h2', { class: 'du-pane-title', textContent: it.label }),
              el('p', { class: 'du-pane-meta', textContent: [`${it.read} of ${plural(it.total, 'round')} with a readable report`, it.record && `${it.record} where reported`].filter(Boolean).join(' · ') }),
              ...section(`Case (${speech(1, 'C')})`, [list(it.own, 'Not named in their reports.')]),
              ...section(`Last speech (${speech(2, 'R')})`, [list(it.final, 'Not named in their reports.')]),
            );
            return;
          }
          if (tab === 'rounds') {
            const dl = el('dl', { class: 'du-info' });
            for (const [k, v] of it.info) dl.append(el('dt', { textContent: k }), el('dd', { textContent: v }));
            pane.append(...section('Round', [dl]));
            pane.append(...section('Round report', [el('p', { class: `du-pre${it.report ? '' : ' du-muted'}`, textContent: it.report || 'No report.' })]));
            if (it.cites.length) {
              pane.append(...section('Cites for this round', it.cites.map((c) => el('div', { class: 'du-cite' }, [
                el('div', { class: 'du-cite-title', textContent: c.title }), el('p', { class: 'du-pre', textContent: c.text }),
              ]))));
            }
          } else {
            pane.append(el('h2', { class: 'du-pane-title', textContent: it.label }), el('p', { class: 'du-pane-meta', textContent: it.detail }), el('p', { class: 'du-pre', textContent: it.text || 'No cites text.' }));
          }
        };
        const renderFoot = () => {
          d.foot.textContent = '';
          const it = current();
          if (spec.onViewOnline) d.foot.append(button('View on openCaselist', false, () => spec.onViewOnline(spec.pageUrl)));
          if (tab === 'rounds' && it) {
            if (it.cites.length) d.foot.append(button('Copy cites', false, () => spec.onCopy(it.cites.map((c) => `${c.title}\n${c.text}`).join('\n\n'), 'cites')));
            if (it.report) d.foot.append(button('Copy report', false, () => spec.onCopy(it.report, 'report')));
            const open = button('Open doc', true, () => spec.onOpen(it.key));
            open.title = it.hasFile ? 'Enter' : 'This round has cites only, no file';
            if (!it.hasFile) open.disabled = true;
            d.foot.append(open);
          } else if (tab === 'cites' && it) {
            d.foot.append(button('Copy cites', true, () => spec.onCopy(it.text, 'cites')));
          }
        };
        let rows = [];
        const keepFocus = () => {
          // Rebuilding the footer can remove the focused button; keep keys inside the dialog.
          if (d.dialog.contains && !d.dialog.contains(document.activeElement)) d.dialog.focus();
        };
        // Selection repaints in place: rows are never rebuilt under the pointer.
        const select = (i) => {
          sel[tab] = i;
          rows.forEach((r, j) => {
            r.setAttribute('aria-selected', j === i ? 'true' : 'false');
            if (j === i && r.scrollIntoView) r.scrollIntoView({ block: 'nearest' });
          });
          renderPane();
          renderFoot();
          keepFocus();
        };
        const render = () => {
          tabBtns.forEach((b) => {
            const key = b.dataset.value;
            const shown = key === 'summary' ? 0 : spec[key].filter(matches).length;
            const total = key === 'summary' ? 0 : spec[key].length;
            if (key !== 'summary') b.textContent = `${key === 'rounds' ? 'Rounds' : 'Cites'} (${filtering() ? `${shown} of ${total}` : total})`;
            b.setAttribute('aria-selected', key === tab ? 'true' : 'false');
          });
          sideBtns.forEach((b) => b.setAttribute('aria-pressed', b.dataset.value === filter.side ? 'true' : 'false'));
          list.textContent = '';
          rows = items().map((it, i) => {
            // Two lines: what (tournament / cite title) on top, the specifics underneath.
            const [top, ...rest] = tab === 'rounds' ? it.label.split(' · ')
              : tab === 'summary' ? [it.label, plural(it.total, 'round'), it.record].filter(Boolean)
                : [it.label, it.detail];
            const row = el('div', { class: `du-row${tab === 'rounds' && !it.hasFile ? ' du-dim' : ''}`, attrs: { role: 'option' } }, [
              el('span', { class: 'du-row-text' }, [
                el('span', { class: 'du-row-main', textContent: top, title: it.label }),
                el('span', { class: 'du-row-sub', textContent: rest.join(' · ') }),
              ]),
              tab === 'rounds' ? el('span', { class: 'du-row-detail', textContent: it.detail }) : null,
            ]);
            row.addEventListener('mousedown', (e) => { e.preventDefault(); select(i); });
            list.append(row);
            return row;
          });
          if (!items().length) {
            const what = tab === 'cites' ? 'cites' : 'rounds';
            const any = spec[tab === 'cites' ? 'cites' : 'rounds'].length;
            list.append(el('div', { class: 'du-empty', textContent: filtering() && any ? `No ${what} match these filters.` : 'Nothing here yet.' }));
          }
          select(Math.min(sel[tab], Math.max(items().length - 1, 0)));
        };
        list.addEventListener('dblclick', () => {
          const it = current();
          if (tab === 'rounds' && it && it.hasFile) spec.onOpen(it.key);
        });
        const close = () => { d.close(); resolve(); };
        d.onDismiss(close);
        d.dialog.addEventListener('keydown', (e) => {
          if (e.target && (e.target.tagName === 'SELECT' || e.target.tagName === 'INPUT')) return; // the dropdown keeps its own keys
          const n = items().length;
          if (e.key === 'ArrowDown' && n) { e.preventDefault(); select(Math.min(sel[tab] + 1, n - 1)); }
          else if (e.key === 'ArrowUp' && n) { e.preventDefault(); select(Math.max(sel[tab] - 1, 0)); }
          else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
            e.preventDefault();
            const i = TABS.findIndex(([k]) => k === tab) + (e.key === 'ArrowRight' ? 1 : -1);
            tab = TABS[Math.max(0, Math.min(TABS.length - 1, i))][0];
            render();
          }
          // Enter opens only when the dialog itself has focus; on a focused button it presses that button.
          else if (e.key === 'Enter' && tab === 'rounds' && e.target === d.dialog) { e.preventDefault(); const it = current(); if (it && it.hasFile) spec.onOpen(it.key); }
        });
        render();
        d.dialog.focus();
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

  // ---------------------------------------------------------------- Editor access
  // Plugin API v1 can't edit the document, so marking reaches CardMirror's ProseMirror
  // view the way ProseMirror hands it around internally: its view descriptions receive
  // the view in update()/setSelection(). Wrapping those once records each editor's view.
  // Unsupported by CardMirror, so every step fails soft ("couldn't reach the editor").
  const editor = (() => {
    const views = new WeakMap();
    let patched = false;
    let lastFocused = null;
    const doms = () => [...document.querySelectorAll('.ProseMirror')].filter((n) => n.pmViewDesc);
    function patch(dom) {
      if (patched || !dom || !dom.pmViewDesc) return;
      const desc = dom.pmViewDesc;
      for (const [name, at] of [['update', 3], ['setSelection', 2]]) {
        let proto = Object.getPrototypeOf(desc);
        while (proto && !Object.prototype.hasOwnProperty.call(proto, name)) proto = Object.getPrototypeOf(proto);
        if (!proto || typeof proto[name] !== 'function') continue;
        const orig = proto[name];
        proto[name] = function (...args) {
          try {
            const v = args[at];
            if (v && v.dom && v.state && typeof v.dispatch === 'function') views.set(v.dom, v);
          } catch { /* never break the editor */ }
          return orig.apply(this, args);
        };
      }
      patched = true;
    }
    function install() {
      if (typeof document === 'undefined' || !document.addEventListener) return;
      document.addEventListener('focusin', (e) => {
        const d = e.target && e.target.closest && e.target.closest('.ProseMirror');
        if (d) { lastFocused = d; patch(d); }
      }, true);
      try { patch(doms()[0]); } catch { /* no editor yet */ }
    }
    // The view for the editor the user was last in. If it hasn't updated since the
    // patch, nudge the caret (and put it back) so ProseMirror passes its view along.
    async function view(sleep) {
      const all = doms();
      if (!all.length) return null;
      patch(all[0]);
      const dom = (lastFocused && lastFocused.isConnected && lastFocused.pmViewDesc && lastFocused) || all.find((n) => n.offsetParent !== null) || all[0];
      const ok = (v) => (v && v.docView && v.dom === dom ? v : null);
      if (ok(views.get(dom))) return views.get(dom);
      const sel = window.getSelection();
      const saved = sel && sel.rangeCount ? sel.getRangeAt(0).cloneRange() : null;
      const scrolls = [];
      for (let n = dom; n; n = n.parentElement) if (n.scrollTop) scrolls.push([n, n.scrollTop]);
      try {
        for (const atEnd of [true, false]) {
          if (ok(views.get(dom))) break;
          if (dom.focus) dom.focus({ preventScroll: true });
          const r = document.createRange();
          r.selectNodeContents(dom);
          r.collapse(!atEnd);
          sel.removeAllRanges();
          sel.addRange(r);
          for (let i = 0; i < 10 && !ok(views.get(dom)); i++) await sleep(30);
        }
      } finally {
        if (saved && sel) { sel.removeAllRanges(); sel.addRange(saved); }
        for (const [n, top] of scrolls) n.scrollTop = top;
      }
      return ok(views.get(dom));
    }
    return { install, view };
  })();

  // Tabroom gives judges as last names ("Habib,Patel,Sortland"). Paradigms need a
  // Tabroom login, so they open in the browser, where the user is signed in.
  const openExternal = () => window.electronAPI && window.electronAPI.openExternal;
  const judgeNames = (judge) => String(judge ?? '').split(',').map((j) => j.trim()).filter(Boolean);
  const paradigmUrl = (name) => `https://www.tabroom.com/index/paradigm.mhtml?search_first=&search_last=${encodeURIComponent(name)}`;

  const openedToast = (r) => (r.app === 'finder'
    ? `Saved "${r.name}" and showed it in Finder (not opened: unusual file type).`
    : r.opened === false
      ? `Saved "${r.name}" but couldn't open it.`
      : `Opened "${r.name}" in ${r.app === 'CardMirror' ? 'CardMirror' : 'your default app'}`);

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
    remember(api, 'sendDocFolder', folder);
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
    remember(api, 'lastRoom', room);
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
      // Long-poll the helper, which holds a live SpeechDrop socket for the room.
      let res = await call(api, '/speechdrop/watch', { room, version: 0 });
      let { files, version, live } = res;
      remember(api, 'lastRoom', room);
      const seen = new Set(files.map((f) => f.index));
      const toItems = () => files.map((f) => ({ key: f.index, label: f.name, detail: formatTime(f.ctime), isNew: !seen.has(f.index) }));
      const KEYS = '↑↓ + Enter or click to open · Esc to close';
      const hint = () => (live ? `Live · ${KEYS}` : `Refreshing every 5 s · ${KEYS}`);
      const view = u.showList(`SpeechDrop room ${room}`, toItems(), async (item) => {
        const f = files.find((x) => x.index === item.key);
        if (!f) return api.showToast(message('removed', { name: item.label }));
        api.showToast(`Opening "${f.name}"…`);
        try {
          const r = await runJob(api, '/speechdrop/open', { room, index: f.index, name: f.name }, u.sleep);
          api.showToast(openedToast(r));
        } catch (err) {
          api.showToast(message(err.message, { ...ctx, name: f.name }));
        }
      }, { hint: hint() });
      let open = true;
      let failing = false;
      view.closed.then(() => { open = false; });
      while (open) {
        try {
          res = await call(api, '/speechdrop/watch', { room, version });
          if (!open) break;
          if (res.version !== version || res.live !== live || failing) {
            ({ files, version, live } = res);
            failing = false;
            view.update(toItems(), hint());
          }
        } catch {
          if (!open) break;
          failing = true;
          view.update(toItems(), "Couldn't refresh, retrying…");
          await u.sleep(2000);
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
      remember(api, 'tabroomEmail', email);
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
      const open = openExternal();
      const items = rounds.map((r, i) => ({
        key: r.id ?? i,
        judges: judgeNames(r.judge),
        label: `${r.tournament} · ${r.round}`,
        detail: [
          r.side && `${r.side} vs ${r.opponent || 'TBA'}`,
          r.judge && `judge ${r.judge}`,
          r.start_time ? formatTime(Date.parse(r.start_time)) : '',
        ].filter(Boolean).join(' · '),
      }));
      const onPick = (it) => { if (open) for (const j of it.judges) open(paradigmUrl(j)); };
      const hint = open ? 'Enter or click opens the judge\'s paradigm · Esc to close' : 'Esc to close';
      const view = u.showList(current ? 'Tabroom: current rounds' : 'Tabroom: recent rounds', items, onPick, { hint, stacked: true });
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
    remember(api, 'caselistTarget', target);
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
      title: 'Upload to Caselist',
      subtitle: `${target.teamLabel} · ${target.caselistLabel}`,
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

  // ---------------------------------------------------------------- Scouting
  const displayTournament = (t) => String(t ?? '').replace(/^\s*\d+\s*-+\s*/, '');
  const shortDate = (s) => {
    const d = new Date(Date.parse(String(s ?? '').replace(' ', 'T')));
    return Number.isFinite(d.getTime()) ? d.toLocaleDateString([], { month: 'short', day: 'numeric' }) : '';
  };
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const sideLabelsFor = (cl) => (/pf|public forum/i.test(`${cl.event || ''} ${cl.label || ''}`) ? { A: 'Pro', N: 'Con' } : { A: 'Aff', N: 'Neg' });
  const ownCaselist = (api) => {
    const t = api.storage.get('caselistTarget');
    return t ? { name: t.caselist, label: t.caselistLabel, event: t.event || '' } : null;
  };

  async function pickCaselist(api, u) {
    const all = await runJob(api, '/caselist/caselists', {}, u.sleep);
    if (!all.length) { api.showToast('No caselists are open right now.'); return null; }
    const prefer = [ownCaselist(api)?.name, api.storage.get('scoutCaselist')?.name].filter(Boolean);
    const rank = (c) => { const i = prefer.indexOf(c.name); return i === -1 ? prefer.length : i; };
    const ordered = all.map((c, i) => [c, i]).sort((a, b) => rank(a[0]) - rank(b[0]) || a[1] - b[1]).map(([c]) => c);
    const i = await u.choose('Pick a caselist', ordered.map((c) => c.label));
    if (i == null) return null;
    const cl = { name: ordered[i].name, label: ordered[i].label, event: ordered[i].event || '' };
    remember(api, 'scoutCaselist', cl);
    return cl;
  }

  async function openTeamPage(api, u, cl, team, ctx, pairing) {
    const data = await runJob(api, '/caselist/team', { caselist: cl.name, school: team.school, team: team.team }, u.sleep);
    const sl = sideLabelsFor(cl);
    const citesByRound = new Map();
    for (const c of data.cites) {
      if (c.roundId == null) continue;
      if (!citesByRound.has(c.roundId)) citesByRound.set(c.roundId, []);
      citesByRound.get(c.roundId).push({ title: c.title, text: c.cites });
    }
    const rounds = data.rounds.map((r) => {
      const side = sl[r.side] || r.side;
      return {
        key: r.id,
        label: [displayTournament(r.tournament), roundName(r.round), [side, r.opponent && `vs ${r.opponent}`].filter(Boolean).join(' ')].filter(Boolean).join(' · '),
        detail: r.opensource ? shortDate(r.updated) : 'cites only',
        hasFile: !!r.opensource,
        info: [
          ['Tournament', displayTournament(r.tournament)], ['Round', roundName(r.round)], ['Side', side], ['Opponent', r.opponent],
          ['Judge', r.judge], ['Uploaded', shortDate(r.updated)], ['File', r.opensource ? r.opensource.split('/').pop() : 'None (cites only)'],
        ].filter(([, v]) => v),
        report: r.report || '',
        cites: citesByRound.get(r.id) || [],
        tournament: displayTournament(r.tournament),
        side: r.side,
        parsed: r.parsed || null,
      };
    });
    const cites = data.cites.map((c) => ({
      key: c.id, label: c.title || 'Untitled', text: c.cites, tournament: displayTournament(c.tournament), side: c.side,
      detail: [displayTournament(c.tournament), roundName(c.round)].filter(Boolean).join(' · '),
    }));
    const open = openExternal();
    const ourSide = pairing && sideNorm(pairing.side);
    await u.teamPage({
      title: team.label,
      subtitle: `${cl.label} · ${plural(rounds.length, 'round')} · ${cites.length} cite ${cites.length === 1 ? 'entry' : 'entries'}`,
      rounds,
      cites,
      sideLabels: sl,
      round: pairing ? {
        text: [pairing.tournament, roundName(pairing.round), ourSide && `you're ${sl[ourSide]}`, pairing.start_time && formatTime(Date.parse(pairing.start_time))].filter(Boolean).join(' · '),
        judges: judgeNames(pairing.judge),
      } : null,
      onParadigm: open ? (name) => open(paradigmUrl(name)) : null,
      pageUrl: `https://opencaselist.com/${cl.name}/${team.school}/${team.team}`,
      onViewOnline: open ? (url) => open(url) : null,
      onOpen: async (key) => {
        const r = data.rounds.find((x) => x.id === key);
        if (!r || !r.opensource) return;
        const name = r.opensource.split('/').pop();
        api.showToast(`Opening "${name}"…`);
        try {
          const res = await runJob(api, '/caselist/open', { caselist: cl.name, school: team.school, team: team.team, path: r.opensource }, u.sleep);
          api.showToast(openedToast(res));
        } catch (err) {
          api.showToast(message(err.message, { ...ctx, name }));
        }
      },
      onCopy: async (text, what) => {
        try {
          await navigator.clipboard.writeText(text);
          api.showToast(`Copied the ${what}.`);
        } catch {
          api.showToast("Couldn't copy to the clipboard.");
        }
      },
    });
  }

  async function caselistScout(api) {
    const u = ui();
    const ctx = { caselist: true, scouting: true };
    try {
      const { current, rounds } = await runJob(api, '/tabroom/rounds', {}, u.sleep);
      const withOpp = rounds.filter((r) => r.opponent);
      if (!withOpp.length) return api.showToast(current ? 'Your current round has no opponent yet.' : 'No Tabroom rounds with an opponent.');
      let round = withOpp[0];
      if (!(current && withOpp.length === 1)) {
        const i = await u.choose('Scout which round?', withOpp.map((r) => [r.tournament, roundName(r.round), `vs ${r.opponent}`].filter(Boolean).join(' · ')));
        if (i == null) return;
        round = withOpp[i];
      }
      // Your caselist if known; otherwise the helper tries every open caselist (no event picker).
      let cl = ownCaselist(api) || api.storage.get('scoutCaselist') || null;
      // The helper matches Tabroom's "School CODE" to a caselist team by the debater pair.
      const found = await runJob(api, '/caselist/scout', cl ? { caselist: cl.name, opponent: round.opponent } : { opponent: round.opponent }, u.sleep);
      if (!cl && found.caselist) {
        cl = found.caselist;
        remember(api, 'scoutCaselist', cl);
      }
      let team = found.match;
      if (!team) {
        if (!found.candidates.length) return api.showToast(`No caselist page for ${round.opponent}${cl ? ` on ${cl.label}` : ''} yet. Try Search the caselist…`);
        const i = await u.choose(`Which team is ${round.opponent}?`, found.candidates.map((t) => (t.names && t.names.length ? `${t.label} (${t.names.join(' & ')})` : t.label)));
        if (i == null) return;
        team = found.candidates[i];
      }
      await openTeamPage(api, u, cl, team, ctx, round);
    } catch (err) {
      api.showToast(message(err.message, ctx));
    }
  }

  // Browse like the upload team picker: caselist → school → team, all type-to-filter lists.
  async function caselistSearch(api) {
    const u = ui();
    const ctx = { caselist: true, scouting: true };
    try {
      const cl = await pickCaselist(api, u);
      if (!cl) return;
      const schools = await runJob(api, '/caselist/schools', { caselist: cl.name }, u.sleep);
      if (!schools.length) return api.showToast(`No schools on ${cl.label} yet.`);
      const si = await u.choose(`${cl.label}: pick a school`, schools.map((x) => x.label));
      if (si == null) return;
      const school = schools[si];
      const teams = await runJob(api, '/caselist/teams', { caselist: cl.name, school: school.name }, u.sleep);
      if (!teams.length) return api.showToast(`No teams for ${school.label} on ${cl.label} yet.`);
      const ti = teams.length === 1 ? 0 : await u.choose(`${school.label}: pick a team`, teams.map((x) => x.label));
      if (ti == null) return;
      await openTeamPage(api, u, cl, { school: school.name, team: teams[ti].name, label: teams[ti].label }, ctx);
    } catch (err) {
      api.showToast(message(err.message, ctx));
    }
  }


  // ---------------------------------------------------------------- Mark cards
  // "Marked" in CardMirror = red text (FF0000): its reading marker and "marked cards"
  // tools look for exactly that color.
  const MARK_RED = 'FF0000';
  const isRed = (m) => m.type.name === 'font_color' && String(m.attrs.color || '').toUpperCase() === MARK_RED;
  const HEADINGS = { pocket: 0, hat: 1, block: 2 };

  function cardsIn(doc) {
    const out = [];
    const heads = ['', '', ''];
    doc.descendants((node, pos) => {
      const name = node.type.name;
      if (name in HEADINGS) {
        heads[HEADINGS[name]] = node.textContent.trim();
        heads.fill('', HEADINGS[name] + 1);
        return false;
      }
      if (name !== 'card') return true;
      let red = 0;
      let total = 0;
      node.descendants((t) => {
        if (!t.isText) return true;
        total += t.text.length;
        if (t.marks.some(isRed)) red += t.text.length;
        return false;
      });
      let cite = '';
      node.forEach((c) => { if (!cite && c.type.name === 'cite_paragraph') cite = c.textContent.trim(); });
      out.push({
        from: pos, to: pos + node.nodeSize,
        tag: (node.firstChild ? node.firstChild.textContent : '').trim() || '(untitled card)',
        cite, group: heads.filter(Boolean).pop() || '',
        marked: total > 0 && red === total, partial: red > 0 && red < total,
      });
      return false;
    });
    return out;
  }

  // One transaction, so a single ⌘Z undoes the whole batch.
  function applyMarks(view, cards, wanted) {
    const { state } = view;
    const type = state.schema.marks.font_color;
    const tr = state.tr;
    let marked = 0;
    let unmarked = 0;
    cards.forEach((c, i) => {
      if (wanted[i] === c.marked) return;
      if (wanted[i]) { tr.addMark(c.from, c.to, type.create({ color: MARK_RED })); marked++; return; }
      state.doc.nodesBetween(c.from, c.to, (t, pos) => {
        if (!t.isText) return true;
        for (const m of t.marks) if (isRed(m)) tr.removeMark(Math.max(pos, c.from), Math.min(pos + t.nodeSize, c.to), m);
        return false;
      });
      unmarked++;
    });
    if (tr.docChanged) view.dispatch(tr);
    return { marked, unmarked };
  }

  async function markCards(api) {
    const u = ui();
    const view = u.editorView ? await u.editorView() : await editor.view(u.sleep);
    if (!view || !view.state.schema.marks.font_color) return api.showToast("Couldn't reach the editor. Click into your document, then run Mark cards again.");
    const cards = cardsIn(view.state.doc);
    if (!cards.length) return api.showToast('No cards in this document.');
    const info = typeof api.docInfo === 'function' ? api.docInfo() : null;
    const wanted = await u.pickCards({
      title: 'Mark cards',
      subtitle: `${info && info.docTitle ? `${info.docTitle} · ` : ''}checked cards turn red`,
      cards: cards.map((c) => ({ label: c.tag, sub: c.cite, group: c.group, checked: c.marked, partial: c.partial })),
    });
    if (!wanted) return;
    // Positions may have moved if the doc changed meanwhile; the cards must still line up.
    const now = cardsIn(view.state.doc);
    if (now.length !== cards.length || now.some((c, i) => c.tag !== cards[i].tag)) {
      return api.showToast('The cards changed while the list was open. Run Mark cards again.');
    }
    const r = applyMarks(view, now.map((c, i) => ({ ...c, marked: cards[i].marked })), wanted);
    const parts = [r.marked && `marked ${plural(r.marked, 'card')}`, r.unmarked && `unmarked ${plural(r.unmarked, 'card')}`].filter(Boolean);
    if (parts.length) {
      const text = parts.join(', ');
      api.showToast(`${text[0].toUpperCase()}${text.slice(1)} (⌘Z to undo)`);
    }
  }

  // ---------------------------------------------------------------- Search my files
  const fmt = (n) => Number(n || 0).toLocaleString('en-US');
  const short = (s) => (s.length > 70 ? `${s.slice(0, 70)}…` : s);
  const indexStatus = (s) => (s.scanning
    ? `Indexing… ${fmt(s.done)} of ${fmt(s.total)} files`
    : `${fmt(s.cards)} cards in ${fmt(s.files)} files${s.unreadable ? ` · ${fmt(s.unreadable)} unreadable` : ''}`);
  const b64url = (text) => {
    let bin = '';
    for (const b of new TextEncoder().encode(text)) bin += String.fromCharCode(b);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  };

  async function setEvidenceFolders(api, current) {
    const raw = await ui().prompt('Evidence folders (separate several with ;)', (current || []).join('; '));
    if (raw == null) return null;
    const folders = raw.split(';').map((f) => f.trim()).filter(Boolean);
    const st = await call(api, '/evidence/folders', { folders });
    api.showToast(`Indexing ${plural(st.folders.length, 'folder')}. Search works while it runs.`);
    return st;
  }

  async function evidenceFolders(api) {
    try {
      const st = await call(api, '/evidence/status', {});
      await setEvidenceFolders(api, st.folders);
    } catch (err) {
      api.showToast(message(err.message, { evidence: true }));
    }
  }

  // Best effort: once CardMirror shows the opened file, scroll to the card's tag.
  // Needs the doc's id, which only the active doc in this window exposes.
  async function jumpToCard(api, name, quote, approxPos) {
    if (typeof api.jumpToSource !== 'function' || typeof api.docInfo !== 'function' || !quote) return false;
    const titles = [name, name.replace(/\.docx$/i, '')];
    for (let i = 0; i < 20; i++) {
      const info = api.docInfo();
      if (info && info.docId && titles.includes(info.docTitle)) {
        const source = `cmsrc1.${b64url(JSON.stringify({ docId: info.docId, docTitle: info.docTitle, headingId: null, anchor: { quote, prefix: '', suffix: '', approxPos } }))}`;
        try { return !!(await api.jumpToSource(source)).ok; } catch { return false; }
      }
      await ui().sleep(150);
    }
    return false;
  }

  async function openEvidence(api, card) {
    try {
      const r = await call(api, '/evidence/open', { path: card.path, ordinal: card.ordinal });
      if (r.opened === false) return api.showToast(`Couldn't open "${r.name}".`);
      const jumped = await jumpToCard(api, r.name, r.quote, r.approxPos);
      api.showToast(jumped ? `Opened "${r.name}" at "${short(card.tag)}"` : `Opened "${r.name}". The card: "${short(card.tag)}"`);
    } catch (err) {
      api.showToast(message(err.message, { evidence: true }));
    }
  }

  async function openCardOnly(api, card) {
    try {
      const r = await call(api, '/evidence/card', { path: card.path, ordinal: card.ordinal });
      api.showToast(r.opened === false ? `Saved "${r.name}" but couldn't open it.` : `Opened just the card: "${r.name}"`);
    } catch (err) {
      api.showToast(message(err.message, { evidence: true }));
    }
  }

  async function evidenceSearch(api) {
    const ctx = { evidence: true };
    try {
      let st = await call(api, '/evidence/status', { refresh: true });
      if (!st.folders.length) {
        st = await setEvidenceFolders(api, []);
        if (!st) return;
      }
      await ui().search({
        title: 'Search my files',
        placeholder: 'Tag, author, year, block or file name',
        status: indexStatus(st),
        empty: 'Type to search your cards.',
        onQuery: async (q) => {
          try {
            const r = await call(api, '/evidence/search', { query: q, limit: 60 });
            return {
              items: r.results.map((c) => ({
                card: c,
                label: c.tag,
                sub: c.cite || 'Analytic',
                // Right column: the block it sits under, then the file (and how many copies exist).
                where: [c.headings[c.headings.length - 1], `${c.file}${c.copies > 1 ? ` · ${c.copies} copies` : ''}`].filter(Boolean),
              })),
              status: indexStatus(r),
              again: r.scanning,
              empty: !q.trim() ? 'Type to search your cards.' : r.scanning ? 'No matches yet. Still indexing…' : 'No matches.',
            };
          } catch (err) {
            return { items: [], status: message(err.message, ctx), empty: '' };
          }
        },
        onOpen: (it) => openEvidence(api, it.card),
        onCard: (it) => openCardOnly(api, it.card),
      });
    } catch (err) {
      api.showToast(message(err.message, ctx));
    }
  }

  try { editor.install(); } catch { /* marking just reports it can't reach the editor */ }

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
        run: (api) => withPrefs(api, () => uploadToSpeechDrop(api, 'newest')),
      },
      {
        id: `${ID}.sdPick`,
        label: 'Upload file to SpeechDrop…',
        keywords: ['speechdrop', 'upload', 'file', 'drop'],
        defaultKey: null,
        run: (api) => withPrefs(api, () => uploadToSpeechDrop(api, 'pick')),
      },
      {
        id: `${ID}.sdBrowse`,
        label: 'Browse SpeechDrop room…',
        keywords: ['speechdrop', 'browse', 'open', 'download', 'room'],
        defaultKey: null,
        run: (api) => withPrefs(api, () => browse(api)),
      },
      {
        id: `${ID}.setFolder`,
        label: SET_FOLDER_LABEL,
        keywords: ['speechdrop', 'send doc', 'folder'],
        defaultKey: null,
        run: (api) => withPrefs(api, () => setFolder(api)),
      },
      {
        id: `${ID}.tabroomLogin`,
        label: 'Log in to Tabroom…',
        keywords: ['tabroom', 'caselist', 'login', 'sign in'],
        defaultKey: null,
        run: (api) => withPrefs(api, () => tabroomLogin(api)),
      },
      {
        id: `${ID}.tabroomLogout`,
        label: 'Log out of Tabroom',
        keywords: ['tabroom', 'caselist', 'logout', 'sign out'],
        defaultKey: null,
        run: (api) => withPrefs(api, () => tabroomLogout(api)),
      },
      {
        id: `${ID}.tabroomRounds`,
        label: 'Show my Tabroom rounds',
        keywords: ['tabroom', 'rounds', 'pairings', 'opponent', 'judge'],
        defaultKey: null,
        run: (api) => withPrefs(api, () => tabroomRounds(api)),
      },
      {
        id: `${ID}.caselistUpload`,
        label: 'Upload to Caselist…',
        keywords: ['caselist', 'opencaselist', 'disclose', 'disclosure', 'upload', 'open source'],
        defaultKey: null,
        run: (api) => withPrefs(api, () => caselistUpload(api)),
      },
      {
        id: `${ID}.caselistTeam`,
        label: 'Change caselist team…',
        keywords: ['caselist', 'opencaselist', 'team', 'school'],
        defaultKey: null,
        run: (api) => withPrefs(api, () => caselistTeam(api)),
      },
      {
        id: `${ID}.caselistScout`,
        label: 'Scout next opponent…',
        keywords: ['scout', 'opponent', 'caselist', 'prep', 'disclosure'],
        defaultKey: null,
        run: (api) => withPrefs(api, () => caselistScout(api)),
      },
      {
        id: `${ID}.markCards`,
        label: 'Mark cards…',
        keywords: ['mark', 'marked', 'red', 'cards', 'select'],
        defaultKey: null,
        run: (api) => withPrefs(api, () => markCards(api)),
      },
      {
        id: `${ID}.evidenceSearch`,
        label: 'Search my files…',
        keywords: ['search', 'evidence', 'card', 'find', 'files', 'backfile', 'tub', 'author', 'cite'],
        defaultKey: null,
        run: (api) => withPrefs(api, () => evidenceSearch(api)),
      },
      {
        id: `${ID}.evidenceFolders`,
        label: 'Set evidence folders…',
        keywords: ['search', 'evidence', 'folder', 'files', 'index'],
        defaultKey: null,
        run: (api) => withPrefs(api, () => evidenceFolders(api)),
      },
      {
        id: `${ID}.caselistSearch`,
        label: 'Search the caselist…',
        keywords: ['caselist', 'search', 'team', 'school', 'opencaselist'],
        defaultKey: null,
        run: (api) => withPrefs(api, () => caselistSearch(api)),
      },
    ],
  });
})();
