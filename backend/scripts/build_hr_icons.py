"""Generate the human-rights / OSINT icon set as 96x96 PNGs.

White silhouettes on transparent — designed so KML's <IconStyle><color> multiply
works (red tint → red icon). Pillow is only used at build time; the runtime
serves the committed PNG bytes.

Run: `.venv/bin/python scripts/build_hr_icons.py`
"""

from __future__ import annotations

import math
from pathlib import Path

from PIL import Image, ImageDraw

SIZE = 96
WHITE = (255, 255, 255, 255)
TRANSPARENT = (255, 255, 255, 0)
OUT_DIR = Path(__file__).resolve().parent.parent / "app" / "kml" / "hr_icons"


def _canvas() -> tuple[Image.Image, ImageDraw.ImageDraw]:
    img = Image.new("RGBA", (SIZE, SIZE), TRANSPARENT)
    return img, ImageDraw.Draw(img)


def _save(img: Image.Image, name: str) -> None:
    out = OUT_DIR / f"{name}.png"
    img.save(out, "PNG", optimize=True)


def _ring(draw: ImageDraw.ImageDraw, cx: float, cy: float, r: float, w: int) -> None:
    draw.ellipse([cx - r, cy - r, cx + r, cy + r], outline=WHITE, width=w)


def _disc(draw: ImageDraw.ImageDraw, cx: float, cy: float, r: float) -> None:
    draw.ellipse([cx - r, cy - r, cx + r, cy + r], fill=WHITE)


def _line(draw, x1, y1, x2, y2, w: int) -> None:
    draw.line([(x1, y1), (x2, y2)], fill=WHITE, width=w)


def _stroke_rect(draw, x1, y1, x2, y2, w: int, radius: int = 0) -> None:
    if radius:
        draw.rounded_rectangle([x1, y1, x2, y2], radius=radius, outline=WHITE, width=w)
    else:
        draw.rectangle([x1, y1, x2, y2], outline=WHITE, width=w)


def _filled_rect(draw, x1, y1, x2, y2, radius: int = 0) -> None:
    if radius:
        draw.rounded_rectangle([x1, y1, x2, y2], radius=radius, fill=WHITE)
    else:
        draw.rectangle([x1, y1, x2, y2], fill=WHITE)


# -------- SOURCE (8) --------


def src_video() -> Image.Image:
    img, d = _canvas()
    _stroke_rect(d, 14, 22, 82, 74, 6, radius=8)
    # play triangle
    d.polygon([(40, 34), (40, 62), (66, 48)], fill=WHITE)
    return img


def src_photo() -> Image.Image:
    img, d = _canvas()
    # viewfinder bump
    _filled_rect(d, 36, 18, 60, 30, radius=2)
    # body
    _stroke_rect(d, 12, 28, 84, 78, 6, radius=6)
    # lens (filled circle with inner hole to read as a lens)
    _disc(d, 48, 53, 16)
    d.ellipse([42, 47, 54, 59], fill=TRANSPARENT)
    return img


def src_satellite() -> Image.Image:
    img, d = _canvas()
    # central body
    _filled_rect(d, 38, 38, 58, 58, radius=2)
    # solar panels left & right
    _filled_rect(d, 8, 42, 32, 54)
    _filled_rect(d, 64, 42, 88, 54)
    # panel divisions
    for x in (16, 24, 72, 80):
        _line(d, x, 42, x, 54, 2)
    # antenna stem & dish
    _line(d, 48, 38, 48, 22, 4)
    d.pieslice([34, 8, 62, 36], start=200, end=340, fill=WHITE)
    return img


def src_drone() -> Image.Image:
    img, d = _canvas()
    # central body
    _disc(d, 48, 48, 10)
    # arms
    for ax, ay in [(18, 18), (78, 18), (18, 78), (78, 78)]:
        _line(d, 48, 48, ax, ay, 5)
        _ring(d, ax, ay, 12, 4)
    return img


def src_social() -> Image.Image:
    img, d = _canvas()
    # rounded speech bubble
    _filled_rect(d, 12, 16, 84, 66, radius=12)
    # tail
    d.polygon([(28, 64), (32, 80), (44, 64)], fill=WHITE)
    # cut three "dots" line out of bubble (so it reads as a chat bubble)
    for cx in (34, 48, 62):
        d.ellipse([cx - 4, 37, cx + 4, 45], fill=TRANSPARENT)
    return img


