// ============================================================================
// builder.js: primitive spawning, selection, transform gizmo, inspector panel
// ============================================================================
import * as THREE from 'three';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import {
  state, MIN_SCALE, createEntity, removeEntity, pointsFromObject, captureInitial,
  shouldCaptureInitial, syncBodyFromMesh, rebuildCollider, setStatic, setMass,
  setMaterialProps, setColliderType, applyImpulse,
} from './physics.js';

const $ = (id) => document.getElementById(id);
const TRANSFORM_TOOLS = ['translate', 'rotate', 'scale'];

let ctx = null;
let transform = null;
let selBox = null;
let selected = null;
let spawnStatic = false;
let spawnCount = 0;
let hintedPaused = false;

// ----------------------------------------------------------------------------
// Unit-sized primitive geometries (final size comes from mesh.scale)
// ----------------------------------------------------------------------------
function makeGeometry(kind) {
  switch (kind) {
    case 'sphere': return new THREE.SphereGeometry(0.5, 32, 20);
    case 'box': return new THREE.BoxGeometry(1, 1, 1);
    case 'cylinder': return new THREE.CylinderGeometry(0.5, 0.5, 1, 32);
    case 'ramp': {
      // right triangle in XY (rises towards +X), extruded 1 unit along Z, centred on the origin
      const shape = new THREE.Shape();
      shape.moveTo(-0.5, -0.5);
      shape.lineTo(0.5, -0.5);
      shape.lineTo(0.5, 0.5);
      shape.closePath();
      const g = new THREE.ExtrudeGeometry(shape, { depth: 1, bevelEnabled: false });
      g.translate(0, 0, -0.5);
      return g;
    }
    default: throw new Error(`Unknown primitive: ${kind}`);
  }
}

const PRESETS = {
  dynamic: {
    sphere:   { scale: [1, 1, 1],       mass: 1,   restitution: 0.55 },
    box:      { scale: [1, 1, 1],       mass: 1,   restitution: 0.25 },
    cylinder: { scale: [1, 1.2, 1],     mass: 1.5, restitution: 0.25 },
    ramp:     { scale: [1.2, 0.8, 1.2], mass: 1,   restitution: 0.2 },
  },
  static: {
    sphere:   { scale: [2, 2, 2],       mass: 0,   restitution: 0.3 },
    box:      { scale: [4, 0.5, 4],     mass: 0,   restitution: 0.3 },
    cylinder: { scale: [1.5, 3, 1.5],   mass: 0,   restitution: 0.3 },
    ramp:     { scale: [5, 2, 3],       mass: 0,   restitution: 0.3 },
  },
};

export function spawnPrimitive(kind, isStatic = spawnStatic) {
  const preset = PRESETS[isStatic ? 'static' : 'dynamic'][kind];
  const geometry = makeGeometry(kind);
  const color = isStatic
    ? new THREE.Color().setHSL(0.6, 0.18, 0.46 + Math.random() * 0.08)
    : new THREE.Color().setHSL(Math.random(), 0.7, 0.58);
  const material = new THREE.MeshStandardMaterial({ color, roughness: 0.55, metalness: 0.08 });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.castShadow = true;
  mesh.receiveShadow = true;

  const localPoints = kind === 'box' ? [] : pointsFromObject(mesh);
  mesh.scale.set(...preset.scale);

  const sp = ctx.spawnPoint(spawnCount++);
  const h = preset.scale[1];
  mesh.position.set(sp.x, isStatic ? h / 2 : 3 + h / 2, sp.z);
  mesh.name = `${isStatic ? 'Static ' : ''}${kind}`;

  const entity = createEntity({
    name: `${kind} ${state.nextId}`,
    kind,
    mesh,
    localPoints,
    isStatic,
    mass: preset.mass || 1,
    friction: 0.5,
    restitution: preset.restitution,
  });
  select(entity);
  return entity;
}

// ----------------------------------------------------------------------------
// Selection + gizmo
// ----------------------------------------------------------------------------
export function select(entity) {
  if (selected) selected.dragging = false;
  selected = entity || null;
  ctx.selected = selected;

  if (selBox) { ctx.scene.remove(selBox); selBox.geometry.dispose(); selBox.material.dispose(); selBox = null; }
  if (selected) {
    selBox = new THREE.BoxHelper(selected.mesh, 0x4f8cff);
    selBox.material.depthTest = false;
    selBox.renderOrder = 998;
    ctx.scene.add(selBox);
  }
  applyTool();
  $('btn-delete').disabled = !selected;
  $('sel-empty').hidden = !!selected;
  $('sel-body').hidden = !selected;
  refreshInspector(true);
}

export function updateSelectionHelper() {
  if (selBox && selected) selBox.update();
}

