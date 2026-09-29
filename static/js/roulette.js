/* Russian Roulette — 3D bar scene + realistic revolver (Three.js). */
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";

let renderer, scene, camera, controls, clock;
let revolver, cylinderGroup, hammer, muzzleFlash, muzzleLight;
let running = false, inited = false;
let tweens = [];
let shake = 0;
let idleT = 0;
let smokeParticles = [];

const GUNMETAL = 0x23262c;
const WOOD = 0x4a2c18;

// ---------- tween helpers ----------
function tween(obj, to, dur, ease, onDone) {
  const from = {};
  for (const k in to) from[k] = getPath(obj, k);
  tweens.push({ obj, from, to, dur, t: 0, ease: ease || easeOut, onDone });
}
function getPath(o, path) { return path.split(".").reduce((a, k) => a[k], o); }
function setPath(o, path, v) {
  const ks = path.split("."); const last = ks.pop();
  ks.reduce((a, k) => a[k], o)[last] = v;
}
const easeOut = (t) => 1 - Math.pow(1 - t, 3);
const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const easeIn = (t) => t * t * t;

function updateTweens(dt) {
  for (let i = tweens.length - 1; i >= 0; i--) {
    const tw = tweens[i];
    tw.t += dt;
    let p = Math.min(tw.t / tw.dur, 1);
    const e = tw.ease(p);
    for (const k in tw.to) setPath(tw.obj, k, tw.from[k] + (tw.to[k] - tw.from[k]) * e);
    if (p >= 1) { tweens.splice(i, 1); if (tw.onDone) tw.onDone(); }
  }
}

// ---------- materials ----------
function metal(color, rough = 0.32, metalness = 0.95) {
  return new THREE.MeshStandardMaterial({ color, roughness: rough, metalness });
}

