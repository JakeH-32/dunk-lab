// Web Audio for the whole page: short UI sounds as decoded buffers (low latency) and one music
// <audio> element routed through a gain node. Volume must go through Web Audio because iOS Safari
// ignores HTMLMediaElement.volume. Browsers only allow sound after a user gesture, so the context
// is created and resumed by unlock(), which main.js calls on the first pointerdown.

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
    ctx.createMediaElementSource(music).connect(musicGain).connect(ctx.destination);
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
