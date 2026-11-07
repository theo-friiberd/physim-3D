// ============================================================================
// fields.js: force fields (Wind, Point Attractor / gravity well, Radial Explosion)
//
// Fields are scene objects: move and rotate them with the gizmo. They act on
// dynamic rigid bodies and on cloth particles.
//   wind       blows along the field's local +X axis (rotate it to aim)
//   attractor  pulls toward the field (negative strength pushes away)
//   explosion  one-shot radial impulse (Detonate button, or at a chosen frame)
// ============================================================================
import * as THREE from 'three';
import { state, getScene, addStepHook, on, emit } from './physics.js';

export const FIELD_LABELS = { wind: 'Wind', attractor: 'Attractor', explosion: 'Explosion' };
const COLORS = { wind: 0x62c6ff, attractor: 0xb78cff, explosion: 0xff6a3d };

const _p = new THREE.Vector3();
const _d = new THREE.Vector3();
const _q = new THREE.Quaternion();

const DEFAULTS = {
  wind:      { strength: 8,   radius: 0, falloff: 0, turbulence: 0.5 },
  attractor: { strength: 40,  radius: 10, falloff: 2, turbulence: 0 },
  explosion: { strength: 14,  radius: 6, falloff: 1, turbulence: 0 },
};

export function createField(kind, position = new THREE.Vector3(0, 2, 0)) {
  const scene = getScene();
  const d = DEFAULTS[kind];
  const f = {
    id: state.nextId++,
    category: 'field',
    kind,
    name: `${FIELD_LABELS[kind]} ${state.fields.length + 1}`,
    enabled: true,
    strength: d.strength,
    radius: d.radius,
    falloff: d.falloff,
    turbulence: d.turbulence,
    triggerFrame: 0,
    scalable: false,
    root: new THREE.Group(),
    flash: 0,
    fired: false,
  };
  f.root.position.copy(position);
  if (kind === 'wind') f.root.rotation.y = 0;             // +X
  f.root.userData.entity = f;

  const color = COLORS[kind];
  const mat = (opacity) => new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false, wireframe: false });

  // core marker
  const core = new THREE.Mesh(new THREE.SphereGeometry(kind === 'wind' ? 0.12 : 0.2, 16, 12), mat(0.95));
  core.userData.entity = f;
  f.root.add(core);
  f.core = core;

  // range indicator (unit sphere scaled by radius)
  if (kind !== 'wind') {
    const range = new THREE.Mesh(new THREE.SphereGeometry(1, 24, 16), new THREE.MeshBasicMaterial({ color, wireframe: true, transparent: true, opacity: 0.14, depthWrite: false }));
    range.raycast = () => {};            // the big range sphere must never swallow clicks
    f.root.add(range);
    f.range = range;
  }

  // wind: a bundle of arrows along +X
  if (kind === 'wind') {
    f.arrows = new THREE.Group();
    const offsets = [[0, 0], [0, 0.45], [0, -0.45], [0.45, 0], [-0.45, 0]];
    for (const [oy, oz] of offsets) {
      const a = new THREE.ArrowHelper(new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, oy, oz), 1.6, color, 0.35, 0.2);
      a.line.material.transparent = true; a.line.material.opacity = oy === 0 && oz === 0 ? 0.95 : 0.5;
      a.cone.material.transparent = true; a.cone.material.opacity = a.line.material.opacity;
      a.traverse((o) => { o.userData.entity = f; });
      f.arrows.add(a);
    }
    f.root.add(f.arrows);
  }

  f.setHighlight = (on) => {
    f.core.material.color.set(on ? 0xf57c00 : color);
    f.core.scale.setScalar(on ? 1.5 : 1);
  };
  f.setVisible = (v) => { f.root.visible = v; };
  f.setHighlight(false);
  applyVisual(f);

  scene.add(f.root);
  state.fields.push(f);
  emit('scene');
  return f;
}

export function applyVisual(f) {
  if (f.range) f.range.scale.setScalar(Math.max(f.radius, 0.1));
  if (f.arrows) {
    const k = THREE.MathUtils.clamp(0.5 + Math.abs(f.strength) / 16, 0.4, 2.2);
    f.arrows.scale.set(k * (f.strength < 0 ? -1 : 1), 1, 1);
  }
  f.core.visible = true;
}

export function removeField(f) {
  getScene().remove(f.root);
  f.root.traverse((o) => {
    if (o.geometry) o.geometry.dispose();
    if (o.material) o.material.dispose();
  });
  const i = state.fields.indexOf(f);
  if (i >= 0) state.fields.splice(i, 1);
  emit('scene');
}

export function clearFields() { for (const f of [...state.fields]) removeField(f); }

