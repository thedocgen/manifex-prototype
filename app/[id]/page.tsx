'use client';
import { useEffect, useState, useCallback, use } from 'react';
import { useRouter } from 'next/navigation';
import { Markdown } from '@/components/Markdown';
import type { ManifexSession, ManifestState, TreeNode } from '@/lib/types';

type StatusKind = 'idle' | 'thinking' | 'compiling' | 'saving' | 'success' | 'error';

// ── Sidebar Tree ──

function TreeItem({ node, activePath, changedPaths, onSelect, depth = 0 }: {
  node: TreeNode;
  activePath: string;
  changedPaths: Set<string>;
  onSelect: (path: string) => void;
  depth?: number;
}) {
  const [expanded, setExpanded] = useState(true);
  const hasChildren = node.children && node.children.length > 0;
  const isActive = node.path === activePath;
  const isChanged = changedPaths.has(node.path);

  return (
    <div>
      <button
        onClick={() => onSelect(node.path)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '6px',
          width: '100%',
          textAlign: 'left',
          padding: '6px 12px',
          paddingLeft: `${12 + depth * 16}px`,
          border: 'none',
          borderRadius: '6px',
          background: isActive ? 'var(--accent-soft)' : 'transparent',
          color: isActive ? 'var(--accent)' : 'var(--text)',
          fontWeight: isActive ? 600 : 400,
          fontSize: '13px',
          cursor: 'pointer',
          transition: 'background 0.1s',
        }}
        onMouseEnter={e => { if (!isActive) (e.target as HTMLElement).style.background = 'rgba(0,0,0,0.03)'; }}
        onMouseLeave={e => { if (!isActive) (e.target as HTMLElement).style.background = 'transparent'; }}
      >
        {hasChildren && (
          <span
            onClick={e => { e.stopPropagation(); setExpanded(!expanded); }}
            style={{ fontSize: '10px', color: 'var(--text-dim)', width: '12px', textAlign: 'center' }}
          >
            {expanded ? '▾' : '▸'}
          </span>
        )}
        <span style={{ flex: 1 }}>{node.title}</span>
        {isChanged && (
          <span style={{
            width: '7px',
            height: '7px',
            borderRadius: '50%',
            background: 'var(--accent)',
            flexShrink: 0,
          }} title="Changed" />
        )}
      </button>
      {hasChildren && expanded && node.children!.map(child => (
        <TreeItem
          key={child.path}
          node={child}
          activePath={activePath}
          changedPaths={changedPaths}
          onSelect={onSelect}
          depth={depth + 1}
        />
      ))}
    </div>
  );
}

// ── Main Page ──

