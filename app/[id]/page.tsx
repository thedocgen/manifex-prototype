'use client';
import { useEffect, useState, use } from 'react';
import { useRouter } from 'next/navigation';
import { Markdown } from '@/components/Markdown';
import type { ManifexSession } from '@/lib/types';

type StatusKind = 'idle' | 'thinking' | 'compiling' | 'saving' | 'success' | 'error';

export default function BuildPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const [session, setSession] = useState<ManifexSession | null>(null);
  const [prompt, setPrompt] = useState('');
  const [status, setStatus] = useState<StatusKind>('idle');
  const [statusMsg, setStatusMsg] = useState<string>('');
  const [previewHtml, setPreviewHtml] = useState<string | null>(null);
  const [renderedAt, setRenderedAt] = useState<Date | null>(null);
  const [toast, setToast] = useState<{ kind: 'success' | 'error'; msg: string } | null>(null);
  const [showDescription, setShowDescription] = useState(false);

  const load = async () => {
    const res = await fetch(`/api/manifex/sessions/${id}`);
    const data = await res.json();
    if (data.session) setSession(data.session);
    if (data.inlined_html) {
      setPreviewHtml(data.inlined_html);
      setRenderedAt(new Date());
    } else if (data.session) {
      // Auto-render on first load if no cached compilation
      renderInBackground();
    }
  };

  useEffect(() => { load(); }, [id]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2000);
    return () => clearTimeout(t);
  }, [toast]);

  const showToast = (kind: 'success' | 'error', msg: string) => {
    setToast({ kind, msg });
  };

  const renderInBackground = async () => {
    try {
      const res = await fetch(`/api/manifex/sessions/${id}/render`, { method: 'POST' });
      if (!res.ok) return;
      const data = await res.json();
      if (data.inlined_html) {
        setPreviewHtml(data.inlined_html);
        setRenderedAt(new Date());
      }
    } catch {
      // Silent — background only
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
      if (data.session) setSession(data.session);
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

  const save = () => {
    showToast('success', 'Saved!');
  };

  if (!session) {
    return (
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100vh',
        color: 'var(--text-muted)',
      }}>
        Loading your app…
      </div>
    );
  }

  const pending = session.pending_attempt;
  const displayContent = pending ? pending.proposed_manifest.content : session.manifest_state.content;
  const baseForDiff = pending ? session.manifest_state.content : null;
  const busy = status !== 'idle';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
      {/* Top bar */}
      <header style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '14px 32px',
        borderBottom: '1px solid var(--border)',
        background: 'var(--bg-elev)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
          <span
            className="mx-brand-mark"
            style={{ fontSize: '20px', cursor: 'pointer' }}
            onClick={() => router.push('/')}
          >
            Manifex
          </span>
          {pending && (
            <span style={{ fontSize: '13px', color: 'var(--warning)' }}>
              Suggested change
            </span>
          )}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          {busy && (
            <span className="mx-status">
              <span className="dot" />
              {statusMsg}
            </span>
          )}
          <button
            onClick={save}
            className="mx-btn mx-btn-success"
            style={{ padding: '8px 18px' }}
          >
            Save
          </button>
        </div>
      </header>

      {/* Main content area */}
      <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
        {/* App preview (main hero area) */}
        <div data-testid="preview-pane" style={{
          flex: showDescription ? '0 0 50%' : '1 1 100%',
          display: 'flex',
          flexDirection: 'column',
          background: 'var(--bg-elev)',
          transition: 'flex 0.3s ease',
        }}>
          <div style={{
            padding: '8px 20px',
            borderBottom: '1px solid var(--border)',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            fontSize: '12px',
            color: 'var(--text-dim)',
          }}>
            <span style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
              <span style={{ textTransform: 'uppercase', letterSpacing: '0.05em' }}>Your App</span>
              {status === 'compiling' && <span style={{ color: 'var(--accent)' }}>Building…</span>}
            </span>
            <span style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
              <button
                onClick={() => setShowDescription(!showDescription)}
                style={{
                  background: 'transparent',
                  border: '1px solid var(--border-strong)',
                  color: showDescription ? 'var(--accent)' : 'var(--text-muted)',
                  padding: '4px 10px',
                  borderRadius: '4px',
                  fontSize: '11px',
                  cursor: 'pointer',
                }}
              >
                {showDescription ? 'Hide description' : 'Show description'}
              </button>
              {previewHtml && (
                <button
                  data-testid="breakout-btn"
                  onClick={() => {
                    const w = window.open('', '_blank');
                    if (w) {
                      w.document.open();
                      w.document.write(previewHtml);
                      w.document.close();
                    }
                  }}
                  style={{
                    background: 'transparent',
                    border: '1px solid var(--border-strong)',
                    color: 'var(--text-muted)',
                    padding: '4px 10px',
                    borderRadius: '4px',
                    fontSize: '11px',
                    textTransform: 'uppercase',
                    letterSpacing: '0.05em',
                    cursor: 'pointer',
                  }}
                  title="Open in a new tab"
                >
                  Open in new tab
                </button>
              )}
            </span>
          </div>
          <div style={{ flex: 1, background: '#fff', position: 'relative' }}>
            {status === 'compiling' && (
              <div style={{
                position: 'absolute', inset: 0,
                background: 'rgba(255, 255, 255, 0.9)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                color: '#374151', fontSize: '14px', gap: '8px',
                zIndex: 10,
              }}>
                <span className="mx-spinner" /> Building your app…
              </div>
            )}
            {previewHtml ? (
              <iframe
                data-testid="preview-iframe"
                srcDoc={previewHtml}
                style={{ width: '100%', height: '100%', border: 'none' }}
              />
            ) : (
              <div style={{
                padding: '40px 24px',
                color: '#6b7280',
                fontFamily: 'system-ui',
                textAlign: 'center',
              }}>
                Describe what you want below and your app will appear here.
              </div>
            )}
          </div>
        </div>

        {/* Description panel (hidden by default) */}
        {showDescription && (
          <div data-testid="doc-viewer" style={{
            flex: '0 0 50%',
            padding: '40px 56px',
            overflow: 'auto',
            borderLeft: '1px solid var(--border)',
            background: 'var(--bg)',
            opacity: status === 'thinking' ? 0.6 : 1,
            transition: 'opacity 0.2s ease',
          }}>
            <Markdown content={displayContent} diffAgainst={baseForDiff} />
            {pending && pending.diff_summary && (
              <div data-testid="diff-summary" style={{
                marginTop: '24px',
                padding: '12px 16px',
                background: 'rgba(245, 158, 11, 0.08)',
                borderLeft: '3px solid var(--warning)',
                borderRadius: '4px',
                fontSize: '13px',
                color: 'var(--warning)',
                fontStyle: 'italic',
              }}>
                {pending.diff_summary}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Suggested change bar (when pending) */}
      {pending && (
        <div style={{
          borderTop: '1px solid var(--border)',
          background: 'var(--bg-elev)',
          padding: '12px 32px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}>
          <span style={{ fontSize: '14px', color: 'var(--text-muted)', fontStyle: 'italic' }}>
            {pending.diff_summary || 'A change has been suggested'}
          </span>
          <div style={{ display: 'flex', gap: '8px' }}>
            <button
              data-testid="keep-btn"
              onClick={() => action('/keep', undefined, { successMsg: 'Applied!', autoRender: true })}
              disabled={busy}
              className="mx-btn mx-btn-success"
            >
              Looks good
            </button>
            <button
              data-testid="retry-btn"
              onClick={() => action('/retry', undefined, { statusMsg: 'Thinking…' })}
              disabled={busy}
              className="mx-btn mx-btn-secondary"
            >
              Try again
            </button>
            <button
              data-testid="forget-btn"
              onClick={() => action('/forget')}
              disabled={busy}
              className="mx-btn mx-btn-danger"
            >
              Never mind
            </button>
          </div>
        </div>
      )}

      {/* Bottom prompt bar */}
      <footer style={{
        borderTop: '1px solid var(--border)',
        background: 'var(--bg-elev)',
        padding: '16px 32px',
      }}>
        <div style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
          {/* Undo/Redo (subtle) */}
          <div style={{ display: 'flex', gap: '4px' }}>
            <button
              data-testid="undo-btn"
              onClick={() => action('/undo', undefined, { statusMsg: 'Undoing…', autoRender: true })}
              disabled={busy || session.history.length === 0}
              className="mx-btn mx-btn-ghost"
              title="Undo"
              style={{ padding: '8px 10px', fontSize: '13px' }}
            >
              ↶
            </button>
            <button
              data-testid="redo-btn"
              onClick={() => action('/redo', undefined, { statusMsg: 'Redoing…', autoRender: true })}
              disabled={busy || session.redo_stack.length === 0}
              className="mx-btn mx-btn-ghost"
              title="Redo"
              style={{ padding: '8px 10px', fontSize: '13px' }}
            >
              ↷
            </button>
          </div>

          <textarea
            data-testid="prompt-input"
            value={prompt}
            onChange={e => setPrompt(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                submitPrompt();
              }
            }}
            placeholder="Tell me what you want to change…"
            disabled={busy}
            rows={1}
            style={{
              flex: 1,
              resize: 'none',
              fontFamily: 'var(--font-sans)',
            }}
          />
          <button
            data-testid="submit-prompt-btn"
            onClick={submitPrompt}
            disabled={busy || !prompt.trim()}
            className="mx-btn mx-btn-primary"
          >
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
