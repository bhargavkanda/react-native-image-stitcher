// SPDX-License-Identifier: Apache-2.0
/**
 * sweepTimeline — the per-sweep RECORDER, and the bytes of the one sidecar it
 * produces: `host_sweep_timeline.json` in the sweep's session directory.
 *
 * WHY IT EXISTS. No sweep pack carried a per-sweep timing record. The one
 * finish-time sidecar (`host_sweep_hud.json`) holds the HUD's text, frozen
 * BEFORE the finish on purpose; native's `meta.json` carries wall clocks on
 * one platform only; and a host sees the delivered result, after the finish,
 * and nothing in between. So three facts about the capture MECHANISM were
 * recorded nowhere:
 *
 *   · THE FINISH — when the stop began, when a poll first saw native report
 *     the camera released, when the engine reported `stitching` (the edge
 *     `<Camera>` unmounts its camera on), and when the stop settled;
 *   · THE STATUS RATE — how often a live status reached JS, on which channel
 *     (the AR frame push or the `getStatus` poll), and how often it carried
 *     NEW native content rather than a repeat;
 *   · PROCESS MEMORY over the hold and the finish, sampled with the
 *     package's own public memory read.
 *
 * Only the engine hook can observe all three, so the hook feeds this object
 * and writes it ONCE, at the settle of `finish()`, beside the HUD sidecar.
 *
 * ⚠ PURE, AND THAT IS LOAD-BEARING. It imports types and one pure helper and
 * never `react-native`, so the whole fold is walked by a node test. The hook
 * owns the native reads and the clock; this file folds what it is handed.
 *
 * ⚠ THE OBJECT'S IDENTITY IS THE GENERATION. A timeline is a mutable plain
 * object, one per sweep. Every async read pins the object AT ISSUE and writes
 * into that one, so a late answer can only ever land in the sweep that asked
 * for it — never in the next one, whatever the hook's ref holds by then. A
 * discarded sweep's object is dropped whole; nothing is copied out of it.
 *
 * ⚠ O(1) PER STATUS TICK, AND NO REACT STATE. The push lands at ~10 Hz on the
 * JS thread, and a recorder that re-rendered — or did more than a short array
 * push per tick — would lower the very rate it measures. Everything that costs
 * anything (which ticks carried new content, the gaps, the percentiles, the
 * one-second buckets) is folded ONCE, at write time, from the raw rows.
 *
 * `null` in the file means "nothing to say" and is never collapsed to `0` or
 * `''`: a release nobody saw and a release seen at 0 ms must not read alike.
 * Same rule as `panoPlusSweepHudSidecar`.
 */
import { panoPlusStatusSessionId } from './panoPlusModel';
import type { SweepMemoryMetric } from './panoPlusNative';
import type { PanoPlusStatus } from './panoPlusTypes';

/** The sidecar's file name inside the sweep's session directory. Same
 *  placement rule as the other `host_*` sidecars: the session dir, never
 *  `meta.json`, which is native's file. */
export const PANO_PLUS_SWEEP_TIMELINE_FILE = 'host_sweep_timeline.json';
export const SWEEP_TIMELINE_SCHEMA = 'panoplus-host-sweep-timeline/1';
/** How often process memory is sampled while a sweep is not idle. */
export const SWEEP_MEMORY_SAMPLE_MS = 250;
/** The bound on each of the two reads taken after the stop settles. */
export const SWEEP_TIMELINE_FINAL_READ_MS = 250;
/**
 * THE CAPS. Each is minutes of a sweep at its channel's own rate (status
 * ~12/s, memory 4/s, release polls 10/s), far past any sweep yet recorded, and
 * each one that is hit says so in the file — a truncated record must never
 * read as a complete one.
 */
export const SWEEP_TIMELINE_MAX_TICKS = 4000;
export const SWEEP_TIMELINE_MAX_MEMORY_ROWS = 1200;
export const SWEEP_TIMELINE_MAX_RELEASE_POLLS = 600;

