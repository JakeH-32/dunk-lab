// Menu (takeoff -> dunk) and video player, ported from WBP_MainMenu / WBP_DunkPlayer.

import { CLIPS, REAL } from "./clips.js?v=29";
import { Court, DEFAULT_CAMERA } from "./court.js?v=31";
import { DIFFICULTY, DUNKS, TAKEOFFS } from "./data.js?v=29";
import { LineFX } from "./fx.js?v=29";
import { Radio } from "./radio.js?v=29";
import { play, unlock } from "./sound.js?v=29";

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
let court = null; // live WebGL court (startCourt, at the bottom); null when the static background is used
let clipCams = null; // per-clip phone cameras (assets/brand/clip_cameras.json)

// VIEW modes. 0 shows the clip itself; 1-2 run the GPU line-art pipeline (js/fx.js).
const MODES = [
  { label: "LINE ART", title: "LINE ART", text: "The dunk traced as line art. Press VIEW to see how the GPU reads the lines." },
  { label: "DISTANCE", title: "DISTANCE VIEW", text: "A distance field: every pixel knows how far it is from the nearest line, rebuilt each frame on the GPU with jump flooding. Rings are 8 px apart." },
  { label: "RE-STROKE", title: "RE-STROKE VIEW", text: "The lines redrawn from the distance field instead of copied from the video, so every stroke gets the same clean width and glow." },
  { label: "GRASSFIRE", title: "GRASSFIRE VIEW", text: "The distance field as a wave: fronts spread out from every line at the same speed and light up where they meet." },
  { label: "CHROME", title: "CHROME VIEW", text: "The distance field used as a height map, so each line becomes a shaded 3D tube with chrome reflections." },
  { label: "TRAILS", title: "TRAILS VIEW", text: "Moving lines leave fading trails. Motion comes from matching each line to the closest line in the previous frame." },
  { label: "SPEED", title: "SPEED VIEW", text: "Lines coloured by how fast they move, measured frame to frame: blue is still, cyan and white are faster, orange is fastest." },
];
const SLOWMO_NOTE = "Slow-mo: the GPU makes the in-between frames itself, sliding each line toward its next position.";
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
// Phone player: the video fills the screen, so the explanation below isn't visible until you scroll. A small
// "DETAILS BELOW" line above the keys says so (tap scrolls there); it fades once the page has been scrolled.
const detailsHint = $("#details-hint");
detailsHint.hidden = !fx;
detailsHint.addEventListener("click", () => $("#explain").scrollIntoView({ behavior: "smooth", block: "center" }));
addEventListener("scroll", () => detailsHint.classList.toggle("gone", scrollY > 40), { passive: true });
// No page zoom on phones (it was easy to double-tap-zoom while pressing keys and get stuck zoomed in). The viewport meta
// and touch-action handle most browsers; iOS Safari ignores user-scalable=no for pinches, so cancel its gesture events.
for (const type of ["gesturestart", "gesturechange"]) document.addEventListener(type, (e) => e.preventDefault(), { passive: false });
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

// ---- the swoop: with the live court, picking a dunk flies the background camera into the phone camera the clip
// was filmed with (assets/brand/clip_cameras.json, Tools/Brand/clip_cameras.py in the Unreal project), framed so
// the video's box shows exactly that camera's 720x1280 picture. The video appears when the camera lands, so the
// clip's hoop sits on the 3D hoop and the court around the bezel continues the shot. Back to Menu flies back.
const SWOOP_MS = 1700; // long enough that the turn and zoom read as a glide, not a lurch
const SWOOP_EASE = "smoother";
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
let flight = 0; // id of the latest transition; older ones stop when they see it changed

function clipCamera(key) {
  const j = court && court.isReady && document.documentElement.classList.contains("court") && clipCams && clipCams[key];
  if (!j) return null;
  const im = j.image;
  return Court.fitCamera(j, { w: im.w, h: im.h, f: im.f_px, cx: im.cx, cy: im.cy }, video);
}
// Take an element out of the layout where it is (it keeps its look while it fades), or put it back.
function pin(el) {
  if (el.dataset.pinned) return;
  const r = el.getBoundingClientRect();
  el.dataset.pinned = "1";
  Object.assign(el.style, { position: "fixed", left: r.left + "px", top: r.top + "px", width: r.width + "px", margin: "0", zIndex: "3" });
}
function unpin(el) {
  delete el.dataset.pinned;
  for (const p of ["position", "left", "top", "width", "margin", "zIndex"]) el.style[p] = "";
}
function courtState(s) {
  document.body.dataset.court = s; // "menu" | "flying" | "landed" (tests read it)
}

