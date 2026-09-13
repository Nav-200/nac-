/**
 * Static world rendering: merged geometry per chunk (slabs, roads, markings, buildings,
 * roofs, decals) and InstancedMesh props per chunk per kind. Also owns the water planes,
 * lamp light pools and the night-time emissive fades.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { BLOCK_PITCH, SIDEWALK_HEIGHT, SIDEWALK_WIDTH } from '../core/constants';
import type { BuildingRecord, ChunkRecord, DecalRecord, PropKind, PropRecord, SlabRecord, WorldData } from '../core/types';
import {
  asphaltTexture,
  billboardTexture,
  concreteTexture,
  dirtTexture,
  facadeTexture,
  FACADE_STYLES,
  glowTexture,
  grassTexture,
  plankTexture,
  plazaTexture,
  roofTexture,
  sandTexture,
  sidewalkTexture,
  waterTexture,
} from '../core/textures';
import { GridRoadNetwork, isAvenueLine, lineHalfWidth, rightOf } from '../world/roadNetwork';
import { PIER_DECK_Y, SHORE_X, WATER_Y } from '../world/cityGen';
import type { RoadNode } from '../core/types';

const ROAD_Y = 0.0;
const MARK_Y = 0.012;
const DECAL_Y = SIDEWALK_HEIGHT + 0.012;

// ------------------------------------------------------------------ geometry helpers
const m4 = new THREE.Matrix4();
const q = new THREE.Quaternion();
const v3 = new THREE.Vector3();
const s3 = new THREE.Vector3();

function xform(geo: THREE.BufferGeometry, x: number, y: number, z: number, yaw = 0, sx = 1, sy = 1, sz = 1, pitch = 0, roll = 0): THREE.BufferGeometry {
  q.setFromEuler(new THREE.Euler(pitch, yaw, roll, 'YXZ'));
  v3.set(x, y, z);
  s3.set(sx, sy, sz);
  m4.compose(v3, q, s3);
  geo.applyMatrix4(m4);
  return geo;
}

function colorize(geo: THREE.BufferGeometry, hex: number): THREE.BufferGeometry {
  const c = new THREE.Color(hex);
  const n = geo.getAttribute('position').count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    arr[i * 3] = c.r;
    arr[i * 3 + 1] = c.g;
    arr[i * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return geo;
}

/** Flat rectangle in the XZ plane facing up, UVs scaled so the texture repeats every `texSize` metres. */
function flatRect(minX: number, minZ: number, maxX: number, maxZ: number, y: number, texSize: number): THREE.BufferGeometry {
  const w = maxX - minX;
  const d = maxZ - minZ;
  const g = new THREE.PlaneGeometry(w, d, 1, 1);
  g.rotateX(-Math.PI / 2);
  g.translate((minX + maxX) / 2, y, (minZ + maxZ) / 2);
  const uv = g.getAttribute('uv') as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, (uv.getX(i) * w) / texSize + minX / texSize, (uv.getY(i) * d) / texSize + minZ / texSize);
  return g;
}

/** Rotated flat rectangle (centre, half sizes, yaw). */
function flatRectRot(cx: number, cz: number, hx: number, hz: number, yaw: number, y: number, texSize: number): THREE.BufferGeometry {
  const g = new THREE.PlaneGeometry(hx * 2, hz * 2, 1, 1);
  g.rotateX(-Math.PI / 2);
  const uv = g.getAttribute('uv') as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, (uv.getX(i) * hx * 2) / texSize, (uv.getY(i) * hz * 2) / texSize);
  g.rotateY(yaw);
  g.translate(cx, y, cz);
  return g;
}

/** Box with per-face UVs scaled by face size / texSize; y0 is the bottom. */
function texturedBox(cx: number, cz: number, y0: number, w: number, h: number, d: number, texSize: number, skipBottom = true): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d);
  const uv = g.getAttribute('uv') as THREE.BufferAttribute;
  // Face groups of 4 vertices: +x(d,h) -x(d,h) +y(w,d) -y(w,d) +z(w,h) -z(w,h)
  const sizes: [number, number][] = [
    [d, h],
    [d, h],
    [w, d],
    [w, d],
    [w, h],
    [w, h],
  ];
  for (let f = 0; f < 6; f++) {
    const [su, sv] = sizes[f];
    for (let i = f * 4; i < f * 4 + 4; i++) uv.setXY(i, (uv.getX(i) * su) / texSize, (uv.getY(i) * sv) / texSize);
  }
  g.translate(cx, y0 + h / 2, cz);
  if (skipBottom) {
    // Drop the -y face (group 3): indices 18..23 of the 36-index buffer.
    const idx = g.getIndex()!;
    const arr = Array.from(idx.array as ArrayLike<number>);
    arr.splice(18, 6);
    g.setIndex(arr);
    g.clearGroups();
  }
  return g;
}

/** Four walls of a building with window UVs (u = metres/winW, v = metres/floorH). No top/bottom. */
function wallsGeometry(cx: number, cz: number, y0: number, w: number, h: number, d: number, winW: number, floorH: number): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const mk = (pw: number, yaw: number, ox: number, oz: number) => {
    const g = new THREE.PlaneGeometry(pw, h, 1, 1);
    const uv = g.getAttribute('uv') as THREE.BufferAttribute;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, (uv.getX(i) * pw) / winW, (uv.getY(i) * h) / floorH);
    g.rotateY(yaw);
    g.translate(cx + ox, y0 + h / 2, cz + oz);
    parts.push(g);
  };
  mk(w, 0, 0, d / 2); // +z
  mk(w, Math.PI, 0, -d / 2); // -z
  mk(d, Math.PI / 2, w / 2, 0); // +x
  mk(d, -Math.PI / 2, -w / 2, 0); // -x
  return mergeGeometries(parts, false)!;
}

function mergeOrNull(list: THREE.BufferGeometry[]): THREE.BufferGeometry | null {
  if (!list.length) return null;
  const merged = mergeGeometries(list, false);
  for (const g of list) g.dispose();
  return merged;
}

