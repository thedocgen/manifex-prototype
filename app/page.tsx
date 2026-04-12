'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { ManifexProject } from '@/lib/types';

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

  // Start brainstorming: create project + session, navigate to editor (planning phase kicks in)
  const startBrainstorm = async () => {
    setCreating(true);
    try {
      const res = await fetch('/api/manifex/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'New project' }),
      });
      const data = await res.json();
      if (data.project) {
        const sessRes = await fetch(`/api/manifex/projects/${data.project.id}/sessions`, { method: 'POST' });
        const sessData = await sessRes.json();
        if (sessData.session) {
          // Send the brainstorm prompt to trigger planning phase
          await fetch(`/api/manifex/sessions/${sessData.session.id}/prompt`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ prompt: "I have a rough idea but I'm not sure how to shape it yet. Can you help me think through it?" }),
          });
          router.push(`/${sessData.session.id}`);
        }
      }
    } finally {
      setCreating(false);
    }
  };

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

  const userApps = builds.filter(b =>
    !b.name.startsWith('TPL:') && !b.name.startsWith('QTpl:') &&
    !b.name.startsWith('R3 ') && !b.name.startsWith('R4 ') &&
    !b.name.startsWith('Diagram ')
  );

  return (
    <div style={{ minHeight: '100vh' }}>
      <main style={{ maxWidth: '640px', margin: '0 auto', padding: '120px 32px 64px' }}>
        <div style={{ textAlign: 'center', marginBottom: '48px' }}>
          <h1 style={{
            fontFamily: 'var(--font-sans)',
            fontSize: '36px',
            fontWeight: 700,
            letterSpacing: '-0.03em',
            margin: '0 0 12px',
            lineHeight: 1.15,
            color: 'var(--text)',
          }}>
            Manifex
          </h1>
          <p style={{
            fontSize: '18px',
            color: 'var(--text-muted)',
            margin: '0 0 8px',
            lineHeight: 1.4,
            fontWeight: 500,
          }}>
            Spec-driven development for visionaries.
          </p>
          <p style={{
            fontSize: '15px',
            color: 'var(--text-dim)',
            margin: '0 0 40px',
            lineHeight: 1.6,
            maxWidth: '460px',
            marginLeft: 'auto',
            marginRight: 'auto',
          }}>
            Describe your idea. Get a thorough technical specification and a working app built from it.
          </p>

          {/* Prompt input */}
          <div style={{
            background: 'var(--bg-card)',
            border: '1px solid var(--border)',
            borderRadius: '8px',
            padding: '20px',
            boxShadow: '0 1px 3px rgba(0, 0, 0, 0.06)',
            marginBottom: '16px',
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
              placeholder="What's your idea?"
              disabled={creating}
              rows={3}
              style={{
                width: '100%', resize: 'none', fontFamily: 'var(--font-sans)',
                fontSize: '16px', border: 'none', background: 'transparent',
                padding: 0, marginBottom: '12px', outline: 'none',
                color: 'var(--text)',
              }}
            />
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <button
                data-testid="home-create-btn"
                onClick={() => createFromPrompt(prompt)}
                disabled={!prompt.trim() || creating}
                className="mx-btn mx-btn-primary"
                style={{ padding: '10px 24px', fontSize: '14px' }}
              >
                {creating ? <><span className="mx-spinner" /> Working...</> : 'Start'}
              </button>
            </div>
          </div>

          {/* Brainstorm link */}
          <button
            onClick={startBrainstorm}
            disabled={creating}
            style={{
              background: 'none',
              border: 'none',
              color: 'var(--accent)',
              fontSize: '14px',
              cursor: 'pointer',
              padding: '4px 0',
            }}
          >
            Not sure yet? Start a conversation and we'll figure it out together.
          </button>

          {/* Ambient inspiration */}
          <p style={{
            fontSize: '13px',
            color: 'var(--text-dim)',
            margin: '32px 0 0',
            lineHeight: 1.5,
          }}>
            People have built client portals, event pages, internal tools, and personal dashboards.
          </p>
        </div>

        {/* Existing apps */}
        {loaded && userApps.length > 0 && (
          <div>
            <h2 style={{
              fontSize: '13px',
              fontWeight: 500,
              color: 'var(--text-dim)',
              margin: '0 0 12px',
              textTransform: 'uppercase',
              letterSpacing: '0.05em',
            }}>
              Your apps
            </h2>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {userApps.map(b => (
                <div
                  key={b.id}
                  className="mx-card"
                  onClick={() => openBuild(b.id)}
                  data-testid={`build-${b.id}`}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                    <h3 style={{ fontSize: '15px', fontWeight: 600, margin: 0 }}>{b.name}</h3>
                    <span style={{ fontSize: '12px', color: 'var(--text-dim)' }}>{timeAgo(b.created_at)}</span>
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
        <span>Manifex by Manifex Labs</span>
        <span style={{ margin: '0 8px' }}>·</span>
        <a href="/about" style={{ color: 'var(--text-dim)', textDecoration: 'underline' }}>
          Why is Manifex different?
        </a>
      </footer>
    </div>
  );
}
