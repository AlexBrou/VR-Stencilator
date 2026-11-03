// VR-Stencilator AR — place a stack of image layers on a real wall/table in Quest passthrough.
import * as THREE from 'three';

const $ = (id) => document.getElementById(id);
const V3 = THREE.Vector3, M4 = THREE.Matrix4;
const SNAPS = [0, 5, 15, 45, 90];

// ======================================================================
// Settings (per device) and layers (stored in IndexedDB so they survive reloads)
// ======================================================================
const S = Object.assign({ opacity: 0.6, width: 1.0, snap: 15, angle: 0, depth: 0, gridSize: 2, gridStep: 0.1, gridMode: 'adjusting' },
  readJSON('traceAR.settings'));
function readJSON(key) { try { return JSON.parse(localStorage.getItem(key) || '{}'); } catch { return {}; } }
function saveSettings() {
  try { localStorage.setItem('traceAR.settings', JSON.stringify({ opacity: S.opacity, width: S.width, snap: S.snap, angle: S.angle, depth: S.depth,
    gridSize: S.gridSize, gridStep: S.gridStep, gridMode: S.gridMode })); } catch {}
}

let layers = []; // { id, name, blob, url }
const newId = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now() + '-' + Math.random());

function idb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('trace-ar', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('layers', { keyPath: 'id' });
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function persistLayers() {
  try {
    const db = await idb();
    const tx = db.transaction('layers', 'readwrite'), st = tx.objectStore('layers');
    st.clear();
    layers.forEach((l, i) => st.put({ id: l.id, name: l.name, blob: l.blob, order: i }));
    await new Promise((r) => (tx.oncomplete = tx.onerror = r));
  } catch (e) { console.warn('Could not save layers', e); }
}
async function restoreLayers() {
  try {
    const db = await idb();
    const rows = await new Promise((res, rej) => {
      const r = db.transaction('layers').objectStore('layers').getAll();
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    });
    rows.sort((a, b) => a.order - b.order);
    layers = rows.map((r) => ({ id: r.id, name: r.name, blob: r.blob, url: URL.createObjectURL(r.blob) }));
  } catch (e) { console.warn('Could not restore layers', e); }
  renderList();
}

// ======================================================================
// 2D page: layer list
// ======================================================================
let arSupported = false;

$('addBtn').onclick = () => $('file').click();
$('file').onchange = (e) => {
  for (const f of e.target.files) {
    if (!f.type.startsWith('image/')) continue;
    layers.push({ id: newId(), name: f.name.replace(/\.[^.]+$/, ''), blob: f, url: URL.createObjectURL(f) });
  }
  e.target.value = '';
  renderList(); persistLayers();
};

function renderList() {
  const ol = $('list');
  ol.innerHTML = '';
  layers.forEach((l, i) => {
    const li = document.createElement('li');
    li.innerHTML = `<span class="num"></span><img alt=""><div class="meta"><input aria-label="Layer name"><span class="dims"></span></div>
      <div class="acts"><button data-a="up" title="Move up">↑</button><button data-a="down" title="Move down">↓</button><button data-a="rm" title="Remove">✕</button></div>`;
    li.querySelector('.num').textContent = i + 1;
    li.querySelector('img').src = l.url;
    const inp = li.querySelector('input');
    inp.value = l.name;
    inp.onchange = () => { l.name = inp.value.trim() || l.name; persistLayers(); };
    const up = li.querySelector('[data-a=up]'), down = li.querySelector('[data-a=down]');
    up.disabled = i === 0; down.disabled = i === layers.length - 1;
    up.onclick = () => { [layers[i - 1], layers[i]] = [layers[i], layers[i - 1]]; renderList(); persistLayers(); };
    down.onclick = () => { [layers[i + 1], layers[i]] = [layers[i], layers[i + 1]]; renderList(); persistLayers(); };
    li.querySelector('[data-a=rm]').onclick = () => { URL.revokeObjectURL(l.url); layers.splice(i, 1); renderList(); persistLayers(); };
    ol.appendChild(li);
  });
  $('empty').hidden = layers.length > 0;
  checkSizes();
  Promise.all(layers.map(measure)).then(checkSizes);
}

// All layers must have exactly the same pixel size, or they won't line up in AR.
function measure(l) {
  if (l.w || l.failed) return Promise.resolve();
  return new Promise((res) => {
    const im = new Image();
    im.onload = () => { l.w = im.naturalWidth; l.h = im.naturalHeight; res(); };
    im.onerror = () => { l.failed = true; res(); };
    im.src = l.url;
  });
}
function sizeError() {
  const ref = layers[0];
  if (!ref) return '';
  const broken = layers.filter((l) => l.failed);
  if (broken.length) return `Can’t read ${broken.map((l) => '“' + l.name + '”').join(', ')}. Remove it and add it again.`;
  if (!ref.w) return '';
  const odd = layers.filter((l) => l.w && (l.w !== ref.w || l.h !== ref.h));
  if (!odd.length) return '';
  return `All layers must be the same size as layer 1 (${ref.w} × ${ref.h} px), or they won’t line up. ` +
    `Different: ${odd.map((l) => `“${l.name}” (${l.w} × ${l.h})`).join(', ')}. ` +
    'In the Maker, save every layer from the same image with the same Size and Rotate settings.';
}
function checkSizes() {
  const ref = layers[0];
  $('list').querySelectorAll('li').forEach((li, i) => {
    const l = layers[i];
    if (!l) return;
    const dims = li.querySelector('.dims');
    dims.textContent = l.failed ? 'can’t read this image' : l.w ? `${l.w} × ${l.h} px` : '';
    li.classList.toggle('bad', !!l.failed || (!!ref?.w && !!l.w && (l.w !== ref.w || l.h !== ref.h)));
  });
  const err = sizeError();
  $('sizeError').textContent = err;
  const pending = layers.some((l) => !l.w && !l.failed);
  $('saveProjBtn').disabled = !layers.length;
  $('startBtn').disabled = !layers.length || !arSupported || !!err || pending;
}

function updateSupport(msg) {
  $('support').textContent = msg || '';
  renderList();
}
if (!window.isSecureContext) {
  updateSupport('AR only works when this page is opened over https:// (or localhost). You can still prepare your layers here.');
} else if (!navigator.xr) {
  updateSupport('Open this page in the Meta Quest browser to start AR. You can still prepare your layers here.');
} else {
  navigator.xr.isSessionSupported('immersive-ar')
    .then((ok) => { arSupported = ok; updateSupport(ok ? '' : 'This browser can’t do passthrough AR. Open this page in the Meta Quest browser.'); })
    .catch(() => updateSupport('Could not check AR support.'));
}
restoreLayers();

// ---------- projects: a .zip with the layer images + project.json ----------
const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };
const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' };
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const safeName = (s) => s.replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-').slice(0, 40) || 'layer';
function projMsg(text, isError) {
  const el = $('projMsg');
  el.textContent = text;
  el.className = 'note ' + (isError ? 'error' : 'ok');
}

$('saveProjBtn').onclick = async () => {
  try {
    if (typeof JSZip === 'undefined') throw new Error('the zip library didn’t load (are you online?)');
    const zip = new JSZip();
    const files = layers.map((l, i) =>
      `layers/${String(i + 1).padStart(2, '0')}-${safeName(l.name)}.${EXT[l.blob.type] || 'png'}`);
    layers.forEach((l, i) => zip.file(files[i], l.blob));
    const project = {
      app: 'VR-Stencilator', version: 1, savedAt: new Date().toISOString(),
      layers: layers.map((l, i) => ({ name: l.name, file: files[i], width: l.w, height: l.h })),
      settings: {
        opacity: S.opacity,
        widthCm: Math.round(S.width * 1000) / 10,
        rotationDeg: S.angle,
        snapDeg: S.snap,
        depthCm: Math.round(S.depth * 1000) / 10,
      },
    };
    // where the image was placed in your room (only works on this headset, at this web address)
    const placement = readPlacement();
    if (placement.uuid) project.placement = placement;
    zip.file('project.json', JSON.stringify(project, null, 2));
    const blob = await zip.generateAsync({ type: 'blob' }); // images are already compressed, so store as-is
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `vr-stencilator-${safeName(layers[0].name)}-${new Date().toISOString().slice(0, 10)}.zip`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    projMsg(`Saved ${a.download} (${layers.length} layers + settings${project.placement ? ' + placement' : ''}).`);
  } catch (e) {
    projMsg('Could not save the project: ' + e.message, true);
  }
};

