import { scoreToReport } from '../runQualityCheck';
import type { QualityThresholds } from '../../types';

// Baseline: sharp + well-exposed, so only the glare axis varies.
const CLEAN = { blurScore: 500, brightnessScore: 128, glareScore: 20 };
const THRESHOLDS: QualityThresholds = {
  minBlurScore: 100,
  minBrightness: 40,
  maxBrightness: 220,
  maxGlare: 33,
};

describe('scoreToReport — glare (dark-channel veiling)', () => {
  it('flags glare when glareScore exceeds maxGlare', () => {
    const report = scoreToReport({ ...CLEAN, glareScore: 45 }, THRESHOLDS);
    const glare = report.issues.find((i) => i.type === 'glare');
    expect(glare).toBeDefined();
    expect(glare?.severity).toBe('warning');
    expect(glare?.message).toContain('45'); // Math.round(glareScore)
  });

  it('is non-blocking — a glare-only report still passes', () => {
    const report = scoreToReport({ ...CLEAN, glareScore: 200 }, THRESHOLDS);
    expect(report.issues.some((i) => i.type === 'glare')).toBe(true);
    expect(report.passed).toBe(true); // warning-severity does not gate
  });

  it('does not flag glare below the threshold', () => {
    const report = scoreToReport({ ...CLEAN, glareScore: 32 }, THRESHOLDS);
    expect(report.issues.some((i) => i.type === 'glare')).toBe(false);
  });

  it('is opt-in — omitting maxGlare disables the check entirely', () => {
    const { maxGlare, ...noGlareThresholds } = THRESHOLDS;
    void maxGlare;
    const report = scoreToReport(
      { ...CLEAN, glareScore: 255 },
      noGlareThresholds as QualityThresholds,
    );
    expect(report.issues.some((i) => i.type === 'glare')).toBe(false);
  });

  it('a fully clean frame produces no issues', () => {
    const report = scoreToReport(CLEAN, THRESHOLDS);
    expect(report.issues).toHaveLength(0);
    expect(report.passed).toBe(true);
  });
});
