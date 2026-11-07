// ============================================================================
// app.js: Three.js setup, render loop, menus / workspaces, simulation + world
//         controls, fling tool and the demo scene
// ============================================================================
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import * as Physics from './physics.js';
import { initNumberFields, initMenus, initTabs, showPropsTab, nf, toast, loading } from './ui.js';
import { initInspector, refreshInspector } from './inspector.js';
import { initOutliner } from './outliner.js';
import { initBuilder, spawnPrimitive, addCloth, updateSelectionHelper } from './builder.js';
import { initLoaders } from './loaders.js';
import { initInteract, setOverlay, updateOverlays } from './interact.js';
import { initTimeline, updateTimeline } from './timeline.js';
import { createJoint, clearJoints, updateJointVisuals } from './joints.js';
import { createField, clearFields, detonate, updateFieldVisuals } from './fields.js';
import { createCloth, clearCloths, updateClothVisuals } from './cloth.js';

const $ = (id) => document.getElementById(id);
const { state } = Physics;

// ----------------------------------------------------------------------------
// Renderer, scene, camera
// ----------------------------------------------------------------------------
const canvas = $('viewport');
const wrap = $('viewport-wrap');
let renderer;
try {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
} catch (err) {
  document.body.insertAdjacentHTML('beforeend', '<div class="fatal">WebGL is not available in this browser.</div>');
  throw err;
}
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;

const BG = 0x1e1e1e;
const scene = new THREE.Scene();
scene.background = new THREE.Color(BG);
scene.fog = new THREE.Fog(BG, 70, 170);

const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

const camera = new THREE.PerspectiveCamera(50, 1, 0.05, 500);
const HOME_POS = new THREE.Vector3(5, 6, 12);
const HOME_TARGET = new THREE.Vector3(-1, 1.5, 0);
camera.position.copy(HOME_POS);

scene.add(new THREE.HemisphereLight(0xbcd2ff, 0x1a1a1a, 0.35));
const sun = new THREE.DirectionalLight(0xffffff, 1.9);
sun.position.set(8, 14, 6);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -24, right: 24, top: 24, bottom: -24, near: 1, far: 60 });
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.02;
scene.add(sun);

// floor visuals (the physical floor lives in physics.js)
const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(400, 400),
  new THREE.MeshStandardMaterial({ color: 0x262626, roughness: 0.95, metalness: 0 }),
);
ground.rotation.x = -Math.PI / 2;
ground.position.y = -0.002;
ground.receiveShadow = true;
scene.add(ground);

const grid = new THREE.GridHelper(120, 120, 0x555555, 0x333333);
grid.position.y = 0.002;
grid.material.transparent = true;
grid.material.opacity = 0.7;
grid.material.depthWrite = false;
scene.add(grid);

// Blender-style coloured axes (X red, Z blue)
function axisLine(a, b, color) {
  const g = new THREE.BufferGeometry().setFromPoints([a, b]);
  const l = new THREE.Line(g, new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.85, depthWrite: false }));
  l.position.y = 0.004;
  return l;
}
const axes = new THREE.Group();
axes.add(axisLine(new THREE.Vector3(-60, 0, 0), new THREE.Vector3(60, 0, 0), 0xb83a3a));
axes.add(axisLine(new THREE.Vector3(0, 0, -60), new THREE.Vector3(0, 0, 60), 0x3a6bb8));
scene.add(axes);

// ----------------------------------------------------------------------------
// Physics + shared context
// ----------------------------------------------------------------------------
Physics.initPhysics(scene);

const ctx = {
  scene, camera, renderer,
  orbit: null, transform: null,
  tool: 'select', selected: null,
  select: () => {},
  lastGizmoDrag: 0,
  afterFrame: [],
  toast, loading,
  reset: doReset,
  setRunning,
  /** World position near the orbit target where the next object appears (golden-angle spiral). */
  spawnPoint(i) {
    const t = ctx.orbit.target;
    const a = i * 2.399963;
    const r = 0.55 * Math.sqrt(i % 14);
    return new THREE.Vector3(t.x + Math.cos(a) * r, 0, t.z + Math.sin(a) * r);
  },
};

// UI widgets first: the inspector needs the number fields
initNumberFields();
initMenus();
initTabs();
initInspector(ctx);

