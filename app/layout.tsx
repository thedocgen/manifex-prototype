import './globals.css';

export const metadata = {
  title: 'Manifex — Documentation as Code',
  description: 'Doc-first AI development. Write what you want — get a working app.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
      </head>
      <body>{children}</body>
    </html>
  );
}
