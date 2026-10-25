// Dunk sound effects, synced to the clip: footsteps, sneaker squeaks, dribbles, the takeoff, the dunk (rim, net) and
// the landing. The moments come from the Unreal project (Tools/FXLab/sfx/detect_events.py: foot contacts, ball
// bounces and the ball through the rim, measured on the cut-out masks and the clip's camera). The sounds are real
// recordings (Adobe Audition SFX and Mixkit: basketballs on hardwood and concrete, sneakers in a gym, rims, a net),
// cut into one-shots by Tools/FXLab/sfx/build_sfxlib.py there (credits: Audio/SFXLib/CREDITS.md);
// tools/sync_assets.py packs them into one MP3 sprite and copies the events into assets/audio/sfx/.
//
// Timing: Web Audio plays a sound at an exact context time, so each event is scheduled a little ahead (HORIZON) from
// the video's own clock. requestVideoFrameCallback says which clip time each frame has and when it reaches the screen
// (expectedDisplayTime); getOutputTimestamp says when a context time reaches the speakers. The event is scheduled so
// the two meet. Slow-mo, loops, replays, seeks and pauses re-anchor: sounds not started yet are cancelled or moved.
// Without requestVideoFrameCallback the clock is read from video.currentTime instead (a little less exact).
//
// window.__sfx (tests): .log = one entry per scheduled sound with the measured drift (ms) between when it is heard and
// when its frame is shown; .on / .setOn(bool).

import { audioContext, duck, sfxOutput, unduck } from "./sound.js?v=35";

const BASE = "assets/audio/sfx/";
const VERSION = "?v=37";
const STORE = "dunklab.sfx"; // "off" when muted (default on)
const HORIZON = 0.2; // s of real time scheduled ahead
const RESCHEDULE = 0.012; // s: an unstarted sound whose ideal time moved more than this is moved
const LATE_OK = 0.04; // s: a sound this late still plays (now); later ones are skipped
const LEVEL = 1.0; // master level of the effects (they sit under the radio)
// Per-type balance (the one-shots are all normalised alike). Types not listed are not played: the arm-swing whoosh
// is detected but left out. Keep in step with render_preview_lib.py in the Unreal project.
const TYPE_GAIN = { step: 0.4, squeak: 0.22, dribble: 0.7, takeoff: 0.5, rim: 1.0, net: 0.55, landing: 0.65, backboard: 0.7 };
const SLOWMO_RATE = 0.8; // SLOW-MO: each sound at its 4x-later moment, a little lower and longer (0.25x would be mud)
const SLOW_SOURCE_RATE = 0.9; // clips that are themselves slow motion (overrides.json "slow"): a little deeper
const PAN = 0.4; // how far the screen position pans

export class DunkSfx {
  constructor(video) {
    this.video = video;
    this.on = readPref();
    this.slowMo = false;
    this.clip = null; // { key, events, slow, surface }
    this.data = null; // events.json
    this.map = null; // sfx.json (sprite map)
    this.raw = null; // sprite bytes until decoded
    this.buffer = null;
    this.shift = 0; // decoded sprite offset vs the map (encoder delay), from calib
    this.voices = new Map(); // key -> voice
    this.gen = 0; // bumped on every seek / clip change: keys from before never match again
    this.loop = 0; // loops of the clip since the last seek
    this.anchor = null; // the clip clock: { media, perf, rate, loop, offs, off } from the last presented frame
    this.lastMedia = null;
    this.resetAt = 0;
    this.log = [];
    this.ready = null; // loading starts with the first dunk (setClip), not with the page

    const v = video;
    const reset = () => this.reset();
    for (const type of ["emptied", "ratechange"]) v.addEventListener(type, reset);
    // A looping video seeks back to 0 by itself: that is a wrap (the frame clock counts it and the sounds already
    // scheduled for the next loop stay), anything else (replay, a seek) starts over.
    v.addEventListener("seeking", () => {
      const a = this.anchor;
      const dur = this.duration();
      if (a && v.loop && dur && v.currentTime < 0.1) {
        const media = a.media + ((performance.now() - a.perf) / 1000) * a.rate;
        if (media > dur - 0.3 * Math.max(1, a.rate)) return;
      }
      this.reset();
    });
    v.addEventListener("pause", () => this.cancel());
    v.addEventListener("play", reset);
    document.addEventListener("visibilitychange", reset);
    this.useFrames = "requestVideoFrameCallback" in HTMLVideoElement.prototype;
    if (this.useFrames) {
      const onFrame = (now, meta) => {
        this.frame(meta);
        v.requestVideoFrameCallback(onFrame);
      };
      v.requestVideoFrameCallback(onFrame);
    }
    setInterval(() => this.tick(), 30);
  }

