// The Monster Island Terraformer (terraformer.html, dev server only): shape a terrain with fantasy-terrain.js, then
// "Save to game" — new islands in the game take their ground from it (src/sim/terrain-import.ts). Ported from the
// standalone Documents/monster-game/Monster Island Terraformer.html (three r128 → the game's three).
import * as THREE from 'three';
import FT from '../terrain/fantasy-terrain.js';
import { DEFAULT_SETTINGS, TERRAIN_FORMAT, type TerrainSettings } from '../sim/terrain-import';

const W = 128, H = 64, D = 128;

// headless screenshots (dev/winshot.sh) are taken at the load event: ?shot=ms holds it (as in the game)
const shot = Number(new URLSearchParams(location.search).get('shot'));
if (shot) Object.assign(document.body.appendChild(new Image()), { src: `/dev-ai/delay?ms=${shot}`, hidden: true });
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

// ---------- controls ----------
type Slider = [group: string, key: string, label: string, min: number, max: number, step: number, val: number, fmt?: (v: number) => string];
const SLIDERS: Slider[] = [
  ['g-land', 'heightScale', 'Height in the game (m per unit)', 1, 8, 0.5, DEFAULT_SETTINGS.heightScale],
  ['g-land', 'terraceStep', 'Cliff terrace height', 0, 10, 0.5, 5],
  ['g-land', 'terraceSharp', 'Cliff sheerness', 0.1, 1, 0.05, 0.3, (v) => (1.1 - v).toFixed(2)],
  ['g-land', 'hillHeight', 'Relief', 6, 36, 1, 22],
  ['g-land', 'warp', 'Domain warp', 0, 24, 1, 8],
  ['g-land', 'canyons', 'River canyons', 0, 1, 0.05, 0.6],
  ['g-land', 'caves', 'Tunnel caves', 0, 1, 0.05, 0.5],
  ['g-land', 'caverns', 'Caverns', 0, 1, 0.05, 0.4],
  ['g-fant', 'spires', 'Twisted spires', 0, 1, 0.05, 0.5],
  ['g-fant', 'islands', 'Floating isles', 0, 1, 0.05, 0.5],
  ['g-fant', 'arches', 'Arches', 0, 1, 0.05, 0.5],
  ['g-fant', 'crystalRate', 'Cave crystals', 0, 0.3, 0.01, 0.06],
  ['g-mesh', 'jitter', 'Facet jitter', 0, 0.9, 0.05, 0.2],
  ['g-mesh', 'slice', 'Slice height', 4, 64, 1, 64, (v) => (v >= 64 ? 'off' : String(v))],
];
/** preview-only controls: not part of the saved settings */
const VIEW_ONLY = new Set(['slice', 'crystalRate']);
const ctl: Record<string, HTMLInputElement> = {};
const shows: (() => void)[] = [];
for (const [group, key, label, min, max, step, val, fmt] of SLIDERS) {
  const row = document.createElement('div');
  row.className = 'row';
  row.innerHTML = `<label for="s-${key}">${label}</label><output id="o-${key}"></output>
    <input type="range" id="s-${key}" min="${min}" max="${max}" step="${step}" value="${val}">`;
  $(group).appendChild(row);
  const input = row.querySelector('input')!, out = row.querySelector('output')!;
  const show = () => { out.textContent = fmt ? fmt(+input.value) : String(+input.value); };
  show();
  shows.push(show);
  ctl[key] = input;
  input.addEventListener('input', () => {
    show();
    if (key === 'slice' || key === 'heightScale') applyView();
    else schedule();
    gameStatus();
  });
}
const rot = document.createElement('label');
rot.className = 'check';
rot.innerHTML = '<input type="checkbox" id="autorot" checked> Slow orbit';
$('g-mesh').appendChild(rot);
const autoRot = rot.querySelector('input')!;

const seedEl = $<HTMLInputElement>('seed'), palEl = $<HTMLSelectElement>('palette'), cellEl = $<HTMLSelectElement>('cell');
for (const el of [seedEl, palEl, cellEl]) el.addEventListener('change', () => { schedule(); gameStatus(); });
const WORDS = ['bog', 'fang', 'moon', 'grave', 'howl', 'ooze', 'bone', 'crypt', 'shade', 'gloom', 'hex', 'mire', 'wisp', 'tusk'];
$('reroll').addEventListener('click', () => {
  const w = () => WORDS[Math.floor(Math.random() * WORDS.length)];
  seedEl.value = `${w()}-${w()}-${Math.floor(Math.random() * 1000)}`;
  generate();
  gameStatus();
});