/** The edges `markSweepTimeline` stamps. */
export type SweepTimelineMark = 'sweeping' | 'finishing' | 'stitchingReported' | 'settled';
/** Where a status entered JS: the AR frame meta, or a `getStatus` answer. */
export type SweepStatusChannel = 'push' | 'poll';
/**
 * Why a memory read was issued: `b` the baseline at the hold, `s` the
 * sweeping edge, `f` the finishing edge, `e` the end (after the stop
 * settled), `p` the periodic sample.
 */
export type SweepMemoryTag = 'b' | 's' | 'f' | 'e' | 'p';
/** A phase of the hold, as the fold assigns it from the stamped edges. */
export type SweepTimelinePhase = 'starting' | 'sweeping' | 'finishing' | 'settled';

/** One status arrival: `[ms since the hold, 0 push | 1 poll, seq, previewSeq]`. */
export type SweepStatusRow = [number, 0 | 1, number, number];
/** One release poll: `[ms since the hold at issue, round trip ms, 1 released | 0]`. */
export type SweepReleasePollRow = [number, number, 0 | 1];
/** One memory sample: `[ms since the hold at issue, MB, tag]`. */
export type SweepMemoryRow = [number, number, SweepMemoryTag];

/** What the hook knows about the sweep at the claim. */
export interface SweepTimelineStart {
  platform: string;
  /** `panoPlusArmContract` — which policy the arm was resolved under. */
  armContract: string;
  /** The `frameSource` prop: whose camera feeds the sweep. */
  frameSource: string;
  /**
   * The arm the operator SELECTED (the `poseSource` prop), and the arm the
   * start ASKED native for (the arm notice's effective arm). Both keys, and
   * both meanings, are `host_notice.json`'s: the two files sit in the same
   * pack and are read side by side, so one key must never name two different
   * arms. They differ exactly when a selected IMU arm fell back to ARKit.
   */
  poseSourceRequested: string;
  poseSourceEffective: string;
  releasePollMs: number;
  memorySampleMs: number;
  /** The memory reader this binary carries, or null — see `sweepMemoryReader`. */
  memoryReader: string | null;
  /** What that reader measures on this platform — see `sweepMemoryMetric`. */
  memoryMetric: SweepMemoryMetric | null;
}

export interface SweepTimeline {
  /** The claim in `start()` — the hold began and the camera is opening. */
  holdStartAtMs: number;
  /** `start()` resolved and the sweep went live. */
  sweepingAtMs: number | null;
  /** `finish()` — the operator let go. */
  finishingAtMs: number | null;
  /** The engine's rising `stitching` report (camera released, still finishing). */
  stitchingReportedAtMs: number | null;
  /** The stop's promise settled, either way. */
  stopSettledAtMs: number | null;
  /** The guidance headline rendered while finishing. */
  finishingHeadline: string | null;
  context: {
    platform: string;
    armContract: string;
    frameSource: string;
    poseSourceRequested: string;
    poseSourceEffective: string;
    /** What native ANSWERED at start; null when it did not say. */
    poseSourceStarted: string | null;
    frameSourceStarted: string | null;
    /** The status poll interval actually chosen while sweeping. */
    statusPollMs: number | null;
    releasePollMs: number;
    memorySampleMs: number;
  };
  releasePoll: {
    issued: number;
    answered: number;
    /** Ticks skipped because the previous read had not come back. */
    skippedInFlight: number;
    rttMaxMs: number | null;
    /** The RESOLVE time of the first poll that answered `cameraReleased`. */
    cameraReleasedSeenAtMs: number | null;
    rows: SweepReleasePollRow[];
    rowsTruncated: boolean;
  };
  /** Native's own release stamp (epoch ms), when a status carried one. */
  nativeCameraReleasedAtMs: number | null;
  /** The bounded read taken after the stop settled. */
  finalRead: {
    answer: 'answered' | 'no-status' | 'timed-out';
    cameraReleased: boolean | null;
    atMs: number;
  } | null;
  status: {
    rows: SweepStatusRow[];
    /** Own-session arrivals past `SWEEP_TIMELINE_MAX_TICKS`, counted, not kept. */
    rowsDropped: number;
    pushEmpty: number;
    pollNulls: number;
    pollNotRunning: number;
    /** Round trips past `SWEEP_TIMELINE_MAX_TICKS` are not kept (the p95 is
     *  over the kept ones, and says so); the max is running, so it is exact. */
    pollRtts: number[];
    pollRttMaxMs: number | null;
    pollRttsTruncated: boolean;
    foreignSession: number;
  };
  memory: {
    reader: string | null;
    metric: SweepMemoryMetric | null;
    samples: number;
    failed: number;
    inFlightSkipped: number;
    rttMaxMs: number | null;
    baselineMB: number | null;
    endMB: number | null;
    peak: { mb: number; atMs: number; tag: SweepMemoryTag } | null;
    series: SweepMemoryRow[];
    seriesTruncated: boolean;
  };
}