  load() {
    this.ready ||= Promise.all([
      fetch(BASE + "events.json" + VERSION).then((r) => r.json()).then((j) => (this.data = j)),
      fetch(BASE + "sfx.json" + VERSION).then((r) => r.json()).then((j) => (this.map = j)),
      fetch(BASE + "sfx.mp3" + VERSION).then((r) => r.arrayBuffer()).then((b) => (this.raw = b)),
    ]).catch((e) => console.warn("Dunk sound effects unavailable:", e));
    return this.ready;
  }

  setClip(key) {
    if (key) this.load();
    this.stopAll(true);
    this.gen++;
    this.loop = 0;
    this.anchor = null;
    this.lastMedia = null;
    this.resetAt = performance.now();
    this.clip = key ? { key } : null;
  }

  setSlowMo(on) {
    this.slowMo = on;
    this.reset();
  }

  setOn(on) {
    this.on = on;
    try {
      localStorage.setItem(STORE, on ? "on" : "off");
    } catch (e) { /* private mode: not remembered */ }
    if (!on) this.stopAll(false);
    else this.reset();
  }

  // ---- clock

  // A frame was presented: anchor the clip clock to it, notice loops and jumps, measure the drift of due sounds.
  frame(meta) {
    if (!this.clip) return;
    const rate = this.video.playbackRate || 1;
    const dur = this.duration();
    const prev = this.anchor;
    let wrapped = false;
    if (prev && dur) {
      const expected = prev.media + ((meta.expectedDisplayTime - prev.perf) / 1000) * rate;
      if (meta.mediaTime < expected - dur / 2) {
        this.loop++; // wrapped around (looping)
        wrapped = true;
      }
    }
    // Each frame reaches the screen on a display refresh, so a single frame's time is up to one refresh late; the
    // clock is the median over the last frames (one line of slope 1 / rate through them).
    const A = this.loop * dur + meta.mediaTime;
    const o = meta.expectedDisplayTime - (A / rate) * 1000;
    let offs = prev && prev.rate === rate && prev.offs && !wrapped ? prev.offs.slice(-7) : [];
    // a real jump (a stall, the pause a loop makes) is more than a refresh off: start the history again
    if (offs.length && Math.abs(o - prev.off) > 20) offs = [];
    offs.push(o);
    const off = [...offs].sort((x, y) => x - y)[offs.length >> 1];
    this.anchor = { media: meta.mediaTime, perf: meta.expectedDisplayTime, rate, loop: this.loop, offs, off };
    this.measure(meta.mediaTime, meta.expectedDisplayTime, rate);
    this.tick();
  }

  duration() {
    const d = this.video.duration;
    if (isFinite(d) && d > 0) return d;
    const c = this.data && this.clip && this.data.clips[this.clip.key];
    return c ? c.frames / this.data.fps : 0;
  }

  // performance.now() time at which absolute clip time A (loops * duration + t) is shown
  perfOfClip(A) {
    const a = this.anchor;
    if (a.off !== undefined) return a.off + (A / a.rate) * 1000;
    return a.perf + ((A - (a.loop * this.duration() + a.media)) / a.rate) * 1000;
  }

  // context time whose sample is heard at performance.now() time p, and back
  ctxOfPerf(p) {
    const ctx = audioContext();
    const ts = ctx.getOutputTimestamp ? ctx.getOutputTimestamp() : null;
    if (ts && ts.performanceTime > 0) return ts.contextTime + (p - ts.performanceTime) / 1000;
    return ctx.currentTime + (p - performance.now()) / 1000 - (ctx.outputLatency || ctx.baseLatency || 0);
  }
  perfOfCtx(T) {
    const ctx = audioContext();
    const ts = ctx.getOutputTimestamp ? ctx.getOutputTimestamp() : null;
    if (ts && ts.performanceTime > 0) return ts.performanceTime + (T - ts.contextTime) * 1000;
    return performance.now() + (T - ctx.currentTime + (ctx.outputLatency || ctx.baseLatency || 0)) * 1000;
  }

  // ---- scheduling

