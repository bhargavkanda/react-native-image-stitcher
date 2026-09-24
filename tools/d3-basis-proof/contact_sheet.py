#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
#
# contact_sheet.py — put every arm's replayed canvas for one pack side by side,
# labelled, so the effect of a wrong basis is SEEN and not only read off a
# table.  Needs python3 + opencv-python (cv2) + numpy.
#
#   python3 contact_sheet.py out PP3-124737 [arm ...]
#
# Writes out/contact_<tag>.jpg.  Arms default to every replay/ under out/<tag>/.

import os
import sys

import cv2
import numpy as np


def main() -> int:
    if len(sys.argv) < 3:
        print(__doc__ or "usage: contact_sheet.py <outDir> <tag> [arm ...]")
        return 2
    out_dir, tag = sys.argv[1], sys.argv[2]
    root = os.path.join(out_dir, tag)
    arms = sys.argv[3:] or sorted(
        d for d in os.listdir(root) if os.path.isdir(os.path.join(root, d, "replay"))
    )
    target_h = 900
    tiles = []
    for arm in arms:
        p = os.path.join(root, arm, "replay", "canvas.jpg")
        img = cv2.imread(p) if os.path.exists(p) else None
        if img is None:
            img = np.full((target_h, 300, 3), 40, np.uint8)
            cv2.putText(img, "no canvas", (20, target_h // 2), cv2.FONT_HERSHEY_SIMPLEX,
                        1.0, (0, 0, 255), 2)
        else:
            s = target_h / img.shape[0]
            img = cv2.resize(img, (max(1, int(img.shape[1] * s)), target_h),
                             interpolation=cv2.INTER_AREA)
        label = np.full((60, img.shape[1], 3), 255, np.uint8)
        cv2.putText(label, arm, (10, 42), cv2.FONT_HERSHEY_SIMPLEX, 1.2, (0, 0, 0), 2)
        tiles.append(np.vstack([label, img]))
        tiles.append(np.full((target_h + 60, 12, 3), 255, np.uint8))
    # Wrap at four canvases a row so a sheet stays legible at screen width.
    tiles = tiles[:-1]
    per_row = 4 * 2 - 1   # four canvases and the three gutters between them
    rows = [tiles[i:i + per_row + 1] for i in range(0, len(tiles), per_row + 1)]
    rows = [r[:-1] if r and r[-1].shape[1] == 12 else r for r in rows]
    strips = [np.hstack(r) for r in rows]
    width = max(s.shape[1] for s in strips)
    strips = [np.hstack([s, np.full((s.shape[0], width - s.shape[1], 3), 255, np.uint8)])
              if s.shape[1] < width else s for s in strips]
    gap = np.full((20, width, 3), 255, np.uint8)
    sheet = strips[0]
    for s in strips[1:]:
        sheet = np.vstack([sheet, gap, s])
    dst = os.path.join(out_dir, f"contact_{tag}.jpg")
    cv2.imwrite(dst, sheet, [cv2.IMWRITE_JPEG_QUALITY, 85])
    print(dst)
    return 0


if __name__ == "__main__":
    sys.exit(main())
