// GitHub commit helper for Manifex.
// Uses the Contents API (PUT /repos/.../contents/{path}) which works on empty repos.

const GITHUB_API = 'https://api.github.com';

function token(): string {
  const t = process.env.GITHUB_TOKEN || process.env.GITHUB_PAT;
  if (!t) throw new Error('GITHUB_TOKEN or GITHUB_PAT not set');
  return t;
}

function headers() {
  return {
    'Authorization': `token ${token()}`,
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'Content-Type': 'application/json',
  };
}

interface CommitFile {
  path: string;
  content: string; // raw text
}

async function getExistingFile(repo: string, path: string): Promise<{ sha: string } | null> {
  const r = await fetch(`${GITHUB_API}/repos/${repo}/contents/${encodeURIComponent(path)}`, {
    headers: headers(),
  });
  if (r.status === 404) return null;
  if (!r.ok) return null;
  const data = await r.json();
  return { sha: data.sha };
}

async function putFile(repo: string, file: CommitFile, message: string): Promise<{ commit: { sha: string; html_url: string } }> {
  const existing = await getExistingFile(repo, file.path);
  const body: any = {
    message,
    content: Buffer.from(file.content, 'utf-8').toString('base64'),
  };
  if (existing) body.sha = existing.sha;

  const r = await fetch(`${GITHUB_API}/repos/${repo}/contents/${encodeURIComponent(file.path)}`, {
    method: 'PUT',
    headers: headers(),
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const errText = await r.text();
    throw new Error(`PUT ${file.path} failed: ${r.status} ${errText}`);
  }
  return r.json();
}

/**
 * Commit one or more files to a repo. Each file is its own commit (Contents API limitation),
 * but they all happen in sequence so the result is a sequence of commits ending with all files present.
 */
export async function commitFiles(repo: string, files: CommitFile[], message: string): Promise<{ commit_sha: string; commit_url: string }> {
  let lastResult: { commit: { sha: string; html_url: string } } | null = null;
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    const isLast = i === files.length - 1;
    const msg = files.length === 1 ? message : `${message} (${i + 1}/${files.length}: ${f.path})`;
    lastResult = await putFile(repo, f, msg);
  }
  if (!lastResult) throw new Error('no files committed');
  return {
    commit_sha: lastResult.commit.sha,
    commit_url: lastResult.commit.html_url,
  };
}