/** A fresh recorder, stamped at the claim. */
export function newSweepTimeline(atMs: number, ctx: SweepTimelineStart): SweepTimeline {
  return {
    holdStartAtMs: atMs,
    sweepingAtMs: null,
    finishingAtMs: null,
    stitchingReportedAtMs: null,
    stopSettledAtMs: null,
    finishingHeadline: null,
    context: {
      platform: ctx.platform,
      armContract: ctx.armContract,
      frameSource: ctx.frameSource,
      poseSourceRequested: ctx.poseSourceRequested,
      poseSourceEffective: ctx.poseSourceEffective,
      poseSourceStarted: null,
      frameSourceStarted: null,
      statusPollMs: null,
      releasePollMs: ctx.releasePollMs,
      memorySampleMs: ctx.memorySampleMs,
    },
    releasePoll: {
      issued: 0,
      answered: 0,
      skippedInFlight: 0,
      rttMaxMs: null,
      cameraReleasedSeenAtMs: null,
      rows: [],
      rowsTruncated: false,
    },
    nativeCameraReleasedAtMs: null,
    finalRead: null,
    status: {
      rows: [],
      rowsDropped: 0,
      pushEmpty: 0,
      pollNulls: 0,
      pollNotRunning: 0,
      pollRtts: [],
      pollRttMaxMs: null,
      pollRttsTruncated: false,
      foreignSession: 0,
    },
    memory: {
      reader: ctx.memoryReader,
      metric: ctx.memoryMetric,
      samples: 0,
      failed: 0,
      inFlightSkipped: 0,
      rttMaxMs: null,
      baselineMB: null,
      endMB: null,
      peak: null,
      series: [],
      seriesTruncated: false,
    },
  };
}

/** Stamp an edge. THE FIRST STAMP WINS: an effect that re-runs on an
 *  unrelated dep must not move an edge that already happened. */
export function markSweepTimeline(t: SweepTimeline, mark: SweepTimelineMark, atMs: number): void {
  switch (mark) {
    case 'sweeping':
      if (t.sweepingAtMs == null) t.sweepingAtMs = atMs;
      return;
    case 'finishing':
      if (t.finishingAtMs == null) t.finishingAtMs = atMs;
      return;
    case 'stitchingReported':
      if (t.stitchingReportedAtMs == null) t.stitchingReportedAtMs = atMs;
      return;
    case 'settled':
      if (t.stopSettledAtMs == null) t.stopSettledAtMs = atMs;
      return;
  }
}

/**
 * One status ARRIVAL, counted where it entered JS and before any filtering.
 *
 * Classified here, cheaply, into what is NOT a tick — a null push (the plugin
 * said nothing), a null poll answer, a poll answering `running: false`, a
 * status about another session — and otherwise kept as one raw row. Which
 * rows carried new content, and which fell in the sweeping window, is decided
 * by the fold, once.
 *
 * The session test is `applyStatus`'s own: a status that cannot be placed is
 * the live sweep's, and nothing is attributable while no sweep is live.
 */
