// SPDX-License-Identifier: Apache-2.0
/**
 * PanoChrome — Pano's AR pill and lens switcher, for a surface that must look
 * EXACTLY like Pano and cannot mount Pano's `<Camera>`.
 *
 * ── WHY THIS FILE EXISTS, AND WHY IT IS NOT A CLONE BY CHOICE ─────────────
 * Owner, 2026-09-03: "I want the UI for pano+ to be EXACTLY same as pano. One
 * AR pill and show the lens switcher if AR is off." Pano's pill and switcher
 * are `ARToggle` and `LensChip` inside `react-native-image-stitcher`'s
 * `Camera.tsx` (:1329 and :1187). Neither is exported from that package's
 * `src/index.ts` — only `CameraShutter` is — and the stitcher is the PUBLIC
 * repo: widening its API for a private capture surface, or carrying a patch
 * to do it, is the boundary this project does not cross (the patch overlay is
 * machine-checked empty apart from one sanctioned stopgap; see
 * `host-app/__tests__/stitcherPatchesEmpty.test.ts`). So the two
 * components are reproduced here style-for-style and label-for-label, with
 * the source line cited beside every number, the same way `panoPlusModel.ts`
 * re-declares the stitcher's orientation model. The SHUTTER is not reproduced
 * — it IS exported, and the surface uses the real one.
 *
 * ══ THE RULE THESE PILLS ARE SHOWN UNDER — SETTLED ════════════════════════
 * THESE PILLS ARE PANO'S COMPONENTS, AND SINCE 2026-09-03 SO IS THE STATE THEY
 * ARE SHOWN IN. The owner was shown the two asymmetries this block used to
 * record as open, and the mirror-of-Pano mapping that closes them, and CHOSE
 * THE MAPPING:
 *
 *   "Adopt Pano's real rule": the lens chip is ALWAYS VISIBLE on BOTH arms,
 *   and the AR pill is gated on `lens === '1x'` — so tapping 0.5× moves pano+
 *   to the non-AR (decoupled) arm automatically, exactly as picking 0.5× in
 *   Pano drops you out of AR.
 *
 * That is Pano's own shape, read off the source rather than assumed: `LensChip`
 * renders whenever `!arOnly` (`Camera.tsx:3336`, and the shell passes
 * `captureSources="both"` at `:4607`), so the chip is on screen with AR ON —
 * visible as `0.5× | 1×` in the A35 device screenshot
 * (`B-reference-visioncamera.png`, 2026-09-02) with Pano defaulting to
 * `defaultCaptureSource="ar"` — while `ARToggle` carries `lens === '1x'` in its
 * gate (`:3382`). The earlier reading ("show the switcher if AR is off") had
 * the gate on the wrong control; it was written believing Pano hides its chip
 * under AR, and Pano does the opposite.
 *
 * WHERE IT LANDS IN pano+ is `PanoPlusCaptureSurface`, not here — this file
 * holds the pills, the surface holds the policy — in three terms: the chip
 * paints the lens the RUNNING ARM will open (`effectiveLens`, so the
 * fresh-device default of `panoPlusLens: 'ultraWide'` + `panoPlusPoseSource:
 * 'ar'` paints `1×`, which is what ARCore actually opens); a `0.5×` tap writes
 * BOTH host flags from one handler; and a `1×` tap writes only the lens, so
 * coming back restores the pill OFF and the operator re-arms AR deliberately or
 * not at all.
 *
 * ⚠ ONE ASYMMETRY SURVIVES, AND IT IS FORCED RATHER THAN CHOSEN. PANO DRAWS NO
 * AR PILL AT ALL in the shipped field build: its `ARToggle` is ALSO gated on
 * `!hideBuiltInShutter` (`:3382`) and the shell passes
 * `hideBuiltInShutter={unifiedChrome}` = true (`HostCaptureCamera.tsx:4620`),
 * so in the five-mode bar Pano's top-right holds only the host gear. pano+ draws
 * one there because it MUST — the pill is the only switch between the ARCore and
 * decoupled arms, and pano+ is the mode where that choice exists. Pano cannot
 * GAIN one either: `<Camera>` owns `arPreference` as runtime state
 * (`Camera.tsx:20`), `defaultCaptureSource` sets only the initial value and
 * `onCaptureSourceChange` is a read-out, so a host-drawn pill would have nothing
 * to write to without widening the PUBLIC package's API — the boundary named
 * above. So: same components, same lens rule, one extra control that only one of
 * the two modes has a use for.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ── WHAT IS REPRODUCED, EXACTLY ───────────────────────────────────────────
 *  · `ARToggle` (`Camera.tsx:1329-1372`): a `Pressable` with
 *    `accessibilityRole="switch"`, label `AR mode on|off`, `checked` state;
 *    pad 14×8, radius 16, `rgba(0,0,0,0.45)`, minWidth 56; ON = `#ffd34d`
 *    background + `#1a1a1a` text; label 13/700, letterSpacing 1.
 *  · `LensChip` (`Camera.tsx:1187-1310`, the two-lens branch): a row
 *    container `rgba(0,0,0,0.45)` radius 18 pad 3 `alignSelf: center`; two
 *    `Pressable` pills pad 12×6 radius 14 minWidth 44, active `#ffd34d`;
 *    labels 13/600 white, active `#1a1a1a`; a11y `0.5x ultra-wide lens` /
 *    `1x wide-angle lens` with `selected` state.
 *
 * ⚠ ONE KNOWN NON-PARITY, AND IT IS THE ULTRA-WIDE LABEL. Pano prints the
 * device's REPORTED factor when it has one — `${ultraWideFactor}×`, so `0.6×`
 * on a body that reports 0.6 — and falls back to the literal `0.5×` only when
 * it does not (`Camera.tsx:1199-1202`, fed from `capture.ultraWideFactor` at
 * `:3345`). That number comes from vision-camera's device list, which this arm
 * does not run through, and it is NOT recoverable from what pano+ does have:
 * the native `PanoPlusLensCandidate` carries a horizontal FOV, which is a
 * different quantity from a zoom factor and would print a different number.
 * So this chip is hard-wired to `0.5×` and is Pano's label only on hardware
 * that reports 0.5 or reports nothing — every phone this arm has run on,
 * including the A35, but not a guarantee. Closing it needs the factor carried
 * through the bridge beside `lensAvail`, not a cleverer fallback here.
 *  · The GLYPH rotation (`Camera.tsx:1245, :1265, :1342`): Pano applies
 *    `useContentRotation()` to the label `<Text>` of each pill so the glyph
 *    reads upright when a portrait-locked host is held sideways, while the
 *    CONTAINER stays put. That is the only thing on Pano's screen that turns
 *    with the hold, and it is the only thing that turns here.
 *
 * ── THE SINGLE-LENS BRANCH, AND WHOSE `has0_5x` IT READS ──────────────────
 * Pano collapses the chip to a static `1×` when the device publishes no
 * ultra-wide (`Camera.tsx:1203-1227`), reading `selectCaptureDevice`'s
 * `has0_5x` — a vision-camera fact, and pano+ does not run through
 * vision-camera. Its own answer is `panoPlusLensAvailability()`
 * (`panoplus/panoPlusCalibration.ts`), which asks the SAME selector the sweep
 * and the idle viewfinder open through (`RNISPanoAvfSource.planFormat`) once
 * per lens; on Android it is `null` and both pills stand, because there the
 * recorder resolves the camera.
 *
 * ⚠ WITH ONE DEPARTURE FROM PANO, AND IT IS A GUARD, NOT A PATH. Pano's lens
 * state cannot BE `0.5x` when `has0_5x` is false — the chip is its only
 * writer and never offers the pill. pano+'s lens is a PERSISTED HOST FLAG
 * (`panoPlusLens`) that can already name a lens this body does not publish,
 * and a chip that dropped the SELECTED pill would show a selection the
 * operator cannot see and cannot move. So a pill is dropped only when it is
 * not the current selection.
 *
 * ⚠ AND THAT GUARD IS NOT ENOUGH ON ITS OWN — A CLAIM THIS BLOCK MADE AND THE
 * SURFACE DISPROVED. It used to end here, arguing that never dropping the
 * SELECTED pill "is the only thing standing between a refused lens and a chip
 * the operator cannot move off". It is not, because it drops the OTHER one:
 * with the selection on `0.5x` and the wide refused, `show1x` is false, the
 * single-lens branch below renders a static `Text` with NO `Pressable`, and
 * the chip is mounted, visible, and inert. Pair that with the AR pill hidden
 * by its own `lens === '1x'` gate and the surface has no writer for either
 * flag — measured on 2026-09-03: one 0.5× tap left the whole screen with a
 * single pressable, the arm notice's expand/collapse, which moves nothing, and
 * both flags persist across a relaunch.
 *
 * What actually closes it is one term in the SURFACE's pill gate
 * (`chipCanMoveLens`): the AR pill is drawn under Pano's rule OR whenever
 * nothing else on screen can write a flag, so exactly one control always
 * survives. That is the one deliberate deviation from `:3382`, and it exists
 * because Pano cannot reach the state it guards — Pano's lens is chip-owned
 * and therefore always a lens the chip can move off, while pano+'s is a
 * persisted flag that can name a lens this body does not publish. On a body
 * publishing both lenses — every phone this arm has run on — none of this is
 * reachable and the chip is Pano's, pill for pill.
 *
 * ── WHAT IS DELIBERATELY NOT HERE ─────────────────────────────────────────
 * The `0.5×⤢` native hand-off (`Camera.tsx:1206-1218`) — it opens the OS
 * camera app for a STILL, and there is no such hand-off for a sweep — and
 * `hideWhenSingle`, which is Pano's host's choice and not one pano+'s host is
 * offered. The AR pill's `arAllowed && nonArAllowed && lens === '1x' &&
 * isARSupportedOnDevice` gate (:3382) is Pano's policy for when to OFFER the
 * toggle and lives in the surface that decides, not in the pill — along with
 * the escape term above, and with the rule that LEAVING AR commits the lens
 * the chip was painting. Both are consequences of the pill being gated on the
 * lens, and both are the surface's business: this file draws pills.
 */

