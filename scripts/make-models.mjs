// Builds the small 3D vehicle models used for traffic, as binary glTF files in
// public/models. Each vehicle is a handful of boxes: body, cabin glass, wheels
// and lights. Front of the vehicle is +Z, up is +Y, units are metres.
import { mkdirSync, writeFileSync } from 'node:fs';

/** boxes: [{ min:[x,y,z], max:[x,y,z], mat:number }], materials: glTF material objects. */
export function buildGlb(boxes, materials) {
  const groups = materials.map(() => ({ pos: [], nor: [], idx: [] }));
  const faces = [
    [[0, 0, 1], [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]]],
    [[0, 0, -1], [[1, 0, 0], [0, 0, 0], [0, 1, 0], [1, 1, 0]]],
    [[1, 0, 0], [[1, 0, 1], [1, 0, 0], [1, 1, 0], [1, 1, 1]]],
    [[-1, 0, 0], [[0, 0, 0], [0, 0, 1], [0, 1, 1], [0, 1, 0]]],
    [[0, 1, 0], [[0, 1, 1], [1, 1, 1], [1, 1, 0], [0, 1, 0]]],
    [[0, -1, 0], [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]]],
  ];
  for (const b of boxes) {
    const g = groups[b.mat];
    for (const [n, corners] of faces) {
      const base = g.pos.length / 3;
      for (const c of corners) {
        g.pos.push(c[0] ? b.max[0] : b.min[0], c[1] ? b.max[1] : b.min[1], c[2] ? b.max[2] : b.min[2]);
        g.nor.push(...n);
      }
      g.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
  }
  const chunks = [];
  const bufferViews = [];
  const accessors = [];
  const primitives = [];
  let offset = 0;
  const push = (typed, target) => {
    const bytes = new Uint8Array(typed.buffer, typed.byteOffset, typed.byteLength);
    const pad = (4 - (bytes.length % 4)) % 4;
    bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: bytes.length, target });
    chunks.push(bytes, new Uint8Array(pad));
    offset += bytes.length + pad;
    return bufferViews.length - 1;
  };
  groups.forEach((g, m) => {
    if (!g.idx.length) return;
    const pos = new Float32Array(g.pos);
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < pos.length; i += 3) for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k], pos[i + k]);
      max[k] = Math.max(max[k], pos[i + k]);
    }
    const p = accessors.push({ bufferView: push(pos, 34962), componentType: 5126, count: pos.length / 3, type: 'VEC3', min, max }) - 1;
    const n = accessors.push({ bufferView: push(new Float32Array(g.nor), 34962), componentType: 5126, count: g.nor.length / 3, type: 'VEC3' }) - 1;
    const i = accessors.push({ bufferView: push(new Uint16Array(g.idx), 34963), componentType: 5123, count: g.idx.length, type: 'SCALAR' }) - 1;
    primitives.push({ attributes: { POSITION: p, NORMAL: n }, indices: i, material: m });
  });
  const json = {
    asset: { version: '2.0', generator: 'beautiful-streets' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives }],
    materials,
    accessors,
    bufferViews,
    buffers: [{ byteLength: offset }],
  };
  let jsonBytes = new TextEncoder().encode(JSON.stringify(json));
  const jsonPad = (4 - (jsonBytes.length % 4)) % 4;
  const out = new Uint8Array(12 + 8 + jsonBytes.length + jsonPad + 8 + offset);
  const view = new DataView(out.buffer);
  view.setUint32(0, 0x46546c67, true); // "glTF"
  view.setUint32(4, 2, true);
  view.setUint32(8, out.length, true);
  view.setUint32(12, jsonBytes.length + jsonPad, true);
  view.setUint32(16, 0x4e4f534a, true); // "JSON"
  out.set(jsonBytes, 20);
  out.fill(0x20, 20 + jsonBytes.length, 20 + jsonBytes.length + jsonPad);
  let at = 20 + jsonBytes.length + jsonPad;
  view.setUint32(at, offset, true);
  view.setUint32(at + 4, 0x004e4942, true); // "BIN"
  at += 8;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

const paint = (rgb, metallic = 0.35, rough = 0.45) => ({ pbrMetallicRoughness: { baseColorFactor: [...rgb, 1], metallicFactor: metallic, roughnessFactor: rough } });
const lamp = (rgb) => ({ pbrMetallicRoughness: { baseColorFactor: [...rgb, 1], metallicFactor: 0, roughnessFactor: 0.4 }, emissiveFactor: rgb });
const GLASS = paint([0.09, 0.13, 0.17], 0.6, 0.15);
const TYRE = paint([0.06, 0.06, 0.06], 0, 0.9);

