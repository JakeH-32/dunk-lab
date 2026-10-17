# Dunk Lab (web)

Play it: **https://dunklab.app/** (also https://jakeh-32.github.io/dunk-lab/, which redirects)

Pick a takeoff, pick a dunk, and watch it as 2D line art, with a retro car stereo playing in the
corner. This is the browser version of my Unreal Engine 5 class project. It runs on phones too.

- **Menu:** takeoff style (One Foot, Two Foot, Off Vert), then the dunk. Dunks without a clip yet
  show "COMING SOON".
- **Player:** looping clip in a chrome monitor frame, with View, Replay, Pause/Play and Back.
- **VIEW (GPU line art, WebGL2):** seven line-art views, after the 3D COURT view (see Live court
  below). Each has a short explanation beside the video.
  1. **Line art** (the clip itself)
  2. **Distance:** every pixel's distance to the nearest line. It's computed live with the Jump
     Flooding Algorithm and shown as rings, plus the medial axis.
  3. **Re-stroke:** the lines redrawn from that distance field as clean neon strokes.
  4. **Grassfire:** the field read as arrival time. Fronts leave every line at once and flash where
     they meet.
  5. **Chrome:** the lines extruded into lit 3D tubes.
  6. **Trails:** moving lines leave fading streaks.
  7. **Speed:** lines colored by how fast they move.
- **SLOW-MO:** 0.25x playback. The GPU builds in-between frames by sliding each line toward its
  position in the next frame, then rebuilding the distance field.
- **How the motion is measured:** each line point is matched to the nearest line in the previous
  frame's distance field (normal flow). `js/fx.js` is a port of the Unreal shaders in
  `Tools/FXLab/motion`.
- **Phone support:** the fields pack coordinates into RGBA8, so it also runs on phones without float
  render targets.
- **Radio:** five stations with presets, ‹ › tuning, volume (drag the left knob, use − / +, or scroll),
  power, a static burst between stations, and auto-advance to the next song.
- **Live court (WebGL2, `js/court.js`):** the background is the court scene rendered in real time, a
  port of the offline renderer `Tools/Brand/court_render.py` in the Unreal project. It uses the same
  pinhole camera, metre units and shading: hardwood and court lines are box-filtered over each
  sample's exact footprint on the floor plane, with GGX lamp streaks, Fresnel and a light pool. The
  hoop is 3D line art drawn with the painter's algorithm. The scene is static and renders only on
  resize or while the camera moves. `assets/brand/kit/background.jpg` is the fallback when there is
  no GPU, WebGL2 or context.
  - **Swoop:** picking a dunk flies the camera into the phone camera the clip was filmed with
    (`assets/brand/clip_cameras.json`, made by `Tools/Brand/clip_cameras.py` in the Unreal project and
    copied by `tools/sync_assets.py`). The camera is framed so the video's box shows exactly that
    camera's 720×1280 picture, so the clip's hoop lands on the 3D hoop and the court around the bezel
    continues the shot. The video appears when the camera lands. Back to Menu flies back.
    With `prefers-reduced-motion` it cuts instead.
  - **3D COURT view** (`js/cutout.js`; the default after landing, first in the VIEW cycle): the
    dunker is cut out of the real footage and drawn in the video's place over the court. The mattes
    are SAM 2.1 masks from `Tools/FXLab/cutout` in the Unreal project. The bezel fades away, and the
    3D hoop is where the real one was.
    - One light WebGL pass runs per video frame, on its own transparent canvas; the court is not
      redrawn. It draws a contact shadow, a dim floor reflection, then the cutout (choked and
      feathered edge, graded toward the dark stage).
    - The shadow sits under the feet (`clips/cutout/feet.json`, raycast through the clip camera)
      and fades and widens as the feet leave the floor.
    - `clips/cutout/<Clip>.mp4` packs line art, real footage and matte into one video, so the 3D
      view and the line-art views share one decoder and are frame-locked. Slow-mo, pause and
      replay work in every view.
  - `window.__court`: `getCamera()`, `setCamera({ pos: [x, y, z], yaw, pitch, roll, f | fovY, pp })`,
    `animateTo(cam, ms, ease, { via, arc, orient })` (returns a Promise), `Court.fitCamera(cam, image, element)`
    (frames a pinhole image inside an element) and `bench(n)` (ms per frame).
    `f` and `pp` are in px of a 2560×1440 frame shown like `cover`. The default is
    `pos [-9.78, 1.73, 9.35], yaw 18.55, pitch 3.85, f 1781`.
  - `?court=cam`: logs the camera after every change. Arrows turn, I/K/J/L/U/O move, `[` `]` zoom,
    0 resets, and Shift moves 5x. `?court=off` shows the static image.

Plain HTML, CSS and JavaScript with no build step. Audio runs through the Web Audio API, so volume
also works on iPhone. Sound starts on your first tap or click, because browsers block autoplay.

## Updating

Media is copied from the Unreal project by `python tools/sync_assets.py`, which also optimizes
the images and regenerates `js/clips.js`. It also packs the cutouts into `clips/cutout/`, which needs
ffmpeg: it uses the one on the PATH, `imageio-ffmpeg`, or the copy in the Unreal project's tool venvs.
Run the site locally with a static server that supports HTTP range requests, for example
`npx http-server`, then open the address it prints. GitHub Pages supports them. Without range
requests, browsers can't seek the videos to arbitrary times (`python -m http.server` doesn't
support them).

## Credits

Line-art clips of my own dunks. UI and radio art generated with ChatGPT for this project. Music is
fan-made instrumental recreations.

When you change CSS or JS, bump the `?v=` number in `index.html` and the imports in `js/*.js`.
Browsers cache GitHub Pages files for about 10 minutes, so this makes phones fetch the new version.
