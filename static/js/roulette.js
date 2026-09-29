/* Russian Roulette — FIRST PERSON. Click the table to lock the mouse and look
   around with your head (65° left/right, 80° up / 75° down). The held revolver
   swings onto the nearest rival to where you look; click to fire, press S for
   yourself. Everyone's head-look + aim is broadcast so the stick-figure
   opponents turn and point in real time. Dark speakeasy bar. */
import * as THREE from "three";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { ShaderPass } from "three/addons/postprocessing/ShaderPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";

let renderer, scene, camera, composer, clock, canvasEl;
let revolver, cylinderGroup, hammer, muzzleFlash, muzzleLight, gunRig, tablePointer;
let dust, beamCone, bulbLight, targetReticle, shooterRing;
let running = false, inited = false;
let idleT = 0, shake = 0;
let smokeParticles = [];

const CENTER = new THREE.Vector3(0, 1.0, 0);
const CAM_POS = new THREE.Vector3(0, 1.52, 2.5);
const CAM_LOOK = new THREE.Vector3(0, 1.12, -0.2);
const GUN_REST = new THREE.Vector3(0.26, -0.28, -0.62);
const GUNMETAL = 0x23262c, WOOD = 0x4a2c18;
const PALETTE = [0xe5484d, 0x4cc2ff, 0x3fb950, 0xbf7af0, 0xf2a53c, 0x2dd4bf, 0xf778ba, 0xa0a0a0];

const players = new Map();  // sid -> record
let curState = null, localSid = null, orderKey = "";
let currentTarget = null, myTurn = false;

// ---- first-person head look ----
const UP = new THREE.Vector3(0, 1, 0);
const BASE_FWD = CAM_LOOK.clone().sub(CAM_POS).normalize();
const YAW_LIMIT = 65 * Math.PI / 180;   // look 65° left/right
const PITCH_UP = 80 * Math.PI / 180;    // look 80° up
const PITCH_DOWN = 75 * Math.PI / 180;  // look 75° down
const LOOK_SENS = 0.0024;
let yaw = 0, pitch = 0, sYaw = 0, sPitch = 0;   // raw + smoothed head angles
let pointerLocked = false;
let lastLookSent = 0, lastSentYaw = 0, lastSentPitch = 0, lastSentTarget = "?";
const camLookTarget = new THREE.Vector3();

// ---- easing / tween ----
const easeOut = (t) => 1 - Math.pow(1 - t, 3);
const easeIn = (t) => t * t * t;
let tweens = [];
function tween(obj, to, dur, ease, onDone) {
  const from = {}; for (const k in to) from[k] = path(obj, k);
  tweens.push({ obj, from, to, dur, t: 0, ease: ease || easeOut, onDone });
}
const path = (o, p) => p.split(".").reduce((a, k) => a[k], o);
const setp = (o, p, v) => { const ks = p.split("."); const l = ks.pop(); ks.reduce((a, k) => a[k], o)[l] = v; };
function updateTweens(dt) {
  for (let i = tweens.length - 1; i >= 0; i--) {
    const tw = tweens[i]; tw.t += dt;
    const e = tw.ease(Math.min(tw.t / tw.dur, 1));
    for (const k in tw.to) setp(tw.obj, k, tw.from[k] + (tw.to[k] - tw.from[k]) * e);
    if (tw.t >= tw.dur) { tweens.splice(i, 1); if (tw.onDone) tw.onDone(); }
  }
}
const metal = (c, r = 0.32, m = 0.95) => new THREE.MeshStandardMaterial({ color: c, roughness: r, metalness: m });

