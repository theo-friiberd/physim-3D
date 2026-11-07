// ============================================================================
// inspector.js: Physics + Object property tabs for the current selection
// ============================================================================
import * as THREE from 'three';
import {
  state, MIN_SCALE, emit, on, captureInitial, shouldCaptureInitial, syncBodyFromMesh, rebuildCollider,
  setStatic, setMass, setMaterialProps, setColliderType, setDamping, applyImpulse,
} from './physics.js';
import { buildJoint, usesPivot, JOINT_LABELS } from './joints.js';
import { detonate, applyVisual, FIELD_LABELS } from './fields.js';
import { rebuildCloth, setClothMass } from './cloth.js';
import { nf } from './ui.js';
import { setItemVisible } from './outliner.js';

const $ = (id) => document.getElementById(id);
const deg = THREE.MathUtils.radToDeg;
const rad = THREE.MathUtils.degToRad;

let ctx = null;
let hintedImpulse = false;
let hintedBoom = false;

const FIELD_HINTS = {
  wind: 'Blows along the field\'s +X axis (the arrows). Rotate the field to aim it. Radius 0 means the whole scene.',
  attractor: 'Pulls bodies and cloth toward the field. Negative strength repels. Falloff 2 is inverse-square.',
  explosion: 'Detonate gives everything inside the radius a one-shot outward velocity kick. Press Play first to see it.',
};

// ----------------------------------------------------------------------------
// Shared: commit a hand-made transform change to the simulation
// ----------------------------------------------------------------------------
export function commitTransform(item, scaleChanged = false) {
  switch (item.category) {
    case 'body':
      if (scaleChanged) rebuildCollider(item);
      syncBodyFromMesh(item);
      if (shouldCaptureInitial(item)) captureInitial(item);
      emit('transform', item);
      break;
    case 'constraint':
      item.pivot.copy(item.root.position);
      buildJoint(item);
      break;
    case 'cloth':
      rebuildCloth(item);
      break;
    default:
      break;
  }
}

// ----------------------------------------------------------------------------
// Refresh the panels from the selected item
// ----------------------------------------------------------------------------
const setSel = (id, v) => { const el = $(id); if (document.activeElement !== el) el.value = v; };

function fillBodySelect(select, bodies, current, allowWorld) {
  const frag = document.createDocumentFragment();
  if (allowWorld) { const o = document.createElement('option'); o.value = '0'; o.textContent = 'World (fixed point)'; frag.appendChild(o); }
  for (const e of bodies) {
    const o = document.createElement('option');
    o.value = String(e.id); o.textContent = e.name;
    frag.appendChild(o);
  }
  select.replaceChildren(frag);
  select.value = current ? String(current.id) : '0';
}