/** An ordinary car, about 4.4 m long. */
export function car(body) {
  const materials = [paint(body), GLASS, TYRE, lamp([1, 0.96, 0.82]), lamp([0.85, 0.08, 0.06])];
  const w = 0.9;
  const wheel = (x, z) => ({ min: [x - 0.12, 0, z - 0.33], max: [x + 0.12, 0.66, z + 0.33], mat: 2 });
  const boxes = [
    { min: [-w, 0.3, -2.2], max: [w, 0.88, 2.2], mat: 0 }, // body
    { min: [-w + 0.04, 0.88, 1.0], max: [w - 0.04, 0.98, 2.15], mat: 0 }, // bonnet rise
    { min: [-w + 0.1, 0.88, -1.45], max: [w - 0.1, 1.44, 0.95], mat: 1 }, // cabin glass
    { min: [-w + 0.08, 1.44, -1.3], max: [w - 0.08, 1.5, 0.75], mat: 0 }, // roof
    wheel(-w + 0.06, 1.35), wheel(w - 0.06, 1.35), wheel(-w + 0.06, -1.35), wheel(w - 0.06, -1.35),
    { min: [-w + 0.1, 0.58, 2.2], max: [-w + 0.5, 0.76, 2.23], mat: 3 }, { min: [w - 0.5, 0.58, 2.2], max: [w - 0.1, 0.76, 2.23], mat: 3 },
    { min: [-w + 0.1, 0.6, -2.23], max: [-w + 0.5, 0.76, -2.2], mat: 4 }, { min: [w - 0.5, 0.6, -2.23], max: [w - 0.1, 0.76, -2.2], mat: 4 },
  ];
  return buildGlb(boxes, materials);
}

/** A San Francisco cable car: maroon below, cream above, open at the front. */
export function cableCar() {
  const materials = [paint([0.42, 0.07, 0.09], 0.1, 0.6), paint([0.93, 0.88, 0.74], 0, 0.7), GLASS, TYRE, lamp([1, 0.95, 0.75]), paint([0.72, 0.6, 0.25], 0.8, 0.35)];
  const w = 1.2;
  const post = (x, z) => ({ min: [x - 0.05, 1.25, z - 0.05], max: [x + 0.05, 2.75, z + 0.05], mat: 1 });
  const boxes = [
    { min: [-w, 0.35, -4.2], max: [w, 1.25, 4.2], mat: 0 }, // lower body
    { min: [-w - 0.08, 0.55, -4.25], max: [w + 0.08, 0.68, 4.25], mat: 5 }, // gold stripe
    { min: [-w + 0.05, 1.25, -4.1], max: [w - 0.05, 2.35, -0.2], mat: 2 }, // enclosed rear cabin windows
    { min: [-w, 2.35, -4.1], max: [w, 2.5, -0.2], mat: 1 },
    { min: [-w - 0.1, 2.75, -4.35], max: [w + 0.1, 2.95, 4.35], mat: 1 }, // roof
    { min: [-0.5, 2.95, -3.2], max: [0.5, 3.15, 3.2], mat: 1 }, // clerestory
    post(-w + 0.06, 0.3), post(w - 0.06, 0.3), post(-w + 0.06, 2.1), post(w - 0.06, 2.1), post(-w + 0.06, 4.0), post(w - 0.06, 4.0),
    { min: [-w - 0.25, 0.35, 0.2], max: [-w, 0.45, 4.0], mat: 0 }, { min: [w, 0.35, 0.2], max: [w + 0.25, 0.45, 4.0], mat: 0 }, // running boards
    { min: [-0.25, 1.3, 4.2], max: [0.25, 1.6, 4.26], mat: 4 }, // headlamp
    { min: [-w + 0.1, 0, 2.6], max: [w - 0.1, 0.4, 3.4], mat: 3 }, { min: [-w + 0.1, 0, -3.4], max: [w - 0.1, 0.4, -2.6], mat: 3 }, // trucks
  ];
  return buildGlb(boxes, materials);
}