export function setTool(tool) {
  ctx.tool = tool;
  document.querySelectorAll('[data-tool]').forEach((b) => b.classList.toggle('active', b.dataset.tool === tool));
  document.body.classList.toggle('tool-fling', tool === 'fling');
  applyTool();
}

function applyTool() {
  if (selected && TRANSFORM_TOOLS.includes(ctx.tool)) {
    transform.setMode(ctx.tool);
    transform.attach(selected.mesh);
  } else {
    transform.detach();
  }
}

function onObjectChange() {
  if (!selected) return;
  selected.mesh.scale.max(new THREE.Vector3(MIN_SCALE, MIN_SCALE, MIN_SCALE));
  syncBodyFromMesh(selected);
  refreshInspector(true);
}

function onDragEnd() {
  if (!selected) return;
  if (ctx.tool === 'scale') rebuildCollider(selected);
  syncBodyFromMesh(selected);
  if (shouldCaptureInitial(selected)) captureInitial(selected);
  refreshInspector(true);
}

// ----------------------------------------------------------------------------
// Inspector panel
// ----------------------------------------------------------------------------
const num = (v, d = 2) => (Math.round(v * 10 ** d) / 10 ** d).toString();

function setIfIdle(id, value) {
  const el = $(id);
  if (document.activeElement !== el) el.value = value;
}

/** Push entity values into the inputs. `force` also refreshes the static controls (name, sliders...). */
export function refreshInspector(force = false) {
  if (!selected) return;
  const e = selected;
  const m = e.mesh;

  if (force) {
    setIfIdle('sel-name', e.name);
    $('sel-kind').textContent = e.kind;
    $('sel-static').checked = e.isStatic;
    setIfIdle('sel-mass', num(e.mass));
    $('sel-mass').disabled = e.isStatic;
    $('sel-restitution').value = e.restitution;
    $('sel-restitution-val').textContent = e.restitution.toFixed(2);
    $('sel-friction').value = e.friction;
    $('sel-friction-val').textContent = e.friction.toFixed(2);
    $('row-collider').hidden = e.kind !== 'model';
    $('sel-collider').value = e.colliderType;
    document.querySelectorAll('#impulse-grid button').forEach((b) => { b.disabled = e.isStatic; });
  }

  setIfIdle('sel-pos-x', num(m.position.x)); setIfIdle('sel-pos-y', num(m.position.y)); setIfIdle('sel-pos-z', num(m.position.z));
  const deg = THREE.MathUtils.radToDeg;
  setIfIdle('sel-rot-x', num(deg(m.rotation.x), 1)); setIfIdle('sel-rot-y', num(deg(m.rotation.y), 1)); setIfIdle('sel-rot-z', num(deg(m.rotation.z), 1));
  setIfIdle('sel-scale-x', num(m.scale.x)); setIfIdle('sel-scale-y', num(m.scale.y)); setIfIdle('sel-scale-z', num(m.scale.z));
}

function commitTransform(rebuild) {
  if (!selected) return;
  if (rebuild) rebuildCollider(selected);
  syncBodyFromMesh(selected);
  if (shouldCaptureInitial(selected)) captureInitial(selected);
  updateSelectionHelper();
}

function readNum(id, fallback) {
  const v = parseFloat($(id).value);
  return Number.isFinite(v) ? v : fallback;
}

function bindInspector() {
  $('sel-name').addEventListener('input', (ev) => {
    if (!selected) return;
    selected.name = ev.target.value || selected.kind;
    selected.mesh.name = selected.name;
  });

  $('sel-static').addEventListener('change', (ev) => {
    if (!selected) return;
    setStatic(selected, ev.target.checked);
    refreshInspector(true);
  });

  $('sel-mass').addEventListener('input', () => {
    if (selected) setMass(selected, readNum('sel-mass', selected.mass));
  });

  $('sel-restitution').addEventListener('input', (ev) => {
    if (!selected) return;
    const v = parseFloat(ev.target.value);
    setMaterialProps(selected, { restitution: v });
    $('sel-restitution-val').textContent = v.toFixed(2);
  });
  $('sel-friction').addEventListener('input', (ev) => {
    if (!selected) return;
    const v = parseFloat(ev.target.value);
    setMaterialProps(selected, { friction: v });
    $('sel-friction-val').textContent = v.toFixed(2);
  });

  $('sel-collider').addEventListener('change', (ev) => {
    if (selected) setColliderType(selected, ev.target.value);
  });

  // position / rotation
  for (const axis of ['x', 'y', 'z']) {
    $(`sel-pos-${axis}`).addEventListener('input', () => {
      if (!selected) return;
      selected.mesh.position[axis] = readNum(`sel-pos-${axis}`, selected.mesh.position[axis]);
      commitTransform(false);
    });
    $(`sel-rot-${axis}`).addEventListener('input', () => {
      if (!selected) return;
      const r = selected.mesh.rotation;
      r[axis] = THREE.MathUtils.degToRad(readNum(`sel-rot-${axis}`, 0));
      selected.mesh.quaternion.setFromEuler(r);
      commitTransform(false);
    });
    $(`sel-scale-${axis}`).addEventListener('input', () => {
      if (!selected) return;
      const v = Math.max(MIN_SCALE, readNum(`sel-scale-${axis}`, selected.mesh.scale[axis]));
      if ($('sel-uniform').checked) {
        const old = selected.mesh.scale[axis] || 1;
        selected.mesh.scale.multiplyScalar(v / old);
      } else {
        selected.mesh.scale[axis] = v;
      }
      commitTransform(true);
      refreshInspector();
    });
  }

  // impulses (strength = velocity change in m/s, so heavier bodies get bigger impulses)
  const strength = $('imp-strength');
  strength.addEventListener('input', () => { $('imp-strength-val').textContent = strength.value; });
  $('impulse-grid').addEventListener('click', (ev) => {
    const btn = ev.target.closest('[data-imp]');
    if (!btn || !selected || selected.isStatic) return;
    const [x, y, z] = btn.dataset.imp.split(',').map(Number);
    const k = parseFloat(strength.value) * selected.body.mass;
    applyImpulse(selected, new THREE.Vector3(x * k, y * k, z * k));
    if (!state.running && !hintedPaused) {
      hintedPaused = true;
      ctx.toast('Impulse applied. Press Play to see it move.', 'info');
    }
  });
}

