// ============================================================================
// builder.js: spawning, selection, transform gizmo, picking, delete, shortcuts
// ============================================================================
import * as THREE from 'three';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import {
  state, MIN_SCALE, createEntity, removeEntity, pointsFromObject, syncBodyFromMesh, allItems, on, emit, setDamping,
} from './physics.js';
import { createJoint, removeJoint, nearestPartner, usesPivot } from './joints.js';
import { createField, removeField } from './fields.js';
import { createCloth, removeCloth, rebuildCloth } from './cloth.js';
import { commitTransform, refreshInspector } from './inspector.js';
import { highlight, setItemVisible } from './outliner.js';

const TRANSFORM_TOOLS = ['translate', 'rotate', 'scale'];

let ctx = null;
let transform = null;
let selBox = null;
let selected = null;
let spawnCount = 0;

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

export function spawnPrimitive(kind, isStatic = false) {
  const preset = PRESETS[isStatic ? 'static' : 'dynamic'][kind];
  const geometry = makeGeometry(kind);
  const color = isStatic
    ? new THREE.Color().setHSL(0.6, 0.12, 0.42 + Math.random() * 0.08)
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

  const entity = createEntity({
    name: `${isStatic ? 'Static ' : ''}${kind.charAt(0).toUpperCase()}${kind.slice(1)} ${state.nextId}`,
    kind,
    mesh,
    localPoints,
    isStatic,
    mass: preset.mass || 1,
    friction: 0.5,
    restitution: preset.restitution,
  });
  mesh.name = entity.name;
  select(entity);
  return entity;
}

// ----------------------------------------------------------------------------
// Joints, force fields, cloth
// ----------------------------------------------------------------------------
export function addJoint(kind) {
  let a = selected?.category === 'body' ? selected : selected?.category === 'constraint' ? selected.a : null;
  if (!a) a = state.entities.find((e) => !e.isStatic) || state.entities[0];
  if (!a) { ctx.toast('Add a rigid body first. Joints connect bodies.', 'error'); return null; }

  let b = nearestPartner(a);
  if (a.isStatic && b && !b.isStatic) [a, b] = [b, a];          // keep the dynamic body as "A"
  if (a.isStatic && (!b || b.isStatic)) ctx.toast('Both ends are static, so the joint will be inactive until one body is Active.', 'info');

  const joint = createJoint(kind, a, b);
  select(joint);
  return joint;
}

export function addField(kind) {
  const sp = ctx.spawnPoint(spawnCount++);
  const y = kind === 'explosion' ? 0.4 : kind === 'wind' ? 2 : 3;
  const f = createField(kind, new THREE.Vector3(sp.x, y, sp.z));
  select(f);
  return f;
}

export function addCloth() {
  const sp = ctx.spawnPoint(spawnCount++);
  const c = createCloth({ position: new THREE.Vector3(sp.x, 4.5, sp.z) });
  select(c);
  return c;
}

// ----------------------------------------------------------------------------
// Selection + gizmo
// ----------------------------------------------------------------------------
function gizmoAllows(item, tool) {
  if (!item || !TRANSFORM_TOOLS.includes(tool)) return false;
  switch (item.category) {
    case 'body': return true;
    case 'field': return tool !== 'scale';
    case 'cloth': return tool !== 'scale';
    case 'constraint': return tool === 'translate' && usesPivot(item);
    default: return false;
  }
}

export function select(item) {
  if (selected) { selected.dragging = false; selected.setHighlight?.(false); }
  selected = item || null;
  ctx.selected = selected;

  if (selBox) { ctx.scene.remove(selBox); selBox.geometry.dispose(); selBox.material.dispose(); selBox = null; }
  if (selected) {
    selected.setHighlight?.(true);
    if (selected.category === 'body') {
      selBox = new THREE.BoxHelper(selected.mesh, 0xf57c00);
      selBox.material.depthTest = false;
      selBox.renderOrder = 998;
      ctx.scene.add(selBox);
    }
  }
  applyTool();
  highlight();
  refreshInspector(true);
}

