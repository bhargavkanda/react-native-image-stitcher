// SPDX-License-Identifier: Apache-2.0
//
// sweepTimeline — the per-sweep recorder and the fold behind
// `host_sweep_timeline.json`.
//
// What these pin, and the failure each one prevents:
//
//   1. THE FILE SAYS NOTHING RATHER THAN SOMETHING FALSE. A release nobody saw
//      is `null`, not 0; a sweep whose memory reads all failed has no peak,
//      not a peak of 0; a window too short to rate has null rates. Each of
//      those, collapsed to a number, reads as a measurement.
//   2. THE ORDER OF THE FINISH is checked link by link, and a broken link is
//      NAMED — `finishing ≤ release seen ≤ stitching ≤ settled`.
//   3. NEW CONTENT IS NOT THE SAME AS A TICK. A poll that reads the snapshot
//      the push already delivered is a tick of the channel and not a new
//      `seq`; the rate gate and the content rate are different questions.
//   4. THE OBJECT IS THE GENERATION. What was noted into a dropped sweep's
//      timeline cannot appear in the next sweep's file.
//   5. EVERY CAP SAYS SO. A truncated record must not read as a complete one.

import { coercePanoPlusStatus } from '../panoPlusModel';
import type { PanoPlusStatus } from '../panoPlusTypes';
import {
  PANO_PLUS_SWEEP_TIMELINE_FILE,
  SWEEP_TIMELINE_MAX_MEMORY_ROWS,
  SWEEP_TIMELINE_MAX_RELEASE_POLLS,
  SWEEP_TIMELINE_MAX_TICKS,
  SWEEP_TIMELINE_SCHEMA,
  markSweepTimeline,
  newSweepTimeline,
  noteFinalRead,
  noteMemorySample,
  noteReleasePoll,
  panoPlusSweepTimelineSidecar,
  summarizeSweepTimeline,
  tickSweepStatus,
  type SweepTimeline,
} from '../sweepTimeline';

const T0 = 1_790_000_000_000;
const LIVE = 'pp_1';

function timeline(over: { memoryReader?: string | null } = {}): SweepTimeline {
  return newSweepTimeline(T0, {
    platform: 'ios',
    armContract: 'ios-coremotion',
    frameSource: 'host-ar',
    // A selected IMU arm that fell back to ARKit: the one case where the two
    // differ, so a context that swapped or merged them cannot pass.
    poseSourceRequested: 'imu',
    poseSourceEffective: 'ar',
    releasePollMs: 100,
    memorySampleMs: 250,
    memoryReader: over.memoryReader === undefined
      ? 'IncrementalStitcher.getMemoryFootprintMB'
      : over.memoryReader,
    memoryMetric: 'phys_footprint',
  });
}

/** A complete live status, through the real coercion. */
function st(seq: number, previewSeq = 0, over: Record<string, unknown> = {}): PanoPlusStatus {
  return coercePanoPlusStatus({
    running: true, sessionDir: `/d/${LIVE}`, seq, previewSeq, ...over,
  })!;
}

type Parsed = Record<string, any>;
const parse = (t: SweepTimeline, outcome = 'resolved'): Parsed => JSON.parse(
  panoPlusSweepTimelineSidecar(t, {
    outcome, sessionDir: `/d/${LIVE}`, nativeFinalizeMs: 78, writtenAtMs: T0 + 9_999,
  }),
) as Parsed;