// ---------- build revolver ----------
function buildRevolver() {
  const g = new THREE.Group();
  const steel = metal(GUNMETAL, 0.3, 0.95);
  const darkSteel = metal(0x15171b, 0.5, 0.9);
  const wood = new THREE.MeshStandardMaterial({ color: WOOD, roughness: 0.55, metalness: 0.05 });

  // ---- barrel (points +X) ----
  const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.028, 0.028, 0.30, 32), steel);
  barrel.rotation.z = Math.PI / 2;
  barrel.position.set(0.20, 0.045, 0);
  g.add(barrel);
  // barrel top rib
  const rib = new THREE.Mesh(new THREE.BoxGeometry(0.30, 0.016, 0.026), steel);
  rib.position.set(0.20, 0.072, 0);
  g.add(rib);
  // under-lug / ejector housing
  const lug = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.03, 0.03), steel);
  lug.position.set(0.20, 0.022, 0);
  g.add(lug);
  const ejrod = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, 0.24, 16), metal(0xb9bcc2, 0.25));
  ejrod.rotation.z = Math.PI / 2;
  ejrod.position.set(0.21, 0.022, 0);
  g.add(ejrod);
  // muzzle crown
  const crown = new THREE.Mesh(new THREE.CylinderGeometry(0.031, 0.031, 0.02, 32), darkSteel);
  crown.rotation.z = Math.PI / 2;
  crown.position.set(0.352, 0.045, 0);
  g.add(crown);
  const bore = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.015, 0.03, 24), new THREE.MeshBasicMaterial({ color: 0x050505 }));
  bore.rotation.z = Math.PI / 2;
  bore.position.set(0.358, 0.045, 0);
  g.add(bore);
  // front sight
  const fsight = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.03, 0.008), darkSteel);
  fsight.position.set(0.335, 0.088, 0);
  g.add(fsight);
  // rear sight
  const rsight = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.02, 0.03), darkSteel);
  rsight.position.set(0.055, 0.082, 0);
  g.add(rsight);

  // ---- frame / receiver ----
  const frame = new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.09, 0.045), steel);
  frame.position.set(0.02, 0.045, 0);
  g.add(frame);

  // ---- cylinder (rotating group) ----
  cylinderGroup = new THREE.Group();
  cylinderGroup.position.set(0.065, 0.045, 0);
  const cyl = new THREE.Mesh(new THREE.CylinderGeometry(0.046, 0.046, 0.072, 48), metal(0x2b2f36, 0.28, 0.95));
  cyl.rotation.z = Math.PI / 2;
  cylinderGroup.add(cyl);
  // flutes + chambers
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    const cz = Math.cos(a) * 0.03;
    const cy = Math.sin(a) * 0.03;
    // chamber bore on both faces
    const chamber = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, 0.076, 16),
      new THREE.MeshStandardMaterial({ color: 0x090909, roughness: 0.6, metalness: 0.4 }));
    chamber.rotation.z = Math.PI / 2;
    chamber.position.set(0, cy, cz);
    cylinderGroup.add(chamber);
    // flute cut (dark groove)
    const flute = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.006, 0.012), darkSteel);
    const fa = a + Math.PI / 6;
    flute.position.set(0, Math.sin(fa) * 0.043, Math.cos(fa) * 0.043);
    flute.lookAt(new THREE.Vector3(0, Math.sin(fa) * 0.1, Math.cos(fa) * 0.1));
    cylinderGroup.add(flute);
  }
  // center pin
  const pin = new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.006, 0.08, 12), metal(0x9a9da3, 0.3));
  pin.rotation.z = Math.PI / 2;
  cylinderGroup.add(pin);
  g.add(cylinderGroup);

  // ---- top strap ----
  const strap = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.014, 0.04), steel);
  strap.position.set(0.03, 0.088, 0);
  g.add(strap);

  // ---- hammer (rotates about Z at back) ----
  hammer = new THREE.Group();
  hammer.position.set(-0.028, 0.088, 0);
  const hbody = new THREE.Mesh(new THREE.BoxGeometry(0.018, 0.05, 0.02), darkSteel);
  hbody.position.set(0, 0.018, 0);
  hammer.add(hbody);
  const spur = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.014, 0.022), darkSteel);
  spur.position.set(-0.012, 0.045, 0);
  spur.rotation.z = 0.5;
  hammer.add(spur);
  g.add(hammer);

  // ---- trigger guard + trigger ----
  const guard = new THREE.Mesh(new THREE.TorusGeometry(0.028, 0.006, 12, 24, Math.PI * 1.3), steel);
  guard.position.set(-0.02, 0.0, 0);
  guard.rotation.set(Math.PI / 2, 0, -0.4);
  g.add(guard);
  const trigger = new THREE.Mesh(new THREE.BoxGeometry(0.01, 0.03, 0.012), darkSteel);
  trigger.position.set(-0.02, 0.012, 0);
  trigger.rotation.z = 0.2;
  g.add(trigger);

  // ---- grip (wood panels) ----
  const gripShape = new THREE.Group();
  const grip = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.13, 0.05), wood);
  grip.position.set(-0.055, -0.04, 0);
  grip.rotation.z = -0.32;
  gripShape.add(grip);
  const gripBack = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.13, 0.052), metal(0x1b1d22, 0.4, 0.9));
  gripBack.position.set(-0.083, -0.035, 0);
  gripBack.rotation.z = -0.32;
  gripShape.add(gripBack);
  // grip medallion
  const med = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, 0.052, 16), metal(0xe0b64a, 0.3, 0.9));
  med.rotation.x = Math.PI / 2;
  med.position.set(-0.05, -0.045, 0);
  gripShape.add(med);
  g.add(gripShape);

  // ---- screws ----
  [[-0.01, 0.045], [0.06, 0.02]].forEach(([x, y]) => {
    const s = new THREE.Mesh(new THREE.CylinderGeometry(0.005, 0.005, 0.046, 8), metal(0x8a8d93, 0.3));
    s.rotation.x = Math.PI / 2; s.position.set(x, y, 0.023);
    g.add(s);
  });

  // ---- muzzle flash ----
  muzzleFlash = new THREE.Sprite(new THREE.SpriteMaterial({
    map: makeFlashTexture(), color: 0xffcc66, transparent: true, opacity: 0,
    blending: THREE.AdditiveBlending, depthWrite: false,
  }));
  muzzleFlash.scale.set(0.001, 0.001, 0.001);
  muzzleFlash.position.set(0.4, 0.045, 0);
  g.add(muzzleFlash);
  muzzleLight = new THREE.PointLight(0xffaa44, 0, 3, 2);
  muzzleLight.position.set(0.42, 0.06, 0);
  g.add(muzzleLight);

  g.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  g.userData.baseX = 0;
  return g;
}