export function tickSweepStatus(
  t: SweepTimeline,
  channel: SweepStatusChannel,
  s: PanoPlusStatus | null,
  atMs: number,
  liveSessionId: string | null,
  issuedAtMs?: number,
): void {
  const st = t.status;
  if (channel === 'poll' && issuedAtMs != null) {
    const rtt = atMs - issuedAtMs;
    st.pollRttMaxMs = st.pollRttMaxMs == null ? rtt : Math.max(st.pollRttMaxMs, rtt);
    if (st.pollRtts.length < SWEEP_TIMELINE_MAX_TICKS) st.pollRtts.push(rtt);
    else st.pollRttsTruncated = true;
  }
  if (s == null) {
    if (channel === 'push') st.pushEmpty += 1;
    else st.pollNulls += 1;
    return;
  }
  if (channel === 'poll' && !s.running) {
    st.pollNotRunning += 1;
    return;
  }
  const id = panoPlusStatusSessionId(s) ?? liveSessionId;
  if (liveSessionId == null || id !== liveSessionId) {
    st.foreignSession += 1;
    return;
  }
  if (st.rows.length >= SWEEP_TIMELINE_MAX_TICKS) {
    st.rowsDropped += 1;
    return;
  }
  st.rows.push([atMs - t.holdStartAtMs, channel === 'push' ? 0 : 1, s.seq, s.previewSeq]);
}

/**
 * Native's release stamp, when one arrived. `0`, absent, non-finite, or
 * earlier than this hold (a stamp this sweep cannot own) is "not reported"
 * — the fail-closed reading, never a time.
 */
function noteNativeRelease(t: SweepTimeline, v: unknown): void {
  if (t.nativeCameraReleasedAtMs != null) return;
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) return;
  if (v < t.holdStartAtMs) return;
  t.nativeCameraReleasedAtMs = v;
}

/**
 * One ANSWERED release poll. `issued` and `skippedInFlight` are the hook's to
 * count, at the tick.
 *
 * A `released` answer that resolves after the stop settled is still counted,
 * but is not "seen during the finish": the finish had already ended, and the
 * final read (`releasedBySettle`) is what records it.
 */
export function noteReleasePoll(
  t: SweepTimeline,
  released: boolean,
  issuedAtMs: number,
  resolvedAtMs: number,
  nativeReleasedAtMs?: unknown,
): void {
  const rp = t.releasePoll;
  rp.answered += 1;
  const rtt = resolvedAtMs - issuedAtMs;
  rp.rttMaxMs = rp.rttMaxMs == null ? rtt : Math.max(rp.rttMaxMs, rtt);
  if (rp.rows.length < SWEEP_TIMELINE_MAX_RELEASE_POLLS) {
    rp.rows.push([issuedAtMs - t.holdStartAtMs, rtt, released ? 1 : 0]);
  } else {
    rp.rowsTruncated = true;
  }
  if (
    released
    && rp.cameraReleasedSeenAtMs == null
    && (t.stopSettledAtMs == null || resolvedAtMs <= t.stopSettledAtMs)
  ) {
    rp.cameraReleasedSeenAtMs = resolvedAtMs;
  }
  noteNativeRelease(t, nativeReleasedAtMs);
}

/**
 * The status read taken after the stop settled. `undefined` is a read that
 * did not answer inside its bound; `null` is an answer with no status in it.
 */
export function noteFinalRead(
  t: SweepTimeline,
  s: PanoPlusStatus | null | undefined,
  atMs: number,
): void {
  t.finalRead = {
    answer: s === undefined ? 'timed-out' : s === null ? 'no-status' : 'answered',
    cameraReleased: s == null ? null : s.cameraReleased,
    atMs,
  };
  if (s != null) noteNativeRelease(t, s.cameraReleasedAtMs);
}

