'use client';
import { useEffect, useState, useCallback, useRef, use } from 'react';
import { useRouter } from 'next/navigation';
import { Markdown, countMatches } from '@/components/Markdown';
import type { ManifexSession, ManifestState, TreeNode, ConversationMessage, Question } from '@/lib/types';

type StatusKind = 'idle' | 'thinking' | 'compiling' | 'saving' | 'success' | 'error';

// ── Preview Bridge Script (injected into compiled HTML) ──
const PREVIEW_BRIDGE_SCRIPT = `<script>
// Click-to-identify: walk up DOM to find data-doc-page, notify parent
document.addEventListener('click', function(e) {
  var el = e.target;
  while (el && el !== document.body) {
    if (el.dataset && el.dataset.docPage) {
      window.parent.postMessage({ type: 'doc-navigate', page: el.dataset.docPage, section: el.dataset.docSection || '' }, '*');
      e.preventDefault();
      return;
    }
    el = el.parentElement;
  }
});
// Hover-to-highlight: parent sends highlight/clear messages
var currentHighlights = [];
window.addEventListener('message', function(e) {
  if (e.data && e.data.type === 'highlight') {
    currentHighlights.forEach(function(el) { el.style.outline = ''; el.style.outlineOffset = ''; });
    currentHighlights = [];
    var selector = '[data-doc-section="' + e.data.section + '"]';
    if (e.data.page) selector = '[data-doc-page="' + e.data.page + '"]' + (e.data.section ? '[data-doc-section="' + e.data.section + '"]' : '');
    var els = document.querySelectorAll(selector);
    els.forEach(function(el) {
      el.style.outline = '2px solid rgba(217, 119, 6, 0.4)';
      el.style.outlineOffset = '4px';
      currentHighlights.push(el);
    });
  }
  if (e.data && e.data.type === 'highlight-clear') {
    currentHighlights.forEach(function(el) { el.style.outline = ''; el.style.outlineOffset = ''; });
    currentHighlights = [];
  }
});
</script>`;

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
          borderLeft: isActive ? '3px solid var(--accent)' : '3px solid transparent',
          borderRadius: '0 6px 6px 0',
          background: isActive ? 'var(--accent-soft)' : 'transparent',
          color: isActive ? 'var(--accent)' : 'var(--text)',
          fontWeight: isActive ? 600 : 400,
          fontSize: '13px',
          cursor: 'pointer',
          transition: 'all 0.15s ease',
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
  const [compiling, setCompiling] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [toast, setToast] = useState<{ kind: 'success' | 'error'; msg: string } | null>(null);
  const [activePage, setActivePage] = useState<string>('');
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [sidebarSearch, setSidebarSearch] = useState('');
  const [pageSearch, setPageSearch] = useState('');
  const [pageSearchOpen, setPageSearchOpen] = useState(false);
  const [activeMatchIdx, setActiveMatchIdx] = useState(0);
  const [conversationOpen, setConversationOpen] = useState(false);
  const [conversation, setConversation] = useState<ConversationMessage[]>([]);
  const [pendingImage, setPendingImage] = useState<{ base64: string; mediaType: string; previewUrl: string } | null>(null);

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
    } else {
      // Check for pre-built template HTML from sessionStorage
      const templateHtml = sessionStorage.getItem(`template-html-${id}`);
      if (templateHtml) {
        setPreviewHtml(templateHtml);
        sessionStorage.removeItem(`template-html-${id}`);
      } else if (data.session) {
        renderInBackground();
      }
    }
  };

  useEffect(() => { load(); }, [id]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2000);
    return () => clearTimeout(t);
  }, [toast]);

  // Reset page search when switching pages
  useEffect(() => {
    setPageSearch('');
    setActiveMatchIdx(0);
  }, [activePage]);

  // Scroll to active search match
  useEffect(() => {
    if (!pageSearch) return;
    const el = document.querySelector('.mx-search-active');
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [activeMatchIdx, pageSearch]);

  // Preview ↔ Docs bridge: listen for click-to-identify from iframe
  const iframeRef = useRef<HTMLIFrameElement>(null);
  useEffect(() => {
    const handler = (e: MessageEvent) => {
      if (e.data?.type === 'doc-navigate' && e.data.page) {
        setActivePage(e.data.page);
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, []);

  // Send highlight message to iframe
  const highlightInPreview = useCallback((section: string | null) => {
    const iframe = iframeRef.current;
    if (!iframe?.contentWindow) return;
    if (section) {
      iframe.contentWindow.postMessage({ type: 'highlight', page: activePage, section }, '*');
    } else {
      iframe.contentWindow.postMessage({ type: 'highlight-clear' }, '*');
    }
  }, [activePage]);

  const showToast = (kind: 'success' | 'error', msg: string) => setToast({ kind, msg });

  const renderInBackground = async () => {
    setCompiling(true);
    setPreviewError(null);
    try {
      try { new BroadcastChannel('manifex-preview').postMessage({ type: 'compiling' }); } catch {}
      const res = await fetch(`/api/manifex/sessions/${id}/render`, { method: 'POST' });
      if (!res.ok) {
        setPreviewError('Something went wrong building your app. Try making another change.');
        return;
      }
      const data = await res.json();
      if (data.inlined_html) {
        setPreviewHtml(data.inlined_html);
        try { new BroadcastChannel('manifex-preview').postMessage({ type: 'update', html: data.inlined_html }); } catch {}
      }
    } catch {
      setPreviewError('Couldn\'t connect to the build service. Try again in a moment.');
    } finally {
      setCompiling(false);
    }
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
    setConversationOpen(true);

    // Add user message to local conversation
    const userMsg: ConversationMessage = {
      role: 'user',
      content: p || '(image)',
      imageUrl: pendingImage?.previewUrl,
      timestamp: new Date().toISOString(),
    };
    setPendingImage(null);
    const updatedConvo = [...conversation, userMsg];
    setConversation(updatedConvo);

    // Pass recent conversation context to API for multi-turn
    const recentContext = updatedConvo.slice(-6);

    setStatus('thinking');
    // Progressive loading for first prompt (scaffolding takes 60-90s)
    const isFirstPrompt = conversation.length <= 1;
    const progressTimers: ReturnType<typeof setTimeout>[] = [];
    if (isFirstPrompt) {
      setStatusMsg('Setting up your project…');
      progressTimers.push(setTimeout(() => setStatusMsg('Creating documentation…'), 5000));
      progressTimers.push(setTimeout(() => setStatusMsg('Building your app structure…'), 20000));
      progressTimers.push(setTimeout(() => setStatusMsg('Almost ready…'), 45000));
      progressTimers.push(setTimeout(() => setStatusMsg('Taking a bit longer than usual…'), 75000));
    } else {
      setStatusMsg('Thinking…');
    }
    try {
      const res = await fetch(`/api/manifex/sessions/${id}/prompt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: p,
          conversationContext: recentContext,
          ...(pendingImage ? { image: { base64: pendingImage.base64, media_type: pendingImage.mediaType } } : {}),
        }),
      });
      const data = await res.json();

      if (data.response_type === 'question') {
        // LLM asked a question
        const assistantMsg: ConversationMessage = {
          role: 'assistant',
          content: data.message,
          questions: data.questions,
          timestamp: new Date().toISOString(),
        };
        setConversation(prev => [...prev, assistantMsg]);
      } else {
        // LLM updated docs
        if (data.session) {
          setSession(data.session);
          const pa = data.session.pending_attempt;
          if (pa?.changed_pages?.length > 0) setActivePage(pa.changed_pages[0]);
        }
        const pa = data.session?.pending_attempt;
        const assistantMsg: ConversationMessage = {
          role: 'assistant',
          content: data.diff_summary || 'Changes applied.',
          diff_summary: data.diff_summary,
          changed_pages: pa?.changed_pages,
          timestamp: new Date().toISOString(),
        };
        setConversation(prev => [...prev, assistantMsg]);
      }

      if (!res.ok) {
        showToast('error', data.error || data.message || 'Something went wrong');
      }
    } catch (e: any) {
      // Error recovery: friendly message in conversation
      const errorMsg: ConversationMessage = {
        role: 'assistant',
        content: 'Something went wrong. You can try sending your message again.',
        timestamp: new Date().toISOString(),
      };
      setConversation(prev => [...prev, errorMsg]);
    } finally {
      progressTimers.forEach(clearTimeout);
      setStatus('idle');
      setStatusMsg('');
    }
  };

  const submitSecretAnswer = async (questionId: string, key: string, value: string) => {
    if (!session) return;
    // Store secret via separate endpoint
    await fetch('/api/manifex/secrets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project_id: session.project_id, key, value }),
    });
    // Then send a follow-up prompt telling the LLM the secret was stored
    setPrompt(`I've provided the ${key}. It's stored securely — continue with the setup.`);
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

  const basePageContent = baseState?.pages[effectiveActivePage]?.content || null;
  const diffAgainst = (baseState && changedPaths.has(effectiveActivePage)) ? basePageContent : null;

  // ── Build History page (auto-generated from conversation) ──
  const HISTORY_PATH = '_build-history';
  const historyEntries = conversation.filter(m => m.role === 'user' || (m.role === 'assistant' && m.diff_summary));
  let historyContent = '# Build History\n\nHow this app came to be.\n';
  let entryNum = 0;
  for (let i = 0; i < conversation.length; i++) {
    const msg = conversation[i];
    if (msg.role === 'user') {
      entryNum++;
      const ts = new Date(msg.timestamp).toLocaleString();
      historyContent += `\n## ${entryNum}. ${ts}\n\nYou: "${msg.content}"\n`;
      // Look for the next assistant message with changes
      const next = conversation[i + 1];
      if (next && next.role === 'assistant' && next.diff_summary) {
        historyContent += `\n→ ${next.diff_summary}`;
        if (next.changed_pages && next.changed_pages.length > 0) {
          historyContent += ` (${next.changed_pages.join(', ')})`;
        }
        historyContent += '\n';
      } else if (next && next.role === 'assistant' && next.questions) {
        historyContent += `\n→ Asked clarifying questions\n`;
      }
    }
  }

  // Augmented tree with history page appended
  const displayTree = [
    ...currentState.tree,
    ...(entryNum > 0 ? [{ path: HISTORY_PATH, title: 'Build History' }] : []),
  ];
  // Augmented pages with history page
  const displayPages: { [path: string]: { title: string; content: string } } = {
    ...currentState.pages,
    ...(entryNum > 0 ? { [HISTORY_PATH]: { title: 'Build History', content: historyContent } } : {}),
  };

  // ── Contextual prompt suggestions ──
  const getSuggestions = (): string[] => {
    if (pending || busy || Object.keys(currentState.pages).length <= 1) return [];
    const all = Object.values(currentState.pages).map(p => p.content).join(' ').toLowerCase();
    const suggestions: string[] = [];
    if (!all.includes('database') && !all.includes('supabase') && !all.includes('storage'))
      suggestions.push('Add a database to save data');
    if (!all.includes('auth') && !all.includes('login') && !all.includes('signup'))
      suggestions.push('Add user accounts');
    if (!all.includes('responsive') && !all.includes('mobile'))
      suggestions.push('Make it work on mobile');
    if (!all.includes('dark mode') && !all.includes('dark theme'))
      suggestions.push('Add a dark mode toggle');
    if (!all.includes('search') && !all.includes('filter'))
      suggestions.push('Add search or filtering');
    return suggestions.slice(0, 3);
  };
  const suggestions = getSuggestions();

  // Use displayPages for content lookup (includes history page)
  const isHistoryPage = effectiveActivePage === HISTORY_PATH;
  const pageContent = displayPages[effectiveActivePage]?.content || '';

  // Sidebar search filtering
  const searchLower = sidebarSearch.toLowerCase();
  const searchResults: { path: string; title: string; snippet: string }[] = [];
  if (sidebarSearch.trim()) {
    for (const [path, page] of Object.entries(displayPages)) {
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
                  displayTree.map(node => (
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
                  {displayPages[effectiveActivePage]?.title || effectiveActivePage}
                </span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <button
                  onClick={() => { setPageSearchOpen(!pageSearchOpen); if (pageSearchOpen) { setPageSearch(''); setActiveMatchIdx(0); } }}
                  style={{
                    background: 'none',
                    border: 'none',
                    cursor: 'pointer',
                    fontSize: '12px',
                    color: pageSearchOpen ? 'var(--accent)' : 'var(--text-muted)',
                    padding: '2px 6px',
                  }}
                  title="Search in page"
                >
                  ⌕
                </button>
                <span style={{ fontSize: '11px' }}>
                  {Object.keys(displayPages).length} pages
                </span>
              </div>
            </div>

            {/* In-page search bar */}
            {pageSearchOpen && (() => {
              const matchCount = countMatches(pageContent, pageSearch);
              return (
                <div style={{
                  padding: '6px 16px',
                  borderBottom: '1px solid var(--border)',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '8px',
                  fontSize: '12px',
                  background: 'var(--bg)',
                }}>
                  <input
                    autoFocus
                    value={pageSearch}
                    onChange={e => { setPageSearch(e.target.value); setActiveMatchIdx(0); }}
                    onKeyDown={e => {
                      if (e.key === 'Enter') {
                        if (e.shiftKey) setActiveMatchIdx(Math.max(0, activeMatchIdx - 1));
                        else if (matchCount > 0) setActiveMatchIdx((activeMatchIdx + 1) % matchCount);
                      }
                      if (e.key === 'Escape') { setPageSearchOpen(false); setPageSearch(''); setActiveMatchIdx(0); }
                    }}
                    placeholder="Find in page…"
                    style={{ width: '180px', padding: '4px 8px', fontSize: '12px', borderRadius: '4px' }}
                  />
                  {pageSearch && (
                    <>
                      <span style={{ color: matchCount > 0 ? 'var(--text-muted)' : 'var(--danger)', whiteSpace: 'nowrap' }}>
                        {matchCount > 0 ? `${activeMatchIdx + 1} / ${matchCount}` : 'No results'}
                      </span>
                      <button
                        onClick={() => setActiveMatchIdx(Math.max(0, activeMatchIdx - 1))}
                        disabled={matchCount === 0}
                        style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', fontSize: '14px', padding: '0 4px' }}
                      >
                        ‹
                      </button>
                      <button
                        onClick={() => { if (matchCount > 0) setActiveMatchIdx((activeMatchIdx + 1) % matchCount); }}
                        disabled={matchCount === 0}
                        style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', fontSize: '14px', padding: '0 4px' }}
                      >
                        ›
                      </button>
                    </>
                  )}
                  <button
                    onClick={() => { setPageSearchOpen(false); setPageSearch(''); setActiveMatchIdx(0); }}
                    style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-dim)', fontSize: '14px', padding: '0 4px', marginLeft: 'auto' }}
                  >
                    ✕
                  </button>
                </div>
              );
            })()}

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
            <div key={effectiveActivePage} className="mx-page-content" style={{
              flex: 1,
              overflow: 'auto',
              padding: '32px 40px',
              opacity: status === 'thinking' ? 0.6 : 1,
              transition: 'opacity 0.2s ease',
            }}>
              <Markdown content={pageContent} diffAgainst={diffAgainst} searchTerm={pageSearch} activeMatchIndex={activeMatchIdx} onSectionHover={highlightInPreview} />
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
              <span style={{ fontWeight: 500, color: 'var(--text)' }}>
                {currentState.pages['overview']?.title || 'Preview'}
              </span>
              {compiling && <span style={{ color: 'var(--accent)' }}>Updating…</span>}
            </span>
            {previewHtml && (
              <button
                data-testid="breakout-btn"
                onClick={() => {
                  const w = window.open('', '_blank');
                  if (w) {
                    // Write initial HTML + BroadcastChannel listener for live updates
                    const listenerScript = `<script>
                      const ch = new BroadcastChannel('manifex-preview');
                      ch.onmessage = e => {
                        if (e.data.type === 'update' && e.data.html) {
                          document.open();
                          document.write(e.data.html);
                          document.close();
                        }
                        if (e.data.type === 'compiling') {
                          if (!document.getElementById('mx-compile-overlay')) {
                            const d = document.createElement('div');
                            d.id = 'mx-compile-overlay';
                            d.style.cssText = 'position:fixed;inset:0;background:rgba(255,255,255,0.9);display:flex;align-items:center;justify-content:center;z-index:9999;font-family:system-ui;color:#374151;font-size:14px';
                            d.textContent = 'Building your app…';
                            document.body.appendChild(d);
                          }
                        }
                      };
                    </script>`;
                    w.document.open();
                    w.document.write(previewHtml + listenerScript);
                    w.document.close();
                  }
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
            {compiling && (
              <div className="mx-compile-bar" />
            )}
            {previewError ? (
              <div style={{ padding: '40px 24px', textAlign: 'center', color: '#6b7280' }}>
                <p style={{ fontSize: '15px', margin: '0 0 16px' }}>{previewError}</p>
                <button onClick={renderInBackground} className="mx-btn mx-btn-secondary" style={{ fontSize: '13px' }}>
                  Try rebuilding
                </button>
              </div>
            ) : previewHtml ? (
              <iframe ref={iframeRef} data-testid="preview-iframe" srcDoc={previewHtml + PREVIEW_BRIDGE_SCRIPT} style={{ width: '100%', height: '100%', border: 'none' }} />
            ) : (
              <div style={{ padding: '60px 32px', textAlign: 'center' }}>
                {busy ? (
                  <div style={{ color: 'var(--text-muted)' }}>
                    <div className="mx-typing-dots" style={{ justifyContent: 'center', marginBottom: '16px' }}>
                      <span /><span /><span />
                    </div>
                    <p style={{ fontSize: '16px', margin: 0 }}>Your app is being created…</p>
                  </div>
                ) : (
                  <div>
                    <p style={{ fontSize: '20px', fontFamily: 'var(--font-serif)', fontWeight: 600, color: 'var(--text)', margin: '0 0 8px' }}>
                      What are you building?
                    </p>
                    <p style={{ fontSize: '14px', color: 'var(--text-dim)', margin: '0 0 20px' }}>
                      Describe it below, or try one of these:
                    </p>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', maxWidth: '360px', margin: '0 auto' }}>
                      {['A booking system for my yoga studio', 'A dashboard to track my reading goals', 'A fan page for my cat'].map(ex => (
                        <button
                          key={ex}
                          onClick={() => setPrompt(ex)}
                          style={{
                            background: 'var(--accent-soft)',
                            border: '1px solid rgba(217,119,6,0.12)',
                            borderRadius: '10px',
                            padding: '10px 16px',
                            fontSize: '13px',
                            color: 'var(--accent)',
                            cursor: 'pointer',
                            textAlign: 'left',
                          }}
                        >
                          {ex}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
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

      {/* Conversation + prompt area */}
      <footer className="build-footer" style={{
        borderTop: '1px solid var(--border)',
        background: 'var(--bg-elev)',
        display: 'flex',
        flexDirection: 'column',
        maxHeight: conversationOpen ? '40vh' : 'auto',
      }}>
        {/* Conversation toggle + thread */}
        {conversation.length > 0 && (
          <button
            onClick={() => setConversationOpen(!conversationOpen)}
            style={{
              background: 'none',
              border: 'none',
              borderBottom: conversationOpen ? '1px solid var(--border)' : 'none',
              padding: '6px 24px',
              fontSize: '11px',
              color: 'var(--text-dim)',
              cursor: 'pointer',
              textAlign: 'left',
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
            }}
          >
            <span>{conversationOpen ? '▾' : '▸'}</span>
            <span>Conversation ({conversation.length})</span>
            {!conversationOpen && conversation.length > 0 && (
              <span style={{ color: 'var(--text-muted)', marginLeft: '4px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '300px' }}>
                — {conversation[conversation.length - 1].content.slice(0, 60)}
              </span>
            )}
          </button>
        )}

        {conversationOpen && conversation.length > 0 && (
          <div style={{
            flex: 1,
            overflow: 'auto',
            padding: '12px 24px',
            display: 'flex',
            flexDirection: 'column',
            gap: '8px',
          }}>
            {conversation.map((msg, i) => (
              <div key={i} style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: msg.role === 'user' ? 'flex-end' : 'flex-start',
                gap: '4px',
              }}>
                <div style={{
                  background: msg.role === 'user' ? 'var(--accent-soft)' : 'rgba(0,0,0,0.03)',
                  border: msg.role === 'user' ? '1px solid rgba(217,119,6,0.2)' : '1px solid var(--border)',
                  borderRadius: '12px',
                  padding: '8px 14px',
                  maxWidth: '80%',
                  fontSize: '13px',
                  lineHeight: 1.5,
                  color: 'var(--text)',
                }}>
                  {msg.imageUrl && (
                    <img src={msg.imageUrl} alt="Uploaded" style={{ maxWidth: '200px', maxHeight: '120px', borderRadius: '6px', marginBottom: '6px', display: 'block' }} />
                  )}
                  {msg.content}
                  {/* Show changed pages in timeline */}
                  {msg.changed_pages && msg.changed_pages.length > 0 && (
                    <div style={{ marginTop: '4px', fontSize: '11px', color: 'var(--text-dim)' }}>
                      {msg.changed_pages.map((p, j) => (
                        <button
                          key={p}
                          onClick={() => setActivePage(p)}
                          style={{
                            background: 'none', border: 'none', cursor: 'pointer',
                            color: 'var(--accent)', fontSize: '11px', padding: 0,
                            textDecoration: 'underline',
                          }}
                        >
                          {p}
                        </button>
                      )).reduce<React.ReactNode[]>((acc, el, j) => j === 0 ? [el] : [...acc, ', ', el], [])}
                    </div>
                  )}
                </div>

                {/* Render structured questions */}
                {msg.questions && msg.questions.length > 0 && (
                  <div style={{
                    background: 'rgba(0,0,0,0.03)',
                    border: '1px solid var(--border)',
                    borderRadius: '12px',
                    padding: '10px 14px',
                    maxWidth: '80%',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '8px',
                  }}>
                    {msg.questions.map(q => (
                      <div key={q.id}>
                        <div style={{ fontSize: '12px', fontWeight: 500, color: 'var(--text)', marginBottom: '4px' }}>
                          {q.text}
                        </div>
                        {q.type === 'choice' && q.options && (
                          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                            {q.options.map(opt => (
                              <button
                                key={opt}
                                onClick={() => {
                                  setPrompt(opt);
                                  // Auto-submit the choice
                                  setTimeout(() => {
                                    const btn = document.querySelector('[data-testid="submit-prompt-btn"]') as HTMLButtonElement;
                                    if (btn && !btn.disabled) btn.click();
                                  }, 50);
                                }}
                                disabled={busy}
                                style={{
                                  background: 'var(--bg-elev)',
                                  border: '1px solid var(--border)',
                                  borderRadius: '8px',
                                  padding: '6px 12px',
                                  fontSize: '12px',
                                  color: 'var(--text)',
                                  cursor: 'pointer',
                                  textAlign: 'left',
                                }}
                              >
                                {opt}
                              </button>
                            ))}
                          </div>
                        )}
                        {q.type === 'text' && (
                          <input
                            placeholder="Type your answer…"
                            onKeyDown={e => {
                              if (e.key === 'Enter') {
                                setPrompt((e.target as HTMLInputElement).value);
                                (e.target as HTMLInputElement).value = '';
                              }
                            }}
                            style={{ width: '100%', padding: '6px 10px', fontSize: '12px', borderRadius: '6px' }}
                          />
                        )}
                        {q.type === 'secret' && (
                          <div style={{ display: 'flex', gap: '6px' }}>
                            <input
                              type="password"
                              placeholder="Paste securely…"
                              data-secret-key={q.id}
                              style={{ flex: 1, padding: '6px 10px', fontSize: '12px', borderRadius: '6px' }}
                            />
                            <button
                              onClick={() => {
                                const input = document.querySelector(`[data-secret-key="${q.id}"]`) as HTMLInputElement;
                                if (input?.value) {
                                  submitSecretAnswer(q.id, q.id, input.value);
                                  input.value = '';
                                }
                              }}
                              className="mx-btn mx-btn-primary"
                              style={{ padding: '4px 10px', fontSize: '11px' }}
                            >
                              Save
                            </button>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {/* Suggestions */}
        {suggestions.length > 0 && !prompt && !pending && !busy && (
          <div style={{ padding: '6px 24px 0', display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
            {suggestions.map(s => (
              <button key={s} className="mx-suggestion" onClick={() => setPrompt(s)}>
                {s}
              </button>
            ))}
          </div>
        )}

        {/* Image preview */}
        {pendingImage && (
          <div style={{ padding: '6px 24px', display: 'flex', alignItems: 'center', gap: '8px' }}>
            <img src={pendingImage.previewUrl} alt="Upload" style={{ height: '40px', borderRadius: '6px', border: '1px solid var(--border)' }} />
            <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>Image attached</span>
            <button onClick={() => setPendingImage(null)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-dim)', fontSize: '14px' }}>✕</button>
          </div>
        )}

        {/* Prompt input */}
        <div style={{ padding: '12px 24px', display: 'flex', gap: '10px', alignItems: 'center' }}>
          <div style={{ display: 'flex', gap: '4px' }}>
            <button data-testid="undo-btn" onClick={() => action('/undo', undefined, { statusMsg: 'Undoing…', autoRender: true })} disabled={busy || session.history.length === 0} className="mx-btn mx-btn-ghost" title="Undo" style={{ padding: '6px 8px', fontSize: '13px' }}>↶</button>
            <button data-testid="redo-btn" onClick={() => action('/redo', undefined, { statusMsg: 'Redoing…', autoRender: true })} disabled={busy || session.redo_stack.length === 0} className="mx-btn mx-btn-ghost" title="Redo" style={{ padding: '6px 8px', fontSize: '13px' }}>↷</button>
          </div>
          {/* Image upload */}
          <input
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp"
            id="image-upload"
            style={{ display: 'none' }}
            onChange={e => {
              const file = e.target.files?.[0];
              if (!file) return;
              // Resize to max 1024px width
              const img = new Image();
              img.onload = () => {
                const maxW = 1024;
                const scale = img.width > maxW ? maxW / img.width : 1;
                const canvas = document.createElement('canvas');
                canvas.width = img.width * scale;
                canvas.height = img.height * scale;
                canvas.getContext('2d')!.drawImage(img, 0, 0, canvas.width, canvas.height);
                const base64 = canvas.toDataURL(file.type).split(',')[1];
                setPendingImage({ base64, mediaType: file.type, previewUrl: URL.createObjectURL(file) });
              };
              img.src = URL.createObjectURL(file);
              e.target.value = '';
            }}
          />
          <button
            onClick={() => document.getElementById('image-upload')?.click()}
            disabled={busy}
            className="mx-btn mx-btn-ghost"
            title="Attach image"
            style={{ padding: '6px 8px', fontSize: '16px' }}
          >
            Attach
          </button>
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
          <button data-testid="submit-prompt-btn" onClick={submitPrompt} disabled={busy || (!prompt.trim() && !pendingImage)} className="mx-btn mx-btn-primary">
            {status === 'thinking' ? <><span className="mx-typing-dots"><span /><span /><span /></span></> : 'Tell me'}
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
