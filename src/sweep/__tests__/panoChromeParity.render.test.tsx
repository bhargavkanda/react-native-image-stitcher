// SPDX-License-Identifier: Apache-2.0
//
// THE SWEEP'S BOTTOM ANCHOR IS `<Camera>`'S — checked against `Camera.tsx`,
// not claimed.
//
// ── WHAT IS LEFT OF THIS FILE (M10) ────────────────────────────────────────
//
// This file used to pin the sweep's CLONE of Pano's chrome — `PanoArToggle` /
// `PanoLensChip` in `sweep/chrome.tsx` — style-for-style against `ARToggle` /
// `LensChip` in `Camera.tsx`, plus the one glyph rotation both applied. M10
// deleted the clone with the sweep's second screen: a sweep runs inside
// `<Camera>`, on `<Camera>`'s own pill, chip and shutter, so there is no copy
// left to drift.
//
//   · the clone's justification (upstream exports vs. the copy's `has1x` /
//     `glyphRotateDeg` gap) — clone chrome, deleted in M10;
//   · the AR pill / lens chip style fidelity and accessibility contract —
//     clone chrome, deleted in M10;
//   · "only the glyph turns" on the clone's pills — clone glyph rotation,
//     deleted in M10.
//
// ONE CASE SURVIVES, because the mechanism it pins still exists: the bottom
// anchor. On the sweep engine `<Camera>` docks its own lens chip at
// `panoLensChipBottomPt` (and its hatch shutter at the same bar inset), and
// the hold overlay keeps the preview and HUD above `panoBottomChromePt`. Both
// are built on `PANO_BOTTOM_BAR_INSET`. On the keyframe engine `<Camera>`'s
// bottom area is `insets.bottom + N` (`bottomAreaStyleForEdge`). If the two
// ever differ, `<Camera>`'s chrome sits at a different height depending on
// which engine is selected — so N is read from the source and compared.
//
// ⚠️ THIS FILE MUST LIVE IN `__tests__/` — the BUILD config's `**/*.test.ts`
// exclude does not match `.tsx`, so a render test beside its component
// compiles into `dist/` and breaks `npm run build` on react-test-renderer's
// missing declarations. Its siblings carry the same warning.

import * as fs from 'fs';
import * as path from 'path';

import { panoBottomChromePt, panoLensChipBottomPt } from '../sweepLayout';

/**
 * `Camera.tsx`'s source, read by PATH rather than through the module system:
 * the render project maps the package barrel to a mock, and this check is
 * about the real file.
 */
function cameraSource(): string {
  const camera = path.resolve(__dirname, '../../camera/Camera.tsx');
  if (!fs.existsSync(camera)) {
    // Not a skip — a green run over nothing is the failure this guards.
    throw new Error(`Camera.tsx not found at ${camera}`);
  }
  return fs.readFileSync(camera, 'utf8');
}

describe('the sweep anchors its bottom chrome where <Camera> anchors its bar', () => {
  it('uses the SAME bar inset as <Camera>\'s keyframe bottom area', () => {
    // THE ONE NUMBER THAT PUT THE TWO CHIPS AT DIFFERENT HEIGHTS. `<Camera>`'s
    // bottom area is `paddingBottom: insets.bottom + N` (the
    // `bottomAreaStyleForEdge` call), the inner bar adds no vertical padding
    // on the bottom edge, and both engines lift it by the same
    // `bottomBarOffset` — so N is the whole of the anchor and the sweep must
    // use it verbatim. It was once hardcoded to 16 from a uiautomator dump
    // that had measured the PILL rather than its row container, which is
    // 3 pt larger, and 4 pt of that error went straight into the gap between
    // the modes.
    //
    // Read from the source so the number cannot drift silently: if `<Camera>`
    // moves its bar, this fails and names the new value.
    const m = cameraSource().match(
      /bottomAreaStyleForEdge\(\s*homeIndicatorEdge\([^)]*\),\s*insets\.bottom \+ (\d+)/,
    );
    expect(m).not.toBeNull();
    const barInset = Number(m![1]);
    // `<Camera>`'s lens chip on the sweep engine docks at this slot. With the
    // built-in shutter hidden, the slot starts at the bar inset itself.
    expect(panoLensChipBottomPt(0, 0, true)).toBe(barInset);
    // The hold overlay's reservation is that slot plus the chip's height
    // (36) and 8 pt of air.
    expect(panoBottomChromePt(0, 0, true) - 44).toBe(barInset);
    // …and both track the safe-area and the offset they are handed, so the
    // whole anchor matches `<Camera>`'s and not just its constant term.
    expect(panoLensChipBottomPt(21, 150, true)).toBe(barInset + 21 + 150);
    expect(panoBottomChromePt(21, 150, true) - 44).toBe(barInset + 21 + 150);
  });
});
