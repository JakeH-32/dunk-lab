// Live line-art views on the GPU (WebGL2), a port of the Unreal pipeline in Tools/FXLab:
//   1. Seed pass (seed_final.hlsl): a ridge detector marks line pixels and stores their coordinates.
//   2. Jump Flooding (Rong & Tan 2006): log2(size) passes spread every pixel's nearest line.
//   3. Display (motion/display_motion.hlsl): Distance, Re-stroke, Grassfire, Chrome tubes, Trails, Speed.
// Motion: each new video frame keeps the previous frame's field. The nearest previous line to a line point
// is how far it moved (normal flow): Speed colours lines by it, Trails accumulate moving lines in a fading
// feedback buffer, and slow motion builds in-between fields by sliding seeds part of the way and re-flooding.
// Fields store texel coordinates in 1/32 px fixed point packed into RGBA8 (2 bytes per axis), because rendering
// to float textures isn't reliable on phones; 65535 (all bytes 255) means "no line". The maths runs in linear light,
// like Unreal: the video is uploaded as plain RGBA8 and decoded from sRGB on every texelFetch (vid()), which is exact
// for unfiltered fetches. (Uploading video into an SRGB8_ALPHA8 texture takes a slow path in Chrome: ~10 ms per
// 720x1280 frame, ~29 ms for the packed 2192x1280 clip, against ~0.2 ms for RGBA8.)
//
// Phones show the field at about 1:1 (a 720 px clip across a 360-430 pt screen at 2x), while desktop windows
// shrink it to about half, which hides single-pixel faults. So the seed pass drops the faint maxima on a line's
// flank and stores each seed at its sub-pixel ridge centre; before, those flank seeds and whole-pixel positions
// showed on phones as jagged strokes with little ticks and dots. Debug: ?fxdpr=2 (any number) in the URL renders the
// canvas at that pixel ratio instead of min(devicePixelRatio, 2), e.g. to see phone-like 1:1 output on desktop.

const VS = `#version 300 es
in vec2 p;
void main() { gl_Position = vec4(p, 0.0, 1.0); }`;