// The newest placement wins. If the browser's own is newer than the project's, ask.
function choosePlacement(zipP) {
  const box = $('placeChoice');
  box.hidden = true;
  if (!zipP || !zipP.uuid) return;
  const webP = readPlacement();
  if (!webP.uuid || webP.uuid === zipP.uuid || (zipP.savedAt || 0) >= (webP.savedAt || 0)) {
    writePlacement(zipP);
    $('projMsg').textContent += ' Its placement will be restored when you start AR.';
    return;
  }
  const when = (t) => (t ? new Date(t).toLocaleString() : 'unknown date');
  box.innerHTML = '<p>This project has a saved placement, but there’s a more recent one in this browser. Which one should AR use?</p><div class="bar"><button class="btn" data-c="zip"></button><button class="btn" data-c="web"></button></div>';
  box.querySelector('[data-c=zip]').textContent = `The project’s (${when(zipP.savedAt)})`;
  box.querySelector('[data-c=web]').textContent = `The most recent (${when(webP.savedAt)})`;
  box.querySelector('[data-c=zip]').onclick = () => { writePlacement(zipP); box.hidden = true; projMsg('AR will use the placement from the project.'); };
  box.querySelector('[data-c=web]').onclick = () => { box.hidden = true; projMsg('AR will use the most recent placement.'); };
  box.hidden = false;
}

$('openProjBtn').onclick = () => $('projFile').click();
$('projFile').onchange = async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  try {
    if (typeof JSZip === 'undefined') throw new Error('the zip library didn’t load (are you online?)');
    const zip = await JSZip.loadAsync(f).catch(() => { throw new Error('this file isn’t a readable .zip'); });
    const pj = zip.file('project.json');
    if (!pj) throw new Error('this zip has no project.json, so it isn’t a VR-Stencilator project');
    const project = JSON.parse(await pj.async('string'));
    const list = Array.isArray(project.layers) ? project.layers : [];
    if (!list.length) throw new Error('the project has no layers');
    const loaded = [];
    for (const L of list) {
      const entry = typeof L.file === 'string' && zip.file(L.file);
      if (!entry) throw new Error(`the image “${L.file}” is missing from the zip`);
      const ext = L.file.split('.').pop().toLowerCase();
      const blob = new Blob([await entry.async('arraybuffer')], { type: MIME[ext] || 'image/png' });
      loaded.push({ id: newId(), name: String(L.name || 'layer').slice(0, 80), blob, url: URL.createObjectURL(blob) });
    }
    if (layers.length && !confirm(`Replace your current ${layers.length} layer(s) with this project?`)) {
      loaded.forEach((l) => URL.revokeObjectURL(l.url));
      return;
    }
    layers.forEach((l) => URL.revokeObjectURL(l.url));
    layers = loaded;
    const st = project.settings || {};
    const num = (v, d) => (v !== undefined && Number.isFinite(+v) ? +v : d);
    S.opacity = clamp(num(st.opacity, S.opacity), 0.05, 1);
    S.width = clamp(num(st.widthCm, S.width * 100) / 100, 0.05, 10);
    S.angle = wrapAngle(num(st.rotationDeg, S.angle));
    S.snap = SNAPS.includes(+st.snapDeg) ? +st.snapDeg : S.snap;
    S.depth = clamp(num(st.depthCm, S.depth * 100) / 100, -0.15, 0.15);
    saveSettings();
    renderList();
    persistLayers();
    projMsg(`Opened “${f.name}”: ${loaded.length} layers · width ${Math.round(S.width * 100)} cm · rotation ${Math.round(S.angle)}° · depth ${(S.depth * 100).toFixed(1)} cm.`);
    choosePlacement(project.placement);
  } catch (err) {
    projMsg('Could not open the project: ' + err.message, true);
  }
};

$('startBtn').onclick = () => startAR().catch((e) => {
  console.error(e);
  updateSupport('Could not start AR: ' + e.message);
});

// ======================================================================
// AR scene
// ======================================================================
let renderer, scene, camera, session, ref;
let imageRoot, imageMesh, imageMat, frameLines, reticle, surfaceGrid;
const calibDots = [];
// The controller's tracked grip point sits inside the handle, about this far from a surface
// the controller is lying on. Fine-tune in the headset with the Depth buttons.
const CONTROLLER_HALF_THICKNESS = 0.035; // measured on a Quest 3S
let panel, pill, wristBtn;
let textures = [];

const A = {
  mode: 'placing', // 'restoring' | 'calibrating' | 'placing' | 'placed'
  layer: 0,
  // calibrated surface (null = automatic detection)
  surfaceMode: 'auto', // 'auto' | 'wall' | 'floor'
  surface: null, // { kind, point: V3, normal: V3 } normal points toward you
  calib: null, // { kind, p1: V3|null }
  error: '',
  slide: { x: 0, y: 0 }, // meters, fine-tune along the surface after placing
  drag: null, // { src, via, dist, offset } while the menu is being moved
  slideDist: 0,
  angle: 0, // degrees, about the surface normal
  locked: false,
  menuOpen: true,
  onSurface: false,
  placeRequested: false,
  ghost: new M4(),
  anchor: null,
  placedMatrix: new M4(),
  activeSource: null,
  head: new M4(),
  needPanelPlacement: true,
};
const inputs = new Map(); // XRInputSource -> { ray, hitSource, pose: M4, prevButtons: [], flickReady }

function setupThree() {
  if (renderer) return;
  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setClearColor(0x000000, 0);
  renderer.xr.enabled = true;
  renderer.xr.setReferenceSpaceType('local-floor');
  document.body.appendChild(renderer.domElement);

  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.01, 50);

  imageRoot = new THREE.Group();
  imageRoot.matrixAutoUpdate = false;
  scene.add(imageRoot);

  imageMat = new THREE.MeshBasicMaterial({ transparent: true, side: THREE.DoubleSide, depthWrite: false });
  imageMesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), imageMat);
  imageMesh.position.z = 0.003; // a hair off the surface
  imageMesh.renderOrder = 0;
  imageRoot.add(imageMesh);

  // outline of the image bounds, visible while placing / unlocked
  const g = new THREE.BufferGeometry().setFromPoints([
    new V3(-0.5, -0.5, 0), new V3(0.5, -0.5, 0), new V3(0.5, 0.5, 0), new V3(-0.5, 0.5, 0),
  ]);
  frameLines = new THREE.LineLoop(g, new THREE.LineBasicMaterial({ color: 0x00e5ff, transparent: true, opacity: 0.8 }));
  imageMesh.add(frameLines);

  reticle = new THREE.Mesh(
    new THREE.RingGeometry(0.025, 0.035, 40),
    new THREE.MeshBasicMaterial({ color: 0x39ff14, side: THREE.DoubleSide, transparent: true, depthWrite: false })
  );
  reticle.position.z = 0.004;
  imageRoot.add(reticle);

  // faint grid showing the calibrated surface
  surfaceGrid = new THREE.Group();
  surfaceGrid.matrixAutoUpdate = false;
  rebuildGrid();
  surfaceGrid.visible = false;
  scene.add(surfaceGrid);

  // dots where the controller touched the surface during calibration
  for (let i = 0; i < 2; i++) {
    const m = new THREE.Mesh(new THREE.SphereGeometry(0.012, 16, 12), new THREE.MeshBasicMaterial({ color: 0xff3df0 }));
    m.visible = false;
    scene.add(m);
    calibDots.push(m);
  }

  panel = makePanel();
  pill = makePill();
  scene.add(panel.mesh, pill.mesh);
  wristBtn = makeWristButton();
  scene.add(wristBtn.mesh);
}

