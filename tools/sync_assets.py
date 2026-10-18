"""Copy Dunk Lab's media from the Unreal project into this web build.

Run again whenever clips, songs or art change in the Unreal project:
    python tools/sync_assets.py

- Clips:  <unreal>/Content/Movies/*.mp4                  -> clips/
- Real footage, synced to the line art (Tools/FXLab/real/make_real.py): <unreal>/Content/Movies/Real/*.mp4 -> clips/real/
- Cutouts (Tools/FXLab/cutout): <unreal>/Content/Movies/Cutout/*.mp4, packed with the line art into one video
  -> clips/cutout/, plus the dunker's per-frame foot track clips/cutout/feet.json (needs ffmpeg and numpy/scipy)
- Music:  <unreal>/Audio/*.mp3 and RadioStatic.wav       -> assets/audio/
- Sounds: <unreal>/Audio/UI/*.wav                        -> assets/audio/ui/
- Dunk sound effects: <unreal>/Audio/SFXLib/processed/*.wav (recorded one-shots, Tools/FXLab/sfx/build_sfxlib.py)
  -> one MP3 sprite assets/audio/sfx/sfx.mp3 + sfx.json,
  and the per-clip events <unreal>/Tools/FXLab/sfx/events.json -> assets/audio/sfx/events.json (js/sfx.js)
- Art:    ChatGPT's PNGs in <unreal>/Inbox               -> assets/ui/ (icons), assets/radio/
- Brand:  <unreal>/Tools/Brand/final (logo, monogram, icons, kit/) -> assets/brand/, plus the 1200x630
  share image assets/brand/og.jpg, and the per-clip cameras final/clip_cameras.json -> assets/brand/
  Big opaque images become JPEG and big transparent ones WebP, so phones load quickly.
Also writes js/clips.js, the list of clips that exist (the menu greys out the rest).
"""

import json
import os
import shutil
import sys

from PIL import Image

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
UNREAL = sys.argv[1] if len(sys.argv) > 1 else r"C:/Users/Jake/Documents/Unreal Projects/DunkLab"
KIT = os.path.join(UNREAL, "Inbox/UIKit/DunkLab_Retro_UI_Kit")
RADIO = os.path.join(UNREAL, "Tools/Brand/final/radio")  # premium radio art (radio_kit.py), same names/sizes
RADIO_LAYOUT = os.path.join(UNREAL, "Inbox/RadioControls/RetroRadioBlue_ImageAssets")  # layout.json (control positions)
BRAND = os.path.join(UNREAL, "Tools/Brand/final")
BRAND_KIT = os.path.join(BRAND, "kit")


def out(*parts):
    path = os.path.join(HERE, *parts)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    return path


def copy(src, *dst):
    shutil.copyfile(src, out(*dst))


def image(src, dst_dir, name, max_w=None, fmt=None, quality=86):
    im = Image.open(src)
    if max_w and im.width > max_w:
        im = im.resize((max_w, round(im.height * max_w / im.width)), Image.LANCZOS)
    if fmt == "jpg":
        im.convert("RGB").save(out(dst_dir, name + ".jpg"), quality=quality, optimize=True)
    elif fmt == "webp":
        im.save(out(dst_dir, name + ".webp"), quality=quality, method=6)
    else:
        im.save(out(dst_dir, name + ".png"), optimize=True)


clips = sorted(f[:-4] for f in os.listdir(os.path.join(UNREAL, "Content/Movies")) if f.lower().endswith(".mp4"))
for c in clips:
    copy(os.path.join(UNREAL, "Content/Movies", c + ".mp4"), "clips", c + ".mp4")
real_dir = os.path.join(UNREAL, "Content/Movies/Real")
real = sorted(f[:-4] for f in os.listdir(real_dir) if f.lower().endswith(".mp4")) if os.path.isdir(real_dir) else []
for c in real:
    copy(os.path.join(real_dir, c + ".mp4"), "clips", "real", c + ".mp4")


