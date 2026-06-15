// SPDX-License-Identifier: Apache-2.0
import { buildStitchDebugInfo } from '../stitchDebugInfo';

describe('buildStitchDebugInfo', () => {
  it('expands the native summary into one labelled line per pair', () => {
    const out = buildStitchDebugInfo({
      debugSummary:
        'pipe=manual;warp=spherical;route=batch;seam=graphcut;blend=multiband',
    });
    expect(out).toBe(
      ['pipe: manual', 'warp: spherical', 'route: batch', 'seam: graphcut', 'blend: multiband'].join(
        '\n',
      ),
    );
  });

  it('appends mode / score / frames / size from the structured fields', () => {
    const out = buildStitchDebugInfo({
      debugSummary: 'pipe=highlevel;warp=spherical',
      stitchModeResolved: 'panorama',
      finalConfidenceThresh: 0.5,
      framesIncluded: 4,
      framesRequested: 6,
      width: 4000,
      height: 1200,
    });
    expect(out.split('\n')).toEqual([
      'pipe: highlevel',
      'warp: spherical',
      'mode: panorama',
      'score: 0.50',
      'frames: 4/6',
      'size: 4000×1200',
    ]);
  });

  it('returns "" when nothing useful is present', () => {
    expect(buildStitchDebugInfo({})).toBe('');
    expect(buildStitchDebugInfo({ debugSummary: '' })).toBe('');
  });

  it('skips sentinel / negative values', () => {
    const out = buildStitchDebugInfo({
      finalConfidenceThresh: -1,
      framesIncluded: -1,
      framesRequested: -1,
      width: 0,
      height: 0,
    });
    expect(out).toBe('');
  });

  it('uses "?" for framesRequested when it is missing/sentinel', () => {
    expect(buildStitchDebugInfo({ framesIncluded: 3 })).toBe('frames: 3/?');
    expect(
      buildStitchDebugInfo({ framesIncluded: 3, framesRequested: -1 }),
    ).toBe('frames: 3/?');
  });

  it('ignores malformed summary pairs', () => {
    expect(
      buildStitchDebugInfo({ debugSummary: 'pipe=manual;;=orphan;warp=' }),
    ).toBe('pipe: manual');
  });
});