// =========================================================================
//  REVOLVER (barrel along +X)
// =========================================================================
function buildRevolver() {
  const g = new THREE.Group();
  const steel = metal(GUNMETAL, 0.3, 0.95), darkSteel = metal(0x15171b, 0.5, 0.9);
  const wood = new THREE.MeshStandardMaterial({ color: WOOD, roughness: 0.55, metalness: 0.05 });
  const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.028, 0.028, 0.30, 32), steel);
  barrel.rotation.z = Math.PI / 2; barrel.position.set(0.20, 0.045, 0); g.add(barrel);
  const rib = new THREE.Mesh(new THREE.BoxGeometry(0.30, 0.016, 0.026), steel); rib.position.set(0.20, 0.072, 0); g.add(rib);
  const lug = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.03, 0.03), steel); lug.position.set(0.20, 0.022, 0); g.add(lug);
  const crown = new THREE.Mesh(new THREE.CylinderGeometry(0.031, 0.031, 0.02, 32), darkSteel);
  crown.rotation.z = Math.PI / 2; crown.position.set(0.352, 0.045, 0); g.add(crown);
  const bore = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.015, 0.03, 24), new THREE.MeshBasicMaterial({ color: 0x050505 }));
  bore.rotation.z = Math.PI / 2; bore.position.set(0.358, 0.045, 0); g.add(bore);
  const fsight = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.03, 0.008), darkSteel); fsight.position.set(0.335, 0.088, 0); g.add(fsight);
  const frame = new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.09, 0.045), steel); frame.position.set(0.02, 0.045, 0); g.add(frame);
  cylinderGroup = new THREE.Group(); cylinderGroup.position.set(0.065, 0.045, 0);
  const cyl = new THREE.Mesh(new THREE.CylinderGeometry(0.046, 0.046, 0.072, 48), metal(0x2b2f36, 0.28, 0.95)); cyl.rotation.z = Math.PI / 2; cylinderGroup.add(cyl);
  for (let i = 0; i < 6; i++) {
    const a = i / 6 * Math.PI * 2;
    const ch = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, 0.076, 14), new THREE.MeshStandardMaterial({ color: 0x090909, roughness: 0.6, metalness: 0.4 }));
    ch.rotation.z = Math.PI / 2; ch.position.set(0, Math.sin(a) * 0.03, Math.cos(a) * 0.03); cylinderGroup.add(ch);
  }
  g.add(cylinderGroup);
  const strap = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.014, 0.04), steel); strap.position.set(0.03, 0.088, 0); g.add(strap);
  hammer = new THREE.Group(); hammer.position.set(-0.028, 0.088, 0);
  const hbody = new THREE.Mesh(new THREE.BoxGeometry(0.018, 0.05, 0.02), darkSteel); hbody.position.set(0, 0.018, 0); hammer.add(hbody);
  const spur = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.014, 0.022), darkSteel); spur.position.set(-0.012, 0.045, 0); spur.rotation.z = 0.5; hammer.add(spur); g.add(hammer);
  const guard = new THREE.Mesh(new THREE.TorusGeometry(0.028, 0.006, 12, 20, Math.PI * 1.3), steel); guard.position.set(-0.02, 0, 0); guard.rotation.set(Math.PI / 2, 0, -0.4); g.add(guard);
  const trigger = new THREE.Mesh(new THREE.BoxGeometry(0.01, 0.03, 0.012), darkSteel); trigger.position.set(-0.02, 0.012, 0); trigger.rotation.z = 0.2; g.add(trigger);
  const grip = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.13, 0.05), wood); grip.position.set(-0.055, -0.04, 0); grip.rotation.z = -0.32; g.add(grip);
  const gripBack = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.13, 0.052), metal(0x1b1d22, 0.4, 0.9)); gripBack.position.set(-0.083, -0.035, 0); gripBack.rotation.z = -0.32; g.add(gripBack);
  const med = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, 0.052, 12), metal(0xe0b64a, 0.3, 0.9)); med.rotation.x = Math.PI / 2; med.position.set(-0.05, -0.045, 0); g.add(med);

  // first-person hand + forearm gripping
  const skin = new THREE.MeshStandardMaterial({ color: 0xd9a066, roughness: 0.55 });
  const hand = new THREE.Mesh(new THREE.SphereGeometry(0.05, 14, 14), skin); hand.scale.set(1, 0.8, 1.1); hand.position.set(-0.05, -0.05, 0); g.add(hand);
  const forearm = new THREE.Mesh(new THREE.CapsuleGeometry(0.045, 0.28, 5, 12), skin); forearm.position.set(-0.12, -0.2, 0.06); forearm.rotation.set(0.5, 0, 0.5); g.add(forearm);
  const cuff = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.055, 0.06, 12), new THREE.MeshStandardMaterial({ color: 0x16181d, roughness: 0.8 })); cuff.position.set(-0.16, -0.26, 0.09); cuff.rotation.set(0.5, 0, 0.5); g.add(cuff);

  muzzleFlash = new THREE.Sprite(new THREE.SpriteMaterial({ map: makeFlashTexture(), color: 0xffcc66, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }));
  muzzleFlash.scale.set(0.001, 0.001, 0.001); muzzleFlash.position.set(0.4, 0.045, 0); g.add(muzzleFlash);
  muzzleLight = new THREE.PointLight(0xffaa44, 0, 5, 2); muzzleLight.position.set(0.42, 0.06, 0); g.add(muzzleLight);
  g.traverse((o) => { if (o.isMesh) o.castShadow = false; });
  return g;
}
function makeFlashTexture() {
  const c = document.createElement("canvas"); c.width = c.height = 128; const x = c.getContext("2d");
  const grd = x.createRadialGradient(64, 64, 2, 64, 64, 64);
  grd.addColorStop(0, "rgba(255,255,230,1)"); grd.addColorStop(0.25, "rgba(255,200,90,0.9)"); grd.addColorStop(0.6, "rgba(255,120,40,0.35)"); grd.addColorStop(1, "rgba(255,80,0,0)");
  x.fillStyle = grd; x.fillRect(0, 0, 128, 128);
  x.strokeStyle = "rgba(255,220,150,0.8)"; x.lineWidth = 4;
  for (let i = 0; i < 8; i++) { x.beginPath(); x.moveTo(64, 64); const a = i / 8 * Math.PI * 2; x.lineTo(64 + Math.cos(a) * 60, 64 + Math.sin(a) * 60); x.stroke(); }
  return new THREE.CanvasTexture(c);
}
let SMOKE_TEX = null;
function makeSmokeTexture() {
  const c = document.createElement("canvas"); c.width = c.height = 64; const x = c.getContext("2d");
  const g = x.createRadialGradient(32, 32, 2, 32, 32, 32); g.addColorStop(0, "rgba(190,190,190,0.5)"); g.addColorStop(1, "rgba(120,120,120,0)");
  x.fillStyle = g; x.fillRect(0, 0, 64, 64); return new THREE.CanvasTexture(c);
}