describe('the sidecar', () => {
  it('names its file and schema, and round-trips through JSON', () => {
    expect(PANO_PLUS_SWEEP_TIMELINE_FILE).toBe('host_sweep_timeline.json');
    const t = timeline();
    markSweepTimeline(t, 'sweeping', T0 + 400);
    markSweepTimeline(t, 'finishing', T0 + 5400);
    markSweepTimeline(t, 'settled', T0 + 5480);
    const f = parse(t);
    expect(f.schema).toBe(SWEEP_TIMELINE_SCHEMA);
    expect(f.schema).toBe('panoplus-host-sweep-timeline/1');
    expect(f.writtenAtMs).toBe(T0 + 9_999);
    expect(f.sessionDir).toBe('/d/pp_1');
    expect(f.platform).toBe('ios');
    expect(f.outcome).toBe('resolved');
    // `poseSourceRequested` / `poseSourceEffective` are `host_notice.json`'s
    // keys with its meanings — the selected arm, and the arm sent to native.
    expect(f.context).toEqual({
      armContract: 'ios-coremotion',
      frameSource: 'host-ar',
      poseSourceRequested: 'imu',
      poseSourceEffective: 'ar',
      poseSourceStarted: null,
      frameSourceStarted: null,
      statusPollMs: null,
      releasePollMs: 100,
      memorySampleMs: 250,
    });
    expect(f.finish.nativeFinalizeMs).toBe(78);
    // Every block the file promises is there.
    for (const k of ['finish', 'statusRate', 'memory', 'peakMemoryMB']) expect(f).toHaveProperty(k);
  });

  it('keeps NULL as null — a release nobody saw is not a release at 0', () => {
    const t = timeline({ memoryReader: null });
    markSweepTimeline(t, 'sweeping', T0 + 400);
    markSweepTimeline(t, 'finishing', T0 + 900);
    markSweepTimeline(t, 'settled', T0 + 950);
    const f = parse(t);
    expect(f.finish.cameraReleasedSeenAtMs).toBeNull();
    expect(f.finish.stitchingReportedAtMs).toBeNull();
    expect(f.finish.nativeCameraReleasedAtMs).toBeNull();
    expect(f.finish.releasedBySettle).toBeNull();
    expect(f.finish.finishingHeadline).toBeNull();
    expect(f.finish.releasePoll.rttMaxMs).toBeNull();
    expect(f.memory.peakMemoryMB).toBeNull();
    expect(f.peakMemoryMB).toBeNull();
    expect(f.memory.unavailable).toBe('no-reader');
  });
});

