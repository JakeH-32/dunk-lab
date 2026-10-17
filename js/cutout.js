// 3D COURT view: the dunker, cut out of the real footage (Tools/FXLab/cutout in the Unreal project: SAM 2.1 mattes),
// composited into the live court (js/court.js), which has landed at the exact camera that filmed the clip.
//
// The packed clip (clips/cutout/<Clip>.mp4, PACKING in js/clips.js) holds line art | real footage | matte in one
// video, so the #video element that plays the line art is also the clock here: every composite uses the frame that
// element is showing (requestVideoFrameCallback), and slow motion, pause and replay need nothing extra.
//
// One light pass per video frame, on a transparent full-window canvas above the court (the court itself is static
// while landed and is never redrawn for this). Per pixel, through the clip's camera (pinhole, roll, principal point):
//   1. contact shadow: the pixel's ray hits the floor; darken by a soft ellipse around the point under the feet,
//      fading and widening with the height of the feet (from clips/cutout/feet.json, see Footprints below);
//   2. reflection: the ray mirrored in the satin floor meets a vertical billboard through the dunker's ground point
//      (facing the camera); that point is projected back into the clip and the cutout is sampled there, dimmed;
//   3. the cutout itself: real colour x matte, the matte choked half a pixel and feathered (the footage has background
//      colour in its anti-aliased edge), graded toward the dark stage (exposure, saturation, warm lamp tint) and
//      vignetted like the court.
// The rim and net are black in the matte, so where they pass in front of the hand the 3D rim behind shows through.

const VS = `#version 300 es
layout(location = 0) in vec2 p;
void main() { gl_Position = vec4(p, 0.0, 1.0); }`;

