// Car-stereo radio, ported from WBP_Radio. Controls sit on the faceplate recesses measured in
// assets/radio/layout.json (1600x640 art space), placed in percent so the radio scales freely.

import { STATIONS } from "./data.js?v=23";
import { music, play, setMusicLevel, unlocked } from "./sound.js?v=23";

const W = 1600;
const H = 640;
const L = {
  display: [344, 108, 912, 177],
  dial: [148, 410, 1305, 58],
  knobL: [88, 101, 188, 188],
  knobR: [1321, 101, 188, 188],
  volDown: [67, 325, 101, 58],
  volUp: [186, 324, 103, 59],
  tunePrev: [1312, 324, 102, 59],
  tuneNext: [1433, 325, 100, 58],
  presets: [[76, 500, 184, 69], [286, 500, 186, 69], [498, 500, 186, 69], [711, 500, 186, 69], [924, 500, 187, 69], [1138, 500, 188, 69]],
  power: [1416, 507, 108, 58],
};

const VOLUME_KEY = "dunklab.volume";
const cube = (v) => v * v * v; // perceptual volume curve (same as the game)
const clamp01 = (v) => Math.min(1, Math.max(0, v));

function el(tag, cls, parent, rect) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (rect) {
    const [x, y, w, h] = rect;
    Object.assign(e.style, { left: (x / W) * 100 + "%", top: (y / H) * 100 + "%", width: (w / W) * 100 + "%", height: (h / H) * 100 + "%" });
  }
  if (parent) parent.appendChild(e);
  return e;
}

export class Radio {
  constructor(dock) {
    this.preset = 0;
    this.power = true;
    this.volume = 0.9;
    try {
      const v = parseFloat(localStorage.getItem(VOLUME_KEY));
      if (v >= 0 && v <= 1) this.volume = v;
    } catch (e) {}
    this.gain = 0;
    this.targetGain = 0;
    this.started = false;
    this.dialPos = 0.5;
    this.volShownAt = -1e9;

    this.banner = el("div", "banner", dock);
    this.bannerStation = el("div", "banner-station", this.banner);
    this.bannerTrack = el("div", "banner-track", this.banner);

    const r = (this.root = el("div", "radio", dock));
    const face = el("img", "radio-face", r);
    face.src = "assets/radio/faceplate.webp?v=23";
    face.alt = "";
    face.draggable = false;

    // Display window: info row, station, scrolling track. Glass overlay on top.
    const disp = (this.display = el("div", "radio-display", r, L.display));
    const info = el("div", "radio-info", disp);
    this.presetText = el("span", "", info);
    this.freqText = el("span", "", info);
    this.stationText = el("div", "radio-station", disp);
    const clip = el("div", "radio-track", disp);
    this.trackText = el("span", "", clip);
    el("img", "glass", r, L.display).src = "assets/radio/display_glass.png?v=23";

    // Dial: ticks + labels 88-108 and a needle.
    const dial = el("div", "radio-dial", r, L.dial);
    for (let f = 88; f <= 108; f++) {
      const t = el("i", f % 4 === 0 ? "tick major" : "tick", dial);
      t.style.left = this.freqToPos(f) * 100 + "%";
      if (f % 4 === 0) {
        const lbl = el("b", "", dial);
        lbl.textContent = f;
        lbl.style.left = this.freqToPos(f) * 100 + "%";
      }
    }
    this.needle = el("i", "needle", dial);
    el("img", "glass", r, L.dial).src = "assets/radio/dial_glass.png?v=23";

    // Knobs: the art is rotation-safe, so only the pointer rotates.
    this.volKnob = this.knob(r, L.knobL, "Volume: drag up or down");
    this.tuneKnob = this.knob(r, L.knobR, "Next station");

    // Small keys and presets.
    this.key(r, L.volDown, "small", "−", "Volume down", () => this.stepVolume(-0.1), "detent");
    this.key(r, L.volUp, "small", "+", "Volume up", () => this.stepVolume(0.1), "detent");
    this.key(r, L.tunePrev, "small", "‹", "Previous station", () => this.step(-1), "detent");
    this.key(r, L.tuneNext, "small", "›", "Next station", () => this.step(1), "detent");
    this.presetKeys = L.presets.map((rect, i) => this.key(r, rect, "preset", String(i + 1), "Preset " + (i + 1), () => this.tune(i), "button"));
    const pwr = this.key(r, L.power, "small power", "", "Power", () => this.togglePower(), "power");
    this.led = el("i", "led", pwr);
    el("span", "", pwr).textContent = "PWR";

    this.bindVolumeKnob();
    this.tuneKnob.el.addEventListener("click", () => {
      play("detent", { volume: 0.8 });
      this.step(1);
    });

    music.addEventListener("ended", () => {
      // A song finished on its own: move to the next preset that has one (no static).
      if (this.power) this.tune(this.nextWithSong(this.preset), { quiet: true });
    });

    this.loop = this.loop.bind(this);
    this.update();
  }

  freqToPos(f) {
    return 0.06 + ((f - 88) / 20) * 0.88;
  }

  knob(parent, rect, title) {
    const k = el("div", "knob", parent, rect);
    k.title = title;
    const img = el("img", "", k);
    img.src = "assets/radio/knob.png?v=23";
    img.draggable = false;
    const ptr = el("i", "pointer", k);
    return { el: k, ptr };
  }

  key(parent, rect, kind, label, title, action, sound) {
    const b = el("button", "rkey " + kind, parent, rect);
    b.type = "button";
    b.title = title;
    b.setAttribute("aria-label", title);
    if (label) el("span", "", b).textContent = label;
    b.addEventListener("pointerdown", () => play(sound, { volume: 0.9 }));
    b.addEventListener("click", action);
    return b;
  }

