// SPDX-License-Identifier: Apache-2.0
/**
 * KEY PARITY — every key the TypeScript reads from a sweep's live status and
 * result summary is emitted by BOTH native producers.
 *
 * ── Why ─────────────────────────────────────────────────────────────────────
 *
 * iOS does not use the shared C++ producer: `RNISPanoCore.mm` hand-builds its
 * own copy of the status and summary. A key one producer omits is not an
 * error anywhere — `coercePanoPlusStatus` / `coercePanoPlusSummary` substitute
 * a default and the result looks complete. Commit dc0c98d found fields that
 * had reached ZERO iPhone packs that way, and the same gap ran the other way:
 * the Android summary carried no `gain` or `lens` block at all, and half of
 * `seam` and `projection` (canvasJogP50Px, jogDriftPx, subjectDistanceFitM…).
 *
 * ── How ─────────────────────────────────────────────────────────────────────
 *
 * 1. WHAT THE TS READS is enumerated by running the two readers over a
 *    recording Proxy — every property access is a key path — not by a regex
 *    over the source, which can quietly match nothing. A floor and named
 *    spot-checks are the negative control.
 * 2. ANDROID: the shared C++ producer's key paths are snapshotted by
 *    `PanoLiveSession.KeyParityFixtureMatchesTheProducer` (which fails when
 *    the snapshot goes stale), plus the few keys the Kotlin layer adds, each
 *    of which must be spelled in the Kotlin file named.
 * 3. iOS: every read key's LEAF must be spelled as a string literal in the
 *    iOS producer sources. That proves the key is written somewhere, not that
 *    it is written on every path — the device pack is the final guard (DR-1a:
 *    iPhone packs parse with zero defaulted fields).
 * 4. Exceptions are EXPLICIT and carry a reason. A key that is legitimately
 *    one platform's (the ARKit exposure probe) is listed as such; nothing is
 *    skipped silently.
 */
import * as fs from 'fs';
import * as path from 'path';

import { coercePanoPlusStatus, coercePanoPlusSummary } from '../panoPlusModel';

const ROOT = path.resolve(__dirname, '../../..');

/** Every key path a reader touches on `raw`. `hints` pins the few type guards. */
function readPaths(
  read: (raw: unknown) => unknown, hints: Record<string, unknown> = {},
): string[] {
  const paths = new Set<string>();
  const rec = (prefix: string): unknown => new Proxy({}, {
    get(_t, k) {
      if (typeof k === 'symbol') return undefined;
      const p = prefix ? `${prefix}.${String(k)}` : String(k);
      paths.add(p);
      return p in hints ? hints[p] : rec(p);
    },
  });
  read(rec(''));
  return [...paths].sort();
}

// `coercePanoPlusStatus` returns null unless `running` is a boolean.
const STATUS_READ = readPaths(coercePanoPlusStatus, { running: true });
const SUMMARY_READ = readPaths(coercePanoPlusSummary);

const fixture = JSON.parse(fs.readFileSync(
  path.join(ROOT, 'cpp/tests/panoplus/fixtures/panoplus_live_keys.json'), 'utf8',
)) as { status: string[]; summary: string[] };

/** Keys the Kotlin layer adds on top of the C++ producer, and where. */
const KOTLIN_ADDED: Record<'status' | 'summary', Record<string, string>> = {
  status: {
    viewfinderAttached: 'android/src/main/java/io/imagestitcher/rn/panoplus/PanoPlusLiveNative.kt',
    viewfinderNote: 'android/src/main/java/io/imagestitcher/rn/panoplus/PanoPlusLiveNative.kt',
    poseSourceRan: 'android/src/main/java/io/imagestitcher/rn/panoplus/PanoPlusAndroidRecorder.kt',
    arTrackingFailure: 'android/src/main/java/io/imagestitcher/rn/panoplus/PanoPlusAndroidRecorder.kt',
  },
  summary: {},
};

/**
 * Read keys Android does not produce, BY DESIGN, with the reason. A prefix
 * covers the block below it.
 */
const ANDROID_NOT_APPLICABLE: Record<string, string> = {
  'exposure.ar':
    'the ARKit exposure probe (ARCamera exposure vs the locked AVCaptureDevice) — an iOS ARKit-arm '
    + 'measurement with no Android counterpart; the reader treats an absent block as UNKNOWN',
  'exposure.lock':
    'the iOS camera-lock report (AVCaptureDevice lock/restore). Android reports its own lock through '
    + 'the recorder pack; the vision-camera arm\'s AE/AWB lock report lands with M4',
};

