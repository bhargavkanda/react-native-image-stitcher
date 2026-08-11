// SPDX-License-Identifier: Apache-2.0
/**
 * perfTrace — Phase 0 measurement surface for the RN-0.79-vs-0.83 stitch
 * regression investigation (docs/perf-3a … perf-3b, and the fix plan's
 * Phase 0).
 *
 * The point of this module is to turn "significant regression on 0.79.3"
 * into an *attributed* number. Three questions, three surfaces:
 *
 *  1. Is the host on the old (Paper) architecture or new (Fabric /
 *     bridgeless)?  → `getArchFingerprint()`.  RN 0.82 removed the legacy
 *     architecture, so "0.79.3 vs 0.83" is very likely "old bridge vs
 *     bridgeless" — this tells us for sure, per host.
 *  2. How much wall time is spent in native `cv::Stitcher` vs in JS /
 *     bridge?  → `IncrementalTimings` (below) carries `stitchWallMs`
 *     (pure native) alongside `jsOverheadMs` (finalize round-trip minus
 *     native).  Equal native time + different end-to-end ⇒ the regression
 *     is JS/bridge; different native time ⇒ camera-format / device.
 *  3. How much per-capture event + render churn does the host pay?  →
 *     the counter registry (`bumpPerfCounter` / `snapshotPerfCounters`).
 *     On a Paper host each `IncrementalStateUpdate` crosses the
 *     serialized bridge AND re-renders the consumer tree.
 *
 * NON-GOAL: this module never changes stitch behavior. It is pure
 * measurement. It is safe to call on any RN version — every host-global
 * probe is optional-chained and falls back to `undefined`, never throws.
 */

import { Platform } from 'react-native';

// ── Architecture / toolchain fingerprint ──────────────────────────────

export interface ArchFingerprint {
  /** e.g. "0.79.3" — from `Platform.constants.reactNativeVersion`. */
  reactNativeVersion?: string;
  /** New-architecture Fabric renderer present. */
  isFabric?: boolean;
  /** Bridgeless mode (RN 0.74+; default on 0.82+). */
  isBridgeless?: boolean;
  /** Hermes present (vs JSC). */
  isHermes?: boolean;
  /** Hermes bytecode version + build, when queryable. */
  hermes?: Record<string, unknown>;
  /** OS + version, for the record. */
  platform?: string;
  osVersion?: string;
}

/**
 * Capture a one-time snapshot of the JS runtime's architecture. Cheap;
 * safe to call at capture start and stamp into every trace. All probes
 * are defensive — a missing global yields `undefined`, never a throw.
 */
export function getArchFingerprint(): ArchFingerprint {
  const g = globalThis as unknown as {
    nativeFabricUIManager?: unknown;
    RN$Bridgeless?: boolean;
    HermesInternal?: {
      getRuntimeProperties?: () => Record<string, unknown>;
    };
  };

  let reactNativeVersion: string | undefined;
  try {
    const v = (Platform.constants as { reactNativeVersion?: {
      major?: number; minor?: number; patch?: number;
    } })?.reactNativeVersion;
    if (v && typeof v.major === 'number') {
      reactNativeVersion = `${v.major}.${v.minor ?? 0}.${v.patch ?? 0}`;
    }
  } catch {
    /* ignore */
  }

  let hermes: Record<string, unknown> | undefined;
  try {
    hermes = g.HermesInternal?.getRuntimeProperties?.();
  } catch {
    /* ignore */
  }

  let osVersion: string | undefined;
  try {
    osVersion = String((Platform as { Version?: unknown }).Version);
  } catch {
    /* ignore */
  }

  return {
    reactNativeVersion,
    isFabric: g.nativeFabricUIManager != null ? true : undefined,
    isBridgeless: g.RN$Bridgeless === true ? true : undefined,
    isHermes: g.HermesInternal != null ? true : undefined,
    hermes,
    platform: Platform.OS,
    osVersion,
  };
}

// ── Native stitch timings (filled by the native finalize result) ──────

/**
 * Per-phase native timings surfaced on the finalize result. Populated by
 * the native side (Kotlin `queueDelayMs`; the C++ `cv::Stitcher` phase
 * timers surfaced through the JNI — landing with docs/perf-3b, which
 * builds the C++ anyway). Every field is optional so this type is stable
 * while the native side fills in incrementally and so iOS (which lacks
 * some fields initially) never breaks the shared shape.
 */