const FS = `#version 300 es
precision highp float;
precision highp sampler2D;
out vec4 o;
uniform sampler2D uTex;      // packed video frame, RGBA8 holding sRGB values (decoded below)
uniform vec2 uTexSize;       // packed frame size
uniform vec3 uPanel;         // real_x, matte_x, panel width (px)
uniform float uPanelH;
uniform vec2 uCanvas;        // canvas px
uniform vec3 uMap;           // clip image -> canvas: left, top, scale (canvas px per image px)
uniform vec3 uImg;           // clip intrinsics: f, cx, cy (image px)
uniform vec3 uPos, uRight, uUp, uFwd;
uniform vec4 uShadow;        // centre x, z (m), height of the feet (m), strength (0 = none)
uniform vec2 uShadowR;       // radii across / along the view (m)
uniform float uOpacity;
uniform vec3 uVig;           // court vignette: principal point (canvas px, y down), focal (canvas px)

vec3 dec(vec3 c) { return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(vec3(0.04045), c)); } // sRGB -> linear
vec3 rayAt(vec2 img) { return uFwd + uRight * ((img.x - uImg.y) / uImg.x) - uUp * ((img.y - uImg.z) / uImg.x); }
vec2 project(vec3 P) {
  vec3 v = P - uPos;
  float z = max(dot(v, uFwd), 1e-4);
  return vec2(uImg.y + uImg.x * dot(v, uRight) / z, uImg.z - uImg.x * dot(v, uUp) / z);
}
// cutout at image px: premultiplied linear rgb (graded) + alpha; zero outside the frame
vec4 cutout(vec2 img) {
  if (img.x < 0.0 || img.y < 0.0 || img.x > uPanel.z || img.y > uPanelH) return vec4(0.0);
  vec2 q = clamp(img, vec2(0.75), vec2(uPanel.z, uPanelH) - 0.75);
  // matte: 5 taps (a ~1 px blur), then choked half a pixel and feathered (the matte is read as stored, not decoded)
  vec2 mt = vec2(uPanel.y, 0.0);
  float m = texture(uTex, (mt + q) / uTexSize).r * 0.4;
  m += (texture(uTex, (mt + q + vec2(1, 0)) / uTexSize).r + texture(uTex, (mt + q - vec2(1, 0)) / uTexSize).r
      + texture(uTex, (mt + q + vec2(0, 1)) / uTexSize).r + texture(uTex, (mt + q - vec2(0, 1)) / uTexSize).r) * 0.15;
  float a = smoothstep(0.30, 0.85, m);
  vec3 c = dec(texture(uTex, (vec2(uPanel.x, 0.0) + q) / uTexSize).rgb);
  // grade toward the stage: a little darker, less saturated, tinted by the warm lamps, lifted toward the void
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c = mix(vec3(l), c, 0.82) * 0.78 * vec3(1.0, 0.95, 0.88);
  c = c * 0.96 + vec3(0.0035, 0.0040, 0.0050);
  return vec4(c * a, a);
}
vec3 toSrgb(vec3 x) {
  x = clamp(x, 0.0, 1.0);
  return mix(12.92 * x, 1.055 * pow(x, vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), x));
}
void main() {
  vec2 px = vec2(gl_FragCoord.x, uCanvas.y - gl_FragCoord.y);   // canvas px, y down
  vec2 img = (px - uMap.xy) / uMap.z;                             // clip image px
  vec3 D = rayAt(img);
  vec4 acc = vec4(0.0);                                           // premultiplied, linear
  if (D.y < -1e-4 && uShadow.w > 0.0) {
    vec3 P = uPos + D * (-uPos.y / D.y);
    // 1. contact shadow, in floor axes across / along the view
    vec2 fh = normalize(uFwd.xz + 1e-6);
    vec2 d = P.xz - uShadow.xy;
    vec2 e = vec2(dot(d, vec2(-fh.y, fh.x)), dot(d, fh)) / uShadowR;
    float r2 = dot(e, e);
    float h = uShadow.z;
    // a soft pool that fades and spreads as the feet leave the floor, plus a tight contact core while they touch it
    float sh = uShadow.w * (0.42 * exp(-2.0 * r2) * exp(-h / 0.6) + 0.38 * exp(-7.0 * r2) * exp(-h / 0.15));
    acc = vec4(0.0, 0.0, 0.0, clamp(sh, 0.0, 0.85));
    // 2. reflection in the satin floor, via a billboard through the dunker's ground point
    vec3 R = vec3(D.x, -D.y, D.z);
    vec3 n = vec3(fh.x, 0.0, fh.y);
    float den = dot(R, n);
    if (den > 1e-4) {
      float t = dot(vec3(uShadow.x, 0.0, uShadow.y) - P, n) / den;
      if (t > 0.0) {
        vec3 Q = P + R * t;
        vec4 rc = cutout(project(Q));
        float k = 0.16 * exp(-Q.y / 1.1);
        rc *= k;
        acc = rc + acc * (1.0 - rc.a);
      }
    }
  }
  // 3. the dunker
  vec4 c = cutout(img);
  acc = c + acc * (1.0 - c.a);
  // vignette, as the court's (camera-attached, same formula)
  vec2 uv = (px - uVig.xy) / uVig.z;
  float rv = sqrt(pow(uv.x / 0.95, 2.0) + pow((uv.y + 0.02) / 0.62, 2.0));
  float vig = 1.0 - 0.72 * smoothstep(0.40, 1.35, rv);
  acc.rgb *= vig;
  // premultiplied sRGB out: encode the straight colour, then premultiply
  vec3 straight = acc.a > 1e-5 ? acc.rgb / acc.a : vec3(0.0);
  o = vec4(toSrgb(straight) * acc.a, acc.a) * uOpacity;
}`;

