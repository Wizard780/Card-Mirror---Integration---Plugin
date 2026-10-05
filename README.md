# Debate Uploader

CardMirror commands that upload docs to SpeechDrop and open docs from it, through a small local helper.

## Install (once)

```bash
cd /Users/ryanchan/Downloads/debateskills/debate-uploader
./install.sh
```

The helper starts at login and restarts itself if it crashes. Log: `~/Library/Logs/debate-uploader.log`.

In CardMirror:
1. Settings → Plugins → turn on **Enable plugins**, then relaunch CardMirror.
2. Settings → Plugins → **Load plugin from file…** → pick `plugin/plugin.js`.
   CardMirror loads file plugins **for that session only**, so repeat this step after each relaunch.
3. Run **Set send doc folder for SpeechDrop…** once (where Save Send Doc writes). It's remembered.
4. Optional: bind **Upload newest send doc to SpeechDrop** to a key in Settings → Keyboard.

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
  side, opponent, judge, start time.
- **Log out of Tabroom**: deletes the stored token.

If the list is always empty, link your Tabroom account to your student record on tabroom.com.
If a toast says Keychain is locked, unlock your login keychain (Keychain Access) and run the command again.

## Caselist

- **Upload to Caselist…**: the first time, pick your caselist, school and team (type to filter); it's remembered.
  Then a form opens: tournament, side, round, opponent, judge, optional report, and the file (newest send doc
  or pick one). **Fill from Tabroom** auto-fills the fields from a current or recent round, or **General
  disclosure (all tournaments)**; every field stays editable. Nothing is sent until you press **Upload**.
- **Change caselist team…**: pick a different caselist, school or team.

Uploads are public and never retried automatically. If a toast says to check the caselist page, look there
before uploading again. Requires **Log in to Tabroom…** first.

## Scouting

- **Scout next opponent…**: takes your current Tabroom round's opponent (or pick a round) and finds their page by
  the **debater pair**, with no event picker (your caselist if known, otherwise every open caselist is tried): Tabroom's "Cranbrook FZ" matches the Cranbrook team whose debaters' last names
  start with F and Z, in either order, even when school names differ a little. If two schools have a matching pair,
  the one closer to Tabroom's school name wins; if it's still unclear you pick (debater names shown).
- **Search the caselist…**: pick a caselist (yours first), then a school and a team from type-to-filter lists.

The team page lists their **Rounds** (newest first; rounds with only cites are greyed) and **Cites**. Selecting a
round shows its tournament, round, side, opponent, judge, upload date, file, the full round report and that round's
cites. **Enter** or **Open doc** downloads the doc to `~/Downloads/Caselist/<caselist>/<school>-<team>/` and opens it
in CardMirror; **Copy report** / **Copy cites** copy text; ←→ switches tabs; Esc closes. Requires **Log in to Tabroom…**.

## Settings

CardMirror clears a plugin's saved settings at every launch when it was loaded from a file, so the helper keeps a
copy in `~/Library/Application Support/debate-uploader/prefs.json` (send doc folder, last room, caselist team,
Tabroom email; never passwords) and the plugin restores it before each command.

## Troubleshooting

- "Uploader helper isn't running" → `launchctl kickstart gui/$(id -u)/debate-uploader`
- Uninstall the helper: `launchctl bootout gui/$(id -u)/debate-uploader && rm ~/Library/LaunchAgents/com.debate-uploader.plist`
- Run the tests: `node --test`
