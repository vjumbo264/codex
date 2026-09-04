-- Codex — initial schema (D1), following the Compass reference pattern
-- (migrations/0001_initial.sql: IF NOT EXISTS everywhere, idempotent,
-- timestamps as ISO-8601 UTC TEXT, booleans as 0/1 INTEGERs).
--
-- Replaces the CODEX_KV namespace. Inventory (worker/src/keypool.js +
-- worker/src/telegram.js before this migration):
--   gemini:keys        JSON array of Gemini API key strings  -> api_keys
--   gemini:last_ok_idx last pool index that succeeded        -> key_pool_state
--   gemini:migrated    legacy GEMINI_API_KEY promotion flag  -> key_pool_state
--   sys:cmd_synced     last /menu command-sync date          -> sys_state
--
-- api_keys is ADAPTED (not copied) from Compass's api_keys table
-- (daily_quota / used_today / last_reset_date / is_active /
-- consecutive_errors / last_error_message / last_used_at) against what
-- keypool.js actually tracks: Codex's rotation starts from the last key
-- that SUCCEEDED and rotates on key-specific failures, so each row
-- carries position (pool order, shown 1-based in Settings) plus the
-- health fields; the Compass daily-quota columns are kept for future
-- quota accounting. Nothing GitHub- or PDF-related is stored in KV/D1 —
-- the notebook lives in the GitHub repo (github.js), so no extra tables
-- are needed for it.

-- ---------------------------------------------------------------
-- api_keys — Gemini key pool (rotation starts from last success)
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS api_keys (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  key_value           TEXT    NOT NULL UNIQUE,
  position            INTEGER NOT NULL,          -- pool order (Settings list order)
  daily_quota         INTEGER NOT NULL DEFAULT 1500,
  used_today          INTEGER NOT NULL DEFAULT 0,
  last_reset_date     TEXT    NOT NULL DEFAULT (date('now')),
  is_active           INTEGER NOT NULL DEFAULT 1,
  consecutive_errors  INTEGER NOT NULL DEFAULT 0,
  last_error_message  TEXT,
  last_used_at        TEXT,
  created_at          TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_api_keys_active_lru
  ON api_keys (is_active, last_used_at);

-- ---------------------------------------------------------------
-- key_pool_state — cross-request rotation state (single rows)
--   'last_ok_idx'  INTEGER string: pool index that last succeeded
--   'migrated'     '1' once the legacy GEMINI_API_KEY secret has been
--                  promoted into api_keys (or deliberately cleared)
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS key_pool_state (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- ---------------------------------------------------------------
-- sys_state — tiny system flags (replaces misc KV keys)
--   'cmd_synced'  ISO date (YYYY-MM-DD) of the last setMyCommands sync
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sys_state (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
