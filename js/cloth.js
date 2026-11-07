// ============================================================================
// cloth.js: spring-mass cloth (structural + shear + bend springs)
//
// Each grid vertex is a small cannon sphere body, so cloth collides with every
// rigid body and the floor. Particles do not collide with each other. Springs
// are integrated explicitly after every physics step; a short position-based
// pass limits over-stretching so a hanging sheet does not turn into rubber.
// ============================================================================
import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { state, getWorld, getScene, addStepHook, on, emit, FIXED_DT } from './physics.js';

const STRETCH_LIMIT = 1.1;      // structural springs may stretch at most 10%
const MAX_SPEED = 35;           // particle speed clamp (m/s), keeps the explicit integrator safe

export const PIN_MODES = { corners: 'Top corners', edge: 'Top edge', none: 'None (free fall)' };

let clothTexture = null;
function getTexture() {
  if (clothTexture) return clothTexture;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  g.fillStyle = '#e8873a'; g.fillRect(0, 0, 64, 64);
  g.fillStyle = '#d4742a'; g.fillRect(0, 0, 32, 32); g.fillRect(32, 32, 32, 32);
  clothTexture = new THREE.CanvasTexture(c);
  clothTexture.wrapS = clothTexture.wrapT = THREE.RepeatWrapping;
  clothTexture.colorSpace = THREE.SRGBColorSpace;
  return clothTexture;
}

export function createCloth(opts = {}) {
  const scene = getScene();
  const cl = {
    id: state.nextId++,
    category: 'cloth',
    kind: 'cloth',
    name: `Cloth ${state.cloths.length + 1}`,
    res: opts.res ?? 14,
    size: opts.size ?? 3,
    pMass: 0.05,
    stiffness: 200,
    damping: 3,
    pin: opts.pin ?? 'corners',
    scalable: false,
    root: new THREE.Group(),
    particles: [],
    initial: null,
    mesh: null,
    pick: [],
    springs: null,
  };
  cl.root.position.copy(opts.position || new THREE.Vector3(0, 4, 0));
  cl.root.rotation.x = opts.rotationX ?? Math.PI / 2;      // hang in the XY plane; top row is the pinned edge
  cl.root.userData.entity = cl;

  const axes = new THREE.AxesHelper(0.45);
  axes.material.depthTest = false;
  axes.renderOrder = 995;
  cl.root.add(axes);

  cl.material = new THREE.MeshStandardMaterial({
    map: getTexture(), side: THREE.DoubleSide, roughness: 0.85, metalness: 0, emissive: 0x000000,
  });

  cl.setHighlight = (on) => { cl.material.emissive.set(on ? 0x6a3300 : 0x000000); axes.visible = true; };
  cl.setVisible = (v) => { cl.root.visible = v; if (cl.mesh) cl.mesh.visible = v; };

  scene.add(cl.root);
  state.cloths.push(cl);
  buildCloth(cl);
  emit('scene');
  return cl;
}

function destroyBodies(cl) {
  const world = getWorld();
  for (const p of cl.particles) world.removeBody(p);
  cl.particles = [];
}

