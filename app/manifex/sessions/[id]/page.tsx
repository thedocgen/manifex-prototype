'use client';
import { useEffect, useState, use } from 'react';
import { Brand } from '@/components/Brand';
import { Markdown } from '@/components/Markdown';
import type { ManifexSession } from '@/lib/types';

type StatusKind = 'idle' | 'thinking' | 'compiling' | 'committing' | 'success' | 'error';

export default function SessionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [session, setSession] = useState<ManifexSession | null>(null);
  const [prompt, setPrompt] = useState('');
  const [status, setStatus] = useState<StatusKind>('idle');
  const [statusMsg, setStatusMsg] = useState<string>('');
  const [previewHtml, setPreviewHtml] = useState<string | null>(null);
  const [renderedAt, setRenderedAt] = useState<Date | null>(null);
  const [toast, setToast] = useState<{ kind: 'success' | 'error'; msg: string } | null>(null);

  const load = async () => {
    const res = await fetch(`/api/manifex/sessions/${id}`);
    const data = await res.json();
    if (data.session) setSession(data.session);
    if (data.inlined_html) {
      setPreviewHtml(data.inlined_html);
      setRenderedAt(new Date());
    }
  };

  useEffect(() => { load(); }, [id]);

  // Auto-dismiss toast
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2000);
    return () => clearTimeout(t);
  }, [toast]);

  const showToast = (kind: 'success' | 'error', msg: string) => {
    setToast({ kind, msg });
  };

  // Background render: fetch the new compilation without changing status spinners.
  // Used after Keep / Undo / Redo to keep the preview pane in sync without
  // making the user wait or click Render manually.
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
        showToast('error', data.error || data.message || 'Action failed');
        return data;
      }
      if (opts.successMsg) showToast('success', opts.successMsg);
      // After certain actions, fire a background render to keep preview in sync
      if (opts.autoRender) {
        renderInBackground();
      }
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

  const render = async () => {
    setStatus('compiling');
    setStatusMsg('Compiling your app…');
    try {
      const res = await fetch(`/api/manifex/sessions/${id}/render`, { method: 'POST' });
      const data = await res.json();
      if (data.inlined_html) {
        setPreviewHtml(data.inlined_html);
        setRenderedAt(new Date());
        showToast('success', 'Compiled');
      } else {
        showToast('error', data.error || 'Render failed');
      }
    } catch (e: any) {
      showToast('error', e.message || 'Render failed');
    } finally {
      setStatus('idle');
      setStatusMsg('');
    }
  };

  const commit = async () => {
    setStatus('committing');
    setStatusMsg('Pushing to GitHub…');
    try {
      const res = await fetch(`/api/manifex/sessions/${id}/commit`, { method: 'POST' });
      const data = await res.json();
      if (data.success) {
        showToast('success', `Committed ${data.commit_sha?.slice(0, 7)}`);
      } else {
        showToast('error', data.error || data.message || 'Commit failed');
      }
    } catch (e: any) {
      showToast('error', e.message || 'Commit failed');
    } finally {
      setStatus('idle');
      setStatusMsg('');
    }
  };

  if (!session) {
    return (
      <div>
        <Brand />
        <main style={{ padding: '64px 32px', textAlign: 'center', color: 'var(--text-muted)' }}>
          Loading session…
        </main>
      </div>
    );
  }

  const pending = session.pending_attempt;
  const displayContent = pending ? pending.proposed_manifest.content : session.manifest_state.content;
  const baseForDiff = pending ? session.manifest_state.content : null;
  const busy = status !== 'idle';

  const renderedAgo = renderedAt ? `${Math.max(1, Math.floor((Date.now() - renderedAt.getTime()) / 1000))}s ago` : null;

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
        <div style={{ display: 'flex', alignItems: 'baseline', gap: '16px' }}>
          <span className="mx-brand-mark" style={{ fontSize: '20px' }}>Manifex</span>
          <span style={{ fontSize: '13px', color: 'var(--text-dim)', fontFamily: 'var(--font-mono)' }}>
            session · sha {session.manifest_state.sha.slice(0, 12)}
          </span>
          {pending && (
            <span style={{ fontSize: '13px', color: 'var(--warning)' }}>
              ● pending #{pending.attempt_number}
            </span>
          )}
        </div>
        {busy && (
          <span className="mx-status">
            <span className="dot" />
            {statusMsg}
          </span>
        )}
      </header>

      {/* Two-pane content */}
      <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
        {/* Doc viewer (60%) */}
        <div data-testid="doc-viewer" style={{
          flex: '0 0 50%',
          padding: '40px 56px',
          overflow: 'auto',
          borderRight: '1px solid var(--border)',
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

        {/* Preview pane (40%) */}
        <div data-testid="preview-pane" style={{
          flex: '0 0 50%',
          display: 'flex',
          flexDirection: 'column',
          background: 'var(--bg-elev)',
        }}>
          <div style={{
            padding: '12px 20px',
            borderBottom: '1px solid var(--border)',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            fontSize: '12px',
            color: 'var(--text-dim)',
            textTransform: 'uppercase',
            letterSpacing: '0.05em',
          }}>
            <span>Preview</span>
            <span style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
              {renderedAt && <span>Last rendered {renderedAgo}</span>}
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
                  title="Open the rendered app in a new tab"
                >
                  ↗ Open in new tab
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
                <span className="mx-spinner" /> Compiling your app…
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
                Click <strong>Render</strong> to see your app come to life.
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Bottom action bar */}
      <footer style={{
        borderTop: '1px solid var(--border)',
        background: 'var(--bg-elev)',
        padding: '20px 32px',
      }}>
        <div style={{ display: 'flex', gap: '12px', marginBottom: '14px' }}>
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
            placeholder="What do you want to change?"
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
            {status === 'thinking' ? <><span className="mx-spinner" /> Thinking…</> : 'Send'}
          </button>
        </div>

        {/* Action button groups */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '12px' }}>
          {/* Left: undo/redo (subtle) */}
          <div style={{ display: 'flex', gap: '6px' }}>
            <button
              data-testid="undo-btn"
              onClick={() => action('/undo', undefined, { statusMsg: 'Undoing…', autoRender: true })}
              disabled={busy || session.history.length === 0}
              className="mx-btn mx-btn-ghost"
              title="Undo last accepted edit"
            >
              ↶ Undo
            </button>
            <button
              data-testid="redo-btn"
              onClick={() => action('/redo', undefined, { statusMsg: 'Redoing…', autoRender: true })}
              disabled={busy || session.redo_stack.length === 0}
              className="mx-btn mx-btn-ghost"
              title="Redo"
            >
              ↷ Redo
            </button>
          </div>

          {/* Center: pending edit actions */}
          <div style={{ display: 'flex', gap: '8px' }}>
            <button
              data-testid="keep-btn"
              onClick={() => action('/keep', undefined, { successMsg: 'Kept', autoRender: true })}
              disabled={busy || !pending}
              className="mx-btn mx-btn-success"
            >
              ✓ Keep
            </button>
            <button
              data-testid="retry-btn"
              onClick={() => action('/retry', undefined, { statusMsg: 'Thinking…' })}
              disabled={busy || !pending}
              className="mx-btn mx-btn-secondary"
            >
              ↻ Retry
            </button>
            <button
              data-testid="forget-btn"
              onClick={() => action('/forget')}
              disabled={busy || !pending}
              className="mx-btn mx-btn-danger"
            >
              ✕ Forget
            </button>
          </div>

          {/* Right: build/ship */}
          <div style={{ display: 'flex', gap: '8px' }}>
            <button
              data-testid="render-btn"
              onClick={render}
              disabled={busy}
              className="mx-btn mx-btn-primary"
            >
              {status === 'compiling' ? <><span className="mx-spinner" /> Compiling…</> : '▷ Render'}
            </button>
            <button
              data-testid="commit-btn"
              onClick={commit}
              disabled={busy}
              className="mx-btn mx-btn-success"
            >
              {status === 'committing' ? <><span className="mx-spinner" /> Pushing…</> : '↑ Commit'}
            </button>
          </div>
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