// =========================================================================
//  STICK FIGURE opponents (hand-drawn doodle sprites)
// =========================================================================
function drawStick(ctx, W, H, opts) {
  const pose = opts.pose | 0, color = opts.color, dead = !!opts.dead;
  const aimDeg = (typeof opts.aimDeg === "number") ? opts.aimDeg : null;
  const headTurn = Math.max(-1, Math.min(1, opts.headTurn || 0));
  const holdGun = !!opts.holdGun;
  ctx.clearRect(0, 0, W, H);
  ctx.lineCap = "round"; ctx.lineJoin = "round";
  const cx = W / 2;
  const stroke = dead ? "#8a8f96" : "#f1ece2";
  ctx.strokeStyle = stroke; ctx.fillStyle = "rgba(0,0,0,0)";
  ctx.lineWidth = 9;
  const L = (x1, y1, x2, y2) => { ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke(); };

  if (dead) {
    // slumped on the ground, X eyes
    const gy = H - 60;
    ctx.save();
    L(cx - 90, gy, cx + 70, gy - 8);                    // torso lying
    ctx.beginPath(); ctx.arc(cx + 92, gy - 14, 26, 0, Math.PI * 2); ctx.stroke(); // head
    L(cx - 90, gy, cx - 120, gy + 30); L(cx - 90, gy, cx - 110, gy - 26); // legs sprawled
    L(cx - 10, gy - 4, cx - 30, gy + 34); L(cx - 10, gy - 4, cx + 6, gy + 36); // arms
    ctx.lineWidth = 5; ctx.strokeStyle = "#e5484d";
    const ex = cx + 92, ey = gy - 16;
    L(ex - 12, ey - 8, ex - 2, ey + 2); L(ex - 2, ey - 8, ex - 12, ey + 2);
    L(ex + 4, ey - 8, ex + 14, ey + 2); L(ex + 14, ey - 8, ex + 4, ey + 2);
    ctx.restore();
    return;
  }

  const headR = 26, headY = 74;
  const hx = cx + headTurn * 9;   // head shifts slightly toward gaze
  ctx.beginPath(); ctx.arc(hx, headY, headR, 0, Math.PI * 2); ctx.stroke();
  // colored hat band accent
  ctx.save(); ctx.strokeStyle = color; ctx.lineWidth = 8;
  ctx.beginPath(); ctx.arc(hx, headY, headR, Math.PI * 1.05, Math.PI * 1.95); ctx.stroke(); ctx.restore();
  // eyes look toward gaze direction
  ctx.save(); ctx.fillStyle = stroke;
  const eo = headTurn * 6;
  ctx.beginPath(); ctx.arc(hx - 8 + eo, headY - 3, 3, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.arc(hx + 8 + eo, headY - 3, 3, 0, Math.PI * 2); ctx.fill(); ctx.restore();
  // smile
  ctx.lineWidth = 4; ctx.beginPath(); ctx.arc(hx, headY + 6, 11, 0.15 * Math.PI, 0.85 * Math.PI); ctx.stroke();
  ctx.lineWidth = 9;
  const neck = headY + headR, hip = H - 150;
  L(cx, neck, cx, hip); // spine
  const sh = neck + 14;

  if (aimDeg !== null) {
    // aiming: outstretched arm toward the target, planted stance
    const ax = Math.cos(aimDeg), ay = Math.sin(aimDeg);
    const armLen = 82;
    const gx = cx + ax * armLen, gy = sh + ay * armLen;
    L(cx, sh, gx, gy);                                   // gun arm
    L(cx, sh, cx - ax * 30, sh + Math.abs(ay) * 6 + 42); // support arm at side
    L(cx, hip, cx - 32, H - 50); L(cx, hip, cx + 34, H - 52); // legs
    if (holdGun) {
      ctx.save(); ctx.strokeStyle = "#1b1d22"; ctx.lineWidth = 9;
      const bx = gx + ax * 20, by = gy + ay * 20;
      ctx.beginPath(); ctx.moveTo(gx, gy); ctx.lineTo(bx, by); ctx.stroke();   // barrel
      ctx.lineWidth = 7; ctx.beginPath(); ctx.moveTo(gx, gy); ctx.lineTo(gx - ay * 12, gy + ax * 12); ctx.stroke(); // grip
      ctx.restore();
    }
    return;
  }

  // idle pose variants for arms/legs
  const P = pose % 6;
  if (P === 0) { L(cx, sh, cx - 60, sh + 34); L(cx, sh, cx + 60, sh + 34); L(cx, hip, cx - 40, H - 50); L(cx, hip, cx + 40, H - 50); }
  else if (P === 1) { L(cx, sh, cx - 58, sh - 46); L(cx, sh, cx + 58, sh - 46); L(cx, hip, cx - 30, H - 50); L(cx, hip, cx + 46, H - 60); } // arms up
  else if (P === 2) { L(cx, sh, cx - 50, sh + 8); L(cx - 50, sh + 8, cx - 40, sh + 50); L(cx, sh, cx + 60, sh + 30); L(cx, hip, cx - 48, H - 52); L(cx, hip, cx + 34, H - 46); } // hand on hip
  else if (P === 3) { L(cx, sh, cx - 66, sh - 20); L(cx, sh, cx + 40, sh + 50); L(cx, hip, cx - 52, H - 60); L(cx, hip, cx + 30, H - 44); } // waving
  else if (P === 4) { L(cx, sh, cx - 44, sh + 40); L(cx - 44, sh + 40, cx - 6, sh + 30); L(cx, sh, cx + 44, sh + 40); L(cx + 44, sh + 40, cx + 6, sh + 30); L(cx, hip, cx - 36, H - 50); L(cx, hip, cx + 36, H - 50); } // arms crossed
  else { L(cx, sh, cx - 62, sh + 10); L(cx, sh, cx + 62, sh + 10); L(cx, hip, cx - 20, H - 60); L(cx - 20, H - 60, cx - 30, H - 46); L(cx, hip, cx + 46, H - 54); } // leaning
}

function makeFigure(pose, color, name) {
  const rec = { pose, color, name, alive: true, lookYaw: 0, lookPitch: 0, aimTarget: null, drawKey: "" };
  const c = document.createElement("canvas"); c.width = 220; c.height = 360;
  drawStick(c.getContext("2d"), c.width, c.height, { pose, color, dead: false });
  const tex = new THREE.CanvasTexture(c);
  const spr = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }));
  spr.scale.set(1.35, 2.15, 1); spr.position.set(0, 1.07, 0);  // feet on the floor
  rec.canvas = c; rec.tex = tex; rec.body = spr;
  const outer = new THREE.Group(); outer.add(spr);
  const label = makeLabel(name); label.position.set(0, 2.2, 0); outer.add(label);
  rec.label = label; rec.outer = outer;
  return rec;
}
function redrawFigure(rec) {
  drawStick(rec.canvas.getContext("2d"), rec.canvas.width, rec.canvas.height,
    { pose: rec.pose, color: rec.color, dead: !rec.alive });
  rec.tex.needsUpdate = true;
  rec.body.material.opacity = rec.alive ? 1 : 0.6;
}
function makeLabel(name) {
  const c = document.createElement("canvas"); c.width = 256; c.height = 64; drawLabel(c, name, false);
  const tex = new THREE.CanvasTexture(c);
  const spr = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }));
  spr.scale.set(0.95, 0.24, 1); spr.userData = { canvas: c, tex, name }; return spr;
}
function drawLabel(c, name, active) {
  const x = c.getContext("2d"); x.clearRect(0, 0, c.width, c.height);
  x.fillStyle = active ? "rgba(229,72,77,0.16)" : "rgba(14,14,16,0.6)";
  rr(x, 6, 8, c.width - 12, c.height - 16, 10); x.fill();
  x.lineWidth = 2; x.strokeStyle = active ? "#e5484d" : "rgba(255,255,255,0.14)"; x.stroke();
  x.font = "600 30px Oswald, sans-serif"; x.textAlign = "center"; x.textBaseline = "middle";
  x.fillStyle = active ? "#ff8f92" : "#c9c4ba"; x.fillText(name.slice(0, 16), c.width / 2, c.height / 2 + 1);
}
function rr(x, a, b, w, h, r) { x.beginPath(); x.moveTo(a + r, b); x.arcTo(a + w, b, a + w, b + h, r); x.arcTo(a + w, b + h, a, b + h, r); x.arcTo(a, b + h, a, b, r); x.arcTo(a, b, a + w, b, r); x.closePath(); }