/** (Re)build particles, springs and the render mesh from the current parameters and root transform. */
export function buildCloth(cl) {
  const world = getWorld();
  const scene = getScene();
  destroyBodies(cl);

  const n = Math.max(3, Math.round(cl.res));
  const spacing = cl.size / (n - 1);
  const radius = THREE.MathUtils.clamp(spacing * 0.3, 0.025, 0.12);
  cl.root.updateMatrixWorld(true);
  const tmp = new THREE.Vector3();
  cl.initial = new Float32Array(n * n * 3);

  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      tmp.set((i / (n - 1) - 0.5) * cl.size, 0, (j / (n - 1) - 0.5) * cl.size);
      cl.root.localToWorld(tmp);
      const idx = j * n + i;
      cl.initial[idx * 3] = tmp.x; cl.initial[idx * 3 + 1] = tmp.y; cl.initial[idx * 3 + 2] = tmp.z;

      const pinned = cl.pin === 'edge' ? j === 0 : cl.pin === 'corners' ? j === 0 && (i === 0 || i === n - 1) : false;
      const body = new CANNON.Body({
        mass: pinned ? 0 : cl.pMass,
        shape: new CANNON.Sphere(radius),
        position: new CANNON.Vec3(tmp.x, tmp.y, tmp.z),
        linearDamping: 0.08,
        allowSleep: false,
        collisionFilterGroup: 2,       // cloth particles ...
        collisionFilterMask: 1,        // ... only collide with normal bodies, never each other
      });
      body.material = new CANNON.Material({ friction: 0.4, restitution: 0 });
      body.userData = { particle: true, cloth: cl, index: idx };
      world.addBody(body);
      cl.particles.push(body);
    }
  }

  // ---- springs: [a, b, rest, kScale, structural] ----
  const list = [];
  const at = (i, j) => j * n + i;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      if (i + 1 < n) list.push([at(i, j), at(i + 1, j), spacing, 1, 1]);
      if (j + 1 < n) list.push([at(i, j), at(i, j + 1), spacing, 1, 1]);
      if (i + 1 < n && j + 1 < n) {
        list.push([at(i, j), at(i + 1, j + 1), spacing * Math.SQRT2, 0.5, 0]);
        list.push([at(i + 1, j), at(i, j + 1), spacing * Math.SQRT2, 0.5, 0]);
      }
      if (i + 2 < n) list.push([at(i, j), at(i + 2, j), spacing * 2, 0.3, 0]);
      if (j + 2 < n) list.push([at(i, j), at(i, j + 2), spacing * 2, 0.3, 0]);
    }
  }
  cl.springs = list;

  // ---- render mesh ----
  if (cl.mesh) { scene.remove(cl.mesh); cl.mesh.geometry.dispose(); }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(cl.initial), 3).setUsage(THREE.DynamicDrawUsage));
  const uv = new Float32Array(n * n * 2);
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) { uv[(j * n + i) * 2] = (i / (n - 1)) * ((n - 1) / 2); uv[(j * n + i) * 2 + 1] = (j / (n - 1)) * ((n - 1) / 2); }
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  const index = [];
  for (let j = 0; j < n - 1; j++) for (let i = 0; i < n - 1; i++) {
    const a = at(i, j), b = at(i + 1, j), c = at(i, j + 1), d = at(i + 1, j + 1);
    index.push(a, c, b, b, c, d);
  }
  geo.setIndex(index);
  geo.computeVertexNormals();
  cl.mesh = new THREE.Mesh(geo, cl.material);
  cl.mesh.castShadow = true;
  cl.mesh.receiveShadow = true;
  cl.mesh.frustumCulled = false;
  cl.mesh.userData.entity = cl;
  cl.mesh.visible = cl.root.visible;
  cl.pick = [cl.mesh];
  scene.add(cl.mesh);
  cl.material.map.repeat.set(1, 1);
  cl.material.needsUpdate = true;
}

export function rebuildCloth(cl) { buildCloth(cl); }

export function setClothMass(cl, m) {
  cl.pMass = Math.max(0.005, m);
  for (const p of cl.particles) {
    if (p.mass > 0) { p.mass = cl.pMass; p.updateMassProperties(); }
  }
}

export function removeCloth(cl) {
  destroyBodies(cl);
  const scene = getScene();
  scene.remove(cl.root);
  if (cl.mesh) { scene.remove(cl.mesh); cl.mesh.geometry.dispose(); }
  cl.material.dispose();
  const i = state.cloths.indexOf(cl);
  if (i >= 0) state.cloths.splice(i, 1);
  emit('scene');
}

export function clearCloths() { for (const c of [...state.cloths]) removeCloth(c); }

/** Closest particle to a world point (used by the mouse-drag tool). */
export function nearestParticle(cl, point) {
  let best = null, bestD = Infinity;
  for (const p of cl.particles) {
    const d = (p.position.x - point.x) ** 2 + (p.position.y - point.y) ** 2 + (p.position.z - point.z) ** 2;
    if (d < bestD) { bestD = d; best = p; }
  }
  return best;
}