// Footprints: from the per-frame feet in the clip (feet.json) to a point on the floor and a height, through the
// clip camera. While a foot is down, its ray meets the floor where the foot is. In the air the same ray meets the
// floor farther away (that is how it shows), so a frame is "in contact" when its floor distance is close to the
// lower envelope of the distances around it (running minimum over +-15 frames, 0.5 s); between two contacts the
// ground point is interpolated, and the foot is the point on its ray above that ground point, which gives its height.
export function footprints(feet, cam, img) {
  const n = feet.length;
  const B = camBasis(cam.yaw, cam.pitch, cam.roll || 0);
  const C = cam.pos;
  const ray = (u, v) => B.fwd.map((f, i) => f + B.right[i] * ((u - img.cx) / img.f) - B.up[i] * ((v - img.cy) / img.f));
  const rec = feet.map((ft) => {
    if (!ft || ft[4]) return null;
    const [xl, xr, yb] = ft;
    const d = ray((xl + xr) / 2, yb);
    const hit = d[1] < -1e-6 ? -C[1] / d[1] : Infinity;
    const G = hit < Infinity ? [C[0] + d[0] * hit, C[2] + d[2] * hit] : null;
    return { d, G, dist: G ? Math.hypot(G[0] - C[0], G[1] - C[2]) : Infinity, wpx: xr - xl, depth: 0 };
  });
  const W = 15;
  const contact = rec.map((r, i) => {
    if (!r || !r.G) return false;
    let m = Infinity;
    for (let j = Math.max(0, i - W); j <= Math.min(n - 1, i + W); j++) if (rec[j]) m = Math.min(m, rec[j].dist);
    return r.dist <= m * 1.06 + 0.08;
  });
  const out = new Array(n).fill(null);
  for (let i = 0; i < n; i++) {
    const r = rec[i];
    if (!r) continue;
    let g;
    if (contact[i]) g = r.G;
    else {
      let a = i - 1;
      while (a >= 0 && !contact[a]) a--;
      let b = i + 1;
      while (b < n && !contact[b]) b++;
      if (a >= 0 && b < n) {
        const t = (i - a) / (b - a);
        g = [rec[a].G[0] + (rec[b].G[0] - rec[a].G[0]) * t, rec[a].G[1] + (rec[b].G[1] - rec[a].G[1]) * t];
      } else if (a >= 0) g = rec[a].G;
      else if (b < n) g = rec[b].G;
      else continue;
    }
    // the point on the foot's ray above g (closest approach of the ray to the vertical line through g)
    const dx = r.d[0];
    const dz = r.d[2];
    const t = ((g[0] - C[0]) * dx + (g[1] - C[2]) * dz) / Math.max(dx * dx + dz * dz, 1e-9);
    const F = [C[0] + r.d[0] * t, C[1] + r.d[1] * t, C[2] + r.d[2] * t];
    const depth = Math.max(0.3, dot3(sub3(F, C), B.fwd));
    // (heights are clamped: a panning clip, whose camera moves, would otherwise give nonsense)
    out[i] = { x: F[0], z: F[2], h: contact[i] ? 0 : Math.min(2, Math.max(0, F[1])), width: (r.wpx / img.f) * depth, contact: contact[i] };
  }
  // light smoothing (3 frames) of position and height; gaps (no matte / body off the bottom) are filled from the
  // nearest frames, and frames far from any data get no shadow
  const sm = out.map((o, i) => {
    if (!o) {
      for (let k = 1; k <= 3; k++) {
        if (out[i - k]) return { ...out[i - k], fill: true };
        if (out[i + k]) return { ...out[i + k], fill: true };
      }
      return null;
    }
    const nb = [out[i - 1], o, out[i + 1]].filter(Boolean);
    const avg = (key) => nb.reduce((s, q) => s + q[key], 0) / nb.length;
    return { x: avg("x"), z: avg("z"), h: avg("h"), width: avg("width"), contact: o.contact };
  });
  return sm;
}