# ---- Cutouts (Tools/FXLab/cutout): the dunker + ball matted out of the real footage, for the 3D COURT view ----
# <unreal>/Content/Movies/Cutout/<Clip>.mp4 is 1440x1280 (real | matte). For the web it is packed together with the
# line-art clip into ONE video, clips/cutout/<Clip>.mp4, 2192x1280:
#     x 0-719 line art | 16 px black | x 736-1455 real footage | 16 px black | x 1472-2191 matte
# so a single decoder drives the line-art views and the 3D composite: they can never drift apart, and slow motion,
# pause and replay apply to both. The black gaps keep compression and texture filtering from bleeding between
# panels (720 and 736 are multiples of 16, so no macroblock straddles a seam). The website reads the geometry from
# PACKING in js/clips.js.
# clips/cutout/feet.json: per frame, where the dunker's feet are in the clip (image px), for the contact shadow:
# [x_left, x_right, y_bottom, y_top, cut] of the largest matte component's lowest 3% (cut = 1 when the body runs off
# the bottom of the frame), or null for an empty matte.
PACK = {"w": 720, "h": 1280, "gap": 16, "fps": 30}
PACK["line_x"], PACK["real_x"] = 0, PACK["w"] + PACK["gap"]
PACK["matte_x"] = 2 * (PACK["w"] + PACK["gap"])
PACK["width"] = 3 * PACK["w"] + 2 * PACK["gap"]


def ffmpeg_exe():
    import glob
    found = shutil.which("ffmpeg")
    if found:
        return found
    try:
        import imageio_ffmpeg
        return imageio_ffmpeg.get_ffmpeg_exe()
    except ImportError:
        pass
    # the Unreal project's Python tools ship one (imageio-ffmpeg in their venvs)
    hits = sorted(glob.glob(os.path.join(UNREAL, "Tools", "**", ".venv", "Lib", "site-packages", "imageio_ffmpeg", "binaries", "ffmpeg*"),
                            recursive=True))
    if hits:
        return hits[0]
    raise SystemExit("ffmpeg not found (needed to pack the cutouts): install it or `pip install imageio-ffmpeg`")


def foot_track(ffmpeg, src):
    """Per-frame feet of the dunker in the matte half of a Cutout clip (see feet.json above)."""
    import subprocess
    import numpy as np
    try:
        from scipy import ndimage
    except ImportError:
        ndimage = None
    w, h = PACK["w"], PACK["h"]
    raw = subprocess.run([ffmpeg, "-v", "error", "-i", src, "-vf", f"crop={w}:{h}:{w}:0,format=gray", "-f", "rawvideo", "-"],
                         capture_output=True, check=True).stdout
    frames = np.frombuffer(raw, np.uint8).reshape(-1, h, w)
    track = []
    for m in frames:
        on = m > 127
        if ndimage is not None and on.any():
            lab, n = ndimage.label(on)
            if n > 1:
                on = lab == (np.argmax(np.bincount(lab.ravel())[1:]) + 1)
        ys, xs = np.nonzero(on)
        if len(ys) < 50:
            track.append(None)
            continue
        yb, yt = int(ys.max()), int(ys.min())
        band = ys >= yb - max(6, 0.03 * (yb - yt))
        xl, xr = np.percentile(xs[band], [5, 95])
        track.append([round(float(xl), 1), round(float(xr), 1), yb, yt, int(yb >= h - 3)])
    return track