/** A bay ferry, about 40 m long: dark hull, white decks, a wheelhouse forward. */
export function ferry() {
  const materials = [paint([0.07, 0.14, 0.26], 0.1, 0.6), paint([0.95, 0.95, 0.93], 0, 0.6), GLASS, paint([0.8, 0.2, 0.12], 0.1, 0.6), lamp([1, 0.95, 0.8])];
  const w = 5;
  const boxes = [
    { min: [-w, 0, -19], max: [w, 2.2, 17], mat: 0 }, // hull
    { min: [-w * 0.6, 0, 17], max: [w * 0.6, 2.2, 20.5], mat: 0 }, // bow
    { min: [-w, 2.2, -19], max: [w, 2.5, 17], mat: 3 }, // red sheer line
    { min: [-w + 0.4, 2.5, -17], max: [w - 0.4, 5.2, 13], mat: 1 }, // main deck cabin
    { min: [-w + 0.35, 3.3, -16.5], max: [w - 0.35, 4.4, 12.5], mat: 2 }, // window band
    { min: [-w + 1, 5.2, -15], max: [w - 1, 7.6, 8], mat: 1 }, // upper deck
    { min: [-w + 0.95, 5.9, -14.5], max: [w - 0.95, 6.9, 7.5], mat: 2 },
    { min: [-2.4, 7.6, 2], max: [2.4, 9.8, 7.5], mat: 1 }, // wheelhouse
    { min: [-2.45, 8.4, 2.5], max: [2.45, 9.3, 7.55], mat: 2 },
    { min: [-1, 7.6, -9], max: [1, 10.6, -6.5], mat: 3 }, // funnel
    { min: [-0.3, 9.8, 4], max: [0.3, 12.5, 4.6], mat: 1 }, // mast
    { min: [-0.3, 12.5, 4], max: [0.3, 12.9, 4.6], mat: 4 },
  ];
  return buildGlb(boxes, materials);
}

/** The walker at one moment of the stride. Keep in step with pose() in src/app/walker.ts. */
export function walker(phase) {
  const materials = [paint([0.89, 0.33, 0.18], 0, 0.7), paint([0.14, 0.17, 0.27], 0, 0.8), paint([0.9, 0.69, 0.54], 0, 0.7), paint([0.23, 0.16, 0.11], 0, 0.8), paint([0.96, 0.95, 0.93], 0, 0.6), paint([0.12, 0.34, 0.45], 0, 0.7)];
  const [JACKET, TROUSERS, SKIN, HAIR, SHOE, PACK] = [0, 1, 2, 3, 4, 5];
  const s = Math.sin(phase);
  const c = Math.cos(phase);
  const bob = 0.03 * Math.abs(c);
  const parts = [];
  const part = (x, z, w, d, y0, y1, mat) => parts.push({ min: [x - w / 2, y0, z - d / 2], max: [x + w / 2, y1, z + d / 2], mat });
  for (const side of [-1, 1]) {
    const swing = s * side;
    const lift = Math.max(0, c * side) * 0.11;
    part(0.11 * side, 0.3 * swing + 0.05, 0.17, 0.3, lift, lift + 0.09, SHOE);
    part(0.11 * side, 0.3 * swing, 0.17, 0.19, lift + 0.09, 0.5 + bob, TROUSERS);
    part(0.11 * side, 0.14 * swing, 0.18, 0.21, 0.5 + bob, 0.9 + bob, TROUSERS);
    part(0.28 * side, -0.09 * swing, 0.11, 0.14, 1.12 + bob, 1.46 + bob, JACKET);
    part(0.28 * side, -0.24 * swing, 0.1, 0.13, 0.86 + bob, 1.12 + bob, JACKET);
    part(0.28 * side, -0.27 * swing, 0.09, 0.11, 0.77 + bob, 0.86 + bob, SKIN);
  }
  part(0, 0.02, 0.44, 0.26, 0.9 + bob, 1.48 + bob, JACKET);
  part(0, -0.19, 0.3, 0.13, 1.02 + bob, 1.42 + bob, PACK);
  part(0, 0.02, 0.13, 0.13, 1.48 + bob, 1.54 + bob, SKIN);
  part(0, 0.03, 0.21, 0.22, 1.54 + bob, 1.74 + bob, SKIN);
  part(0, 0, 0.23, 0.24, 1.72 + bob, 1.8 + bob, HAIR);
  part(0, -0.09, 0.23, 0.07, 1.58 + bob, 1.74 + bob, HAIR);
  return buildGlb(parts, materials);
}

/** Car colours in roughly the proportions seen on the street. */
export const CAR_PAINTS = [
  [0.93, 0.93, 0.92], // white
  [0.7, 0.72, 0.74], // silver
  [0.13, 0.135, 0.15], // black
  [0.33, 0.36, 0.4], // grey
  [0.13, 0.22, 0.4], // blue
  [0.55, 0.09, 0.08], // red
];

if (import.meta.url === `file://${process.argv[1]}`) {
  mkdirSync('public/models', { recursive: true });
  CAR_PAINTS.forEach((c, i) => writeFileSync(`public/models/car-${i}.glb`, car(c)));
  writeFileSync('public/models/cable-car.glb', cableCar());
  writeFileSync('public/models/ferry.glb', ferry());
  for (let i = 0; i < 4; i++) writeFileSync(`public/models/walker-${i}.glb`, walker((i * Math.PI) / 2));
  console.log(`Wrote ${CAR_PAINTS.length} cars, a cable car and a ferry to public/models.`);
}