const COMMON = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D; // samplers default to lowp in GLSL ES, and phone GPUs honour it
out vec4 o;
vec3 vid(vec3 c) { return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(vec3(0.04045), c)); } // sRGB -> linear
const float FIX = 32.0;    // field coordinates are stored in 1/32 px
const float NONE = 2000.0; // decoded coordinates above this mean "no line" (65535 / 32 = 2048)
vec4 enc(vec2 s) { s = floor(s * FIX + 0.5); return vec4(floor(s.x / 256.0), mod(s.x, 256.0), floor(s.y / 256.0), mod(s.y, 256.0)) / 255.0; }
vec2 dec(vec4 t) { vec4 b = floor(t * 255.0 + 0.5); return vec2(b.x * 256.0 + b.y, b.z * 256.0 + b.w) / FIX; }
// Ridge fit on a 3x3 neighbourhood v (row-major, v[4] = centre): unit normal n across the line, its curvature
// kc (negative on a bright line) and the offset along n to the ridge centre, clamped to under half a pixel
// (with room for the 1/32 px rounding) so the seed's nearest pixel stays its own.
void ridgeFit(float v[9], out vec2 n, out float off, out float kc) {
  float gx = 0.5 * (v[5] - v[3]);
  float gy = 0.5 * (v[7] - v[1]);
  float hxx = v[5] - 2.0 * v[4] + v[3];
  float hyy = v[7] - 2.0 * v[4] + v[1];
  float hxy = 0.25 * (v[8] - v[2] - v[6] + v[0]);
  float phi = 0.5 * atan(2.0 * hxy, hxx - hyy + 1e-6) + 1.5707963;
  n = vec2(cos(phi), sin(phi));
  kc = n.x * n.x * hxx + 2.0 * n.x * n.y * hxy + n.y * n.y * hyy;
  off = (kc < -1e-4) ? -(gx * n.x + gy * n.y) / min(kc, -1e-4) : 0.0;
  off = clamp(off, -0.45, 0.45);
}
`;

const SEED = COMMON + `
uniform sampler2D uVideo;
uniform vec2 uRes;
float lum(ivec2 q) { vec3 t = vid(texelFetch(uVideo, clamp(q, ivec2(0), ivec2(uRes) - 1), 0).rgb); return sqrt(max(max(t.r, t.g), t.b)); }
void main() {
  const float kContrast = 0.07;
  const float kSlope = 0.75;
  ivec2 ip = ivec2(gl_FragCoord.xy);
  float v[9];
  for (int j = 0; j < 3; j++)
  for (int i = 0; i < 3; i++) v[j * 3 + i] = lum(ip + ivec2(i - 1, j - 1));
  float c = v[4];
  // ridge: a local maximum along any of the 4 axes (prom = how far it stands above both neighbours there)
  bool ridge = false;
  float prom = 0.0, top = c;
  for (int k = 0; k < 4; k++) {
    float a = k == 0 ? v[3] : k == 1 ? v[1] : k == 2 ? v[0] : v[6];
    float b = k == 0 ? v[5] : k == 1 ? v[7] : k == 2 ? v[8] : v[2];
    if (c > a && c >= b && c - min(a, b) >= kContrast) { ridge = true; prom = max(prom, c - max(a, b)); }
    top = max(top, max(a, b));
  }
  // Thin anti-aliased lines brighten and dim as they cross the pixel grid, so the faint fringe beside a line
  // has small maxima along it. Those sit on the slope up to the line (a neighbour far brighter than the bump
  // is high) and drew as ticks and dots: a seed must stand out more than it is overshadowed.
  bool peak = prom >= kSlope * (top - c);
  vec2 n; float off, kc;
  ridgeFit(v, n, off, kc);
  // stored at the sub-pixel ridge centre, so distances (and every view built on them) are smooth, not stepped
  o = (ridge && peak && c >= 0.1) ? enc(vec2(ip) + off * n) : vec4(1.0);
}`;

const STEP = COMMON + `
uniform sampler2D uField;
uniform int uStep;
uniform ivec2 uSize;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec2 pf = vec2(p);
  float best = 1e20;
  vec4 bestT = vec4(1.0);
  for (int j = -1; j <= 1; j++)
  for (int i = -1; i <= 1; i++) {
    ivec2 q = p + ivec2(i, j) * uStep;
    if (q.x < 0 || q.y < 0 || q.x >= uSize.x || q.y >= uSize.y) continue;
    vec4 t = texelFetch(uField, q, 0);
    vec2 s = dec(t);
    if (s.x > NONE) continue;
    vec2 r = pf - s;
    float dd = dot(r, r);
    if (dd < best) { best = dd; bestT = t; }
  }
  o = bestT;
}`;

const COPY = COMMON + `
uniform sampler2D uSrc;
void main() { o = texelFetch(uSrc, ivec2(gl_FragCoord.xy), 0); }`;

// In-between seeds (motion/seed_interp.hlsl). Seeds slide from their own sub-pixel positions, and the moved
// positions keep 1/32 px precision.
const INTERP = COMMON + `
uniform sampler2D uPrev;
uniform sampler2D uCur;
uniform float uBlend;
void main() {
  const float kMaxMove = 48.0;
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec2 pf = vec2(p);
  vec2 sp = dec(texelFetch(uPrev, p, 0));
  vec2 sc = dec(texelFetch(uCur, p, 0));
  bool prevLine = sp.x < NONE && all(lessThan(abs(sp - pf), vec2(0.5)));
  bool curLine = sc.x < NONE && all(lessThan(abs(sc - pf), vec2(0.5)));
  // unmatched points (big jumps, appearing/disappearing lines) cut over at the midpoint instead of double-exposing
  o = vec4(1.0);
  if (prevLine) {
    vec2 v = sc.x < NONE ? sc - sp : vec2(1e4);
    if (dot(v, v) <= kMaxMove * kMaxMove) { o = enc(sp + uBlend * v); return; }
    if (uBlend < 0.5) { o = enc(sp); return; }
  }
  if (curLine) {
    vec2 v = sp.x < NONE ? sp - sc : vec2(1e4);
    if (dot(v, v) <= kMaxMove * kMaxMove) { o = enc(sc + (1.0 - uBlend) * v); return; }
    if (uBlend >= 0.5) { o = enc(sc); return; }
  }
}`;

const SPEED_COLOR = `
vec3 speedColor(float t) {
  vec3 c = mix(vec3(0.10, 0.35, 1.0), vec3(0.15, 0.90, 1.0), clamp(t * 3.0, 0.0, 1.0));
  c = mix(c, vec3(1.0), clamp(t * 3.0 - 1.0, 0.0, 1.0));
  return mix(c, vec3(1.0, 0.50, 0.12), clamp(t * 3.0 - 2.0, 0.0, 1.0));
}`;

// Motion-trail feedback (motion/trail.hlsl). RGBA8 storage, so the fade also subtracts one step to reach 0.
const TRAIL = COMMON + SPEED_COLOR + `
uniform sampler2D uPrev;
uniform sampler2D uCur;
uniform sampler2D uTrailIn;
uniform ivec2 uSize;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec2 pf = vec2(p);
  vec3 old = max(texelFetch(uTrailIn, p, 0).rgb * 0.82 - 1.0 / 255.0, 0.0);
  vec2 sc = dec(texelFetch(uCur, p, 0));
  if (sc.x > NONE) { o = vec4(old, 1.0); return; }
  float cov = clamp(2.0 - length(pf - sc), 0.0, 1.0);
  vec2 sp = dec(texelFetch(uPrev, clamp(ivec2(sc + 0.5), ivec2(0), uSize - 1), 0));
  float spd = sp.x > NONE ? 0.0 : min(length(sc - sp), 24.0);
  vec3 c = speedColor(clamp(spd / 12.0, 0.0, 1.0));
  o = vec4(max(old, c * (cov * smoothstep(2.0, 7.0, spd))), 1.0);
}`;

const DISPLAY = COMMON + SPEED_COLOR + `
uniform sampler2D uVideo;
uniform sampler2D uField;
uniform sampler2D uPrev;
uniform sampler2D uTrail;
uniform vec2 uRes;
uniform vec2 uCanvas;
uniform int uMode;
uniform float uWidth;
uniform float uGlow;
uniform float uTime;
uniform bool uSlowMo;
vec3 toSrgb(vec3 c) { return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }
vec2 field(sampler2D f, ivec2 q) { return dec(texelFetch(f, q, 0)); }

