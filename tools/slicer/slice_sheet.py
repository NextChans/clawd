#!/usr/bin/env python3
"""
slice_sheet.py — 나노바나나(Gemini) 고양이 pose 시트를 개별 PNG로 슬라이스.

원본 시트 특징 (중요):
  - mode 는 RGBA 이지만 alpha 가 전부 255 (완전 불투명).
  - "투명" 배경은 실제 알파가 아니라 체커보드 패턴이 픽셀로 그려져 있음.
    체커보드 = 중립색 (R≈G≈B): 흰색(~254) + 회색(~186).
  - 외곽선은 진한 갈색/검정. 각 셀 하단에 pose 라벨 텍스트가 baked-in.
  - multi-color 시트: 상단에 컬러명 헤더 텍스트도 baked-in.
  - 일부 캐릭터는 셀 폭을 넘어 옆(빈) 셀까지 그려져 있음.

배경 감지 (--bg-mode):
  color(레거시): 중립색 & 밝음 = 배경. 크림 시트엔 통하지만
    흰색·회색 고양이는 몸통이 중립·밝음 → 배경으로 오인식 → 못 씀.
  flood(기본, 컬러 무관, 강건): 배경후보(중립&밝음) 중에서
    이미지 4개 모서리와 4-연결로 이어진 픽셀만 배경으로 확정.
    캐릭터 몸통(흰/회색)은 진한 outline 이 막아 모서리에서 도달 불가
    → 배경후보라도 전경으로 유지됨. (task 요구사항)

슬라이스 파이프라인 (시트/quadrant 단위):
  1. 배경 마스크 계산 (bg-mode).  fg = ~bg.
  2. fg 4-연결 컴포넌트 라벨링 → MIN_SIZE 이상만 캐릭터 채택
     (라벨/헤더 텍스트/노이즈는 크기로 탈락).
  3. 각 blob 을 "기대 셀 중심"에 최근접 매칭 → pose 이름 부여.
  4. blob bbox 크롭 후 15% 패딩 정사각 캔버스 중앙 배치 → 512x512.
  5. 배경 alpha=0, 캐릭터 alpha=255 (원본 RGB 유지) → PNG-32.

사용법:
  # 단일 컬러 시트
  python3 slice_sheet.py --input tools/slicer/cream_sheet.png \
      --output src/assets/cat/cream --color cream

  # 4-컬러 quadrant 시트 (2x2) → 컬러별 폴더로 분리
  python3 slice_sheet.py --input tools/slicer/multi_color_sheet.png \
      --multi-color --output-root src/assets/cat
"""
from __future__ import annotations

import argparse
import os

import numpy as np
from PIL import Image

# 시트 그리드 (각 시트/quadrant: 4열 x 3행) — --layout 으로 교체 가능.
COLS = 4
ROWS = 3

# 배경후보(중립·밝음) 판정 임계값
SAT_TOL = 18    # max-min <= SAT_TOL 이면 중립색(체커보드/흰·회 몸통)
BR_MIN = 150    # 그리고 밝기(max) >= BR_MIN 이면 배경후보 (진한 outline 제외)

# 캐릭터 컴포넌트 최소 크기(px). 라벨/헤더 텍스트(<수백)와 캐릭터 사이 갭.
MIN_SIZE = 3000

# multi-color quadrant 상단 헤더(컬러명) 크롭 비율.
HEADER_CROP_FRAC = 0.12

# 정규화 파라미터
OUT_SIZE = 512
PAD_FRAC = 0.15  # 최종 캔버스 각 변 15% 여백 (캐릭터가 70% 차지)

# quadrant 위치 -> 컬러 폴더명 (task 매핑)
QUADRANT_COLORS = {
    "tl": "black",
    "tr": "orange_tabby",
    "bl": "gray_tabby",
    "br": "white",
}

# 셀 (row, col) -> 파일명.  None = 빈 셀.
#   (0,3)과 (1,0) 라벨이 둘 다 run_right_a → (1,0)을 정식 run_right_a,
#   (0,3)은 run_stretch_alt(extra)로 보존 (manifest 정식 pose 미포함).
CELLS: dict[tuple[int, int], str | None] = {
    (0, 0): "sit_forward",
    (0, 1): "walk_right_a",
    (0, 2): "walk_right_b",
    (0, 3): "run_stretch_alt",   # extra
    (1, 0): "run_right_a",
    (1, 1): "run_right_b",
    (1, 2): None,                # empty
    (1, 3): "sleep_curled",
    (2, 0): "alert_arched",
    (2, 1): "angry_hiss",
    (2, 2): None,                # empty
    (2, 3): "exhausted_lie",
}

