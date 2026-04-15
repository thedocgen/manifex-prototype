import './globals.css';
import { PRODUCT_NAME } from '@/lib/branding';

export const metadata = {
  title: `${PRODUCT_NAME} — Spec-driven development for visionaries`,
  description: 'Describe your idea. Get a thorough technical specification and a working app built from it.',
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