vec3 shade() {
  vec2 UV = vec2(gl_FragCoord.x / uCanvas.x, 1.0 - gl_FragCoord.y / uCanvas.y);
  vec2 x = UV * uRes - 0.5;
  float fp = max(max(length(dFdx(x)), length(dFdy(x))), 0.25);
  ivec2 b = ivec2(floor(x));
  ivec2 hi = ivec2(uRes) - 1;

  vec2 S[4]; float D2[4];
  float best = 1e10;
  vec2 s = vec2(0.0);
  for (int k = 0; k < 4; k++) {
    ivec2 q = clamp(b + ivec2(k & 1, k >> 1), ivec2(0), hi);
    vec2 f = field(uField, q);
    vec2 r = x - f;
    float dd = (f.x > NONE) ? 1e10 : dot(r, r);
    S[k] = f; D2[k] = dd;
    if (dd < best) { best = dd; s = f; }
  }
  float d = sqrt(best);

  // sub-pixel stroke distance from a Hessian ridge fit on the video (skipped for slow-motion in-betweens)
  const float L = 1.5;
  float ds = d;
  vec2 nrm = vec2(0.0);
  vec2 cp = s;
  if (d < L + 2.5 && !uSlowMo) {
    // refit at the seed's own pixel (seeds sit within half a pixel of it): same fit as the seed pass, so the
    // fitted point is the stored seed, and the stroke also extends L along the line between seeds
    ivec2 sp = clamp(ivec2(floor(s + 0.5)), ivec2(0), hi);
    float v[9];
    for (int j = 0; j < 3; j++)
    for (int i = 0; i < 3; i++) {
      vec3 c = vid(texelFetch(uVideo, clamp(sp + ivec2(i - 1, j - 1), ivec2(0), hi), 0).rgb);
      v[j * 3 + i] = sqrt(max(c.r, max(c.g, c.b)));
    }
    vec2 n; float off, kc;
    ridgeFit(v, n, off, kc);
    vec2 rr = x - (vec2(sp) + off * n);
    float perp = abs(dot(rr, n));
    float alng = rr.y * n.x - rr.x * n.y;
    float along = abs(alng);
    float dr = sqrt(perp * perp + max(along - L, 0.0) * max(along - L, 0.0));
    float wb = smoothstep(L + 1.0, L + 2.5, d);
    ds = mix(dr, d, wb);
    vec2 qp = vec2(sp) + off * n + clamp(alng, -L, L) * vec2(-n.y, n.x);
    cp = mix(qp, s, wb);
    nrm = n;
  }
  float core = clamp((0.5 * uWidth - ds) / fp + 0.5, 0.0, 1.0);
  vec3 ink = vec3(0.95, 0.97, 1.0);
  float e = max(ds - 0.5 * uWidth, 0.0);
  float halo = uGlow * (0.9 * exp(-e / 1.6) + 0.12 * exp(-e / 7.0));

  // medial axis (shared by Distance and Grassfire)
  vec2 g0 = x - s;
  float m = 1e4;
  for (int k2 = 0; k2 < 4; k2++) {
    vec2 ek = x - S[k2];
    float dk = sqrt(D2[k2]);
    float cs = dot(ek, g0) / max(dk * d, 1e-4);
    float sep = length(S[k2] - s);
    if (D2[k2] < 1e9 && cs < 0.5 && sep > 0.5) m = min(m, (D2[k2] - best) / (2.0 * max(sep, 0.5)));
  }

  if (uMode == 1) {  // DISTANCE: tinted isolines + medial axis
    float t = clamp(d / 128.0, 0.0, 1.0);
    vec3 tint = mix(vec3(0.10, 0.45, 1.0), vec3(0.10, 0.08, 0.45), sqrt(t));
    vec3 dcol = vec3(0.004, 0.005, 0.009) + tint * (0.07 * exp(-d / 28.0));
    float kq = d / 8.0;
    float id = abs(fract(kq + 0.5) - 0.5) * 8.0;
    float iso = clamp(1.0 - id / fp, 0.0, 1.0) * smoothstep(3.0, 5.0, d);
    float amaj = (mod(floor(kq + 0.5), 4.0) < 0.5) ? 0.75 : 0.30;
    dcol = mix(dcol, tint, iso * amaj * mix(1.0, 0.35, t));
    float med = clamp(1.0 - m / fp, 0.0, 1.0) * smoothstep(3.0, 8.0, d);
    dcol = mix(dcol, vec3(0.10, 0.42, 1.0), med * 0.9);
    return mix(dcol, ink, core);
  }
  if (uMode == 2) {  // RE-STROKE
    vec3 col = vec3(0.002, 0.0025, 0.004) + vec3(0.046, 0.258, 1.0) * halo;
    return mix(col, ink, core);
  }
  if (uMode == 3) {  // GRASSFIRE: fronts launched from every line meet on the medial axis
    const float PERIOD = 64.0, TAIL = 8.0, ENV_R = 100.0, LEAD_R = 70.0, FLASH_TAIL = 10.0;
    float ph = fract(uTime * 0.9375);
    float behind = fract(ph - d / PERIOD) * PERIOD;
    float env = exp(-d / ENV_R) * smoothstep(6.0, 14.0, d);
    float lead = clamp(1.0 - min(behind, PERIOD - behind) / fp, 0.0, 1.0) * exp(-d / LEAD_R);
    float ring = env * (0.85 * lead + 0.45 * exp(-behind / TAIL));
    vec3 col = vec3(0.0025, 0.003, 0.005) + vec3(0.046, 0.258, 1.0) * (ring * 0.55);
    col = mix(col, vec3(0.45, 0.70, 1.0), clamp(lead * env * 0.9, 0.0, 1.0));
    float axis = clamp(1.0 - m / (1.5 * fp), 0.0, 1.0) * smoothstep(6.0, 14.0, d);
    float flash = exp(-behind / FLASH_TAIL);
    col = mix(col, vec3(0.10, 0.42, 1.0), clamp(axis * flash * exp(-d / (2.0 * ENV_R)), 0.0, 1.0));
    col += vec3(0.046, 0.258, 1.0) * halo;
    return mix(col, ink, core);
  }
  if (uMode == 4) {  // CHROME TUBES: lines extruded into lit pipes on a plate
    float R = 1.6 * uWidth;
    vec2 xs = x - vec2(3.0, 4.0);
    ivec2 bs = ivec2(floor(xs));
    float b2 = 1e10;
    for (int k3 = 0; k3 < 4; k3++) {
      vec2 f2 = field(uField, clamp(bs + ivec2(k3 & 1, k3 >> 1), ivec2(0), hi));
      vec2 r2 = xs - f2;
      b2 = min(b2, (f2.x > NONE) ? 1e10 : dot(r2, r2));
    }
    float shadow = 0.7 * (1.0 - smoothstep(R, R + 6.0, sqrt(b2)));
    float ao = 1.0 - 0.6 * exp(-max(ds - R, 0.0) / 2.5);
    float spill = uGlow * 0.10 * exp(-max(ds - R, 0.0) / 6.0);
    vec3 col = vec3(0.010, 0.011, 0.014) * (ao * (1.0 - shadow)) + vec3(0.046, 0.258, 1.0) * (spill * (1.0 - shadow));
    vec2 gv = x - cp;
    gv = (dot(nrm, nrm) > 0.5) ? nrm * ((dot(gv, nrm) >= 0.0) ? 1.0 : -1.0) : gv / max(length(gv), 1e-3);
    float t = clamp(ds / R, 0.0, 1.0);
    float nz = sqrt(max(1.0 - t * t, 0.0));
    vec3 rv = vec3(2.0 * nz * gv * t, 2.0 * nz * nz - 1.0);
    float rk = clamp(dot(rv, normalize(vec3(-0.55, -0.65, 0.52))), 0.0, 1.0);
    float rf = clamp(dot(rv, normalize(vec3(0.75, 0.45, 0.48))), 0.0, 1.0);
    float fres = (1.0 - nz) * (1.0 - nz) * (1.0 - nz);
    float key = min(1.3 * rk * rk * rk + 1.6 * pow(rk, 12.0), 0.92);
    vec3 tube = vec3(0.035, 0.038, 0.045) + key + vec3(0.046, 0.258, 1.0) * (uGlow * (2.0 * rf * rf * rf + 1.2 * fres));
    float cov = clamp((R - ds) / fp + 0.5, 0.0, 1.0);
    return clamp(mix(col, tube, cov), 0.0, 1.0);
  }
  if (uMode == 5) {  // TRAILS
    vec3 tr = texture(uTrail, UV).rgb;
    vec3 col = vec3(0.002, 0.0025, 0.004) + tr * 1.1 + vec3(0.046, 0.258, 1.0) * (halo * 0.6);
    return mix(col, ink, core);
  }
  // SPEED: lines coloured by how far they moved since the previous frame
  vec2 pv = field(uPrev, clamp(ivec2(s + 0.5), ivec2(0), hi));
  float spd = (pv.x > NONE || d > 1e4) ? 0.0 : min(length(s - pv), 24.0);
  float t = clamp(spd / 12.0, 0.0, 1.0);
  vec3 sc = speedColor(t);
  vec3 col = vec3(0.002, 0.0025, 0.004) + sc * (halo * mix(0.35, 1.0, t));
  return mix(col, mix(sc, ink, 0.25 * (1.0 - t)), core);
}

