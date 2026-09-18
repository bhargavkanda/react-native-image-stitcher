// SPDX-License-Identifier: Apache-2.0
/**
 * panoPlusCameraOffNotice — WHAT THE pano+ SCREEN SAYS WHEN THERE ARE NO
 * PIXELS, and the one place that decides whether it says anything at all.
 *
 * ── THE INCIDENT THIS FILE EXISTS FOR ──────────────────────────────────────
 *
 * The operator, 2026-09-03, on the AR arm of his A35: "I do not see a preview
 * in the pano+ screen still?" The screen was black and it was printing
 *
 *     "AR arm — ARCore is UP, inside the sweep's own camera session.
 *      It is not this screen's session to draw, so there is no AR preview
 *      here. Aim by the panorama band once the sweep starts."
 *
 * EVERY CLAUSE OF THAT WAS FALSE AT IDLE. logcat on his phone showed the
 * camera opening and then closing (`camera3->close : X`) with no sweep
 * running: ARCore was DOWN, no session existed, and nothing held the camera.
 * The real cause was a startup race — the panel's idle-preview effect reached
 * native 12 ms before the viewfinder view offered its SurfaceTexture, so
 * `startIdlePreview` refused and nothing ever retried (fixed natively by
 * `PanoPlusPreview.awaitSurface`).
 *
 * The copy was written from the ARM the surface believed it was on, and an
 * arm is not a state. That is the mistake this module is shaped to prevent:
 * the notice is derived from WHO OWNS THE CAMERA RIGHT NOW, and when native
 * has said why in its own words, those words win over anything written here.
 *
 * ── WHO OWNS THE CAMERA, AS A TABLE ────────────────────────────────────────
 *
 *   contract          phase       owner
 *   ─────────────────────────────────────────────────────────────────────────
 *   ios  · imu arm    idle        the arm's own AVCaptureSession (idle preview)
 *   ios  · imu arm    sweeping    the arm's own AVCaptureSession
 *   ios  · ar  arm    idle        ARKit, via the mounted <ARCameraView>
 *   ios  · ar  arm    sweeping    ARKit
 *   android · either  idle        `PanoPlusIdlePreviewSession` — ARCore is DOWN
 *   android · imu arm sweeping    the recorder's Camera2 session
 *   android · ar  arm sweeping    ARCore's shared camera; the recorder's
 *                                 preview surface rides it via `setAppSurfaces`
 *
 * The Android row that used to be missing is the idle one, and it is the only
 * row the operator was ever looking at.
 *
 * PURE, so the matrix above is a thing tests can walk rather than a thing that
 * has to be reproduced on a phone.
 */

import type { PanoPlusArmContract } from './panoPlusAndroidArm';

/** The capture phases this notice distinguishes. `starting` and `finishing`
 *  are transitions the sweep owns; `sweeping` is the sweep proper. */
export type PanoPlusNoticePhase =
  | 'idle'
  | 'starting'
  | 'sweeping'
  | 'finishing';

export interface PanoPlusCameraOffInput {
  /** Which platform's arm contract this runtime is on. */
  armContract: PanoPlusArmContract;
  /** THIS SURFACE has mounted and owns an AR session (iOS only — see
   *  `PanoPlusCaptureSurface`'s `arArmed`, which is hard-false on Android). */
  arArmed: boolean;
  /** The AR view is past its swap grace and may be drawing. */
  arReady: boolean;
  /** The sweep will run (or is running) on ARCore poses. Android only. */
  androidArArm: boolean;
  /** A native viewfinder component exists in this build and is mounted. */
  hasViewfinderView: boolean;
  /** The idle viewfinder answered `on: true`. */
  idleFeedLive: boolean;
  /** Native's own words for why there is no idle feed, or `''`. */
  idleReason: string;
  phase: PanoPlusNoticePhase;
}

/** True while the sweep's own session — not the idle one — owns the camera. */
function sweepOwnsCamera(phase: PanoPlusNoticePhase): boolean {
  return phase === 'starting' || phase === 'sweeping' || phase === 'finishing';
}

