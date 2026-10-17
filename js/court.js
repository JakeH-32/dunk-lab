// Live menu background: the Dunk Lab court rendered in real time with WebGL2. A port of the offline renderer
// Tools/Brand/court_render.py in the Unreal project (same pinhole camera, world units and shading maths), so a
// camera written for one works in the other and the camera can be animated (animateTo).
//
// World: metres, y up. Hoop-end baseline at x = 0, court at x < 0 (midcourt x = -14.33), sidelines z = +-7.62.
// Camera: position, yaw (deg; 0 looks along -z across the court, + turns toward the hoop at +x), pitch (deg, down),
// focal length f in px for a 2560 px wide frame (or fovY in degrees for the 2560x1440 reference frame).
// The canvas shows that 2560x1440 frame scaled like CSS `background-size: cover` (centred), the way the old
// static background.jpg was shown: f_canvas = f * max(W / 2560, H / 1440), principal point at the canvas centre.
//
// Passes (all on demand: nothing runs while the camera is still):
//   1. Hoop line art, into textures the size of the hoop's screen box. The geometry (hoop_scene() in the Python)
//      is projected on the CPU each frame: back-face culling, near-plane clipping, one fill instance per visible
//      face and one segment instance per visible edge. Drawn with the Python's painter's algorithm: stanchion
//      solids sorted by distance from the camera, then struts, arm, backboard, bracket, rim and net (reversed when
//      the camera is behind the board). That ordering is part of the reference look (the brace is drawn over the
//      base, the arm over the posts), which a depth buffer would change. Fills: 4x4 supersampled coverage of the
//      convex polygon. Lines: 4x4 supersampled coverage of each segment, MAX-blended into a coverage buffer so each
//      draw group is one union (crossings don't double up), then composited "over" with its colour. A second
//      render target collects the glow layer.
//   2. Mirror image of the stanchion (y -> -y), same passes, for the faint floor reflection.
//   3. Separable Gaussian blurs at half resolution: glow (sigma 2.4 and 9 px), reflection (2 x 7 px).
//   4. Full-screen pass: per pixel SS x SS rays; floor = ray/plane hit with the hardwood planks, joints and court
//      lines box-filtered over the sample's exact footprint (the plane Jacobian), GGX streaks from three lamps,
//      Fresnel reflection of the backdrop, light pool, fade into the void; then reflection, hoop and glow
//      composite, vignette, sRGB encode, film grain.

const FT = 0.3048;
const LINE_W = 0.0508;
const HALF_W = 25 * FT;
const COURT_L = 94 * FT;
const MID_X = -47 * FT;
const BASKET_X = -63 * 0.0254;
const BOARD_X = -4 * FT;
const KEY_HW = 8 * FT;
const FT_X = -19 * FT;
const FT_R = 6 * FT;
const R3 = 23.75 * FT;
const C3 = 22 * FT;
const RA_R = 4 * FT;
const RIM_Y = 10 * FT;
const RIM_R = 0.2286;
const SEED = 7;

const REF_W = 2560; // reference frame the camera's f is given for
const REF_H = 1440;
export const DEFAULT_CAMERA = Object.freeze({ pos: Object.freeze([-9.78, 1.73, 9.35]), yaw: 18.55, pitch: 3.85, f: 1781 });

const GOLD = "#CBB68A";
const GOLD_LIT = "#E2CF9F";
const VOID_EDGE = "#0C0E11";
const VOID_POOL = "#2B2F35";
const LINEART = "#E8DCC0";
const RIM_GOLD = "#E2C48C";

const NEAR = 0.05; // m, near clip for the hoop geometry

// ---------------------------------------------------------------------------------------------------------------
// small vector helpers
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const norm = (a) => mul(a, 1 / (len(a) || 1));
const D2R = Math.PI / 180;

