// Shared TypeScript types for Manifex

export interface ManifestState {
  content: string;        // raw markdown
  sha: string;            // sha256 of content
}

export interface PendingAttempt {
  prompt: string;
  proposed_manifest: ManifestState;
  diff_summary?: string;
  attempt_number: number; // bumps on each Retry
}

export interface ManifexProject {
  id: string;
  user_id: string;
  name: string;
  github_repo: string;
  github_repo_id: number | null;
  default_branch: string;
  created_at: string;
}

export interface ManifexSession {
  id: string;
  project_id: string;
  user_id: string;
  base_commit_sha: string;
  manifest_state: ManifestState;
  history: ManifestState[];        // accepted prior states (for undo)
  redo_stack: ManifestState[];     // popped states (for redo)
  pending_attempt: PendingAttempt | null;
  created_at: string;
  updated_at: string;
}

export interface CodexFiles {
  'index.html': string;
  'styles.css': string;
  'app.js': string;
}

export interface CompiledCodex {
  files: CodexFiles;
  codex_sha: string;
  compiler_version: string;
}

// Hardcoded user for prototype (no real auth)
export const LOCAL_DEV_USER = {
  id: 'local-dev-user',
  name: 'Local Developer',
  email: 'local@manifex.dev',
};
