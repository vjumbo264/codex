# Deployment — root cause, mechanism, verification (v4 round, 2026-09-04)

## Root cause of "fixes on main but nothing changes on the live bot"

There was **no broken pipeline**. The v4 session proved the whole chain
works end-to-end in ~7 minutes:

- `git push` → GitHub Actions `Deploy Worker` run (33829562667, commit
  a60afc8, success 2026-09-04T02:27:03Z) → new Cloudflare deployment
  (created 2026-09-04T02:34Z) → live GET https://codex-bot.vjumbo264.workers.dev/
  returning the pushed marker `codex-bot ok · probe-v4-0904a`.

The earlier "nothing changed" report was a **verification artifact**, not a
deploy failure:

1. The fixes from the previous round (loud KV failures, tap-only UI) mostly
   live in **POST-authorized Telegram flows** — inline-keyboard buttons and
   ForceReply prompts. None of them are visible from a bare GET, and the
   Cloudflare `scripts/content` download endpoint does not accept this
   account's API-token auth (`error 10405`), so no session could read the
   deployed source back. Every "not deployed" conclusion came from that
   blind spot.
2. The public GET reply `codex-bot ok` never contained a build marker, so
   the operator had no way to tell which build was answering.
3. Workers Builds (GitHub → Cloudflare direct integration) is **not** in
   use for this Worker: every deployment in the Cloudflare deployments API
   has `source: wrangler`, matching the GitHub Actions + wrangler-action
   path in `.github/workflows/deploy.yml`. Each push to `main` touching
   `worker/**` deploys (run history 2026-09-03/04 confirms one successful
   run per push).

## How a deploy actually happens (permanent record)

- Push to `main` touching `worker/**` or the workflow file triggers
  `.github/workflows/deploy.yml` (or `workflow_dispatch`).
- The workflow runs `scripts/predeploy.mjs` (idempotently provisions the
  CODEX_KV namespace and stamps its id into `wrangler.toml`) then
  `cloudflare/wrangler-action@v3` `deploy`.
- Secrets used: repo secrets CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID.
  Worker-side secrets (TELEGRAM_BOT_TOKEN, GITHUB_REPO_TOKEN,
  WEBHOOK_SECRET, GEMINI_API_KEY) live in Cloudflare, not in the repo.
- Telegram webhook → `https://codex-bot.vjumbo264.workers.dev/`
  (verified via getWebhookInfo 2026-09-04, pending_update_count 0).
- The webhook POST path is guarded by WEBHOOK_SECRET; unauthenticated GET
  returns the ok+marker string, which is the canonical liveness/build probe.

## How to verify a deploy from now on (no dashboard, no guessing)

1. Push with a one-word change to the GET marker in `worker/src/index.js`
   when you need positive proof (temporary, then revert).
2. Poll `GET https://codex-bot.vjumbo264.workers.dev/` until the marker
   appears — this is the same front door the Telegram webhook uses, so it
   proves the operator's chat is served by the new build.
3. Cross-check `GET /accounts/<acct>/workers/scripts/codex-bot/deployments`
   for a deployment timestamped after the push, and the Actions run list
   for the matching SHA.

## Known KV data note

`gemini:keys` in CODEX_KV (namespace f1ad0d7e42c3456c8f3f241c61a7b3d8)
holds 7 entries; one has length 106 (two keys pasted on one line by the
operator — a paste artifact, harmless to rotation, removable via
Settings → Keys → Remove).
