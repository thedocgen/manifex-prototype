-- Phase 1 of team collaboration: additive only.
-- Adds team tables, makes manifex_projects.team_id available, and
-- ensures every existing project has a backing team. Solo users see
-- no behavior change because LOCAL_DEV_TEAM auto-claims their work.

-- ── Tables ────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS manifex_teams (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,
  created_by  TEXT NOT NULL,                          -- user id (text, mirrors manifex_projects.user_id)
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS manifex_team_members (
  team_id    UUID NOT NULL REFERENCES manifex_teams(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL,
  role       TEXT NOT NULL CHECK (role IN ('owner', 'editor', 'viewer')),
  joined_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (team_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_manifex_team_members_user ON manifex_team_members(user_id);

-- ── Project linkage ───────────────────────────────────────────────
-- team_id is nullable for backward compatibility; the store layer
-- treats NULL as "owned by the user's personal team".

ALTER TABLE manifex_projects
  ADD COLUMN IF NOT EXISTS team_id UUID REFERENCES manifex_teams(id);

CREATE INDEX IF NOT EXISTS idx_manifex_projects_team ON manifex_projects(team_id, created_at DESC);

-- ── Backfill: create LOCAL_DEV_TEAM and adopt orphaned projects ───
-- Idempotent — uses a deterministic UUID derived from a fixed
-- namespace so re-running the migration is safe.

INSERT INTO manifex_teams (id, name, created_by)
SELECT '00000000-0000-0000-0000-000000000001'::uuid, 'Personal (local dev)', 'local-dev-user'
WHERE NOT EXISTS (
  SELECT 1 FROM manifex_teams WHERE id = '00000000-0000-0000-0000-000000000001'::uuid
);

INSERT INTO manifex_team_members (team_id, user_id, role)
SELECT '00000000-0000-0000-0000-000000000001'::uuid, 'local-dev-user', 'owner'
WHERE NOT EXISTS (
  SELECT 1 FROM manifex_team_members
  WHERE team_id = '00000000-0000-0000-0000-000000000001'::uuid
    AND user_id = 'local-dev-user'
);

-- Adopt all existing projects without a team into LOCAL_DEV_TEAM.
-- (In production this would create a personal team per distinct user.)
UPDATE manifex_projects
SET team_id = '00000000-0000-0000-0000-000000000001'::uuid
WHERE team_id IS NULL
  AND user_id = 'local-dev-user';
