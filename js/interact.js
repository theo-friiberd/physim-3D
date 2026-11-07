// ============================================================================
// interact.js: spring-based mouse dragging + velocity / contact-normal overlays
// ============================================================================
import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { state, getWorld, getScene, addStepHook, on } from './physics.js';
import { nearestParticle } from './cloth.js';

let ctx = null;
let jointBody = null;          // invisible static body that follows the mouse
let drag = null;
let warnedStatic = false;
let warnedPaused = false;

// ---- overlays ----
const MAX_VECTORS = 1024;
const MAX_NORMALS = 1500;
let velLines = null;
let nrmLines = null;
export const overlays = { velocity: false, normals: false };

const _ndc = new THREE.Vector2();
const _ray = new THREE.Raycaster();
const _hit = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _perp = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _side = new THREE.Vector3(1, 0, 0);

export function initInteract(context) {
  ctx = context;
  const world = getWorld();
  const scene = getScene();
  const canvas = ctx.renderer.domElement;

  jointBody = new CANNON.Body({ mass: 0, type: CANNON.Body.STATIC });
  jointBody.collisionResponse = false;
  world.addBody(jointBody);

  // rubber-band indicator
  const lineGeo = new THREE.BufferGeometry();
  lineGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
  const line = new THREE.Line(lineGeo, new THREE.LineBasicMaterial({ color: 0xf57c00, depthTest: false, transparent: true }));
  line.frustumCulled = false; line.renderOrder = 1000; line.visible = false;
  const dot = new THREE.Mesh(new THREE.SphereGeometry(0.07, 12, 8), new THREE.MeshBasicMaterial({ color: 0xf57c00, depthTest: false }));
  dot.renderOrder = 1000; dot.visible = false;
  scene.add(line, dot);

  // ---- overlay line sets ----
  velLines = makeLines(MAX_VECTORS * 6, 0x4cc9f0);
  nrmLines = makeLines(MAX_NORMALS * 2, 0xff4d4d);
  scene.add(velLines, nrmLines);

  // ---- grab tool ----
  const pointerNdc = (ev) => {
    const r = canvas.getBoundingClientRect();
    _ndc.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
    _ray.setFromCamera(_ndc, ctx.camera);
  };

  const updateIndicator = () => {
    if (!drag) { line.visible = false; dot.visible = false; return; }
    const p = line.geometry.attributes.position;
    drag.body.pointToWorldFrame(drag.localAnchor, drag.world);
    p.setXYZ(0, drag.world.x, drag.world.y, drag.world.z);
    p.setXYZ(1, jointBody.position.x, jointBody.position.y, jointBody.position.z);
    p.needsUpdate = true;
    dot.position.copy(jointBody.position);
    line.visible = true; dot.visible = true;
  };

  const end = () => {
    if (!drag) return;
    drag = null;
    updateIndicator();
    document.body.classList.remove('dragging-fling');
    ctx.orbit.enabled = true;
  };

  canvas.addEventListener('pointerdown', (ev) => {
    if (ctx.tool !== 'grab' || ev.button !== 0) return;
    pointerNdc(ev);
    const targets = [...state.entities.map((e) => e.mesh), ...state.cloths.map((c) => c.mesh).filter(Boolean)];
    const hits = _ray.intersectObjects(targets, true);
    if (!hits.length) return;                              // empty space: orbit as usual
    const item = hits[0].object.userData.entity;
    if (!item) return;

    let body;
    if (item.category === 'cloth') {
      body = nearestParticle(item, hits[0].point);
      if (!body || body.mass === 0) { ctx.toast('That cloth point is pinned. Drag a free point.', 'info'); return; }
    } else {
      if (item.isStatic) {
        if (!warnedStatic) { warnedStatic = true; ctx.toast('Static bodies cannot be dragged. Switch it to an Active rigid body first.', 'info'); }
        return;
      }
      body = item.body;
    }

    ev.stopImmediatePropagation();
    canvas.setPointerCapture(ev.pointerId);
    ctx.orbit.enabled = false;
    document.body.classList.add('dragging-fling');
    if (item.category === 'body') ctx.select(item);

    const grab = new CANNON.Vec3(hits[0].point.x, hits[0].point.y, hits[0].point.z);
    const isParticle = !!body.userData?.particle;
    const m = body.mass;
    const w2 = isParticle ? 900 : 120;                      // spring frequency squared
    const ratio = isParticle ? 0.6 : 0.8;                    // damping ratio
    const localAnchor = body.pointToLocalFrame(grab, new CANNON.Vec3());
    jointBody.position.copy(grab);
    const spring = new CANNON.Spring(body, jointBody, {
      restLength: 0,
      stiffness: m * w2,
      damping: 2 * ratio * Math.sqrt(w2) * m,
      localAnchorA: localAnchor,
      localAnchorB: new CANNON.Vec3(0, 0, 0),
    });
    const camDir = new THREE.Vector3();
    ctx.camera.getWorldDirection(camDir);
    drag = {
      body, spring, localAnchor, world: new CANNON.Vec3(),
      plane: new THREE.Plane().setFromNormalAndCoplanarPoint(camDir, hits[0].point.clone()),
    };
    body.wakeUp();
    updateIndicator();
    if (!state.running && !warnedPaused) { warnedPaused = true; ctx.toast('Press Play (Space): the drag spring only pulls while the simulation runs.', 'info'); }
  }, true);

  canvas.addEventListener('pointermove', (ev) => {
    if (!drag) return;
    pointerNdc(ev);
    if (_ray.ray.intersectPlane(drag.plane, _hit)) jointBody.position.set(_hit.x, _hit.y, _hit.z);
    drag.body.wakeUp();
    updateIndicator();
  });
  canvas.addEventListener('pointerup', (ev) => {
    if (drag && canvas.hasPointerCapture(ev.pointerId)) canvas.releasePointerCapture(ev.pointerId);
    end();
  });
  canvas.addEventListener('pointercancel', end);
  window.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') end(); });

  // the dragged body may be deleted while held
  on('removed', (item) => { if (drag && (item.body === drag.body || drag.body.userData?.cloth === item)) end(); });
  on('scene', () => { if (drag && !getWorld().bodies.includes(drag.body)) end(); });

  addStepHook(() => {
    if (!drag) return;
    drag.spring.applyForce();
    updateIndicator();
  });
  // refresh the rubber band every frame (bodies move even when the pointer does not)
  ctx.afterFrame.push(updateIndicator);
}