export function updateSelectionHelper() {
  if (selBox && selected) selBox.update();
}

export function setTool(tool) {
  ctx.tool = tool;
  document.querySelectorAll('[data-tool]').forEach((b) => b.classList.toggle('active', b.dataset.tool === tool));
  document.body.classList.toggle('tool-fling', tool === 'fling');
  document.body.classList.toggle('tool-grab', tool === 'grab');
  applyTool();
}

function applyTool() {
  if (selected && gizmoAllows(selected, ctx.tool)) {
    transform.setMode(ctx.tool);
    transform.attach(selected.root);
  } else {
    transform.detach();
  }
}

function onObjectChange() {
  const it = selected;
  if (!it) return;
  if (it.category === 'body') {
    it.mesh.scale.max(new THREE.Vector3(MIN_SCALE, MIN_SCALE, MIN_SCALE));
    syncBodyFromMesh(it);
  } else if (it.category === 'constraint') {
    it.pivot.copy(it.root.position);
  }
  refreshInspector(false);
}

function onDragEnd() {
  if (!selected) return;
  commitTransform(selected, ctx.tool === 'scale');
  refreshInspector(true);
}

// ----------------------------------------------------------------------------
// Delete
// ----------------------------------------------------------------------------
export function deleteSelected() {
  const it = selected;
  if (!it) return;
  select(null);
  switch (it.category) {
    case 'body': removeEntity(it); break;
    case 'constraint': removeJoint(it); break;
    case 'field': removeField(it); break;
    case 'cloth': removeCloth(it); break;
    default: break;
  }
}

// ----------------------------------------------------------------------------
// Duplicate / hide / cycle selection
// ----------------------------------------------------------------------------
function deepCloneObject(root) {
  const c = root.clone(true);
  c.traverse((o) => {
    if (o.isMesh) {
      o.geometry = o.geometry.clone();
      o.material = Array.isArray(o.material) ? o.material.map((m) => m.clone()) : o.material.clone();
    }
  });
  return c;
}

export function duplicateSelected() {
  const it = selected;
  if (!it) { ctx.toast('Select something to duplicate.', 'info'); return null; }
  let copy = null;

  if (it.category === 'body') {
    const mesh = deepCloneObject(it.mesh);
    mesh.position.add(new THREE.Vector3(0.7, it.isStatic ? 0 : 0.4, 0.7));
    copy = createEntity({
      name: `${it.name} copy`,
      kind: it.kind,
      mesh,
      localPoints: it.localPoints.map((p) => p.clone()),
      colliderType: it.colliderType,
      isStatic: it.isStatic,
      mass: it.mass,
      friction: it.friction,
      restitution: it.restitution,
    });
    setDamping(copy, it.linearDamping, it.angularDamping);
  } else if (it.category === 'field') {
    copy = createField(it.kind, it.root.position.clone().add(new THREE.Vector3(1, 0, 1)));
    Object.assign(copy, { name: `${it.name} copy`, enabled: it.enabled, strength: it.strength, radius: it.radius, falloff: it.falloff, turbulence: it.turbulence, triggerFrame: it.triggerFrame });
    copy.root.quaternion.copy(it.root.quaternion);
  } else if (it.category === 'cloth') {
    copy = createCloth({ res: it.res, size: it.size, pin: it.pin, position: it.root.position.clone().add(new THREE.Vector3(1, 0, 1)) });
    copy.root.quaternion.copy(it.root.quaternion);
    Object.assign(copy, { name: `${it.name} copy`, stiffness: it.stiffness, damping: it.damping });
    setClothMassSafe(copy, it.pMass);
    rebuildClothSafe(copy);
  } else {
    ctx.toast('Joints cannot be duplicated. Add a new one from the Add menu.', 'info');
    return null;
  }
  emit('scene');
  select(copy);
  return copy;
}

function setClothMassSafe(c, m) { c.pMass = m; }
function rebuildClothSafe(c) { rebuildCloth(c); }

export function hideSelected() {
  if (!selected) return;
  setItemVisible(selected, false);
  emit('scene');
}

