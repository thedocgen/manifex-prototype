import Link from 'next/link';

export default function Home() {
  return (
    <main style={{ padding: '4rem 2rem', maxWidth: '720px', margin: '0 auto' }}>
      <h1 style={{ fontSize: '3rem', margin: '0 0 1rem', fontWeight: 700 }}>Manifex</h1>
      <p style={{ fontSize: '1.25rem', color: '#a3a3a3', margin: '0 0 2rem' }}>
        Doc-first AI development. Write what you want — get a working app.
      </p>
      <Link
        href="/manifex/projects"
        style={{
          display: 'inline-block',
          padding: '0.75rem 1.5rem',
          background: '#3b82f6',
          color: 'white',
          borderRadius: '8px',
          textDecoration: 'none',
          fontWeight: 500,
        }}
      >
        Open Projects →
      </Link>
    </main>
  );
}
