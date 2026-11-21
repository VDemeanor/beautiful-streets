import * as THREE from 'three';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { Sky } from 'three/addons/objects/Sky.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import { TilesRenderer } from '3d-tiles-renderer';
import { GLTFExtensionsPlugin, GoogleCloudAuthPlugin, ReorientationPlugin, TilesFadePlugin } from '3d-tiles-renderer/plugins';
import type { LngLat } from '@/lib/types';
import { cameraDistance, NORMAL_LENS, type Shot, type Stage } from '../flight';
import type { Vehicle } from '../traffic';

/**
 * The cinematic city. Google's photographed 3D city is loaded as a model into
 * a game-style renderer, so it can be lit by our own sun and moon, cast
 * shadows, sit under a real sky, and share the scene with an animated walker,
 * cars and glowing pickups. Everything is placed in a local frame centred on
 * the walk's start: Y is up, X points west and Z points north, in metres.
 */

export interface SunAt {
  /** Degrees clockwise from north, and degrees above the horizon. */
  azimuth: number;
  altitude: number;
  /** 0..100 */
  cloud: number;
}

export interface CinemaApi {
  stage: Stage;
  frame(view: { center: LngLat; zoom: number }, pitch: number, bearing: number): void;
  nudge(bearing: number, pitch: number): void;
  vehicles(list: Vehicle[]): void;
  nextTurn(at: LngLat | null, label?: string): void;
  gems(list: { where: LngLat; label: string }[]): void;
  /** Draw the planned walk, or clear it with null. */
  route(path: LngLat[] | null): void;
  light(sun: SunAt): void;
  /** The credits Google requires to be shown with its imagery. */
  credits(): string;
  dispose(): void;
}

interface Options {
  apiKey: string;
  start: LngLat;
  /** Ground height in metres above sea level, from the street data. */
  altitude: (at: LngLat) => number;
  sun: SunAt;
  onError: (message: string, keyRefused: boolean) => void;
}

const RAD = Math.PI / 180;
const clamp = (x: number, a: number, b: number) => Math.max(a, Math.min(b, x));