// ------------------------------------------------------------------ prop geometry
interface PropVariant {
  geo: THREE.BufferGeometry;
  material: THREE.Material;
  castShadow: boolean;
  /** Hide beyond this distance (m). */
  cullDist: number;
}

const PROP_CULL_NEAR = 420;
const PROP_CULL_FAR = 1500;

function box(hex: number, w: number, h: number, d: number, x = 0, y = 0, z = 0, yaw = 0): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d);
  colorize(g, hex);
  return xform(g, x, y + h / 2, z, yaw);
}
function cyl(hex: number, rTop: number, rBot: number, h: number, x = 0, y = 0, z = 0, seg = 8): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(rTop, rBot, h, seg);
  colorize(g, hex);
  return xform(g, x, y + h / 2, z);
}
function cone(hex: number, r: number, h: number, x = 0, y = 0, z = 0, seg = 8): THREE.BufferGeometry {
  const g = new THREE.ConeGeometry(r, h, seg);
  colorize(g, hex);
  return xform(g, x, y + h / 2, z);
}
function sphere(hex: number, r: number, x = 0, y = 0, z = 0, sy = 1): THREE.BufferGeometry {
  const g = new THREE.SphereGeometry(r, 8, 6);
  colorize(g, hex);
  return xform(g, x, y, z, 0, 1, sy, 1);
}
function merged(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const g = mergeGeometries(parts, false)!;
  for (const p of parts) p.dispose();
  return g;
}

