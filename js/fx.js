// Live line-art views on the GPU (WebGL2), ported from the Unreal pipeline in Tools/FXLab:
//   1. Seed pass (seed_final.hlsl): a ridge detector marks line pixels and stores their coordinates.
//   2. Jump Flooding (Rong & Tan 2006): log2(size) passes spread every pixel's nearest seed.
//   3. Display (display_final.hlsl): Distance view (isolines + medial axis) or Re-stroke (clean
//      strokes with a blue halo), using a sub-pixel ridge fit near the lines.
// The field stores integer texel coordinates packed into RGBA8 (2 bytes per axis), because
// rendering to float textures isn't reliable on phones; 65535 means "no seed".
// The video is uploaded as an sRGB texture so the maths runs in linear light, like Unreal.

const VS = `#version 300 es
in vec2 p;
void main() { gl_Position = vec4(p, 0.0, 1.0); }`;

const COMMON = `#version 300 es
precision highp float;
precision highp int;
out vec4 o;
vec4 enc(vec2 s) { return vec4(floor(s.x / 256.0), mod(s.x, 256.0), floor(s.y / 256.0), mod(s.y, 256.0)) / 255.0; }
vec2 dec(vec4 t) { vec4 b = floor(t * 255.0 + 0.5); return vec2(b.x * 256.0 + b.y, b.z * 256.0 + b.w); }
`;

const SEED = COMMON + `
uniform sampler2D uVideo;
uniform vec2 uRes;
uniform float uThreshold;
float lum(vec2 uv) { vec3 t = textureLod(uVideo, uv, 0.0).rgb; return sqrt(max(max(t.r, t.g), t.b)); }
void main() {
  const float kContrast = 0.07;
  vec2 p = floor(gl_FragCoord.xy);
  vec2 d = 1.0 / uRes;
  vec2 uv = (p + 0.5) * d;
  float sNW = lum(uv + vec2(-1.0, -1.0) * d), sN = lum(uv + vec2(0.0, -1.0) * d), sNE = lum(uv + vec2(1.0, -1.0) * d);
  float sW  = lum(uv + vec2(-1.0,  0.0) * d), c  = lum(uv),                      sE  = lum(uv + vec2(1.0,  0.0) * d);
  float sSW = lum(uv + vec2(-1.0,  1.0) * d), sS = lum(uv + vec2(0.0,  1.0) * d), sSE = lum(uv + vec2(1.0,  1.0) * d);
  bool ridge = (c > sW  && c >= sE  && c - min(sW,  sE)  >= kContrast)
            || (c > sN  && c >= sS  && c - min(sN,  sS)  >= kContrast)
            || (c > sNW && c >= sSE && c - min(sNW, sSE) >= kContrast)
            || (c > sSW && c >= sNE && c - min(sSW, sNE) >= kContrast);
  o = (ridge && c >= uThreshold) ? enc(p) : vec4(1.0);
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
    if (s.x > 65000.0) continue;
    vec2 r = pf - s;
    float dd = dot(r, r);
    if (dd < best) { best = dd; bestT = t; }
  }
  o = bestT;
}`;

