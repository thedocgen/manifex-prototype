-- Phase 2 of team collaboration: pending attempts as docs-as-PRs.
-- Multiple proposals can be open on the same session at once, each
-- authored by a different team member. Anyone with editor role can
-- accept or reject. The author can withdraw their own.

CREATE TABLE IF NOT EXISTS manifex_pending_attempts (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id        UUID NOT NULL REFERENCES manifex_sessions(id) ON DELETE CASCADE,
  author_id         TEXT NOT NULL,
  base_sha          TEXT NOT NULL,                     -- the manifest sha this proposal was built against
  prompt            TEXT NOT NULL,
  proposed_manifest JSONB NOT NULL,
  diff_summary      TEXT,
  changed_pages     TEXT[],
  status            TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'accepted', 'rejected', 'withdrawn')),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_by       TEXT,
  resolved_at       TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_manifex_pending_attempts_session_open
  ON manifex_pending_attempts(session_id, created_at DESC)
  WHERE status = 'open';

CREATE INDEX IF NOT EXISTS idx_manifex_pending_attempts_session
  ON manifex_pending_attempts(session_id, created_at DESC);

-- Per-section comments on a proposal (PR-review style).

CREATE TABLE IF NOT EXISTS manifex_proposal_comments (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  proposal_id  UUID NOT NULL REFERENCES manifex_pending_attempts(id) ON DELETE CASCADE,
  author_id    TEXT NOT NULL,
  body         TEXT NOT NULL,
  page_path    TEXT,                                   -- optional: scope to a doc page
  section_slug TEXT,                                   -- optional: scope to a section heading slug
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_manifex_proposal_comments_proposal
  ON manifex_proposal_comments(proposal_id, created_at);