function makeFlashTexture() {
  const c = document.createElement("canvas"); c.width = c.height = 128;
  const ctx = c.getContext("2d");
  const grd = ctx.createRadialGradient(64, 64, 2, 64, 64, 64);
  grd.addColorStop(0, "rgba(255,255,230,1)");
  grd.addColorStop(0.25, "rgba(255,200,90,0.9)");
  grd.addColorStop(0.6, "rgba(255,120,40,0.35)");
  grd.addColorStop(1, "rgba(255,80,0,0)");
  ctx.fillStyle = grd; ctx.fillRect(0, 0, 128, 128);
  // starburst spikes
  ctx.strokeStyle = "rgba(255,220,150,0.8)"; ctx.lineWidth = 4;
  for (let i = 0; i < 8; i++) {
    ctx.beginPath(); ctx.moveTo(64, 64);
    const a = (i / 8) * Math.PI * 2;
    ctx.lineTo(64 + Math.cos(a) * 60, 64 + Math.sin(a) * 60); ctx.stroke();
  }
  const t = new THREE.CanvasTexture(c); return t;
}

function makeSmokeTexture() {
  const c = document.createElement("canvas"); c.width = c.height = 64;
  const ctx = c.getContext("2d");
  const grd = ctx.createRadialGradient(32, 32, 2, 32, 32, 32);
  grd.addColorStop(0, "rgba(180,180,180,0.5)");
  grd.addColorStop(1, "rgba(120,120,120,0)");
  ctx.fillStyle = grd; ctx.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}
const SMOKE_TEX = null;

