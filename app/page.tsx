import Link from 'next/link';

export default function Home() {
  return (
    <div>
      <header className="mx-brand">
        <span className="mx-brand-mark">Manifex</span>
        <span className="mx-brand-tag">Documentation as code.</span>
      </header>
      <main style={{ padding: '64px 32px', maxWidth: '720px', margin: '0 auto', textAlign: 'center' }}>
        <h1 style={{
          fontFamily: 'var(--font-serif)',
          fontSize: '48px',
          fontWeight: 600,
          letterSpacing: '-0.03em',
          margin: '0 0 16px',
          lineHeight: 1.1,
        }}>
          Write your software<br />in plain English.
        </h1>
        <p style={{
          fontSize: '18px',
          color: 'var(--text-muted)',
          margin: '0 0 40px',
          lineHeight: 1.5,
        }}>
          Manifex turns natural-language documentation into a working app.<br />
          You iterate on the doc. The code follows.
        </p>
        <Link href="/manifex/projects" className="mx-btn mx-btn-primary" style={{ padding: '14px 28px', fontSize: '16px' }}>
          Open Projects →
        </Link>
      </main>
    </div>
  );
}
