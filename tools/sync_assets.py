"""Copy Dunk Lab's media from the Unreal project into this web build.

Run again whenever clips, songs or art change in the Unreal project:
    python tools/sync_assets.py

- Clips:  <unreal>/Content/Movies/*.mp4                  -> clips/
- Real footage, synced to the line art (Tools/FXLab/real/make_real.py): <unreal>/Content/Movies/Real/*.mp4 -> clips/real/
- Cutouts (Tools/FXLab/cutout): <unreal>/Content/Movies/Cutout/*.mp4, packed with the line art into one video
  -> clips/cutout/, plus the dunker's per-frame foot track clips/cutout/feet.json (needs ffmpeg and numpy/scipy)
- Music:  <unreal>/Audio/*.mp3 and RadioStatic.wav       -> assets/audio/
- Sounds: <unreal>/Audio/UI/*.wav                        -> assets/audio/ui/
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
