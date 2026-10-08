# Debate Uploader

CardMirror commands that upload docs to SpeechDrop and open docs from it, through a small local helper.

## Install

Debate Uploader has two parts: a **CardMirror plugin** (the commands and dialogs) and a small **local helper**
(does the network work, since CardMirror plugins can't). macOS only for now.

**1. The helper** (once):

```bash
git clone https://github.com/Wizard780/Card-Mirror---Integration---Plugin.git ~/debate-uploader
cd ~/debate-uploader && ./install.sh
```

It starts at login and restarts itself if it crashes. Log: `~/Library/Logs/debate-uploader.log`.

**2. The plugin** (from GitHub, survives relaunches):
1. CardMirror → Settings → Plugins → turn on **Enable plugins**, then relaunch CardMirror.
2. **Required: allow community plugins.** CardMirror only installs plugins from its own curated list, so without
   this step the install fails with *"This repository is not on the curated plugin list."* Open the developer
   console (**View → Toggle Developer Tools → Console**, or Cmd+Option+I) and run:

   ```js
   __plugins('community-on')
   ```

   It answers "community plugin installs ENABLED…" and is remembered. (It allows installs from any GitHub repo;
   check with `__plugins('status')`, turn it off again with `__plugins('community-off')` after installing.)
3. Settings → Plugins → paste `Wizard780/Card-Mirror---Integration---Plugin` (or the full GitHub URL) into the
   install field → **Install** → accept the consent prompt → turn the plugin on.
4. Optional: bind your favorite commands under Settings → Keyboard.

If you previously used **Load plugin from file…**, relaunch CardMirror before installing so the two copies don't clash.

For development you can instead use **Load plugin from file…** → `plugin/plugin.js` (session only).

## Commands

- **Upload newest send doc to SpeechDrop**: uploads the newest `.docx` in your send doc folder.
- **Upload file to SpeechDrop…**: pick any file (`.docx .doc .pdf .txt .rtf .odt`, 10 MB max).
- **Set send doc folder for SpeechDrop…**: change the folder.
- **Browse SpeechDrop room…**: lists a room's files, newest first. ↑↓ + Enter (or click) downloads one to
  `~/Downloads/SpeechDrop/<room>/` and opens it: `.docx`/`.cmir` in CardMirror, anything else in its default app.
  The list stays open so you can open several and **updates live**: new uploads appear within about half a second,
  on top and marked "new" (an empty room shows "Waiting for uploads…"). If the live connection can't be made, the
  hint says "Refreshing every 5 s" and it checks every 5 s instead. Esc closes it.
  file with the same name is saved as `name (2).docx`, so nothing you have open is overwritten.

Both upload commands ask for the room code (pre-filled with the last one). Pasting the whole room URL works too.
Uploads are never retried automatically. If a toast says to check the room, look before uploading again.

## Tabroom

- **Log in to Tabroom…**: email, then password (hidden). The helper trades them for a session token and keeps
  only the token in macOS Keychain (service `debate-uploader`). The password is never saved or logged.
- **Show my Tabroom rounds**: current rounds (or your last 10 if no tournament is live): tournament, round,
  side, opponent, judge, start time. **Enter** (or click) on a round opens each judge's paradigm search on
  tabroom.com in your browser. Tabroom only shows paradigms when you're logged in there, and it only gives
  judges' last names, so pick the right person from the search.
- **Log out of Tabroom**: deletes the stored token.

If the list is always empty, link your Tabroom account to your student record on tabroom.com.
If a toast says Keychain is locked, unlock your login keychain (Keychain Access) and run the command again.

## Caselist

- **Upload to Caselist…**: the first time, pick your caselist, school and team (type to filter); it's remembered.
  Then a form opens: tournament, side, round, opponent, judge, optional report, and the file (newest send doc
  or pick one). **Fill from Tabroom** auto-fills the fields from a current or recent round, or **General
  disclosure (all tournaments)**; every field stays editable. Nothing is sent until you press **Upload**.
- **Change caselist team…**: pick a different caselist, school or team.

**Round report** is drafted for you: the plugin reads the round's docs in your last SpeechDrop room (both teams',
uploaded in the last 4 hours) plus your newest send doc, finds the speech each heading belongs to ("1AC---Grid",
"AT: Offshoring---2NC", or a speech named on a parent heading or in the file name) and writes
"1AC -- Grid, Econ" lines in speech order. A note under the box names the docs it used. Edit it before uploading;
the result line ([W]/[L]) is yours to add.

Uploads are public and never retried automatically. If a toast says to check the caselist page, look there
before uploading again. Requires **Log in to Tabroom…** first.

