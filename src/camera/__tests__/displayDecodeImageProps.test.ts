// SPDX-License-Identifier: Apache-2.0
/**
 * Unit test for DISPLAY_DECODE_IMAGE_PROPS — the shared <Image> props that
 * make Android/Fresco decode full-res captures at display size (the
 * accumulation half of the OOM fix).
 *
 * The render-time behaviour (Fresco decoding at display size, native heap
 * staying flat) is on-device-only; what this locks is the contract that
 * BOTH the thumbnail strip and the full-screen preview spread the SAME
 * decode strategy, so the two call sites can't drift.
 */
import { DISPLAY_DECODE_IMAGE_PROPS } from '../displayDecodeImageProps';

describe('DISPLAY_DECODE_IMAGE_PROPS', () => {
  it('requests display-size decode (resizeMethod="resize")', () => {
    expect(DISPLAY_DECODE_IMAGE_PROPS.resizeMethod).toBe('resize');
  });

  it('is a valid <Image> prop bag with no stray keys', () => {
    // Only the decode strategy — nothing that would override a call site's
    // resizeMode / source / style.
    expect(Object.keys(DISPLAY_DECODE_IMAGE_PROPS)).toEqual(['resizeMethod']);
  });
});