function params() {
  const p: Record<string, number | string | number[]> = { seed: seedEl.value || 'monster-island', palette: palEl.value, cell: +cellEl.value, size: [W, H, D] };
  for (const k in ctl) if (k !== 'slice' && k !== 'heightScale') p[k] = +ctl[k].value;
  return p;
}

/** what "Save to game" sends: the generator's options the game needs, nothing view-only */
function settings(): TerrainSettings {
  const s: Record<string, unknown> = { format: TERRAIN_FORMAT, seed: seedEl.value || 'monster-island', palette: palEl.value, cell: +cellEl.value };
  for (const k in ctl) if (!VIEW_ONLY.has(k)) s[k] = +ctl[k].value;
  // generator options without a slider keep their defaults
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) if (!(k in s)) s[k] = v;
  return s as unknown as TerrainSettings;
}

function apply(s: TerrainSettings) {
  seedEl.value = s.seed;
  palEl.value = s.palette;
  cellEl.value = String(s.cell);
  for (const [k, v] of Object.entries(s)) if (ctl[k] && typeof v === 'number') ctl[k].value = String(v);
  shows.forEach((f) => f());
}

const panel = $('panel'), toggle = $('toggle');
toggle.addEventListener('click', () => {
  const c = panel.classList.toggle('collapsed');
  toggle.textContent = c ? 'Controls' : 'Hide';
  toggle.setAttribute('aria-expanded', String(!c));
});

const copyBtn = $('copy');
copyBtn.addEventListener('click', () => {
  const text = JSON.stringify(settings(), null, 2);
  const done = () => { copyBtn.textContent = 'Copied'; setTimeout(() => (copyBtn.textContent = 'Copy settings'), 1400); };
  navigator.clipboard.writeText(text).then(done, () => { copyBtn.textContent = 'Copy failed'; });
});

// ---------- the game's saved terrain (dev/terrain-middleware.ts) ----------
const gameEl = $('game');
let saved: TerrainSettings | null = null;
let endpoint = true;
function gameStatus(note = '') {
  gameEl.classList.remove('err');
  if (!endpoint) {
    gameEl.classList.add('err');
    gameEl.textContent = 'The game\'s dev server isn\'t answering (open this page from `npm run dev`). "Save to game" downloads the settings instead: put them in src/terrain/saved-terrain.json.';
    return;
  }
  const canon = (o: object) => JSON.stringify(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : 1)));
  const same = saved && canon(saved) === canon(settings());
  gameEl.innerHTML = (saved
    ? `New islands use <b>${escape(saved.seed)}</b>${same ? ' (what you see)' : ' — not what you see now'}.`
    : 'New islands are <b>procedural</b> (the game\'s own generator).') + (note ? ` ${note}` : '');
}
const escape = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);

async function call(method: string, body?: unknown): Promise<TerrainSettings | null> {
  const r = await fetch('/__terrain', { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await r.json();
  if (!r.ok) throw new Error(data?.error ?? r.statusText);
  return data;
}

async function save(): Promise<boolean> {
  const s = settings();
  if (!endpoint) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(s, null, 2) + '\n'], { type: 'application/json' }));
    a.download = 'saved-terrain.json';
    a.click();
    return false;
  }
  try {
    saved = await call('POST', s);
    gameStatus('Saved: the next new island gets this ground (a running game keeps its island).');
    return true;
  } catch (err) {
    gameEl.classList.add('err');
    gameEl.textContent = `Saving failed: ${(err as Error).message}`;
    return false;
  }
}
$('save').addEventListener('click', () => void save());
$('play').addEventListener('click', async () => {
  // a new island on the default save slot; game tabs still open on it stop saving (main.ts)
  if (await save()) location.href = '/?fresh=1';
});
$('forget').addEventListener('click', async () => {
  try {
    saved = await call('DELETE');
    gameStatus('New islands are procedural again.');
  } catch (err) {
    gameEl.textContent = `Failed: ${(err as Error).message}`;
  }
});