def src_broadcast() -> Image.Image:
    img, d = _canvas()
    # antennas
    _line(d, 48, 30, 22, 10, 4)
    _line(d, 48, 30, 74, 10, 4)
    _disc(d, 22, 10, 4)
    _disc(d, 74, 10, 4)
    # TV body
    _stroke_rect(d, 12, 30, 84, 80, 6, radius=6)
    # screen "wave" lines
    _line(d, 24, 50, 72, 50, 4)
    _line(d, 24, 60, 72, 60, 4)
    return img


def src_document() -> Image.Image:
    img, d = _canvas()
    # page with folded corner
    d.polygon(
        [(22, 10), (66, 10), (84, 28), (84, 86), (22, 86)],
        outline=WHITE,
        width=6,
    )
    # fold triangle
    d.polygon([(66, 10), (66, 28), (84, 28)], outline=WHITE, width=6)
    # text lines
    for y in (44, 56, 68):
        _line(d, 32, y, 74, y, 4)
    return img


def src_witness() -> Image.Image:
    img, d = _canvas()
    # head
    _disc(d, 36, 32, 12)
    # shoulders
    d.pieslice([12, 44, 60, 92], start=180, end=360, fill=WHITE)
    # speech bubble pointing from the figure
    _filled_rect(d, 56, 16, 90, 44, radius=6)
    d.polygon([(60, 42), (56, 52), (70, 42)], fill=WHITE)
    # quote marks inside bubble (transparent dots)
    d.ellipse([62, 24, 70, 32], fill=TRANSPARENT)
    d.ellipse([76, 24, 84, 32], fill=TRANSPARENT)
    return img


# -------- IHL EVENT (8) --------


def evt_shelling() -> Image.Image:
    img, d = _canvas()
    # 8-point burst
    cx, cy = 48, 48
    pts = []
    for i in range(16):
        ang = -math.pi / 2 + i * math.pi / 8
        r = 42 if i % 2 == 0 else 16
        pts.append((cx + r * math.cos(ang), cy + r * math.sin(ang)))
    d.polygon(pts, fill=WHITE)
    return img


def evt_airstrike() -> Image.Image:
    img, d = _canvas()
    # plane silhouette (top)
    # fuselage
    _filled_rect(d, 44, 10, 52, 40, radius=2)
    # wings
    d.polygon([(14, 22), (82, 22), (60, 30), (36, 30)], fill=WHITE)
    # tail
    d.polygon([(40, 36), (56, 36), (52, 44), (44, 44)], fill=WHITE)
    # falling munitions (dashes)
    for x in (32, 48, 64):
        _line(d, x, 52, x, 64, 4)
        _line(d, x, 70, x, 80, 4)
    return img


def evt_casualty() -> Image.Image:
    img, d = _canvas()
    # horizontal figure (silhouette lying down)
    # head
    _disc(d, 22, 48, 10)
    # body / torso
    _filled_rect(d, 30, 42, 70, 54, radius=4)
    # legs
    _filled_rect(d, 70, 42, 86, 50, radius=2)
    _filled_rect(d, 70, 50, 86, 58, radius=2)
    # baseline ground
    _line(d, 8, 72, 88, 72, 4)
    return img


def evt_mass_grave() -> Image.Image:
    img, d = _canvas()
    # ground line
    _line(d, 6, 74, 90, 74, 5)
    # three crosses (grave markers)
    for cx in (22, 48, 74):
        _line(d, cx, 30, cx, 68, 5)
        _line(d, cx - 8, 42, cx + 8, 42, 5)
    return img


def evt_detention() -> Image.Image:
    img, d = _canvas()
    # outer frame
    _stroke_rect(d, 14, 14, 82, 82, 6, radius=4)
    # vertical bars
    for x in (28, 40, 52, 64):
        _line(d, x, 20, x, 76, 5)
    return img


def evt_displacement() -> Image.Image:
    img, d = _canvas()
    # three walking-figure silhouettes (tiny), arrow under
    def figure(x: int) -> None:
        _disc(d, x, 28, 6)
        d.polygon(
            [(x - 8, 38), (x + 8, 38), (x + 10, 60), (x - 10, 60)],
            fill=WHITE,
        )
    figure(20)
    figure(48)
    figure(76)
    # arrow
    _line(d, 12, 80, 78, 80, 5)
    d.polygon([(78, 74), (88, 80), (78, 86)], fill=WHITE)
    return img


