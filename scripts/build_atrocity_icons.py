"""Generate the atrocity-investigations icon set as 96x96 PNGs.

White silhouettes on transparent — designed so KML's <IconStyle><color> multiply
works (red tint → red icon). Pillow is only used at build time; the runtime
serves the committed PNG bytes.

The SVG sources in ``scripts/atrocity_icon_sources/`` are the visual spec; the
Pillow renderers below implement those same silhouettes in raster. Keeping a
pure-Pillow pipeline avoids dragging the libcairo system dependency into the
backend image just to build a handful of icons.

Run: ``.venv/bin/python scripts/build_atrocity_icons.py``
"""

from __future__ import annotations

import math
from pathlib import Path

from PIL import Image, ImageDraw

SIZE = 96
WHITE = (255, 255, 255, 255)
TRANSPARENT = (255, 255, 255, 0)
OUT_DIR = Path(__file__).resolve().parent.parent / "backend" / "app" / "kml" / "atrocity_icons"


def _canvas() -> tuple[Image.Image, ImageDraw.ImageDraw]:
    img = Image.new("RGBA", (SIZE, SIZE), TRANSPARENT)
    return img, ImageDraw.Draw(img)


def _save(img: Image.Image, name: str) -> None:
    out = OUT_DIR / f"{name}.png"
    img.save(out, "PNG", optimize=True)


def _ring(d, cx, cy, r, w):
    d.ellipse([cx - r, cy - r, cx + r, cy + r], outline=WHITE, width=w)


def _disc(d, cx, cy, r):
    d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=WHITE)


def _line(d, x1, y1, x2, y2, w):
    d.line([(x1, y1), (x2, y2)], fill=WHITE, width=w)


def _stroke_rect(d, x1, y1, x2, y2, w, radius=0):
    if radius:
        d.rounded_rectangle([x1, y1, x2, y2], radius=radius, outline=WHITE, width=w)
    else:
        d.rectangle([x1, y1, x2, y2], outline=WHITE, width=w)


def _filled_rect(d, x1, y1, x2, y2, radius=0):
    if radius:
        d.rounded_rectangle([x1, y1, x2, y2], radius=radius, fill=WHITE)
    else:
        d.rectangle([x1, y1, x2, y2], fill=WHITE)


# ===== DETENTION =====


def detention_facility():
    """Fenced compound: outer frame with vertical bars."""
    img, d = _canvas()
    _stroke_rect(d, 12, 12, 84, 84, 6)
    for x in (24, 40, 56, 72):
        _line(d, x, 18, x, 78, 5)
    return img


def prison():
    """Barred building with pitched roof — institutional silhouette."""
    img, d = _canvas()
    # roof
    d.polygon([(8, 32), (48, 12), (88, 32)], fill=WHITE)
    # walls
    _stroke_rect(d, 12, 32, 84, 84, 5)
    # bars
    for x in (24, 36, 48, 60, 72):
        _line(d, x, 36, x, 80, 4)
    return img


def secret_detention():
    """Barred frame with a small magnifier — hidden facility."""
    img, d = _canvas()
    _stroke_rect(d, 10, 10, 70, 86, 5)
    for x in (22, 34, 46, 58):
        _line(d, x, 16, x, 80, 4)
    # magnifier suggesting investigation / concealment
    _ring(d, 74, 56, 12, 5)
    _line(d, 82, 64, 90, 78, 6)
    return img


def holding_cell():
    """Small bar-fronted cell — three bars only."""
    img, d = _canvas()
    _stroke_rect(d, 18, 14, 78, 82, 6)
    for x in (38, 48, 58):
        _line(d, x, 20, x, 76, 5)
    _disc(d, 68, 48, 4)  # latch
    return img


def interrogation_site():
    """Lone chair under a hanging lamp — abstracted."""
    img, d = _canvas()
    # lamp cord + shade
    _line(d, 48, 6, 48, 22, 3)
    d.polygon([(34, 22), (62, 22), (56, 34), (40, 34)], fill=WHITE)
    # chair back + seat
    _filled_rect(d, 36, 48, 60, 56)
    _filled_rect(d, 36, 56, 44, 84)
    _filled_rect(d, 52, 56, 60, 84)
    return img


# ===== MORTALITY =====


def mass_grave():
    """Pit shape (trapezoid) with multiple dashes inside."""
    img, d = _canvas()
    d.polygon(
        [(10, 50), (86, 50), (78, 84), (18, 84)],
        outline=WHITE, width=5,
    )
    # dashes inside representing remains
    for y in (60, 70, 80):
        for x in (26, 44, 62):
            _line(d, x, y, x + 8, y, 4)
    return img


