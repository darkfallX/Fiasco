"use client";

import React, { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { AGENT_PROFILES } from "@/lib/sim/missions";
import { AGENT_IDS } from "@/lib/sim/engine";
import { AgentId, AgentState, Coord, MissionConfig } from "@/lib/types";

type Props = {
  mission: MissionConfig;
  roundId: string;
  agents: Record<AgentId, AgentState>;
  activeHazards: Coord[];
  focusAgent: AgentId | "all";
  /** false while scrubbing history: state snaps without effects */
  live: boolean;
  /** Trailer rendering: an outside director drives the camera and the clock. */
  film?: FilmControl;
};

export type FilmCam = {
  pos: [number, number, number];
  target: [number, number, number];
  fov: number;
};

export type FilmControl = {
  /** When true the stage does not animate by itself; call step(dt) once per frame. */
  manual: boolean;
  cam: FilmCam | null;
  hideTags: boolean;
  timeScale: number;
  step?: (dt: number) => void;
  rovers: Record<AgentId, { x: number; z: number; heading: number }>;
};

export function cellToWorld(c: Coord, m: MissionConfig): { x: number; z: number } {
  return {
    x: (c.x - (m.width - 1) / 2) * 1.5,
    z: (c.y - (m.height - 1) / 2) * 1.5,
  };
}

const TILE = 1.5;
const MARGIN = 1.15;
const CELL_PX = 96;
const LANE: Record<AgentId, number> = { vanguard: -0.34, gridwise: 0, pivot: 0.34 };
const AGENT_NUM: Record<AgentId, string> = { vanguard: "1", gridwise: "2", pivot: "3" };
const TAG_INK: Record<AgentId, string> = {
  vanguard: "#F7F2E6",
  gridwise: "#F7F2E6",
  pivot: "#1A1915",
};

const INK = 0x1a1915;
const PAPER = 0xf7f2e6;
const WALLS = [0xf1e9d6, 0xd0684a, 0x7e99b0, 0xe0b65a, 0x97ab8a, 0xe9dcc0];
const ROOFS = [0xb5533a, 0x4a5560, 0x8c4a36];

function hash2(x: number, y: number, salt = 0): number {
  let h = (x * 374761393 + y * 668265263 + salt * 2147483647) | 0;
  h = (h ^ (h >>> 13)) * 1274126177;
  h = h ^ (h >>> 16);
  return (h >>> 0) / 4294967295;
}

function hex(n: number): string {
  return "#" + n.toString(16).padStart(6, "0");
}

function makeWindowTexture(wall: number): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = 64;
  c.height = 64;
  const g = c.getContext("2d")!;
  g.fillStyle = hex(wall);
  g.fillRect(0, 0, 64, 64);
  g.fillStyle = "#2F3A45";
  g.fillRect(16, 14, 32, 34);
  g.fillStyle = "#56687A";
  g.fillRect(16, 14, 32, 10);
  g.fillStyle = "rgba(26,25,21,0.28)";
  g.fillRect(12, 48, 40, 4);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.magFilter = THREE.NearestFilter;
  return t;
}

