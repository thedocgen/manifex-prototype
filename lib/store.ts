// Supabase-backed store for Manifex.
// Same interface as the previous in-memory version, but persists across server restarts.

import { createClient, SupabaseClient } from '@supabase/supabase-js';
import type { ManifexProject, ManifexSession, ManifestState } from './types';
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

export const STARTER_MANIFEST = `# My App

## Overview
A simple web application built with Manifex.

## Pages
- Home page with a welcome message

## Styles
- Clean, modern design with system fonts
- Light background, dark text
`;

export function makeManifestState(content: string): ManifestState {
  return {
    content,
    sha: sha256(content),
  };
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

function rowToSession(row: any): ManifexSession {
  return {
    id: row.id,
    project_id: row.project_id,
    user_id: row.user_id,
    base_commit_sha: row.base_commit_sha,
    manifest_state: row.manifest_state,
    history: row.history || [],
    redo_stack: row.redo_stack || [],
    pending_attempt: row.pending_attempt,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}
