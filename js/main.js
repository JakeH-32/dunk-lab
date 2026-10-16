// Menu (takeoff -> dunk) and video player, ported from WBP_MainMenu / WBP_DunkPlayer.

import { CLIPS } from "./clips.js?v=15";
import { DIFFICULTY, DUNKS, TAKEOFFS } from "./data.js?v=15";
import { LineFX } from "./fx.js?v=15";
import { Radio } from "./radio.js?v=15";
import { play, unlock } from "./sound.js?v=15";

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
  { label: "GRASSFIRE", title: "GRASSFIRE VIEW", text: "The distance map read as arrival time: fronts leave every line at once and flash where they meet, halfway between lines." },
  { label: "CHROME", title: "CHROME VIEW", text: "Every line turned into a 3D chrome tube, lit like a studio sculpture. Its shape comes from the distance map." },
  { label: "TRAILS", title: "TRAILS VIEW", text: "Moving lines leave fading streaks. Motion is measured on the GPU by matching each line to the nearest line in the frame before." },
  { label: "SPEED", title: "SPEED VIEW", text: "Lines coloured by how fast they move: blue is still, then cyan, white, and orange for the fastest parts." },
];
const SLOWMO_NOTE = "Slow-mo: the GPU builds the in-between frames, sliding each line toward where it is next, so motion glides at ¼ speed.";
let mode = 0;
let fx = null;
try {
  if (LineFX.supported()) fx = new LineFX($("#fx"), $("#video"));
} catch (e) {
  console.warn("Line-art views unavailable:", e);
}
let slowMo = false;
function updateExplain() {
  $("#explain-title").textContent = MODES[mode].title;
  $("#explain-text").textContent = MODES[mode].text;
  $("#explain-note").textContent = slowMo && mode > 0 ? SLOWMO_NOTE : "";
  $("#explain-note").hidden = !(slowMo && mode > 0);
}
function setMode(m) {
  mode = m;
  $("#view-label").innerHTML = `<span class="vp">VIEW: </span>${MODES[m].label}`;
  if (fx) fx.setMode(m);
  updateExplain();
}
function setSlowMo(on) {
  slowMo = on;
  $("#key-slow").classList.toggle("on", on);
  $("#slow-state").textContent = on ? "ON" : "OFF";
  if (fx) fx.setSlowMo(on);
  else $("#video").playbackRate = on ? 0.25 : 1;
  updateExplain();
}
if (!fx) {
  $("#key-view").hidden = true;
  $("#explain").hidden = true;
}
$("#key-view").addEventListener("click", () => setMode((mode + 1) % MODES.length));
sfxOn($("#key-view"), "select");
$("#key-slow").addEventListener("click", () => setSlowMo(!slowMo));
sfxOn($("#key-slow"), "select");
setMode(0);

// Keep page content clear of the radio when it is docked at the bottom (phone menu), via --dock-h.
const phone = window.matchMedia("(max-width: 899px)");
function updateDockSpace() {
  const s = getComputedStyle(dock);
  const docked = s.position === "fixed" && phone.matches; // only the phone dock sits over the bottom of the page
  document.documentElement.style.setProperty("--dock-h", docked ? dock.offsetHeight + "px" : "0px");
}
new ResizeObserver(updateDockSpace).observe(dock);
window.addEventListener("resize", updateDockSpace);
let takeoff = null;

// Sound needs a user gesture, and iOS only accepts some kinds (touchend/click, not pointerdown). Every tap,
// click or key press anywhere (radio, buttons, video, background) unlocks audio and starts the radio until it plays.
for (const type of ["pointerdown", "pointerup", "touchend", "click", "keydown"]) {
  window.addEventListener(type, () => {
    unlock();
    radio.start();
  }, { capture: true });
}
window.dunkRadio = radio; // handy for debugging in the browser console

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
  if (disabled) {
    b.setAttribute("aria-disabled", "true");
    b.tabIndex = -1;
  }
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
    b.addEventListener("pointerenter", () => placeTip(b, t));
  }
  sfxOn(b, disabled ? "back" : "select");
  return b;
}

// Hover popups sit to the right of the card. If that runs off the screen they go to the left, unless the
// radio is there, and otherwise below the card (above it near the bottom of the window). Placed on load and
// resize as well as on hover, so a hidden popup never widens the page.
function placeTip(cardEl, tipEl) {
  const c = cardEl.getBoundingClientRect();
  const w = tipEl.offsetWidth;
  const gap = 18;
  const radioRight = dock.getBoundingClientRect().right;
  let side = "right";
  if (c.right + gap + w > document.documentElement.clientWidth - 8) {
    side = c.left - gap - w >= Math.max(8, radioRight + 12) ? "left" : "below";
    if (side === "below" && c.bottom + 10 + tipEl.offsetHeight > window.innerHeight - 8) side = "above";
  }
  tipEl.dataset.side = side;
}
function placeTips() {
  for (const b of takeoffList.querySelectorAll(".card")) placeTip(b, b.querySelector(".tip"));
}
window.addEventListener("resize", placeTips);

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
  setSlowMo(false);
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
// The phone layout sizes the video box from the clip's aspect ratio (--ar).
video.addEventListener("loadedmetadata", () => {
  if (video.videoWidth && video.videoHeight) frame.style.setProperty("--ar", video.videoWidth / video.videoHeight);
});
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
const togglePause = () => (video.paused ? video.play().catch(() => {}) : video.pause());
pauseKey.addEventListener("click", togglePause);
// Keyboard shortcuts, the same as the Unreal build. Player: Space pause/play, R replay, V view, S slow-mo,
// Backspace/Esc back. Menu: 1-3 pick a takeoff, 1-6 pick a dunk, Backspace/Esc back to the takeoffs.
// Handled keys are stopped before they reach a focused button, which would otherwise also be pressed.
const PLAYER_KEYS = {
  Space: ["select", () => togglePause()],
  KeyR: ["select", () => $("#key-replay").click()],
  KeyV: ["select", () => fx && $("#key-view").click()],
  KeyS: ["select", () => $("#key-slow").click()],
  Backspace: ["back", () => backToMenu()],
  Escape: ["back", () => backToMenu()],
};
function menuKey(code) {
  const digit = /^(Digit|Numpad)([1-6])$/.exec(code);
  if (!takeoffList.hidden) {
    const card = digit && takeoffList.querySelectorAll(".card")[digit[2] - 1];
    return card ? ["select", () => card.click()] : null;
  }
  if (code === "Backspace" || code === "Escape") return ["back", () => showTakeoffs()];
  const card = digit && dunkList.querySelectorAll(".card")[digit[2] - 1];
  if (!card) return null;
  return card.classList.contains("disabled") ? ["back", () => {}] : ["select", () => card.click()];
}
for (const type of ["keydown", "keyup"]) {
  window.addEventListener(type, (e) => {
    if (e.ctrlKey || e.altKey || e.metaKey) return;
    const action = player.hidden ? menuKey(e.code) : PLAYER_KEYS[e.code];
    if (!action) return;
    e.preventDefault();
    e.stopPropagation();
    if (type === "keydown" && !e.repeat) {
      play(action[0]);
      action[1]();
    }
  }, { capture: true });
}
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
placeTips();
document.fonts.ready.then(placeTips);
