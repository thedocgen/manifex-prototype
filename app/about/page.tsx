import Link from 'next/link';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'About Manifex — Documentation as Code',
  description: 'Manifex turns natural-language descriptions into working apps. Documentation as code — the description IS the source of truth.',
};

export default function AboutPage() {
  return (
    <div style={{ minHeight: '100vh' }}>
      <header className="mx-brand">
        <Link href="/" style={{ textDecoration: 'none' }}>
          <span className="mx-brand-mark">Manifex</span>
        </Link>
        <span className="mx-brand-tag">Documentation as code.</span>
      </header>

      <main style={{ maxWidth: '680px', margin: '0 auto', padding: '64px 32px' }}>
        <h1 style={{
          fontFamily: 'var(--font-sans)',
          fontSize: '40px',
          fontWeight: 700,
          letterSpacing: '-0.03em',
          margin: '0 0 32px',
          lineHeight: 1.2,
        }}>
          Why is Manifex different?
        </h1>

        <div style={{ fontSize: '17px', lineHeight: 1.8, color: 'var(--text)' }}>
          <p style={{ margin: '0 0 24px' }}>
            Most tools generate code from a prompt and hand you the result. The code becomes
            the source of truth, and your original description is forgotten. Change something
            by hand, and the description and the code drift apart forever.
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
            Manifex works differently. Your description <em>is</em> the source of truth.
            The code is built from it every time — they cannot drift because there is only
            one source. When you change the description, the code follows. When the code
            is regenerated, it always matches what you wrote.
          </p>

          <p style={{ margin: '0 0 24px' }}>
            This is the principle of <strong>documentation as code</strong>: the human-readable
            description and the machine-executable code are the same artifact, not two things
            that need to be kept in sync.
          </p>

          <h2 style={{
            fontFamily: 'var(--font-sans)',
            fontSize: '24px',
            fontWeight: 600,
            margin: '48px 0 16px',
            color: 'var(--accent)',
          }}>
            What this means for you
          </h2>

          <p style={{ margin: '0 0 24px' }}>
            You describe what you want in plain language. Manifex turns that description into
            a working app. You refine the description — add features, change the layout,
            fix details — and the app updates to match. Every version of your app traces
            back to a description you can read and understand.
          </p>

          <p style={{ margin: '0 0 24px' }}>
            No code to manage. No templates to customize. No gap between what you said
            and what you got.
          </p>
        </div>

        <div style={{ marginTop: '48px' }}>
          <Link
            href="/"
            className="mx-btn mx-btn-primary"
            style={{ padding: '14px 28px', fontSize: '16px', textDecoration: 'none' }}
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
      }}>
        Manifex by Manifex Labs · Documentation as code
      </footer>
    </div>
  );
}