describe('the finish timeline', () => {
  it('release seen → stitching → settle is in order, with the deltas', () => {
    const t = timeline();
    markSweepTimeline(t, 'sweeping', T0 + 400);
    markSweepTimeline(t, 'finishing', T0 + 5000);
    t.finishingHeadline = 'Finishing the panorama…';
    t.releasePoll.issued += 2;
    noteReleasePoll(t, false, T0 + 5100, T0 + 5104);
    noteReleasePoll(t, true, T0 + 5200, T0 + 5206, T0 + 5150);
    markSweepTimeline(t, 'stitchingReported', T0 + 5210);
    markSweepTimeline(t, 'settled', T0 + 5400);
    noteFinalRead(t, st(0, 0, { running: false, cameraReleased: true }), T0 + 5402);
    const f = summarizeSweepTimeline(t).finish;
    expect(f.releasePoll).toMatchObject({ issued: 2, answered: 2, skippedInFlight: 0, rttMaxMs: 6 });
    expect(f.releasePoll.rows).toEqual([[5100, 4, 0], [5200, 6, 1]]);
    expect(f.cameraReleasedSeenAtMs).toBe(T0 + 5206);
    expect(f.nativeCameraReleasedAtMs).toBe(T0 + 5150);
    expect(f.releasedBySettle).toBe(true);
    expect(f.finalRead).toBe('answered');
    expect(f.remount).toBe('at-settle-by-construction');
    expect(f.derived).toEqual({
      startMs: 400,
      finishMs: 400,
      finishingToReleaseSeenMs: 206,
      releaseSeenToStitchingMs: 4,
      stitchingToSettledMs: 190,
      nativeReleaseToSeenMs: 56,
      releaseToSettledMs: 250,
      cameraUnmountedDuringFinish: true,
      orderOk: true,
      orderViolations: [],
    });
  });

  it('a finish that OUTRAN the poll is recorded as such, not hidden — and is in order', () => {
    const t = timeline();
    markSweepTimeline(t, 'sweeping', T0 + 400);
    markSweepTimeline(t, 'finishing', T0 + 5000);
    t.releasePoll.issued += 1;
    noteReleasePoll(t, false, T0 + 5100, T0 + 5103);
    markSweepTimeline(t, 'settled', T0 + 5140);
    // The read after the settle sees what the poll never did.
    noteFinalRead(t, st(0, 0, { running: false, cameraReleased: true }), T0 + 5142);
    const f = summarizeSweepTimeline(t).finish;
    expect(f.cameraReleasedSeenAtMs).toBeNull();
    expect(f.releasedBySettle).toBe(true);
    expect(f.derived.cameraUnmountedDuringFinish).toBe(false);
    expect(f.derived.orderOk).toBe(true);
    expect(f.derived.finishingToReleaseSeenMs).toBeNull();
  });

  it('names a stitching report with no release seen', () => {
    const t = timeline();
    markSweepTimeline(t, 'sweeping', T0 + 400);
    markSweepTimeline(t, 'finishing', T0 + 5000);
    markSweepTimeline(t, 'stitchingReported', T0 + 5200);
    markSweepTimeline(t, 'settled', T0 + 5400);
    const f = summarizeSweepTimeline(t).finish;
    expect(f.derived.orderOk).toBe(false);
    expect(f.derived.orderViolations).toEqual(['stitching-without-release']);
  });

  it('names every other broken link', () => {
    const t = timeline();
    markSweepTimeline(t, 'sweeping', T0 + 400);
    markSweepTimeline(t, 'finishing', T0 + 5000);
    // Seen BEFORE finishing (impossible in the hook — the fold must still say
    // so), native stamping LATER than the poll that saw it, stitching before
    // the release was seen, and a settle before the stitching report.
    noteReleasePoll(t, true, T0 + 4900, T0 + 4950, T0 + 4990);
    markSweepTimeline(t, 'stitchingReported', T0 + 4940);
    markSweepTimeline(t, 'settled', T0 + 4930);
    expect(summarizeSweepTimeline(t).finish.derived.orderViolations).toEqual([
      'release-seen-before-finishing',
      'stitching-before-release-seen',
      'settled-before-stitching',
      'native-release-after-js-saw-it',
    ]);
  });

  it('counts a tick skipped behind an unanswered read', () => {
    const t = timeline();
    t.releasePoll.issued += 1;
    t.releasePoll.skippedInFlight += 3;
    noteReleasePoll(t, false, T0 + 5100, T0 + 5480);
    const f = summarizeSweepTimeline(t).finish;
    expect(f.releasePoll.skippedInFlight).toBe(3);
    expect(f.releasePoll.rttMaxMs).toBe(380);
  });

  it('a release answered AFTER the settle is not "seen during the finish"', () => {
    const t = timeline();
    markSweepTimeline(t, 'sweeping', T0 + 400);
    markSweepTimeline(t, 'finishing', T0 + 5000);
    markSweepTimeline(t, 'settled', T0 + 5100);
    noteReleasePoll(t, true, T0 + 5090, T0 + 5130);
    expect(t.releasePoll.answered).toBe(1);
    expect(t.releasePoll.cameraReleasedSeenAtMs).toBeNull();
  });

  it('reads native\'s release stamp fail-closed: 0, absent, junk or pre-hold is null', () => {
    for (const v of [0, undefined, null, Number.NaN, -5, 'x', T0 - 1]) {
      const t = timeline();
      noteReleasePoll(t, true, T0 + 100, T0 + 110, v);
      noteFinalRead(t, st(0, 0, { cameraReleasedAtMs: v }), T0 + 200);
      expect(t.nativeCameraReleasedAtMs).toBeNull();
    }
    const t = timeline();
    noteFinalRead(t, st(0, 0, { cameraReleasedAtMs: T0 + 150 }), T0 + 200);
    expect(t.nativeCameraReleasedAtMs).toBe(T0 + 150);
  });

  it('tells a final read that did not answer from one that answered no status', () => {
    const t = timeline();
    noteFinalRead(t, undefined, T0 + 1);
    expect(summarizeSweepTimeline(t).finish.finalRead).toBe('timed-out');
    expect(summarizeSweepTimeline(t).finish.releasedBySettle).toBeNull();
    noteFinalRead(t, null, T0 + 2);
    expect(summarizeSweepTimeline(t).finish.finalRead).toBe('no-status');
  });

  it('the first stamp of an edge wins', () => {
    const t = timeline();
    markSweepTimeline(t, 'stitchingReported', T0 + 10);
    markSweepTimeline(t, 'stitchingReported', T0 + 20);
    expect(t.stitchingReportedAtMs).toBe(T0 + 10);
  });
});

