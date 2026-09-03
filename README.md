# 📓 Codex

A personal notebook that lives entirely in **Telegram**. Send it text, voice
notes, or photos at any time, about anything — it files them into an
infinitely nestable tree of topics, and can fetch, read, export, edit, or
delete anything, any time.

- **Storage:** this GitHub repository *is* the database. Every note is plain
  Markdown in `notebook/`, committed on every change — so you get full
  history and versioning for free. Deletions are recoverable via git
  history.
- **Runtime:** a Cloudflare Worker (auto-deploys from this repo on every
  push to `main` via GitHub Actions).
- **Brains (optional):** Google Gemini, used only for things that genuinely
  need reasoning — transcribing/cleaning voice notes, auto-filing
  unspecified notes, editing notes from natural requests, and understanding
  plain-language commands. All slash commands and buttons work with **zero**
  Gemini calls.

Everything below works from a phone — no computer, no command line needed
(Termux works too if you prefer it).

---

## 1 · Add your Gemini API key(s) — right inside Telegram

The bot's manual commands work without this, but voice notes, auto-filing,
plain-language requests, and note editing need at least one key.

**Step 1 — Get a free Gemini API key**
1. On your phone, open **https://aistudio.google.com/apikey** (sign in with
   any Google account).
2. Tap **Create API key** → copy it.

**Step 2 — Hand it to the bot**
1. Open the bot and send `/start` → tap **⚙️ Settings** → **🔑 Gemini API
   keys** → **➕ Add keys**.
2. Paste your key(s) — **one per line, as many as you like in a single
   message** — and send.

Keys are stored in the Worker's KV storage and listed masked (only the
last 4 characters show). You can remove a key by tapping its **🗑 Remove**
button, or add several at once so the bot rotates through them when one
runs out of quota. No Cloudflare dashboard, no redeploys, ever.

*If you previously set the `GEMINI_API_KEY` Worker secret: it still works —
the bot automatically migrates it into the key pool on first use. Nothing
to redo.*

---

## 2 · Using the bot

Open your bot in Telegram and tap **Start** (or send `/start`). That opens
the **home screen** — from then on, the bot runs on taps:

- **🗂 Browse topics** — drill into your tree (unlimited depth), and on
  every topic: **📖 Read** (paginated in chat, photos inline),
  **📄 Export PDF** (that topic plus everything under it), **🗑 Delete**
  (always asks first). **⬆️ Up** climbs, **🏠 Home** is on every screen.
- **📄 Export** — the whole notebook as one PDF, or pick a topic.
- **⚙️ Settings → 🔑 Gemini API keys** — add several keys at once (one per
  line), see them listed masked, remove one or clear all — all by tapping.

Capture is not a menu: just **send** text, a voice note, a photo, or a
text file (`.txt`/`.md`/…) — with an optional caption to steer where it's
filed. Every completed action replies with exactly what it did (which
topic, which entry), with **View / Move / New topic** buttons.

### Fast-path commands (optional)

Everything above works from the menu; these are just quicker when you know
what you want: `/menu` · `/topics` · `/new <topic>` · `/add <topic>` ·
`/read <topic>` · `/export <topic>` or `/export all` ·
`/delete <topic> [entry-id]` · `/help`.

### Just ask (plain language, uses Gemini)

- “read my travel notes”
- “export recipes as a PDF”
- “delete the entry about the visa in travel”
- “edit my note about the flight to mention the booking reference XYZ123”
- “what topics do I have?”

Every delete — however you trigger it — asks for confirmation first.

---

## 3 · How it works (short version)

```
Telegram ──webhook──> Cloudflare Worker (codex-bot)
                          │
                          ├─ manual commands/buttons ─> GitHub API (this repo = database)
                          │                              commits on every change
                          ├─ voice/ambiguous/auto-file ─> Gemini (only reasoning tasks)
                          └─ export ─> mechanical Markdown→PDF (pdf-lib), no AI
```

- **Note tree:** `notebook/<topic>/<subtopic>/…` — a directory per topic,
  `index.md` for its entries, `assets/` for its images. See
  [ARCHITECTURE.md](ARCHITECTURE.md).
- **Deploys:** push to `main` → GitHub Action → Worker updated. No manual
  deploys.
- **Secrets & storage** (never in code): `TELEGRAM_BOT_TOKEN`,
  `GITHUB_REPO_TOKEN`, `WEBHOOK_SECRET` as Worker secrets; Gemini API keys
  in the Worker's `CODEX_KV` namespace (auto-provisioned on deploy),
  managed in-chat via Settings → Keys.

### Known limitations
- PDF text uses an embedded DejaVu font: Latin/Greek/Cyrillic render fully;
  CJK characters and emoji appear as blanks in PDFs (they're fine in chat).
- The notebook repo is public, so notes are readable on GitHub. If you ever
  want it private, flip the repo to private and the bot keeps working (it
  authenticates with its own token).

## 4 · For future build sessions

Read `BUILD_STATE.json` (the persistent build checkpoint) and
`ARCHITECTURE.md` before changing anything. Never reset either file; resume
from the first non-`done` task.
