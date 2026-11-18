/**
 * Building skins, painted procedurally: grainy stucco, brick, concrete and
 * curtain-wall glass, with recessed windows, sills, trim and a little
 * weathering. Every texture tiles seamlessly and is drawn at 3x so it holds up
 * when the camera is at street level.
 */

export interface Skin {
  width: number;
  height: number;
  data: Uint8Array;
}

const SIZE = 96; // logical pixels; one tile is about three window bays wide and three storeys tall
export const SKIN_SCALE = 3;

/** Deterministic random numbers, so a building looks the same on every visit. */
function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function canvas(): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const cv = document.createElement('canvas');
  cv.width = cv.height = SIZE * SKIN_SCALE;
  const g = cv.getContext('2d')!;
  g.scale(SKIN_SCALE, SKIN_SCALE);
  return [cv, g];
}

/** Fine grain plus soft blotches: the difference between paint and a flat fill. */
function grain(g: CanvasRenderingContext2D, rand: () => number, amount: number, blotches = 14) {
  const px = SIZE * SKIN_SCALE;
  const img = g.getImageData(0, 0, px, px);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (rand() - 0.5) * amount;
    d[i] += n;
    d[i + 1] += n;
    d[i + 2] += n;
  }
  g.putImageData(img, 0, 0);
  for (let i = 0; i < blotches; i++) {
    const x = rand() * SIZE;
    const y = rand() * SIZE;
    const r = 6 + rand() * 16;
    const dark = rand() < 0.6;
    // Draw each blotch wrapped around the edges so the tile stays seamless.
    for (const ox of [-SIZE, 0, SIZE])
      for (const oy of [-SIZE, 0, SIZE]) {
        const grad = g.createRadialGradient(x + ox, y + oy, 0, x + ox, y + oy, r);
        grad.addColorStop(0, dark ? 'rgba(0,0,0,0.07)' : 'rgba(255,255,255,0.07)');
        grad.addColorStop(1, 'rgba(0,0,0,0)');
        g.fillStyle = grad;
        g.fillRect(x + ox - r, y + oy - r, r * 2, r * 2);
      }
  }
}

function finish(cv: HTMLCanvasElement, g: CanvasRenderingContext2D): Skin {
  const px = SIZE * SKIN_SCALE;
  const d = g.getImageData(0, 0, px, px);
  return { width: cv.width, height: cv.height, data: new Uint8Array(d.data.buffer) };
}

/** A window set back into the wall: trim, shadowed reveal, glass with a reflection, sill. */
function windowAt(g: CanvasRenderingContext2D, rand: () => number, x: number, y: number, w: number, h: number, trim: string) {
  g.fillStyle = trim;
  g.fillRect(x - 1.6, y - 1.6, w + 3.2, h + 3.2);
  g.fillStyle = 'rgba(0,0,0,0.55)'; // the reveal, in shadow
  g.fillRect(x - 0.4, y - 0.4, w + 0.8, h + 0.8);
  const glass = g.createLinearGradient(x, y, x + w * 0.4, y + h);
  const tone = 30 + rand() * 30;
  glass.addColorStop(0, `rgb(${tone + 8},${tone + 22},${tone + 38})`);
  glass.addColorStop(0.55, `rgb(${tone - 8},${tone},${tone + 12})`);
  glass.addColorStop(1, `rgb(${tone + 40},${tone + 52},${tone + 62})`);
  g.fillStyle = glass;
  g.fillRect(x, y, w, h);
  if (rand() < 0.55) {
    // A blind or curtain drawn part of the way down.
    g.fillStyle = `rgba(${225 + rand() * 20},${218 + rand() * 20},${200 + rand() * 20},${0.5 + rand() * 0.35})`;
    g.fillRect(x, y, w, h * (0.25 + rand() * 0.45));
  }
  g.fillStyle = 'rgba(255,255,255,0.16)'; // sky caught in the glass
  g.beginPath();
  g.moveTo(x, y + h * 0.75);
  g.lineTo(x + w * 0.55, y);
  g.lineTo(x + w * 0.8, y);
  g.lineTo(x, y + h);
  g.fill();
  g.fillStyle = trim; // sash bar
  g.fillRect(x, y + h * 0.48, w, 0.8);
  g.fillStyle = 'rgba(255,255,255,0.75)'; // sill catching the light
  g.fillRect(x - 2.2, y + h + 1.2, w + 4.4, 1.3);
  const drip = g.createLinearGradient(0, y + h + 2.5, 0, y + h + 9);
  drip.addColorStop(0, 'rgba(0,0,0,0.22)');
  drip.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = drip; // shadow and rain streaks under the sill
  g.fillRect(x - 2.2, y + h + 2.5, w + 4.4, 6.5);
}

