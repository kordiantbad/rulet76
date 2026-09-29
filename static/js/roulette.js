/* Russian Roulette — 3D bar, seated characters, a held & aimed revolver.
   Dark speakeasy lighting + bloom/vignette shaders (Three.js). */
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { ShaderPass } from "three/addons/postprocessing/ShaderPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";

let renderer, scene, camera, controls, composer, clock;
let revolver, cylinderGroup, hammer, muzzleFlash, muzzleLight;
let dust, activeRing, beamCone, bulbLight;
let running = false, inited = false;
let idleT = 0, shake = 0;
let smokeParticles = [];

const CENTER = new THREE.Vector3(0, 1.0, 0);
const SEAT_R = 1.95;
const HEAD_Y = 1.58;
const GUNMETAL = 0x23262c;
const WOOD = 0x4a2c18;
const PALETTE = [0xc0392b, 0x2980b9, 0x27ae60, 0x8e44ad, 0xd35400, 0x16a085, 0xc2185b, 0x7f8c8d];

const chars = new Map();   // sid -> character record
let curState = null, localSid = null, orderKey = "";

// ---------- gun transform driver ----------
const gun = {
  mode: "rest",            // rest | hold | spin
  pos: new THREE.Vector3(0.15, 1.03, 0.1),
  quat: new THREE.Quaternion(),
  busy: false,
  spin: null,
};
const Q_ROLL = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2);
const REST_POS = new THREE.Vector3(0.12, 1.03, 0.08);

// ---------- easing ----------
const easeOut = (t) => 1 - Math.pow(1 - t, 3);
const easeIn = (t) => t * t * t;
const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

// tiny tween list for discrete part animations (hammer / recoil / flash)
let tweens = [];
function tween(obj, to, dur, ease, onDone) {
  const from = {};
  for (const k in to) from[k] = path(obj, k);
  tweens.push({ obj, from, to, dur, t: 0, ease: ease || easeOut, onDone });
}
function path(o, p) { return p.split(".").reduce((a, k) => a[k], o); }
function setp(o, p, v) { const ks = p.split("."); const l = ks.pop(); ks.reduce((a, k) => a[k], o)[l] = v; }
function updateTweens(dt) {
  for (let i = tweens.length - 1; i >= 0; i--) {
    const tw = tweens[i]; tw.t += dt;
    const e = tw.ease(Math.min(tw.t / tw.dur, 1));
    for (const k in tw.to) setp(tw.obj, k, tw.from[k] + (tw.to[k] - tw.from[k]) * e);
    if (tw.t >= tw.dur) { tweens.splice(i, 1); if (tw.onDone) tw.onDone(); }
  }
}

function metal(color, rough = 0.32, metalness = 0.95) {
  return new THREE.MeshStandardMaterial({ color, roughness: rough, metalness });
}

