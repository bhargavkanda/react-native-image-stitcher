// SPDX-License-Identifier: Apache-2.0
/**
 * DISPLAY_DECODE_IMAGE_PROPS — props every <Image> that displays a
 * FULL-RES capture (a stitched panorama or a photo file) must spread.
 *
 * Why this exists (the accumulation half of the OOM crash):
 *   On Android 8+, decoded bitmap pixels live in the NATIVE heap, and the
 *   source here is the full-resolution capture file — a wide panorama can
 *   be tens of megapixels.  Without `resizeMethod="resize"`, Android/Fresco
 *   decodes the source at FULL resolution into a native bitmap that the
 *   mounted <Image> pins (not LRU-evictable), and Fresco's URI-keyed cache
 *   keeps it even after the view unmounts.  Each capture (especially wide
 *   panoramas) then accumulates tens of MB of native heap until lmkd
 *   OOM-kills the app.  'resize' decodes at the on-screen (~device-width)
 *   size instead, making per-image memory tiny and panorama-size-
 *   independent.  No-op on iOS (harmless).
 *
 * Centralised (rather than a bare `resizeMethod="resize"` at each call
 * site) so the decode strategy + its rationale have one home, and so the
 * contract is unit-testable without mounting a component.  Spread it:
 *   <Image source={...} resizeMode="cover" {...DISPLAY_DECODE_IMAGE_PROPS} />
 */
export const DISPLAY_DECODE_IMAGE_PROPS = {
  resizeMethod: 'resize',
} as const;
