-- Phase 2 of team collaboration: presence heartbeats.
-- Poll-based for v1 (Supabase realtime channels are a v2 upgrade).
-- Each row is a (session_id, user_id) pair updated on every heartbeat.

CREATE TABLE IF NOT EXISTS manifex_presence (
  session_id    UUID NOT NULL REFERENCES manifex_sessions(id) ON DELETE CASCADE,
  user_id       TEXT NOT NULL,
  display_name  TEXT,
  page_path     TEXT,
  last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (session_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_manifex_presence_session
  ON manifex_presence(session_id, last_seen_at DESC);
