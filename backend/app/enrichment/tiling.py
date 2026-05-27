"""Shared bbox-tiling math for the Browse and Compose paths.

Both inventory tiling (browse.py) and Compose-mode auto-tiling
(overpass_tile.py) split a single bbox into an NxN grid sized to keep each
tile under a target element count. The math is identical; only the
return-shape differs (browse wraps it in a Pydantic ``TileGrid`` for its
preflight response, Compose just needs the raw bbox list).

This module owns the pure math. Side-effect-free, no schema imports.
"""

from __future__ import annotations

import math

# Square grids capped at 12x12 = 144 tiles so the worst-case wait stays
# under ~2.5min at the 1 req/sec rate-limit floor (and ~50s with three
# mirrors in parallel).
DEFAULT_TARGET_PER_TILE = 3000
DEFAULT_MAX_TILE_DIM = 12


def plan_tile_bboxes(
    bbox: tuple[float, float, float, float],
    total_count: int,
    *,
    target_per_tile: int = DEFAULT_TARGET_PER_TILE,
    max_dim: int = DEFAULT_MAX_TILE_DIM,
) -> tuple[int, list[list[float]]]:
    """Subdivide ``bbox`` into an NxN grid sized for ``target_per_tile`` features.

    Returns ``(dim, tiles)`` where ``dim`` is the side length (1..max_dim)
    and ``tiles`` is the list of ``[west, south, east, north]`` bboxes in
    row-major order. The aspect ratio of the source bbox carries through;
    we only split the box into equal subdivisions, we don't try to balance
    east-west vs north-south density.
    """
    if total_count <= 0:
        dim = 1
    else:
        ideal = math.sqrt(total_count / target_per_tile)
        dim = max(1, min(max_dim, math.ceil(ideal)))
    west, south, east, north = bbox
    dx = (east - west) / dim
    dy = (north - south) / dim
    tiles: list[list[float]] = []
    for r in range(dim):
        for c in range(dim):
            w = west + c * dx
            e = west + (c + 1) * dx if c < dim - 1 else east
            s = south + r * dy
            n = south + (r + 1) * dy if r < dim - 1 else north
            tiles.append([w, s, e, n])
    return dim, tiles
