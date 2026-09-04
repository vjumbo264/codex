# Codex Architecture

Codex is a personal notebook accessed entirely through Telegram. This document
is the authoritative description of the note-tree storage schema and the
system architecture. Any session resuming work on this repo must read this
file plus `BUILD_STATE.json` before writing code.

---

## 1. Note-tree storage schema (repo-as-database)

The notebook lives entirely in this repository under `notebook/`.
The git history of this repo **is** the version history of the notebook.
Deletions rewrite the live files; recovery happens via git history only.

### 1.1 Topics = directories

```
notebook/
├── travel/                        <- top-level topic
│   ├── index.md                   <- this node's own entries
│   ├── assets/                    <- images attached to this node's entries
│   │   └── 20260903-141205-k7f2.jpg
│   └── japan/                     <- subtopic (nesting is unlimited)
│       ├── index.md
│       ├── assets/
│       └── kyoto/                 <- sub-subtopic, and so on, no depth limit
│           └── index.md
└── recipes/
    ├── index.md
    └── ...
```

- **A topic is a directory.** A subtopic is a subdirectory. Because the tree
  is just the filesystem, nesting depth is genuinely unlimited — no schema
  change is ever needed to go deeper.
- **Directory name = immutable slug** of the topic title: lowercase,
  `[a-z0-9-]`, spaces/punctuation collapsed to `-`, max 48 chars, unique
  among siblings (suffix `-2`, `-3`, … on collision). Slugs never change
  once created, so links/callbacks never break.
- **Display title** lives in the first line of `index.md` as `# <Title>`.
  Renaming a topic edits only that line; the directory stays put.
- A **node path** is the slash-joined slugs below `notebook/`, e.g.
  `travel/japan/kyoto`. The empty path `` is the notebook root (top level).
  Root itself holds no entries; entries always belong to a topic.

### 1.2 `index.md` entry format

Every node directory contains `index.md` with this exact structure:

```markdown
# Japan

<!-- e:20260903-093015-k7f2 -->
_2026-09-03 · 09:30 UTC_

Flight to Osaka booked for late November. Check visa requirements
and pocket-wifi rental.

---

<!-- e:20260903-141205-q9x1 -->
_2026-09-03 · 14:12 UTC_

Station map I need later:

![photo](assets/20260903-141205-q9x1.jpg)

---
```

Rules that make this mechanically parseable (no AI ever needed):

1. **Entry ID line** — an HTML comment `<!-- e:<id> -->` where
   `<id> = <yyyymmdd>-<hhmmss>-<4-char base36 random>`. IDs are unique,
   sortable, and let edit/delete target one entry deterministically.
   HTML comments render as nothing in Telegram and are stripped by the PDF
   renderer.
2. **Date line** — `_YYYY-MM-DD · HH:MM UTC_` (italic). This is the
   "visible but not prominent" date stamp: small italic line above each
   entry. Times are always UTC.
3. **Body** — free Markdown: paragraphs, lists, bold/italic, and image
   embeds `![alt](assets/<filename>)`. Image paths are always relative
   to the node's own `assets/` directory.
4. **Separator** — every entry ends with a line containing only `---`
   (including the last one). A node file is therefore:
   `# Title` + zero or more `(ID line, date line, body, ---)` blocks.
5. New entries are **appended at the end** (chronological order, which is
   also the natural reading order for both Telegram and PDF).

### 1.3 Image storage convention

- Images are committed to the repo under the owning node's `assets/`
  directory: `notebook/<path>/assets/<yyyymmdd>-<hhmmss>-<rand>.<ext>`.
- The entry body references them with the relative path
  `assets/<filename>`. Given a node path + entry, every image resolves
  mechanically to a repo path, and from there to a raw bytes URL:
  `https://raw.githubusercontent.com/vjumbo264/codex/main/notebook/<path>/assets/<file>`
  (the repo is public, so Telegram `sendPhoto` by URL and the PDF renderer
  can both fetch bytes with no credential).
- One image per Telegram photo message; multi-photo messages create one
  entry per image (caption on the first).

### 1.4 Why this satisfies the three hard requirements