// ----------------------------------------------------------------------------
// Detonation (one-shot radial impulse, linear falloff)
// ----------------------------------------------------------------------------
export function detonate(f) {
  if (f.kind !== 'explosion') return;
  f.root.getWorldPosition(_p);
  const R = Math.max(f.radius, 0.1);
  f.flash = 1;
  f.fired = true;

  const hit = (body, isParticle) => {
    if (body.mass <= 0) return;                 // static / pinned
    _d.set(body.position.x - _p.x, body.position.y - _p.y, body.position.z - _p.z);
    const dist = _d.length();
    if (dist > R) return;
    if (dist < 1e-4) _d.set(0, 1, 0); else _d.divideScalar(dist);
    const fall = Math.pow(1 - dist / R, Math.max(f.falloff, 0.01));
    const impulse = f.strength * body.mass * fall;
    body.wakeUp();
    body.velocity.x += _d.x * impulse / body.mass;
    body.velocity.y += (_d.y + 0.25) * impulse / body.mass;      // slight upward kick
    body.velocity.z += _d.z * impulse / body.mass;
    if (!isParticle) {
      body.angularVelocity.x += (Math.random() - 0.5) * fall * f.strength * 0.3;
      body.angularVelocity.y += (Math.random() - 0.5) * fall * f.strength * 0.3;
      body.angularVelocity.z += (Math.random() - 0.5) * fall * f.strength * 0.3;
    }
  };

  for (const e of state.entities) hit(e.body, false);
  for (const cl of state.cloths) for (const p of cl.particles) hit(p, true);
}

// ----------------------------------------------------------------------------
// Continuous forces (applied after every step; used by the next step)
// ----------------------------------------------------------------------------
const gust = (t, x, z, seed) =>
  Math.sin(t * 2.3 + x * 0.8 + seed) * Math.sin(t * 1.1 + z * 0.7 + seed * 1.7 + 1.3);

addStepHook((dt) => {
  const t = state.frame * dt;

  for (const f of state.fields) {
    if (!f.enabled) continue;

    if (f.kind === 'explosion') {
      if (f.triggerFrame > 0 && state.frame === f.triggerFrame) detonate(f);
      continue;
    }

    f.root.getWorldPosition(_p);
    f.root.getWorldQuaternion(_q);
    const R = f.radius;

    if (f.kind === 'wind') {
      const dir = new THREE.Vector3(1, 0, 0).applyQuaternion(_q);
      const apply = (body, area) => {
        if (body.mass <= 0) return;
        if (R > 0) {
          const dx = body.position.x - _p.x, dy = body.position.y - _p.y, dz = body.position.z - _p.z;
          if (dx * dx + dy * dy + dz * dz > R * R) return;
        }
        const g = 1 + f.turbulence * gust(t, body.position.x, body.position.z, f.id);
        const mag = f.strength * area * Math.max(g, 0);
        body.force.x += dir.x * mag; body.force.y += dir.y * mag; body.force.z += dir.z * mag;
        body.wakeUp();
      };
      for (const e of state.entities) {
        if (e.isStatic) continue;
        const r = e.body.boundingRadius || 0.5;
        apply(e.body, Math.max(0.15, r * r));
      }
      for (const cl of state.cloths) for (const p of cl.particles) apply(p, 0.06);
    } else if (f.kind === 'attractor') {
      const apply = (body) => {
        if (body.mass <= 0) return;
        _d.set(_p.x - body.position.x, _p.y - body.position.y, _p.z - body.position.z);
        const dist = _d.length();
        if (R > 0 && dist > R) return;
        const soft = Math.max(dist, 0.6);
        _d.divideScalar(Math.max(dist, 1e-4));
        let mag = f.strength * body.mass / Math.pow(soft, f.falloff);
        if (R > 0) {                                            // fade out over the last 20% of the range
          const edge = THREE.MathUtils.smoothstep(dist, R * 0.8, R);
          mag *= 1 - edge;
        }
        mag = Math.min(mag, 400 * body.mass);
        body.force.x += _d.x * mag; body.force.y += _d.y * mag; body.force.z += _d.z * mag;
        body.wakeUp();
      };
      for (const e of state.entities) if (!e.isStatic) apply(e.body);
      for (const cl of state.cloths) for (const p of cl.particles) apply(p);
    }
  }
});

on('reset', () => { for (const f of state.fields) { f.fired = false; f.flash = 0; } });

// ----------------------------------------------------------------------------
// Per-frame visuals (explosion flash, attractor pulse)
// ----------------------------------------------------------------------------
export function updateFieldVisuals(dt) {
  for (const f of state.fields) {
    if (f.kind === 'explosion' && f.range) {
      if (f.flash > 0) {
        f.flash = Math.max(0, f.flash - dt * 2.2);
        const k = 1 - f.flash;
        f.range.scale.setScalar(Math.max(f.radius, 0.1) * (0.15 + 0.85 * k));
        f.range.material.opacity = 0.14 + 0.5 * f.flash;
      } else {
        f.range.scale.setScalar(Math.max(f.radius, 0.1));
        f.range.material.opacity = 0.14;
      }
    }
    f.core.material.opacity = f.enabled ? 0.95 : 0.3;
  }
}