// =========================================================================
//  REVOLVER
// =========================================================================
function buildRevolver() {
  const g = new THREE.Group();
  const steel = metal(GUNMETAL, 0.3, 0.95);
  const darkSteel = metal(0x15171b, 0.5, 0.9);
  const wood = new THREE.MeshStandardMaterial({ color: WOOD, roughness: 0.55, metalness: 0.05 });

  const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.028, 0.028, 0.30, 32), steel);
  barrel.rotation.z = Math.PI / 2; barrel.position.set(0.20, 0.045, 0); g.add(barrel);
  const rib = new THREE.Mesh(new THREE.BoxGeometry(0.30, 0.016, 0.026), steel);
  rib.position.set(0.20, 0.072, 0); g.add(rib);
  const lug = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.03, 0.03), steel);
  lug.position.set(0.20, 0.022, 0); g.add(lug);
  const ejrod = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, 0.24, 16), metal(0xb9bcc2, 0.25));
  ejrod.rotation.z = Math.PI / 2; ejrod.position.set(0.21, 0.022, 0); g.add(ejrod);
  const crown = new THREE.Mesh(new THREE.CylinderGeometry(0.031, 0.031, 0.02, 32), darkSteel);
  crown.rotation.z = Math.PI / 2; crown.position.set(0.352, 0.045, 0); g.add(crown);
  const bore = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.015, 0.03, 24), new THREE.MeshBasicMaterial({ color: 0x050505 }));
  bore.rotation.z = Math.PI / 2; bore.position.set(0.358, 0.045, 0); g.add(bore);
  const fsight = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.03, 0.008), darkSteel);
  fsight.position.set(0.335, 0.088, 0); g.add(fsight);
  const rsight = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.02, 0.03), darkSteel);
  rsight.position.set(0.055, 0.082, 0); g.add(rsight);

  const frame = new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.09, 0.045), steel);
  frame.position.set(0.02, 0.045, 0); g.add(frame);

  cylinderGroup = new THREE.Group();
  cylinderGroup.position.set(0.065, 0.045, 0);
  const cyl = new THREE.Mesh(new THREE.CylinderGeometry(0.046, 0.046, 0.072, 48), metal(0x2b2f36, 0.28, 0.95));
  cyl.rotation.z = Math.PI / 2; cylinderGroup.add(cyl);
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    const chamber = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, 0.076, 16),
      new THREE.MeshStandardMaterial({ color: 0x090909, roughness: 0.6, metalness: 0.4 }));
    chamber.rotation.z = Math.PI / 2; chamber.position.set(0, Math.sin(a) * 0.03, Math.cos(a) * 0.03);
    cylinderGroup.add(chamber);
    const flute = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.006, 0.012), darkSteel);
    const fa = a + Math.PI / 6;
    flute.position.set(0, Math.sin(fa) * 0.043, Math.cos(fa) * 0.043);
    flute.lookAt(new THREE.Vector3(0, Math.sin(fa) * 0.1, Math.cos(fa) * 0.1));
    cylinderGroup.add(flute);
  }
  const pin = new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.006, 0.08, 12), metal(0x9a9da3, 0.3));
  pin.rotation.z = Math.PI / 2; cylinderGroup.add(pin);
  g.add(cylinderGroup);

  const strap = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.014, 0.04), steel);
  strap.position.set(0.03, 0.088, 0); g.add(strap);

  hammer = new THREE.Group(); hammer.position.set(-0.028, 0.088, 0);
  const hbody = new THREE.Mesh(new THREE.BoxGeometry(0.018, 0.05, 0.02), darkSteel);
  hbody.position.set(0, 0.018, 0); hammer.add(hbody);
  const spur = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.014, 0.022), darkSteel);
  spur.position.set(-0.012, 0.045, 0); spur.rotation.z = 0.5; hammer.add(spur);
  g.add(hammer);

  const guard = new THREE.Mesh(new THREE.TorusGeometry(0.028, 0.006, 12, 24, Math.PI * 1.3), steel);
  guard.position.set(-0.02, 0.0, 0); guard.rotation.set(Math.PI / 2, 0, -0.4); g.add(guard);
  const trigger = new THREE.Mesh(new THREE.BoxGeometry(0.01, 0.03, 0.012), darkSteel);
  trigger.position.set(-0.02, 0.012, 0); trigger.rotation.z = 0.2; g.add(trigger);

  const grip = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.13, 0.05), wood);
  grip.position.set(-0.055, -0.04, 0); grip.rotation.z = -0.32; g.add(grip);
  const gripBack = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.13, 0.052), metal(0x1b1d22, 0.4, 0.9));
  gripBack.position.set(-0.083, -0.035, 0); gripBack.rotation.z = -0.32; g.add(gripBack);
  const med = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, 0.052, 16), metal(0xe0b64a, 0.3, 0.9));
  med.rotation.x = Math.PI / 2; med.position.set(-0.05, -0.045, 0); g.add(med);

  muzzleFlash = new THREE.Sprite(new THREE.SpriteMaterial({
    map: makeFlashTexture(), color: 0xffcc66, transparent: true, opacity: 0,
    blending: THREE.AdditiveBlending, depthWrite: false,
  }));
  muzzleFlash.scale.set(0.001, 0.001, 0.001); muzzleFlash.position.set(0.4, 0.045, 0); g.add(muzzleFlash);
  muzzleLight = new THREE.PointLight(0xffaa44, 0, 4, 2); muzzleLight.position.set(0.42, 0.06, 0); g.add(muzzleLight);

  g.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  return g;
}

