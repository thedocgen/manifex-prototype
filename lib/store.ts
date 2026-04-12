// Supabase-backed store for Manifex.

import { createClient, SupabaseClient } from '@supabase/supabase-js';
import type { ManifexProject, ManifexSession, ManifestState, DocPage, TreeNode, CompiledCodex } from './types';
import { migrateManifestState } from './types';
import { sha256 } from './crypto';

const SUPABASE_URL = process.env.SUPABASE_PROJECT_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || '';

let _client: SupabaseClient | null = null;
function client(): SupabaseClient {
  if (!_client) {
    if (!SUPABASE_URL || !SUPABASE_KEY) {
      throw new Error('SUPABASE_PROJECT_URL and SUPABASE_SERVICE_KEY must be set');
    }
    _client = createClient(SUPABASE_URL, SUPABASE_KEY, {
      auth: { persistSession: false },
    });
  }
  return _client;
}

// ── Starter content ──

export const STARTER_PAGES: { [path: string]: DocPage } = {
  overview: {
    title: 'Overview',
    content: `# New Project

Describe your app idea below. Manifex will work with you to plan the documentation structure, then generate thorough technical docs covering architecture, pages, data models, and visual design. Once the documentation is complete, build your app with one click.

## What to include in your description

- **Who uses it** — the target audience or user roles
- **What it does** — the core functionality and purpose
- **Key features** — the main capabilities you need
- **Design preferences** — any style, layout, or branding direction`,
  },
};

export const STARTER_TREE: TreeNode[] = [
  { path: 'overview', title: 'Overview' },
];

export function makeManifestState(pages: { [path: string]: DocPage }, tree: TreeNode[]): ManifestState {
  return {
    pages,
    tree,
    sha: sha256(JSON.stringify(pages)),
  };
}

export function makeStarterManifest(): ManifestState {
  return makeManifestState(STARTER_PAGES, STARTER_TREE);
}

// ────────────────────────────────────────────────────────────
// Projects
// ────────────────────────────────────────────────────────────

export async function listProjects(userId: string): Promise<ManifexProject[]> {
  const { data, error } = await client()
    .from('manifex_projects')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false });
  if (error) throw new Error(`listProjects: ${error.message}`);
  return (data || []).map(rowToProject);
}

export async function getProject(id: string): Promise<ManifexProject | null> {
  const { data, error } = await client()
    .from('manifex_projects')
    .select('*')
    .eq('id', id)
    .maybeSingle();
  if (error) throw new Error(`getProject: ${error.message}`);
  return data ? rowToProject(data) : null;
}

export async function createProject(input: {
  user_id: string;
  name: string;
  github_repo: string;
}): Promise<ManifexProject> {
  const { data, error } = await client()
    .from('manifex_projects')
    .insert({
      user_id: input.user_id,
      name: input.name,
      github_repo: input.github_repo,
      default_branch: 'main',
    })
    .select('*')
    .single();
  if (error) throw new Error(`createProject: ${error.message}`);
  return rowToProject(data);
}

function rowToProject(row: any): ManifexProject {
  return {
    id: row.id,
    user_id: row.user_id,
    name: row.name,
    github_repo: row.github_repo,
    github_repo_id: null,
    default_branch: row.default_branch || 'main',
    created_at: row.created_at,
  };
}

// ────────────────────────────────────────────────────────────
// Sessions
// ────────────────────────────────────────────────────────────

export async function getSession(id: string): Promise<ManifexSession | null> {
  const { data, error } = await client()
    .from('manifex_sessions')
    .select('*')
    .eq('id', id)
    .maybeSingle();
  if (error) throw new Error(`getSession: ${error.message}`);
  return data ? rowToSession(data) : null;
}

export async function createSession(input: {
  project_id: string;
  user_id: string;
  base_commit_sha: string;
  manifest_state: ManifestState;
}): Promise<ManifexSession> {
  const { data, error } = await client()
    .from('manifex_sessions')
    .insert({
      project_id: input.project_id,
      user_id: input.user_id,
      base_commit_sha: input.base_commit_sha,
      manifest_state: input.manifest_state,
      history: [],
      redo_stack: [],
      pending_attempt: null,
    })
    .select('*')
    .single();
  if (error) throw new Error(`createSession: ${error.message}`);
  return rowToSession(data);
}

export async function updateSession(id: string, patch: Partial<ManifexSession>): Promise<ManifexSession> {
  const update: any = { updated_at: new Date().toISOString() };
  if ('manifest_state' in patch) update.manifest_state = patch.manifest_state;
  if ('history' in patch) update.history = patch.history;
  if ('redo_stack' in patch) update.redo_stack = patch.redo_stack;
  if ('pending_attempt' in patch) update.pending_attempt = patch.pending_attempt;

  const { data, error } = await client()
    .from('manifex_sessions')
    .update(update)
    .eq('id', id)
    .select('*')
    .single();
  if (error) throw new Error(`updateSession: ${error.message}`);
  return rowToSession(data);
}

// ────────────────────────────────────────────────────────────
// Compilation cache
// ────────────────────────────────────────────────────────────

export async function getCachedCompilation(
  manifestSha: string,
  compilerVersion: string
): Promise<CompiledCodex | null> {
  const { data, error } = await client()
    .from('manifex_compilations')
    .select('codex_files, manifest_sha')
    .eq('manifest_sha', manifestSha)
    .eq('compiler_version', compilerVersion)
    .maybeSingle();
  if (error) {
    console.warn('getCachedCompilation error:', error.message);
    return null;
  }
  if (!data) return null;
  return {
    files: data.codex_files,
    codex_sha: manifestSha,
    compiler_version: compilerVersion,
  };
}

export async function putCachedCompilation(
  manifestSha: string,
  compilerVersion: string,
  compiled: CompiledCodex
): Promise<void> {
  const { error } = await client()
    .from('manifex_compilations')
    .upsert({
      manifest_sha: manifestSha,
      compiler_version: compilerVersion,
      codex_files: compiled.files,
    });
  if (error) {
    console.warn('putCachedCompilation error:', error.message);
  }
}

// ────────────────────────────────────────────────────────────
// Secrets
// ────────────────────────────────────────────────────────────

export async function getSecrets(projectId: string): Promise<{ [key: string]: string }> {
  try {
    const { data, error } = await client()
      .from('manifex_secrets')
      .select('key, value')
      .eq('project_id', projectId);
    if (error) {
      // Table might not exist yet — return empty
      return {};
    }
    const result: { [key: string]: string } = {};
    for (const row of (data || [])) {
      result[row.key] = row.value;
    }
    return result;
  } catch {
    return {};
  }
}

// ────────────────────────────────────────────────────────────
// Row mappers (with migration)
// ────────────────────────────────────────────────────────────

function rowToSession(row: any): ManifexSession {
  const manifestState = migrateManifestState(row.manifest_state);
  const history = (row.history || []).map(migrateManifestState);
  const redo_stack = (row.redo_stack || []).map(migrateManifestState);

  let pending_attempt = row.pending_attempt;
  if (pending_attempt && pending_attempt.proposed_manifest) {
    pending_attempt = {
      ...pending_attempt,
      proposed_manifest: migrateManifestState(pending_attempt.proposed_manifest),
    };
  }

  return {
    id: row.id,
    project_id: row.project_id,
    user_id: row.user_id,
    base_commit_sha: row.base_commit_sha,
    manifest_state: manifestState,
    history,
    redo_stack,
    pending_attempt,
    conversation: row.conversation || [],
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}