/**
 * The centred explainer, or `null` when there is something live to look at.
 *
 * `null` IS THE COMMON ANSWER AND THAT IS THE POINT. A live feed explains
 * itself; a permanent caption over it is clutter, and a caption that describes
 * a state the screen is not in is worse than clutter. The notice earns its
 * place only when there is genuinely nothing to see.
 */
export function panoPlusCameraOffNotice(
  input: PanoPlusCameraOffInput,
): string | null {
  const {
    armContract, arArmed, arReady, androidArArm,
    hasViewfinderView, idleFeedLive, idleReason, phase,
  } = input;

  // ── iOS, AR ARM: ARKit draws its own view ────────────────────────────────
  // Nothing to explain once it is up; while it warms, say only that.
  if (arArmed) return arReady ? null : 'Starting the camera…';

  // ── THE VIEWFINDER IS LIVE ───────────────────────────────────────────────
  // Two ways to have pixels: the idle session answered yes, or the sweep owns
  // the session and its preview is one of its outputs. Both need the native
  // view to be in this build — without it there is nothing to draw into.
  if (hasViewfinderView && (idleFeedLive || sweepOwnsCamera(phase))) {
    return null;
  }

  // ── NO PIXELS. SAY WHY, FOR THE STATE THE SCREEN IS ACTUALLY IN ──────────

  if (sweepOwnsCamera(phase)) {
    // The sweep owns the camera. On the Android AR arm that session is
    // ARCore's shared one and the preview rides it through `setAppSurfaces`;
    // when it did not attach, the sweep is recording HEADLESS — which is worth
    // saying plainly, because the pack is still good and the operator's
    // instinct will be to stop and restart.
    if (armContract === 'android-sensor' && androidArArm) {
      return 'ARCore owns the camera for this sweep and its shared session '
        + 'did not take the viewfinder.\nThe sweep is still recording — aim by '
        + 'the panorama band.';
    }
    return 'The sweep owns the camera and no viewfinder is attached.\nThe '
      + 'sweep is still recording — aim by the panorama band.';
  }

  // IDLE. Nothing holds the camera on either Android arm — ARCore does not
  // come up until Start — so the honest answer is the one native gave for why
  // the idle viewfinder is not running.
  if (!hasViewfinderView) {
    return 'No viewfinder in this build.\nThe sweep still records; aim by the '
      + 'panorama band once it starts.';
  }
  const reason = idleReason.trim();
  if (reason !== '') return `No live camera feed — ${reason}`;
  return 'The camera has not opened yet.';
}

/**
 * THE OTHER FAILURE THIS SCREEN CAN HAVE: PIXELS THAT DO NOT MATCH.
 *
 * ⚠ EVERYTHING ABOVE IS ABOUT A SCREEN WITH NO PICTURE, AND THAT IS ONLY HALF
 * THE FAULT. The idle viewfinder exists to show the frame the sweep will
 * record; a feed that is up, sharp and live but running at a rate the sweep
 * will not is the SAME lie, arriving through the front door instead of the
 * back — and it is the worse one to ship, because a black rectangle reports
 * itself and a wrong picture does not.
 *
 * BOTH PLATFORMS ANSWER IT, UNDER DIFFERENT NAMES, AND NEITHER REACHED A PIXEL
 * UNTIL THIS FUNCTION. Android answers a FLAG — `previewFpsApplied` beside a
 * range and a sentence (`PanoPlusLiveModule.kt:932-941`) — precisely so the
 * panel does not have to parse the fact back out of English. iOS answers the
 * flag `previewFormatApplied` (`RNISPanoAvfSource.swift:407`) AND writes the
 * prose itself ("PREVIEW FORMAT NOT APPLIED … this viewfinder does NOT match
 * what the sweep will record", `RNISPanoAvfSource.swift:400-401`) — but that
 * prose lands in `reason`, and `PanoPlusCaptureSurface` clears `reason` on the
 * success path (`setIdleReason(res.on ? '' : res.reason)`), which is exactly
 * this case: the lock failure is non-fatal, so `on` is TRUE. So iOS's own
 * sentence never reaches the screen, and it is the FLAG that has to speak here
 * on both platforms.
 *
 * ⚠ THE TWO FLAGS ARE NOT THE SAME NOUN, WHICH IS WHY `subject` EXISTS. iOS
 * pins the format and the rate under ONE `lockForConfiguration()`
 * (`RNISPanoAvfSource.swift:383-389`), so its decline is a wrong-SHAPE
 * viewfinder as well as a wrong-rate one — the half the operator actually
 * found in the field, `.high` 16:9 framing over a 4:3 sweep, "a band above and
 * below what he had framed" (`RNISPanoAvfSource.swift:335-345`). Android's flag
 * is the rate alone. Printing Android's headline for iOS's fault would be
 * accurate and incomplete, so the caller names which one it has.
 */
