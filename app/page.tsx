'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Brand } from '@/components/Brand';
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

export default function BuildsPage() {
  const router = useRouter();
  const [builds, setBuilds] = useState<ManifexProject[]>([]);
  const [name, setName] = useState('');
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

  const createBuild = async () => {
    if (!name.trim()) return;
    setCreating(true);
    try {
      const res = await fetch('/api/manifex/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      const data = await res.json();
      if (data.project) {
        setName('');
        await openBuild(data.project.id);
      }
    } finally {
      setCreating(false);
    }
  };

  return (
    <div>
      <Brand />
      <main style={{ maxWidth: '720px', margin: '0 auto', padding: '48px 32px' }}>
        <div style={{ marginBottom: '40px' }}>
          <h1 style={{
            fontFamily: 'var(--font-serif)',
            fontSize: '36px',
            fontWeight: 600,
            letterSpacing: '-0.02em',
            margin: '0 0 8px',
          }}>
            Your Builds
          </h1>
          <p style={{ color: 'var(--text-muted)', margin: 0 }}>
            Each build is an app you can create and refine just by describing what you want.
          </p>
        </div>

        {/* Create form */}
        <div style={{
          background: 'var(--bg-card)',
          border: '1px solid var(--border)',
          borderRadius: '12px',
          padding: '24px',
          marginBottom: '32px',
        }}>
          <label style={{
            display: 'block',
            fontSize: '13px',
            fontWeight: 500,
            color: 'var(--text-muted)',
            textTransform: 'uppercase',
            letterSpacing: '0.05em',
            marginBottom: '10px',
          }}>
            Start something new
          </label>
          <div style={{ display: 'flex', gap: '12px' }}>
            <input
              data-testid="build-name-input"
              value={name}
              onChange={e => setName(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && createBuild()}
              placeholder="Give your app a name…"
              style={{ flex: 1 }}
            />
            <button
              data-testid="create-build-btn"
              onClick={createBuild}
              disabled={!name.trim() || creating}
              className="mx-btn mx-btn-primary"
            >
              {creating ? <><span className="mx-spinner" /> Creating…</> : 'Create →'}
            </button>
          </div>
        </div>

        {/* Builds list */}
        {!loaded ? null : builds.length === 0 ? (
          <div className="mx-empty">
            <div className="mx-empty-icon">✦</div>
            <h2>Start your first build</h2>
            <p>Describe what you want and watch it come to life. No code required.</p>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            {builds.map(b => (
              <div
                key={b.id}
                className="mx-card"
                onClick={() => openBuild(b.id)}
                data-testid={`build-${b.id}`}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                  <h3 style={{
                    fontFamily: 'var(--font-serif)',
                    fontSize: '20px',
                    fontWeight: 600,
                    margin: 0,
                    letterSpacing: '-0.01em',
                  }}>{b.name}</h3>
                  <span style={{ fontSize: '13px', color: 'var(--text-dim)' }}>{timeAgo(b.created_at)}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