import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { TextStyle } from 'react-native';

/** Pano's `CameraLens` — `'1x' | '0.5x'` (`Camera.tsx:172`). Re-declared
 *  rather than imported for the reason the module doc gives. */
export type PanoLens = '1x' | '0.5x';

/**
 * The glyph rotation as a ready-to-spread text style — the stitcher's
 * `useContentRotation()` return shape: an EMPTY object in the 0° case so
 * React skips the layout work, else a single `rotate`.
 */
export function panoGlyphRotationStyle(deg: number): Pick<TextStyle, 'transform'> {
  return deg === 0 ? {} : { transform: [{ rotate: `${deg}deg` }] };
}

export interface PanoArToggleProps {
  /** Filled (`#ffd34d`) when on — Pano's `arPreference`. */
  arEnabled: boolean;
  onToggle: () => void;
  /** `panoPlusGlyphRotationDeg` — applied to the `AR` glyph only. */
  glyphRotateDeg?: number;
  testID?: string;
}

/** Pano's AR pill — `ARToggle`, `Camera.tsx:1329-1349`. */
export function PanoArToggle({
  arEnabled,
  onToggle,
  glyphRotateDeg = 0,
  testID,
}: PanoArToggleProps): React.JSX.Element {
  return (
    <Pressable
      onPress={onToggle}
      accessibilityRole="switch"
      accessibilityLabel={`AR mode ${arEnabled ? 'on' : 'off'}`}
      accessibilityState={{ checked: arEnabled }}
      style={[arToggleStyles.container, arEnabled && arToggleStyles.containerOn]}
      testID={testID}>
      <Text
        style={[
          arToggleStyles.label,
          arEnabled && arToggleStyles.labelOn,
          panoGlyphRotationStyle(glyphRotateDeg),
        ]}>
        AR
      </Text>
    </Pressable>
  );
}