const DISPLAY = COMMON + `
uniform sampler2D uVideo;
uniform sampler2D uField;
uniform vec2 uRes;
uniform vec2 uCanvas;
uniform int uMode;
uniform float uWidth;
uniform float uGlow;
vec3 toSrgb(vec3 c) { return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }
void main() {
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
    vec2 f = dec(texelFetch(uField, q, 0));
    vec2 r = x - f;
    float dd = (f.x > 65000.0) ? 1e10 : dot(r, r);
    S[k] = f; D2[k] = dd;
    if (dd < best) { best = dd; s = f; }
  }
  float d = sqrt(best);

  const float L = 1.5;
  float ds = d;
  if (d < L + 2.5) {
    vec2 ts = 1.0 / uRes;
    vec2 su = (s + 0.5) * ts;
    float v[9];
    for (int j = 0; j < 3; j++)
    for (int i = 0; i < 3; i++) {
      vec3 c = textureLod(uVideo, su + vec2(float(i - 1), float(j - 1)) * ts, 0.0).rgb;
      v[j * 3 + i] = sqrt(max(c.r, max(c.g, c.b)));
    }
    float gx = 0.5 * (v[5] - v[3]);
    float gy = 0.5 * (v[7] - v[1]);
    float hxx = v[5] - 2.0 * v[4] + v[3];
    float hyy = v[7] - 2.0 * v[4] + v[1];
    float hxy = 0.25 * (v[8] - v[2] - v[6] + v[0]);
    float phi = 0.5 * atan(2.0 * hxy, hxx - hyy + 1e-6) + 1.5707963;
    vec2 n = vec2(cos(phi), sin(phi));
    float kc = n.x * n.x * hxx + 2.0 * n.x * n.y * hxy + n.y * n.y * hyy;
    float off = (kc < -1e-4) ? -(gx * n.x + gy * n.y) / min(kc, -1e-4) : 0.0;
    off = clamp(off, -1.0, 1.0);
    vec2 rr = x - (s + off * n);
    float perp = abs(dot(rr, n));
    float along = abs(rr.y * n.x - rr.x * n.y);
    float dr = sqrt(perp * perp + max(along - L, 0.0) * max(along - L, 0.0));
    ds = mix(dr, d, smoothstep(L + 1.0, L + 2.5, d));
  }
  float core = clamp((0.5 * uWidth - ds) / fp + 0.5, 0.0, 1.0);
  vec3 ink = vec3(0.95, 0.97, 1.0);
  vec3 col;

  if (uMode == 1) {
    float t = clamp(d / 128.0, 0.0, 1.0);
    vec3 tint = mix(vec3(0.10, 0.45, 1.0), vec3(0.10, 0.08, 0.45), sqrt(t));
    vec3 dcol = vec3(0.004, 0.005, 0.009) + tint * (0.07 * exp(-d / 28.0));
    float kq = d / 8.0;
    float id = abs(fract(kq + 0.5) - 0.5) * 8.0;
    float iso = clamp(1.0 - id / fp, 0.0, 1.0) * smoothstep(3.0, 5.0, d);
    float amaj = (mod(floor(kq + 0.5), 4.0) < 0.5) ? 0.75 : 0.30;
    dcol = mix(dcol, tint, iso * amaj * mix(1.0, 0.35, t));
    vec2 g0 = x - s;
    float m = 1e4;
    for (int k2 = 0; k2 < 4; k2++) {
      vec2 ek = x - S[k2];
      float dk = sqrt(D2[k2]);
      float cs = dot(ek, g0) / max(dk * d, 1e-4);
      float sep = length(S[k2] - s);
      if (D2[k2] < 1e9 && cs < 0.5 && sep > 0.5) m = min(m, (D2[k2] - best) / (2.0 * max(sep, 0.5)));
    }
    float med = clamp(1.0 - m / fp, 0.0, 1.0) * smoothstep(3.0, 8.0, d);
    dcol = mix(dcol, vec3(0.10, 0.42, 1.0), med * 0.9);
    col = mix(dcol, ink, core);
  } else {
    float e = max(ds - 0.5 * uWidth, 0.0);
    float halo = uGlow * (0.9 * exp(-e / 1.6) + 0.12 * exp(-e / 7.0));
    vec3 c2 = vec3(0.002, 0.0025, 0.004) + vec3(0.046, 0.258, 1.0) * halo;
    col = mix(c2, ink, core);
  }
  o = vec4(toSrgb(clamp(col, 0.0, 1.0)), 1.0);
}`;