/**
 * One memory read. `null`, a negative value (native's `-1` failure answer) or
 * a non-finite one is a FAILED read and is never a sample — so it can never
 * be the peak, and a sweep whose every read failed has no peak at all rather
 * than a peak of 0.
 */
export function noteMemorySample(
  t: SweepTimeline,
  mb: number | null,
  issuedAtMs: number,
  resolvedAtMs: number,
  tag: SweepMemoryTag,
): void {
  const m = t.memory;
  const rtt = resolvedAtMs - issuedAtMs;
  m.rttMaxMs = m.rttMaxMs == null ? rtt : Math.max(m.rttMaxMs, rtt);
  if (mb == null || !Number.isFinite(mb) || mb < 0) {
    m.failed += 1;
    return;
  }
  m.samples += 1;
  if (tag === 'b' && m.baselineMB == null) m.baselineMB = mb;
  if (tag === 'e') m.endMB = mb;
  if (m.peak == null || mb > m.peak.mb) m.peak = { mb, atMs: issuedAtMs, tag };
  if (m.series.length < SWEEP_TIMELINE_MAX_MEMORY_ROWS) {
    m.series.push([issuedAtMs - t.holdStartAtMs, mb, tag]);
  } else {
    m.seriesTruncated = true;
  }
}

// ── THE FOLD ────────────────────────────────────────────────────────────────

const round1 = (v: number): number => Math.round(v * 10) / 10;
const round2 = (v: number): number => Math.round(v * 100) / 100;
const r1OrNull = (v: number | null | undefined): number | null => (v == null ? null : round1(v));
const since = (a: number | null, b: number | null): number | null => (
  a == null || b == null ? null : b - a
);

/** Nearest-rank percentile of an already-sorted array; null when empty. */
function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[i]!;
}

/**
 * The gaps between consecutive arrivals INCLUDING the two window edges — the
 * longest stretch of the sweep in which this channel told JS nothing. A
 * channel silent for the whole window has one gap, the window itself.
 */
function gapsOf(times: number[], start: number | null, end: number | null): number[] | null {
  if (start == null || end == null) return null;
  const gaps: number[] = [];
  let prev = start;
  for (const at of times) {
    gaps.push(at - prev);
    prev = at;
  }
  gaps.push(end - prev);
  return gaps;
}

/** The fewest arrivals in any FULL one-second bucket of the window; null when
 *  the window holds no full second. */
function worstFullSecond(times: number[], start: number | null, windowMs: number | null): number | null {
  if (start == null || windowMs == null) return null;
  const full = Math.floor(windowMs / 1000);
  if (full < 1) return null;
  const counts = new Array<number>(full).fill(0);
  for (const at of times) {
    const k = Math.floor((at - start) / 1000);
    if (k >= 0 && k < full) counts[k] += 1;
  }
  return Math.min(...counts);
}

function channelRate(
  times: number[],
  newTimes: number[],
  start: number | null,
  end: number | null,
  windowMs: number | null,
  rated: boolean,
) {
  const gaps = gapsOf(times, start, end);
  const sorted = gaps == null ? [] : [...gaps].sort((a, b) => a - b);
  return {
    ticks: times.length,
    perS: rated ? round2((times.length * 1000) / windowMs!) : null,
    newSeq: newTimes.length,
    newSeqPerS: rated ? round2((newTimes.length * 1000) / windowMs!) : null,
    maxGapMs: sorted.length > 0 ? sorted[sorted.length - 1]! : null,
    p50GapMs: percentile(sorted, 50),
    p95GapMs: percentile(sorted, 95),
  };
}