function buildPropVariants(): Map<PropKind, PropVariant[]> {
  const std = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, metalness: 0.05 });
  const metal = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.5, metalness: 0.5 });
  const foliage = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0 });
  const fenceMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, metalness: 0.6, transparent: true, opacity: 0.55, depthWrite: false, side: THREE.DoubleSide });
  const map = new Map<PropKind, PropVariant[]>();
  const add = (kind: PropKind, geo: THREE.BufferGeometry, material: THREE.Material, castShadow = true, cullDist = PROP_CULL_NEAR) => {
    const list = map.get(kind) ?? [];
    list.push({ geo, material, castShadow, cullDist });
    map.set(kind, list);
  };

  // Lamp: pole + arm (head is a separate emissive instanced mesh)
  add('lamp', merged([cyl(0x3a3f45, 0.09, 0.13, 6), box(0x3a3f45, 0.12, 0.12, 1.7, 0, 5.75, 0.85), cyl(0x2a2e33, 0.25, 0.3, 0.25)]), metal);
  // Traffic light: pole + arm + housing (lens separate)
  add('trafficlight', merged([cyl(0x2f3338, 0.08, 0.1, 5), box(0x2f3338, 0.1, 0.1, 2.2, 0, 4.85, 1.1), box(0x1b1d20, 0.3, 0.9, 0.3, 0, 3.9, 2.2)]), metal);
  // Trees: round and conical
  add('tree', merged([cyl(0x6b4a2b, 0.16, 0.24, 2.4), sphere(0x3f7a2b, 1.7, 0, 3.4, 0, 1.15), sphere(0x4d8a34, 1.1, 0.6, 4.2, 0.3, 1)]), foliage);
  add('tree', merged([cyl(0x5f4326, 0.14, 0.22, 2.0), cone(0x2f6b2a, 1.6, 2.6, 0, 1.6), cone(0x3a7a30, 1.25, 2.2, 0, 3.2), cone(0x458a38, 0.85, 1.8, 0, 4.6)]), foliage);
  // Palm: tilted trunk + fronds
  {
    const parts: THREE.BufferGeometry[] = [xform(colorize(new THREE.CylinderGeometry(0.12, 0.22, 7, 7), 0x8a6a3c), 0, 3.5, 0, 0, 1, 1, 1, 0, 0.08)];
    for (let i = 0; i < 7; i++) {
      const a = (i / 7) * Math.PI * 2;
      const frond = new THREE.BoxGeometry(0.5, 0.06, 2.6);
      colorize(frond, 0x3f8a3a);
      xform(frond, Math.sin(a) * 1.2 + 0.55, 6.9 - Math.abs(Math.cos(a)) * 0.2, Math.cos(a) * 1.2, a, 1, 1, 1, -0.55, 0);
      parts.push(frond);
    }
    add('palm', merged(parts), foliage);
  }
  add('bush', merged([sphere(0x3f7a2b, 0.7, 0, 0.55, 0, 0.8), sphere(0x4a8a33, 0.5, 0.5, 0.45, 0.2, 0.8)]), foliage, false, 200);
  add('bench', merged([box(0x7a5a3a, 1.8, 0.08, 0.5, 0, 0.45, 0), box(0x7a5a3a, 1.8, 0.45, 0.08, 0, 0.5, -0.24), box(0x2c2c2c, 0.08, 0.45, 0.5, -0.8, 0, 0), box(0x2c2c2c, 0.08, 0.45, 0.5, 0.8, 0, 0)]), std, false, 220);
  add('hydrant', merged([cyl(0xc0392b, 0.16, 0.18, 0.75), sphere(0xc0392b, 0.17, 0, 0.78, 0), box(0xc0392b, 0.5, 0.12, 0.12, 0, 0.45, 0)]), std, false, 160);
  add('trash', merged([cyl(0x2f4f3f, 0.32, 0.28, 1.0), cyl(0x1f2f27, 0.34, 0.34, 0.08, 0, 1.0, 0)]), std, false, 160);
  add('bollard', cyl(0x333333, 0.13, 0.15, 0.9), metal, false, 120);
  add('sign', merged([cyl(0x555555, 0.05, 0.05, 2.6), box(0x1e5aa8, 0.7, 0.7, 0.05, 0, 2.2, 0)]), metal, false, 160);
  // Container (instanceColor tints the whole thing)
  add('container', merged([box(0xffffff, 6.06, 2.59, 2.44), box(0xdddddd, 6.1, 0.1, 2.5, 0, 2.5, 0)]), std, true, 500);
  add('crate', merged([box(0xa07a4a, 1.4, 1.4, 1.4), box(0x7a5a34, 1.45, 0.1, 1.45, 0, 0.65, 0)]), std, true, 220);
  add('fence', merged([box(0x9aa0a6, 6, 1.9, 0.04, 0, 0.1, 0), cyl(0x6c757d, 0.05, 0.05, 2.0, -3, 0, 0, 6), cyl(0x6c757d, 0.05, 0.05, 2.0, 3, 0, 0, 6), box(0x6c757d, 6, 0.05, 0.05, 0, 1.95, 0)]), fenceMat, false, 260);
  add('billboard', merged([cyl(0x444444, 0.18, 0.2, 5.5, -3, 0, 0, 6), cyl(0x444444, 0.18, 0.2, 5.5, 3, 0, 0, 6), box(0x2a2a2a, 8.3, 4.3, 0.3, 0, 5.3, -0.05)]), metal, true, PROP_CULL_FAR);
  add('crane', merged([box(0xf1c40f, 2.2, 30, 2.2), box(0xf1c40f, 44, 1.4, 1.4, 12, 30, 0), box(0xf1c40f, 10, 1.6, 1.8, -8, 29.6, 0), box(0x333333, 2.4, 2.2, 2.6, 2, 27, 0), box(0x777777, 3, 2.5, 3, -11, 28.6, 0), cyl(0x222222, 0.05, 0.05, 20, 30, 10, 0, 4)]), metal, true, PROP_CULL_FAR);
  add(
    'ship',
    merged([
      box(0x8b1e1e, 90, 9, 18, 0, -2, 0),
      box(0x9c9c9c, 90, 0.6, 18, 0, 7, 0),
      box(0xf0f0f0, 14, 10, 12, -32, 7.6, 0),
      box(0xdcdcdc, 10, 5, 8, -32, 17.6, 0),
      cyl(0xc0392b, 1.4, 1.6, 6, -28, 22.6, 0),
      box(0x2980b9, 6.06, 2.59, 2.44, -6, 7.6, -4),
      box(0xe67e22, 6.06, 2.59, 2.44, 0.5, 7.6, -4),
      box(0x27ae60, 6.06, 2.59, 2.44, 7, 7.6, -4),
      box(0xecf0f1, 6.06, 2.59, 2.44, 14, 7.6, -4),
      box(0x8e44ad, 6.06, 2.59, 2.44, -6, 7.6, 4),
      box(0xf1c40f, 6.06, 2.59, 2.44, 0.5, 7.6, 4),
      box(0x2980b9, 6.06, 2.59, 2.44, 7, 10.2, 4),
      box(0xe67e22, 6.06, 2.59, 2.44, 14, 7.6, 4),
      box(0x27ae60, 6.06, 2.59, 2.44, 22, 7.6, 0),
    ]),
    std,
    true,
    PROP_CULL_FAR,
  );
  {
    const fus = new THREE.CylinderGeometry(1.5, 1.5, 22, 12);
    colorize(fus, 0xf4f4f4);
    xform(fus, 0, 2.4, 0, 0, 1, 1, 1, Math.PI / 2, 0);
    const nose = new THREE.SphereGeometry(1.5, 10, 8);
    colorize(nose, 0xf4f4f4);
    xform(nose, 0, 2.4, 11);
    add('plane', merged([fus, nose, box(0xf4f4f4, 26, 0.35, 4, 0, 1.9, -1), box(0xf4f4f4, 9, 0.3, 2.6, 0, 3.2, -10), box(0x1e5aa8, 0.3, 4.5, 3.2, 0, 3.2, -10.5), cyl(0x333333, 0.9, 0.9, 3.4, -5, 0.6, 0, 8), cyl(0x333333, 0.9, 0.9, 3.4, 5, 0.6, 0, 8), cyl(0x222222, 0.35, 0.35, 0.3, 0, 0, 7.5, 8), cyl(0x222222, 0.4, 0.4, 0.3, -3, 0, -1, 8), cyl(0x222222, 0.4, 0.4, 0.3, 3, 0, -1, 8), box(0x1e5aa8, 22, 0.5, 0.1, 0, 2.7, 1.51)]), std, true, PROP_CULL_FAR);
  }
  {
    const roof = new THREE.CylinderGeometry(12, 12, 32, 16, 1, false, 0, Math.PI);
    colorize(roof, 0x8d949b);
    xform(roof, 0, 6, 0, 0, 1, 1, 0.75, 0, Math.PI / 2);
    add('hangar', merged([box(0x7f878f, 32, 6, 24), roof, box(0x3b4046, 20, 8, 0.4, 0, 0, 12.1)]), std, true, PROP_CULL_FAR);
  }
  add('tower', merged([box(0xb8b8b8, 7, 20, 7), box(0x3d4b5c, 10, 3.6, 10, 0, 20, 0), box(0xdddddd, 10.4, 0.5, 10.4, 0, 23.6, 0), cyl(0xff3333, 0.1, 0.1, 3, 0, 24.1, 0, 4)]), std, true, PROP_CULL_FAR);
  add('hut', merged([box(0xf5d76e, 3.4, 2.6, 3.4), cone(0xc0392b, 2.9, 1.6, 0, 2.6, 0, 4)]), std, true, 400);
  add('hut', merged([box(0x74b9ff, 3.4, 2.6, 3.4), cone(0x2d3436, 2.9, 1.6, 0, 2.6, 0, 4)]), std, true, 400);
  {
    // Pier: 100 m deck along X (scaled by instance), posts and rails
    const parts: THREE.BufferGeometry[] = [box(0x8a6a44, 100, 0.35, 8, 0, -0.35, 0)];
    for (let x = -45; x <= 45; x += 10) {
      parts.push(cyl(0x5a4630, 0.3, 0.3, 3, x, -3.2, -3.2, 6), cyl(0x5a4630, 0.3, 0.3, 3, x, -3.2, 3.2, 6));
      parts.push(cyl(0x6a5636, 0.06, 0.06, 1.1, x, 0, -3.9, 4), cyl(0x6a5636, 0.06, 0.06, 1.1, x, 0, 3.9, 4));
    }
    parts.push(box(0x6a5636, 100, 0.08, 0.08, 0, 1.05, -3.9), box(0x6a5636, 100, 0.08, 0.08, 0, 1.05, 3.9));
    add('pier', merged(parts), std, true, PROP_CULL_FAR);
  }
  add('fountain', merged([cyl(0xbfbfbf, 4.5, 4.7, 0.8, 0, 0, 0, 20), cyl(0x3b8fd6, 4.1, 4.1, 0.05, 0, 0.8, 0, 20), cyl(0xbfbfbf, 0.5, 0.7, 2.6, 0, 0.8, 0, 10), cyl(0xbfbfbf, 1.6, 1.4, 0.3, 0, 2.6, 0, 14)]), std, true, 400);
  return map;
}