// The fling tool must see pointerdown before OrbitControls, so register it first.
initFling();

const orbit = new OrbitControls(camera, canvas);
orbit.enableDamping = true;
orbit.dampingFactor = 0.08;
orbit.target.copy(HOME_TARGET);
orbit.maxPolarAngle = Math.PI * 0.495;
orbit.minDistance = 1;
orbit.maxDistance = 120;
orbit.update();
ctx.orbit = orbit;

initBuilder(ctx);
initOutliner(ctx);
initInteract(ctx);
initLoaders(ctx);
initTimeline(ctx);

// ----------------------------------------------------------------------------
// Simulation controls
// ----------------------------------------------------------------------------
function setRunning(on) {
  state.running = on;
  $('play-label').textContent = on ? 'Pause' : 'Play';
  document.querySelector('.icon-play').hidden = on;
  document.querySelector('.icon-pause').hidden = !on;
  const pill = $('sim-state');
  pill.textContent = on ? 'Running' : 'Paused';
  pill.classList.toggle('running', on);
  pill.classList.toggle('paused', !on);
}

function doReset() {
  Physics.resetAll();
  setRunning(false);
  refreshInspector(true);
}

function doStep() {
  setRunning(false);
  Physics.stepOnce();
  refreshInspector(false);
}

function detonateAll() {
  const booms = state.fields.filter((f) => f.kind === 'explosion' && f.enabled);
  if (!booms.length) { toast('No explosion fields in the scene. Add one from Add > Force Field.', 'info'); return; }
  booms.forEach(detonate);
  if (!state.running) toast('Blast applied. Press Play to watch the debris fly.', 'info');
}

function clearAll() {
  ctx.select(null);
  clearJoints();
  clearFields();
  clearCloths();
  Physics.clearEntities();
  setRunning(false);
  state.started = false;
  state.frame = 0;
}

$('btn-play').addEventListener('click', () => setRunning(!state.running));
$('btn-step').addEventListener('click', doStep);
$('btn-reset').addEventListener('click', doReset);

// Mouse clicks on buttons should not keep keyboard focus (Space would re-trigger them).
document.addEventListener('click', (ev) => {
  const b = ev.target.closest?.('button');
  if (b && ev.detail > 0) b.blur();
});

window.addEventListener('keydown', (ev) => {
  if (ev.target.closest?.('input, select, textarea')) return;
  if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
  const key = ev.key.toLowerCase();
  if (ev.key === ' ' && ev.target.tagName !== 'BUTTON') { ev.preventDefault(); setRunning(!state.running); }
  else if (key === 'n') doStep();
  else if (key === 'r') doReset();
  else if (key === 'b') detonateAll();
  else if (key === '.') frameSelected();
  else if (key === 'home') resetCamera();
  else if (ev.key === '?') toggleHelp();
});

// ----------------------------------------------------------------------------
// View toggles (overlays, grid, shadows, floor): menu items, overlay buttons and checkboxes stay in sync
// ----------------------------------------------------------------------------
const toggles = {
  colliders: { on: false, apply: (v) => Physics.setDebug(v) },
  velocity:  { on: false, apply: (v) => setOverlay('velocity', v) },
  normals:   { on: false, apply: (v) => setOverlay('normals', v) },
  grid:      { on: true,  apply: (v) => { grid.visible = v; axes.visible = v; } },
  shadows:   { on: true,  apply: (v) => { sun.castShadow = v; } },
  floor:     { on: true,  apply: (v) => { Physics.setFloor(v); ground.visible = v; orbit.maxPolarAngle = v ? Math.PI * 0.495 : Math.PI; } },
};

function setToggle(name, on) {
  const t = toggles[name];
  if (!t) return;
  t.on = on;
  t.apply(on);
  document.querySelectorAll(`[data-toggle="${name}"]`).forEach((b) => b.classList.toggle('on', on));
  const chk = $(`chk-${name}`);
  if (chk) chk.checked = on;
}

document.querySelectorAll('[data-toggle]').forEach((b) =>
  b.addEventListener('click', () => setToggle(b.dataset.toggle, !toggles[b.dataset.toggle].on)));