function makeFlashTexture() {
  const c = document.createElement("canvas"); c.width = c.height = 128;
  const x = c.getContext("2d");
  const grd = x.createRadialGradient(64, 64, 2, 64, 64, 64);
  grd.addColorStop(0, "rgba(255,255,230,1)"); grd.addColorStop(0.25, "rgba(255,200,90,0.9)");
  grd.addColorStop(0.6, "rgba(255,120,40,0.35)"); grd.addColorStop(1, "rgba(255,80,0,0)");
  x.fillStyle = grd; x.fillRect(0, 0, 128, 128);
  x.strokeStyle = "rgba(255,220,150,0.8)"; x.lineWidth = 4;
  for (let i = 0; i < 8; i++) { x.beginPath(); x.moveTo(64, 64); const a = i / 8 * Math.PI * 2; x.lineTo(64 + Math.cos(a) * 60, 64 + Math.sin(a) * 60); x.stroke(); }
  return new THREE.CanvasTexture(c);
}
let SMOKE_TEX = null;
function makeSmokeTexture() {
  const c = document.createElement("canvas"); c.width = c.height = 64;
  const x = c.getContext("2d");
  const grd = x.createRadialGradient(32, 32, 2, 32, 32, 32);
  grd.addColorStop(0, "rgba(180,180,180,0.5)"); grd.addColorStop(1, "rgba(120,120,120,0)");
  x.fillStyle = grd; x.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

// =========================================================================
//  CHARACTERS
// =========================================================================
function makeCharacter(color, name) {
  const outer = new THREE.Group();
  const mats = [];
  const jacket = new THREE.MeshStandardMaterial({ color, roughness: 0.65, metalness: 0.08 }); mats.push(jacket);
  const shirt = new THREE.MeshStandardMaterial({ color: 0xece3d0, roughness: 0.7 }); mats.push(shirt);
  const skin = new THREE.MeshStandardMaterial({ color: 0xd9a066, roughness: 0.5 }); mats.push(skin);
  const dark = new THREE.MeshStandardMaterial({ color: 0x17130f, roughness: 0.6 }); mats.push(dark);

  // stool
  const stool = new THREE.Group();
  const seat = new THREE.Mesh(new THREE.CylinderGeometry(0.26, 0.26, 0.08, 20), new THREE.MeshStandardMaterial({ color: 0x5a1f1a, roughness: 0.5 }));
  seat.position.y = 0.75; stool.add(seat);
  for (let i = 0; i < 4; i++) {
    const a = i / 4 * Math.PI * 2 + Math.PI / 4;
    const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.022, 0.75, 8), new THREE.MeshStandardMaterial({ color: 0x2a1810, roughness: 0.6 }));
    leg.position.set(Math.cos(a) * 0.2, 0.375, Math.sin(a) * 0.2); stool.add(leg);
  }
  outer.add(stool);

  // toppling body (forward = +Z toward table)
  const body = new THREE.Group();
  const pelvis = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.18, 0.28), dark); pelvis.position.set(0, 0.86, 0.02); body.add(pelvis);
  const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.24, 0.34, 6, 14), jacket); torso.position.set(0, 1.16, 0); body.add(torso);
  const chest = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.3, 0.06), shirt); chest.position.set(0, 1.14, 0.2); chest.rotation.x = 0.1; body.add(chest);
  const collar = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.13, 0.08, 12), jacket); collar.position.set(0, 1.36, 0.03); body.add(collar);
  const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.07, 0.08, 10), skin); neck.position.set(0, 1.42, 0.02); body.add(neck);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.17, 24, 24), skin); head.position.set(0, 1.56, 0.02); head.scale.set(1, 1.15, 1.05); body.add(head);
  // eyes
  const eyeMat = new THREE.MeshStandardMaterial({ color: 0x111 });
  [-0.06, 0.06].forEach((ex) => { const e = new THREE.Mesh(new THREE.SphereGeometry(0.022, 10, 10), eyeMat); e.position.set(ex, 1.57, 0.17); body.add(e); });
  // fedora
  const brim = new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.24, 0.02, 24), dark); brim.position.set(0, 1.66, 0.02); body.add(brim);
  const crownH = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.17, 0.16, 20), dark); crownH.position.set(0, 1.74, 0.02); body.add(crownH);
  const bandM = new THREE.Mesh(new THREE.CylinderGeometry(0.153, 0.173, 0.03, 20), jacket); bandM.position.set(0, 1.69, 0.02); body.add(bandM);
  // arms
  [-1, 1].forEach((s) => {
    const sh = new THREE.Mesh(new THREE.SphereGeometry(0.1, 12, 12), jacket); sh.position.set(0.26 * s, 1.24, 0.02); body.add(sh);
    const up = new THREE.Mesh(new THREE.CapsuleGeometry(0.075, 0.2, 4, 10), jacket); up.position.set(0.28 * s, 1.08, 0.08); up.rotation.x = 0.5; body.add(up);
    const fore = new THREE.Mesh(new THREE.CapsuleGeometry(0.06, 0.2, 4, 10), skin); fore.position.set(0.26 * s, 0.95, 0.3); fore.rotation.x = 1.2; body.add(fore);
  });
  // thighs forward + shins down (seated)
  [-1, 1].forEach((s) => {
    const thigh = new THREE.Mesh(new THREE.CapsuleGeometry(0.09, 0.24, 4, 10), dark); thigh.position.set(0.12 * s, 0.82, 0.24); thigh.rotation.x = Math.PI / 2; body.add(thigh);
    const shin = new THREE.Mesh(new THREE.CapsuleGeometry(0.08, 0.34, 4, 10), dark); shin.position.set(0.12 * s, 0.5, 0.42); body.add(shin);
    const shoe = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.08, 0.22), new THREE.MeshStandardMaterial({ color: 0x0a0806, roughness: 0.4 })); shoe.position.set(0.12 * s, 0.28, 0.5); body.add(shoe);
  });
  outer.add(body);

  const label = makeLabel(name);
  label.position.set(0, 2.15, 0.02);
  outer.add(label);

  outer.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  return { outer, body, mats, label, alive: true, toppled: 0 };
}

function makeLabel(name) {
  const c = document.createElement("canvas"); c.width = 256; c.height = 72;
  drawLabel(c, name, false);
  const tex = new THREE.CanvasTexture(c);
  const spr = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }));
  spr.scale.set(1.1, 0.31, 1);
  spr.userData.canvas = c; spr.userData.tex = tex; spr.userData.name = name;
  return spr;
}
function drawLabel(c, name, active) {
  const x = c.getContext("2d"); x.clearRect(0, 0, c.width, c.height);
  x.fillStyle = active ? "rgba(60,30,10,0.9)" : "rgba(10,8,6,0.75)";
  roundRect(x, 6, 6, c.width - 12, c.height - 12, 14); x.fill();
  x.lineWidth = 3; x.strokeStyle = active ? "#ffb347" : "rgba(233,196,106,0.35)"; x.stroke();
  x.font = "600 34px Oswald, sans-serif"; x.textAlign = "center"; x.textBaseline = "middle";
  x.fillStyle = active ? "#ffd88a" : "#e8dcc4";
  x.fillText(name.slice(0, 14), c.width / 2, c.height / 2 + 2);
}
function roundRect(x, a, b, w, h, r) {
  x.beginPath(); x.moveTo(a + r, b); x.arcTo(a + w, b, a + w, b + h, r);
  x.arcTo(a + w, b + h, a, b + h, r); x.arcTo(a, b + h, a, b, r); x.arcTo(a, b, a + w, b, r); x.closePath();
}

