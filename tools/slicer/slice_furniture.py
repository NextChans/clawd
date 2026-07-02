#!/usr/bin/env python3
"""
slice_furniture.py — 나노바나나(Gemini) 고양이 *가구* 시트를 개별 PNG로 슬라이스.

원본 시트(`furniture_sheet.png`, 2816x1536)는 고양이 pose 시트와 같은 스타일:
  - RGBA 이지만 alpha 전부 255. "투명" 배경은 실제 알파가 아니라
    체커보드(중립색·밝음)가 픽셀로 그려져 있음.
  - 외곽선은 진한 검정/갈색. 각 아이템 하단에 라벨 텍스트가 baked-in.

레이아웃(고양이 pose 시트와 달리 색상별 quadrant 그리드가 아님):
  좌/우 = 색 그룹, 세로로 furniture 행이 쌓임. 행 투영으로 측정한 밴드:

    A  y107-389 : black(좌) · orange(우)  타워 행  (T1 T2 T2 T3)
    B  y522-742 : black(좌) · orange(우)  쿠션 행  (C1 C2 C2/C3 C3)
    C  y860-1071: gray(좌)  · white(우)   타워 행  (T1 T2 T3 C3cave …)
    D  y1131-1261: gray(좌)만            밥그릇 상단행 (B1 B2 B3)
       (밥그릇은 gray 그룹에만 존재 → 다른 색은 코드에서 gray fallback)

  각 색 그룹(좌/우 half) 안에서 4열. 열 중심 ~0.155 / 0.395 / 0.62 / 0.855.

task가 채택한 대표 3종:
  tower   = T2 Cat_Tower_Platform  (타워 행 col1)
  cushion = C3 Cat_Cushion_Cave    (쿠션/타워 행 마지막 열 col3)
  bowl    = B3 Food_Bowl_double    (gray 밥그릇 상단행 col3, 나무 스탠드 2구)

추출 파이프라인 (ROI = 행밴드 × 열범위 단위, blob 분류 대신 ROI 최근접):
  1. 시트 전체 배경 마스크(border flood)로 fg 계산 (slice_sheet.py 방식 재사용).
  2. 각 타깃 ROI 안에서 fg 4-연결 컴포넌트 라벨링 → 최대 컴포넌트 채택
     (라벨 텍스트/노이즈는 크기로 탈락, 인접 아이템은 열범위로 배제).
  3. 컴포넌트 bbox 크롭 → 15% 패딩 정사각 512x512, 투명 PNG-32.

저장: src/assets/furniture/{color}/{tower,cushion,bowl}.png
  color ∈ {black, orange_tabby, gray_tabby, white}.  cream 은 시트에 없음 → skip.

사용법:
  python3 tools/slicer/slice_furniture.py \
      --input tools/slicer/furniture_sheet.png \
      --output-root src/assets/furniture
"""
from __future__ import annotations

import argparse
import os

import numpy as np
from PIL import Image

# 배경후보(중립·밝음) 판정 임계값 (slice_sheet.py 와 동일).
SAT_TOL = 18
BR_MIN = 150

# 가구 컴포넌트 최소 크기(px). 라벨 텍스트(<수백~수천)와 아이템 사이 갭.
MIN_SIZE = 3000

# 정규화 파라미터 (고양이 스프라이트와 동일 스케일).
OUT_SIZE = 512
PAD_FRAC = 0.15

# --- 레이아웃 (전체 시트 절대 좌표, 행 투영으로 측정) -----------------------
# 행 밴드 (y0, y1) — 약간의 패딩 포함.
ROW_A = (100, 395)    # black/orange 타워
ROW_B = (515, 748)    # black/orange 쿠션
ROW_C = (853, 1078)   # gray/white 타워+cave
ROW_D = (1125, 1268)  # gray 밥그릇 상단행

# 색 그룹 half 폭 안에서의 열 범위(프랙션). col1=T2/C2/B2, col3=T3/C3/B3.
COL1 = (0.27, 0.52)
COL3 = (0.72, 1.00)

# (color, kind, row_band, half('L'|'R'), col_range)
TARGETS = [
    ("black", "tower", ROW_A, "L", COL1),
    ("black", "cushion", ROW_B, "L", COL3),
    ("orange_tabby", "tower", ROW_A, "R", COL1),
    ("orange_tabby", "cushion", ROW_B, "R", COL3),
    ("gray_tabby", "tower", ROW_C, "L", COL1),
    ("gray_tabby", "cushion", ROW_C, "L", COL3),
    ("gray_tabby", "bowl", ROW_D, "L", COL3),
    # 밥그릇 상단행(B1~B3)은 크림/베이지 톤 — 나무 스탠드 2구 B3 double 을
    # cream 전용 밥그릇으로도 추출한다. gray_tabby/bowl 과 동일 ROI(같은 그림).
    ("cream", "bowl", ROW_D, "L", COL3),
    ("white", "tower", ROW_C, "R", COL1),
    ("white", "cushion", ROW_C, "R", COL3),
]


