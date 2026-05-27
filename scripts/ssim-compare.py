#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
"""
ssim-compare.py — v0.8.0 Phase 7 SSIM parity gate.

Compares two panorama JPEGs using pixel-wise SSIM (Structural
Similarity Index Measure).  Used to verify that the v0.8.0
worklet-dispatched AR-mode stitching pipeline produces output
equivalent to the v0.7.x baseline — JPEGs need not be byte-
identical (encoder non-determinism) but pixel-wise SSIM must be
>= 0.98 to gate the v0.8.0 tag.

## Usage

    python3 scripts/ssim-compare.py BASELINE.jpg V0.8-OUTPUT.jpg

Exit codes:
    0  — SSIM >= --threshold (default 0.98), parity OK
    1  — SSIM <  threshold, parity FAILED (do not ship)
    2  — usage error / missing file / dependency issue

## Why Pillow + scikit-image

Per the v0.8.0 plan (docs/plans/2026-05-25-v0.8.0-ar-worklet-unified-fp.md
Task 10): "~30 lines using Pillow + scikit-image".  Standard
pair for image-quality comparisons; deterministic; doesn't depend
on macOS-only frameworks (so CI on Linux can run the same gate).

## Install (if missing)

    python3 -m pip install Pillow numpy scikit-image

## Resizing strategy

cv::Stitcher's output dimensions can vary slightly between runs
(seam-finder + warper introduce per-input edge effects).  The two
panoramas being compared MIGHT differ by a few pixels in width /
height.  We resize the larger to match the smaller (LANCZOS
filter; preserves edge structure better than bilinear).

If the size delta is > 5% in either dimension, the script prints
a warning + still computes SSIM — but a delta that large usually
means the panorama dimensions diverged for a reason (different
input frame count, different warper) and the parity test is
unreliable.  Inspect manually.
"""

from __future__ import annotations

import argparse
import os
import sys


def _die(msg: str, exit_code: int = 2) -> None:
    print(f"[ssim-compare] error: {msg}", file=sys.stderr)
    sys.exit(exit_code)


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Compare two panorama JPEGs via pixel-wise SSIM",
    )
    parser.add_argument("baseline", help="Reference image (e.g., v0.7.x output)")
    parser.add_argument("candidate", help="Candidate image (e.g., v0.8.0 output)")
    parser.add_argument(
        "--threshold",
        type=float,
        default=0.98,
        help="SSIM threshold for parity pass (default: 0.98)",
    )
    parser.add_argument(
        "--channel",
        choices=("luma", "rgb"),
        default="luma",
        help="luma = compare grayscale (faster, what cv::Stitcher's "
        "structural quality cares about); rgb = per-channel mean SSIM "
        "(stricter, catches colour-cast regressions)",
    )
    args = parser.parse_args()

    for path in (args.baseline, args.candidate):
        if not os.path.isfile(path):
            _die(f"file not found: {path}")

    # Defer imports so the script can print a clean usage message
    # even when dependencies aren't installed.
    try:
        import numpy as np
        from PIL import Image
        from skimage.metrics import structural_similarity as ssim
    except ImportError as exc:
        _die(
            f"missing dependency ({exc.name}). "
            "Install with: python3 -m pip install Pillow numpy scikit-image",
            exit_code=2,
        )

    baseline_img = Image.open(args.baseline).convert(
        "L" if args.channel == "luma" else "RGB"
    )
    candidate_img = Image.open(args.candidate).convert(
        "L" if args.channel == "luma" else "RGB"
    )

    # Resize to common dims (smaller of the two).  cv::Stitcher's
    # output can vary by a few pixels per input; LANCZOS preserves
    # edge structure.
    bw, bh = baseline_img.size
    cw, ch = candidate_img.size
    target_w = min(bw, cw)
    target_h = min(bh, ch)
    if (bw, bh) != (target_w, target_h):
        baseline_img = baseline_img.resize((target_w, target_h), Image.LANCZOS)
    if (cw, ch) != (target_w, target_h):
        candidate_img = candidate_img.resize((target_w, target_h), Image.LANCZOS)

    # Warn on large size delta.
    max_delta = max(abs(bw - cw) / max(bw, cw), abs(bh - ch) / max(bh, ch))
    if max_delta > 0.05:
        print(
            f"[ssim-compare] WARN: size delta {max_delta * 100:.1f}% — "
            f"baseline {bw}x{bh}, candidate {cw}x{ch}.  SSIM may be "
            "misleading; inspect the panoramas manually.",
            file=sys.stderr,
        )

    baseline = np.asarray(baseline_img)
    candidate = np.asarray(candidate_img)

    if args.channel == "luma":
        score = float(ssim(baseline, candidate, data_range=255))
    else:
        # Mean SSIM across R/G/B channels.  `channel_axis=-1` tells
        # scikit-image the colour channels are the last axis.
        score = float(
            ssim(baseline, candidate, data_range=255, channel_axis=-1)
        )

    passed = score >= args.threshold
    status = "PASS" if passed else "FAIL"
    print(
        f"[ssim-compare] {status}  score={score:.4f}  "
        f"threshold={args.threshold:.4f}  "
        f"channel={args.channel}  "
        f"dims={target_w}x{target_h}"
    )
    sys.exit(0 if passed else 1)


if __name__ == "__main__":
    main()