// =========================================================================
//  BAR ENVIRONMENT (dark)
// =========================================================================
function buildBar() {
  const bar = new THREE.Group();

  const floor = new THREE.Mesh(new THREE.PlaneGeometry(30, 30),
    new THREE.MeshStandardMaterial({ color: 0x120c08, roughness: 0.9, metalness: 0.15, map: makeWoodTexture() }));
  floor.rotation.x = -Math.PI / 2; floor.receiveShadow = true; bar.add(floor);

  const wallMat = new THREE.MeshStandardMaterial({ color: 0x1c120c, roughness: 0.95 });
  const back = new THREE.Mesh(new THREE.BoxGeometry(24, 8, 0.4), wallMat); back.position.set(0, 4, -6); back.receiveShadow = true; bar.add(back);
  const lWall = new THREE.Mesh(new THREE.BoxGeometry(0.4, 8, 24), wallMat); lWall.position.set(-10, 4, 0); bar.add(lWall);
  const rWall = lWall.clone(); rWall.position.x = 10; bar.add(rWall);
  const ceil = new THREE.Mesh(new THREE.BoxGeometry(24, 0.4, 24), new THREE.MeshStandardMaterial({ color: 0x0a0705, roughness: 1 }));
  ceil.position.set(0, 6.2, 0); bar.add(ceil);

  // back bar counter + shelves + bottles
  const backCounter = new THREE.Mesh(new THREE.BoxGeometry(14, 1.2, 0.8), new THREE.MeshStandardMaterial({ color: 0x241209, roughness: 0.5, metalness: 0.25 }));
  backCounter.position.set(0, 0.6, -5.2); backCounter.castShadow = backCounter.receiveShadow = true; bar.add(backCounter);
  const shelfMat = new THREE.MeshStandardMaterial({ color: 0x1c0c06, roughness: 0.7 });
  for (let s = 0; s < 3; s++) {
    const shelf = new THREE.Mesh(new THREE.BoxGeometry(12, 0.08, 0.5), shelfMat);
    shelf.position.set(0, 2.2 + s * 1.1, -5.6); shelf.castShadow = shelf.receiveShadow = true; bar.add(shelf);
    // small light strip glow under each shelf
    const strip = new THREE.Mesh(new THREE.BoxGeometry(11.5, 0.03, 0.05), new THREE.MeshStandardMaterial({ color: 0x3a1e0c, emissive: 0xff7b2e, emissiveIntensity: 1.2 }));
    strip.position.set(0, 2.16 + s * 1.1, -5.35); bar.add(strip);
    for (let b = 0; b < 16; b++) {
      const bottle = makeBottle();
      bottle.position.set(-5.6 + b * 0.75 + (s % 2) * 0.2, 2.24 + s * 1.1 + 0.22, -5.6 + (Math.random() - 0.5) * 0.15);
      bar.add(bottle);
    }
  }
  const mirror = new THREE.Mesh(new THREE.PlaneGeometry(12.5, 4), new THREE.MeshStandardMaterial({ color: 0x080c10, roughness: 0.12, metalness: 0.9 }));
  mirror.position.set(0, 3.6, -5.79); bar.add(mirror);

  const neon = makeNeonSign(); neon.position.set(0, 5.3, -5.7); bar.add(neon);
  // side neon accents
  const barTop = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.06, 10), new THREE.MeshStandardMaterial({ color: 0x081a1a, emissive: 0x28e0d0, emissiveIntensity: 2 }));
  barTop.position.set(-9.6, 1.6, 0); bar.add(barTop);
  const barTop2 = barTop.clone(); barTop2.position.x = 9.6; barTop2.material = barTop.material.clone(); barTop2.material.emissive = new THREE.Color(0xff3b6b); bar.add(barTop2);

  // the round game table — deep, near-black felt
  const felt = new THREE.Mesh(new THREE.CylinderGeometry(1.15, 1.15, 0.12, 64), new THREE.MeshStandardMaterial({ color: 0x04140d, roughness: 0.95, metalness: 0.02 }));
  felt.position.set(0, 0.94, 0); felt.castShadow = felt.receiveShadow = true; bar.add(felt);
  const rail = new THREE.Mesh(new THREE.TorusGeometry(1.15, 0.06, 16, 64), new THREE.MeshStandardMaterial({ color: 0x241009, roughness: 0.5, metalness: 0.3 }));
  rail.rotation.x = Math.PI / 2; rail.position.set(0, 1.0, 0); bar.add(rail);
  const ped = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.3, 0.9, 24), new THREE.MeshStandardMaterial({ color: 0x180b05, roughness: 0.6, metalness: 0.2 }));
  ped.position.set(0, 0.45, 0); ped.castShadow = true; bar.add(ped);
  const base = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.55, 0.06, 24), new THREE.MeshStandardMaterial({ color: 0x180b05, roughness: 0.6 }));
  base.position.set(0, 0.03, 0); bar.add(base);

  return bar;
}

