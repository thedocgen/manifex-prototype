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

export default function ProjectsPage() {
  const router = useRouter();
  const [projects, setProjects] = useState<ManifexProject[]>([]);
  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const load = async () => {
    const res = await fetch('/api/manifex/projects');
    const data = await res.json();
    setProjects(data.projects || []);
    setLoaded(true);
  };

  useEffect(() => { load(); }, []);

  const create = async () => {
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
        router.push(`/manifex/projects/${data.project.id}`);
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
            Your Projects
          </h1>
          <p style={{ color: 'var(--text-muted)', margin: 0 }}>
            Each project is a self-contained app you can iterate on through documentation.
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
              data-testid="project-name-input"
              value={name}
              onChange={e => setName(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && create()}
              placeholder="Give your project a name…"
              style={{ flex: 1 }}
            />
            <button
              data-testid="create-project-btn"
              onClick={create}
              disabled={!name.trim() || creating}
              className="mx-btn mx-btn-primary"
            >
              {creating ? <><span className="mx-spinner" /> Creating…</> : 'Create →'}
            </button>
          </div>
        </div>

        {/* Projects list */}
        {!loaded ? null : projects.length === 0 ? (
          <div className="mx-empty">
            <div className="mx-empty-icon">✦</div>
            <h2>Start your first project</h2>
            <p>Manifex builds software from natural language. Begin by giving your project a name above.</p>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            {projects.map(p => (
              <div
                key={p.id}
                className="mx-card"
                onClick={() => router.push(`/manifex/projects/${p.id}`)}
                data-testid={`project-${p.id}`}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                  <h3 style={{
                    fontFamily: 'var(--font-serif)',
                    fontSize: '20px',
                    fontWeight: 600,
                    margin: 0,
                    letterSpacing: '-0.01em',
                  }}>{p.name}</h3>
                  <span style={{ fontSize: '13px', color: 'var(--text-dim)' }}>{timeAgo(p.created_at)}</span>
                </div>
                <p style={{
                  fontStyle: 'italic',
                  color: 'var(--text-muted)',
                  fontSize: '14px',
                  margin: '6px 0 0',
                }}>
                  {p.github_repo}
                </p>
              </div>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