void main() { o = vec4(toSrgb(clamp(shade(), 0.0, 1.0)), 1.0); }`;

const MAX_SIDE = 1280; // same working size as the Unreal render targets
const DEBUG_DPR = parseFloat(new URLSearchParams(location.search).get("fxdpr")) || 0; // ?fxdpr=N, see the top

export class LineFX {
  static supported() {
    try {
      return !!document.createElement("canvas").getContext("webgl2");
    } catch (e) {
      return false;
    }
  }

  constructor(canvas, video) {
    this.canvas = canvas;
    this.video = video;
    this.mode = 0;
    this.slowMo = false;
    this.fps = 30;
    this.lastMedia = -1;
    this.newFrameAt = 0;
    this.started = performance.now();
    const gl = (this.gl = canvas.getContext("webgl2", { antialias: false, alpha: false, premultipliedAlpha: false, preserveDrawingBuffer: false }));
    this.progSeed = this.program(SEED);
    this.progStep = this.program(STEP);
    this.progCopy = this.program(COPY);
    this.progInterp = this.program(INTERP);
    this.progTrail = this.program(TRAIL);
    this.progDisplay = this.program(DISPLAY);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.disable(gl.DITHER); // on by default; GPUs that honour it would perturb the packed coordinates
    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    this.videoTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.videoTex);
    this.texParams(gl.LINEAR);
    this.size = [0, 0];
    this.t = null; // render targets: work A/B, cur, prev, shown (interp result), trail A/B
    this.fresh = false;

    new ResizeObserver(() => this.draw()).observe(canvas);
    video.addEventListener("loadstart", () => this.reset());
    this.onFrame = this.onFrame.bind(this);
    this.loop = this.loop.bind(this);
    this.watchFrames();
    video.addEventListener("play", () => this.kick());
  }

  program(fs) {
    const gl = this.gl;
    const sh = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      return s;
    };
    const p = gl.createProgram();
    gl.attachShader(p, sh(gl.VERTEX_SHADER, VS));
    gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs));
    gl.bindAttribLocation(p, 0, "p");
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    const u = {};
    for (let i = 0; i < gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS); i++) {
      const name = gl.getActiveUniform(p, i).name;
      u[name] = gl.getUniformLocation(p, name);
    }
    return { p, u };
  }

  texParams(filter) {
    const gl = this.gl;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }

  target(w, h, filter, clear) {
    const gl = this.gl;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    this.texParams(filter);
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    const rt = { tex, fbo, clear };
    this.clear(rt);
    return rt;
  }

  clear(rt) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, rt.fbo);
    gl.clearColor(rt.clear, rt.clear, rt.clear, rt.clear);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  ensureTargets(w, h) {
    if (this.t && this.size[0] === w && this.size[1] === h) return;
    const gl = this.gl;
    if (this.t) for (const rt of Object.values(this.t)) { gl.deleteTexture(rt.tex); gl.deleteFramebuffer(rt.fbo); }
    const field = () => this.target(w, h, gl.NEAREST, 1); // 1.0 = "no line"
    this.t = { a: field(), b: field(), cur: field(), prev: field(), trailA: this.target(w, h, gl.LINEAR, 0), trailB: this.target(w, h, gl.LINEAR, 0) };
    this.size = [w, h];
  }

  reset() {
    // new clip: forget the previous frame and the trails
    this.lastMedia = -1;
    if (!this.t) return;
    this.clear(this.t.prev);
    this.clear(this.t.cur);
    this.clear(this.t.trailA);
    this.clear(this.t.trailB);
  }

  setMode(mode) {
    this.mode = mode;
    this.canvas.hidden = mode === 0;
    this.fresh = true;
    this.draw();
    this.kick();
  }

  setSlowMo(on) {
    this.slowMo = on;
    this.frameInterval = 1000 / (this.fps * 0.25);
    this.video.playbackRate = on ? 0.25 : 1;
    this.draw();
    this.kick();
  }

  watchFrames() {
    if (this.video.requestVideoFrameCallback) this.video.requestVideoFrameCallback(this.onFrame);
    else requestAnimationFrame(() => this.onFrame(performance.now(), { mediaTime: this.video.currentTime }));
  }

  onFrame(now, meta) {
    const media = meta && meta.mediaTime !== undefined ? meta.mediaTime : this.video.currentTime;
    if (media !== this.lastMedia) {
      const step = media - this.lastMedia;
      if (this.lastMedia >= 0 && step > 0.005 && step < 0.1 && !this.slowMo) this.fps = 0.9 * this.fps + 0.1 * (1 / step);
      this.looped = this.lastMedia >= 0 && media < this.lastMedia;
      this.lastMedia = media;
      // slow motion spreads each in-between over the measured gap between frames (decoders don't deliver
      // frames exactly 4x slower), so blending never finishes early and freezes until the next frame
      const t = performance.now();
      const gap = t - this.newFrameAt;
      if (this.slowMo && gap > 10 && gap < 1000) this.frameInterval = 0.5 * this.frameInterval + 0.5 * gap;
      this.newFrameAt = t;
      this.fresh = true;
      this.draw();
    }
    this.watchFrames();
  }

  // Slow motion and Grassfire animate between video frames, so they redraw every display frame. The loop
  // only runs while that is the case; anything that could start it calls kick().
  animating() {
    return this.mode !== 0 && (this.slowMo || this.mode === 3) && !this.canvas.hidden && !this.video.paused && !!this.video.currentSrc;
  }

  kick() {
    if (!this.looping && this.animating()) {
      this.looping = true;
      requestAnimationFrame(this.loop);
    }
  }

  loop() {
    if (!this.animating()) {
      this.looping = false;
      return;
    }
    this.draw();
    requestAnimationFrame(this.loop);
  }

  pass(prog, rt, textures, uniforms = {}) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, rt ? rt.fbo : null);
    gl.useProgram(prog.p);
    let unit = 0;
    for (const [name, tex] of Object.entries(textures)) {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.uniform1i(prog.u[name], unit++);
    }
    for (const [name, v] of Object.entries(uniforms)) {
      const loc = prog.u[name];
      if (loc === undefined) continue;
      if (Array.isArray(v)) (v.isInt ? gl.uniform2i : gl.uniform2f).call(gl, loc, v[0], v[1]);
      else if (typeof v === "boolean") gl.uniform1i(loc, v ? 1 : 0);
      else if (Number.isInteger(v) && name !== "uWidth" && name !== "uGlow" && name !== "uTime" && name !== "uBlend") gl.uniform1i(loc, v);
      else gl.uniform1f(loc, v);
    }
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.activeTexture(gl.TEXTURE0);
  }

  // Seeds in `t.a` -> jump flooding -> returns the target holding the finished field.
  flood() {
    const [w, h] = this.size;
    const size = Object.assign([w, h], { isInt: true });
    let src = this.t.a, dst = this.t.b;
    for (let step = 1 << Math.ceil(Math.log2(Math.max(w, h)) - 1); step >= 1; step >>= 1) {
      this.pass(this.progStep, dst, { uField: src.tex }, { uStep: step, uSize: size });
      [src, dst] = [dst, src];
    }
    return src;
  }

  // New video frame: previous <- current, rebuild current, update trails.
  buildFrame() {
    const gl = this.gl;
    const v = this.video;
    // packed clips (clips/cutout: line art | real | matte in one video) set data-panel-w: only the left panel is
    // line art, and texelFetch below never reaches past it
    const vw = +v.dataset.panelW || v.videoWidth;
    const scale = Math.min(1, MAX_SIDE / Math.max(vw, v.videoHeight));
    const w = Math.max(1, Math.round(vw * scale));
    const h = Math.max(1, Math.round(v.videoHeight * scale));
    this.ensureTargets(w, h);
    gl.viewport(0, 0, w, h);

    gl.bindTexture(gl.TEXTURE_2D, this.videoTex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, v); // sRGB-encoded: decoded by vid()

    [this.t.prev, this.t.cur] = [this.t.cur, this.t.prev];
    this.pass(this.progSeed, this.t.a, { uVideo: this.videoTex }, { uRes: [w, h] });
    const result = this.flood();
    this.pass(this.progCopy, this.t.cur, { uSrc: result.tex });
    if (this.looped) {
      // looped or rewound: no motion this frame
      this.pass(this.progCopy, this.t.prev, { uSrc: this.t.cur.tex });
      this.clear(this.t.trailA);
      this.clear(this.t.trailB);
    }
    const size = Object.assign([w, h], { isInt: true });
    this.pass(this.progTrail, this.t.trailB, { uPrev: this.t.prev.tex, uCur: this.t.cur.tex, uTrailIn: this.t.trailA.tex }, { uSize: size });
    [this.t.trailA, this.t.trailB] = [this.t.trailB, this.t.trailA];
  }

  draw() {
    if (this.mode === 0 || this.video.readyState < 2 || !this.video.videoWidth) return;
    const gl = this.gl;
    const c = this.canvas;
    const dpr = DEBUG_DPR || Math.min(window.devicePixelRatio || 1, 2);
    const cw = Math.max(1, Math.round(c.clientWidth * dpr));
    const ch = Math.max(1, Math.round(c.clientHeight * dpr));
    if (c.width !== cw || c.height !== ch) {
      c.width = cw;
      c.height = ch;
    }
    gl.bindVertexArray(this.vao);
    if (this.fresh || !this.t) {
      this.buildFrame();
      this.fresh = false;
    }
    const [w, h] = this.size;
    let shown = this.t.cur;
    if (this.slowMo) {
      // in-between frame: slide seeds from the previous toward the current frame, then re-flood
      const blend = Math.min(1, (performance.now() - this.newFrameAt) / Math.max(this.frameInterval, 20));
      gl.viewport(0, 0, w, h);
      this.pass(this.progInterp, this.t.a, { uPrev: this.t.prev.tex, uCur: this.t.cur.tex }, { uBlend: blend });
      shown = this.flood();
    }
    gl.viewport(0, 0, cw, ch);
    this.pass(this.progDisplay, null, { uVideo: this.videoTex, uField: shown.tex, uPrev: this.t.prev.tex, uTrail: this.t.trailA.tex }, {
      uRes: [w, h], uCanvas: [cw, ch], uMode: this.mode, uWidth: 1.5, uGlow: 0.6,
      uTime: this.video.currentTime, uSlowMo: this.slowMo,
    });
  }
}