// `Camera.tsx:1351-1372`, verbatim.
const arToggleStyles = StyleSheet.create({
  container: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 16,
    backgroundColor: 'rgba(0,0,0,0.45)',
    minWidth: 56,
    alignItems: 'center',
  },
  containerOn: {
    backgroundColor: '#ffd34d',
  },
  label: {
    color: '#ffffff',
    fontSize: 13,
    fontWeight: '700',
    letterSpacing: 1,
  },
  labelOn: {
    color: '#1a1a1a',
  },
});

export interface PanoLensChipProps {
  lens: PanoLens;
  onChange: (lens: PanoLens) => void;
  /** `panoPlusGlyphRotationDeg` — applied to the two label glyphs only. */
  glyphRotateDeg?: number;
  /**
   * Pano's own prop name: can this body open the 0.5× ultra-wide? Default
   * `true` = "nobody said otherwise, offer it" — the answer on Android and on
   * any build whose native cannot be asked, where hiding a pill would be a
   * hardware claim made out of silence.
   */
  has0_5x?: boolean;
  /**
   * The mirror, which Pano has no prop for because vision-camera cannot
   * produce a body without a wide. `RNISPanoAvfSource` can REFUSE one —
   * `panoplus-no-wide`, or a wide with no 4:3 format at 60 fps — and a pill
   * the sweep would refuse is a pill that lies.
   */
  has1x?: boolean;
  testID?: string;
}

