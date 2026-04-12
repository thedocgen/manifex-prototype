-- Manifex prototype tables in public schema
-- Run against the DocGen Supabase project pooler (port 5432 for DDL)

CREATE TABLE IF NOT EXISTS manifex_projects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  github_repo TEXT NOT NULL,
  default_branch TEXT NOT NULL DEFAULT 'main',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_manifex_projects_user ON manifex_projects(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS manifex_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES manifex_projects(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  base_commit_sha TEXT NOT NULL,
  manifest_state JSONB NOT NULL,
  history JSONB NOT NULL DEFAULT '[]'::jsonb,
  redo_stack JSONB NOT NULL DEFAULT '[]'::jsonb,
  pending_attempt JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_manifex_sessions_project ON manifex_sessions(project_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_manifex_sessions_user ON manifex_sessions(user_id, updated_at DESC);

-- R4: Secrets vault for API keys and credentials
CREATE TABLE IF NOT EXISTS manifex_secrets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(project_id, key)
);

CREATE INDEX IF NOT EXISTS idx_manifex_secrets_project ON manifex_secrets(project_id);

-- R4: Add conversation column to sessions (for existing DBs, run: ALTER TABLE manifex_sessions ADD COLUMN IF NOT EXISTS conversation JSONB DEFAULT '[]'::jsonb)

CREATE TABLE IF NOT EXISTS manifex_compilations (
  manifest_sha TEXT NOT NULL,
  compiler_version TEXT NOT NULL,
  codex_files JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (manifest_sha, compiler_version)
);