// =========================================================================
//  BAR (dark)
// =========================================================================
function buildBar() {
  const bar = new THREE.Group();
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(30, 30), new THREE.MeshStandardMaterial({ color: 0x0f0a07, roughness: 0.92, metalness: 0.12, map: makeWoodTexture() }));
  floor.rotation.x = -Math.PI / 2; floor.receiveShadow = true; bar.add(floor);
  const wallMat = new THREE.MeshStandardMaterial({ color: 0x17100b, roughness: 0.97 });
  const back = new THREE.Mesh(new THREE.BoxGeometry(24, 8, 0.4), wallMat); back.position.set(0, 4, -6); back.receiveShadow = true; bar.add(back);
  const lWall = new THREE.Mesh(new THREE.BoxGeometry(0.4, 8, 24), wallMat); lWall.position.set(-10, 4, 0); bar.add(lWall);
  const rWall = lWall.clone(); rWall.position.x = 10; bar.add(rWall);
  const ceil = new THREE.Mesh(new THREE.BoxGeometry(24, 0.4, 24), new THREE.MeshStandardMaterial({ color: 0x080604, roughness: 1 })); ceil.position.set(0, 6.2, 0); bar.add(ceil);

  const bc = new THREE.Mesh(new THREE.BoxGeometry(14, 1.2, 0.8), new THREE.MeshStandardMaterial({ color: 0x1e0f08, roughness: 0.5, metalness: 0.25 }));
  bc.position.set(0, 0.6, -5.2); bc.castShadow = bc.receiveShadow = true; bar.add(bc);
  const shelfMat = new THREE.MeshStandardMaterial({ color: 0x160a05, roughness: 0.7 });
  for (let s = 0; s < 3; s++) {
    const shelf = new THREE.Mesh(new THREE.BoxGeometry(12, 0.08, 0.5), shelfMat); shelf.position.set(0, 2.2 + s * 1.1, -5.6); bar.add(shelf);
    const strip = new THREE.Mesh(new THREE.BoxGeometry(11.5, 0.03, 0.05), new THREE.MeshStandardMaterial({ color: 0x2a1508, emissive: 0xff7b2e, emissiveIntensity: 1.0 })); strip.position.set(0, 2.16 + s * 1.1, -5.35); bar.add(strip);
    for (let b = 0; b < 16; b++) { const bo = makeBottle(); bo.position.set(-5.6 + b * 0.75 + (s % 2) * 0.2, 2.24 + s * 1.1 + 0.22, -5.6 + (Math.random() - 0.5) * 0.15); bar.add(bo); }
  }
  const mirror = new THREE.Mesh(new THREE.PlaneGeometry(12.5, 4), new THREE.MeshStandardMaterial({ color: 0x070a0d, roughness: 0.12, metalness: 0.9 })); mirror.position.set(0, 3.6, -5.79); bar.add(mirror);
  const neon = makeNeonSign(); neon.position.set(0, 5.3, -5.7); bar.add(neon);

  const felt = new THREE.Mesh(new THREE.CylinderGeometry(1.15, 1.15, 0.12, 64), new THREE.MeshStandardMaterial({ color: 0x04140d, roughness: 0.96, metalness: 0.02 }));
  felt.position.set(0, 0.94, 0); felt.receiveShadow = true; bar.add(felt);
  const rail = new THREE.Mesh(new THREE.TorusGeometry(1.15, 0.06, 16, 64), new THREE.MeshStandardMaterial({ color: 0x1f0d07, roughness: 0.5, metalness: 0.3 })); rail.rotation.x = Math.PI / 2; rail.position.set(0, 1.0, 0); bar.add(rail);
  const ped = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.3, 0.9, 20), new THREE.MeshStandardMaterial({ color: 0x140a05, roughness: 0.6 })); ped.position.set(0, 0.45, 0); bar.add(ped);

  // circular rug under the table
  const rug = new THREE.Mesh(new THREE.CircleGeometry(2.7, 48), new THREE.MeshStandardMaterial({ color: 0x2a0f0c, roughness: 0.95 }));
  rug.rotation.x = -Math.PI / 2; rug.position.y = 0.011; bar.add(rug);
  const rugRing = new THREE.Mesh(new THREE.RingGeometry(2.4, 2.55, 48), new THREE.MeshStandardMaterial({ color: 0x5a2318, roughness: 0.9, side: THREE.DoubleSide }));
  rugRing.rotation.x = -Math.PI / 2; rugRing.position.y = 0.012; bar.add(rugRing);

  // bar stools along the counter
  for (let i = 0; i < 5; i++) {
    const st = new THREE.Group();
    const seat = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.22, 0.08, 16), new THREE.MeshStandardMaterial({ color: 0x3a1410, roughness: 0.6 })); seat.position.y = 0.9; st.add(seat);
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.9, 10), metal(0x22252b, 0.4)); pole.position.y = 0.45; st.add(pole);
    const base = new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.24, 0.03, 16), metal(0x22252b, 0.4)); base.position.y = 0.02; st.add(base);
    st.position.set(-4 + i * 2, 0, -4.2); bar.add(st);
  }

  // hanging Edison bulbs over the bar counter
  for (let i = 0; i < 5; i++) {
    const x = -4.4 + i * 2.2;
    const cord = new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.006, 1.4, 6), new THREE.MeshStandardMaterial({ color: 0x0a0a0a })); cord.position.set(x, 5.1, -4.6); bar.add(cord);
    const b2 = new THREE.Mesh(new THREE.SphereGeometry(0.07, 12, 12), new THREE.MeshStandardMaterial({ color: 0xffce7a, emissive: 0xffa23a, emissiveIntensity: 2.4 })); b2.position.set(x, 4.4, -4.6); bar.add(b2);
    const pl = new THREE.PointLight(0xffa23a, 1.4, 5, 2); pl.position.set(x, 4.3, -4.4); bar.add(pl);
  }

  // wall sconces + framed art on the side walls
  const frameMat = new THREE.MeshStandardMaterial({ color: 0x2a1c10, roughness: 0.6, metalness: 0.3 });
  const artMat = new THREE.MeshStandardMaterial({ color: 0x1a1410, roughness: 0.9, emissive: 0x3a1e10, emissiveIntensity: 0.2 });
  [-1, 1].forEach((sgn) => {
    for (let k = 0; k < 2; k++) {
      const z = -2 + k * 3.4;
      const fr = new THREE.Mesh(new THREE.BoxGeometry(0.1, 1.5, 1.1), frameMat); fr.position.set(sgn * 9.7, 3.4, z); bar.add(fr);
      const art = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 1.3), artMat); art.rotation.y = -sgn * Math.PI / 2; art.position.set(sgn * 9.63, 3.4, z); bar.add(art);
      const sc = new THREE.PointLight(0xffb060, 1.1, 5, 2); sc.position.set(sgn * 9, 4.4, z); bar.add(sc);
      const scb = new THREE.Mesh(new THREE.SphereGeometry(0.06, 10, 10), new THREE.MeshStandardMaterial({ color: 0xffdca0, emissive: 0xffb14d, emissiveIntensity: 2 })); scb.position.set(sgn * 9.6, 4.4, z); bar.add(scb);
    }
  });

  // faint warm pool of light on the floor around the table
  const pool = new THREE.Mesh(new THREE.CircleGeometry(2.2, 40), new THREE.MeshBasicMaterial({ color: 0xffb968, transparent: true, opacity: 0.05, blending: THREE.AdditiveBlending, depthWrite: false }));
  pool.rotation.x = -Math.PI / 2; pool.position.y = 0.02; bar.add(pool);

  return bar;
}
function makeBottle() {
  const grp = new THREE.Group(); const cols = [0x2e7d32, 0x795548, 0xb71c1c, 0x37474f, 0xf9a825, 0x4a148c];
  const mat = new THREE.MeshStandardMaterial({ color: cols[Math.floor(Math.random() * cols.length)], roughness: 0.12, metalness: 0.1, transparent: true, opacity: 0.85 });
  const h = 0.34 + Math.random() * 0.12; const body = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.06, h, 10), mat); body.position.y = h / 2; grp.add(body);
  const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.03, 0.12, 8), mat); neck.position.y = h + 0.05; grp.add(neck); return grp;
}
function makeNeonSign() {
  const grp = new THREE.Group(); const c = document.createElement("canvas"); c.width = 1024; c.height = 256; const x = c.getContext("2d");
  x.font = "900 150px Cinzel, serif"; x.textAlign = "center"; x.textBaseline = "middle";
  x.shadowColor = "#e5484d"; x.shadowBlur = 40; x.fillStyle = "#ff6b8f"; x.fillText("BAR 76", 512, 130);
  x.shadowBlur = 18; x.fillStyle = "#fff"; x.fillText("BAR 76", 512, 130);
  const tex = new THREE.CanvasTexture(c);
  grp.add(new THREE.Mesh(new THREE.PlaneGeometry(4, 1), new THREE.MeshBasicMaterial({ map: tex, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false })));
  const glow = new THREE.PointLight(0xe5484d, 3, 8, 2); glow.position.set(0, 0, 1); grp.add(glow); return grp;
}
function makeWoodTexture() {
  const c = document.createElement("canvas"); c.width = c.height = 512; const x = c.getContext("2d"); x.fillStyle = "#0f0a06"; x.fillRect(0, 0, 512, 512);
  for (let i = 0; i < 512; i += 32) { x.fillStyle = i % 64 === 0 ? "#140d08" : "#0c0805"; x.fillRect(0, i, 512, 30); x.strokeStyle = "rgba(0,0,0,0.5)"; x.beginPath(); x.moveTo(0, i + 31); x.lineTo(512, i + 31); x.stroke(); }
  const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(8, 8); return t;
}
function buildCeilingLight() {
  const grp = new THREE.Group();
  grp.add(mesh(new THREE.CylinderGeometry(0.012, 0.012, 2.4, 8), { color: 0x0a0a0a }, 0, 4.9, 0));
  const shade = new THREE.Mesh(new THREE.ConeGeometry(0.5, 0.5, 24, 1, true), new THREE.MeshStandardMaterial({ color: 0x121212, side: THREE.DoubleSide, metalness: 0.7, roughness: 0.35 })); shade.position.set(0, 3.55, 0); grp.add(shade);
  const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.1, 16, 16), new THREE.MeshStandardMaterial({ color: 0xfff0d0, emissive: 0xffb14d, emissiveIntensity: 3 })); bulb.position.set(0, 3.4, 0); grp.add(bulb);
  beamCone = new THREE.Mesh(new THREE.ConeGeometry(1.25, 2.35, 40, 1, true), new THREE.MeshBasicMaterial({ color: 0xffb968, transparent: true, opacity: 0.07, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false })); beamCone.position.set(0, 2.22, 0); grp.add(beamCone);
  bulbLight = new THREE.PointLight(0xffb14d, 6, 6, 2); bulbLight.position.set(0, 3.35, 0); grp.add(bulbLight); return grp;
}
function mesh(geo, matOpts, x, y, z) { const m = new THREE.Mesh(geo, new THREE.MeshStandardMaterial(matOpts)); m.position.set(x, y, z); return m; }
function buildDust() {
  const N = 200, pos = new Float32Array(N * 3);
  for (let i = 0; i < N; i++) { const r = Math.random() * 1.1, a = Math.random() * Math.PI * 2; pos[i * 3] = Math.cos(a) * r; pos[i * 3 + 1] = 1 + Math.random() * 2.2; pos[i * 3 + 2] = Math.sin(a) * r; }
  const geo = new THREE.BufferGeometry(); geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  return new THREE.Points(geo, new THREE.PointsMaterial({ color: 0xffcf9a, size: 0.02, transparent: true, opacity: 0.45, blending: THREE.AdditiveBlending, depthWrite: false }));
}
function buildTablePointer() {
  // flat revolver silhouette that lies on the felt and spins about Y (no clipping)
  const g = new THREE.Group();
  const steel = metal(0x2a2d33, 0.4), dark = metal(0x1b1d22, 0.5);
  const frame = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.028, 0.06), steel); frame.position.set(0.02, 0, 0); g.add(frame);
  const bar = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.015, 0.26, 16), steel); bar.rotation.z = Math.PI / 2; bar.position.set(0.2, 0.004, 0); g.add(bar);
  const cyl = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.05, 20), metal(0x33373f, 0.32)); cyl.position.set(0.03, 0.004, 0); g.add(cyl);
  const grip = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.026, 0.05), new THREE.MeshStandardMaterial({ color: WOOD, roughness: 0.6 })); grip.position.set(-0.1, -0.001, 0.035); g.add(grip);
  const sight = new THREE.Mesh(new THREE.BoxGeometry(0.01, 0.018, 0.01), dark); sight.position.set(0.32, 0.012, 0); g.add(sight);
  g.position.set(0, 1.035, 0); g.visible = false; return g;  // rests just on top of the felt (top y=1.0)
}