function rebuildGrid() {
  if (!surfaceGrid) return;
  surfaceGrid.children.slice().forEach((c) => { surfaceGrid.remove(c); c.geometry.dispose(); c.material.dispose(); });
  const divisions = Math.max(2, Math.round(S.gridSize / S.gridStep));
  const grid = new THREE.GridHelper(S.gridSize, divisions, 0xff3df0, 0x00e5ff); // pink center lines through the image
  grid.rotation.x = Math.PI / 2; // GridHelper lies in XZ; our surface frame uses XY
  grid.material.transparent = true; grid.material.opacity = 0.4; grid.material.depthWrite = false;
  surfaceGrid.add(grid);
}

function loadTexture(layer) {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => {
      const t = new THREE.Texture(img);
      t.colorSpace = THREE.SRGBColorSpace;
      t.anisotropy = 8;
      t.needsUpdate = true;
      res({ tex: t, aspect: img.naturalHeight / img.naturalWidth, name: layer.name });
    };
    img.onerror = () => rej(new Error('Could not load ' + layer.name));
    img.src = layer.url;
  });
}

async function startAR() {
  if (sizeError()) throw new Error(sizeError());
  setupThree();
  // request the session first: it must happen inside the button press
  session = await navigator.xr.requestSession('immersive-ar', {
    requiredFeatures: ['local-floor'],
    optionalFeatures: ['hit-test', 'anchors', 'hand-tracking'],
  });
  textures = await Promise.all(layers.map(loadTexture));

  Object.assign(A, {
    mode: 'placing', layer: 0, locked: false, menuOpen: true, anchor: null, needPanelPlacement: true, activeSource: null,
    surfaceMode: 'auto', surface: null, calib: null, drag: null, restore: null, slide: { x: 0, y: 0 },
  });
  calibDots.forEach((d) => (d.visible = false));
  history.length = 0;
  applyLayer();

  session.addEventListener('end', onSessionEnd);
  session.addEventListener('inputsourceschange', (e) => {
    e.added.forEach(addInput);
    e.removed.forEach(removeInput);
  });
  session.addEventListener('select', onSelect);
  // moving the menu: grip anywhere on it, or trigger/pinch on its title bar
  session.addEventListener('squeezestart', (e) => tryStartDrag(e.inputSource, 'squeeze'));
  session.addEventListener('selectstart', (e) => tryStartDrag(e.inputSource, 'select'));
  const endDrag = (via) => (e) => { if (A.drag && A.drag.src === e.inputSource && A.drag.via === via) { A.drag = null; panel.dirty = true; } };
  session.addEventListener('squeezeend', endDrag('squeeze'));
  session.addEventListener('selectend', endDrag('select'));

  await renderer.xr.setSession(session);
  ref = renderer.xr.getReferenceSpace();
  for (const src of session.inputSources) addInput(src);
  panel.redraw();
  renderer.setAnimationLoop(onFrame);
  tryRestorePlacement();
}

function onSessionEnd() {
  renderer.setAnimationLoop(null);
  for (const [src] of inputs) removeInput(src);
  textures.forEach((t) => t.tex.dispose());
  textures = [];
  A.anchor = null;
  session = null;
}

// ---------- input sources ----------
function addInput(src) {
  if (inputs.has(src)) return;
  const ray = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints([new V3(0, 0, 0), new V3(0, 0, -1)]),
    new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.6 })
  );
  ray.matrixAutoUpdate = false;
  ray.visible = false;
  scene.add(ray);
  const rec = { ray, hitSource: null, pose: new M4(), hasPose: false, prevButtons: [], flickReady: true };
  inputs.set(src, rec);
  if (!A.activeSource || src.handedness === 'right') A.activeSource = src;
  if (session.requestHitTestSource && src.targetRayMode === 'tracked-pointer') {
    session.requestHitTestSource({ space: src.targetRaySpace })
      .then((hs) => { if (inputs.get(src) === rec) rec.hitSource = hs; else hs.cancel(); })
      .catch((e) => console.warn('hit-test unavailable', e));
  }
}
function removeInput(src) {
  const rec = inputs.get(src);
  if (!rec) return;
  rec.hitSource?.cancel();
  scene.remove(rec.ray);
  inputs.delete(src);
  if (A.activeSource === src) A.activeSource = inputs.keys().next().value || null;
}

// ---------- geometry helpers ----------
// Image frame on a surface: X = right, Y = up (in the picture), Z = surface normal toward the viewer.
function surfaceFrame(pos, normal) {
  const head = new V3().setFromMatrixPosition(A.head);
  const n = normal.clone().normalize();
  if (n.dot(head.clone().sub(pos)) < 0) n.negate();
  let up;
  if (Math.abs(n.y) < 0.7) {
    up = new V3(0, 1, 0).addScaledVector(n, -n.y); // wall: picture up = world up
  } else {
    up = pos.clone().sub(head); // floor/table: picture top points away from you
    up.addScaledVector(n, -up.dot(n));
    if (up.lengthSq() < 1e-6) up.set(0, 0, -1).addScaledVector(n, -n.z);
  }
  up.normalize();
  const right = new V3().crossVectors(up, n).normalize();
  up.crossVectors(n, right);
  return new M4().makeBasis(right, up, n).setPosition(pos);
}

const raycaster = new THREE.Raycaster();
function setRayFromPose(pose) {
  const o = new V3().setFromMatrixPosition(pose);
  const d = new V3(0, 0, -1).transformDirection(pose);
  raycaster.set(o, d);
  return [o, d];
}

// ======================================================================
// Per-frame update
// ======================================================================
let lastT = 0;
function onFrame(t, frame) {
  const dt = Math.min(0.1, (t - lastT) / 1000 || 0);
  lastT = t;
  if (!frame) return;

  const vp = frame.getViewerPose(ref);
  if (vp) A.head.fromArray(vp.transform.matrix);
  if (A.needPanelPlacement && vp) { placeMenuInFront(); A.needPanelPlacement = false; }

  if (A.drag) updateDrag(dt);
  scene.updateMatrixWorld();

  // poses, rays, hover over menu
  let hover = null;
  for (const [src, rec] of inputs) {
    const p = frame.getPose(src.targetRaySpace, ref);
    rec.hasPose = !!p;
    rec.ray.visible = !!p;
    if (!p) continue;
    rec.pose.fromArray(p.transform.matrix);
    setRayFromPose(rec.pose);
    const hit = raycaster.intersectObjects(menuTargets(), false)[0];
    let len = 3;
    if (hit) {
      len = hit.distance;
      const target = hit.object === panel.mesh ? panel : pill;
      const id = target.hitTest(hit.uv);
      if (id) hover = { target, id };
    }
    rec.ray.matrix.copy(rec.pose).multiply(new M4().makeScale(1, 1, len));
    handleGamepad(src, rec, dt);
  }
  hover = handleFingers(frame) || hover;
  panel.setHover(hover && hover.target === panel ? hover.id : null);
  pill.setHover(hover && hover.target === pill ? hover.id : null);

  // placing: the image follows the pointer
  if (A.mode === 'placing') updateGhost(frame);

  // placing: confirm (done here, because anchors must be created inside a frame)
  if (A.placeRequested) {
    A.placeRequested = false;
    if (A.mode === 'placing') confirmPlacement(frame);
  }

  if (A.mode === 'restoring' && A.restore) updateRestore(frame);
  if (A.detailsDirty && t - (A.detailsSavedAt || 0) > 500) { A.detailsDirty = false; A.detailsSavedAt = t; updateSavedDetails(); }
  if (A.needAnchor) { A.needAnchor = false; if (A.mode === 'placed') anchorAt(frame, A.placedMatrix); }
  // placed: follow the anchor if the system refines it
  if (A.mode === 'placed') {
    if (A.anchor && frame.trackedAnchors?.has(A.anchor)) {
      const ap = frame.getPose(A.anchor.anchorSpace, ref);
      if (ap) A.placedMatrix.fromArray(ap.transform.matrix);
    }
  }
  // fine-tuning: slide along the surface (local X/Y) and depth along its normal (local Z).
  // Always start from the stored pose so the offsets never pile up frame after frame.
  const slide = A.mode === 'placed' ? A.slide : { x: 0, y: 0 };
  imageRoot.matrix.copy(A.mode === 'placed' ? A.placedMatrix : A.ghost)
    .multiply(new M4().makeTranslation(slide.x, slide.y, S.depth));

  imageRoot.visible = A.mode !== 'calibrating' && A.mode !== 'restoring';
  // touch dots: always while calibrating, afterwards only while the menu is open and unlocked
  const showDots = A.mode === 'calibrating' || (!!A.surface && A.menuOpen && !A.locked);
  calibDots.forEach((d, i) => (d.visible = showDots && (A.mode !== 'calibrating' || (i === 0 ? !!A.calib?.p1 : false))));
  frameLines.visible = A.mode === 'placing' || !A.locked;
  reticle.visible = A.mode === 'placing';
  // grid: centered on the image, lying on its surface (upright on walls), never rotated with the picture
  const adjusting = A.mode === 'placing' || (A.mode === 'placed' && !A.locked);
  const onSomething = A.mode === 'placed' || (A.mode === 'placing' && A.onSurface);
  surfaceGrid.visible = onSomething && (S.gridMode === 'always' || (S.gridMode === 'adjusting' && adjusting));
  if (surfaceGrid.visible) surfaceGrid.matrix.copy(imageRoot.matrix).multiply(new M4().makeTranslation(0, 0, 0.001));
  panel.mesh.visible = A.menuOpen;
  pill.mesh.visible = !A.menuOpen;
  panel.flush(t);

  renderer.render(scene, camera);
}