for (const name of Object.keys(toggles)) {
  const chk = $(`chk-${name}`);
  if (chk) chk.addEventListener('change', () => setToggle(name, chk.checked));
}
for (const name of Object.keys(toggles)) setToggle(name, toggles[name].on);

// ----------------------------------------------------------------------------
// Scene tab: gravity, speed, solver, fling power
// ----------------------------------------------------------------------------
function markGravityPreset(g) {
  document.querySelectorAll('#gravity-presets .chip').forEach((c) => {
    const p = c.dataset.grav.split(',').map(Number);
    c.classList.toggle('active', p.every((v, i) => Math.abs(v - g[i]) < 1e-6));
  });
}
function readGravity() {
  const g = [nf('grav-x').get(), nf('grav-y').get(), nf('grav-z').get()];
  Physics.setGravity(g[0], g[1], g[2]);
  markGravityPreset(g);
}
['x', 'y', 'z'].forEach((a) => nf(`grav-${a}`).on(readGravity));
$('gravity-presets').addEventListener('click', (ev) => {
  const chip = ev.target.closest('[data-grav]');
  if (!chip) return;
  const [x, y, z] = chip.dataset.grav.split(',').map(Number);
  nf('grav-x').set(x, true); nf('grav-y').set(y, true); nf('grav-z').set(z, true);
  readGravity();
});
markGravityPreset([0, -9.82, 0]);

nf('speed').on((v) => { state.timeScale = v; });
nf('iter').on((v) => Physics.setSolverIterations(v));
$('btn-clear').addEventListener('click', () => { clearAll(); toast('Scene cleared.', 'info'); });

// ----------------------------------------------------------------------------
// Menus + workspaces
// ----------------------------------------------------------------------------
const ACTIONS = {
  'new-scene': () => { clearAll(); toast('New empty scene.', 'info'); },
  'load-demo': () => { clearAll(); buildDemoScene(); toast('Demo scene loaded.', 'info'); },
  'add-cloth': () => addCloth(),
  'toggle-play': () => setRunning(!state.running),
  step: doStep,
  reset: doReset,
  'detonate-all': detonateAll,
  'clear-scene': () => { clearAll(); toast('Scene cleared.', 'info'); },
  'frame-selected': () => frameSelected(),
  'reset-camera': () => resetCamera(),
  'toggle-help': () => toggleHelp(),
};
document.querySelectorAll('[data-action]').forEach((b) =>
  b.addEventListener('click', () => ACTIONS[b.dataset.action]?.()));

const WORKSPACES = {
  layout:  { tab: 'object',  overlays: { colliders: false, velocity: false, normals: false } },
  physics: { tab: 'physics', overlays: { colliders: true,  velocity: false, normals: false } },
  debug:   { tab: 'scene',   overlays: { colliders: true,  velocity: true,  normals: true } },
};
function setWorkspace(name) {
  const ws = WORKSPACES[name];
  document.querySelectorAll('.ws-tab').forEach((b) => {
    const on = b.dataset.ws === name;
    b.classList.toggle('active', on);
    b.setAttribute('aria-selected', String(on));
  });
  showPropsTab(ws.tab);
  for (const [k, v] of Object.entries(ws.overlays)) setToggle(k, v);
}
document.querySelectorAll('.ws-tab').forEach((b) => b.addEventListener('click', () => setWorkspace(b.dataset.ws)));

function toggleHelp() { $('help').hidden = !$('help').hidden; }

function frameSelected() {
  const it = ctx.selected;
  if (!it) { toast('Select something to frame.', 'info'); return; }
  const p = new THREE.Vector3();
  it.root.getWorldPosition(p);
  if (it.category === 'cloth' && it.particles.length) {
    const c = it.particles[Math.floor(it.particles.length / 2)].position;
    p.set(c.x, c.y, c.z);
  }
  const offset = camera.position.clone().sub(orbit.target);
  orbit.target.copy(p);
  camera.position.copy(p).add(offset);
}
function resetCamera() {
  camera.position.copy(HOME_POS);
  orbit.target.copy(HOME_TARGET);
  orbit.update();
}