export function refreshInspector(force = false) {
  const it = ctx.selected;

  if (force || !it) {
    $('obj-empty').hidden = !!it;
    $('obj-body').hidden = !it;
    for (const id of ['phys-body', 'phys-field', 'phys-joint', 'phys-cloth']) $(id).hidden = true;
    $('phys-none').hidden = !!it;
  }
  if (!it) return;

  const m = it.root;
  if (force) {
    setSel('obj-name', it.name);
    $('obj-kind').textContent = it.category === 'body' ? it.kind : it.category === 'constraint' ? JOINT_LABELS[it.kind] : it.category === 'field' ? FIELD_LABELS[it.kind] : 'Cloth';
    $('obj-visible').checked = it.visible !== false;
    $('row-scale').hidden = !it.scalable;
  }

  const loc = it.category === 'constraint' && !usesPivot(it) ? false : true;
  for (const a of ['x', 'y', 'z']) {
    nf(`loc-${a}`).set(m.position[a], true);
    nf(`loc-${a}`).setDisabled(!loc);
    nf(`rot-${a}`).set(deg(m.rotation[a]), true);
    nf(`rot-${a}`).setDisabled(it.category === 'constraint');
    if (it.scalable) nf(`scl-${a}`).set(m.scale[a], true);
  }

  if (!force) return;

  if (it.category === 'body') {
    $('phys-body').hidden = false;
    $('sel-type').value = it.isStatic ? 'passive' : 'active';
    nf('mass').set(it.mass, true);
    nf('mass').setDisabled(it.isStatic);
    nf('restitution').set(it.restitution, true);
    nf('friction').set(it.friction, true);
    nf('lindamp').set(it.linearDamping, true);
    nf('angdamp').set(it.angularDamping, true);
    $('row-collider').hidden = it.kind !== 'model';
    $('sel-collider').value = it.colliderType;
    document.querySelectorAll('#impulse-grid button').forEach((b) => { b.disabled = it.isStatic; });
  } else if (it.category === 'field') {
    $('phys-field').hidden = false;
    $('fld-title').textContent = `${FIELD_LABELS[it.kind]} Field`;
    $('fld-enabled').checked = it.enabled;
    nf('fld-strength').set(it.strength, true);
    nf('fld-radius').set(it.radius, true);
    nf('fld-falloff').set(it.falloff, true);
    nf('fld-turb').set(it.turbulence, true);
    nf('fld-trigger').set(it.triggerFrame, true);
    nf('fld-falloff').show(it.kind !== 'wind');
    nf('fld-turb').show(it.kind === 'wind');
    nf('fld-trigger').show(it.kind === 'explosion');
    $('btn-detonate').hidden = it.kind !== 'explosion';
    $('fld-hint').textContent = FIELD_HINTS[it.kind];
    const strengthField = nf('fld-strength');
    strengthField.label = it.kind === 'explosion' ? 'Blast Speed' : it.kind === 'wind' ? 'Wind Force' : 'Pull Strength';
    strengthField.render();
  } else if (it.category === 'constraint') {
    $('phys-joint').hidden = false;
    $('jnt-title').textContent = JOINT_LABELS[it.kind];
    fillBodySelect($('jnt-a'), state.entities, it.a, false);
    fillBodySelect($('jnt-b'), state.entities.filter((e) => e !== it.a), it.b, true);
    const lengthy = it.kind === 'distance' || it.kind === 'spring';
    nf('jnt-length').show(lengthy);
    nf('jnt-stiff').show(it.kind === 'spring');
    nf('jnt-damp').show(it.kind === 'spring');
    $('jnt-axis-sec').hidden = it.kind !== 'hinge';
    $('jnt-pivot-sec').hidden = !usesPivot(it);
    nf('jnt-length').set(it.restLength, true);
    nf('jnt-stiff').set(it.stiffness, true);
    nf('jnt-damp').set(it.damping, true);
    nf('jnt-ax').set(it.axis.x, true); nf('jnt-ay').set(it.axis.y, true); nf('jnt-az').set(it.axis.z, true);
    nf('jnt-mspeed').set(it.motorSpeed, true);
    nf('jnt-mforce').set(it.motorForce, true);
    nf('jnt-px').set(it.pivot.x, true); nf('jnt-py').set(it.pivot.y, true); nf('jnt-pz').set(it.pivot.z, true);
    $('jnt-collide').checked = it.collide;
    $('jnt-warn').hidden = !it.inactive;
  } else if (it.category === 'cloth') {
    $('phys-cloth').hidden = false;
    nf('cl-res').set(it.res, true);
    nf('cl-size').set(it.size, true);
    $('cl-pin').value = it.pin;
    nf('cl-mass').set(it.pMass, true);
    nf('cl-stiff').set(it.stiffness, true);
    nf('cl-damp').set(it.damping, true);
  }
}

// ----------------------------------------------------------------------------
// Bind inputs
// ----------------------------------------------------------------------------
const sel = () => ctx.selected;

function bindObjectTab() {
  $('obj-name').addEventListener('input', (ev) => {
    const it = sel(); if (!it) return;
    it.name = ev.target.value || it.kind;
    it.root.name = it.name;
    emit('scene');
  });
  $('obj-visible').addEventListener('change', (ev) => { const it = sel(); if (it) { setItemVisible(it, ev.target.checked); emit('scene'); } });
  $('btn-obj-delete').addEventListener('click', () => ctx.deleteSelected());

  for (const a of ['x', 'y', 'z']) {
    nf(`loc-${a}`).on((v) => {
      const it = sel(); if (!it) return;
      it.root.position[a] = v;
      commitTransform(it);
    });
    nf(`rot-${a}`).on((v) => {
      const it = sel(); if (!it) return;
      it.root.rotation[a] = rad(v);
      commitTransform(it);
    });
    nf(`scl-${a}`).on((v) => {
      const it = sel(); if (!it || !it.scalable) return;
      const s = it.root.scale;
      if ($('obj-uniform').checked) {
        const old = s[a] || 1;
        s.multiplyScalar(Math.max(v, MIN_SCALE) / old);
      } else {
        s[a] = Math.max(v, MIN_SCALE);
      }
      commitTransform(it, true);
      refreshInspector(false);
    });
  }
}

