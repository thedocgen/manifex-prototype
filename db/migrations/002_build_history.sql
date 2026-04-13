-- Phase 2 of team collaboration: persisted team build history.
-- A team-scoped narrative of who did what to a session — accept events,
-- undo events, retries, etc. The client will read this back on session
-- load to render a per-team "this is how we built it" timeline.

CREATE TABLE IF NOT EXISTS manifex_build_history (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id   UUID NOT NULL REFERENCES manifex_sessions(id) ON DELETE CASCADE,
  team_id      UUID REFERENCES manifex_teams(id),  -- nullable until projects fully migrated
  author_id    TEXT NOT NULL,                       -- user id (text, mirrors manifex_projects.user_id)
  action       TEXT NOT NULL CHECK (action IN ('accept', 'undo', 'redo', 'forget', 'retry')),
  prompt       TEXT,                                -- the prompt that produced the change, when applicable
  diff_summary TEXT,
  changed_pages TEXT[],
  sha_before   TEXT,                                -- manifest sha before the action
  sha_after    TEXT,                                -- manifest sha after the action
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_manifex_build_history_session
  ON manifex_build_history(session_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_manifex_build_history_team
  ON manifex_build_history(team_id, created_at DESC);