def individual_grave():
    """Single rounded headstone over ground line."""
    img, d = _canvas()
    _line(d, 8, 80, 88, 80, 5)
    # rounded stone
    d.pieslice([28, 24, 68, 64], start=180, end=360, fill=WHITE)
    _filled_rect(d, 28, 44, 68, 80)
    # inscription
    _line(d, 38, 52, 58, 52, 3)
    _line(d, 36, 60, 60, 60, 3)
    return img


def body_recovery():
    """Stretcher silhouette."""
    img, d = _canvas()
    # stretcher poles
    _filled_rect(d, 6, 46, 90, 54, radius=2)
    _disc(d, 8, 50, 5)
    _disc(d, 88, 50, 5)
    # covered body shape
    d.polygon([(20, 46), (76, 46), (70, 36), (26, 36)], fill=WHITE)
    return img


def mortuary():
    """Building with grid of small drawers."""
    img, d = _canvas()
    _stroke_rect(d, 10, 18, 86, 84, 5)
    for col in (24, 42, 60, 78):
        for row in (32, 50, 68):
            _filled_rect(d, col - 6, row - 6, col + 6, row + 6, radius=1)
    return img


def cemetery():
    """Row of three headstones over ground line."""
    img, d = _canvas()
    _line(d, 4, 82, 92, 82, 5)
    # left
    d.pieslice([10, 36, 34, 60], start=180, end=360, fill=WHITE)
    _filled_rect(d, 10, 48, 34, 82)
    # middle (taller)
    d.pieslice([36, 24, 60, 48], start=180, end=360, fill=WHITE)
    _filled_rect(d, 36, 36, 60, 82)
    # right
    d.pieslice([62, 40, 86, 62], start=180, end=360, fill=WHITE)
    _filled_rect(d, 62, 51, 86, 82)
    return img


# ===== DESTRUCTION =====


def destroyed_building():
    """Building outline with collapsed corner and crack."""
    img, d = _canvas()
    # remaining structure
    d.polygon(
        [(12, 84), (12, 30), (44, 30), (60, 50), (76, 50), (84, 38), (84, 84)],
        outline=WHITE, width=5,
    )
    _line(d, 8, 84, 88, 84, 5)
    # crack
    d.line([(30, 84), (34, 70), (28, 56), (36, 42)], fill=WHITE, width=4)
    return img


def damaged_infra():
    """Bridge / utility frame with broken segment."""
    img, d = _canvas()
    # piers
    _filled_rect(d, 10, 50, 18, 84)
    _filled_rect(d, 78, 50, 86, 84)
    # deck (broken in the middle)
    _filled_rect(d, 10, 46, 38, 54)
    _filled_rect(d, 58, 46, 86, 54)
    # broken jagged edges
    d.polygon([(38, 46), (44, 54), (38, 54)], fill=WHITE)
    d.polygon([(58, 46), (52, 54), (58, 54)], fill=WHITE)
    # truss above
    d.line([(14, 46), (32, 26), (50, 46)], fill=WHITE, width=3)
    d.line([(46, 46), (64, 26), (82, 46)], fill=WHITE, width=3)
    return img


def burnt_structure():
    """Building outline with flame shape inside."""
    img, d = _canvas()
    _stroke_rect(d, 16, 30, 80, 86, 5)
    _line(d, 12, 86, 84, 86, 5)
    # roof line
    d.polygon([(14, 30), (48, 10), (82, 30)], outline=WHITE, width=5)
    # flame
    d.polygon(
        [(48, 76), (38, 60), (44, 56), (40, 46), (52, 54), (50, 44), (60, 60)],
        fill=WHITE,
    )
    return img


def shelled_site():
    """Impact star / asterisk — abstract burst."""
    img, d = _canvas()
    cx, cy = 48, 48
    pts = []
    for i in range(16):
        ang = -math.pi / 2 + i * math.pi / 8
        r = 40 if i % 2 == 0 else 14
        pts.append((cx + r * math.cos(ang), cy + r * math.sin(ang)))
    d.polygon(pts, fill=WHITE)
    _disc(d, cx, cy, 6)
    # leave a small hole for "impact point"
    d.ellipse([cx - 3, cy - 3, cx + 3, cy + 3], fill=TRANSPARENT)
    return img


