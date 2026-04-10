'use client';
import { useEffect, useState, use } from 'react';
import { useRouter } from 'next/navigation';
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
      if (data.session) {
        router.push(`/manifex/sessions/${data.session.id}`);
      }
    } finally {
      setStarting(false);
    }
  };

  if (!project) return <main style={{ padding: '2rem' }}>Loading...</main>;

  return (
    <main style={{ padding: '2rem', maxWidth: '900px', margin: '0 auto' }}>
      <button
        onClick={() => router.push('/manifex/projects')}
        style={{ background: 'none', border: 'none', color: '#666', cursor: 'pointer', marginBottom: '1rem' }}
      >
        ← Back to projects
      </button>
      <h1 style={{ fontSize: '2rem', margin: '0 0 0.5rem' }}>{project.name}</h1>
      <p style={{ color: '#666', margin: '0 0 2rem' }}>{project.github_repo}</p>

      <button
        data-testid="start-session-btn"
        onClick={startSession}
        disabled={starting}
        style={{
          padding: '0.75rem 1.5rem',
          background: '#3b82f6',
          color: 'white', border: 'none', borderRadius: '8px',
          cursor: 'pointer', fontWeight: 500,
        }}
      >
        {starting ? 'Starting...' : 'Start Session →'}
      </button>
    </main>
  );
}
