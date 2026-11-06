// ============================================================================
// app.js: Three.js setup, render loop, simulation / world controls, fling tool
// ============================================================================
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import * as Physics from './physics.js';
import { initBuilder, spawnPrimitive, updateSelectionHelper, refreshInspector } from './builder.js';
import { initLoaders } from './loaders.js';

const $ = (id) => document.getElementById(id);
const { state } = Physics;

// ----------------------------------------------------------------------------
// Renderer, scene, camera
// ----------------------------------------------------------------------------
const canvas = $('viewport');
let renderer;
try {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
} catch (err) {
  document.body.insertAdjacentHTML('beforeend', '<div class="fatal">WebGL is not available in this browser.</div>');
  throw err;
}
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x10141c);
scene.fog = new THREE.Fog(0x10141c, 60, 160);

const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.05, 500);
camera.position.set(4, 5.5, 10);

// ---- lights ----
scene.add(new THREE.HemisphereLight(0xbcd2ff, 0x1a1f2a, 0.35));
const sun = new THREE.DirectionalLight(0xffffff, 1.9);
sun.position.set(8, 14, 6);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.left = -22; sun.shadow.camera.right = 22;
sun.shadow.camera.top = 22; sun.shadow.camera.bottom = -22;
sun.shadow.camera.near = 1; sun.shadow.camera.far = 60;
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.02;
scene.add(sun);

// ---- floor visuals (the physical floor lives in physics.js) ----
const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(400, 400),
  new THREE.MeshStandardMaterial({ color: 0x1a2130, roughness: 0.95, metalness: 0 }),
);
ground.rotation.x = -Math.PI / 2;
ground.position.y = -0.002;
ground.receiveShadow = true;
scene.add(ground);

const grid = new THREE.GridHelper(120, 120, 0x40527a, 0x263147);
grid.position.y = 0.002;
grid.material.transparent = true;
grid.material.opacity = 0.55;
grid.material.depthWrite = false;
scene.add(grid);

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
  toast, loading,
  /** World position near the orbit target where the next object appears (golden-angle spiral). */
  spawnPoint(i) {
    const t = ctx.orbit.target;
    const a = i * 2.399963;
    const r = 0.55 * Math.sqrt(i % 14);
    return new THREE.Vector3(t.x + Math.cos(a) * r, 0, t.z + Math.sin(a) * r);
  },
};

// The fling tool must see pointerdown before OrbitControls, so register it first.
initFling();

const orbit = new OrbitControls(camera, canvas);
orbit.enableDamping = true;
orbit.dampingFactor = 0.08;
orbit.target.set(-3, 1.2, 0);
orbit.maxPolarAngle = Math.PI * 0.495;
orbit.minDistance = 1;
orbit.maxDistance = 120;
orbit.update();
ctx.orbit = orbit;

initBuilder(ctx);
initLoaders(ctx);

// ----------------------------------------------------------------------------
// UI helpers
// ----------------------------------------------------------------------------
function toast(message, type = 'info') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = message;
  $('toasts').appendChild(el);
  const life = type === 'error' ? 6500 : 3800;
  setTimeout(() => el.classList.add('out'), life);
  setTimeout(() => el.remove(), life + 350);
}

function loading(on, text = 'Loading…') {
  $('loading').hidden = !on;
  $('loading-text').textContent = text;
}

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
  refreshInspector();
}

$('btn-play').addEventListener('click', () => setRunning(!state.running));
$('btn-step').addEventListener('click', doStep);
$('btn-reset').addEventListener('click', doReset);

// Mouse clicks on toolbar buttons should not keep keyboard focus (Space would re-trigger them).
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
  else if (ev.key === '?') toggleHelp();
});

// ----------------------------------------------------------------------------
// World controls
// ----------------------------------------------------------------------------
function readGravityInputs() {
  const g = ['x', 'y', 'z'].map((a) => {
    const v = parseFloat($(`grav-${a}`).value);
    return Number.isFinite(v) ? v : 0;
  });
  Physics.setGravity(g[0], g[1], g[2]);
  markGravityPreset(g);
}

function markGravityPreset(g) {
  document.querySelectorAll('#gravity-presets .chip').forEach((c) => {
    const p = c.dataset.grav.split(',').map(Number);
    c.classList.toggle('active', p.every((v, i) => Math.abs(v - g[i]) < 1e-6));
  });
}

