// SPDX-License-Identifier: Apache-2.0
/**
 * The sweep screen's layout constants and helpers (M7): shared by
 * `useSweepEngine` (the start bag's frontier-window knee and insets) and the
 * `PanoPlusCaptureSurface` composite. Moved verbatim.
 */
import type { PanoPlusNoticePhase } from './panoPlusCameraOffNotice';

/** The capture phases, and the SAME type `panoPlusCameraOffNotice` keys on —
 *  aliased rather than re-spelled so a new phase cannot be added here and
 *  silently fall through the notice's who-owns-the-camera table. */
export type Phase = PanoPlusNoticePhase;

/**
 * Pano's bottom bar sits this far above the safe-area bottom.
 *
 * READ FROM PANO'S SOURCE, NOT FROM A PIXEL DUMP. `Camera.tsx:3273-3277`
 * passes `insets.bottom + 12` as `bottomAreaStyleForEdge`'s `bottomInsetPx`,
 * applied as `paddingBottom` on the bottom edge (`:3705-3723`); the inner bar
 * adds `paddingVertical: 0` there (`bottomBarStyleForEdge`, `:3774-3782`) and
 * is lifted by the same `bottomBarOffset` this surface is given. So Pano's bar
 * bottom is `insets.bottom + 12 + bottomBarOffset`, and this constant is that
 * 12.
 *
 * ⚠ IT WAS 16, derived from a uiautomator dump of Pano's chip on the A35, and
 * that was 4 pt (≈11 px on this phone) too high: the dump measured the PILL,
 * which sits 3 pt inside its row container (`lensChipStyles.container`'s
 * `padding: 3`, `Camera.tsx:1280`), so the residual it attributed to bar
 * padding was mostly the chip's own. Both bars are bottom-anchored with the
 * same offset and nothing compensates downstream, so the error landed
 * straight in the gap between the two modes.
 */
export const PANO_BOTTOM_BAR_INSET = 12;
/** Pano's lens chip, measured on the same dump: 85 px / 2.816 px·pt⁻¹ ≈ 30 pt;
 *  36 leaves a hairline of slack for a taller font. */
const PANO_LENS_CHIP_HEIGHT = 36;
/** `CameraShutter`'s outer touch target (`CameraShutter.tsx:281-286`) plus the
 *  stitcher's `shutterWrap` gap above it (`Camera.tsx:3826`). */
const PANO_SHUTTER_HEIGHT = 76 + 12;

/**
 * Points of Pano's bottom stack the preview and HUD must stay above, from the
 * bottom edge of the window. The chip's slot is counted whether the chip is
 * shown or not, so toggling AR never moves the HUD; the built-in shutter is
 * counted only when this surface draws it.
 */
export function panoBottomChromePt(
  insetBottom: number,
  bottomBarOffset: number,
  hideBuiltInControls: boolean,
): number {
  return panoLensChipBottomPt(insetBottom, bottomBarOffset, hideBuiltInControls)
    + PANO_LENS_CHIP_HEIGHT
    + 8;
}

/**
 * Where the LENS CHIP's slot starts, in points from the bottom edge.
 *
 * ⚠ EXPORTED BECAUSE `<Camera>` NOW DRAWS THE CHIP AND WAS GUESSING. Its
 * dock was a literal `bottom: 132` under a comment claiming the two sides
 * "agree by construction" via `bottomBarOffset` — they did not agree and
 * nothing connected them. A hardcoded offset against a slot computed from
 * four variables is the lens chip landing on the shutter as soon as a host
 * sets `bottomBarOffset`, and the mutation confirmed no test could see it:
 * `bottom: 132` → `bottom: 0` (the chip fully under the shutter) left the
 * whole suite green.
 *
 * `panoBottomChromePt` is now defined in terms of THIS, so the slot the HUD
 * stays above and the slot the chip sits in cannot drift apart. The sum is
 * unchanged — the terms were only reordered, and addition is commutative.
 */
export function panoLensChipBottomPt(
  insetBottom: number,
  bottomBarOffset: number,
  hideBuiltInControls: boolean,
): number {
  return insetBottom
    + PANO_BOTTOM_BAR_INSET
    + bottomBarOffset
    + (hideBuiltInControls ? 0 : PANO_SHUTTER_HEIGHT);
}

/**
 * The safe-area insets with the HOST's own top chrome added to `top`.
 *
 * Returns `undefined` — not a zeroed object — when there is nothing to say, so
 * `panoPlusPreviewLayout` keeps its "no insets supplied" branch and a host that
 * passes neither is byte-identical to before this existed.
 */
export function withHostChromeTop(
  insets: { top: number; bottom: number; left: number; right: number } | null,
  hostChromeTopPt: number,
): { top: number; bottom: number; left: number; right: number } | undefined {
  // MAX, NOT SUM. Both numbers are measured from the same origin — the top of
  // the window — so the host's banner at `top: 48` ALREADY contains the status
  // bar's 32 pt. Adding them would push the guidance 32 pt further down than
  // anything on screen asks for, which is the same class of error as the
  // overprint, just in the other direction.
  const claimed = hostChromeTopPt > 0 ? hostChromeTopPt : 0;
  if (insets == null) {
    if (claimed === 0) return undefined;
    return { top: claimed, bottom: 0, left: 0, right: 0 };
  }
  if (claimed <= insets.top) return insets;
  return { ...insets, top: claimed };
}