function makeBottle() {
  const grp = new THREE.Group();
  const colors = [0x2e7d32, 0x795548, 0xb71c1c, 0x37474f, 0xf9a825, 0x4a148c];
  const col = colors[Math.floor(Math.random() * colors.length)];
  const mat = new THREE.MeshStandardMaterial({ color: col, roughness: 0.12, metalness: 0.1, transparent: true, opacity: 0.85 });
  const h = 0.34 + Math.random() * 0.12;
  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.06, h, 12), mat); body.position.y = h / 2; body.castShadow = true; grp.add(body);
  const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.03, 0.12, 8), mat); neck.position.y = h + 0.05; grp.add(neck);
  return grp;
}

function makeNeonSign() {
  const grp = new THREE.Group();
  const c = document.createElement("canvas"); c.width = 1024; c.height = 256;
  const x = c.getContext("2d");
  x.font = "900 150px Cinzel, serif"; x.textAlign = "center"; x.textBaseline = "middle";
  x.shadowColor = "#ff3b6b"; x.shadowBlur = 40; x.fillStyle = "#ff6b8f"; x.fillText("BAR 76", 512, 130);
  x.shadowBlur = 20; x.fillStyle = "#fff"; x.fillText("BAR 76", 512, 130);
  const tex = new THREE.CanvasTexture(c);
  const plane = new THREE.Mesh(new THREE.PlaneGeometry(4, 1), new THREE.MeshBasicMaterial({ map: tex, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
  grp.add(plane);
  const glow = new THREE.PointLight(0xff3b6b, 4, 8, 2); glow.position.set(0, 0, 1); grp.add(glow);
  return grp;
}

function makeWoodTexture() {
  const c = document.createElement("canvas"); c.width = c.height = 512;
  const x = c.getContext("2d");
  x.fillStyle = "#120c08"; x.fillRect(0, 0, 512, 512);
  for (let i = 0; i < 512; i += 32) {
    x.fillStyle = i % 64 === 0 ? "#170f09" : "#0f0a06"; x.fillRect(0, i, 512, 30);
    x.strokeStyle = "rgba(0,0,0,0.5)"; x.beginPath(); x.moveTo(0, i + 31); x.lineTo(512, i + 31); x.stroke();
  }
  const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(8, 8); return t;
}

// ceiling lamp with a visible warm beam onto the table
function buildCeilingLight() {
  const grp = new THREE.Group();
  const cord = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 2.4, 8), new THREE.MeshStandardMaterial({ color: 0x0a0a0a }));
  cord.position.set(0, 4.9, 0); grp.add(cord);
  const shade = new THREE.Mesh(new THREE.ConeGeometry(0.5, 0.5, 28, 1, true),
    new THREE.MeshStandardMaterial({ color: 0x141414, side: THREE.DoubleSide, metalness: 0.7, roughness: 0.35 }));
  shade.position.set(0, 3.55, 0); grp.add(shade);
  const inner = new THREE.Mesh(new THREE.ConeGeometry(0.47, 0.47, 28, 1, true),
    new THREE.MeshStandardMaterial({ color: 0xffcf8a, emissive: 0xffa94d, emissiveIntensity: 1.4, side: THREE.BackSide }));
  inner.position.set(0, 3.55, 0); grp.add(inner);
  const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.1, 16, 16), new THREE.MeshStandardMaterial({ color: 0xfff0d0, emissive: 0xffb14d, emissiveIntensity: 3 }));
  bulb.position.set(0, 3.4, 0); grp.add(bulb);

  // volumetric-ish beam cone (apex at bulb, base on table)
  beamCone = new THREE.Mesh(new THREE.ConeGeometry(1.25, 2.35, 40, 1, true),
    new THREE.MeshBasicMaterial({ color: 0xffb968, transparent: true, opacity: 0.08, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false }));
  beamCone.position.set(0, 2.22, 0); grp.add(beamCone);

  bulbLight = new THREE.PointLight(0xffb14d, 6, 6, 2); bulbLight.position.set(0, 3.35, 0); grp.add(bulbLight);
  return grp;
}

// floating dust motes inside the light beam
function buildDust() {
  const N = 220, pos = new Float32Array(N * 3);
  for (let i = 0; i < N; i++) {
    const r = Math.random() * 1.1, a = Math.random() * Math.PI * 2;
    pos[i * 3] = Math.cos(a) * r; pos[i * 3 + 1] = 1.0 + Math.random() * 2.2; pos[i * 3 + 2] = Math.sin(a) * r;
  }
  const geo = new THREE.BufferGeometry(); geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  const mat = new THREE.PointsMaterial({ color: 0xffcf9a, size: 0.02, transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending, depthWrite: false });
  return new THREE.Points(geo, mat);
}

