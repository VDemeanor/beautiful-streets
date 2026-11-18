import App from './App';

export default function Page() {
  return <App mapStyle={process.env.NEXT_PUBLIC_MAP_STYLE || 'https://tiles.openfreemap.org/styles/positron'} />;
}