def evt_attack_civilian() -> Image.Image:
    img, d = _canvas()
    # person silhouette in center
    _disc(d, 48, 28, 10)
    d.polygon([(30, 40), (66, 40), (62, 70), (34, 70)], fill=WHITE)
    # crosshair around
    _ring(d, 48, 48, 38, 4)
    _line(d, 48, 4, 48, 18, 4)
    _line(d, 48, 78, 48, 92, 4)
    _line(d, 4, 48, 18, 48, 4)
    _line(d, 78, 48, 92, 48, 4)
    return img


def evt_indiscriminate() -> Image.Image:
    img, d = _canvas()
    # cluster: scattered filled circles
    spots = [
        (24, 24, 7), (44, 18, 5), (66, 26, 6),
        (16, 50, 5), (40, 44, 7), (58, 52, 6), (78, 44, 5),
        (28, 70, 6), (50, 76, 7), (72, 68, 5), (84, 76, 4),
        (8, 78, 4),
    ]
    for cx, cy, r in spots:
        _disc(d, cx, cy, r)
    return img


# -------- PROTECTED (6) --------


def prot_medical() -> Image.Image:
    img, d = _canvas()
    # red-cross / medical plus
    _filled_rect(d, 38, 10, 58, 86, radius=4)
    _filled_rect(d, 10, 38, 86, 58, radius=4)
    return img


def prot_school() -> Image.Image:
    img, d = _canvas()
    # mortarboard top
    d.polygon([(48, 18), (90, 38), (48, 58), (6, 38)], fill=WHITE)
    # cap base
    _filled_rect(d, 22, 50, 74, 70, radius=4)
    # tassel
    _line(d, 78, 38, 78, 60, 4)
    _disc(d, 78, 64, 4)
    return img


def prot_religious() -> Image.Image:
    img, d = _canvas()
    # domed building (universalist silhouette: column + dome, no cross/crescent/star)
    # base
    _filled_rect(d, 12, 70, 84, 86, radius=2)
    # walls
    _filled_rect(d, 20, 44, 76, 70)
    # dome
    d.pieslice([20, 22, 76, 78], start=180, end=360, fill=WHITE)
    # spire (small)
    _line(d, 48, 26, 48, 12, 5)
    _disc(d, 48, 10, 4)
    return img


def prot_heritage() -> Image.Image:
    img, d = _canvas()
    # Greek column: capital, shaft (with flutes), base
    _filled_rect(d, 14, 16, 82, 24)
    _filled_rect(d, 20, 24, 76, 32)
    # shaft
    _filled_rect(d, 28, 32, 68, 72)
    # flutes (transparent vertical lines)
    for x in (36, 44, 52, 60):
        _line(d, x, 36, x, 68, 2)
        # draw transparent over white by re-blanking — use a black-on-white fudge
    # base
    _filled_rect(d, 20, 72, 76, 80)
    _filled_rect(d, 14, 80, 82, 88)
    return img


def prot_water() -> Image.Image:
    img, d = _canvas()
    # teardrop
    d.polygon(
        [
            (48, 8),
            (76, 50),
            (72, 70),
            (60, 84),
            (36, 84),
            (24, 70),
            (20, 50),
        ],
        fill=WHITE,
    )
    return img


def prot_press() -> Image.Image:
    img, d = _canvas()
    # video camera body
    _filled_rect(d, 8, 36, 64, 72, radius=4)
    # lens cone
    d.polygon([(64, 44), (88, 32), (88, 76), (64, 64)], fill=WHITE)
    # "REC" dot
    d.ellipse([16, 44, 24, 52], fill=TRANSPARENT)
    return img


# -------- FORCES (5) --------


def force_military() -> Image.Image:
    img, d = _canvas()
    # combat helmet silhouette
    d.pieslice([14, 20, 82, 76], start=180, end=360, fill=WHITE)
    # brim
    _filled_rect(d, 10, 46, 86, 54, radius=2)
    # chin strap suggestion
    _line(d, 22, 54, 30, 70, 4)
    _line(d, 74, 54, 66, 70, 4)
    return img


def force_checkpoint() -> Image.Image:
    img, d = _canvas()
    # two posts
    _filled_rect(d, 10, 28, 18, 86)
    _filled_rect(d, 78, 28, 86, 86)
    # barrier (striped) — emulate stripes by drawing alternating blocks
    bar_y1, bar_y2 = 36, 56
    stripe_w = 12
    x = 18
    on = True
    while x < 78:
        nx = min(x + stripe_w, 78)
        if on:
            _filled_rect(d, x, bar_y1, nx, bar_y2)
        x = nx
        on = not on
    # outline the bar fully
    _stroke_rect(d, 18, bar_y1, 78, bar_y2, 3)
    return img