def demolished():
    """Pile of rubble — irregular blocks at ground level."""
    img, d = _canvas()
    _line(d, 4, 84, 92, 84, 5)
    # rubble blocks
    d.polygon([(10, 84), (16, 64), (28, 60), (32, 76), (40, 70), (48, 84)], fill=WHITE)
    d.polygon([(46, 84), (52, 68), (66, 64), (70, 78), (82, 72), (86, 84)], fill=WHITE)
    # scattered chunks above
    _filled_rect(d, 22, 52, 30, 60, radius=1)
    _filled_rect(d, 60, 56, 68, 64, radius=1)
    return img


# ===== MILITARY =====


def military_base():
    """Star inside hex / compound — abstracted command icon."""
    img, d = _canvas()
    # compound frame
    d.polygon(
        [(20, 14), (76, 14), (88, 48), (76, 82), (20, 82), (8, 48)],
        outline=WHITE, width=5,
    )
    # 5-point star
    cx, cy = 48, 50
    pts = []
    for i in range(10):
        ang = -math.pi / 2 + i * math.pi / 5
        r = 22 if i % 2 == 0 else 9
        pts.append((cx + r * math.cos(ang), cy + r * math.sin(ang)))
    d.polygon(pts, fill=WHITE)
    return img


def checkpoint():
    """Striped barrier across road between two posts."""
    img, d = _canvas()
    _filled_rect(d, 8, 30, 18, 86)
    _filled_rect(d, 78, 30, 88, 86)
    # barrier
    _stroke_rect(d, 18, 42, 78, 60, 4)
    # stripes inside barrier
    stripe_w = 10
    x = 18
    on = True
    while x < 78:
        nx = min(x + stripe_w, 78)
        if on:
            _filled_rect(d, x, 42, nx, 60)
        x = nx
        on = not on
    return img


def weapons_cache():
    """Crate with downward-arrow lid suggesting storage."""
    img, d = _canvas()
    _stroke_rect(d, 10, 26, 86, 84, 5)
    _line(d, 10, 44, 86, 44, 4)
    # arrow into top
    d.polygon([(48, 6), (38, 22), (44, 22), (44, 30), (52, 30), (52, 22), (58, 22)], fill=WHITE)
    # crate slats
    _line(d, 30, 44, 30, 84, 3)
    _line(d, 48, 44, 48, 84, 3)
    _line(d, 66, 44, 66, 84, 3)
    return img


def artillery():
    """Long-barrelled piece on wheels — abstracted."""
    img, d = _canvas()
    # carriage / chassis
    _filled_rect(d, 10, 56, 60, 68, radius=2)
    # wheels
    _disc(d, 20, 76, 8)
    _disc(d, 52, 76, 8)
    # barrel tilted up-right
    d.line([(34, 60), (90, 28)], fill=WHITE, width=10)
    # muzzle cap
    _filled_rect(d, 84, 22, 92, 34, radius=1)
    return img


def blast_crater():
    """Concentric ellipses with stylised ejecta marks."""
    img, d = _canvas()
    d.ellipse([10, 54, 86, 86], outline=WHITE, width=5)
    d.ellipse([24, 62, 72, 80], outline=WHITE, width=4)
    d.ellipse([36, 66, 60, 76], fill=WHITE)
    # ejecta lines
    _line(d, 16, 46, 26, 56, 4)
    _line(d, 80, 46, 70, 56, 4)
    _line(d, 48, 38, 48, 50, 4)
    return img


def munitions():
    """Single dropped bomb silhouette — teardrop with fins."""
    img, d = _canvas()
    # body
    d.polygon(
        [(48, 8), (62, 24), (62, 60), (54, 76), (42, 76), (34, 60), (34, 24)],
        fill=WHITE,
    )
    # tail fins
    d.polygon([(34, 60), (24, 78), (34, 78)], fill=WHITE)
    d.polygon([(62, 60), (72, 78), (62, 78)], fill=WHITE)
    return img


# ===== DISPLACEMENT =====


def idp_camp():
    """Cluster of three tent triangles."""
    img, d = _canvas()
    _line(d, 4, 80, 92, 80, 4)
    d.polygon([(8, 80), (24, 44), (40, 80)], fill=WHITE)
    d.polygon([(34, 80), (52, 36), (70, 80)], fill=WHITE)
    d.polygon([(60, 80), (76, 50), (92, 80)], fill=WHITE)
    return img


