export const metadata = {
  title: 'Manifex',
  description: 'Doc-first AI development',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body style={{
        margin: 0,
        fontFamily: 'system-ui, -apple-system, sans-serif',
        backgroundColor: '#0a0a0a',
        color: '#e5e5e5',
        minHeight: '100vh',
      }}>
        {children}
      </body>
    </html>
  );
}