export function createEngine(host: HTMLElement, options: Options): CinemaApi {
  const origin = options.start;
  const kx = 111320 * Math.cos(origin[1] * RAD);
  const small = host.clientWidth < 700;

  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, small ? 1.5 : 2));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.shadowMap.enabled = !small;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.domElement.style.cssText = 'width:100%;height:100%;display:block;touch-action:none';
  host.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(NORMAL_LENS, 1, 1, 60000);
  scene.fog = new THREE.FogExp2(0xcfe0ee, 0.00009);

  // ---------- Light and sky
  const sky = new Sky();
  sky.scale.setScalar(45000);
  scene.add(sky);
  const sunLight = new THREE.DirectionalLight(0xffffff, 3);
  sunLight.castShadow = true;
  sunLight.shadow.mapSize.set(2048, 2048);
  sunLight.shadow.camera.near = 10;
  sunLight.shadow.camera.far = 2400;
  sunLight.shadow.bias = -0.0006;
  sunLight.shadow.normalBias = 0.6;
  scene.add(sunLight, sunLight.target);
  const ambient = new THREE.HemisphereLight(0xbcd6ff, 0x6b6257, 1.2);
  scene.add(ambient);
  const stars = new THREE.Points(
    (() => {
      const g = new THREE.BufferGeometry();
      const p = new Float32Array(1500 * 3);
      for (let i = 0; i < 1500; i++) {
        // Scattered over the upper dome.
        const a = Math.random() * Math.PI * 2;
        const e = Math.asin(0.06 + Math.random() * 0.94);
        p.set([Math.cos(a) * Math.cos(e) * 40000, Math.sin(e) * 40000, Math.sin(a) * Math.cos(e) * 40000], i * 3);
      }
      g.setAttribute('position', new THREE.BufferAttribute(p, 3));
      return g;
    })(),
    new THREE.PointsMaterial({ color: 0xffffff, size: 2.2, sizeAttenuation: false, fog: false, transparent: true, opacity: 0.9 }),
  );
  stars.visible = false;
  scene.add(stars);
  let night = false;

  // ---------- Film look
  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.3, 0.7, 0.9);
  composer.addPass(bloom);
  composer.addPass(new OutputPass());

  const light = (sun: SunAt) => {
    night = sun.altitude < -6;
    const golden = !night && sun.altitude < 9;
    // Below the horizon the moon takes over from a fixed, pleasing height.
    const alt = night ? 38 : Math.max(sun.altitude, 3);
    const az = night ? sun.azimuth + 140 : sun.azimuth;
    const dir = new THREE.Vector3(-Math.sin(az * RAD) * Math.cos(alt * RAD), Math.sin(alt * RAD), Math.cos(az * RAD) * Math.cos(alt * RAD));
    sunDir.copy(dir);
    const grey = sun.cloud / 100;
    sky.visible = !night;
    stars.visible = night;
    const u = sky.material.uniforms;
    u.turbidity.value = 3 + grey * 9;
    u.rayleigh.value = golden ? 3.2 : 1.6 - grey * 0.8;
    u.mieCoefficient.value = 0.006;
    u.mieDirectionalG.value = 0.82;
    u.sunPosition.value.copy(dir);
    scene.background = night ? new THREE.Color(0x050a1c) : null;
    sunLight.color.set(night ? 0x8ea6e8 : golden ? 0xffc38a : 0xfff4e2);
    sunLight.intensity = night ? 0.5 : (golden ? 2.4 : 3.2) * (1 - grey * 0.55);
    ambient.color.set(night ? 0x34467e : golden ? 0xd9c2c8 : 0xbcd6ff);
    ambient.groundColor.set(night ? 0x0c1022 : 0x6b6257);
    ambient.intensity = night ? 0.5 : 1.1 + grey * 0.6;
    (scene.fog as THREE.FogExp2).color.set(night ? 0x070c1e : golden ? 0xe9c9a8 : 0xcfe0ee);
    (scene.fog as THREE.FogExp2).density = 0.00008 + grey * 0.00016;
    renderer.toneMappingExposure = night ? 0.85 : golden ? 0.62 : 0.55;
    bloom.strength = night ? 0.55 : 0.25;
    bloom.threshold = night ? 0.8 : 0.92;
    (planned.material as THREE.MeshBasicMaterial).color.set(night ? 0x8f97ad : 0xffffff);
    for (const lamp of headlamps) lamp.visible = night;
  };
  const sunDir = new THREE.Vector3(0, 1, 0);

  // ---------- The photographed city
  const tiles = new TilesRenderer();
  tiles.registerPlugin(new GoogleCloudAuthPlugin({ apiToken: options.apiKey, autoRefreshToken: true }));
  const draco = new DRACOLoader();
  draco.setDecoderPath('/draco/');
  tiles.registerPlugin(new GLTFExtensionsPlugin({ dracoLoader: draco }));
  tiles.registerPlugin(new ReorientationPlugin({ lat: origin[1] * RAD, lon: origin[0] * RAD, height: 0 }));
  tiles.registerPlugin(new TilesFadePlugin());
  tiles.errorTarget = small ? 26 : 14;
  scene.add(tiles.group);
  let failures = 0;
  let loaded = 0;
  // If nothing of the city has arrived after a while, say so rather than leave an empty sky.
  const patience = window.setTimeout(() => {
    if (!loaded) options.onError('The 3D city did not load. The Google key needs the Map Tiles API enabled in Google Cloud.', false);
  }, 14000);
  tiles.addEventListener('load-model', (event: { scene: THREE.Object3D }) => {
    loaded++;
    // The photographs arrive unlit. Give every piece a material that answers to our
    // sun, so the city takes the light and shadows of whatever hour is showing.
    event.scene.traverse((node) => {
      const mesh = node as THREE.Mesh;
      if (!mesh.isMesh) return;
      const old = mesh.material as THREE.MeshBasicMaterial;
      mesh.material = new THREE.MeshLambertMaterial({ map: old.map ?? null });
      mesh.castShadow = true;
      mesh.receiveShadow = true;
    });
  });
  tiles.addEventListener('load-error', (event: { error?: { message?: string } }) => {
    failures++;
    if (failures === 1 && loaded === 0) {
      const text = String(event.error?.message ?? '');
      const refused = /40[13]/.test(text);
      options.onError(
        refused
          ? 'Google refused the key for 3D city tiles. Enable the Map Tiles API for it in Google Cloud.'
          : 'The 3D city could not be loaded from Google.',
        false,
      );
    }
  });

  // ---------- Places and heights
  const local = (at: LngLat, y = 0) => new THREE.Vector3(-(at[0] - origin[0]) * kx, y, (at[1] - origin[1]) * 111320);
  const raycaster = new THREE.Raycaster();
  (raycaster as unknown as { firstHitOnly: boolean }).firstHitOnly = true;
  const down = new THREE.Vector3(0, -1, 0);
  /** Scene height minus height above sea level: Google measures from the ellipsoid, about 32 m lower here. */
  let seaOffset = -32;
  let calibrated = false;
  const heights = new Map<string, number>();
  const probe = (at: LngLat): number | null => {
    const p = local(at, 4000);
    raycaster.set(p, down);
    const hit = raycaster.intersectObject(tiles.group, true)[0];
    return hit ? hit.point.y : null;
  };
  const ground = (at: LngLat): number => {
    const key = `${at[0].toFixed(5)},${at[1].toFixed(5)}`;
    const cached = heights.get(key);
    if (cached !== undefined) return cached;
    const expected = options.altitude(at) + seaOffset;
    let y = expected;
    if (calibrated) {
      // A ray from above lands on whatever is highest: a roof, a tree, a parked van. The street
      // data says roughly where the pavement is, so a hit far from that is not the ground.
      const hit = probe(at);
      if (hit !== null && Math.abs(hit - expected) < 2.2) y = hit;
    }
    heights.set(key, y);
    return y;
  };
  let calibrateAt = 0;
  let calibrations = 0;
  const samples: LngLat[] = [];
  const calibrate = () => {
    const spots = samples.length ? samples : [origin];
    const diffs: number[] = [];
    for (let i = 0; i < spots.length; i += Math.max(1, Math.floor(spots.length / 40))) {
      const hit = probe(spots[i]);
      if (hit !== null) diffs.push(hit - options.altitude(spots[i]));
    }
    if (diffs.length < 4) return;
    // Trees and vehicles only ever push a hit upward, so the true offset sits low in the spread.
    diffs.sort((a, b) => a - b);
    seaOffset = diffs[Math.floor(diffs.length * 0.3)];
    calibrated = true;
    calibrations++;
    heights.clear();
    if (lastPath) drawRoute(lastPath);
  };

  // ---------- Camera
  let view: Shot = { look: origin, bearing: -18, pitch: 62, zoom: 15.6, lens: NORMAL_LENS };
  let glide: { from: Shot; to: Shot; t: number } | null = null;
  const height = () => host.getBoundingClientRect().height || 600;
  const aim = (s: Shot) => {
    const target = local(s.look, ground(s.look) + 1.3);
    const d = cameraDistance(s, height());
    const b = s.bearing * RAD;
    const p = clamp(s.pitch, 0, 88) * RAD;
    camera.position.set(target.x + Math.sin(b) * d * Math.sin(p), target.y + d * Math.cos(p), target.z - Math.cos(b) * d * Math.sin(p));
    camera.fov = s.lens;
    camera.near = clamp(d / 60, 0.5, 20);
    camera.updateProjectionMatrix();
    camera.lookAt(target);
    sunLight.target.position.copy(target);
    sunLight.position.copy(target).addScaledVector(sunDir, 1200);
    const reach = clamp(d * 1.6, 160, 900);
    const cam = sunLight.shadow.camera;
    if (Math.abs(cam.right - reach) > reach * 0.15) {
      cam.left = cam.bottom = -reach;
      cam.right = cam.top = reach;
      cam.updateProjectionMatrix();
    }
  };

  // ---------- The walker
  const walker = new THREE.Group();
  walker.visible = false;
  scene.add(walker);
  let mixer: THREE.AnimationMixer | null = null;
  const gltf = new GLTFLoader();
  gltf.load('/models/walker-rig.glb', (model) => {
    model.scene.traverse((node) => {
      const mesh = node as THREE.SkinnedMesh;
      if (!mesh.isMesh) return;
      mesh.castShadow = true;
      mesh.frustumCulled = false;
      const material = (mesh.material as THREE.MeshStandardMaterial).clone();
      // A pale figure with international-orange joints, easy to pick out against the street.
      material.color.set(/Joints/i.test(material.name) ? 0xe2542f : 0xd8d2c6);
      material.roughness = 0.6;
      material.metalness = 0;
      mesh.material = material;
    });
    walker.add(model.scene);
    mixer = new THREE.AnimationMixer(model.scene);
    const walk = model.animations.find((a) => /walk/i.test(a.name)) ?? model.animations[0];
    if (walk) mixer.clipAction(walk).play();
  });
  // A soft light the walker carries, so they can be found at night.
  const halo = new THREE.PointLight(0xffc98a, 0, 26, 1.6);
  halo.position.y = 2.4;
  walker.add(halo);

  // ---------- The route, drawn on the ground
  const ribbon = (color: number, width: number, lift: number) => {
    const mesh = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial({ color, toneMapped: false, transparent: true, opacity: 0.92, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4 }));
    mesh.frustumCulled = false;
    mesh.userData = { width, lift };
    mesh.renderOrder = 2;
    scene.add(mesh);
    return mesh;
  };
  const planned = ribbon(0xffffff, 1.5, 0.35);
  const walkedLine = ribbon(0xff6a3d, 2.1, 0.45);
  (planned.material as THREE.MeshBasicMaterial).opacity = 0.7;
  const lay = (mesh: THREE.Mesh, path: LngLat[]) => {
    const { width, lift } = mesh.userData as { width: number; lift: number };
    if (path.length < 2) {
      mesh.visible = false;
      return;
    }
    const points = path.map((p) => local(p, ground(p) + lift));
    const positions: number[] = [];
    const index: number[] = [];
    points.forEach((p, i) => {
      const a = points[Math.max(0, i - 1)];
      const b = points[Math.min(points.length - 1, i + 1)];
      const side = new THREE.Vector3(b.z - a.z, 0, -(b.x - a.x)).normalize().multiplyScalar(width / 2);
      positions.push(p.x - side.x, p.y, p.z - side.z, p.x + side.x, p.y, p.z + side.z);
      if (i) index.push(i * 2 - 2, i * 2 - 1, i * 2, i * 2 - 1, i * 2 + 1, i * 2);
    });
    mesh.geometry.dispose();
    mesh.geometry = new THREE.BufferGeometry();
    mesh.geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    mesh.geometry.setIndex(index);
    (mesh.material as THREE.Material).side = THREE.DoubleSide;
    mesh.visible = true;
  };
  /** Add points along long straight stretches, so the ribbon follows the slope of the hill. */
  const dense = (path: LngLat[]) => {
    const out: LngLat[] = [];
    path.forEach((p, i) => {
      if (i) {
        const a = path[i - 1];
        const n = Math.floor(Math.hypot((p[0] - a[0]) * kx, (p[1] - a[1]) * 111320) / 12);
        for (let k = 1; k <= n; k++) out.push([a[0] + ((p[0] - a[0]) * k) / (n + 1), a[1] + ((p[1] - a[1]) * k) / (n + 1)]);
      }
      out.push(p);
    });
    return out;
  };
  let lastPath: LngLat[] | null = null;
  const drawRoute = (path: LngLat[]) => lay(planned, dense(path));

  // ---------- Pickups
  const gemShape = new THREE.OctahedronGeometry(1.5);
  const gemLook = new THREE.MeshStandardMaterial({ color: 0x58d6e8, emissive: 0x2aa9c4, emissiveIntensity: 1.6, roughness: 0.15, metalness: 0.2, flatShading: true });
  const pickups = new Map<string, THREE.Mesh>();

  // ---------- Vehicles
  const fleet = new Map<number, THREE.Object3D>();
  const moulds = new Map<string, THREE.Object3D | null>();
  const headlamps: THREE.Object3D[] = [];
  const lampLook = new THREE.MeshBasicMaterial({ color: 0xfff3cf, toneMapped: false });
  const tailLook = new THREE.MeshBasicMaterial({ color: 0xff2a1c, toneMapped: false });
  const build = (v: Vehicle): THREE.Object3D | null => {
    const src = v.type === 'cable' ? '/models/cable-car.glb' : v.type === 'ferry' ? '/models/ferry.glb' : `/models/car-${v.paint}.glb`;
    if (!moulds.has(src)) {
      moulds.set(src, null);
      gltf.load(src, (model) => {
        model.scene.traverse((node) => {
          (node as THREE.Mesh).castShadow = true;
        });
        moulds.set(src, model.scene);
      });
    }
    const mould = moulds.get(src);
    if (!mould) return null;
    const body = SkeletonUtils.clone(mould);
    if (v.type === 'car') {
      // Lamps that glow after dark.
      const lamps = new THREE.Group();
      for (const x of [-0.6, 0.6]) {
        const head = new THREE.Mesh(new THREE.SphereGeometry(0.16, 8, 6), lampLook);
        head.position.set(x, 0.68, 2.22);
        const tail = new THREE.Mesh(new THREE.SphereGeometry(0.13, 8, 6), tailLook);
        tail.position.set(x, 0.68, -2.22);
        lamps.add(head, tail);
      }
      lamps.visible = night;
      headlamps.push(lamps);
      body.add(lamps);
    }
    scene.add(body);
    return body;
  };

  // ---------- Drawing loop
  const clock = new THREE.Timer();
  let raf = 0;
  let disposed = false;
  let width = 0;
  let heightPx = 0;
  let walkerScale = 1.2;
  const frame = () => {
    if (disposed) return;
    raf = requestAnimationFrame(frame);
    clock.update();
    const dt = Math.min(clock.getDelta(), 0.1);
    const box = host.getBoundingClientRect();
    if (box.width < 4 || box.height < 4) return;
    if (box.width !== width || box.height !== heightPx) {
      width = box.width;
      heightPx = box.height;
      renderer.setSize(width, heightPx, false);
      composer.setSize(width, heightPx);
      camera.aspect = width / heightPx;
    }
    if (glide) {
      glide.t = Math.min(1, glide.t + dt / 1.6);
      const t = 1 - (1 - glide.t) ** 3;
      const { from, to } = glide;
      view = {
        look: [from.look[0] + (to.look[0] - from.look[0]) * t, from.look[1] + (to.look[1] - from.look[1]) * t],
        bearing: from.bearing + ((((to.bearing - from.bearing + 540) % 360) - 180) * t),
        pitch: from.pitch + (to.pitch - from.pitch) * t,
        zoom: from.zoom + (to.zoom - from.zoom) * t,
        lens: to.lens,
      };
      if (glide.t >= 1) glide = null;
    }
    aim(view);
    camera.updateMatrixWorld();
    tiles.setCamera(camera);
    tiles.setResolutionFromRenderer(camera, renderer);
    tiles.update();
    // Once enough of the city has arrived, measure how its heights sit against the street data,
    // and measure again a few times as sharper pieces load.
    const now = performance.now();
    if (loaded > 6 && calibrations < 5 && now > calibrateAt) {
      calibrateAt = now + (calibrated ? 5000 : 1200);
      calibrate();
    }
    mixer?.update(dt * 1.15);
    if (walker.visible) walker.scale.setScalar(walkerScale);
    halo.intensity = night && walker.visible ? 45 : 0;
    const spin = now / 1000;
    for (const gem of pickups.values()) {
      gem.rotation.y = spin * 1.4;
      gem.position.y = (gem.userData.base as number) + Math.sin(spin * 2 + gem.position.x) * 0.5;
    }
    composer.render(dt);
  };
  raf = requestAnimationFrame(frame);

  // ---------- Moving the camera by hand
  const canvas = renderer.domElement;
  const fingers = new Map<number, { x: number; y: number }>();
  let pinch = 0;
  const onDown = (e: PointerEvent) => {
    fingers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    canvas.setPointerCapture(e.pointerId);
    pinch = 0;
    glide = null;
  };
  const onMove = (e: PointerEvent) => {
    const was = fingers.get(e.pointerId);
    if (!was) return;
    const dx = e.clientX - was.x;
    const dy = e.clientY - was.y;
    fingers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (fingers.size === 2) {
      // Two fingers: pinch to move in and out.
      const [a, b] = [...fingers.values()];
      const spread = Math.hypot(a.x - b.x, a.y - b.y);
      if (pinch) view = { ...view, zoom: clamp(view.zoom + Math.log2(spread / pinch), 13, 20.5) };
      pinch = spread;
    } else if (e.shiftKey || e.buttons === 2) {
      view = { ...view, bearing: view.bearing - dx * 0.3, pitch: clamp(view.pitch - dy * 0.25, 5, 86) };
    } else {
      // Drag the ground under the pointer.
      const metres = (cameraDistance(view, height()) * 2 * Math.tan((view.lens * RAD) / 2)) / height();
      const b = view.bearing * RAD;
      const east = (-dx * Math.cos(b) + dy * Math.sin(b)) * metres;
      const north = (dx * Math.sin(b) + dy * Math.cos(b)) * metres;
      view = { ...view, look: [view.look[0] + east / kx, view.look[1] + north / 111320] };
    }
  };
  const onUp = (e: PointerEvent) => {
    fingers.delete(e.pointerId);
    pinch = 0;
  };
  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    glide = null;
    if (e.ctrlKey || !e.shiftKey) view = { ...view, zoom: clamp(view.zoom - e.deltaY * 0.0022, 13, 20.5) };
    else view = { ...view, bearing: view.bearing + e.deltaY * 0.1 };
  };
  const noMenu = (e: Event) => e.preventDefault();
  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointercancel', onUp);
  canvas.addEventListener('wheel', onWheel, { passive: false });
  canvas.addEventListener('contextmenu', noMenu);

  light(options.sun);

  const stage: Stage = {
    current: () => view,
    apply(s) {
      glide = null;
      view = s;
    },
    walker(at, heading = 0) {
      if (!at) {
        walker.visible = false;
        return;
      }
      walker.visible = true;
      walker.position.copy(local(at, ground(at)));
      // The figure is modelled facing north.
      walker.rotation.y = -heading * RAD;
      // Life size up close; larger from a distance, so they can still be found.
      walkerScale = clamp(cameraDistance(view, height()) / 30, 1.15, 9);
    },
    ground,
    // Close enough to feel like being in the street, high enough to clear the street trees.
    street: { distance: 46, pitch: 74 },
    height,
    settle() {
      view = { ...view, lens: NORMAL_LENS };
    },
    reveal(path) {
      drawRoute(path);
    },
    trail(path) {
      lay(walkedLine, dense(path));
    },
  };

  return {
    stage,
    frame(target, pitch, bearing) {
      glide = { from: view, to: { look: target.center, zoom: target.zoom, pitch, bearing, lens: NORMAL_LENS }, t: 0 };
    },
    nudge(bearing, pitch) {
      glide = { from: view, to: { ...view, bearing: view.bearing + bearing, pitch: clamp(view.pitch + pitch, 5, 86) }, t: 0.4 };
    },
    vehicles(list) {
      const seen = new Set<number>();
      for (const v of list) {
        seen.add(v.id);
        let body = fleet.get(v.id);
        if (!body) {
          const made = build(v);
          if (!made) continue;
          body = made;
          fleet.set(v.id, body);
        }
        body.position.copy(local(v.at, v.type === 'ferry' ? seaOffset : ground(v.at)));
        body.rotation.y = -v.heading * RAD;
      }
      for (const [id, body] of fleet) {
        if (seen.has(id)) continue;
        scene.remove(body);
        fleet.delete(id);
      }
    },
    nextTurn() {
      /* The film's own direction card covers this. */
    },
    gems(list) {
      const wanted = new Set(list.map((g) => `${g.where[0]},${g.where[1]}`));
      for (const [key, gem] of pickups) {
        if (wanted.has(key)) continue;
        scene.remove(gem);
        pickups.delete(key);
      }
      for (const g of list) {
        const key = `${g.where[0]},${g.where[1]}`;
        if (pickups.has(key)) continue;
        const gem = new THREE.Mesh(gemShape, gemLook);
        gem.scale.set(1, 1.5, 1);
        gem.userData.base = ground(g.where) + 6;
        gem.position.copy(local(g.where, gem.userData.base as number));
        gem.castShadow = true;
        scene.add(gem);
        pickups.set(key, gem);
      }
    },
    route(path) {
      lastPath = path;
      samples.length = 0;
      if (!path) {
        planned.visible = false;
        walkedLine.visible = false;
        return;
      }
      samples.push(...path);
      calibrations = Math.min(calibrations, 2);
      drawRoute(path);
    },
    light,
    credits() {
      const parts = tiles.getAttributions().filter((a) => a.type === 'string').map((a) => String(a.value));
      return parts.join(' ');
    },
    dispose() {
      disposed = true;
      window.clearTimeout(patience);
      cancelAnimationFrame(raf);
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('pointercancel', onUp);
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('contextmenu', noMenu);
      tiles.dispose();
      draco.dispose();
      composer.dispose();
      renderer.dispose();
      canvas.remove();
    },
  };
}
