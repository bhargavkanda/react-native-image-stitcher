// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for `buildCaptureWarnings` — the pure builder that turns a
 * finalize result + lateral-stop flag into the non-fatal `CaptureWarning[]`
 * attached to a successful capture (and shown on the crop banner).
 *
 * Pure-TS: no native deps, so it runs in the lib's jest config directly.
 */
import {
  buildCaptureWarnings,
  LOW_FRAME_UTILIZATION_THRESHOLD,
  DEFAULT_CAPTURE_WARNING_COPY,
} from '../captureWarnings';

describe('buildCaptureWarnings', () => {
  it('returns no warnings for a clean, full-utilization capture', () => {
    expect(
      buildCaptureWarnings({ framesRequested: 20, framesIncluded: 20 }),
    ).toEqual([]);
  });

  it('returns no warning at exactly the threshold (70% used)', () => {
    // 14/20 = 0.70 — NOT below the 0.70 trip point (strict <), so no warning.
    expect(
      buildCaptureWarnings({ framesRequested: 20, framesIncluded: 14 }),
    ).toEqual([]);
  });

  it('warns LOW_FRAME_UTILIZATION when <70% of frames survived', () => {
    // 13/20 = 0.65 < 0.70.
    const warnings = buildCaptureWarnings({
      framesRequested: 20,
      framesIncluded: 13,
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.code).toBe('LOW_FRAME_UTILIZATION');
    expect(warnings[0]?.framesRequested).toBe(20);
    expect(warnings[0]?.framesIncluded).toBe(13);
    expect(warnings[0]?.utilization).toBeCloseTo(0.65, 5);
    expect(warnings[0]?.message).toContain('13 of 20');
    expect(warnings[0]?.message).toContain('65%');
  });

  it('warns LATERAL_DRIFT_FINALIZE when the capture was stopped sideways', () => {
    const warnings = buildCaptureWarnings({
      framesRequested: 20,
      framesIncluded: 20,
      lateralFinalize: true,
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.code).toBe('LATERAL_DRIFT_FINALIZE');
  });

  it('orders lateral (cause) before low-utilization (symptom) when both fire', () => {
    const warnings = buildCaptureWarnings({
      framesRequested: 20,
      framesIncluded: 5,
      lateralFinalize: true,
    });
    expect(warnings.map((w) => w.code)).toEqual([
      'LATERAL_DRIFT_FINALIZE',
      'LOW_FRAME_UTILIZATION',
    ]);
  });

  it('warns HIGH_PAN_SPEED when the pan exceeded the recommended pace', () => {
    const warnings = buildCaptureWarnings({
      framesRequested: 20,
      framesIncluded: 20,
      highPanSpeed: true,
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.code).toBe('HIGH_PAN_SPEED');
    expect(warnings[0]?.message).toMatch(/faster than the recommended pace/i);
  });

  it('can surface lateral, high-speed AND low-utilization together', () => {
    const warnings = buildCaptureWarnings({
      framesRequested: 20,
      framesIncluded: 5,
      lateralFinalize: true,
      highPanSpeed: true,
    });
    expect(warnings.map((w) => w.code).sort()).toEqual([
      'HIGH_PAN_SPEED',
      'LATERAL_DRIFT_FINALIZE',
      'LOW_FRAME_UTILIZATION',
    ]);
  });

  it('honours a custom utilization threshold', () => {
    // 17/20 = 0.85; below a 0.9 threshold → warns.
    const warnings = buildCaptureWarnings({
      framesRequested: 20,
      framesIncluded: 17,
      lowFrameUtilizationThreshold: 0.9,
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.code).toBe('LOW_FRAME_UTILIZATION');
  });

  it('does not warn on missing / non-numeric frame counts', () => {
    expect(buildCaptureWarnings({})).toEqual([]);
    expect(
      buildCaptureWarnings({ framesRequested: 0, framesIncluded: 0 }),
    ).toEqual([]);
  });

  it('exposes a 0.70 default threshold', () => {
    expect(LOW_FRAME_UTILIZATION_THRESHOLD).toBe(0.7);
  });

  describe('i18n — copy override', () => {
    it('uses an overridden (localised) message for the static warnings', () => {
      const warnings = buildCaptureWarnings({
        lateralFinalize: true,
        highPanSpeed: true,
        copy: {
          lateralDriftFinalize: 'Capture arrêtée — dérive latérale.',
          highPanSpeed: 'Trop rapide.',
        },
      });
      expect(warnings.find((w) => w.code === 'LATERAL_DRIFT_FINALIZE')?.message)
        .toBe('Capture arrêtée — dérive latérale.');
      expect(warnings.find((w) => w.code === 'HIGH_PAN_SPEED')?.message).toBe(
        'Trop rapide.',
      );
    });

    it('interpolates {included}/{requested}/{percent} into a custom template', () => {
      const warnings = buildCaptureWarnings({
        framesRequested: 20,
        framesIncluded: 5,
        copy: {
          lowFrameUtilization:
            'Seulement {included}/{requested} ({percent}%) utilisées.',
        },
      });
      const low = warnings.find((w) => w.code === 'LOW_FRAME_UTILIZATION');
      expect(low?.message).toBe('Seulement 5/20 (25%) utilisées.');
      // The structured fields are still populated for code-based hosts.
      expect(low?.framesIncluded).toBe(5);
      expect(low?.utilization).toBeCloseTo(0.25);
    });

    it('falls back to the default for any copy key the override omits', () => {
      const warnings = buildCaptureWarnings({
        lateralFinalize: true,
        highPanSpeed: true,
        copy: { lateralDriftFinalize: 'override only this one' },
      });
      expect(warnings.find((w) => w.code === 'HIGH_PAN_SPEED')?.message).toBe(
        DEFAULT_CAPTURE_WARNING_COPY.highPanSpeed,
      );
    });

    it('leaves an unknown placeholder verbatim rather than throwing', () => {
      const warnings = buildCaptureWarnings({
        framesRequested: 10,
        framesIncluded: 1,
        copy: { lowFrameUtilization: '{included} of {bogus} frames' },
      });
      expect(warnings[0]?.message).toBe('1 of {bogus} frames');
    });
  });
});
