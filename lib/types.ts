// Shared TypeScript types for Manifex

// ── Multi-page document model ──

export interface DocPage {
  title: string;
  content: string; // markdown
}

export interface TreeNode {
  path: string;
  title: string;
  children?: TreeNode[];
}

export interface ManifestState {
  pages: { [path: string]: DocPage };
  tree: TreeNode[];
  sha: string; // sha256 of JSON.stringify(pages)
}

export interface PendingAttempt {
  prompt: string;
  proposed_manifest: ManifestState;
  diff_summary?: string;
  changed_pages?: string[]; // paths of pages that were modified/created/deleted
  attempt_number: number;
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

// ── Conversation model ──

export interface Question {
  id: string;
  text: string;
  type: 'choice' | 'text' | 'secret';
  options?: string[]; // for choice type
}

export interface ConversationMessage {
  role: 'user' | 'assistant';
  content: string;
  questions?: Question[];
  diff_summary?: string;     // what changed (for timeline view)
  changed_pages?: string[];  // which pages were affected
  timestamp: string;
}

export interface ManifexSession {
  id: string;
  project_id: string;
  user_id: string;
  base_commit_sha: string;
  manifest_state: ManifestState;
  history: ManifestState[];
  redo_stack: ManifestState[];
  pending_attempt: PendingAttempt | null;
  conversation: ConversationMessage[];
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

export const LOCAL_DEV_USER = {
  id: 'local-dev-user',
  name: 'Local Developer',
  email: 'local@manifex.dev',
};

// ── Helpers ──

/** Serialize all pages in tree order into a single string for LLM context */
export function serializePages(state: ManifestState): string {
  const seen = new Set<string>();
  const lines: string[] = [];
  function walk(nodes: TreeNode[]) {
    for (const node of nodes) {
      const page = state.pages[node.path];
      if (page) {
        seen.add(node.path);
        lines.push(`=== ${node.path} (${page.title}) ===`);
        lines.push(page.content);
        lines.push('');
      }
      if (node.children) walk(node.children);
    }
  }
  walk(state.tree);
  // Include any pages not in tree (safety net)
  for (const path of Object.keys(state.pages)) {
    if (!seen.has(path)) {
      lines.push(`=== ${path} (${state.pages[path].title}) ===`);
      lines.push(state.pages[path].content);
      lines.push('');
    }
  }
  return lines.join('\n');
}

/** Migrate old single-content manifest to multi-page format */
export function migrateManifestState(raw: any): ManifestState {
  if (raw && raw.pages && raw.tree) {
    return raw as ManifestState;
  }
  if (raw && typeof raw.content === 'string') {
    return {
      pages: { overview: { title: 'Overview', content: raw.content } },
      tree: [{ path: 'overview', title: 'Overview' }],
      sha: raw.sha || '',
    };
  }
  return {
    pages: { overview: { title: 'Overview', content: '# My App\n\nA new app.' } },
    tree: [{ path: 'overview', title: 'Overview' }],
    sha: '',
  };
}