## Scouting

- **Scout next opponent…**: takes your current Tabroom round's opponent (or pick a round) and finds their page by
  the **debater pair**, with no event picker (your caselist if known, otherwise every open caselist is tried): Tabroom's "Cranbrook FZ" matches the Cranbrook team whose debaters' last names
  start with F and Z, in either order, even when school names differ a little. If two schools have a matching pair,
  the one closer to Tabroom's school name wins; if it's still unclear you pick (debater names shown).
- **Search the caselist…**: pick a caselist (yours first; past years back to 2014 follow the open ones), then a school and a team from type-to-filter lists.
- **Search the caselist for cards…**: type an author, tag or line of card text, then pick where to look (type to
  filter, e.g. `2024`): your event across every year, any single year, this year's caselists, another event across
  every year, or every caselist. It's searched as an exact phrase; put your own quotes in to search words separately
  (`"Starr" nuclear`). One search covers the whole scope and returns its 100 most relevant hits in about a second, so a
  specific search ("Fang 26" across all 60 caselists) is complete right away. When there are more than 100 matches, the
  plugin splits the scope by where the hits came from and searches again; openCaselist allows 4 searches a minute per
  account, so a very common card takes about a minute more (all 580 "Starr 15" cards across every PF year: 62 s, most
  within 2 s). A year with over 100 matches of its own shows the 100 most relevant (openCaselist's maximum). Results are
  remembered for 30 minutes. The same card read in many rounds is one row (+N more). **Enter** on a doc hit downloads
  and opens that round's doc; a cite hit opens the team page. Caselists that failed get a Retry row. Closing the list
  stops the search.

The team page opens on **Summary** ("what they run") when their round reports can be read: for each side, the
arguments in their first constructive (1AC / 1NC) and what they went for in their last speech (2AR / 2NR), with how
many rounds each appeared in and the record in those rounds. It follows the tournament and side filters, so pick a
tournament to see what they ran there. It's built from free-text reports, so it says how many rounds had a
readable one; teams that write "All" or nothing show less. Scouting from Tabroom also shows your pairing above the
tabs (round, your side, time) with each judge's name linking to their paradigm.

The team page also lists their **Rounds** (newest first; rounds with only cites are greyed) and **Cites**. Selecting a
round shows its tournament, round, side, opponent, judge, upload date, file, the full round report and that round's
cites. Filter by **tournament** (dropdown) and **side** (All / Pro / Con) above the list; both tabs follow the filters
and show "x of y" counts. **Enter** or **Open doc** downloads the doc to `~/Downloads/Caselist/<caselist>/<school>-<team>/` and opens it
in CardMirror; **Copy report** / **Copy cites** copy text; ←→ switches tabs; Esc closes. Requires **Log in to Tabroom…**.

## Mark cards

- **Mark cards…**: lists every card in the open document under its block heading. Check the ones to mark
  (click, or ↑↓ and **Enter**; type to filter; **Check shown** does a whole filtered list) and press **Apply**
  (**⌘Enter**). Checked cards turn red, the same red (`FF0000`) CardMirror's own reading marker and marked-card
  tools use. Cards that are already all red start checked; uncheck them to remove that red (other colors stay).
  "Partly red" cards are left alone unless you check them. It's one edit, so **⌘Z** undoes the whole batch.

The plugin API can't edit documents, so this reaches CardMirror's editor through ProseMirror internals. If a
CardMirror update changes those, the command says it couldn't reach the editor instead of doing anything.

## Emphasis in other programs

CardMirror saves its **Emphasis** style with bold switched off, forced to Times New Roman, with complex-script
italics, so in Word, Google Docs and Pages emphasized words look like serif (sometimes italic) underlining. The
plugin fixes this on the way out: every .docx it sends (SpeechDrop, caselist, email chain) goes with Emphasis set to
bold, in the document's own font, not italic, keeping its underline and box. Nothing else in the file changes, and
CardMirror still reads it as emphasis.

- **Make emphasis bold in newest send doc**: fixes the newest send doc in place, for sharing it any other way
  (flash drive, share.tabroom.com in a browser, AirDrop).
- **Copy and paste**: copying from CardMirror into Google Docs or Word keeps cites and emphasis bold. The plugin adds
  bold to those two in what you copy; when you paste the same text back into CardMirror it takes that bold out again,
  so cards pasted within CardMirror are exactly as before. No command needed.

## Email chain (Gmail)

- **Set up Gmail for email chains…** (once): your Gmail address, then a Google **app password**. Make one at
  myaccount.google.com/apppasswords (it needs 2-Step Verification on). The helper checks it with Gmail before
  saving it in macOS Keychain (item `debate-uploader` / `gmail`); it's never logged. An app password can read and
  send mail on your account, so treat it like a password; **Forget Gmail login** deletes it.
- **Email newest send doc to the chain…**: your newest send doc attached, then:
  - **Reply all to**: pick a recent email (last 3 days, newest first) to reply-all into a chain someone else
    started. To fills with everyone on it (sender, To and Cc, minus you) and the reply joins that thread for everyone.
    The helper reads only email headers (sender, recipients, subject, date) over IMAP, read-only; nothing is marked
    read and no message bodies are fetched.
  - **New email**: To (the last chain's addresses filled in) and Subject (from your Tabroom pairing, e.g.
    "Glenbrooks · Round 3 · University AS vs Cranbrook FZ"). Sending again with the same subject replies in your
    own thread.
  - **Message**: the email's text, editable; your last message is remembered.
  **Send** (or ⌘Enter) emails it right away from your Gmail.
- Never retried automatically. If a toast says Gmail didn't confirm, check your Sent folder before sending again.

## Card Check

- **Card Check this document…**: checks every card in the open document against the page its cite links to.
  Results fill in as sources load (4 at a time); select one for details, **Enter** / **Go to card** jumps to it,
  **Open source** opens the page. **Show last Card Check results** reopens the list.
- What it looks at:
  - text in the card that isn't on the page (CardMirror's condense notes, `[bracketed]` insertions and your own
    `---` note lines are ignored);
  - text joined from far-apart or out-of-order places in the source;
  - the cite's author not named on the page, or a year that differs from the page's date;
  - highlighting that skips a qualifier ("not", "may", "could", "unless", …) between read words. This one only
    needs the doc, so it works even without a link.