def refugee_camp():
    """Larger camp: tents + small flag."""
    img, d = _canvas()
    _line(d, 4, 80, 92, 80, 4)
    d.polygon([(6, 80), (20, 50), (34, 80)], fill=WHITE)
    d.polygon([(36, 80), (54, 42), (72, 80)], fill=WHITE)
    d.polygon([(70, 80), (84, 54), 92, 80], fill=WHITE) if False else None
    d.polygon([(70, 80), (84, 54), (92, 80)], fill=WHITE)
    # central flagpole over biggest tent
    _line(d, 54, 42, 54, 18, 3)
    d.polygon([(54, 18), (74, 24), (54, 30)], fill=WHITE)
    return img


def evacuation_point():
    """Up-arrow inside circle."""
    img, d = _canvas()
    _ring(d, 48, 48, 38, 6)
    d.polygon([(48, 24), (66, 48), (56, 48), (56, 72), (40, 72), (40, 48), (30, 48)], fill=WHITE)
    return img


def border_crossing():
    """Flag on pole with dashed ground line."""
    img, d = _canvas()
    _filled_rect(d, 22, 8, 30, 88)
    # pennant
    d.polygon([(30, 14), (78, 22), (30, 40)], fill=WHITE)
    # dashed ground
    x = 6
    while x < 92:
        _line(d, x, 82, min(x + 8, 90), 82, 4)
        x += 14
    return img


def transit_route():
    """Curved dashed path with end arrow."""
    img, d = _canvas()
    # dashed bezier-ish arc using short segments
    pts = [(8, 78), (16, 60), (28, 48), (44, 44), (60, 48), (72, 56), (82, 50)]
    for i in range(0, len(pts) - 1):
        x1, y1 = pts[i]
        x2, y2 = pts[i + 1]
        d.line([(x1, y1), (x2, y2)], fill=WHITE, width=5)
        # break it up by drawing a small transparent gap at midpoints
        mx = (x1 + x2) / 2
        my = (y1 + y2) / 2
        d.ellipse([mx - 2, my - 2, mx + 2, my + 2], fill=TRANSPARENT)
    _disc(d, 8, 78, 6)
    d.polygon([(78, 42), (92, 50), (78, 58)], fill=WHITE)
    return img


# ===== CIVILIAN =====


def school():
    """Mortarboard cap."""
    img, d = _canvas()
    d.polygon([(48, 16), (90, 38), (48, 56), (6, 38)], fill=WHITE)
    _filled_rect(d, 22, 48, 74, 68, radius=4)
    _line(d, 80, 38, 80, 60, 4)
    _disc(d, 80, 64, 4)
    return img


def hospital():
    """Building with bold medical plus."""
    img, d = _canvas()
    _stroke_rect(d, 12, 14, 84, 86, 5)
    _filled_rect(d, 40, 30, 56, 70)
    _filled_rect(d, 24, 46, 72, 54)
    return img


def religious_site():
    """Domed building with spire (universalist, no specific symbol)."""
    img, d = _canvas()
    _filled_rect(d, 12, 70, 84, 86, radius=2)
    _filled_rect(d, 20, 44, 76, 70)
    d.pieslice([20, 22, 76, 78], start=180, end=360, fill=WHITE)
    _line(d, 48, 26, 48, 12, 5)
    _disc(d, 48, 10, 4)
    return img


def market():
    """Striped awning over shopfront."""
    img, d = _canvas()
    # awning
    d.polygon([(8, 30), (88, 30), (78, 50), (18, 50)], fill=WHITE)
    # awning stripes (transparent cuts)
    for cx in (28, 40, 52, 64, 76):
        d.line([(cx, 30), (cx - 4, 50)], fill=TRANSPARENT, width=3)
    # shop body
    _stroke_rect(d, 18, 50, 78, 86, 5)
    # door
    _filled_rect(d, 40, 60, 56, 86)
    return img


def water_source():
    """Faucet + droplet — civilian water infrastructure."""
    img, d = _canvas()
    # faucet body
    _filled_rect(d, 14, 30, 60, 42)
    _filled_rect(d, 50, 18, 62, 30)
    # spout down
    _filled_rect(d, 40, 42, 50, 56)
    # droplet
    d.polygon(
        [(45, 60), (58, 76), (54, 84), (36, 84), (32, 76)],
        fill=WHITE,
    )
    return img


def power_station():
    """Cooling tower silhouette with steam puff."""
    img, d = _canvas()
    # cooling tower (hyperboloid suggestion)
    d.polygon(
        [(30, 84), (24, 50), (32, 40), (64, 40), (72, 50), (66, 84)],
        fill=WHITE,
    )
    _line(d, 4, 86, 92, 86, 4)
    # steam clouds above
    _disc(d, 36, 30, 8)
    _disc(d, 50, 22, 10)
    _disc(d, 64, 30, 8)
    return img