function playDunk(d, t) {
  const key = `${d.key}${t.key}`;
  const my = ++flight;
  caption.textContent = `${d.label.toUpperCase()} — ${t.label.toUpperCase()}`;
  status.hidden = true;
  frame.classList.remove("ready");
  video.src = `clips/${key}.mp4`;
  loadReal(key);
  setSlowMo(false);
  const cam = clipCamera(key);
  if (!cam) {
    // no live court (or no camera for this clip): straight cut, as before
    video.play().catch(() => {});
    unpin(menu);
    menu.classList.remove("fading");
    player.classList.remove("fading");
    menu.hidden = true;
    player.hidden = false;
    frame.classList.add("landed");
    document.body.classList.add("playing");
    updateDockSpace();
    window.scrollTo(0, 0);
    return;
  }
  video.pause(); // starts at frame 0 when the camera lands
  const ms = reducedMotion.matches ? 0 : SWOOP_MS;
  // the menu fades where it is; the player is laid out (invisible) right away, so the landing frame is known
  if (!menu.hidden) pin(menu);
  menu.classList.add("fading");
  frame.classList.remove("landed");
  player.classList.add("fading");
  player.hidden = false;
  document.body.classList.add("playing");
  updateDockSpace();
  window.scrollTo(0, 0);
  courtState("flying");
  setTimeout(() => my === flight && player.classList.remove("fading"), ms * 0.45); // fades in as it lands
  court.animateTo(cam, ms, SWOOP_EASE).then((done) => {
    if (!done || my !== flight) return;
    unpin(menu);
    menu.hidden = true;
    menu.classList.remove("fading");
    player.classList.remove("fading");
    frame.classList.add("landed");
    courtState("landed");
    video.currentTime = 0;
    video.play().catch(() => {});
  });
}