- Results: **Matches source** · **Differences found** · **Couldn't verify** (the page doesn't contain the card:
  paywall, a different version, a landing page, or the wrong link) · **Couldn't reach the source** · **No link in
  cite**. It reports differences; it doesn't decide that a card is fake. Read the source before accusing anyone.
- Dead or blocked links fall back to the Wayback Machine's copy. PDFs need PyMuPDF (`pip install pymupdf`) or
  `pdftotext` (`brew install poppler`); without them PDF sources show as couldn't reach.
- Links come from other people's docs, so the helper only fetches public web addresses (never your own Mac or
  local network), caps each page at 8 MB and 15 s, and keeps nothing.

## Search my files

- **Set evidence folders…**: the folders to search, separated by `;` (e.g. `~/Downloads/Ryan Files; ~/Downloads/Caselist`).
  The first **Search my files…** asks for them. Subfolders are included; hidden folders, Word lock files (`~$…`) and
  symlinks are skipped.
- **Search my files…**: type words from a card's **tag, cite (author, year, source), block heading or file name**;
  every word must match. Whole-word matches rank first, real cards beat analytics, and the same card saved in several
  files shows once (with a copy count; the newest copy opens). ↑↓ moves, **Enter** opens the file in CardMirror and
  tries to jump to the card (if it can't, the toast names the card to look for). **⌘Enter** / **Open card only**
  saves just that card, formatting kept, to `~/Downloads/Cards/` and opens it, ready to copy into a speech doc.

The helper indexes in the background (about 13 s for 2,500 files the first time; later only changed files are read)
and search works while it runs. The index lives in `~/Library/Application Support/debate-uploader/evidence-index.json`.
Tags are paragraphs in a Heading 4 style (including custom styles based on it). Tags typed as bold Normal text
aren't found.

## Updating

- Plugin: Settings → Plugins → **Update** on Debate Uploader (needs `__plugins('community-on')` still on).
- Helper: `cd ~/debate-uploader && git pull && launchctl kickstart -k gui/$(id -u)/debate-uploader`

## Settings

CardMirror clears a plugin's saved settings at every launch when it was loaded from a file, so the helper keeps a
copy in `~/Library/Application Support/debate-uploader/prefs.json` (send doc folder, last room, caselist team,
Tabroom email; never passwords) and the plugin restores it before each command.

## Troubleshooting

- "Uploader helper isn't running" → `launchctl kickstart gui/$(id -u)/debate-uploader`
- Uninstall the helper: `launchctl bootout gui/$(id -u)/debate-uploader && rm ~/Library/LaunchAgents/com.debate-uploader.plist`
- Run the tests: `node --test`

## For the maintainer: how many people use it

```bash
npm run stats
```

Shows how many times each release's `plugin.js` was downloaded. CardMirror downloads it on every install and
update, so this counts installs + updates, not people. The plugin and helper send nothing anywhere to be counted.