describe('the status rate', () => {
  /** A 5 s window: push every 100 ms, poll every 500 ms, fresh seq each push. */
  function fiveSeconds(): SweepTimeline {
    const t = timeline();
    markSweepTimeline(t, 'sweeping', T0);
    let seq = 0;
    for (let ms = 0; ms < 5000; ms += 100) {
      seq += 1;
      tickSweepStatus(t, 'push', st(seq, seq), T0 + ms, LIVE);
      if (ms % 500 === 0) {
        // The poll reads the SAME native snapshot the push just delivered.
        tickSweepStatus(t, 'poll', st(seq, seq), T0 + ms + 2, LIVE, T0 + ms);
      }
    }
    markSweepTimeline(t, 'finishing', T0 + 5000);
    return t;
  }

  it('push 10/s + poll 2/s reads as 12/s on all, per channel beside it', () => {
    const r = summarizeSweepTimeline(fiveSeconds()).statusRate;
    expect(r.windowMs).toBe(5000);
    expect(r.all.ticks).toBe(60);
    expect(r.all.perS).toBeCloseTo(12, 5);
    expect(r.push.perS).toBeCloseTo(10, 5);
    expect(r.poll.perS).toBeCloseTo(2, 5);
    expect(r.all.worst1sTicks).toBe(12);
    expect(r.poll.rttMaxMs).toBe(2);
    expect(r.poll.rttP95Ms).toBe(2);
  });

  it('a poll racing the push is a TICK but not new content', () => {
    const r = summarizeSweepTimeline(fiveSeconds()).statusRate;
    expect(r.push.newSeq).toBe(50);
    expect(r.poll.ticks).toBe(10);
    expect(r.poll.newSeq).toBe(0);
    expect(r.all.newSeq).toBe(50);
    expect(r.all.newSeqPerS).toBeCloseTo(10, 5);
    expect(r.all.worst1sNewSeq).toBe(10);
    expect(r.previewSeq.newCount).toBe(50);
    expect(r.seq).toEqual({ first: 1, last: 50, advancePerS: 9.8 });
  });

  it('a LOWER seq is a tick and not new; seq -1 is never new', () => {
    const t = timeline();
    markSweepTimeline(t, 'sweeping', T0);
    tickSweepStatus(t, 'poll', st(-1), T0 + 50, LIVE, T0);
    tickSweepStatus(t, 'push', st(-1), T0 + 100, LIVE);
    tickSweepStatus(t, 'push', st(5), T0 + 200, LIVE);
    tickSweepStatus(t, 'poll', st(4), T0 + 300, LIVE, T0 + 250);
    tickSweepStatus(t, 'push', st(5), T0 + 400, LIVE);
    markSweepTimeline(t, 'finishing', T0 + 1500);
    const r = summarizeSweepTimeline(t).statusRate;
    expect(r.all.ticks).toBe(5);
    expect(r.all.newSeq).toBe(1);
    expect(r.seq.first).toBe(4);
  });

  it('a 600 ms hole shows as the max gap, and drags the worst second under 8', () => {
    const t = timeline();
    markSweepTimeline(t, 'sweeping', T0);
    let seq = 0;
    for (let ms = 0; ms < 3000; ms += 100) {
      if (ms > 1100 && ms < 1700) continue;   // nothing from 1200 to 1600
      seq += 1;
      tickSweepStatus(t, 'push', st(seq), T0 + ms, LIVE);
    }
    markSweepTimeline(t, 'finishing', T0 + 3000);
    const r = summarizeSweepTimeline(t).statusRate;
    expect(r.all.maxGapMs).toBe(600);
    expect(r.all.maxNewSeqGapMs).toBe(600);
    expect(r.all.p50GapMs).toBe(100);
    expect(r.all.worst1sTicks).toBeLessThan(8);
  });

  it('a channel silent for the whole window has ONE gap: the window', () => {
    const t = timeline();
    markSweepTimeline(t, 'sweeping', T0);
    tickSweepStatus(t, 'push', null, T0 + 100, LIVE);
    tickSweepStatus(t, 'poll', st(1), T0 + 200, LIVE, T0 + 190);
    markSweepTimeline(t, 'finishing', T0 + 2000);
    const r = summarizeSweepTimeline(t).statusRate;
    expect(r.push.ticks).toBe(0);
    expect(r.push.empty).toBe(1);
    expect(r.push.maxGapMs).toBe(2000);
    expect(r.push.perS).toBe(0);
  });

  it('a foreign session is COUNTED and not rated; nulls and not-running are not ticks', () => {
    const t = timeline();
    markSweepTimeline(t, 'sweeping', T0);
    tickSweepStatus(t, 'push', st(900, 0, { sessionDir: '/d/pp_0' }), T0 + 100, LIVE);
    tickSweepStatus(t, 'push', st(1), T0 + 150, null);   // no live sweep to own it
    tickSweepStatus(t, 'poll', null, T0 + 200, LIVE, T0 + 190);
    tickSweepStatus(t, 'poll', st(2, 0, { running: false }), T0 + 300, LIVE, T0 + 290);
    tickSweepStatus(t, 'push', st(3), T0 + 400, LIVE);
    markSweepTimeline(t, 'finishing', T0 + 1200);
    const r = summarizeSweepTimeline(t).statusRate;
    expect(r.foreignSession).toBe(2);
    expect(r.poll.nulls).toBe(1);
    expect(r.poll.notRunning).toBe(1);
    expect(r.all.ticks).toBe(1);
    expect(r.all.newSeq).toBe(1);
    // Both unrated polls still had a round trip.
    expect(r.poll.rttMaxMs).toBe(10);
  });

  it('keeps arrivals outside the window as raw rows, and rates none of them', () => {
    const t = timeline();
    tickSweepStatus(t, 'push', st(1), T0 + 100, LIVE);   // still starting
    markSweepTimeline(t, 'sweeping', T0 + 200);
    tickSweepStatus(t, 'push', st(2), T0 + 300, LIVE);
    markSweepTimeline(t, 'finishing', T0 + 1400);
    tickSweepStatus(t, 'poll', st(3), T0 + 1450, LIVE, T0 + 1300);   // answered late
    const r = summarizeSweepTimeline(t).statusRate;
    expect(r.preSweep).toBe(1);
    expect(r.afterFinishing).toBe(1);
    expect(r.all.ticks).toBe(1);
    // The pre-sweep row still set the bar a later repeat must beat.
    expect(r.rows).toEqual([[100, 0, 1, 0], [300, 0, 2, 0], [1450, 1, 3, 0]]);
  });

  it('a window under one second has NULL rates, never an extrapolation', () => {
    const t = timeline();
    markSweepTimeline(t, 'sweeping', T0);
    tickSweepStatus(t, 'push', st(1, 1), T0 + 50, LIVE);
    markSweepTimeline(t, 'finishing', T0 + 120);
    const r = summarizeSweepTimeline(t).statusRate;
    expect(r.all.ticks).toBe(1);
    expect(r.all.perS).toBeNull();
    expect(r.all.newSeqPerS).toBeNull();
    expect(r.all.worst1sTicks).toBeNull();
    expect(r.seq.advancePerS).toBeNull();
    expect(r.previewSeq.newPerS).toBeNull();
  });

  it('the row past the cap sets ticksTruncated and is counted, not kept', () => {
    const t = timeline();
    markSweepTimeline(t, 'sweeping', T0);
    for (let i = 0; i < SWEEP_TIMELINE_MAX_TICKS; i += 1) {
      tickSweepStatus(t, 'push', st(i), T0 + i, LIVE);
    }
    expect(summarizeSweepTimeline(t).statusRate.ticksTruncated).toBe(false);
    tickSweepStatus(t, 'push', st(SWEEP_TIMELINE_MAX_TICKS), T0 + SWEEP_TIMELINE_MAX_TICKS, LIVE);
    const r = summarizeSweepTimeline(t).statusRate;
    expect(r.rows).toHaveLength(SWEEP_TIMELINE_MAX_TICKS);
    expect(r.ticksTruncated).toBe(true);
    expect(r.ticksDropped).toBe(1);
  });

  it('the round trips past the cap say so — and the max stays exact past it', () => {
    const t = timeline();
    markSweepTimeline(t, 'sweeping', T0);
    for (let i = 0; i < SWEEP_TIMELINE_MAX_TICKS; i += 1) {
      tickSweepStatus(t, 'poll', st(i), T0 + i + 3, LIVE, T0 + i);
    }
    let r = summarizeSweepTimeline(t).statusRate;
    expect(r.poll.rttsTruncated).toBe(false);
    expect(r.poll.rttMaxMs).toBe(3);
    // A finalize-time wedge AFTER the cap: kept out of the p95's sample, and
    // still the max — the one number an RCA of a stalled channel reads first.
    tickSweepStatus(t, 'poll', null, T0 + 9_900, LIVE, T0 + 9_000);
    r = summarizeSweepTimeline(t).statusRate;
    expect(r.poll.rttsTruncated).toBe(true);
    expect(r.poll.rttMaxMs).toBe(900);
    expect(r.poll.rttP95Ms).toBe(3);
  });
});