export function showAll() {
  for (const it of allItems()) if (it.visible === false) setItemVisible(it, true);
  emit('scene');
  refreshInspector(true);
}

export function cycleSelection(dir) {
  const items = allItems();
  if (!items.length) return;
  const i = selected ? items.indexOf(selected) : -1;
  select(items[(i + dir + items.length) % items.length]);
}

// ----------------------------------------------------------------------------
// Init
// ----------------------------------------------------------------------------
export function initBuilder(context) {
  ctx = context;
  ctx.tool = 'select';
  ctx.selected = null;
  ctx.select = select;
  ctx.deleteSelected = deleteSelected;

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

  // spawn menu items
  document.querySelectorAll('[data-spawn]').forEach((b) =>
    b.addEventListener('click', () => spawnPrimitive(b.dataset.spawn, b.dataset.static === '1')));
  document.querySelectorAll('[data-joint]').forEach((b) => b.addEventListener('click', () => addJoint(b.dataset.joint)));
  document.querySelectorAll('[data-field]').forEach((b) => b.addEventListener('click', () => addField(b.dataset.field)));

  // tools
  document.querySelectorAll('[data-tool]').forEach((b) => b.addEventListener('click', () => setTool(b.dataset.tool)));

  // click-to-select (ignored for gizmo use, the fling / grab tools and orbit drags)
  const canvas = ctx.renderer.domElement;
  const raycaster = new THREE.Raycaster();
  raycaster.params.Line.threshold = 0.12;
  const ndc = new THREE.Vector2();
  let down = null;
  canvas.addEventListener('pointerdown', (ev) => {
    down = { x: ev.clientX, y: ev.clientY, t: performance.now(), onGizmo: !!transform.axis, button: ev.button };
  });
  canvas.addEventListener('pointerup', (ev) => {
    const d = down;
    down = null;
    if (!d || d.button !== 0 || d.onGizmo || ctx.tool === 'fling' || ctx.tool === 'grab') return;
    const moved = Math.hypot(ev.clientX - d.x, ev.clientY - d.y);
    const quick = performance.now() - d.t < 500;
    const afterGizmo = performance.now() - (ctx.lastGizmoDrag || 0) < 150;
    if (moved > 5 || !quick || afterGizmo) return;

    const rect = canvas.getBoundingClientRect();
    ndc.set(((ev.clientX - rect.left) / rect.width) * 2 - 1, -((ev.clientY - rect.top) / rect.height) * 2 + 1);
    raycaster.setFromCamera(ndc, ctx.camera);
    const targets = [];
    for (const it of allItems()) {
      if (it.visible === false) continue;
      if (it.pick) targets.push(...it.pick); else targets.push(it.root);
    }
    const hits = raycaster.intersectObjects(targets, true);
    const hit = hits.find((h) => h.object.userData.entity);
    select(hit ? hit.object.userData.entity : null);
  });

  // keyboard shortcuts
  window.addEventListener('keydown', (ev) => {
    if (ev.target.closest?.('input, select, textarea')) return;
    if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
    const key = ev.key.toLowerCase();
    const map = { q: 'select', w: 'translate', e: 'rotate', t: 'scale', f: 'fling', g: 'grab' };
    const bare = ev.target === document.body || ev.target === canvas;
    if (ev.shiftKey && key === 'd') { duplicateSelected(); ev.preventDefault(); }
    else if (ev.shiftKey && key === 'h') showAll();
    else if (!ev.shiftKey && key === 'h') hideSelected();
    else if (key === 'tab' && bare) { cycleSelection(ev.shiftKey ? -1 : 1); ev.preventDefault(); }
    else if (ev.shiftKey) return;
    else if (map[key]) setTool(map[key]);
    else if (key === 'delete' || key === 'backspace' || key === 'x') { if (selected) { deleteSelected(); ev.preventDefault(); } }
    else if (key === 'escape') select(null);
  });

  // drop the selection if the selected item disappears (e.g. its body was deleted)
  on('scene', () => { if (selected && !allItems().includes(selected)) select(null); });

  select(null);
}