function camBasis(yawDeg, pitchDeg, rollDeg) {
  const D = Math.PI / 180;
  const y = yawDeg * D;
  const p = pitchDeg * D;
  const r = rollDeg * D;
  const fwd = [Math.cos(p) * Math.sin(y), -Math.sin(p), -Math.cos(p) * Math.cos(y)];
  const r0 = [Math.cos(y), 0, Math.sin(y)];
  const u0 = [r0[1] * fwd[2] - r0[2] * fwd[1], r0[2] * fwd[0] - r0[0] * fwd[2], r0[0] * fwd[1] - r0[1] * fwd[0]];
  const right = r0.map((v, i) => v * Math.cos(r) + u0[i] * Math.sin(r));
  const up = r0.map((v, i) => -v * Math.sin(r) + u0[i] * Math.cos(r));
  return { fwd, right, up };
}
const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub3 = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];

export class CutoutLayer {
  // canvas: a transparent full-window canvas above the court; video: the packed #video; court: the Court (for the
  // fitted framing and canvas size); packing: PACKING from js/clips.js.
  constructor(canvas, video, court, packing) {
    this.canvas = canvas;
    this.video = video;
    this.court = court;
    this.pack = packing;
    this.active = false;
    this.clip = null;
    const gl = (this.gl = canvas.getContext("webgl2", { alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false }));
    if (!gl) throw new Error("WebGL2 unavailable");
    const sh = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      return s;
    };
    const p = gl.createProgram();
    this.shaders = [sh(gl.VERTEX_SHADER, VS), sh(gl.FRAGMENT_SHADER, FS)];
    for (const s of this.shaders) gl.attachShader(p, s);
    gl.bindAttribLocation(p, 0, "p");
    gl.linkProgram(p);
    this.prog = p;
    this.u = null; // uniform locations once linked (asked lazily, so the compile doesn't block the page)
    const vao = (this.vao = gl.createVertexArray());
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    this.tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]])
      gl.texParameteri(gl.TEXTURE_2D, k, v);
    this.onFrame = this.onFrame.bind(this);
    this.frameCb = 0;
    this.stats = { frames: 0, ms: [] };
  }

  ready() {
    if (this.u) return true;
    const gl = this.gl;
    const ext = gl.getExtension("KHR_parallel_shader_compile");
    if (ext && !gl.getProgramParameter(this.prog, ext.COMPLETION_STATUS_KHR)) return false;
    if (!gl.getProgramParameter(this.prog, gl.LINK_STATUS)) {
      throw new Error(this.shaders.map((s) => gl.getShaderInfoLog(s)).join("\n") + gl.getProgramInfoLog(this.prog));
    }
    this.u = {};
    for (let i = 0; i < gl.getProgramParameter(this.prog, gl.ACTIVE_UNIFORMS); i++) {
      const name = gl.getActiveUniform(this.prog, i).name;
      this.u[name] = gl.getUniformLocation(this.prog, name);
    }
    return true;
  }

  // key, cam (clip_cameras.json entry), feet (feet.json frames). The fitted framing comes from the court.
  setClip(key, cam, feet) {
    const im = cam.image;
    this.clip = { key, cam, img: { f: im.f_px, cx: im.cx, cy: im.cy }, foot: feet ? footprints(feet, cam, { f: im.f_px, cx: im.cx, cy: im.cy }) : [] };
    this.hasFrame = false;
    this.mediaTime = null;
  }

  setActive(on) {
    if (on && !this.active) this.mediaTime = null; // until the next frame callback: the frame at currentTime
    this.active = on;
    this.canvas.classList.toggle("on", on);
    if (on) {
      this.watch();
      this.draw(true);
    } else {
      this.clear();
    }
  }

  watch() {
    if (this.frameCb || !this.active) return;
    if (this.video.requestVideoFrameCallback) this.frameCb = this.video.requestVideoFrameCallback(this.onFrame);
    else this.frameCb = requestAnimationFrame(() => this.onFrame(performance.now(), { mediaTime: this.video.currentTime }));
  }

  onFrame(now, meta) {
    this.frameCb = 0;
    if (!this.active) return;
    this.mediaTime = meta && meta.mediaTime !== undefined ? meta.mediaTime : this.video.currentTime;
    this.draw(true);
    this.watch();
  }

  clear() {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  // upload: take a new frame from the video (true on video frames; false for redraws on scroll / resize)
  draw(upload = false) {
    if (!this.active || !this.clip || !this.ready()) return;
    const t0 = performance.now();
    const gl = this.gl;
    const v = this.video;
    const court = this.court;
    const W = court.canvas.width;
    const H = court.canvas.height;
    if (this.canvas.width !== W || this.canvas.height !== H) {
      this.canvas.width = W;
      this.canvas.height = H;
      upload = true;
    }
    if (upload || !this.hasFrame) {
      if (v.readyState < 2 || !v.videoWidth) return;
      gl.bindTexture(gl.TEXTURE_2D, this.tex);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      // RGBA8, not SRGB8_ALPHA8: Chrome uploads video into sRGB textures on a slow path (~29 ms for this frame size)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, v);
      this.texSize = [v.videoWidth, v.videoHeight];
      this.hasFrame = true;
      this.frameMedia = this.mediaTime ?? v.currentTime;
    }
    const cam = this.clip.cam;
    const fit = court.cam.fit;
    const fr = fit && court.fitRect(fit);
    if (!fr) {
      this.clear();
      return;
    }
    const B = camBasis(cam.yaw, cam.pitch, cam.roll || 0);
    const intr = court.intrinsics();
    // shadow for this frame
    const n = this.clip.foot.length;
    // frame f is shown for t in [f / fps, (f + 1) / fps); the epsilon absorbs timestamps a hair below f / fps
    const idx = Math.max(0, Math.min(n - 1, Math.floor((this.frameMedia ?? v.currentTime) * this.pack.fps + 0.01)));
    this.frameIndex = idx;
    const fp = this.clip.foot[idx];
    const u = this.u;
    gl.viewport(0, 0, W, H);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.disable(gl.BLEND);
    gl.useProgram(this.prog);
    gl.bindVertexArray(this.vao);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.uniform1i(u.uTex, 0);
    gl.uniform2f(u.uTexSize, this.texSize[0], this.texSize[1]);
    gl.uniform3f(u.uPanel, this.pack.real_x, this.pack.matte_x, this.pack.w);
    gl.uniform1f(u.uPanelH, this.pack.h);
    gl.uniform2f(u.uCanvas, W, H);
    gl.uniform3f(u.uMap, fr.left, fr.top, fr.s);
    gl.uniform3f(u.uImg, this.clip.img.f, this.clip.img.cx, this.clip.img.cy);
    gl.uniform3fv(u.uPos, cam.pos);
    gl.uniform3fv(u.uRight, B.right);
    gl.uniform3fv(u.uUp, B.up);
    gl.uniform3fv(u.uFwd, B.fwd);
    if (fp) {
      // radii across / along the view (m): the feet's spread plus a body-sized margin, growing with height
      const spread = 0.5 * fp.width + 0.3 + 0.35 * fp.h;
      gl.uniform4f(u.uShadow, fp.x, fp.z, fp.h, fp.fill ? 0.6 : 1);
      gl.uniform2f(u.uShadowR, Math.min(spread, 1.1), 0.32 + 0.3 * fp.h);
    } else gl.uniform4f(u.uShadow, 0, 0, 0, 0);
    gl.uniform1f(u.uOpacity, 1);
    gl.uniform3f(u.uVig, intr.cx, intr.cy, intr.f);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
    this.stats.frames++;
    this.stats.ms.push(performance.now() - t0);
    if (this.stats.ms.length > 600) this.stats.ms.shift();
  }

  // GPU time of n composites (ms each), synchronised with a 1-pixel read-back.
  bench(n = 30) {
    const gl = this.gl;
    const px = new Uint8Array(4);
    this.draw(true);
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    const t = performance.now();
    for (let i = 0; i < n; i++) this.draw(true);
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    return (performance.now() - t) / n;
  }
}