/** The phase a moment falls in, from the stamped edges. */
function phaseAt(t: SweepTimeline, atMs: number): SweepTimelinePhase {
  if (t.sweepingAtMs == null || atMs < t.sweepingAtMs) return 'starting';
  if (t.finishingAtMs == null || atMs < t.finishingAtMs) return 'sweeping';
  if (t.stopSettledAtMs == null || atMs < t.stopSettledAtMs) return 'finishing';
  return 'settled';
}

function foldFinish(t: SweepTimeline) {
  const seen = t.releasePoll.cameraReleasedSeenAtMs;
  const native = t.nativeCameraReleasedAtMs;
  const stitching = t.stitchingReportedAtMs;
  const settled = t.stopSettledAtMs;
  // THE CHAIN `finishing ≤ release seen ≤ stitching ≤ settled`, and native's
  // own stamp no later than the poll that saw it. Each break is NAMED, so a
  // file that fails says which link failed rather than only that one did.
  const orderViolations: string[] = [];
  if (stitching != null && seen == null) orderViolations.push('stitching-without-release');
  if (seen != null && t.finishingAtMs != null && seen < t.finishingAtMs) {
    orderViolations.push('release-seen-before-finishing');
  }
  if (stitching != null && seen != null && stitching < seen) {
    orderViolations.push('stitching-before-release-seen');
  }
  if (stitching != null && settled != null && settled < stitching) {
    orderViolations.push('settled-before-stitching');
  }
  if (native != null && seen != null && native > seen) {
    orderViolations.push('native-release-after-js-saw-it');
  }
  return {
    holdStartAtMs: t.holdStartAtMs,
    sweepingAtMs: t.sweepingAtMs,
    finishingAtMs: t.finishingAtMs,
    finishingHeadline: t.finishingHeadline,
    releasePoll: {
      issued: t.releasePoll.issued,
      answered: t.releasePoll.answered,
      skippedInFlight: t.releasePoll.skippedInFlight,
      rttMaxMs: t.releasePoll.rttMaxMs,
      rows: t.releasePoll.rows,
      rowsTruncated: t.releasePoll.rowsTruncated,
    },
    cameraReleasedSeenAtMs: seen,
    stitchingReportedAtMs: stitching,
    stopSettledAtMs: settled,
    /** What the read after the settle said — `null` when it did not answer. */
    releasedBySettle: t.finalRead?.cameraReleased ?? null,
    finalRead: t.finalRead?.answer ?? null,
    nativeCameraReleasedAtMs: native,
    // ⚠ THE REMOUNT IS NOT A TIMESTAMP, and cannot be one: this file is
    // written before the commit that remounts the camera. It follows the
    // settle BY CONSTRUCTION — `stitching` is `finishing && released`, the
    // phase goes idle in the same callback as this write, and `<Camera>`
    // clears its stitching state on the sweep's falling edge.
    remount: 'at-settle-by-construction' as const,
    derived: {
      startMs: since(t.holdStartAtMs, t.sweepingAtMs),
      finishMs: since(t.finishingAtMs, settled),
      finishingToReleaseSeenMs: since(t.finishingAtMs, seen),
      releaseSeenToStitchingMs: since(seen, stitching),
      stitchingToSettledMs: since(stitching, settled),
      nativeReleaseToSeenMs: since(native, seen),
      /** How long the stop ran on after native let the camera go. */
      releaseToSettledMs: since(native, settled),
      /** The engine reported `stitching`, which `<Camera>` maps to unmounting
       *  its camera for the rest of the finish. */
      cameraUnmountedDuringFinish: stitching != null,
      orderOk: orderViolations.length === 0,
      orderViolations,
    },
  };
}