// ---------- three.js scene ----------
const canvas = $<HTMLCanvasElement>('view');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.localClippingEnabled = true;
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(48, 1, 0.5, 1200);
// r155+ lights are physical: π × the r128 intensities looks the same
const hemi = new THREE.HemisphereLight(0xffffff, 0x444444, 0.7 * Math.PI);
const sun = new THREE.DirectionalLight(0xfff0dd, 0.85 * Math.PI);
sun.position.set(70, 120, 40);
scene.add(hemi, sun, new THREE.AmbientLight(0xffffff, 0.15 * Math.PI));

const clip = new THREE.Plane(new THREE.Vector3(0, -1, 0), 999);
const terrainMat = new THREE.MeshLambertMaterial({ vertexColors: true, clippingPlanes: [clip] });
const crystalMat = new THREE.MeshBasicMaterial({ clippingPlanes: [clip] });
const world = new THREE.Group();
world.position.set(-W / 2, 0, -D / 2);
scene.add(world);

const waterGeo = new THREE.PlaneGeometry(420, 420, 56, 56);
waterGeo.rotateX(-Math.PI / 2);
const waterBase = (waterGeo.attributes.position.array as Float32Array).slice();
const waterMat = new THREE.MeshPhongMaterial({ transparent: true, opacity: 0.82, flatShading: true, shininess: 40 });
const water = new THREE.Mesh(waterGeo, waterMat);
scene.add(water);

let terrain: THREE.Mesh | null = null, crystals: THREE.InstancedMesh | null = null, waterLevel = 7;

/**
 * The preview's vertical scale is the game's: heightScale m per unit against 8 m per tile, about the water level.
 * The slice plane and the water are in the same scaled space.
 */
function applyView() {
  const k = +ctl.heightScale.value / 8;
  world.scale.y = k;
  world.position.y = waterLevel * (1 - k);
  const v = +ctl.slice.value;
  clip.constant = v >= 64 ? 999 : waterLevel + (v - waterLevel) * k;
  water.position.y = waterLevel;
  water.visible = v >= 64 || v > waterLevel;
}

const busy = $('busy'), stats = $('stats');
let timer = 0;
function schedule() {
  clearTimeout(timer);
  timer = window.setTimeout(generate, 220);
}

function generate() {
  busy.hidden = false;
  setTimeout(() => {
    const t0 = performance.now();
    const r = FT.generate(params() as never);
    const ms = performance.now() - t0;
    waterLevel = r.field.options.waterLevel;

    if (terrain) { world.remove(terrain); terrain.geometry.dispose(); }
    if (crystals) { world.remove(crystals); crystals.geometry.dispose(); }

    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(r.flat.positions, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(r.flat.normals, 3));
    // fantasy-terrain's colors are sRGB; three works in linear
    const lin = new Float32Array(r.flat.colors.length), c = new THREE.Color();
    for (let i = 0; i < lin.length; i += 3) {
      c.setRGB(r.flat.colors[i], r.flat.colors[i + 1], r.flat.colors[i + 2], THREE.SRGBColorSpace);
      lin[i] = c.r; lin[i + 1] = c.g; lin[i + 2] = c.b;
    }
    g.setAttribute('color', new THREE.BufferAttribute(lin, 3));
    terrain = new THREE.Mesh(g, terrainMat);
    world.add(terrain);

    const cg = new THREE.OctahedronGeometry(1, 0);
    cg.scale(0.42, 1.7, 0.42);
    cg.translate(0, 0.9, 0);
    const n = r.crystals.length;
    crystals = new THREE.InstancedMesh(cg, crystalMat, Math.max(1, n));
    crystals.count = n;
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), qs = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0);
    const dir = new THREE.Vector3(), pos = new THREE.Vector3(), sc = new THREE.Vector3(), color = new THREE.Color();
    r.crystals.forEach((cr, i) => {
      dir.set(cr.direction[0], cr.direction[1], cr.direction[2]);
      q.setFromUnitVectors(up, dir);
      qs.setFromAxisAngle(up, cr.spin);
      q.multiply(qs);
      pos.set(cr.position[0], cr.position[1], cr.position[2]);
      sc.setScalar(cr.scale);
      m.compose(pos, q, sc);
      crystals!.setMatrixAt(i, m);
      crystals!.setColorAt(i, color.setHex(cr.color));
    });
    if (crystals.instanceColor) crystals.instanceColor.needsUpdate = true;
    world.add(crystals);

    const pal = r.flat.palette;
    scene.background = new THREE.Color(pal.sky);
    scene.fog = new THREE.Fog(pal.fog, 160, 420);
    hemi.color.setHex(pal.sky).lerp(new THREE.Color(0xffffff), 0.5);
    hemi.groundColor.setHex(pal.under);
    waterMat.color.setHex(pal.water);
    waterMat.emissive.setHex(pal.waterGlow);
    waterMat.opacity = pal.waterGlow ? 0.95 : 0.82;
    applyView();

    stats.textContent = `${r.flat.triangleCount.toLocaleString()} tris · ${n} crystals · ${Math.round(ms)} ms`;
    busy.hidden = true;
  }, 20);
}

