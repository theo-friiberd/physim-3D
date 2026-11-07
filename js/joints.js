// ============================================================================
// joints.js: Distance, Spring, Hinge and Point-to-Point constraints
//
// Every joint connects body A to body B (or to the world, through a static
// anchor body placed at the joint's pivot). Anchors are stored in the local
// frame of each body, so joints follow their bodies while the simulation runs.
// ============================================================================
import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import {
  state, getWorld, getScene, addStepHook, on, emit,
} from './physics.js';

export const JOINT_LABELS = {
  distance: 'Distance Joint',
  spring: 'Spring Joint',
  hinge: 'Hinge Joint',
  p2p: 'Point-to-Point',
};

const COLORS = { distance: 0xf5c542, spring: 0x4cd1a5, hinge: 0xe0607e, p2p: 0x5ea0ff };
const _a = new CANNON.Vec3();
const _b = new CANNON.Vec3();
const _w = new CANNON.Vec3();

/** True when the joint pivot is a free point in space (and can be moved with the gizmo). */
export function usesPivot(c) {
  return c.kind === 'hinge' || c.kind === 'p2p' || !c.b;
}

function isDynamic(entity) { return entity && !entity.isStatic; }

// ----------------------------------------------------------------------------
// Create / destroy
// ----------------------------------------------------------------------------
export function createJoint(kind, a, b = null, opts = {}) {
  const scene = getScene();
  const pa = a.body.position;
  const pivot = opts.pivot
    ? opts.pivot.clone()
    : b
      ? new THREE.Vector3((pa.x + b.body.position.x) / 2, (pa.y + b.body.position.y) / 2, (pa.z + b.body.position.z) / 2)
      : new THREE.Vector3(pa.x, pa.y + 1.5, pa.z);

  const bPos = b ? b.body.position : { x: pivot.x, y: pivot.y, z: pivot.z };
  const distance = Math.hypot(pa.x - bPos.x, pa.y - bPos.y, pa.z - bPos.z);

  const c = {
    id: state.nextId++,
    category: 'constraint',
    kind,
    name: `${JOINT_LABELS[kind]} ${state.constraints.length + 1}`,
    a, b, pivot,
    axis: opts.axis ? opts.axis.clone() : new THREE.Vector3(0, 0, 1),
    restLength: Math.max(0.05, distance),
    stiffness: 80,
    damping: 4,
    collide: false,
    motorSpeed: 0,
    motorForce: 30,
    scalable: false,
    cn: null, spring: null, anchor: null, localA: new CANNON.Vec3(), localB: new CANNON.Vec3(),
    axisA: new CANNON.Vec3(0, 0, 1), axisB: new CANNON.Vec3(0, 0, 1),
    inactive: false,
    root: new THREE.Group(),
    dragging: false,
  };

  // Marker at the pivot (selectable / movable) + a line object for the arms and hinge axis.
  const marker = new THREE.Mesh(
    new THREE.OctahedronGeometry(0.14),
    new THREE.MeshBasicMaterial({ color: COLORS[kind], depthTest: false, transparent: true, opacity: 0.95 }),
  );
  marker.renderOrder = 997;
  c.root.add(marker);
  c.marker = marker;
  c.root.userData.entity = c;
  marker.userData.entity = c;

  const lineGeo = new THREE.BufferGeometry();
  lineGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(18), 3));
  c.line = new THREE.LineSegments(lineGeo, new THREE.LineBasicMaterial({ color: COLORS[kind], depthTest: false, transparent: true, opacity: 0.85 }));
  c.line.frustumCulled = false;
  c.line.renderOrder = 996;
  c.root.userData.line = c.line;

  scene.add(c.root);
  scene.add(c.line);
  c.root.position.copy(pivot);

  c.setHighlight = (on) => {
    c.marker.material.color.set(on ? 0xf57c00 : COLORS[kind]);
    c.marker.scale.setScalar(on ? 1.5 : 1);
  };
  c.setVisible = (v) => { c.root.visible = v; c.line.visible = v; };

  state.constraints.push(c);
  buildJoint(c);
  emit('scene');
  return c;
}

function destroyPhysics(c) {
  const world = getWorld();
  if (c.cn) { world.removeConstraint(c.cn); c.cn = null; }
  c.spring = null;
  if (c.anchor) { world.removeBody(c.anchor); c.anchor = null; }
}

