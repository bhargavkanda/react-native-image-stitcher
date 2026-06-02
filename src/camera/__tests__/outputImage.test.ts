// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for the pure output-image option resolvers (v0.15).
 *
 * These are the JS-testable unit of the output-controls feature:
 * normalising the host-supplied `outputImage` prop into the values
 * the bridges expect.  The actual pixel resize/encode happens
 * natively (see the plan doc's DRY note) and is covered by on-device
 * verification, not here.
 */
import {
  DEFAULT_JPEG_QUALITY,
  resolveJpegQuality,
  resolveMaxDimensions,
  type OutputImageOptions,
} from '../outputImage';

describe('resolveJpegQuality', () => {
  it('defaults to 90 when options are undefined', () => {
    expect(resolveJpegQuality(undefined)).toBe(DEFAULT_JPEG_QUALITY);
    expect(DEFAULT_JPEG_QUALITY).toBe(90);
  });

  it('defaults to 90 when the object omits jpegQuality', () => {
    expect(resolveJpegQuality({})).toBe(90);
    expect(resolveJpegQuality({ maxWidth: 100 })).toBe(90);
  });

  it('passes through in-range integer values', () => {
    expect(resolveJpegQuality({ jpegQuality: 1 })).toBe(1);
    expect(resolveJpegQuality({ jpegQuality: 50 })).toBe(50);
    expect(resolveJpegQuality({ jpegQuality: 100 })).toBe(100);
  });

  it('clamps below 1 up to 1', () => {
    expect(resolveJpegQuality({ jpegQuality: 0 })).toBe(1);
    expect(resolveJpegQuality({ jpegQuality: -5 })).toBe(1);
    expect(resolveJpegQuality({ jpegQuality: -9999 })).toBe(1);
  });

  it('clamps above 100 down to 100', () => {
    expect(resolveJpegQuality({ jpegQuality: 101 })).toBe(100);
    expect(resolveJpegQuality({ jpegQuality: 150 })).toBe(100);
    expect(resolveJpegQuality({ jpegQuality: 1e6 })).toBe(100);
  });

  it('rounds fractional values to the nearest integer', () => {
    expect(resolveJpegQuality({ jpegQuality: 80.4 })).toBe(80);
    expect(resolveJpegQuality({ jpegQuality: 80.6 })).toBe(81);
    expect(resolveJpegQuality({ jpegQuality: 0.4 })).toBe(1); // rounds to 0 → clamps to 1
    expect(resolveJpegQuality({ jpegQuality: 100.4 })).toBe(100);
  });

  it('falls back to 90 for non-finite values', () => {
    expect(resolveJpegQuality({ jpegQuality: NaN })).toBe(90);
    expect(resolveJpegQuality({ jpegQuality: Infinity })).toBe(90);
    expect(resolveJpegQuality({ jpegQuality: -Infinity })).toBe(90);
  });
});

describe('resolveMaxDimensions', () => {
  it('returns both undefined when options are undefined', () => {
    expect(resolveMaxDimensions(undefined)).toEqual({
      maxWidth: undefined,
      maxHeight: undefined,
    });
  });

  it('returns both undefined for an empty object', () => {
    expect(resolveMaxDimensions({})).toEqual({
      maxWidth: undefined,
      maxHeight: undefined,
    });
  });

  it('passes through positive integers', () => {
    expect(resolveMaxDimensions({ maxWidth: 4096, maxHeight: 2160 })).toEqual({
      maxWidth: 4096,
      maxHeight: 2160,
    });
  });

  it('treats a single provided axis as a one-sided cap', () => {
    expect(resolveMaxDimensions({ maxWidth: 4096 })).toEqual({
      maxWidth: 4096,
      maxHeight: undefined,
    });
    expect(resolveMaxDimensions({ maxHeight: 2160 })).toEqual({
      maxWidth: undefined,
      maxHeight: 2160,
    });
  });

  it('drops zero and negative dimensions (treated as unbounded)', () => {
    expect(resolveMaxDimensions({ maxWidth: 0, maxHeight: -10 })).toEqual({
      maxWidth: undefined,
      maxHeight: undefined,
    });
  });

  it('floors fractional dimensions so the cap is never exceeded', () => {
    expect(resolveMaxDimensions({ maxWidth: 100.9, maxHeight: 50.1 })).toEqual({
      maxWidth: 100,
      maxHeight: 50,
    });
  });

  it('drops non-finite dimensions', () => {
    expect(resolveMaxDimensions({ maxWidth: NaN, maxHeight: Infinity })).toEqual({
      maxWidth: undefined,
      maxHeight: undefined,
    });
  });

  it('does not let one invalid axis poison a valid one', () => {
    expect(resolveMaxDimensions({ maxWidth: 4096, maxHeight: 0 })).toEqual({
      maxWidth: 4096,
      maxHeight: undefined,
    });
  });
});

describe('OutputImageOptions type wiring', () => {
  it('accepts the documented full shape', () => {
    const o: OutputImageOptions = {
      jpegQuality: 80,
      maxWidth: 4096,
      maxHeight: 4096,
    };
    expect(resolveJpegQuality(o)).toBe(80);
    expect(resolveMaxDimensions(o)).toEqual({ maxWidth: 4096, maxHeight: 4096 });
  });
});