// ---------- orbit camera ----------
const orbit = { theta: 0.75, phi: 0.95, radius: 175, target: new THREE.Vector3(0, 16, 0) };
const pointers = new Map<number, { x: number; y: number }>();
let lastPinch = 0, panMode = false;
canvas.addEventListener('contextmenu', (e) => e.preventDefault());
canvas.addEventListener('pointerdown', (e) => {
  canvas.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  panMode = e.button === 2 || e.shiftKey;
  autoRot.checked = false;
});
canvas.addEventListener('pointermove', (e) => {
  const prev = pointers.get(e.pointerId);
  if (!prev) return;
  const dx = e.clientX - prev.x, dy = e.clientY - prev.y;
  prev.x = e.clientX;
  prev.y = e.clientY;
  if (pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    const dist = Math.hypot(a.x - b.x, a.y - b.y);
    if (lastPinch) orbit.radius = Math.min(420, Math.max(25, orbit.radius * (lastPinch / dist)));
    lastPinch = dist;
    return;
  }
  if (panMode) {
    const s = orbit.radius * 0.0016;
    const right = new THREE.Vector3(Math.cos(orbit.theta), 0, -Math.sin(orbit.theta));
    const fwd = new THREE.Vector3(Math.sin(orbit.theta), 0, Math.cos(orbit.theta));
    orbit.target.addScaledVector(right, -dx * s).addScaledVector(fwd, -dy * s);
  } else {
    orbit.theta -= dx * 0.006;
    orbit.phi = Math.min(1.52, Math.max(0.12, orbit.phi - dy * 0.006));
  }
});
const endPtr = (e: PointerEvent) => { pointers.delete(e.pointerId); if (pointers.size < 2) lastPinch = 0; };
canvas.addEventListener('pointerup', endPtr);
canvas.addEventListener('pointercancel', endPtr);
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  orbit.radius = Math.min(420, Math.max(25, orbit.radius * Math.exp(e.deltaY * 0.001)));
}, { passive: false });

function resize() {
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);
resize();

const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
if (reduce) autoRot.checked = false;
const wp = waterGeo.attributes.position as THREE.BufferAttribute;
let last = performance.now();
function frame(now: number) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  if (autoRot.checked) orbit.theta += dt * 0.12;
  const t = now * 0.001;
  if (!reduce) {
    const arr = wp.array as Float32Array;
    for (let i = 0; i < wp.count; i++) {
      const x = waterBase[i * 3], z = waterBase[i * 3 + 2];
      arr[i * 3 + 1] = Math.sin(x * 0.09 + t * 1.1) * 0.35 + Math.cos(z * 0.11 + t * 0.8) * 0.35;
    }
    wp.needsUpdate = true;
  }
  const sp = Math.sin(orbit.phi);
  camera.position.set(
    orbit.target.x + orbit.radius * sp * Math.sin(orbit.theta),
    orbit.target.y + orbit.radius * Math.cos(orbit.phi),
    orbit.target.z + orbit.radius * sp * Math.cos(orbit.theta));
  camera.lookAt(orbit.target);
  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}

// start from what the game has, so "Save" after a tweak is a tweak of the island in the game
call('GET').then(
  (s) => {
    saved = s;
    if (s) apply(s);
  },
  () => { endpoint = false; },
).finally(() => {
  gameStatus();
  generate();
  requestAnimationFrame(frame);
});
