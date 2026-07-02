#!/usr/bin/env python3
"""
slice_sheet.py — 나노바나나(Gemini) 고양이 pose 시트를 개별 PNG로 슬라이스.

원본 시트 특징 (중요):
  - mode 는 RGBA 이지만 alpha 가 전부 255 (완전 불투명).
  - "투명" 배경은 실제 알파가 아니라 체커보드 패턴이 픽셀로 그려져 있음.
    체커보드 = 중립색 (R≈G≈B): 흰색(~254) + 회색(~180).
  - 캐릭터 몸통 크림색은 따뜻한 색 (R>G>B, R-B≈18) → 중립 배경과 구분됨.
  - 외곽선은 진한 갈색 (~66,36,28).
  - 각 셀 하단에 라벨 텍스트(진한 글자)가 baked-in 되어 있음.
  - 일부 캐릭터는 704px 셀 폭을 넘어 옆 (빈) 셀까지 그려져 있음.

슬라이스 파이프라인 (시트 전체 단위):
  1. is_bg 마스크: 중립색(sat<=SAT_TOL) & 밝음(br>=BR_MIN) → 체커보드 배경.
  2. 전경(fg) = ~is_bg. (외곽선+크림몸통+핑크 = 하나의 큰 연결blob,
     라벨 글자/배경 노이즈 = 작은 분리 blob).
  3. 시트 전체에서 4-연결 컴포넌트를 라벨링 → MIN_SIZE 이상만 캐릭터로 채택.
     (라벨/노이즈는 크기로 탈락. 격자 경계로 자르지 않으므로 셀을 넘친
      캐릭터도 온전히 추출됨.)
  4. 각 캐릭터 blob 을 "기대 셀 중심"에 최근접 매칭 → pose 이름 부여.
  5. blob bbox 크롭 후 15% 패딩 정사각 캔버스 중앙 배치 → 512x512.
  6. 배경 alpha=0, 캐릭터 alpha=255 (원본 RGB 유지) → PNG-32.

사용법:
  python3 slice_sheet.py --input tools/slicer/cream_sheet.png \
      --output src/assets/cat/cream --color cream
  # 다른 컬러 시트도 동일 레이아웃이면:
  python3 slice_sheet.py --input tools/slicer/black_sheet.png \
      --output src/assets/cat/black --color black
"""
from __future__ import annotations

import argparse
import os

import numpy as np
from PIL import Image

# 시트 그리드 (원본 2816x1536 기준: 4열 x 3행)
COLS = 4
ROWS = 3

# 배경/전경 분류 임계값
SAT_TOL = 12    # max-min <= 12 이면 중립색(체커보드)으로 간주
BR_MIN = 150    # 그리고 밝기(max) >= 150 이면 배경 후보

# 캐릭터 컴포넌트 최소 크기(px). 라벨/노이즈(<1000)와 캐릭터(>100k) 사이 갭.
MIN_SIZE = 5000

# 정규화 파라미터
OUT_SIZE = 512
PAD_FRAC = 0.15  # 최종 캔버스 각 변 15% 여백 (캐릭터가 70% 차지)

# 셀 (row, col) -> 파일명.
#   None = 빈 셀.
#   시트 1행 마지막(0,3)과 2행 첫(1,0) 둘 다 라벨이 run_right_a 였음.
#   → 실제 leap 자세인 (1,0)을 정식 run_right_a 로 채택,
#     (0,3)은 run_stretch_alt(extra)로 보존 (manifest 정식 pose 에는 미포함).
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

# manifest 에 들어가는 정식 pose (extra 제외)
EXTRAS = {"run_stretch_alt"}
CANONICAL_POSES = [
    "sit_forward", "walk_right_a", "walk_right_b",
    "run_right_a", "run_right_b", "sleep_curled",
    "alert_arched", "angry_hiss", "exhausted_lie",
]


def background_mask(rgb: np.ndarray) -> np.ndarray:
    """중립색 & 밝은 픽셀 = 체커보드 배경 후보 (bool HxW)."""
    mx = rgb.max(axis=2)
    mn = rgb.min(axis=2)
    sat = mx.astype(np.int16) - mn.astype(np.int16)
    return (sat <= SAT_TOL) & (mx >= BR_MIN)


def label_components(fg: np.ndarray):
    """fg(bool HxW) 의 4-연결 컴포넌트를 라벨링.

    scipy 없이 numpy + iterative flood(stack) 로 구현.
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
    # 배경 alpha 0, 전경 alpha 255
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


def slice_sheet(input_path: str, output_dir: str, keep_extras: bool = True):
    im = Image.open(input_path).convert("RGBA")
    W, H = im.size
    cw = W // COLS
    ch = H // ROWS
    arr = np.asarray(im)
    rgb = arr[:, :, :3].astype(np.int16)

    is_bg = background_mask(rgb)
    fg = ~is_bg
    labels, comps = label_components(fg)

    big = [(cid, size, cy, cx) for (cid, size, cy, cx) in comps if size >= MIN_SIZE]
    print(f"  detected {len(big)} character blob(s) (>= {MIN_SIZE}px)")

    centers = expected_centers(cw, ch)
    # 각 blob -> 최근접 기대중심 (greedy, 이미 배정된 이름은 스킵)
    assigned: dict[str, int] = {}  # name -> comp id
    for cid, size, cy, cx in big:
        best_name = None
        best_d = None
        for name, (ey, ex) in centers.items():
            if name in assigned:
                continue
            d = (cy - ey) ** 2 + (cx - ex) ** 2
            if best_d is None or d < best_d:
                best_d = d
                best_name = name
        if best_name is None:
            print(f"  [warn] blob id={cid} size={size} unmatched (all names taken)")
            continue
        assigned[best_name] = cid

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


def main():
    ap = argparse.ArgumentParser(description="Slice cat pose sheet into individual PNGs.")
    ap.add_argument("--input", required=True, help="input sheet PNG")
    ap.add_argument("--output", required=True, help="output directory")
    ap.add_argument("--color", required=True, help="coat color label (e.g. cream)")
    ap.add_argument("--no-extras", action="store_true", help="skip extra poses (run_stretch_alt)")
    args = ap.parse_args()

    print(f"Slicing '{args.input}' -> '{args.output}' (color={args.color})")
    saved = slice_sheet(args.input, args.output, keep_extras=not args.no_extras)
    print(f"Done: {len(saved)} PNG(s) written.")


if __name__ == "__main__":
    main()
