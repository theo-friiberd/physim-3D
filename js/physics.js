// ============================================================================
// physics.js: cannon-es world, entity registry, collider generation, debug view
// ============================================================================
import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { ConvexHull } from 'three/addons/math/ConvexHull.js';

export const FIXED_DT = 1 / 60;
export const MAX_HULL_POINTS = 300;     // keeps convex colliders cheap for the solver
export const MIN_SCALE = 0.02;

/** Shared simulation state (read by app.js / builder.js). */
export const state = {
  running: false,       // simulation is stepping every frame
  started: false,       // at least one step happened since the last reset
  timeScale: 1,
  entities: [],         // every physical object in the scene
  nextId: 1,
};

let world = null;
let scene = null;
let groundBody = null;
let floorEnabled = true;
let debugGroup = null;
let debugOn = false;

const _v = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _inv = new THREE.Matrix4();

// ----------------------------------------------------------------------------
// World
// ----------------------------------------------------------------------------
export function initPhysics(threeScene) {
  scene = threeScene;
  world = new CANNON.World({ gravity: new CANNON.Vec3(0, -9.82, 0) });
  world.broadphase = new CANNON.SAPBroadphase(world);
  world.allowSleep = false;
  world.solver.iterations = 14;
  world.defaultContactMaterial.friction = 0.5;
  world.defaultContactMaterial.restitution = 0.2;

  // Infinite floor at y = 0 (friction / restitution of 1 so body values rule the contact).
  groundBody = new CANNON.Body({
    type: CANNON.Body.STATIC,
    shape: new CANNON.Plane(),
    material: new CANNON.Material({ friction: 1, restitution: 1 }),
  });
  groundBody.quaternion.setFromEuler(-Math.PI / 2, 0, 0);
  world.addBody(groundBody);

  debugGroup = new THREE.Group();
  debugGroup.name = 'collider-debug';
  debugGroup.visible = false;
  scene.add(debugGroup);
  return world;
}

export function getWorld() { return world; }

export function setGravity(x, y, z) {
  world.gravity.set(x, y, z);
  for (const e of state.entities) if (!e.isStatic) e.body.wakeUp();
}

export function getGravity() {
  return new THREE.Vector3(world.gravity.x, world.gravity.y, world.gravity.z);
}

export function setFloor(enabled) {
  if (enabled === floorEnabled) return;
  floorEnabled = enabled;
  if (enabled) world.addBody(groundBody); else world.removeBody(groundBody);
  for (const e of state.entities) if (!e.isStatic) e.body.wakeUp();
}

// ----------------------------------------------------------------------------
// Point collection + convex hull helpers
// ----------------------------------------------------------------------------

/**
 * Collect vertex positions of every mesh below `root`, expressed in root-local
 * space. Duplicates are merged and the set is reduced to `max` points while
 * always keeping the extreme points, so hulls / boxes stay faithful.
 */