function updateGhost(frame) {
  const src = A.activeSource, rec = src && inputs.get(src);
  if (!rec || !rec.hasPose) return;
  let m = null;
  if (A.surface) {
    // calibrated surface: intersect the pointer ray with that exact plane
    const [o, d] = setRayFromPose(rec.pose);
    const { point, normal } = A.surface;
    const denom = normal.dot(d);
    const t = denom < -1e-4 ? normal.dot(point.clone().sub(o)) / denom : -1;
    if (t > 0 && t < 15) {
      A.onSurface = true;
      A.ghost.copy(surfaceFrame(o.addScaledVector(d, t), normal));
      imageRoot.matrix.copy(A.ghost);
      reticle.material.color.set(0x39ff14);
      panel.setHint(`On your ${A.surface.kind === 'wall' ? 'wall' : 'surface'}. Pull the trigger (or pinch) to place.`);
    } else {
      A.onSurface = false;
      reticle.material.color.set(0xffb020);
      panel.setHint(`Point at the ${A.surface.kind === 'wall' ? 'wall' : 'surface'} you set up.`);
    }
    return;
  }
  if (rec.hitSource) {
    const results = frame.getHitTestResults(rec.hitSource);
    if (results.length) {
      const p = results[0].getPose(ref);
      if (p) {
        const hm = new M4().fromArray(p.transform.matrix);
        m = surfaceFrame(new V3().setFromMatrixPosition(hm), new V3().setFromMatrixColumn(hm, 1));
      }
    }
  }
  A.onSurface = !!m;
  if (!m) {
    // nothing hit: float 1.5 m along the ray, upright and facing you
    const [o, d] = setRayFromPose(rec.pose);
    const pos = o.addScaledVector(d, 1.5);
    const n = d.clone().negate(); n.y = 0;
    if (n.lengthSq() < 1e-6) n.set(0, 0, 1);
    m = surfaceFrame(pos, n);
  }
  A.ghost.copy(m);
  imageRoot.matrix.copy(m);
  reticle.material.color.set(A.onSurface ? 0x39ff14 : 0xffb020);
  panel.setHint(A.onSurface
    ? 'Surface found. Pull the trigger (or pinch) to place.'
    : 'No surface here. Point at a wall or table, or place it floating.');
}

// ---------- surface calibration: touch the surface at two points ----------
function startCalibration(kind) {
  if (A.locked) return;
  dropAnchor();
  if (A.restore) { A.restore.anchor?.delete?.(); A.restore = null; }
  A.surfaceMode = kind;
  A.calib = { kind, p1: null };
  A.mode = 'calibrating';
  calibDots.forEach((d) => (d.visible = false));
  panel.setHint(kind === 'wall'
    ? 'Step 1 of 2: hold a controller flat against the wall, then pull its trigger.'
    : 'Step 1 of 2: lay a controller flat on the surface, then pull its trigger.');
  panel.dirty = true;
}

function captureCalibrationPoint(e) {
  const src = e.inputSource;
  const space = src.gripSpace || src.targetRaySpace;
  const p = e.frame.getPose(space, ref);
  if (!p) return;
  const pt = new V3(p.transform.position.x, p.transform.position.y, p.transform.position.z);
  const C = A.calib;
  if (!C.p1) {
    C.p1 = pt;
    calibDots[0].position.copy(pt); calibDots[0].visible = true;
    pulse(src, 0.8, 60);
    panel.setHint('Step 2 of 2: move about half a meter to the side, touch the surface again, then pull the trigger.');
    return;
  }
  const flat = pt.clone().sub(C.p1);
  if (C.kind === 'wall') flat.y = 0;
  if (flat.length() < 0.2) {
    pulse(src, 1, 150);
    panel.setHint('Those points are too close. Move at least 20 cm away from the first one and try step 2 again.');
    return;
  }
  calibDots[1].position.copy(pt); calibDots[1].visible = true;
  const head = new V3().setFromMatrixPosition(A.head);
  const mid = C.p1.clone().add(pt).multiplyScalar(0.5);
  let normal;
  if (C.kind === 'wall') {
    normal = new V3(-flat.z, 0, flat.x).normalize(); // horizontal, perpendicular to the two touches
  } else {
    normal = new V3(0, 1, 0);
  }
  if (normal.dot(head.clone().sub(mid)) < 0) normal.negate();
  // the tracked point is inside the controller: move the plane onto the real surface
  const point = mid.addScaledVector(normal, -CONTROLLER_HALF_THICKNESS);
  A.surface = { kind: C.kind, point, normal };
  A.calib = null;
  A.mode = 'placing';
  pulse(src, 0.8, 60);
  setTimeout(() => pulse(src, 0.8, 60), 120);
  panel.setHint(C.kind === 'wall' ? 'Wall set. Point at it and pull the trigger to place.' : 'Surface set. Point at it and pull the trigger to place.');
  panel.dirty = true;
}

function useAutoSurface() {
  if (A.locked) return;
  A.surfaceMode = 'auto';
  A.surface = null;
  A.calib = null;
  calibDots.forEach((d) => (d.visible = false));
  if (A.mode === 'calibrating') A.mode = 'placing';
  panel.dirty = true;
}

function confirmPlacement(frame) {
  if (A.surface && !A.onSurface) return; // pointing away from the calibrated surface
  if (!A.moveRemembered) remember('place'); // first placement: undo goes back to placing
  A.moveRemembered = false;
  A.slide = { x: 0, y: 0 };
  A.placedMatrix.copy(A.ghost);
  A.mode = 'placed';
  anchorAt(frame, A.placedMatrix);
  panel.setHint('Placed. Lock it before you start drawing.');
  panel.dirty = true;
}

// Anchor the image to the real world so it stays put if tracking re-centers.
let anchorToken = 0;
function dropAnchor() { anchorToken++; A.anchor?.delete?.(); A.anchor = null; }
function anchorAt(frame, matrix) {
  dropAnchor();
  if (!frame.createAnchor) return;
  const token = anchorToken, pos = new V3(), quat = new THREE.Quaternion(), scl = new V3();
  matrix.decompose(pos, quat, scl);
  try {
    frame.createAnchor(new XRRigidTransform(
      { x: pos.x, y: pos.y, z: pos.z, w: 1 }, { x: quat.x, y: quat.y, z: quat.z, w: quat.w }
    ), ref).then((a) => {
      if (token !== anchorToken || A.mode !== 'placed') { a.delete?.(); return; }
      A.anchor = a;
      persistPlacement(a, token);
    }).catch((e) => console.warn('anchor failed', e));
  } catch (e) { console.warn('anchor failed', e); }
}

// ---------- remembering the placement between sessions ----------
// The headset keeps a "persistent anchor" (a point in your room) and gives us an id for it.
// We store that id plus everything else about the placement relative to the anchor.
const PLACEMENT_KEY = 'traceAR.placement';
function readPlacement() { return readJSON(PLACEMENT_KEY); }
function writePlacement(rec) { try { localStorage.setItem(PLACEMENT_KEY, JSON.stringify(rec)); } catch {} }

