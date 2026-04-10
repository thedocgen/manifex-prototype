'use client';
import { useEffect, useState, use } from 'react';
import { useRouter } from 'next/navigation';
import { Brand } from '@/components/Brand';
import type { ManifexProject } from '@/lib/types';

export default function ProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const [project, setProject] = useState<ManifexProject | null>(null);
  const [starting, setStarting] = useState(false);

  useEffect(() => {
    fetch(`/api/manifex/projects/${id}`)
      .then(r => r.json())
      .then(d => setProject(d.project));
  }, [id]);

  const startSession = async () => {
    setStarting(true);
    try {
      const res = await fetch(`/api/manifex/projects/${id}/sessions`, { method: 'POST' });
      const data = await res.json();
      if (data.session) router.push(`/manifex/sessions/${data.session.id}`);
    } finally {
      setStarting(false);
    }
  };

  return (
    <div>
      <Brand />
      <main style={{ maxWidth: '720px', margin: '0 auto', padding: '48px 32px' }}>
        <button
          onClick={() => router.push('/manifex/projects')}
          className="mx-btn mx-btn-ghost"
          style={{ marginBottom: '24px', padding: '6px 12px' }}
        >
          ← Back to projects
        </button>

        {!project ? (
          <p style={{ color: 'var(--text-muted)' }}>Loading…</p>
        ) : (
          <>
            <h1 style={{
              fontFamily: 'var(--font-serif)',
              fontSize: '40px',
              fontWeight: 600,
              letterSpacing: '-0.02em',
              margin: '0 0 8px',
            }}>{project.name}</h1>
            <p style={{
              fontStyle: 'italic',
              color: 'var(--text-muted)',
              margin: '0 0 32px',
            }}>{project.github_repo}</p>

            <button
              data-testid="start-session-btn"
              onClick={startSession}
              disabled={starting}
              className="mx-btn mx-btn-primary"
              style={{ padding: '14px 28px', fontSize: '16px' }}
            >
              {starting ? <><span className="mx-spinner" /> Starting…</> : 'Start Session →'}
            </button>
          </>
        )}
      </main>
    </div>
  );
}