EXTRAS = {"run_stretch_alt"}
CANONICAL_POSES = [
    "sit_forward", "walk_right_a", "walk_right_b",
    "run_right_a", "run_right_b", "sleep_curled",
    "alert_arched", "angry_hiss", "exhausted_lie",
]

# --- 레이아웃 프리셋 ---------------------------------------------------------
# 시트마다 그리드/셀 매핑이 다르다. --layout 으로 골라 위 전역(COLS/ROWS/CELLS/
# EXTRAS)을 교체한다. 나머지 파이프라인(flood/blob/normalize)은 그대로 재사용.
#
#   default   : 원본 pose 시트 (4x3), run_stretch_alt extra 포함.
#   new_poses : 표정/동작 확장 시트 (4x2, 마지막 셀 빈칸). 라벨은 하단 baked-in.
#     Row0: sit_forward_blink | yawn | stretch | eating
#     Row1: happy_purr        | startled | playing_pounce | (empty)
LAYOUTS: dict[str, dict] = {
    "default": {
        "cols": 4,
        "rows": 3,
        "cells": dict(CELLS),
        "extras": set(EXTRAS),
    },
    "new_poses": {
        "cols": 4,
        "rows": 2,
        "cells": {
            (0, 0): "sit_forward_blink",
            (0, 1): "yawn",
            (0, 2): "stretch",
            (0, 3): "eating",
            (1, 0): "happy_purr",
            (1, 1): "startled",
            (1, 2): "playing_pounce",
            (1, 3): None,  # empty (label + placeholder box)
        },
        "extras": set(),
    },
}


def apply_layout(name: str) -> None:
    """--layout 프리셋을 전역(COLS/ROWS/CELLS/EXTRAS)에 반영."""
    global COLS, ROWS, CELLS, EXTRAS
    if name not in LAYOUTS:
        raise ValueError(f"unknown layout: {name} (choices: {', '.join(LAYOUTS)})")
    spec = LAYOUTS[name]
    COLS = spec["cols"]
    ROWS = spec["rows"]
    CELLS = spec["cells"]
    EXTRAS = spec["extras"]


def background_candidate(rgb: np.ndarray) -> np.ndarray:
    """중립색 & 밝은 픽셀 = 배경후보 (체커보드 + 흰/회 몸통) (bool HxW)."""
    mx = rgb.max(axis=2)
    mn = rgb.min(axis=2)
    sat = mx.astype(np.int16) - mn.astype(np.int16)
    return (sat <= SAT_TOL) & (mx >= BR_MIN)


def flood_from_border(cand: np.ndarray) -> np.ndarray:
    """배경후보(cand) 중 이미지 4모서리와 4-연결로 이어진 픽셀 = 배경.

    캐릭터 안쪽(흰/회 몸통)은 진한 outline 에 막혀 모서리에서 도달 불가
    → cand 여도 배경으로 확정되지 않고 전경으로 남는다.
    """
    h, w = cand.shape
    flat = cand.ravel()
    n = h * w
    bg = np.zeros(n, dtype=bool)

    # 4 경계의 모든 배경후보 픽셀을 시드로 (task: 4 코너 flood 확장판)
    seeds = []
    top = np.nonzero(flat[0:w])[0]
    seeds.extend(top.tolist())
    bot = np.nonzero(flat[(h - 1) * w:h * w])[0] + (h - 1) * w
    seeds.extend(bot.tolist())
    left = np.nonzero(cand[:, 0])[0] * w
    seeds.extend(left.tolist())
    right = np.nonzero(cand[:, w - 1])[0] * w + (w - 1)
    seeds.extend(right.tolist())

    stack = []
    for s in seeds:
        if not bg[s]:
            bg[s] = True
            stack.append(s)

    while stack:
        p = stack.pop()
        col = p % w
        up = p - w
        if up >= 0 and flat[up] and not bg[up]:
            bg[up] = True
            stack.append(up)
        dn = p + w
        if dn < n and flat[dn] and not bg[dn]:
            bg[dn] = True
            stack.append(dn)
        if col > 0 and flat[p - 1] and not bg[p - 1]:
            bg[p - 1] = True
            stack.append(p - 1)
        if col < w - 1 and flat[p + 1] and not bg[p + 1]:
            bg[p + 1] = True
            stack.append(p + 1)

    return bg.reshape(h, w)


def compute_background(rgb: np.ndarray, mode: str) -> np.ndarray:
    """bg-mode 에 따라 배경 마스크(bool HxW) 계산."""
    cand = background_candidate(rgb)
    if mode == "color":
        return cand
    if mode == "flood":
        return flood_from_border(cand)
    raise ValueError(f"unknown bg-mode: {mode}")