// ------------------------------------------------------------------ renderer
interface ChunkView {
  rec: ChunkRecord;
  group: THREE.Group;
  centerX: number;
  centerZ: number;
  propMeshes: { mesh: THREE.InstancedMesh; cullDist: number }[];
  visible: boolean;
}

interface LightPool {
  mesh: THREE.InstancedMesh;
}

export class WorldRenderer {
  readonly root = new THREE.Group();
  private facadeMats: THREE.MeshStandardMaterial[] = [];
  private lampHeadMat = new THREE.MeshStandardMaterial({ color: 0xfff2c8, emissive: 0xffd28a, emissiveIntensity: 0, roughness: 0.4 });
  private lensMat = new THREE.MeshStandardMaterial({ color: 0x222222, emissive: 0xffffff, emissiveIntensity: 1.4, roughness: 0.3 });
  private poolMat = new THREE.MeshBasicMaterial({ map: glowTexture(), transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, color: 0xffd9a0 });
  private waterMats: THREE.MeshStandardMaterial[] = [];
  private chunks: ChunkView[] = [];
  private propVariants: Map<PropKind, PropVariant[]>;
  private propInstance = new Map<number, { mesh: THREE.InstancedMesh; index: number }>();
  private lensInstances: { mesh: THREE.InstancedMesh; index: number; node: RoadNode; axisNS: boolean }[] = [];
  private lightPools: LightPool[] = [];
  private lampHeads: THREE.InstancedMesh[] = [];
  private night = 0;
  private dummy = new THREE.Object3D();
  private colorTmp = new THREE.Color();
  private lensBuf: THREE.InstancedMesh[] = [];

  constructor(public readonly world: WorldData) {
    this.propVariants = buildPropVariants();
    this.buildMaterials();
    this.buildGround();
    this.buildRoads();
    this.buildChunks();
    this.buildWater();
  }

  private buildMaterials(): void {
    for (let i = 0; i < FACADE_STYLES.length; i++) {
      const mat = new THREE.MeshStandardMaterial({
        map: facadeTexture(i, i * 7),
        emissiveMap: facadeTexture(i, i * 7, true),
        emissive: new THREE.Color(0xffe2b0),
        emissiveIntensity: 0,
        roughness: 0.7,
        metalness: 0.15,
      });
      this.facadeMats.push(mat);
    }
  }

  private groundMaterial(kind: SlabRecord['top']): THREE.MeshStandardMaterial {
    const cache = (this as unknown as { _gm?: Map<string, THREE.MeshStandardMaterial> })._gm ?? new Map<string, THREE.MeshStandardMaterial>();
    (this as unknown as { _gm?: Map<string, THREE.MeshStandardMaterial> })._gm = cache;
    let m = cache.get(kind);
    if (m) return m;
    const tex = kind === 'grass' ? grassTexture() : kind === 'sand' ? sandTexture() : kind === 'dirt' ? dirtTexture() : kind === 'asphalt' ? asphaltTexture() : concreteTexture();
    m = new THREE.MeshStandardMaterial({ map: tex, roughness: 1, metalness: 0 });
    cache.set(kind, m);
    return m;
  }

