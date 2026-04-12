'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { ManifexProject } from '@/lib/types';
import { TEMPLATES } from '@/lib/templates';

function timeAgo(iso: string): string {
  const t = new Date(iso).getTime();
  const diff = Date.now() - t;
  const secs = Math.floor(diff / 1000);
  if (secs < 60) return 'just now';
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins} minute${mins !== 1 ? 's' : ''} ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} hour${hrs !== 1 ? 's' : ''} ago`;
  const days = Math.floor(hrs / 24);
  return `${days} day${days !== 1 ? 's' : ''} ago`;
}

export default function HomePage() {
  const router = useRouter();
  const [builds, setBuilds] = useState<ManifexProject[]>([]);
  const [prompt, setPrompt] = useState('');
  const [creating, setCreating] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const load = async () => {
    const res = await fetch('/api/manifex/projects');
    const data = await res.json();
    setBuilds(data.projects || []);
    setLoaded(true);
  };

  useEffect(() => { load(); }, []);

  const openBuild = async (projectId: string) => {
    const res = await fetch(`/api/manifex/projects/${projectId}/sessions`, { method: 'POST' });
    const data = await res.json();
    if (data.session) router.push(`/${data.session.id}`);
  };

  // Instant template: create project with pre-built manifest + compiled HTML
  const createFromTemplate = async (templateId: string) => {
    const tpl = TEMPLATES.find(t => t.id === templateId);
    if (!tpl) return;
    setCreating(true);
    try {
      const res = await fetch('/api/manifex/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: tpl.name }),
      });
      const data = await res.json();
      if (data.project) {
        const sessRes = await fetch(`/api/manifex/projects/${data.project.id}/sessions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ manifest_state: tpl.manifestState }),
        });
        const sessData = await sessRes.json();
        if (sessData.session) {
          // Store compiled HTML for instant preview
          sessionStorage.setItem(`template-html-${sessData.session.id}`, tpl.compiledHtml);
          router.push(`/${sessData.session.id}`);
        }
      }
    } finally {
      setCreating(false);
    }
  };

  // Free-form prompt: create project, session, send prompt
  const createFromPrompt = async (buildPrompt: string) => {
    if (!buildPrompt.trim()) return;
    setCreating(true);
    try {
      const name = buildPrompt.slice(0, 60).replace(/[^\w\s]/g, '').trim();
      const res = await fetch('/api/manifex/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      const data = await res.json();
      if (data.project) {
        const sessRes = await fetch(`/api/manifex/projects/${data.project.id}/sessions`, { method: 'POST' });
        const sessData = await sessRes.json();
        if (sessData.session) {
          await fetch(`/api/manifex/sessions/${sessData.session.id}/prompt`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ prompt: buildPrompt }),
          });
          router.push(`/${sessData.session.id}`);
        }
      }
    } finally {
      setCreating(false);
    }
  };

  return (
    <div style={{ minHeight: '100vh' }}>
      <main style={{ maxWidth: '800px', margin: '0 auto', padding: '80px 32px 48px' }}>
        <div style={{ textAlign: 'center', marginBottom: '48px' }}>
          <h1 style={{
            fontFamily: 'var(--font-serif)',
            fontSize: '48px',
            fontWeight: 700,
            letterSpacing: '-0.03em',
            margin: '0 0 16px',
            lineHeight: 1.1,
          }}>
            Manifex
          </h1>
          <p style={{
            fontSize: '18px',
            color: 'var(--text-muted)',
            margin: '0 0 40px',
            lineHeight: 1.6,
            maxWidth: '480px',
            marginLeft: 'auto',
            marginRight: 'auto',
          }}>
            Describe an app in plain language. Get a working product with full documentation.
          </p>

          {/* Main prompt input */}
          <div style={{
            background: 'var(--bg-card)',
            border: '1px solid var(--border)',
            borderRadius: '16px',
            padding: '20px',
            boxShadow: '0 4px 16px rgba(0, 0, 0, 0.04)',
          }}>
            <textarea
              data-testid="home-prompt-input"
              value={prompt}
              onChange={e => setPrompt(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  createFromPrompt(prompt);
                }
              }}
              placeholder="Describe what you want to build..."
              disabled={creating}
              rows={2}
              style={{
                width: '100%', resize: 'none', fontFamily: 'var(--font-sans)',
                fontSize: '16px', border: 'none', background: 'transparent',
                padding: 0, marginBottom: '12px', outline: 'none',
              }}
            />
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <button
                data-testid="home-create-btn"
                onClick={() => createFromPrompt(prompt)}
                disabled={!prompt.trim() || creating}
                className="mx-btn mx-btn-primary"
                style={{ padding: '12px 24px', fontSize: '15px' }}
              >
                {creating ? <><span className="mx-spinner" /> Building…</> : 'Tell me →'}
              </button>
            </div>
          </div>
        </div>

        {/* Instant templates */}
        {TEMPLATES.length > 0 && (
          <div style={{ marginBottom: '48px' }}>
            <h2 style={{
              fontSize: '14px',
              fontWeight: 500,
              color: 'var(--text-dim)',
              margin: '0 0 16px',
              textAlign: 'center',
              textTransform: 'uppercase',
              letterSpacing: '0.05em',
            }}>
              Start from a template
            </h2>
            <div style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
              gap: '16px',
            }}>
              {TEMPLATES.map(t => (
                <button
                  key={t.id}
                  onClick={() => createFromTemplate(t.id)}
                  disabled={creating}
                  className="mx-card"
                  style={{ textAlign: 'left', border: '1px solid var(--border)', padding: '20px 24px' }}
                >
                  <div style={{ fontSize: '15px', fontWeight: 600, marginBottom: '6px', color: 'var(--text)' }}>
                    {t.name}
                  </div>
                  <div style={{ fontSize: '13px', color: 'var(--text-muted)', lineHeight: 1.5 }}>
                    {t.description}
                  </div>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Existing apps */}
        {loaded && builds.filter(b => !b.name.startsWith('TPL:') && !b.name.startsWith('R3 ') && !b.name.startsWith('R4 ')).length > 0 && (
          <div>
            <h2 style={{
              fontSize: '14px',
              fontWeight: 500,
              color: 'var(--text-dim)',
              margin: '0 0 12px',
              textTransform: 'uppercase',
              letterSpacing: '0.05em',
            }}>
              Your apps
            </h2>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
              {builds.filter(b => !b.name.startsWith('TPL:') && !b.name.startsWith('R3 ') && !b.name.startsWith('R4 ')).map(b => (
                <div
                  key={b.id}
                  className="mx-card"
                  onClick={() => openBuild(b.id)}
                  data-testid={`build-${b.id}`}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                    <h3 style={{ fontFamily: 'var(--font-serif)', fontSize: '18px', fontWeight: 600, margin: 0 }}>{b.name}</h3>
                    <span style={{ fontSize: '13px', color: 'var(--text-dim)' }}>{timeAgo(b.created_at)}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </main>

      <footer style={{
        borderTop: '1px solid var(--border)',
        padding: '24px 32px',
        textAlign: 'center',
        fontSize: '13px',
        color: 'var(--text-dim)',
      }}>
        <span>Manifex by Manifex Labs · Documentation as code</span>
        <span style={{ margin: '0 8px' }}>·</span>
        <a href="/about" style={{ color: 'var(--text-dim)', textDecoration: 'underline' }}>
          Why is Manifex different?
        </a>
      </footer>
    </div>
  );
}