- **(a) Mechanical PDF conversion:** the grammar above is a tiny regular
  structure — title line, repeated entry blocks, relative image paths.
  `worker/src/pdf.js` parses it with plain string/regex code and renders
  PDF directly. No model call anywhere in export.
- **(b) Clean raw Markdown in Telegram:** headings, italic dates, bullet
  lists and `![…](…)` embeds are exactly what a person would write by hand.
  In-chat reading sends entry text as plain text (no parse-mode injection
  bugs) and sends each image as a real photo message.
- **(c) Unlimited nesting:** directories nest arbitrarily; nothing in the
  schema or code hard-codes a depth.

### 1.5 No index file, no D1

The directory structure is the single source of truth. The Worker lists the
tree with one recursive GitHub `git/trees?recursive=1` call (repo is small —
a personal notebook). D1/KV were considered and deliberately **not** used:
they would add a second store that can drift from the repo. Multi-step
interaction state is carried statelessly in Telegram itself (see §4).

---

## 2. Worker layout

```
worker/
├── wrangler.toml              # Worker config (name, vars, Data import rule for font)
├── package.json               # pdf-lib is the only runtime dependency
├── fonts/DejaVuSans.ttf       # embedded in the Worker for PDF text (see §6)
└── src/
    ├── index.js               # fetch handler: webhook verification, update routing
    ├── telegram.js            # Telegram Bot API client (send/edit/photo/document/keyboard)
    ├── github.js              # GitHub contents/trees API client (the "database driver")
    ├── tree.js                # tree listing, slugify, path resolve, node create/exists
    ├── notes.js               # entry append/edit/delete, node delete, node read model
    ├── pdf.js                 # mechanical Markdown-tree -> PDF renderer (pdf-lib)
    ├── commands.js            # manual slash-command handlers (zero Gemini)
    ├── keyboards.js           # inline keyboard builders (every screen ends in Back/Home)
    ├── ui.js                  # the tappable app screens: home, export menu, settings, keys (fix-03)
    ├── keypool.js             # Gemini API key pool in CODEX_KV + legacy-secret migration (fix-03)
    ├── callbacks.js           # callback_query routing (screens + browse/read/export/delete/move)
    ├── pending.js             # stateless ForceReply context tokens (#cx:…)
    ├── gemini.js              # Gemini intent dispatch, transcription, edit (only file that calls Gemini)
    └── util.js                # ids, dates, chunking, base64url, sha1-h8
```

`scripts/predeploy.mjs` runs in the deploy workflow before `wrangler deploy`:
it creates the `CODEX_KV` KV namespace via the Cloudflare API when missing
(using the same `CLOUDFLARE_API_TOKEN`/`CLOUDFLARE_ACCOUNT_ID` secrets as the
deploy step) and stamps its real id into `wrangler.toml` — the namespace
requires no dashboard interaction, ever.

`.github/workflows/deploy.yml` deploys the Worker on every push to `main`
that touches `worker/**` (wrangler-action), using GitHub Actions secrets
`CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID`. That is the
GitHub-connected auto-deploy; pushing to `main` is the only deploy step.

---

## 3. Configuration & secrets

Worker **vars** (public, in `wrangler.toml`):
`REPO_OWNER`, `REPO_NAME`, `REPO_BRANCH`, `GEMINI_MODEL` (default
`gemini-flash-lite-latest` — the cheapest current model; used for both
text and audio; one configurable knob).

Worker **bindings**:
- `CODEX_KV` — KV namespace, declared in `wrangler.toml` and auto-
  provisioned by `scripts/predeploy.mjs` at deploy time. Holds the Gemini
  key pool (`gemini:keys`, a JSON array), the last-working key index
  (`gemini:last_ok_idx`, fix-04), and a once-a-day flag for the Telegram
  command-menu sync. **Loud-failure contract (v3 fix-01):** every KV
  read/parse/write failure in `keypool.js` throws a `KeyPoolError`
  (`KV_MISSING` / `KV_READ_FAILED` / `KV_WRITE_FAILED`) that is surfaced
  verbatim to the operator; every write is read-back-verified before
  success is reported. A broken binding must never again look like
  "zero keys configured".