def label_components(fg: np.ndarray):
    """fg(bool HxW) 의 4-연결 컴포넌트 라벨링 (numpy + iterative stack).

    반환: (labels HxW int32, comps) — comps=[(id, size, cy, cx), ...] (size desc).
    """
    h, w = fg.shape
    flat = fg.ravel()
    n = h * w
    labels = np.full(n, -1, dtype=np.int32)
    comps = []
    cid = 0
    nz = np.nonzero(flat)[0]
    for s in nz.tolist():
        if labels[s] != -1:
            continue
        stack = [s]
        labels[s] = cid
        size = 0
        sy = 0
        sx = 0
        while stack:
            p = stack.pop()
            size += 1
            sy += p // w
            sx += p % w
            col = p % w
            up = p - w
            if up >= 0 and flat[up] and labels[up] == -1:
                labels[up] = cid
                stack.append(up)
            dn = p + w
            if dn < n and flat[dn] and labels[dn] == -1:
                labels[dn] = cid
                stack.append(dn)
            if col > 0 and flat[p - 1] and labels[p - 1] == -1:
                labels[p - 1] = cid
                stack.append(p - 1)
            if col < w - 1 and flat[p + 1] and labels[p + 1] == -1:
                labels[p + 1] = cid
                stack.append(p + 1)
        comps.append((cid, size, sy / size, sx / size))
        cid += 1
    comps.sort(key=lambda t: t[1], reverse=True)
    return labels.reshape(h, w), comps


def normalize(rgba: np.ndarray, mask: np.ndarray) -> Image.Image:
    """마스크된 캐릭터를 15% 패딩 정사각 512x512 로 정규화."""
    ys, xs = np.nonzero(mask)
    y0, y1 = ys.min(), ys.max() + 1
    x0, x1 = xs.min(), xs.max() + 1

    crop_rgba = rgba[y0:y1, x0:x1].copy()
    crop_mask = mask[y0:y1, x0:x1]
    crop_rgba[:, :, 3] = np.where(crop_mask, 255, 0).astype(np.uint8)

    ch, cw = crop_rgba.shape[:2]
    side = int(np.ceil(max(ch, cw) / (1.0 - 2.0 * PAD_FRAC)))
    canvas = np.zeros((side, side, 4), dtype=np.uint8)
    oy = (side - ch) // 2
    ox = (side - cw) // 2
    canvas[oy:oy + ch, ox:ox + cw] = crop_rgba

    img = Image.fromarray(canvas, "RGBA")
    if side != OUT_SIZE:
        img = img.resize((OUT_SIZE, OUT_SIZE), Image.LANCZOS)
    return img


def expected_centers(cw: int, ch: int):
    """named pose -> (cy, cx) 기대 셀 중심."""
    centers = {}
    for (r, c), name in CELLS.items():
        if name is None:
            continue
        centers[name] = ((r + 0.5) * ch, (c + 0.5) * cw)
    return centers


def slice_array(arr: np.ndarray, output_dir: str, bg_mode: str,
                keep_extras: bool = True):
    """RGBA numpy 배열(HxWx4)을 슬라이스해 output_dir 에 PNG 저장."""
    H, W = arr.shape[:2]
    cw = W // COLS
    ch = H // ROWS
    rgb = arr[:, :, :3].astype(np.int16)

    bg = compute_background(rgb, bg_mode)
    fg = ~bg
    labels, comps = label_components(fg)

    big = [(cid, size, cy, cx) for (cid, size, cy, cx) in comps if size >= MIN_SIZE]
    print(f"  detected {len(big)} character blob(s) (>= {MIN_SIZE}px) [{bg_mode}]")

    # Assign each blob to its nearest *named* cell center, then keep — per
    # center — the blob whose centroid sits closest to it. This is robust to
    # both failure modes we see in the wild:
    #   - Cats overflow into an *adjacent empty* column (default sheet:
    #     run_right_b / angry_hiss), so we must not bin by strict integer cell.
    #   - An empty cell can carry a large spurious blob (new_poses sheet: a dark
    #     gradient in cell (1,3) ~446k px). It maps to its nearest center too,
    #     but a real, well-centered cat owns that center by distance and wins —
    #     so the spurious blob is dropped instead of stealing the slot and
    #     cascading a misassignment (the greedy largest-first variant did steal).
    centers = expected_centers(cw, ch)
    best_per_name: dict[str, tuple[float, int, int]] = {}  # name -> (dist2, size, cid)
    for cid, size, cy, cx in big:
        best_name = None
        best_d = None
        for name, (ey, ex) in centers.items():
            d = (cy - ey) ** 2 + (cx - ex) ** 2
            if best_d is None or d < best_d:
                best_d = d
                best_name = name
        if best_name is None:
            continue
        prev = best_per_name.get(best_name)
        if prev is None or best_d < prev[0]:
            if prev is not None:
                print(f"  [drop] blob id={prev[2]} size={prev[1]} "
                      f"(farther from {best_name} center) superseded")
            best_per_name[best_name] = (best_d, size, cid)
        else:
            print(f"  [drop] blob id={cid} size={size} "
                  f"(farther from {best_name} center) — likely label/bg noise")
    assigned: dict[str, int] = {n: cid for n, (_, _, cid) in best_per_name.items()}

    missing = [n for n in centers if n not in assigned]
    if missing:
        print(f"  [warn] no blob matched for: {', '.join(missing)}")

    os.makedirs(output_dir, exist_ok=True)
    saved = []
    for name, cid in sorted(assigned.items()):
        if name in EXTRAS and not keep_extras:
            continue
        mask = labels == cid
        img = normalize(arr, mask)
        out_path = os.path.join(output_dir, f"{name}.png")
        img.save(out_path)
        size_kb = os.path.getsize(out_path) / 1024
        tag = " (extra)" if name in EXTRAS else ""
        saved.append((name, size_kb))
        print(f"  [ok] {name}.png  {size_kb:6.1f} KB{tag}")
    return saved