async function persistPlacement(anchor, token) {
  if (!anchor.requestPersistentHandle) return; // this browser can't remember anchors
  try {
    const uuid = await anchor.requestPersistentHandle();
    if (token !== anchorToken) return;
    rememberAnchorId(uuid);
    writePlacement({ uuid, ...placementDetails(), savedAt: Date.now() });
    panel.setHint('Placed and saved: it will be here next time too. Lock it before you start drawing.');
  } catch (e) { console.warn('could not save the placement', e); }
}
// slide, lock and the calibrated surface, stored relative to the anchor's pose
function placementDetails() {
  const inv = A.placedMatrix.clone().invert();
  const d = { slide: { ...A.slide }, locked: A.locked };
  if (A.surface) {
    d.surface = {
      kind: A.surface.kind,
      point: A.surface.point.clone().applyMatrix4(inv).toArray(),
      normal: A.surface.normal.clone().transformDirection(inv).toArray(),
    };
  }
  if (calibDots[1].position.lengthSq()) d.dots = calibDots.map((m) => m.position.clone().applyMatrix4(inv).toArray());
  return d;
}
function updateSavedDetails() {
  const rec = readPlacement();
  if (rec.uuid && A.mode === 'placed' && A.anchor) writePlacement({ ...rec, ...placementDetails(), savedAt: Date.now() });
}
// Older saved spots are kept (project zips may point at them); only the oldest beyond 20 are erased.
function rememberAnchorId(uuid) {
  let list = readJSON('traceAR.anchors').list || [];
  list = list.filter((u) => u !== uuid).concat(uuid);
  const keep = new Set([uuid, readPlacement().uuid]);
  while (list.length > 20) {
    const old = list.shift();
    if (!keep.has(old)) session?.deletePersistentAnchor?.(old).catch(() => {});
  }
  try { localStorage.setItem('traceAR.anchors', JSON.stringify({ list })); } catch {}
}
function forgetPlacement() {
  try { localStorage.removeItem(PLACEMENT_KEY); } catch {}
  panel.setHint('Forgot the saved placement. Next time you’ll place the image fresh.');
  panel.dirty = true;
}

async function tryRestorePlacement() {
  const rec = readPlacement();
  if (!rec.uuid || !session.restorePersistentAnchor) return;
  A.mode = 'restoring';
  A.restore = { rec, started: performance.now(), anchor: null };
  panel.setHint('Looking for your saved placement… look around the room. Press “Place new” to skip.');
  panel.dirty = true;
  try {
    const a = await session.restorePersistentAnchor(rec.uuid);
    if (A.mode === 'restoring' && A.restore?.rec === rec) A.restore.anchor = a; else a.delete?.();
  } catch (e) {
    console.warn('restore failed', e);
    if (A.mode === 'restoring') restoreFailed();
  }
}
function updateRestore(frame) {
  const R = A.restore;
  if (R.anchor && frame.trackedAnchors?.has(R.anchor)) {
    const p = frame.getPose(R.anchor.anchorSpace, ref);
    if (!p) return;
    anchorToken++;
    A.anchor = R.anchor;
    A.placedMatrix.fromArray(p.transform.matrix);
    const { rec } = R;
    A.slide = { x: rec.slide?.x || 0, y: rec.slide?.y || 0 };
    A.locked = !!rec.locked;
    if (rec.surface) {
      A.surface = {
        kind: rec.surface.kind,
        point: new V3().fromArray(rec.surface.point).applyMatrix4(A.placedMatrix),
        normal: new V3().fromArray(rec.surface.normal).transformDirection(A.placedMatrix),
      };
      A.surfaceMode = rec.surface.kind;
    }
    if (rec.dots) rec.dots.forEach((d, i) => calibDots[i].position.fromArray(d).applyMatrix4(A.placedMatrix));
    A.restore = null;
    A.mode = 'placed';
    panel.setHint(A.locked ? 'Welcome back: restored where you left it (locked).' : 'Welcome back: restored where you left it.');
    panel.dirty = true;
  } else if (performance.now() - R.started > 25000) {
    restoreFailed();
  }
}
function restoreFailed() {
  A.restore?.anchor?.delete?.();
  A.restore = null;
  A.mode = 'placing';
  panel.setHint('Couldn’t find last time’s placement in this room. Point at a wall or table to place it again.');
  panel.dirty = true;
}

// ---------- undo ----------
// Each change pushes the state from before it. Rapid repeats of the same kind of change
// (holding a stick, tapping + several times) count as one step.
const history = [];
function remember(kind) {
  const now = performance.now(), top = history[history.length - 1];
  if (top && top.kind === kind && kind !== 'place' && now - top.t < 1200) { top.t = now; return; }
  history.push({
    kind, t: now, mode: A.mode, placed: A.placedMatrix.clone(), slide: { ...A.slide },
    width: S.width, angle: S.angle, depth: S.depth, opacity: S.opacity,
  });
  if (history.length > 80) history.shift();
  if (panel) panel.dirty = true;
}
function undo() {
  if (A.locked || A.mode === 'calibrating') return;
  const h = history.pop();
  if (!h) return;
  S.width = h.width; S.angle = h.angle; S.depth = h.depth; S.opacity = h.opacity;
  A.slide = { ...h.slide };
  if (h.kind === 'place') {
    A.moveRemembered = false;
    if (h.mode === 'placed') { A.placedMatrix.copy(h.placed); A.mode = 'placed'; A.needAnchor = true; }
    else { dropAnchor(); A.mode = 'placing'; }
  }
  applyTransform(); saveSettings();
  panel.setHint(`Undid ${{ place: 'placement', slide: 'slide', width: 'width', rotate: 'rotation', depth: 'depth', opacity: 'opacity' }[h.kind]}.`);
  panel.dirty = true;
}

