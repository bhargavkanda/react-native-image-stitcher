// SPDX-License-Identifier: Apache-2.0
/**
 * The sweep screen's styles (M7) — shared by the `PanoPlusCaptureSurface`
 * composite and `SweepHoldOverlay`. Moved verbatim.
 */
import { StyleSheet } from 'react-native';


// ⚠ `PREVIEW_MARKER_PX` LIVED HERE UNTIL 2026-09-03, with the frontier line.
export const sweepSurfaceStyles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: '#000' },
  /** Host arm: the camera is a sibling BEHIND this surface — see the
   *  root's comment. Opaque here means a black screen. */
  fillOverHost: { backgroundColor: 'transparent' },
  cameraOff: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cameraOffText: { color: '#8a8a8a', fontSize: 13 },
  // POSITION AND SIZE COME FROM `panoPlusPreviewLayout`, not from here. A
  // hard-coded box is what made a tall panorama invisible, and a hard-coded
  // box cannot be unit-tested.
  //
  // ⚠ THE HAIRLINE BORDER WAS REMOVED ON 2026-09-03 (it was
  // `rgba(255,255,255,0.25)`). While the frame HUGGED the panorama's aspect
  // that border sat exactly on the canvas extent and moved outward with every
  // publish — the operator's SECOND "changing boundary", the one he could not
  // name a colour for. `rgba(0,0,0,0.55)` is kept because it is the slit-scan
  // band's own capsule fill (`PanoramaBandOverlay.tsx:263`), and it is now a
  // FIXED rectangle, so it reads as chrome rather than as a live edge.
  previewFrame: {
    position: 'absolute',
    borderRadius: 8,
    overflow: 'hidden',
    backgroundColor: 'rgba(0,0,0,0.55)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  // No padding here: `panoPlusPreviewLayout` has already taken
  // `PREVIEW_BAND_PADDING` off the frame to build `inner`, so a style inset
  // would double it.
  previewImage: { position: 'absolute' },
  /** The box the in-frame notices live in: the frame itself, filled. (It was
   *  a centred, chrome-rotated transpose of the frame until 2026-09-03.) */
  previewNoticeInner: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 8,
  },
  /** The load-failure line sits at the bottom of the rotated box rather than
   *  its middle: it appears UNDER a preview that did arrive, so it must not
   *  land across the panorama's centre. */
  previewNoticeBottom: { justifyContent: 'flex-end', paddingBottom: 4 },
  previewPlaceholderText: {
    color: '#b9b9b9',
    fontSize: 10,
    textAlign: 'center',
  },
  previewErrorText: {
    color: '#ff6b6b',
    fontSize: 9,
    textAlign: 'center',
  },
  // ⚠ `previewMarkerInner` / `previewMarker` / `previewWindowText` LIVED HERE
  // UNTIL 2026-09-03 — the blue frontier line, its container, and the type
  // both its caption and the window caption used. All three are gone with the
  // diagnostics they drew.
  hud: { position: 'absolute' },
  guidanceHeadline: { color: '#e8e8e8', fontSize: 15, fontWeight: '700' },
  guidanceDetail: { color: '#b9b9b9', fontSize: 11, marginTop: 2 },
  toneWarn: { color: '#ffcf6b' },
  toneStop: { color: '#ff6b6b' },
  hudText: {
    color: '#7fd7ff',
    fontSize: 10,
    marginTop: 8,
    fontVariant: ['tabular-nums'],
  },
  hudDrops: { color: '#ffcf6b', fontSize: 10, marginTop: 2 },
  hudError: { color: '#ff6b6b', fontSize: 11, marginTop: 6 },
  // The selected-arm banner. Sized between the guidance headline and the HUD
  // rows: it is a precondition, read once before the tap, not a live readout.
  armHeadline: {
    color: '#7fd7ff', fontSize: 12, fontWeight: '700', marginTop: 8,
  },
  armDetail: { color: '#b9b9b9', fontSize: 10, marginTop: 2 },
  // The expander's handle. Dimmer than the detail it opens — it is a control
  // for a bench read, and it must not compete with the headline above it for
  // the operator's eye at a shelf.
  armMore: { color: '#8a8a8a', fontSize: 10, marginTop: 2 },
  // ── THE UNCORRECTED-SWEEP CHIP ──────────────────────────────────────────
  // Loud on purpose and NOT in the palette anything else uses: the blue rows
  // are live readouts, amber is a degraded-but-working state, red is a fault.
  // This is none of those — it is a run whose RESULT must not be read as a
  // calibrated one, and it stays on screen for the whole sweep.
  experimentChip: {
    color: '#101010',
    backgroundColor: '#c9a0ff',
    fontSize: 10,
    fontWeight: '700',
    marginTop: 8,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 4,
    overflow: 'hidden',
    alignSelf: 'flex-start',
  },
  // ── PANO'S CHROME POSITIONS, CITED ──────────────────────────────────────
  /** The stitcher's `pillStack` (`Camera.tsx:3844-3849`): absolute, pinned
   *  `right: 14`, a column so a second pill would stack under the first.
   *  `top` is supplied inline from `pillStackTop`. */
  pillStack: {
    position: 'absolute',
    right: 14,
    alignItems: 'flex-end',
    gap: 10,
  },
  /** The stitcher's `bottomBar` + `bottomBarCenter` (`Camera.tsx:3807-3821`)
   *  collapsed to the centre column: lens chip above, shutter below. `bottom`
   *  is supplied inline from `bottomBarBottom`. */
  bottomBar: {
    position: 'absolute',
    left: 0,
    right: 0,
    paddingHorizontal: 18,
    alignItems: 'center',
  },
  /** `Camera.tsx:3826` — the gap between the chip and the shutter under it. */
  shutterWrap: { marginTop: 12 },
  unavailable: {
    flex: 1,
    backgroundColor: '#000',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 28,
  },
  unavailableTitle: {
    color: '#ffcf6b',
    fontSize: 17,
    fontWeight: '700',
    marginBottom: 10,
  },
  unavailableBody: {
    color: '#c8c8c8',
    fontSize: 12,
    lineHeight: 18,
    textAlign: 'center',
    marginBottom: 22,
  },
});
