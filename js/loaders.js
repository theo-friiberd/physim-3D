// ============================================================================
// loaders.js: STL / OBJ(+MTL) / GLTF / GLB import (file picker + drag & drop)
//             and conversion of loaded meshes into physics colliders
// ============================================================================
import * as THREE from 'three';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { MTLLoader } from 'three/addons/loaders/MTLLoader.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { createEntity, pointsFromObject } from './physics.js';

const MODEL_EXT = /\.(stl|obj|gltf|glb)$/i;
const TARGET_SIZE = 2;          // imported models are normalised to ~2 world units
const DRACO_PATH = 'https://www.gstatic.com/draco/versioned/decoders/1.5.6/';

let ctx = null;
let spawnCounter = 0;

export function initLoaders(context) {
  ctx = context;

  const input = document.getElementById('file-input');
  document.getElementById('btn-import').addEventListener('click', () => input.click());
  input.addEventListener('change', () => {
    if (input.files?.length) loadFiles(input.files);
    input.value = '';
  });

  // ---- drag & drop over the whole window ----
  const zone = document.getElementById('dropzone');
  let depth = 0;
  const hasFiles = (e) => e.dataTransfer && [...e.dataTransfer.types].includes('Files');

  window.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth++;
    zone.hidden = false;
  });
  window.addEventListener('dragover', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });
  window.addEventListener('dragleave', (e) => {
    if (!hasFiles(e)) return;
    depth = Math.max(0, depth - 1);
    if (depth === 0) zone.hidden = true;
  });
  window.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth = 0;
    zone.hidden = true;
    if (e.dataTransfer.files.length) loadFiles(e.dataTransfer.files);
  });
}

/** Load one or more dropped / picked files. Companion files (.mtl, .bin, textures) may be included. */
export async function loadFiles(fileList) {
  const files = [...fileList];
  const byName = new Map(files.map((f) => [f.name.toLowerCase(), f]));
  const models = files.filter((f) => MODEL_EXT.test(f.name));

  if (!models.length) {
    ctx.toast('Unsupported file. Use .stl, .obj, .gltf or .glb.', 'error');
    return;
  }

  const blobUrls = new Map();
  const manager = new THREE.LoadingManager();
  manager.setURLModifier((url) => {
    if (/^(blob|data):/i.test(url)) return url;
    const name = decodeURIComponent(url.split('?')[0].split('#')[0].split('/').pop() || '').toLowerCase();
    const file = byName.get(name);
    if (!file) return url;
    if (!blobUrls.has(name)) blobUrls.set(name, URL.createObjectURL(file));
    return blobUrls.get(name);
  });

  for (const file of models) {
    ctx.loading(true, `Loading ${file.name}…`);
    try {
      if (file.size > 150 * 1024 * 1024) ctx.toast('Large file: this may take a while.', 'info');
      const root = await parseModel(file, byName, manager);
      const entity = addModel(root, file.name.replace(/\.[^.]+$/, ''));
      ctx.select(entity);
      ctx.toast(`Loaded “${entity.name}” (${entity.localPoints.length} collider points)`, 'ok');
    } catch (err) {
      console.error(err);
      ctx.toast(`Could not load ${file.name}: ${err.message || err}`, 'error');
    }
  }

  ctx.loading(false);
  setTimeout(() => blobUrls.forEach((u) => URL.revokeObjectURL(u)), 10000);
}

// ----------------------------------------------------------------------------
// Parsing per format
// ----------------------------------------------------------------------------
async function parseModel(file, byName, manager) {
  const ext = file.name.split('.').pop().toLowerCase();

  if (ext === 'stl') {
    const geometry = new STLLoader().parse(await file.arrayBuffer());
    if (!geometry.attributes.normal) geometry.computeVertexNormals();
    const material = new THREE.MeshStandardMaterial({ color: randomColor(), roughness: 0.55, metalness: 0.1 });
    if (geometry.hasColors) { material.vertexColors = true; material.color.set(0xffffff); }
    return new THREE.Mesh(geometry, material);
  }

  if (ext === 'obj') {
    const loader = new OBJLoader(manager);
    const base = file.name.replace(/\.obj$/i, '').toLowerCase();
    const mtlFile = byName.get(`${base}.mtl`) || [...byName.values()].find((f) => /\.mtl$/i.test(f.name));
    let hasMaterials = false;
    if (mtlFile) {
      const creator = new MTLLoader(manager).parse(await mtlFile.text(), '');
      creator.preload();
      loader.setMaterials(creator);
      hasMaterials = true;
    }
    const root = loader.parse(await file.text());
    if (!hasMaterials) {
      const material = new THREE.MeshStandardMaterial({ color: randomColor(), roughness: 0.55, metalness: 0.1, side: THREE.DoubleSide });
      root.traverse((o) => { if (o.isMesh) o.material = material; });
    }
    return root;
  }

  // glTF / GLB
  const loader = new GLTFLoader(manager);
  const draco = new DRACOLoader().setDecoderPath(DRACO_PATH);
  loader.setDRACOLoader(draco);
  const data = ext === 'glb' ? await file.arrayBuffer() : await file.text();
  try {
    const gltf = await new Promise((resolve, reject) => loader.parse(data, '', resolve, reject));
    return gltf.scene || gltf.scenes?.[0];
  } finally {
    draco.dispose();
  }
}

// ----------------------------------------------------------------------------
// Mesh -> physics entity
// ----------------------------------------------------------------------------
function addModel(root, name) {
  root.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(root);
  if (box.isEmpty()) throw new Error('the file contains no geometry');

  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const longest = Math.max(size.x, size.y, size.z);
  if (!isFinite(longest) || longest <= 0) throw new Error('the model has an invalid size');
  const k = TARGET_SIZE / longest;

  // wrapper (physics body frame, centred on the bounding-box centre) > inner (fit-to-size) > model
  const inner = new THREE.Group();
  inner.add(root);
  inner.scale.setScalar(k);
  inner.position.copy(center).multiplyScalar(-k);
  const wrapper = new THREE.Group();
  wrapper.name = name;
  wrapper.add(inner);

  wrapper.traverse((o) => {
    if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; o.frustumCulled = true; }
  });

  const localPoints = pointsFromObject(wrapper);
  if (localPoints.length < 4) throw new Error('not enough vertices to build a collider');

  const halfH = (size.y * k) / 2;
  const sp = ctx.spawnPoint(spawnCounter++);
  wrapper.position.set(sp.x, halfH + 2.5, sp.z);

  return createEntity({
    name,
    kind: 'model',
    mesh: wrapper,
    localPoints,
    colliderType: 'hull',
    isStatic: false,
    mass: 2,
    friction: 0.5,
    restitution: 0.3,
  });
}

function randomColor() {
  return new THREE.Color().setHSL(Math.random(), 0.55, 0.58);
}