export function pointsFromObject(root, max = MAX_HULL_POINTS) {
  root.updateWorldMatrix(true, true);
  _inv.copy(root.matrixWorld).invert();

  let total = 0;
  root.traverse((o) => { if (o.isMesh && o.geometry?.attributes?.position) total += o.geometry.attributes.position.count; });
  const step = Math.max(1, Math.floor(total / 60000));

  const seen = new Set();
  const pts = [];
  root.traverse((o) => {
    if (!o.isMesh || !o.geometry?.attributes?.position) return;
    const pos = o.geometry.attributes.position;
    _m.multiplyMatrices(_inv, o.matrixWorld);
    for (let i = 0; i < pos.count; i += step) {
      _v.fromBufferAttribute(pos, i).applyMatrix4(_m);
      const key = `${Math.round(_v.x * 1e4)},${Math.round(_v.y * 1e4)},${Math.round(_v.z * 1e4)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      pts.push(_v.clone());
    }
  });
  return reducePoints(pts, max);
}

function reducePoints(pts, max) {
  if (pts.length <= max) return pts;
  const keep = new Set();
  // Extreme points along the 3 axes and the 4 cube diagonals (both directions).
  const dirs = [];
  for (let sx = -1; sx <= 1; sx++) for (let sy = -1; sy <= 1; sy++) for (let sz = -1; sz <= 1; sz++) {
    if (sx || sy || sz) dirs.push(new THREE.Vector3(sx, sy, sz));
  }
  for (const d of dirs) {
    let best = 0, bestDot = -Infinity;
    for (let i = 0; i < pts.length; i++) {
      const dot = pts[i].dot(d);
      if (dot > bestDot) { bestDot = dot; best = i; }
    }
    keep.add(best);
  }
  const stride = pts.length / Math.max(1, max - keep.size);
  for (let f = 0; f < pts.length && keep.size < max; f += stride) keep.add(Math.floor(f));
  return [...keep].map((i) => pts[i]);
}

/** Build a cannon ConvexPolyhedron from points (outward CCW faces). */
function hullShape(points) {
  const hull = new ConvexHull().setFromPoints(points);
  const index = new Map();
  const vertices = [];
  const faces = [];
  for (const face of hull.faces) {
    const ids = [];
    let edge = face.edge;
    do {
      const p = edge.head().point;
      let i = index.get(p);
      if (i === undefined) {
        i = vertices.length;
        vertices.push(new CANNON.Vec3(p.x, p.y, p.z));
        index.set(p, i);
      }
      ids.push(i);
      edge = edge.next;
    } while (edge !== face.edge);
    faces.push(ids);
  }
  if (vertices.length < 4 || faces.length < 4) throw new Error('degenerate hull');
  return new CANNON.ConvexPolyhedron({ vertices, faces });
}

function boundsBoxShape(points, scale) {
  const mn = new THREE.Vector3(Infinity, Infinity, Infinity);
  const mx = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
  for (const p of points) {
    _v.copy(p).multiply(scale);
    mn.min(_v); mx.max(_v);
  }
  const he = mx.sub(mn).multiplyScalar(0.5);
  return new CANNON.Box(new CANNON.Vec3(Math.max(he.x, 0.01), Math.max(he.y, 0.01), Math.max(he.z, 0.01)));
}

/** Create the cannon shape that matches an entity's kind, collider type and current scale. */
function buildShape(e) {
  const s = e.mesh.scale;
  const sx = Math.max(Math.abs(s.x), MIN_SCALE);
  const sy = Math.max(Math.abs(s.y), MIN_SCALE);
  const sz = Math.max(Math.abs(s.z), MIN_SCALE);
  const sc = new THREE.Vector3(sx, sy, sz);

  if (e.kind === 'box') return new CANNON.Box(new CANNON.Vec3(sx / 2, sy / 2, sz / 2));

  const uniform = Math.abs(sx - sy) < 1e-3 * sx && Math.abs(sx - sz) < 1e-3 * sx;
  if (e.kind === 'sphere' && uniform) return new CANNON.Sphere(0.5 * sx);

  if (e.kind === 'model' && e.colliderType === 'bbox') return boundsBoxShape(e.localPoints, sc);

  const scaled = e.localPoints.map((p) => p.clone().multiply(sc));
  try {
    return hullShape(scaled);
  } catch (err) {
    console.warn(`Convex hull failed for "${e.name}", using bounding box instead.`, err);
    return boundsBoxShape(e.localPoints, sc);
  }
}

// ----------------------------------------------------------------------------
// Entities
// ----------------------------------------------------------------------------

/**
 * Register a mesh as a physical entity.
 * opts: { name, kind: 'sphere'|'box'|'cylinder'|'ramp'|'model', mesh, localPoints,
 *         isStatic, mass, friction, restitution, colliderType }
 */
export function createEntity(opts) {
  const e = {
    id: state.nextId++,
    name: opts.name || opts.kind,
    kind: opts.kind,
    mesh: opts.mesh,
    localPoints: opts.localPoints || [],
    colliderType: opts.colliderType || 'hull',
    isStatic: !!opts.isStatic,
    mass: opts.mass ?? 1,
    friction: opts.friction ?? 0.5,
    restitution: opts.restitution ?? 0.3,
    body: null,
    debug: null,
    dragging: false,
    initial: null,
  };

  e.body = new CANNON.Body({
    mass: e.isStatic ? 0 : e.mass,
    type: e.isStatic ? CANNON.Body.STATIC : CANNON.Body.DYNAMIC,
    material: new CANNON.Material({ friction: e.friction, restitution: e.restitution }),
    linearDamping: 0.02,
    angularDamping: 0.08,
    allowSleep: false,
  });
  e.body.addShape(buildShape(e));
  e.body.userData = { entity: e };
  e.mesh.userData.entity = e;
  e.mesh.traverse((o) => { o.userData.entity = e; });

  scene.add(e.mesh);
  syncBodyFromMesh(e);
  world.addBody(e.body);
  captureInitial(e);
  state.entities.push(e);
  if (debugOn) rebuildDebug(e);
  return e;
}

export function removeEntity(e) {
  world.removeBody(e.body);
  scene.remove(e.mesh);
  disposeObject(e.mesh);
  if (e.debug) { debugGroup.remove(e.debug); disposeObject(e.debug); e.debug = null; }
  const i = state.entities.indexOf(e);
  if (i >= 0) state.entities.splice(i, 1);
}

export function clearEntities() {
  for (const e of [...state.entities]) removeEntity(e);
}

export function disposeObject(obj) {
  obj.traverse((o) => {
    if (o.geometry) o.geometry.dispose();
    const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
    for (const m of mats) {
      for (const k of Object.keys(m)) if (m[k] && m[k].isTexture) m[k].dispose();
      m.dispose();
    }
  });
}

export function captureInitial(e) {
  e.initial = {
    p: e.mesh.position.clone(),
    q: e.mesh.quaternion.clone(),
    s: e.mesh.scale.clone(),
  };
}

/** Edits update the "reset" layout unless a simulation run is in progress (static layout edits always persist). */
export function shouldCaptureInitial(e) {
  return !state.started || e.isStatic;
}

export function syncBodyFromMesh(e) {
  const b = e.body;
  b.position.set(e.mesh.position.x, e.mesh.position.y, e.mesh.position.z);
  b.quaternion.set(e.mesh.quaternion.x, e.mesh.quaternion.y, e.mesh.quaternion.z, e.mesh.quaternion.w);
  b.previousPosition.copy(b.position);
  b.interpolatedPosition.copy(b.position);
  b.initPosition.copy(b.position);
  b.previousQuaternion.copy(b.quaternion);
  b.interpolatedQuaternion.copy(b.quaternion);
  b.initQuaternion.copy(b.quaternion);
  b.velocity.setZero();
  b.angularVelocity.setZero();
  b.force.setZero();
  b.torque.setZero();
  b.aabbNeedsUpdate = true;
  b.wakeUp();
}

function syncMeshFromBody(e) {
  e.mesh.position.set(e.body.position.x, e.body.position.y, e.body.position.z);
  e.mesh.quaternion.set(e.body.quaternion.x, e.body.quaternion.y, e.body.quaternion.z, e.body.quaternion.w);
}

/** Rebuild the collision shape (after scale or collider-type changes). */
export function rebuildCollider(e) {
  const b = e.body;
  while (b.shapes.length) b.removeShape(b.shapes[0]);
  b.addShape(buildShape(e));
  b.updateBoundingRadius();
  b.updateMassProperties();
  b.aabbNeedsUpdate = true;
  b.wakeUp();
  if (debugOn) rebuildDebug(e);
}

export function setStatic(e, isStatic) {
  e.isStatic = isStatic;
  const b = e.body;
  b.type = isStatic ? CANNON.Body.STATIC : CANNON.Body.DYNAMIC;
  b.mass = isStatic ? 0 : e.mass;
  b.velocity.setZero();
  b.angularVelocity.setZero();
  b.updateMassProperties();
  b.aabbNeedsUpdate = true;
  b.wakeUp();
  if (isStatic) syncBodyFromMesh(e);
  if (debugOn) rebuildDebug(e);
  if (isStatic) captureInitial(e);
}

export function setMass(e, mass) {
  e.mass = Math.max(0.01, mass);
  if (!e.isStatic) { e.body.mass = e.mass; e.body.updateMassProperties(); e.body.wakeUp(); }
}

export function setMaterialProps(e, { friction, restitution }) {
  if (friction !== undefined) { e.friction = friction; e.body.material.friction = friction; }
  if (restitution !== undefined) { e.restitution = restitution; e.body.material.restitution = restitution; }
}

export function setColliderType(e, type) {
  e.colliderType = type;
  rebuildCollider(e);
}

/** Impulse in world space, applied at a world-space point (defaults to the centre of mass). */
export function applyImpulse(e, impulse, worldPoint) {
  if (e.isStatic) return;
  const b = e.body;
  b.wakeUp();
  const rel = worldPoint
    ? new CANNON.Vec3(worldPoint.x - b.position.x, worldPoint.y - b.position.y, worldPoint.z - b.position.z)
    : new CANNON.Vec3(0, 0, 0);
  b.applyImpulse(new CANNON.Vec3(impulse.x, impulse.y, impulse.z), rel);
}

// ----------------------------------------------------------------------------
// Simulation loop helpers
// ----------------------------------------------------------------------------
export function update(dt) {
  if (state.running) {
    world.step(FIXED_DT, Math.min(dt, 0.1) * state.timeScale, 6);
    state.started = true;
  }
  syncVisuals();
}

export function stepOnce() {
  world.step(FIXED_DT);
  state.started = true;
  syncVisuals();
}

function syncVisuals() {
  for (const e of state.entities) {
    if (!e.isStatic && !e.dragging) syncMeshFromBody(e);
    if (e.debug) {
      e.debug.position.copy(e.body.position);
      e.debug.quaternion.copy(e.body.quaternion);
    }
  }
}

/** Put every body back to its start transform and clear all motion. */
export function resetAll() {
  for (const e of state.entities) {
    const { p, q, s } = e.initial;
    const scaleChanged = !e.mesh.scale.equals(s);
    e.mesh.position.copy(p);
    e.mesh.quaternion.copy(q);
    e.mesh.scale.copy(s);
    if (scaleChanged) rebuildCollider(e);
    syncBodyFromMesh(e);
    if (e.debug) { e.debug.position.copy(p); e.debug.quaternion.copy(q); }
  }
  state.started = false;
}

// ----------------------------------------------------------------------------
// Collision wireframe overlay
// ----------------------------------------------------------------------------
export function setDebug(on) {
  debugOn = on;
  debugGroup.visible = on;
  if (on) for (const e of state.entities) rebuildDebug(e);
}

function shapeGeometry(shape) {
  switch (shape.type) {
    case CANNON.Shape.types.BOX: {
      const h = shape.halfExtents;
      return new THREE.WireframeGeometry(new THREE.BoxGeometry(h.x * 2, h.y * 2, h.z * 2));
    }
    case CANNON.Shape.types.SPHERE:
      return new THREE.WireframeGeometry(new THREE.SphereGeometry(shape.radius, 16, 12));
    case CANNON.Shape.types.CONVEXPOLYHEDRON: {
      const pos = [];
      for (const f of shape.faces) {
        for (let i = 1; i < f.length - 1; i++) {
          for (const idx of [f[0], f[i], f[i + 1]]) {
            const v = shape.vertices[idx];
            pos.push(v.x, v.y, v.z);
          }
        }
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      return new THREE.EdgesGeometry(g, 8);
    }
    default:
      return new THREE.BufferGeometry();
  }
}

function rebuildDebug(e) {
  if (e.debug) { debugGroup.remove(e.debug); disposeObject(e.debug); e.debug = null; }
  const shape = e.body.shapes[0];
  if (!shape) return;
  const mat = new THREE.LineBasicMaterial({
    color: e.isStatic ? 0xffb547 : 0x3ddc97,
    transparent: true,
    opacity: 0.95,
    depthTest: false,
  });
  const lines = new THREE.LineSegments(shapeGeometry(shape), mat);
  lines.renderOrder = 999;
  lines.position.copy(e.body.position);
  lines.quaternion.copy(e.body.quaternion);
  debugGroup.add(lines);
  e.debug = lines;
}