/** Painted stucco or wood siding: the San Francisco house. */
export function houseSkin(color: string, seed: number, siding: boolean): Skin {
  const rand = rng(seed);
  const [cv, g] = canvas();
  g.fillStyle = color;
  g.fillRect(0, 0, SIZE, SIZE);
  if (siding) {
    // Horizontal boards.
    for (let y = 0; y < SIZE; y += 2.4) {
      g.fillStyle = 'rgba(0,0,0,0.085)';
      g.fillRect(0, y, SIZE, 0.5);
      g.fillStyle = 'rgba(255,255,255,0.06)';
      g.fillRect(0, y + 0.5, SIZE, 0.5);
    }
  }
  grain(g, rand, siding ? 9 : 16);
  const floor = SIZE / 3;
  const bay = SIZE / 3;
  for (let row = 0; row < 3; row++) {
    // Cornice band between storeys.
    g.fillStyle = 'rgba(255,255,255,0.4)';
    g.fillRect(0, row * floor, SIZE, 1.6);
    g.fillStyle = 'rgba(0,0,0,0.2)';
    g.fillRect(0, row * floor + 1.6, SIZE, 1.1);
    for (let col = 0; col < 3; col++) windowAt(g, rand, col * bay + 9, row * floor + 8.5, 14, 16.5, 'rgba(250,248,242,0.95)');
  }
  // Slim pilasters between bays.
  for (let col = 0; col < 3; col++) {
    g.fillStyle = 'rgba(255,255,255,0.14)';
    g.fillRect(col * bay, 0, 1.4, SIZE);
    g.fillStyle = 'rgba(0,0,0,0.1)';
    g.fillRect(col * bay + 1.4, 0, 0.8, SIZE);
  }
  return finish(cv, g);
}

/** Brick apartment block. */
export function brickSkin(base: [number, number, number], seed: number): Skin {
  const rand = rng(seed);
  const [cv, g] = canvas();
  g.fillStyle = '#b9b0a4'; // mortar
  g.fillRect(0, 0, SIZE, SIZE);
  const bh = 2;
  const bw = 6;
  for (let row = 0; row * bh < SIZE; row++) {
    const off = row % 2 ? bw / 2 : 0;
    for (let col = -1; col * bw < SIZE; col++) {
      const v = (rand() - 0.5) * 34;
      g.fillStyle = `rgb(${base[0] + v},${base[1] + v * 0.7},${base[2] + v * 0.6})`;
      g.fillRect(col * bw + off + 0.3, row * bh + 0.3, bw - 0.6, bh - 0.55);
    }
  }
  grain(g, rand, 10, 10);
  const floor = SIZE / 3;
  for (let row = 0; row < 3; row++)
    for (let col = 0; col < 3; col++) {
      const x = col * (SIZE / 3) + 9.5;
      const y = row * floor + 9;
      g.fillStyle = 'rgba(222,214,200,0.95)'; // stone lintel
      g.fillRect(x - 2.4, y - 4, 17.8, 2.6);
      windowAt(g, rand, x, y, 13, 16, 'rgba(238,234,226,0.95)');
    }
  return finish(cv, g);
}