cut_dir = os.path.join(UNREAL, "Content/Movies/Cutout")
cutout = sorted(f[:-4] for f in os.listdir(cut_dir) if f.lower().endswith(".mp4") and f[:-4] in clips) if os.path.isdir(cut_dir) else []
if cutout:
    import subprocess
    ffmpeg = ffmpeg_exe()
    feet = {}
    for c in cutout:
        line_src = os.path.join(UNREAL, "Content/Movies", c + ".mp4")
        cut_src = os.path.join(cut_dir, c + ".mp4")
        dst = out("clips", "cutout", c + ".mp4")
        if not (os.path.exists(dst) and os.path.getmtime(dst) > max(os.path.getmtime(line_src), os.path.getmtime(cut_src))):
            w, g = PACK["w"], PACK["gap"]
            graph = (f"[0:v]pad={w + g}:{PACK['h']}:0:0:black[a];"
                     f"[1:v]crop={w}:{PACK['h']}:0:0,pad={w + g}:{PACK['h']}:0:0:black[b];"
                     f"[1:v]crop={w}:{PACK['h']}:{w}:0[c];[a][b][c]hstack=inputs=3,format=yuv420p[v]")
            subprocess.run([ffmpeg, "-v", "error", "-y", "-i", line_src, "-i", cut_src, "-filter_complex", graph, "-map", "[v]",
                            "-c:v", "libx264", "-preset", "slow", "-crf", "18", "-profile:v", "high", "-level", "5.1",
                            "-g", "30", "-fps_mode", "passthrough", "-movflags", "+faststart", "-an", dst], check=True)
        feet[c] = foot_track(ffmpeg, cut_src)
    with open(out("clips", "cutout", "feet.json"), "w", encoding="utf-8", newline="\n") as f:
        json.dump({"_about": "Per frame: [x_left, x_right, y_bottom, y_top, cut] of the dunker's lowest 3% in the 720x1280 "
                             "clip (cut = runs off the bottom of the frame), or null. Written by tools/sync_assets.py.",
                   "fps": PACK["fps"], "clips": feet}, f, separators=(",", ":"))

with open(out("js", "clips.js"), "w") as f:
    f.write("// Generated by tools/sync_assets.py: clips that exist in clips/, those with real footage in clips/real/, and\n"
            "// those with a cutout (clips/cutout/<Clip>.mp4: line art | real | matte in one video, laid out as PACKING).\n"
            "export const CLIPS = new Set(%s);\nexport const REAL = new Set(%s);\nexport const CUTOUT = new Set(%s);\n"
            "export const PACKING = %s;\n" % (json.dumps(clips), json.dumps(real), json.dumps(cutout), json.dumps(PACK)))

for song in ["DefaultTheme", "Song2", "FastLane", "Over", "Represent", "WeDemBoyz"]:
    copy(os.path.join(UNREAL, "Audio", song + ".mp3"), "assets", "audio", song + ".mp3")
copy(os.path.join(UNREAL, "Audio", "RadioStatic.wav"), "assets", "audio", "RadioStatic.wav")
for s in ["UI_Hover", "UI_Select", "UI_Back", "Radio_Button", "Radio_Detent", "Radio_Power"]:
    copy(os.path.join(UNREAL, "Audio", "UI", s + ".wav"), "assets", "audio", "ui", s + ".wav")


# ---- Dunk sound effects (js/sfx.js) ----
# Sounds: <unreal>/Audio/SFXLib/processed/*.wav (real recordings cut into one-shots by Tools/FXLab/sfx/build_sfxlib.py,
# several variations of each; credits in <unreal>/Audio/SFXLib/CREDITS.md) are packed into ONE mono
# MP3 sprite, assets/audio/sfx/sfx.mp3, so a phone makes one request and decodes once. assets/audio/sfx/sfx.json lists
# each variation's [start, duration] in the sprite and each sound's "peak" (seconds from its start to the moment it
# belongs to). MP3 encoders add a little silence at the start that some decoders keep and some trim, so "calib" is
# the time of the sprite's first loud sample: the player finds that sample in the decoded audio and shifts every
# offset by the difference.
# Events: <unreal>/Tools/FXLab/sfx/events.json (detect_events.py + overrides.json) -> assets/audio/sfx/events.json.
SFX_DIR = os.path.join(UNREAL, "Audio", "SFXLib", "processed")  # only the mixed sprite is published, never the originals
SFX_EVENTS = os.path.join(UNREAL, "Tools", "FXLab", "sfx", "events.json")


