// Web Audio for the whole page: short UI sounds as decoded buffers (low latency) and one music
// <audio> element routed through a gain node. Volume must go through Web Audio because iOS Safari
// ignores HTMLMediaElement.volume. Browsers only allow sound after a user gesture, so the context
// is created and resumed by unlock(), which main.js calls on the first pointerdown.
// The dunk sound effects (js/sfx.js) play through their own bus (sfxOutput) on the same context, and duck() dips the
// music a little around a dunk through a separate gain stage, so it never fights the radio's own volume.

const SFX = {
  hover: "assets/audio/ui/UI_Hover.wav",
  select: "assets/audio/ui/UI_Select.wav",
  back: "assets/audio/ui/UI_Back.wav",
  button: "assets/audio/ui/Radio_Button.wav",
  detent: "assets/audio/ui/Radio_Detent.wav",
  power: "assets/audio/ui/Radio_Power.wav",
  static: "assets/audio/RadioStatic.wav",
};

let ctx = null;
const buffers = {};
let musicGain = null;
let duckGain = null; // after musicGain: ducking for the dunk sounds
let sfxBus = null;
export const music = new Audio();
music.preload = "auto";

// True once the audio context exists (created on the first gesture). It may still be resuming; anything played
// meanwhile starts as soon as it runs, so callers must not wait for "running" (iOS resumes asynchronously).
export function unlocked() {
  return ctx !== null;
}

export function unlock() {
  if (!ctx) {
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    musicGain = ctx.createGain();
    musicGain.gain.value = 0;
    duckGain = ctx.createGain();
    sfxBus = ctx.createGain();
    sfxBus.connect(ctx.destination);
    ctx.createMediaElementSource(music).connect(musicGain).connect(duckGain).connect(ctx.destination);
    for (const [name, url] of Object.entries(SFX)) {
      fetch(url)
        .then((r) => r.arrayBuffer())
        .then((data) => ctx.decodeAudioData(data))
        .then((buf) => (buffers[name] = buf))
        .catch(() => {});
    }
  }
  if (ctx.state !== "running") ctx.resume();
}

export function play(name, { volume = 1, rate = 1 } = {}) {
  if (!ctx || !buffers[name] || volume <= 0) return;
  const src = ctx.createBufferSource();
  src.buffer = buffers[name];
  src.playbackRate.value = rate;
  const g = ctx.createGain();
  g.gain.value = volume;
  src.connect(g).connect(ctx.destination);
  src.start();
}

export function setMusicLevel(level) {
  if (musicGain) musicGain.gain.setTargetAtTime(level, ctx.currentTime, 0.015);
}

// The shared AudioContext (null until the first gesture) and the bus the dunk sound effects play into.
export function audioContext() {
  return ctx;
}
export function sfxOutput() {
  return sfxBus;
}

// Dip the music to `depth` around context time `at`: down over ~0.1 s just before it, back up after `hold` s.
export function duck(at, hold, depth = 0.6) {
  if (!duckGain) return;
  const g = duckGain.gain;
  const t0 = Math.max(ctx.currentTime, at - 0.1);
  if (g.cancelAndHoldAtTime) g.cancelAndHoldAtTime(t0);
  else g.cancelScheduledValues(t0);
  g.setTargetAtTime(depth, t0, 0.03);
  g.setTargetAtTime(1, t0 + 0.1 + hold, 0.25);
}
// Undo a pending or current dip (the dunk it was for was cancelled: seek, pause, mute).
export function unduck() {
  if (!duckGain) return;
  const g = duckGain.gain;
  if (g.cancelAndHoldAtTime) g.cancelAndHoldAtTime(ctx.currentTime);
  else g.cancelScheduledValues(ctx.currentTime);
  g.setTargetAtTime(1, ctx.currentTime, 0.08);
}