// ----------------------------------------------------------------------------
// Init
// ----------------------------------------------------------------------------
export function initBuilder(context) {
  ctx = context;
  ctx.tool = 'select';
  ctx.selected = null;
  ctx.select = select;

  transform = new TransformControls(ctx.camera, ctx.renderer.domElement);
  transform.setSize(0.85);
  ctx.scene.add(transform);
  ctx.transform = transform;
  transform.addEventListener('dragging-changed', (ev) => {
    ctx.orbit.enabled = !ev.value;
    if (selected) selected.dragging = ev.value;
    if (!ev.value) { ctx.lastGizmoDrag = performance.now(); onDragEnd(); }
  });
  transform.addEventListener('objectChange', onObjectChange);

  // spawn buttons + spawn mode
  document.querySelectorAll('[data-spawn]').forEach((b) =>
    b.addEventListener('click', () => spawnPrimitive(b.dataset.spawn)));
  document.querySelectorAll('[data-spawnmode]').forEach((b) =>
    b.addEventListener('click', () => {
      spawnStatic = b.dataset.spawnmode === 'static';
      document.querySelectorAll('[data-spawnmode]').forEach((o) => o.classList.toggle('active', o === b));
    }));

  // tools
  document.querySelectorAll('[data-tool]').forEach((b) =>
    b.addEventListener('click', () => setTool(b.dataset.tool)));

  $('btn-delete').addEventListener('click', deleteSelected);

  // click-to-select (ignored for gizmo interaction, fling tool and orbit drags)
  const canvas = ctx.renderer.domElement;
  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  let down = null;
  canvas.addEventListener('pointerdown', (ev) => {
    down = { x: ev.clientX, y: ev.clientY, t: performance.now(), onGizmo: !!transform.axis, button: ev.button };
  });
  canvas.addEventListener('pointerup', (ev) => {
    if (!down || down.button !== 0 || down.onGizmo || ctx.tool === 'fling') { down = null; return; }
    const moved = Math.hypot(ev.clientX - down.x, ev.clientY - down.y);
    const quick = performance.now() - down.t < 500;
    const afterGizmo = performance.now() - (ctx.lastGizmoDrag || 0) < 150;
    down = null;
    if (moved > 5 || !quick || afterGizmo) return;

    const rect = canvas.getBoundingClientRect();
    ndc.set(((ev.clientX - rect.left) / rect.width) * 2 - 1, -((ev.clientY - rect.top) / rect.height) * 2 + 1);
    raycaster.setFromCamera(ndc, ctx.camera);
    const hits = raycaster.intersectObjects(state.entities.map((e) => e.mesh), true);
    select(hits.length ? hits[0].object.userData.entity || null : null);
  });

  // keyboard shortcuts
  window.addEventListener('keydown', (ev) => {
    if (ev.target.closest?.('input, select, textarea')) return;
    if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
    const key = ev.key.toLowerCase();
    const map = { q: 'select', w: 'translate', e: 'rotate', t: 'scale', f: 'fling' };
    if (map[key]) setTool(map[key]);
    else if (key === 'delete' || key === 'backspace') { deleteSelected(); ev.preventDefault(); }
    else if (key === 'escape') select(null);
  });

  bindInspector();
  select(null);
}

export function deleteSelected() {
  if (!selected) return;
  const e = selected;
  select(null);
  removeEntity(e);
}