/** Read keys iOS does not produce, BY DESIGN, with the reason. */
const IOS_NOT_APPLICABLE: Record<string, string> = {
  viewfinderAttached:
    "the Android Camera2 idle viewfinder's attach state — iOS has no such view (and the Camera2 "
    + 'viewfinder is deleted with pano+\'s own Android camera, M6b); the reader treats false as '
    + '"not reported"',
  viewfinderNote: 'as viewfinderAttached',
  arTrackingFailure:
    "ARCore's TrackingFailureReason label (INSUFFICIENT_LIGHT, …), which is what the reader switches "
    + "on. ARKit's limited-state reasons are a different set and reach the iOS status only as "
    + '`tracking`; an absent label falls back to the generic guidance',
};

function covered(key: string, exceptions: Record<string, string>): boolean {
  return Object.keys(exceptions).some((p) => key === p || key.startsWith(`${p}.`));
}

function literalsIn(files: string[]): Set<string> {
  const out = new Set<string>();
  for (const f of files) {
    const src = fs.readFileSync(f, 'latin1');
    for (const m of src.matchAll(/@?"([A-Za-z_][A-Za-z0-9_]*)"/g)) out.add(m[1]!);
  }
  return out;
}

const IOS_DIR = path.join(ROOT, 'ios/PanoPlus');
const IOS_SOURCES = fs.readdirSync(IOS_DIR)
  .filter((f) => /\.(mm|m|swift|h)$/.test(f))
  .map((f) => path.join(IOS_DIR, f));
const IOS_LITERALS = literalsIn(IOS_SOURCES);

describe('what the TypeScript reads is enumerated, not guessed', () => {
  it('finds the whole status and summary surface (negative control)', () => {
    expect(STATUS_READ.length).toBeGreaterThanOrEqual(75);
    expect(SUMMARY_READ.length).toBeGreaterThanOrEqual(200);
    for (const k of ['running', 'painted', 'previewSeq', 'poseSourceRan']) {
      expect(STATUS_READ).toContain(k);
    }
    for (const k of [
      'counts.painted', 'seam.canvasJogP50Px', 'seam.jogDriftPx',
      'projection.subjectDistanceFitM', 'gain.cumEnd', 'lens.gate', 'latch.latched',
    ]) {
      expect(SUMMARY_READ).toContain(k);
    }
  });
});

describe('Android — the shared C++ producer plus the Kotlin layer', () => {
  for (const kind of ['status', 'summary'] as const) {
    it(`emits every ${kind} key the TypeScript reads`, () => {
      const produced = new Set(fixture[kind]);
      const missing = (kind === 'status' ? STATUS_READ : SUMMARY_READ).filter(
        (k) => !produced.has(k)
          && !(k in KOTLIN_ADDED[kind])
          && !covered(k, ANDROID_NOT_APPLICABLE),
      );
      expect(missing).toEqual([]);
    });
  }

  it('every Kotlin-added key is actually spelled in the file named for it', () => {
    for (const kind of ['status', 'summary'] as const) {
      for (const [key, file] of Object.entries(KOTLIN_ADDED[kind])) {
        const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
        expect({ key, found: src.includes(`"${key}"`) || src.includes(`\\"${key}\\"`) })
          .toEqual({ key, found: true });
      }
    }
  });

  it('an exception is never used for a key the producer DOES emit (stale exceptions)', () => {
    for (const kind of ['status', 'summary'] as const) {
      const produced = new Set(fixture[kind]);
      const stale = Object.keys(ANDROID_NOT_APPLICABLE).filter((p) => produced.has(p));
      expect({ kind, stale }).toEqual({ kind, stale: [] });
    }
  });
});

describe('iOS — RNISPanoCore.mm and its bridge', () => {
  for (const kind of ['status', 'summary'] as const) {
    it(`spells every ${kind} key the TypeScript reads`, () => {
      const read = kind === 'status' ? STATUS_READ : SUMMARY_READ;
      const missing = read.filter((k) => {
        if (covered(k, IOS_NOT_APPLICABLE)) return false;
        const leaf = k.split('.').pop()!;
        return !IOS_LITERALS.has(leaf);
      });
      expect(missing).toEqual([]);
    });
  }
});