// ---------- build bar environment ----------
function buildBar() {
  const bar = new THREE.Group();

  // floor
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(30, 30),
    new THREE.MeshStandardMaterial({ color: 0x1a120c, roughness: 0.85, metalness: 0.1 })
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = 0;
  floor.receiveShadow = true;
  bar.add(floor);
  // floor plank lines
  const plankTex = makeWoodTexture();
  floor.material.map = plankTex; floor.material.needsUpdate = true;

  // back wall
  const wallMat = new THREE.MeshStandardMaterial({ color: 0x2a1c14, roughness: 0.9 });
  const backWall = new THREE.Mesh(new THREE.BoxGeometry(24, 8, 0.4), wallMat);
  backWall.position.set(0, 4, -6);
  backWall.receiveShadow = true;
  bar.add(backWall);
  // side walls
  const lWall = new THREE.Mesh(new THREE.BoxGeometry(0.4, 8, 24), wallMat);
  lWall.position.set(-10, 4, 0); bar.add(lWall);
  const rWall = lWall.clone(); rWall.position.x = 10; bar.add(rWall);

  // back bar counter (behind, with shelves + bottles)
  const counterMat = new THREE.MeshStandardMaterial({ color: 0x2e1a0f, roughness: 0.5, metalness: 0.2 });
  const backCounter = new THREE.Mesh(new THREE.BoxGeometry(14, 1.2, 0.8), counterMat);
  backCounter.position.set(0, 0.6, -5.2);
  backCounter.castShadow = backCounter.receiveShadow = true;
  bar.add(backCounter);

  // shelves with bottles
  const shelfMat = new THREE.MeshStandardMaterial({ color: 0x241009, roughness: 0.7 });
  for (let s = 0; s < 3; s++) {
    const shelf = new THREE.Mesh(new THREE.BoxGeometry(12, 0.08, 0.5), shelfMat);
    shelf.position.set(0, 2.2 + s * 1.1, -5.6);
    shelf.castShadow = shelf.receiveShadow = true;
    bar.add(shelf);
    for (let b = 0; b < 16; b++) {
      const bottle = makeBottle();
      bottle.position.set(-5.6 + b * 0.75 + (s % 2) * 0.2, 2.24 + s * 1.1 + 0.22, -5.6 + (Math.random() - 0.5) * 0.15);
      bar.add(bottle);
    }
  }
  // mirror-ish back panel behind shelves
  const mirror = new THREE.Mesh(new THREE.PlaneGeometry(12.5, 4), new THREE.MeshStandardMaterial({
    color: 0x0a0f14, roughness: 0.15, metalness: 0.85,
  }));
  mirror.position.set(0, 3.6, -5.79);
  bar.add(mirror);

  // neon sign "BAR 76"
  const neon = makeNeonSign();
  neon.position.set(0, 5.4, -5.7);
  bar.add(neon);

  // the round poker/game table (center) — where the gun sits
  const tableTop = new THREE.Mesh(new THREE.CylinderGeometry(1.15, 1.15, 0.12, 64),
    new THREE.MeshStandardMaterial({ color: 0x0d5c3f, roughness: 0.7, metalness: 0.05 }));
  tableTop.position.set(0, 0.94, 0);
  tableTop.castShadow = tableTop.receiveShadow = true;
  bar.add(tableTop);
  const rail = new THREE.Mesh(new THREE.TorusGeometry(1.15, 0.06, 16, 64),
    new THREE.MeshStandardMaterial({ color: 0x3a1f12, roughness: 0.4, metalness: 0.3 }));
  rail.rotation.x = Math.PI / 2; rail.position.set(0, 1.0, 0);
  bar.add(rail);
  const pedestal = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.3, 0.9, 24),
    new THREE.MeshStandardMaterial({ color: 0x201009, roughness: 0.6, metalness: 0.2 }));
  pedestal.position.set(0, 0.45, 0); pedestal.castShadow = true;
  bar.add(pedestal);
  const base = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.55, 0.06, 24),
    new THREE.MeshStandardMaterial({ color: 0x201009, roughness: 0.6 }));
  base.position.set(0, 0.03, 0); bar.add(base);

  // stools around table
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    const stool = makeStool();
    stool.position.set(Math.cos(a) * 1.9, 0, Math.sin(a) * 1.9);
    bar.add(stool);
  }

  // hanging lamp over table
  const lampCord = new THREE.Mesh(new THREE.CylinderGeometry(0.01, 0.01, 2.2, 8),
    new THREE.MeshStandardMaterial({ color: 0x111 }));
  lampCord.position.set(0, 3.9, 0); bar.add(lampCord);
  const lampShade = new THREE.Mesh(new THREE.ConeGeometry(0.45, 0.4, 24, 1, true),
    new THREE.MeshStandardMaterial({ color: 0x1a1a1a, side: THREE.DoubleSide, metalness: 0.6, roughness: 0.4 }));
  lampShade.position.set(0, 2.75, 0); bar.add(lampShade);
  const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.08, 16, 16),
    new THREE.MeshStandardMaterial({ color: 0xffddaa, emissive: 0xffaa33, emissiveIntensity: 2 }));
  bulb.position.set(0, 2.62, 0); bar.add(bulb);

  return bar;
}

function makeBottle() {
  const grp = new THREE.Group();
  const colors = [0x2e7d32, 0x795548, 0xb71c1c, 0x37474f, 0xf9a825, 0x4a148c];
  const col = colors[Math.floor(Math.random() * colors.length)];
  const mat = new THREE.MeshStandardMaterial({ color: col, roughness: 0.15, metalness: 0.1, transparent: true, opacity: 0.85 });
  const h = 0.34 + Math.random() * 0.12;
  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.06, h, 12), mat);
  body.position.y = h / 2; body.castShadow = true;
  grp.add(body);
  const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.03, 0.12, 8), mat);
  neck.position.y = h + 0.05; grp.add(neck);
  return grp;
}

