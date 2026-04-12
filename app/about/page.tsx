import Link from 'next/link';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Why Manifex is different — Complete documentation, not black boxes',
  description: 'Manifex is the professional AI builder that produces thorough documentation alongside working apps. Architecture diagrams, data models, page specs, style guides — you understand and own everything.',
};

export default function AboutPage() {
  return (
    <div style={{ minHeight: '100vh', fontFamily: 'var(--font-sans)' }}>
      <header className="mx-brand">
        <Link href="/" style={{ textDecoration: 'none' }}>
          <span className="mx-brand-mark">Manifex</span>
        </Link>
        <span className="mx-brand-tag">Your idea, fully documented.</span>
      </header>

      <main style={{ maxWidth: '680px', margin: '0 auto', padding: '64px 32px' }}>
        <h1 style={{
          fontFamily: 'var(--font-sans)',
          fontSize: '40px',
          fontWeight: 700,
          letterSpacing: '-0.03em',
          margin: '0 0 32px',
          lineHeight: 1.2,
          color: 'var(--text)',
        }}>
          Why Manifex is different
        </h1>

        <div style={{ fontSize: '17px', lineHeight: 1.8, color: 'var(--text)', fontFamily: 'var(--font-sans)' }}>
          <p style={{ margin: '0 0 24px' }}>
            Other AI builders generate code from a prompt and hand you the result. You get a
            working app — but also a black box. No architecture overview, no data model
            reference, no explanation of how the pieces fit together. Change something and
            you are guessing at what might break.
          </p>

          <h2 style={{
            fontFamily: 'var(--font-sans)',
            fontSize: '24px',
            fontWeight: 600,
            margin: '48px 0 16px',
            color: 'var(--accent)',
          }}>
            Documentation is the product
          </h2>

          <p style={{ margin: '0 0 24px' }}>
            Manifex creates complete technical documentation alongside your app — architecture
            diagrams, data models, page specs, style guides. Every component, every endpoint,
            every design decision is captured in plain language you can read and understand.
            You don't just get an app. You get full ownership of how it works.
          </p>

          <h2 style={{
            fontFamily: 'var(--font-sans)',
            fontSize: '24px',
            fontWeight: 600,
            margin: '48px 0 16px',
            color: 'var(--accent)',
          }}>
            Documentation as code
          </h2>

          <p style={{ margin: '0 0 24px' }}>
            The documentation isn't a byproduct — it is the source of truth. Your docs define
            the architecture, the data model, the page structure. The code is built from them.
            Change the docs and the app follows. They cannot drift apart because the docs
            drive the build.
          </p>

          <p style={{ margin: '0 0 24px' }}>
            This is the principle of <strong>documentation as code</strong>: the human-readable
            specification and the machine-executable application are one system, not two things
            that need to be kept in sync.
          </p>

          <h2 style={{
            fontFamily: 'var(--font-sans)',
            fontSize: '24px',
            fontWeight: 600,
            margin: '48px 0 16px',
            color: 'var(--accent)',
          }}>
            What you get
          </h2>

          <p style={{ margin: '0 0 24px' }}>
            Describe what you want in plain language. Manifex produces a working app and a
            complete documentation package: architecture diagrams, data models, page-by-page
            specs, a style guide, and deployment notes. Refine the description, add features,
            change the layout — the docs and the app update together.
          </p>

          <p style={{ margin: '0 0 24px' }}>
            No black boxes. No undocumented magic. Everything you built, explained and yours.
          </p>
        </div>

        <div style={{ marginTop: '48px' }}>
          <Link
            href="/"
            className="mx-btn mx-btn-primary"
            style={{ padding: '14px 28px', fontSize: '16px', textDecoration: 'none', fontFamily: 'var(--font-sans)' }}
          >
            Start building →
          </Link>
        </div>
      </main>

      <footer style={{
        borderTop: '1px solid var(--border)',
        padding: '24px 32px',
        textAlign: 'center',
        fontSize: '13px',
        color: 'var(--text-dim)',
        fontFamily: 'var(--font-sans)',
      }}>
        Manifex by Manifex Labs · Your idea, fully documented.
      </footer>
    </div>
  );
}