# Curation, the same rules as <unreal>/Tools/FXLab/sfx/render_preview_lib.py (the user approved its previews; keep both
# in step): nothing after the dunk's landing (+0.3 s), no rim clang on a soft rim hit (the ball just drops through:
# strength < 0.72, the net still plays), and every clip uses the indoor (court) sounds.
def curate_events(events, after_landing=0.3, soft_rim=0.72):
    ev = sorted(events, key=lambda e: e["t"])
    rim = next((e["t"] for e in ev if e["type"] == "rim"), None)
    if rim is not None:
        land = next((e["t"] for e in ev if e["type"] == "landing" and e["t"] >= rim), None)
        if land is not None:
            ev = [e for e in ev if e["t"] <= land + after_landing]
    return [e for e in ev if not (e["type"] == "rim" and e.get("strength", 1) < soft_rim)]


def sfx_sprite():
    import subprocess
    import wave
    import numpy as np
    meta = json.load(open(os.path.join(SFX_DIR, "sounds.json"), encoding="utf-8"))
    sr = meta["sr"]
    lead, gap = 0.1, 0.08
    parts, table, pos = [np.zeros(int(sr * lead), np.int16)], {}, lead
    for name, s in meta["sounds"].items():
        table[name] = {"peak": s["peak"], "v": []}
        for fn in s["files"]:
            with wave.open(os.path.join(SFX_DIR, fn)) as w:
                assert w.getframerate() == sr and w.getnchannels() == 1
                x = np.frombuffer(w.readframes(w.getnframes()), "<i2")
            table[name]["v"].append([round(pos, 5), round(len(x) / sr, 5)])
            parts += [x, np.zeros(int(sr * gap), np.int16)]
            pos += (len(x) + int(sr * gap)) / sr
    pcm = np.concatenate(parts)
    calib = float(np.argmax(np.abs(pcm) >= 0.05 * 32768)) / sr
    dst = out("assets", "audio", "sfx", "sfx.mp3")
    subprocess.run([ffmpeg_exe(), "-v", "error", "-y", "-f", "s16le", "-ar", str(sr), "-ac", "1", "-i", "-",
                    "-c:a", "libmp3lame", "-b:a", "96k", dst], input=pcm.tobytes(), check=True)
    with open(out("assets", "audio", "sfx", "sfx.json"), "w", encoding="utf-8", newline="\n") as f:
        json.dump({"_about": "Sprite map for sfx.mp3 (tools/sync_assets.py): per sound, peak (s) and variations [start, "
                             "duration] in s; calib = time of the first sample >= 5% full scale, before encoding.",
                   "calib": round(calib, 5), "sounds": table}, f, separators=(",", ":"))
    with open(SFX_EVENTS, encoding="utf-8") as f:
        ev = json.load(f)
    clips_ev = {}
    for key, c in ev["clips"].items():
        clips_ev[key] = {"frames": c["frames"], "surface": "court", "slow": c.get("slow", 1),  # indoor set everywhere
                         "events": [{"t": e["t"], "type": e["type"], "s": e["strength"], "pan": e["pan"]} for e in curate_events(c["events"])]}
    with open(out("assets", "audio", "sfx", "events.json"), "w", encoding="utf-8", newline="\n") as f:
        json.dump({"_about": "Sound events per clip, from the Unreal project's Tools/FXLab/sfx/detect_events.py (copied by "
                             "tools/sync_assets.py). t = seconds into the clip, s = strength 0..1, pan = screen position -1..1.",
                   "fps": ev["fps"], "clips": clips_ev}, f, separators=(",", ":"))
    print("sfx: %d sounds, %.1f s sprite, %d KB; events for %d clips" % (
        sum(len(v["v"]) for v in table.values()), len(pcm) / sr, os.path.getsize(dst) // 1024, len(clips_ev)))


if os.path.isdir(SFX_DIR) and os.path.exists(SFX_EVENTS):
    sfx_sprite()

# Icons (white, used as CSS masks) still come from the first UI kit; its chrome pieces were replaced by the brand kit.
for n in ["icon_play", "icon_pause", "icon_replay", "icon_back", "icon_view", "icon_chevron"]:
    image(os.path.join(KIT, n + ".png"), "assets/ui", n)

# Brand (graphite + champagne gold): logo, monogram, icons and the kit pieces -> assets/brand/
for n in ["logo.svg", "monogram.svg", "favicon.ico"]:
    copy(os.path.join(BRAND, n), "assets", "brand", n)
for n in ["logo_metal", "monogram_metal", "icon_32", "icon_180", "icon_192", "icon_512"]:
    image(os.path.join(BRAND, n + ".png"), "assets/brand", n)
# logo_mask.png is greyscale (no alpha); CSS masks read alpha, so store it as white with that alpha.
mask = Image.open(os.path.join(BRAND, "logo_mask.png")).convert("L")
white = Image.new("RGBA", mask.size, (255, 255, 255, 0))
white.putalpha(mask)
white.save(out("assets", "brand", "logo_mask.png"), optimize=True)
image(os.path.join(BRAND_KIT, "background.png"), "assets/brand/kit", "background", fmt="jpg", quality=84)
for n in ["card_normal", "card_hover", "card_pressed", "key_normal", "key_hover", "key_pressed",
          "screen_bezel", "pill", "divider"]:
    image(os.path.join(BRAND_KIT, n + ".png"), "assets/brand/kit", n)
copy(os.path.join(BRAND_KIT, "layout.json"), "assets", "brand", "kit", "layout.json")
# Per-clip phone cameras (Tools/Brand/clip_cameras.py): the live court swoops into them when a dunk is picked.
with open(os.path.join(BRAND, "clip_cameras.json"), encoding="utf-8") as f:
    cams = json.load(f)
with open(out("assets", "brand", "clip_cameras.json"), "w", encoding="utf-8", newline="\n") as f:
    json.dump(cams, f, separators=(",", ":"))


def og_image():
    """1200x630 share card: the stage background, the gold logo centred, the monogram above it."""
    W, H = 1200, 630
    bg = Image.open(os.path.join(BRAND_KIT, "background.png")).convert("RGB")
    s = W / bg.width
    bg = bg.resize((W, round(bg.height * s)), Image.LANCZOS)
    top = round((bg.height - H) * 0.35)  # keep the top light, crop more of the floor
    card = bg.crop((0, top, W, top + H)).convert("RGBA")
    card = Image.blend(card, Image.new("RGBA", card.size, (12, 14, 17, 255)), 0.35)  # quieter, so the logo leads
    logo = Image.open(os.path.join(BRAND, "logo_metal.png")).convert("RGBA")
    lw = 860
    logo = logo.resize((lw, round(logo.height * lw / logo.width)), Image.LANCZOS)
    mono = Image.open(os.path.join(BRAND, "monogram_metal.png")).convert("RGBA")
    mw = 150
    mono = mono.resize((mw, round(mono.height * mw / mono.width)), Image.LANCZOS)
    gap = 34
    y0 = round((H - (mono.height + gap + logo.height)) / 2)
    card.alpha_composite(mono, ((W - mw) // 2, y0))
    card.alpha_composite(logo, ((W - lw) // 2, y0 + mono.height + gap))
    card.convert("RGB").save(out("assets", "brand", "og.jpg"), quality=88, optimize=True)


og_image()

image(os.path.join(RADIO, "faceplate.png"), "assets/radio", "faceplate", fmt="webp")
for n in ["knob", "key_normal", "key_pressed", "small_key_normal", "small_key_pressed", "display_glass", "dial_glass"]:
    image(os.path.join(RADIO, n + ".png"), "assets/radio", n)
copy(os.path.join(RADIO_LAYOUT, "layout.json"), "assets", "radio", "layout.json")

total = sum(os.path.getsize(os.path.join(r, f)) for r, _, fs in os.walk(HERE) for f in fs if ".git" not in r)
print("clips: %d (real footage: %d)   total size: %.1f MB" % (len(clips), len(real), total / 1e6))
