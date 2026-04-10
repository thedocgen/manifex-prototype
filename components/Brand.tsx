import Link from 'next/link';

export function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <header className="mx-brand">
      <Link href="/manifex/projects" style={{ textDecoration: 'none' }}>
        <span className="mx-brand-mark">Manifex</span>
      </Link>
      {!compact && <span className="mx-brand-tag">Documentation as code.</span>}
    </header>
  );
}