export default function BuildPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const [session, setSession] = useState<ManifexSession | null>(null);
  const [prompt, setPrompt] = useState('');
  const [status, setStatus] = useState<StatusKind>('idle');
  const [statusMsg, setStatusMsg] = useState<string>('');
  const [previewHtml, setPreviewHtml] = useState<string | null>(null);
  const [toast, setToast] = useState<{ kind: 'success' | 'error'; msg: string } | null>(null);
  const [activePage, setActivePage] = useState<string>('');
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [sidebarSearch, setSidebarSearch] = useState('');

  const load = async () => {
    const res = await fetch(`/api/manifex/sessions/${id}`);
    const data = await res.json();
    if (data.session) {
      setSession(data.session);
      // Set active page to first page if not set
      const state = data.session.manifest_state as ManifestState;
      if (!activePage && state.tree.length > 0) {
        setActivePage(state.tree[0].path);
      }
    }
    if (data.inlined_html) {
      setPreviewHtml(data.inlined_html);
    } else if (data.session) {
      renderInBackground();
    }
  };

  useEffect(() => { load(); }, [id]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2000);
    return () => clearTimeout(t);
  }, [toast]);

  const showToast = (kind: 'success' | 'error', msg: string) => setToast({ kind, msg });

  const renderInBackground = async () => {
    try {
      const res = await fetch(`/api/manifex/sessions/${id}/render`, { method: 'POST' });
      if (!res.ok) return;
      const data = await res.json();
      if (data.inlined_html) setPreviewHtml(data.inlined_html);
    } catch { /* silent */ }
  };

  const action = async (path: string, body?: any, opts: { statusKind?: StatusKind; statusMsg?: string; successMsg?: string; autoRender?: boolean } = {}) => {
    setStatus(opts.statusKind || 'thinking');
    setStatusMsg(opts.statusMsg || 'Working…');
    try {
      const res = await fetch(`/api/manifex/sessions/${id}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      });
      const data = await res.json();
      if (data.session) {
        setSession(data.session);
        // After a prompt, navigate to the first changed page
        const pa = data.session.pending_attempt;
        if (pa?.changed_pages?.length > 0) {
          setActivePage(pa.changed_pages[0]);
        }
      }
      if (!res.ok) {
        showToast('error', data.error || data.message || 'Something went wrong');
        return data;
      }
      if (opts.successMsg) showToast('success', opts.successMsg);
      if (opts.autoRender) renderInBackground();
      return data;
    } catch (e: any) {
      showToast('error', e.message || 'Network error');
    } finally {
      setStatus('idle');
      setStatusMsg('');
    }
  };

  const submitPrompt = async () => {
    if (!prompt.trim()) return;
    const p = prompt;
    setPrompt('');
    await action('/prompt', { prompt: p }, { statusKind: 'thinking', statusMsg: 'Thinking…' });
  };

  if (!session) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', color: 'var(--text-muted)' }}>
        Loading your app…
      </div>
    );
  }

  const pending = session.pending_attempt;
  const currentState = pending ? pending.proposed_manifest : session.manifest_state;
  const baseState = pending ? session.manifest_state : null;
  const changedPaths = new Set<string>(pending?.changed_pages || []);
  const busy = status !== 'idle';

  // Ensure activePage is valid
  const effectiveActivePage = currentState.pages[activePage] ? activePage : (currentState.tree[0]?.path || Object.keys(currentState.pages)[0] || '');

  // Get content for current page
  const pageContent = currentState.pages[effectiveActivePage]?.content || '';
  const basePageContent = baseState?.pages[effectiveActivePage]?.content || null;
  // Only show diff if this specific page changed
  const diffAgainst = (baseState && changedPaths.has(effectiveActivePage)) ? basePageContent : null;

  // Sidebar search filtering
  const searchLower = sidebarSearch.toLowerCase();
  const searchResults: { path: string; title: string; snippet: string }[] = [];
  if (sidebarSearch.trim()) {
    for (const [path, page] of Object.entries(currentState.pages)) {
      const titleMatch = page.title.toLowerCase().includes(searchLower);
      const contentIdx = page.content.toLowerCase().indexOf(searchLower);
      if (titleMatch || contentIdx >= 0) {
        const snippet = contentIdx >= 0
          ? '…' + page.content.slice(Math.max(0, contentIdx - 30), contentIdx + sidebarSearch.length + 30) + '…'
          : '';
        searchResults.push({ path, title: page.title, snippet });
      }
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
      {/* Top bar */}
      <header className="build-header" style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '10px 24px',
        borderBottom: '1px solid var(--border)',
        background: 'var(--bg-elev)',
        minHeight: '48px',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <span className="mx-brand-mark" style={{ fontSize: '18px', cursor: 'pointer' }} onClick={() => router.push('/')}>
            Manifex
          </span>
          {pending && (
            <span style={{ fontSize: '12px', color: 'var(--warning)', fontWeight: 500 }}>
              Suggested changes
            </span>
          )}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          {busy && <span className="mx-status"><span className="dot" />{statusMsg}</span>}
          <button onClick={() => showToast('success', 'Saved!')} className="mx-btn mx-btn-success" style={{ padding: '6px 14px', fontSize: '13px' }}>
            Save
          </button>
        </div>
      </header>

      {/* Main content: [Sidebar + Docs | Preview] */}
      <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>

        {/* Left pane: Sidebar + Doc content (50%) */}
        <div style={{ flex: '0 0 50%', display: 'flex', overflow: 'hidden', borderRight: '1px solid var(--border)' }}>

          {/* Sidebar nav */}
          {sidebarOpen && (
            <div style={{
              width: '220px',
              minWidth: '220px',
              borderRight: '1px solid var(--border)',
              background: 'var(--bg)',
              display: 'flex',
              flexDirection: 'column',
              overflow: 'hidden',
            }}>
              {/* Sidebar search */}
              <div style={{ padding: '10px 10px 6px' }}>
                <input
                  value={sidebarSearch}
                  onChange={e => setSidebarSearch(e.target.value)}
                  placeholder="Search docs…"
                  style={{
                    width: '100%',
                    padding: '6px 10px',
                    fontSize: '12px',
                    borderRadius: '6px',
                  }}
                />
              </div>

              {/* Search results or tree */}
              <div style={{ flex: 1, overflow: 'auto', padding: '4px 6px' }}>
                {sidebarSearch.trim() ? (
                  searchResults.length === 0 ? (
                    <div style={{ padding: '12px', fontSize: '12px', color: 'var(--text-dim)', textAlign: 'center' }}>
                      No results
                    </div>
                  ) : (
                    searchResults.map(r => (
                      <button
                        key={r.path}
                        onClick={() => { setActivePage(r.path); setSidebarSearch(''); }}
                        style={{
                          display: 'block',
                          width: '100%',
                          textAlign: 'left',
                          padding: '8px 10px',
                          border: 'none',
                          borderRadius: '6px',
                          background: 'transparent',
                          cursor: 'pointer',
                          marginBottom: '2px',
                        }}
                      >
                        <div style={{ fontSize: '13px', fontWeight: 500, color: 'var(--text)' }}>{r.title}</div>
                        {r.snippet && (
                          <div style={{ fontSize: '11px', color: 'var(--text-dim)', marginTop: '2px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {r.snippet}
                          </div>
                        )}
                      </button>
                    ))
                  )
                ) : (
                  currentState.tree.map(node => (
                    <TreeItem
                      key={node.path}
                      node={node}
                      activePath={effectiveActivePage}
                      changedPaths={changedPaths}
                      onSelect={setActivePage}
                    />
                  ))
                )}
              </div>
            </div>
          )}

          {/* Doc content area */}
          <div style={{
            flex: 1,
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
            background: 'var(--bg-elev)',
          }}>
            {/* Doc toolbar */}
            <div style={{
              padding: '6px 16px',
              borderBottom: '1px solid var(--border)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              fontSize: '12px',
              color: 'var(--text-dim)',
              minHeight: '32px',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <button
                  onClick={() => setSidebarOpen(!sidebarOpen)}
                  style={{
                    background: 'none',
                    border: 'none',
                    cursor: 'pointer',
                    fontSize: '14px',
                    color: 'var(--text-muted)',
                    padding: '2px 4px',
                  }}
                  title={sidebarOpen ? 'Hide sidebar' : 'Show sidebar'}
                >
                  {sidebarOpen ? '◀' : '▶'}
                </button>
                <span style={{ fontWeight: 500, color: 'var(--text)' }}>
                  {currentState.pages[effectiveActivePage]?.title || effectiveActivePage}
                </span>
              </div>
              <span style={{ fontSize: '11px' }}>
                {Object.keys(currentState.pages).length} pages
              </span>
            </div>

            {/* Changes summary banner */}
            {pending && changedPaths.size > 0 && (
              <div style={{
                padding: '8px 16px',
                background: 'rgba(217, 119, 6, 0.06)',
                borderBottom: '1px solid var(--border)',
                fontSize: '12px',
                color: 'var(--text-muted)',
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
                flexWrap: 'wrap',
              }}>
                <span style={{ color: 'var(--warning)', fontWeight: 500 }}>
                  {changedPaths.size} page{changedPaths.size !== 1 ? 's' : ''} updated:
                </span>
                {Array.from(changedPaths).map((p, i) => (
                  <span key={p}>
                    <button
                      onClick={() => setActivePage(p)}
                      style={{
                        background: 'none',
                        border: 'none',
                        cursor: 'pointer',
                        color: p === effectiveActivePage ? 'var(--accent)' : 'var(--text)',
                        fontWeight: p === effectiveActivePage ? 600 : 400,
                        fontSize: '12px',
                        textDecoration: 'underline',
                        padding: 0,
                      }}
                    >
                      {currentState.pages[p]?.title || p}
                    </button>
                    {i < changedPaths.size - 1 && <span style={{ color: 'var(--text-dim)' }}>, </span>}
                  </span>
                ))}
              </div>
            )}

            {/* Page content */}
            <div style={{
              flex: 1,
              overflow: 'auto',
              padding: '32px 40px',
              opacity: status === 'thinking' ? 0.6 : 1,
              transition: 'opacity 0.2s ease',
            }}>
              <Markdown content={pageContent} diffAgainst={diffAgainst} />
              {pending && changedPaths.has(effectiveActivePage) && pending.diff_summary && (
                <div style={{
                  marginTop: '24px',
                  padding: '10px 14px',
                  background: 'rgba(217, 119, 6, 0.06)',
                  borderLeft: '3px solid var(--warning)',
                  borderRadius: '4px',
                  fontSize: '12px',
                  color: 'var(--warning)',
                  fontStyle: 'italic',
                }}>
                  {pending.diff_summary}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Right pane: App preview (50%) */}
        <div data-testid="preview-pane" style={{
          flex: '0 0 50%',
          display: 'flex',
          flexDirection: 'column',
          background: 'var(--bg-elev)',
        }}>
          <div style={{
            padding: '6px 16px',
            borderBottom: '1px solid var(--border)',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            fontSize: '12px',
            color: 'var(--text-dim)',
            minHeight: '32px',
          }}>
            <span style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span style={{ textTransform: 'uppercase', letterSpacing: '0.05em' }}>Preview</span>
              {status === 'compiling' && <span style={{ color: 'var(--accent)' }}>Building…</span>}
            </span>
            {previewHtml && (
              <button
                data-testid="breakout-btn"
                onClick={() => {
                  const w = window.open('', '_blank');
                  if (w) { w.document.open(); w.document.write(previewHtml); w.document.close(); }
                }}
                style={{
                  background: 'transparent',
                  border: '1px solid var(--border-strong)',
                  color: 'var(--text-muted)',
                  padding: '3px 8px',
                  borderRadius: '4px',
                  fontSize: '11px',
                  cursor: 'pointer',
                }}
              >
                Open in new tab
              </button>
            )}
          </div>
          <div style={{ flex: 1, background: '#fff', position: 'relative' }}>
            {status === 'compiling' && (
              <div style={{
                position: 'absolute', inset: 0,
                background: 'rgba(255,255,255,0.9)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                color: '#374151', fontSize: '14px', gap: '8px', zIndex: 10,
              }}>
                <span className="mx-spinner" /> Building your app…
              </div>
            )}
            {previewHtml ? (
              <iframe data-testid="preview-iframe" srcDoc={previewHtml} style={{ width: '100%', height: '100%', border: 'none' }} />
            ) : (
              <div style={{ padding: '40px 24px', color: '#6b7280', textAlign: 'center' }}>
                Describe what you want below and your app will appear here.
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Suggested change bar */}
      {pending && (
        <div className="build-suggested-bar" style={{
          borderTop: '1px solid var(--border)',
          background: 'var(--bg-elev)',
          padding: '10px 24px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}>
          <span style={{ fontSize: '13px', color: 'var(--text-muted)', fontStyle: 'italic' }}>
            {pending.diff_summary || 'Changes suggested'}
          </span>
          <div style={{ display: 'flex', gap: '8px' }}>
            <button data-testid="keep-btn" onClick={() => action('/keep', undefined, { successMsg: 'Applied!', autoRender: true })} disabled={busy} className="mx-btn mx-btn-success">Looks good</button>
            <button data-testid="retry-btn" onClick={() => action('/retry', undefined, { statusMsg: 'Thinking…' })} disabled={busy} className="mx-btn mx-btn-secondary">Try again</button>
            <button data-testid="forget-btn" onClick={() => action('/forget')} disabled={busy} className="mx-btn mx-btn-danger">Never mind</button>
          </div>
        </div>
      )}

      {/* Bottom prompt bar */}
      <footer className="build-footer" style={{
        borderTop: '1px solid var(--border)',
        background: 'var(--bg-elev)',
        padding: '12px 24px',
      }}>
        <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
          <div style={{ display: 'flex', gap: '4px' }}>
            <button data-testid="undo-btn" onClick={() => action('/undo', undefined, { statusMsg: 'Undoing…', autoRender: true })} disabled={busy || session.history.length === 0} className="mx-btn mx-btn-ghost" title="Undo" style={{ padding: '6px 8px', fontSize: '13px' }}>↶</button>
            <button data-testid="redo-btn" onClick={() => action('/redo', undefined, { statusMsg: 'Redoing…', autoRender: true })} disabled={busy || session.redo_stack.length === 0} className="mx-btn mx-btn-ghost" title="Redo" style={{ padding: '6px 8px', fontSize: '13px' }}>↷</button>
          </div>
          <textarea
            data-testid="prompt-input"
            value={prompt}
            onChange={e => setPrompt(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submitPrompt(); } }}
            placeholder="Tell me what you want to change…"
            disabled={busy}
            rows={1}
            style={{ flex: 1, resize: 'none', fontFamily: 'var(--font-sans)' }}
          />
          <button data-testid="submit-prompt-btn" onClick={submitPrompt} disabled={busy || !prompt.trim()} className="mx-btn mx-btn-primary">
            {status === 'thinking' ? <><span className="mx-spinner" /> Thinking…</> : 'Tell me'}
          </button>
        </div>
      </footer>

      {toast && (
        <div className={`mx-toast ${toast.kind}`}>
          {toast.kind === 'success' ? '✓' : '⚠'} {toast.msg}
        </div>
      )}
    </div>
  );
}