Worker **secrets** (set via Cloudflare API/dashboard, never in files):
- `TELEGRAM_BOT_TOKEN` — Bot API calls.
- `GITHUB_REPO_TOKEN` — fine-grained PAT scoped to this repo, contents
  read/write. Used only for writes; reads of public raw content need none.
- `WEBHOOK_SECRET` — random token Telegram sends as
  `X-Telegram-Bot-Api-Secret-Token`; the Worker rejects updates without it.
- `GEMINI_API_KEY` — legacy single-key secret. The key pool auto-migrates
  it: when the KV pool is empty and this secret is present, it is promoted
  into the pool as key #1, so pre-fix-03 setups keep working with zero
  manual re-adding. New keys are managed in-chat (Home → Settings → Keys),
  never via the dashboard.

GitHub Actions **secrets**: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`.

---

## 4. Interaction protocol (stateless)

### 4.1 Node handles (`h8`)

Deep paths would overflow Telegram's 64-byte `callback_data`. Every node is
therefore addressed by `h8` = first 8 hex chars of SHA-1 of its full path
(`root` for the top level). Resolution is stateless: fetch the recursive
tree once, hash every node path, pick the match. Collisions are
astronomically unlikely at notebook scale; if one ever occurs the resolver
detects it (two paths with same h8) and falls back to 12 hex chars.

### 4.2 Callback opcodes

`callback_data = "<op>:<h8>"` or `"<op>:<h8>:<arg>"`:

| op | meaning |
|----|---------|
| `h` | home screen (the app's front door, drawn by /start and /menu too) |
| `nt` | new topic: ForceReply name prompt (from Home or Browse root) |
| `an` | add note to a topic: ForceReply prompt (from the browse screen) |
| `e` | edit an entry: ForceReply instruction prompt (from the read view) |
| `s` | settings menu |
| `sk` | settings → Gemini keys screen (masked list + add/remove/clear) |
| `ka` | add keys: ForceReply prompt (newline-separated, many at once) |
| `kr` | remove key by index (tap-only; full keys are never retyped) |
| `kc` | clear all keys (`kc:root` asks, `kc:confirm` executes) |
| `b` | browse node (children as buttons + Read/Export/Delete/Up row) |
| `r` | read node in chat, `<arg>` = page number |
| `x` | export node + descendants as PDF (`x:menu` = the Export chooser) |
| `X` | export entire notebook as PDF |
| `d` | ask delete confirmation (Yes/Cancel) |
| `D` | confirmed delete — executes |
| `c` | cancel / dismiss |
| `v` | view the entry/node just filed |
| `m` | start move flow for just-filed entry |
| `mt` | move-flow: pick target node |
| `n` | re-file just-filed entry as a brand-new top-level topic |

### 4.3 The tappable interface (fix-03)

The bot is operated as an app, not by memorized commands. `/start` and
`/menu` draw the **home screen**; from there every capability — Browse
(the `b` tree), **New topic**, **Add note here** (per topic, on the browse
screen), Read, **Edit** and **Delete** buttons on every entry in the read
view, Export (chooser → whole notebook or a topic), topic Delete
confirmations, and **Settings → Gemini API keys** — is reachable by taps
alone, arbitrarily deep. The only thing that inherently requires sending
content is capture itself. Every screen follows one pattern: a title
line, one button per action, and a trailing Back/Home row. Typed slash
commands remain as an optional fast-path (`/topics`, `/read`, `/export`,
`/delete`, `/new`, `/add`); the Telegram `/` command menu is kept in sync
by `syncCommandMenu` (runs at most once per day, flag in KV). Key
management is tap-only: keys are pasted newline-separated into a
ForceReply prompt (flow `keys`), listed masked (last 4 chars), and removed
by index button — a full key value is never displayed or retyped.

### 4.4 Pending input via ForceReply tokens

Multi-step manual flows (`/new`, `/add`, move-by-rename, …) never need
server state. The bot replies with `ForceReply` and a machine-readable
footer line:

```
#cx:<flow>:<h8>[:<extra>]
```

When the operator's reply arrives, `message.reply_to_message.text` carries
that footer; the Worker parses it and completes the flow. Works across
Worker invocations and cold starts, survives arbitrarily long gaps.

### 4.4 Status messages

Multi-step operations (voice ingestion, auto-filing, export) send one
message and then **edit it in place**:
`⏳ Transcribing…` → `⏳ Filing…` → `✅ Done — filed under …`.
No silent waits, no message spam.

---

## 5. Gemini usage policy (quota-critical)

Gemini is called **only** for:

1. Voice-note transcription + cleanup (audio in, coherent cleaned text out;
   raw verbatim transcripts are never stored).
2. Auto-filing: choosing a destination node (or minting a new topic) for a
   note whose destination wasn't specified, given a compact listing of the
   existing tree.
3. Editing an existing entry/topic from a natural-language request
   (reads the target entry, returns the rewritten entry).
4. Resolving genuinely ambiguous targets (e.g. "delete that note about the
   visa" → identifies entry id).

Everything else — all manual commands, all buttons, and even Gemini-chat
requests whose target is explicit ("export travel as PDF", "read
recipes/pasta", "delete entry … confirmed by id") — is dispatched by
pattern matching first. Gemini's job for explicit requests is a single
minimal classification call returning strict JSON:
`{"action": "…", "path": "…", "entry_id": "…"}`; the deterministic
function then executes. Gemini never re-reads, re-renders or re-processes
stored content outside cases 1–4. Manual paths contain **no Gemini code at
all** — the import graph keeps `gemini.js` out of the command path.

### 5.1 Model & key rotation (fix-04)

- **Model:** `gemini-flash-lite-latest` (the cheapest current model) for
  every call, text and audio. Configurable via the `GEMINI_MODEL` var.
- **Key pool:** every call runs against the KV key pool (§3), starting
  from the last-successful key index (`gemini:last_ok_idx`) so the bot
  settles onto a working key instead of re-discovering dead ones on every
  request. On success the new index is persisted.
- **Rotation triggers (key-specific only):** HTTP 429 (quota/rate
  exhaustion), 403 with `PERMISSION_DENIED`/quota in the body, 400 with
  `API_KEY_INVALID`/`API key not valid`, 401. The same request is retried
  verbatim with the next key, walking the whole pool in order.
- **Non-triggers:** 5xx responses are service-side — retried once on the
  SAME key, then surfaced; other 4xx (e.g. malformed request) fail
  immediately without burning the pool. Only when EVERY key fails does the
  operator see a specific failure message pointing at Settings → Keys.

---

## 6. PDF rendering

`pdf.js` + `pdf-lib` (pure JS, Worker-safe). Mechanical rules:

- Title page: "Codex — <node title or 'Notebook'>", export date.
- Each node renders its `# Title` as a heading sized by depth, then its
  entries: date line in small italic gray, body text word-wrapped
  (Markdown markers rendered as plain emphasis — headers/bold/italic/
  bullets), each `![…](assets/…)` image fetched and embedded inline at the
  exact position it appears in the entry (max width = page width, aspect
  preserved), then children recursively (depth-first).
- Font: DejaVuSans.ttf embedded via wrangler `Data` import rule, covering
  Latin/Greek/Cyrillic. (CJK/emoji fall back to `?`-replacement — known
  limitation, documented in README.)
- Output is sent to Telegram as a document named
  `codex-<slug or "full">-<yyyymmdd>.pdf`.

---

## 7. Deploy & verify flow

1. Push to `main` → GitHub Actions → `wrangler deploy` → Worker live at
   `https://<worker>.<subdomain>.workers.dev`.
2. `POST /setWebhook` (done once, by build tooling via Bot API) points the
   bot at the Worker with `WEBHOOK_SECRET`; `getWebhookInfo` confirms.
3. Live smoke test without a real user: synthetic signed webhook POSTs to
   the Worker URL exercise command handlers; the Worker logs actions.
   Final human-path confirmation happens when the operator sends their
   first real message (README covers it).
