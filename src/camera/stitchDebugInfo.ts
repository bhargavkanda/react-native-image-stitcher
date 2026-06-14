// SPDX-License-Identifier: Apache-2.0
/**
 * buildStitchDebugInfo — format the stitcher's runtime stats as a compact,
 * multi-line string for the __DEV__-only overlay on the output preview.
 *
 * The operator uses this to SEE how a panorama was built — which pipeline +
 * warper ran, whether the low-memory stream/feather fallback kicked in, the
 * confidence score the successful attempt used, and how many keyframes
 * survived pruning.  Purely presentational; never shown in release.
 *
 * Pure + structurally typed so it unit-tests in the node jest env.
 */

export interface StitchDebugFields {
  /** Native `debugSummary`: `"pipe=…;warp=…;route=…;seam=…;blend=…"`. */
  debugSummary?: string;
  stitchModeResolved?: 'panorama' | 'scans';
  finalConfidenceThresh?: number;
  framesIncluded?: number;
  framesRequested?: number;
  width?: number;
  height?: number;
}

/**
 * Build the overlay text.  Returns `''` when nothing useful is present (so the
 * caller can skip rendering the pill entirely).  One `key: value` per line.
 */
export function buildStitchDebugInfo(r: StitchDebugFields): string {
  const lines: string[] = [];

  // Expand the native summary ("pipe=manual;warp=spherical;…") into one
  // labelled line per pair, preserving order.  Malformed pairs are skipped.
  if (r.debugSummary) {
    for (const pair of r.debugSummary.split(';')) {
      const eq = pair.indexOf('=');
      if (eq <= 0) continue;
      const key = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      if (key && value) lines.push(`${key}: ${value}`);
    }
  }

  if (r.stitchModeResolved) lines.push(`mode: ${r.stitchModeResolved}`);

  if (
    typeof r.finalConfidenceThresh === 'number'
    && r.finalConfidenceThresh >= 0
  ) {
    lines.push(`score: ${r.finalConfidenceThresh.toFixed(2)}`);
  }

  if (typeof r.framesIncluded === 'number' && r.framesIncluded >= 0) {
    const req =
      typeof r.framesRequested === 'number' && r.framesRequested >= 0
        ? String(r.framesRequested)
        : '?';
    lines.push(`frames: ${r.framesIncluded}/${req}`);
  }

  if (
    typeof r.width === 'number'
    && typeof r.height === 'number'
    && r.width > 0
    && r.height > 0
  ) {
    lines.push(`size: ${r.width}×${r.height}`);
  }

  return lines.join('\n');
}