/** Pano's lens switcher — `LensChip`, `Camera.tsx:1187-1272`. */
export function PanoLensChip({
  lens,
  onChange,
  glyphRotateDeg = 0,
  has0_5x = true,
  has1x = true,
  testID,
}: PanoLensChipProps): React.JSX.Element {
  const glyph = panoGlyphRotationStyle(glyphRotateDeg);
  // A pill shows when the body can open that lens OR when it is the current
  // selection — see the module doc: dropping the selected pill would strand
  // the flag on a lens with no control left to move it off. One of the two is
  // always the selection, so the chip is never empty.
  const show0_5x = has0_5x || lens === '0.5x';
  const show1x = has1x || lens === '1x';
  if (!show0_5x || !show1x) {
    // Pano's single-lens branch (`Camera.tsx:1222-1227`): a static label, no
    // Pressable, `singleLens` padding. The label is the surviving lens rather
    // than Pano's hard-coded `1×` — which is what it reduces to in the only
    // case vision-camera can produce.
    return (
      <View
        style={[lensChipStyles.container, lensChipStyles.singleLens]}
        testID={testID}>
        <Text style={[lensChipStyles.label, glyph]}>
          {show0_5x ? '0.5×' : '1×'}
        </Text>
      </View>
    );
  }
  return (
    <View style={lensChipStyles.container} testID={testID}>
      <Pressable
        onPress={() => onChange('0.5x')}
        accessibilityRole="button"
        accessibilityLabel="0.5x ultra-wide lens"
        accessibilityState={{ selected: lens === '0.5x' }}
        style={[lensChipStyles.pill, lens === '0.5x' && lensChipStyles.pillActive]}
        testID={testID != null ? `${testID}-0_5x` : undefined}>
        <Text
          style={[
            lensChipStyles.label,
            lens === '0.5x' && lensChipStyles.labelActive,
            glyph,
          ]}>
          0.5×
        </Text>
      </Pressable>
      <Pressable
        onPress={() => onChange('1x')}
        accessibilityRole="button"
        accessibilityLabel="1x wide-angle lens"
        accessibilityState={{ selected: lens === '1x' }}
        style={[lensChipStyles.pill, lens === '1x' && lensChipStyles.pillActive]}
        testID={testID != null ? `${testID}-1x` : undefined}>
        <Text
          style={[
            lensChipStyles.label,
            lens === '1x' && lensChipStyles.labelActive,
            glyph,
          ]}>
          1×
        </Text>
      </Pressable>
    </View>
  );
}

// `Camera.tsx:1275-1310`, the entries the two branches read, verbatim.
const lensChipStyles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    backgroundColor: 'rgba(0,0,0,0.45)',
    borderRadius: 18,
    padding: 3,
    alignSelf: 'center',
  },
  singleLens: {
    paddingHorizontal: 12,
  },
  pill: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 14,
    minWidth: 44,
    alignItems: 'center',
  },
  pillActive: {
    backgroundColor: '#ffd34d',
  },
  label: {
    color: '#ffffff',
    fontSize: 13,
    fontWeight: '600',
  },
  labelActive: {
    color: '#1a1a1a',
  },
});