// ----------------------------------------------------------------------------
// Simulation
// ----------------------------------------------------------------------------
function stepCloth(cl, dt) {
  const P = cl.particles;
  if (!P.length) return;
  const m = cl.pMass;
  const k0 = cl.stiffness * m;
  const c0 = cl.damping * m;

  for (const [ia, ib, rest, kScale] of cl.springs) {
    const a = P[ia], b = P[ib];
    const dx = b.position.x - a.position.x;
    const dy = b.position.y - a.position.y;
    const dz = b.position.z - a.position.z;
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (len < 1e-6) continue;
    const nx = dx / len, ny = dy / len, nz = dz / len;
    const rv = (b.velocity.x - a.velocity.x) * nx + (b.velocity.y - a.velocity.y) * ny + (b.velocity.z - a.velocity.z) * nz;
    let f = kScale * (k0 * (len - rest) + c0 * rv);
    const maxF = k0 * rest * 4;
    if (f > maxF) f = maxF; else if (f < -maxF) f = -maxF;
    a.force.x += nx * f; a.force.y += ny * f; a.force.z += nz * f;
    b.force.x -= nx * f; b.force.y -= ny * f; b.force.z -= nz * f;
  }

  // stretch limiting (position-based): pull over-stretched structural links back and drop the relative velocity
  for (let it = 0; it < 3; it++) {
    for (const [ia, ib, rest, , structural] of cl.springs) {
      if (!structural) continue;
      const a = P[ia], b = P[ib];
      const w = a.invMass + b.invMass;
      if (w === 0) continue;
      const dx = b.position.x - a.position.x;
      const dy = b.position.y - a.position.y;
      const dz = b.position.z - a.position.z;
      const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
      const max = rest * STRETCH_LIMIT;
      if (len <= max || len < 1e-6) continue;
      const nx = dx / len, ny = dy / len, nz = dz / len;
      const corr = (len - max) / w;
      a.position.x += nx * corr * a.invMass; a.position.y += ny * corr * a.invMass; a.position.z += nz * corr * a.invMass;
      b.position.x -= nx * corr * b.invMass; b.position.y -= ny * corr * b.invMass; b.position.z -= nz * corr * b.invMass;
      const rv = (b.velocity.x - a.velocity.x) * nx + (b.velocity.y - a.velocity.y) * ny + (b.velocity.z - a.velocity.z) * nz;
      if (rv > 0) {
        a.velocity.x += nx * rv * a.invMass / w; a.velocity.y += ny * rv * a.invMass / w; a.velocity.z += nz * rv * a.invMass / w;
        b.velocity.x -= nx * rv * b.invMass / w; b.velocity.y -= ny * rv * b.invMass / w; b.velocity.z -= nz * rv * b.invMass / w;
      }
    }
  }

  for (const p of P) {
    if (p.invMass === 0) continue;
    const s2 = p.velocity.x ** 2 + p.velocity.y ** 2 + p.velocity.z ** 2;
    if (s2 > MAX_SPEED * MAX_SPEED) p.velocity.scale(MAX_SPEED / Math.sqrt(s2), p.velocity);
    p.aabbNeedsUpdate = true;
  }
}

addStepHook((dt) => { for (const cl of state.cloths) stepCloth(cl, dt); });

on('reset', () => {
  for (const cl of state.cloths) {
    cl.particles.forEach((p, i) => {
      p.position.set(cl.initial[i * 3], cl.initial[i * 3 + 1], cl.initial[i * 3 + 2]);
      p.previousPosition.copy(p.position);
      p.interpolatedPosition.copy(p.position);
      p.velocity.setZero(); p.angularVelocity.setZero(); p.force.setZero();
      p.aabbNeedsUpdate = true;
    });
  }
});

/** Copy particle positions into the render meshes (call once per frame). */
export function updateClothVisuals() {
  for (const cl of state.cloths) {
    if (!cl.mesh) continue;
    const attr = cl.mesh.geometry.attributes.position;
    const arr = attr.array;
    for (let i = 0; i < cl.particles.length; i++) {
      const p = cl.particles[i].position;
      arr[i * 3] = p.x; arr[i * 3 + 1] = p.y; arr[i * 3 + 2] = p.z;
    }
    attr.needsUpdate = true;
    cl.mesh.geometry.computeVertexNormals();
    cl.mesh.geometry.computeBoundingSphere();
    cl.mesh.geometry.computeBoundingBox();
  }
}