function bindBody() {
  $('sel-type').addEventListener('change', (ev) => {
    const it = sel(); if (!it) return;
    setStatic(it, ev.target.value === 'passive');
    refreshInspector(true);
    emit('scene');
  });
  nf('mass').on((v) => { const it = sel(); if (it) setMass(it, v); });
  nf('restitution').on((v) => { const it = sel(); if (it) setMaterialProps(it, { restitution: v }); });
  nf('friction').on((v) => { const it = sel(); if (it) setMaterialProps(it, { friction: v }); });
  nf('lindamp').on((v) => { const it = sel(); if (it) setDamping(it, v, undefined); });
  nf('angdamp').on((v) => { const it = sel(); if (it) setDamping(it, undefined, v); });
  $('sel-collider').addEventListener('change', (ev) => { const it = sel(); if (it) setColliderType(it, ev.target.value); });

  $('impulse-grid').addEventListener('click', (ev) => {
    const btn = ev.target.closest('[data-imp]');
    const it = sel();
    if (!btn || !it || it.isStatic) return;
    const [x, y, z] = btn.dataset.imp.split(',').map(Number);
    const k = nf('impulse').get() * it.body.mass;
    applyImpulse(it, new THREE.Vector3(x * k, y * k, z * k));
    if (!state.running && !hintedImpulse) { hintedImpulse = true; ctx.toast('Impulse applied. Press Play to see it move.', 'info'); }
  });
}

function bindField() {
  $('fld-enabled').addEventListener('change', (ev) => { const it = sel(); if (it) it.enabled = ev.target.checked; });
  const upd = (key) => (v) => { const it = sel(); if (it) { it[key] = v; applyVisual(it); } };
  nf('fld-strength').on(upd('strength'));
  nf('fld-radius').on(upd('radius'));
  nf('fld-falloff').on(upd('falloff'));
  nf('fld-turb').on(upd('turbulence'));
  nf('fld-trigger').on(upd('triggerFrame'));
  $('btn-detonate').addEventListener('click', () => {
    const it = sel(); if (!it) return;
    detonate(it);
    if (!state.running && !hintedBoom) { hintedBoom = true; ctx.toast('Blast applied. Press Play to watch the debris fly.', 'info'); }
  });
}

function bindJoint() {
  const rebuild = () => { const c = sel(); if (c) { buildJoint(c); $('jnt-warn').hidden = !c.inactive; } };
  const bodyById = (id) => state.entities.find((e) => e.id === Number(id)) || null;

  $('jnt-a').addEventListener('change', (ev) => {
    const c = sel(); if (!c) return;
    const a = bodyById(ev.target.value);
    if (!a) return;
    c.a = a;
    if (c.b === a) c.b = null;
    refreshInspector(true);
    rebuild();
  });
  $('jnt-b').addEventListener('change', (ev) => {
    const c = sel(); if (!c) return;
    c.b = bodyById(ev.target.value);
    $('jnt-pivot-sec').hidden = !usesPivot(c);
    rebuild();
  });
  nf('jnt-length').on((v) => { const c = sel(); if (c) { c.restLength = v; rebuild(); } });
  nf('jnt-stiff').on((v) => { const c = sel(); if (c) { c.stiffness = v; if (c.spring) c.spring.stiffness = v; } });
  nf('jnt-damp').on((v) => { const c = sel(); if (c) { c.damping = v; if (c.spring) c.spring.damping = v; } });
  nf('jnt-mspeed').on((v) => { const c = sel(); if (c) { c.motorSpeed = v; rebuild(); } });
  nf('jnt-mforce').on((v) => { const c = sel(); if (c) { c.motorForce = v; rebuild(); } });
  for (const a of ['x', 'y', 'z']) {
    nf(`jnt-a${a}`).on((v) => { const c = sel(); if (c) { c.axis[a] = v; rebuild(); } });
    nf(`jnt-p${a}`).on((v) => { const c = sel(); if (c) { c.pivot[a] = v; c.root.position.copy(c.pivot); rebuild(); } });
  }
  $('jnt-collide').addEventListener('change', (ev) => { const c = sel(); if (c) { c.collide = ev.target.checked; rebuild(); } });
}

function bindCloth() {
  const rebuild = () => { const c = sel(); if (c) rebuildCloth(c); };
  nf('cl-res').on((v) => { const c = sel(); if (c) { c.res = v; rebuild(); } });
  nf('cl-size').on((v) => { const c = sel(); if (c) { c.size = v; rebuild(); } });
  $('cl-pin').addEventListener('change', (ev) => { const c = sel(); if (c) { c.pin = ev.target.value; rebuild(); } });
  nf('cl-mass').on((v) => { const c = sel(); if (c) setClothMass(c, v); });
  nf('cl-stiff').on((v) => { const c = sel(); if (c) c.stiffness = v; });
  nf('cl-damp').on((v) => { const c = sel(); if (c) c.damping = v; });
}

export function initInspector(context) {
  ctx = context;
  ctx.refreshInspector = refreshInspector;
  bindObjectTab();
  bindBody();
  bindField();
  bindJoint();
  bindCloth();

  // keep joint body pickers in sync when bodies are added / removed / renamed
  let pending = false;
  const later = () => {
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => {
      pending = false;
      if (ctx.selected && ctx.selected.category === 'constraint') refreshInspector(true);
    });
  };
  on('scene', later);

  refreshInspector(true);
}