  tick() {
    const ctx = audioContext();
    const v = this.video;
    if (!ctx || !this.clip || !this.on || v.paused || v.seeking || document.hidden || ctx.state !== "running") return;
    if (!this.prepare(ctx)) return;
    const dur = this.duration();
    if (!dur) return;
    const now = performance.now();
    // clock: the last presented frame. video.currentTime runs ahead of what is on screen (by the compositor's
    // latency, ~20-30 ms), so it is only used without frame callbacks, or when frames stop arriving.
    if (this.useFrames && !this.anchor && now - this.resetAt < 300) return; // the first frame is on its way
    if (!this.anchor || !this.useFrames || now - this.anchor.perf > 300 / Math.min(1, v.playbackRate || 1)) {
      const t = v.currentTime;
      if (this.lastMedia !== null && t < this.lastMedia - dur / 2) this.loop++;
      this.lastMedia = t;
      this.anchor = { media: t, perf: now, rate: v.playbackRate || 1, loop: this.loop };
    }
    const a = this.anchor;
    const Anow = a.loop * dur + a.media + ((now - a.perf) / 1000) * a.rate;
    const Aend = Anow + HORIZON * a.rate;
    const evs = this.clip.events;
    for (let l = Math.max(0, Math.floor(Anow / dur)); l * dur <= Aend; l++) {
      for (let i = 0; i < evs.length; i++) {
        const A = l * dur + evs[i].t;
        if (A < Anow - LATE_OK * a.rate || A > Aend) continue;
        const key = `${this.gen}:${l}:${i}`;
        const T = this.ctxOfPerf(this.perfOfClip(A));
        const vo = this.voices.get(key);
        if (!vo) {
          // the same moment already sounding from before a reset (a loop can fire "seeking" just after it started)
          if (this.recent(evs[i], T)) continue;
          this.start(key, evs[i], T, l, i);
        }
        else if (!vo.started && Math.abs(vo.T - T) > RESCHEDULE) {
          this.stopVoice(vo);
          this.start(key, evs[i], T, l, i, vo.entry);
        }
      }
    }
    for (const [key, vo] of this.voices) {
      if (!vo.started && ctx.currentTime >= vo.T0) vo.started = true;
      if (vo.started && ctx.currentTime > vo.end + 1) this.voices.delete(key);
    }
  }

  // Decode the sprite once there is a context, and pick up the clip's events.
  prepare(ctx) {
    if (!this.map || !this.data) return false;
    if (!this.buffer) {
      if (this.raw && !this.decoding) {
        this.decoding = true;
        const bytes = this.raw;
        this.raw = null;
        ctx.decodeAudioData(bytes).then((b) => {
          this.buffer = b;
          this.shift = calibrate(b, this.map.calib);
        }, (e) => console.warn("Dunk sound effects: decode failed", e));
      }
      return false;
    }
    if (!this.clip.events) {
      const c = this.data.clips[this.clip.key];
      const events = c ? c.events.filter((e) => e.type in TYPE_GAIN) : [];
      Object.assign(this.clip, { events, slow: (c && c.slow) || 1, surface: c && c.surface, picks: [] });
    }
    return true;
  }

  soundName(ev) {
    const n = ev.type;
    return this.clip.surface === "outdoor" && this.map.sounds[n + "_out"] ? n + "_out" : n;
  }

  // Which variation each event of loop l plays: a fixed hash of (loop, event), but never the variation the same sound
  // played last, so repeats (steps, dribbles) don't sound identical. Worked out loop by loop and kept.
  pick(loop, index) {
    const c = this.clip;
    for (let l = c.picks.length; l <= loop; l++) {
      const last = l ? { ...c.picks[l - 1].last } : {};
      const ks = c.events.map((ev, i) => {
        const name = this.soundName(ev);
        const n = this.map.sounds[name] ? this.map.sounds[name].v.length : 1;
        let k = Math.floor(hash(l * 7 + i * 13 + 1) * n);
        if (n > 1 && last[name] === k) k = (k + 1) % n;
        last[name] = k;
        return k;
      });
      c.picks.push({ ks, last });
    }
    return c.picks[loop].ks[index];
  }

