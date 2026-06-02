// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for the single-photo output-controls post-process wrapper
 * (v0.15). The wrapper hands a captured JPEG to the native
 * BatchStitcher.applyOutputControls (resize + re-encode) and degrades
 * gracefully to a no-op when that native method is absent (e.g. before
 * the native phase ships, or on a platform that hasn't registered it).
 *
 * NativeModules is the shared jest mock (jest.mocks/react-native.js);
 * each test swaps in its own BatchStitcher stub.
 */
import { NativeModules } from 'react-native';
import {
  shouldApplyOutputControls,
  applyOutputControls,
} from '../applyOutputControls';

type Mutable = Record<string, unknown>;

describe('shouldApplyOutputControls', () => {
  it('is true when a width cap is set — regardless of capture quality', () => {
    expect(
      shouldApplyOutputControls({
        quality: 90,
        maxWidth: 4096,
        qualityAppliedAtCapture: true,
      }),
    ).toBe(true);
    expect(
      shouldApplyOutputControls({
        quality: 90,
        maxWidth: 4096,
        qualityAppliedAtCapture: false,
      }),
    ).toBe(true);
  });

  it('is true when a height cap is set', () => {
    expect(
      shouldApplyOutputControls({
        quality: 90,
        maxHeight: 2160,
        qualityAppliedAtCapture: true,
      }),
    ).toBe(true);
  });

  it('is false with no caps and default quality', () => {
    expect(
      shouldApplyOutputControls({ quality: 90, qualityAppliedAtCapture: false }),
    ).toBe(false);
    expect(
      shouldApplyOutputControls({ quality: 90, qualityAppliedAtCapture: true }),
    ).toBe(false);
  });

  it('non-default quality forces post-process only when capture did NOT apply it', () => {
    // non-AR: vision-camera gave no quality control → must re-encode.
    expect(
      shouldApplyOutputControls({ quality: 60, qualityAppliedAtCapture: false }),
    ).toBe(true);
    // AR: takePhoto already encoded at the requested quality → skip.
    expect(
      shouldApplyOutputControls({ quality: 60, qualityAppliedAtCapture: true }),
    ).toBe(false);
  });
});

describe('applyOutputControls', () => {
  afterEach(() => {
    (NativeModules as Mutable).BatchStitcher = undefined;
  });

  it('no-ops (applied:false) when the native module is absent', async () => {
    (NativeModules as Mutable).BatchStitcher = undefined;
    const r = await applyOutputControls('file:///tmp/a.jpg', {
      quality: 80,
      maxWidth: 1000,
    });
    expect(r).toEqual({ path: 'file:///tmp/a.jpg', applied: false });
  });

  it('no-ops when BatchStitcher exists but lacks applyOutputControls', async () => {
    (NativeModules as Mutable).BatchStitcher = {};
    const r = await applyOutputControls('/tmp/a.jpg', { quality: 80 });
    expect(r.applied).toBe(false);
    expect(r.path).toBe('/tmp/a.jpg');
  });

  it('calls native with a BARE path + opts, returns new dims + same uri', async () => {
    const spy = jest.fn().mockResolvedValue({ width: 1000, height: 750 });
    (NativeModules as Mutable).BatchStitcher = { applyOutputControls: spy };

    const r = await applyOutputControls('file:///tmp/a.jpg', {
      quality: 80,
      maxWidth: 1000,
      maxHeight: 1000,
    });

    expect(spy).toHaveBeenCalledWith({
      imagePath: '/tmp/a.jpg', // file:// stripped for the native side
      maxWidth: 1000,
      maxHeight: 1000,
      quality: 80,
    });
    expect(r).toEqual({
      path: 'file:///tmp/a.jpg', // caller keeps its original uri scheme
      width: 1000,
      height: 750,
      applied: true,
    });
  });

  it('forwards undefined caps for the quality-only re-encode case', async () => {
    const spy = jest.fn().mockResolvedValue({ width: 4032, height: 3024 });
    (NativeModules as Mutable).BatchStitcher = { applyOutputControls: spy };

    await applyOutputControls('/tmp/a.jpg', { quality: 50 });

    expect(spy).toHaveBeenCalledWith({
      imagePath: '/tmp/a.jpg',
      maxWidth: undefined,
      maxHeight: undefined,
      quality: 50,
    });
  });
});
