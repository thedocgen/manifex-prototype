'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { ManifexProject } from '@/lib/types';

export default function ProjectsPage() {
  const router = useRouter();
  const [projects, setProjects] = useState<ManifexProject[]>([]);
  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);

  const load = async () => {
    const res = await fetch('/api/manifex/projects');
    const data = await res.json();
    setProjects(data.projects || []);
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
        await load();
        router.push(`/manifex/projects/${data.project.id}`);
      }
    } finally {
      setCreating(false);
    }
  };

  return (
    <main style={{ padding: '2rem', maxWidth: '900px', margin: '0 auto' }}>
      <h1 style={{ fontSize: '2rem', margin: '0 0 1rem' }}>Manifex Projects</h1>

      <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '2rem' }}>
        <input
          data-testid="project-name-input"
          value={name}
          onChange={e => setName(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && create()}
          placeholder="New project name..."
          style={{
            flex: 1, padding: '0.6rem 0.9rem',
            background: '#1a1a1a', color: '#e5e5e5',
            border: '1px solid #333', borderRadius: '6px',
            fontSize: '0.95rem',
          }}
        />
        <button
          data-testid="create-project-btn"
          onClick={create}
          disabled={!name.trim() || creating}
          style={{
            padding: '0.6rem 1.25rem',
            background: name.trim() ? '#3b82f6' : '#333',
            color: 'white', border: 'none', borderRadius: '6px',
            cursor: name.trim() ? 'pointer' : 'not-allowed',
            fontWeight: 500,
          }}
        >
          {creating ? 'Creating...' : 'Create'}
        </button>
      </div>

      {projects.length === 0 ? (
        <p style={{ color: '#666' }}>No projects yet. Create one above.</p>
      ) : (
        <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
          {projects.map(p => (
            <li key={p.id} style={{
              padding: '1rem',
              border: '1px solid #2a2a2a',
              borderRadius: '8px',
              marginBottom: '0.5rem',
              cursor: 'pointer',
              background: '#0f0f0f',
            }}
            onClick={() => router.push(`/manifex/projects/${p.id}`)}
            data-testid={`project-${p.id}`}
            >
              <div style={{ fontWeight: 500 }}>{p.name}</div>
              <div style={{ fontSize: '0.85rem', color: '#666' }}>{p.github_repo}</div>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
