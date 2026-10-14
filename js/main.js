// Menu (takeoff -> dunk) and video player, ported from WBP_MainMenu / WBP_DunkPlayer.

import { CLIPS } from "./clips.js";
import { DIFFICULTY, DUNKS, TAKEOFFS } from "./data.js";
import { LineFX } from "./fx.js";
import { Radio } from "./radio.js";
import { play, unlock } from "./sound.js";

const $ = (sel) => document.querySelector(sel);
const subtitle = $("#subtitle");
const takeoffList = $("#takeoffs");
const dunkList = $("#dunks");
const menu = $("#menu");
const player = $("#player");
const video = $("#video");
const frame = $("#frame");
const status = $("#status");
const caption = $("#caption");
const pauseKey = $("#key-pause");

const dock = $("#radio-dock");
const radio = new Radio(dock);

// VIEW modes. 0 shows the clip itself; 1-2 run the GPU line-art pipeline (js/fx.js).
const MODES = [
  { label: "ORIGINAL", title: "ORIGINAL", text: "The clip as recorded. Press VIEW to see how the GPU reads the lines." },
  { label: "DISTANCE", title: "DISTANCE VIEW", text: "Each pixel shows how far it is from the nearest line, worked out live on the GPU. Every ring is 8 px farther out; the bright seams sit halfway between two lines." },
  { label: "RE-STROKE", title: "RE-STROKE VIEW", text: "The lines redrawn from that distance map: clean, even strokes with a neon glow, drawn by the GPU instead of copied from the video." },
];
let mode = 0;
let fx = null;
try {
  if (LineFX.supported()) fx = new LineFX($("#fx"), $("#video"));
} catch (e) {
  console.warn("Line-art views unavailable:", e);
}
function setMode(m) {
  mode = m;
  $("#view-label").textContent = "VIEW: " + MODES[m].label;
  $("#explain-title").textContent = MODES[m].title;
  $("#explain-text").textContent = MODES[m].text;
  if (fx) fx.setMode(m);
}
if (!fx) {
  $("#key-view").hidden = true;
  $("#explain").hidden = true;
}
$("#key-view").addEventListener("click", () => setMode((mode + 1) % MODES.length));
sfxOn($("#key-view"), "select");
setMode(0);

// Keep page content clear of the radio when it is docked at the bottom (phone menu), via --dock-h.
function updateDockSpace() {
  const s = getComputedStyle(dock);
  const docked = s.position === "fixed" && s.transform !== "none";
  document.documentElement.style.setProperty("--dock-h", docked ? dock.offsetHeight + "px" : "0px");
}
new ResizeObserver(updateDockSpace).observe(dock);
window.addEventListener("resize", updateDockSpace);
let takeoff = null;

// Sound needs a user gesture: the first touch/click anywhere unlocks audio and starts the radio.
window.addEventListener("pointerdown", () => {
  unlock();
  radio.start();
}, { capture: true });

function sfxOn(btn, pressSound) {
  btn.addEventListener("pointerenter", (e) => {
    if (e.pointerType === "mouse") play("hover", { volume: 0.7 });
  });
  btn.addEventListener("pointerdown", () => play(pressSound));
}

function card(label, { tip, right, disabled } = {}) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "card" + (disabled ? " disabled" : "");
  const name = document.createElement("span");
  name.className = "card-name";
  name.textContent = label;
  b.appendChild(name);
  if (right) b.appendChild(right);
  if (tip) {
    const t = document.createElement("div");
    t.className = "tip";
    t.innerHTML = `<b>${tip.title}</b><span>${tip.text}</span>`;
    b.appendChild(t);
  }
  sfxOn(b, disabled ? "back" : "select");
  return b;
}

function showTakeoffs() {
  subtitle.textContent = "CHOOSE A TAKEOFF STYLE";
  takeoffList.hidden = false;
  dunkList.hidden = true;
}

function showDunks(t) {
  takeoff = t;
  subtitle.textContent = `${t.label.toUpperCase()} TAKEOFF — CHOOSE A DUNK`;
  dunkList.replaceChildren();
  for (const d of DUNKS) {
    if (d.only && !d.only.includes(t.key)) continue;
    const clip = d.key + t.key;
    const has = CLIPS.has(clip);
    const right = document.createElement("span");
    right.className = "card-right";
    right.innerHTML = has
      ? `<span class="pill" style="--pill:${DIFFICULTY[d.difficulty]}">${d.difficulty}</span>`
      : `<span class="soon">COMING SOON</span>`;
    const b = card(d.label, { right, disabled: !has });
    if (has) b.addEventListener("click", () => playDunk(d, t));
    dunkList.appendChild(b);
  }
  const back = document.createElement("button");
  back.type = "button";
  back.className = "key back-key";
  back.innerHTML = `<i class="icon i-back"></i>CHANGE TAKEOFF`;
  sfxOn(back, "back");
  back.addEventListener("click", showTakeoffs);
  dunkList.appendChild(back);
  takeoffList.hidden = true;
  dunkList.hidden = false;
}

function playDunk(d, t) {
  caption.textContent = `${d.label.toUpperCase()} — ${t.label.toUpperCase()}`;
  status.hidden = true;
  frame.classList.remove("ready");
  video.src = `clips/${d.key}${t.key}.mp4`;
  video.play().catch(() => {});
  menu.hidden = true;
  player.hidden = false;
  document.body.classList.add("playing");
  updateDockSpace();
  window.scrollTo(0, 0);
}

function backToMenu() {
  video.pause();
  video.removeAttribute("src");
  video.load();
  player.hidden = true;
  menu.hidden = false;
  document.body.classList.remove("playing");
  updateDockSpace();
  window.scrollTo(0, 0);
  showDunks(takeoff);
}

// Reveal the video once it has a real frame (avoids a flash of the wrong size).
video.addEventListener("loadeddata", () => frame.classList.add("ready"));
video.addEventListener("error", () => {
  if (!video.getAttribute("src")) return;
  status.textContent = "This dunk couldn't be loaded.";
  status.hidden = false;
});
video.addEventListener("play", () => pauseKey.classList.remove("paused"));
video.addEventListener("pause", () => pauseKey.classList.add("paused"));

$("#key-replay").addEventListener("click", () => {
  video.currentTime = 0;
  video.play().catch(() => {});
});
pauseKey.addEventListener("click", () => (video.paused ? video.play().catch(() => {}) : video.pause()));
$("#key-back").addEventListener("click", backToMenu);
sfxOn($("#key-replay"), "select");
sfxOn(pauseKey, "select");
sfxOn($("#key-back"), "back");

for (const t of TAKEOFFS) {
  const chev = document.createElement("i");
  chev.className = "icon i-chevron";
  const b = card(t.label, { tip: { title: t.title, text: t.tip }, right: chev });
  b.addEventListener("click", () => showDunks(t));
  takeoffList.appendChild(b);
}
showTakeoffs();