['x', 'y', 'z'].forEach((a) => $(`grav-${a}`).addEventListener('input', readGravityInputs));
$('gravity-presets').addEventListener('click', (ev) => {
  const chip = ev.target.closest('[data-grav]');
  if (!chip) return;
  const [x, y, z] = chip.dataset.grav.split(',').map(Number);
  $('grav-x').value = x; $('grav-y').value = y; $('grav-z').value = z;
  readGravityInputs();
});
markGravityPreset([0, -9.82, 0]);

$('rng-speed').addEventListener('input', (ev) => {
  state.timeScale = parseFloat(ev.target.value);
  $('rng-speed-val').textContent = `${state.timeScale.toFixed(2)}×`;
});

let flingPower = 14;
$('rng-fling').addEventListener('input', (ev) => {
  flingPower = parseFloat(ev.target.value);
  $('rng-fling-val').textContent = String(flingPower);
});

$('chk-colliders').addEventListener('change', (ev) => Physics.setDebug(ev.target.checked));

$('chk-floor').addEventListener('change', (ev) => {
  const on = ev.target.checked;
  Physics.setFloor(on);
  ground.visible = on;
  orbit.maxPolarAngle = on ? Math.PI * 0.495 : Math.PI;
});

$('chk-shadows').addEventListener('change', (ev) => { sun.castShadow = ev.target.checked; });

$('btn-clear').addEventListener('click', () => {
  ctx.select(null);
  Physics.clearEntities();
  setRunning(false);
  state.started = false;
});

// panel + help
const panel = $('side-panel');
function setPanelCollapsed(c) {
  panel.classList.toggle('collapsed', c);
  $('panel-toggle').setAttribute('aria-expanded', String(!c));
}
$('panel-toggle').addEventListener('click', () => setPanelCollapsed(!panel.classList.contains('collapsed')));
if (window.innerWidth <= 720) setPanelCollapsed(true);

function toggleHelp() { $('help').hidden = !$('help').hidden; }
$('btn-help').addEventListener('click', toggleHelp);

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

  const arrow = new THREE.ArrowHelper(new THREE.Vector3(1, 0, 0), new THREE.Vector3(), 1, 0x3ddc97, 0.4, 0.25);
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
      if (!warnedStatic) { warnedStatic = true; toast('Static bodies cannot be flung. Untick “Static collider” to make it dynamic.', 'info'); }
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
    const k = frac * flingPower * mass;
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
// Demo scene (a ball, a ramp and a small box pyramid)
// ----------------------------------------------------------------------------
function place(entity, x, y, z) {
  entity.mesh.position.set(x, y, z);
  Physics.syncBodyFromMesh(entity);
  Physics.captureInitial(entity);
}

function buildDemoScene() {
  place(spawnPrimitive('ramp', true), -3, 1, 0);
  const ball = spawnPrimitive('sphere', false);
  ball.mesh.scale.setScalar(1);
  place(ball, -1.1, 2.75, 0);
  const rows = [
    { y: 0.5, zs: [-1.1, 0, 1.1] },
    { y: 1.5, zs: [-0.55, 0.55] },
    { y: 2.5, zs: [0] },
  ];
  for (const row of rows) for (const z of row.zs) place(spawnPrimitive('box', false), -8.5, row.y, z);
  ctx.select(null);
}

// ----------------------------------------------------------------------------
// Resize + main loop
// ----------------------------------------------------------------------------
function onResize() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', onResize);

const clock = new THREE.Clock();
let fpsFrames = 0;
let fpsTime = 0;
let inspectorTimer = 0;

function frame() {
  requestAnimationFrame(frame);
  const dt = Math.min(clock.getDelta(), 0.1);

  Physics.update(dt);
  orbit.update();
  updateSelectionHelper();

  inspectorTimer += dt;
  if (inspectorTimer > 0.12) {
    inspectorTimer = 0;
    if (state.running && ctx.selected) refreshInspector(false);
  }

  fpsFrames++;
  fpsTime += dt;
  if (fpsTime >= 0.5) {
    $('hud-fps').textContent = `${Math.round(fpsFrames / fpsTime)} fps`;
    const n = state.entities.length;
    $('hud-bodies').textContent = `${n} ${n === 1 ? 'body' : 'bodies'}`;
    fpsFrames = 0;
    fpsTime = 0;
  }

  renderer.render(scene, camera);
}

buildDemoScene();
setRunning(false);
frame();
toast('Press Play (Space) to run the demo. Drop an STL, OBJ or GLTF/GLB file to import your own model.', 'info');

// Handy for debugging in the browser console.
window.__physicsLab = { scene, camera, Physics };