// =========================================================================
//  INIT
// =========================================================================
function init(canvas) {
  if (inited) return; inited = true; canvasEl = canvas;
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 0.92;

  scene = new THREE.Scene(); scene.background = new THREE.Color(0x050403); scene.fog = new THREE.FogExp2(0x050403, 0.07);
  const pmrem = new THREE.PMREMGenerator(renderer); scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.02).texture;

  camera = new THREE.PerspectiveCamera(58, 1, 0.05, 100);
  camera.position.copy(CAM_POS); camera.lookAt(CAM_LOOK); scene.add(camera);

  scene.add(new THREE.AmbientLight(0x201811, 0.3));
  const key = new THREE.SpotLight(0xffb066, 80, 14, 0.62, 0.55, 1.3); key.position.set(0, 3.35, 0); key.target.position.copy(CENTER); key.castShadow = true; key.shadow.mapSize.set(1024, 1024); key.shadow.bias = -0.0004; scene.add(key, key.target);
  const fill = new THREE.PointLight(0x4cc2ff, 3, 12, 2); fill.position.set(-5, 2.3, 2); scene.add(fill);
  const rim = new THREE.PointLight(0xe5484d, 4, 12, 2); rim.position.set(5, 2.3, -2); scene.add(rim);

  scene.add(buildBar()); scene.add(buildCeilingLight());
  dust = buildDust(); scene.add(dust);
  tablePointer = buildTablePointer(); scene.add(tablePointer);

  // gun rig attached to camera (first-person view model)
  revolver = buildRevolver();
  gunRig = new THREE.Group(); gunRig.add(revolver); gunRig.position.copy(GUN_REST); gunRig.visible = false;
  camera.add(gunRig);
  restGunQuat();

  // target reticle (red brackets) — billboard
  targetReticle = new THREE.Sprite(new THREE.SpriteMaterial({ map: makeReticleTexture(), color: 0xffffff, transparent: true, depthTest: false, opacity: 0 }));
  targetReticle.scale.set(0.7, 0.7, 1); scene.add(targetReticle);
  // shooter highlight ring for observing others
  shooterRing = new THREE.Mesh(new THREE.TorusGeometry(0.4, 0.03, 12, 32), new THREE.MeshStandardMaterial({ color: 0xffb347, emissive: 0xffa030, emissiveIntensity: 2 }));
  shooterRing.rotation.x = Math.PI / 2; shooterRing.visible = false; scene.add(shooterRing);

  composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  composer.addPass(new UnrealBloomPass(new THREE.Vector2(1, 1), 0.65, 0.8, 0.85));
  composer.addPass(new ShaderPass(VignetteShader));
  composer.addPass(new OutputPass());

  clock = new THREE.Clock();
  window.addEventListener("resize", onResize);
  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("contextmenu", (e) => e.preventDefault());
  document.addEventListener("mousemove", onLockedMove);
  document.addEventListener("pointerlockchange", onLockChange);
  document.addEventListener("keydown", onKeyDown);
  onResize(); animate();
}

