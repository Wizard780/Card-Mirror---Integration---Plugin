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
  The list stays open so you can open several, refreshes every 5 s (new uploads appear on top marked "new";
  an empty room shows "Waiting for uploads…"), and Esc closes it. A file you already have is reused; a different
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

## Troubleshooting

- "Uploader helper isn't running" → `launchctl kickstart gui/$(id -u)/debate-uploader`
- Uninstall the helper: `launchctl bootout gui/$(id -u)/debate-uploader && rm ~/Library/LaunchAgents/com.debate-uploader.plist`
- Run the tests: `node --test`