def slice_sheet(input_path: str, output_dir: str, bg_mode: str,
                keep_extras: bool = True):
    im = Image.open(input_path).convert("RGBA")
    return slice_array(np.asarray(im), output_dir, bg_mode, keep_extras)


def slice_multi(input_path: str, output_root: str, bg_mode: str):
    """4-quadrant(2x2) 멀티컬러 시트를 컬러별 폴더로 분리 슬라이스."""
    im = Image.open(input_path).convert("RGBA")
    arr = np.asarray(im)
    H, W = arr.shape[:2]
    qh, qw = H // 2, W // 2
    crop = int(round(qh * HEADER_CROP_FRAC))

    quads = {
        "tl": (0, qh, 0, qw),
        "tr": (0, qh, qw, W),
        "bl": (qh, H, 0, qw),
        "br": (qh, H, qw, W),
    }

    results = {}
    for pos, (y0, y1, x0, x1) in quads.items():
        color = QUADRANT_COLORS[pos]
        # 상단 헤더 크롭
        sub = arr[y0 + crop:y1, x0:x1]
        out_dir = os.path.join(output_root, color)
        print(f"[{pos}] color={color} quadrant={sub.shape[1]}x{sub.shape[0]} "
              f"(header -{crop}px) -> {out_dir}")
        # multi 시트엔 run_stretch_alt 없음 → extras 미보존
        saved = slice_array(sub, out_dir, bg_mode, keep_extras=False)
        results[color] = saved
    return results


def main():
    ap = argparse.ArgumentParser(description="Slice cat pose sheet(s) into individual PNGs.")
    ap.add_argument("--input", required=True, help="input sheet PNG")
    ap.add_argument("--output", help="output directory (single-color mode)")
    ap.add_argument("--color", help="coat color label (single-color mode)")
    ap.add_argument("--output-root", help="output root dir (multi-color mode)")
    ap.add_argument("--multi-color", action="store_true",
                    help="treat input as 2x2 quadrant multi-color sheet")
    ap.add_argument("--bg-mode", choices=["color", "flood"], default="flood",
                    help="background detection mode (default: flood)")
    ap.add_argument("--layout", choices=list(LAYOUTS), default="default",
                    help="grid/cell preset (default: default; new_poses = 4x2 expression sheet)")
    ap.add_argument("--no-extras", action="store_true",
                    help="skip extra poses (run_stretch_alt) in single-color mode")
    args = ap.parse_args()

    apply_layout(args.layout)

    if args.multi_color:
        if not args.output_root:
            ap.error("--multi-color requires --output-root")
        print(f"Slicing multi-color '{args.input}' -> '{args.output_root}' "
              f"(bg-mode={args.bg_mode})")
        results = slice_multi(args.input, args.output_root, args.bg_mode)
        total = sum(len(v) for v in results.values())
        print(f"Done: {total} PNG(s) across {len(results)} color(s).")
    else:
        if not args.output or not args.color:
            ap.error("single-color mode requires --output and --color")
        print(f"Slicing '{args.input}' -> '{args.output}' "
              f"(color={args.color}, bg-mode={args.bg_mode})")
        saved = slice_sheet(args.input, args.output, args.bg_mode,
                            keep_extras=not args.no_extras)
        print(f"Done: {len(saved)} PNG(s) written.")


if __name__ == "__main__":
    main()
