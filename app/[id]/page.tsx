'use client';
import { useEffect, useState, useCallback, useRef, use } from 'react';
import { useRouter } from 'next/navigation';
import { Markdown, countMatches } from '@/components/Markdown';
import type { ManifexSession, ManifestState, TreeNode, ConversationMessage, Question } from '@/lib/types';
import { generateSkeletonHtml } from '@/lib/skeleton';

type StatusKind = 'idle' | 'thinking' | 'compiling' | 'saving' | 'success' | 'error';

// ── Preview Bridge Script (injected into compiled HTML) ──
const PREVIEW_BRIDGE_SCRIPT = `<script>
// Visual edit mode toggle, set by parent via postMessage.
var __visualEditMode = false;
window.addEventListener('message', function(e) {
  if (e.data && e.data.type === 'set-edit-mode') {
    __visualEditMode = !!e.data.enabled;
    document.body.style.cursor = __visualEditMode ? 'crosshair' : '';
  }
});
// Click handler is OPT-IN via visual edit mode. When the mode is OFF
// (the default), clicks pass through to the compiled app normally so
// users can actually interact with their built UI (press buttons, fill
// forms, etc). When the mode is ON, clicks walk up the DOM to find
// data-doc-page and emit a visual-edit message with click coords +
// section info; the parent renders a floating edit card near the click.
document.addEventListener('click', function(e) {
  if (!__visualEditMode) return;
  var el = e.target;
  while (el && el !== document.body) {
    if (el.dataset && el.dataset.docPage) {
      var payload = {
        page: el.dataset.docPage,
        section: el.dataset.docSection || '',
        clickX: e.clientX,
        clickY: e.clientY,
        elementText: (el.textContent || '').slice(0, 80).trim(),
        elementTag: el.tagName.toLowerCase(),
      };
      window.parent.postMessage(Object.assign({ type: 'visual-edit' }, payload), '*');
      el.style.outline = '2px dashed rgba(217, 119, 6, 0.85)';
      el.style.outlineOffset = '2px';
      setTimeout(function() { el.style.outline = ''; el.style.outlineOffset = ''; }, 1500);
      e.preventDefault();
      e.stopPropagation();
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
  // Meta entries (path starts with "_") are session-scoped pages like Build
  // History — render them visually distinct so users don't expect them to
  // behave like editable doc pages.
  const isMeta = node.path.startsWith('_');

  return (
    <div style={isMeta ? { borderTop: '1px solid var(--border)', marginTop: '8px', paddingTop: '6px' } : undefined}>
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
          color: isActive ? 'var(--accent)' : (isMeta ? 'var(--text-dim)' : 'var(--text)'),
          fontWeight: isActive ? 600 : 400,
          fontStyle: isMeta ? 'italic' : 'normal',
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
        {isMeta && <span style={{ fontSize: '11px', color: 'var(--text-dim)', flexShrink: 0 }} aria-hidden="true">⏱</span>}
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
  const [validateResult, setValidateResult] = useState<{
    total: number;
    passed: number;
    structural?: number;
    behavior?: number;
    results: { name: string; passed: boolean; error?: string; category?: 'structural' | 'behavior'; durationMs?: number }[];
  } | null>(null);
  const [validating, setValidating] = useState(false);
  const [editMode, setEditMode] = useState(false);
  const [editCard, setEditCard] = useState<{ x: number; y: number; page: string; section: string; elementText: string; elementTag: string } | null>(null);
  const [editCardText, setEditCardText] = useState('');
  const [presencePeers, setPresencePeers] = useState<{ user_id: string; display_name: string | null; page_path: string | null }[]>([]);
  // Per-question answers for the active planning question group. Keyed by
  // questionId. Cleared after a successful combined-submit. Choice clicks
  // select; text/secret inputs are controlled by this same map.
  const [activeAnswers, setActiveAnswers] = useState<Record<string, string>>({});

  // Derive a friendly project title for the docs panel + browser tab.
  // Order of preference:
  //   1. The Overview page's H1 once the LLM has scaffolded real content
  //      (anything other than the starter "# New Project").
  //   2. A short slice of the first user prompt, when planning is still
  //      in progress.
  //   3. "Planning…" if there's a conversation but no usable text yet.
  //   4. "New Project" as a final fallback (matches starter content).
  const projectTitle = (() => {
    const overview = session?.manifest_state?.pages?.['overview']?.content || '';
    const h1 = overview.match(/^#\s+(.+?)\s*$/m)?.[1]?.trim();
    if (h1 && h1 !== 'New Project') return h1;
    const firstUser = conversation.find(m => m.role === 'user')?.content?.trim();
    if (firstUser) {
      const cleaned = firstUser.replace(/\s+/g, ' ').slice(0, 50);
      return cleaned.length < firstUser.length ? cleaned + '…' : cleaned;
    }
    if (conversation.length > 0) return 'Planning…';
    return 'New Project';
  })();

  useEffect(() => {
    if (typeof document === 'undefined') return;
    document.title = projectTitle === 'New Project'
      ? 'Manifex — Spec-driven development for visionaries'
      : `${projectTitle} · Manifex`;
  }, [projectTitle]);

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

  const runValidate = async () => {
    const iframe = iframeRef.current;
    const win = iframe?.contentWindow as (Window & { __manifexRunTests?: () => any | Promise<any> }) | null | undefined;
    if (!win || typeof win.__manifexRunTests !== 'function') {
      setValidateResult({ total: 0, passed: 0, results: [{ name: 'No tests available', passed: false, error: 'The compiled app has no tests. Add a Tests page to your docs and rebuild.' }] });
      return;
    }
    setValidating(true);
    try {
      // Runner is async — behavior tests await sleeps, DOM updates, etc.
      const r = await Promise.resolve(win.__manifexRunTests());
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
      if (e.data?.type === 'visual-edit' && e.data.page) {
        // Project the iframe-local click coordinates into parent space.
        const iframe = iframeRef.current;
        const rect = iframe?.getBoundingClientRect();
        const x = (rect?.left ?? 0) + (e.data.clickX ?? 0);
        const y = (rect?.top ?? 0) + (e.data.clickY ?? 0);
        setEditCard({
          x, y,
          page: e.data.page,
          section: e.data.section || '',
          elementText: e.data.elementText || '',
          elementTag: e.data.elementTag || '',
        });
        setEditCardText('');
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, []);

  // Presence heartbeat. Strict 30s cadence, paused while the tab is hidden,
  // and intentionally NOT re-fired on every activePage change — the next
  // scheduled beat will pick up the new page from a ref. Heartbeat ONLY
  // updates presencePeers; it never touches session state, so it can't
  // overwrite a just-received prompt response.
  const activePageRef = useRef(activePage);
  useEffect(() => { activePageRef.current = activePage; }, [activePage]);

  useEffect(() => {
    if (!session?.id) return;
    let cancelled = false;
    const myUserId = session.user_id || 'local-dev-user';
    const beat = async () => {
      if (typeof document !== 'undefined' && document.hidden) return; // pause when backgrounded
      try {
        const res = await fetch(`/api/manifex/sessions/${id}/presence`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ user_id: myUserId, page_path: activePageRef.current || null }),
        });
        const data = await res.json().catch(() => ({}));
        if (cancelled || !data?.entries) return;
        setPresencePeers(
          data.entries
            .filter((e: any) => e.user_id !== myUserId)
            .map((e: any) => ({ user_id: e.user_id, display_name: e.display_name, page_path: e.page_path }))
        );
      } catch {}
    };
    beat();
    const interval = setInterval(beat, 30000);
    // Beat once immediately when the tab becomes visible again so peers see
    // the user is back; also resume the cadence from there.
    const onVisibility = () => { if (!document.hidden) beat(); };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      cancelled = true;
      clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [session?.id, id]);

  // When edit mode toggles, push state into the iframe.
  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe?.contentWindow) return;
    iframe.contentWindow.postMessage({ type: 'set-edit-mode', enabled: editMode }, '*');
    // Closing edit mode also dismisses any open card.
    if (!editMode) setEditCard(null);
  }, [editMode, previewHtml]);

  // Submit a planning question group as one combined user turn. Composes
  // the answers into a structured message the LLM can parse, attaches the
  // raw {questionId → answer} map to the resulting user message so the
  // retired-question UI can pair per-question, and clears the active
  // answer state.
  const submitQuestionAnswers = (questions: { id: string; text: string }[]) => {
    if (busy) return;
    const answers: Record<string, string> = {};
    const lines: string[] = [];
    for (const q of questions) {
      const a = (activeAnswers[q.id] || '').trim();
      if (!a) continue;
      answers[q.id] = a;
      lines.push(`Q: ${q.text} → ${a}`);
    }
    if (lines.length === 0) return;
    const combined = lines.join('\n');
    setActiveAnswers({});
    submitPrompt(combined, { answers });
  };

  const submitVisualEdit = () => {
    if (!editCard || !editCardText.trim()) return;
    const sectionLabel = editCard.section ? editCard.section.replace(/-/g, ' ') : '';
    const pageLabel = editCard.page.replace(/-/g, ' ');
    const scopedPrompt = sectionLabel
      ? `Edit only the "${sectionLabel}" section of the "${pageLabel}" page (the ${editCard.elementTag} containing "${editCard.elementText}"): ${editCardText.trim()}`
      : `Edit only the "${pageLabel}" page (the ${editCard.elementTag} containing "${editCard.elementText}"): ${editCardText.trim()}`;
    setEditCard(null);
    setEditCardText('');
    setEditMode(false);
    submitPrompt(scopedPrompt);
  };

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
    // Show a skeleton wireframe immediately so the user sees something while
    // the LLM compile runs. Replaced with the real HTML when /render returns.
    // We base the skeleton on the manifest the compile is about to operate
    // on (proposed if a pending attempt is open, otherwise the current state).
    try {
      const skeletonState = session?.pending_attempt?.proposed_manifest || session?.manifest_state;
      if (skeletonState && Object.keys(skeletonState.pages).length > 0) {
        const skeleton = generateSkeletonHtml(skeletonState);
        setPreviewHtml(skeleton);
        try { new BroadcastChannel(`manifex-preview-${id}`).postMessage({ type: 'update', html: skeleton }); } catch {}
      }
    } catch {} // skeleton failures are non-fatal
    try {
      try { new BroadcastChannel(`manifex-preview-${id}`).postMessage({ type: 'compiling' }); } catch {}
      const res = await fetch(`/api/manifex/sessions/${id}/render`, { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setPreviewError(data?.error || 'Something went wrong building your app. Try making another change.');
        return;
      }
      if (data.inlined_html) {
        setPreviewHtml(data.inlined_html);
        try { new BroadcastChannel(`manifex-preview-${id}`).postMessage({ type: 'update', html: data.inlined_html }); } catch {}
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

  const submitPrompt = async (overridePrompt?: string | any, opts: { answers?: Record<string, string> } = {}) => {
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
      answers: opts.answers,
      timestamp: new Date().toISOString(),
    };
    setPendingFile(null);
    const updatedConvo = [...conversation, userMsg];
    setConversation(updatedConvo);

    // Pass recent conversation context to API for multi-turn
    const recentContext = updatedConvo.slice(-6);

    setStatus('thinking');
    // One honest message per phase. The status text used to cycle on a
    // timer ("Analyzing… / Planning… / Generating…") which had no real
    // relationship to what the LLM was actually doing — a loading
    // illusion. Now the skeleton preview carries the visible-progress
    // load during compile, and this status bar just states the phase.
    // Keep one fallback for the 90s+ case so users know it isn't stuck.
    const isFirstPrompt = conversation.length <= 1;
    const progressTimers: ReturnType<typeof setTimeout>[] = [];
    if (isFirstPrompt) {
      setStatusMsg('Scaffolding your documentation…');
      progressTimers.push(setTimeout(() => setStatusMsg('Scaffolding your documentation… (this can take up to 2 minutes for the first build)'), 90000));
    } else {
      setStatusMsg('Updating your docs…');
      progressTimers.push(setTimeout(() => setStatusMsg('Updating your docs… (taking longer than usual — still working)'), 60000));
    }
    try {
      const res = await fetch(`/api/manifex/sessions/${id}/prompt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: p,
          conversationContext: recentContext,
          expected_sha: session?.manifest_state?.sha,
          ...(pendingFile && (pendingFile.type === 'image' || pendingFile.type === 'pdf') && pendingFile.base64 ? { image: { base64: pendingFile.base64, media_type: pendingFile.mediaType } } : {}),
        }),
      });
      const data = await res.json();
      // Stop the progressive status timers as soon as we have a response —
      // otherwise a delayed 'Still working…' tick can fire after the UI has
      // already moved on, which leaves the status bar lying. We also flip
      // status to idle here as belt-and-braces; the finally below is the
      // canonical clear, but doing it now means the status indicator
      // disappears the instant the response lands instead of after React
      // batches in the next branch's state work.
      progressTimers.forEach(clearTimeout);
      progressTimers.length = 0;
      setStatus('idle');
      setStatusMsg('');

      if (!res.ok) {
        // Sha conflict: refresh local session from the server's snapshot so
        // the user sees what changed, and tell them to retry.
        if (data.kind === 'sha_conflict' && data.session) {
          setSession(data.session);
          if (data.session.manifest_state?.tree?.length > 0 && !data.session.manifest_state.pages[activePage]) {
            setActivePage(data.session.manifest_state.tree[0].path);
          }
        }
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

        // Safety net: re-fetch the session from the server. Concurrent writes
        // (presence, conversation persist) and React state batching have
        // historically left the local session out of sync with the server's
        // latest pending_attempt. A direct read-back guarantees the UI lands
        // on the truth even if intermediate setState calls were dropped.
        try {
          const refresh = await fetch(`/api/manifex/sessions/${id}`);
          if (refresh.ok) {
            const fresh = await refresh.json();
            if (fresh?.session) setSession(fresh.session);
          }
        } catch {}
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

  // The starter manifest is the empty new-project state: a single 'overview'
  // page with the boilerplate "Describe your app idea below…" content. We
  // hide the preview pane in this state so undoing back to empty doesn't
  // leave a stale Manifex marketing page in the iframe.
  const isStarterManifest =
    Object.keys(currentState.pages).length <= 1 &&
    !!currentState.pages['overview'] &&
    currentState.pages['overview'].content.includes('Describe your app idea below');

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

  // Show Build History only once there's actual history to show — at
  // least two user turns OR at least one applied change. A single
  // first-prompt isn't history, it's the prompt the user just typed.
  const userTurns = conversation.filter(m => m.role === 'user').length;
  const appliedChanges = conversation.filter(m => m.role === 'assistant' && m.diff_summary).length;
  const showHistory = userTurns >= 2 || appliedChanges >= 1;

  // Augmented tree with history page appended
  const displayTree = [
    ...currentState.tree,
    ...(showHistory ? [{ path: HISTORY_PATH, title: 'Build History' }] : []),
  ];
  // Augmented pages with history page
  const displayPages: { [path: string]: { title: string; content: string } } = {
    ...currentState.pages,
    ...(showHistory ? { [HISTORY_PATH]: { title: 'Build History', content: historyContent } } : {}),
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
                <span style={{ display: 'flex', alignItems: 'baseline', gap: '6px', minWidth: 0 }}>
                  {projectTitle && projectTitle !== 'New Project' && (
                    <>
                      <span
                        style={{
                          fontSize: '12px',
                          color: 'var(--text-dim)',
                          fontWeight: 400,
                          maxWidth: '260px',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                        title={projectTitle}
                      >
                        {projectTitle}
                      </span>
                      <span style={{ color: 'var(--text-dim)' }}>›</span>
                    </>
                  )}
                  <span style={{ fontWeight: 500, color: 'var(--text)' }}>
                    {displayPages[effectiveActivePage]?.title || effectiveActivePage}
                  </span>
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

            {/* Presence badges — show team members currently viewing this session */}
            {presencePeers.length > 0 && (
              <div
                data-testid="presence-bar"
                style={{
                  padding: '6px 16px',
                  background: 'rgba(59, 130, 246, 0.06)',
                  borderBottom: '1px solid var(--border)',
                  fontSize: '11px',
                  color: 'var(--text-muted)',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '8px',
                  flexWrap: 'wrap',
                }}
              >
                {presencePeers.map(peer => {
                  const name = peer.display_name || peer.user_id;
                  const where = peer.page_path ? ` viewing ${peer.page_path.replace(/-/g, ' ')}` : '';
                  return (
                    <span
                      key={peer.user_id}
                      title={`${name}${where}`}
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: '5px',
                        padding: '2px 8px',
                        borderRadius: '999px',
                        background: 'rgba(59, 130, 246, 0.12)',
                        color: '#1e40af',
                      }}
                    >
                      <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: '#22c55e' }} />
                      {name}{where && <span style={{ opacity: 0.75 }}>{where}</span>}
                    </span>
                  );
                })}
              </div>
            )}

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
        {(previewHtml || compiling) && !isStarterManifest && (
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
              {compiling && <span style={{ color: 'var(--accent)' }}>Building your app…</span>}
            </span>
            <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
            {previewHtml && (
              <>
              <button
                onClick={() => setEditMode(m => !m)}
                data-testid="visual-edit-btn"
                style={{
                  background: editMode ? 'var(--accent)' : 'transparent',
                  border: '1px solid ' + (editMode ? 'var(--accent)' : 'var(--border-strong)'),
                  color: editMode ? '#fff' : 'var(--text-muted)',
                  padding: '3px 8px',
                  borderRadius: '4px',
                  fontSize: '11px',
                  cursor: 'pointer',
                }}
                title={editMode ? 'Click an element in the preview to edit it' : 'Edit a specific element by clicking it'}
              >
                {editMode ? 'Click an element…' : 'Visual edit'}
              </button>
              <button
                onClick={runValidate}
                disabled={validating}
                data-testid="validate-btn"
                style={{
                  background: 'transparent',
                  border: '1px solid var(--border-strong)',
                  color: 'var(--text-muted)',
                  padding: '3px 8px',
                  borderRadius: '4px',
                  fontSize: '11px',
                  cursor: validating ? 'default' : 'pointer',
                  opacity: validating ? 0.6 : 1,
                }}
                title="Run the test suite for this app"
              >
                {validating ? 'Validating…' : 'Validate'}
              </button>
              </>
            )}
            {previewHtml && (
              <button
                data-testid="breakout-btn"
                onClick={() => {
                  const w = window.open('', '_blank');
                  if (w) {
                    // Write initial HTML + BroadcastChannel listener for live updates.
                    // Channel name is scoped per-session so each breakout tab only receives
                    // updates for its own session — stops cross-session contamination.
                    const listenerScript = `<script>
                      const ch = new BroadcastChannel("manifex-preview-${id}");
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
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '8px', gap: '8px' }}>
                      <div>
                        <strong>{validateResult.passed}/{validateResult.total} passed</strong>
                        {(validateResult.behavior !== undefined || validateResult.structural !== undefined) && (
                          <div style={{ fontSize: '10px', color: 'var(--text-dim, #888)', marginTop: '2px' }}>
                            {validateResult.behavior ?? 0} behavior · {validateResult.structural ?? 0} structural
                          </div>
                        )}
                      </div>
                      <button onClick={() => setValidateResult(null)} style={{ background: 'transparent', border: 'none', cursor: 'pointer', fontSize: '14px', color: 'var(--text-dim, #888)' }}>×</button>
                    </div>
                    {validateResult.results.length === 0 ? (
                      <p style={{ margin: 0, color: 'var(--text-dim, #888)' }}>No tests defined.</p>
                    ) : (
                      <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: '6px' }}>
                        {validateResult.results.map((r, i) => {
                          const isBehavior = r.category === 'behavior';
                          return (
                          <li key={i} style={{ display: 'flex', gap: '6px', alignItems: 'flex-start' }}>
                            <span style={{ color: r.passed ? '#16a34a' : '#dc2626', fontWeight: 600, flexShrink: 0 }}>{r.passed ? '✓' : '✗'}</span>
                            <div style={{ minWidth: 0, flex: 1 }}>
                              <div style={{ wordBreak: 'break-word', display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
                                <span>{r.name}</span>
                                <span
                                  title={isBehavior ? 'Behavior test — drives the UI and asserts on real outcomes' : 'Structural test — checks that the right elements rendered'}
                                  style={{
                                    fontSize: '9px',
                                    padding: '1px 6px',
                                    borderRadius: '999px',
                                    background: isBehavior ? '#dbeafe' : '#f1f5f9',
                                    color: isBehavior ? '#1e40af' : '#64748b',
                                    fontWeight: 600,
                                    textTransform: 'uppercase',
                                    letterSpacing: '0.04em',
                                    flexShrink: 0,
                                  }}
                                >
                                  {isBehavior ? 'behavior' : 'structural'}
                                </span>
                                {r.durationMs !== undefined && r.durationMs > 50 && (
                                  <span style={{ fontSize: '10px', color: 'var(--text-dim, #888)' }}>{r.durationMs}ms</span>
                                )}
                              </div>
                              {r.error && <div style={{ color: '#dc2626', fontSize: '11px', marginTop: '2px', wordBreak: 'break-word' }}>{r.error}</div>}
                            </div>
                          </li>
                          );
                        })}
                      </ul>
                    )}
                  </div>
                )}
              </div>
            ) : (
              <div style={{ padding: '60px 32px', textAlign: 'center' }}>
                {(busy || compiling) ? (
                  <div style={{ color: 'var(--text-muted)' }}>
                    <div className="mx-typing-dots" style={{ justifyContent: 'center', marginBottom: '16px' }}>
                      <span /><span /><span />
                    </div>
                    <p style={{ fontSize: '16px', margin: 0 }}>
                      {compiling ? 'Building your app…' : 'Your app is being created…'}
                    </p>
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
            {conversation.map((msg, i) => {
              // Only the LAST assistant message that carries questions is interactive.
              // Earlier question sets are answered history — render their buttons inert
              // so the user can't re-click them and so they don't share the global busy state.
              const lastQIdx = conversation.reduce((acc, m, j) => (m.role === 'assistant' && m.questions && m.questions.length > 0 ? j : acc), -1);
              const isActiveQuestionMsg = i === lastQIdx;
              // The next user message after this question set is the answer the user picked.
              const answer = msg.questions && msg.questions.length > 0 && conversation[i + 1]?.role === 'user' ? conversation[i + 1].content : null;
              return (
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
                {msg.questions && msg.questions.length > 0 && (() => {
                  const qs = msg.questions;
                  const nextUserMsg = conversation[i + 1]?.role === 'user' ? conversation[i + 1] : null;
                  const filledCount = qs.filter(q => (activeAnswers[q.id] || '').trim().length > 0).length;
                  return (
                  <div style={{
                    background: 'rgba(0,0,0,0.03)',
                    border: '1px solid var(--border)',
                    borderRadius: '12px',
                    padding: '10px 14px',
                    maxWidth: '80%',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '10px',
                    opacity: isActiveQuestionMsg ? 1 : 0.55,
                  }}>
                    {qs.map(q => {
                      // Per-question retired answer (P1 #20): if the user message
                      // immediately after this turn carries a per-question answer
                      // map, pull this question's answer from there. Falls back to
                      // the legacy "whole user message" path for older sessions.
                      const retiredAnswer = nextUserMsg?.answers?.[q.id]
                        ?? (qs.length === 1 ? nextUserMsg?.content ?? null : null);
                      const currentValue = activeAnswers[q.id] || '';
                      return (
                      <div key={q.id}>
                        <div style={{ fontSize: '12px', fontWeight: 500, color: 'var(--text)', marginBottom: '4px' }}>
                          {q.text}
                        </div>
                        {!isActiveQuestionMsg ? (
                          <div style={{ fontSize: '12px', color: 'var(--text-dim)', fontStyle: 'italic', padding: '4px 0' }}>
                            {retiredAnswer ? `You answered: ${retiredAnswer}` : 'Skipped'}
                          </div>
                        ) : q.type === 'choice' && q.options ? (
                          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                            {q.options.map(opt => {
                              const selected = currentValue === opt;
                              return (
                                <button
                                  key={opt}
                                  onClick={() => setActiveAnswers(prev => ({ ...prev, [q.id]: opt }))}
                                  disabled={busy}
                                  data-testid="question-choice-btn"
                                  data-selected={selected ? 'true' : 'false'}
                                  style={{
                                    background: selected ? 'var(--accent-soft)' : 'var(--bg-elev)',
                                    border: selected ? '1.5px solid var(--accent)' : '1px solid var(--border)',
                                    borderRadius: '8px',
                                    padding: '6px 12px',
                                    fontSize: '12px',
                                    color: selected ? 'var(--accent)' : 'var(--text)',
                                    fontWeight: selected ? 600 : 400,
                                    cursor: 'pointer',
                                    textAlign: 'left',
                                  }}
                                >
                                  <span style={{ marginRight: '6px' }}>{selected ? '●' : '○'}</span>
                                  {opt}
                                </button>
                              );
                            })}
                          </div>
                        ) : q.type === 'text' ? (
                          <textarea
                            value={currentValue}
                            onChange={e => setActiveAnswers(prev => ({ ...prev, [q.id]: e.target.value }))}
                            placeholder="Type your answer…"
                            rows={2}
                            data-testid="question-text-input"
                            disabled={busy}
                            style={{
                              width: '100%',
                              padding: '6px 10px',
                              fontSize: '12px',
                              borderRadius: '6px',
                              border: '1px solid var(--border)',
                              background: 'var(--bg-elev)',
                              color: 'var(--text)',
                              resize: 'vertical',
                              fontFamily: 'inherit',
                              boxSizing: 'border-box',
                            }}
                          />
                        ) : q.type === 'secret' ? (
                          <input
                            type="password"
                            value={currentValue}
                            onChange={e => setActiveAnswers(prev => ({ ...prev, [q.id]: e.target.value }))}
                            placeholder="Paste securely…"
                            data-testid="question-secret-input"
                            disabled={busy}
                            style={{ width: '100%', padding: '6px 10px', fontSize: '12px', borderRadius: '6px', border: '1px solid var(--border)' }}
                          />
                        ) : null}
                      </div>
                      );
                    })}
                    {isActiveQuestionMsg && (
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderTop: '1px solid var(--border)', paddingTop: '8px', marginTop: '2px', gap: '8px', flexWrap: 'wrap' }}>
                        <span style={{ fontSize: '11px', color: 'var(--text-dim)' }}>
                          {filledCount} of {qs.length} answered
                        </span>
                        <div style={{ display: 'flex', gap: '6px' }}>
                          <button
                            onClick={() => { setActiveAnswers({}); submitPrompt('Skip the questions and build with sensible defaults.'); }}
                            disabled={busy}
                            data-testid="skip-questions-btn"
                            className="mx-btn mx-btn-ghost"
                            style={{ fontSize: '11px', padding: '6px 12px' }}
                            title="Skip these questions — Manifex picks reasonable defaults and starts building"
                          >
                            Skip & build with defaults
                          </button>
                          <button
                            onClick={() => submitQuestionAnswers(qs)}
                            disabled={busy || filledCount === 0}
                            data-testid="submit-answers-btn"
                            className="mx-btn mx-btn-primary"
                            style={{ fontSize: '12px', padding: '6px 14px' }}
                          >
                            Submit answers
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                  );
                })()}
              </div>
              );
            })}
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
      {/* Visual edit floating card — fixed-position so it can extend beyond the iframe */}
      {editCard && (
        <>
          <div
            onClick={() => { setEditCard(null); setEditCardText(''); }}
            style={{ position: 'fixed', inset: 0, zIndex: 9998, background: 'transparent' }}
          />
          <div
            data-testid="visual-edit-card"
            style={{
              position: 'fixed',
              left: Math.min(editCard.x + 12, (typeof window !== 'undefined' ? window.innerWidth : 1024) - 340),
              top: Math.min(editCard.y + 12, (typeof window !== 'undefined' ? window.innerHeight : 768) - 200),
              width: '320px',
              background: 'var(--bg-card, #fff)',
              border: '1px solid var(--border, #e5e7eb)',
              borderRadius: '10px',
              boxShadow: '0 12px 32px rgba(0,0,0,0.18)',
              padding: '12px',
              zIndex: 9999,
              fontSize: '12px',
              color: 'var(--text, #111)',
            }}
          >
            <div style={{ fontSize: '11px', color: 'var(--text-dim, #666)', marginBottom: '6px' }}>
              Editing <strong>{editCard.section ? editCard.section.replace(/-/g, ' ') : editCard.page.replace(/-/g, ' ')}</strong>
              {editCard.elementText && (
                <span style={{ display: 'block', marginTop: '2px', fontStyle: 'italic', opacity: 0.85 }}>
                  &ldquo;{editCard.elementText}&rdquo;
                </span>
              )}
            </div>
            <textarea
              autoFocus
              value={editCardText}
              onChange={e => setEditCardText(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submitVisualEdit(); }
                if (e.key === 'Escape') { setEditCard(null); setEditCardText(''); }
              }}
              placeholder="What should change here? (⌘+Enter to submit)"
              rows={3}
              style={{
                width: '100%',
                padding: '8px 10px',
                borderRadius: '6px',
                border: '1px solid var(--border, #e5e7eb)',
                fontSize: '12px',
                fontFamily: 'inherit',
                resize: 'vertical',
                boxSizing: 'border-box',
              }}
            />
            <div style={{ display: 'flex', gap: '6px', marginTop: '8px', justifyContent: 'flex-end' }}>
              <button
                onClick={() => { setEditCard(null); setEditCardText(''); }}
                className="mx-btn mx-btn-ghost"
                style={{ fontSize: '11px', padding: '5px 10px' }}
              >
                Cancel
              </button>
              <button
                onClick={submitVisualEdit}
                disabled={!editCardText.trim()}
                className="mx-btn mx-btn-primary"
                data-testid="visual-edit-submit"
                style={{ fontSize: '11px', padding: '5px 10px' }}
              >
                Apply
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
