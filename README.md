# Dunk Lab (web)

Play it: **https://jakeh-32.github.io/dunk-lab/**

Pick a takeoff, pick a dunk, and watch it as 2D line art, with a retro car stereo playing in the
corner. This is the browser version of my Unreal Engine 5 class project. It runs on phones too.

- **Menu:** takeoff style (One Foot, Two Foot, Off Vert), then the dunk. Dunks without a clip yet
  show "COMING SOON".
- **Player:** looping clip in a chrome monitor frame, with Replay, Pause/Play and Back.
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