export function isDragging() { return !!drag; }

// ----------------------------------------------------------------------------
// Overlays
// ----------------------------------------------------------------------------
function makeLines(vertexCount, color) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(vertexCount * 3), 3).setUsage(THREE.DynamicDrawUsage));
  geo.setDrawRange(0, 0);
  const lines = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color, depthTest: false, transparent: true, opacity: 0.95 }));
  lines.frustumCulled = false;
  lines.renderOrder = 990;
  lines.visible = false;
  return lines;
}

export function setOverlay(name, on) {
  overlays[name] = on;
  const lines = name === 'velocity' ? velLines : nrmLines;
  lines.visible = on;
  if (!on) lines.geometry.setDrawRange(0, 0);
}

export function updateOverlays() {
  if (overlays.velocity) updateVelocity();
  if (overlays.normals) updateNormals();
}

function updateVelocity() {
  const arr = velLines.geometry.attributes.position.array;
  let n = 0;
  for (const e of state.entities) {
    if (e.isStatic || n >= MAX_VECTORS * 6 - 6) continue;
    const v = e.body.velocity;
    const speed = Math.hypot(v.x, v.y, v.z);
    if (speed < 0.05) continue;
    const p = e.body.position;
    const len = Math.min(speed * 0.35, 4);
    _dir.set(v.x / speed, v.y / speed, v.z / speed);
    const tx = p.x + _dir.x * len, ty = p.y + _dir.y * len, tz = p.z + _dir.z * len;
    _perp.crossVectors(_dir, Math.abs(_dir.y) > 0.95 ? _side : _up).normalize();
    const hl = Math.min(0.25, len * 0.4);
    const bx = tx - _dir.x * hl, by = ty - _dir.y * hl, bz = tz - _dir.z * hl;
    const w = hl * 0.45;

    arr.set([p.x, p.y, p.z, tx, ty, tz], n * 3); n += 2;
    arr.set([tx, ty, tz, bx + _perp.x * w, by + _perp.y * w, bz + _perp.z * w], n * 3); n += 2;
    arr.set([tx, ty, tz, bx - _perp.x * w, by - _perp.y * w, bz - _perp.z * w], n * 3); n += 2;
  }
  velLines.geometry.setDrawRange(0, n);
  velLines.geometry.attributes.position.needsUpdate = true;
}

function updateNormals() {
  const arr = nrmLines.geometry.attributes.position.array;
  const contacts = getWorld().contacts;
  let n = 0;
  for (let i = 0; i < contacts.length && n < MAX_NORMALS * 2; i++) {
    const c = contacts[i];
    if (c.bi.userData?.particle || c.bj.userData?.particle) continue;
    const px = c.bi.position.x + c.ri.x;
    const py = c.bi.position.y + c.ri.y;
    const pz = c.bi.position.z + c.ri.z;
    arr[n * 3] = px; arr[n * 3 + 1] = py; arr[n * 3 + 2] = pz; n++;
    arr[n * 3] = px + c.ni.x * 0.5; arr[n * 3 + 1] = py + c.ni.y * 0.5; arr[n * 3 + 2] = pz + c.ni.z * 0.5; n++;
  }
  nrmLines.geometry.setDrawRange(0, n);
  nrmLines.geometry.attributes.position.needsUpdate = true;
}