// ----------------------------------------------------------------------------
// Fling tool: click a dynamic body, pull back (slingshot style), release
// ----------------------------------------------------------------------------
function initFling() {
  const MAX_PULL_PX = 220;   // pull length that equals full power
  const LINE_LEN = 3;        // world length of the on-screen band at full pull
  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const right = new THREE.Vector3();
  const up = new THREE.Vector3();
  const pull = new THREE.Vector3();
  let fl = null;
  let warnedStatic = false;
  let autoPlayHinted = false;

  const arrow = new THREE.ArrowHelper(new THREE.Vector3(1, 0, 0), new THREE.Vector3(), 1, 0x7ac74f, 0.4, 0.25);
  arrow.visible = false;
  arrow.renderOrder = 1000;
  for (const m of [arrow.line.material, arrow.cone.material]) { m.depthTest = false; m.transparent = true; }
  scene.add(arrow);

  const bandGeo = new THREE.BufferGeometry();
  bandGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
  const band = new THREE.Line(bandGeo, new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.55, depthTest: false }));
  band.frustumCulled = false;
  band.visible = false;
  band.renderOrder = 999;
  scene.add(band);

  const pointerNdc = (ev) => {
    const r = canvas.getBoundingClientRect();
    ndc.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
  };

  function end() {
    if (!fl) return;
    arrow.visible = false;
    band.visible = false;
    document.body.classList.remove('dragging-fling');
    if (ctx.orbit) ctx.orbit.enabled = true;
    fl = null;
  }

  function update(ev) {
    fl.cx = ev.clientX; fl.cy = ev.clientY;
    const dx = fl.cx - fl.sx;
    const dy = fl.cy - fl.sy;
    const len = Math.hypot(dx, dy);
    fl.frac = Math.min(len / MAX_PULL_PX, 1);

    right.setFromMatrixColumn(camera.matrixWorld, 0);
    up.setFromMatrixColumn(camera.matrixWorld, 1);
    pull.copy(right).multiplyScalar(dx).addScaledVector(up, -dy);
    if (len < 4 || pull.lengthSq() < 1e-9) { fl.launch = null; arrow.visible = false; band.visible = false; return; }
    pull.normalize();
    fl.launch = pull.clone().negate();

    const reach = fl.frac * LINE_LEN;
    const p = band.geometry.attributes.position;
    p.setXYZ(0, fl.point.x, fl.point.y, fl.point.z);
    p.setXYZ(1, fl.point.x + pull.x * reach, fl.point.y + pull.y * reach, fl.point.z + pull.z * reach);
    p.needsUpdate = true;
    band.visible = true;

    const headLen = Math.min(0.4, Math.max(reach * 0.5, 0.05));
    arrow.position.copy(fl.point);
    arrow.setDirection(fl.launch);
    arrow.setLength(Math.max(reach, 0.06), headLen, headLen * 0.65);
    arrow.setColor(new THREE.Color().setHSL(0.34 * (1 - fl.frac), 0.9, 0.55));
    arrow.visible = true;
  }

  canvas.addEventListener('pointerdown', (ev) => {
    if (ctx.tool !== 'fling' || ev.button !== 0) return;
    pointerNdc(ev);
    raycaster.setFromCamera(ndc, camera);
    const hits = raycaster.intersectObjects(state.entities.map((e) => e.mesh), true);
    if (!hits.length) return;                       // empty space: let the camera orbit
    const entity = hits[0].object.userData.entity;
    if (!entity) return;
    if (entity.isStatic) {
      if (!warnedStatic) { warnedStatic = true; toast('Static bodies cannot be flung. Set its type to Active in the Physics tab.', 'info'); }
      return;
    }
    ev.stopImmediatePropagation();                  // keep OrbitControls out of this gesture
    canvas.setPointerCapture(ev.pointerId);
    ctx.select(entity);
    fl = { entity, point: hits[0].point.clone(), sx: ev.clientX, sy: ev.clientY, cx: ev.clientX, cy: ev.clientY, frac: 0, launch: null };
    if (ctx.orbit) ctx.orbit.enabled = false;
    document.body.classList.add('dragging-fling');
  }, true);

  canvas.addEventListener('pointermove', (ev) => { if (fl) update(ev); });

  canvas.addEventListener('pointerup', (ev) => {
    if (!fl) return;
    update(ev);
    const { entity, launch, frac, point } = fl;
    if (canvas.hasPointerCapture(ev.pointerId)) canvas.releasePointerCapture(ev.pointerId);
    end();
    if (!launch || frac < 0.02 || !state.entities.includes(entity)) return;

    // Strength = velocity change in m/s at full pull; applied slightly off-centre for a little spin.
    const mass = entity.body.mass;
    const k = frac * nf('fling').get() * mass;
    const at = new THREE.Vector3(entity.body.position.x, entity.body.position.y, entity.body.position.z).lerp(point, 0.5);
    Physics.applyImpulse(entity, launch.clone().multiplyScalar(k), at);
    if (!state.running) {
      setRunning(true);
      if (!autoPlayHinted) { autoPlayHinted = true; toast('Fling started the simulation.', 'info'); }
    }
  });

  canvas.addEventListener('pointercancel', end);
  window.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') end(); });
}