function makeStripeTexture(a: string, b: string): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = 512;
  c.height = 128;
  const g = c.getContext("2d")!;
  g.scale(8, 8);
  g.fillStyle = a;
  g.fillRect(0, 0, 64, 16);
  g.fillStyle = b;
  for (let i = -16; i < 80; i += 16) {
    g.beginPath();
    g.moveTo(i, 16);
    g.lineTo(i + 8, 16);
    g.lineTo(i + 16, 0);
    g.lineTo(i + 8, 0);
    g.closePath();
    g.fill();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function makeGroundTexture(m: MissionConfig): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = m.width * CELL_PX;
  c.height = m.height * CELL_PX;
  const g = c.getContext("2d")!;
  const P = CELL_PX;

  for (let y = 0; y < m.height; y++) {
    for (let x = 0; x < m.width; x++) {
      g.fillStyle = (x + y) % 2 === 0 ? "#E2D9C3" : "#D9CFB7";
      g.fillRect(x * P, y * P, P, P);
    }
  }

  // lane dashes through cell centres
  g.strokeStyle = "rgba(247,242,230,0.75)";
  g.lineWidth = 3;
  g.setLineDash([10, 14]);
  for (let y = 0; y < m.height; y++) {
    g.beginPath();
    g.moveTo(0, y * P + P / 2);
    g.lineTo(m.width * P, y * P + P / 2);
    g.stroke();
  }
  for (let x = 0; x < m.width; x++) {
    g.beginPath();
    g.moveTo(x * P + P / 2, 0);
    g.lineTo(x * P + P / 2, m.height * P);
    g.stroke();
  }
  g.setLineDash([]);

  for (const b of m.buildings) {
    g.fillStyle = "#C9BEA4";
    g.fillRect(b.x * P, b.y * P, P, P);
    g.fillStyle = "#BDB196";
    g.fillRect(b.x * P + 5, b.y * P + 5, P - 10, P - 10);
  }

  for (const h of m.scheduledHazards) {
    g.save();
    g.beginPath();
    g.rect(h.coord.x * P + 4, h.coord.y * P + 4, P - 8, P - 8);
    g.clip();
    g.fillStyle = "#E2A400";
    g.fillRect(h.coord.x * P, h.coord.y * P, P, P);
    g.strokeStyle = "#1A1915";
    g.lineWidth = 9;
    for (let i = -P; i < P * 2; i += 26) {
      g.beginPath();
      g.moveTo(h.coord.x * P + i, h.coord.y * P + P);
      g.lineTo(h.coord.x * P + i + P, h.coord.y * P);
      g.stroke();
    }
    g.restore();
  }

  for (const ch of m.chargers) {
    const x = ch.coord.x * P;
    const y = ch.coord.y * P;
    g.fillStyle = "#1F7A4D";
    g.fillRect(x + 6, y + 6, P - 12, P - 12);
    g.fillStyle = "#F7F2E6";
    g.beginPath();
    g.moveTo(x + 54, y + 18);
    g.lineTo(x + 30, y + 52);
    g.lineTo(x + 46, y + 52);
    g.lineTo(x + 40, y + 78);
    g.lineTo(x + 66, y + 42);
    g.lineTo(x + 50, y + 42);
    g.closePath();
    g.fill();
  }

  for (const d of m.deliveries) {
    const cx = d.coord.x * P + P / 2;
    const cy = d.coord.y * P + P / 2;
    g.fillStyle = "#1A1915";
    g.fillRect(d.coord.x * P + 6, d.coord.y * P + 6, P - 12, P - 12);
    g.strokeStyle = "#F7F2E6";
    g.lineWidth = 5;
    g.strokeRect(cx - 26, cy - 26, 52, 52);
    g.fillStyle = "#F7F2E6";
    g.fillRect(cx - 9, cy - 9, 18, 18);
  }

  {
    const x = m.startCoord.x * P;
    const y = m.startCoord.y * P;
    const s = P / 6;
    for (let i = 0; i < 6; i++) {
      for (let j = 0; j < 6; j++) {
        g.fillStyle = (i + j) % 2 === 0 ? "#1A1915" : "#F7F2E6";
        g.fillRect(x + i * s, y + j * s, s, s);
      }
    }
  }

  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

type Particle = {
  mesh: THREE.Mesh;
  vx: number;
  vy: number;
  vz: number;
  life: number;
  max: number;
  gravity: number;
  grow: number;
};

type Tag = {
  el: HTMLDivElement;
  pos: THREE.Vector3;
  follow?: THREE.Object3D;
  lift?: number;
};

type RoverRig = {
  group: THREE.Group;
  body: THREE.Group;
  wheels: THREE.Mesh[];
  crates: THREE.Mesh[];
  livery: THREE.MeshStandardMaterial;
  baseColor: THREE.Color;
  toX: number;
  toZ: number;
  fromX: number;
  fromZ: number;
  t: number;
  heading: number;
  tilt: number;
  celebrate: number;
  smoke: number;
  prevDelivered: number;
  prevStatus: string;
  prevCharges: number;
  tag: Tag;
  batFill: HTMLDivElement;
  batText: string;
};

export function CityStage({
  mission,
  roundId,
  agents,
  activeHazards,
  focusAgent,
  live,
  film,
}: Props) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const tagsRef = useRef<HTMLDivElement | null>(null);
  const [ready, setReady] = useState(false);
  const [webglError, setWebglError] = useState(false);

  const agentsRef = useRef(agents);
  const hazardsRef = useRef(activeHazards);
  const missionRef = useRef(mission);
  const focusRef = useRef(focusAgent);
  const liveRef = useRef(live);
  const filmRef = useRef(film);
  filmRef.current = film;
  const roundRef = useRef(roundId);
  agentsRef.current = agents;
  hazardsRef.current = activeHazards;
  missionRef.current = mission;
  focusRef.current = focusAgent;
  liveRef.current = live;
  roundRef.current = roundId;

  useEffect(() => {
    const container = mountRef.current;
    const tagLayer = tagsRef.current;
    if (!container || !tagLayer) return;

    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({
        antialias: true,
        alpha: true,
        preserveDrawingBuffer: Boolean(filmRef.current),
      });
    } catch {
      setWebglError(true);
      return;
    }
    renderer.setPixelRatio(filmRef.current ? 2 : Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(container.clientWidth, container.clientHeight);
    renderer.setClearColor(0x000000, 0);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    container.innerHTML = "";
    container.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.OrthographicCamera(-10, 10, 10, -10, 0.1, 200);
    const filmCam = new THREE.PerspectiveCamera(35, 16 / 9, 0.1, 400);
    let tagCam: THREE.Camera = camera;

    scene.add(new THREE.HemisphereLight(0xfff4dc, 0xb9ad92, 1.25));
    const sun = new THREE.DirectionalLight(0xfff0d6, 2.1);
    sun.position.set(9, 15, 5);
    sun.castShadow = true;
    const shadowRes = filmRef.current ? 4096 : 2048;
    sun.shadow.mapSize.set(shadowRes, shadowRes);
    sun.shadow.camera.near = 1;
    sun.shadow.camera.far = 50;
    sun.shadow.camera.left = -15;
    sun.shadow.camera.right = 15;
    sun.shadow.camera.top = 15;
    sun.shadow.camera.bottom = -15;
    sun.shadow.bias = -0.0008;
    sun.shadow.normalBias = 0.02;
    scene.add(sun);

    const table = new THREE.Mesh(
      new THREE.PlaneGeometry(120, 120),
      new THREE.ShadowMaterial({ opacity: 0.2 })
    );
    table.rotation.x = -Math.PI / 2;
    table.position.y = -0.62;
    table.receiveShadow = true;
    scene.add(table);

    const staticGroup = new THREE.Group();
    const hazardGroup = new THREE.Group();
    const trailGroup = new THREE.Group();
    const fxGroup = new THREE.Group();
    scene.add(staticGroup, hazardGroup, trailGroup, fxGroup);

    const unitBox = new THREE.BoxGeometry(1, 1, 1);
    const stripeRed = makeStripeTexture("#C22A1C", "#F7F2E6");
    const windowTex = WALLS.map((w) => makeWindowTexture(w));

    const cellPos = (c: Coord, m: MissionConfig) => ({
      x: (c.x - (m.width - 1) / 2) * TILE,
      z: (c.y - (m.height - 1) / 2) * TILE,
    });

    // ---------- tags ----------
    let staticTags: Tag[] = [];
    const makeTag = (text: string, bg: string, fg: string, pos: THREE.Vector3): Tag => {
      const el = document.createElement("div");
      el.className = "stage-tag";
      el.style.background = bg;
      el.style.color = fg;
      el.style.padding = "3px 6px 3px";
      el.textContent = text;
      tagLayer.appendChild(el);
      return { el, pos };
    };

    // ---------- particles ----------
    const particles: Particle[] = [];
    const spawn = (
      x: number,
      y: number,
      z: number,
      color: number,
      opts: { n: number; speed: number; up: number; size: number; life: number; gravity: number; grow?: number }
    ) => {
      for (let i = 0; i < opts.n; i++) {
        if (particles.length > 220) return;
        const mat = new THREE.MeshBasicMaterial({ color, transparent: true });
        const mesh = new THREE.Mesh(unitBox, mat);
        const s = opts.size * (0.6 + Math.random() * 0.8);
        mesh.scale.set(s, s, s);
        mesh.position.set(x, y, z);
        mesh.rotation.set(Math.random() * 3, Math.random() * 3, Math.random() * 3);
        const a = Math.random() * Math.PI * 2;
        const sp = opts.speed * (0.4 + Math.random() * 0.8);
        fxGroup.add(mesh);
        particles.push({
          mesh,
          vx: Math.cos(a) * sp,
          vz: Math.sin(a) * sp,
          vy: opts.up * (0.6 + Math.random() * 0.7),
          life: 0,
          max: opts.life * (0.7 + Math.random() * 0.6),
          gravity: opts.gravity,
          grow: opts.grow ?? 0,
        });
      }
    };

    // ---------- sector ----------
    const diamonds: THREE.Mesh[] = [];
    const chargerRings: { mesh: THREE.Mesh; coord: Coord }[] = [];
    const pennants: Record<string, Record<AgentId, THREE.Mesh>> = {};
    const hazardTags = new Map<string, Tag>();
    let boardW = 10;
    let boardH = 10;

    const disposeGroup = (grp: THREE.Group) => {
      grp.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (mesh.geometry && mesh.geometry !== unitBox) mesh.geometry.dispose();
      });
      grp.clear();
    };

    const buildSector = (m: MissionConfig) => {
      disposeGroup(staticGroup);
      for (const t of staticTags) t.el.remove();
      staticTags = [];
      hazardTags.clear();
      diamonds.length = 0;
      chargerRings.length = 0;
      for (const k of Object.keys(pennants)) delete pennants[k];

      const playW = m.width * TILE;
      const playH = m.height * TILE;
      boardW = playW + MARGIN * 2;
      boardH = playH + MARGIN * 2;

      const sideMat = new THREE.MeshStandardMaterial({ color: 0x2a2823, roughness: 0.9 });
      const topMat = new THREE.MeshStandardMaterial({ color: 0xa8b487, roughness: 1 });
      const board = new THREE.Mesh(new THREE.BoxGeometry(boardW, 0.6, boardH), [
        sideMat,
        sideMat,
        topMat,
        sideMat,
        sideMat,
        sideMat,
      ]);
      board.position.y = -0.3;
      board.receiveShadow = true;
      board.castShadow = true;
      staticGroup.add(board);

      const curb = new THREE.Mesh(
        new THREE.BoxGeometry(playW + 0.18, 0.05, playH + 0.18),
        new THREE.MeshStandardMaterial({ color: 0xf7f2e6, roughness: 0.9 })
      );
      curb.position.y = 0.012;
      curb.receiveShadow = true;
      staticGroup.add(curb);

      const ground = new THREE.Mesh(
        new THREE.PlaneGeometry(playW, playH),
        new THREE.MeshStandardMaterial({ map: makeGroundTexture(m), roughness: 0.95 })
      );
      ground.rotation.x = -Math.PI / 2;
      ground.position.y = 0.04;
      ground.receiveShadow = true;
      staticGroup.add(ground);

      // buildings
      const occupied = new Set(m.buildings.map((b) => `${b.x},${b.y}`));
      for (const b of m.buildings) {
        const r = hash2(b.x, b.y, 1);
        const r2 = hash2(b.x, b.y, 2);
        const r3 = hash2(b.x, b.y, 3);
        const wallIdx = Math.floor(r * WALLS.length) % WALLS.length;
        const floors = 2 + Math.floor(r2 * 4);
        const h = floors * 0.44 + 0.12;
        const w = TILE * (0.78 + r3 * 0.1);
        const p = cellPos(b, m);

        const tex = windowTex[wallIdx].clone();
        tex.repeat.set(2, floors);
        tex.needsUpdate = true;
        const wallMat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.85 });
        const capMat = new THREE.MeshStandardMaterial({ color: WALLS[wallIdx], roughness: 0.9 });
        const body = new THREE.Mesh(new THREE.BoxGeometry(w, h, w), [
          wallMat,
          wallMat,
          capMat,
          capMat,
          wallMat,
          wallMat,
        ]);
        body.position.set(p.x, h / 2 + 0.04, p.z);
        body.castShadow = true;
        body.receiveShadow = true;
        staticGroup.add(body);

        const roofColor = ROOFS[Math.floor(r3 * ROOFS.length) % ROOFS.length];
        if (r2 < 0.42) {
          const roof = new THREE.Mesh(
            new THREE.ConeGeometry(w * 0.74, 0.5 + r * 0.25, 4),
            new THREE.MeshStandardMaterial({ color: roofColor, roughness: 0.8, flatShading: true })
          );
          roof.rotation.y = Math.PI / 4;
          roof.position.set(p.x, h + 0.04 + (0.5 + r * 0.25) / 2, p.z);
          roof.castShadow = true;
          staticGroup.add(roof);
        } else {
          const slab = new THREE.Mesh(
            unitBox,
            new THREE.MeshStandardMaterial({ color: roofColor, roughness: 0.85 })
          );
          slab.scale.set(w + 0.1, 0.1, w + 0.1);
          slab.position.set(p.x, h + 0.09, p.z);
          slab.castShadow = true;
          staticGroup.add(slab);

          const unit = new THREE.Mesh(
            unitBox,
            new THREE.MeshStandardMaterial({ color: 0xd8d0be, roughness: 0.7 })
          );
          unit.scale.set(0.3, 0.2, 0.42);
          unit.position.set(p.x - w * 0.18, h + 0.24, p.z + w * 0.12);
          unit.castShadow = true;
          staticGroup.add(unit);

          if (r > 0.5) {
            const tank = new THREE.Mesh(
              new THREE.CylinderGeometry(0.16, 0.16, 0.3, 10),
              new THREE.MeshStandardMaterial({ color: 0x8c6a4a, roughness: 0.8 })
            );
            tank.position.set(p.x + w * 0.22, h + 0.29, p.z - w * 0.2);
            tank.castShadow = true;
            staticGroup.add(tank);
          }
        }
      }

      // trees in the margin
      const trunkMat = new THREE.MeshStandardMaterial({ color: 0x7a5a3c, roughness: 1 });
      const leafMats = [0x4f7a4a, 0x5f8f55, 0x3f6a48].map(
        (c) => new THREE.MeshStandardMaterial({ color: c, roughness: 1, flatShading: true })
      );
      const addTree = (x: number, z: number, seed: number) => {
        const s = 0.75 + hash2(seed, 7, 4) * 0.6;
        const kind = hash2(seed, 3, 5);
        const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.07, 0.3, 6), trunkMat);
        trunk.position.set(x, 0.15 * s, z);
        trunk.scale.setScalar(s);
        trunk.castShadow = true;
        staticGroup.add(trunk);
        const leaf = new THREE.Mesh(
          kind < 0.55
            ? new THREE.ConeGeometry(0.3, 0.85, 7)
            : new THREE.IcosahedronGeometry(0.34, 0),
          leafMats[Math.floor(hash2(seed, 9, 6) * 3) % 3]
        );
        leaf.position.set(x, (kind < 0.55 ? 0.68 : 0.56) * s, z);
        leaf.scale.setScalar(s);
        leaf.rotation.y = seed;
        leaf.castShadow = true;
        staticGroup.add(leaf);
      };
      let seed = m.seed.length * 31 + m.maxTurns;
      const edgeX = playW / 2 + MARGIN * 0.52;
      const edgeZ = playH / 2 + MARGIN * 0.52;
      for (let x = -edgeX; x <= edgeX; x += 1.05) {
        for (const sz of [-1, 1]) {
          seed++;
          if (hash2(seed, 1, 8) < 0.3) continue;
          addTree(x + (hash2(seed, 2, 9) - 0.5) * 0.5, sz * edgeZ + (hash2(seed, 3, 10) - 0.5) * 0.3, seed);
        }
      }
      for (let z = -edgeZ + 1; z <= edgeZ - 1; z += 1.05) {
        for (const sx of [-1, 1]) {
          seed++;
          if (hash2(seed, 1, 8) < 0.3) continue;
          addTree(sx * edgeX + (hash2(seed, 2, 9) - 0.5) * 0.3, z + (hash2(seed, 3, 10) - 0.5) * 0.5, seed);
        }
      }

      // drop points: mast with one pennant per courier
      const inkMat = new THREE.MeshStandardMaterial({ color: INK, roughness: 0.6 });
      for (const d of m.deliveries) {
        const p = cellPos(d.coord, m);
        const mx = p.x - TILE * 0.3;
        const mz = p.z - TILE * 0.3;
        const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.045, 1.9, 6), inkMat);
        mast.position.set(mx, 0.99, mz);
        mast.castShadow = true;
        staticGroup.add(mast);

        const diamond = new THREE.Mesh(
          new THREE.OctahedronGeometry(0.17, 0),
          new THREE.MeshStandardMaterial({ color: 0xe2a400, roughness: 0.4, flatShading: true })
        );
        diamond.position.set(mx, 2.08, mz);
        diamond.castShadow = true;
        staticGroup.add(diamond);
        diamonds.push(diamond);

        pennants[d.id] = {} as Record<AgentId, THREE.Mesh>;
        AGENT_IDS.forEach((id, i) => {
          const shape = new THREE.Shape();
          shape.moveTo(0, 0.12);
          shape.lineTo(0.46, 0);
          shape.lineTo(0, -0.12);
          shape.closePath();
          const flag = new THREE.Mesh(
            new THREE.ShapeGeometry(shape),
            new THREE.MeshBasicMaterial({ color: AGENT_PROFILES[id].color, side: THREE.DoubleSide })
          );
          flag.position.set(mx + 0.03, 1.72 - i * 0.3, mz);
          flag.rotation.y = -Math.PI / 4;
          flag.scale.set(0.001, 1, 1);
          flag.visible = false;
          staticGroup.add(flag);
          pennants[d.id][id] = flag;
        });

        staticTags.push(makeTag(d.id, "#1A1915", "#F7F2E6", new THREE.Vector3(mx, 2.42, mz)));
        void occupied;
      }

      // chargers
      for (const ch of m.chargers) {
        const p = cellPos(ch.coord, m);
        const px = p.x - TILE * 0.3;
        const pz = p.z - TILE * 0.3;
        const pylon = new THREE.Mesh(
          unitBox,
          new THREE.MeshStandardMaterial({ color: 0x1f7a4d, roughness: 0.6 })
        );
        pylon.scale.set(0.24, 1.0, 0.24);
        pylon.position.set(px, 0.54, pz);
        pylon.castShadow = true;
        staticGroup.add(pylon);
        const cap = new THREE.Mesh(
          unitBox,
          new THREE.MeshStandardMaterial({ color: PAPER, roughness: 0.6 })
        );
        cap.scale.set(0.3, 0.1, 0.3);
        cap.position.set(px, 1.08, pz);
        staticGroup.add(cap);

        const ring = new THREE.Mesh(
          new THREE.RingGeometry(0.5, 0.58, 4),
          new THREE.MeshBasicMaterial({
            color: 0xf7f2e6,
            side: THREE.DoubleSide,
            transparent: true,
            opacity: 0,
          })
        );
        ring.rotation.x = -Math.PI / 2;
        ring.rotation.z = Math.PI / 4;
        ring.position.set(p.x, 0.07, p.z);
        staticGroup.add(ring);
        chargerRings.push({ mesh: ring, coord: ch.coord });

        staticTags.push(
          makeTag(`+${ch.chargeAmount}`, "#1F7A4D", "#F7F2E6", new THREE.Vector3(px, 1.42, pz))
        );
      }

      // closure warnings
      for (const h of m.scheduledHazards) {
        const p = cellPos(h.coord, m);
        const tag = makeTag(`T${h.triggerTurn}`, "#E2A400", "#1A1915", new THREE.Vector3(p.x, 0.5, p.z));
        staticTags.push(tag);
        hazardTags.set(`${h.coord.x},${h.coord.y}`, tag);
      }
    };

    // ---------- couriers ----------
    const rigs = {} as Record<AgentId, RoverRig>;
    const wheelGeo = new THREE.CylinderGeometry(0.1, 0.1, 0.08, 10);
    wheelGeo.rotateZ(Math.PI / 2);
    const wheelMat = new THREE.MeshStandardMaterial({ color: INK, roughness: 0.8 });
    const crateMat = new THREE.MeshStandardMaterial({ color: 0xc9a26b, roughness: 0.9 });
    const glassMat = new THREE.MeshStandardMaterial({ color: 0x2f3a45, roughness: 0.3 });

    for (const id of AGENT_IDS) {
      const baseColor = new THREE.Color(AGENT_PROFILES[id].color);
      const livery = new THREE.MeshStandardMaterial({ color: baseColor.clone(), roughness: 0.5 });
      const group = new THREE.Group();
      const body = new THREE.Group();
      group.add(body);

      const chassis = new THREE.Mesh(unitBox, livery);
      chassis.scale.set(0.44, 0.16, 0.7);
      chassis.position.y = 0.2;
      chassis.castShadow = true;
      body.add(chassis);

      const cab = new THREE.Mesh(unitBox, livery);
      cab.scale.set(0.4, 0.22, 0.24);
      cab.position.set(0, 0.39, 0.2);
      cab.castShadow = true;
      body.add(cab);

      const glass = new THREE.Mesh(unitBox, glassMat);
      glass.scale.set(0.34, 0.12, 0.02);
      glass.position.set(0, 0.41, 0.325);
      body.add(glass);

      const bumper = new THREE.Mesh(unitBox, new THREE.MeshBasicMaterial({ color: PAPER }));
      bumper.scale.set(0.4, 0.05, 0.03);
      bumper.position.set(0, 0.17, 0.36);
      body.add(bumper);

      const wheels: THREE.Mesh[] = [];
      for (const [wx, wz] of [
        [-0.24, 0.22],
        [0.24, 0.22],
        [-0.24, -0.22],
        [0.24, -0.22],
      ]) {
        const w = new THREE.Mesh(wheelGeo, wheelMat);
        w.position.set(wx, 0.1, wz);
        w.castShadow = true;
        body.add(w);
        wheels.push(w);
      }

      const crates: THREE.Mesh[] = [];
      for (let i = 0; i < 3; i++) {
        const c = new THREE.Mesh(unitBox, crateMat);
        c.scale.set(0.26, 0.2, 0.26);
        c.position.set(i === 2 ? 0 : 0, 0.38 + i * 0.205, -0.14);
        c.rotation.y = (i - 1) * 0.22;
        c.castShadow = true;
        body.add(c);
        crates.push(c);
      }

      group.scale.setScalar(1.5);
      scene.add(group);

      const el = document.createElement("div");
      el.className = "stage-tag";
      el.style.background = AGENT_PROFILES[id].color;
      el.style.color = TAG_INK[id];
      el.style.padding = "3px 5px 4px";
      el.style.fontSize = "15px";
      el.style.display = "flex";
      el.style.flexDirection = "column";
      el.style.alignItems = "center";
      el.style.gap = "3px";
      const num = document.createElement("span");
      num.textContent = AGENT_NUM[id];
      const bar = document.createElement("div");
      bar.style.cssText = `width:22px;height:5px;border:1px solid ${TAG_INK[id]};`;
      const batFill = document.createElement("div");
      batFill.style.cssText = `height:100%;width:100%;background:${TAG_INK[id]};`;
      bar.appendChild(batFill);
      el.append(num, bar);
      tagLayer.appendChild(el);

      rigs[id] = {
        group,
        body,
        wheels,
        crates,
        livery,
        baseColor,
        toX: 0,
        toZ: 0,
        fromX: 0,
        fromZ: 0,
        t: 1,
        heading: Math.PI / 2,
        tilt: 0,
        celebrate: 0,
        smoke: 0,
        prevDelivered: 0,
        prevStatus: "ready",
        prevCharges: 0,
        tag: { el, pos: new THREE.Vector3(), follow: group, lift: 1.75 },
        batFill,
        batText: "",
      };
    }

    const snapRigs = () => {
      const m = missionRef.current;
      for (const id of AGENT_IDS) {
        const ag = agentsRef.current[id];
        const p = cellPos(ag.coord, m);
        const rig = rigs[id];
        rig.toX = rig.fromX = p.x + LANE[id];
        rig.toZ = rig.fromZ = p.z - LANE[id];
        rig.t = 1;
        rig.group.position.set(rig.toX, 0.04, rig.toZ);
        rig.prevDelivered = ag.deliveredIds.length;
        rig.prevStatus = ag.status;
        rig.prevCharges = ag.chargesUsed;
        rig.celebrate = 0;
        rig.tilt = ag.status.startsWith("failed") ? 0.32 : 0;
      }
    };

    // ---------- hazards ----------
    type Barrier = { group: THREE.Group; vy: number; landed: boolean };
    const barriers = new Map<string, Barrier>();
    const coneMat = new THREE.MeshStandardMaterial({ color: 0xe8651a, roughness: 0.7 });
    const boardMat = new THREE.MeshStandardMaterial({ map: stripeRed, roughness: 0.7 });
    const legMat = new THREE.MeshStandardMaterial({ color: INK, roughness: 0.8 });

    const makeBarrier = (): THREE.Group => {
      const g = new THREE.Group();
      for (const rot of [Math.PI / 4, -Math.PI / 4]) {
        const horse = new THREE.Group();
        const plank = new THREE.Mesh(unitBox, boardMat);
        plank.scale.set(TILE * 0.95, 0.22, 0.07);
        plank.position.y = 0.52;
        plank.castShadow = true;
        horse.add(plank);
        for (const lx of [-0.5, 0.5]) {
          const leg = new THREE.Mesh(unitBox, legMat);
          leg.scale.set(0.07, 0.56, 0.07);
          leg.position.set(lx, 0.28, 0);
          leg.castShadow = true;
          horse.add(leg);
        }
        horse.rotation.y = rot;
        g.add(horse);
      }
      for (const [cx, cz] of [
        [0, 0.58],
        [0, -0.58],
      ]) {
        const cone = new THREE.Mesh(new THREE.ConeGeometry(0.11, 0.32, 8), coneMat);
        cone.position.set(cx, 0.16, cz);
        cone.castShadow = true;
        g.add(cone);
      }
      return g;
    };

    // ---------- camera ----------
    const BASE_YAW = 0.46;
    const PITCH = 0.64;
    let yaw = BASE_YAW;
    let userZoom = 1;
    let zoomCur = 1;
    let shake = 0;
    let eventFocus: { x: number; z: number; until: number } | null = null;
    const target = new THREE.Vector3(0, 0.6, 0);
    let dragging = false;
    let lastX = 0;

    const onDown = (e: PointerEvent) => {
      dragging = true;
      lastX = e.clientX;
    };
    const onMove = (e: PointerEvent) => {
      if (!dragging) return;
      yaw -= (e.clientX - lastX) * 0.006;
      lastX = e.clientX;
    };
    const onUp = () => {
      dragging = false;
    };
    const onWheel = (e: WheelEvent) => {
      if (window.innerWidth < 1024) return;
      e.preventDefault();
      userZoom = Math.max(0.8, Math.min(2.4, userZoom - e.deltaY * 0.0012));
    };
    const onDbl = () => {
      yaw = BASE_YAW;
      userZoom = 1;
    };
    const dom = renderer.domElement;
    dom.style.touchAction = "pan-y";
    dom.addEventListener("pointerdown", onDown);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    dom.addEventListener("wheel", onWheel, { passive: false });
    dom.addEventListener("dblclick", onDbl);

    let sizeW = container.clientWidth;
    let sizeH = container.clientHeight;
    const ro = new ResizeObserver(() => {
      // The trailer resizes inside its own frame step so a frame is never left blank.
      if (filmRef.current) return;
      renderer.setSize(Math.max(1, container.clientWidth), Math.max(1, container.clientHeight));
    });
    ro.observe(container);

    // ---------- trails ----------
    let trailSig = "";
    const trailMats = {} as Record<AgentId, THREE.MeshBasicMaterial>;
    const dotMats = {} as Record<AgentId, THREE.MeshBasicMaterial>;
    for (const id of AGENT_IDS) {
      trailMats[id] = new THREE.MeshBasicMaterial({ color: AGENT_PROFILES[id].color, transparent: true });
      dotMats[id] = new THREE.MeshBasicMaterial({ color: AGENT_PROFILES[id].color, transparent: true });
    }

    const syncTrails = () => {
      const m = missionRef.current;
      const cur = agentsRef.current;
      const focus = focusRef.current;
      const sig =
        focus +
        AGENT_IDS.map(
          (id) => `${cur[id].path.length}.${cur[id].plannedPath.length}.${cur[id].coord.x}.${cur[id].coord.y}`
        ).join("|");
      if (sig === trailSig) return;
      trailSig = sig;
      trailGroup.clear();

      AGENT_IDS.forEach((id, li) => {
        const ag = cur[id];
        const dim = focus !== "all" && focus !== id;
        trailMats[id].opacity = dim ? 0.18 : 0.9;
        dotMats[id].opacity = dim ? 0.12 : 0.6;
        const y = 0.06 + li * 0.006;
        for (let i = 1; i < ag.path.length; i++) {
          const a = cellPos(ag.path[i - 1], m);
          const b = cellPos(ag.path[i], m);
          if (a.x === b.x && a.z === b.z) continue;
          const seg = new THREE.Mesh(unitBox, trailMats[id]);
          const horiz = a.z === b.z;
          seg.scale.set(horiz ? TILE + 0.1 : 0.1, 0.02, horiz ? 0.1 : TILE + 0.1);
          seg.position.set((a.x + b.x) / 2 + LANE[id], y, (a.z + b.z) / 2 - LANE[id]);
          trailGroup.add(seg);
        }
        for (let i = 1; i < ag.plannedPath.length; i++) {
          const p = cellPos(ag.plannedPath[i], m);
          const dot = new THREE.Mesh(unitBox, dotMats[id]);
          dot.scale.set(0.13, 0.02, 0.13);
          dot.rotation.y = Math.PI / 4;
          dot.position.set(p.x + LANE[id], y, p.z - LANE[id]);
          trailGroup.add(dot);
        }
      });
    };

    // ---------- loop ----------
    buildSector(missionRef.current);
    snapRigs();
    let builtMission = missionRef.current.id;
    let builtRound = roundRef.current;
    let wasLive = liveRef.current;

    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const clock = new THREE.Clock();
    const grey = new THREE.Color(0x8a8372);
    const v = new THREE.Vector3();
    const right = new THREE.Vector3();
    const up = new THREE.Vector3();
    const fwd = new THREE.Vector3();
    let raf = 0;

    const placeTag = (tag: Tag, w: number, h: number) => {
      if (tag.follow) {
        v.copy(tag.follow.position);
        v.y += tag.lift ?? 1;
      } else {
        v.copy(tag.pos);
      }
      v.project(tagCam);
      tag.el.style.visibility = v.z > 1 || v.z < -1 ? "hidden" : "visible";
      const x = ((v.x + 1) / 2) * w;
      const y = ((1 - v.y) / 2) * h;
      tag.el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) translate(-50%, -100%)`;
    };

    let stageNow = 0;
    let builtSectorRound = roundRef.current;
    const frame = (manualDt?: number) => {
      const filmCtl = filmRef.current;
      if (manualDt === undefined) {
        raf = requestAnimationFrame(() => frame());
        if (filmCtl?.manual) return;
        if (document.hidden) return;
      }
      const scale = filmCtl?.timeScale ?? 1;
      const dt =
        (manualDt !== undefined ? manualDt : Math.min(0.05, clock.getDelta())) * scale;
      stageNow += dt;
      const now = stageNow;
      if (filmCtl) {
        const cw = Math.max(1, container.clientWidth);
        const ch = Math.max(1, container.clientHeight);
        if (cw !== sizeW || ch !== sizeH) {
          sizeW = cw;
          sizeH = ch;
          renderer.setSize(cw, ch);
        }
      }
      const m = missionRef.current;
      const cur = agentsRef.current;
      const isLive = liveRef.current;

      // Each round has its own drop points and closures, even on the same map.
      if (m.id !== builtMission || roundRef.current !== builtSectorRound) {
        buildSector(m);
        builtMission = m.id;
        builtSectorRound = roundRef.current;
        trailSig = "";
      }
      const discontinuity = roundRef.current !== builtRound || isLive !== wasLive || !isLive;
      if (roundRef.current !== builtRound) {
        builtRound = roundRef.current;
        for (const b of barriers.values()) hazardGroup.remove(b.group);
        barriers.clear();
        for (const id of AGENT_IDS) rigs[id].livery.color.copy(rigs[id].baseColor);
        snapRigs();
      }
      wasLive = isLive;

      syncTrails();

      // hazards
      const activeKeys = new Set(hazardsRef.current.map((h) => `${h.x},${h.y}`));
      for (const [key, b] of barriers) {
        if (!activeKeys.has(key)) {
          hazardGroup.remove(b.group);
          barriers.delete(key);
        }
      }
      for (const h of hazardsRef.current) {
        const key = `${h.x},${h.y}`;
        if (barriers.has(key)) continue;
        const p = cellPos(h, m);
        const group = makeBarrier();
        const animate = !discontinuity && !reduced;
        group.position.set(p.x, animate ? 9 : 0.04, p.z);
        hazardGroup.add(group);
        barriers.set(key, { group, vy: 0, landed: !animate });
        if (animate) eventFocus = { x: p.x, z: p.z, until: now + 1.7 };
      }
      for (const [key, tag] of hazardTags) {
        const closed = activeKeys.has(key);
        const want = closed ? "CLOSED" : "";
        if (closed && tag.el.textContent !== want) {
          tag.el.textContent = want;
          tag.el.style.background = "#C22A1C";
          tag.el.style.color = "#F7F2E6";
          tag.pos.y = 1.15;
        } else if (!closed && tag.el.textContent === "CLOSED") {
          const sh = m.scheduledHazards.find((s) => `${s.coord.x},${s.coord.y}` === key);
          tag.el.textContent = sh ? `T${sh.triggerTurn}` : "";
          tag.el.style.background = "#E2A400";
          tag.el.style.color = "#1A1915";
          tag.pos.y = 0.5;
        }
      }
      for (const b of barriers.values()) {
        if (b.landed) continue;
        b.vy -= 46 * dt;
        b.group.position.y += b.vy * dt;
        if (b.group.position.y <= 0.04) {
          b.group.position.y = 0.04;
          if (Math.abs(b.vy) > 12) {
            shake = 1;
            spawn(b.group.position.x, 0.15, b.group.position.z, 0xbdb196, {
              n: 22,
              speed: 2.6,
              up: 1.4,
              size: 0.14,
              life: 0.7,
              gravity: 3,
              grow: 0.4,
            });
          }
          b.vy = -b.vy * 0.32;
          if (Math.abs(b.vy) < 1.2) b.landed = true;
        }
      }

      // ambient props
      if (!reduced) {
        diamonds.forEach((d, i) => {
          d.rotation.y = now * 1.2 + i;
          d.position.y = 2.08 + Math.sin(now * 2 + i) * 0.04;
        });
      }
      for (const r of chargerRings) {
        const busy = AGENT_IDS.some(
          (id) => cur[id].status === "charging" && cur[id].coord.x === r.coord.x && cur[id].coord.y === r.coord.y
        );
        const mat = r.mesh.material as THREE.MeshBasicMaterial;
        if (busy) {
          const ph = (now * 1.4) % 1;
          r.mesh.scale.setScalar(0.5 + ph * 0.9);
          mat.opacity = 1 - ph;
        } else {
          mat.opacity = 0;
        }
      }

      // pennants
      for (const d of m.deliveries) {
        for (const id of AGENT_IDS) {
          const flag = pennants[d.id]?.[id];
          if (!flag) continue;
          const on = cur[id].deliveredIds.includes(d.id);
          flag.visible = on || flag.scale.x > 0.01;
          const goal = on ? 1 : 0.001;
          flag.scale.x += (goal - flag.scale.x) * (discontinuity ? 1 : Math.min(1, dt * 9));
        }
      }

      // couriers
      for (const id of AGENT_IDS) {
        const rig = rigs[id];
        const ag = cur[id];
        const p = cellPos(ag.coord, m);
        const tx = p.x + LANE[id];
        const tz = p.z - LANE[id];

        if (tx !== rig.toX || tz !== rig.toZ) {
          const jump = Math.hypot(tx - rig.group.position.x, tz - rig.group.position.z);
          if (discontinuity || reduced || jump > TILE * 2.4) {
            rig.fromX = rig.toX = tx;
            rig.fromZ = rig.toZ = tz;
            rig.t = 1;
          } else {
            rig.fromX = rig.group.position.x;
            rig.fromZ = rig.group.position.z;
            rig.toX = tx;
            rig.toZ = tz;
            rig.t = 0;
          }
        }

        let hop = 0;
        if (rig.t < 1) {
          rig.t = Math.min(1, rig.t + dt / 0.44);
          const e = rig.t < 0.5 ? 2 * rig.t * rig.t : 1 - Math.pow(-2 * rig.t + 2, 2) / 2;
          const dx = rig.toX - rig.fromX;
          const dz = rig.toZ - rig.fromZ;
          rig.group.position.x = rig.fromX + dx * e;
          rig.group.position.z = rig.fromZ + dz * e;
          if (Math.hypot(dx, dz) > 0.05) {
            const want = Math.atan2(dx, dz);
            let diff = want - rig.heading;
            while (diff > Math.PI) diff -= Math.PI * 2;
            while (diff < -Math.PI) diff += Math.PI * 2;
            rig.heading += diff * Math.min(1, dt * 14);
          }
          hop = Math.sin(rig.t * Math.PI) * 0.07;
          for (const w of rig.wheels) w.rotation.x += dt * 14;
        } else {
          rig.group.position.x = rig.toX;
          rig.group.position.z = rig.toZ;
        }

        const failed = ag.status === "failed_battery" || ag.status === "failed_timeout";
        const done = ag.status === "completed";

        if (!discontinuity) {
          if (ag.deliveredIds.length > rig.prevDelivered) {
            spawn(rig.group.position.x, 0.9, rig.group.position.z, rig.baseColor.getHex(), {
              n: 26,
              speed: 2.4,
              up: 4.2,
              size: 0.11,
              life: 1.1,
              gravity: 9,
            });
            spawn(rig.group.position.x, 0.9, rig.group.position.z, PAPER, {
              n: 10,
              speed: 2,
              up: 3.6,
              size: 0.09,
              life: 1,
              gravity: 9,
            });
          }
          if (ag.chargesUsed > rig.prevCharges) {
            spawn(rig.group.position.x, 0.3, rig.group.position.z, 0x1f7a4d, {
              n: 14,
              speed: 0.5,
              up: 2.4,
              size: 0.09,
              life: 0.9,
              gravity: -1,
            });
          }
          if (done && rig.prevStatus !== "completed") rig.celebrate = 2.6;
          if (failed && !rig.prevStatus.startsWith("failed")) shake = Math.max(shake, 0.5);
        }
        rig.prevDelivered = ag.deliveredIds.length;
        rig.prevCharges = ag.chargesUsed;
        rig.prevStatus = ag.status;

        rig.crates.forEach((c, i) => {
          c.visible = i < m.deliveries.length - ag.deliveredIds.length;
        });

        if (rig.celebrate > 0) {
          rig.celebrate -= dt;
          hop += Math.abs(Math.sin(rig.celebrate * 7)) * 0.3;
          rig.heading += dt * 5;
        }

        rig.tilt += ((failed ? 0.34 : 0) - rig.tilt) * Math.min(1, dt * 6);
        rig.livery.color.lerp(failed ? grey : rig.baseColor, Math.min(1, dt * 4));
        if (failed && isLive && !reduced) {
          rig.smoke -= dt;
          if (rig.smoke <= 0) {
            rig.smoke = 0.22;
            spawn(rig.group.position.x, 0.6, rig.group.position.z, 0x5e584b, {
              n: 1,
              speed: 0.25,
              up: 1.1,
              size: 0.13,
              life: 1.4,
              gravity: -0.4,
              grow: 0.8,
            });
          }
        }

        rig.group.position.y = 0.04 + hop;
        rig.group.rotation.y = rig.heading;
        rig.body.rotation.z = rig.tilt;

        const pct = Math.max(0, Math.min(100, Math.round((ag.battery / ag.maxBattery) * 100)));
        const txt = `${pct}`;
        if (txt !== rig.batText) {
          rig.batText = txt;
          rig.batFill.style.width = `${pct}%`;
          rig.batFill.style.background = ag.battery <= 4 ? "#C22A1C" : TAG_INK[id];
        }
        const dim = focusRef.current !== "all" && focusRef.current !== id;
        rig.tag.el.style.opacity = dim ? "0.45" : "1";
      }

      // particles
      for (let i = particles.length - 1; i >= 0; i--) {
        const pt = particles[i];
        pt.life += dt;
        if (pt.life >= pt.max) {
          fxGroup.remove(pt.mesh);
          (pt.mesh.material as THREE.Material).dispose();
          particles.splice(i, 1);
          continue;
        }
        pt.vy -= pt.gravity * dt;
        pt.mesh.position.x += pt.vx * dt;
        pt.mesh.position.y = Math.max(0.05, pt.mesh.position.y + pt.vy * dt);
        pt.mesh.position.z += pt.vz * dt;
        pt.mesh.rotation.x += dt * 4;
        pt.mesh.rotation.y += dt * 3;
        if (pt.grow) pt.mesh.scale.multiplyScalar(1 + pt.grow * dt);
        (pt.mesh.material as THREE.MeshBasicMaterial).opacity = 1 - Math.pow(pt.life / pt.max, 2);
      }

      // camera
      const w = Math.max(1, container.clientWidth);
      const h = Math.max(1, container.clientHeight);
      const aspect = w / h;
      const focus = focusRef.current;
      let gx = 0;
      let gz = 0;
      let gZoom = userZoom;
      if (focus !== "all") {
        gx = rigs[focus].group.position.x;
        gz = rigs[focus].group.position.z;
        gZoom = Math.max(userZoom, 1.9);
      } else if (eventFocus && now < eventFocus.until) {
        gx = eventFocus.x * 0.7;
        gz = eventFocus.z * 0.7;
        gZoom = Math.max(userZoom, 1.45);
      }
      const k = reduced ? 1 : Math.min(1, dt * 3.2);
      target.x += (gx - target.x) * k;
      target.z += (gz - target.z) * k;
      zoomCur += (gZoom - zoomCur) * k;

      const sway = reduced || dragging ? 0 : Math.sin(now * 0.17) * 0.045;
      const yy = yaw + sway;
      fwd.set(Math.sin(yy) * Math.cos(PITCH), Math.sin(PITCH), Math.cos(yy) * Math.cos(PITCH));
      right.set(Math.cos(yy), 0, -Math.sin(yy));
      up.crossVectors(fwd, right);

      let maxX = 0;
      let maxY = 0;
      for (const sx of [-1, 1]) {
        for (const sz of [-1, 1]) {
          for (const sy of [-0.6, 2.3]) {
            v.set((sx * boardW) / 2, sy, (sz * boardH) / 2);
            maxX = Math.max(maxX, Math.abs(v.dot(right)));
            maxY = Math.max(maxY, Math.abs(v.dot(up) - 0.9));
          }
        }
      }
      const halfW = (Math.max(maxX, maxY * aspect) * 1.04) / zoomCur;
      camera.left = -halfW;
      camera.right = halfW;
      camera.top = halfW / aspect;
      camera.bottom = -halfW / aspect;
      camera.updateProjectionMatrix();

      shake = Math.max(0, shake - dt * 2.6);
      const sk = reduced ? 0 : shake * shake * 0.22;
      camera.position
        .copy(target)
        .addScaledVector(fwd, 60)
        .addScaledVector(right, Math.sin(now * 71) * sk)
        .addScaledVector(up, 0.9 + Math.cos(now * 83) * sk);
      v.copy(target).addScaledVector(up, 0.9);
      camera.lookAt(v);
      camera.updateMatrixWorld();

      const fc = filmCtl?.cam;
      if (fc) {
        filmCam.fov = fc.fov;
        filmCam.aspect = aspect;
        filmCam.updateProjectionMatrix();
        filmCam.position.set(
          fc.pos[0] + Math.sin(now * 71) * sk * 0.7,
          fc.pos[1] + Math.cos(now * 83) * sk * 0.7,
          fc.pos[2]
        );
        filmCam.lookAt(fc.target[0], fc.target[1], fc.target[2]);
        filmCam.updateMatrixWorld();
        tagCam = filmCam;
      } else {
        tagCam = camera;
      }
      tagLayer.style.display = filmCtl?.hideTags ? "none" : "";
      if (filmCtl) {
        for (const id of AGENT_IDS) {
          filmCtl.rovers[id] = {
            x: rigs[id].group.position.x,
            z: rigs[id].group.position.z,
            heading: rigs[id].heading,
          };
        }
      }
      renderer.render(scene, tagCam);

      for (const t of staticTags) placeTag(t, w, h);
      for (const id of AGENT_IDS) placeTag(rigs[id].tag, w, h);
    };

    if (filmRef.current) filmRef.current.step = (dt: number) => frame(dt);
    setReady(true);
    frame();

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      dom.removeEventListener("pointerdown", onDown);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      dom.removeEventListener("wheel", onWheel);
      dom.removeEventListener("dblclick", onDbl);
      tagLayer.innerHTML = "";
      renderer.dispose();
    };
  }, []);

  return (
    <div className="absolute inset-0 overflow-hidden select-none">
      <div ref={mountRef} className="absolute inset-0 cursor-grab active:cursor-grabbing" />
      <div ref={tagsRef} className="absolute inset-0 pointer-events-none overflow-hidden" />

      {!ready && !webglError && (
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="grid grid-cols-6 gap-1.5 w-[62%] max-w-[560px] -skew-x-12">
            {Array.from({ length: 24 }).map((_, i) => (
              <div key={i} className="skeleton h-12" style={{ animationDelay: `${(i % 6) * 90}ms` }} />
            ))}
          </div>
        </div>
      )}

      {webglError && (
        <div className="absolute inset-0 flex items-center justify-center font-display text-xl font-bold text-[#C22A1C]">
          WEBGL UNAVAILABLE
        </div>
      )}
    </div>
  );
}
