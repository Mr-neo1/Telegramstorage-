# Telegram Storage

A file and folder storage app that keeps your files in Telegram.

- **Web app**: folders, drag-and-drop uploads (files and whole folders), previews for images, video, audio, PDFs and text, search, recent files, trash with restore, and move, rename and download. Works on phones too, and follows your system's light or dark mode.
- **Sign in with Telegram**: no passwords. You open the bot, it asks *"Sign in to Telegram Storage?"*, and you tap **Approve**.
- **REST API**: other apps and scripts can read and write files with an API key.
- **Any file size**: big files are split into parts under Telegram's bot limits and joined again when you download them. Downloads support HTTP range requests, so videos stream and seek.
- **Send to bot**: send a file to your bot in Telegram and it shows up in a `Telegram Inbox` folder.

## How it works

```
 Browser / your apps ──HTTP──▶  This server  ──Bot API──▶  Telegram
                                 │                          (private channel or
                                 └─ data/storage.db          your chat with the bot)
                                    folders, file names,
                                    where each part lives
```

The bytes of every file live in Telegram as documents. The server keeps a small SQLite database (`data/storage.db`) that records your folders and which Telegram messages hold each file.

The database is backed up automatically: a few seconds after any change, the server saves a compressed copy to Telegram as a **pinned** file called `telegram-storage-backup.db.gz`, by replacing the file in that one pinned message. If the server ever starts with no database (a new machine, or a free host that wiped its disk), it restores from that file before starting. Keep that message pinned, and don't pin other messages after it in the same chat.

## Requirements

- Node.js 22.13 or newer (it uses Node's built-in SQLite, so there's nothing to compile)
- A Telegram account

## Get started

```bash
npm install
npm run setup     # connects your bot, picks where files are stored, locks sign-in to you
npm run build
npm start
```

Then open http://localhost:8080 and sign in with Telegram.

`npm run setup` walks you through:

