import type { Metadata, Viewport } from 'next';
import '@fontsource-variable/overpass';
import 'maplibre-gl/dist/maplibre-gl.css';
import './globals.css';

export const metadata: Metadata = {
  title: 'Beautiful Streets',
  description: 'Walks designed around the most beautiful blocks, down to the side of the street.',
};

export const viewport: Viewport = { width: 'device-width', initialScale: 1, viewportFit: 'cover' };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