describe('sampled memory', () => {
  it('finds the peak and the phase it fell in', () => {
    const t = timeline();
    noteMemorySample(t, 610.04, T0, T0 + 3, 'b');
    markSweepTimeline(t, 'sweeping', T0 + 400);
    noteMemorySample(t, 700, T0 + 400, T0 + 402, 's');
    noteMemorySample(t, 760.26, T0 + 650, T0 + 655, 'p');
    markSweepTimeline(t, 'finishing', T0 + 5000);
    noteMemorySample(t, 905.55, T0 + 5000, T0 + 5004, 'f');
    noteMemorySample(t, 880, T0 + 5250, T0 + 5251, 'p');
    markSweepTimeline(t, 'settled', T0 + 5400);
    noteMemorySample(t, 720, T0 + 5401, T0 + 5420, 'e');
    const m = summarizeSweepTimeline(t).memory;
    expect(m.reader).toBe('IncrementalStitcher.getMemoryFootprintMB');
    expect(m.metric).toBe('phys_footprint');
    expect(m.unavailable).toBeNull();
    expect(m.baselineMB).toBe(610);
    expect(m.peakMemoryMB).toBe(905.6);
    expect(m.peakTag).toBe('f');
    expect(m.peakPhase).toBe('finishing');
    expect(m.peakAtMs).toBe(T0 + 5000);
    expect(m.peakSweepingMB).toBe(760.3);
    expect(m.peakFinishingMB).toBe(905.6);
    expect(m.endMB).toBe(720);
    expect(m.samples).toBe(6);
    expect(m.rttMaxMs).toBe(19);
    expect(m.series[0]).toEqual([0, 610, 'b']);
    expect(summarizeSweepTimeline(t).peakMemoryMB).toBe(905.6);
  });

  it('counts -1, NaN and null as FAILED reads — never a sample, never the peak', () => {
    const t = timeline();
    noteMemorySample(t, -1, T0, T0 + 1, 'b');
    noteMemorySample(t, null, T0 + 250, T0 + 251, 'p');
    noteMemorySample(t, Number.NaN, T0 + 500, T0 + 501, 'p');
    let m = summarizeSweepTimeline(t).memory;
    expect(m.failed).toBe(3);
    expect(m.samples).toBe(0);
    expect(m.peakMemoryMB).toBeNull();
    expect(m.unavailable).toBe('no-sample');
    expect(m.baselineMB).toBeNull();
    noteMemorySample(t, 12, T0 + 750, T0 + 751, 'p');
    m = summarizeSweepTimeline(t).memory;
    expect(m.peakMemoryMB).toBe(12);
    expect(m.series).toEqual([[750, 12, 'p']]);
  });

  it('says so when the series is capped — and the peak stays exact past the cap', () => {
    const t = timeline();
    for (let i = 0; i < SWEEP_TIMELINE_MAX_MEMORY_ROWS; i += 1) {
      noteMemorySample(t, 500, T0 + i, T0 + i, 'p');
    }
    expect(summarizeSweepTimeline(t).memory.seriesTruncated).toBe(false);
    noteMemorySample(t, 999, T0 + 99_999, T0 + 99_999, 'p');
    const m = summarizeSweepTimeline(t).memory;
    expect(m.series).toHaveLength(SWEEP_TIMELINE_MAX_MEMORY_ROWS);
    expect(m.seriesTruncated).toBe(true);
    expect(m.peakMemoryMB).toBe(999);
  });

  it('the release-poll rows are capped the same way', () => {
    const t = timeline();
    for (let i = 0; i <= SWEEP_TIMELINE_MAX_RELEASE_POLLS; i += 1) {
      noteReleasePoll(t, false, T0 + i, T0 + i + 1);
    }
    const f = summarizeSweepTimeline(t).finish;
    expect(f.releasePoll.rows).toHaveLength(SWEEP_TIMELINE_MAX_RELEASE_POLLS);
    expect(f.releasePoll.rowsTruncated).toBe(true);
    expect(f.releasePoll.answered).toBe(SWEEP_TIMELINE_MAX_RELEASE_POLLS + 1);
  });
});