function makeStool() {
  const grp = new THREE.Group();
  const woodMat = new THREE.MeshStandardMaterial({ color: 0x2a1810, roughness: 0.6 });
  const seat = new THREE.Mesh(new THREE.CylinderGeometry(0.26, 0.26, 0.08, 20),
    new THREE.MeshStandardMaterial({ color: 0x5a1f1a, roughness: 0.5 }));
  seat.position.y = 0.75; seat.castShadow = true; grp.add(seat);
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
    const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.022, 0.75, 8), woodMat);
    leg.position.set(Math.cos(a) * 0.2, 0.375, Math.sin(a) * 0.2);
    grp.add(leg);
  }
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.2, 0.014, 8, 20), woodMat);
  ring.rotation.x = Math.PI / 2; ring.position.y = 0.3; grp.add(ring);
  return grp;
}

function makeNeonSign() {
  const grp = new THREE.Group();
  const canvas = document.createElement("canvas");
  canvas.width = 1024; canvas.height = 256;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "rgba(0,0,0,0)"; ctx.fillRect(0, 0, 1024, 256);
  ctx.font = "900 150px Cinzel, serif";
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.shadowColor = "#ff3b6b"; ctx.shadowBlur = 40;
  ctx.fillStyle = "#ff6b8f"; ctx.fillText("BAR 76", 512, 130);
  ctx.shadowBlur = 20; ctx.fillStyle = "#fff"; ctx.fillText("BAR 76", 512, 130);
  const tex = new THREE.CanvasTexture(canvas);
  const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });
  const plane = new THREE.Mesh(new THREE.PlaneGeometry(4, 1), mat);
  grp.add(plane);
  const glow = new THREE.PointLight(0xff3b6b, 6, 8, 2);
  glow.position.set(0, 0, 1); grp.add(glow);
  return grp;
}

function makeWoodTexture() {
  const c = document.createElement("canvas"); c.width = c.height = 512;
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#1a120c"; ctx.fillRect(0, 0, 512, 512);
  for (let i = 0; i < 512; i += 32) {
    ctx.fillStyle = i % 64 === 0 ? "#20150d" : "#160f09";
    ctx.fillRect(0, i, 512, 30);
    ctx.strokeStyle = "rgba(0,0,0,0.4)"; ctx.beginPath();
    ctx.moveTo(0, i + 31); ctx.lineTo(512, i + 31); ctx.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(8, 8);
  return t;
}

// ---------- init ----------
function init(canvas) {
  if (inited) return;
  inited = true;
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x080604);
  scene.fog = new THREE.FogExp2(0x080604, 0.045);

  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

  camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
  camera.position.set(0, 1.9, 2.7);

  controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, 1.05, 0);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.minDistance = 1.4;
  controls.maxDistance = 6;
  controls.maxPolarAngle = Math.PI / 2.05;
  controls.minPolarAngle = 0.3;
  controls.autoRotate = false;

  // lighting
  scene.add(new THREE.AmbientLight(0x3a2a1a, 0.4));
  const key = new THREE.SpotLight(0xffb066, 60, 12, 0.7, 0.5, 1.4);
  key.position.set(0, 4.2, 0.3);
  key.target.position.set(0, 1, 0);
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  key.shadow.bias = -0.0004;
  scene.add(key); scene.add(key.target);
  const fill = new THREE.PointLight(0x28e0d0, 8, 12, 2);
  fill.position.set(-4, 2.5, 3); scene.add(fill);
  const rim = new THREE.PointLight(0xff3b6b, 8, 12, 2);
  rim.position.set(4, 2.5, -2); scene.add(rim);

  scene.add(buildBar());
  revolver = buildRevolver();
  revolver.position.set(0, 1.02, 0);
  revolver.rotation.y = -0.5;
  scene.add(revolver);

  clock = new THREE.Clock();
  window.addEventListener("resize", onResize);
  onResize();
  animate();
}

function onResize() {
  if (!renderer) return;
  const el = renderer.domElement;
  const w = el.clientWidth || window.innerWidth;
  const h = el.clientHeight || window.innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}

