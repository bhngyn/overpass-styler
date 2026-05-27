#!/usr/bin/env python3
"""Build Mali_styled.kmz from Mali-backup.kmz.

Run with the project's backend venv (lxml + Pillow + pyshp installed):
    backend/.venv/bin/python scripts/build_mali_styled.py
"""
from __future__ import annotations

import io
import math
import re
import sys
import urllib.request
import zipfile
from collections import Counter, defaultdict
from datetime import datetime
from html import escape as html_escape
from pathlib import Path
from xml.sax.saxutils import escape as xml_escape

from PIL import Image, ImageDraw, ImageFont
from lxml import etree

REPO = Path(__file__).resolve().parents[1]
SRC = REPO / "Mali-backup.kmz"
OUT = REPO / "Mali_styled.kmz"
NE_CACHE = REPO / ".cache" / "ne_10m_admin_1_states_provinces.zip"

KML_NS = "http://www.opengis.net/kml/2.2"
GX_NS = "http://www.google.com/kml/ext/2.2"
NSMAP = {None: KML_NS, "gx": GX_NS}
K = lambda tag: f"{{{KML_NS}}}{tag}"
GX = lambda tag: f"{{{GX_NS}}}{tag}"


# ──────────────────────────────────────────────────────────────────────────────
# Perpetrator + event-type encodings
# ──────────────────────────────────────────────────────────────────────────────

# Color hierarchy carries the moral framing: this is a Wagner-investigation map.
# Tier 1 (Wagner-involved) is the headline; the other tiers contextualize.
# Granular actor distinction (JNIM vs IS vs separatist vs militia) lives in the balloon,
# not on the icon — 9 colors is noise, 4 is signal.
PERP_COLORS = {
    "wagner":   ("8b0a1a", "Wagner-involved (actor1 or assoc.)"),
    "fama":     ("e85a4f", "FAMa alone (no Wagner present)"),
    "jihadist": ("1b5e20", "Jihadist groups (JNIM, IS)"),
    "other":    ("616161", "Other armed actors"),
}
PERP_ORDER = ["wagner", "fama", "jihadist", "other"]

# Six verbs an investigator actually uses, not sixteen icons no one memorizes.
GLYPHS = {
    "kill":    "Killing (attack, armed clash, sexual violence)",
    "bomb":    "Bombing (IED, shelling, airstrike)",
    "capture": "Capture (arrest, abduction)",
    "destroy": "Destruction (looting, property destruction)",
    "base":    "Base / HQ established",
    "dot":     "Other strategic development / protest",
    # manual-layer glyphs (not shown in ACLED legend)
    "shield":       "FAMa base",
    "shield_w":     "FAMa + Wagner co-located",
    "shield_half":  "Checkpoint",
    "shield_arrow": "Former MINUSMA handover",
    "pickaxe":      "Artisanal gold mine",
    "factory":      "Industrial gold mine",
    "drum":         "Gold refinery",
}


def classify_perpetrator(actor1: str, assoc1: str) -> str:
    """4-tier moral hierarchy. Wagner involvement (anywhere) is the headline."""
    a1 = actor1 or ""
    aa = assoc1 or ""
    if "Wagner" in a1 or "Wagner" in aa:
        return "wagner"
    if "Military Forces of Mali" in a1 or "Police Forces of Mali" in a1:
        return "fama"
    if "JNIM" in a1 or "Islamic State" in a1:
        return "jihadist"
    return "other"


def classify_glyph(event_type: str, sub_event: str) -> str:
    """6 buckets, mapped to verbs the investigator thinks in."""
    et = event_type or ""
    sub = sub_event or ""
    if et == "Explosions/Remote violence":
        return "bomb"
    if et == "Battles":
        return "kill"  # armed clash → still killing
    if et == "Violence against civilians":
        if "Abduction" in sub or "disappearance" in sub:
            return "capture"
        return "kill"
    if et == "Strategic developments":
        if "Arrests" in sub:
            return "capture"
        if "Looting" in sub:
            return "destroy"
        if "Headquarters" in sub or "base" in sub.lower():
            return "base"
        return "dot"
    return "dot"


def fatality_scale(fatalities: int) -> float:
    """Icon scale by fatality count.

    With 1083 markers on the map at country zoom, individual icons cannot be large
    or they overlap into a wall of red. Range 0.35 → 1.0 — the 100+ outlier reads as
    a clearly larger marker; zero-fatality strategic events stay readable but compact.
    """
    if fatalities <= 0:
        return 0.35
    s = 0.35 + 0.16 * math.log2(fatalities + 1)
    return max(0.35, min(1.0, s))


# ──────────────────────────────────────────────────────────────────────────────
# Icon rendering — Pillow
# ──────────────────────────────────────────────────────────────────────────────

SUPER = 256          # supersampled canvas
FINAL = 64           # final PNG size
WHITE = (255, 255, 255, 255)

def _blank() -> Image.Image:
    return Image.new("RGBA", (SUPER, SUPER), (0, 0, 0, 0))

def _finalize(img: Image.Image) -> Image.Image:
    return img.resize((FINAL, FINAL), Image.LANCZOS)

def draw_kill() -> Image.Image:
    """Skull-on-target — for any killing event (attack, armed clash, sexual violence).

    A solid disc anchors the icon visually; a cross-and-circle overlay reads as
    crosshairs / target, communicating violent intent without literal gore.
    """
    img = _blank()
    d = ImageDraw.Draw(img)
    cx = cy = SUPER // 2
    r = SUPER * 0.34
    # solid disc base
    d.ellipse((cx-r, cy-r, cx+r, cy+r), fill=WHITE)
    # cut out a darker concentric ring then a smaller disc, so the icon reads as a target
    rr = SUPER * 0.22
    d.ellipse((cx-rr, cy-rr, cx+rr, cy+rr), fill=(0, 0, 0, 0))
    rrr = SUPER * 0.10
    d.ellipse((cx-rrr, cy-rrr, cx+rrr, cy+rrr), fill=WHITE)
    # crosshair arms
    w = int(SUPER * 0.05)
    arm_out = SUPER * 0.46
    arm_in  = SUPER * 0.36
    for dx, dy in [(1,0),(-1,0),(0,1),(0,-1)]:
        d.line((cx + dx*arm_in, cy + dy*arm_in, cx + dx*arm_out, cy + dy*arm_out),
               fill=WHITE, width=w)
    return _finalize(img)


