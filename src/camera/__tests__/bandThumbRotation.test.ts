// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for the band/tile orientation-decision functions in
 * `PanoramaBandOverlay` — the pure logic behind the v0.13.1 EXIF
 * double-rotation fix.
 *
 * Why test the pure functions, not a render: the lib's jest config is
 * pure-TS (`ts-jest` + node env, no `@testing-library/react-native`;
 * see jest.config.js header).  The orientation contract lives entirely
 * in `bandThumbRotation` / `tileRotation`, which the component now calls
 * directly — so exercising them here covers the real code path.
 *
 * The bug these guard against:
 *   Saved `keyframe-N.jpg` files are sensor-native LANDSCAPE pixels with
 *   EXIF Orientation = 6 ("rotate 90° CW").  RN's <Image> auto-rotates
 *   them upright.  v0.12 ALSO applied a JS rotate transform to the tiles
 *   → double-rotation → thumbnails 90° off in portrait-locked landscape.
 *   The fix: tiles get NO transform in the portrait-locked
 *   (vertical=false) path; the single cumulative thumb (no EXIF) still
 *   does.
 */

// Mock react-native so importing the SUT module doesn't pull the native
// StyleSheet/Image bridge (we only call the pure functions).  Matches
// the mocking approach in useOrientationDrift.test.ts.
jest.mock('react-native', () => ({
  Image: 'Image',
  ScrollView: 'ScrollView',
  StyleSheet: { create: (s: Record<string, unknown>) => s, absoluteFill: {} },
  Text: 'Text',
  View: 'View',
}));

import {
  _bandThumbRotationForTests as bandThumbRotation,
  _tileRotationForTests as tileRotation,
  type BandCaptureOrientation,
} from '../PanoramaBandOverlay';

const PORTRAIT: BandCaptureOrientation = 'portrait';
const UPSIDE: BandCaptureOrientation = 'portrait-upside-down';
const LEFT: BandCaptureOrientation = 'landscape-left';
const RIGHT: BandCaptureOrientation = 'landscape-right';

describe('bandThumbRotation — single cumulative thumb (no EXIF source)', () => {
  describe('vertical=false (portrait-locked UI)', () => {
    it('does not rotate in portrait', () => {
      expect(bandThumbRotation(PORTRAIT, false)).toBeUndefined();
    });

    it('does not rotate in portrait-upside-down', () => {
      expect(bandThumbRotation(UPSIDE, false)).toBeUndefined();
    });

    it('rotates 90° CW for landscape-left', () => {
      expect(bandThumbRotation(LEFT, false)).toEqual([{ rotate: '90deg' }]);
    });

    it('rotates 90° CCW for landscape-right (opposite sign of left)', () => {
      expect(bandThumbRotation(RIGHT, false)).toEqual([{ rotate: '-90deg' }]);
    });
  });

  describe('vertical=true (non-locked, OS-rotated framebuffer)', () => {
    it('does not rotate in portrait', () => {
      expect(bandThumbRotation(PORTRAIT, true)).toBeUndefined();
    });

    it('uses the OPPOSITE sign from the portrait-locked case (left)', () => {
      // vertical=false → 90deg, so vertical=true → -90deg.
      expect(bandThumbRotation(LEFT, true)).toEqual([{ rotate: '-90deg' }]);
      expect(bandThumbRotation(LEFT, true)).not.toEqual(
        bandThumbRotation(LEFT, false),
      );
    });

    it('uses the OPPOSITE sign from the portrait-locked case (right)', () => {
      expect(bandThumbRotation(RIGHT, true)).toEqual([{ rotate: '90deg' }]);
      expect(bandThumbRotation(RIGHT, true)).not.toEqual(
        bandThumbRotation(RIGHT, false),
      );
    });
  });
});

describe('tileRotation — per-keyframe tiles (EXIF-6 source, the fix)', () => {
  describe('vertical=false (portrait-locked) — the regression case', () => {
    it.each<[BandCaptureOrientation]>([
      [PORTRAIT],
      [UPSIDE],
      [LEFT],
      [RIGHT],
    ])(
      'applies NO transform for %s (EXIF already auto-rotates → no double-rotate)',
      (orientation) => {
        expect(tileRotation(orientation, false)).toBeUndefined();
      },
    );

    it('specifically does NOT rotate landscape tiles (the v0.12 bug)', () => {
      // Pre-fix this returned [{rotate:'90deg'}] / [{rotate:'-90deg'}]
      // on top of the EXIF auto-rotate → tiles 90° off.  Must be undefined.
      expect(tileRotation(LEFT, false)).toBeUndefined();
      expect(tileRotation(RIGHT, false)).toBeUndefined();
    });
  });

  describe('vertical=true (non-locked landscape) — transform still needed', () => {
    it('matches bandThumbRotation in the vertical path', () => {
      // In the OS-rotated case the box is landscape JS coords, 90° off
      // the EXIF-upright tile, so the compensation IS required.
      expect(tileRotation(LEFT, true)).toEqual(bandThumbRotation(LEFT, true));
      expect(tileRotation(RIGHT, true)).toEqual(bandThumbRotation(RIGHT, true));
    });

    it('does not rotate in portrait even when vertical', () => {
      expect(tileRotation(PORTRAIT, true)).toBeUndefined();
    });
  });
});