  start(key, ev, T, loop, index, entry = null) {
    const ctx = audioContext();
    const snd = this.map.sounds[this.soundName(ev)];
    if (!snd) return;
    const rate = (this.slowMo ? SLOWMO_RATE : 1) * (this.clip.slow > 1 ? SLOW_SOURCE_RATE : 1) * (1 + (hash(loop * 31 + index) - 0.5) * 0.06);
    let T0 = T - snd.peak / rate; // each one-shot starts its pre-roll before the moment
    if (T0 < ctx.currentTime) {
      if (T < ctx.currentTime - LATE_OK) return; // too late (e.g. just after a seek): skip
      T0 = ctx.currentTime;
    }
    const [off, len] = snd.v[this.pick(loop, index)];
    const src = ctx.createBufferSource();
    src.buffer = this.buffer;
    src.playbackRate.value = rate;
    const g = ctx.createGain();
    g.gain.value = LEVEL * TYPE_GAIN[ev.type] * (0.45 + 0.55 * ev.s);
    src.connect(g);
    if (ctx.createStereoPanner) {
      const p = ctx.createStereoPanner();
      p.pan.value = ev.pan * PAN;
      g.connect(p).connect(sfxOutput());
    } else g.connect(sfxOutput());
    src.start(T0, Math.max(0, off + this.shift), len);
    if (ev.type === "rim") duck(T, 0.7, 0.6);
    const vo = { src, gain: g, T, T0, end: T0 + len / rate, started: false, ev };
    if (entry) entry.rescheduled = (entry.rescheduled || 0) + 1;
    else {
      entry = { clip: this.clip.key, type: ev.type, t: ev.t, loop, gen: this.gen, rate, slow: this.slowMo, drift: null };
      this.log.push(entry);
      if (this.log.length > 2000) this.log.shift();
    }
    entry.heardPerf = this.perfOfCtx(T);
    vo.entry = entry;
    this.voices.set(key, vo);
  }

  recent(ev, T) {
    const now = audioContext().currentTime;
    for (const vo of this.voices.values()) if (vo.ev === ev && now >= vo.T0 && Math.abs(vo.T - T) < 0.15) return true;
    return false;
  }

  // When a frame at or past a sound's moment is shown, compare when that moment is on screen with when it is heard.
  measure(media, perf, rate) {
    const dur = this.duration();
    for (const vo of this.voices.values()) {
      const e = vo.entry;
      if (e.drift !== null || e.gen !== this.gen || e.interrupted || !dur) continue;
      const A = e.loop * dur + e.t;
      const Af = this.loop * dur + media;
      if (Af < A || Af - A > 0.05) continue; // the first frame at or after the moment (1.5 frames at 30 fps)
      const shown = perf - ((Af - A) / rate) * 1000; // when the event's moment is on screen (between frames: interpolated)
      e.drift = Math.round((e.heardPerf - shown) * 10) / 10;
    }
  }

  stopVoice(vo, fade = false) {
    const ctx = audioContext();
    try {
      if (fade && vo.started) {
        vo.gain.gain.setTargetAtTime(0, ctx.currentTime, 0.03);
        vo.src.stop(ctx.currentTime + 0.2);
      } else vo.src.stop();
    } catch (e) { /* not started yet */ }
  }

  // Cancel what hasn't started (seek, pause, rate change); what is already sounding rings out.
  cancel() {
    let dunk = false;
    for (const [key, vo] of this.voices) {
      if (vo.entry && vo.entry.drift === null) vo.entry.interrupted = true; // its frame may now come much later
      if (!vo.started && audioContext() && audioContext().currentTime < vo.T0) {
        this.stopVoice(vo);
        if (vo.ev.type === "rim") dunk = true;
        if (vo.entry) vo.entry.cancelled = true;
        this.voices.delete(key);
      }
    }
    if (dunk) unduck();
  }

  reset() {
    this.cancel();
    this.resetAt = performance.now();
    this.gen++;
    this.loop = 0;
    this.anchor = null;
    this.lastMedia = null;
  }

  stopAll(fade) {
    for (const vo of this.voices.values()) this.stopVoice(vo, fade);
    this.voices.clear();
    if (audioContext()) unduck();
  }
}

function readPref() {
  try {
    return localStorage.getItem(STORE) !== "off";
  } catch (e) {
    return true;
  }
}

// Where the sprite's first loud sample landed after decoding vs where it was written (MP3 encoder delay).
function calibrate(buf, calib) {
  const x = buf.getChannelData(0);
  const sr = buf.sampleRate;
  const limit = Math.min(x.length, Math.round((calib + 0.2) * sr));
  for (let i = 0; i < limit; i++) {
    if (Math.abs(x[i]) >= 0.05) {
      const d = i / sr - calib;
      return Math.abs(d) < 0.1 ? d : 0;
    }
  }
  return 0;
}

// deterministic 0..1 from an integer (variation choice and slight detune, different on every loop)
function hash(n) {
  const s = Math.sin(n * 12.9898 + 78.233) * 43758.5453;
  return s - Math.floor(s);
}