def background_candidate(rgb: np.ndarray) -> np.ndarray:
    """중립색 & 밝은 픽셀 = 배경후보 (체커보드) (bool HxW)."""
    mx = rgb.max(axis=2)
    mn = rgb.min(axis=2)
    sat = mx.astype(np.int16) - mn.astype(np.int16)
    return (sat <= SAT_TOL) & (mx >= BR_MIN)


def flood_from_border(cand: np.ndarray) -> np.ndarray:
    """배경후보 중 이미지 4모서리와 4-연결로 이어진 픽셀 = 배경."""
    h, w = cand.shape
    flat = cand.ravel()
    n = h * w
    bg = np.zeros(n, dtype=bool)

    seeds = []
    seeds.extend(np.nonzero(flat[0:w])[0].tolist())
    seeds.extend((np.nonzero(flat[(h - 1) * w:h * w])[0] + (h - 1) * w).tolist())
    seeds.extend((np.nonzero(cand[:, 0])[0] * w).tolist())
    seeds.extend((np.nonzero(cand[:, w - 1])[0] * w + (w - 1)).tolist())

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


def largest_component(fg: np.ndarray):
    """fg(bool HxW) 최대 4-연결 컴포넌트의 마스크(bool HxW)와 크기 반환.

    fg 가 비었으면 (None, 0).
    """
    h, w = fg.shape
    flat = fg.ravel()
    n = h * w
    labels = np.full(n, -1, dtype=np.int32)
    best_id = -1
    best_size = 0
    cid = 0
    for s in np.nonzero(flat)[0].tolist():
        if labels[s] != -1:
            continue
        stack = [s]
        labels[s] = cid
        size = 0
        while stack:
            p = stack.pop()
            size += 1
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
        if size > best_size:
            best_size = size
            best_id = cid
        cid += 1
    if best_id < 0:
        return None, 0
    return (labels.reshape(h, w) == best_id), best_size


def normalize(rgba: np.ndarray, mask: np.ndarray) -> Image.Image:
    """마스크된 아이템을 15% 패딩 정사각 512x512 로 정규화."""
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


def slice_furniture(input_path: str, output_root: str):
    im = Image.open(input_path).convert("RGBA")
    arr = np.asarray(im)
    H, W = arr.shape[:2]
    hw = W // 2  # half width (색 그룹 경계)
    rgb = arr[:, :, :3].astype(np.int16)

    print(f"Slicing furniture '{input_path}' ({W}x{H}) -> '{output_root}'")
    fg_full = ~flood_from_border(background_candidate(rgb))

    saved: dict[str, list[str]] = {}
    for color, kind, (ry0, ry1), half, (cf0, cf1) in TARGETS:
        x_off = 0 if half == "L" else hw
        x0 = x_off + int(cf0 * hw)
        x1 = x_off + int(cf1 * hw)
        sub_rgba = arr[ry0:ry1, x0:x1]
        sub_fg = fg_full[ry0:ry1, x0:x1]

        mask, size = largest_component(sub_fg)
        if mask is None or size < MIN_SIZE:
            print(f"  [warn] {color}/{kind}: no component >= {MIN_SIZE}px "
                  f"(got {size}) in ROI y[{ry0}-{ry1}] x[{x0}-{x1}] — skip")
            continue

        out_dir = os.path.join(output_root, color)
        os.makedirs(out_dir, exist_ok=True)
        img = normalize(sub_rgba, mask)
        out_path = os.path.join(out_dir, f"{kind}.png")
        img.save(out_path)
        size_kb = os.path.getsize(out_path) / 1024
        saved.setdefault(color, []).append(kind)
        print(f"  [ok] {color}/{kind}.png  {size_kb:6.1f} KB  (blob {size}px)")

    return saved


def main():
    ap = argparse.ArgumentParser(description="Slice cat furniture sheet into PNGs.")
    ap.add_argument("--input", default="tools/slicer/furniture_sheet.png",
                    help="input furniture sheet PNG")
    ap.add_argument("--output-root", default="src/assets/furniture",
                    help="output root dir (per-color subfolders)")
    args = ap.parse_args()

    results = slice_furniture(args.input, args.output_root)
    total = sum(len(v) for v in results.values())
    print(f"Done: {total} PNG(s) across {len(results)} color(s).")
    for color, kinds in sorted(results.items()):
        print(f"  {color}: {', '.join(sorted(kinds))}")


if __name__ == "__main__":
    main()
