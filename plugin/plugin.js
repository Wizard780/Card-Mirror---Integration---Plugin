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
    if (ctx.zip && code === 'empty_room') return `SpeechDrop room ${ctx.room} has no files yet.`;
    if (ctx.zip && code === 'download_failed') return "Couldn't download any file in the room. Try again.";
    if (ctx.zip && code === 'too_large') return 'That room is too big for one zip (over 4 GB or 65,535 files).';
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
    if (ctx.email) {
      if (code.startsWith('smtp_rejected:')) return `Gmail refused it: ${code.slice('smtp_rejected:'.length)}`;
      switch (code) {
        case 'bad_login': return 'Gmail rejected that address or app password. Make a new app password and run "Set up Gmail for email chains…".';
        case 'bad_email': return "That isn't an email address.";
        case 'gmail_not_set_up': return 'Set up Gmail first: run "Set up Gmail for email chains…".';
        case 'bad_recipients': return 'Check the To list: one or more addresses look wrong.';
        case 'too_large': return 'The doc is over 20 MB, too big for Gmail.';
        case 'smtp_unreachable':
        case 'smtp_closed':
        case 'smtp_timeout': return "Couldn't reach Gmail. Nothing was sent; check your connection.";
        case 'newest_changed': return 'The newest send doc changed after the form opened. Nothing was sent; run Email again to check it.';
        case 'send_unknown':
        case 'upload_unknown':
        case 'start_unknown':
        case 'still_running':
        case 'unknown_job': return "Gmail didn't confirm. Check your Sent folder before sending again.";
        case 'keychain_failed': return "Couldn't use Keychain. Is it locked?";
        default: break;
      }
    }
    if (ctx.cardcheck) {
      switch (code) {
        case 'start_unknown':
        case 'upload_unknown':
        case 'unknown_job':
        case 'still_running': return "Card Check stopped answering. Results so far are shown; run it again for the rest.";
        case 'too_large': return 'This document is too big to check in one go.';
        default: break;
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
  const PREF_KEYS = ['caselistTarget', 'scoutCaselist', 'sendDocFolder', 'lastRoom', 'tabroomEmail', 'emailChain', 'emailBody'];
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
  const withPrefs = async (api, fn) => { syncLook(api); await restorePrefs(api); return fn(); };

  // "Interface theme" settings. Liquid is Sleek's layout in glass. CardMirror only
  // hands a plugin its api when a command runs, so the settings are also read
  // from CardMirror's own plugin storage at load and every second after.
  const THEMES = ['Standard', 'Sleek', 'Liquid'];
  let look = '';
  let lookTheme = null;
  let appTheme = null; // what's applied to CardMirror itself
  let lookWatched = false;
  const lookClass = (theme) => (theme === 'Liquid' ? ' du-sleek du-liquid' : theme === 'Sleek' ? ' du-sleek' : '');
  function applyTheme(rawTheme, rawWhole) {
    const theme = THEMES.includes(rawTheme) ? rawTheme : 'Standard';
    const wantApp = rawWhole === true && theme !== 'Standard' ? theme : null;
    if (theme !== lookTheme) {
      lookTheme = theme;
      look = lookClass(theme);
      if (typeof document !== 'undefined') {
        for (const n of document.querySelectorAll('.du-scrim, .du-pickbar')) {
          n.classList.remove('du-sleek', 'du-liquid');
          if (look) n.classList.add(...look.trim().split(' '));
        }
      }
    }
    // Retried on every poll until CardMirror's page rule is there to copy.
    if (wantApp !== appTheme && typeof document !== 'undefined' && applyAppTheme(wantApp)) appTheme = wantApp;
  }
  function syncLook(api) {
    const get = (k) => { try { return api.settings && api.settings.get(k); } catch { return undefined; } };
    applyTheme(get('theme'), get('themeWholeApp'));
    if (lookWatched || !api.settings || typeof api.settings.onChanged !== 'function') return;
    lookWatched = true;
    api.settings.onChanged((key) => { if (key === 'theme' || key === 'themeWholeApp') applyTheme(get('theme'), get('themeWholeApp')); });
  }
  function storedTheme() {
    try {
      const s = JSON.parse(localStorage.getItem(`plugin:${ID}`) || '{}').__settings || {};
      applyTheme(s.theme, s.themeWholeApp);
    } catch { /* storage unreadable: themes apply when a command runs */ }
  }

  // ---------------------------------------------------------------- Whole-app theme
  // Not a CardMirror API: CardMirror paints its chrome from --pmd-c-* tokens, so
  // redefining them on <html> restyles the app. The page keeps CardMirror's own
  // light paper: its dark-mode rule that resets the editor is copied under our class.
  const APP_CSS = `
:root.du-app-sleek{--pmd-c-bg:#fff;--pmd-c-bg-soft:#fafafa;--pmd-c-surface-soft:#fafafa;--pmd-c-surface:#fafafa;--pmd-c-surface-alt:#f4f4f5;
  --pmd-c-border:#e4e4e7;--pmd-c-border-soft:#e4e4e7;--pmd-c-divider:#ececee;--pmd-c-divider-faint:#f4f4f5;
  --pmd-c-text:#18181b;--pmd-c-text-strong:#09090b;--pmd-c-text-secondary:#52525b;--pmd-c-text-muted:#71717a;--pmd-c-text-faint:#a1a1aa;
  --pmd-c-hover:#f4f4f5;--pmd-c-hover-strong:#e4e4e7;--pmd-c-button-hover:rgba(0,0,0,.045);--pmd-c-button-active:rgba(0,0,0,.07);
  --pmd-c-button-press:rgba(0,0,0,.08);--pmd-c-button-press-border:rgba(0,0,0,.2);--pmd-c-button-press-soft:rgba(0,0,0,.05);--pmd-c-button-press-soft-border:rgba(0,0,0,.12);
  --pmd-c-accent:#2f6fde;--pmd-c-accent-hover:#2559b8;--pmd-c-accent-soft:rgba(47,111,222,.12);--pmd-c-text-on-accent:#fff;
  --pmd-c-focus:#2f6fde;--pmd-c-focus-glow:rgba(47,111,222,.18);--pmd-c-overlay:rgba(0,0,0,.28);
  --pmd-c-info-bg:rgba(0,0,0,.05);--pmd-c-drop-soft:rgba(0,0,0,.055);--pmd-c-info-bg-alt:rgba(0,0,0,.035)}
:root.du-app-sleek[data-theme="dark"]{--pmd-c-bg:#111113;--pmd-c-bg-soft:#151517;--pmd-c-surface-soft:#131315;--pmd-c-surface:#0e0e10;--pmd-c-surface-alt:#0a0a0b;
  --pmd-c-border:#2a2a2e;--pmd-c-border-soft:#232327;--pmd-c-divider:#1f1f23;--pmd-c-divider-faint:#19191c;
  --pmd-c-text:#ececee;--pmd-c-text-strong:#fff;--pmd-c-text-secondary:#a1a1aa;--pmd-c-text-muted:#8b8b93;--pmd-c-text-faint:#63636b;
  --pmd-c-hover:#1c1c1f;--pmd-c-hover-strong:#26262a;--pmd-c-button-hover:rgba(255,255,255,.06);--pmd-c-button-active:rgba(255,255,255,.09);
  --pmd-c-button-press:rgba(255,255,255,.1);--pmd-c-button-press-border:rgba(255,255,255,.22);--pmd-c-button-press-soft:rgba(255,255,255,.07);--pmd-c-button-press-soft-border:rgba(255,255,255,.14);
  --pmd-c-accent:#6b9cff;--pmd-c-accent-hover:#8ab1ff;--pmd-c-accent-soft:rgba(107,156,255,.16);--pmd-c-text-on-accent:#fff;
  --pmd-c-focus:#6b9cff;--pmd-c-focus-glow:rgba(107,156,255,.25);--pmd-c-overlay:rgba(0,0,0,.5);
  --pmd-c-info-bg:rgba(255,255,255,.07);--pmd-c-drop-soft:rgba(255,255,255,.075);--pmd-c-info-bg-alt:rgba(255,255,255,.045)}
:root.du-app-liquid{color-scheme:dark;--pmd-c-bg:#0b0f17;--pmd-c-bg-soft:#0e131c;--pmd-c-surface-soft:#0d121a;--pmd-c-surface:#0a0e15;--pmd-c-surface-alt:#070a10;
  --pmd-c-border:#1f2633;--pmd-c-border-soft:#1a202b;--pmd-c-divider:#161c26;--pmd-c-divider-faint:#121720;
  --pmd-c-text:#c0caf5;--pmd-c-text-strong:#e4e9ff;--pmd-c-text-secondary:#a9b1d6;--pmd-c-text-muted:#7090a8;--pmd-c-text-faint:#4a6070;
  --pmd-c-hover:rgba(255,255,255,.05);--pmd-c-hover-strong:rgba(255,255,255,.09);--pmd-c-button-hover:rgba(255,255,255,.07);--pmd-c-button-active:rgba(122,162,247,.14);
  --pmd-c-button-press:rgba(122,162,247,.18);--pmd-c-button-press-border:rgba(122,162,247,.45);--pmd-c-button-press-soft:rgba(122,162,247,.1);--pmd-c-button-press-soft-border:rgba(122,162,247,.3);
  --pmd-c-accent:#7aa2f7;--pmd-c-accent-hover:#93b4ff;--pmd-c-accent-soft:rgba(122,162,247,.16);--pmd-c-text-on-accent:#fff;
  --pmd-c-focus:#7aa2f7;--pmd-c-focus-glow:rgba(122,162,247,.25);--pmd-c-link:#7aa2f7;--pmd-c-overlay:rgba(4,6,12,.5);
  --pmd-color-analytic:#8aa9d1;--pmd-color-undertag:#8fb377;
  --pmd-c-success:#73daca;--pmd-c-error:#f7768e;--pmd-c-warning:#e0af68;--pmd-c-info-bg:rgba(122,162,247,.14);--pmd-c-drop-soft:rgba(122,162,247,.16);--pmd-c-info-bg-alt:rgba(122,162,247,.08);
  background:radial-gradient(900px 520px at 0% 0%,rgba(122,162,247,.16),transparent 60%),radial-gradient(800px 600px at 100% 100%,rgba(115,218,202,.07),transparent 60%),#070a10}
:root.du-app-liquid body{background:transparent}
:root.du-app #ribbon{border-bottom:1px solid var(--pmd-c-divider)}
:root.du-app #ribbon button:not(.formatting-panel-btn):not(.pmd-timer-prep):not([aria-pressed="true"]),
:root.du-app #status-bar button:not([aria-pressed="true"]){background-color:transparent;border-color:transparent}
:root.du-app #ribbon button:not(.formatting-panel-btn):not(.pmd-timer-prep):not([aria-pressed="true"]):hover,
:root.du-app #status-bar button:not([aria-pressed="true"]):hover{background-color:var(--pmd-c-button-hover)}
:root.du-app #ribbon button,:root.du-app .pmd-nav-panel button,:root.du-app #status-bar button{border-radius:7px;transition:background-color .12s,border-color .12s,color .12s}
:root.du-app .pmd-nav-item{border-radius:7px}
:root.du-app #status-bar{border-top:1px solid var(--pmd-c-divider)}
/* Sleek keeps a real blue accent (selections, markers); the chrome's "selected" states stay monochrome */
:root.du-app-sleek .pmd-pane-focused .pmd-pane-chip{background:#09090b;box-shadow:inset 0 -2px 0 var(--pmd-c-accent)}
:root.du-app-sleek .pmd-pane-focused .pmd-pane-chip :is(.pmd-pane-chip-name,.pmd-pane-chip-close,.pmd-pane-chip-stack,.pmd-pane-chip-nav,.pmd-pane-chip-hide,.pmd-pane-chip-expand,.pmd-pane-chip-slot-num){color:#fff}
:root.du-app-sleek[data-theme="dark"] .pmd-pane-focused .pmd-pane-chip{background:#000}
:root.du-app-sleek .pmd-nav-level-btn-active{background:var(--pmd-c-text);border-color:var(--pmd-c-text);color:var(--pmd-c-bg)}
:root.du-app .pmd-nav-panel{border-right:1px solid var(--pmd-c-divider)}
:root.du-app ::-webkit-scrollbar{width:10px;height:10px}
:root.du-app ::-webkit-scrollbar-thumb{background:var(--pmd-c-border);border-radius:8px;border:2px solid transparent;background-clip:padding-box}
:root.du-app ::-webkit-scrollbar-thumb:hover{background-color:var(--pmd-c-text-faint)}
:root.du-app ::-webkit-scrollbar-track{background:transparent}
:root.du-app-liquid #ribbon,:root.du-app-liquid #status-bar{background:rgba(10,14,20,.45);backdrop-filter:blur(32px) saturate(160%);border-color:rgba(255,255,255,.06)}
:root.du-app-liquid #ribbon{box-shadow:inset 0 1px 0 rgba(255,255,255,.06)}
:root.du-app-liquid .pmd-nav-panel{background:rgba(10,14,20,.3);backdrop-filter:blur(32px) saturate(160%);border-right-color:rgba(255,255,255,.05)}
:root.du-app-liquid .pmd-nav-panel>header{background:linear-gradient(180deg,rgba(255,255,255,.04),transparent);border-bottom:1px solid rgba(255,255,255,.05)}
:root.du-app-liquid #ribbon .formatting-panel-btn,:root.du-app-liquid .pmd-nav-panel button:not(.pmd-nav-level-btn-active){background-color:rgba(255,255,255,.04);border-color:rgba(255,255,255,.08)}
:root.du-app-liquid #ribbon .formatting-panel-btn:hover,:root.du-app-liquid .pmd-nav-panel button:not(.pmd-nav-level-btn-active):hover{background-color:rgba(255,255,255,.08);border-color:rgba(255,255,255,.14)}
:root.du-app-liquid .pmd-nav-panel button[aria-pressed="true"],:root.du-app-liquid #ribbon button[aria-pressed="true"],:root.du-app-liquid .pmd-nav-level-btn-active{background-color:rgba(122,162,247,.18);border-color:rgba(122,162,247,.4);
  box-shadow:inset 0 1px 0 rgba(255,255,255,.1),0 0 12px rgba(122,162,247,.15)}
:root.du-app-liquid ::-webkit-scrollbar-thumb{background-color:rgba(255,255,255,.07)}
`;
  // CardMirror's page reset (light paper inside a dark app), re-scoped to our themes.
  function pageGuard() {
    const find = (rules) => {
      for (const r of rules) {
        if (r.selectorText && /data-theme-doc/.test(r.selectorText) && /#editor/.test(r.selectorText) && /--pmd-c-bg\s*:/.test(r.style.cssText)) {
          return `:root.du-app:not([data-theme-doc="dark"]) :is(#editor, .pmd-pane-editor){${r.style.cssText}}`;
        }
        const inner = r.cssRules && find(r.cssRules); // @media, @layer, @supports
        if (inner) return inner;
      }
      return '';
    };
    for (const sheet of document.styleSheets) {
      let rules;
      try { rules = sheet.cssRules; } catch { continue; }
      const hit = find(rules);
      if (hit) return hit;
    }
    return '';
  }
  // Returns false (try again later) rather than theme CardMirror without the page guard,
  // so the document is never recolored.
  function applyAppTheme(theme) {
    const root = document.documentElement;
    if (!root) return false;
    if (theme && !document.getElementById('du-app-style')) {
      const guard = pageGuard();
      if (!guard) return false;
      (document.head || document.body).append(el('style', { id: 'du-app-style', textContent: APP_CSS + guard }));
    }
    root.classList.toggle('du-app', !!theme);
    root.classList.toggle('du-app-sleek', theme === 'Sleek');
    root.classList.toggle('du-app-liquid', theme === 'Liquid');
    return true;
  }

  async function call(api, route, body) {
    const r = await api.flowPost(ID, route, body);
    if (!r.ok) throw new Error(r.error);
    if (r.status === 401) throw new Error('bad_token');
    if (r.body && r.body.ok === false) throw new Error(r.body.error);
    return r.body;
  }

  const MAX_POLL_FAILURES = 5;

  async function runJob(api, route, body, sleep, { onProgress, maxPolls = MAX_POLLS } = {}) {
    let job;
    try {
      ({ job } = await call(api, route, body));
    } catch (err) {
      // A timeout or garbled reply may come after the helper started the job.
      if (err.message === 'timeout' || err.message === 'bad-response') throw new Error('start_unknown');
      throw err; // helper down / restarted / unsupported: nothing was sent
    }
    let failures = 0;
    for (let polls = 0; polls < maxPolls; polls++) {
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
      if (onProgress && s.progress) onProgress(s.progress);
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
.du-wrap .du-row-main{white-space:normal;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical}
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
.du-hint{font-size:.78rem;color:var(--pmd-c-text-muted);overflow-wrap:anywhere}
.du-st{flex:none;width:1.2em;text-align:center;font-weight:700}
.du-st-matches{color:var(--pmd-c-success)}
.du-st-differences{color:var(--pmd-c-warning)}
.du-st-unverified,.du-st-unreachable,.du-st-no_link,.du-st-pending,.du-st-skipped{color:var(--pmd-c-text-muted)}
.du-issues{margin:0;padding-left:1.1em}
.du-issues li+li{margin-top:6px}
.du-btn:disabled{opacity:.5;cursor:default}
.du-btn:disabled:hover{background:var(--pmd-c-bg)}
.du-cmp{height:min(86vh,760px);max-height:86vh}
.du-cmp-bar{display:flex;align-items:center;flex-wrap:wrap;gap:8px 16px;padding:0 20px 12px}
.du-cmp-bar .du-seg button{flex:none;padding:5px 12px;font-size:.85rem}
.du-toggle{display:flex;align-items:center;gap:6px;font-size:.85rem;color:var(--pmd-c-text-secondary);cursor:pointer;user-select:none}
.du-toggle input{margin:0;accent-color:var(--pmd-c-accent)}
.du-cmp-nav{margin-left:auto;display:flex;align-items:center;gap:6px;font-size:.82rem;color:var(--pmd-c-text-muted);font-variant-numeric:tabular-nums}
.du-cmp-nav .du-btn{padding:4px 10px}
.du-cmp-cols{flex:1 1 auto;min-height:0;display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:12px;padding:0 20px 16px}
.du-cmp-col{display:flex;flex-direction:column;gap:6px;min-height:0;min-width:0}
.du-cmp-head{display:flex;align-items:center;gap:6px;min-height:28px}
.du-cmp-head .du-label{flex:1;min-width:0}
.du-cmp-head .du-btn{padding:3px 9px;font-size:.8rem}
.du-cmp-text,.du-cmp-out{flex:1 1 auto;min-height:0;font-size:.9rem;line-height:1.55}
textarea.du-cmp-text{resize:none;min-height:0}
.du-cmp-out{position:relative;overflow:auto;padding:7px 10px;border:1px solid var(--pmd-c-border);border-radius:6px;background:var(--pmd-c-bg);
  white-space:pre-wrap;overflow-wrap:anywhere;outline:none}
.du-cmp-out:focus-visible{border-color:var(--pmd-c-focus);box-shadow:0 0 0 3px var(--pmd-c-accent-soft)}
.du-cmp-out[hidden],.du-cmp-text[hidden]{display:none}
.du-cmp-out [data-g]{border-radius:2px;cursor:pointer}
.du-k1.du-a{background:color-mix(in srgb,var(--pmd-c-error) 12%,transparent)}
.du-k2.du-a{background:color-mix(in srgb,var(--pmd-c-error) 30%,transparent)}
.du-k1.du-b{background:color-mix(in srgb,var(--pmd-c-success) 12%,transparent)}
.du-k2.du-b{background:color-mix(in srgb,var(--pmd-c-success) 32%,transparent)}
.du-k3{display:inline-block;width:3px;height:1.15em;margin:0 1px;vertical-align:text-bottom}
.du-k3.du-a{background:var(--pmd-c-error)}
.du-k3.du-b{background:var(--pmd-c-success)}
.du-cmp-out .du-cur{text-decoration:underline 2px var(--pmd-c-focus);text-underline-offset:4px;text-decoration-skip-ink:none}
.du-cmp-out .du-k3.du-cur{box-shadow:0 0 0 2px var(--pmd-c-focus)}
.du-pickbar{position:fixed;left:50%;bottom:48px;transform:translateX(-50%);z-index:100000;display:flex;align-items:center;gap:10px;
  padding:8px 10px 8px 16px;border-radius:10px;background:var(--pmd-c-bg);color:var(--pmd-c-text);border:1px solid var(--pmd-c-border-soft);
  box-shadow:0 12px 34px var(--pmd-c-shadow-deep,rgba(0,0,0,.28));font-family:var(--pmd-ui-font,system-ui,sans-serif);font-size:.88rem}
/* Sleek interface: monochrome, built from the theme's own text and page colors */
.du-sleek{--du-line:color-mix(in srgb,var(--pmd-c-text) 10%,transparent);--du-line-2:color-mix(in srgb,var(--pmd-c-text) 17%,transparent);
  --du-soft:color-mix(in srgb,var(--pmd-c-text) 4%,transparent);--du-soft-2:color-mix(in srgb,var(--pmd-c-text) 8%,transparent);
  --du-muted:color-mix(in srgb,var(--pmd-c-text) 56%,var(--pmd-c-bg));-webkit-font-smoothing:antialiased}
.du-scrim.du-sleek{background:color-mix(in srgb,var(--pmd-c-overlay,rgba(0,0,0,.4)) 75%,transparent);backdrop-filter:blur(6px) saturate(1.05)}
.du-sleek .du-dialog{border-radius:14px;border:1px solid var(--du-line);font-size:13px;
  box-shadow:0 28px 70px -16px rgba(0,0,0,.42),0 10px 24px -10px rgba(0,0,0,.22);animation:du-in-sleek .16s cubic-bezier(.2,.9,.3,1)}
@keyframes du-in-sleek{from{opacity:0;transform:translateY(4px) scale(.985)}}
@media (prefers-reduced-motion:reduce){.du-sleek .du-dialog{animation:none}}
.du-sleek .du-head{padding:14px 16px 8px}
.du-sleek .du-title{font-size:14px;font-weight:600;letter-spacing:-.01em}
.du-sleek .du-sub{font-size:12px;color:var(--du-muted)}
.du-sleek .du-body{padding:4px 16px 14px}
.du-sleek .du-foot{background:transparent;border-top:1px solid var(--du-line);padding:9px 10px 9px 16px;gap:6px}
.du-sleek .du-note,.du-sleek .du-hint{font-size:12px;color:var(--du-muted)}
.du-sleek .du-label{font-size:12px;color:var(--du-muted)}
.du-sleek .du-input{font-size:13px;border-radius:8px;border-color:var(--du-line-2);background:var(--du-soft);padding:6px 10px}
.du-sleek .du-input:focus{border-color:color-mix(in srgb,var(--pmd-c-text) 38%,transparent);box-shadow:0 0 0 3px var(--du-soft-2);background:var(--pmd-c-bg)}
.du-sleek .du-btn{font-size:12.5px;font-weight:500;padding:5px 11px;border-radius:8px;border-color:var(--du-line-2);background:transparent}
.du-sleek .du-btn:hover{background:var(--du-soft-2)}
.du-sleek .du-btn:disabled:hover{background:transparent}
.du-sleek .du-btn:focus-visible,.du-sleek .du-choice:focus-visible,.du-sleek .du-seg button:focus-visible{outline:2px solid color-mix(in srgb,var(--pmd-c-text) 45%,transparent);outline-offset:2px}
.du-sleek .du-primary{background:var(--pmd-c-text);border-color:var(--pmd-c-text);color:var(--pmd-c-bg);font-weight:600}
.du-sleek .du-primary:hover{background:color-mix(in srgb,var(--pmd-c-text) 84%,var(--pmd-c-bg))}
.du-sleek .du-primary:disabled:hover{background:var(--pmd-c-text)}
.du-sleek .du-seg{border:0;border-radius:9px;padding:2px;gap:2px;background:var(--du-soft-2)}
.du-sleek .du-seg button,.du-sleek .du-seg button+button{border:0;border-radius:7px;background:transparent;color:var(--du-muted);font-size:12.5px;font-weight:500;padding:4px 11px}
.du-sleek .du-seg button:hover{background:transparent;color:var(--pmd-c-text)}
.du-sleek .du-seg button[aria-pressed="true"],.du-sleek .du-tabs button[aria-selected="true"]{background:var(--pmd-c-bg);color:var(--pmd-c-text);font-weight:600;
  box-shadow:0 1px 2px rgba(0,0,0,.14),0 0 0 1px var(--du-line)}
.du-sleek .du-choice{border-color:var(--du-line);border-radius:9px;font-size:13px}
.du-sleek .du-choice:hover{background:var(--du-soft)}
.du-sleek .du-choice[aria-checked="true"]{border-color:color-mix(in srgb,var(--pmd-c-text) 40%,transparent);background:var(--du-soft-2)}
.du-sleek .du-choice[aria-checked="true"] .du-radio{border-color:var(--pmd-c-text)}
.du-sleek .du-choice-detail{font-size:12px;color:var(--du-muted)}
.du-sleek .du-fill{border-radius:10px;border-color:var(--du-line);background:var(--du-soft)}
.du-sleek .du-search{margin:0 12px 8px;width:calc(100% - 24px)}
.du-sleek .du-list{padding:0 6px 6px}
.du-sleek .du-row{border-radius:8px;padding:7px 10px}
.du-sleek .du-row:hover{background:var(--du-soft)}
.du-sleek .du-row[aria-selected="true"]{background:var(--du-soft-2)}
.du-sleek .du-row-main{font-size:13px}
.du-sleek .du-row-detail,.du-sleek .du-row-sub,.du-sleek .du-where{font-size:11.5px;color:var(--du-muted)}
.du-sleek .du-group{font-size:10.5px;text-transform:uppercase;letter-spacing:.07em;color:var(--du-muted)}
.du-sleek .du-empty{font-size:12.5px;color:var(--du-muted)}
.du-sleek .du-split{border-top-color:var(--du-line)}
.du-sleek .du-split .du-list{border-color:var(--du-line)}
.du-sleek .du-pane{font-size:13px}
.du-sleek .du-pane h3{font-size:10.5px;text-transform:uppercase;letter-spacing:.07em;color:var(--du-muted)}
.du-sleek .du-info dt,.du-sleek .du-pane-meta,.du-sleek .du-round{color:var(--du-muted)}
.du-sleek .du-link{color:var(--pmd-c-text);text-decoration-color:var(--du-line-2)}
.du-sleek .du-check{border-radius:4px;border-color:var(--du-line-2)}
.du-sleek .du-toggle{font-size:12.5px;color:var(--du-muted)}
.du-sleek .du-toggle input{accent-color:var(--pmd-c-text)}
.du-sleek .du-cmp-nav{font-size:12px}
.du-sleek .du-cmp-out,.du-sleek textarea.du-cmp-text{border-radius:10px;border-color:var(--du-line-2);font-size:13.5px}
.du-sleek .du-cmp-out{background:transparent}
.du-sleek .du-cmp-out:focus-visible{border-color:color-mix(in srgb,var(--pmd-c-text) 38%,transparent);box-shadow:0 0 0 3px var(--du-soft-2)}
.du-sleek .du-cmp-out .du-cur{text-decoration-color:var(--pmd-c-text)}
.du-sleek .du-cmp-out .du-k3.du-cur{box-shadow:0 0 0 2px var(--pmd-c-text)}
.du-pickbar.du-sleek{border-radius:12px;border-color:var(--du-line);font-size:13px;background:color-mix(in srgb,var(--pmd-c-bg) 86%,transparent);
  backdrop-filter:blur(14px) saturate(1.1);box-shadow:0 18px 44px -12px rgba(0,0,0,.4)}
/* Liquid: Lynx Theme Pro's LIQUID palette and frosted glass, on top of Sleek's layout */
.du-liquid{--pmd-c-text:#c0caf5;--pmd-c-bg:#0a0e15;--pmd-c-error:#f7768e;--pmd-c-success:#73daca;--pmd-c-warning:#e0af68;
  --pmd-c-accent:#7aa2f7;--pmd-c-focus:#7aa2f7;--du-line:rgba(255,255,255,.08);--du-line-2:rgba(255,255,255,.12);
  --du-soft:rgba(255,255,255,.04);--du-soft-2:rgba(122,162,247,.10);--du-muted:#7090a8;--du-ease:cubic-bezier(.16,1,.3,1);color-scheme:dark}
.du-scrim.du-liquid{background:rgba(4,6,12,.38);backdrop-filter:blur(6px) saturate(120%)}
.du-liquid .du-dialog{position:relative;color:var(--pmd-c-text);background:rgba(8,12,18,.72);backdrop-filter:blur(48px) saturate(180%);
  border:1px solid rgba(255,255,255,.08);border-radius:16px;animation:du-in-liquid .25s var(--du-ease);
  box-shadow:0 8px 40px rgba(0,0,0,.65),0 2px 8px rgba(0,0,0,.4),inset 0 1px 0 rgba(255,255,255,.18),0 0 30px rgba(122,162,247,.08)}
.du-liquid .du-dialog::before{content:'';position:absolute;top:0;left:0;right:0;height:1px;pointer-events:none;z-index:1;
  background:linear-gradient(90deg,transparent,rgba(255,255,255,.18) 30%,rgba(255,255,255,.25) 50%,rgba(255,255,255,.18) 70%,transparent)}
@keyframes du-in-liquid{from{opacity:0;transform:translateY(6px) scale(.98)}}
@media (prefers-reduced-motion:reduce){.du-liquid .du-dialog{animation:none}}
.du-liquid .du-title{color:#e4e9ff;text-shadow:0 1px 8px rgba(122,162,247,.15)}
.du-liquid .du-foot{background:rgba(255,255,255,.02)}
.du-liquid .du-btn{background:rgba(255,255,255,.04);color:var(--pmd-c-text);
  transition:background .15s var(--du-ease),box-shadow .25s var(--du-ease),transform .15s cubic-bezier(.34,1.56,.64,1)}
.du-liquid .du-btn:hover{background:rgba(255,255,255,.08);box-shadow:0 2px 8px rgba(255,255,255,.06)}
.du-liquid .du-btn:disabled:hover{background:rgba(255,255,255,.04);box-shadow:none}
.du-liquid .du-primary,.du-liquid .du-primary:disabled:hover{color:#fff;border-color:rgba(122,162,247,.45);
  background:linear-gradient(135deg,rgba(122,162,247,.65),rgba(80,110,190,.55));box-shadow:0 2px 12px rgba(122,162,247,.2),inset 0 1px 0 rgba(255,255,255,.18)}
.du-liquid .du-primary:hover:not(:disabled){background:linear-gradient(135deg,rgba(122,162,247,.8),rgba(80,110,190,.7));
  box-shadow:0 4px 24px rgba(122,162,247,.35),inset 0 1px 0 rgba(255,255,255,.22);transform:translateY(-1px)}
.du-liquid .du-primary:active{transform:none}
.du-liquid .du-btn:focus-visible,.du-liquid .du-choice:focus-visible,.du-liquid .du-seg button:focus-visible{outline:2px solid rgba(122,162,247,.6)}
.du-liquid .du-input{background:rgba(255,255,255,.04);border-color:var(--du-line-2);color:var(--pmd-c-text)}
.du-liquid .du-input::placeholder{color:#4a6070}
.du-liquid .du-input:focus{background:rgba(255,255,255,.05);border-color:rgba(122,162,247,.45);box-shadow:0 0 0 3px rgba(122,162,247,.12)}
.du-liquid .du-input option{background:#0a0e15}
.du-liquid .du-seg{background:rgba(255,255,255,.05)}
.du-liquid .du-seg button[aria-pressed="true"],.du-liquid .du-tabs button[aria-selected="true"]{background:rgba(122,162,247,.18);color:#e4e9ff;
  box-shadow:inset 0 1px 0 rgba(255,255,255,.12),0 0 0 1px rgba(122,162,247,.3)}
.du-liquid .du-row:hover,.du-liquid .du-choice:hover{background:rgba(255,255,255,.04)}
.du-liquid .du-row[aria-selected="true"]{background:rgba(122,162,247,.14)}
.du-liquid .du-choice[aria-checked="true"]{border-color:rgba(122,162,247,.45);background:rgba(122,162,247,.08)}
.du-liquid .du-choice[aria-checked="true"] .du-radio{border-color:#7aa2f7}
.du-liquid .du-toggle input{accent-color:#7aa2f7}
.du-liquid .du-link{color:#7aa2f7;text-decoration-color:rgba(122,162,247,.4)}
.du-liquid .du-cmp-out .du-cur{text-decoration-color:#7aa2f7}
.du-liquid .du-cmp-out .du-k3.du-cur{box-shadow:0 0 0 2px #7aa2f7}
.du-liquid ::-webkit-scrollbar{width:10px;height:10px}
.du-liquid ::-webkit-scrollbar-thumb{background:rgba(255,255,255,.06);border-radius:4px;border:2px solid transparent;background-clip:padding-box}
.du-liquid ::-webkit-scrollbar-thumb:hover{background-color:rgba(255,255,255,.12)}
.du-liquid ::-webkit-scrollbar-track{background:transparent}
.du-pickbar.du-liquid{color:var(--pmd-c-text);background:rgba(8,12,18,.72);backdrop-filter:blur(48px) saturate(180%);border:1px solid rgba(255,255,255,.08);
  border-radius:16px;box-shadow:0 8px 40px rgba(0,0,0,.65),inset 0 1px 0 rgba(255,255,255,.18),0 0 30px rgba(122,162,247,.08)}
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
    const scrim = el('div', { class: `du-scrim${look}` }, [dialog]);
    let onDismiss = () => {};
    scrim.addEventListener('mousedown', (e) => { if (e.target === scrim) onDismiss(); });
    dialog.addEventListener('keydown', (e) => {
      e.stopPropagation(); // CardMirror hotkeys never see keys typed here
      if (e.key === 'Escape') { e.preventDefault(); onDismiss(); }
    });
    document.body.append(scrim);
    return {
      dialog, head, body, foot, scrim,
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
      const d = openDialog({ title, stacked: opts.stacked || opts.wrap, width: opts.wrap ? '760px' : '560px' });
      if (opts.wrap) d.dialog.className += ' du-wrap'; // long rows (card text) get up to three lines
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
        let shownQuery = null; // the query the current items answer
        let pending = null; // a debounced query not sent yet
        const done = () => { if (closed) return; closed = true; clearTimeout(timer); d.close(); resolve(); };
        const pick = async (how) => {
          // Enter right after typing: answer the new text first, never open a stale row.
          if (pending !== null || shownQuery !== input.value) await run();
          if (closed || shownQuery !== input.value) return; // still not the typed text (a second Enter took over)
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
          pending = null;
          const mine = ++seq;
          const q = input.value;
          const r = await spec.onQuery(q);
          if (closed || mine !== seq) return; // a newer query is on its way
          // A refresh of the same query (still indexing) keeps the highlighted row.
          const keep = q === shownQuery && items[sel] ? items[sel].key : undefined;
          items = r.items;
          const at = keep === undefined ? -1 : items.findIndex((it) => it.key === keep);
          sel = at === -1 ? 0 : at;
          shownQuery = q;
          status.set(r.status || '');
          render(r.empty);
          if (r.again) timer = setTimeout(run, 1500); // still indexing: refresh as it grows
        };
        input.addEventListener('input', () => { clearTimeout(timer); pending = input.value; timer = setTimeout(run, 120); });
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

    // Side-by-side compare: edit the two texts, then Compare shows both with the
    // differences marked; ↑↓ step through them. Resolves when closed.
    compareText(spec) {
      return new Promise((resolve) => {
        const d = openDialog({ title: 'Compare text', width: '1040px' });
        d.dialog.className += ' du-cmp';
        d.body.remove();
        const o = { ...spec.opts };
        let res = null;
        let cur = -1;
        let showing = false;
        const status = note('');
        const save = () => spec.onChange({ texts: sides.map((s) => s.text.value), opts: { ...o } });

        const sides = [0, 1].map((k) => {
          const text = el('textarea', {
            class: 'du-input du-cmp-text', value: spec.texts[k] || '', spellcheck: false,
            placeholder: k ? 'Paste the second text, or press Use selection and select it in your document' : 'Paste the first text, or press Use selection',
            attrs: { 'aria-label': `Text ${k + 1}` },
          });
          text.addEventListener('input', save);
          const out = el('div', { class: 'du-cmp-out', tabIndex: 0, hidden: true, attrs: { 'aria-label': `Text ${k + 1}, differences marked` } });
          out.addEventListener('mousedown', (e) => { const g = e.target.dataset && e.target.dataset.g; if (g != null) goTo(Number(g)); });
          const head = el('div', { class: 'du-cmp-head' }, [
            el('span', { class: 'du-label', textContent: `Text ${k + 1}` }),
            button('Use selection', false, () => pick(k)),
            button('Clear', false, () => { text.value = ''; save(); edit(k); }),
          ]);
          return { text, out, col: el('div', { class: 'du-cmp-col' }, [head, text, out]) };
        });

        const modes = el('div', { class: 'du-seg', attrs: { role: 'group', 'aria-label': 'Compare by' } },
          [['words', 'Words'], ['chars', 'Characters']].map(([m, label]) =>
            el('button', { type: 'button', textContent: label, data: { mode: m }, onclick: () => { o.mode = m; changed(); } })));
        const toggle = (key, label) => {
          const box = el('input', { type: 'checkbox', checked: !!o[key], onchange: () => { o[key] = box.checked; changed(); } });
          return el('label', { class: 'du-toggle' }, [box, label]);
        };
        const count = el('span', { attrs: { 'aria-live': 'polite' } });
        const prev = button('↑', false, () => goTo(cur - 1));
        const next = button('↓', false, () => goTo(cur + 1));
        prev.title = 'Previous difference (↑)';
        next.title = 'Next difference (↓)';
        const nav = el('div', { class: 'du-cmp-nav' }, [count, prev, next]);
        const bar = el('div', { class: 'du-cmp-bar' }, [modes, toggle('ignoreCase', 'Ignore case'), toggle('ignoreSpace', 'Ignore spacing'), nav]);
        const cols = el('div', { class: 'du-cmp-cols' }, sides.map((s) => s.col));
        if (d.dialog.insertBefore) { d.dialog.insertBefore(bar, d.foot); d.dialog.insertBefore(cols, d.foot); } else d.dialog.append(bar, cols);

        const main = button('Compare', true, () => (showing ? edit(0) : run()));
        d.foot.append(status.node, button('Swap', false, () => {
          [sides[0].text.value, sides[1].text.value] = [sides[1].text.value, sides[0].text.value];
          save();
          if (showing) run(true);
        }), main);

        const close = () => { d.close(); resolve(); };
        d.onDismiss(close);

        const paintBar = () => {
          for (const b of modes.children) b.setAttribute('aria-pressed', String(b.dataset.mode === (o.mode === 'chars' ? 'chars' : 'words')));
          const n = showing && res ? res.diffs : 0;
          count.textContent = n ? `${cur + 1} of ${n}` : '';
          prev.disabled = !n || cur <= 0;
          next.disabled = !n || cur >= n - 1;
        };
        const edit = (k) => {
          showing = false;
          for (const s of sides) { s.text.hidden = false; s.out.hidden = true; }
          main.textContent = 'Compare';
          status.set('⌘Enter to compare · Esc to close');
          paintBar();
          sides[k].text.focus();
        };
        const paintSide = (out, pieces, side) => {
          out.textContent = '';
          for (const p of pieces) {
            if (!p.kind) { out.append(p.text); continue; }
            // A changed line break or space has to be visible.
            const shown = p.kind === 3 ? '' : p.kind === 2 ? p.text.replace(/\n/g, '↵\n') : p.text;
            const span = el('span', { class: `du-k${p.kind} du-${side}`, textContent: shown, data: { g: String(p.g) } });
            if (p.kind === 3) span.title = side === 'a' ? 'Text 2 has text here' : 'Text 1 has text here';
            out.append(span);
          }
        };
        const run = (rerun = false) => {
          const [a, b] = sides.map((s) => s.text.value);
          if (!a.trim() && !b.trim()) { status.set('Paste or select two texts to compare.'); return; }
          res = spec.compare(a, b, o);
          showing = true;
          paintSide(sides[0].out, res.left, 'a');
          paintSide(sides[1].out, res.right, 'b');
          for (const s of sides) { s.text.hidden = true; s.out.hidden = false; if (!rerun) s.out.scrollTop = 0; }
          main.textContent = 'Edit';
          const ignoring = [o.ignoreCase && 'case', o.ignoreSpace && 'spacing'].filter(Boolean).join(' and ');
          status.set(!res.diffs
            ? (a === b ? 'Identical, byte for byte.' : `No differences${ignoring ? ` (ignoring ${ignoring})` : ''}.`)
            : [plural(res.diffs, 'difference'), res.removed && `${plural(res.removed, res.unit)} only in Text 1`,
              res.added && `${plural(res.added, res.unit)} only in Text 2`, res.timedOut && 'too long to line up exactly'].filter(Boolean).join(' · '));
          if (rerun) { goTo(cur); return; } // an option or Swap: stay where you were
          cur = -1;
          if (res.diffs) goTo(0); else paintBar();
          sides[1].out.focus();
        };
        const goTo = (i) => {
          if (!res || !res.diffs) { cur = -1; paintBar(); return; }
          cur = Math.max(0, Math.min(i, res.diffs - 1));
          for (const s of sides) {
            let first = null;
            for (const span of s.out.querySelectorAll('[data-g]')) {
              const on = span.dataset.g === String(cur);
              span.classList.toggle('du-cur', on);
              if (on && !first) first = span;
            }
            if (first) s.out.scrollTop = Math.max(0, first.offsetTop - s.out.clientHeight / 3);
          }
          paintBar();
        };
        const changed = () => { save(); paintBar(); if (showing) run(true); };

        // The dialog steps aside so text can be selected in the document.
        const pick = (k) => {
          d.scrim.style.display = 'none';
          const finish = (take) => {
            pickBar.remove();
            window.removeEventListener('keydown', onKey, true);
            d.scrim.style.display = '';
            const got = take ? spec.readSelection() : '';
            if (got.trim()) { sides[k].text.value = got; save(); }
            const other = sides[1 - k].text.value.trim();
            if (got.trim() && other) run();
            else {
              edit(got.trim() ? 1 - k : k);
              if (take && !got.trim()) status.set('Nothing was selected. Select text in the document first.');
            }
          };
          const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false); } };
          const barBtn = (label, primary, take) => {
            const b = button(label, primary, () => finish(take));
            b.addEventListener('mousedown', (e) => e.preventDefault()); // keep the selection
            return b;
          };
          const pickBar = el('div', { class: `du-pickbar${look}`, attrs: { role: 'status' } }, [
            el('span', { textContent: `Select the text for Text ${k + 1} in your document` }),
            barBtn('Cancel', false, false),
            barBtn('Use selection', true, true),
          ]);
          document.body.append(pickBar);
          window.addEventListener('keydown', onKey, true);
        };

        d.dialog.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); showing ? edit(0) : run(); return; }
          if (!showing || e.target.tagName === 'INPUT') return;
          if (e.key === 'ArrowDown') { e.preventDefault(); goTo(cur + 1); }
          else if (e.key === 'ArrowUp') { e.preventDefault(); goTo(cur - 1); }
        });

        const [a, b] = spec.texts;
        edit(a ? 1 : 0);
        if (a && b) sides[1].text.select(); // pasting replaces the kept Text 2
      });
    },

    // Card Check results: cards on the left (status as they finish), details on the right.
    // Returns { closed, update(items, subtitle) }.
    checkResults(spec) {
      const d = openDialog({ title: spec.title, subtitle: spec.subtitle, width: '820px' });
      d.dialog.className += ' du-team';
      d.foot.className += ' du-foot-end';
      const list = el('div', { class: 'du-list', data: { field: 'list' }, attrs: { role: 'listbox', 'aria-label': spec.title } });
      const pane = el('div', { class: 'du-pane', data: { field: 'pane' } });
      d.body.remove();
      const split = el('div', { class: 'du-split' }, [list, pane]);
      if (d.dialog.insertBefore) d.dialog.insertBefore(split, d.foot); else d.dialog.append(split);
      const sub = [...(d.head.children || [])].find((n) => n.className === 'du-sub') || null;
      let items = spec.items;
      let selKey = items.length ? items[0].key : null;
      let rows = [];
      let resolveClosed;
      const closed = new Promise((r) => { resolveClosed = r; });
      const close = () => { d.close(); resolveClosed(); };
      d.onDismiss(close);
      const current = () => items.find((it) => it.key === selKey) || null;
      const renderPane = () => {
        pane.textContent = '';
        const it = current();
        if (!it) return;
        pane.append(el('h2', { class: 'du-pane-title', textContent: it.label }), el('p', { class: 'du-pane-meta', textContent: [it.statusText, it.sub].filter(Boolean).join(' · ') }));
        if (it.issues.length) pane.append(el('h3', { textContent: 'What it found' }), el('ul', { class: 'du-issues' }, it.issues.map((t) => el('li', { textContent: t }))));
        if (it.notes.length) pane.append(el('h3', { textContent: 'Check the highlighting' }), el('ul', { class: 'du-issues' }, it.notes.map((t) => el('li', { textContent: t }))));
        if (it.url) pane.append(el('h3', { textContent: it.archived ? 'Source (archived copy)' : 'Source' }), el('p', { class: 'du-pre', textContent: it.url }));
      };
      const renderFoot = () => {
        d.foot.textContent = '';
        const it = current();
        if (it && it.url && spec.onSource) d.foot.append(button('Open source', false, () => spec.onSource(it)));
        const go = button('Go to card', true, () => { const x = current(); if (x) { close(); spec.onGo(x); } });
        go.title = 'Enter';
        go.disabled = !it;
        d.foot.append(go);
      };
      const paint = () => {
        rows.forEach((r, i) => r.setAttribute('aria-selected', items[i].key === selKey ? 'true' : 'false'));
        renderPane();
        renderFoot();
        if (d.dialog.contains && !d.dialog.contains(document.activeElement)) d.dialog.focus();
      };
      const render = () => {
        list.textContent = '';
        rows = items.map((it) => {
          const row = el('div', { class: 'du-row', attrs: { role: 'option' } }, [
            el('span', { class: `du-st du-st-${it.status}`, textContent: it.glyph, attrs: { 'aria-label': it.statusText } }),
            el('span', { class: 'du-row-text' }, [
              el('span', { class: 'du-row-main', textContent: it.label, title: it.label }),
              el('span', { class: 'du-row-sub', textContent: it.statusText }),
            ]),
          ]);
          row.addEventListener('mousedown', (e) => { e.preventDefault(); selKey = it.key; paint(); });
          row.addEventListener('dblclick', () => { selKey = it.key; close(); spec.onGo(it); });
          list.append(row);
          return row;
        });
        paint();
      };
      d.dialog.addEventListener('keydown', (e) => {
        const i = items.findIndex((it) => it.key === selKey);
        if (e.key === 'ArrowDown' && items.length) { e.preventDefault(); selKey = items[Math.min(i + 1, items.length - 1)].key; paint(); }
        else if (e.key === 'ArrowUp' && items.length) { e.preventDefault(); selKey = items[Math.max(i - 1, 0)].key; paint(); }
        else if (e.key === 'Enter' && e.target === d.dialog) { e.preventDefault(); const it = current(); if (it) { close(); spec.onGo(it); } }
      });
      render();
      d.dialog.focus();
      return {
        closed,
        update(next, subtitle) {
          items = next;
          if (!items.some((it) => it.key === selKey)) selKey = items.length ? items[0].key : null;
          if (sub && subtitle) sub.textContent = subtitle;
          render();
        },
      };
    },

    // Email the chain: To + Subject, the attached doc named. Resolves {to, subject} or null.
    emailForm(spec) {
      return new Promise((resolve) => {
        const d = openDialog({ title: spec.title, subtitle: spec.subtitle, width: '560px' });
        const done = (v) => { d.close(); resolve(v); };
        d.onDismiss(() => done(null));
        const field = (label, control) => el('label', { class: 'du-field du-span' }, [el('span', { class: 'du-label', textContent: label }), control]);
        const to = el('textarea', { class: 'du-input', rows: 2, value: spec.to || '', placeholder: 'judge@school.edu, opp1@…, opp2@…', data: { field: 'to' } });
        const subject = el('input', { class: 'du-input', value: spec.subject || '', data: { field: 'subject' } });
        const body = el('textarea', { class: 'du-input', rows: 3, value: spec.body || '', data: { field: 'body' } });
        // Reply all: picking a recent email fills To with everyone on it and keeps its thread.
        const replies = spec.replies || [];
        const replySel = el('select', { class: 'du-input', data: { field: 'reply' } });
        replySel.append(new Option('New email', ''));
        replies.forEach((r, i) => replySel.append(new Option(r.label, String(i))));
        const fresh = { to: to.value, subject: subject.value };
        // "New email" has value '' (Number('') is 0, so it must never index the list).
        const chosen = () => (replySel.value === '' ? null : replies[Number(replySel.value)] || null);
        replySel.addEventListener('change', () => {
          const r = chosen();
          to.value = r ? r.to.join(', ') : fresh.to;
          subject.value = r ? r.subject : fresh.subject;
        });
        const err = el('p', { class: 'du-error', attrs: { role: 'alert' } });
        d.body.append(el('div', { class: 'du-grid' }, [
          replies.length || spec.replyNote ? el('div', { class: 'du-field du-span' }, [
            el('span', { class: 'du-label', textContent: 'Reply all to' }),
            replies.length ? replySel : null,
            spec.replyNote ? el('span', { class: 'du-hint', textContent: spec.replyNote }) : null,
          ]) : null,
          field('To (commas or spaces between addresses)', to),
          field('Subject', subject),
          field('Message', body),
          el('div', { class: 'du-field du-span' }, [el('span', { class: 'du-label', textContent: 'Attached' }), el('span', { class: 'du-hint', textContent: spec.attached })]),
        ]), err);
        const submit = () => {
          const list = to.value.split(/[\s,;]+/).filter(Boolean);
          const bad = list.filter((x) => !/^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[A-Za-z]{2,}$/.test(x));
          if (!list.length) { err.textContent = 'Add at least one address.'; return; }
          if (bad.length) { err.textContent = `Not an email address: ${bad.join(', ')}`; return; }
          const r = chosen();
          done({ to: list, subject: subject.value.trim(), body: body.value, replyTo: r ? r.replyTo : null });
        };
        subject.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
        for (const area of [to, body]) area.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submit(); } });
        d.foot.append(note(`From ${spec.from}`).node, button('Cancel', false, () => done(null)), button('Send', true, submit));
        to.focus();
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
        const report = el('textarea', { class: 'du-input', rows: Math.min(8, Math.max(2, String(spec.fields.report || '').split('\n').length)), value: spec.fields.report || '', placeholder: 'Optional: what was read', data: { field: 'report' } });
        const reportField = el('div', { class: 'du-field du-span' }, [
          el('span', { class: 'du-label', textContent: 'Round report' }), report,
          spec.reportNote ? el('span', { class: 'du-hint', textContent: spec.reportNote, data: { field: 'report-note' } }) : null,
        ]);

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
          if (fill.value === '') return; // "Enter manually" keeps what's typed (Number('') would be round 0)
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
            reportField,
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

  // ---------------------------------------------------------------- Open cache
  // Not a CardMirror API. CardMirror parses a .docx in a worker (docx-open-worker-*.js) that
  // posts back { id, ok, docJson, threads, docId }; on a 30 MB document that parse is ~1 s of
  // every open. The plugin keeps those replies in IndexedDB, keyed on CardMirror's bundle URL
  // (its content hash changes with every parser change) plus a SHA-256 of the file bytes, so
  // reopening an unchanged file skips the parse. Any cache failure falls back to the worker.
  const OPEN_CACHE_DB = 'debate-uploader-open-cache';
  const OPEN_CACHE_MAX = 10; // replies kept, least recently opened dropped first
  const OPEN_CACHE_MIN_BYTES = 512 * 1024; // small files parse faster than a cache read

  function idbStore(dbName) {
    let dbp = null;
    const db = () => (dbp ??= new Promise((res, rej) => {
      const r = indexedDB.open(dbName, 1);
      r.onupgradeneeded = () => { r.result.createObjectStore('replies'); r.result.createObjectStore('index'); };
      r.onsuccess = () => res(r.result);
      r.onerror = () => { dbp = null; rej(r.error); };
    }));
    const run = (stores, mode, fn) => db().then((d) => new Promise((res, rej) => {
      const t = d.transaction(stores, mode);
      let out;
      t.oncomplete = () => res(out);
      t.onerror = t.onabort = () => rej(t.error);
      out = fn(t);
    }));
    const req = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    return {
      async get(key) {
        let reply;
        await run(['replies'], 'readonly', (t) => req(t.objectStore('replies').get(key)).then((v) => { reply = v; }));
        return reply;
      },
      async put(key, reply, max) {
        await run(['replies', 'index'], 'readwrite', (t) => {
          const replies = t.objectStore('replies');
          const index = t.objectStore('index');
          replies.put(reply, key);
          return req(index.get('lru')).then((lru) => {
            const keys = [key, ...(lru || []).filter((k) => k !== key)];
            for (const old of keys.slice(max)) replies.delete(old);
            index.put(keys.slice(0, max), 'lru');
          });
        });
      },
      async touch(key, max) {
        await run(['index'], 'readwrite', (t) => {
          const index = t.objectStore('index');
          return req(index.get('lru')).then((lru) => index.put([key, ...(lru || []).filter((k) => k !== key)].slice(0, max), 'lru'));
        });
      },
      async clear() {
        await run(['replies', 'index'], 'readwrite', (t) => { t.objectStore('replies').clear(); t.objectStore('index').clear(); });
      },
    };
  }

  async function sha256Hex(bytes) {
    const d = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    let s = '';
    for (const b of d) s += b.toString(16).padStart(2, '0');
    return s;
  }

  // CardMirror's open request is exactly { id, bytes } (the quick-card parser also sends a format
  // and kinds). Patching the prototype, not the constructor, also covers a worker CardMirror made
  // before the plugin loaded, since it reuses one open worker for the whole session.
  const isOpenRequest = (m) => !!m && typeof m === 'object' && typeof m.id === 'number' &&
    (m.bytes instanceof Uint8Array || m.bytes instanceof ArrayBuffer) && Object.keys(m).length === 2;

  function patchWorkerPostMessage(proto, { store, version, hash = sha256Hex, enabled = () => true, idle = (fn) => setTimeout(fn, 0), max = OPEN_CACHE_MAX, minBytes = OPEN_CACHE_MIN_BYTES }) {
    const native = proto.postMessage;
    if (native.__duOpenCache) return;
    const pendingKeys = new WeakMap(); // worker -> Map(request id -> cache key)
    const watch = (w) => {
      let keys = pendingKeys.get(w);
      if (keys) return keys;
      keys = new Map();
      pendingKeys.set(w, keys);
      w.addEventListener('message', (e) => {
        const msg = e.data;
        if (!msg || e.__duCached || !keys.has(msg.id)) return;
        const key = keys.get(msg.id);
        keys.delete(msg.id);
        if (msg.ok !== true || !msg.docJson) return;
        // Saving clones the reply on this thread, so it waits until the open has painted.
        idle(() => { store.put(key, { docJson: msg.docJson, threads: msg.threads, docId: msg.docId }, max).catch(() => {}); });
      });
      return keys;
    };
    const patched = function (msg, transfer) {
      if (!isOpenRequest(msg) || msg.bytes.byteLength < minBytes || !enabled()) return native.call(this, msg, transfer);
      const keys = watch(this);
      (async () => {
        let key = null;
        try {
          key = `${version()}|${await hash(msg.bytes)}`;
          const hit = await store.get(key);
          if (hit && hit.docJson) {
            const ev = new MessageEvent('message', { data: { id: msg.id, ok: true, docJson: hit.docJson, threads: hit.threads || [], docId: hit.docId ?? null } });
            ev.__duCached = true;
            this.dispatchEvent(ev);
            store.touch(key, max).catch(() => {});
            return;
          }
        } catch { /* cache unreadable: parse as usual */ }
        if (key) keys.set(msg.id, key);
        native.call(this, msg, transfer);
      })();
    };
    patched.__duOpenCache = true;
    proto.postMessage = patched;
  }

  function openCacheOn() {
    try {
      const s = JSON.parse(localStorage.getItem(`plugin:${ID}`) || '{}').__settings || {};
      return s.openCache !== false;
    } catch { return true; }
  }

  // The parser ships inside CardMirror's hashed bundle, so the bundle's URL changes with it.
  const bundleVersion = () => {
    const s = document.querySelector('script[type="module"][src]');
    return s ? s.src : location.href;
  };

  let openStore = null;
  function installOpenCache() {
    if (typeof Worker !== 'function' || typeof indexedDB === 'undefined' || !globalThis.crypto || !crypto.subtle) return;
    openStore = idbStore(OPEN_CACHE_DB);
    const idle = (fn) => (typeof requestIdleCallback === 'function' ? requestIdleCallback(fn, { timeout: 5000 }) : setTimeout(fn, 1000));
    patchWorkerPostMessage(Worker.prototype, { store: openStore, version: bundleVersion, enabled: openCacheOn, idle });
  }

  // ---------------------------------------------------------------- Copy into Google Docs / Word
  // CardMirror's clipboard HTML styles cite and emphasis with size/underline/box but no
  // bold, so Google Docs and Word paste them unbolded. Add bold on copy (tagged), and take
  // it back out when the same HTML is pasted into CardMirror, so nothing changes there.
  const BOLD_TAG = 'data-du-bold';
  // The tag keeps the original style ("-" = none) so the paste back is byte-for-byte CardMirror's.
  function boldCopiedHTML(html) {
    // Exactly the class pmd-emphasis or pmd-cite (not pmd-cite-author). Function replacers
    // throughout: "$&" in page CSS must stay literal.
    return String(html).replace(/<span\b([^>]*\bclass="(?:[^"]*\s)?pmd-(?:emphasis|cite)(?:\s[^"]*)?"[^>]*)>/g, (all, attrs) => {
      if (attrs.includes(BOLD_TAG)) return all;
      const m = /\sstyle="([^"]*)"/.exec(attrs);
      if (!m) return `<span${attrs} style="font-weight: 700;" ${BOLD_TAG}="-">`;
      const css = m[1];
      return `<span${attrs.replace(m[0], () => ` style="${css}${css && !/;\s*$/.test(css) ? ';' : ''} font-weight: 700;"`)} ${BOLD_TAG}="${css}">`;
    });
  }
  function unboldCopiedHTML(html) {
    return String(html).replace(/<span\b([^>]*?)\sdata-du-bold="([^"]*)"([^>]*)>/g, (all, a, orig, b) => {
      const attrs = `${a}${b}`.replace(/\sstyle="[^"]*"/, () => (orig === '-' ? '' : ` style="${orig}"`));
      return `<span${attrs}>`;
    });
  }
  function installClipboardFix() {
    if (typeof document === 'undefined' || !document.addEventListener) return;
    const onCopy = (e) => {
      // Runs after ProseMirror (it handles copy on the editor; this listens on the document).
      const dt = e.clipboardData;
      if (!dt || !e.target || !e.target.closest || !e.target.closest('.ProseMirror')) return;
      const html = dt.getData('text/html');
      if (!html || !/pmd-(emphasis|cite)/.test(html)) return;
      try { dt.setData('text/html', boldCopiedHTML(html)); } catch { /* leave CardMirror's copy as is */ }
    };
    document.addEventListener('copy', onCopy);
    document.addEventListener('cut', onCopy);
    // Pasting our own copy back: swap in the original HTML and let the paste continue as a
    // normal one, so ProseMirror still does its own checks (read-only docs, Paste and Match
    // Style, node views) and nothing depends on reaching the editor's internals.
    document.addEventListener('paste', (e) => {
      const dt = e.clipboardData;
      const html = dt && dt.getData('text/html');
      if (!html || !html.includes(BOLD_TAG) || typeof DataTransfer !== 'function' || typeof ClipboardEvent !== 'function') return;
      const target = e.target;
      if (!target || !target.closest || !target.closest('.ProseMirror')) return;
      const restored = unboldCopiedHTML(html);
      if (restored === html) return; // nothing of ours to undo (also stops any re-dispatch loop)
      let clean;
      try {
        clean = new DataTransfer();
        for (const type of dt.types) if (type !== 'Files') clean.setData(type, type === 'text/html' ? restored : dt.getData(type));
      } catch { return; } // leave the paste alone
      e.preventDefault();
      e.stopImmediatePropagation();
      target.dispatchEvent(new ClipboardEvent('paste', { clipboardData: clean, bubbles: true, cancelable: true }));
    }, true);
  }

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
    // The plugin's settings gear wins when it has a value (plugins can't change it).
    const gear = String(api.settings.get('sendDocFolder') || '').trim();
    api.showToast(gear && gear !== folder
      ? `Saved, but the plugin settings gear says ${gear}, and that one is used. Change or clear it there.`
      : `Send doc folder set to ${folder}`);
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

  async function zipRoom(api) {
    const u = ui();
    const ctx = { browse: true, zip: true, room: '' };
    try {
      const raw = await u.prompt('SpeechDrop room code to download', api.storage.get('lastRoom') || '');
      if (raw == null) return;
      const room = normalizeRoom(raw);
      ctx.room = room;
      if (!room) return api.showToast(`"${String(raw).trim()}" doesn't look like a SpeechDrop room code.`);
      remember(api, 'lastRoom', room);
      api.showToast(`Downloading room ${room}…`);
      let shown = 0;
      const r = await runJob(api, '/speechdrop/zip', { room }, u.sleep, {
        maxPolls: 1800, // ≈30 min: camp rooms hold 1,000+ files
        onProgress: (p) => { // a toast every 10%, not every poll
          if (p.total >= 20 && p.done < p.total && p.done - shown >= p.total / 10) { shown = p.done; api.showToast(`Downloading room ${room}: ${p.done} of ${p.total} files…`); }
        },
      });
      const skipped = r.skipped ? ` ${r.skipped} file${r.skipped === 1 ? ' is' : 's are'} no longer on SpeechDrop and ${r.skipped === 1 ? 'was' : 'were'} skipped.` : '';
      api.showToast(`Saved ${r.count} file${r.count === 1 ? '' : 's'} to "${r.name}" and showed it in Finder.${skipped}`);
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
    const folder = sendDocFolder(api);
    // Draft the report from the round's docs while Tabroom answers; never blocks the form.
    const room = api.storage.get('lastRoom') || '';
    const drafting = runJob(api, '/caselist/report-draft', { room, folder }, u.sleep).catch(() => null);
    let rounds = [];
    try {
      rounds = (await runJob(api, '/tabroom/rounds', {}, u.sleep)).rounds;
    } catch (err) {
      // Login problems stop here (the upload would fail too); anything else falls back to manual entry.
      if (['not_logged_in', 'login_expired', 'keychain_failed'].includes(err.message)) throw err;
    }
    // The draft is a bonus: open the form after at most 3 s more, with or without it.
    const draft = await Promise.race([drafting, u.sleep(3000).then(() => null)]);
    // Name the actual newest send doc in the form, so a public upload is never a surprise.
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
      fields: { tournament: '', side: '', round: '', opponent: '', judge: '', report: draft && draft.report ? draft.report : '' },
      reportNote: draft && draft.report
        ? `Drafted from ${draft.used.length === 1 ? `"${draft.used[0]}"` : `${draft.used.length} docs (${draft.used.join(', ')})`}${draft.skipped ? `; ${plural(draft.skipped, 'non-.docx file')} skipped` : ''}. Edit before uploading.`
        : '',
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

  // Open caselists first, then every past year back to 2014, newest first.
  async function pickCaselist(api, u) {
    const all = await runJob(api, '/caselist/caselists', { all: true }, u.sleep);
    if (!all.length) { api.showToast('No caselists are open right now.'); return null; }
    const prefer = [ownCaselist(api)?.name, api.storage.get('scoutCaselist')?.name].filter(Boolean);
    const rank = (c) => { const i = prefer.indexOf(c.name); return i === -1 ? prefer.length : i; };
    const ordered = all.map((c, i) => [c, i]).sort((a, b) => rank(a[0]) - rank(b[0]) || a[1] - b[1]).map(([c]) => c);
    const i = await u.choose('Pick a caselist', ordered.map((c) => c.label));
    if (i == null) return null;
    const cl = { name: ordered[i].name, label: ordered[i].label, event: ordered[i].event || '' };
    if (!ordered[i].archived) remember(api, 'scoutCaselist', cl); // a past year must never become Scout's default
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
      pageUrl: `https://opencaselist.com/${[cl.name, team.school, team.team].map(encodeURIComponent).join('/')}`,
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


  // Full-text search of open source docs and cites across caselists. One search covers the
  // whole scope (its 100 most relevant hits, in about a second); when there's more, the helper
  // digs deeper within openCaselist's 4 searches a minute and hits stream in.
  // "NDT/CEDA College 2024-25" and "NDT/CEDA 2019-20" are one event: openCaselist renamed it in 2022.
  const yearless = (label) => String(label).replace(/\s*\d{4}(-\d{2})?\s*$/, '').replace(/\s+College\b/, '').trim();

  // The same card read in many rounds comes back once per doc: one row each, newest first.
  function cardRows(hits, byName) {
    const rows = new Map();
    for (const h of hits) {
      const text = h.snippet.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 160);
      const key = `${h.type}:${text || `${h.caselist}/${h.school}/${h.team}/${h.path || h.title}`}`;
      const r = rows.get(key);
      if (r) { r.more++; continue; }
      rows.set(key, { hit: h, more: 0 });
    }
    return [...rows.values()].map(({ hit: h, more }, i) => ({
      key: String(i),
      hit: h,
      label: h.snippet || h.title || '(no text)',
      detail: [h.type === 'cite' ? `cites: ${h.title}` : '', h.teamLabel, byName.get(h.caselist)?.label || h.caselistLabel, more ? `+${more} more` : ''].filter(Boolean).join(' · '),
    }));
  }

  async function caselistCardSearch(api) {
    const u = ui();
    const ctx = { caselist: true, scouting: true };
    try {
      const q = String((await u.prompt('Search the caselist for cards', api.storage.get('cardSearchQuery') || '')) ?? '').trim();
      if (!q) return;
      api.storage.set('cardSearchQuery', q); // session only: not worth a mirrored pref
      const all = await runJob(api, '/caselist/caselists', { all: true }, u.sleep);
      if (!all.length) return api.showToast('No caselists found.');
      const byName = new Map(all.map((c) => [c.name, c]));
      // Scopes: your event across every year, then each of its years, this year's caselists,
      // the other events across every year, every caselist, then every single caselist.
      const newest = (list) => list.slice().sort((x, y) => x.archived - y.archived || (y.year || 0) - (x.year || 0));
      const mine = ownCaselist(api) || api.storage.get('scoutCaselist');
      const myEvent = mine ? yearless(mine.label) : '';
      const groups = [...new Set(all.map((c) => yearless(c.label)))];
      const eventScope = (g) => ({ label: `${g}, every year`, title: `every ${g} year`, list: newest(all.filter((c) => yearless(c.label) === g)) });
      const one = (c) => ({ label: c.label, title: c.label, list: [c] });
      const others = groups.filter((g) => g !== myEvent);
      const scopes = [
        ...(myEvent ? [eventScope(myEvent), ...eventScope(myEvent).list.map(one)] : []),
        { label: 'This year, every event', title: "this year's caselists", list: all.filter((c) => !c.archived) },
        ...others.map(eventScope),
        { label: 'Every caselist', title: 'every caselist', list: newest(all) },
        ...newest(all).filter((c) => yearless(c.label) !== myEvent).map(one),
      ].filter((x) => x.list.length);
      const si = await u.choose(`Search for "${q}" in…`, scopes.map((x) => (x.list.length > 1 ? `${x.label} (${x.list.length} caselists)` : x.label)));
      if (si == null) return;
      const scope = scopes[si];
      let hits = [];
      let searched = 0;
      let rest = [];
      const capped = new Set(); // over 100 matches in one caselist, across every pass
      let tooMany = false;
      const merge = (a, b) => { const seen = new Set(a.map((h) => h.id)); return a.concat(b.filter((h) => !h.id || !seen.has(h.id))); };
      let closed = false;
      let view = null;
      const MORE = 'more';
      const render = (status) => {
        if (closed) return;
        const items = cardRows(hits, byName);
        if (rest.length) items.push({ key: MORE, label: `Retry ${plural(rest.length, 'caselist')} that didn't finish…`, detail: '' });
        view.update(items, status);
      };
      let running = false;
      const pass = async (batch) => {
        running = true;
        rest = [];
        // Caselists this pass didn't finish (failed, stopped, error) go on a "Retry" row
        // (a helper older than 0.3.1 sends no `searched`: trust its count).
        const unfinished = (p) => { const ok = new Set(p.searched || batch.slice(0, p.done).map((c) => c.name)); rest = batch.filter((c) => !ok.has(c.name)); };
        const before = hits;
        const fin = (p) => (p.searched ? p.searched.length : p.done - p.failed.length); // failed ones aren't searched
        const status = (p, finished) => {
          const complete = searched + fin(p);
          for (const c of p.capped || []) capped.add(c);
          if (p.tooMany) tooMany = true;
          const all = complete === scope.list.length && !capped.size && !tooMany;
          return [
            plural(cardRows(hits, byName).length, 'card'),
            finished ? (all ? 'every match' : `${complete} of ${plural(scope.list.length, 'caselist')} complete`) : `finding more (${complete} of ${scope.list.length} caselists complete)…`,
            tooMany ? 'showing the first 1,000: add words to narrow it' : capped.size ? `${plural(capped.size, 'caselist')} had over 100 matches: add words to narrow it` : '',
            p.failed.length ? `${p.failed.length} failed` : '',
            'Enter opens the doc',
          ].filter(Boolean).join(' · ');
        };
        let last = { done: 0, failed: [], searched: [] };
        try {
          const done = await runJob(api, '/caselist/card-search', { q, caselists: batch.map((c) => c.name) }, u.sleep, {
            onProgress: (p) => { last = p; hits = merge(before, p.hits); render(status(p, false)); },
            maxPolls: batch.length * 90 + 120, // ~16 s per caselist; up to two 61 s 429 back-offs each
          });
          hits = merge(before, done.hits);
          const text = done.stopped ? `${status(done, true)} · stopped` : status(done, true);
          searched += fin(done);
          unfinished(done);
          if (tooMany) rest = []; // a retry would hit the same limit
          render(text);
        } catch (err) {
          call(api, '/caselist/card-search/stop', {}).catch(() => {}); // never leave it spending the rate limit
          searched += fin(last);
          unfinished(last);
          if (closed) return api.showToast(message(err.message, ctx));
          render(`Search stopped: ${message(err.message, ctx)}`);
        } finally {
          running = false;
        }
      };
      const onPick = async (it) => {
        if (it.key === MORE) return running ? api.showToast('Still searching. Try again when this pass finishes.') : pass(rest);
        const h = it.hit;
        const cl = byName.get(h.caselist) || { name: h.caselist, label: h.caselistLabel, event: '' };
        const team = { school: h.school, team: h.team, label: h.teamLabel };
        try {
          if (h.type === 'cite') return await openTeamPage(api, u, { name: cl.name, label: cl.label, event: cl.event || '' }, team, ctx);
          const name = h.path.split('/').pop();
          api.showToast(`Opening "${name}"…`);
          const res = await runJob(api, '/caselist/open', { caselist: cl.name, school: h.school, team: h.team, path: h.path }, u.sleep);
          api.showToast(openedToast(res));
        } catch (err) {
          api.showToast(message(err.message, { ...ctx, name: h.title }));
        }
      };
      view = u.showList(`"${q}" on ${scope.title}`, [], onPick, { wrap: true, hint: 'Searching…' });
      view.closed.then(() => { closed = true; call(api, '/caselist/card-search/stop', {}).catch(() => {}); });
      await pass(scope.list);
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
    try {
      await markCardsFlow(api);
    } catch {
      api.showToast("Couldn't mark the cards. Click into your document and try again.");
    }
  }

  async function markCardsFlow(api) {
    const u = ui();
    const view = u.editorView ? await u.editorView() : await editor.view(u.sleep);
    if (!view || !view.state.schema.marks.font_color) return api.showToast("Couldn't reach the editor. Click into your document, then run Mark cards again.");
    const cards = cardsIn(view.state.doc);
    if (!cards.length) return api.showToast('No cards in this document.');
    const info = typeof api.docInfo === 'function' ? api.docInfo() : null;
    const wanted = await u.pickCards({
      title: 'Mark cards',
      subtitle: `${info && info.docTitle ? `${info.docTitle} · ` : ''}checked cards turn red`,
      // Checked = has red. A partly red card starts checked; unchecking it clears the red.
      cards: cards.map((c) => ({ label: c.tag, sub: c.cite, group: c.group, checked: c.marked || c.partial, partial: c.partial })),
    });
    if (!wanted) return;
    // Positions may have moved if the doc changed meanwhile; the cards must still line up.
    const now = cardsIn(view.state.doc);
    if (now.length !== cards.length || now.some((c, i) => c.tag !== cards[i].tag)) {
      return api.showToast('The cards changed while the list was open. Run Mark cards again.');
    }
    const r = applyMarks(view, now.map((c, i) => ({ ...c, marked: cards[i].marked || cards[i].partial })), wanted);
    const parts = [r.marked && `marked ${plural(r.marked, 'card')}`, r.unmarked && `unmarked ${plural(r.unmarked, 'card')}`].filter(Boolean);
    if (parts.length) {
      const text = parts.join(', ');
      api.showToast(`${text[0].toUpperCase()}${text.slice(1)} (⌘Z to undo)`);
    }
  }

  // ---------------------------------------------------------------- Bold emphasis
  async function boldEmphasisCommand(api) {
    try {
      const folder = sendDocFolder(api);
      if (!folder) throw new Error('no_folder');
      const r = await call(api, '/docx/bold-emphasis', { folder });
      api.showToast(r.changed ? `Emphasis in "${r.name}" now shows bold in Word and Google Docs.` : `"${r.name}" already shows emphasis as bold.`);
    } catch (err) {
      api.showToast(message(err.message, {}));
    }
  }

  // ---------------------------------------------------------------- Email chain (Gmail)
  async function gmailSetup(api) {
    const u = ui();
    const st = await call(api, '/gmail/status', {});
    const email = await u.prompt('Gmail address for email chains', st.email || '');
    if (email == null || !email.trim()) return null;
    const pass = await u.prompt('Gmail app password (myaccount.google.com/apppasswords; needs 2-Step Verification)', '', { secret: true });
    if (pass == null || !pass.trim()) return null;
    api.showToast('Checking with Gmail…');
    const r = await runJob(api, '/gmail/setup', { email: email.trim(), appPassword: pass }, u.sleep);
    api.showToast(`Gmail ready: chains send from ${r.email}.`);
    return r.email;
  }

  async function gmailSetupCommand(api) {
    try { await gmailSetup(api); } catch (err) { api.showToast(message(err.message, { email: true })); }
  }

  async function gmailForget(api) {
    try {
      await call(api, '/gmail/forget', {});
      api.showToast('Removed the Gmail app password from Keychain.');
    } catch (err) {
      api.showToast(message(err.message, { email: true }));
    }
  }

  // "Glenbrooks · Round 3 · University AS vs Cranbrook FZ", from the current Tabroom pairing.
  async function chainSubject(api, u) {
    try {
      const { current, rounds } = await runJob(api, '/tabroom/rounds', {}, u.sleep);
      const r = current ? rounds.find((x) => x.opponent) || null : null; // between tournaments: no stale round
      if (!r) return '';
      const us = (api.storage.get('caselistTarget') || {}).teamLabel;
      return [r.tournament, roundName(r.round), us ? `${us} vs ${r.opponent}` : `vs ${r.opponent}`].filter(Boolean).join(' · ');
    } catch {
      return '';
    }
  }

  async function emailChain(api) {
    if (busy) return api.showToast('An upload is already in progress.');
    const u = ui();
    const ctx = { email: true };
    let sending = false;
    try {
      let from = (await call(api, '/gmail/status', {})).email;
      if (!from) {
        from = await gmailSetup(api);
        if (!from) return;
      }
      const folder = sendDocFolder(api);
      if (!folder) throw new Error('no_folder');
      const recent = runJob(api, '/gmail/recent', {}, u.sleep).catch(() => null);
      const [newest, subject, inbox] = await Promise.all([call(api, '/caselist/newest', { folder }), chainSubject(api, u), recent]);
      const last = api.storage.get('emailChain') || {};
      const me = String(from).toLowerCase();
      const replies = (inbox ? inbox.messages : []).map((m) => ({
        label: [m.subject || '(no subject)', m.from.toLowerCase() === me ? 'you' : m.fromName || m.from, m.date ? formatTime(m.date) : ''].filter(Boolean).join(' · '),
        to: [...new Set([m.from, ...m.to, ...m.cc].map((a) => a.toLowerCase()))].filter((a) => a && a !== me),
        subject: m.subject,
        replyTo: { messageId: m.messageId, references: m.references },
      })).filter((r) => r.to.length);
      const values = await u.emailForm({
        title: 'Email the chain',
        subtitle: 'Sends now from your Gmail',
        from,
        to: (last.to || []).join(', '),
        subject: subject || last.subject || '',
        body: api.storage.get('emailBody') || 'Speech doc attached.',
        replies,
        replyNote: inbox ? '' : "Couldn't read your recent emails, so reply-all isn't available; New email still works.",
        attached: `${newest.name} (newest send doc, ${formatTime(newest.mtime)})`,
      });
      if (!values) return;
      remember(api, 'emailChain', { to: values.to, subject: values.subject });
      remember(api, 'emailBody', values.body);
      if (busy) return api.showToast('An upload is already in progress. Send again when it finishes.');
      busy = true;
      sending = true;
      api.showToast(`Sending "${newest.name}"…`);
      const r = await runJob(api, '/gmail/send', { to: values.to, subject: values.subject, text: values.body, replyTo: values.replyTo, folder, expectName: newest.name }, u.sleep);
      api.showToast(`Sent "${r.name}" to ${r.recipients} ${r.recipients === 1 ? 'person' : 'people'}${r.reply ? ' (same thread)' : ''}.`);
    } catch (err) {
      api.showToast(message(err.message, ctx));
    } finally {
      if (sending) busy = false; // only release the lock this command took
    }
  }

  // ---------------------------------------------------------------- Card Check
  const CHECK = {
    pending: ['…', 'Checking…'],
    matches: ['✓', 'Matches source'],
    differences: ['!', 'Differences found'],
    unverified: ['?', "Couldn't verify (paywall, other version, or wrong link)"],
    unreachable: ['×', "Couldn't reach the source"],
    no_link: ['–', 'No link in cite'],
    skipped: ['–', 'Not checked (only the first 400 cards are checked)'],
  };
  const CHECK_LIMIT = 400; // the helper's cap per run
  let lastCheck = null; // { title, items } for "Show last Card Check results"

  // Each card's cite links and its body as runs, h = highlighted (read aloud).
  function cardsForCheck(doc) {
    return cardsIn(doc).map((c, i) => {
      const node = doc.nodeAt(c.from);
      const urls = [];
      const runs = [];
      let cite = '';
      // CardMirror marks cites (cite_paragraph); some imports leave them as plain paragraphs,
      // so without one the first unhighlighted body paragraph is the cite (Verbatim layout).
      let hasCite = false;
      node.forEach((child) => { if (child.type.name === 'cite_paragraph') hasCite = true; });
      let fallback = null;
      if (!hasCite) {
        node.forEach((child) => {
          if (fallback || child.type.name !== 'card_body' || !child.textContent.trim()) return;
          let lit = false;
          child.descendants((t) => { if (t.isText && t.marks.some((m) => m.type.name === 'highlight' || m.type.name === 'shading')) lit = true; return true; });
          fallback = lit ? 'none' : child;
        });
      }
      node.forEach((child) => {
        if (child.type.name === 'cite_paragraph' || child === fallback) {
          cite += `${child.textContent} `;
          child.descendants((t) => {
            if (t.isText) for (const m of t.marks) if (m.type.name === 'link' && m.attrs && m.attrs.href) urls.push(m.attrs.href);
            return true;
          });
        } else if (child.type.name === 'card_body') {
          child.descendants((t) => {
            if (t.isText) runs.push({ t: t.text, h: t.marks.some((m) => m.type.name === 'highlight' || m.type.name === 'shading') });
            return true;
          });
          runs.push({ t: '\n', h: false });
        }
      });
      return { key: i, from: c.from, tag: c.tag, cite: cite.trim(), urls: [...new Set(urls)], runs };
    });
  }

  const checkItem = (card, r) => {
    const status = r ? r.status : 'pending';
    const notes = r && r.qualifiers ? r.qualifiers.map((q) => `"${q.context}": the highlighting skips "${q.word}".`) : [];
    const text = CHECK[status][1] + (r && r.reason && status === 'unreachable' ? ` (${r.reason})` : '') + (notes.length ? ' · check highlighting' : '');
    return { key: card.key, label: card.tag, sub: card.cite, status, glyph: CHECK[status][0], statusText: text, issues: r ? r.issues : [], notes, url: r ? r.url : null, archived: !!(r && r.archived) };
  };
  const checkSummary = (results, total, all = total) => {
    const n = (s) => results.filter((r) => r && r.status === s).length;
    const done = results.filter(Boolean).length;
    const parts = [[n('matches'), 'match'], [n('differences'), 'with differences'], [n('unverified') + n('unreachable'), "couldn't check"], [n('no_link'), 'no link']].filter(([k]) => k).map(([k, w]) => `${k} ${w}`);
    const over = all > total ? ` · ${all - total} not checked (over ${total})` : '';
    return `${done < total ? `Checked ${done} of ${total} · ` : ''}${parts.join(' · ') || 'Starting…'}${over}`;
  };

  function goToCard(api, view, tag, key) {
    // Positions may have moved since the check started; find the card by its order and tag.
    const now = cardsIn(view.state.doc);
    const c = now[key] && now[key].tag === tag ? now[key] : now.find((x) => x.tag === tag);
    if (!c) return api.showToast(`Couldn't find "${short(tag)}" any more.`);
    try {
      const Sel = view.state.selection.constructor;
      if (Sel && Sel.near) view.dispatch(view.state.tr.setSelection(Sel.near(view.state.doc.resolve(Math.min(c.from + 2, view.state.doc.content.size)))).scrollIntoView());
      const dom = view.nodeDOM && view.nodeDOM(c.from);
      if (dom && dom.scrollIntoView) dom.scrollIntoView({ block: 'center' });
      if (view.focus) view.focus();
    } catch {
      api.showToast(`Couldn't jump to "${short(tag)}".`);
    }
  }

  async function showResults(api, view, title, items, run) {
    const open = openExternal();
    const ctl = ui().checkResults({
      title,
      subtitle: run ? 'Starting…' : lastCheck.subtitle,
      items,
      onGo: (it) => goToCard(api, view, it.label, it.key),
      onSource: open ? (it) => open(it.url) : null,
    });
    if (run) await run(ctl);
    await ctl.closed;
  }

  async function cardCheck(api) {
    const u = ui();
    const view = u.editorView ? await u.editorView() : await editor.view(u.sleep);
    if (!view) return api.showToast("Couldn't reach the editor. Click into your document, then run Card Check again.");
    const cards = cardsForCheck(view.state.doc);
    if (!cards.length) return api.showToast('No cards in this document.');
    const info = typeof api.docInfo === 'function' ? api.docInfo() : null;
    const title = `Card Check${info && info.docTitle ? `: ${info.docTitle}` : ''}`;
    let results = [];
    const checked = cards.slice(0, CHECK_LIMIT);
    const SKIPPED = { status: 'skipped', issues: [], qualifiers: [] };
    const items = () => cards.map((c, i) => checkItem(c, i < CHECK_LIMIT ? results[i] : SKIPPED));
    await showResults(api, view, title, items(), async (ctl) => {
      try {
        const body = { cards: checked.map(({ key, cite, urls, runs }) => ({ key, cite, urls, runs })) };
        const final = await runJob(api, '/cardcheck/run', body, u.sleep, {
          maxPolls: 900,
          onProgress: (p) => { results = p.results || []; ctl.update(items(), checkSummary(results, checked.length, cards.length)); },
        });
        results = final.results;
        lastCheck = { title, subtitle: checkSummary(results, checked.length, cards.length), items: items(), view };
        ctl.update(lastCheck.items, lastCheck.subtitle);
      } catch (err) {
        ctl.update(items(), message(err.message, { cardcheck: true }));
      }
    });
  }

  async function lastCardCheck(api) {
    if (!lastCheck) return api.showToast('No Card Check results yet. Run "Card Check this document…" first.');
    await showResults(api, lastCheck.view, lastCheck.title, lastCheck.items, null);
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
  // `before` is docInfo() from before the open: a same-named doc that was already active
  // isn't the new one, so wait (a while) for the active doc to change first.
  async function jumpToCard(api, name, quote, approxPos, before) {
    if (typeof api.jumpToSource !== 'function' || typeof api.docInfo !== 'function' || !quote) return false;
    const titles = [name, name.replace(/\.docx$/i, '')];
    const wasActive = before && before.docId && titles.includes(before.docTitle);
    for (let i = 0; i < 20; i++) {
      const info = api.docInfo();
      const changed = !before || !info || info.docId !== before.docId;
      if (info && info.docId && titles.includes(info.docTitle) && (changed || (wasActive && i >= 10))) {
        const source = `cmsrc1.${b64url(JSON.stringify({ docId: info.docId, docTitle: info.docTitle, headingId: null, anchor: { quote, prefix: '', suffix: '', approxPos } }))}`;
        try { return !!(await api.jumpToSource(source)).ok; } catch { return false; }
      }
      await ui().sleep(150);
    }
    return false;
  }

  async function openEvidence(api, card) {
    try {
      const before = typeof api.docInfo === 'function' ? api.docInfo() : null;
      const r = await call(api, '/evidence/open', { path: card.path, ordinal: card.ordinal });
      if (r.opened === false) return api.showToast(`Couldn't open "${r.name}".`);
      const jumped = await jumpToCard(api, r.name, r.quote, r.approxPos, before);
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
                key: `${c.path}#${c.ordinal}`,
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

  // ---------------------------------------------------------------- Text compare
  // Words are diffed first (Myers in linear space, after diff-match-patch's bisect);
  // in Characters mode each changed stretch is then diffed letter by letter, so
  // anything left unhighlighted is identical, byte for byte, unless an Ignore option is on.
  const WORD_RE = /\s+|[\p{L}\p{M}\p{N}]+(?:['’][\p{L}\p{M}\p{N}]+)*|[^]/gu;
  const COMPARE_MS = 2500; // past this, what's left is shown as one big change

  const TIMED_OUT = 'timed out';
  // The point where the forward and reverse D-paths meet; null when they share nothing.
  function bisect(a, b, deadline) {
    const n = a.length, m = b.length, maxD = Math.ceil((n + m) / 2), off = maxD, len = 2 * maxD;
    const v1 = new Int32Array(len).fill(-1), v2 = new Int32Array(len).fill(-1);
    v1[off + 1] = 0;
    v2[off + 1] = 0;
    const delta = n - m, front = delta % 2 !== 0;
    let k1s = 0, k1e = 0, k2s = 0, k2e = 0;
    for (let d = 0; d < maxD; d++) {
      if (Date.now() > deadline) return TIMED_OUT;
      for (let k1 = -d + k1s; k1 <= d - k1e; k1 += 2) {
        const k1o = off + k1;
        let x1 = k1 === -d || (k1 !== d && v1[k1o - 1] < v1[k1o + 1]) ? v1[k1o + 1] : v1[k1o - 1] + 1;
        let y1 = x1 - k1;
        while (x1 < n && y1 < m && a[x1] === b[y1]) { x1++; y1++; }
        v1[k1o] = x1;
        if (x1 > n) k1e += 2;
        else if (y1 > m) k1s += 2;
        else if (front) {
          const k2o = off + delta - k1;
          if (k2o >= 0 && k2o < len && v2[k2o] !== -1 && x1 >= n - v2[k2o]) return [x1, y1];
        }
      }
      for (let k2 = -d + k2s; k2 <= d - k2e; k2 += 2) {
        const k2o = off + k2;
        let x2 = k2 === -d || (k2 !== d && v2[k2o - 1] < v2[k2o + 1]) ? v2[k2o + 1] : v2[k2o - 1] + 1;
        let y2 = x2 - k2;
        while (x2 < n && y2 < m && a[n - x2 - 1] === b[m - y2 - 1]) { x2++; y2++; }
        v2[k2o] = x2;
        if (x2 > n) k2e += 2;
        else if (y2 > m) k2s += 2;
        else if (!front) {
          const k1o = off + delta - k2;
          if (k1o >= 0 && k1o < len && v1[k1o] !== -1) {
            const x1 = v1[k1o];
            if (x1 >= n - x2) return [x1, off + x1 - k1o];
          }
        }
      }
    }
    return null;
  }

  // Edit script over two Int32Arrays: [['=', n] | ['-', n] | ['+', n], …].
  function diffSeq(a, b, deadline) {
    const ops = [];
    let timedOut = false;
    const emit = (t, n) => {
      if (!n) return;
      const last = ops[ops.length - 1];
      if (last && last[0] === t) last[1] += n; else ops.push([t, n]);
    };
    const rec = (a, b) => {
      let p = 0;
      while (p < a.length && p < b.length && a[p] === b[p]) p++;
      let s = 0;
      while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
      emit('=', p);
      const ma = a.subarray(p, a.length - s), mb = b.subarray(p, b.length - s);
      const at = ma.length && mb.length ? bisect(ma, mb, deadline) : null;
      if (at === TIMED_OUT) timedOut = true;
      if (at && at !== TIMED_OUT) {
        rec(ma.subarray(0, at[0]), mb.subarray(0, at[1]));
        rec(ma.subarray(at[0]), mb.subarray(at[1]));
      } else {
        emit('-', ma.length);
        emit('+', mb.length);
      }
      emit('=', s);
    };
    rec(a, b);
    return { ops, timedOut };
  }

  // Units to compare. With Ignore spacing, whitespace rides along with the unit
  // before it and never counts.
  function units(text, words, ignoreSpace) {
    const raw = words ? text.match(WORD_RE) || [] : Array.from(text);
    if (!ignoreSpace) return raw;
    const out = [];
    let lead = '';
    for (const u of raw) {
      if (!/^\s+$/.test(u)) { out.push(lead + u); lead = ''; } else if (out.length) out[out.length - 1] += u; else lead += u;
    }
    if (lead) out.push(lead);
    return out;
  }

  function encode(listA, listB, opts) {
    const ids = new Map();
    const key = (u) => {
      let k = opts.ignoreSpace ? u.replace(/\s+/g, '') : u;
      if (opts.ignoreCase) k = k.toLowerCase();
      if (!ids.has(k)) ids.set(k, ids.size);
      return ids.get(k);
    };
    return [Int32Array.from(listA, key), Int32Array.from(listB, key)];
  }

  const textLen = (list, i, j) => { let n = 0; for (let k = i; k < j; k++) n += list[k].length; return n; };

  // Pieces per side: { text, kind, g } with kind 0 = same, 1 = in a change but
  // the same letters (Characters mode), 2 = changed, 3 = where the other side has text.
  function compareTexts(left, right, opts = {}) {
    const deadline = Date.now() + COMPARE_MS;
    const words = opts.mode !== 'chars';
    const ta = units(left, true, opts.ignoreSpace), tb = units(right, true, opts.ignoreSpace);
    const [a, b] = encode(ta, tb, opts);
    const { ops, timedOut: slow } = diffSeq(a, b, deadline);
    let timedOut = slow;

    // Equal runs and changes, by unit index.
    const isWord = (u) => /[\p{L}\p{N}]/u.test(u);
    let segs = [];
    let i = 0, j = 0, removedWords = 0, addedWords = 0;
    for (const [t, n] of ops) {
      if (t === '-') removedWords += ta.slice(i, i + n).filter(isWord).length;
      if (t === '+') addedWords += tb.slice(j, j + n).filter(isWord).length;
      if (t === '=') { segs.push({ eq: true, a0: i, a1: i + n, b0: j, b1: j + n }); i += n; j += n; continue; }
      let last = segs[segs.length - 1];
      if (!last || last.eq) segs.push((last = { eq: false, a0: i, a1: i, b0: j, b1: j }));
      if (t === '-') last.a1 = i += n; else last.b1 = j += n;
    }
    // A short equal run between two bigger changes ("the", a space) joins them,
    // so a rewritten phrase reads as one change instead of confetti.
    for (let again = true; again;) {
      again = false;
      for (let k = 1; k < segs.length - 1; k++) {
        const [p, e, q] = [segs[k - 1], segs[k], segs[k + 1]];
        if (!e.eq || p.eq || q.eq) continue;
        const n = textLen(ta, e.a0, e.a1);
        if (n <= Math.max(textLen(ta, p.a0, p.a1), textLen(tb, p.b0, p.b1)) && n <= Math.max(textLen(ta, q.a0, q.a1), textLen(tb, q.b0, q.b1))) {
          segs.splice(k - 1, 3, { eq: false, a0: p.a0, a1: q.a1, b0: p.b0, b1: q.b1 });
          again = true;
        }
      }
    }

    const sides = [[], []];
    const push = (side, text, kind, g) => {
      if (!text && kind !== 3) return;
      const last = side[side.length - 1];
      if (last && last.kind === kind && last.g === g && kind !== 3) last.text += text; else side.push({ text, kind, g });
    };
    let g = 0, removed = words ? removedWords : 0, added = words ? addedWords : 0;
    for (const s of segs) {
      const at = ta.slice(s.a0, s.a1).join(''), bt = tb.slice(s.b0, s.b1).join('');
      if (s.eq) { push(sides[0], at, 0, -1); push(sides[1], bt, 0, -1); continue; }
      if (!at || !bt) {
        push(sides[0], at, at ? 2 : 3, g);
        push(sides[1], bt, bt ? 2 : 3, g);
      }
      // Characters mode marks the exact letters only when the two sides mostly
      // share them ("colour"/"color"); a swapped word ("nearly"/"almost") stays whole.
      let sub = null, ca = null, cb = null;
      if (!words && at && bt) {
        ca = units(at, false, opts.ignoreSpace);
        cb = units(bt, false, opts.ignoreSpace);
        const [x, y] = encode(ca, cb, opts);
        sub = diffSeq(x, y, deadline);
        timedOut = timedOut || sub.timedOut;
        const same = sub.ops.reduce((n, [t, c]) => (t === '=' ? n + c : n), 0);
        if (same * 2 < Math.min(ca.length, cb.length)) sub = null;
      }
      if (at && bt && !sub) {
        push(sides[0], at, 2, g);
        push(sides[1], bt, 2, g);
      }
      if (words) {
        // counted above, from the edit script (a merged "the" is in both texts)
      } else if (!sub) {
        removed += units(at, false, opts.ignoreSpace).length;
        added += units(bt, false, opts.ignoreSpace).length;
      } else {
        let ci = 0, cj = 0;
        for (const [t, n] of sub.ops) {
          if (t !== '+') { const part = ca.slice(ci, ci + n).join(''); ci += n; push(sides[0], part, t === '=' ? 1 : 2, g); if (t === '-') removed += n; }
          if (t !== '-') { const part = cb.slice(cj, cj + n).join(''); cj += n; push(sides[1], part, t === '=' ? 1 : 2, g); if (t === '+') added += n; }
        }
      }
      g++;
    }
    return { diffs: g, removed, added, unit: words ? 'word' : 'character', left: sides[0], right: sides[1], timedOut };
  }

  // Text in the document selection, paragraph breaks as newlines.
  function selectedText() {
    const sel = window.getSelection && window.getSelection();
    return sel ? String(sel.toString()) : '';
  }

  // Kept for the session, so one source can be compared against several cards.
  let compareTextsKept = ['', ''];

  async function textCompare(api) {
    const u = ui();
    const read = u.selectedText || selectedText;
    const sel = read();
    if (sel.trim()) compareTextsKept[0] = sel;
    await u.compareText({
      texts: compareTextsKept.slice(),
      opts: { mode: 'words', ignoreCase: false, ignoreSpace: false, ...(api.storage.get('compareOpts') || {}) },
      compare: compareTexts,
      readSelection: read,
      onChange: ({ texts, opts }) => { compareTextsKept = texts.slice(); api.storage.set('compareOpts', opts); },
    });
  }

  try { editor.install(); } catch { /* marking just reports it can't reach the editor */ }
  if (!window.__debateUploaderTest && typeof document !== 'undefined') {
    storedTheme();
    setInterval(storedTheme, 1000);
  }
  try { installClipboardFix(); } catch { /* copies stay as CardMirror makes them */ }
  if (!window.__debateUploaderTest) { try { installOpenCache(); } catch { /* opens parse as usual */ } }
  if (window.__debateUploaderTest) window.__debateUploaderOpenCache = { patchWorkerPostMessage };
  if (window.__debateUploaderTest) window.__debateUploaderClipboard = { boldCopiedHTML, unboldCopiedHTML }; // only when tests ask
  if (window.__debateUploaderTest) window.__debateUploaderCompare = compareTexts;

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
      {
        key: 'theme',
        label: 'Interface theme',
        type: 'select',
        options: THEMES,
        default: 'Standard',
        description: "Standard matches CardMirror. Sleek: compact and monochrome. Liquid: Lynx Theme Pro's frosted glass, always dark.",
      },
      {
        key: 'themeWholeApp',
        label: 'Apply the theme to all of CardMirror',
        type: 'boolean',
        default: false,
        description: 'Also restyles the ribbon, sidebar, status bar and menus. Your document page keeps its normal look. Unofficial: a CardMirror update may undo parts until the plugin is updated.',
      },
      {
        key: 'openCache',
        label: 'Reopen big files faster',
        type: 'boolean',
        default: true,
        description: 'Keeps the last 10 big .docx files CardMirror parsed, so reopening an unchanged file skips the parse (about 1 second on a 30 MB file). A changed file is parsed fresh.',
      },
    ],
    commands: [
      {
        id: `${ID}.clearOpenCache`,
        label: 'Clear the reopen-faster cache',
        keywords: ['cache', 'open', 'speed', 'fast', 'performance'],
        defaultKey: null,
        run: async (api) => {
          if (!openStore) { api.showToast('The reopen cache is not running here.'); return; }
          try { await openStore.clear(); api.showToast('Cleared. Big files parse fresh on their next open.'); } catch { api.showToast("Couldn't clear the cache. Try again."); }
        },
      },
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
        id: `${ID}.sdZip`,
        label: 'Download SpeechDrop room as zip…',
        keywords: ['speechdrop', 'download', 'zip', 'all', 'room'],
        defaultKey: null,
        run: (api) => withPrefs(api, () => zipRoom(api)),
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
        id: `${ID}.boldEmphasis`,
        label: 'Make emphasis bold in newest send doc',
        keywords: ['emphasis', 'bold', 'word', 'google docs', 'export', 'format'],
        defaultKey: null,
        run: (api) => withPrefs(api, () => boldEmphasisCommand(api)),
      },
      {
        id: `${ID}.emailChain`,
        label: 'Email newest send doc to the chain…',
        keywords: ['email', 'chain', 'gmail', 'send', 'doc', 'speech'],
        defaultKey: null,
        run: (api) => withPrefs(api, () => emailChain(api)),
      },
      {
        id: `${ID}.gmailSetup`,
        label: 'Set up Gmail for email chains…',
        keywords: ['email', 'chain', 'gmail', 'app password', 'setup'],
        defaultKey: null,
        run: (api) => withPrefs(api, () => gmailSetupCommand(api)),
      },
      {
        id: `${ID}.gmailForget`,
        label: 'Forget Gmail login',
        keywords: ['email', 'gmail', 'logout', 'forget'],
        defaultKey: null,
        run: (api) => withPrefs(api, () => gmailForget(api)),
      },
      {
        id: `${ID}.textCompare`,
        label: 'Compare text…',
        keywords: ['compare', 'diff', 'difference', 'text', 'changes', 'version', 'card', 'source'],
        defaultKey: null,
        run: (api) => { syncLook(api); return textCompare(api); }, // no helper needed
      },
      {
        id: `${ID}.cardCheck`,
        label: 'Card Check this document…',
        keywords: ['check', 'verify', 'source', 'cite', 'cards', 'evidence', 'miscut'],
        defaultKey: null,
        run: (api) => withPrefs(api, () => cardCheck(api)),
      },
      {
        id: `${ID}.cardCheckLast`,
        label: 'Show last Card Check results',
        keywords: ['check', 'verify', 'results', 'cards'],
        defaultKey: null,
        run: (api) => withPrefs(api, () => lastCardCheck(api)),
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
      {
        id: `${ID}.caselistCardSearch`,
        label: 'Search the caselist for cards…',
        keywords: ['caselist', 'search', 'cards', 'evidence', 'wiki', 'opencaselist', 'past years', 'archive'],
        defaultKey: null,
        run: (api) => withPrefs(api, () => caselistCardSearch(api)),
      },
    ],
  });
})();