function foldStatusRate(t: SweepTimeline) {
  const start = t.sweepingAtMs;
  const end = t.finishingAtMs;
  const windowMs = start != null && end != null ? Math.max(0, end - start) : null;
  // A window under a second — a release in the start window finishes at once
  // — has no meaningful rate, so every rate is null rather than a number
  // extrapolated from a handful of ticks.
  const rated = windowMs != null && windowMs >= 1000;
  const all: number[] = [];
  const push: number[] = [];
  const poll: number[] = [];
  const allNew: number[] = [];
  const pushNew: number[] = [];
  const pollNew: number[] = [];
  let preSweep = 0;
  let afterFinishing = 0;
  let newPreview = 0;
  let seqFirst: number | null = null;
  let seqLast: number | null = null;
  // NEW CONTENT IS A REPLAY OF THE ARRIVALS, IN ORDER, ACROSS BOTH CHANNELS:
  // a tick is new when its `seq` beats every `seq` JS had already been
  // handed, on either channel. A poll racing the push reads the SAME native
  // snapshot, so its repeat is a tick but not new content. `seq` -1 (Android,
  // before the first row) is never new; nor is `previewSeq` 0 (nothing
  // published yet).
  let maxSeq = -1;
  let maxPreviewSeq = 0;
  for (const [dt, ch, seq, previewSeq] of t.status.rows) {
    const at = t.holdStartAtMs + dt;
    const isNew = seq > maxSeq;
    if (isNew) maxSeq = seq;
    const isNewPreview = previewSeq > maxPreviewSeq;
    if (isNewPreview) maxPreviewSeq = previewSeq;
    if (start == null || at < start) { preSweep += 1; continue; }
    if (end != null && at >= end) { afterFinishing += 1; continue; }
    all.push(at);
    (ch === 0 ? push : poll).push(at);
    if (isNew) {
      allNew.push(at);
      (ch === 0 ? pushNew : pollNew).push(at);
    }
    if (isNewPreview) newPreview += 1;
    if (seq >= 0) {
      seqFirst = seqFirst == null ? seq : Math.min(seqFirst, seq);
      seqLast = seqLast == null ? seq : Math.max(seqLast, seq);
    }
  }
  for (const a of [all, push, poll, allNew, pushNew, pollNew]) a.sort((x, y) => x - y);
  const rtts = [...t.status.pollRtts].sort((a, b) => a - b);
  const newGaps = gapsOf(allNew, start, end);
  return {
    windowStartAtMs: start,
    windowEndAtMs: end,
    windowMs,
    all: {
      ...channelRate(all, allNew, start, end, windowMs, rated),
      maxNewSeqGapMs: newGaps == null ? null : Math.max(...newGaps),
      worst1sTicks: worstFullSecond(all, start, windowMs),
      worst1sNewSeq: worstFullSecond(allNew, start, windowMs),
    },
    push: {
      ...channelRate(push, pushNew, start, end, windowMs, rated),
      empty: t.status.pushEmpty,
    },
    poll: {
      ...channelRate(poll, pollNew, start, end, windowMs, rated),
      // The max over EVERY round trip; the p95 over the kept ones, which are
      // the first `SWEEP_TIMELINE_MAX_TICKS` when `rttsTruncated` says so — a
      // finalize-time wedge past the cap still reaches the max.
      rttMaxMs: t.status.pollRttMaxMs,
      rttP95Ms: percentile(rtts, 95),
      rttsTruncated: t.status.pollRttsTruncated,
      nulls: t.status.pollNulls,
      notRunning: t.status.pollNotRunning,
    },
    foreignSession: t.status.foreignSession,
    preSweep,
    afterFinishing,
    /** The engine-side row rate: how fast native's own `seq` advanced. */
    seq: {
      first: seqFirst,
      last: seqLast,
      advancePerS: rated && seqFirst != null && seqLast != null
        ? round2(((seqLast - seqFirst) * 1000) / windowMs!)
        : null,
    },
    previewSeq: {
      newCount: newPreview,
      newPerS: rated ? round2((newPreview * 1000) / windowMs!) : null,
    },
    ticksTruncated: t.status.rowsDropped > 0,
    ticksDropped: t.status.rowsDropped,
    rows: t.status.rows,
  };
}