  // ----- behaviour -------------------------------------------------------------------------

  start() {
    // Any user gesture: begin playing the current preset. Retries on every gesture until playback really
    // starts, because mobile browsers reject play() outside a gesture they accept (e.g. pointerdown on iOS).
    if (this.started || !this.power || !music.paused) return;
    this.tune(this.preset, { quiet: true });
  }

  nextWithSong(i) {
    return (i + 1) % STATIONS.length;
  }

  tune(i, { quiet = false } = {}) {
    this.preset = i;
    this.gain = 0;
    this.showBanner();
    const st = STATIONS[i];
    if (this.power && unlocked()) {
      if (!quiet) play("static", { volume: cube(this.volume) * 0.9 });
      if (st) {
        if (!music.src.endsWith(st.src)) music.src = st.src;
        music.currentTime = 0;
        music.play().then(() => (this.started = true)).catch(() => {});
        this.targetGain = 1;
      } else {
        music.pause();
        this.targetGain = 0;
      }
    }
    this.update();
  }

  step(d) {
    this.tune((this.preset + d + 6) % 6);
  }

  togglePower() {
    this.power = !this.power;
    if (this.power) this.tune(this.preset);
    else {
      this.targetGain = 0;
      this.banner.classList.remove("show");
      this.update();
    }
  }

  setVolume(v) {
    this.volume = clamp01(v);
    this.volShownAt = performance.now();
    try {
      localStorage.setItem(VOLUME_KEY, String(this.volume));
    } catch (e) {}
    this.update();
  }

  stepVolume(d) {
    this.setVolume(Math.round((this.volume + d) * 10) / 10);
  }

  bindVolumeKnob() {
    const k = this.volKnob.el;
    let startY = 0;
    let startV = 0;
    let lastStep = 0;
    k.addEventListener("pointerdown", (e) => {
      k.setPointerCapture(e.pointerId);
      startY = e.clientY;
      startV = this.volume;
      lastStep = Math.round(this.volume * 30);
      this.volShownAt = performance.now();
      this.update();
      e.preventDefault();
    });
    k.addEventListener("pointermove", (e) => {
      if (!k.hasPointerCapture(e.pointerId)) return;
      // 160 px of drag covers the whole range, scaled with the radio's size.
      const span = 160 * (this.root.clientWidth / 576);
      this.setVolume(startV + (startY - e.clientY) / span);
      const s = Math.round(this.volume * 30);
      if (s !== lastStep) {
        lastStep = s;
        play("detent", { volume: 0.8, rate: 0.88 + this.volume * 0.24 });
      }
    });
    k.addEventListener("wheel", (e) => {
      e.preventDefault();
      this.stepVolume(e.deltaY < 0 ? 0.1 : -0.1);
      play("detent", { volume: 0.8, rate: 0.88 + this.volume * 0.24 });
    }, { passive: false });
  }

  showBanner() {
    if (!this.power) return;
    const st = STATIONS[this.preset];
    this.bannerStation.textContent = st ? st.name : "NO SIGNAL";
    this.bannerTrack.textContent = st ? st.track : "PRESET EMPTY";
    this.banner.classList.remove("show");
    void this.banner.offsetWidth; // restart the CSS animation
    this.banner.classList.add("show");
  }

  update() {
    const st = STATIONS[this.preset];
    const showVol = performance.now() - this.volShownAt < 1200;
    this.presetText.textContent = "P" + (this.preset + 1);
    this.freqText.textContent = showVol ? "VOL " + Math.round(this.volume * 30) : st ? "FM " + st.freq.toFixed(1) : "FM --.-";
    this.stationText.textContent = st ? st.name : "NO SIGNAL";
    if (this.trackText.textContent !== (st ? st.track : "- - -")) {
      this.trackText.textContent = st ? st.track : "- - -";
      requestAnimationFrame(() => {
        const over = this.trackText.scrollWidth - this.trackText.parentElement.clientWidth;
        this.trackText.classList.toggle("scroll", over > 0);
        this.trackText.style.setProperty("--over", -over - 12 + "px");
      });
    }
    this.root.classList.toggle("off", !this.power);
    this.presetKeys.forEach((b, i) => b.classList.toggle("active", i === this.preset));
    this.volKnob.ptr.style.transform = `rotate(${-135 + 270 * this.volume}deg)`;
    this.tuneKnob.ptr.style.transform = `rotate(${-120 + 48 * this.preset}deg)`;
    this.dialTarget = this.freqToPos(st ? st.freq : 88.1 + 3.9 * this.preset);
    this.kick();
  }

  // The loop below (fades, dial needle, volume readout) only runs until everything has settled. Every state
  // change goes through update(), which restarts it.
  kick() {
    if (this.looping) return;
    this.looping = true;
    this.lastT = 0;
    requestAnimationFrame(this.loop);
  }

  loop(t) {
    const dt = Math.min(0.1, (t - (this.lastT || t)) / 1000);
    this.lastT = t;
    const rate = 2.5 * dt;
    this.gain += Math.max(-rate, Math.min(rate, this.targetGain - this.gain));
    setMusicLevel(cube(this.volume) * this.gain);
    if (!this.power && this.gain <= 0 && !music.paused) music.pause();
    this.dialPos += (this.dialTarget - this.dialPos) * Math.min(1, dt * 5);
    this.needle.style.left = this.dialPos * 100 + "%";
    if (this.volShownAt > 0 && performance.now() - this.volShownAt > 1200) {
      this.volShownAt = -1e9;
      this.update();
    }
    const settled = this.gain === this.targetGain && Math.abs(this.dialTarget - this.dialPos) < 1e-4 &&
      this.volShownAt < 0 && (this.power || music.paused);
    if (settled) this.looping = false;
    else requestAnimationFrame(this.loop);
  }
}