export interface PanoPlusPreviewPinInput {
  /** Native's `previewFpsApplied`: `true` pinned, `false` declined, `null`
   *  when this build does not report it (every iOS build, every Android
   *  binary before 2026-09-07). */
  applied: boolean | null;
  /** The AE range that was requested, `[lower, upper]`, or null. */
  range: string | null;
  /** Native's own sentence for what happened, or `''`. */
  note: string;
  /** There are pixels on screen to mistrust. */
  idleFeedLive: boolean;
  phase: PanoPlusNoticePhase;
  /**
   * WHICH FACT `applied` IS ABOUT. `'rate'` (the default, and Android's
   * `previewFpsApplied`) — the viewfinder is clocked differently from the
   * sweep. `'framing'` (iOS's `previewFormatApplied`) — one lock declined the
   * format AND the rate together, so the picture is the wrong shape as well as
   * the wrong speed.
   *
   * OPTIONAL, DEFAULTING TO `'rate'`, so every Android caller and every test
   * written before iOS was wired keeps its exact words.
   */
  subject?: 'rate' | 'framing';
}

/**
 * The one-line rate warning, or `null` — which is the answer almost always.
 *
 * FOUR SILENCES, EACH FOR ITS OWN REASON:
 *  1. `applied == null` — the build does not report the pin. Silence is not
 *     evidence of a wrong rate, and printing a fault from an absent field is
 *     the class of bug this module was written after.
 *  2. `applied === true` — the viewfinder matches. A caption over a correct
 *     picture is clutter, exactly as in `panoPlusCameraOffNotice`.
 *  3. no feed — `panoPlusCameraOffNotice` owns that screen. Two notices about
 *     one camera, and the one that matters is the one about the missing feed.
 *  4. off idle — the idle session is torn down inside
 *     `PanoPlusAndroidRecorder.start` and the sweep pins its own range
 *     (`PanoPlusAndroidRecorder.kt:3276`), so this fact is stale the moment
 *     the operator holds the shutter.
 */
export function panoPlusPreviewPinNotice(
  input: PanoPlusPreviewPinInput,
): string | null {
  const {
    applied, range, note, idleFeedLive, phase, subject = 'rate',
  } = input;
  if (applied !== false) return null;
  if (!idleFeedLive) return null;
  if (phase !== 'idle') return null;
  // The headline names what native actually declined — see `subject`. The four
  // silences above are identical either way: the fault is one fault.
  const head = subject === 'framing'
    ? 'VIEWFINDER DOES NOT MATCH THE SWEEP'
    : 'VIEWFINDER RATE NOT PINNED';
  const said = note.trim();
  if (said !== '') return `${head} — ${said}`;
  // A FLAG WITHOUT ITS WORDS IS STILL THE FACT. Native always sends the
  // sentence today; a future or foreign binary that sends only the flag must
  // not degrade this into silence, so the range carries the report instead.
  //
  // On the framing subject there is no range to carry — iOS reports one
  // boolean for the whole lock — so the words are this file's, and they say
  // both halves because one lock declined both.
  const tail = subject === 'framing'
    ? 'this viewfinder does not match the shape or the rate the sweep will '
      + 'record.'
    : (range != null
      ? `${range} was requested and did not take; this viewfinder does not `
        + 'match the rate the sweep will record.'
      : 'this viewfinder does not match the rate the sweep will record.');
  return `${head} — ${tail}`;
}
