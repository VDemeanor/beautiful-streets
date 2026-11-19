import App from './App';

// Read settings when the page is requested, so a key added later needs no rebuild.
export const dynamic = 'force-dynamic';

export default function Page() {
  return (
    <App
      mapStyle={process.env.NEXT_PUBLIC_MAP_STYLE || 'https://tiles.openfreemap.org/styles/liberty'}
      googleKey={process.env.GOOGLE_MAPS_KEY || ''}
    />
  );
}
