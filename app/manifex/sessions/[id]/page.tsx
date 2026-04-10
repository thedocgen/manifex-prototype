'use client';
import { useEffect, useState, use } from 'react';
import type { ManifexSession } from '@/lib/types';

export default function SessionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [session, setSession] = useState<ManifexSession | null>(null);
  const [prompt, setPrompt] = useState('');
  const [loading, setLoading] = useState(false);
  const [previewHtml, setPreviewHtml] = useState<string | null>(null);

  const load = async () => {
    const res = await fetch(`/api/manifex/sessions/${id}`);
    const data = await res.json();
    if (data.session) setSession(data.session);
  };

  useEffect(() => { load(); }, [id]);

  const action = async (path: string, body?: any) => {
    setLoading(true);
    try {
      const res = await fetch(`/api/manifex/sessions/${id}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      });
      const data = await res.json();
      if (data.session) setSession(data.session);
      return data;
    } finally {
      setLoading(false);
    }
  };

  const submitPrompt = async () => {
    if (!prompt.trim()) return;
    await action('/prompt', { prompt });
    setPrompt('');
  };

  const render = async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/manifex/sessions/${id}/render`, { method: 'POST' });
      const data = await res.json();
      if (data.inlined_html) setPreviewHtml(data.inlined_html);
    } finally {
      setLoading(false);
    }
  };

  if (!session) return <main style={{ padding: '2rem' }}>Loading session...</main>;

  const pending = session.pending_attempt;
  const displayContent = pending ? pending.proposed_manifest.content : session.manifest_state.content;

  return (
    <main style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
      {/* Top header */}
      <header style={{ padding: '0.75rem 1.5rem', borderBottom: '1px solid #2a2a2a', background: '#0f0f0f' }}>
        <span style={{ fontSize: '0.85rem', color: '#666' }}>
          Session {id} · sha {session.manifest_state.sha.slice(0, 12)}
          {pending && <span style={{ color: '#fbbf24', marginLeft: '0.5rem' }}>● pending attempt #{pending.attempt_number}</span>}
        </span>
      </header>

      {/* Two-pane content */}
      <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
        {/* Doc viewer */}
        <div data-testid="doc-viewer" style={{
          flex: 1, padding: '1.5rem', overflow: 'auto',
          borderRight: '1px solid #2a2a2a',
          background: pending ? '#1a1410' : '#0a0a0a',
        }}>
          <pre style={{
            margin: 0, fontFamily: 'ui-monospace, Menlo, monospace',
            whiteSpace: 'pre-wrap', fontSize: '0.9rem', lineHeight: 1.6,
            color: '#e5e5e5',
          }}>
            {displayContent}
          </pre>
          {pending && (
            <div data-testid="diff-summary" style={{
              marginTop: '1rem', padding: '0.75rem',
              background: '#2a1f0f', borderLeft: '3px solid #fbbf24', borderRadius: '4px',
              fontSize: '0.85rem', color: '#fcd34d',
            }}>
              {pending.diff_summary || 'Pending change'}
            </div>
          )}
        </div>

        {/* Preview pane */}
        <div data-testid="preview-pane" style={{ flex: 1, background: '#fff' }}>
          {previewHtml ? (
            <iframe
              data-testid="preview-iframe"
              srcDoc={previewHtml}
              style={{ width: '100%', height: '100%', border: 'none' }}
            />
          ) : (
            <div style={{ padding: '2rem', color: '#666', fontFamily: 'system-ui' }}>
              Click <strong>Render</strong> to compile the manifest and see a preview.
            </div>
          )}
        </div>
      </div>

      {/* Bottom action bar */}
      <footer style={{ borderTop: '1px solid #2a2a2a', background: '#0f0f0f', padding: '0.75rem 1.5rem' }}>
        <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.5rem' }}>
          <input
            data-testid="prompt-input"
            value={prompt}
            onChange={e => setPrompt(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && submitPrompt()}
            placeholder="Type a prompt to edit the manifest..."
            disabled={loading}
            style={{
              flex: 1, padding: '0.6rem 0.9rem',
              background: '#1a1a1a', color: '#e5e5e5',
              border: '1px solid #333', borderRadius: '6px',
              fontSize: '0.95rem',
            }}
          />
          <button
            data-testid="submit-prompt-btn"
            onClick={submitPrompt}
            disabled={loading || !prompt.trim()}
            style={{
              padding: '0.6rem 1.25rem',
              background: '#3b82f6', color: 'white',
              border: 'none', borderRadius: '6px',
              cursor: loading ? 'wait' : 'pointer',
            }}
          >
            Send
          </button>
        </div>
        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
          <ActionBtn testid="keep-btn" disabled={!pending || loading} onClick={() => action('/keep')} color="#10b981">Keep</ActionBtn>
          <ActionBtn testid="retry-btn" disabled={!pending || loading} onClick={() => action('/retry')} color="#8b5cf6">Retry</ActionBtn>
          <ActionBtn testid="forget-btn" disabled={!pending || loading} onClick={() => action('/forget')} color="#ef4444">Forget</ActionBtn>
          <ActionBtn testid="render-btn" disabled={loading} onClick={render} color="#3b82f6">Render</ActionBtn>
          <ActionBtn testid="commit-btn" disabled={loading} onClick={() => action('/commit')} color="#06b6d4">Commit</ActionBtn>
          <ActionBtn testid="undo-btn" disabled={loading || session.history.length === 0} onClick={() => action('/undo')} color="#666">Undo</ActionBtn>
          <ActionBtn testid="redo-btn" disabled={loading || session.redo_stack.length === 0} onClick={() => action('/redo')} color="#666">Redo</ActionBtn>
        </div>
      </footer>
    </main>
  );
}

function ActionBtn({ children, testid, disabled, onClick, color }: any) {
  return (
    <button
      data-testid={testid}
      onClick={onClick}
      disabled={disabled}
      style={{
        padding: '0.45rem 0.9rem',
        background: disabled ? '#222' : color,
        color: disabled ? '#555' : 'white',
        border: 'none', borderRadius: '6px',
        cursor: disabled ? 'not-allowed' : 'pointer',
        fontSize: '0.85rem', fontWeight: 500,
      }}
    >
      {children}
    </button>
  );
}