# ===== EVIDENCE =====


def witness():
    """Eye shape — clean almond + pupil."""
    img, d = _canvas()
    # outer almond
    d.polygon(
        [(8, 48), (24, 30), (48, 24), (72, 30), (88, 48), (72, 66), (48, 72), (24, 66)],
        outline=WHITE, width=5,
    )
    # pupil
    _disc(d, 48, 48, 11)
    # highlight cut
    d.ellipse([42, 40, 48, 46], fill=TRANSPARENT)
    return img


def photo_video():
    """Film/photo camera with lens — evidence capture."""
    img, d = _canvas()
    # body
    _stroke_rect(d, 6, 30, 70, 72, 5, radius=4)
    # viewfinder bump
    _filled_rect(d, 28, 22, 50, 30, radius=2)
    # lens (filled disc with transparent inner)
    _disc(d, 38, 50, 14)
    d.ellipse([32, 44, 44, 56], fill=TRANSPARENT)
    # film lens / projector cone
    d.polygon([(70, 36), (92, 26), (92, 76), (70, 66)], fill=WHITE)
    return img


def satellite_confirmed():
    """Satellite outline with downward check / signal lines."""
    img, d = _canvas()
    # central body
    _filled_rect(d, 38, 32, 58, 52, radius=2)
    # solar panels
    _filled_rect(d, 8, 36, 32, 48)
    _filled_rect(d, 64, 36, 88, 48)
    for x in (16, 24, 72, 80):
        _line(d, x, 36, x, 48, 2)
    # antenna
    _line(d, 48, 32, 48, 16, 4)
    d.pieslice([34, 4, 62, 30], start=200, end=340, fill=WHITE)
    # check below
    d.line([(28, 70), (44, 84), (72, 60)], fill=WHITE, width=7)
    return img


def suspected():
    """Dashed circle around question mark."""
    img, d = _canvas()
    # dashed ring
    cx, cy, r = 48, 48, 38
    steps = 28
    for i in range(steps):
        if i % 2 == 0:
            a1 = i / steps * 2 * math.pi
            a2 = (i + 1) / steps * 2 * math.pi
            d.arc(
                [cx - r, cy - r, cx + r, cy + r],
                start=math.degrees(a1),
                end=math.degrees(a2),
                fill=WHITE,
                width=5,
            )
    # question mark
    d.arc([34, 18, 62, 50], start=180, end=360, fill=WHITE, width=7)
    _line(d, 48, 50, 48, 62, 7)
    _disc(d, 48, 72, 4)
    return img


def incident_marker():
    """Map pin — neutral location glyph, the default of the palette."""
    img, d = _canvas()
    # teardrop pin
    d.polygon(
        [
            (48, 8),
            (76, 32),
            (74, 50),
            (60, 68),
            (48, 86),
            (36, 68),
            (22, 50),
            (20, 32),
        ],
        fill=WHITE,
    )
    # inner hole
    d.ellipse([38, 24, 58, 44], fill=TRANSPARENT)
    return img


# ===== REGISTRY =====


ICONS: list[tuple[str, callable]] = [
    # Detention
    ("detention-facility", detention_facility),
    ("prison", prison),
    ("secret-detention", secret_detention),
    ("holding-cell", holding_cell),
    ("interrogation-site", interrogation_site),
    # Mortality
    ("mass-grave", mass_grave),
    ("individual-grave", individual_grave),
    ("body-recovery", body_recovery),
    ("mortuary", mortuary),
    ("cemetery", cemetery),
    # Destruction
    ("destroyed-building", destroyed_building),
    ("damaged-infra", damaged_infra),
    ("burnt-structure", burnt_structure),
    ("shelled-site", shelled_site),
    ("demolished", demolished),
    # Military
    ("military-base", military_base),
    ("checkpoint", checkpoint),
    ("weapons-cache", weapons_cache),
    ("artillery", artillery),
    ("blast-crater", blast_crater),
    ("munitions", munitions),
    # Displacement
    ("idp-camp", idp_camp),
    ("refugee-camp", refugee_camp),
    ("evacuation-point", evacuation_point),
    ("border-crossing", border_crossing),
    ("transit-route", transit_route),
    # Civilian
    ("school", school),
    ("hospital", hospital),
    ("religious-site", religious_site),
    ("market", market),
    ("water-source", water_source),
    ("power-station", power_station),
    # Evidence
    ("witness", witness),
    ("photo-video", photo_video),
    ("satellite-confirmed", satellite_confirmed),
    ("suspected", suspected),
    ("incident-marker", incident_marker),
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