const VignetteShader = {
  uniforms: { tDiffuse: { value: null }, offset: { value: 1.1 }, darkness: { value: 1.3 } },
  vertexShader: `varying vec2 vUv; void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);} `,
  fragmentShader: `uniform sampler2D tDiffuse; uniform float offset; uniform float darkness; varying vec2 vUv;
    void main(){ vec4 t=texture2D(tDiffuse,vUv); vec2 uv=(vUv-0.5)*offset; float v=clamp(1.0-dot(uv,uv)*darkness,0.0,1.0); t.rgb*=mix(0.5,1.0,v); gl_FragColor=t; }`,
};
function makeReticleTexture() {
  const c = document.createElement("canvas"); c.width = c.height = 128; const x = c.getContext("2d");
  x.strokeStyle = "#e5484d"; x.lineWidth = 8; x.lineCap = "round"; const s = 18, e = 46, m = 64;
  // four corner brackets
  const corner = (dx, dy) => { x.beginPath(); x.moveTo(m + dx * e, m + dy * s); x.lineTo(m + dx * e, m + dy * e); x.lineTo(m + dx * s, m + dy * e); x.stroke(); };
  corner(-1, -1); corner(1, -1); corner(-1, 1); corner(1, 1);
  return new THREE.CanvasTexture(c);
}

function onResize() {
  if (!renderer) return; const el = renderer.domElement;
  const w = el.clientWidth || window.innerWidth, h = el.clientHeight || window.innerHeight;
  renderer.setSize(w, h, false); composer.setSize(w, h); camera.aspect = w / h; camera.updateProjectionMatrix();
}
function onPointerMove(e) {
  if (pointerLocked) return; // when locked, movement comes through onLockedMove
  const cross = document.getElementById("rl-crosshair");
  if (cross) { cross.style.left = e.clientX + "px"; cross.style.top = e.clientY + "px"; }
}
function onPointerDown() {
  if (!running) return;
  if (document.pointerLockElement !== canvasEl) { try { canvasEl.requestPointerLock(); } catch (_) {} return; }
  // locked: a click fires at whoever you're looking at (only on your turn)
  if (myTurn && currentTarget && window.socket) window.socket.emit("roulette_shoot", { target: currentTarget });
}
function onLockedMove(e) {
  if (!pointerLocked) return;
  yaw -= (e.movementX || 0) * LOOK_SENS;
  pitch -= (e.movementY || 0) * LOOK_SENS;
  yaw = Math.max(-YAW_LIMIT, Math.min(YAW_LIMIT, yaw));
  pitch = Math.max(-PITCH_DOWN, Math.min(PITCH_UP, pitch));
}
function onLockChange() {
  pointerLocked = document.pointerLockElement === canvasEl;
  document.body.classList.toggle("rl-locked", pointerLocked);
  const cross = document.getElementById("rl-crosshair");
  if (cross && pointerLocked) { cross.style.left = "50%"; cross.style.top = "50%"; }
}
function onKeyDown(e) {
  if (!pointerLocked || !running) return;
  if (e.key === "s" || e.key === "S") { e.preventDefault(); shootSelf(); }
}

// =========================================================================
//  STATE
// =========================================================================
function rebuild(order, localS) {
  for (const rec of players.values()) scene.remove(rec.outer);
  players.clear();
  const others = order.filter((o) => o.sid !== localS);
  const M = others.length;
  others.forEach((o, i) => {
    const frac = M <= 1 ? 0.5 : i / (M - 1);
    const ang = THREE.MathUtils.lerp(-1.15, 1.15, frac);
    const Rx = 2.2, Rz = 1.75;
    const pos = new THREE.Vector3(Math.sin(ang) * Rx, 0, -Math.cos(ang) * Rz);
    const gi = order.findIndex((x) => x.sid === o.sid);
    const rec = makeFigure(gi, PALETTE[gi % PALETTE.length], o.name);
    rec.outer.position.copy(pos);
    rec.pos = pos.clone(); rec.headPos = pos.clone().setY(1.62); rec.center = pos.clone().setY(1.15);
    scene.add(rec.outer); players.set(o.sid, rec);
  });
}

function setState(st, localS) {
  curState = st; localSid = localS; if (!inited) return;
  const key = st.order.map((o) => o.sid).join(",") + "|" + localS;
  if (key !== orderKey) { orderKey = key; rebuild(st.order, localS); }
  st.order.forEach((o) => {
    const rec = players.get(o.sid); if (!rec) return;
    if (!o.alive && rec.alive) { rec.alive = false; redrawFigure(rec); }
    const active = st.turn === o.sid && st.state === "playing";
    if (rec.labelActive !== active) { rec.labelActive = active; drawLabel(rec.label.userData.canvas, rec.label.userData.name, active); rec.label.userData.tex.needsUpdate = true; }
  });

  myTurn = st.state === "playing" && st.turn === localSid;
  gunRig.visible = myTurn && !gunBusy;

  // shooter ring for observed turns
  if (st.state === "playing" && st.turn && st.turn !== localSid && players.get(st.turn)) {
    const p = players.get(st.turn); shooterRing.visible = true; shooterRing.position.set(p.pos.x, 0.06, p.pos.z);
  } else shooterRing.visible = false;

  // reticle for observed aim
  if (!myTurn && st.state === "playing" && st.aim && players.get(st.aim)) {
    const p = players.get(st.aim); targetReticle.position.copy(p.headPos); targetReticle.material.opacity = 0.9; targetReticle.material.color.set(0xe5484d);
  } else if (!myTurn) { targetReticle.material.opacity = 0; }

  document.body.classList.toggle("rl-aiming", myTurn);
}

