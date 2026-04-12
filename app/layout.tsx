import './globals.css';

export const metadata = {
  title: 'Manifex — Your idea, fully documented',
  description: 'Describe what you want to build. Get a working app with complete technical documentation.',
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