function hexLin(h) {
  return [1, 3, 5].map((i) => {
    const c = parseInt(h.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
}

// Camera basis, identical to court_render.Camera, plus roll as in clip_cameras.cam_axes (rotation about the view
// axis, + = the camera's right side up).
function basis(yawDeg, pitchDeg, rollDeg = 0) {
  const y = yawDeg * D2R;
  const p = pitchDeg * D2R;
  const r = rollDeg * D2R;
  const fwd = [Math.cos(p) * Math.sin(y), -Math.sin(p), -Math.cos(p) * Math.cos(y)];
  const right0 = [Math.cos(y), 0, Math.sin(y)];
  const up0 = cross(right0, fwd);
  const right = add(mul(right0, Math.cos(r)), mul(up0, Math.sin(r)));
  const up = add(mul(right0, -Math.sin(r)), mul(up0, Math.cos(r)));
  return { fwd, right, up };
}

// ---------------------------------------------------------------------------------------------------------------
// Court markings (court_features() in the Python): segments and arcs on the floor plane, as GLSL constants.
function courtFeatures() {
  const segs = [];
  const arcs = [];
  const side = (m) => {
    const X = (x) => (m > 0 ? x : -COURT_L - x);
    segs.push([[X(0), -KEY_HW], [X(FT_X), -KEY_HW], 1]);
    segs.push([[X(0), KEY_HW], [X(FT_X), KEY_HW], 1]);
    segs.push([[X(FT_X), -KEY_HW], [X(FT_X), KEY_HW], 1]);
    const th = m < 0 ? 0 : Math.PI;
    const bx = X(BASKET_X);
    arcs.push([[X(FT_X), 0], FT_R, th, Math.PI / 2, 0]);
    arcs.push([[X(FT_X), 0], FT_R, th + Math.PI, Math.PI / 2, 7]);
    const xm = BASKET_X - Math.sqrt(R3 ** 2 - C3 ** 2);
    arcs.push([[bx, 0], R3, th, Math.atan2(C3, BASKET_X - xm), 0]);
    for (const zs of [-C3, C3]) segs.push([[X(0), zs], [X(xm), zs], 1]);
    arcs.push([[bx, 0], RA_R, th, Math.PI / 2, 0]);
    for (const zs of [-RA_R, RA_R]) segs.push([[bx, zs], [X(BOARD_X), zs], 0]);
    for (const [zs, o] of [[-KEY_HW, -1], [KEY_HW, 1]]) {
      segs.push([[X(-7.5 * FT), zs], [X(-7.5 * FT), zs + o * 8 * 0.0254], 0, 6 * 0.0254]);
      for (const d of [11, 14, 17]) segs.push([[X(-d * FT), zs], [X(-d * FT), zs + o * 6 * 0.0254], 0]);
    }
    for (const [zs, o] of [[-HALF_W, 1], [HALF_W, -1]]) segs.push([[X(-28 * FT), zs], [X(-28 * FT), zs + o * 3 * FT], 0]);
  };
  side(1);
  side(-1);
  segs.push([[0, -HALF_W], [-COURT_L, -HALF_W], 1]);
  segs.push([[0, HALF_W], [-COURT_L, HALF_W], 1]);
  segs.push([[0, -HALF_W], [0, HALF_W], 1]);
  segs.push([[-COURT_L, -HALF_W], [-COURT_L, HALF_W], 1]);
  segs.push([[MID_X, -HALF_W], [MID_X, HALF_W], 1]);
  arcs.push([[MID_X, 0], 6 * FT, 0, Math.PI, 0]);
  arcs.push([[MID_X, 0], 2 * FT, 0, Math.PI, 0]);
  return { segs, arcs };
}

const f9 = (v) => {
  const s = Number(v).toPrecision(9);
  return /[.e]/.test(s) ? s : s + ".0";
};
const v4 = (a, b, c, d) => `vec4(${f9(a)},${f9(b)},${f9(c)},${f9(d)})`;

function courtGLSL() {
  const { segs, arcs } = courtFeatures();
  const hw = LINE_W / 2;
  const segA = [];
  const segB = [];
  for (const [p0, p1, ext, width] of segs) {
    let ex = p1[0] - p0[0];
    let ez = p1[1] - p0[1];
    const L = Math.hypot(ex, ez);
    ex /= L;
    ez /= L;
    segA.push(v4(p0[0], p0[1], ex, ez));
    segB.push(v4(L, ext ? hw : 0, width ?? hw, 0));
  }
  const arcA = arcs.map(([c, R, thm]) => v4(c[0], c[1], R, thm));
  const arcB = arcs.map(([, , , ha, dashes]) => v4(ha, dashes, 0, 0));
  return `
const int NSEG = ${segs.length};
const vec4 SEG_A[NSEG] = vec4[NSEG](${segA.join(",")});
const vec4 SEG_B[NSEG] = vec4[NSEG](${segB.join(",")});
const int NARC = ${arcs.length};
const vec4 ARC_A[NARC] = vec4[NARC](${arcA.join(",")});
const vec4 ARC_B[NARC] = vec4[NARC](${arcB.join(",")});`;
}

// Unseen lamps (LIGHTS_SCREEN): placed from the screen position of their streak in the default 2560x1440 frame,
// i.e. where the camera ray through that point, mirrored in the floor, reaches the lamp height. Fixed in the world.
function lightPositions() {
  const L = [
    [560, 1120, 2.8, [1.0, 0.93, 0.82], 1.0],
    [1180, 1110, 2.8, [1.0, 0.95, 0.86], 0.75],
    [2290, 1130, 2.8, [1.0, 0.93, 0.82], 0.9],
  ];
  const c = DEFAULT_CAMERA;
  const { fwd, right, up } = basis(c.yaw, c.pitch);
  return L.map(([px, py, h, col, k]) => {
    const a = (px - REF_W / 2) / c.f;
    const b = (py - REF_H / 2) / c.f;
    const d = add(add(fwd, mul(right, a)), mul(up, -b));
    const t = (c.pos[1] + h) / -d[1];
    const Lm = add(c.pos, mul(d, t));
    return { pos: [Lm[0], h, Lm[2]], col: mul(col, k) };
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Hoop geometry (hoop_scene() in the Python)
function hexa(V) {
  return { V, F: [[0, 1, 3, 2], [4, 6, 7, 5], [0, 4, 5, 1], [2, 3, 7, 6], [0, 2, 6, 4], [1, 5, 7, 3]] };
}
function boxSolid(x0, x1, y0, y1, z0, z1) {
  const V = [];
  for (const x of [x0, x1]) for (const y of [y0, y1]) for (const z of [z0, z1]) V.push([x, y, z]);
  return hexa(V);
}
function prism(profile, z0, z1) {
  const n = profile.length;
  const V = [...profile.map(([x, y]) => [x, y, z0]), ...profile.map(([x, y]) => [x, y, z1])];
  const F = [[...Array(n).keys()], [...Array(n).keys()].map((k) => k + n)];
  for (let k = 0; k < n; k++) {
    const k2 = (k + 1) % n;
    F.push([k, k2, n + k2, n + k]);
  }
  return { V, F };
}
function frustum(xa, xb, za, ya, xc, xd, zc, yb) {
  const V = new Array(8);
  for (const xi of [0, 1])
    for (const yi of [0, 1])
      for (const zi of [0, 1]) {
        const X = yi === 0 ? (xi === 0 ? xa : xb) : xi === 0 ? xc : xd;
        const Z = yi === 0 ? (zi === 0 ? -za : za) : zi === 0 ? -zc : zc;
        V[xi * 4 + yi * 2 + zi] = [X, yi === 0 ? ya : yb, Z];
      }
  return hexa(V);
}
function beam(p0, p1, hwy, hwz) {
  const V = new Array(8);
  [p0, p1].forEach(([X, Y], xi) => {
    for (const yi of [0, 1]) for (const zi of [0, 1]) V[xi * 4 + yi * 2 + zi] = [X, Y + (yi ? hwy : -hwy), zi ? hwz : -hwz];
  });
  return hexa(V);
}

function style(fill, line, line_a, w, extra = {}) {
  return { fill: fill && hexLin(fill), line: hexLin(line), line_a, w, glow: 1, soft: false, ...extra };
}

// Ordered like the Python's draw list (painter's algorithm, back to front for cameras on the court side). Items:
// {kind: "solid", V, F, st, stan} | {kind: "lines", polys, st, decal} | {kind: "net", which: "back" | "front", st}
// (the net's back / front split depends on the camera). `asm` numbers the assemblies (stanchion, struts, arm,
// backboard, bracket, rim + net): seen from behind the backboard they are drawn in reverse. `decal`: lines painted
// on the board's front face, only visible from in front of it.
function hoopScene() {
  const S_STAN = style("#16191D", LINEART, 0.4, 1.3);
  const S_ARM = style("#16191D", LINEART, 0.48, 1.3);
  const S_PAD = style("#121418", LINEART, 0.55, 1.35);
  const S_BOARD = style("#08090B", LINEART, 0.88, 1.7);
  const items = [];
  let asm = 0;
  const solid = (g, st, stan = false) => items.push({ kind: "solid", V: g.V, F: g.F, st, stan, asm });
  const lines = (polys, st, decal = false) => items.push({ kind: "lines", polys, st, decal, asm });

  solid(prism([[0.95, 0.0], [2.65, 0.0], [2.65, 0.28], [1.95, 0.8], [0.95, 0.8]], -0.72, 0.72), S_STAN, true);
  solid(frustum(1.0, 1.78, 0.42, 0.8, 1.16, 1.46, 0.25, 2.3), S_STAN, true);
  solid(beam([2.25, 0.55], [1.42, 2.72], 0.045, 0.3), S_STAN, true);
  for (const zc of [-0.13, 0.13]) solid(boxSolid(1.24, 1.36, 2.3, 2.86, zc - 0.035, zc + 0.035), S_STAN, true);
  asm = 1;
  lines([-0.4, 0.4].map((zc) => [[-1.17, 3.62, zc], [1.3, 2.92, zc * 0.3]]), style(null, LINEART, 0.22, 1.0));
  asm = 2;
  solid(beam([1.4, 2.8], [-1.15, 3.05], 0.11, 0.1), S_ARM);
  asm = 3;

  const bz = 0.9144;
  const yb0 = RIM_Y - 0.1524;
  const yb1 = yb0 + 1.0668;
  solid(boxSolid(BOARD_X, BOARD_X + 0.05, yb0, yb1, -bz, bz), S_BOARD);
  const fx = BOARD_X - 0.001;
  const ins = 0.05;
  lines([[[fx, yb0 + ins, -bz + ins], [fx, yb0 + ins, bz - ins], [fx, yb1 - ins, bz - ins], [fx, yb1 - ins, -bz + ins], [fx, yb0 + ins, -bz + ins]]],
    style(null, LINEART, 0.55, 1.15), true);
  const sqW = 0.3048;
  const sqH = 0.4572;
  for (const [d, a, w] of [[0, 0.85, 1.5], [0.0508, 0.55, 1.15]]) {
    lines([[[fx, RIM_Y + d, -sqW + d], [fx, RIM_Y + d, sqW - d], [fx, RIM_Y + sqH - d, sqW - d], [fx, RIM_Y + sqH - d, -sqW + d], [fx, RIM_Y + d, -sqW + d]]],
      style(null, LINEART, a, w), true);
  }
  lines([[[fx, yb1 - 0.1, -0.7], [fx, yb0 + 0.3, -0.22]]], style(null, "#C8D2DE", 0.028, 26.0, { glow: 0, soft: true }), true);
  solid(boxSolid(BOARD_X - 0.06, BOARD_X + 0.07, yb0 - 0.07, yb0 + 0.02, -bz - 0.03, bz + 0.03), S_PAD);
  for (const zc of [-1, 1]) {
    const [z0, z1] = zc > 0 ? [bz - 0.005, bz + 0.03] : [-bz - 0.03, -bz + 0.005];
    solid(boxSolid(BOARD_X - 0.06, BOARD_X + 0.07, yb0 + 0.02, yb0 + 0.38, z0, z1), S_PAD);
  }
  asm = 4;
  solid(boxSolid(BASKET_X + RIM_R - 0.005, BOARD_X - 0.06, RIM_Y - 0.1, RIM_Y - 0.01, -0.09, 0.09), style("#101215", RIM_GOLD, 0.75, 1.3));

  asm = 5;
  items.push({ kind: "net", which: "back", st: style(null, LINEART, 0.32, 1.05), asm });
  const ring = (y) => Array.from({ length: 161 }, (_, i) => {
    const t = (2 * Math.PI * i) / 160;
    return [BASKET_X + (RIM_R + 0.008) * Math.cos(t), y, (RIM_R + 0.008) * Math.sin(t)];
  });
  lines([ring(RIM_Y - 0.016)], style(null, RIM_GOLD, 0.55, 1.3));
  lines([ring(RIM_Y)], style(null, RIM_GOLD, 1.0, 2.0));
  items.push({ kind: "net", which: "front", st: style(null, LINEART, 0.78, 1.15), asm });
  return items;
}

// Net strands (diamond lattice) as segments, split by which side of the rim faces the camera.
function netStrands(camPos) {
  const N = 12;
  const J = 5;
  const Lnet = 0.43;
  const node = (j, kk) => {
    const ang = (2 * Math.PI * (kk + 0.5 * (j % 2))) / N;
    const tt = j / J;
    const rr = RIM_R - (RIM_R - 0.135) * (1 - (1 - tt) ** 1.6);
    return [BASKET_X + rr * Math.cos(ang), RIM_Y - 0.012 - Lnet * tt, rr * Math.sin(ang)];
  };
  let cx = camPos[0] - BASKET_X;
  let cz = camPos[2];
  const cl = Math.hypot(cx, cz) || 1;
  cx /= cl;
  cz /= cl;
  const back = [];
  const front = [];
  for (let j = 0; j < J; j++)
    for (let kk = 0; kk < N; kk++) {
      const a = node(j, kk);
      const ends = j % 2 === 0 ? [node(j + 1, kk), node(j + 1, kk - 1)] : [node(j + 1, kk), node(j + 1, kk + 1)];
      for (const e of ends) {
        const mid = mul(add(a, e), 0.5);
        ((mid[0] - BASKET_X) * cx + mid[2] * cz > 0 ? front : back).push([a, e]);
      }
    }
  return { back, front };
}

// ---------------------------------------------------------------------------------------------------------------
// GLSL
const HEAD = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
`;

const VS_TRI = HEAD + `
layout(location = 0) in vec2 p;
void main() { gl_Position = vec4(p, 0.0, 1.0); }`;

// Fill: one instance per visible face (convex, up to 6 vertices after clipping), drawn as its padded bounding box.
const VS_FILL = HEAD + `
layout(location = 0) in vec2 corner;
layout(location = 1) in vec4 iV01;
layout(location = 2) in vec4 iV23;
layout(location = 3) in vec4 iV45;
layout(location = 4) in vec4 iInfo; // vertex count, unused
layout(location = 5) in vec4 iCol;  // linear rgb, alpha
uniform vec2 uVp;
flat out vec4 vV01, vV23, vV45, vInfo, vCol;
void main() {
  int n = int(iInfo.x);
  vec2 v[6] = vec2[6](iV01.xy, iV01.zw, iV23.xy, iV23.zw, iV45.xy, iV45.zw);
  vec2 lo = v[0], hi = v[0];
  for (int k = 1; k < 6; k++) if (k < n) { lo = min(lo, v[k]); hi = max(hi, v[k]); }
  vec2 q = mix(floor(lo) - 1.0, ceil(hi) + 1.0, corner);
  gl_Position = vec4(q / uVp * 2.0 - 1.0, 0.0, 1.0);
  vV01 = iV01; vV23 = iV23; vV45 = iV45; vInfo = iInfo; vCol = iCol;
}`;

const FS_FILL = HEAD + `
flat in vec4 vV01, vV23, vV45, vInfo, vCol;
layout(location = 0) out vec4 o0;
layout(location = 1) out vec4 o1;
void main() {
  int n = int(vInfo.x);
  vec2 v[6] = vec2[6](vV01.xy, vV01.zw, vV23.xy, vV23.zw, vV45.xy, vV45.zw);
  vec2 base = floor(gl_FragCoord.xy);
  float cov = 0.0;
  for (int sy = 0; sy < 4; sy++)
  for (int sx = 0; sx < 4; sx++) {
    vec2 q = base + (vec2(sx, sy) + 0.5) * 0.25;
    bool inside = true;
    for (int k = 0; k < 6; k++) {
      if (k >= n) break;
      vec2 a = v[k], b = v[(k + 1) % n];
      if ((b.x - a.x) * (q.y - a.y) - (b.y - a.y) * (q.x - a.x) < 0.0) inside = false;
    }
    cov += inside ? 1.0 : 0.0;
  }
  cov *= 1.0 / 16.0;
  if (cov <= 0.0) discard;
  float a = vCol.a * cov;
  o0 = vec4(vCol.rgb * a, a);
  o1 = vec4(0.0, 0.0, 0.0, a); // fills hide the glow of what's behind them
}`;

// Line: one instance per segment, drawn as a padded quad along it. Coverage -> R (MAX-blended per draw group).
const VS_LINE = HEAD + `
layout(location = 0) in vec2 corner;
layout(location = 1) in vec4 iSeg; // a.xy, b.xy (texture px)
uniform vec2 uVp;
uniform float uW;
uniform bool uSoft;
flat out vec4 vSeg;
void main() {
  vec2 a = iSeg.xy, b = iSeg.zw, d = b - a;
  float L = length(d);
  vec2 t = L > 1e-6 ? d / L : vec2(1.0, 0.0);
  vec2 nn = vec2(-t.y, t.x);
  float pad = uSoft ? uW : uW * 0.5 + 1.5;
  vec2 q = (corner.x < 0.5 ? a - t * pad : b + t * pad) + nn * pad * (corner.y * 2.0 - 1.0);
  gl_Position = vec4(q / uVp * 2.0 - 1.0, 0.0, 1.0);
  vSeg = iSeg;
}`;

const FS_LINE = HEAD + `
flat in vec4 vSeg;
uniform float uW;
uniform bool uSoft;
uniform bool uDirect;  // motion frames: blend straight into the layer (no per-group union)
uniform vec4 uCol;
uniform float uGlowK;
layout(location = 0) out vec4 o;
layout(location = 1) out vec4 o1;
float segT(vec2 q, vec2 a, vec2 b) { vec2 e = b - a; return clamp(dot(q - a, e) / (dot(e, e) + 1e-12), 0.0, 1.0); }
void main() {
  vec2 a = vSeg.xy, b = vSeg.zw;
  vec2 c = gl_FragCoord.xy;
  float cov = 0.0;
  if (uSoft) {
    float d = length(c - mix(a, b, segT(c, a, b)));
    cov = exp(-0.5 * pow(d / (uW * 0.25), 2.0));
  } else {
    vec2 base = floor(c);
    for (int sy = 0; sy < 4; sy++)
    for (int sx = 0; sx < 4; sx++) {
      vec2 q = base + (vec2(sx, sy) + 0.5) * 0.25;
      float d = length(q - mix(a, b, segT(q, a, b)));
      cov += clamp((uW * 0.5 - d) * 4.0 + 0.5, 0.0, 1.0);
    }
    cov *= 1.0 / 16.0;
  }
  if (cov <= 0.002) discard;
  if (uDirect) {
    float al = cov * uCol.a;
    o = vec4(uCol.rgb * al, al);
    o1 = vec4(uCol.rgb * al * uGlowK, al);
  } else {
    o = vec4(cov);
    o1 = vec4(0.0);
  }
}`;

// One draw group's union coverage composited "over" the layer (premultiplied) and its glow layer.
const FS_GROUP = HEAD + `
uniform sampler2D uCov;
uniform vec4 uCol;
uniform float uGlowK;
layout(location = 0) out vec4 o0;
layout(location = 1) out vec4 o1;
void main() {
  float a = texelFetch(uCov, ivec2(gl_FragCoord.xy), 0).r * uCol.a;
  o0 = vec4(uCol.rgb * a, a);
  o1 = vec4(uCol.rgb * a * uGlowK, a);
}`;

// Horizontal Gaussian, full resolution -> half resolution (each tap is a bilinear 2x2 box), two sigmas at once.
const FS_BLUR_H = HEAD + `
uniform sampler2D uSrc;
uniform vec2 uSrcSize;    // full-resolution texture size
uniform vec2 uS;          // two sigmas, full-resolution px
layout(location = 0) out vec4 o0;
layout(location = 1) out vec4 o1;
void main() {
  vec2 c = gl_FragCoord.xy * 2.0;
  int M = int(ceil(1.5 * max(uS.x, uS.y)));
  vec4 a = vec4(0.0), b = vec4(0.0);
  float wa = 0.0, wb = 0.0;
  for (int m = -40; m <= 40; m++) {
    if (m < -M || m > M) continue;
    float x = 2.0 * float(m);
    vec4 t = texture(uSrc, (c + vec2(x, 0.0)) / uSrcSize);
    float ka = exp(-0.5 * x * x / (uS.x * uS.x));
    float kb = exp(-0.5 * x * x / (uS.y * uS.y));
    a += t * ka; wa += ka;
    b += t * kb; wb += kb;
  }
  o0 = a / wa;
  o1 = b / wb;
}`;

// Vertical Gaussian at half resolution; out = wA * blur(A, sA) + wB * blur(B, sB).
const FS_BLUR_V = HEAD + `
uniform sampler2D uA, uB;
uniform vec2 uHalfSize;
uniform vec2 uS;   // sigmas, full-resolution px
uniform vec2 uWt;  // weights
out vec4 o;
void main() {
  vec2 c = gl_FragCoord.xy;
  float sa = uS.x * 0.5, sb = max(uS.y * 0.5, 1e-3);
  int M = int(ceil(3.0 * max(sa, uWt.y > 0.0 ? sb : 0.0)));
  vec4 a = vec4(0.0), b = vec4(0.0);
  float wa = 0.0, wb = 0.0;
  for (int m = -40; m <= 40; m++) {
    if (m < -M || m > M) continue;
    float y = float(m);
    vec2 uv = (c + vec2(0.0, y)) / uHalfSize;
    float ka = exp(-0.5 * y * y / (sa * sa));
    float kb = exp(-0.5 * y * y / (sb * sb));
    a += texture(uA, uv) * ka; wa += ka;
    if (uWt.y > 0.0) { b += texture(uB, uv) * kb; wb += kb; }
  }
  o = uWt.x * a / wa + (uWt.y > 0.0 ? uWt.y * b / wb : vec4(0.0));
}`;

function hexVec3(h) {
  const c = hexLin(h);
  return `vec3(${c.map(f9).join(",")})`;
}

function finalFS() {
  const K1 = ((0x27d4eb2d + 0x165667b1) >>> 0).toString(16);
  return HEAD + `
out vec4 o;
uniform vec2 uRes;                 // canvas px
uniform vec3 uPos, uFwd, uRight, uUp;
uniform float uF;                  // focal length, canvas px
uniform vec2 uC;                   // principal point, canvas px (y down)
uniform int uSS;                   // supersampling per axis
uniform vec3 uB0, uB1, uB2;        // backdrop frame (right, up, forward)
uniform vec3 uLP[3], uLC[3];       // lamps
uniform float uScale;              // canvas px per reference-frame px
uniform bool uHoop;
uniform vec4 uBox;                 // hoop box: origin (GL px), size
uniform vec2 uTex;                 // full-resolution hoop texture size
uniform sampler2D uLayer, uRefl, uGlow;
uniform float uYc;                 // row (y down) where the reflection starts to fade
${courtGLSL()}
const float PI = 3.14159265358979;
const vec3 EDGE = ${hexVec3(VOID_EDGE)};
const vec3 POOL = ${hexVec3(VOID_POOL)};
const vec3 GOLD = ${hexVec3(GOLD)};
const vec3 GOLD_LIT = ${hexVec3(GOLD_LIT)};
const vec3 WOOD = vec3(0.0150, 0.0124, 0.0104);
const float POOL_V0 = -0.46;
const float SPEC_K = 0.050;
const float ALPHA0 = 0.14;

// hashing: the same integer hash as the Python (hash_u32 / hrand), so the boards come out identical
uint hu(uint a) { a ^= a >> 16u; a *= 0x7FEB352Du; a ^= a >> 15u; a *= 0x846CA68Bu; a ^= a >> 16u; return a; }
uint hseed(int s) { return uint(s) * 0x9E3779B9u + 0x85EBCA6Bu; }
float hrand1(int a, int s) { return float(hu(hseed(s) ^ (uint(a) * 0x27D4EB2Du))) * (1.0 / 4294967296.0); }
float hrand2(int a, int b, int s) {
  uint acc = hu(hseed(s) ^ (uint(a) * 0x27D4EB2Du));
  return float(hu(acc ^ (uint(b) * 0x${K1}u))) * (1.0 / 4294967296.0);
}
float vnoise1(float x, int key, int s) {
  float i = floor(x), f = x - i, u = f * f * (3.0 - 2.0 * f);
  float a = hrand2(int(i), key, s), b = hrand2(int(i) + 1, key, s);
  return a + (b - a) * u;
}
float sstep(float e0, float e1, float x) { float t = clamp((x - e0) / (e1 - e0), 0.0, 1.0); return t * t * (3.0 - 2.0 * t); }

// box-filtered primitives
float boxStripe(float s, float hw, float fp) { return max(min(s + fp * 0.5, hw) - max(s - fp * 0.5, -hw), 0.0) / fp; }
float boxRange(float t, float a, float b, float fp) { return max(min(t + fp * 0.5, b) - max(t - fp * 0.5, a), 0.0) / fp; }
float pulseF(float x, float w) { return floor(x) * w + clamp(x - floor(x), 0.0, w); }
float pulseTrain(float s, float w, float fp) { fp = max(fp, 1e-6); return (pulseF(s + fp * 0.5, w) - pulseF(s - fp * 0.5, w)) / fp; }

vec3 ray(vec2 s) { return uFwd + uRight * ((s.x - uC.x) / uF) - uUp * ((s.y - uC.y) / uF); }

// Graphite void with the top-centre light pool, as a function of view direction in the backdrop frame (the
// default camera's frame: identical to the Python's screen-space version there, and fixed when the camera moves).
vec3 backdrop(vec3 d) {
  float fz = dot(d, uB2);
  float u = 1e3, v = 0.0;
  if (fz > 1e-4) { u = dot(d, uB0) / fz; v = -dot(d, uB1) / fz; }
  float g = exp(-(pow(u / 0.40, 2.0) + pow((v - POOL_V0) / 0.21, 2.0)));
  float g2 = exp(-(pow(u / 0.80, 2.0) + pow((v - POOL_V0) / 0.45, 2.0)));
  float k = 0.92 * g + 0.08 * g2;
  return EDGE * (0.30 + 0.70 * exp(-pow(u / 0.6, 2.0))) + (POOL - EDGE) * k;
}

float courtCov(float x, float z, vec2 Jx, vec2 Jy) {
  float cov = 0.0;
  for (int k = 0; k < NSEG; k++) {
    vec4 A = SEG_A[k], B = SEG_B[k];
    float rx = x - A.x, rz = z - A.y;
    float nx = -A.w, nz = A.z;
    float s = rx * nx + rz * nz;
    float t = rx * A.z + rz * A.w;
    if (abs(s) >= 0.6 || t <= -0.6 || t >= B.x + 0.6) continue;
    float fpn = abs(Jx.x * nx + Jx.y * nz) + abs(Jy.x * nx + Jy.y * nz) + 1e-6;
    float fpt = abs(Jx.x * A.z + Jx.y * A.w) + abs(Jy.x * A.z + Jy.y * A.w) + 1e-6;
    cov = max(cov, boxStripe(s, B.z, fpn) * boxRange(t, -B.y, B.x + B.y, fpt));
  }
  float hw = ${f9(LINE_W / 2)};
  for (int k = 0; k < NARC; k++) {
    vec4 A = ARC_A[k];
    float R = A.z;
    float rx = x - A.x, rz = z - A.y;
    float rr = sqrt(rx * rx + rz * rz) + 1e-9;
    float s = rr - R;
    if (abs(s) >= 0.6) continue;
    float nx = rx / rr, nz = rz / rr;
    float fpn = abs(Jx.x * nx + Jx.y * nz) + abs(Jy.x * nx + Jy.y * nz) + 1e-6;
    float fpt = abs(-Jx.x * nz + Jx.y * nx) + abs(-Jy.x * nz + Jy.y * nx) + 1e-6;
    float th = atan(rz, rx);
    float d = mod(th - A.w + PI, 2.0 * PI) - PI;
    float t = d * R;
    float span = ARC_B[k].x * R;
    int dashes = int(ARC_B[k].y);
    float cc;
    if (dashes > 0) {
      float seg = 2.0 * span / float(2 * dashes - 1);
      cc = 0.0;
      for (int j = 0; j < 16; j++) {
        if (j >= dashes) break;
        float a = -span + 2.0 * float(j) * seg;
        cc = max(cc, boxRange(t, a, a + seg, fpt));
      }
    } else {
      cc = boxRange(t, -span, span, fpt);
    }
    cov = max(cov, boxStripe(s, hw, fpn) * cc);
  }
  return cov;
}

// Floor sample along ray D (D.y < 0); sub = samples per pixel axis (the footprint is one sample step).
vec3 shadeFloor(vec3 D, float sub) {
  float Cy = uPos.y;
  float Dy = D.y;
  float t = -Cy / Dy;
  float x = uPos.x + D.x * t;
  float z = uPos.z + D.z * t;
  // exact Jacobian of the plane hit w.r.t. screen x and y, per sample step: P = C - D Cy / Dy, dD/dsx = right / f,
  // dD/dsy = -up / f  =>  dP = -(Cy / Dy) (dD - D dD.y / Dy). Equals the Python's when right.y = 0 (no roll).
  float k1 = -Cy / (uF * Dy) / sub;
  vec2 Jx = k1 * (uRight.xz - D.xz * (uRight.y / Dy));
  vec2 Jy = -k1 * (uUp.xz - D.xz * (uUp.y / Dy));
  float fx = abs(Jx.x) + abs(Jy.x) + 1e-7;
  float fz = abs(Jx.y) + abs(Jy.y) + 1e-7;

  // hardwood: 2.25 in maple strips along x, random-length boards
  const float P = 0.0571;
  const float L0 = 1.6;
  float zi = z / P;
  float fi = floor(zi);
  int i = int(fi);
  float az = clamp(1.5 - fz / P, 0.0, 1.0);
  float seamW = 0.0022 / P;
  float seam = pulseTrain(zi + seamW * 0.5, seamW, fz / P);
  float off = hrand1(i, ${SEED + 1}) * L0;
  float ux = (x - off) / L0;
  float fk = floor(ux);
  int k = int(fk);
  float jk = fk + 0.7 * (hrand2(i, k, ${SEED + 2}) - 0.5);
  float jk1 = fk + 1.0 + 0.7 * (hrand2(i, k + 1, ${SEED + 2}) - 0.5);
  int b = ux < jk ? k - 1 : (ux >= jk1 ? k + 1 : k);
  float fb = float(b);
  float jb = fb + 0.7 * (hrand2(i, b, ${SEED + 2}) - 0.5);
  float jb1 = fb + 1.0 + 0.7 * (hrand2(i, b + 1, ${SEED + 2}) - 0.5);
  float dj = min(ux - jb, jb1 - ux) * L0;
  float joint = boxStripe(dj, 0.0011, fx) * az + (1.0 - az) * (0.0022 / L0);
  float tone = 1.0 + 0.55 * (hrand2(i, b, ${SEED + 3}) - 0.5) * az;
  float zl = zi - fi;
  float gfade = clamp(1.0 - fx / 0.08, 0.0, 1.0) * az;
  float drift = (vnoise1(x / 0.35, i * 7 + b, ${SEED + 4}) - 0.5) * 0.30 * gfade;
  float figFade = clamp(1.0 - fz / 0.006, 0.0, 1.0) * clamp(1.0 - fx / 0.05, 0.0, 1.0);
  float wob = vnoise1(x / 0.21, i * 13 + b, ${SEED + 5}) * 2.2 + vnoise1(x / 0.06, i * 5 + b, ${SEED + 6}) * 0.35;
  float fs = sin(2.0 * PI * (zl * 3.0 + wob)) * 0.5 + 0.5;
  float figure = fs * fs * fs * 0.22 * figFade;
  float wood = (1.0 + drift - figure) * tone * (1.0 - 0.55 * seam - 0.45 * joint);

  // overhead diffuse pool, contact darkening around the stanchion base
  vec2 pp = vec2(x + 6.0, z + 1.0);
  float E = 0.06 + 0.94 * exp(-(pow(pp.x / 10.0, 2.0) + pow(pp.y / 8.5, 2.0)));
  float ddx = max(max(0.95 - x, x - 2.65), 0.0);
  float ddz = max(max(-0.72 - z, z - 0.72), 0.0);
  E *= 1.0 - 0.75 * exp(-sqrt(ddx * ddx + ddz * ddz) / 0.22);

  // court paint
  float cov = courtCov(x, z, Jx, Jy);
  vec3 paint = mix(GOLD, GOLD_LIT, sstep(0.45, 1.0, E));
  vec3 paintRad = paint * (0.40 + 0.42 * E);

  // GGX specular from the lamps, per-board tilt and roughness
  vec3 V = -normalize(D);
  float nz = (hrand2(i, b, ${SEED + 7}) - 0.5) * 0.010 * az + (zl - 0.5) * 0.006 * az;
  float nx = (hrand2(i, b, ${SEED + 8}) - 0.5) * 0.004 * az;
  vec3 N = vec3(nx, sqrt(1.0 - nz * nz - nx * nx), nz);
  float alpha = ALPHA0 + ALPHA0 * 0.4 * (hrand2(i, b, ${SEED + 9}) - 0.5) * az;
  if (cov > 0.5) alpha = 0.20;
  float a2 = alpha * alpha;
  float NV = clamp(dot(N, V), 1e-3, 1.0);
  vec3 spec = vec3(0.0);
  vec3 Pw = vec3(x, 0.0, z);
  for (int l = 0; l < 3; l++) {
    vec3 L = normalize(uLP[l] - Pw);
    vec3 H = normalize(L + V);
    float NH = clamp(dot(N, H), 0.0, 1.0);
    float NL = clamp(dot(N, L), 1e-3, 1.0);
    float VH = clamp(dot(V, H), 0.0, 1.0);
    float q = NH * NH * (a2 - 1.0) + 1.0;
    float Dg = a2 / (PI * q * q);
    float kk = alpha * 0.5;
    float G = (NL / (NL * (1.0 - kk) + kk)) * (NV / (NV * (1.0 - kk) + kk));
    float F = 0.04 + 0.96 * pow(1.0 - VH, 5.0);
    spec += uLC[l] * (Dg * G * F / (4.0 * NV));
  }
  spec *= SPEC_K;

  // grazing (Fresnel) reflection of the backdrop
  float Fn = 0.04 + 0.96 * pow(1.0 - NV, 5.0);
  vec3 refl = Fn * backdrop(vec3(D.x, -D.y, D.z)) * 0.85;

  vec3 base = WOOD * wood * E;
  float groove = 1.0 - 0.85 * clamp(seam + joint, 0.0, 1.0) * (1.0 - cov);
  vec3 surf = base * (1.0 - cov) + paintRad * cov + (spec + refl) * groove * (1.0 - 0.5 * cov);

  // falloff into the void: pool visibility + distance from the eye
  float dist = length(vec2(x, z) - uPos.xz);
  float vis = exp(-pow(pow((x + 3.5) / 11.5, 2.0) + pow((z + 0.5) / 12.0, 2.0), 2.0));
  vis *= exp(-max(dist - 14.0, 0.0) / 9.0);
  return mix(backdrop(D), surf, vis);
}

vec3 toSrgb(vec3 x) {
  x = clamp(x, 0.0, 1.0);
  return mix(12.92 * x, 1.055 * pow(x, vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), x));
}

void main() {
  ivec2 ip = ivec2(gl_FragCoord.xy);
  float col = float(ip.x);
  float row = uRes.y - 1.0 - float(ip.y);   // the Python's rows run top to bottom
  float n = float(uSS);
  vec3 acc = vec3(0.0);
  for (int j = 0; j < 4; j++) {
    if (j >= uSS) break;
    for (int i = 0; i < 4; i++) {
      if (i >= uSS) break;
      vec3 D = ray(vec2(col + (float(i) + 0.5) / n, row + (float(j) + 0.5) / n));
      acc += D.y < -1e-4 ? shadeFloor(D, n) : backdrop(D);
    }
  }
  vec3 img = acc / (n * n);
  vec2 sc = vec2(col + 0.5, row + 0.5);

  if (uHoop) {
    vec2 q = gl_FragCoord.xy - uBox.xy;
    if (all(greaterThanEqual(q, vec2(0.0))) && all(lessThan(q, uBox.zw))) {
      vec4 R = texture(uRefl, q / uTex);
      float onFloor = ray(sc).y < 0.0 ? 1.0 : 0.0;
      float kr = 0.30 * onFloor * exp(-max(sc.y - uYc, 0.0) / (110.0 * uScale));
      img = img * (1.0 - R.a * kr) + R.rgb * kr * 0.9;
      vec4 L = texelFetch(uLayer, ivec2(q), 0);
      img = img * (1.0 - L.a) + L.rgb;
      img += texture(uGlow, q / uTex).rgb;
    }
  }

  // vignette (camera-attached)
  vec2 uv = (sc - uC) / uF;
  float rv = sqrt(pow(uv.x / 0.95, 2.0) + pow((uv.y + 0.02) / 0.62, 2.0));
  img *= 1.0 - 0.72 * sstep(0.40, 1.35, rv);

  // sRGB + film grain (in 8-bit units, as the Python), Box-Muller from the pixel hash
  vec3 c = toSrgb(img) * 255.0;
  uint h = hu(uint(ip.x) * 0x9E3779B9u ^ hu(uint(ip.y) + 0x632BE5ABu));
  float u1 = (float(h & 0xFFFFu) + 0.5) / 65536.0;
  float u2 = float(h >> 16u) / 65536.0;
  float g = sqrt(-2.0 * log(u1)) * cos(2.0 * PI * u2) * 0.80;
  c += g * (0.6 + 0.4 * clamp((c.r + c.g + c.b) / 180.0, 0.0, 1.0));
  o = vec4(clamp(floor(c + 0.5), 0.0, 255.0) / 255.0, 1.0);
}`;
}

// ---------------------------------------------------------------------------------------------------------------
const EASES = {
  linear: (t) => t,
  inOutSine: (t) => 0.5 - 0.5 * Math.cos(Math.PI * t),
  inOutCubic: (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2),
  inOutQuint: (t) => (t < 0.5 ? 16 * t ** 5 : 1 - (-2 * t + 2) ** 5 / 2),
  outCubic: (t) => 1 - (1 - t) ** 3,
  // smootherstep: zero velocity AND zero acceleration at both ends (no lurch when the flight starts or lands)
  smoother: (t) => t * t * t * (t * (6 * t - 15) + 10),
};

// Camera: pos, yaw, pitch, roll (deg) and intrinsics, either
//   f (px of the 2560x1440 reference frame, shown like CSS `cover`) + pp (principal-point offset from the frame
//   centre, reference px, y down), or
//   fit: { element, image: { w, h, f, cx, cy } }: a pinhole image (e.g. a clip's 720x1280 frame, f / cx / cy in
//   its px) shown exactly in `element`'s box (object-fit: contain); f and pp are then derived from the element's
//   position on the page whenever the scene is drawn.
function normCam(c) {
  const f = c.f ?? (c.fovY != null ? REF_H / 2 / Math.tan((c.fovY * D2R) / 2) : DEFAULT_CAMERA.f);
  return { pos: [...c.pos], yaw: c.yaw, pitch: c.pitch, roll: c.roll ?? 0, f, pp: c.pp ? [...c.pp] : [0, 0], fit: c.fit ?? null };
}

// Obstacles for camera paths (world AABBs: x0, x1, y0, y1, z0, z1): stanchion, arm and posts, backboard, rim + net.
const OBSTACLES = [
  [0.95, 2.65, 0, 3.0, -0.72, 0.72],
  [-1.2, 1.5, 2.6, 3.7, -0.45, 0.45],
  [-1.3, -1.1, 2.8, 4.0, -0.95, 0.95],
  [-1.85, -1.35, 2.55, 3.1, -0.25, 0.25],
];

function slerp(a, b, t) {
  const d = Math.min(1, Math.max(-1, dot(a, b)));
  const th = Math.acos(d);
  if (th < 1e-5) return norm(add(mul(a, 1 - t), mul(b, t)));
  const s = Math.sin(th);
  return add(mul(a, Math.sin((1 - t) * th) / s), mul(b, Math.sin(t * th) / s));
}

export class Court {
  static supported() {
    try {
      const gl = document.createElement("canvas").getContext("webgl2", { failIfMajorPerformanceCaveat: true });
      if (!gl) return false;
      gl.getExtension("WEBGL_lose_context")?.loseContext();
      return true;
    } catch (e) {
      return false;
    }
  }

  // opts: backdrop "world" (default: the void is fixed in the world, as seen from the default camera) or
  // "camera" (the light pool follows the camera); maxPixels (render cap); ssStill / ssMotion (samples per axis).
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.opts = opts;
    const phone = matchMedia("(pointer: coarse)").matches && Math.min(screen.width, screen.height) < 700;
    this.maxPixels = opts.maxPixels ?? (phone ? 1.4e6 : REF_W * REF_H);
    this.maxDpr = opts.maxDpr ?? 2;
    this.ssStill = opts.ssStill ?? (phone ? 2 : 3);
    this.ssMotion = opts.ssMotion ?? (phone ? 1 : 2);
    this.cam = normCam(opts.camera ?? DEFAULT_CAMERA);
    this.lights = lightPositions();
    this.scene = hoopScene();
    this.anim = null;
    this.pending = 0;
    this.onRender = null; // optional callback(ms) after each frame, for debugging
    this.lost = false;
    canvas.addEventListener("webglcontextlost", (e) => {
      e.preventDefault();
      this.lost = true;
      this.onLost?.();
    });
    canvas.addEventListener("webglcontextrestored", () => {
      this.lost = false;
      this.init();
      this.waitPrograms().then(() => {
        this.render();
        this.onRestored?.();
      }, (e) => console.warn("Court: restore failed", e));
    });
    this.init();
    this.measure();
    // `ready` resolves after the first frame; it rejects if the shaders fail (the caller falls back to the JPG)
    this.ready = this.waitPrograms().then(() => {
      this.measure();
      this.render();
      return this;
    });
    new ResizeObserver(() => this.resize()).observe(canvas);
    window.addEventListener("resize", () => this.resize());
    this.watchDpr();
  }

  watchDpr() {
    const mq = matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
    mq.addEventListener("change", () => {
      this.resize();
      this.watchDpr();
    }, { once: true });
  }

  init() {
    const gl = (this.gl = this.canvas.getContext("webgl2", {
      alpha: false, antialias: false, depth: false, stencil: false, premultipliedAlpha: false, preserveDrawingBuffer: false,
      powerPreference: "high-performance",
      failIfMajorPerformanceCaveat: true, // a software renderer (no GPU) would take seconds per frame: use the JPG
    }));
    if (!gl) throw new Error("WebGL2 unavailable");
    gl.disable(gl.DITHER);
    this.programs = [];
    this.isReady = false;
    this.pFinal = this.program(VS_TRI, finalFS());
    this.pFill = this.program(VS_FILL, FS_FILL);
    this.pLine = this.program(VS_LINE, FS_LINE);
    this.pGroup = this.program(VS_TRI, FS_GROUP);
    this.pBlurH = this.program(VS_TRI, FS_BLUR_H);
    this.pBlurV = this.program(VS_TRI, FS_BLUR_V);

    this.triVao = gl.createVertexArray();
    gl.bindVertexArray(this.triVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    const corners = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, corners);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
    const mkVao = (inst, layout) => {
      const vao = gl.createVertexArray();
      gl.bindVertexArray(vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, corners);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, inst);
      const stride = layout.reduce((s, n) => s + n, 0) * 4;
      let off = 0;
      layout.forEach((n, i) => {
        gl.enableVertexAttribArray(i + 1);
        gl.vertexAttribPointer(i + 1, n, gl.FLOAT, false, stride, off);
        gl.vertexAttribDivisor(i + 1, 1);
        off += n * 4;
      });
      return vao;
    };
    this.fillBuf = gl.createBuffer();
    this.lineBuf = gl.createBuffer();
    this.fillVao = mkVao(this.fillBuf, [4, 4, 4, 4, 4]);
    this.lineVao = mkVao(this.lineBuf, [4]);
    gl.bindVertexArray(null);
    this.tex = null; // hoop textures, allocated on demand
    this.empty = this.makeTex(1, 1, gl.SRGB8_ALPHA8);
  }

  // Compile and link without asking for the result: any status query blocks the page until the driver is done
  // (about 0.7 s cold on ANGLE / D3D11 for the floor shader). finish() runs once the programs are ready.
  program(vs, fs) {
    const gl = this.gl;
    const sh = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      return s;
    };
    const p = gl.createProgram();
    const shaders = [sh(gl.VERTEX_SHADER, vs), sh(gl.FRAGMENT_SHADER, fs)];
    for (const s of shaders) gl.attachShader(p, s);
    gl.linkProgram(p);
    const prog = { p, u: null, shaders };
    this.programs.push(prog);
    return prog;
  }

  finish(prog) {
    const gl = this.gl;
    const { p } = prog;
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      const log = prog.shaders.map((s) => gl.getShaderInfoLog(s)).join("\n") + gl.getProgramInfoLog(p);
      throw new Error(log);
    }
    const u = {};
    const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS) || 0;
    for (let i = 0; i < n; i++) {
      const name = gl.getActiveUniform(p, i).name.replace(/\[0\]$/, "");
      u[name] = gl.getUniformLocation(p, name);
    }
    prog.u = u;
  }

  // Resolves when every program has linked (polled with KHR_parallel_shader_compile where available, so the page
  // keeps running meanwhile); rejects with the compile log on failure.
  waitPrograms() {
    const gl = this.gl;
    const ext = gl.getExtension("KHR_parallel_shader_compile");
    return new Promise((resolve, reject) => {
      const poll = () => {
        if (gl.isContextLost()) return reject(new Error("WebGL context lost"));
        if (ext && !this.programs.every((pr) => gl.getProgramParameter(pr.p, ext.COMPLETION_STATUS_KHR))) {
          setTimeout(poll, 16);
          return;
        }
        try {
          for (const pr of this.programs) this.finish(pr);
          this.isReady = true;
          resolve(this);
        } catch (e) {
          reject(e);
        }
      };
      poll();
    });
  }

  makeTex(w, h, fmt) {
    const gl = this.gl;
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texStorage2D(gl.TEXTURE_2D, 1, fmt, w, h);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }

  fbo(colors) {
    const gl = this.gl;
    const f = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, f);
    colors.forEach((t, i) => gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + i, gl.TEXTURE_2D, t, 0));
    gl.drawBuffers(colors.map((_, i) => gl.COLOR_ATTACHMENT0 + i));
    return f;
  }

  // Hoop textures cover the hoop's screen box; they grow in steps of 64 px and are reused.
  ensureTex(w, h) {
    const gl = this.gl;
    const W = Math.ceil(w / 64) * 64;
    const H = Math.ceil(h / 64) * 64;
    if (this.tex && this.tex.W >= W && this.tex.H >= H) return this.tex;
    if (this.tex) {
      for (const t of this.tex.all) gl.deleteTexture(t);
      for (const f of this.tex.fbos) gl.deleteFramebuffer(f);
    }
    const TW = Math.max(W, this.tex?.W ?? 0);
    const TH = Math.max(H, this.tex?.H ?? 0);
    const S = gl.SRGB8_ALPHA8;
    const t = { W: TW, H: TH };
    t.layer = this.makeTex(TW, TH, S);
    t.glow = this.makeTex(TW, TH, S);
    t.cov = this.makeTex(TW, TH, gl.R8);
    t.hA = this.makeTex(TW / 2, TH / 2, S);
    t.hB = this.makeTex(TW / 2, TH / 2, S);
    t.glowOut = this.makeTex(TW / 2, TH / 2, S);
    t.reflOut = this.makeTex(TW / 2, TH / 2, S);
    t.fLayer = this.fbo([t.layer, t.glow]);
    t.fCov = this.fbo([t.cov]);
    t.fH = this.fbo([t.hA, t.hB]);
    t.fGlow = this.fbo([t.glowOut]);
    t.fRefl = this.fbo([t.reflOut]);
    t.all = [t.layer, t.glow, t.cov, t.hA, t.hB, t.glowOut, t.reflOut];
    t.fbos = [t.fLayer, t.fCov, t.fH, t.fGlow, t.fRefl];
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return (this.tex = t);
  }

  // ---- canvas size ----
  measure() {
    const c = this.canvas;
    const cssW = c.clientWidth || window.innerWidth;
    const cssH = c.clientHeight || window.innerHeight;
    let dpr = Math.min(window.devicePixelRatio || 1, this.maxDpr);
    let W = Math.max(1, Math.round(cssW * dpr));
    let H = Math.max(1, Math.round(cssH * dpr));
    if (W * H > this.maxPixels) {
      const s = Math.sqrt(this.maxPixels / (W * H));
      W = Math.max(1, Math.round(W * s));
      H = Math.max(1, Math.round(H * s));
    }
    if (c.width === W && c.height === H) return false;
    c.width = W;
    c.height = H;
    return true;
  }

  resize() {
    if (this.lost) return;
    if (this.measure() || !this.drawn) this.render(); // a resized canvas is cleared: redraw in the same task
  }

  // ---- camera ----
  // Intrinsics in canvas device px for camera c: focal length f, principal point (cx, cy) (y down), and k, the
  // cover scale of the reference frame (also the line-width scale).
  intrinsics(c = this.cam) {
    const W = this.canvas.width;
    const H = this.canvas.height;
    const k = Math.max(W / REF_W, H / REF_H);
    const fr = c.fit && this.fitRect(c.fit);
    if (fr) return { f: c.fit.image.f * fr.s, cx: fr.left + c.fit.image.cx * fr.s, cy: fr.top + c.fit.image.cy * fr.s, k };
    return { f: c.f * k, cx: W / 2 + c.pp[0] * k, cy: H / 2 + c.pp[1] * k, k };
  }

  // The fitted image's box in canvas device px (object-fit: contain inside the element), or null if not laid out.
  fitRect(fit) {
    const B = fit.element.getBoundingClientRect();
    if (!(B.width > 0 && B.height > 0)) return null;
    // the browser draws the video snapped to whole device pixels (e.g. top 97.5 -> 98): snap the same way
    const dpr = window.devicePixelRatio || 1;
    const snap = (v) => Math.round(v * dpr) / dpr;
    const R = { left: snap(B.left), top: snap(B.top) };
    R.width = snap(B.left + B.width) - R.left;
    R.height = snap(B.top + B.height) - R.top;
    const C = this.canvas.getBoundingClientRect();
    const im = fit.image;
    const s = Math.min(R.width / im.w, R.height / im.h);
    const sx = this.canvas.width / (C.width || 1);
    const sy = this.canvas.height / (C.height || 1);
    return { s: s * sx, left: (R.left + (R.width - im.w * s) / 2 - C.left) * sx, top: (R.top + (R.height - im.h * s) / 2 - C.top) * sy };
  }

  // Intrinsics of c as reference-frame f / pp (what cover-style cameras store); used to interpolate between a
  // cover camera and a fitted one.
  refIntrinsics(c) {
    const W = this.canvas.width;
    const H = this.canvas.height;
    const i = this.intrinsics(c);
    return { f: i.f / i.k, pp: [(i.cx - W / 2) / i.k, (i.cy - H / 2) / i.k] };
  }

  getCamera() {
    const c = this.cam;
    const r = this.refIntrinsics(c);
    const out = { pos: [...c.pos], yaw: c.yaw, pitch: c.pitch, roll: c.roll, f: r.f, pp: r.pp, fovY: (2 * Math.atan(REF_H / 2 / r.f)) / D2R };
    if (c.fit) out.fit = c.fit;
    return out;
  }

  // Partial updates are merged into the current camera. Giving f, fovY or pp (without fit) leaves a fitted framing.
  setCamera(cam) {
    this.stop();
    this.cam = this.merge(this.cam, cam);
    this.watchFit();
    this.requestRender();
  }

  merge(base, cam) {
    const next = { ...base, ...cam };
    if (!("fit" in cam) && (cam.f != null || cam.fovY != null || cam.pp)) next.fit = null;
    next.f = cam.f ?? (cam.fovY != null ? undefined : base.f);
    return normCam(next);
  }

  requestRender(ss) {
    if (this.pending) return;
    this.pending = requestAnimationFrame(() => {
      this.pending = 0;
      this.render(ss);
    });
  }

  // While the camera is fitted to an element, follow that element (scrolling, layout changes): scroll re-renders
  // at motion quality and once more at full quality when it stops; a light poll catches other layout moves.
  watchFit() {
    const on = !!(this.cam.fit && !this.anim);
    if (!on) {
      if (this.fitWatch) {
        removeEventListener("scroll", this.fitWatch.onScroll, true);
        clearInterval(this.fitWatch.poll);
        clearTimeout(this.fitWatch.still);
        this.fitWatch = null;
      }
      return;
    }
    if (this.fitWatch) return;
    const key = () => {
      const r = this.cam.fit && this.fitRect(this.cam.fit);
      return r ? `${r.s.toFixed(4)},${r.left.toFixed(1)},${r.top.toFixed(1)}` : "";
    };
    const w = (this.fitWatch = { last: key() });
    w.onScroll = () => {
      w.last = key();
      this.requestRender(this.ssMotion);
      clearTimeout(w.still);
      w.still = setTimeout(() => this.render(), 160);
    };
    w.poll = setInterval(() => {
      const k = key();
      if (k !== w.last) {
        w.last = k;
        this.render();
      }
    }, 250);
    addEventListener("scroll", w.onScroll, { capture: true, passive: true });
  }

  // A camera that shows a pinhole image (e.g. a clip's 720x1280 frame) exactly inside `element`.
  static fitCamera({ pos, yaw, pitch, roll = 0 }, image, element) {
    return { pos: [...pos], yaw, pitch, roll, fit: { element, image: { ...image } } };
  }

  // Midpoint for a camera path from P0 to P3 that stays clear of the hoop's solids and above the floor: tries a
  // fan of lifted / sideways-bowed quadratic paths and keeps the cheapest one without collisions.
  planVia(P0, P3) {
    const d = len(sub(P3, P0));
    const mid = mul(add(P0, P3), 0.5);
    let side = [P3[2] - P0[2], 0, P0[0] - P3[0]];
    side = len(side) > 1e-6 ? norm(side) : [1, 0, 0];
    const floorY = Math.min(0.15, P0[1], P3[1]) - 1e-3;
    const m = 0.35;
    const hits = (via) => {
      const C = mul(sub(via, mul(add(P0, P3), 0.125)), 1 / 0.75);
      let n = 0;
      for (let i = 1; i < 48; i++) {
        const t = i / 48;
        const u = 1 - t;
        const p = add(add(mul(P0, u * u), mul(C, 2 * u * t)), mul(P3, t * t));
        if (p[1] < floorY) n++;
        for (const [x0, x1, y0, y1, z0, z1] of OBSTACLES) {
          if (p[0] > x0 - m && p[0] < x1 + m && p[1] > y0 - m && p[1] < y1 + m && p[2] > z0 - m && p[2] < z1 + m) n++;
        }
      }
      return n;
    };
    let best = null;
    // a gentle lift (about 6% of the distance, at most 1 m) unless that path hits something
    for (const lift of [Math.min(0.06, 1 / Math.max(d, 1e-3)), 0.15, 0.3, 0.5]) {
      for (const lat of [0, 0.3, -0.3, 0.6, -0.6]) {
        const via = add(add(mid, [0, lift * d, 0]), mul(side, lat * d));
        const cost = hits(via) * 1000 + Math.abs(lat) * 2 + lift;
        if (!best || cost < best.cost) best = { via, cost };
      }
    }
    return best.via;
  }

  // Animate to `target` over `ms`. Position follows a smooth path through opts.via [x,y,z] at the midpoint
  // (default: planVia, a lifted arc that avoids the hoop and the floor; opts.arc = lift in metres instead); the view
  // follows a sliding look point (opts.orient "look", default) or is slerped (opts.orient "slerp"), roll is
  // interpolated along the shortest way; f is interpolated geometrically
  // and the principal point linearly. The target may be fitted to an element (fitCamera): its intrinsics are
  // re-evaluated every frame, so a resize during the flight still lands exactly. ease: a name in EASES or a
  // function. Resolves true when done, false if interrupted by another animateTo / setCamera / stop. Honours
  // prefers-reduced-motion (cuts) unless opts.ignoreReducedMotion.
  animateTo(target, ms = 1200, ease = "inOutCubic", opts = {}) {
    this.stop();
    const a = normCam({ ...this.getCamera(), fit: null }); // current view, frozen as reference intrinsics
    const b = this.merge({ ...a, roll: 0, pp: [0, 0] }, target);
    const reduce = !opts.ignoreReducedMotion && matchMedia("(prefers-reduced-motion: reduce)").matches;
    const fn = typeof ease === "function" ? ease : EASES[ease] || EASES.inOutCubic;
    const P0 = a.pos;
    const P3 = b.pos;
    let P1;
    let P2;
    if (opts.via || opts.arc == null) {
      const via = opts.via ?? this.planVia(P0, P3);
      const C = mul(sub(via, mul(add(P0, P3), 0.125)), 1 / 0.75); // quadratic through via at t = 0.5, as a cubic
      P1 = add(mul(P0, 1 / 3), mul(C, 2 / 3));
      P2 = add(mul(P3, 1 / 3), mul(C, 2 / 3));
    } else {
      const lift = [0, opts.arc, 0];
      P1 = add(add(P0, mul(sub(P3, P0), 1 / 3)), lift);
      P2 = add(add(P0, mul(sub(P3, P0), 2 / 3)), lift);
    }
    this.path = { P0, P1, P2, P3 };
    const F0 = basis(a.yaw, a.pitch).fwd;
    const F1 = basis(b.yaw, b.pitch).fwd;
    // Orientation: "look" (default) aims at a target that slides from where the start view looks (at the camera's
    // distance to the rim) to where the end view looks, pulled toward the rim mid-flight (weight sin(pi t)): big
    // turns keep the hoop in view instead of swinging through the floor or sky. If the target gets within 2 m of
    // the camera the direction eases back to the slerp. "slerp": the view direction turns along the shortest arc.
    const rim = [BASKET_X, RIM_Y, 0];
    const LA = add(P0, mul(F0, Math.max(2, len(sub(rim, P0)))));
    const LB = add(P3, mul(F1, Math.max(2, len(sub(rim, P3)))));
    let dRoll = b.roll - a.roll;
    dRoll -= 360 * Math.round(dRoll / 360);
    const at = (t) => {
      const u = 1 - t;
      const pos = add(add(mul(P0, u * u * u), mul(P1, 3 * u * u * t)), add(mul(P2, 3 * u * t * t), mul(P3, t * t * t)));
      let fw = slerp(F0, F1, t);
      if (opts.orient !== "slerp") {
        // fallback direction: yaw (shortest way) and pitch interpolated, which keeps the horizon level
        let dy = b.yaw - a.yaw;
        dy -= 360 * Math.round(dy / 360);
        fw = basis(a.yaw + dy * t, a.pitch + (b.pitch - a.pitch) * t).fwd;
        const slide = add(LA, mul(sub(LB, LA), t));
        const target = add(slide, mul(sub(rim, slide), Math.sin(Math.PI * t)));
        const look = sub(target, pos);
        const d = len(look);
        const w = Math.min(1, Math.max(0, (d - 0.5) / 1.5));
        fw = norm(add(mul(fw, 1 - w * w * (3 - 2 * w)), mul(look, (w * w * (3 - 2 * w)) / (d || 1))));
      }
      let yaw = Math.atan2(fw[0], -fw[2]) / D2R;
      yaw += 360 * Math.round((a.yaw - yaw) / 360); // continuous with the start (no 360 jumps)
      const pitch = Math.asin(Math.max(-1, Math.min(1, -fw[1]))) / D2R;
      const B = b.fit ? this.refIntrinsics(b) : b; // live: follows the target element
      return {
        pos, yaw, pitch, roll: a.roll + dRoll * t, f: a.f * (B.f / a.f) ** t,
        pp: [a.pp[0] + (B.pp[0] - a.pp[0]) * t, a.pp[1] + (B.pp[1] - a.pp[1]) * t], fit: null,
      };
    };
    return new Promise((resolve) => {
      if (reduce || ms <= 0) {
        this.cam = b;
        this.watchFit();
        this.render();
        resolve(true);
        return;
      }
      const t0 = performance.now();
      const anim = { resolve, raf: 0, frames: 0, times: [] };
      const step = (now) => {
        const t = Math.min(1, (now - t0) / ms);
        if (t >= 1) {
          this.cam = b;
          this.anim = null;
          this.watchFit();
        } else this.cam = at(fn(t));
        const r0 = performance.now();
        this.render(t >= 1 ? this.ssStill : this.ssMotion);
        anim.times.push(performance.now() - r0);
        anim.frames++;
        if (t >= 1) {
          this.anim = null;
          this.lastAnim = { frames: anim.frames, ms: performance.now() - t0, cpuMs: anim.times };
          resolve(true);
        } else anim.raf = requestAnimationFrame(step);
      };
      this.anim = anim;
      this.watchFit(); // off during the flight
      anim.raf = requestAnimationFrame(step);
    });
  }

  stop() {
    if (!this.anim) return;
    cancelAnimationFrame(this.anim.raf);
    const r = this.anim.resolve;
    this.anim = null;
    r(false);
  }

  // ---- per-frame hoop geometry on the CPU ----
  frameGeometry(view) {
    const { pos, right, up, fwd, f, cx, cyg, H } = view;
    const cam3 = (p) => {
      const v = sub(p, pos);
      return [dot(v, right), dot(v, up), dot(v, fwd)];
    };
    const proj = (c) => [cx + (f * c[0]) / c[2], cyg + (f * c[1]) / c[2]]; // GL px (y up)
    const clipSeg = (a, b) => {
      if (a[2] < NEAR && b[2] < NEAR) return null;
      if (a[2] < NEAR) a = add(a, mul(sub(b, a), (NEAR - a[2]) / (b[2] - a[2])));
      else if (b[2] < NEAR) b = add(b, mul(sub(a, b), (NEAR - b[2]) / (a[2] - b[2])));
      return [a, b];
    };
    const clipPoly = (P) => {
      const out = [];
      for (let k = 0; k < P.length; k++) {
        const a = P[k];
        const b = P[(k + 1) % P.length];
        const ina = a[2] >= NEAR;
        const inb = b[2] >= NEAR;
        if (ina) out.push(a);
        if (ina !== inb) out.push(add(a, mul(sub(b, a), (NEAR - a[2]) / (b[2] - a[2]))));
      }
      return out;
    };
    const net = netStrands(pos);
    const build = (mirror) => {
      // Draw order (painter's). Assemblies 0 stanchion, 1 struts, 2 arm, 3 backboard, 4 bracket, 5 rim + net.
      // The planes x = -1.376 (rim side of the bracket) and x = BOARD_X (board face) separate them, so which side
      // the camera is on decides their order exactly; on the court side this is the Python's order. The stanchion's
      // solids are sorted far to near by centroid distance (the Python's rule).
      const asms = [];
      for (const it of this.scene) {
        if (mirror && !(it.kind === "solid" && it.stan)) continue;
        if (it.decal && pos[0] >= BOARD_X - 0.001) continue; // painted on the front face: hidden from behind
        (asms[it.asm] ||= []).push(it);
      }
      const dist = (it) => len(sub(mul(it.V.reduce(add, [0, 0, 0]), 1 / it.V.length), pos));
      if (asms[0]) asms[0].sort((a, b) => dist(b) - dist(a));
      const rimFirst = pos[0] > BASKET_X + RIM_R - 0.005; // camera beyond the bracket's rim end: rim is behind it
      const hoopEnd = rimFirst ? [5, 4] : [4, 5];
      const order = pos[0] < BOARD_X ? [0, 1, 2, 3, ...hoopEnd] : [...hoopEnd, 3, 0, 1, 2];
      const draws = [];
      const M = (p) => (mirror ? [p[0], -p[1], p[2]] : p);
      const lineGroup = (segs3, st) => {
        const segs = [];
        for (const [p, q] of segs3) {
          const c = clipSeg(cam3(M(p)), cam3(M(q)));
          if (!c) continue;
          const A = proj(c[0]);
          const B = proj(c[1]);
          segs.push([A[0], A[1], B[0], B[1]]);
        }
        return segs.length ? { segs, st, w: Math.max(st.w * view.k, 0.8) } : null;
      };
      for (const it of order.flatMap((i) => asms[i] || [])) {
        const fills = [];
        let group = null;
        if (it.kind === "solid") {
          const V = it.V.map(M);
          const cen = mul(V.reduce(add, [0, 0, 0]), 1 / V.length);
          const edges = new Map();
          for (const face of it.F) {
            const Q = face.map((i) => V[i]);
            let n = cross(sub(Q[1], Q[0]), sub(Q[2], Q[0]));
            if (len(n) < 1e-12) n = cross(sub(Q[2], Q[0]), sub(Q[3], Q[0]));
            const fc = mul(Q.reduce(add, [0, 0, 0]), 1 / Q.length);
            if (dot(n, sub(fc, cen)) < 0) n = mul(n, -1);
            if (dot(n, sub(pos, fc)) <= 0) continue;
            for (let k = 0; k < face.length; k++) {
              const i = face[k];
              const j = face[(k + 1) % face.length];
              edges.set(i < j ? `${i},${j}` : `${j},${i}`, [V[Math.min(i, j)], V[Math.max(i, j)]]);
            }
            const C = clipPoly(Q.map(cam3));
            if (C.length < 3) continue;
            const pts = C.map(proj);
            let area = 0;
            for (let k = 0; k < pts.length; k++) {
              const [ax, ay] = pts[k];
              const [bx, by] = pts[(k + 1) % pts.length];
              area += ax * by - bx * ay;
            }
            if (Math.abs(area) < 1e-9) continue; // edge-on
            if (area < 0) pts.reverse();
            fills.push({ pts: pts.slice(0, 6), col: it.st.fill });
          }
          // V is already mirrored; lineGroup mirrors again, so hand it the unmirrored edges
          group = lineGroup([...edges.values()].map(([p, q]) => [M(p), M(q)]), it.st);
        } else if (it.kind === "lines") {
          const segs3 = [];
          for (const P of it.polys) for (let k = 0; k + 1 < P.length; k++) segs3.push([P[k], P[k + 1]]);
          group = lineGroup(segs3, it.st);
        } else if (it.kind === "net") {
          group = lineGroup(net[it.which], it.st);
        }
        if (fills.length || group) draws.push({ fills, group });
      }
      return draws;
    };
    const hoop = build(false);
    const refl = build(true);
    // reflection fade start: the stanchion base's front edge on screen (Python: yc), as a row from the top
    const e0 = cam3([0.95, 0, 0.72]);
    const e1 = cam3([2.65, 0, 0.72]);
    const rows = [e0, e1].filter((c) => c[2] > NEAR).map((c) => H - proj(c)[1]);
    const yc = rows.length ? Math.min(...rows) : 0;
    return { hoop, refl, yc };
  }

  // ---- render ----
  render(ss = this.ssStill) {
    if (this.lost || !this.isReady || this.gl.isContextLost()) return;
    const gl = this.gl;
    const W = this.canvas.width;
    const H = this.canvas.height;
    const c = this.cam;
    const { fwd, right, up } = basis(c.yaw, c.pitch, c.roll);
    const { f, cx, cy, k } = this.intrinsics(c); // k: cover scale (line widths, blur radii)
    const view = { pos: c.pos, fwd, right, up, f, cx, cyg: H - cy, H, k };

    // hoop geometry and its screen box (union of the hoop and its reflection, padded for the glow blur)
    const geo = this.frameGeometry(view);
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    const grow = (draws) => {
      for (const { fills, group } of draws) {
        for (const s of fills) for (const [x, y] of s.pts) {
          x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
        }
        if (!group) continue;
        const pad = group.st.soft ? group.w : group.w / 2 + 2;
        for (const s of group.segs) {
          x0 = Math.min(x0, s[0] - pad, s[2] - pad); x1 = Math.max(x1, s[0] + pad, s[2] + pad);
          y0 = Math.min(y0, s[1] - pad, s[3] - pad); y1 = Math.max(y1, s[1] + pad, s[3] + pad);
        }
      }
    };
    grow(geo.hoop);
    grow(geo.refl);
    const blurPad = Math.ceil(3 * 9 * k) + 4;
    const bx0 = Math.max(0, Math.floor(x0 - blurPad));
    const by0 = Math.max(0, Math.floor(y0 - blurPad));
    const bx1 = Math.min(W, Math.ceil(x1 + blurPad));
    const by1 = Math.min(H, Math.ceil(y1 + blurPad));
    const hasHoop = bx1 > bx0 && by1 > by0;
    let T = null;
    if (hasHoop) {
      const bw = bx1 - bx0;
      const bh = by1 - by0;
      T = this.ensureTex(bw, bh);
      gl.disable(gl.SCISSOR_TEST);
      for (const fb of [T.fLayer, T.fH, T.fGlow, T.fRefl]) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
      }
      const box = { ox: bx0, oy: by0, bw, bh };
      // reflection: mirrored stanchion, blurred 2 x 7 px
      const fast = ss < this.ssStill; // motion frame
      this.drawHoop(geo.refl, box, T, fast);
      this.blur(T, box, T.layer, [2.0 * k, 2.0 * k], [7.0 * k, 7.0 * k], [1, 0], T.fRefl);
      // hoop, then its glow: 0.30 * blur(2.4 px) + 0.06 * blur(9 px)
      this.drawHoop(geo.hoop, box, T, fast);
      this.blur(T, box, T.glow, [2.4 * k, 9 * k], [2.4 * k, 9 * k], [0.3, 0.06], T.fGlow);
      this.box = box;
    }

    // final full-screen pass
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, W, H);
    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.SCISSOR_TEST);
    const P = this.pFinal;
    gl.useProgram(P.p);
    const u = P.u;
    gl.uniform2f(u.uRes, W, H);
    gl.uniform3fv(u.uPos, c.pos);
    gl.uniform3fv(u.uFwd, fwd);
    gl.uniform3fv(u.uRight, right);
    gl.uniform3fv(u.uUp, up);
    gl.uniform1f(u.uF, f);
    gl.uniform2f(u.uC, cx, cy);
    gl.uniform1i(u.uSS, Math.max(1, Math.min(4, ss | 0)));
    const bb = this.opts.backdrop === "camera" ? { fwd, right, up } : basis(DEFAULT_CAMERA.yaw, DEFAULT_CAMERA.pitch);
    gl.uniform3fv(u.uB0, bb.right);
    gl.uniform3fv(u.uB1, bb.up);
    gl.uniform3fv(u.uB2, bb.fwd);
    gl.uniform3fv(u.uLP, this.lights.flatMap((l) => l.pos));
    gl.uniform3fv(u.uLC, this.lights.flatMap((l) => l.col));
    gl.uniform1f(u.uScale, k);
    gl.uniform1i(u.uHoop, hasHoop ? 1 : 0);
    const bind = (unit, name, tex) => {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.uniform1i(u[name], unit);
    };
    bind(0, "uLayer", hasHoop ? T.layer : this.empty);
    bind(1, "uRefl", hasHoop ? T.reflOut : this.empty);
    bind(2, "uGlow", hasHoop ? T.glowOut : this.empty);
    if (hasHoop) {
      gl.uniform4f(u.uBox, bx0, by0, bx1 - bx0, by1 - by0);
      gl.uniform2f(u.uTex, T.W, T.H);
    }
    gl.uniform1f(u.uYc, geo.yc);
    gl.bindVertexArray(this.triVao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
    this.drawn = true;
    this.lastSS = ss;
    if (this.onRender) this.onRender(this);
  }

  // Painter's algorithm over the ordered draw list: each item's fills, then its lines as one union.
  drawHoop(draws, box, T, fast = false) {
    const gl = this.gl;
    const { ox, oy, bw, bh } = box;
    gl.bindFramebuffer(gl.FRAMEBUFFER, T.fLayer);
    gl.viewport(0, 0, bw, bh);
    gl.disable(gl.SCISSOR_TEST);
    gl.disable(gl.DEPTH_TEST);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    // all instance data up front (texture px): fills in one buffer, segments in another
    const nf = draws.reduce((s, d) => s + d.fills.length, 0);
    const fa = new Float32Array(Math.max(nf, 1) * 20);
    const ns = draws.reduce((s, d) => s + (d.group ? d.group.segs.length : 0), 0);
    const la = new Float32Array(Math.max(ns, 1) * 4);
    let fi = 0;
    let li = 0;
    for (const d of draws) {
      d.fillStart = fi;
      for (const s of d.fills) {
        const o = fi * 20;
        for (let v = 0; v < 6; v++) {
          const p = s.pts[Math.min(v, s.pts.length - 1)];
          fa[o + v * 2] = p[0] - ox;
          fa[o + v * 2 + 1] = p[1] - oy;
        }
        fa[o + 12] = s.pts.length;
        fa.set(s.col, o + 16);
        fa[o + 19] = 1;
        fi++;
      }
      if (!d.group) continue;
      d.group.start = li;
      for (const s of d.group.segs) {
        la.set([s[0] - ox, s[1] - oy, s[2] - ox, s[3] - oy], li * 4);
        li++;
      }
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, this.fillBuf);
    gl.bufferData(gl.ARRAY_BUFFER, fa, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.lineBuf);
    gl.bufferData(gl.ARRAY_BUFFER, la, gl.DYNAMIC_DRAW);

    for (const d of draws) {
      if (d.fills.length) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, T.fLayer);
        gl.disable(gl.SCISSOR_TEST);
        gl.enable(gl.BLEND);
        gl.blendEquation(gl.FUNC_ADD);
        gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
        gl.useProgram(this.pFill.p);
        gl.uniform2f(this.pFill.u.uVp, bw, bh);
        gl.bindVertexArray(this.fillVao);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.fillBuf);
        for (let k = 0; k < 5; k++) gl.vertexAttribPointer(k + 1, 4, gl.FLOAT, false, 80, d.fillStart * 80 + k * 16);
        gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, d.fills.length);
      }
      const gr = d.group;
      if (!gr) continue;
      // group box in texture px
      const pad = (gr.st.soft ? gr.w : gr.w / 2 + 2) + 1;
      let gx0 = Infinity;
      let gy0 = Infinity;
      let gx1 = -Infinity;
      let gy1 = -Infinity;
      for (const s of gr.segs) {
        gx0 = Math.min(gx0, s[0], s[2]); gx1 = Math.max(gx1, s[0], s[2]);
        gy0 = Math.min(gy0, s[1], s[3]); gy1 = Math.max(gy1, s[1], s[3]);
      }
      const sx0 = Math.max(0, Math.floor(gx0 - pad - ox));
      const sy0 = Math.max(0, Math.floor(gy0 - pad - oy));
      const sx1 = Math.min(bw, Math.ceil(gx1 + pad - ox));
      const sy1 = Math.min(bh, Math.ceil(gy1 + pad - oy));
      if (sx1 <= sx0 || sy1 <= sy0) continue;
      gl.enable(gl.SCISSOR_TEST);
      gl.scissor(sx0, sy0, sx1 - sx0, sy1 - sy0);
      gl.useProgram(this.pLine.p);
      gl.uniform2f(this.pLine.u.uVp, bw, bh);
      gl.uniform1f(this.pLine.u.uW, gr.w);
      gl.uniform1i(this.pLine.u.uSoft, gr.st.soft ? 1 : 0);
      gl.uniform1i(this.pLine.u.uDirect, fast ? 1 : 0);
      gl.uniform4f(this.pLine.u.uCol, ...gr.st.line, gr.st.line_a);
      gl.uniform1f(this.pLine.u.uGlowK, gr.st.glow);
      gl.bindVertexArray(this.lineVao);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.lineBuf);
      gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 16, gr.start * 16);
      gl.enable(gl.BLEND);
      if (fast) {
        // motion frames: straight "over" into the layer; crossings within a group double up slightly, unseen in motion
        gl.bindFramebuffer(gl.FRAMEBUFFER, T.fLayer);
        gl.blendEquation(gl.FUNC_ADD);
        gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
        gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, gr.segs.length);
        continue;
      }
      // union coverage
      gl.bindFramebuffer(gl.FRAMEBUFFER, T.fCov);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.blendEquation(gl.MAX);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, gr.segs.length);
      // composite over the layer
      gl.bindFramebuffer(gl.FRAMEBUFFER, T.fLayer);
      gl.blendEquation(gl.FUNC_ADD);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.useProgram(this.pGroup.p);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, T.cov);
      gl.uniform1i(this.pGroup.u.uCov, 0);
      gl.uniform4f(this.pGroup.u.uCol, ...gr.st.line, gr.st.line_a);
      gl.uniform1f(this.pGroup.u.uGlowK, gr.st.glow);
      gl.bindVertexArray(this.triVao);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
    gl.bindVertexArray(null);
    gl.disable(gl.SCISSOR_TEST);
    gl.disable(gl.BLEND);
  }

  // Separable blur: H (full -> half resolution, two sigmas into hA / hB), then V into `out` with weights.
  blur(T, box, src, sH, sV, wt, out) {
    const gl = this.gl;
    const hw = Math.ceil(box.bw / 2) + 1;
    const hh = Math.ceil(box.bh / 2) + 1;
    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);
    gl.bindVertexArray(this.triVao);
    gl.bindFramebuffer(gl.FRAMEBUFFER, T.fH);
    gl.viewport(0, 0, hw, hh);
    gl.useProgram(this.pBlurH.p);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, src);
    gl.uniform1i(this.pBlurH.u.uSrc, 0);
    gl.uniform2f(this.pBlurH.u.uSrcSize, T.W, T.H);
    gl.uniform2f(this.pBlurH.u.uS, Math.max(sH[0], 0.3), Math.max(sH[1], 0.3));
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindFramebuffer(gl.FRAMEBUFFER, out);
    gl.useProgram(this.pBlurV.p);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, T.hA);
    gl.uniform1i(this.pBlurV.u.uA, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, T.hB);
    gl.uniform1i(this.pBlurV.u.uB, 1);
    gl.uniform2f(this.pBlurV.u.uHalfSize, T.W / 2, T.H / 2);
    gl.uniform2f(this.pBlurV.u.uS, Math.max(sV[0], 0.3), Math.max(sV[1], 0.3));
    gl.uniform2f(this.pBlurV.u.uWt, wt[0], wt[1]);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
  }

  // GPU time of n still renders (ms each), synchronised with a 1-pixel read-back.
  bench(n = 20, ss = this.ssStill) {
    const gl = this.gl;
    const px = new Uint8Array(4);
    const sync = () => gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    this.render(ss);
    sync();
    const t = performance.now();
    for (let i = 0; i < n; i++) this.render(ss);
    sync();
    return (performance.now() - t) / n;
  }
}