// ---- gun aiming ----
function quatFromBarrel(dir) {
  const ex = dir.clone().normalize(); let up = new THREE.Vector3(0, 1, 0);
  if (Math.abs(ex.dot(up)) > 0.94) up = new THREE.Vector3(0, 0, 1);
  const ez = new THREE.Vector3().crossVectors(ex, up).normalize();
  const ey = new THREE.Vector3().crossVectors(ez, ex).normalize();
  return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(ex, ey, ez));
}
let restQuat = new THREE.Quaternion();
function restGunQuat() { restQuat = quatFromBarrel(new THREE.Vector3(0.18, 0.05, -1)); gunRig.quaternion.copy(restQuat); }

// look direction from smoothed head angles (yaw around world up, pitch around local right)
function computeLook(y, p) {
  const dir = BASE_FWD.clone().applyAxisAngle(UP, y);
  const right = new THREE.Vector3().crossVectors(dir, UP).normalize();
  dir.applyAxisAngle(right, p);
  return dir.normalize();
}
// nearest alive rival to a world-space look direction
function pickTarget(lookDir) {
  let best = null, bestA = Infinity;
  for (const [sid, rec] of players) {
    if (!rec.alive) continue;
    const to = rec.headPos.clone().sub(camera.position).normalize();
    const a = lookDir.angleTo(to);
    if (a < bestA) { bestA = a; best = sid; }
  }
  return best;
}
// point the first-person revolver at the current target (camera-local)
function updateAimGun(dt) {
  if (!myTurn || gunBusy || firing) return;
  let goalQuat = restQuat;
  if (currentTarget && players.get(currentTarget)) {
    const tLocal = camera.worldToLocal(players.get(currentTarget).headPos.clone());
    const d = tLocal.sub(GUN_REST).normalize();
    goalQuat = quatFromBarrel(d);
    const rec = players.get(currentTarget);
    targetReticle.position.copy(rec.headPos); targetReticle.material.opacity = 0.95; targetReticle.material.color.set(0xe5484d);
  } else { targetReticle.material.opacity = 0; }
  gunRig.quaternion.slerp(goalQuat, Math.min(dt * 10, 1));
  gunRig.position.lerp(GUN_REST, Math.min(dt * 8, 1));
}
// choose target from where the head is looking, and broadcast look+target to others
function updateLook(now) {
  const look = computeLook(sYaw, sPitch);
  const tgt = pickTarget(look);
  if (tgt !== currentTarget) {
    currentTarget = tgt;
    if (myTurn && tgt && window.socket) window.socket.emit("roulette_aim", { target: tgt });
    if (window.RL_onTarget) window.RL_onTarget(tgt);
  }
  if (window.socket && running) {
    const moved = Math.abs(sYaw - lastSentYaw) > 0.02 || Math.abs(sPitch - lastSentPitch) > 0.02 || currentTarget !== lastSentTarget;
    if (moved && now - lastLookSent > 80) {
      lastLookSent = now; lastSentYaw = sYaw; lastSentPitch = sPitch; lastSentTarget = currentTarget;
      window.socket.emit("roulette_look", { yaw: sYaw, pitch: sPitch, target: currentTarget });
    }
  }
}
// redraw other players' figures so head + gun arm follow where THEY look/aim
function projNDC(v) { const p = v.clone().project(camera); return { x: p.x, y: p.y }; }
function updateFigures() {
  for (const [sid, rec] of players) {
    if (!rec.alive) continue;
    let aimDeg = null, headTurn = Math.max(-1, Math.min(1, rec.lookYaw / YAW_LIMIT));
    const tgt = rec.aimTarget && players.get(rec.aimTarget);
    if (tgt && tgt.alive) {
      const a = projNDC(rec.headPos), b = projNDC(tgt.headPos);
      aimDeg = Math.atan2(-(b.y - a.y), (b.x - a.x) * camera.aspect);
      headTurn = Math.max(-1, Math.min(1, Math.cos(aimDeg)));
    }
    const holdGun = !!(curState && curState.state === "playing" && curState.turn === sid);
    const key = (aimDeg === null ? "n" : aimDeg.toFixed(1)) + "|" + headTurn.toFixed(1) + "|" + (holdGun ? 1 : 0);
    if (key !== rec.drawKey) {
      rec.drawKey = key;
      drawStick(rec.canvas.getContext("2d"), rec.canvas.width, rec.canvas.height,
        { pose: rec.pose, color: rec.color, dead: false, aimDeg, headTurn, holdGun });
      rec.tex.needsUpdate = true;
    }
  }
}

// =========================================================================
//  FX
// =========================================================================
let gunBusy = false, firing = false;
function onFx(fx) {
  if (!running || !inited) return;
  if (fx.type === "handoff") startHandoff(fx.from, fx.to);
  else if (fx.type === "bang") fireSequence(true, fx.shooter, fx.target, fx.self);
  else if (fx.type === "click") fireSequence(false, fx.shooter, fx.target, fx.self);
  else if (fx.type === "aim") { /* handled via state */ }
  else if (fx.type === "look") applyRemoteLook(fx.sid, fx.yaw, fx.pitch, fx.target);
  else if (fx.type === "win") fxWin();
}
function applyRemoteLook(sid, y, p, target) {
  const rec = players.get(sid); if (!rec) return;
  rec.lookYaw = y || 0; rec.lookPitch = p || 0; rec.aimTarget = target || null;
}

function cockAndDrop(onFall) {
  tween(hammer, { "rotation.z": -1.0 }, 0.22, easeOut, () => tween(hammer, { "rotation.z": 0 }, 0.06, easeIn, onFall));
}

