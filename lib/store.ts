// Supabase-backed store for Manifex.

import { createClient, SupabaseClient } from '@supabase/supabase-js';
import type { ManifexProject, ManifexSession, ManifestState, DocPage, TreeNode, CompiledCodex, ManifexTeam, ManifexTeamMember, TeamRole, BuildHistoryEntry, BuildHistoryAction, PendingProposal, ProposalStatus, ProposalComment, TeamInvite, PresenceEntry } from './types';
import { randomBytes } from 'crypto';
import { LOCAL_DEV_TEAM, LOCAL_DEV_USER, migrateManifestState } from './types';
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
  // List by team membership when the schema supports it; fall back to
  // user_id-only filter for pre-migration databases.
  const teamIds = await listTeamIdsForUser(userId);
  if (teamIds.length > 0) {
    const { data, error } = await client()
      .from('manifex_projects')
      .select('*')
      .or(`team_id.in.(${teamIds.join(',')}),user_id.eq.${userId}`)
      .order('created_at', { ascending: false });
    if (!error) return (data || []).map(rowToProject);
    // If the team_id column doesn't exist yet, fall through to the legacy path.
    if (!/team_id/.test(error.message)) throw new Error(`listProjects: ${error.message}`);
  }
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
  team_id?: string;
}): Promise<ManifexProject> {
  // Resolve the team: explicit > user's personal team > none (pre-migration DB).
  const teamId = input.team_id || (await ensurePersonalTeam(input.user_id));
  const baseRow: any = {
    user_id: input.user_id,
    name: input.name,
    github_repo: input.github_repo,
    default_branch: 'main',
  };
  if (teamId) baseRow.team_id = teamId;

  let { data, error } = await client()
    .from('manifex_projects')
    .insert(baseRow)
    .select('*')
    .single();
  // Pre-migration fallback: retry without team_id if the column doesn't exist.
  if (error && /team_id/.test(error.message)) {
    delete baseRow.team_id;
    ({ data, error } = await client()
      .from('manifex_projects')
      .insert(baseRow)
      .select('*')
      .single());
  }
  if (error) throw new Error(`createProject: ${error.message}`);
  return rowToProject(data);
}