1. **Creating a bot**: in Telegram, message [@BotFather](https://t.me/BotFather), send `/newbot`, and paste the token.
2. **Choosing where files go**: a private channel (recommended) or your private chat with the bot. For a channel, create it, add the bot as an admin that can post and delete messages, and post anything. The script detects it.
3. **Choosing who can sign in**: "Only me" waits for you to press Start in the bot and saves your Telegram ID.

Stop the server before running setup again, because both read the bot's updates.

You can also copy `.env.example` to `.env` and fill it in yourself.

### While developing

```bash
npm run dev
```

This runs the API on port 8080 with auto-restart, and the web app on http://localhost:5173 with hot reload.

## Using the API

1. Open **Developers** in the app and create an API key. Choose **Read** only, or **Read** and **Write**.
2. Send it with every request: `Authorization: Bearer tgs_…` (or `X-API-Key: tgs_…`).

The Developers page has copy-ready examples in curl, JavaScript and Python, filled in with your server's address.

### Read and write by path

The simplest way: paths work like folders on disk, and missing folders are created for you.

```bash
# Write (creates Backups/ if needed; replaces the file if it exists)
curl -X PUT "http://localhost:8080/api/v1/fs/Backups/notes.txt" \
  -H "Authorization: Bearer $TGS_KEY" --data-binary @notes.txt

# Read
curl "http://localhost:8080/api/v1/fs/Backups/notes.txt" -H "Authorization: Bearer $TGS_KEY"

# List a folder (JSON)
curl "http://localhost:8080/api/v1/fs/Backups" -H "Authorization: Bearer $TGS_KEY"

# Rename or move
curl -X PATCH "http://localhost:8080/api/v1/fs/Backups/notes.txt" \
  -H "Authorization: Bearer $TGS_KEY" -H "Content-Type: application/json" \
  -d '{"name": "notes-2026.txt", "moveTo": "Archive/2026"}'

# Delete (moves to trash; add ?permanent=true to delete forever)
curl -X DELETE "http://localhost:8080/api/v1/fs/Archive/2026/notes-2026.txt" -H "Authorization: Bearer $TGS_KEY"
```

### Upload with a form

```bash
curl "http://localhost:8080/api/v1/files?path=Photos/2026&onConflict=rename" \
  -H "Authorization: Bearer $TGS_KEY" \
  -F "file=@beach.jpg" -F "file=@sunset.jpg"
```

`onConflict` is `rename` (default, gives "beach (1).jpg"), `overwrite` (keeps the file's id) or `fail` (409).

### All endpoints

| Method | Path | What it does |
| --- | --- | --- |
| GET | `/api/v1/fs/{path}` | Download a file, or list a folder. `?meta=1` returns a file's details. |
| PUT | `/api/v1/fs/{path}` | Write the request body to a file. `?overwrite=false` refuses to replace. |
| PATCH | `/api/v1/fs/{path}` | Rename or move: `{"name", "moveTo"}` |
| DELETE | `/api/v1/fs/{path}` | Move to trash. `?permanent=true` deletes forever. |
| POST | `/api/v1/files` | Upload (multipart, field `file`). Options: `folderId` or `path`, `onConflict`. |
| GET | `/api/v1/files/{id}` | File details. |
| GET | `/api/v1/files/{id}/content` | Download. Supports `Range`. `?download=1` forces a download. |
| PUT | `/api/v1/files/{id}/content` | Replace the content, keeping the id. |
| PATCH | `/api/v1/files/{id}` | Rename or move: `{"name", "folderId"}` |
| DELETE | `/api/v1/files/{id}` | Move to trash (`?permanent=true` deletes forever). |
| GET | `/api/v1/folders/{id or root}/children` | List a folder. |
| POST | `/api/v1/folders` | `{"name", "parentId"}`, or `{"path": "A/B/C"}` for nested folders. |
| PATCH | `/api/v1/folders/{id}` | Rename or move: `{"name", "parentId"}` |
| DELETE | `/api/v1/folders/{id}` | Move to trash with its contents (`?permanent=true` deletes forever). |
| POST | `/api/v1/items/move` | Move many: `{"files": [], "folders": [], "folderId"}` |
| POST | `/api/v1/items/trash` | Trash many: `{"files": [], "folders": []}` |
| GET | `/api/v1/search?q=` | Find by name. |
| GET | `/api/v1/recent` | Recently changed files. |
| GET | `/api/v1/trash` | What's in the trash. |
| POST | `/api/v1/trash/restore` | Restore: `{"files": [], "folders": []}` |
| POST | `/api/v1/trash/delete` | Delete forever: `{"files": [], "folders": []}` |
| DELETE | `/api/v1/trash` | Empty the trash. |
| GET | `/api/v1/me` | Your account and storage usage. |

Errors are JSON: `{"error": {"code": "name_taken", "message": "A file named \"a.txt\" already exists here"}}` with a matching HTTP status. CORS is open for `/api/v1`, so browser apps on other sites can call it with an API key.

## Limits and behaviour

- **File size**: unlimited in practice. The public Bot API lets bots download files up to 20 MB, so files are stored as 18 MB parts. A 1 GB file is about 56 parts.
- **Speed**: Telegram rate-limits bots (roughly 20 messages a minute in a channel). The server waits and retries automatically, so a large batch slows down rather than failing. To store big files faster, run your own [Telegram Bot API server](https://github.com/tdlib/telegram-bot-api), set `TELEGRAM_API_BASE` to it and raise `CHUNK_SIZE_MB` (up to 1990).
- **Files sent to the bot in chat** are saved without re-uploading, but only up to 20 MB, because that's the most a bot can read. Upload bigger ones from the web app.
- **Deleting forever** removes the parts from Telegram too. Telegram only lets bots delete messages from the last 48 hours in some chats; older parts stay in the channel but are no longer listed.
- **Don't delete messages in the storage channel by hand**, or the files that use them will stop downloading.

## Security notes

- Sign-in codes expire after 10 minutes and can be used once. The bot shows the browser, OS and IP address asking to sign in, and only the person who opened the link can approve it.
- With `ALLOWED_TELEGRAM_USER_IDS` empty, anyone who finds your bot can sign in. Each person only sees their own files, but they're stored in your channel. `npm run setup` → "Only me" prevents this.
- Sessions and API keys are stored as hashes. API keys are shown once when created.
- Browser sessions use `SameSite=Lax` cookies plus a required `X-Requested-With` header on every change, so other websites can't act as you.
- Uploaded HTML and SVG files are served with a sandboxing `Content-Security-Policy`, so opening them can't run scripts as you.
- Files in Telegram are not encrypted by this app. Anyone with access to the storage channel can see them.

## Deploy for free on Render

Render's free plan has two catches, and the app handles both:

- **It sleeps after 15 minutes without visits.** The app visits its own address every 10 minutes, so it stays awake.
- **It wipes the disk on every restart and deploy.** The app backs its database up to Telegram and restores it on start, as described above.

One always-on service uses about 720–744 of the 750 free hours Render gives each workspace per month. Don't run a second free web service in the same Render workspace, or the hours run out before the month ends.

### 1. Move your existing data to Telegram (skip if you're starting fresh)

Run the latest version on your computer once: `npm run build`, then `npm start`. Wait for `✓ Database backed up to Telegram`, then stop it with Ctrl+C. Your chat with the bot (or your storage channel) now has the pinned backup file, and Render will start from it.

### 2. Put the code on GitHub

Create an **empty private repository** on github.com (no README), then in this folder:

```bash
git remote add origin https://github.com/YOUR-NAME/telegram-storage.git
git push -u origin main
```

`.env` and `data/` are never uploaded (see `.gitignore`).

### 3. Create the service on Render

1. Sign in at [render.com](https://render.com) with GitHub. No card is needed for the free plan.
2. Choose **New → Blueprint**, pick your repository, and Render reads `render.yaml`.
3. Fill in `TELEGRAM_BOT_TOKEN` and `ALLOWED_TELEGRAM_USER_IDS` (copy both from your local `.env`). If you use a storage channel, also add `TELEGRAM_STORAGE_CHAT_ID` under **Environment** afterwards.
4. Click **Apply**. The first build takes a few minutes. Open the `https://….onrender.com` address it shows and sign in with Telegram.

### 4. Stop the copy on your computer

Only one copy can use a bot at a time (otherwise sign-in stops working with a "409" error in the log), and two copies would overwrite each other's backups. From now on, use the Render address.

### Updating

Push to GitHub and Render redeploys automatically. Before stopping the old version, the app saves its latest changes to Telegram, and the new version restores them.

### Good to know

- If the app crashes without warning, changes from the last ~15 seconds before the crash may be lost. Normal restarts and deploys save first.
- Downloads and uploads pass through Render, so they count toward Render's free monthly bandwidth.
- The keep-alive is a workaround. If Render ever stops counting it as a visit, add a free external monitor (for example [cron-job.org](https://cron-job.org)) that opens `https://YOUR-APP.onrender.com/api/health` every 10 minutes.

## Running it for other devices

By default the server only listens on this computer (`HOST=127.0.0.1`).

- **On your home network**: set `HOST=0.0.0.0`, then open `http://<this computer's IP>:8080` on another device.
- **On the internet**: put it behind HTTPS (Caddy, nginx or a Cloudflare Tunnel), set `PUBLIC_URL=https://your.domain` (turns on secure cookies) and `TRUST_PROXY=1` (so sign-in prompts show real IP addresses).

## Settings (`.env`)

| Setting | Default | Meaning |
| --- | --- | --- |
| `TELEGRAM_BOT_TOKEN` | | Required. From @BotFather. |
| `TELEGRAM_STORAGE_CHAT_ID` | empty | Channel or group to store files in. Empty = each person's chat with the bot. |
| `ALLOWED_TELEGRAM_USER_IDS` | empty | Comma-separated Telegram user ids that may sign in. Empty = anyone. |
| `PORT` / `HOST` | `8080` / `127.0.0.1` | Where the web server listens. |
| `PUBLIC_URL` | empty | Public address of the app. |
| `TRUST_PROXY` | empty | `1` when behind a reverse proxy. |
| `DATA_DIR` | `data` | Where the database is kept. |
| `BACKUP` | `on` | Back the database up to Telegram and restore it on an empty disk. |
| `BACKUP_CHAT_ID` | | Where backups go. Defaults to the storage channel, else the first allowed user's chat. |
| `KEEP_ALIVE_URL` | Render's address | Address the app visits to keep itself awake. `KEEP_ALIVE=off` disables it. |
| `MAX_UPLOAD_MB` | `0` | Largest upload allowed, `0` = no limit. |
| `TELEGRAM_API_BASE` | `https://api.telegram.org` | Use your own Bot API server. |
| `CHUNK_SIZE_MB` | `18` | Part size (max 19 on the public API, 1990 on your own server). |

## Troubleshooting

- **The sign-in page says the bot isn't connected**: run `npm run setup`, then restart the server.
- **"Another program is reading this bot's updates (409)"**: two copies of the server (or setup) are running with the same bot, for example on your computer and on Render. Stop one.
- **"The most recently pinned message … isn't a Telegram Storage backup"**: you pinned another message in the backup chat. Unpin it so the backup file is the latest pin, then restart.
- **Uploads fail with "chat not found"**: the bot isn't an admin in the storage channel, or `TELEGRAM_STORAGE_CHAT_ID` is wrong. Run setup again.
- **Uploads fail when storing in the bot chat**: open the bot in Telegram and press Start (and make sure you haven't blocked it).

## Project layout

```
server/            Node.js + Express API
  index.js         Startup: restores the database from Telegram if needed, then starts the app
  app.js           HTTP server, static web app, error handling
  backup.js        Database backups to Telegram, restore, keep-alive
  api.js           /api/v1 routes (files, folders, path API, uploads, downloads)
  auth.js          Telegram sign-in, sessions, API keys
  bot.js           Telegram bot: sign-in confirmation, files sent in chat
  storage.js       Folders, files, chunked upload/download, trash
  telegram.js      Bot API client with retries and rate-limit handling
  db.js            SQLite schema
web/               React web app (Vite)
scripts/setup.js   Interactive setup
render.yaml        Render deployment (free plan)
```