function animate() {
  requestAnimationFrame(animate);
  if (!running) return;
  const dt = Math.min(clock.getDelta(), 0.05);
  updateTweens(dt);
  idleT += dt;

  // gentle idle float of the revolver
  if (tweens.length === 0) {
    revolver.position.y = 1.02 + Math.sin(idleT * 1.2) * 0.006;
  }

  // muzzle flash flicker
  if (muzzleFlash.material.opacity > 0.02) {
    muzzleFlash.material.rotation = Math.random() * Math.PI;
  }

  // smoke
  for (let i = smokeParticles.length - 1; i >= 0; i--) {
    const p = smokeParticles[i];
    p.life -= dt;
    p.mesh.position.x += p.vx * dt;
    p.mesh.position.y += p.vy * dt;
    p.mesh.material.opacity = Math.max(0, p.life / p.max) * 0.5;
    p.mesh.scale.multiplyScalar(1 + dt * 0.8);
    if (p.life <= 0) { revolver.remove(p.mesh); smokeParticles.splice(i, 1); }
  }

  // screen shake
  if (shake > 0) {
    shake = Math.max(0, shake - dt * 4);
    camera.position.x += (Math.random() - 0.5) * shake * 0.08;
    camera.position.y += (Math.random() - 0.5) * shake * 0.08;
  }

  controls.update();
  renderer.render(scene, camera);
}

// ---------- FX API ----------
function fxSpin() {
  const turns = 6 + Math.floor(Math.random() * 4);
  const target = cylinderGroup.rotation.x + Math.PI * 2 * turns + Math.random() * Math.PI;
  tween(cylinderGroup, { "rotation.x": target }, 1.8, easeOut);
}

function cockAndDrop(onFall) {
  // cock back
  tween(hammer, { "rotation.z": -1.0 }, 0.28, easeOut, () => {
    // fall
    tween(hammer, { "rotation.z": 0 }, 0.07, easeIn, onFall);
  });
}

function fxClick() {
  cockAndDrop(() => {
    // advance cylinder one notch
    tween(cylinderGroup, { "rotation.x": cylinderGroup.rotation.x + Math.PI / 3 }, 0.15, easeOut);
  });
}

function fxBang() {
  cockAndDrop(() => {
    shake = 1.0;
    // muzzle flash
    muzzleFlash.material.opacity = 1;
    muzzleFlash.scale.set(0.5, 0.5, 0.5);
    muzzleLight.intensity = 12;
    tween(muzzleFlash.material, { opacity: 0 }, 0.18, easeOut);
    tween(muzzleFlash.scale, { x: 0.9, y: 0.9, z: 0.9 }, 0.18, easeOut);
    tween(muzzleLight, { intensity: 0 }, 0.22, easeOut);
    // recoil: gun kicks back and up
    const baseRot = revolver.rotation.z;
    tween(revolver, { "position.x": -0.12, "rotation.z": baseRot + 0.5 }, 0.09, easeOut, () => {
      tween(revolver, { "position.x": 0, "rotation.z": baseRot }, 0.5, easeOut);
    });
    spawnSmoke();
  });
}

function spawnSmoke() {
  if (!SMOKE_TEX_CACHE) SMOKE_TEX_CACHE = makeSmokeTexture();
  for (let i = 0; i < 6; i++) {
    const m = new THREE.Sprite(new THREE.SpriteMaterial({
      map: SMOKE_TEX_CACHE, transparent: true, opacity: 0.5, depthWrite: false,
    }));
    m.position.set(0.4 + Math.random() * 0.1, 0.045 + Math.random() * 0.03, (Math.random() - 0.5) * 0.05);
    m.scale.set(0.08, 0.08, 0.08);
    revolver.add(m);
    smokeParticles.push({ mesh: m, vx: 0.15 + Math.random() * 0.1, vy: 0.08 + Math.random() * 0.06, life: 1.2, max: 1.2 });
  }
}
let SMOKE_TEX_CACHE = null;

function fxWin() {
  controls.autoRotate = true;
  controls.autoRotateSpeed = 1.5;
  setTimeout(() => { controls.autoRotate = false; }, 6000);
}

function onFx(fx) {
  if (!running) return;
  if (fx.type === "spin") fxSpin();
  else if (fx.type === "click") fxClick();
  else if (fx.type === "bang") fxBang();
  else if (fx.type === "win") fxWin();
}

function show() {
  running = true;
  if (clock) clock.getDelta();
  onResize();
}
function hide() { running = false; if (controls) controls.autoRotate = false; }

window.RL = { init, onFx, show, hide };