function rowToProject(row: any): ManifexProject {
  return {
    id: row.id,
    user_id: row.user_id,
    team_id: row.team_id ?? null,
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
    conversation: row.manifest_state?.conversation || row.conversation || [],
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

// ────────────────────────────────────────────────────────────
// Teams (Phase 1)
// ────────────────────────────────────────────────────────────
//
// All helpers are designed to no-op gracefully when the team tables
// haven't been migrated yet — solo users on a pre-Phase-1 database see
// exactly the same behavior they did before this commit.

function teamsTableMissing(err: { message?: string; code?: string } | null | undefined): boolean {
  if (!err) return false;
  if (err.code === '42P01' || err.code === 'PGRST205') return true;
  const m = err.message || '';
  return (
    /relation\s+"?manifex_teams"?/i.test(m) ||
    /relation\s+"?manifex_team_members"?/i.test(m) ||
    /Could not find the table\s+'public\.manifex_teams'/i.test(m) ||
    /Could not find the table\s+'public\.manifex_team_members'/i.test(m) ||
    /schema cache/i.test(m) && /manifex_team/i.test(m) ||
    /does not exist/i.test(m) && /manifex_team/i.test(m)
  );
}

function rowToTeam(row: any): ManifexTeam {
  return {
    id: row.id,
    name: row.name,
    created_by: row.created_by,
    created_at: row.created_at,
  };
}

function rowToTeamMember(row: any): ManifexTeamMember {
  return {
    team_id: row.team_id,
    user_id: row.user_id,
    role: (row.role as TeamRole) || 'editor',
    joined_at: row.joined_at,
  };
}

export async function getTeam(teamId: string): Promise<ManifexTeam | null> {
  const { data, error } = await client()
    .from('manifex_teams')
    .select('*')
    .eq('id', teamId)
    .maybeSingle();
  if (error) {
    if (teamsTableMissing(error)) return null;
    throw new Error(`getTeam: ${error.message}`);
  }
  return data ? rowToTeam(data) : null;
}

export async function listTeamMembers(teamId: string): Promise<ManifexTeamMember[]> {
  const { data, error } = await client()
    .from('manifex_team_members')
    .select('*')
    .eq('team_id', teamId);
  if (error) {
    if (teamsTableMissing(error)) return [];
    throw new Error(`listTeamMembers: ${error.message}`);
  }
  return (data || []).map(rowToTeamMember);
}

export async function listTeamIdsForUser(userId: string): Promise<string[]> {
  const { data, error } = await client()
    .from('manifex_team_members')
    .select('team_id')
    .eq('user_id', userId);
  if (error) {
    if (teamsTableMissing(error)) return [];
    throw new Error(`listTeamIdsForUser: ${error.message}`);
  }
  return (data || []).map((r: any) => r.team_id);
}

/**
 * Resolve the user's "personal team", creating it on first run.
 * For LOCAL_DEV_USER this is the deterministic LOCAL_DEV_TEAM so the SQL
 * backfill aligns with what the application creates at runtime. Returns
 * null when the team tables don't exist yet — the caller falls back to
 * the legacy user_id-only project model.
 */
export async function ensurePersonalTeam(userId: string): Promise<string | null> {
  // Solo dev shortcut: always claim LOCAL_DEV_TEAM.
  if (userId === LOCAL_DEV_USER.id) {
    const existing = await getTeam(LOCAL_DEV_TEAM.id);
    if (existing) {
      // Make sure the membership row exists too (idempotent).
      await client()
        .from('manifex_team_members')
        .upsert({ team_id: LOCAL_DEV_TEAM.id, user_id: userId, role: 'owner' }, { onConflict: 'team_id,user_id' })
        .then(() => undefined, () => undefined);
      return LOCAL_DEV_TEAM.id;
    }
    // Try to create it.
    const { error: insertErr } = await client()
      .from('manifex_teams')
      .insert({ id: LOCAL_DEV_TEAM.id, name: LOCAL_DEV_TEAM.name, created_by: userId });
    if (insertErr) {
      if (teamsTableMissing(insertErr)) return null;
      // Race: another caller created it first. Treat as success.
    }
    await client()
      .from('manifex_team_members')
      .upsert({ team_id: LOCAL_DEV_TEAM.id, user_id: userId, role: 'owner' }, { onConflict: 'team_id,user_id' })
      .then(() => undefined, () => undefined);
    return LOCAL_DEV_TEAM.id;
  }

  // Non-local user: look for any existing team owned by them, or create one.
  const ids = await listTeamIdsForUser(userId);
  if (ids.length > 0) return ids[0];

  const { data, error } = await client()
    .from('manifex_teams')
    .insert({ name: 'Personal', created_by: userId })
    .select('*')
    .single();
  if (error) {
    if (teamsTableMissing(error)) return null;
    throw new Error(`ensurePersonalTeam: ${error.message}`);
  }
  await client()
    .from('manifex_team_members')
    .insert({ team_id: data.id, user_id: userId, role: 'owner' })
    .then(() => undefined, () => undefined);
  return data.id;
}

// ────────────────────────────────────────────────────────────
// Build history (Phase 2)
// ────────────────────────────────────────────────────────────

function historyTableMissing(err: { message?: string; code?: string } | null | undefined): boolean {
  if (!err) return false;
  if (err.code === '42P01' || err.code === 'PGRST205') return true;
  const m = err.message || '';
  return (
    /manifex_build_history/i.test(m) && /(does not exist|schema cache|Could not find)/i.test(m)
  );
}

function rowToHistoryEntry(row: any): BuildHistoryEntry {
  return {
    id: row.id,
    session_id: row.session_id,
    team_id: row.team_id ?? null,
    author_id: row.author_id,
    action: row.action,
    prompt: row.prompt ?? null,
    diff_summary: row.diff_summary ?? null,
    changed_pages: row.changed_pages ?? null,
    sha_before: row.sha_before ?? null,
    sha_after: row.sha_after ?? null,
    created_at: row.created_at,
  };
}

export async function appendBuildHistory(input: {
  session_id: string;
  team_id?: string | null;
  author_id: string;
  action: BuildHistoryAction;
  prompt?: string | null;
  diff_summary?: string | null;
  changed_pages?: string[] | null;
  sha_before?: string | null;
  sha_after?: string | null;
}): Promise<BuildHistoryEntry | null> {
  const row = {
    session_id: input.session_id,
    team_id: input.team_id ?? null,
    author_id: input.author_id,
    action: input.action,
    prompt: input.prompt ?? null,
    diff_summary: input.diff_summary ?? null,
    changed_pages: input.changed_pages ?? null,
    sha_before: input.sha_before ?? null,
    sha_after: input.sha_after ?? null,
  };
  const { data, error } = await client()
    .from('manifex_build_history')
    .insert(row)
    .select('*')
    .single();
  if (error) {
    if (historyTableMissing(error)) return null;
    // Don't break the calling endpoint over a history-write failure — log and continue.
    console.warn('appendBuildHistory failed:', error.message);
    return null;
  }
  return rowToHistoryEntry(data);
}

export async function listBuildHistory(sessionId: string, limit = 50): Promise<BuildHistoryEntry[]> {
  const { data, error } = await client()
    .from('manifex_build_history')
    .select('*')
    .eq('session_id', sessionId)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) {
    if (historyTableMissing(error)) return [];
    console.warn('listBuildHistory failed:', error.message);
    return [];
  }
  return (data || []).map(rowToHistoryEntry);
}

// ────────────────────────────────────────────────────────────
// Pending proposals (Phase 2 — docs-as-PRs)
// ────────────────────────────────────────────────────────────

function proposalsTableMissing(err: { message?: string; code?: string } | null | undefined): boolean {
  if (!err) return false;
  if (err.code === '42P01' || err.code === 'PGRST205') return true;
  const m = err.message || '';
  return /manifex_pending_attempts/i.test(m) && /(does not exist|schema cache|Could not find)/i.test(m);
}

function rowToProposal(row: any): PendingProposal {
  const proposed = migrateManifestState(row.proposed_manifest);
  return {
    id: row.id,
    session_id: row.session_id,
    author_id: row.author_id,
    base_sha: row.base_sha,
    prompt: row.prompt,
    proposed_manifest: proposed,
    diff_summary: row.diff_summary ?? null,
    changed_pages: row.changed_pages ?? null,
    status: (row.status as ProposalStatus) || 'open',
    created_at: row.created_at,
    resolved_by: row.resolved_by ?? null,
    resolved_at: row.resolved_at ?? null,
  };
}

export async function createProposal(input: {
  session_id: string;
  author_id: string;
  base_sha: string;
  prompt: string;
  proposed_manifest: ManifestState;
  diff_summary?: string | null;
  changed_pages?: string[] | null;
}): Promise<PendingProposal | null> {
  const row = {
    session_id: input.session_id,
    author_id: input.author_id,
    base_sha: input.base_sha,
    prompt: input.prompt,
    proposed_manifest: input.proposed_manifest,
    diff_summary: input.diff_summary ?? null,
    changed_pages: input.changed_pages ?? null,
    status: 'open' as const,
  };
  const { data, error } = await client()
    .from('manifex_pending_attempts')
    .insert(row)
    .select('*')
    .single();
  if (error) {
    if (proposalsTableMissing(error)) return null;
    throw new Error(`createProposal: ${error.message}`);
  }
  return rowToProposal(data);
}

export async function listOpenProposals(sessionId: string): Promise<PendingProposal[]> {
  const { data, error } = await client()
    .from('manifex_pending_attempts')
    .select('*')
    .eq('session_id', sessionId)
    .eq('status', 'open')
    .order('created_at', { ascending: false });
  if (error) {
    if (proposalsTableMissing(error)) return [];
    console.warn('listOpenProposals failed:', error.message);
    return [];
  }
  return (data || []).map(rowToProposal);
}

export async function getProposal(id: string): Promise<PendingProposal | null> {
  const { data, error } = await client()
    .from('manifex_pending_attempts')
    .select('*')
    .eq('id', id)
    .maybeSingle();
  if (error) {
    if (proposalsTableMissing(error)) return null;
    throw new Error(`getProposal: ${error.message}`);
  }
  return data ? rowToProposal(data) : null;
}

export async function resolveProposal(id: string, status: Exclude<ProposalStatus, 'open'>, resolverId: string): Promise<PendingProposal | null> {
  const { data, error } = await client()
    .from('manifex_pending_attempts')
    .update({ status, resolved_by: resolverId, resolved_at: new Date().toISOString() })
    .eq('id', id)
    .eq('status', 'open')
    .select('*')
    .single();
  if (error) {
    if (proposalsTableMissing(error)) return null;
    throw new Error(`resolveProposal: ${error.message}`);
  }
  return data ? rowToProposal(data) : null;
}

export async function listProposalComments(proposalId: string): Promise<ProposalComment[]> {
  const { data, error } = await client()
    .from('manifex_proposal_comments')
    .select('*')
    .eq('proposal_id', proposalId)
    .order('created_at', { ascending: true });
  if (error) {
    if (proposalsTableMissing(error)) return [];
    console.warn('listProposalComments failed:', error.message);
    return [];
  }
  return (data || []).map((row: any) => ({
    id: row.id,
    proposal_id: row.proposal_id,
    author_id: row.author_id,
    body: row.body,
    page_path: row.page_path ?? null,
    section_slug: row.section_slug ?? null,
    created_at: row.created_at,
  }));
}

// ────────────────────────────────────────────────────────────
// Team invites (Phase 2)
// ────────────────────────────────────────────────────────────

function invitesTableMissing(err: { message?: string; code?: string } | null | undefined): boolean {
  if (!err) return false;
  if (err.code === '42P01' || err.code === 'PGRST205') return true;
  const m = err.message || '';
  return /manifex_team_invites/i.test(m) && /(does not exist|schema cache|Could not find)/i.test(m);
}

function rowToInvite(row: any): TeamInvite {
  return {
    id: row.id,
    team_id: row.team_id,
    token: row.token,
    role_on_join: (row.role_on_join as TeamRole) || 'editor',
    created_by: row.created_by,
    created_at: row.created_at,
    expires_at: row.expires_at ?? null,
    max_uses: row.max_uses ?? null,
    uses: row.uses ?? 0,
    revoked_at: row.revoked_at ?? null,
  };
}

function newInviteToken(): string {
  // 24 url-safe bytes — plenty of entropy, no special chars to escape.
  return randomBytes(24).toString('base64url');
}

export async function createTeamInvite(input: {
  team_id: string;
  created_by: string;
  role_on_join?: TeamRole;
  expires_at?: string | null;
  max_uses?: number | null;
}): Promise<TeamInvite | null> {
  const { data, error } = await client()
    .from('manifex_team_invites')
    .insert({
      team_id: input.team_id,
      token: newInviteToken(),
      role_on_join: input.role_on_join || 'editor',
      created_by: input.created_by,
      expires_at: input.expires_at ?? null,
      max_uses: input.max_uses ?? null,
    })
    .select('*')
    .single();
  if (error) {
    if (invitesTableMissing(error)) return null;
    throw new Error(`createTeamInvite: ${error.message}`);
  }
  return rowToInvite(data);
}

export async function getTeamInviteByToken(token: string): Promise<TeamInvite | null> {
  const { data, error } = await client()
    .from('manifex_team_invites')
    .select('*')
    .eq('token', token)
    .maybeSingle();
  if (error) {
    if (invitesTableMissing(error)) return null;
    throw new Error(`getTeamInviteByToken: ${error.message}`);
  }
  return data ? rowToInvite(data) : null;
}

export async function listTeamInvites(teamId: string): Promise<TeamInvite[]> {
  const { data, error } = await client()
    .from('manifex_team_invites')
    .select('*')
    .eq('team_id', teamId)
    .order('created_at', { ascending: false });
  if (error) {
    if (invitesTableMissing(error)) return [];
    console.warn('listTeamInvites failed:', error.message);
    return [];
  }
  return (data || []).map(rowToInvite);
}

export interface InviteRedemption {
  ok: true;
  team_id: string;
  role: TeamRole;
}

export interface InviteRedemptionError {
  ok: false;
  reason: 'not_found' | 'expired' | 'exhausted' | 'revoked' | 'already_member' | 'tables_missing' | 'unknown';
  message: string;
}

export async function redeemTeamInvite(token: string, userId: string): Promise<InviteRedemption | InviteRedemptionError> {
  const invite = await getTeamInviteByToken(token);
  if (!invite) return { ok: false, reason: 'not_found', message: 'invite link not found' };
  if (invite.revoked_at) return { ok: false, reason: 'revoked', message: 'invite link was revoked' };
  if (invite.expires_at && new Date(invite.expires_at).getTime() < Date.now()) {
    return { ok: false, reason: 'expired', message: 'invite link expired' };
  }
  if (invite.max_uses !== null && invite.uses >= invite.max_uses) {
    return { ok: false, reason: 'exhausted', message: 'invite link is fully used' };
  }

  // Already a member?
  const existingTeams = await listTeamIdsForUser(userId);
  if (existingTeams.includes(invite.team_id)) {
    return { ok: false, reason: 'already_member', message: 'you are already on this team' };
  }

  // Insert membership.
  const { error: memberErr } = await client()
    .from('manifex_team_members')
    .insert({ team_id: invite.team_id, user_id: userId, role: invite.role_on_join });
  if (memberErr) {
    if (teamsTableMissing(memberErr)) return { ok: false, reason: 'tables_missing', message: 'team tables not yet migrated' };
    return { ok: false, reason: 'unknown', message: memberErr.message };
  }

  // Bump use counter — best-effort, never fail the redeem on a counter
  // update error.
  await client()
    .from('manifex_team_invites')
    .update({ uses: invite.uses + 1 })
    .eq('id', invite.id)
    .then(() => undefined, () => undefined);

  return { ok: true, team_id: invite.team_id, role: invite.role_on_join };
}

export async function revokeTeamInvite(id: string): Promise<boolean> {
  const { error } = await client()
    .from('manifex_team_invites')
    .update({ revoked_at: new Date().toISOString() })
    .eq('id', id);
  if (error) {
    if (invitesTableMissing(error)) return false;
    throw new Error(`revokeTeamInvite: ${error.message}`);
  }
  return true;
}

// ────────────────────────────────────────────────────────────
// Presence (Phase 2) — poll-based heartbeats
// ────────────────────────────────────────────────────────────

const PRESENCE_TTL_SECONDS = 30;

function presenceTableMissing(err: { message?: string; code?: string } | null | undefined): boolean {
  if (!err) return false;
  if (err.code === '42P01' || err.code === 'PGRST205') return true;
  const m = err.message || '';
  return /manifex_presence/i.test(m) && /(does not exist|schema cache|Could not find)/i.test(m);
}

function rowToPresence(row: any): PresenceEntry {
  return {
    session_id: row.session_id,
    user_id: row.user_id,
    display_name: row.display_name ?? null,
    page_path: row.page_path ?? null,
    last_seen_at: row.last_seen_at,
  };
}

export async function heartbeatPresence(input: {
  session_id: string;
  user_id: string;
  display_name?: string | null;
  page_path?: string | null;
}): Promise<boolean> {
  const { error } = await client()
    .from('manifex_presence')
    .upsert(
      {
        session_id: input.session_id,
        user_id: input.user_id,
        display_name: input.display_name ?? null,
        page_path: input.page_path ?? null,
        last_seen_at: new Date().toISOString(),
      },
      { onConflict: 'session_id,user_id' }
    );
  if (error) {
    if (presenceTableMissing(error)) return false;
    console.warn('heartbeatPresence failed:', error.message);
    return false;
  }
  return true;
}

export async function listPresence(sessionId: string): Promise<PresenceEntry[]> {
  const cutoff = new Date(Date.now() - PRESENCE_TTL_SECONDS * 1000).toISOString();
  const { data, error } = await client()
    .from('manifex_presence')
    .select('*')
    .eq('session_id', sessionId)
    .gte('last_seen_at', cutoff)
    .order('last_seen_at', { ascending: false });
  if (error) {
    if (presenceTableMissing(error)) return [];
    console.warn('listPresence failed:', error.message);
    return [];
  }
  return (data || []).map(rowToPresence);
}

export async function createProposalComment(input: {
  proposal_id: string;
  author_id: string;
  body: string;
  page_path?: string | null;
  section_slug?: string | null;
}): Promise<ProposalComment | null> {
  const { data, error } = await client()
    .from('manifex_proposal_comments')
    .insert({
      proposal_id: input.proposal_id,
      author_id: input.author_id,
      body: input.body,
      page_path: input.page_path ?? null,
      section_slug: input.section_slug ?? null,
    })
    .select('*')
    .single();
  if (error) {
    if (proposalsTableMissing(error)) return null;
    throw new Error(`createProposalComment: ${error.message}`);
  }
  return {
    id: data.id,
    proposal_id: data.proposal_id,
    author_id: data.author_id,
    body: data.body,
    page_path: data.page_path ?? null,
    section_slug: data.section_slug ?? null,
    created_at: data.created_at,
  };
}