describe('the object is the generation', () => {
  it('a late answer noted into a DROPPED sweep never reaches the next sweep\'s file', () => {
    const first = timeline();
    markSweepTimeline(first, 'sweeping', T0 + 400);
    // The hook drops `first` (a discard) and claims a new one. The reads the
    // first sweep issued are pinned to IT, so they land there, late.
    const second = newSweepTimeline(T0 + 10_000, {
      platform: 'ios', armContract: 'ios-coremotion', frameSource: 'host-ar',
      poseSourceRequested: 'ar', poseSourceEffective: 'ar',
      releasePollMs: 100, memorySampleMs: 250,
      memoryReader: 'IncrementalStitcher.getMemoryFootprintMB', memoryMetric: 'phys_footprint',
    });
    noteMemorySample(first, 1500, T0 + 900, T0 + 10_050, 'p');
    tickSweepStatus(first, 'poll', st(77), T0 + 10_060, LIVE, T0 + 900);
    noteReleasePoll(first, true, T0 + 950, T0 + 10_070, T0 + 960);
    markSweepTimeline(second, 'sweeping', T0 + 10_300);
    noteMemorySample(second, 640, T0 + 10_300, T0 + 10_302, 's');
    markSweepTimeline(second, 'finishing', T0 + 12_000);
    markSweepTimeline(second, 'settled', T0 + 12_100);
    const f = JSON.parse(panoPlusSweepTimelineSidecar(second, {
      outcome: 'resolved', sessionDir: '/d/pp_2', nativeFinalizeMs: 50,
    })) as Parsed;
    expect(f.peakMemoryMB).toBe(640);
    expect(f.memory.samples).toBe(1);
    expect(f.statusRate.rows).toEqual([]);
    expect(f.finish.releasePoll.answered).toBe(0);
    expect(f.finish.cameraReleasedSeenAtMs).toBeNull();
    expect(f.finish.nativeCameraReleasedAtMs).toBeNull();
    // …and the first one did get them.
    expect(first.memory.samples).toBe(1);
    expect(first.status.rows).toHaveLength(1);
  });
});