/** Concrete mid-rise with ribbon windows. */
export function concreteSkin(color: string, seed: number): Skin {
  const rand = rng(seed);
  const [cv, g] = canvas();
  g.fillStyle = color;
  g.fillRect(0, 0, SIZE, SIZE);
  grain(g, rand, 14, 20);
  const floor = SIZE / 3;
  for (let row = 0; row < 3; row++) {
    const y = row * floor + 9;
    g.fillStyle = 'rgba(0,0,0,0.5)';
    g.fillRect(0, y - 0.6, SIZE, 15.2);
    for (let col = 0; col < 6; col++) {
      const x = col * 16;
      const tone = 34 + rand() * 30;
      const glass = g.createLinearGradient(x, y, x + 8, y + 14);
      glass.addColorStop(0, `rgb(${tone + 6},${tone + 20},${tone + 34})`);
      glass.addColorStop(1, `rgb(${tone + 34},${tone + 46},${tone + 56})`);
      g.fillStyle = glass;
      g.fillRect(x + 0.7, y, 14.6, 14);
      if (rand() < 0.4) {
        g.fillStyle = 'rgba(232,226,210,0.6)';
        g.fillRect(x + 0.7, y, 14.6, 3 + rand() * 6);
      }
    }
    // Panel joint and the stain beneath the window band.
    g.fillStyle = 'rgba(0,0,0,0.16)';
    g.fillRect(0, row * floor, SIZE, 0.7);
    const stain = g.createLinearGradient(0, y + 14.6, 0, y + 22);
    stain.addColorStop(0, 'rgba(0,0,0,0.16)');
    stain.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = stain;
    g.fillRect(0, y + 14.6, SIZE, 8);
  }
  return finish(cv, g);
}

/** Curtain-wall glass for the towers. */
export function glassSkin(tint: [number, number, number], seed: number): Skin {
  const rand = rng(seed);
  const [cv, g] = canvas();
  const cols = 6;
  const rows = 6;
  const cw = SIZE / cols;
  const ch = SIZE / rows;
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) {
      const v = (rand() - 0.5) * 46;
      const x = c * cw;
      const y = r * ch;
      const pane = g.createLinearGradient(x, y, x + cw, y + ch);
      pane.addColorStop(0, `rgb(${tint[0] + v + 26},${tint[1] + v + 30},${tint[2] + v + 34})`);
      pane.addColorStop(1, `rgb(${tint[0] + v - 14},${tint[1] + v - 10},${tint[2] + v - 4})`);
      g.fillStyle = pane;
      g.fillRect(x, y, cw, ch);
      if (rand() < 0.12) {
        g.fillStyle = 'rgba(255,236,190,0.35)'; // a lit office
        g.fillRect(x, y, cw, ch);
      }
    }
  for (let r = 0; r < rows; r++) {
    g.fillStyle = 'rgba(40,48,56,0.55)'; // spandrel
    g.fillRect(0, r * ch, SIZE, 3);
    g.fillStyle = 'rgba(20,26,32,0.8)';
    g.fillRect(0, r * ch + 3, SIZE, 0.6);
  }
  for (let c = 0; c < cols; c++) {
    g.fillStyle = 'rgba(205,212,218,0.7)'; // mullion
    g.fillRect(c * cw, 0, 0.9, SIZE);
  }
  grain(g, rand, 6, 6);
  return finish(cv, g);
}

/** Flat roof: tar and gravel, or a pale membrane, with seams and stains. */
export function roofSkin(color: string, seed: number): Skin {
  const rand = rng(seed);
  const [cv, g] = canvas();
  g.fillStyle = color;
  g.fillRect(0, 0, SIZE, SIZE);
  grain(g, rand, 26, 26);
  g.fillStyle = 'rgba(0,0,0,0.1)';
  for (let x = 0; x < SIZE; x += 24) g.fillRect(x, 0, 0.6, SIZE); // membrane seams
  for (let i = 0; i < 5; i++) {
    // Vents and skylights.
    const x = rand() * (SIZE - 8);
    const y = rand() * (SIZE - 8);
    const s = 2.5 + rand() * 3.5;
    g.fillStyle = 'rgba(0,0,0,0.28)';
    g.fillRect(x + 0.9, y + 0.9, s, s);
    g.fillStyle = rand() < 0.5 ? 'rgba(200,205,210,0.95)' : 'rgba(120,150,170,0.95)';
    g.fillRect(x, y, s, s);
  }
  return finish(cv, g);
}