// ======================================================================
// Actions
// ======================================================================
function applyLayer() {
  const L = textures[A.layer];
  if (!L) return;
  imageMat.map = L.tex;
  imageMat.needsUpdate = true;
  applyTransform();
}
function applyTransform() {
  const L = textures[A.layer];
  imageMat.opacity = S.opacity;
  imageMesh.rotation.z = THREE.MathUtils.degToRad(-S.angle); // positive = clockwise as you look at it
  imageMesh.scale.set(S.width, S.width * (L ? L.aspect : 1), 1);
  panel && (panel.dirty = true);
}
const wrapAngle = (a) => { a = ((a % 360) + 360) % 360; return a > 180 ? a - 360 : a; };
function rotateBy(delta) {
  if (A.locked) return;
  remember('rotate');
  S.angle = S.snap ? wrapAngle(Math.round((S.angle + delta) / S.snap) * S.snap) : wrapAngle(S.angle + delta);
  applyTransform(); saveSettings();
}
function setSnap(v) {
  if (v && Math.round(S.angle / v) * v !== S.angle) remember('rotate');
  S.snap = v;
  if (v) S.angle = wrapAngle(Math.round(S.angle / v) * v);
  applyTransform(); saveSettings();
}
function scaleBy(f) {
  if (A.locked) return;
  remember('width');
  S.width = THREE.MathUtils.clamp(S.width * f, 0.05, 10);
  applyTransform(); saveSettings();
}
function setDepth(v) {
  if (A.locked) return;
  remember('depth');
  S.depth = THREE.MathUtils.clamp(v, -0.15, 0.15);
  panel.dirty = true; saveSettings();
}
function setOpacity(v) {
  remember('opacity');
  S.opacity = THREE.MathUtils.clamp(v, 0.05, 1);
  applyTransform(); saveSettings();
}
function nextLayer(step) {
  if (!textures.length) return;
  A.layer = (A.layer + step + textures.length) % textures.length;
  applyLayer();
}
function startMove() {
  if (A.mode === 'restoring') { // skip the saved placement and place fresh
    A.restore?.anchor?.delete?.();
    A.restore = null;
    A.locked = false;
    A.moveRemembered = false;
    A.mode = 'placing';
    panel.dirty = true;
    return;
  }
  if (A.locked) return;
  remember('place'); // undo brings the image back to where it was
  A.moveRemembered = true;
  dropAnchor();
  A.mode = 'placing';
  panel.dirty = true;
}
// Default: about a meter away at belly height, tilted to face you (use the pointer).
// Within reach (summoned from the wrist button): close enough to tap with a finger.
function placeMenuInFront(withinReach = false) {
  const head = new V3().setFromMatrixPosition(A.head);
  const fwd = new V3(0, 0, -1).transformDirection(A.head);
  fwd.y = 0;
  if (fwd.lengthSq() < 1e-6) fwd.set(0, 0, -1);
  fwd.normalize();
  const pos = head.clone().addScaledVector(fwd, withinReach ? 0.42 : 1.05);
  pos.y = head.y - (withinReach ? 0.38 : 0.5);
  for (const m of [panel.mesh, pill.mesh]) {
    m.position.copy(pos);
    m.lookAt(head);
  }
}
// ---------- fingers (hand tracking) ----------
// Tap menu buttons by touching them with an index finger. A small button floats above the
// left wrist: tap it with the right index finger to bring the menu within reach.
function jointPos(frame, hand, name) {
  const j = hand.get(name), p = j && frame.getJointPose?.(j, ref);
  return p ? new V3(p.transform.position.x, p.transform.position.y, p.transform.position.z) : null;
}
function handleFingers(frame) {
  let hover = null, rightTip = null, leftWrist = null;
  for (const [src, rec] of inputs) {
    if (!src.hand) continue;
    const tip = jointPos(frame, src.hand, 'index-finger-tip');
    if (src.handedness === 'right') rightTip = tip;
    if (src.handedness === 'left') leftWrist = jointPos(frame, src.hand, 'wrist');
    if (!tip) continue;
    const target = A.menuOpen ? panel : pill;
    const local = target.mesh.worldToLocal(tip.clone());
    const { w, h } = target.size;
    const inside = Math.abs(local.x) <= w / 2 && Math.abs(local.y) <= h / 2;
    const id = inside && local.z < 0.05 && local.z > -0.04 ? target.hitTest({ x: local.x / w + 0.5, y: local.y / h + 0.5 }) : null;
    if (id) hover = { target, id };
    // a press = the fingertip crosses the menu surface from the front
    if (id && rec.pokeArmed !== false && rec.lastZ >= 0.01 && local.z < 0.01) {
      rec.pokeArmed = false;
      if (id !== 'drag') runButton(id);
    }
    if (!inside || local.z > 0.03) rec.pokeArmed = true;
    rec.lastZ = inside ? local.z : 1;
  }
  // wrist button
  wristBtn.mesh.visible = !!leftWrist;
  if (leftWrist) {
    const head = new V3().setFromMatrixPosition(A.head);
    const pos = leftWrist.clone().add(new V3(0, 0.05, 0)).addScaledVector(head.clone().sub(leftWrist).normalize(), 0.02);
    wristBtn.mesh.position.copy(pos);
    wristBtn.mesh.lookAt(head);
    const d = rightTip ? rightTip.distanceTo(pos) : 1;
    wristBtn.setHover(d < 0.05);
    if (d < 0.025 && wristBtn.armed) {
      wristBtn.armed = false;
      A.menuOpen = true;
      placeMenuInFront(true);
      panel.setHint('Menu brought within reach. Tap buttons with your finger.');
      panel.dirty = true;
    }
    if (d > 0.06) wristBtn.armed = true;
  }
  return hover;
}

// ---------- moving the menu around the room ----------
function tryStartDrag(src, via) {
  const rec = inputs.get(src);
  if (!rec || !rec.hasPose || A.drag) return;
  setRayFromPose(rec.pose);
  const hit = raycaster.intersectObjects(menuTargets(), false)[0];
  if (!hit) return;
  const target = hit.object === panel.mesh ? panel : pill;
  if (via === 'select' && target === panel && target.hitTest(hit.uv) !== 'drag') return; // trigger: title bar only
  if (via === 'select' && target === pill) return; // trigger on the pill opens the menu
  const menu = A.menuOpen ? panel.mesh : pill.mesh;
  // keep the grabbed point at the same distance along the pointer
  A.drag = { src, via, dist: hit.distance, offset: menu.position.clone().sub(hit.point) };
  panel.dirty = true;
  pulse(src, 0.5, 30);
}
function updateDrag(dt) {
  const rec = A.drag && inputs.get(A.drag.src);
  if (!rec) { A.drag = null; return; }
  if (!rec.hasPose) return;
  // while holding: stick up/down pushes the menu away / pulls it closer
  const y = A.drag.src.gamepad?.axes[3] || 0;
  if (Math.abs(y) > 0.25) A.drag.dist = THREE.MathUtils.clamp(A.drag.dist - y * dt * 1.5, 0.25, 6);
  const [o, d] = setRayFromPose(rec.pose);
  const pos = o.addScaledVector(d, A.drag.dist).add(A.drag.offset);
  const head = new V3().setFromMatrixPosition(A.head);
  for (const m of [panel.mesh, pill.mesh]) { m.position.copy(pos); m.lookAt(head); }
}

function pulse(src, strength = 0.4, ms = 25) {
  try { src?.gamepad?.hapticActuators?.[0]?.pulse(strength, ms); } catch {}
}

function onSelect(e) {
  const src = e.inputSource, rec = inputs.get(src);
  if (!rec || !rec.hasPose) return;
  // the trigger was held to adjust depth with the stick: releasing it is not a click
  if (rec.triggerCombo) { rec.triggerCombo = false; return; }
  // the trigger was held to move the menu: releasing it is not a click either
  if (A.drag && A.drag.src === src && A.drag.via === 'select') return;
  setRayFromPose(rec.pose);
  const hit = raycaster.intersectObjects(menuTargets(), false)[0];
  if (hit) {
    const target = hit.object === panel.mesh ? panel : pill;
    const id = target.hitTest(hit.uv);
    if (id) { pulse(src); runButton(id); }
    return;
  }
  if (A.mode === 'calibrating') return captureCalibrationPoint(e);
  if (A.mode === 'placing') {
    A.activeSource = src;
    A.placeRequested = true;
    pulse(src, 0.7, 40);
  }
}

function menuTargets() { return A.menuOpen ? [panel.mesh] : [pill.mesh]; }

function runButton(id) {
  if (id.startsWith('snap:')) return setSnap(+id.slice(5));
  if (id === 'surf:auto') return useAutoSurface();
  if (id.startsWith('gstep:')) { S.gridStep = +id.slice(6); rebuildGrid(); saveSettings(); panel.dirty = true; return; }
  if (id.startsWith('gmode:')) { S.gridMode = id.slice(6); saveSettings(); panel.dirty = true; return; }
  if (id.startsWith('surf:')) return startCalibration(id.slice(5));
  switch (id) {
    case 'depth-': return setDepth(S.depth - 0.005);
    case 'depth+': return setDepth(S.depth + 0.005);
    case 'prev': return nextLayer(-1);
    case 'next': return nextLayer(1);
    case 'op-': return setOpacity(Math.round((S.opacity - 0.1) * 20) / 20);
    case 'op+': return setOpacity(Math.round((S.opacity + 0.1) * 20) / 20);
    case 'size-': return scaleBy(1 / 1.05);
    case 'size+': return scaleBy(1.05);
    case 'rotL': return rotateBy(-(S.snap || 1));
    case 'rotR': return rotateBy(S.snap || 1);
    case 'move': return startMove();
    case 'undo': return undo();
    case 'adv': panel.page = 'advanced'; panel.dirty = true; return;
    case 'back': panel.page = 'main'; panel.dirty = true; return;
    case 'grid-': S.gridSize = Math.max(1, S.gridSize - 1); rebuildGrid(); saveSettings(); panel.dirty = true; return;
    case 'grid+': S.gridSize = Math.min(12, S.gridSize + 1); rebuildGrid(); saveSettings(); panel.dirty = true; return;
    case 'forget': forgetPlacement(); return;
    case 'lock': A.locked = !A.locked; A.detailsDirty = true; panel.setHint(A.locked ? 'Locked. Position, size and rotation are fixed.' : 'Unlocked.'); panel.dirty = true; return;
    case 'hide': A.menuOpen = false; return;
    case 'open': A.menuOpen = true; panel.dirty = true; return; // opens where the pill is
    case 'exit': session?.end(); return;
  }
}