export interface IncrementalTimings {
  /** Wall time of the blocking native `cv::Stitcher` call (ms). The
   *  RN-version-invariant number: on the same device it should not move
   *  between a 0.79 and an 0.83 host. */
  stitchWallMs?: number;
  /** finalize() dispatch → coroutine body start (ms). Backlog on the
   *  serial stitch scope (a pending ingest / prior stitch delays it). */
  queueDelayMs?: number;
  /** Per-cv-phase breakdown of the high-level path (ms), when the native
   *  timers are compiled in. */
  regMs?: number;
  baMs?: number;
  warpMs?: number;
  seamMs?: number;
  blendMs?: number;
  encodeMs?: number;
  /** Keyframes handed to the stitch + the first input's pixel dims. */
  keyframeCount?: number;
  keyframeWidth?: number;
  keyframeHeight?: number;
  /** Retry-ladder attempt the stitch settled on (1 = happy path). */
  ladderAttempt?: number;
  /** Registration / compositing MP budgets actually applied. */
  registrationResolMP?: number;
  compositingResolMP?: number;
}

/**
 * Parse timing key=value pairs out of the native `debugSummary` string
 * (the zero-new-JNI-surface transport: the native side appends
 * `dur=NNms;reg=NNms;…` to the summary it already returns). Forward-
 * compatible — returns only the keys present, `{}` until the native side
 * appends any. Never throws.
 */
export function parseTimingsFromDebugSummary(
  debugSummary: string | undefined,
): IncrementalTimings {
  const out: IncrementalTimings = {};
  if (!debugSummary) return out;
  const num = (re: RegExp): number | undefined => {
    const m = debugSummary.match(re);
    if (!m) return undefined;
    const n = Number(m[1]);
    return Number.isFinite(n) ? n : undefined;
  };
  out.stitchWallMs = num(/\bdur(?:Ms)?=(\d+(?:\.\d+)?)/);
  out.regMs = num(/\breg(?:Ms)?=(\d+(?:\.\d+)?)/);
  out.baMs = num(/\bba(?:Ms)?=(\d+(?:\.\d+)?)/);
  out.warpMs = num(/\bwarp(?:Ms)?=(\d+(?:\.\d+)?)/);
  out.seamMs = num(/\bseam(?:Ms)?=(\d+(?:\.\d+)?)/);
  out.blendMs = num(/\bblend(?:Ms)?=(\d+(?:\.\d+)?)/);
  out.encodeMs = num(/\benc(?:ode)?(?:Ms)?=(\d+(?:\.\d+)?)/);
  out.ladderAttempt = num(/\battempt=(\d+)/);
  // Drop undefined keys so callers can `Object.keys(...).length` to know
  // whether the native side is emitting timings yet.
  (Object.keys(out) as (keyof IncrementalTimings)[]).forEach((k) => {
    if (out[k] === undefined) delete out[k];
  });
  return out;
}

// ── Lightweight per-capture counter registry ──────────────────────────
//
// A module-level bag of monotonic counters + accumulated handler time.
// Consumers (useIncrementalStitcher's event listener, the Camera render
// path) `bumpPerfCounter` on each event/render; a capture snapshots +
// resets around finalize. Refs only — no React state, so counting adds
// zero renders.

interface PerfCounters {
  /** IncrementalStateUpdate events received since the last reset. */
  stateEvents: number;
  /** Of those, reject/hint events (no accepted thumbnail). */
  rejectEvents: number;
  /** Accumulated ms spent in event-handler bodies (performance.now deltas). */
  handlerMs: number;
  /** Consumer re-renders since the last reset. */
  renders: number;
}

let counters: PerfCounters = {
  stateEvents: 0,
  rejectEvents: 0,
  handlerMs: 0,
  renders: 0,
};

export function bumpPerfCounter(
  key: keyof PerfCounters,
  by = 1,
): void {
  counters[key] += by;
}

/** Snapshot the current counters (does not reset). */
export function snapshotPerfCounters(): Readonly<PerfCounters> {
  return { ...counters };
}

/** Reset all counters — call at capture start. */
export function resetPerfCounters(): void {
  counters = { stateEvents: 0, rejectEvents: 0, handlerMs: 0, renders: 0 };
}

/**
 * `performance.now()` if available, else `Date.now()`. Used to time
 * event-handler bodies without pulling in a polyfill.
 */
export function perfNow(): number {
  const p = (globalThis as { performance?: { now?: () => number } })
    .performance;
  return typeof p?.now === 'function' ? p.now() : Date.now();
}