const MAX_SIDE = 1280; // same working size as the Unreal render targets

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
    const gl = (this.gl = canvas.getContext("webgl2", { antialias: false, alpha: false, premultipliedAlpha: false, preserveDrawingBuffer: false }));
    this.progSeed = this.program(SEED);
    this.progStep = this.program(STEP);
    this.progDisplay = this.program(DISPLAY);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    this.videoTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.videoTex);
    this.texParams(gl.LINEAR);
    this.size = [0, 0];
    this.fields = [];
    this.fresh = false;

    new ResizeObserver(() => this.draw()).observe(canvas);
    this.onFrame = this.onFrame.bind(this);
    this.watchFrames();
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

  ensureFields(w, h) {
    if (this.size[0] === w && this.size[1] === h) return;
    const gl = this.gl;
    for (const f of this.fields) {
      gl.deleteTexture(f.tex);
      gl.deleteFramebuffer(f.fbo);
    }
    this.fields = [0, 1].map(() => {
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      this.texParams(gl.NEAREST);
      const fbo = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      return { tex, fbo };
    });
    this.size = [w, h];
  }

  setMode(mode) {
    this.mode = mode;
    this.canvas.hidden = mode === 0;
    this.fresh = true;
    this.draw();
  }

  watchFrames() {
    if (this.video.requestVideoFrameCallback) this.video.requestVideoFrameCallback(this.onFrame);
    else requestAnimationFrame(this.onFrame);
  }

  onFrame() {
    this.fresh = true;
    this.draw();
    this.watchFrames();
  }

  // Rebuild the distance field from the current video frame (only when a new frame arrived).
  buildField() {
    const gl = this.gl;
    const v = this.video;
    const scale = Math.min(1, MAX_SIDE / Math.max(v.videoWidth, v.videoHeight));
    const w = Math.max(1, Math.round(v.videoWidth * scale));
    const h = Math.max(1, Math.round(v.videoHeight * scale));
    this.ensureFields(w, h);

    gl.bindTexture(gl.TEXTURE_2D, this.videoTex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.SRGB8_ALPHA8, gl.RGBA, gl.UNSIGNED_BYTE, v);

    gl.viewport(0, 0, w, h);
    gl.useProgram(this.progSeed.p);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.videoTex);
    gl.uniform1i(this.progSeed.u.uVideo, 0);
    gl.uniform2f(this.progSeed.u.uRes, w, h);
    gl.uniform1f(this.progSeed.u.uThreshold, 0.1);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fields[0].fbo);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    gl.useProgram(this.progStep.p);
    gl.uniform2i(this.progStep.u.uSize, w, h);
    gl.uniform1i(this.progStep.u.uField, 0);
    let src = 0;
    for (let step = 1 << Math.ceil(Math.log2(Math.max(w, h)) - 1); step >= 1; step >>= 1) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fields[1 - src].fbo);
      gl.bindTexture(gl.TEXTURE_2D, this.fields[src].tex);
      gl.uniform1i(this.progStep.u.uStep, step);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      src = 1 - src;
    }
    this.result = src;
  }

  draw() {
    if (this.mode === 0 || this.video.readyState < 2 || !this.video.videoWidth) return;
    const gl = this.gl;
    const c = this.canvas;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const cw = Math.max(1, Math.round(c.clientWidth * dpr));
    const ch = Math.max(1, Math.round(c.clientHeight * dpr));
    if (c.width !== cw || c.height !== ch) {
      c.width = cw;
      c.height = ch;
    }
    gl.bindVertexArray(this.vao);
    if (this.fresh || !this.fields.length) {
      this.buildField();
      this.fresh = false;
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, cw, ch);
    const P = this.progDisplay;
    gl.useProgram(P.p);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.videoTex);
    gl.uniform1i(P.u.uVideo, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.fields[this.result].tex);
    gl.uniform1i(P.u.uField, 1);
    gl.activeTexture(gl.TEXTURE0);
    gl.uniform2f(P.u.uRes, this.size[0], this.size[1]);
    gl.uniform2f(P.u.uCanvas, cw, ch);
    gl.uniform1i(P.u.uMode, this.mode);
    gl.uniform1f(P.u.uWidth, 1.5);
    gl.uniform1f(P.u.uGlow, 0.6);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
}
