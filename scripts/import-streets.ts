import { importStreets } from '../src/lib/store';

const demo = process.argv.includes('--demo');
importStreets(demo ? 'demo' : 'osm')
  .then((blocks) => {
    console.log(`Imported ${blocks.length} blocks (${demo ? 'demo grid' : 'OpenStreetMap'}).`);
    process.exit(0);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
