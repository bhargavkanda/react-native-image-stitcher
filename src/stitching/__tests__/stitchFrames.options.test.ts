// SPDX-License-Identifier: Apache-2.0
/**
 * `stitchFrames` StitchOptions-passthrough contract.
 *
 * The JS shim forwards the caller's options object VERBATIM to
 * `NativeModules.BatchStitcher.stitch` — it never filters, renames, or
 * defaults keys.  That verbatim forwarding is what the optional passthrough
 * fields (`stitchMode`, `compositingResolMP`, `registrationResolMP`,
 * `useManualPipeline`) rely on: the native bridges read them straight off
 * the options dict, and ABSENT keys mean "historical behaviour" on every
 * path.  These tests pin both halves of that contract:
 *
 *   1. a minimal call carries NO passthrough keys (absent stays absent —
 *      the "nil = historical behaviour" convention is only sound if the JS
 *      layer never invents a value), and
 *   2. every passthrough key the caller sets arrives at the native module
 *      unchanged.
 *
 * Style mirrors `AROverlay.types.test.ts`: the shared jest react-native
 * mock exposes an empty `NativeModules`; we inject a spy module for the
 * duration of each test and remove it afterward.
 */

import { stitchFrames, StitchNotImplementedError } from '../stitchFrames';
import type { StitchFramesOptions } from '../stitchFrames';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { NativeModules } = require('react-native') as {
  NativeModules: Record<string, unknown>;
};

const stitchSpy = jest.fn();

beforeEach(() => {
  stitchSpy.mockReset();
  stitchSpy.mockResolvedValue({
    outputPath: '/tmp/out.jpg',
    width: 100,
    height: 50,
    durationMs: 1,
  });
  (NativeModules as Record<string, unknown>).BatchStitcher = {
    stitch: (o: unknown) => stitchSpy(o),
  };
});

afterEach(() => {
  delete (NativeModules as Record<string, unknown>).BatchStitcher;
});

const base: StitchFramesOptions = {
  framePaths: ['/tmp/a.jpg', '/tmp/b.jpg'],
  outputPath: '/tmp/out.jpg',
};

describe('stitchFrames options passthrough', () => {
  it('forwards a minimal call with NO passthrough keys (absent stays absent)', async () => {
    await stitchFrames({ ...base });
    expect(stitchSpy).toHaveBeenCalledTimes(1);
    const forwarded = stitchSpy.mock.calls[0][0] as Record<string, unknown>;
    expect(forwarded.framePaths).toEqual(base.framePaths);
    expect(forwarded.outputPath).toBe(base.outputPath);
    // The "absent = historical behaviour" contract: the JS layer must not
    // materialise these keys when the caller didn't set them.
    expect('stitchMode' in forwarded).toBe(false);
    expect('compositingResolMP' in forwarded).toBe(false);
    expect('registrationResolMP' in forwarded).toBe(false);
    expect('useManualPipeline' in forwarded).toBe(false);
    expect('quality' in forwarded).toBe(false);
  });

  it('forwards every passthrough key unchanged', async () => {
    await stitchFrames({
      ...base,
      quality: 92,
      stitchMode: 'scans',
      compositingResolMP: 2.5,
      registrationResolMP: 1.0,
      useManualPipeline: true,
    });
    const forwarded = stitchSpy.mock.calls[0][0] as Record<string, unknown>;
    expect(forwarded.quality).toBe(92);
    expect(forwarded.stitchMode).toBe('scans');
    expect(forwarded.compositingResolMP).toBe(2.5);
    expect(forwarded.registrationResolMP).toBe(1.0);
    expect(forwarded.useManualPipeline).toBe(true);
  });

  it('forwards useManualPipeline: false explicitly (false ≠ absent)', async () => {
    // Android's historical default for this entry point is the MANUAL
    // pipeline, so an explicit `false` must survive to the native side —
    // it is a real behaviour request, not a default to be dropped.
    await stitchFrames({ ...base, useManualPipeline: false });
    const forwarded = stitchSpy.mock.calls[0][0] as Record<string, unknown>;
    expect(forwarded.useManualPipeline).toBe(false);
  });

  it('resolves with the native result untouched', async () => {
    const result = await stitchFrames({ ...base, stitchMode: 'panorama' });
    expect(result).toEqual({
      outputPath: '/tmp/out.jpg',
      width: 100,
      height: 50,
      durationMs: 1,
    });
  });

  it('still throws StitchNotImplementedError when the native module is absent', async () => {
    delete (NativeModules as Record<string, unknown>).BatchStitcher;
    await expect(stitchFrames({ ...base })).rejects.toBeInstanceOf(
      StitchNotImplementedError,
    );
  });

  it('type-checks the passthrough contract', () => {
    const full: StitchFramesOptions = {
      framePaths: ['a'],
      outputPath: 'b',
      stitchMode: 'panorama',
      compositingResolMP: 1.2,
      registrationResolMP: 0.8,
      useManualPipeline: false,
    };
    expect(full.stitchMode).toBe('panorama');

    const bad: StitchFramesOptions = {
      framePaths: ['a'],
      outputPath: 'b',
      // @ts-expect-error — stitchMode is a closed union, not free text.
      stitchMode: 'affine',
    };
    expect(bad.outputPath).toBe('b');
  });
});
