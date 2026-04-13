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
      el.style.outline = '2px solid rgba(59, 130, 246, 0.6)';
      el.style.outlineOffset = '2px';
      setTimeout(function() { el.style.outline = ''; el.style.outlineOffset = ''; }, 800);
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
  const [pendingFile, setPendingFile] = useState<{ type: 'image' | 'text' | 'pdf'; base64?: string; mediaType?: string; textContent?: string; fileName: string; previewUrl?: string } | null>(null);
  const [validateResult, setValidateResult] = useState<{ total: number; passed: number; results: { name: string; passed: boolean; error?: string }[] } | null>(null);
  const [validating, setValidating] = useState(false);

  // Track whether conversation was loaded from server (skip persisting on restore)
  const convoLoadedRef = useRef(false);
  const convoSkipNextPersist = useRef(false);

  // Persist conversation to Supabase whenever it changes (fire-and-forget)
  useEffect(() => {
    if (conversation.length === 0) return; // nothing to persist
    if (convoSkipNextPersist.current) {
      convoSkipNextPersist.current = false;
      return;
    }
    fetch(`/api/manifex/sessions/${id}/conversation`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversation }),
    }).catch(() => {}); // silent fail — best effort
  }, [conversation, id]);

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
      // Restore persisted conversation from manifest_state
      const savedConvo = data.session.manifest_state?.conversation || data.session.conversation;
      if (savedConvo?.length) {
        convoSkipNextPersist.current = true;
        setConversation(savedConvo);
      }
    }
    if (data.inlined_html) {
      setPreviewHtml(data.inlined_html);
    }
    // Do NOT auto-render on load — docs-first flow means preview
    // only appears when user clicks "Build your app" or accepts changes
  };

  useEffect(() => { load(); }, [id]);

  // Note: initial prompt is now sent by the home page before redirect,
  // so no sessionStorage/auto-submit needed here.

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

  const runValidate = () => {
    const iframe = iframeRef.current;
    const win = iframe?.contentWindow as (Window & { __manifexRunTests?: () => any }) | null | undefined;
    if (!win || typeof win.__manifexRunTests !== 'function') {
      setValidateResult({ total: 0, passed: 0, results: [{ name: 'No tests available', passed: false, error: 'The compiled app has no tests. Add a Tests page to your docs and rebuild.' }] });
      return;
    }
    setValidating(true);
    try {
      const r = win.__manifexRunTests();
      setValidateResult(r);
    } catch (e: any) {
      setValidateResult({ total: 0, passed: 0, results: [{ name: 'Test runner crashed', passed: false, error: e?.message || String(e) }] });
    } finally {
      setValidating(false);
    }
  };

  useEffect(() => {
    const handler = (e: MessageEvent) => {
      if (e.data?.type === 'doc-navigate' && e.data.page) {
        setActivePage(e.data.page);
        const section = e.data.section ? e.data.section.replace(/-/g, ' ') : '';
        const pageName = e.data.page.replace(/-/g, ' ');
        setPrompt(`Change the ${section || pageName} in ${pageName}: `);
        setTimeout(() => {
          const textarea = document.querySelector('[data-testid="prompt-input"]') as HTMLTextAreaElement;
          if (textarea) { textarea.focus(); textarea.setSelectionRange(textarea.value.length, textarea.value.length); }
        }, 100);
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

  const submitPrompt = async (overridePrompt?: string | any) => {
    const promptText = (typeof overridePrompt === 'string') ? overridePrompt : prompt;
    if (!promptText.trim() && !pendingFile) return;
    let p = promptText;
    setPrompt('');
    setConversationOpen(true);

    // Prepend text file content to prompt if attached
    if (pendingFile?.type === 'text' && pendingFile.textContent) {
      p = `FILE CONTENT (${pendingFile.fileName}):\n\`\`\`\n${pendingFile.textContent}\n\`\`\`\n\n${p}`;
    }

    // Add user message to local conversation
    const userMsg: ConversationMessage = {
      role: 'user',
      content: p || (pendingFile ? `(${pendingFile.fileName})` : ''),
      imageUrl: pendingFile?.type === 'image' ? pendingFile.previewUrl : undefined,
      timestamp: new Date().toISOString(),
    };
    setPendingFile(null);
    const updatedConvo = [...conversation, userMsg];
    setConversation(updatedConvo);

    // Pass recent conversation context to API for multi-turn
    const recentContext = updatedConvo.slice(-6);

    setStatus('thinking');
    // Progressive loading for first prompt (scaffolding takes 60-90s)
    const isFirstPrompt = conversation.length <= 1;
    const progressTimers: ReturnType<typeof setTimeout>[] = [];
    if (isFirstPrompt) {
      setStatusMsg('Analyzing your idea…');
      progressTimers.push(setTimeout(() => setStatusMsg('Planning documentation structure…'), 8000));
      progressTimers.push(setTimeout(() => setStatusMsg('Generating architecture diagrams…'), 25000));
      progressTimers.push(setTimeout(() => setStatusMsg('Writing specifications…'), 50000));
      progressTimers.push(setTimeout(() => setStatusMsg('Finalizing your documentation…'), 80000));
      progressTimers.push(setTimeout(() => setStatusMsg('Taking a bit longer than usual…'), 120000));
    } else {
      setStatusMsg('Thinking about your change…');
      progressTimers.push(setTimeout(() => setStatusMsg('Updating the relevant pages…'), 15000));
      progressTimers.push(setTimeout(() => setStatusMsg('Still working…'), 45000));
    }
    try {
      const res = await fetch(`/api/manifex/sessions/${id}/prompt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: p,
          conversationContext: recentContext,
          ...(pendingFile && (pendingFile.type === 'image' || pendingFile.type === 'pdf') && pendingFile.base64 ? { image: { base64: pendingFile.base64, media_type: pendingFile.mediaType } } : {}),
        }),
      });
      const data = await res.json();

      if (!res.ok) {
        const errMsg: ConversationMessage = {
          role: 'assistant',
          content: data.error || 'Something went wrong while thinking about your request.',
          timestamp: new Date().toISOString(),
        };
        setConversation(prev => [...prev, errMsg]);
        showToast('error', data.error || 'Request failed');
        return;
      }

      if (data.response_type === 'question') {
        // LLM asked a question — make conversation prominent
        const assistantMsg: ConversationMessage = {
          role: 'assistant',
          content: data.message,
          questions: data.questions,
          timestamp: new Date().toISOString(),
        };
        setConversation(prev => [...prev, assistantMsg]);
        setConversationOpen(true);
        // Scroll conversation to bottom after render
        setTimeout(() => {
          const convo = document.querySelector('[data-conversation-thread]');
          if (convo) convo.scrollTop = convo.scrollHeight;
        }, 100);
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

  const initialPromptRef = useRef(false);
  useEffect(() => {
    if (initialPromptRef.current) return;
    const params = new URLSearchParams(window.location.search);
    const p = params.get('p');
    if (!p) return;
    initialPromptRef.current = true;
    window.history.replaceState({}, '', `/${id}`);
    submitPrompt(p);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

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
  const getSuggestions = (): { text: string; action: 'prompt' | 'link'; href?: string }[] => {
    if (pending || busy || Object.keys(currentState.pages).length <= 1) return [];
    const all = Object.values(currentState.pages).map(p => p.content).join(' ').toLowerCase();
    const suggestions: { text: string; action: 'prompt' | 'link'; href?: string }[] = [];
    if (!all.includes('database') && !all.includes('supabase') && !all.includes('storage'))
      suggestions.push({ text: 'Add a database to save data', action: 'prompt' });
    if (!all.includes('auth') && !all.includes('login') && !all.includes('signup'))
      suggestions.push({ text: 'Add user accounts', action: 'prompt' });
    if (!all.includes('responsive') && !all.includes('mobile'))
      suggestions.push({ text: 'Make it work on mobile', action: 'prompt' });
    if (!all.includes('dark mode') && !all.includes('dark theme'))
      suggestions.push({ text: 'Add a dark mode toggle', action: 'prompt' });
    if (!all.includes('search') && !all.includes('filter'))
      suggestions.push({ text: 'Add search or filtering', action: 'prompt' });
    // Connector-aware suggestions
    if ((all.includes('image') || all.includes('photo') || all.includes('picture')) && !all.includes('image generation connector'))
      suggestions.push({ text: 'Connect image generation', action: 'link', href: '/connectors' });
    if (previewHtml && !all.includes('deploy connector'))
      suggestions.push({ text: 'Publish your app', action: 'link', href: '/connectors' });
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
          <button onClick={() => showToast('success', 'Saved!')} className="mx-btn mx-btn-secondary" style={{ padding: '6px 14px', fontSize: '13px' }}>
            Save
          </button>
        </div>
      </header>

      {/* Main content: [Sidebar + Docs | Preview] */}
      <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>

        {/* Left pane: Sidebar + Doc content (full-width until first render, then 50%) */}
        <div style={{
          flex: previewHtml ? '0 0 50%' : '1 1 100%',
          display: 'flex',
          overflow: 'hidden',
          borderRight: previewHtml ? '1px solid var(--border)' : 'none',
          transition: 'flex 0.4s ease',
        }}>

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

        {/* Right pane: App preview (hidden until first render, then slides in) */}
        {(previewHtml || compiling) && (
        <div data-testid="preview-pane" className="mx-preview-reveal" style={{
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
              <div style={{ position: 'relative', width: '100%', height: '100%' }}>
                <iframe ref={iframeRef} data-testid="preview-iframe" srcDoc={previewHtml + PREVIEW_BRIDGE_SCRIPT} style={{ width: '100%', height: '100%', border: 'none' }} />
                <button
                  onClick={runValidate}
                  disabled={validating}
                  className="mx-btn mx-btn-secondary"
                  data-testid="validate-btn"
                  style={{ position: 'absolute', top: '8px', right: '8px', fontSize: '12px', padding: '6px 12px', opacity: 0.92 }}
                  title="Run the test suite for this app"
                >
                  {validating ? 'Validating…' : 'Validate'}
                </button>
                {validateResult && (
                  <div
                    data-testid="validate-results"
                    style={{
                      position: 'absolute',
                      top: '44px',
                      right: '8px',
                      width: '320px',
                      maxHeight: '60%',
                      overflowY: 'auto',
                      background: 'var(--bg-card, #fff)',
                      border: '1px solid var(--border, #e5e7eb)',
                      borderRadius: '8px',
                      boxShadow: '0 8px 24px rgba(0,0,0,0.12)',
                      padding: '12px',
                      fontSize: '12px',
                      color: 'var(--text, #111)',
                    }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                      <strong>{validateResult.passed}/{validateResult.total} passed</strong>
                      <button onClick={() => setValidateResult(null)} style={{ background: 'transparent', border: 'none', cursor: 'pointer', fontSize: '14px', color: 'var(--text-dim, #888)' }}>×</button>
                    </div>
                    {validateResult.results.length === 0 ? (
                      <p style={{ margin: 0, color: 'var(--text-dim, #888)' }}>No tests defined.</p>
                    ) : (
                      <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: '6px' }}>
                        {validateResult.results.map((r, i) => (
                          <li key={i} style={{ display: 'flex', gap: '6px', alignItems: 'flex-start' }}>
                            <span style={{ color: r.passed ? '#16a34a' : '#dc2626', fontWeight: 600, flexShrink: 0 }}>{r.passed ? '✓' : '✗'}</span>
                            <div style={{ minWidth: 0 }}>
                              <div style={{ wordBreak: 'break-word' }}>{r.name}</div>
                              {r.error && <div style={{ color: '#dc2626', fontSize: '11px', marginTop: '2px', wordBreak: 'break-word' }}>{r.error}</div>}
                            </div>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
              </div>
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
                    <p style={{ fontSize: '20px', fontWeight: 600, color: 'var(--text)', margin: '0 0 8px' }}>
                      Your app will appear here
                    </p>
                    <p style={{ fontSize: '14px', color: 'var(--text-dim)', margin: 0 }}>
                      Your app will appear here once documentation is complete and you click Build.
                    </p>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
        )}
      </div>

      {/* Build button — prominent when no preview yet */}
      {!previewHtml && !compiling && Object.keys(currentState.pages).length > 1 && (
        <div style={{
          borderTop: '1px solid var(--border)',
          background: 'var(--bg-elev)',
          padding: '16px 24px',
          textAlign: 'center',
        }}>
          <button
            onClick={renderInBackground}
            disabled={busy}
            className="mx-btn mx-btn-primary"
            style={{ padding: '12px 32px', fontSize: '15px' }}
          >
            Build your app
          </button>
          <p style={{ fontSize: '12px', color: 'var(--text-dim)', margin: '8px 0 0' }}>
            Review the documentation above, then build when ready.
          </p>
        </div>
      )}

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
          <div data-conversation-thread style={{
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
                                onClick={() => submitPrompt(opt)}
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
              <button key={s.text} className="mx-suggestion" onClick={() => {
                if (s.action === 'link' && s.href) {
                  router.push(s.href);
                } else {
                  setPrompt(s.text);
                }
              }}>
                {s.text}
              </button>
            ))}
          </div>
        )}

        {/* File preview */}
        {pendingFile && (
          <div style={{ padding: '6px 24px', display: 'flex', alignItems: 'center', gap: '8px' }}>
            {pendingFile.type === 'image' && pendingFile.previewUrl && (
              <img src={pendingFile.previewUrl} alt="Upload" style={{ height: '40px', borderRadius: '6px', border: '1px solid var(--border)' }} />
            )}
            {pendingFile.type === 'text' && (
              <span style={{ fontSize: '12px', padding: '4px 8px', borderRadius: '4px', background: 'var(--bg-muted, #f0f0f0)', color: 'var(--text-muted)', fontFamily: 'monospace' }}>{pendingFile.fileName}</span>
            )}
            {pendingFile.type === 'pdf' && (
              <span style={{ fontSize: '12px', padding: '4px 8px', borderRadius: '4px', background: 'var(--bg-muted, #f0f0f0)', color: 'var(--text-muted)' }}>📄 {pendingFile.fileName}</span>
            )}
            <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
              {pendingFile.type === 'image' ? 'Image' : pendingFile.type === 'pdf' ? 'PDF' : 'File'} attached
            </span>
            <button onClick={() => setPendingFile(null)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-dim)', fontSize: '14px' }}>✕</button>
          </div>
        )}

        {/* Prompt input */}
        <div style={{ padding: '12px 24px', display: 'flex', gap: '10px', alignItems: 'center' }}>
          <div style={{ display: 'flex', gap: '4px' }}>
            <button data-testid="undo-btn" onClick={() => action('/undo', undefined, { statusMsg: 'Undoing…', autoRender: true })} disabled={busy || session.history.length === 0} className="mx-btn mx-btn-ghost" title="Undo" style={{ padding: '6px 8px', fontSize: '13px' }}>↶</button>
            <button data-testid="redo-btn" onClick={() => action('/redo', undefined, { statusMsg: 'Redoing…', autoRender: true })} disabled={busy || session.redo_stack.length === 0} className="mx-btn mx-btn-ghost" title="Redo" style={{ padding: '6px 8px', fontSize: '13px' }}>↷</button>
          </div>
          {/* File upload */}
          <input
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp,.pdf,.csv,.json,.txt,.js,.py,.html,.css"
            id="image-upload"
            style={{ display: 'none' }}
            onChange={e => {
              const file = e.target.files?.[0];
              if (!file) return;
              const fileName = file.name;
              const ext = fileName.split('.').pop()?.toLowerCase() || '';
              const textExtensions = ['txt', 'csv', 'json', 'js', 'py', 'html', 'css'];

              if (file.type.startsWith('image/')) {
                // Image: resize to max 1024px width, base64 encode
                const img = new Image();
                img.onload = () => {
                  const maxW = 1024;
                  const scale = img.width > maxW ? maxW / img.width : 1;
                  const canvas = document.createElement('canvas');
                  canvas.width = img.width * scale;
                  canvas.height = img.height * scale;
                  canvas.getContext('2d')!.drawImage(img, 0, 0, canvas.width, canvas.height);
                  const base64 = canvas.toDataURL(file.type).split(',')[1];
                  setPendingFile({ type: 'image', base64, mediaType: file.type, fileName, previewUrl: URL.createObjectURL(file) });
                };
                img.src = URL.createObjectURL(file);
              } else if (ext === 'pdf') {
                // PDF: read as base64
                const reader = new FileReader();
                reader.onload = () => {
                  const dataUrl = reader.result as string;
                  const base64 = dataUrl.split(',')[1];
                  setPendingFile({ type: 'pdf', base64, mediaType: 'application/pdf', fileName });
                };
                reader.readAsDataURL(file);
              } else if (textExtensions.includes(ext)) {
                // Text-based file: read as text
                const reader = new FileReader();
                reader.onload = () => {
                  const textContent = reader.result as string;
                  setPendingFile({ type: 'text', textContent, fileName });
                };
                reader.readAsText(file);
              }
              e.target.value = '';
            }}
          />
          <button
            onClick={() => document.getElementById('image-upload')?.click()}
            disabled={busy}
            className="mx-btn mx-btn-ghost"
            title="Attach a file"
            style={{ padding: '6px 10px', fontSize: '12px' }}
          >
            Attach
          </button>
          <textarea
            data-testid="prompt-input"
            value={prompt}
            onChange={e => setPrompt(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submitPrompt(); } }}
            placeholder="What should we work on?"
            disabled={busy}
            rows={1}
            style={{ flex: 1, resize: 'none', fontFamily: 'var(--font-sans)' }}
          />
          <button data-testid="submit-prompt-btn" onClick={submitPrompt} disabled={busy || (!prompt.trim() && !pendingFile)} className="mx-btn mx-btn-primary">
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