// thumbsticks + face buttons (Quest controllers use the xr-standard mapping)
function handleGamepad(src, rec, dt) {
  const gp = src.gamepad;
  if (!gp) return;
  const pressed = (i) => !!gp.buttons[i]?.pressed;
  const edge = (i) => pressed(i) && !rec.prevButtons[i];
  if (edge(4)) { nextLayer(1); pulse(src); }                         // A / X
  if (edge(5)) { A.menuOpen = true; placeMenuInFront(); pulse(src); } // B / Y
  rec.prevButtons = gp.buttons.map((b) => b.pressed);
  if (A.drag && A.drag.src === src) return; // stick is pushing/pulling the menu

  const x = gp.axes[2] || 0, y = gp.axes[3] || 0, dead = 0.25;
  if (src.handedness === 'left') {
    // left trigger held + stick = slowly slide the placed image along the surface
    if (edge(0)) rec.triggerCombo = false;
    if (pressed(0)) {
      if (A.mode === 'placed' && !A.locked && (Math.abs(x) > dead || Math.abs(y) > dead)) {
        // squared response: small tilts move very slowly, full tilt is 2 cm per second
        const f = (v) => (Math.abs(v) > dead ? Math.sign(v) * ((Math.abs(v) - dead) / (1 - dead)) ** 2 : 0);
        const dx = f(x) * 0.02 * dt, dy = -f(y) * 0.02 * dt;
        const before = Math.round(A.slideDist * 200);
        remember('slide');
        A.detailsDirty = true;
        A.slide.x += dx; A.slide.y += dy; A.slideDist += Math.hypot(dx, dy);
        if (Math.round(A.slideDist * 200) !== before) pulse(src, 0.15, 6); // tick every 0.5 cm
        rec.triggerCombo = true;
        const cm = (v) => Math.abs(v * 100).toFixed(1);
        panel.setHint(`Moved ${cm(A.slide.x)} cm ${A.slide.x < 0 ? 'left' : 'right'}, ${cm(A.slide.y)} cm ${A.slide.y < 0 ? 'down' : 'up'}. Release the trigger to keep it.`);
      }
      return;
    }
    if (Math.abs(y) > dead) setOpacity(S.opacity - y * dt * 0.6);
    return;
  }
  if (A.locked) return;
  // right trigger held + stick left/right = depth instead of rotation
  if (edge(0)) rec.triggerCombo = false;
  if (pressed(0)) {
    if (Math.abs(x) > dead) {
      const before = Math.round(S.depth * 200);
      setDepth(S.depth + x * dt * 0.03); // up to 3 cm per second
      if (Math.round(S.depth * 200) !== before) pulse(src, 0.2, 8); // tick every 0.5 cm
      rec.triggerCombo = true;
      const cm = S.depth * 100;
      panel.setHint(`Depth ${cm > 0 ? '+' : ''}${cm.toFixed(1)} cm (stick right = toward you). Release the trigger to keep it.`);
    }
    return;
  }
  if (Math.abs(y) > dead && Math.abs(y) > Math.abs(x)) scaleBy(1 - y * dt * 0.8);
  if (S.snap) {
    // with snapping: one flick = one step
    if (Math.abs(x) > 0.7 && rec.flickReady) { rotateBy(Math.sign(x) * S.snap); rec.flickReady = false; pulse(src, 0.3, 15); }
    if (Math.abs(x) < 0.3) rec.flickReady = true;
  } else if (Math.abs(x) > dead && Math.abs(x) > Math.abs(y)) {
    rotateBy(x * dt * 45);
  }
}

// ======================================================================
// In-headset menu (drawn on a canvas, clicked with the controller ray)
// ======================================================================
const FONT = '-apple-system, "Segoe UI", Roboto, sans-serif';
function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath(); ctx.roundRect ? ctx.roundRect(x, y, w, h, r) : ctx.rect(x, y, w, h);
}

function makeCanvasMesh(cw, ch, meters) {
  const canvas = document.createElement('canvas');
  canvas.width = cw; canvas.height = ch;
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(meters, meters * (ch / cw)),
    new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthTest: false })
  );
  mesh.renderOrder = 10; // menu always on top of the image
  return { canvas, ctx: canvas.getContext('2d'), tex, mesh, size: { w: meters, h: meters * (ch / cw) } };
}