function backToMenu() {
  const my = ++flight;
  video.pause();
  video.removeAttribute("src");
  video.load();
  loadReal(null);
  const toMenu = () => {
    if (my !== flight) return;
    unpin(menu);
    player.hidden = true;
    player.classList.remove("fading");
    menu.hidden = false;
    document.body.classList.remove("playing");
    updateDockSpace();
    window.scrollTo(0, 0);
    showDunks(takeoff);
  };
  if (!(court && court.isReady && document.documentElement.classList.contains("court"))) {
    menu.classList.remove("fading");
    toMenu();
    return;
  }
  // the video goes (the court behind it is the same view), the player fades, the camera flies back to the menu
  // view and the menu fades in as it arrives
  const ms = reducedMotion.matches ? 0 : SWOOP_MS;
  frame.classList.remove("landed");
  player.classList.add("fading");
  courtState("flying");
  const showMenu = () => {
    toMenu();
    if (my !== flight) return;
    menu.classList.add("fading");
    requestAnimationFrame(() => requestAnimationFrame(() => my === flight && menu.classList.remove("fading")));
  };
  if (ms) setTimeout(showMenu, ms * 0.35);
  else showMenu();
  court.animateTo(DEFAULT_CAMERA, ms, SWOOP_EASE).then((done) => done && my === flight && courtState("menu"));
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

// ---- real footage: a second video, synced to the line-art clip, shown left of a draggable split ----
// The real clips are retimed frame by frame to the line art offline (Unreal project, Tools/FXLab/real), so both
// play from the same timestamp. The real video follows the line-art clock: small drift is absorbed by nudging its
// playback rate, big jumps (loop, replay, seek) by seeking.
const real = $("#real");
const split = $("#split");
let splitPos = 0;
function setSplit(f) {
  splitPos = Math.min(1, Math.max(0, f));
  frame.style.setProperty("--split", splitPos * 100 + "%");
  frame.style.setProperty("--split-line", splitPos > 0 && splitPos < 1 ? 1 : 0);
  split.setAttribute("aria-valuenow", Math.round(splitPos * 100));
}
function loadReal(key) {
  const has = !!key && REAL.has(key);
  split.hidden = !has;
  $("#slide-hint").hidden = !has;
  setSplit(0);
  if (has) {
    real.src = `clips/real/${key}.mp4`;
    real.playbackRate = video.playbackRate;
    if (!video.paused) real.play().catch(() => {});
  } else {
    real.pause();
    real.removeAttribute("src");
    real.load();
  }
}
function syncReal() {
  if (!real.getAttribute("src") || real.readyState < 2) return;
  const base = video.playbackRate;
  if (video.paused) {
    if (!real.paused) real.pause();
    if (Math.abs(real.currentTime - video.currentTime) > 0.01) real.currentTime = video.currentTime;
    return;
  }
  if (real.paused) real.play().catch(() => {});
  let d = real.currentTime - video.currentTime;
  const dur = video.duration || 0;
  if (dur && Math.abs(d) > dur / 2) d -= Math.sign(d) * dur; // one of them has already looped
  if (Math.abs(d) > 0.25) {
    real.currentTime = video.currentTime;
    real.playbackRate = base;
  } else {
    real.playbackRate = base * (1 - Math.max(-0.2, Math.min(0.2, d * 2)));
  }
}
(function syncLoop() {
  if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(() => { syncReal(); syncLoop(); });
  else setTimeout(() => { syncReal(); syncLoop(); }, 50);
})();
for (const type of ["pause", "play", "seeked", "ratechange"]) video.addEventListener(type, syncReal);
split.addEventListener("pointerdown", (e) => {
  split.setPointerCapture(e.pointerId);
  split.classList.add("dragging");
  e.preventDefault();
});
split.addEventListener("pointermove", (e) => {
  if (!split.hasPointerCapture(e.pointerId)) return;
  const r = split.parentElement.getBoundingClientRect();
  setSplit((e.clientX - r.left) / r.width);
});
for (const type of ["pointerup", "pointercancel"]) split.addEventListener(type, () => split.classList.remove("dragging"));
function cycleSplit() {
  if (split.hidden) return;
  setSplit(splitPos < 0.25 ? 0.5 : splitPos < 0.75 ? 1 : 0);
}

$("#key-replay").addEventListener("click", () => {
  video.currentTime = 0;
  video.play().catch(() => {});
});
const togglePause = () => (video.paused ? video.play().catch(() => {}) : video.pause());
pauseKey.addEventListener("click", togglePause);
// Keyboard shortcuts, the same as the Unreal build. Player: Space pause/play, R replay, V view, S slow-mo, C real footage,
// Backspace/Esc back. Menu: 1-3 pick a takeoff, 1-6 pick a dunk, Backspace/Esc back to the takeoffs.
// Handled keys are stopped before they reach a focused button, which would otherwise also be pressed.
const PLAYER_KEYS = {
  Space: ["select", () => togglePause()],
  KeyR: ["select", () => $("#key-replay").click()],
  KeyV: ["select", () => fx && $("#key-view").click()],
  KeyS: ["select", () => $("#key-slow").click()],
  KeyC: ["select", () => cycleSplit()],
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

// ---- live court background (js/court.js) ----
// Rendered once, and again only on resize or while the camera animates. Debug / test hooks:
//   window.__court             the Court: __court.getCamera(), .setCamera({pos, yaw, pitch, f | fovY}),
//                              .animateTo(cam, ms, ease, {arc, via}) -> Promise, .bench(n) -> ms per still frame
//   ?court=cam                 logs the camera after every change and flies it with the keyboard: arrows turn,
//                              I/K forward/back, J/L left/right, U/O down/up, [ ] zoom, 0 reset (Shift = 5x)
//   ?court=off                 the static background.jpg instead
//   body[data-court]           "menu" | "flying" | "landed": the swoop's state (see playDunk)
function startCourt() {
  const root = document.documentElement;
  if (!root.classList.contains("court")) return;
  const canvas = $("#court");
  try {
    court = new Court(canvas);
  } catch (e) {
    console.warn("Live court unavailable, using the static background:", e);
    root.classList.remove("court");
    court = null;
    return;
  }
  window.__court = court;
  courtState("menu");
  court.ready.catch((e) => {
    console.warn("Live court failed to start, using the static background:", e);
    root.classList.remove("court");
    court = null;
  });
  fetch("assets/brand/clip_cameras.json?v=31")
    .then((r) => (r.ok ? r.json() : null))
    .then((j) => (clipCams = j))
    .catch(() => {}); // no cameras: dunks open with a cut, as without the court
  court.onLost = () => root.classList.remove("court");
  court.onRestored = () => root.classList.add("court");
  const camDebug = new URLSearchParams(location.search).get("court") === "cam";
  let logged = "";
  court.onRender = () => {
    canvas.classList.add("ready");
    if (!camDebug || court.anim) return;
    const c = court.getCamera();
    const r = (v) => Math.round(v * 1000) / 1000;
    const line = `__court.setCamera({ pos: [${c.pos.map(r).join(", ")}], yaw: ${r(c.yaw)}, pitch: ${r(c.pitch)}, roll: ${r(c.roll)}, ` +
      `f: ${r(c.f)}, pp: [${c.pp.map(r).join(", ")}] })${c.fit ? " // fitted to the video" : ""}`;
    if (line !== logged) console.log((logged = line));
  };
  if (camDebug) {
    window.addEventListener("keydown", (e) => {
      const c = court.getCamera();
      const s = e.shiftKey ? 5 : 1;
      const yaw = c.yaw * Math.PI / 180;
      const fwd = [Math.sin(yaw), 0, -Math.cos(yaw)];
      const right = [Math.cos(yaw), 0, Math.sin(yaw)];
      const move = (v, m) => c.pos.forEach((_, i) => (c.pos[i] += v[i] * m * 0.25 * s));
      const keys = {
        ArrowLeft: () => (c.yaw -= s), ArrowRight: () => (c.yaw += s),
        ArrowUp: () => (c.pitch -= 0.5 * s), ArrowDown: () => (c.pitch += 0.5 * s),
        KeyI: () => move(fwd, 1), KeyK: () => move(fwd, -1), KeyJ: () => move(right, -1), KeyL: () => move(right, 1),
        KeyU: () => move([0, 1, 0], -1), KeyO: () => move([0, 1, 0], 1),
        BracketLeft: () => (c.f /= 1.05 ** s), BracketRight: () => (c.f *= 1.05 ** s),
        Digit0: () => Object.assign(c, { ...DEFAULT_CAMERA, pos: [...DEFAULT_CAMERA.pos], roll: 0, pp: [0, 0], fit: null }),
      };
      if (!keys[e.code]) return;
      e.preventDefault();
      e.stopPropagation();
      keys[e.code]();
      delete c.fovY;
      court.setCamera(c);
    }, { capture: true });
  }
}
startCourt();