// =========================================================================
//  INIT
// =========================================================================
function init(canvas) {
  if (inited) return; inited = true;
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 0.92;

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x050403);
  scene.fog = new THREE.FogExp2(0x050403, 0.07);

  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.02).texture;

  camera = new THREE.PerspectiveCamera(46, 1, 0.1, 100);
  camera.position.set(0, 2.0, 3.0);

  controls = new OrbitControls(camera, canvas);
  controls.target.copy(CENTER);
  controls.enableDamping = true; controls.dampingFactor = 0.08;
  controls.minDistance = 1.6; controls.maxDistance = 6.5;
  controls.maxPolarAngle = Math.PI / 2.02; controls.minPolarAngle = 0.25;

  scene.add(new THREE.AmbientLight(0x201811, 0.28));
  const key = new THREE.SpotLight(0xffb066, 75, 14, 0.62, 0.55, 1.3);
  key.position.set(0, 3.35, 0); key.target.position.copy(CENTER);
  key.castShadow = true; key.shadow.mapSize.set(2048, 2048); key.shadow.bias = -0.0004;
  scene.add(key, key.target);
  const fill = new THREE.PointLight(0x28e0d0, 5, 12, 2); fill.position.set(-5, 2.3, 3); scene.add(fill);
  const rim = new THREE.PointLight(0xff3b6b, 5, 12, 2); rim.position.set(5, 2.3, -2); scene.add(rim);

  scene.add(buildBar());
  scene.add(buildCeilingLight());
  dust = buildDust(); scene.add(dust);

  activeRing = new THREE.Mesh(new THREE.TorusGeometry(0.42, 0.03, 14, 40),
    new THREE.MeshStandardMaterial({ color: 0xffb347, emissive: 0xffa030, emissiveIntensity: 2.2 }));
  activeRing.rotation.x = Math.PI / 2; activeRing.visible = false; scene.add(activeRing);

  revolver = buildRevolver(); scene.add(revolver);
  gun.quat.copy(new THREE.Quaternion().multiplyQuaternions(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), 0.6), Q_ROLL));
  gun.pos.copy(REST_POS);
  revolver.position.copy(gun.pos); revolver.quaternion.copy(gun.quat);

  // post-processing: bloom + vignette shader
  composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.7, 0.75, 0.85);
  composer.addPass(bloom);
  composer.addPass(new ShaderPass(VignetteShader));
  composer.addPass(new OutputPass());

  clock = new THREE.Clock();
  window.addEventListener("resize", onResize);
  onResize();
  animate();
}

const VignetteShader = {
  uniforms: { tDiffuse: { value: null }, offset: { value: 1.15 }, darkness: { value: 1.25 } },
  vertexShader: `varying vec2 vUv; void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);} `,
  fragmentShader: `
    uniform sampler2D tDiffuse; uniform float offset; uniform float darkness; varying vec2 vUv;
    void main(){
      vec4 tex = texture2D(tDiffuse, vUv);
      vec2 uv = (vUv - 0.5) * offset;
      float v = clamp(1.0 - dot(uv, uv) * darkness, 0.0, 1.0);
      // warm crush in shadows
      tex.rgb *= mix(0.55, 1.0, v);
      tex.rgb = pow(tex.rgb, vec3(0.98));
      gl_FragColor = tex;
    }`,
};

function onResize() {
  if (!renderer) return;
  const el = renderer.domElement;
  const w = el.clientWidth || window.innerWidth, h = el.clientHeight || window.innerHeight;
  renderer.setSize(w, h, false); composer.setSize(w, h);
  camera.aspect = w / h; camera.updateProjectionMatrix();
}

// =========================================================================
//  STATE  -> scene
// =========================================================================
function rebuildCharacters(order, localS) {
  for (const rec of chars.values()) scene.remove(rec.outer);
  chars.clear();
  let list = order.map((o) => o.sid);
  const li = list.indexOf(localS);
  let ordered = order.slice();
  if (li > 0) ordered = order.slice(li).concat(order.slice(0, li));
  const N = ordered.length;
  ordered.forEach((o, i) => {
    const angle = Math.PI / 2 + (i / N) * Math.PI * 2;
    const seatPos = new THREE.Vector3(Math.cos(angle) * SEAT_R, 0, Math.sin(angle) * SEAT_R);
    const color = PALETTE[order.findIndex((x) => x.sid === o.sid) % PALETTE.length];
    const rec = makeCharacter(color, o.name + (o.sid === localS ? " (you)" : ""));
    rec.outer.position.copy(seatPos);
    rec.outer.rotation.y = Math.atan2(-seatPos.x, -seatPos.z);
    rec.seatPos = seatPos;
    rec.headPos = new THREE.Vector3(seatPos.x * (SEAT_R - 0.15) / SEAT_R, HEAD_Y, seatPos.z * (SEAT_R - 0.15) / SEAT_R);
    rec.angle = angle;
    scene.add(rec.outer);
    chars.set(o.sid, rec);
  });
}