/** (Re)build the cannon constraint from the joint's parameters and the bodies' current transforms. */
export function buildJoint(c) {
  const world = getWorld();
  destroyPhysics(c);

  c.inactive = !(isDynamic(c.a) || isDynamic(c.b));
  const A = c.a.body;
  let B;
  if (c.b) {
    B = c.b.body;
  } else {
    c.anchor = new CANNON.Body({ mass: 0, type: CANNON.Body.STATIC });
    c.anchor.collisionResponse = false;
    c.anchor.position.set(c.pivot.x, c.pivot.y, c.pivot.z);
    world.addBody(c.anchor);
    B = c.anchor;
  }
  if (c.inactive || A === B) return;

  const pivotW = new CANNON.Vec3(c.pivot.x, c.pivot.y, c.pivot.z);

  if (c.kind === 'distance' || c.kind === 'spring') {
    // Anchors sit at the body centres (or at the pivot when connected to the world).
    c.localA.set(0, 0, 0);
    c.localB.set(0, 0, 0);
    if (c.kind === 'distance') {
      c.cn = new CANNON.DistanceConstraint(A, B, c.restLength);
      c.cn.collideConnected = c.collide;
      world.addConstraint(c.cn);
    } else {
      c.spring = new CANNON.Spring(A, B, {
        restLength: c.restLength,
        stiffness: c.stiffness,
        damping: c.damping,
        localAnchorA: c.localA,
        localAnchorB: c.localB,
      });
    }
    return;
  }

  A.pointToLocalFrame(pivotW, c.localA);
  B.pointToLocalFrame(pivotW, c.localB);

  if (c.kind === 'p2p') {
    c.cn = new CANNON.PointToPointConstraint(A, c.localA.clone(), B, c.localB.clone());
  } else {
    const axisW = new CANNON.Vec3(c.axis.x, c.axis.y, c.axis.z);
    if (axisW.lengthSquared() < 1e-8) axisW.set(0, 0, 1);
    axisW.normalize();
    A.vectorToLocalFrame(axisW, c.axisA);
    B.vectorToLocalFrame(axisW, c.axisB);
    c.cn = new CANNON.HingeConstraint(A, B, {
      pivotA: c.localA.clone(),
      pivotB: c.localB.clone(),
      axisA: c.axisA.clone(),
      axisB: c.axisB.clone(),
    });
    if (c.motorSpeed !== 0) {
      c.cn.enableMotor();
      c.cn.setMotorSpeed(c.motorSpeed);
      c.cn.setMotorMaxForce(c.motorForce);
    }
  }
  c.cn.collideConnected = c.collide;
  world.addConstraint(c.cn);
}

export function removeJoint(c) {
  destroyPhysics(c);
  const scene = getScene();
  scene.remove(c.root);
  scene.remove(c.line);
  c.marker.geometry.dispose(); c.marker.material.dispose();
  c.line.geometry.dispose(); c.line.material.dispose();
  const i = state.constraints.indexOf(c);
  if (i >= 0) state.constraints.splice(i, 1);
  emit('scene');
}

export function clearJoints() {
  for (const c of [...state.constraints]) removeJoint(c);
}

/** Choose a sensible partner for a new joint: the nearest other body within range, else the world. */
export function nearestPartner(a, maxDist = 6) {
  let best = null;
  let bestD = maxDist;
  for (const e of state.entities) {
    if (e === a) continue;
    const d = e.body.position.distanceTo(a.body.position);
    if (d < bestD) { bestD = d; best = e; }
  }
  return best;
}

// ----------------------------------------------------------------------------
// Keep joints consistent with scene edits
// ----------------------------------------------------------------------------
on('removed', (item) => {
  if (item.category !== 'body') return;
  for (const c of [...state.constraints]) if (c.a === item || c.b === item) removeJoint(c);
});
on('static', (e) => { for (const c of state.constraints) if (c.a === e || c.b === e) buildJoint(c); });
on('transform', (e) => { for (const c of state.constraints) if (c.a === e || c.b === e) buildJoint(c); });

// Springs apply their forces after each step (forces persist into the next one).
addStepHook(() => {
  for (const c of state.constraints) if (c.spring) c.spring.applyForce();
});

// ----------------------------------------------------------------------------
// Visuals (called once per frame)
// ----------------------------------------------------------------------------
export function updateJointVisuals() {
  for (const c of state.constraints) {
    const A = c.a.body;
    const pos = c.line.geometry.attributes.position;
    const arr = pos.array;

    // world anchors
    A.pointToWorldFrame(c.localA, _a);
    let bx, by, bz;
    if (c.b) {
      c.b.body.pointToWorldFrame(c.localB, _b);
      bx = _b.x; by = _b.y; bz = _b.z;
    } else {
      bx = c.pivot.x; by = c.pivot.y; bz = c.pivot.z;
    }

    const hingeOrP2P = c.kind === 'hinge' || c.kind === 'p2p';
    if (hingeOrP2P) {
      // arms: body centres -> pivot
      const px = _a.x, py = _a.y, pz = _a.z;
      if (!c.dragging) c.root.position.set(px, py, pz);
      arr[0] = A.position.x; arr[1] = A.position.y; arr[2] = A.position.z;
      arr[3] = px; arr[4] = py; arr[5] = pz;
      const Bc = c.b ? c.b.body.position : { x: px, y: py, z: pz };
      arr[6] = Bc.x; arr[7] = Bc.y; arr[8] = Bc.z;
      arr[9] = px; arr[10] = py; arr[11] = pz;
      if (c.kind === 'hinge') {
        A.vectorToWorldFrame(c.axisA, _w);
        arr[12] = px - _w.x * 0.6; arr[13] = py - _w.y * 0.6; arr[14] = pz - _w.z * 0.6;
        arr[15] = px + _w.x * 0.6; arr[16] = py + _w.y * 0.6; arr[17] = pz + _w.z * 0.6;
      } else {
        arr.fill(0, 12, 18);
        arr[12] = arr[15] = px; arr[13] = arr[16] = py; arr[14] = arr[17] = pz;
      }
    } else {
      // distance / spring: line from A centre to B centre (or the world pivot)
      arr[0] = _a.x; arr[1] = _a.y; arr[2] = _a.z;
      arr[3] = bx; arr[4] = by; arr[5] = bz;
      for (let i = 6; i < 18; i += 3) { arr[i] = bx; arr[i + 1] = by; arr[i + 2] = bz; }
      if (!c.b) {
        if (!c.dragging) c.root.position.copy(c.pivot);
      } else {
        c.root.position.set((_a.x + bx) / 2, (_a.y + by) / 2, (_a.z + bz) / 2);
      }
    }
    pos.needsUpdate = true;

    c.marker.material.opacity = c.inactive ? 0.3 : 0.95;
    c.line.material.opacity = c.inactive ? 0.25 : 0.85;
  }
}
