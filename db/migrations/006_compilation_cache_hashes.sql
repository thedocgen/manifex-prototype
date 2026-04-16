-- A2: composite cache key for manifex_compilations.
-- Adds two nullable TEXT columns for seeded-codex and prompt-version hashes.
-- Old rows (NULL hashes) always miss on the extended cache probe, triggering
-- a one-time recompile that populates the hashes. No data migration needed.

ALTER TABLE manifex_compilations
  ADD COLUMN IF NOT EXISTS seeded_codex_hash TEXT,
  ADD COLUMN IF NOT EXISTS prompt_version_hash TEXT;

-- Index on the composite cache key for fast lookups.
-- The primary key (manifest_sha, compiler_version) already covers the first
-- two components; this index covers the full 4-field probe.
CREATE INDEX IF NOT EXISTS idx_compilations_cache_key
  ON manifex_compilations (manifest_sha, compiler_version, seeded_codex_hash, prompt_version_hash);