function foldMemory(t: SweepTimeline) {
  const m = t.memory;
  let peakSweeping: number | null = null;
  let peakFinishing: number | null = null;
  for (const [dt, mb] of m.series) {
    const phase = phaseAt(t, t.holdStartAtMs + dt);
    if (phase === 'sweeping') peakSweeping = peakSweeping == null ? mb : Math.max(peakSweeping, mb);
    else if (phase === 'finishing') peakFinishing = peakFinishing == null ? mb : Math.max(peakFinishing, mb);
  }
  return {
    reader: m.reader,
    // ⚠ THE METRIC TRAVELS WITH EVERY NUMBER. iOS answers `phys_footprint`
    // (what jetsam judges); Android answers resident set size from
    // `/proc/self/statm`, which is NOT the proportional set size other
    // recorders report — so two Android peaks are comparable only when this
    // field matches.
    metric: m.metric,
    cadenceMs: t.context.memorySampleMs,
    unavailable: m.reader == null ? 'no-reader' : m.samples === 0 ? 'no-sample' : null,
    baselineMB: r1OrNull(m.baselineMB),
    // SAMPLED, not a high-water mark: a transient between two samples is not
    // in it. `cadenceMs` and the tagged series say how coarse it is.
    peakMemoryMB: r1OrNull(m.peak?.mb),
    peakAtMs: m.peak?.atMs ?? null,
    peakTag: m.peak?.tag ?? null,
    peakPhase: m.peak == null ? null : phaseAt(t, m.peak.atMs),
    peakSweepingMB: r1OrNull(peakSweeping),
    peakFinishingMB: r1OrNull(peakFinishing),
    endMB: r1OrNull(m.endMB),
    samples: m.samples,
    failed: m.failed,
    inFlightSkipped: m.inFlightSkipped,
    rttMaxMs: m.rttMaxMs,
    series: m.series.map(([dt, mb, tag]) => [dt, round1(mb), tag] as SweepMemoryRow),
    seriesTruncated: m.seriesTruncated,
  };
}

/** The whole fold — pure, and run once, when the file is written. */
export function summarizeSweepTimeline(t: SweepTimeline) {
  const { platform, ...context } = t.context;
  const memory = foldMemory(t);
  return {
    platform,
    context,
    finish: foldFinish(t),
    statusRate: foldStatusRate(t),
    memory,
    peakMemoryMB: memory.peakMemoryMB,
  };
}

/** What only the settle knows. */
export interface SweepTimelineFinal {
  /** `'resolved'`, or `'rejected:<code>'` for a stop that rejected with a pack. */
  outcome: string;
  /** The directory the stop answered — where this file is written. */
  sessionDir: string;
  /** Native's own `finalizeMs` from the summary; null on a rejection. */
  nativeFinalizeMs: number | null;
  writtenAtMs?: number;
}

/**
 * The bytes of {@link PANO_PLUS_SWEEP_TIMELINE_FILE}.
 *
 * PURE, like `panoPlusSweepHudSidecar`: the write happens in the hook, where
 * nothing can be asserted, and a sidecar that silently emitted `{}` would look
 * exactly like a sweep with nothing to report.
 *
 * `peakMemoryMB` is mirrored at the top level so the one number a reader is
 * looking for is found without knowing the file's shape.
 */
export function panoPlusSweepTimelineSidecar(t: SweepTimeline, final: SweepTimelineFinal): string {
  const s = summarizeSweepTimeline(t);
  return JSON.stringify(
    {
      schema: SWEEP_TIMELINE_SCHEMA,
      writtenAtMs: final.writtenAtMs ?? Date.now(),
      sessionDir: final.sessionDir,
      platform: s.platform,
      outcome: final.outcome,
      context: s.context,
      finish: { ...s.finish, nativeFinalizeMs: final.nativeFinalizeMs },
      statusRate: s.statusRate,
      memory: s.memory,
      peakMemoryMB: s.peakMemoryMB,
    },
    null,
    2,
  );
}