// ----------------------------------------------------------------------------
// Demo scene: ramp + ball, box pyramid, spring pendulum, hanging cloth with a wind field
// ----------------------------------------------------------------------------
function place(entity, x, y, z) {
  entity.mesh.position.set(x, y, z);
  Physics.syncBodyFromMesh(entity);
  Physics.captureInitial(entity);
}

function buildDemoScene() {
  place(spawnPrimitive('ramp', true), -3, 1, 0);
  const ball = spawnPrimitive('sphere', false);
  place(ball, -1.1, 2.75, 0);

  const rows = [
    { y: 0.5, zs: [-1.1, 0, 1.1] },
    { y: 1.5, zs: [-0.55, 0.55] },
    { y: 2.5, zs: [0] },
  ];
  for (const row of rows) for (const z of row.zs) place(spawnPrimitive('box', false), -8.5, row.y, z);

  // spring pendulum hanging from a fixed point in the world
  const bob = spawnPrimitive('sphere', false);
  bob.mesh.scale.setScalar(0.8);
  Physics.rebuildCollider(bob);
  place(bob, 2.2, 3, -4);
  bob.name = 'Pendulum bob';
  createJoint('spring', bob, null, { pivot: new THREE.Vector3(0, 5.5, -4) });

  // hanging cloth with a localised wind field
  createCloth({ position: new THREE.Vector3(5, 3.6, 0), size: 3, res: 14, pin: 'corners' });
  const wind = createField('wind', new THREE.Vector3(8.5, 2.6, 0));
  wind.root.rotation.y = Math.PI;                 // blow toward -X, onto the cloth
  wind.strength = 6;
  wind.radius = 5;
  wind.turbulence = 0.8;
  wind.name = 'Wind (cloth)';

  ctx.select(null);
}

// ----------------------------------------------------------------------------
// Resize + main loop
// ----------------------------------------------------------------------------
function onResize() {
  const w = Math.max(1, wrap.clientWidth);
  const h = Math.max(1, wrap.clientHeight);
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
new ResizeObserver(onResize).observe(wrap);
window.addEventListener('resize', onResize);
onResize();

const clock = new THREE.Clock();
let inspectorTimer = 0;
let infoTimer = 0;

function frame() {
  requestAnimationFrame(frame);
  const dt = Math.min(clock.getDelta(), 0.1);

  Physics.update(dt);
  updateJointVisuals();
  updateClothVisuals();
  updateFieldVisuals(dt);
  updateOverlays();
  orbit.update();
  updateSelectionHelper();
  for (const fn of ctx.afterFrame) fn();

  inspectorTimer += dt;
  if (inspectorTimer > 0.12) {
    inspectorTimer = 0;
    if (state.running && ctx.selected) refreshInspector(false);
  }

  updateTimeline(dt);

  infoTimer += dt;
  if (infoTimer > 0.2) {
    infoTimer = 0;
    $('vp-selected').textContent = `(${state.frame}) Scene Collection${ctx.selected ? ` | ${ctx.selected.name}` : ''}`;
  }

  renderer.render(scene, camera);
}

buildDemoScene();
setRunning(false);
setWorkspace('layout');
frame();
toast('Press Play (Space) to run the demo. Drag a number field sideways to edit it, or drop an STL / OBJ / GLTF file to import a model.', 'info');

// Handy for debugging in the browser console.
window.__physim = { scene, camera, Physics };