function setState(st, localS) {
  curState = st; localSid = localS;
  if (!inited) return;
  const key = st.order.map((o) => o.sid).join(",") + "|" + localS;
  if (key !== orderKey) { orderKey = key; rebuildCharacters(st.order, localS); }

  // alive visuals
  st.order.forEach((o) => {
    const rec = chars.get(o.sid); if (!rec) return;
    if (!o.alive && rec.alive) killVisual(rec);
    // refresh label active state
    const active = st.turn === o.sid && st.state === "playing";
    if (rec.labelActive !== active) {
      rec.labelActive = active;
      drawLabel(rec.label.userData.canvas, rec.label.userData.name, active);
      rec.label.userData.tex.needsUpdate = true;
    }
  });

  // active ring
  const holder = st.state === "playing" ? chars.get(st.turn) : null;
  if (holder) { activeRing.visible = true; activeRing.position.set(holder.seatPos.x, 0.06, holder.seatPos.z); }
  else activeRing.visible = false;

  // gun placement (unless a spin/handoff owns it)
  if (!gun.busy) {
    if (st.state === "playing" && st.turn) setHold(st.turn, st.aim);
    else setRest();
  }
}

function killVisual(rec) {
  rec.alive = false;
  rec.mats.forEach((m) => { m.color.multiplyScalar(0.35); m.color.lerp(new THREE.Color(0x555555), 0.5); });
  rec.toppleTarget = -1.25; // fall back off stool
}

// ---- gun transforms ----
function quatFromBarrel(dir) {
  const ex = dir.clone().normalize();
  let up = new THREE.Vector3(0, 1, 0);
  if (Math.abs(ex.dot(up)) > 0.94) up = new THREE.Vector3(0, 0, 1);
  const ez = new THREE.Vector3().crossVectors(ex, up).normalize();
  const ey = new THREE.Vector3().crossVectors(ez, ex).normalize();
  return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(ex, ey, ez));
}
function handPosFor(holderRec) {
  const inward = new THREE.Vector3().subVectors(CENTER, holderRec.seatPos).setY(0).normalize();
  return holderRec.seatPos.clone().addScaledVector(inward, 0.6).setY(1.26);
}
function setHold(holderSid, aimSid) {
  const h = chars.get(holderSid); if (!h) return;
  const handPos = handPosFor(h);
  let aimPoint;
  if (aimSid && aimSid !== holderSid && chars.get(aimSid)) aimPoint = chars.get(aimSid).headPos.clone();
  else if (aimSid === holderSid) aimPoint = h.headPos.clone();
  else aimPoint = CENTER.clone().setY(1.05); // neutral, resting toward table
  const dir = new THREE.Vector3().subVectors(aimPoint, handPos).normalize();
  gun.mode = "hold"; gun.pos.copy(handPos); gun.quat.copy(quatFromBarrel(dir));
}
function setRest() {
  gun.mode = "rest"; gun.pos.copy(REST_POS);
  const qYaw = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), 0.6);
  gun.quat.copy(qYaw.multiply(Q_ROLL.clone()));
}

// =========================================================================
//  FX
// =========================================================================
function onFx(fx) {
  if (!running || !inited) return;
  if (fx.type === "handoff") startHandoff(fx.from, fx.to);
  else if (fx.type === "bang") fireSequence(true, fx.shooter, fx.target);
  else if (fx.type === "click") fireSequence(false, fx.shooter, fx.target);
  else if (fx.type === "aim") { if (!gun.busy) setHold(fx.shooter, fx.target); }
  else if (fx.type === "win") fxWin();
}

function startHandoff(fromSid, toSid) {
  const t = chars.get(toSid); if (!t) { gun.busy = false; return; }
  const dir = new THREE.Vector3().subVectors(t.seatPos, CENTER).setY(0).normalize();
  const finalYaw = Math.atan2(-dir.z, dir.x);
  const startYaw = 0.6;
  const turns = 3 + Math.floor(Math.random() * 3);
  let target = finalYaw;
  while (target < startYaw + turns * Math.PI * 2) target += Math.PI * 2;
  gun.busy = true;
  gun.spin = { t: 0, dur: 2.1, startYaw, target, toSid };
}

function cockAndDrop(onFall) {
  tween(hammer, { "rotation.z": -1.0 }, 0.26, easeOut, () =>
    tween(hammer, { "rotation.z": 0 }, 0.07, easeIn, onFall));
}

function fireSequence(isBang, shooterSid, targetSid) {
  if (!gun.busy) setHold(shooterSid, targetSid);
  cockAndDrop(() => {
    if (isBang) {
      shake = 1.0;
      muzzleFlash.material.opacity = 1; muzzleFlash.scale.set(0.5, 0.5, 0.5);
      muzzleLight.intensity = 14;
      tween(muzzleFlash.material, { opacity: 0 }, 0.18, easeOut);
      tween(muzzleFlash.scale, { x: 0.9, y: 0.9, z: 0.9 }, 0.18, easeOut);
      tween(muzzleLight, { intensity: 0 }, 0.22, easeOut);
      // recoil kick along barrel (-x local approximated in world via quat)
      const back = new THREE.Vector3(-1, 0.35, 0).applyQuaternion(gun.quat).multiplyScalar(0.14);
      const p0 = gun.pos.clone();
      revolver.position.copy(p0).add(back);
      spawnSmoke();
    } else {
      tween(cylinderGroup, { "rotation.x": cylinderGroup.rotation.x + Math.PI / 3 }, 0.15, easeOut);
    }
  });
}