function makePanel() {
  const W = 1024, H = 1100;
  const c = makeCanvasMesh(W, H, 0.42);
  const P = Object.assign(c, {
    buttons: [], hover: null, hint: '', dirty: true, lastDraw: 0, page: 'main',
    setHover(id) { if (id !== this.hover) { this.hover = id; this.dirty = true; } },
    setHint(h) { if (h !== this.hint) { this.hint = h; this.dirty = true; } },
    hitTest(uv) {
      const x = uv.x * W, y = (1 - uv.y) * H;
      const b = this.buttons.find((b) => !b.disabled && x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h);
      return b ? b.id : null;
    },
    flush(t) { if (this.dirty && t - this.lastDraw > 60) { this.redraw(); this.lastDraw = t; } },
    redraw() {
      const ctx = this.ctx;
      this.dirty = false;
      this.buttons = [];
      ctx.clearRect(0, 0, W, H);
      roundRect(ctx, 0, 0, W, H, 36);
      ctx.fillStyle = 'rgba(24,25,30,0.94)'; ctx.fill();

      ctx.fillStyle = '#e8e9ec'; ctx.font = `700 40px ${FONT}`; ctx.textBaseline = 'middle';
      ctx.fillText('VR-Stencilator', 40, 68, 300);
      // title bar = drag handle (hold trigger or grip here to move the menu)
      const dragging = !!A.drag, hov = this.hover === 'drag' || dragging;
      roundRect(ctx, 360, 16, 624, 100, 24);
      ctx.fillStyle = dragging ? '#ff3df0' : hov ? '#3d414c' : '#2a2d35'; ctx.fill();
      if (hov && !dragging) { ctx.lineWidth = 4; ctx.strokeStyle = '#ffffff'; ctx.stroke(); }
      ctx.fillStyle = dragging ? '#1a0018' : '#e8e9ec'; ctx.font = `600 38px ${FONT}`; ctx.textAlign = 'center';
      ctx.fillText(dragging ? 'Moving…' : '✥  Move menu (hold)', 672, 68);
      ctx.textAlign = 'left';
      this.buttons.push({ id: 'drag', x: 0, y: 0, w: W, h: 124 });
      // hint, wrapped onto up to two lines
      ctx.fillStyle = A.mode === 'calibrating' ? '#ffd27a' : '#9a9ea8'; ctx.font = `400 29px ${FONT}`;
      const words = this.hint.split(' '), lines = [''];
      for (const w of words) {
        const tryLine = lines[lines.length - 1] ? lines[lines.length - 1] + ' ' + w : w;
        if (ctx.measureText(tryLine).width > W - 80 && lines[lines.length - 1]) lines.push(w);
        else lines[lines.length - 1] = tryLine;
      }
      lines.slice(0, 2).forEach((l, i) => ctx.fillText(l, 40, 150 + i * 36, W - 80));

      const L = textures[A.layer];
      const lockedOff = A.locked;
      const label = (text, y) => { ctx.fillStyle = '#9a9ea8'; ctx.font = `600 32px ${FONT}`; ctx.textAlign = 'left'; ctx.fillText(text, 40, y + 45); };
      const segs = (y, items, current, prefix) => {
        const n = items.length, w = (984 - 230 - (n - 1) * 10) / n;
        items.forEach(([v, text], i) => this.btn(prefix + v, 230 + i * (w + 10), y, w, 90, text, { on: current === v }));
      };
      const row = (y, label, minusId, value, plusId, disabled) => {
        ctx.fillStyle = '#9a9ea8'; ctx.font = `600 32px ${FONT}`; ctx.textAlign = 'left';
        ctx.fillText(label, 40, y + 45);
        this.btn(minusId, 230, y, 110, 90, minusId === 'prev' ? '◀' : minusId === 'rotL' ? '↺' : '−', { disabled });
        ctx.fillStyle = disabled ? '#5c606a' : '#e8e9ec'; ctx.font = `600 36px ${FONT}`; ctx.textAlign = 'center';
        ctx.fillText(value, (350 + 864) / 2, y + 47, 500);
        ctx.textAlign = 'left';
        this.btn(plusId, 874, y, 110, 90, plusId === 'next' ? '▶' : plusId === 'rotR' ? '↻' : '+', { disabled });
      };
      if (this.page === 'advanced') {
        // ----- advanced options -----
        ctx.fillStyle = '#e8e9ec'; ctx.font = `700 36px ${FONT}`; ctx.fillText('Advanced', 40, 245);
        const cells = Math.round(S.gridSize / S.gridStep);
        row(290, 'Grid size', 'grid-', `${S.gridSize} m × ${S.gridSize} m (${cells} × ${cells} squares)`, 'grid+', false);
        label('Squares', 395);
        segs(395, [[0.05, '5 cm'], [0.1, '10 cm'], [0.25, '25 cm'], [0.5, '50 cm']], S.gridStep, 'gstep:');
        label('Show grid', 500);
        segs(500, [['adjusting', 'While adjusting'], ['always', 'Always'], ['off', 'Off']], S.gridMode, 'gmode:');
        ctx.fillStyle = '#9a9ea8'; ctx.font = `400 28px ${FONT}`;
        ctx.fillText('The grid is centered on your image and lies on its surface. Make it', 40, 640, W - 80);
        ctx.fillText('bigger to check the image lines up with the wall edges and corners.', 40, 676, W - 80);
        const saved = readPlacement();
        label('Saved spot', 740);
        this.btn('forget', 230, 740, 754, 90, saved.uuid ? `Forget saved placement (${new Date(saved.savedAt).toLocaleDateString()})` : 'No saved placement', { disabled: !saved.uuid });
        const bw = (984 - 40 - 12) / 2;
        this.btn('back', 40, 965, bw, 96, '◀  Back');
        this.btn('exit', 40 + bw + 12, 965, bw, 96, 'Exit AR', { danger: true });
        this.tex.needsUpdate = true;
        return;
      }
      row(225, 'Layer', 'prev', L ? `${A.layer + 1}/${textures.length} · ${L.name}` : '—', 'next', textures.length < 2);
      row(330, 'Opacity', 'op-', `${Math.round(S.opacity * 100)}%`, 'op+', false);
      row(435, 'Width', 'size-', `${Math.round(S.width * 100)} cm`, 'size+', lockedOff);
      row(540, 'Rotate', 'rotL', `${Math.round(S.angle)}°`, 'rotR', lockedOff);

      ctx.fillStyle = '#9a9ea8'; ctx.font = `600 32px ${FONT}`;
      ctx.fillText('Snap', 40, 690);
      const sw = (984 - 230 - 4 * 10) / SNAPS.length;
      SNAPS.forEach((s, i) => this.btn('snap:' + s, 230 + i * (sw + 10), 645, sw, 90, s ? s + '°' : 'Off', { on: S.snap === s }));

      ctx.fillStyle = '#9a9ea8'; ctx.font = `600 32px ${FONT}`;
      ctx.fillText('Surface', 40, 795);
      const surf = [['auto', 'Auto'], ['wall', 'Wall'], ['floor', 'Floor / table']];
      const fw = (984 - 230 - 2 * 10) / 3;
      surf.forEach(([k, label], i) => this.btn('surf:' + k, 230 + i * (fw + 10), 750, fw, 90,
        A.calib?.kind === k ? 'Setting up…' : label, { on: A.surfaceMode === k, disabled: A.locked }));

      const depthCm = S.depth * 100;
      row(855, 'Depth', 'depth-', `${depthCm > 0 ? '+' : ''}${depthCm.toFixed(1)} cm`, 'depth+', lockedOff || A.mode === 'calibrating');

      const aw = (984 - 40 - 4 * 12) / 5, ay = 965;
      const busy = A.mode !== 'placed';
      const ax = (i) => 40 + i * (aw + 12);
      const restoring = A.mode === 'restoring';
      this.btn('move', ax(0), ay, aw, 96, restoring ? 'Place new' : A.mode === 'placing' ? 'Placing…' : 'Re-place',
        { disabled: !restoring && (busy || A.locked) });
      this.btn('lock', ax(1), ay, aw, 96, A.locked ? 'Unlock' : 'Lock', { on: A.locked, disabled: busy });
      this.btn('undo', ax(2), ay, aw, 96, 'Undo', { disabled: !history.length || A.locked || A.mode === 'calibrating' });
      this.btn('adv', ax(3), ay, aw, 96, 'More ⚙');
      this.btn('hide', ax(4), ay, aw, 96, 'Hide');
      this.tex.needsUpdate = true;
    },
    btn(id, x, y, w, h, label, o = {}) {
      const ctx = this.ctx, hov = this.hover === id && !o.disabled;
      roundRect(ctx, x, y, w, h, 18);
      ctx.fillStyle = o.on ? '#ff3df0' : o.danger ? (hov ? '#7a2a2a' : '#4a2224') : hov ? '#3d414c' : '#2a2d35';
      ctx.fill();
      if (hov) { ctx.lineWidth = 4; ctx.strokeStyle = '#ffffff'; ctx.stroke(); }
      ctx.fillStyle = o.disabled ? '#5c606a' : o.on ? '#1a0018' : '#e8e9ec';
      ctx.font = `600 ${label.length === 1 ? 48 : 36}px ${FONT}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(label, x + w / 2, y + h / 2 + 2, w - 16);
      ctx.textAlign = 'left';
      this.buttons.push({ id, x, y, w, h, disabled: o.disabled });
    },
  });
  return P;
}

function makeWristButton() {
  const c = makeCanvasMesh(256, 256, 0.05);
  const P = Object.assign(c, {
    hover: false, armed: true,
    setHover(h) { if (h !== this.hover) { this.hover = h; this.draw(); } },
    draw() {
      const ctx = this.ctx;
      ctx.clearRect(0, 0, 256, 256);
      ctx.beginPath(); ctx.arc(128, 128, 120, 0, Math.PI * 2);
      ctx.fillStyle = this.hover ? 'rgba(255,61,240,0.95)' : 'rgba(24,25,30,0.9)'; ctx.fill();
      ctx.lineWidth = 8; ctx.strokeStyle = '#ff3df0'; ctx.stroke();
      ctx.fillStyle = this.hover ? '#1a0018' : '#e8e9ec';
      ctx.font = `700 120px ${FONT}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('☰', 128, 136);
      this.tex.needsUpdate = true;
    },
  });
  P.mesh.visible = false;
  P.draw();
  return P;
}

function makePill() {
  const W = 512, H = 140;
  const c = makeCanvasMesh(W, H, 0.16);
  const P = Object.assign(c, {
    hover: false,
    setHover(id) { const h = !!id; if (h !== this.hover) { this.hover = h; this.draw(); } },
    hitTest() { return 'open'; },
    draw() {
      const ctx = this.ctx;
      ctx.clearRect(0, 0, W, H);
      roundRect(ctx, 4, 4, W - 8, H - 8, 66);
      ctx.fillStyle = this.hover ? 'rgba(255,61,240,0.95)' : 'rgba(24,25,30,0.9)'; ctx.fill();
      ctx.fillStyle = this.hover ? '#1a0018' : '#e8e9ec';
      ctx.font = `600 52px ${FONT}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('☰  Menu', W / 2, H / 2 + 2);
      this.tex.needsUpdate = true;
    },
  });
  P.draw();
  return P;
}

// Open ar.html?preview-menu to see the in-headset menu flat on the page (for tweaking its layout).
if (new URLSearchParams(location.search).has('preview-menu')) {
  textures = [{ name: 'outline', aspect: 1 }, { name: 'final', aspect: 1 }];
  const p = makePanel(), q = makePill();
  if (new URLSearchParams(location.search).get('preview-menu') === 'advanced') p.page = 'advanced';
  p.setHint('Surface found. Pull the trigger (or pinch) to place.');
  p.setHover('op+');
  p.redraw();
  for (const c of [p.canvas, q.canvas]) {
    c.style.cssText = 'display:block;margin:16px auto;max-width:100%;background:#556;border-radius:12px';
    document.body.appendChild(c);
  }
}
