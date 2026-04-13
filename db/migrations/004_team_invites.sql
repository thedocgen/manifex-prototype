-- Phase 2 of team collaboration: invite links with tokens.
-- An invite is a shareable token that, when redeemed, creates a
-- manifex_team_members row for the redeeming user. Single-use vs
-- multi-use is encoded as max_uses (1 = single, NULL = unlimited).

CREATE TABLE IF NOT EXISTS manifex_team_invites (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id       UUID NOT NULL REFERENCES manifex_teams(id) ON DELETE CASCADE,
  token         TEXT NOT NULL UNIQUE,
  role_on_join  TEXT NOT NULL DEFAULT 'editor' CHECK (role_on_join IN ('owner', 'editor', 'viewer')),
  created_by    TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at    TIMESTAMPTZ,
  max_uses      INTEGER,                                 -- NULL = unlimited
  uses          INTEGER NOT NULL DEFAULT 0,
  revoked_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_manifex_team_invites_team
  ON manifex_team_invites(team_id, created_at DESC);