function spawnSmoke() {
  if (!SMOKE_TEX) SMOKE_TEX = makeSmokeTexture();
  const muzzleWorld = new THREE.Vector3(0.4, 0.045, 0).applyQuaternion(gun.quat).add(gun.pos);
  const drift = new THREE.Vector3(1, 0.6, 0).applyQuaternion(gun.quat).normalize();
  for (let i = 0; i < 7; i++) {
    const m = new THREE.Sprite(new THREE.SpriteMaterial({ map: SMOKE_TEX, transparent: true, opacity: 0.5, depthWrite: false }));
    m.position.copy(muzzleWorld).add(new THREE.Vector3((Math.random() - 0.5) * 0.08, (Math.random() - 0.5) * 0.08, (Math.random() - 0.5) * 0.08));
    m.scale.set(0.1, 0.1, 0.1); scene.add(m);
    smokeParticles.push({ mesh: m, vel: drift.clone().multiplyScalar(0.2 + Math.random() * 0.15).add(new THREE.Vector3(0, 0.1, 0)), life: 1.3, max: 1.3 });
  }
}

function fxWin() {
  controls.autoRotate = true; controls.autoRotateSpeed = 1.6;
  setTimeout(() => { controls.autoRotate = false; }, 6500);
}

// =========================================================================
//  LOOP
// =========================================================================
function animate() {
  requestAnimationFrame(animate);
  if (!running) return;
  const dt = Math.min(clock.getDelta(), 0.05);
  idleT += dt;
  updateTweens(dt);

  // gun handoff spin
  if (gun.spin) {
    const s = gun.spin; s.t += dt;
    const p = Math.min(s.t / s.dur, 1); const e = easeOut(p);
    const yaw = s.startYaw + (s.target - s.startYaw) * e;
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw).multiply(Q_ROLL.clone());
    revolver.quaternion.copy(q);
    revolver.position.lerp(REST_POS, Math.min(dt * 6, 1));
    if (p >= 1) {
      gun.spin = null; gun.busy = false;
      if (curState && curState.state === "playing" && curState.turn) setHold(curState.turn, curState.aim);
      else setRest();
    }
  } else {
    // ease toward target transform
    const k = Math.min(dt * 7, 1);
    revolver.position.lerp(gun.pos, k);
    revolver.quaternion.slerp(gun.quat, k);
    if (gun.mode === "rest") revolver.position.y = gun.pos.y + Math.sin(idleT * 1.2) * 0.004;
  }

  if (muzzleFlash.material.opacity > 0.02) muzzleFlash.material.rotation = Math.random() * Math.PI;

  // topple dead characters
  for (const rec of chars.values()) {
    if (rec.toppleTarget !== undefined) {
      rec.body.rotation.x += (rec.toppleTarget - rec.body.rotation.x) * Math.min(dt * 4, 1);
      rec.body.position.y += ((rec.alive ? 0 : -0.15) - rec.body.position.y) * Math.min(dt * 4, 1);
    }
  }

  // smoke
  for (let i = smokeParticles.length - 1; i >= 0; i--) {
    const p = smokeParticles[i]; p.life -= dt;
    p.mesh.position.addScaledVector(p.vel, dt);
    p.mesh.material.opacity = Math.max(0, p.life / p.max) * 0.5;
    p.mesh.scale.multiplyScalar(1 + dt * 0.9);
    if (p.life <= 0) { scene.remove(p.mesh); smokeParticles.splice(i, 1); }
  }

  // dust drift
  if (dust) {
    const arr = dust.geometry.attributes.position.array;
    for (let i = 1; i < arr.length; i += 3) {
      arr[i] += dt * 0.05;
      if (arr[i] > 3.2) arr[i] = 1.0;
    }
    dust.geometry.attributes.position.needsUpdate = true;
    dust.rotation.y += dt * 0.02;
  }

  // active ring pulse
  if (activeRing.visible) {
    const s = 1 + Math.sin(idleT * 4) * 0.06;
    activeRing.scale.set(s, s, s);
    activeRing.rotation.z += dt * 0.6;
  }
  if (beamCone) beamCone.material.opacity = 0.07 + Math.sin(idleT * 3) * 0.012;
  if (bulbLight) bulbLight.intensity = 6 + Math.sin(idleT * 9) * 0.25;

  // screen shake
  if (shake > 0) {
    shake = Math.max(0, shake - dt * 4);
    camera.position.x += (Math.random() - 0.5) * shake * 0.06;
    camera.position.y += (Math.random() - 0.5) * shake * 0.06;
  }

  controls.update();
  composer.render();
}

function show() { running = true; if (clock) clock.getDelta(); onResize(); }
function hide() { running = false; if (controls) controls.autoRotate = false; }

window.RL = { init, setState, onFx, show, hide };
