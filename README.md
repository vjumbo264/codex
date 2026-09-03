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

## 1 · Add your Gemini API key (one-time, ~3 minutes, phone-friendly)

The bot's manual commands work without this, but voice notes, auto-filing,
plain-language requests, and note editing need it.

**Step 1 — Get a free Gemini API key**
1. On your phone, open **https://aistudio.google.com/apikey** (sign in with
   any Google account).
2. Tap **Create API key** → copy it.

**Step 2 — Add it to the Worker (via the Cloudflare dashboard in your browser)**
1. Open **https://dash.cloudflare.com** and log in.
2. In the left menu tap **Workers & Pages** → tap the **`codex-bot`** Worker.
3. Tap **Settings** (top) → **Variables and Secrets** (or **Bindings** →
   **Variables and Secrets**, depending on the layout).
4. Under **Secrets**, tap **Add**:
   - **Name:** `GEMINI_API_KEY`
   - **Value:** paste your key from Step 1.
   - Type: **Secret**.
5. Tap **Deploy** / **Save**. Done — no redeploy needed; the bot picks it up
   immediately.

*(Equivalent from Termux, if you prefer:
`npx wrangler secret put GEMINI_API_KEY` inside a checkout of this repo.)*

That's the only setup step. Everything else is already wired up.

---

## 2 · Using the bot

Open your bot in Telegram and tap **Start** (or send `/start`).

### Capture

| You send | What happens |
|---|---|
| **Plain text** | Gemini decides where it fits in your topic tree and files it. You get buttons to **View / Move / New topic** if it filed wrong. |
| **A voice note** | Transcribed and *cleaned up* (rambling and false starts removed), then filed like a text note. Only the clean text is stored. |
| **A photo** | Filed (with its caption); the image is stored in the repo and shows inline when you read or export. |
| `add this to <topic>: <text>` | Filed exactly there, no guessing. |
| `new topic <name>: <text>` | Creates the topic and files the note in it. |

### Manual commands (always work, no Gemini)

| Command | What it does |
|---|---|
| `/new <topic>` | Create a topic. Use slashes to nest: `/new travel/japan` |
| `/add <topic>` | Add a note to an exact topic — the bot asks for the text (reply to its message; text or a photo). |
| `/topics` | Browse the whole tree with buttons. Tap a topic to drill in (unlimited depth), **⬆️ Up** to go back. Every level has **Read**, **Export PDF**, **Delete**. |
| `/read <topic>` | Read a topic right in chat — paginated if long, photos sent as real inline images. |
| `/export <topic>` | PDF of that topic **plus everything nested under it**, images inline. `/export all` exports the whole notebook. |
| `/delete <topic>` | Delete a topic and all inside it — always asks **Yes / Cancel** first. |
| `/delete <topic> <entry-id>` | Delete one entry (entry ids show when reading). |
| `/help` | The cheat sheet, in chat. |

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
- **Secrets** (all stored safely, never in code): `TELEGRAM_BOT_TOKEN`,
  `GITHUB_REPO_TOKEN`, `WEBHOOK_SECRET`, and your `GEMINI_API_KEY`.

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