  private buildGround(): void {
    // Fallback dark ground under everything (west of the shoreline) so gaps never show the sky.
    const g = flatRect(-2400, -2400, SHORE_X, 2400, -0.06, 50);
    const mesh = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ map: dirtTexture(), color: 0x6b6b6b, roughness: 1 }));
    mesh.receiveShadow = true;
    this.root.add(mesh);
  }

  private buildRoads(): void {
    const roads = this.world.roads as GridRoadNetwork;
    const asphalt: THREE.BufferGeometry[] = [];
    const yellow: THREE.BufferGeometry[] = [];
    const white: THREE.BufferGeometry[] = [];
    const seen = new Set<number>();
    for (const e of roads.edges) {
      if (seen.has(e.twin)) continue;
      seen.add(e.id);
      const a = roads.nodes[e.from];
      const b = roads.nodes[e.to];
      const cutA = lineHalfWidth(e.alongX ? a.gx : a.gz);
      const cutB = lineHalfWidth(e.alongX ? b.gx : b.gz);
      const len = e.length - cutA - cutB;
      if (len <= 0) continue;
      const cx = a.x + e.dx * (cutA + len / 2);
      const cz = a.z + e.dz * (cutA + len / 2);
      const yaw = Math.atan2(e.dx, e.dz);
      asphalt.push(flatRectRot(cx, cz, e.halfWidth, len / 2, yaw, ROAD_Y, 8));
      // Centre line
      if (e.isAvenue) {
        yellow.push(flatRectRot(cx, cz, 0.12, len / 2, yaw, MARK_Y, 1));
        // dashed lane dividers at ±3.5 m
        for (const side of [1, -1]) {
          const [rx, rz] = rightOf(e.dx, e.dz);
          for (let t = 2; t < len - 2; t += 8) {
            const px = a.x + e.dx * (cutA + t + 1.5) + rx * 3.5 * side;
            const pz = a.z + e.dz * (cutA + t + 1.5) + rz * 3.5 * side;
            white.push(flatRectRot(px, pz, 0.08, 1.5, yaw, MARK_Y, 1));
          }
        }
        // edge lines
        for (const side of [1, -1]) {
          const [rx, rz] = rightOf(e.dx, e.dz);
          white.push(flatRectRot(cx + rx * (e.halfWidth - 0.3) * side, cz + rz * (e.halfWidth - 0.3) * side, 0.08, len / 2, yaw, MARK_Y, 1));
        }
      } else {
        for (let t = 1; t < len - 1; t += 9) {
          const px = a.x + e.dx * (cutA + t + 1.5);
          const pz = a.z + e.dz * (cutA + t + 1.5);
          yellow.push(flatRectRot(px, pz, 0.07, 1.5, yaw, MARK_Y, 1));
        }
      }
    }
    // Intersections + crosswalks
    for (const n of roads.nodes) {
      const hx = lineHalfWidth(n.gx);
      const hz = lineHalfWidth(n.gz);
      asphalt.push(flatRect(n.x - hx, n.z - hz, n.x + hx, n.z + hz, ROAD_Y, 8));
      if (!n.hasSignal && !(isAvenueLine(n.gx) || isAvenueLine(n.gz))) continue;
      // zebra stripes on each approach that has a road
      for (const eid of n.out) {
        const e = roads.edges[eid];
        const along = e.alongX ? hx : hz; // distance from node centre to the crosswalk
        const across = e.alongX ? hz : hx; // half width of the road being crossed
        const [rx, rz] = rightOf(e.dx, e.dz);
        const bx = n.x + e.dx * (along + 1.6);
        const bz = n.z + e.dz * (along + 1.6);
        for (let s = -across + 0.6; s < across - 0.4; s += 1.1) {
          white.push(flatRectRot(bx + rx * s, bz + rz * s, 0.28, 1.2, Math.atan2(e.dx, e.dz), MARK_Y, 1));
        }
        // stop line
        white.push(flatRectRot(n.x + e.dx * (along + 3.4) + rx * across * 0.5, n.z + e.dz * (along + 3.4) + rz * across * 0.5, across * 0.48, 0.2, Math.atan2(e.dx, e.dz), MARK_Y, 1));
      }
    }
    const asphaltMesh = new THREE.Mesh(mergeOrNull(asphalt)!, new THREE.MeshStandardMaterial({ map: asphaltTexture(), roughness: 0.95, metalness: 0 }));
    asphaltMesh.receiveShadow = true;
    this.root.add(asphaltMesh);
    const markMat = (hex: number) => new THREE.MeshBasicMaterial({ color: hex, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
    const ym = mergeOrNull(yellow);
    if (ym) this.root.add(new THREE.Mesh(ym, markMat(0xe8c14a)));
    const wm = mergeOrNull(white);
    if (wm) this.root.add(new THREE.Mesh(wm, markMat(0xe6e6e6)));
  }

  private buildChunks(): void {
    const roads = this.world.roads as GridRoadNetwork;
    // Assign slabs/decals to chunks by centre
    const chunkFor = (x: number, z: number): ChunkRecord | null => {
      for (const c of this.world.chunks) if (x >= c.minX && x < c.maxX && z >= c.minZ && z < c.maxZ) return c;
      return null;
    };
    const slabsByChunk = new Map<ChunkRecord, SlabRecord[]>();
    for (const s of this.world.slabs) {
      const c = chunkFor((s.minX + s.maxX) / 2, (s.minZ + s.maxZ) / 2) ?? this.world.chunks[0];
      (slabsByChunk.get(c) ?? slabsByChunk.set(c, []).get(c)!).push(s);
    }
    const decalsByChunk = new Map<ChunkRecord, DecalRecord[]>();
    for (const d of this.world.decals) {
      const c = chunkFor((d.minX + d.maxX) / 2, (d.minZ + d.maxZ) / 2) ?? this.world.chunks[0];
      (decalsByChunk.get(c) ?? decalsByChunk.set(c, []).get(c)!).push(d);
    }
    const roofMat = new THREE.MeshStandardMaterial({ map: roofTexture(), roughness: 0.9 });
    const sidewalkMat = new THREE.MeshStandardMaterial({ map: sidewalkTexture(), roughness: 0.95 });
    const plankMat = new THREE.MeshStandardMaterial({ map: plankTexture(), roughness: 0.9 });
    const plazaMat = new THREE.MeshStandardMaterial({ map: plazaTexture(), roughness: 0.9 });
    const asphaltMat = new THREE.MeshStandardMaterial({ map: asphaltTexture(), roughness: 0.95 });
    const whiteMat = new THREE.MeshBasicMaterial({ color: 0xe6e6e6, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
    const lampHeadGeo = new THREE.BoxGeometry(0.5, 0.22, 0.7);
    lampHeadGeo.translate(0, 5.7, 1.65);
    const lensGeo = new THREE.BoxGeometry(0.22, 0.6, 0.12);
    lensGeo.translate(0, 3.9, 2.38);
    const poolGeo = new THREE.PlaneGeometry(14, 14);
    poolGeo.rotateX(-Math.PI / 2);
    poolGeo.translate(0, 0.2, 1.6);

    for (const rec of this.world.chunks) {
      const group = new THREE.Group();
      const view: ChunkView = { rec, group, centerX: (rec.minX + rec.maxX) / 2, centerZ: (rec.minZ + rec.maxZ) / 2, propMeshes: [], visible: true };
      // --- slabs
      const ringGeos: THREE.BufferGeometry[] = [];
      const topGeos = new Map<SlabRecord['top'], THREE.BufferGeometry[]>();
      for (const s of slabsByChunk.get(rec) ?? []) {
        const w = s.maxX - s.minX;
        const d = s.maxZ - s.minZ;
        if (w <= 0 || d <= 0) continue;
        ringGeos.push(texturedBox((s.minX + s.maxX) / 2, (s.minZ + s.maxZ) / 2, -0.05, w, SIDEWALK_HEIGHT + 0.05, d, 4));
        if (s.ring && w > SIDEWALK_WIDTH * 2 + 2 && d > SIDEWALK_WIDTH * 2 + 2) {
          const list = topGeos.get(s.top) ?? topGeos.set(s.top, []).get(s.top)!;
          list.push(flatRect(s.minX + SIDEWALK_WIDTH, s.minZ + SIDEWALK_WIDTH, s.maxX - SIDEWALK_WIDTH, s.maxZ - SIDEWALK_WIDTH, SIDEWALK_HEIGHT + 0.006, s.top === 'grass' ? 6 : 4));
        }
      }
      const ring = mergeOrNull(ringGeos);
      if (ring) {
        const m = new THREE.Mesh(ring, sidewalkMat);
        m.receiveShadow = true;
        group.add(m);
      }
      for (const [kind, list] of topGeos) {
        const g = mergeOrNull(list);
        if (!g) continue;
        const m = new THREE.Mesh(g, this.groundMaterial(kind));
        m.receiveShadow = true;
        group.add(m);
      }
      // --- decals
      const decalLists = new Map<THREE.Material, THREE.BufferGeometry[]>();
      const pushDecal = (mat: THREE.Material, g: THREE.BufferGeometry) => (decalLists.get(mat) ?? decalLists.set(mat, []).get(mat)!).push(g);
      for (const d of decalsByChunk.get(rec) ?? []) {
        switch (d.kind) {
          case 'path':
            pushDecal(sidewalkMat, flatRect(d.minX, d.minZ, d.maxX, d.maxZ, DECAL_Y, 4));
            break;
          case 'boardwalk':
            pushDecal(plankMat, flatRect(d.minX, d.minZ, d.maxX, d.maxZ, DECAL_Y, 4));
            break;
          case 'plaza':
            pushDecal(plazaMat, flatRect(d.minX, d.minZ, d.maxX, d.maxZ, DECAL_Y, 6));
            break;
          case 'parking':
            pushDecal(asphaltMat, flatRect(d.minX, d.minZ, d.maxX, d.maxZ, DECAL_Y, 8));
            for (let x = d.minX + 3; x < d.maxX - 1; x += 3.2) pushDecal(whiteMat, flatRect(x - 0.06, d.minZ + 1, x + 0.06, Math.min(d.maxZ - 1, d.minZ + 7), DECAL_Y + 0.01, 1));
            break;
          case 'runway': {
            pushDecal(asphaltMat, flatRect(d.minX, d.minZ, d.maxX, d.maxZ, DECAL_Y, 8));
            const cz = (d.minZ + d.maxZ) / 2;
            for (let x = d.minX + 20; x < d.maxX - 20; x += 24) pushDecal(whiteMat, flatRect(x, cz - 0.4, x + 12, cz + 0.4, DECAL_Y + 0.01, 1));
            for (const x0 of [d.minX + 4, d.maxX - 12]) for (let k = -5; k <= 5; k++) pushDecal(whiteMat, flatRect(x0, cz + k * 2.4 - 0.6, x0 + 8, cz + k * 2.4 + 0.6, DECAL_Y + 0.01, 1));
            break;
          }
          case 'taxiway':
            pushDecal(asphaltMat, flatRect(d.minX, d.minZ, d.maxX, d.maxZ, DECAL_Y, 8));
            break;
          case 'helipad': {
            pushDecal(asphaltMat, flatRect(d.minX, d.minZ, d.maxX, d.maxZ, DECAL_Y, 8));
            const cx = (d.minX + d.maxX) / 2;
            const cz = (d.minZ + d.maxZ) / 2;
            const ring = new THREE.RingGeometry(6, 6.8, 24);
            ring.rotateX(-Math.PI / 2);
            ring.translate(cx, DECAL_Y + 0.01, cz);
            pushDecal(whiteMat, ring);
            pushDecal(whiteMat, flatRect(cx - 3, cz - 0.5, cx + 3, cz + 0.5, DECAL_Y + 0.01, 1));
            pushDecal(whiteMat, flatRect(cx - 3.2, cz - 3.5, cx - 2.2, cz + 3.5, DECAL_Y + 0.01, 1));
            pushDecal(whiteMat, flatRect(cx + 2.2, cz - 3.5, cx + 3.2, cz + 3.5, DECAL_Y + 0.01, 1));
            break;
          }
        }
      }
      for (const [mat, list] of decalLists) {
        const g = mergeOrNull(list);
        if (!g) continue;
        const m = new THREE.Mesh(g, mat);
        m.receiveShadow = true;
        group.add(m);
      }
      // --- buildings
      const byStyle = new Map<number, THREE.BufferGeometry[]>();
      const roofs: THREE.BufferGeometry[] = [];
      for (const b of rec.buildings) this.buildBuildingGeometry(b, byStyle, roofs);
      for (const [style, list] of byStyle) {
        const g = mergeOrNull(list);
        if (!g) continue;
        const m = new THREE.Mesh(g, this.facadeMats[style]);
        m.castShadow = true;
        m.receiveShadow = true;
        group.add(m);
      }
      const roofG = mergeOrNull(roofs);
      if (roofG) {
        const m = new THREE.Mesh(roofG, roofMat);
        m.castShadow = true;
        m.receiveShadow = true;
        group.add(m);
      }
      // --- props (instanced per kind/variant)
      const byVariant = new Map<PropVariant, PropRecord[]>();
      const lamps: PropRecord[] = [];
      const lights: PropRecord[] = [];
      const billboards: PropRecord[] = [];
      for (const p of rec.props) {
        const variants = this.propVariants.get(p.kind);
        if (!variants) continue;
        const v = variants[p.id % variants.length];
        (byVariant.get(v) ?? byVariant.set(v, []).get(v)!).push(p);
        if (p.kind === 'lamp') lamps.push(p);
        if (p.kind === 'trafficlight') lights.push(p);
        if (p.kind === 'billboard') billboards.push(p);
      }
      for (const [v, list] of byVariant) {
        const mesh = new THREE.InstancedMesh(v.geo, v.material, list.length);
        mesh.castShadow = v.castShadow;
        mesh.receiveShadow = true;
        mesh.frustumCulled = true;
        for (let i = 0; i < list.length; i++) {
          const p = list[i];
          this.dummy.position.set(p.x, p.y, p.z);
          this.dummy.rotation.set(0, p.yaw, 0);
          const sc = p.kind === 'pier' ? 1 : p.scale;
          this.dummy.scale.set(p.kind === 'pier' ? p.scale : sc, sc, sc);
          this.dummy.updateMatrix();
          mesh.setMatrixAt(i, this.dummy.matrix);
          p.instanceIndex = i;
          this.propInstance.set(p.id, { mesh, index: i });
          if (p.kind === 'container') {
            const palette = [0xc0392b, 0x2980b9, 0x27ae60, 0xe67e22, 0x8e44ad, 0x7f8c8d, 0xf1c40f, 0x16a085];
            mesh.setColorAt(i, this.colorTmp.setHex(palette[p.id % palette.length]));
          } else if (p.kind === 'tree' || p.kind === 'bush' || p.kind === 'palm') {
            const t = 0.85 + ((p.id * 37) % 100) / 100 * 0.3;
            mesh.setColorAt(i, this.colorTmp.setRGB(t, t * (0.95 + ((p.id * 13) % 10) / 100), t * 0.9));
          } else if (p.kind === 'hut') {
            mesh.setColorAt(i, this.colorTmp.setHSL(((p.id * 0.37) % 1), 0.6, 0.6));
          }
        }
        mesh.instanceMatrix.needsUpdate = true;
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
        mesh.computeBoundingSphere();
        group.add(mesh);
        view.propMeshes.push({ mesh, cullDist: v.cullDist });
      }
      // lamp heads + light pools
      if (lamps.length) {
        const heads = new THREE.InstancedMesh(lampHeadGeo, this.lampHeadMat, lamps.length);
        const pools = new THREE.InstancedMesh(poolGeo, this.poolMat, lamps.length);
        pools.renderOrder = 5;
        for (let i = 0; i < lamps.length; i++) {
          const p = lamps[i];
          this.dummy.position.set(p.x, p.y, p.z);
          this.dummy.rotation.set(0, p.yaw, 0);
          this.dummy.scale.set(p.scale, p.scale, p.scale);
          this.dummy.updateMatrix();
          heads.setMatrixAt(i, this.dummy.matrix);
          this.dummy.scale.set(1, 1, 1);
          this.dummy.updateMatrix();
          pools.setMatrixAt(i, this.dummy.matrix);
        }
        heads.instanceMatrix.needsUpdate = true;
        pools.instanceMatrix.needsUpdate = true;
        heads.computeBoundingSphere();
        pools.computeBoundingSphere();
        group.add(heads, pools);
        this.lampHeads.push(heads);
        this.lightPools.push({ mesh: pools });
        view.propMeshes.push({ mesh: heads, cullDist: PROP_CULL_NEAR }, { mesh: pools, cullDist: 300 });
      }
      // traffic-light lenses (colour updated per frame)
      if (lights.length) {
        const lens = new THREE.InstancedMesh(lensGeo, this.lensMat, lights.length);
        for (let i = 0; i < lights.length; i++) {
          const p = lights[i];
          this.dummy.position.set(p.x, p.y, p.z);
          this.dummy.rotation.set(0, p.yaw, 0);
          this.dummy.scale.set(1, 1, 1);
          this.dummy.updateMatrix();
          lens.setMatrixAt(i, this.dummy.matrix);
          lens.setColorAt(i, this.colorTmp.setHex(0xff2222));
          const node = roads.nearestNode(p.x, p.z);
          // Poles with yaw 0/π face along Z → they signal traffic travelling along Z (NS).
          const axisNS = Math.abs(Math.sin(p.yaw)) < 0.5;
          this.lensInstances.push({ mesh: lens, index: i, node, axisNS });
        }
        lens.instanceMatrix.needsUpdate = true;
        lens.computeBoundingSphere();
        group.add(lens);
        this.lensBuf.push(lens);
        view.propMeshes.push({ mesh: lens, cullDist: PROP_CULL_NEAR });
      }
      // billboard faces (textured)
      if (billboards.length) {
        const faceGeo = new THREE.PlaneGeometry(8, 4);
        faceGeo.translate(0, 5.3, 0.12);
        const byVar = new Map<number, PropRecord[]>();
        for (const p of billboards) (byVar.get(p.id % 6) ?? byVar.set(p.id % 6, []).get(p.id % 6)!).push(p);
        for (const [variant, list] of byVar) {
          const mat = new THREE.MeshStandardMaterial({ map: billboardTexture(variant), emissiveMap: billboardTexture(variant), emissive: new THREE.Color(0xffffff), emissiveIntensity: 0, roughness: 0.6 });
          this.facadeMats.push(mat); // participates in the night fade
          const faces = new THREE.InstancedMesh(faceGeo, mat, list.length);
          for (let i = 0; i < list.length; i++) {
            const p = list[i];
            this.dummy.position.set(p.x, p.y, p.z);
            this.dummy.rotation.set(0, p.yaw, 0);
            this.dummy.scale.set(1, 1, 1);
            this.dummy.updateMatrix();
            faces.setMatrixAt(i, this.dummy.matrix);
          }
          faces.instanceMatrix.needsUpdate = true;
          faces.computeBoundingSphere();
          group.add(faces);
          view.propMeshes.push({ mesh: faces, cullDist: PROP_CULL_FAR });
        }
      }
      this.root.add(group);
      this.chunks.push(view);
    }
  }

  private buildBuildingGeometry(b: BuildingRecord, byStyle: Map<number, THREE.BufferGeometry[]>, roofs: THREE.BufferGeometry[]): void {
    const st = FACADE_STYLES[b.style % FACADE_STYLES.length];
    const winW = 3.2 * st.cols;
    const floorH = 3.4 * st.rows;
    const list = byStyle.get(b.style) ?? byStyle.set(b.style, []).get(b.style)!;
    let y = SIDEWALK_HEIGHT;
    list.push(wallsGeometry(b.x, b.z, y, b.w, b.h, b.d, winW, floorH));
    let topW = b.w;
    let topD = b.d;
    y += b.h;
    roofs.push(flatRect(b.x - b.w / 2, b.z - b.d / 2, b.x + b.w / 2, b.z + b.d / 2, y, 6));
    // parapet
    roofs.push(texturedBox(b.x, b.z - b.d / 2 + 0.25, y, b.w, 0.9, 0.5, 6), texturedBox(b.x, b.z + b.d / 2 - 0.25, y, b.w, 0.9, 0.5, 6), texturedBox(b.x - b.w / 2 + 0.25, b.z, y, 0.5, 0.9, b.d, 6), texturedBox(b.x + b.w / 2 - 0.25, b.z, y, 0.5, 0.9, b.d, 6));
    if (b.tiers) {
      for (const t of b.tiers) {
        list.push(wallsGeometry(b.x, b.z, y, t.w, t.h, t.d, winW, floorH));
        y += t.h;
        roofs.push(flatRect(b.x - t.w / 2, b.z - t.d / 2, b.x + t.w / 2, b.z + t.d / 2, y, 6));
        topW = t.w;
        topD = t.d;
      }
    }
    if (b.hasRoofBox && topW > 8 && topD > 8) {
      roofs.push(texturedBox(b.x + topW * 0.2, b.z - topD * 0.15, y, 3.2, 2.8, 3.2, 3));
      roofs.push(texturedBox(b.x - topW * 0.25, b.z + topD * 0.2, y, 2.2, 1.4, 2.2, 3));
    }
    if (b.hasAntenna) {
      const ant = new THREE.CylinderGeometry(0.12, 0.2, Math.min(18, b.h * 0.2 + 6), 5);
      ant.translate(b.x, y + Math.min(18, b.h * 0.2 + 6) / 2, b.z);
      roofs.push(ant);
    }
  }

  private buildWater(): void {
    for (const w of this.world.water) {
      const big = w.maxX - w.minX > 500;
      const mat = new THREE.MeshStandardMaterial({ map: waterTexture(), color: big ? 0x2a6f9e : 0x3a86b8, transparent: true, opacity: big ? 0.92 : 0.85, roughness: 0.25, metalness: 0.3 });
      this.waterMats.push(mat);
      const y = big ? WATER_Y : SIDEWALK_HEIGHT + 0.02;
      const g = flatRect(w.minX, w.minZ, w.maxX, w.maxZ, y, 24);
      const mesh = new THREE.Mesh(g, mat);
      mesh.receiveShadow = true;
      mesh.renderOrder = 1;
      this.root.add(mesh);
    }
  }

  /** Night factor 0 (day) .. 1 (night). */
  setNight(f: number): void {
    if (Math.abs(f - this.night) < 0.002) return;
    this.night = f;
    for (const m of this.facadeMats) m.emissiveIntensity = f * 1.1;
    this.lampHeadMat.emissiveIntensity = f * 2.2;
    this.poolMat.opacity = f * 0.5;
  }

  /** Per-frame: chunk distance culling, water scroll, traffic-light lenses. */
  update(camX: number, camZ: number, time: number, dt: number): void {
    for (const c of this.chunks) {
      const dx = Math.max(0, Math.abs(camX - c.centerX) - BLOCK_PITCH * 1.5);
      const dz = Math.max(0, Math.abs(camZ - c.centerZ) - BLOCK_PITCH * 1.5);
      const d = Math.hypot(dx, dz);
      const vis = d < 1300;
      if (vis !== c.visible) {
        c.visible = vis;
        c.group.visible = vis;
      }
      if (!vis) continue;
      for (const pm of c.propMeshes) pm.mesh.visible = d < pm.cullDist;
    }
    for (const m of this.waterMats) {
      if (m.map) {
        m.map.offset.x += dt * 0.006;
        m.map.offset.y += dt * 0.004;
      }
    }
    const roads = this.world.roads as GridRoadNetwork;
    for (const li of this.lensInstances) {
      if (!li.mesh.visible) continue;
      const st = roads.signalState(li.node, time);
      const green = (st === 'ns' && li.axisNS) || (st === 'ew' && !li.axisNS);
      li.mesh.setColorAt(li.index, this.colorTmp.setHex(green ? 0x22ff44 : 0xff2222));
    }
    for (const lens of this.lensBuf) if (lens.visible && lens.instanceColor) lens.instanceColor.needsUpdate = true;
  }

  /** Hide a destroyed prop instance (collapse its matrix to zero scale). */
  destroyProp(p: PropRecord): void {
    const inst = this.propInstance.get(p.id);
    if (!inst) return;
    this.dummy.position.set(p.x, -50, p.z);
    this.dummy.rotation.set(0, 0, 0);
    this.dummy.scale.set(0.0001, 0.0001, 0.0001);
    this.dummy.updateMatrix();
    inst.mesh.setMatrixAt(inst.index, this.dummy.matrix);
    inst.mesh.instanceMatrix.needsUpdate = true;
    p.destroyed = true;
  }

  /** Tilt a prop (e.g. a knocked-over lamp) — cheap visual for impacts. */
  tiltProp(p: PropRecord, pitch: number, roll: number): void {
    const inst = this.propInstance.get(p.id);
    if (!inst) return;
    this.dummy.position.set(p.x, p.y, p.z);
    this.dummy.rotation.set(pitch, p.yaw, roll);
    this.dummy.scale.set(p.scale, p.scale, p.scale);
    this.dummy.updateMatrix();
    inst.mesh.setMatrixAt(inst.index, this.dummy.matrix);
    inst.mesh.instanceMatrix.needsUpdate = true;
  }

  get pierDeckY(): number {
    return PIER_DECK_Y;
  }

  dispose(): void {
    this.root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.geometry) m.geometry.dispose();
    });
  }
}