function fireSequence(isBang, shooterSid, targetSid, selfShot) {
  const mine = shooterSid === localSid;
  if (mine) {
    firing = true;
    gunRig.visible = true;
    if (selfShot) { // raise the barrel up to the chin
      gunRig.quaternion.copy(quatFromBarrel(new THREE.Vector3(-0.15, 1, 0.2)));
      tween(gunRig, { "position.y": -0.02, "position.z": -0.45 }, 0.22, easeOut);
    }
    cockAndDrop(() => {
      if (isBang) muzzleBang(); else cylTick();
      setTimeout(() => { firing = false; }, 450);
    });
  } else {
    // observer: flash at shooter, shake if bang
    const rec = players.get(shooterSid);
    if (rec) {
      if (isBang) { observerFlash(rec.headPos); shake = 0.8; }
    }
    if (isBang && targetSid) {
      const t = players.get(targetSid);
      if (t) observerFlash(t.center);
    }
  }
}
function muzzleBang() {
  shake = 1.0;
  muzzleFlash.material.opacity = 1; muzzleFlash.scale.set(0.5, 0.5, 0.5); muzzleLight.intensity = 16;
  tween(muzzleFlash.material, { opacity: 0 }, 0.18, easeOut); tween(muzzleFlash.scale, { x: 0.9, y: 0.9, z: 0.9 }, 0.18, easeOut); tween(muzzleLight, { intensity: 0 }, 0.22, easeOut);
  const kp = gunRig.position.clone(); gunRig.position.set(kp.x, kp.y + 0.05, kp.z + 0.12);
  tween(gunRig, { "position.x": GUN_REST.x, "position.y": GUN_REST.y, "position.z": GUN_REST.z }, 0.45, easeOut);
  spawnSmoke(worldMuzzle());
}
function cylTick() { tween(cylinderGroup, { "rotation.x": cylinderGroup.rotation.x + Math.PI / 3 }, 0.15, easeOut); }
function worldMuzzle() { return revolver.localToWorld(new THREE.Vector3(0.4, 0.045, 0)); }
function observerFlash(pos) {
  const f = new THREE.Sprite(new THREE.SpriteMaterial({ map: muzzleFlash.material.map, color: 0xffcc66, transparent: true, opacity: 1, blending: THREE.AdditiveBlending, depthWrite: false }));
  f.position.copy(pos); f.scale.set(0.6, 0.6, 0.6); scene.add(f);
  tween(f.material, { opacity: 0 }, 0.3, easeOut, () => scene.remove(f));
  tween(f.scale, { x: 1.2, y: 1.2, z: 1.2 }, 0.3, easeOut);
}
function spawnSmoke(muzzleWorld) {
  if (!SMOKE_TEX) SMOKE_TEX = makeSmokeTexture();
  for (let i = 0; i < 6; i++) {
    const m = new THREE.Sprite(new THREE.SpriteMaterial({ map: SMOKE_TEX, transparent: true, opacity: 0.45, depthWrite: false }));
    m.position.copy(muzzleWorld).add(new THREE.Vector3((Math.random() - 0.5) * 0.06, (Math.random() - 0.5) * 0.06, (Math.random() - 0.5) * 0.06));
    m.scale.set(0.08, 0.08, 0.08); scene.add(m);
    smokeParticles.push({ mesh: m, vel: new THREE.Vector3((Math.random() - 0.5) * 0.1, 0.14 + Math.random() * 0.08, -0.05 - Math.random() * 0.1), life: 1.2, max: 1.2 });
  }
}

function startHandoff(fromSid, toSid) {
  gunBusy = true; gunRig.visible = false;
  const t = players.get(toSid);
  // if the next shooter is me, spin the table pointer toward the camera; else toward them
  let dir;
  if (toSid === localSid) dir = new THREE.Vector3().subVectors(CAM_POS, CENTER).setY(0).normalize();
  else if (t) dir = new THREE.Vector3().subVectors(t.pos, CENTER).setY(0).normalize();
  else dir = new THREE.Vector3(0, 0, 1);
  const finalYaw = Math.atan2(-dir.z, dir.x);
  const startYaw = 0; const turns = 3 + Math.floor(Math.random() * 3);
  let target = finalYaw; while (target < startYaw + turns * Math.PI * 2) target += Math.PI * 2;
  tablePointer.visible = true; tablePointer.rotation.y = startYaw;
  handoffSpin = { t: 0, dur: 2.0, startYaw, target, toSid };
}
let handoffSpin = null;

function fxWin() { targetReticle.material.opacity = 0; shooterRing.visible = false; gunRig.visible = false; }

// =========================================================================
//  LOOP
// =========================================================================
function animate() {
  requestAnimationFrame(animate); if (!running) return;
  const dt = Math.min(clock.getDelta(), 0.05); idleT += dt;
  const now = performance.now();
  updateTweens(dt);

  // smooth the head toward the requested yaw/pitch
  sYaw += (yaw - sYaw) * Math.min(dt * 12, 1);
  sPitch += (pitch - sPitch) * Math.min(dt * 12, 1);

  if (handoffSpin) {
    const s = handoffSpin; s.t += dt; const p = Math.min(s.t / s.dur, 1); const e = easeOut(p);
    tablePointer.rotation.y = s.startYaw + (s.target - s.startYaw) * e;
    if (p >= 1) {
      tablePointer.visible = false; handoffSpin = null; gunBusy = false;
      gunRig.visible = curState && curState.state === "playing" && curState.turn === localSid;
    }
  }

  if (muzzleFlash.material.opacity > 0.02) muzzleFlash.material.rotation = Math.random() * Math.PI;

  for (let i = smokeParticles.length - 1; i >= 0; i--) {
    const p = smokeParticles[i]; p.life -= dt; p.mesh.position.addScaledVector(p.vel, dt);
    p.mesh.material.opacity = Math.max(0, p.life / p.max) * 0.45; p.mesh.scale.multiplyScalar(1 + dt * 0.9);
    if (p.life <= 0) { scene.remove(p.mesh); smokeParticles.splice(i, 1); }
  }

  if (dust) { const a = dust.geometry.attributes.position.array; for (let i = 1; i < a.length; i += 3) { a[i] += dt * 0.05; if (a[i] > 3.2) a[i] = 1; } dust.geometry.attributes.position.needsUpdate = true; dust.rotation.y += dt * 0.02; }
  if (shooterRing.visible) { const s = 1 + Math.sin(idleT * 4) * 0.06; shooterRing.scale.set(s, s, s); shooterRing.rotation.z += dt * 0.6; }
  if (targetReticle.material.opacity > 0.05) { const s = 0.66 + Math.sin(idleT * 6) * 0.04; targetReticle.scale.set(s, s, 1); }
  if (beamCone) beamCone.material.opacity = 0.06 + Math.sin(idleT * 3) * 0.012;
  if (bulbLight) bulbLight.intensity = 6 + Math.sin(idleT * 9) * 0.25;

  // first-person head: base seat + tiny sway, then aim where the head looks
  camera.position.x = CAM_POS.x + Math.sin(idleT * 0.6) * 0.012;
  camera.position.y = CAM_POS.y + Math.sin(idleT * 0.9) * 0.008;
  camera.position.z = CAM_POS.z;
  if (shake > 0) { shake = Math.max(0, shake - dt * 4); camera.position.x += (Math.random() - 0.5) * shake * 0.05; camera.position.y += (Math.random() - 0.5) * shake * 0.05; }
  const look = computeLook(sYaw, sPitch);
  camLookTarget.copy(camera.position).add(look);
  camera.lookAt(camLookTarget);
  camera.updateMatrixWorld();

  updateLook(now);       // pick target + broadcast our head/aim
  updateAimGun(dt);      // swing the held revolver onto the target
  updateFigures();       // turn other players' heads/arms to their targets

  composer.render();
}

function show() { running = true; yaw = pitch = sYaw = sPitch = 0; if (clock) clock.getDelta(); onResize(); }
function hide() {
  running = false;
  document.body.classList.remove("rl-aiming", "rl-locked");
  if (document.pointerLockElement) { try { document.exitPointerLock(); } catch (_) {} }
}
function shootSelf() { if (myTurn && window.socket) window.socket.emit("roulette_shoot", { target: localSid }); }

window.RL = { init, setState, onFx, show, hide, shootSelf };
