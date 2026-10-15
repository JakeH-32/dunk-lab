# Dunk Lab (web)

Play it: **https://jakeh-32.github.io/dunk-lab/**

Pick a takeoff, pick a dunk, and watch it as 2D line art, with a retro car stereo playing in the
corner. This is the browser version of my Unreal Engine 5 class project. It runs on phones too.

- **Menu:** takeoff style (One Foot, Two Foot, Off Vert), then the dunk. Dunks without a clip yet
  show "COMING SOON".
- **Player:** looping clip in a chrome monitor frame, with View, Replay, Pause/Play and Back.
- **VIEW (GPU line art, WebGL2):** seven views, each with a short explanation beside the video.
  1. **Original**
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

Plain HTML, CSS and JavaScript with no build step. Audio runs through the Web Audio API, so volume
also works on iPhone. Sound starts on your first tap or click, because browsers block autoplay.

## Updating

Media is copied from the Unreal project by `python tools/sync_assets.py`, which also optimizes
the images and regenerates `js/clips.js`. Run it locally with any static server, for example
`python -m http.server`, then open http://localhost:8000.

## Credits

Line-art clips of my own dunks. UI and radio art generated with ChatGPT for this project. Music is
fan-made instrumental recreations.

When you change CSS or JS, bump the `?v=` number in `index.html` and the imports in `js/*.js`.
Browsers cache GitHub Pages files for about 10 minutes, so this makes phones fetch the new version.
