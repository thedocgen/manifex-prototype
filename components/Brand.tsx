import Link from 'next/link';

export function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <header className="mx-brand">
      <Link href="/" style={{ textDecoration: 'none' }}>
        <span className="mx-brand-mark">Manifex</span>
      </Link>
      {!compact && <span className="mx-brand-tag">Spec-driven development for visionaries.</span>}
    </header>
  );
}