def force_armor() -> Image.Image:
    img, d = _canvas()
    # hull
    _filled_rect(d, 6, 56, 90, 78, radius=4)
    # tracks (small wheels)
    for cx in (16, 28, 40, 52, 64, 76):
        _disc(d, cx, 84, 5)
    # turret
    _filled_rect(d, 28, 38, 64, 56, radius=4)
    # barrel
    _filled_rect(d, 60, 44, 92, 50, radius=2)
    return img


def force_weapon() -> Image.Image:
    img, d = _canvas()
    # bullet/munition silhouette
    # tip (triangle)
    d.polygon([(48, 6), (66, 32), (30, 32)], fill=WHITE)
    # body
    _filled_rect(d, 30, 32, 66, 72)
    # casing band
    _line(d, 30, 50, 66, 50, 2)
    # primer
    _filled_rect(d, 38, 72, 58, 84, radius=2)
    return img


def force_border() -> Image.Image:
    img, d = _canvas()
    # flagpole
    _filled_rect(d, 22, 8, 28, 88)
    # pennant
    d.polygon([(28, 14), (78, 22), (28, 38)], fill=WHITE)
    # ground line, dashed (border)
    x = 6
    while x < 90:
        _line(d, x, 82, min(x + 8, 88), 82, 4)
        x += 14
    return img


# -------- VERIFICATION (4) --------


def ver_verified() -> Image.Image:
    img, d = _canvas()
    # shield outline
    d.polygon(
        [(48, 8), (84, 22), (82, 56), (48, 88), (14, 56), (12, 22)],
        outline=WHITE,
        width=6,
    )
    # checkmark
    d.line([(28, 50), (44, 64), (70, 34)], fill=WHITE, width=8)
    return img


def ver_corroborated() -> Image.Image:
    img, d = _canvas()
    # two overlapping rings (Venn)
    _ring(d, 34, 48, 24, 6)
    _ring(d, 62, 48, 24, 6)
    return img


def ver_pending() -> Image.Image:
    img, d = _canvas()
    _ring(d, 48, 48, 38, 6)
    # question mark stem
    d.arc([30, 18, 66, 54], start=180, end=360, fill=WHITE, width=8)
    _line(d, 48, 54, 48, 64, 8)
    _disc(d, 48, 74, 5)
    return img


def ver_disputed() -> Image.Image:
    img, d = _canvas()
    # warning triangle
    d.polygon([(48, 8), (90, 84), (6, 84)], outline=WHITE, width=6)
    # exclamation
    _filled_rect(d, 44, 32, 52, 60, radius=2)
    _disc(d, 48, 72, 5)
    return img


# -------- registry --------

ICONS: list[tuple[str, callable]] = [
    # source
    ("hr-src-video", src_video),
    ("hr-src-photo", src_photo),
    ("hr-src-satellite", src_satellite),
    ("hr-src-drone", src_drone),
    ("hr-src-social", src_social),
    ("hr-src-broadcast", src_broadcast),
    ("hr-src-document", src_document),
    ("hr-src-witness", src_witness),
    # event
    ("hr-evt-shelling", evt_shelling),
    ("hr-evt-airstrike", evt_airstrike),
    ("hr-evt-casualty", evt_casualty),
    ("hr-evt-mass-grave", evt_mass_grave),
    ("hr-evt-detention", evt_detention),
    ("hr-evt-displacement", evt_displacement),
    ("hr-evt-attack-civilian", evt_attack_civilian),
    ("hr-evt-indiscriminate", evt_indiscriminate),
    # protected
    ("hr-prot-medical", prot_medical),
    ("hr-prot-school", prot_school),
    ("hr-prot-religious", prot_religious),
    ("hr-prot-heritage", prot_heritage),
    ("hr-prot-water", prot_water),
    ("hr-prot-press", prot_press),
    # forces
    ("hr-force-military", force_military),
    ("hr-force-checkpoint", force_checkpoint),
    ("hr-force-armor", force_armor),
    ("hr-force-weapon", force_weapon),
    ("hr-force-border", force_border),
    # verification
    ("hr-ver-verified", ver_verified),
    ("hr-ver-corroborated", ver_corroborated),
    ("hr-ver-pending", ver_pending),
    ("hr-ver-disputed", ver_disputed),
]


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    for name, render in ICONS:
        img = render()
        _save(img, name)
        print(f"wrote {name}.png")
    print(f"\n{len(ICONS)} icons written to {OUT_DIR}")


if __name__ == "__main__":
    main()