def draw_bomb() -> Image.Image:
    """Asymmetric burst — for IED, shelling, airstrike.

    Irregular star rays read as 'explosion' more clearly than a regular star.
    """
    img = _blank()
    d = ImageDraw.Draw(img)
    cx = cy = SUPER // 2
    # 8 rays with alternating long/short, jittered for irregularity
    n = 8
    radii_out = [0.46, 0.40, 0.48, 0.38, 0.46, 0.42, 0.48, 0.40]
    r_in = SUPER * 0.16
    pts = []
    for i in range(n * 2):
        ang = math.pi * i / n - math.pi / 2
        r = SUPER * radii_out[i // 2] if i % 2 == 0 else r_in
        pts.append((cx + r * math.cos(ang), cy + r * math.sin(ang)))
    d.polygon(pts, fill=WHITE)
    # core
    cr = SUPER * 0.08
    d.ellipse((cx-cr, cy-cr, cx+cr, cy+cr), fill=(0, 0, 0, 0))
    return _finalize(img)


def draw_capture() -> Image.Image:
    """Handcuffs — for arrests and abductions/disappearances.

    Two open circles linked by a bar. Universally read.
    """
    img = _blank()
    d = ImageDraw.Draw(img)
    cx = cy = SUPER // 2
    r = SUPER * 0.20
    w = int(SUPER * 0.08)
    # two rings
    d.ellipse((cx - SUPER*0.50, cy-r, cx - SUPER*0.10, cy+r), outline=WHITE, width=w)
    d.ellipse((cx + SUPER*0.10, cy-r, cx + SUPER*0.50, cy+r), outline=WHITE, width=w)
    # link
    bar_w = int(SUPER * 0.10)
    d.rectangle((cx - SUPER*0.10, cy - bar_w/2, cx + SUPER*0.10, cy + bar_w/2), fill=WHITE)
    return _finalize(img)


def draw_destroy() -> Image.Image:
    """Flame — for looting / property destruction.

    Asymmetric teardrop shape, lapped over itself to suggest fire.
    """
    img = _blank()
    d = ImageDraw.Draw(img)
    cx = SUPER // 2
    # outer flame
    pts = [
        (cx, SUPER*0.08),
        (cx + SUPER*0.10, SUPER*0.28),
        (cx + SUPER*0.26, SUPER*0.44),
        (cx + SUPER*0.32, SUPER*0.66),
        (cx + SUPER*0.22, SUPER*0.86),
        (cx,              SUPER*0.94),
        (cx - SUPER*0.22, SUPER*0.86),
        (cx - SUPER*0.32, SUPER*0.66),
        (cx - SUPER*0.26, SUPER*0.44),
        (cx - SUPER*0.10, SUPER*0.28),
    ]
    d.polygon(pts, fill=WHITE)
    # inner flame cutout (darker core implied by transparency)
    inner = [
        (cx, SUPER*0.36),
        (cx + SUPER*0.10, SUPER*0.50),
        (cx + SUPER*0.15, SUPER*0.66),
        (cx + SUPER*0.08, SUPER*0.80),
        (cx,              SUPER*0.84),
        (cx - SUPER*0.08, SUPER*0.80),
        (cx - SUPER*0.15, SUPER*0.66),
        (cx - SUPER*0.10, SUPER*0.50),
    ]
    d.polygon(inner, fill=(0, 0, 0, 0))
    return _finalize(img)

def _shield_path(scale: float = 1.0) -> list[tuple[float, float]]:
    cx = SUPER // 2
    top = SUPER * 0.12
    bot = SUPER * 0.92
    half = SUPER * 0.30 * scale
    shoulder = SUPER * 0.30
    return [
        (cx, top),
        (cx + half, top + (shoulder - top)),
        (cx + half, SUPER * 0.55),
        (cx,        bot),
        (cx - half, SUPER * 0.55),
        (cx - half, top + (shoulder - top)),
    ]

def draw_shield() -> Image.Image:
    img = _blank()
    d = ImageDraw.Draw(img)
    pts = _shield_path()
    d.polygon(pts, fill=WHITE)
    # cut out inner shield to make it a thick outline
    inner = _shield_path(0.78)
    inner = [(p[0], p[1]*0.97 + SUPER*0.04) for p in inner]  # nudge down slightly
    d.polygon(inner, fill=(0,0,0,0))
    return _finalize(img)

def draw_shield_w() -> Image.Image:
    """Shield with bold 'W' for Wagner co-located."""
    img = _blank()
    d = ImageDraw.Draw(img)
    pts = _shield_path()
    d.polygon(pts, fill=WHITE)
    # carve 'W' shape inside
    cx = SUPER // 2
    top_y = SUPER * 0.35
    bot_y = SUPER * 0.72
    w_w = SUPER * 0.32
    lw = int(SUPER * 0.07)
    p1 = (cx - w_w, top_y)
    p2 = (cx - w_w * 0.5, bot_y)
    p3 = (cx, top_y + (bot_y - top_y) * 0.55)
    p4 = (cx + w_w * 0.5, bot_y)
    p5 = (cx + w_w, top_y)
    # draw W as cut-outs (transparent strokes) on the shield
    for a, b in [(p1, p2), (p2, p3), (p3, p4), (p4, p5)]:
        d.line([a, b], fill=(0,0,0,0), width=lw)
    return _finalize(img)

def draw_shield_half() -> Image.Image:
    """Shield with horizontal bar (checkpoint barrier)."""
    img = _blank()
    d = ImageDraw.Draw(img)
    pts = _shield_path()
    d.polygon(pts, fill=WHITE)
    inner = _shield_path(0.78)
    inner = [(p[0], p[1]*0.97 + SUPER*0.04) for p in inner]
    d.polygon(inner, fill=(0,0,0,0))
    # red/white striped bar
    bar_y = SUPER * 0.55
    bar_h = SUPER * 0.10
    d.rectangle((SUPER*0.20, bar_y-bar_h/2, SUPER*0.80, bar_y+bar_h/2), fill=WHITE)
    return _finalize(img)

def draw_shield_arrow() -> Image.Image:
    """Shield with curved arrow (handover)."""
    img = _blank()
    d = ImageDraw.Draw(img)
    pts = _shield_path()
    d.polygon(pts, fill=WHITE)
    inner = _shield_path(0.78)
    inner = [(p[0], p[1]*0.97 + SUPER*0.04) for p in inner]
    d.polygon(inner, fill=(0,0,0,0))
    # circular arrow inside
    cx, cy = SUPER // 2, int(SUPER * 0.55)
    r = SUPER * 0.16
    w = int(SUPER * 0.05)
    d.arc((cx-r, cy-r, cx+r, cy+r), start=20, end=320, fill=WHITE, width=w)
    # arrowhead at end
    a = math.radians(320)
    ax, ay = cx + r*math.cos(a), cy + r*math.sin(a)
    head = SUPER * 0.05
    d.polygon([(ax-head, ay), (ax+head, ay-head), (ax+head, ay+head)], fill=WHITE)
    return _finalize(img)

def draw_dot() -> Image.Image:
    """Simple solid disc — for low-stakes strategic developments (the fall-through)."""
    img = _blank()
    d = ImageDraw.Draw(img)
    cx = cy = SUPER // 2
    r = SUPER * 0.26
    d.ellipse((cx-r, cy-r, cx+r, cy+r), fill=WHITE)
    return _finalize(img)


def draw_base() -> Image.Image:
    """Used as the in-ACLED 'base established' glyph — simple shield outline."""
    img = _blank()
    d = ImageDraw.Draw(img)
    pts = _shield_path()
    d.polygon(pts, fill=WHITE)
    inner = _shield_path(0.74)
    inner = [(p[0], p[1]*0.96 + SUPER*0.04) for p in inner]
    d.polygon(inner, fill=(0,0,0,0))
    return _finalize(img)

def draw_pickaxe() -> Image.Image:
    img = _blank()
    d = ImageDraw.Draw(img)
    cx = cy = SUPER // 2
    # crescent head
    d.arc((SUPER*0.08, SUPER*0.10, SUPER*0.92, SUPER*0.55), start=200, end=340, fill=WHITE, width=int(SUPER*0.10))
    # handle
    d.line((SUPER*0.30, SUPER*0.55, SUPER*0.85, SUPER*0.95), fill=WHITE, width=int(SUPER*0.10))
    return _finalize(img)

def draw_factory() -> Image.Image:
    img = _blank()
    d = ImageDraw.Draw(img)
    base_y = SUPER * 0.80
    # main building
    d.rectangle((SUPER*0.10, SUPER*0.40, SUPER*0.92, base_y), fill=WHITE)
    # roof saw-tooth
    saw = [(SUPER*0.10, SUPER*0.40)]
    for i in range(4):
        x0 = SUPER*0.10 + i*SUPER*0.205
        saw.append((x0 + SUPER*0.10, SUPER*0.25))
        saw.append((x0 + SUPER*0.205, SUPER*0.40))
    d.polygon(saw, fill=WHITE)
    # chimney
    d.rectangle((SUPER*0.18, SUPER*0.15, SUPER*0.28, SUPER*0.40), fill=WHITE)
    return _finalize(img)

def draw_drum() -> Image.Image:
    img = _blank()
    d = ImageDraw.Draw(img)
    # drum body
    d.rectangle((SUPER*0.30, SUPER*0.40, SUPER*0.78, SUPER*0.92), fill=WHITE)
    # top ellipse
    d.ellipse((SUPER*0.30, SUPER*0.34, SUPER*0.78, SUPER*0.48), fill=WHITE)
    # cut a dark line for the drum band
    d.line((SUPER*0.30, SUPER*0.65, SUPER*0.78, SUPER*0.65), fill=(0,0,0,0), width=int(SUPER*0.04))
    # flame on top
    pts = [
        (SUPER*0.54, SUPER*0.10),
        (SUPER*0.62, SUPER*0.20),
        (SUPER*0.66, SUPER*0.32),
        (SUPER*0.50, SUPER*0.38),
        (SUPER*0.42, SUPER*0.30),
        (SUPER*0.48, SUPER*0.20),
    ]
    d.polygon(pts, fill=WHITE)
    return _finalize(img)

# ACLED glyphs (six). Manual-layer glyphs (shield variants, mining) listed separately
# because they don't need to be rendered in every perpetrator color.
ACLED_GLYPH_DRAWERS = {
    "kill":    draw_kill,
    "bomb":    draw_bomb,
    "capture": draw_capture,
    "destroy": draw_destroy,
    "base":    draw_base,
    "dot":     draw_dot,
}

MANUAL_GLYPH_DRAWERS = {
    "shield":       draw_shield,
    "shield_w":     draw_shield_w,
    "shield_half":  draw_shield_half,
    "shield_arrow": draw_shield_arrow,
    "pickaxe":      draw_pickaxe,
    "factory":      draw_factory,
    "drum":         draw_drum,
}

GLYPH_DRAWERS = {**ACLED_GLYPH_DRAWERS, **MANUAL_GLYPH_DRAWERS}


def tint(img: Image.Image, hex_rgb: str) -> Image.Image:
    """Replace the white glyph with the given color, keeping alpha."""
    r = int(hex_rgb[0:2], 16); g = int(hex_rgb[2:4], 16); b = int(hex_rgb[4:6], 16)
    color_layer = Image.new("RGBA", img.size, (r, g, b, 255))
    color_layer.putalpha(img.split()[-1])
    return color_layer


def add_civtarget_halo(white_glyph: Image.Image, tinted: Image.Image) -> Image.Image:
    """Civilian-targeting = bright white halo behind the colored glyph.

    Strategy: dilate the white glyph mask at SUPER resolution (where 12-15 pixels
    of dilation reads as a 3-4 pixel halo at the final 64×64), paste it white
    behind the tinted glyph. The result is the colored icon ringed by a bright
    white silhouette that pops on every basemap and against every perpetrator
    color. Half the events glow.
    """
    from PIL import ImageFilter
    # Re-render the glyph at SUPER res for a high-quality dilation, then downscale.
    super_glyph = white_glyph.resize((SUPER, SUPER), Image.LANCZOS)
    alpha_big = super_glyph.split()[-1]
    # dilate by ~28 pixels at SUPER res → ~7 pixels of halo at FINAL res
    dilated = alpha_big.filter(ImageFilter.MaxFilter(29))
    # soften the edge so the halo has a slight glow rather than a hard line
    dilated = dilated.filter(ImageFilter.GaussianBlur(radius=4))
    halo_big = Image.new("RGBA", (SUPER, SUPER), (255, 255, 255, 255))
    halo_big.putalpha(dilated)
    halo = halo_big.resize(tinted.size, Image.LANCZOS)
    out = Image.new("RGBA", tinted.size, (0, 0, 0, 0))
    out.alpha_composite(halo)
    out.alpha_composite(tinted)
    return out


def png_bytes(img: Image.Image) -> bytes:
    buf = io.BytesIO()
    img.save(buf, format="PNG", optimize=True)
    return buf.getvalue()


def build_icon_library() -> tuple[dict[str, bytes], dict[str, Image.Image]]:
    """Render every (glyph, perp, civ?) combo we need. Return (filename→PNG bytes, base_glyphs)."""
    icons: dict[str, bytes] = {}
    base_glyphs = {name: drawer() for name, drawer in GLYPH_DRAWERS.items()}
    # ACLED glyphs × 4 perpetrators × 2 (with/without civ halo) = 48 PNGs
    for glyph_name in ACLED_GLYPH_DRAWERS:
        glyph_img = base_glyphs[glyph_name]
        for perp_key in PERP_ORDER:
            hex_rgb, _ = PERP_COLORS[perp_key]
            tinted = tint(glyph_img, hex_rgb)
            icons[f"icons/{glyph_name}_{perp_key}.png"] = png_bytes(tinted)
            haloed = add_civtarget_halo(glyph_img, tinted)
            icons[f"icons/{glyph_name}_{perp_key}_civ.png"] = png_bytes(haloed)
    # Manual glyphs: only the colors they're actually used in.
    # See MANUAL_TINTS below for the mapping.
    return icons, base_glyphs


# Manual-layer color palette — keyed by glyph name.
# Distinct from PERP_COLORS because mining/refining isn't a perpetrator dimension.
MANUAL_TINTS = {
    "shield":       ("e85a4f", "FAMa base"),
    "shield_w":     ("8b0a1a", "FAMa + Wagner co-located"),
    "shield_half":  ("e85a4f", "Checkpoint"),
    "shield_arrow": ("9e9e9e", "Former MINUSMA handover"),
    "pickaxe":      ("d4af37", "Artisanal gold mine"),       # gold
    "factory":      ("6b4423", "Industrial gold mine"),      # brown
    "drum":         ("d4af37", "Gold refinery"),             # gold
}


def add_manual_icons(icons: dict[str, bytes], base_glyphs: dict[str, Image.Image]) -> None:
    """Render the manual-layer icons (one tint each)."""
    for glyph, (hex_rgb, _) in MANUAL_TINTS.items():
        tinted = tint(base_glyphs[glyph], hex_rgb)
        icons[f"icons/{glyph}.png"] = png_bytes(tinted)


# ──────────────────────────────────────────────────────────────────────────────
# Legend PNG (ScreenOverlay)
# ──────────────────────────────────────────────────────────────────────────────

def build_legend_png(base_glyphs: dict[str, Image.Image]) -> bytes:
    """Legend, pinned bottom-left. Reads top→bottom: title, color hierarchy,
    shape vocabulary, civ-targeting halo, size scale, footer."""
    W, H = 340, 540
    bg = Image.new("RGBA", (W, H), (18, 18, 20, 235))
    d = ImageDraw.Draw(bg)
    try:
        font_h  = ImageFont.truetype("/System/Library/Fonts/Helvetica.ttc", 17)
        font_b  = ImageFont.truetype("/System/Library/Fonts/Helvetica.ttc", 13)
        font_sm = ImageFont.truetype("/System/Library/Fonts/Helvetica.ttc", 11)
    except Exception:
        font_h = font_b = font_sm = ImageFont.load_default()

    LIGHT  = (235, 235, 235, 255)
    MID    = (190, 190, 190, 255)
    DIM    = (140, 140, 140, 255)
    HEADER = (170, 170, 175, 255)

    y = 12
    d.text((14, y), "Mali — FAMa / Wagner activity", fill=LIGHT, font=font_h); y += 26
    d.text((14, y), "Color = WHO   ·   Shape = WHAT   ·   Size = fatalities",
           fill=DIM, font=font_sm); y += 22

    # 4-tier perpetrator colors
    d.text((14, y), "PERPETRATOR", fill=HEADER, font=font_sm); y += 18
    sw = 20
    for key in PERP_ORDER:
        hex_rgb, label = PERP_COLORS[key]
        r, g, b = int(hex_rgb[0:2],16), int(hex_rgb[2:4],16), int(hex_rgb[4:6],16)
        d.rounded_rectangle((20, y, 20+sw, y+sw), radius=3, fill=(r, g, b, 255))
        d.text((50, y+2), label, fill=LIGHT, font=font_b)
        y += 24
    y += 6

    # 6 ACLED glyphs
    d.text((14, y), "EVENT TYPE", fill=HEADER, font=font_sm); y += 18
    for gname in ["kill", "bomb", "capture", "destroy", "base", "dot"]:
        glyph = base_glyphs[gname]
        small = glyph.resize((28, 28), Image.LANCZOS)
        recolored = tint(small, "d0d0d0")
        bg.alpha_composite(recolored, (16, y-4))
        d.text((52, y+2), GLYPHS[gname], fill=LIGHT, font=font_b)
        y += 26
    y += 4

    # civ-targeting halo example
    d.text((14, y), "CIVILIAN TARGETING", fill=HEADER, font=font_sm); y += 18
    # Show two versions side by side: regular and haloed
    base_kill = base_glyphs["kill"]
    tinted_red = tint(base_kill, "8b0a1a")
    plain = tinted_red.resize((36, 36), Image.LANCZOS)
    haloed = add_civtarget_halo(base_kill, tinted_red).resize((36, 36), Image.LANCZOS)
    bg.alpha_composite(plain, (20, y))
    bg.alpha_composite(haloed, (70, y))
    d.text((118, y+10), "White halo = civilians targeted", fill=LIGHT, font=font_b)
    y += 46

    # size scale (matches the new 0.35-1.0 fatality_scale range)
    d.text((14, y), "SIZE", fill=HEADER, font=font_sm); y += 18
    sample = base_glyphs["kill"]
    sample_tinted = tint(sample, "8b0a1a")
    sizes = [(16, "0"), (22, "1"), (32, "10"), (44, "30+")]
    x = 20
    for sz, label in sizes:
        s = sample_tinted.resize((sz, sz), Image.LANCZOS)
        bg.alpha_composite(s, (x, y + (44-sz)//2))
        d.text((x + sz//2 - 6, y + 46), label, fill=MID, font=font_sm)
        x += sz + 14
    y += 72

    # footer
    d.text((14, H-26), "Source: ACLED (2021-01-01 → 2024-01-16) + OSINT base placements",
           fill=DIM, font=font_sm)

    return png_bytes(bg)


def build_timeline_png(acled_records: list[dict]) -> bytes:
    """Sparkline of monthly event counts pinned at the top of the viewport.

    Shows the temporal story at a glance: 2 events in 2021, then 276 in 2022, then
    773 in 2023. The conflict-exploded-in-2023 pattern is invisible from the time
    slider alone — you have to scrub. This makes it the first thing you see.
    """
    # bin by year-month
    counts: dict[tuple[int,int], int] = Counter()
    civ_counts: dict[tuple[int,int], int] = Counter()
    for rec in acled_records:
        iso = to_iso_date(rec["fields"].get("event_date",""))
        if not iso: continue
        y, m, _ = iso.split("-")
        key = (int(y), int(m))
        counts[key] += 1
        if rec["fields"].get("civilian_targeting","").strip() == "Civilian targeting":
            civ_counts[key] += 1
    if not counts:
        return b""
    months = sorted(counts.keys())
    first = months[0]; last = months[-1]
    # fill gaps
    seq: list[tuple[int,int]] = []
    y, m = first
    while (y, m) <= last:
        seq.append((y, m))
        m += 1
        if m > 12:
            m = 1; y += 1

    W = 720
    H = 110
    bg = Image.new("RGBA", (W, H), (18, 18, 20, 230))
    d = ImageDraw.Draw(bg)
    try:
        font_t  = ImageFont.truetype("/System/Library/Fonts/Helvetica.ttc", 12)
        font_sm = ImageFont.truetype("/System/Library/Fonts/Helvetica.ttc", 10)
    except Exception:
        font_t = font_sm = ImageFont.load_default()

    pad_l, pad_r, pad_t, pad_b = 14, 14, 26, 22
    chart_w = W - pad_l - pad_r
    chart_h = H - pad_t - pad_b
    n = len(seq)
    bar_w = chart_w / n
    max_c = max(counts.values())

    d.text((pad_l, 6), f"Monthly ACLED events  ·  {sum(counts.values())} total  ·  {max_c} peak month",
           fill=(220, 220, 220, 255), font=font_t)

    # axis baseline
    base_y = H - pad_b
    d.line((pad_l, base_y, W - pad_r, base_y), fill=(80, 80, 85, 255), width=1)

    # bars: total in muted grey, civilian-targeting overlaid in bright red
    for i, key in enumerate(seq):
        x0 = pad_l + i * bar_w
        x1 = x0 + max(1, bar_w - 1.5)
        c = counts.get(key, 0)
        civ = civ_counts.get(key, 0)
        h_tot = (c / max_c) * chart_h
        h_civ = (civ / max_c) * chart_h
        d.rectangle((x0, base_y - h_tot, x1, base_y), fill=(160, 160, 165, 255))
        if h_civ > 0:
            d.rectangle((x0, base_y - h_civ, x1, base_y), fill=(220, 30, 40, 255))

    # year tick labels
    last_year = None
    for i, (yr, mo) in enumerate(seq):
        if yr != last_year and mo <= 2:
            x = pad_l + i * bar_w
            d.line((x, base_y, x, base_y + 4), fill=(120, 120, 125, 255), width=1)
            d.text((x + 2, base_y + 4), str(yr), fill=(180, 180, 180, 255), font=font_sm)
            last_year = yr

    # legend strip on the right
    d.rectangle((W - 130, 6, W - 122, 14), fill=(160, 160, 165, 255))
    d.text((W - 118, 4), "all events", fill=(200, 200, 200, 255), font=font_sm)
    d.rectangle((W - 130, 16, W - 122, 24), fill=(220, 30, 40, 255))
    d.text((W - 118, 14), "civilians targeted", fill=(200, 200, 200, 255), font=font_sm)

    return png_bytes(bg)


# ──────────────────────────────────────────────────────────────────────────────
# Parse source KMZ
# ──────────────────────────────────────────────────────────────────────────────

JORDAN_LAT_BAND = (28, 34)
JORDAN_LON_BAND = (34, 40)

def is_jordan_stray(lon: float, lat: float) -> bool:
    return (JORDAN_LON_BAND[0] <= lon <= JORDAN_LON_BAND[1]
            and JORDAN_LAT_BAND[0] <= lat <= JORDAN_LAT_BAND[1])


def parse_source(src_path: Path):
    with zipfile.ZipFile(src_path, "r") as z:
        with z.open("doc.kml") as f:
            tree = etree.parse(f)
        preserved_files = {n: z.read(n) for n in z.namelist() if n != "doc.kml"}
    return tree, preserved_files


def text_of(el, tag, default=""):
    found = el.find(K(tag))
    return found.text if found is not None and found.text else default


def extract_acled(root) -> list[dict]:
    """Return one dict per ACLED placemark with everything we need."""
    placemarks = root.iter(K("Placemark"))
    out: list[dict] = []
    for pm in placemarks:
        sd = pm.find(f".//{K('ExtendedData')}/{K('SchemaData')}")
        if sd is None:
            continue
        fields: dict[str, str] = {}
        for f in sd.findall(K("SimpleData")):
            fields[f.get("name")] = f.text or ""
        coord_el = pm.find(f".//{K('Point')}/{K('coordinates')}")
        if coord_el is None:
            continue
        coords = coord_el.text.strip().split(",")
        lon, lat = float(coords[0]), float(coords[1])
        out.append({
            "kind": "acled",
            "lon": lon, "lat": lat,
            "fields": fields,
        })
    return out


def extract_manual(root) -> dict:
    """Pull out FAMA bases, Attacks, Gold Mines, GroundOverlay, polygons."""
    res = {"fama_points": [], "fama_polygon": None, "attacks": [],
           "gold": {"Artisanal Mining Sites": [], "Industrial mines": [], "Refineries": []},
           "ground_overlay": None}

    # Find folders by name path inside <Folder><name>Mali</name>...
    for folder in root.iter(K("Folder")):
        name = text_of(folder, "name")
        if name == "FAMA bases":
            for child in folder:
                if child.tag == K("Placemark"):
                    pm_name = text_of(child, "name")
                    pm_desc = text_of(child, "description")
                    point = child.find(K("Point"))
                    poly = child.find(K("Polygon"))
                    if point is not None:
                        c = point.find(K("coordinates")).text.strip().split(",")
                        res["fama_points"].append({
                            "name": pm_name, "description": pm_desc,
                            "lon": float(c[0]), "lat": float(c[1]),
                        })
                    elif poly is not None:
                        # Bamba polygon
                        ring = poly.find(f".//{K('outerBoundaryIs')}/{K('LinearRing')}/{K('coordinates')}")
                        res["fama_polygon"] = {
                            "name": pm_name,
                            "coords": ring.text.strip(),
                        }
                elif child.tag == K("GroundOverlay"):
                    icon = child.find(K("Icon"))
                    href = icon.find(K("href")).text
                    box = child.find(K("LatLonBox"))
                    res["ground_overlay"] = {
                        "name": text_of(child, "name"),
                        "href": href,
                        "north": text_of(box, "north"),
                        "south": text_of(box, "south"),
                        "east":  text_of(box, "east"),
                        "west":  text_of(box, "west"),
                        "rotation": text_of(box, "rotation"),
                    }
        elif name == "Attacks":
            for pm in folder.findall(K("Placemark")):
                point = pm.find(K("Point"))
                if point is None: continue
                c = point.find(K("coordinates")).text.strip().split(",")
                res["attacks"].append({"name": text_of(pm, "name"),
                                       "lon": float(c[0]), "lat": float(c[1])})
        elif name in res["gold"]:
            for pm in folder.findall(K("Placemark")):
                point = pm.find(K("Point"))
                if point is None: continue
                c = point.find(K("coordinates")).text.strip().split(",")
                res["gold"][name].append({"name": text_of(pm, "name"),
                                          "lon": float(c[0]), "lat": float(c[1])})
    return res


# ──────────────────────────────────────────────────────────────────────────────
# Base classification (FAMa vs FAMa+Wagner vs MINUSMA handover vs checkpoint)
# ──────────────────────────────────────────────────────────────────────────────

WAGNER_BASE_HINTS = {
    "Bamako Airport Wagner base", "Sevare Wagner base", "Gao base", "Menaka Base",
    "Tessit base", "Tessalit airbase", "Goundam military base", "Mourdiah base",
    "Douentza base", "Sokolo Camp", "Ber base", "Niono base", "Bamba base",
}
MINUSMA_HINTS = {"Kidal - Former MINUSMA", "Timbuktu - former MINUSMA"}
CHECKPOINT_HINTS = {"Macina checkpoint", "Thy RN6 Checkpoint", "Kouremale"}

def classify_base(name: str) -> str:
    if name in MINUSMA_HINTS:
        return "minusma"
    if name in CHECKPOINT_HINTS:
        return "checkpoint"
    if "Wagner" in name or name in WAGNER_BASE_HINTS:
        return "fama_wagner"
    return "fama"


# ──────────────────────────────────────────────────────────────────────────────
# Balloon HTML for ACLED events
# ──────────────────────────────────────────────────────────────────────────────

PERP_HEX_TO_LABEL = {key: lbl for key, (_, lbl) in PERP_COLORS.items()}


def _linkify(s: str) -> str:
    """Turn URLs in plain text into clickable HTML anchors. Escapes the rest."""
    if not s:
        return ""
    urls = re.findall(r'https?://\S+', s)
    result = html_escape(s)
    for u in urls:
        result = result.replace(html_escape(u),
            f'<a href="{html_escape(u)}" style="color:#7aa7ff;">{html_escape(u)}</a>')
    return result


def _card_open(border_color: str, kicker: str, title: str) -> str:
    """Common dark-themed balloon-card opening. Uses tables for Earth Pro
    compatibility — older Earth Pro WebKit doesn't reliably render div+padding."""
    return (
        f'<table cellpadding="0" cellspacing="0" border="0" width="380" '
        f'style="font-family:Helvetica,Arial,sans-serif;background:#1a1a1a;color:#e0e0e0;">'
        f'<tr>'
        f'<td width="6" bgcolor="{border_color}">&nbsp;</td>'
        f'<td style="padding:12px 14px 12px 14px;">'
        f'<div style="font-size:10px;color:#888;letter-spacing:1px;text-transform:uppercase;">{kicker}</div>'
        f'<div style="font-size:15px;font-weight:bold;color:#fff;margin-top:2px;">{title}</div>'
    )


def _card_close() -> str:
    return '</td></tr></table>'


def balloon_html_acled(fields: dict, perp_key: str) -> str:
    """One ACLED event's balloon. Table-based for Earth Pro WebKit reliability."""
    color = "#" + PERP_COLORS[perp_key][0]
    perp_label = PERP_COLORS[perp_key][1]
    civ = fields.get("civilian_targeting", "").strip() == "Civilian targeting"
    try:
        fat = int(fields.get("fatalities") or 0)
    except ValueError:
        fat = 0
    date = fields.get("event_date", "")
    loc_parts = [fields.get(k, "") for k in ("location", "admin3", "admin2", "admin1")]
    # dedupe while preserving order
    seen = set(); loc_dedup = []
    for p in loc_parts:
        if p and p not in seen:
            loc_dedup.append(p); seen.add(p)
    loc = ", ".join(loc_dedup)
    event_type = fields.get("event_type", "")
    sub = fields.get("sub_event_type", "")
    actor1 = fields.get("actor1", "")
    assoc1 = fields.get("assoc_actor_1", "")
    actor2 = fields.get("actor2", "")
    notes = fields.get("notes", "")
    source = fields.get("source", "")
    eid = fields.get("event_id_cnty", "")

    fat_color = "#ff5040" if fat >= 10 else ("#ffc060" if fat >= 1 else "#888")
    kicker = html_escape(f"{event_type} · {sub}".strip(" ·"))
    title = html_escape(f"{date} — {loc or '(no location)'}")

    out = []
    out.append(_card_open(color, kicker, title))

    # Big fatality count + perpetrator badge in a 2-col row
    civ_badge_html = (
        f'<span style="background:#b00020;color:#fff;padding:3px 8px;'
        f'font-size:10px;font-weight:bold;letter-spacing:1px;">CIVILIANS TARGETED</span> '
    ) if civ else ''
    perp_badge_html = (
        f'<span style="background:{color};color:#fff;padding:3px 8px;'
        f'font-size:10px;font-weight:bold;letter-spacing:1px;">{html_escape(perp_label.upper())}</span>'
    )

    out.append(
        f'<table cellpadding="0" cellspacing="0" border="0" width="100%" style="margin-top:10px;">'
        f'<tr>'
        f'<td valign="top" width="100" style="font-size:34px;font-weight:bold;color:{fat_color};line-height:1;">'
        f'{fat}<br><span style="font-size:10px;color:#888;font-weight:normal;letter-spacing:1px;">'
        f'{"FATALITIES" if fat != 1 else "FATALITY"}</span></td>'
        f'<td valign="top" style="padding-left:6px;">{civ_badge_html}{perp_badge_html}'
        f'<div style="margin-top:8px;font-size:11px;color:#bbb;line-height:1.4;">'
        f'<b style="color:#fff;">{html_escape(actor1) or "Unknown actor"}</b>'
    )
    if assoc1:
        out.append(f'<br>with <b style="color:#ddd;">{html_escape(assoc1)}</b>')
    if actor2:
        out.append(f'<br>against <b style="color:#ddd;">{html_escape(actor2)}</b>')
    out.append('</div></td></tr></table>')

    if notes:
        out.append(
            f'<div style="margin-top:12px;font-size:12px;line-height:1.5;color:#d8d8d8;">'
            f'{html_escape(notes)}</div>'
        )

    out.append(
        f'<table cellpadding="0" cellspacing="0" border="0" width="100%" '
        f'style="margin-top:12px;border-top:1px solid #333;padding-top:6px;">'
        f'<tr><td style="font-size:10px;color:#888;padding-top:6px;">'
        f'Source: {_linkify(source) or "—"}<br>'
        f'ACLED ID: <span style="color:#bbb;font-family:monospace;">{html_escape(eid)}</span>'
        f'</td></tr></table>'
    )
    out.append(_card_close())
    return ''.join(out)


def balloon_html_base(name: str, kind: str, description: str = "",
                      stats: dict | None = None) -> str:
    """Balloon for a FAMa / Wagner base. If `stats` is provided, includes the
    incidents-within-50km enrichment that turns the base into a question
    investigators care about."""
    LABELS = {
        "fama_wagner": ("FAMa + Wagner co-located", "#8b0a1a"),
        "fama":        ("FAMa military base",       "#e85a4f"),
        "minusma":     ("Former MINUSMA → FAMa",    "#9e9e9e"),
        "checkpoint":  ("Checkpoint",                "#e85a4f"),
    }
    label, color = LABELS[kind]
    out = [_card_open(color, label, html_escape(name))]

    if description:
        out.append(
            f'<div style="margin-top:6px;font-size:11px;color:#bbb;">'
            f'{_linkify(description)}</div>'
        )

    if stats:
        n = stats["count"]
        n_civ = stats["civ_count"]
        n_fat = stats["fatalities"]
        pct_civ = (100.0 * n_civ / n) if n else 0
        out.append(
            f'<table cellpadding="0" cellspacing="0" border="0" width="100%" '
            f'style="margin-top:12px;border-top:1px solid #333;padding-top:8px;">'
            f'<tr>'
            f'<td valign="top" style="padding-right:6px;">'
            f'<div style="font-size:10px;color:#888;letter-spacing:1px;">INCIDENTS WITHIN 50 KM</div>'
            f'<div style="font-size:28px;font-weight:bold;color:#fff;line-height:1;">{n}</div>'
            f'</td>'
            f'<td valign="top" style="padding-right:6px;">'
            f'<div style="font-size:10px;color:#888;letter-spacing:1px;">CIVILIANS TARGETED</div>'
            f'<div style="font-size:28px;font-weight:bold;color:#ff5040;line-height:1;">{n_civ}</div>'
            f'<div style="font-size:10px;color:#888;">{pct_civ:.0f}% of incidents</div>'
            f'</td>'
            f'<td valign="top">'
            f'<div style="font-size:10px;color:#888;letter-spacing:1px;">REPORTED DEAD</div>'
            f'<div style="font-size:28px;font-weight:bold;color:#ff5040;line-height:1;">{n_fat}</div>'
            f'</td>'
            f'</tr></table>'
        )
        worst = stats.get("worst", [])
        if worst:
            out.append('<div style="margin-top:10px;font-size:10px;color:#888;letter-spacing:1px;">WORST INCIDENTS NEARBY</div>')
            out.append('<table cellpadding="0" cellspacing="0" border="0" width="100%" style="margin-top:4px;font-size:11px;color:#ddd;">')
            for w in worst:
                out.append(
                    f'<tr>'
                    f'<td width="78" style="color:#888;font-family:monospace;padding:2px 4px 2px 0;">{html_escape(w["date"])}</td>'
                    f'<td style="padding:2px 4px;">{html_escape(w["location"])}</td>'
                    f'<td width="40" align="right" style="color:#ff5040;font-weight:bold;padding:2px 0;">{w["fatalities"]}</td>'
                    f'</tr>'
                )
            out.append('</table>')

    out.append(_card_close())
    return ''.join(out)


def balloon_html_gold(name: str, sub: str) -> str:
    palette = {"Artisanal Mining Sites": ("#d4af37", "Artisanal gold mine"),
               "Industrial mines":       ("#6b4423", "Industrial gold mine"),
               "Refineries":             ("#d4af37", "Gold refinery")}
    color, label = palette[sub]
    return _card_open(color, label, html_escape(name)) + _card_close()


def balloon_html_atrocity(name: str) -> str:
    return (
        _card_open("#b00020", "Documented atrocity site", html_escape(name))
        + '<div style="margin-top:6px;font-size:11px;color:#aaa;">Manually-placed reference. See nearby ACLED events for source detail.</div>'
        + _card_close()
    )


# ──────────────────────────────────────────────────────────────────────────────
# Date normalization (event_date M/D/YYYY → YYYY-MM-DD)
# ──────────────────────────────────────────────────────────────────────────────

def to_iso_date(event_date: str) -> str | None:
    if not event_date:
        return None
    for fmt in ("%m/%d/%Y", "%d/%m/%Y", "%Y-%m-%d"):
        try:
            return datetime.strptime(event_date.strip(), fmt).strftime("%Y-%m-%d")
        except ValueError:
            continue
    return None


# ──────────────────────────────────────────────────────────────────────────────
# Region/LOD tiering
# ──────────────────────────────────────────────────────────────────────────────

def lod_region(lon: float, lat: float, fatalities: int, event_type: str) -> tuple[int, int]:
    """Return (minLodPixels, fadeExtent). Higher fatality → visible at lower zoom.

    The map carries 1,083 events — at country zoom only the truly worst should
    show, otherwise the screen becomes a wall of overlapping icons. Tiers:

    | fatalities | min_lod | what you see                          |
    | ≥ 20       | 0       | country zoom (whole-Mali view)        |
    | 10–19      | 96      | regional zoom (~3 admin1)             |
    | 5–9        | 160     | sub-regional zoom (~1 admin1)         |
    | 1–4        | 256     | admin2 zoom                           |
    | 0          | 384     | very close zoom (commune / town)      |
    """
    if fatalities >= 20:
        return 0, 0
    if fatalities >= 10:
        return 96, 48
    if fatalities >= 5:
        return 160, 64
    if fatalities >= 1:
        return 256, 80
    return 384, 80


# ──────────────────────────────────────────────────────────────────────────────
# Wagner reach (connector lines)
# ──────────────────────────────────────────────────────────────────────────────

def haversine_km(lon1, lat1, lon2, lat2):
    R = 6371.0
    dlon = math.radians(lon2 - lon1)
    dlat = math.radians(lat2 - lat1)
    a = math.sin(dlat/2)**2 + math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) * math.sin(dlon/2)**2
    return 2 * R * math.asin(math.sqrt(a))


def nearest_base(lon, lat, wagner_bases):
    best = None
    best_d = float("inf")
    for b in wagner_bases:
        d = haversine_km(lon, lat, b["lon"], b["lat"])
        if d < best_d:
            best_d = d
            best = b
    return best, best_d


# ──────────────────────────────────────────────────────────────────────────────
# Admin1 heat polygons
# ──────────────────────────────────────────────────────────────────────────────

NE_URL = "https://naciscdn.org/naturalearth/10m/cultural/ne_10m_admin_1_states_provinces.zip"

def fetch_ne_admin1() -> Path | None:
    NE_CACHE.parent.mkdir(exist_ok=True)
    if NE_CACHE.exists() and NE_CACHE.stat().st_size > 1000:
        return NE_CACHE
    try:
        print(f"  fetching Natural Earth admin1 from {NE_URL}", file=sys.stderr)
        urllib.request.urlretrieve(NE_URL, NE_CACHE)
        return NE_CACHE
    except Exception as exc:
        print(f"  WARN: could not fetch Natural Earth ({exc}); admin1 heat will be skipped", file=sys.stderr)
        return None


def load_mali_admin1(zip_path: Path) -> dict[str, list[list[tuple[float, float]]]]:
    """Return {region_name: [ring1, ring2, ...]} for Mali admin1 features."""
    import shapefile
    prefix = "ne_10m_admin_1_states_provinces"
    with zipfile.ZipFile(zip_path, "r") as z:
        members = [n for n in z.namelist() if n.startswith(prefix)]
        tmp = REPO / ".cache" / "ne_tmp"
        tmp.mkdir(exist_ok=True, parents=True)
        for m in members:
            with z.open(m) as src:
                (tmp / Path(m).name).write_bytes(src.read())
    reader = shapefile.Reader(str(tmp / prefix))
    fields = [f[0] for f in reader.fields[1:]]
    out: dict[str, list[list[tuple[float, float]]]] = {}
    for shp_rec in reader.shapeRecords():
        rec = dict(zip(fields, shp_rec.record))
        if rec.get("admin") != "Mali":
            continue
        name = rec.get("name") or rec.get("name_en") or rec.get("name_alt") or "?"
        parts = list(shp_rec.shape.parts) + [len(shp_rec.shape.points)]
        rings = []
        for i in range(len(parts)-1):
            seg = shp_rec.shape.points[parts[i]:parts[i+1]]
            rings.append([(p[0], p[1]) for p in seg])
        out[name] = rings
    return out


# Mapping from ACLED admin1 spellings → Natural Earth name (best effort)
ADMIN1_ALIASES = {
    "Tombouctou": "Timbuktu",
    "Segou": "Ségou",
    "Menaka": "Ménaka",
    # exact matches expected for: Mopti, Gao, Kidal, Bamako, Sikasso, Kayes, Koulikoro
}


# ──────────────────────────────────────────────────────────────────────────────
# KML emission
# ──────────────────────────────────────────────────────────────────────────────

def E(tag: str, *children, **attrs) -> etree._Element:
    el = etree.SubElement(etree.Element("placeholder"), tag, attrib=attrs)
    # detach placeholder parent
    el.getparent().remove(el)
    for c in children:
        if isinstance(c, str):
            el.text = (el.text or "") + c
        else:
            el.append(c)
    return el


# Simpler: build a small DOM helper

def make_el(tag, text=None, attrib=None, children=()):
    el = etree.Element(tag, attrib=attrib or {})
    if text is not None:
        el.text = text
    for c in children:
        if c is not None:
            el.append(c)
    return el


def cdata(s: str) -> etree.CDATA:
    return etree.CDATA(s)


def build_balloon_style(style_id: str) -> etree._Element:
    bs = make_el(K("BalloonStyle"), children=[
        make_el(K("bgColor"), "ff1a1a1a"),
        make_el(K("textColor"), "ffe0e0e0"),
        make_el(K("text")),
    ])
    bs.find(K("text")).text = cdata("$[description]")
    return make_el(K("Style"), attrib={"id": style_id}, children=[bs])


def icon_style(icon_href: str, scale: float, perp_color_hex: str) -> etree._Element:
    """Build an IconStyle that uses the embedded PNG."""
    return make_el(K("IconStyle"), children=[
        make_el(K("scale"), f"{scale:.2f}"),
        make_el(K("Icon"), children=[make_el(K("href"), icon_href)]),
        # icon already pre-tinted; no need to set <color>
        make_el(K("hotSpot"), attrib={"x": "0.5", "y": "0.5", "xunits": "fraction", "yunits": "fraction"}),
    ])


def label_style(scale: float = 0.0, color: str = "ffffffff") -> etree._Element:
    """scale=0 hides the label entirely. >0 makes it persistently visible."""
    return make_el(K("LabelStyle"), children=[
        make_el(K("color"), color),
        make_el(K("scale"), f"{scale:.2f}"),
    ])


def label_style_hidden() -> etree._Element:
    return label_style(0.0)


# Persistent label scale for headline events. 0.65 keeps the text small enough
# that two adjacent labels don't merge into a wall of overlapping text.
HEADLINE_LABEL_SCALE = 0.65


def line_style(color_aabbggrr: str, width: float = 1.0) -> etree._Element:
    return make_el(K("LineStyle"), children=[
        make_el(K("color"), color_aabbggrr),
        make_el(K("width"), f"{width:.1f}"),
    ])


def poly_style(fill_aabbggrr: str, outline_aabbggrr: str | None = None) -> etree._Element:
    children = [make_el(K("color"), fill_aabbggrr), make_el(K("fill"), "1")]
    if outline_aabbggrr:
        children.append(make_el(K("outline"), "1"))
    return make_el(K("PolyStyle"), children=children)


def kml_color(hex_rgb: str, alpha: int = 255) -> str:
    r = int(hex_rgb[0:2], 16); g = int(hex_rgb[2:4], 16); b = int(hex_rgb[4:6], 16)
    return f"{alpha:02x}{b:02x}{g:02x}{r:02x}"


def build_acled_style(style_id: str, icon_href: str, scale: float) -> etree._Element:
    return make_el(K("Style"), attrib={"id": style_id}, children=[
        icon_style(icon_href, scale, ""),
        label_style_hidden(),
        make_el(K("BalloonStyle"), children=[
            make_el(K("bgColor"), "ff1a1a1a"),
            make_el(K("textColor"), "ffe0e0e0"),
            (lambda: (lambda el: (el.append(etree.fromstring("<text/>")), el)[1])(make_el(K("BalloonStyle"))))() or None,
        ])
    ])


# Simpler helper since the above lambda dance is awkward
def acled_style(style_id: str, icon_href: str, scale: float,
                label_visible: bool = False) -> etree._Element:
    text_el = etree.Element(K("text"))
    text_el.text = cdata("$[description]")
    bs = etree.Element(K("BalloonStyle"))
    bs.append(etree.fromstring(f'<bgColor xmlns="{KML_NS}">ff1a1a1a</bgColor>'))
    bs.append(etree.fromstring(f'<textColor xmlns="{KML_NS}">ffe0e0e0</textColor>'))
    bs.append(text_el)
    return make_el(K("Style"), attrib={"id": style_id}, children=[
        icon_style(icon_href, scale, ""),
        label_style(HEADLINE_LABEL_SCALE if label_visible else 0.0, "ffffffff"),
        bs,
    ])


def region_el(lon: float, lat: float, min_lod: int, fade: int) -> etree._Element | None:
    if min_lod == 0:
        return None
    # tiny bounding box centred on the point (LOD only needs to be a valid box)
    d = 0.02
    return make_el(K("Region"), children=[
        make_el(K("LatLonAltBox"), children=[
            make_el(K("north"), f"{lat+d:.6f}"),
            make_el(K("south"), f"{lat-d:.6f}"),
            make_el(K("east"),  f"{lon+d:.6f}"),
            make_el(K("west"),  f"{lon-d:.6f}"),
        ]),
        make_el(K("Lod"), children=[
            make_el(K("minLodPixels"), str(min_lod)),
            make_el(K("maxLodPixels"), "-1"),
            make_el(K("minFadeExtent"), str(fade)),
            make_el(K("maxFadeExtent"), "0"),
        ]),
    ])


def acled_placemark(record: dict, style_id: str, description_html: str,
                    is_headline: bool = False) -> etree._Element:
    fields = record["fields"]
    lon, lat = record["lon"], record["lat"]
    base_name = fields.get("location") or fields.get("admin3") or fields.get("admin2") or "Incident"
    iso = to_iso_date(fields.get("event_date", ""))
    try: fat = int(fields.get("fatalities") or 0)
    except ValueError: fat = 0
    event_type = fields.get("event_type", "")
    min_lod, fade = lod_region(lon, lat, fat, event_type)
    # Headline events get their location + body count baked into the placemark name
    # so the persistent LabelStyle shows context, not just "Moura".
    name = f"{base_name}  ·  {fat} dead" if is_headline else base_name

    children = [
        make_el(K("name"), name),
    ]
    # keep raw ExtendedData for advanced users
    ed = make_el(K("ExtendedData"))
    for k, v in fields.items():
        d = make_el(K("Data"), attrib={"name": k})
        val = make_el(K("value"), v or "")
        d.append(val)
        ed.append(d)
    children.append(ed)

    desc = make_el(K("description"))
    desc.text = cdata(description_html)
    children.append(desc)

    if iso:
        ts = make_el(GX("TimeStamp")) if False else make_el(K("TimeStamp"))
        ts.append(make_el(K("when"), iso))
        children.append(ts)

    children.append(make_el(K("styleUrl"), f"#{style_id}"))

    region = region_el(lon, lat, min_lod, fade)
    if region is not None:
        children.append(region)

    pt = make_el(K("Point"), children=[
        make_el(K("coordinates"), f"{lon},{lat},0"),
    ])
    children.append(pt)
    return make_el(K("Placemark"), children=children)


# ──────────────────────────────────────────────────────────────────────────────
# Main builder
# ──────────────────────────────────────────────────────────────────────────────

def build():
    print("→ parsing source KMZ", file=sys.stderr)
    tree, preserved = parse_source(SRC)
    root = tree.getroot()

    print("→ extracting placemarks", file=sys.stderr)
    acled = extract_acled(root)
    manual = extract_manual(root)
    print(f"   ACLED: {len(acled)}   bases: {len(manual['fama_points'])}   "
          f"polygon: {1 if manual['fama_polygon'] else 0}   "
          f"attacks: {len(manual['attacks'])}   gold: {sum(len(v) for v in manual['gold'].values())}",
          file=sys.stderr)

    # Filter Jordan stray (in case it slipped into ACLED — it didn't, but defensive)
    acled = [r for r in acled if not is_jordan_stray(r["lon"], r["lat"])]

    print("→ rendering icon library", file=sys.stderr)
    icons, base_glyphs = build_icon_library()
    add_manual_icons(icons, base_glyphs)
    print(f"   {len(icons)} icon PNGs generated", file=sys.stderr)

    print("→ rendering legend", file=sys.stderr)
    icons["icons/legend.png"] = build_legend_png(base_glyphs)

    print("→ rendering timeline sparkline", file=sys.stderr)
    icons["icons/timeline.png"] = build_timeline_png(acled)

    # ─── Pre-compute per-base stats (incidents within 50km) ─────────────────
    wagner_bases = [p for p in manual["fama_points"] if classify_base(p["name"]) == "fama_wagner"]
    base_stats: dict[str, dict] = {}
    for base in wagner_bases:
        nearby = []
        for rec in acled:
            d = haversine_km(base["lon"], base["lat"], rec["lon"], rec["lat"])
            if d <= 50:
                nearby.append((d, rec))
        n = len(nearby)
        civ_count = sum(1 for _, r in nearby
                        if r["fields"].get("civilian_targeting","").strip() == "Civilian targeting")
        fat_total = 0
        for _, r in nearby:
            try: fat_total += int(r["fields"].get("fatalities") or 0)
            except ValueError: pass
        # top 3 worst by fatalities
        worst_sorted = sorted(
            nearby,
            key=lambda dr: -int(dr[1]["fields"].get("fatalities") or 0),
        )[:3]
        worst = []
        for _, r in worst_sorted:
            try: fat = int(r["fields"].get("fatalities") or 0)
            except ValueError: fat = 0
            if fat == 0:
                continue
            worst.append({
                "date": r["fields"].get("event_date",""),
                "location": r["fields"].get("location") or r["fields"].get("admin3") or "",
                "fatalities": fat,
            })
        base_stats[base["name"]] = {
            "count": n, "civ_count": civ_count, "fatalities": fat_total, "worst": worst,
        }

    # ─── Build the KML tree ─────────────────────────────────────────────────
    kml = etree.Element(K("kml"), nsmap=NSMAP)
    doc = make_el(K("Document"))
    kml.append(doc)
    doc.append(make_el(K("name"), "Mali — FAMa / Wagner activity (2021–2024)"))
    doc.append(make_el(K("open"), "1"))

    # Document-level description (renders in Places panel)
    intro = (
        '<div style="font-family:Helvetica,Arial,sans-serif;color:#222;max-width:520px;">'
        '<h2 style="margin:0 0 6px 0;">Mali — FAMa / Wagner activity</h2>'
        '<p style="margin:0 0 8px 0;font-size:12px;color:#555;">'
        'Investigator-facing map covering FAMa (Forces Armées Maliennes) and Wagner Group '
        'operations and alleged abuses across Mali, 2021-01-01 → 2024-01-16.</p>'
        '<p style="margin:8px 0;font-size:12px;"><b>How to read the map:</b><br>'
        '&nbsp;&nbsp;<b>Color</b> = perpetrator (deep red = Wagner-involved; salmon = FAMa alone; '
        'dark green = jihadist groups; grey = other).<br>'
        '&nbsp;&nbsp;<b>Shape</b> = event type (target = killing; burst = bombing; cuffs = capture; '
        'flame = destruction; shield = base; dot = other strategic).<br>'
        '&nbsp;&nbsp;<b>Size</b> = log-scaled fatalities. 30 dead is ~3× a single fatality.<br>'
        '&nbsp;&nbsp;<b>White halo</b> = ACLED-flagged civilian-targeting event.</p>'
        '<p style="margin:8px 0;font-size:12px;">'
        '<b>Time slider</b> is enabled — Earth Pro shows a slider at the top of the viewport. '
        'Drag to filter events by date.</p>'
        '<p style="margin:8px 0;font-size:12px;">'
        '<b>Optional folders</b> at the bottom (off by default): <i>Base activity halos</i> '
        '(50-km civilian-targeting count per Wagner base), <i>Regional civilian-targeting heat</i>, '
        'and a <i>Cinematic tour</i> of the 12 worst incidents.</p>'
        '<p style="margin:8px 0;font-size:11px;color:#777;">'
        'Sources: ACLED (Armed Conflict Location & Event Data) 2021–2024 export for Mali; '
        'OSINT-placed FAMa / Wagner bases and atrocity sites; gold-economy points from open reporting. '
        'Legend pinned bottom-left; monthly-event sparkline pinned top-left.</p>'
        '</div>'
    )
    desc = make_el(K("description"))
    desc.text = cdata(intro)
    doc.append(desc)

    # ─── ScreenOverlay: legend (bottom-left) ───────────────────────────────
    doc.append(make_el(K("ScreenOverlay"), children=[
        make_el(K("name"), "Legend"),
        make_el(K("Icon"), children=[make_el(K("href"), "files/icons/legend.png")]),
        make_el(K("overlayXY"), attrib={"x": "0", "y": "0", "xunits": "fraction", "yunits": "fraction"}),
        make_el(K("screenXY"),  attrib={"x": "12", "y": "12", "xunits": "pixels", "yunits": "pixels"}),
        make_el(K("size"),      attrib={"x": "0", "y": "0", "xunits": "pixels", "yunits": "pixels"}),
    ]))

    # ─── ScreenOverlay: timeline sparkline (top-left) ──────────────────────
    doc.append(make_el(K("ScreenOverlay"), children=[
        make_el(K("name"), "Monthly event timeline"),
        make_el(K("Icon"), children=[make_el(K("href"), "files/icons/timeline.png")]),
        make_el(K("overlayXY"), attrib={"x": "0", "y": "1", "xunits": "fraction", "yunits": "fraction"}),
        make_el(K("screenXY"),  attrib={"x": "12", "y": "-12", "xunits": "pixels", "yunits": "pixels"}),
        make_el(K("size"),      attrib={"x": "0", "y": "0", "xunits": "pixels", "yunits": "pixels"}),
    ]))

    # Identify the top fatality events that get persistent labels visible at any zoom.
    # Investigators reference these cases by name (Moura, Gathi-Loumo, Tonka, etc.).
    # 10 keeps the country-zoom map readable — more, and the labels overlap.
    scored = []
    for rec in acled:
        try: fat = int(rec["fields"].get("fatalities") or 0)
        except ValueError: fat = 0
        scored.append((fat, rec))
    scored.sort(key=lambda x: -x[0])
    LABEL_TOP_N = 10
    labeled_ids = {r["fields"].get("event_id_cnty") for _, r in scored[:LABEL_TOP_N]}

    # ─── Build de-duplicated Style entries — keyed by (glyph, perp, civ, scale-bucket, labeled) ──
    style_cache: dict[str, etree._Element] = {}

    def get_style_id(glyph: str, perp: str, civ: bool, scale: float, labeled: bool) -> str:
        sb = round(scale, 1)
        sb = max(0.7, min(3.5, sb))
        civ_suffix = "_civ" if civ else ""
        lab_suffix = "_lab" if labeled else ""
        sid = f"s_{glyph}_{perp}{civ_suffix}_{int(sb*10):02d}{lab_suffix}"
        if sid not in style_cache:
            href = f"files/icons/{glyph}_{perp}{civ_suffix}.png"
            style_cache[sid] = acled_style(sid, href, sb, label_visible=labeled)
        return sid

    # ─── ACLED placemarks grouped by event_type ─────────────────────────────
    by_event_type: dict[str, list] = defaultdict(list)
    for rec in acled:
        et = rec["fields"].get("event_type", "Other")
        by_event_type[et].append(rec)

    event_folder_order = [
        ("Violence against civilians", "Violence against civilians"),
        ("Battles",                    "Battles"),
        ("Explosions/Remote violence", "Explosions / Remote violence"),
        ("Strategic developments",     "Strategic developments"),
        ("Protests",                   "Protests & Riots"),
        ("Riots",                      "Protests & Riots"),  # merged into same folder
    ]

    # Merge protests + riots
    merged: dict[str, list] = defaultdict(list)
    for src_key, dest in event_folder_order:
        merged[dest].extend(by_event_type.get(src_key, []))

    acled_root_folder = make_el(K("Folder"), children=[
        make_el(K("name"), f"ACLED incidents ({len(acled)})"),
        make_el(K("open"), "1"),
        make_el(K("description")),
    ])
    acled_root_folder.find(K("description")).text = cdata(
        '<div style="font-family:Helvetica,Arial,sans-serif;font-size:12px;color:#333;">'
        '1,083 placemarks sourced from ACLED. Toggle sub-folders to isolate one event class.'
        '</div>'
    )
    doc.append(acled_root_folder)

    for dest_name in ["Violence against civilians", "Battles",
                      "Explosions / Remote violence", "Strategic developments",
                      "Protests & Riots"]:
        recs = merged.get(dest_name, [])
        if not recs:
            continue
        folder = make_el(K("Folder"), children=[
            make_el(K("name"), f"{dest_name} ({len(recs)})"),
            make_el(K("open"), "0"),
        ])
        for rec in recs:
            f = rec["fields"]
            perp = classify_perpetrator(f.get("actor1", ""), f.get("assoc_actor_1", ""))
            glyph = classify_glyph(f.get("event_type", ""), f.get("sub_event_type", ""))
            try:
                fat = int(f.get("fatalities") or 0)
            except ValueError:
                fat = 0
            scale = fatality_scale(fat)
            civ = f.get("civilian_targeting", "").strip() == "Civilian targeting"
            is_headline = f.get("event_id_cnty") in labeled_ids
            sid = get_style_id(glyph, perp, civ, scale, is_headline)
            html = balloon_html_acled(f, perp)
            folder.append(acled_placemark(rec, sid, html, is_headline=is_headline))
        acled_root_folder.append(folder)

    # ─── FAMa / Wagner bases folder ─────────────────────────────────────────
    bases_folder = make_el(K("Folder"), children=[
        make_el(K("name"), f"FAMa / Wagner bases ({len(manual['fama_points']) + (1 if manual['fama_polygon'] else 0)})"),
        make_el(K("open"), "1"),
    ])
    doc.append(bases_folder)

    # Base styles use the flat manual-icon filenames (one tint each).
    # Wagner-co-located bases get persistent labels — investigators ask about these by name.
    BASE_STYLE_DEFS = [
        ("base_fama_wagner", "shield_w",     True),
        ("base_fama",        "shield",       False),
        ("base_minusma",     "shield_arrow", True),
        ("base_checkpoint",  "shield_half",  False),
    ]
    for sid, glyph, labeled in BASE_STYLE_DEFS:
        style_cache[sid] = acled_style(sid, f"files/icons/{glyph}.png", 0.9,
                                        label_visible=labeled)

    base_groups = {"fama_wagner": [], "fama": [], "minusma": [], "checkpoint": []}
    for p in manual["fama_points"]:
        kind = classify_base(p["name"])
        base_groups[kind].append(p)

    group_meta = [
        ("fama_wagner", "FAMa + Wagner co-located", "base_fama_wagner"),
        ("fama",        "FAMa only",                "base_fama"),
        ("minusma",     "Former MINUSMA handover",  "base_minusma"),
        ("checkpoint",  "Checkpoints",              "base_checkpoint"),
    ]
    for kkey, label, sid in group_meta:
        pts = base_groups[kkey]
        if not pts and kkey != "fama_wagner":
            continue
        f = make_el(K("Folder"), children=[
            make_el(K("name"), f"{label} ({len(pts)})"),
            make_el(K("open"), "0"),
        ])
        for p in pts:
            stats = base_stats.get(p["name"]) if kkey == "fama_wagner" else None
            desc_html = balloon_html_base(p["name"], kkey, p.get("description", ""), stats)
            d = make_el(K("description"))
            d.text = cdata(desc_html)
            f.append(make_el(K("Placemark"), children=[
                make_el(K("name"), p["name"]),
                d,
                make_el(K("styleUrl"), f"#{sid}"),
                make_el(K("Point"), children=[make_el(K("coordinates"), f"{p['lon']},{p['lat']},0")]),
            ]))
        bases_folder.append(f)

    # Bamba polygon
    if manual["fama_polygon"]:
        poly_sid = "poly_bamba"
        poly_style_el = make_el(K("Style"), attrib={"id": poly_sid}, children=[
            line_style(kml_color("8b0a1a", 255), 2.0),
            poly_style(kml_color("8b0a1a", 80), kml_color("8b0a1a", 255)),
        ])
        style_cache[poly_sid] = poly_style_el
        poly_folder = make_el(K("Folder"), children=[
            make_el(K("name"), "Bamba (polygon outline)"),
            make_el(K("open"), "0"),
        ])
        d = make_el(K("description"))
        d.text = cdata(balloon_html_base(manual['fama_polygon']['name'], "fama_wagner"))
        poly_folder.append(make_el(K("Placemark"), children=[
            make_el(K("name"), manual["fama_polygon"]["name"]),
            d,
            make_el(K("styleUrl"), f"#{poly_sid}"),
            make_el(K("Polygon"), children=[
                make_el(K("tessellate"), "1"),
                make_el(K("outerBoundaryIs"), children=[
                    make_el(K("LinearRing"), children=[
                        make_el(K("coordinates"), manual["fama_polygon"]["coords"])
                    ])
                ])
            ])
        ]))
        bases_folder.append(poly_folder)

    # ─── Documented atrocity sites ──────────────────────────────────────────
    # The 4 manually-placed atrocity sites (Hombori, Intahaka, Moura, Velingara)
    # all have corresponding ACLED entries with the same locations. Rendering
    # both was producing duplicate labels on the map. We keep them as a quiet
    # bookmark folder: unlabeled, small, off by default — so the investigator
    # can still jump to "the four named cases" without overlapping the data.
    if manual["attacks"]:
        atro_sid = "atro_kill"
        style_cache[atro_sid] = acled_style(atro_sid,
            "files/icons/kill_wagner_civ.png", 0.8, label_visible=False)
        atro_folder = make_el(K("Folder"), children=[
            make_el(K("name"), f"Named atrocity bookmarks ({len(manual['attacks'])})"),
            make_el(K("visibility"), "0"),
            make_el(K("open"), "0"),
        ])
        for a in manual["attacks"]:
            d = make_el(K("description"))
            d.text = cdata(balloon_html_atrocity(a["name"]))
            atro_folder.append(make_el(K("Placemark"), children=[
                make_el(K("name"), a["name"]),
                d,
                make_el(K("styleUrl"), f"#{atro_sid}"),
                make_el(K("Point"), children=[make_el(K("coordinates"), f"{a['lon']},{a['lat']},0")]),
            ]))
        doc.append(atro_folder)

    # ─── Gold economy ───────────────────────────────────────────────────────
    GOLD_STYLE_DEFS = [
        ("gold_art",     "pickaxe"),
        ("gold_ind",     "factory"),
        ("gold_refinery","drum"),
    ]
    for sid, glyph in GOLD_STYLE_DEFS:
        style_cache[sid] = acled_style(sid, f"files/icons/{glyph}.png", 0.9)

    gold_sub_map = {"Artisanal Mining Sites": "gold_art",
                    "Industrial mines": "gold_ind",
                    "Refineries": "gold_refinery"}
    total_gold = sum(len(v) for v in manual["gold"].values())
    if total_gold:
        gold_folder = make_el(K("Folder"), children=[
            make_el(K("name"), f"Gold economy ({total_gold})"),
            make_el(K("open"), "1"),
        ])
        for sub_name, sid in gold_sub_map.items():
            pts = manual["gold"].get(sub_name, [])
            if not pts: continue
            f = make_el(K("Folder"), children=[
                make_el(K("name"), f"{sub_name} ({len(pts)})"),
                make_el(K("open"), "0"),
            ])
            for p in pts:
                d = make_el(K("description"))
                d.text = cdata(balloon_html_gold(p["name"], sub_name))
                f.append(make_el(K("Placemark"), children=[
                    make_el(K("name"), p["name"]),
                    d,
                    make_el(K("styleUrl"), f"#{sid}"),
                    make_el(K("Point"), children=[make_el(K("coordinates"), f"{p['lon']},{p['lat']},0")]),
                ]))
            gold_folder.append(f)
        doc.append(gold_folder)

    # ─── Imagery (GroundOverlay preserved) ──────────────────────────────────
    if manual["ground_overlay"]:
        go = manual["ground_overlay"]
        img_folder = make_el(K("Folder"), children=[
            make_el(K("name"), "Imagery"),
            make_el(K("open"), "0"),
        ])
        ground = make_el(K("GroundOverlay"), children=[
            make_el(K("name"), go["name"]),
            make_el(K("Icon"), children=[make_el(K("href"), go["href"])]),
            make_el(K("LatLonBox"), children=[
                make_el(K("north"), go["north"]),
                make_el(K("south"), go["south"]),
                make_el(K("east"),  go["east"]),
                make_el(K("west"),  go["west"]),
                make_el(K("rotation"), go["rotation"]),
            ]),
        ])
        img_folder.append(ground)
        doc.append(img_folder)

    # ─── Base activity halos (off by default) ───────────────────────────────
    # Replaces the earlier "nearest-base" connector-line heuristic, which risked
    # being misread as an operational claim. This is *evidence-based*: each halo
    # is a 50-km circle around a Wagner-co-located base, fill alpha scaled by
    # the count of ACLED civilian-targeting events that actually fall inside.
    if wagner_bases:
        max_civ = max((base_stats[b["name"]]["civ_count"] for b in wagner_bases), default=1) or 1
        halo_folder = make_el(K("Folder"), children=[
            make_el(K("name"), "▸ Base activity halos (50 km civilian-targeting)"),
            make_el(K("description")),
            make_el(K("visibility"), "0"),
            make_el(K("open"), "0"),
        ])
        halo_folder.find(K("description")).text = cdata(
            '<div style="font-family:Helvetica;font-size:12px;color:#333;max-width:380px;">'
            '50-km circle around each Wagner-co-located base, shaded by the count of '
            'ACLED civilian-targeting events that actually fall inside the radius. '
            'Darker = more events. Click a halo to see the count. '
            '<b>Off by default.</b></div>'
        )
        for base in wagner_bases:
            stats = base_stats.get(base["name"], {})
            n_civ = stats.get("civ_count", 0)
            if n_civ == 0:
                continue
            alpha = int(40 + 160 * (n_civ / max_civ))
            sid = f"halo_{base['name'].replace(' ', '_').replace('-', '_')}"
            style_cache[sid] = make_el(K("Style"), attrib={"id": sid}, children=[
                line_style(kml_color("8b0a1a", 200), 1.5),
                poly_style(kml_color("8b0a1a", alpha), kml_color("8b0a1a", 200)),
            ])
            # build a 36-vertex circle in lat/lon (50 km ≈ 0.45° lat at the equator;
            # adjust lon by 1/cos(lat) to keep the circle visually round at Mali latitudes)
            lat0 = base["lat"]; lon0 = base["lon"]
            dlat = 50.0 / 111.0
            dlon = 50.0 / (111.0 * math.cos(math.radians(lat0)))
            ring = []
            for i in range(37):
                a = 2 * math.pi * i / 36
                ring.append((lon0 + dlon * math.cos(a), lat0 + dlat * math.sin(a)))
            coords_str = " ".join(f"{lon:.5f},{lat:.5f},0" for lon, lat in ring)
            d = make_el(K("description"))
            d.text = cdata(
                _card_open("#8b0a1a", "50-km activity halo",
                           f"{html_escape(base['name'])}")
                + f'<div style="margin-top:8px;font-size:24px;font-weight:bold;color:#ff5040;">{n_civ}'
                  f'<span style="font-size:11px;color:#888;font-weight:normal;margin-left:6px;">civilian-targeting events within 50 km</span></div>'
                + _card_close()
            )
            halo_folder.append(make_el(K("Placemark"), children=[
                make_el(K("name"), f"{base['name']} — {n_civ} civ-target"),
                d,
                make_el(K("styleUrl"), f"#{sid}"),
                make_el(K("Polygon"), children=[
                    make_el(K("tessellate"), "1"),
                    make_el(K("outerBoundaryIs"), children=[
                        make_el(K("LinearRing"), children=[
                            make_el(K("coordinates"), coords_str),
                        ])
                    ])
                ])
            ]))
        print(f"   {sum(1 for el in halo_folder if el.tag == K('Placemark'))} base halos", file=sys.stderr)
        doc.append(halo_folder)

    # ─── Admin1 civilian-targeting heat polygons (off by default) ──────────
    # Switched from raw-fatalities to civilian-targeting event count.
    # Raw fatalities double-count combat losses; HR investigators care about
    # the volume of incidents where civilians were the target.
    print("→ admin1 heat polygons", file=sys.stderr)
    ne_zip = fetch_ne_admin1()
    if ne_zip:
        try:
            admin1_geom = load_mali_admin1(ne_zip)
            print(f"   loaded {len(admin1_geom)} Mali admin1 regions from Natural Earth", file=sys.stderr)
            civ_by_region: dict[str, int] = Counter()
            evt_by_region: dict[str, int] = Counter()
            fat_by_region: dict[str, int] = Counter()
            for rec in acled:
                a1 = rec["fields"].get("admin1", "")
                evt_by_region[a1] += 1
                if rec["fields"].get("civilian_targeting","").strip() == "Civilian targeting":
                    civ_by_region[a1] += 1
                try: fat_by_region[a1] += int(rec["fields"].get("fatalities") or 0)
                except ValueError: pass

            heat_folder = make_el(K("Folder"), children=[
                make_el(K("name"), "▸ Regional civilian-targeting heat"),
                make_el(K("description")),
                make_el(K("visibility"), "0"),
                make_el(K("open"), "0"),
            ])
            heat_folder.find(K("description")).text = cdata(
                '<div style="font-family:Helvetica;font-size:12px;color:#333;max-width:380px;">'
                'Mali admin1 regions shaded by the count of ACLED-flagged civilian-targeting '
                'events (2021-01-01 → 2024-01-16). Polygons from Natural Earth 1:10m. '
                'Click a region for the breakdown. <b>Off by default.</b></div>'
            )

            def lookup(region_name):
                # try every ACLED admin1 spelling against the NE name
                total_civ = 0; total_evt = 0; total_fat = 0
                for acled_admin1 in evt_by_region:
                    if ADMIN1_ALIASES.get(acled_admin1, acled_admin1) == region_name \
                       or acled_admin1 == region_name:
                        total_civ += civ_by_region.get(acled_admin1, 0)
                        total_evt += evt_by_region.get(acled_admin1, 0)
                        total_fat += fat_by_region.get(acled_admin1, 0)
                return total_civ, total_evt, total_fat

            # scale alpha by civilian-targeting count
            scaled = [(name, *lookup(name)) for name in admin1_geom]
            max_civ = max((c for _, c, _, _ in scaled), default=1) or 1

            for region_name, c_civ, c_evt, c_fat in scaled:
                if c_evt == 0:
                    continue
                alpha = max(40, min(220, int(40 + 180 * (c_civ / max_civ))))
                sid = f"heat_{region_name.replace(' ','_').replace(chr(0xe9), 'e').replace(chr(0xe8), 'e')}"
                style_cache[sid] = make_el(K("Style"), attrib={"id": sid}, children=[
                    line_style(kml_color("8b0a1a", 200), 1.0),
                    poly_style(kml_color("8b0a1a", alpha), kml_color("8b0a1a", 200)),
                ])
                multi = make_el(K("MultiGeometry"))
                for ring in admin1_geom[region_name]:
                    if len(ring) < 3:
                        continue
                    coords_str = " ".join(f"{lon},{lat},0" for lon, lat in ring)
                    multi.append(make_el(K("Polygon"), children=[
                        make_el(K("tessellate"), "1"),
                        make_el(K("outerBoundaryIs"), children=[
                            make_el(K("LinearRing"), children=[
                                make_el(K("coordinates"), coords_str),
                            ])
                        ])
                    ]))
                pct = (100.0 * c_civ / c_evt) if c_evt else 0
                d = make_el(K("description"))
                d.text = cdata(
                    _card_open("#8b0a1a", "Admin1 region", html_escape(region_name))
                    + f'<table cellpadding="0" cellspacing="0" border="0" width="100%" style="margin-top:10px;">'
                      f'<tr>'
                      f'<td valign="top"><div style="font-size:10px;color:#888;letter-spacing:1px;">CIVILIANS TARGETED</div>'
                      f'<div style="font-size:28px;font-weight:bold;color:#ff5040;">{c_civ}</div>'
                      f'<div style="font-size:10px;color:#888;">{pct:.0f}% of all incidents</div></td>'
                      f'<td valign="top"><div style="font-size:10px;color:#888;letter-spacing:1px;">ALL INCIDENTS</div>'
                      f'<div style="font-size:28px;font-weight:bold;color:#fff;">{c_evt}</div></td>'
                      f'<td valign="top"><div style="font-size:10px;color:#888;letter-spacing:1px;">REPORTED DEAD</div>'
                      f'<div style="font-size:28px;font-weight:bold;color:#fff;">{c_fat}</div></td>'
                      f'</tr></table>'
                    + _card_close()
                )
                heat_folder.append(make_el(K("Placemark"), children=[
                    make_el(K("name"), region_name),
                    d,
                    make_el(K("styleUrl"), f"#{sid}"),
                    multi,
                ]))
            doc.append(heat_folder)
        except Exception as exc:
            print(f"   WARN: admin1 heat skipped — {exc}", file=sys.stderr)
    else:
        print("   admin1 heat skipped (no Natural Earth shapefile)", file=sys.stderr)

    # ─── Cinematic tour ─────────────────────────────────────────────────────
    print("→ cinematic tour", file=sys.stderr)
    # pick top 12 by fatalities, then sort by date
    scored = []
    for rec in acled:
        f = rec["fields"]
        try: fat = int(f.get("fatalities") or 0)
        except ValueError: fat = 0
        scored.append((fat, rec))
    scored.sort(key=lambda x: -x[0])
    top = [rec for _, rec in scored[:12]]
    top.sort(key=lambda r: to_iso_date(r["fields"].get("event_date","")) or "0000-00-00")

    tour = make_el(GX("Tour"), children=[
        make_el(K("name"), "Cinematic — 12 worst incidents"),
    ])
    playlist = make_el(GX("Playlist"))
    tour.append(playlist)
    # opening wide shot
    open_flyto = make_el(GX("FlyTo"), children=[
        make_el(GX("duration"), "3.0"),
        make_el(GX("flyToMode"), "smooth"),
        make_el(K("LookAt"), children=[
            make_el(K("longitude"), "-3.0"),
            make_el(K("latitude"), "16.0"),
            make_el(K("altitude"), "0"),
            make_el(K("heading"), "0"),
            make_el(K("tilt"), "0"),
            make_el(K("range"), "1800000"),
            make_el(K("altitudeMode"), "relativeToGround"),
        ])
    ])
    playlist.append(open_flyto)
    playlist.append(make_el(GX("Wait"), children=[make_el(GX("duration"), "1.5")]))

    for rec in top:
        f = rec["fields"]
        lon, lat = rec["lon"], rec["lat"]
        flyto = make_el(GX("FlyTo"), children=[
            make_el(GX("duration"), "5.0"),
            make_el(GX("flyToMode"), "smooth"),
            make_el(K("LookAt"), children=[
                make_el(K("longitude"), f"{lon:.6f}"),
                make_el(K("latitude"),  f"{lat:.6f}"),
                make_el(K("altitude"), "0"),
                make_el(K("heading"), "0"),
                make_el(K("tilt"), "45"),
                make_el(K("range"), "8000"),
                make_el(K("altitudeMode"), "relativeToGround"),
            ])
        ])
        playlist.append(flyto)
        playlist.append(make_el(GX("Wait"), children=[make_el(GX("duration"), "4.0")]))

    tour_folder = make_el(K("Folder"), children=[
        make_el(K("name"), "▸ Cinematic tour: 12 worst incidents"),
        make_el(K("description")),
        make_el(K("visibility"), "0"),
        make_el(K("open"), "0"),
        tour,
    ])
    tour_folder.find(K("description")).text = cdata(
        '<div style="font-family:Helvetica;font-size:12px;color:#333;max-width:380px;">'
        'Flies through the 12 highest-fatality incidents in chronological order. '
        'Click <b>▸</b> next to the tour name in the Places panel to play. '
        '<b>Off by default</b>.</div>'
    )
    doc.append(tour_folder)

    # ─── Now insert all styles at the top of Document ───────────────────────
    # Insert after <name>, <open>, <description>, ScreenOverlay
    # i.e. before the first <Folder>
    first_folder_idx = next(i for i, child in enumerate(doc) if child.tag == K("Folder"))
    for sid, style in style_cache.items():
        doc.insert(first_folder_idx, style)
        first_folder_idx += 1

    return kml, icons, preserved


def serialize(kml_root) -> bytes:
    return etree.tostring(kml_root, xml_declaration=True, encoding="UTF-8",
                          pretty_print=True, standalone=False)


def write_kmz(kml_bytes: bytes, icons: dict[str, bytes], preserved: dict[str, bytes]) -> None:
    with zipfile.ZipFile(OUT, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        z.writestr("doc.kml", kml_bytes)
        for name, blob in preserved.items():
            z.writestr(name, blob)
        for name, blob in icons.items():
            z.writestr(f"files/{name}", blob)


def main():
    if not SRC.exists():
        print(f"ERROR: {SRC} not found", file=sys.stderr); sys.exit(1)

    kml_root, icons, preserved = build()

    print("→ serializing KML", file=sys.stderr)
    kml_bytes = serialize(kml_root)

    print("→ self-check: re-parsing emitted KML", file=sys.stderr)
    etree.fromstring(kml_bytes)  # strict parse; raises on any malformed XML

    print("→ writing KMZ", file=sys.stderr)
    write_kmz(kml_bytes, icons, preserved)

    size_kb = OUT.stat().st_size / 1024
    print(f"\n✓ {OUT} written ({size_kb:.0f} KB)", file=sys.stderr)


if __name__ == "__main__":
    main()
