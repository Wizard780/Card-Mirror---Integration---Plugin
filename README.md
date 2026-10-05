# Debate Uploader

CardMirror commands that upload docs to SpeechDrop, through a small local helper.

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

Both upload commands ask for the room code (pre-filled with the last one). Pasting the whole room URL works too.
Uploads are never retried automatically. If a toast says to check the room, look before uploading again.

## Troubleshooting

- "Uploader helper isn't running" → `launchctl kickstart gui/$(id -u)/debate-uploader`
- Uninstall the helper: `launchctl bootout gui/$(id -u)/debate-uploader && rm ~/Library/LaunchAgents/com.debate-uploader.plist`
- Run the tests: `node --test`
