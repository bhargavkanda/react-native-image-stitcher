// SPDX-License-Identifier: Apache-2.0
/**
 * PanoPlusCaptureSurface — the T1 "pano+" capture surface (design doc
 * approved 2026-08-19).
 *
 * iOS-panorama-style, video-rate slit-scan capture on the correct geometry for
 * shelves, with PER-FRAME ATTITUDE RECTIFICATION — which is the whole point.
 * The offline replay validated the strip mechanics on three operator-shot
 * 30 fps sweeps and left exactly one residual: a lateral wobble with slat
 * compression, the signature of unmodeled pitch/yaw that image-only
 * registration cannot observe at 1-frame baselines. The iPhone pano is straight
 * because the gyro measures all three rotation DOFs in hardware. So this
 * surface's job is to get ARKit's per-frame attitude + intrinsics to the engine
 * and to record a pack that lets the offline harness become the device engine's
 * replay twin.
 *
 * ── WHAT THIS COMPONENT ACTUALLY DOES, and what it deliberately does not ──
 *
 * DOES:  mount `<ARCameraView>` (that mount is what starts the ARKit session —
 *        `RNSARCameraView.didMoveToWindow` calls `RNSARSession.shared.start()`),
 *        drive the native session's start/stop/cancel, render the growing
 *        panorama and the 1D governor, and hand the host a result + a pack.
 *
 * DOES NOT: touch pixels, poses or intrinsics in JS. Every frame goes
 *        native→native on the ARKit delegate thread through
 *        `RNISPanoPlusPlugin`; JS sees only the throttled status dict. A JS
 *        frame path at 30–60 fps would be the wrong budget by two orders of
 *        magnitude, and `useStitcherWorklet`'s synthesised-FoV intrinsics are
 *        exactly the "no hardcoded intrinsics" rule's counter-example.
 *
 * ── EVERY DECISION IS PURE AND ELSEWHERE ─────────────────────────────────
 * The status parse, governor copy, HUD lines, preview source, integrity
 * verdict, residual lines and result shape all live in `panoPlusModel.ts` and
 * are unit-tested. This file holds React state, native calls and JSX only —
 * the enforce-1D lesson (2026-07-22: the maths was tested and correct; the
 * WIRING, which number the pill reads, was not reachable by any test).
 *
 * ── LIFECYCLE, stated because it is the part that can leak ───────────────
 *  · MOUNT: a {@link PANO_PLUS_SWAP_GRACE_MS} grace elapses before
 *    `<ARCameraView>` mounts. There is ONE ARKit session; the outgoing
 *    surface's unmount is what stops it, and mounting ours first races two
 *    `arSession.run` calls.
 *  · UNMOUNT WHILE SWEEPING: `stop()` fire-and-forget — NOT `cancel()`. An
 *    abandoned sweep's pack is still evidence, and deleting it is the one
 *    irreversible thing this surface could do by accident. The native session
 *    is torn down either way, which is the part that must never leak.
 *  · A `stop()` that rejects `panoplus-not-running` is followed by `cancel()`,
 *    because that is the ONE native path that leaves the session latched
 *    without finalizing — every later `start()` would reject `panoplus-busy`
 *    for the life of the process.
 */

import React, { forwardRef } from 'react';
import {
  Platform,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import {
  ARCameraView,
  CameraShutter,
  PanHowToOverlay,
  RotateToLandscapePrompt,
} from '../index';

import { PanoArToggle, PanoLensChip } from './chrome';
import { useSweepEngine, type SweepEngine } from './useSweepEngine';
import { SweepHoldOverlay } from './SweepHoldOverlay';
import { sweepSurfaceStyles as styles } from './sweepSurfaceStyles';
import type {
  SweepSurfaceHandle as SurfaceControlHandle,
  SweepSurfaceState as SurfaceControlState,
} from './panoPlusTypes';
import { panoPlusUnavailableDetail } from './panoPlusAndroidArm';
import {
  PANO_PLUS_SWAP_GRACE_MS,
  panoPlusArmNotice,
  type PanoPlusGuidanceContext,
  type PanoPlusDefectCode,
} from './panoPlusModel';
import type {
  PanoPlusCaptureResult,
  PanoPlusEngineOptions,
  PanoPlusFailure,
  PanoPlusPackFrames,
  PanoPlusPackOptions,
  PanoPlusPoseSource,
  PanoPlusStartOptions,
} from './panoPlusTypes';
import { PanoPlusBasisOverlay } from './PanoPlusBasisOverlay';
import type { PanoPlusBasisRoute } from './panoPlusBasisAcquisition';

/**
 * How often the AR metadata (and with it pano+'s sync status) reaches JS.
 * 100 ms ≈ 10 Hz: enough for a HUD that has to be readable while walking, and
 * an order of magnitude below the engine's own per-frame cadence, which is
 * where the real work happens. The preview image updates on its own ~4 Hz
 * native cadence and does NOT need this to be faster.
 */
const AR_META_INTERVAL_MS = 100;

export interface PanoPlusCaptureSurfaceProps {
  /** A finished sweep — canvas + the whole pack under `result.sessionDir`. */
  onComplete: (result: PanoPlusCaptureResult) => void;
  /**
   * The operator backed out and the pack (if any) has been deleted.
   *
   * ⚠ NO GESTURE REACHES THIS SINCE 2026-09-03. The parity change gave pano+
   * Pano's shutter and Pano's shutter only — and Pano has no mid-hold discard:
   * release ALWAYS finalizes (`CameraShutter.tsx:217-236`), and its only
   * abandon paths are automatic. The `Discard` / `Close` buttons that called
   * this are gone; leaving the mode is the shell's mode bar, and ending a
   * sweep is the release. `cancelPanoPlus` is still issued where it must be —
   * a `panoplus-not-running` stop (the one native path that latches the
   * session) — but that is recovery, not a choice, and it reports through
   * `onFailure`. Kept optional so a host's prop bag still type-checks; a host
   * that needs a discard affordance has to add a gesture Pano does not have,
   * and should say so.
   */
  onCancel?: () => void;
  /**
   * A sweep that could not be delivered. `failure.sessionDir` is non-null on
   * `panoplus-empty` — the pack IS on disk and is exactly the evidence the
   * residual analysis wants, so a host should offer to keep it rather than
   * treating this as nothing having happened.
   */
  onFailure?: (failure: PanoPlusFailure) => void;

  /**
   * THE HYPOTHESIS ARM. Default TRUE — the field build ships every feature ON
   * (a feature shipped OFF has not been tested). `false` is the CONTROL arm:
   * the same sweep with image-only registration, which is what the offline
   * replay already ran and where the wobble stands. Shoot the same shelf twice
   * and compare `maxRectifyDeg` + the residual.
   */
  rectify?: boolean;
  /** Chained per-strip exposure match over the strips' TRUE pixel overlap.
   *  Default TRUE. (Not a D-002 reopen: that decision closed the per-frame
   *  scalar for facing-atomic painting, whose root cause was having no overlap
   *  to estimate from. Strips have real overlap.) */
  gainMatch?: boolean;
  /** Which frames the pack keeps. Default `'all'` — the pack IS the
   *  experiment; a frame not written is a residual that can never be
   *  recomputed offline. */
  packFrames?: PanoPlusPackFrames;
  /** Escape hatch for the remaining engine knobs (every one is echoed into the
   *  pack's `meta.json`, fully resolved, so a pack stays self-describing). */
  engineOptions?: PanoPlusEngineOptions;
  /** v6 — LOCK the camera (exposure + white balance + focus) for the sweep,
   *  restored on stop/cancel/error. Default TRUE, matching native, because a
   *  feature shipped off in the field build has not been tested — and this one
   *  is the answer to the banding the operator rejected twice. Off is the
   *  control arm for that A/B. */
  /**
   * ANDROID ONLY. Drive the geometry from the magnetometer-FREE attitude
   * series (`TYPE_GAME_ROTATION_VECTOR`) instead of the magnetometer-fused
   * `TYPE_ROTATION_VECTOR`.
   *
   * ⚠ WHAT IT FIXES, measured on 11 A35 packs 2026-09-10. The fused series
   * leaks indoor compass pull into the OFF-AXIS remainder, because a
   * near-horizontal sweep axis cannot absorb it into the sweep angle. The
   * rectifier applies that remainder as a projective KEYSTONE, so the painted
   * band's bottom and top edges tilt OPPOSITE ways — the reported "the bottom
   * edge, the left edge drops". Sign matched on 11 of 11 packs, and the one
   * pack whose compass pulled the other way is the one canvas leaning right.
   *
   * ABOUT 75%, NOT A CURE: median residual yaw 11.65 deg -> 3.27, predicted
   * lean 11.78 -> 2.66. The rest is genuinely off-axis hand movement plus the
   * sweep axis being quantised to a cardinal direction, which is separate work.
   *
   * THE COST is gyro yaw drift, since nothing corrects heading without a
   * compass. Every pack now measures it either way as
   * `attitude.headingDriftDegPerS`, so the default can be decided from real
   * captures rather than from one borrowed window.
   *
   * iOS ignores this: its attitude comes from ARKit or CoreMotion, not from
   * Android's sensor fusion.
   */
  attitudeMagFree?: boolean;
  /**
   * S5 — run the sweep on frames from the camera the HOST already owns,
   * via the `panoplus_sweep_ingest` vision-camera Frame Processor. Android,
   * IMU arm only. The recorder opens no Camera2 client.
   *
   * ⚠ REQUIRES {@link vcCameraId}, AND BOTH ARE SENT ONLY TOGETHER. An arm
   * that opens no camera and is fed by nothing is the exact shape the AR
   * plugin arm shipped broken in — the operator sat watching a sweep that
   * could never receive a frame.
   *
   * ⚠ AND IT COSTS THE EXPOSURE LOCK. vision-camera has no AE lock on
   * Android, and surfaces no exposure metadata, so a sweep on this arm runs
   * UNLOCKED with the engine's exposure normalisation fed zeros — the
   * banding defence the Camera2 arm asserts. Opt-in for that reason.
   */
  vcPluginArm?: boolean;
  /**
   * WHO OWNS THE CAMERA — `'own'` (default, unchanged) or `'host'`.
   *
   * ⚠ THIS IS NOT THE SAME QUESTION AS "is vision-camera installed", and
   * three subsystems in this file were testing build-presence where they
   * meant ownership. On `'host'` the surface must NOT open a camera of its
   * own for ANY reason: no AVF idle viewfinder, no `setIdlePreview`, no
   * re-arm heartbeat. Android allows one client per back camera, so the
   * idle preview alone takes `ERROR_CAMERA_IN_USE` on MOUNT — before any
   * hold, and before the arm it is supposed to be serving ever starts.
   *
   * It is a separate prop from {@link vcPluginArm} because ownership is a
   * fact about the SCREEN and the arm is a fact about the SWEEP: the
   * viewfinder question is settled at mount, the arm question at start.
   */
  frameSource?: 'own' | 'host';
  /**
   * S7 — is the host's preview actually mounted right now? Only meaningful
   * with `frameSource="host"`, where it distinguishes "vision-camera is
   * drawing behind this surface" from the ~600 ms handoff window in which
   * the host has told us it owns the camera but is deliberately mounting
   * nothing. Defaults TRUE, which is the historical behaviour for a host
   * that says `'host'` and means it.
   */
  hostPreviewLive?: boolean;
  /** S7 — vision-camera's own reason the host preview is not up, or `''`.
   *  Only meaningful with `frameSource="host"`. */
  hostPreviewError?: string;
  /** The camera id vision-camera opened. The recorder derives intrinsics
   *  from its characteristics; without it the arm refuses rather than
   *  guessing a focal length. */
  vcCameraId?: string;
  /**
   * M3 — the NAMED reason the embedding host refuses a hold right now, or
   * null. From `<Camera>`: `sweepHostArmRefusal` when its camera cannot serve
   * the hold, and `panoplus-panorama-disabled` on EITHER arm when the host
   * turned panorama capture off. A hold is then refused with it, on screen
   * and on `onFailure`, instead of starting — and on the host arm instead of
   * the recorder opening a camera of its own.
   */
  hostArmRefusal?: { code: string; message: string } | null;
  /**
   * M4 — the React tag of vision-camera's CameraView (the host's camera), so
   * the Android vision-camera arm can apply the AE/AWB lock to the camera it
   * sweeps from. Sent only with `vcPluginArm`.
   */
  vcViewTag?: number;
  /**
   * Long-edge budget (px) for the AR arm's CPU image. Omit for the library's
   * 1920 default.
   *
   * ⚠ THE A/B THIS EXISTS FOR. `keyframeQualityCapture` (2026-09-10) took the
   * AR arm off ARCore's 640x480 default and fixed the "very blurry" panos — but
   * the library repacks that image to NV21 on the GL RENDER THREAD every tick,
   * before anything asks whether the frame is wanted, so 6.75x the pixels is
   * 6.75x the cost in the loop that DRAWS the viewfinder. Measured 2026-09-16:
   * 57 GL ticks/sec on a 120 Hz panel, 226 of 358 packed frames discarded.
   * 1280 is the A35's middle rung — half the repack of 1080p, still 2.25x the
   * VGA default. Which one wins is a measurement, not a preference.
   */
  arSourceMaxLongEdge?: number;
  lockCamera?: boolean;
  /**
   * DOES THE IDLE VIEWFINDER GET THE SWEEP'S FRAME RATE. Default TRUE, which
   * is byte-for-byte what this surface has always sent — it is here so the
   * OTHER arm exists at all, not to change what ships.
   *
   * ⚠ IT WAS A HARDCODED `true` UNTIL 2026-09-08, AND THAT MADE FOUR NATIVE
   * COMMENTS FALSE. Android's knob defaults OFF on purpose
   * (`PanoPlusLiveModule.kt:985`) and says four times over that the default is
   * the operator's to flip after he has seen both pictures
   * (`PanoPlusLiveModule.kt:974-984`, `PanoPlusIdlePreview.kt:94`, `:301-313`
   * — "it is his call, not this file's" — `PanoPlusAndroidRecorder.kt:961-964`).
   * The only host that exists always overrode it, so there were not two
   * pictures to see: a pinned 60 means shorter exposures, so the dim-aisle
   * viewfinder is visibly DARKER, and there was no row anywhere to put it back.
   *
   * The host flag is `panoPlusPinPreviewFps`, TRUE on both baselines so the
   * shipped picture is unchanged and OFF is one gear tap away.
   *
   * IDLE ONLY, and only the FRAMING viewfinder — the sweep pins its own range
   * (`PanoPlusAndroidRecorder.kt:3276`) and the idle session is torn down
   * before it starts. On iOS the option is inert: `RNISPanoAvfSource` applies
   * the sweep's format and rate from its own plan and reads only `lens` from
   * this bag.
   */
  pinPreviewFps?: boolean;
  /** v6 — AE/AWB re-convergence wait after the video-format switch, before
   *  locking (default 600 ms, matching native). */
  meteringSettleMs?: number;
  /**
   * WHICH PRODUCER FEEDS THE ENGINE. Default `'ar'` — ARKit, byte-for-byte the
   * path every pano+ pack to date was recorded on.
   *
   * `'imu'` selects the DECOUPLED arm: an `AVCaptureSession` on the physical
   * ultra-wide at 60 fps, attitude from `CMDeviceMotion` sampled at `pts + τ`,
   * and ARKit DOWN for the duration (the two cannot share the camera).
   *
   * ⚠️ IT HAS A DEVICE-LOCAL PRECONDITION AND THIS SURFACE STATES IT BEFORE
   * THE TAP. The arm refuses without a measured τ and a validated basis for
   * this body, and neither can ship inside a binary — they are measured by the
   * calibration panel and persisted on the phone. An entry that answered a tap
   * with a native rejection would read as broken rather than unconfigured, so
   * the precondition is read at mount and the primary button is labelled with
   * the arm that will ACTUALLY run. See {@link panoPlusArmNotice}.
   */
  poseSource?: PanoPlusPoseSource;
  /**
   * THE DECOUPLED ARM'S ACCELERATION CAGE, m/s². Only read when
   * `poseSource === 'imu'`.
   *
   * ⚠️ IT DEFAULTS TO UNDEFINED, WHICH MEANS THIS ARM SWEEPS UNCAGED, AND THAT
   * IS SAID RATHER THAN IMPLIED. The engine's pose-side speed cage is
   * structurally inert here (`poseStepM` is identically zero — there is no VIO
   * on this arm at all), so the replacement was written in acceleration; but
   * until 2026-08-31 no reachable path set it, so the "cage that replaces the
   * pose-side cage" existed in no configuration the operator could select. The
   * knob is now reachable.
   *
   * IT IS STILL UNTUNED, AND THE HONEST DEFAULT IS THEREFORE OFF. The
   * threshold is a number in a currency nothing in this repo has ever
   * measured, and an untuned cage would refuse real frames on the very first
   * pack. What ships instead is the EVIDENCE to choose it from: the pack's
   * `alignment.lurchCage` now records `maxAccelMps2Seen` over `accelSamples`
   * on every sweep, caged or not (it used to be tracked only inside the
   * configured branch, which made the first threshold unknowable by
   * construction), and `state` says `uncaged` in words so a reader never has
   * to infer it from a zero.
   */
  lurchAccelMps2?: number;
  /**
   * THE DELIBERATE τ = 0 SWEEP. Only read when `poseSource === 'imu'`, default
   * FALSE, and the ARKit arm never sees it.
   *
   * It answers the question the calibration could not: τ resolved on 8 of 12
   * runs and scattered 5.03 ms — wider than the 3.08 ms budget it was meant to
   * buy back — so the persist gate refused to write one, while the raw lag on
   * the resolved runs sat mostly INSIDE the budget. Whether τ binds at all is
   * therefore open, and a sweep with no correction is the experiment that
   * closes it.
   *
   * ⚠️ IT CHANGES WHAT THIS SURFACE LOOKS LIKE, DELIBERATELY — BUT BY ONE
   * CHIP NOW, NOT BY A BANNER (2026-09-07). An uncorrected sweep must not be
   * mistakable for a calibrated one at a glance, and `⚗︎ τ=0` (loud, outside
   * every other palette on this screen, in EVERY phase) is what says so. The
   * idle EXPERIMENT banner and its paragraph are gone from the screen: the
   * operator declared the experiment himself in the gear, and had nothing to
   * do about being told again. They are written to `host_notice.json` in full
   * on every sweep instead — see `packOnly` on `PanoPlusArmNotice` — which is
   * where the arm, the τ provenance and the basis are read back from later.
   * The operator's memory of which arm he pressed is still not evidence; the
   * pack is.
   */
  tauUncorrected?: boolean;
  /**
   * P5 — which back camera the DECOUPLED arm opens: `'ultraWide'` (0.5×, the
   * default and the only lens ARKit cannot reach on this hardware) or
   * `'wide'` (1×). Read only when `poseSource === 'imu'`; the AR arm's lens
   * is structurally the wide camera (ARKit publishes no ultra-wide format —
   * 0 of 22 on iPhone17,1; ARCore forces camera 0 on the A35), so the arm
   * choice and the lens choice are the same control there. Sent
   * assigned-or-deleted like `tauUncorrected`, and threaded into the idle
   * viewfinder so framing and capture use the SAME camera.
   *
   * On screen it is Pano's lens switcher (`0.5× | 1×`, `PanoLensChip`), which
   * is ALWAYS mounted — Pano's own rule, adopted by the owner 2026-09-03 —
   * and the chip REALLY switches the camera: native's `pickCamera` honours the
   * requested lens on both the sweep and the idle viewfinder, and the pack
   * records the lens that ran.
   *
   * ⚠ WHAT THE CHIP PAINTS IS `effectiveLens`, NOT THIS PROP. On the AR arm
   * this value is a request nothing will honour, so the chip paints `1×`
   * there — the lens that actually runs. Tapping `0.5×` moves the ARM as well
   * as the lens, which is how the two can never disagree; see `onLensPill`.
   */
  lens?: 'ultraWide' | 'wide';
  /**
   * Points of HOST chrome across the top of this surface — chrome the surface
   * cannot see and must not draw under.
   *
   * ⚠ THIS IS NOT A SAFE-AREA INSET AND CANNOT BE DERIVED FROM ONE. The IR
   * shell absolutely-positions its field-baseline banner at `top: 48` over
   * whatever surface is mounted, and on 2026-09-03 the pano+ guidance headline
   * rendered into the same pixels: "Hold portrait — sweep left to right"
   * survived on screen as "H…" and "right", and the banner's lower edge struck
   * through the next line. Two text blocks, one region, and neither view can
   * see the other because they lay out independently. (That particular
   * headline was stripped on 2026-09-07; the collision is not — every
   * during-sweep line still lands in the same region.)
   *
   * Measured from the TOP OF THE WINDOW, the same origin the safe-area inset
   * uses, and combined with it by MAX (the host's banner already sits below the
   * status bar). Absent (every production host, and iOS) ⇒ 0 ⇒ the inset alone
   * ⇒ byte-identical.
   */
  hostChromeTopPt?: number;
  /**
   * HOST COPY FOR THE SWEEP HUD, keyed by guidance rung.
   *
   * `<Camera>` localises every capture-time string the KEYFRAME engine draws
   * through its `guidanceCopy` prop, and on a sweep that prop reached the REC
   * banner and the two guard-rail modals — everything `<Camera>` draws
   * itself — and stopped at this surface's edge. The HUD, which is the text
   * the operator actually reads during a pano+ hold, was hardcoded English on
   * a screen where the rest was translated.
   *
   * Merged onto the defaults per rung inside `panoPlusGuidance`; absent ⇒
   * byte-identical.
   */
  guidanceCopy?: PanoPlusGuidanceContext['copy'];
  /**
   * HOST COPY FOR THE CAPTURE WARNING, keyed by defect.
   *
   * ⚠ READ BY `<Camera>`, NOT BY THIS COMPONENT. It rides the `sweep` bag
   * because that is the one channel a host already uses to configure the
   * sweep, and the warning it localises is on `<Camera>`'s review banner and
   * on `onCapture(result).warnings` — neither of which this surface draws.
   * Declared here so `sweep={{ defectCopy }}` typechecks at the only place
   * anyone would write it.
   */
  defectCopy?: Partial<Record<PanoPlusDefectCode, string>>;
  /**
   * P5b — invoked when the operator taps Pano's lens switcher. The chip
   * renders whenever this is provided, on BOTH arms (Pano's rule, 2026-09-03);
   * a tap mid-sweep is inert, because a lens cannot change under a live sweep
   * (τ/basis keys, the planned format and the idle viewfinder all re-derive
   * from it). The HOST owns the flag — the surface never mutates its own
   * `lens` prop. The flag is `panoPlusLens`; there is no second one.
   *
   * ⚠ A `'ultraWide'` TAP IS ACCOMPANIED BY AN `onPoseSourceChange('imu')`,
   * from the same handler and therefore the same commit. 0.5× is unreachable
   * on the AR arm, so choosing it IS choosing the decoupled arm — a host that
   * takes this callback and ignores the other one would store a lens its arm
   * will never open. The 0.5× pill is withheld from a host that wired only
   * this one, for exactly that reason.
   */
  onLensChange?: (lens: 'ultraWide' | 'wide') => void;
  /**
   * 2026-09-03 — invoked when the operator taps Pano's AR pill. ON asks for
   * the AR arm (ARKit / ARCore), OFF for the decoupled arm. The HOST owns the
   * flag (`panoPlusPoseSource`) exactly as it owns `lens`; the pill renders
   * only when this is provided AND the lens that will run is 1× (Pano's gate,
   * `Camera.tsx:3382` — at 0.5× there is no AR to toggle, on either app), and a
   * tap mid-sweep is inert — the arm is latched for the sweep's duration (see
   * `runningArm`) and the pill draws the LATCHED arm, so it cannot claim a
   * switch that is not happening.
   *
   * ALSO INVOKED BY THE LENS CHIP: a `0.5×` tap sends `'imu'` here before it
   * sends the lens, because 0.5× is unreachable on the AR arm. The return leg
   * does NOT: tapping `1×` restores this pill and leaves the arm alone, so
   * coming back to the wide lens never silently re-arms AR. See `onLensPill`.
   *
   * WHAT THE PILL SHOWS is the arm that will actually run, not the request:
   * an IMU selection this phone cannot honour (no τ, no basis, no module —
   * `panoPlusArmNotice` resolves every such state to the AR arm) draws the
   * pill ON, and the arm notice underneath says why. A TAP THEN REQUESTS THE
   * OPPOSITE OF THE GLYPH under the finger — `'imu'` on an ON pill — which in
   * that state is a no-op, and honestly so: the decoupled arm cannot run on an
   * uncalibrated phone and the notice is what says how to fix it. (It used to
   * write `'ar'` there, "accepting the downgrade"; that inverted a
   * `role="switch"` and discarded a persisted request. If it is wanted back it
   * belongs on the notice, which is a button.) While the precondition read is
   * in flight the pill follows the REQUEST instead, so turning AR off never
   * flashes back to ON for the width of one native round-trip.
   */
  onPoseSourceChange?: (poseSource: PanoPlusPoseSource) => void;
  /**
   * Unified chrome (a host camera with a bottom mode bar):
   * the shell draws Pano's shutter in its own bottom row and drives this
   * surface through {@link SurfaceControlHandle}, so the surface must not draw
   * a second one. Default FALSE — a host embedding the surface on its own
   * gets the same shutter, rendered here at Pano's own position, the way the
   * stitcher's `<Camera>` renders its built-in shutter unless
   * `hideBuiltInShutter`.
   */
  hideBuiltInControls?: boolean;
  /** Unified chrome — the surface reports whether the shell's shutter should
   *  look enabled / busy. See {@link SurfaceControlState}. */
  onControlsState?: (state: SurfaceControlState) => void;
  /**
   * Points the shell's own bottom chrome (mode bar + shutter row) takes, so
   * the lens chip lifts clear of it — the SAME number the shell passes to the
   * stitcher's `<Camera bottomBarOffset>` for Pano's chip, which is what puts
   * the two chips at the same height. 0 (default) is the stand-alone layout.
   */
  bottomBarOffset?: number;
  /** v13 — the D-008 jog guard (see PanoPlusStartOptions.d8JogGuard). An
   *  ENGINE flag, not an arm flag: both arms paint through the same
   *  commitStrip, so it is passed whenever set, whichever pose source runs. */
  jogGuard?: boolean;
  /**
   * 2026-09-01 — RECORD CoreMotion's ATTITUDE BESIDE ARKit's, so the two pose
   * arms can be replayed offline against the SAME PIXELS (see
   * {@link PanoPlusStartOptions.imuSidecar}).
   *
   * An ARKit-ARM prop, and the surface enforces that: it is sent only when the
   * sweep is actually going to run on ARKit, and DELETED otherwise — the exact
   * mirror of `lens` and `tauUncorrected`, which are decoupled-arm-only. On the
   * decoupled arm ARKit is torn down and there is no second channel to record,
   * so the key would be a claim about a comparison that cannot exist.
   *
   * It changes nothing on screen. Unlike `tauUncorrected` this is a RECORDING
   * channel, not a different sweep: the same pixels are painted by the same
   * engine off the same ARKit attitude, and the only difference is one more
   * file in the pack. There is nothing for the operator to be warned about,
   * and a chip that implied otherwise would be noise on a surface whose
   * chrome-must-match-the-pack discipline is load-bearing elsewhere.
   */
  imuSidecar?: boolean;
  /** Escape hatch for the pack writer's knobs. */
  packOptions?: PanoPlusPackOptions;
  /**
   * 2026-09-01 — IS A SWEEP IN FLIGHT RIGHT NOW, as a LEVEL rather than an
   * edge. The shell mounts this surface as a capture MODE now, and a mode
   * switch mid-sweep must be BLOCKED like every other surface's is
   * (`ModeTransitionGuards.surfaceBusy`). Nothing the shell can observe about
   * its own state says a sweep is running — the phase lives here — so this is
   * the only honest source.
   *
   * A level, not a one-shot "started"/"ended" pair, for the reason the Android
   * panel's camera-hold flag is one: an edge missed while the shell was
   * re-rendering leaves the guard latched the wrong way for the rest of the
   * session, and the failure is silent in both directions.
   */
  onSweepingChange?: (sweeping: boolean) => void;
  /**
   * THE STRIPS PAINTED SO FAR, for a host whose guards key on how much a
   * capture has got — `<Camera>`'s lateral-stop policy counts keyframes on the
   * other engine and strips on this one. Reported on every change of the
   * live status's `painted`, and 0 whenever no sweep is live.
   */
  onPaintedChange?: (painted: number) => void;
  /**
   * 2026-09-01 — THE ARM THAT WILL ACTUALLY RUN, for a host that draws its own
   * arm control.
   *
   * The consolidation put an AR on/off pill on the capture screen, and a pill
   * that renders the host's REQUEST would contradict this surface whenever the
   * IMU arm falls back (no measured τ, no validated basis, a binary with no
   * calibration module — see {@link panoPlusArmNotice}, which resolves every
   * unusable IMU state to ARKit). The operator would then be told he is
   * sweeping decoupled while ARKit is what records the pack — the exact
   * misremembered-arm failure the surface's own banner exists to prevent,
   * reintroduced one layer up.
   *
   * So the EFFECTIVE arm is reported out, and `fallbackToAr` says whether that
   * is a downgrade rather than a choice, so the pill can NAME the downgrade
   * instead of silently agreeing with it.
   *
   * `basisRoute` (2026-09-01, first-run acquisition) splits the one state the
   * pill could otherwise not tell apart: "the IMU arm is not usable on this
   * phone" and "the IMU arm is one gesture away, and that gesture is on screen
   * right now" are both `fallbackToAr: true`, and they call for opposite
   * reactions. A pill reading `IMU n/a` over a live measurement would be
   * telling the operator to give up on the thing he is in the middle of doing.
   *
   * `resolving` is the SAME fact the Start button's spinner has always carried
   * (`armPending`), and it is here for the same reason. Selecting the IMU arm
   * resets the precondition read, and until it lands `panoPlusArmNotice` has no
   * plan to reason from and correctly answers "this build cannot answer" — a
   * FALLBACK. A pill that drew it would flash `AR ⟵ IMU n/a` at the exact
   * moment the operator tapped "turn AR off", on a phone where the arm is
   * perfectly usable, and read as a refusal of what he just asked for. The
   * button refuses to offer a label it may take back one frame later; the pill
   * gets the same courtesy.
   */
  onEffectiveArmChange?: (arm: {
    poseSource: PanoPlusPoseSource;
    fallbackToAr: boolean;
    basisRoute: PanoPlusBasisRoute;
    /** The precondition read is in flight — nothing below is settled yet. */
    resolving: boolean;
    /**
     * THIS SURFACE HAS TAKEN THE SCREEN — the host must hide its own chrome.
     *
     * ⚠ THIS EXISTS BECAUSE A SUPPRESSION TERM DID NOT TRAVEL WITH THE PILLS.
     * This surface removes BOTH of its own pills while the basis-acquisition
     * overlay is up (`lensChipVisible`, `arPillVisible`), and the note beside
     * that term spells out the hazard: "the suppression would summon the more
     * damaging of the two controls." When `<Camera>` took the pills over it
     * took the gate on `cropPending` and left this one behind — so its copies
     * sat LIVE on top of the first-run calibration card, and one tap of the AR
     * pill moved the arm to ARKit, which made `armWantsBasis` false and
     * unmounted the overlay. The one-time measurement, cancelled by a control
     * the surface had deliberately removed from that screen.
     *
     * Reported rather than re-derived: it is built here from six local facts
     * (`armWantsBasis`, `armCanAcquireBasis`, `phase`, `calibRead`,
     * `basisAcquired`, `needsGesture`), and a host reconstructing it from
     * `basisRoute` alone would get a DIFFERENT boolean — which is how the
     * first version of this class of fix goes wrong.
     */
    chromeSuppressed: boolean;
  }) => void;
}

export { panoBottomChromePt, panoLensChipBottomPt } from './sweepLayout';



/**
 * M8 — the sweep SCREEN, drawn from an engine someone else owns. The
 * standalone surface below owns its engine; `<Camera>` calls
 * `useSweepEngine` itself (so the engine outlives this view behind the review
 * and is mounted on every engine) and renders this.
 */
export function SweepScreenView({
  surfaceProps: props,
  engine,
}: {
  surfaceProps: PanoPlusCaptureSurfaceProps;
  engine: SweepEngine;
}): React.JSX.Element {
  const {
    frameSource = 'own',
    hostPreviewLive = true,
    arSourceMaxLongEdge,
    hideBuiltInControls = false,
  } = props;
  const {
    AvfViewfinder,
    arArmed,
    arMayOpen,
    arPillOn,
    arPillVisible,
    arReady,
    armContract,
    armDetailOpen,
    armNotice,
    available,
    basisGestureVisible,
    basisWriteDisagreement,
    bottomBarBottom,
    cameraOffNotice,
    canCapture,
    drops,
    effectiveLens,
    error,
    glyphRotateDeg,
    guidance,
    handleArFrame,
    hold,
    holdEnd,
    holdStart,
    howToVisible,
    hud,
    lensAvail,
    lensChipVisible,
    lockWarning,
    nativeReady,
    onArToggle,
    onBasisAcquired,
    onBasisDeclined,
    onLensPill,
    onPreviewSlotLoad,
    orientation,
    phase,
    pillStackTop,
    preview,
    previewLayout,
    previewLoadFailed,
    previewPinNotice,
    previewPlaceholder,
    previewSlots,
    previewStale,
    runningUncorrected,
    setArmDetailOpen,
    setPreviewLoadFailed,
    setSurfaceBox,
    shutterBusy,
    sweepFaults,
    sweeping,
    ultraWideOfferable,
    viewfinderNotice,
  } = engine;


  if (!available) {
    // NF3 — a degradation is REPORTED, and the two causes are named apart. A
    // "camera unavailable" card that cannot say WHY is what turns a five-minute
    // config fix into a field trip.
    return (
      <View style={styles.unavailable} testID="panoplus-unavailable">
        <Text style={styles.unavailableTitle}>pano+ is not available</Text>
        <Text style={styles.unavailableBody}>
          {/* ⚠ THIS STRING SAID "iOS-only" UNTIL 2026-09-02, AND THAT IS THE
              SENTENCE THE OPERATOR READ ON HIS A35. It was true while the
              session module lived only in the pod; the moment the Android live
              arm was registered it became evidence pointing the wrong way — a
              working build telling him his feature does not exist on his phone,
              on the only card on the screen. The copy is now per-platform and
              names the artefact that actually has to be rebuilt (see
              `panoPlusUnavailableDetail`), and it still appears, truthfully,
              whenever the module is genuinely absent. */}
          {!nativeReady
            ? panoPlusUnavailableDetail(Platform.OS)
            : 'The sweep session module is registered but reports no '
              + 'document directory, and this host has no expo-file-system '
              + 'either — so there is nowhere to put the pack. That pairing '
              + 'means a native binary older than the built-in directory '
              + 'constant: rebuild the app against this version of '
              + 'react-native-image-stitcher. The sweep is refused rather '
              + 'than run without its evidence.'}
        </Text>
        {/* No Close button (2026-09-03): Pano has none, and the way out of
            every capture mode is the shell's mode bar, which renders over this
            card exactly as it renders over the live surface. */}
      </View>
    );
  }

  return (
    // ── THE ROOT IS TRANSPARENT WHEN THE HOST OWNS THE CAMERA (S7) ──────
    //
    // `styles.fill` is `{ flex: 1, backgroundColor: '#000' }`, and on the
    // host arm `<Camera>` renders its `<CameraView>` as an ABSOLUTELY
    // POSITIONED SIBLING *before* this surface in the same stacking context.
    // React Native paints siblings in document order, so an opaque flex
    // child that comes second covers an absolute child that came first: the
    // whole point of S7 — "`<CameraView>` IS the viewfinder" — was painted
    // over by this one background colour, and the non-AR sweep screen was
    // black. Nothing in the suite could see it, because the render tests
    // count components and a covered preview is still a mounted component.
    //
    // The black stays on the OWN arm, where it is the backdrop behind this
    // surface's own viewfinder and there is nothing underneath to reveal.
    <View
      onLayout={(e) => {
        const { width, height } = e.nativeEvent.layout;
        setSurfaceBox((prev) => (
          prev != null && prev.width === width && prev.height === height
            ? prev
            : { width, height }
        ));
      }}
      style={[
      styles.fill,
      // Transparent only when something is ACTUALLY drawing behind us. In
      // the handoff window the host says 'host' while mounting nothing, and
      // a transparent root there is a window onto whatever the platform
      // leaves behind rather than a viewfinder.
      frameSource === 'host' && hostPreviewLive && styles.fillOverHost,
    ]}>
      {/* Mounting this view IS what starts ARKit (didMoveToWindow →
          RNSARSession.shared.start()). `planeDetection="vertical"` costs
          nothing here — pano+ never reads a plane — but it keeps ARKit's
          tracker fed with the same structure the other shelf surfaces use, and
          a shared configuration is one less way for two surfaces to behave
          differently on the same rack. */}
      {arReady && arMayOpen && (
        <ARCameraView
          style={StyleSheet.absoluteFill}
          planeDetection="vertical"
          arFrameMetaInterval={AR_META_INTERVAL_MS}
          // ⚠ WITHOUT THIS THE AR ARM SWEEPS AT VGA. Measured on the operator's
          // first working Android AR captures: the frames reaching the engine
          // were 640x480 while the non-AR arm's were 1440x1080 — a FIVE-FOLD
          // area difference — and his verdict was "the output quality is
          // decisively worse than non-AR. WHY??"
          //
          // ARCore's default pairing on this exact handset is called out in the
          // library's own source: "ARCore's default often pairs a 16:9 GPU
          // texture with a 4:3 CPU image (e.g. 1920x1080 texture + 640x480
          // image on the Galaxy A35)". `selectMatchingCameraConfig` exists to
          // pick a matched-aspect config at the highest image resolution, and it
          // is gated on a REFCOUNT that only this prop raises — the same source
          // logs `kfQuality=true chose 1920x1080`. Another engine sets it; the
          // sweep never
          // did, so pano+ got ARCore's default.
          //
          // It also explains the second symptom without a separate cause: at a
          // 2.25x smaller raster the per-frame advance measured 0.13 px against
          // the non-AR arm's 0.40, so the phase correlation was resolving a
          // smaller displacement against the same noise floor.
          keyframeQualityCapture
          keyframeQualitySourceMaxLongEdge={arSourceMaxLongEdge}
          onArFrame={handleArFrame}
        />
      )}
      {/* v12 — THE DECOUPLED ARM'S VIEWFINDER. The arm's own capture session
          drawn straight to a layer: live during the sweep (it IS the sweep's
          session) and, via the idle-preview effect above, live before it too
          — the operator could not FRAME the first shot on this arm, and the
          first frame anchors the whole canvas. Null on builds without the
          native view (and under Jest), where the explainer below keeps doing
          the honest fallback job. */}
      {frameSource === 'own' && !arArmed && AvfViewfinder != null && (
        <AvfViewfinder
          style={StyleSheet.absoluteFill}
          testID="panoplus-avf-viewfinder"
        />
      )}
      {/* The explainer earns its place exactly when there is NOTHING live to
          look at: the AR arm warming up, or an IMU arm on a native build
          without the v12 viewfinder. A live feed explains itself, and a
          permanent centred caption over it would be clutter. */}
      {cameraOffNotice != null && (
        <View style={styles.cameraOff} pointerEvents="none">
          <Text style={styles.cameraOffText} testID="panoplus-camera-off">
            {cameraOffNotice}
          </Text>
        </View>
      )}

      <SweepHoldOverlay
        armContract={armContract}
        armDetailOpen={armDetailOpen}
        armNotice={armNotice}
        basisWriteDisagreement={basisWriteDisagreement}
        drops={drops}
        error={error}
        guidance={guidance}
        hud={hud}
        lockWarning={lockWarning}
        onPreviewSlotLoad={onPreviewSlotLoad}
        phase={phase}
        preview={preview}
        previewLayout={previewLayout}
        previewLoadFailed={previewLoadFailed}
        previewPinNotice={previewPinNotice}
        previewPlaceholder={previewPlaceholder}
        previewSlots={previewSlots}
        previewStale={previewStale}
        runningUncorrected={runningUncorrected}
        setArmDetailOpen={setArmDetailOpen}
        setPreviewLoadFailed={setPreviewLoadFailed}
        sweepFaults={sweepFaults}
        sweeping={sweeping}
        viewfinderNotice={viewfinderNotice}
      />

      {/* R4's rotate + how-to affordances, reused verbatim from the library so
          pano+ teaches the same gesture vocabulary as every other 1D pass —
          and, since the library is the PUBLIC repo, used exactly as published:
          the adaptation is in WHEN they are shown and with WHICH target, never
          in their source.

          `RotateToLandscapePrompt` now fires on the ONE hold that is actually
          worse (upside-down, hand over the lens) and asks for portrait, not
          landscape. It used to fire on every portrait hold — the nag that
          stood between the operator and the gesture he asked for. The two
          stay MUTUALLY EXCLUSIVE, as they were: `directionForOrientation`
          maps upside-down to RIGHT and `useContentRotation` then turns it a
          half turn, so a coach mark under that prompt would point the arrow
          backwards while the prompt asks for the hold that fixes it.

          `PanHowToOverlay` is shown in BOTH first-class holds. It was already
          adaptive at source (landscape → DOWN arrow, portrait → RIGHT arrow,
          both counter-rotated to gravity); the surface was gating it to
          landscape and throwing the portrait half away. That is the pan guide
          pointing along the correct axis in portrait, and it needed no new
          code — only the gate removed. */}
      <RotateToLandscapePrompt
        visible={phase === 'idle' && hold === 'portrait-upside-down'}
        target="portrait"
        copy="Turn the phone the right way up"
      />
      {/* ⚠ THE PAN COACH MARK IS SUPPRESSED UNDER THE BASIS GESTURE, and this
          is a correctness term rather than a tidiness one. `PanHowToOverlay`
          teaches a smooth one-axis sweep; the basis gesture needs the exact
          opposite, because a one-axis log leaves FOUR candidate mountings
          matching to floating-point dust. Showing both at once would have the
          screen coaching the motion that guarantees the refusal. */}
      <PanHowToOverlay
        visible={
          howToVisible
          && phase === 'idle'
          && !basisGestureVisible
          && hold !== 'portrait-upside-down'
        }
        orientation={orientation}
      />

      {/* ── THE FIRST-RUN BASIS, ACQUIRED IN THE CAMERA ────────────────────
          The operator's 2026-09-01 rule: derive where the platform allows it,
          otherwise guide the gesture here — on the camera screen, the way the
          panorama pan is guided — and persist the answer forever.

          `arLive` is the AR VIEW'S OWN GATE, not a guess: the recorder's
          reference is `RNISARFrameContext.poseRotation`, which only exists once
          `<ARCameraView>` is mounted and past its swap grace. `arArmed` is true
          here by construction — `panoPlusArmNotice` resolves an IMU arm with no
          basis to ARKit, and that fallback is exactly what mounts the session
          this measurement reads. The dependency is stated rather than relied
          on: if the notice ever stopped falling back, this would wait instead
          of recording an empty log and blaming the operator's hands for it. */}
      {basisGestureVisible && (
        <PanoPlusBasisOverlay
          arLive={arArmed && arReady}
          onAcquired={onBasisAcquired}
          onDecline={onBasisDeclined}
        />
      )}

      {/* ── PANO'S CHROME, AND NOTHING ELSE (2026-09-03) ────────────────────
          The Start / Discard / Done row that lived here is gone: pano+ is
          driven by Pano's shutter (the shell's, in unified chrome — its own
          below otherwise) with Pano's press semantics, mapped in `holdStart`
          / `holdEnd`. What the surface still draws is exactly what Pano's
          `<Camera>` draws around its viewfinder: the AR pill in the top-right
          pill stack and the lens switcher over the bottom bar. Both are
          `box-none` containers — the pills are the touch targets, never the
          stack — and neither sits inside the HUD block, whose read-only runs
          are fenced `none`.

          WHICH OF THE TWO IS ON SCREEN is Pano's own rule since 2026-09-03:
          the chip always, the AR pill only at 1×. The chip's slot in the
          bottom chrome was ALREADY reserved unconditionally
          (`panoBottomChromePt`, see `previewLayout`), so making it permanent
          moves no pixels of the HUD; the AR pill is absolutely positioned and
          the only tenant of its stack, so hiding it moves nothing either. */}
      {arPillVisible && (
        <View
          style={[styles.pillStack, { top: pillStackTop }]}
          pointerEvents="box-none"
          testID="panoplus-pill-stack">
          <PanoArToggle
            arEnabled={arPillOn}
            onToggle={onArToggle}
            glyphRotateDeg={glyphRotateDeg}
            testID="panoplus-ar-pill"
          />
        </View>
      )}
      {(lensChipVisible || !hideBuiltInControls) && (
        <View
          style={[styles.bottomBar, { bottom: bottomBarBottom }]}
          pointerEvents="box-none"
          testID="panoplus-bottom-bar">
          {lensChipVisible && (
            <PanoLensChip
              // THE LENS THAT WILL RUN, not the flag — see `effectiveLens`.
              // On the AR arm that is always `1x`, which is what keeps the
              // default (0.5×, AR) state from painting a lens ARCore will not
              // open.
              lens={effectiveLens}
              onChange={onLensPill}
              glyphRotateDeg={glyphRotateDeg}
              // `?? true` inside `ultraWideOfferable` — an unanswered question
              // offers both pills; only a measured NO removes one, and never
              // the selected one. The second term is the arm one: a 0.5× this
              // surface cannot leave the AR arm to reach is not offered. See
              // `lensAvail` and `PanoChrome`'s single-lens branch.
              has0_5x={ultraWideOfferable}
              has1x={lensAvail?.wide ?? true}
              testID="panoplus-lens-chip"
            />
          )}
          {/* Pano's built-in shutter, at Pano's built-in position, for a host
              that does not draw one of its own. The SAME callbacks the shell
              reaches through the imperative handle, so the two paths cannot
              disagree about what a hold does. `holdEnabled` is fixed true —
              a tap is inert, but the hold is the whole mode. */}
          {!hideBuiltInControls && (
            <View style={styles.shutterWrap} testID="panoplus-shutter">
              <CameraShutter
                holdEnabled
                disabled={!canCapture}
                isProcessing={shutterBusy}
                onTap={() => undefined}
                onHoldStart={holdStart}
                onHoldComplete={holdEnd}
              />
            </View>
          )}
        </View>
      )}
    </View>
  );
}

// M7 — the ENGINE lives in `useSweepEngine`; this composite only draws.
export const PanoPlusCaptureSurface = forwardRef<
  SurfaceControlHandle,
  PanoPlusCaptureSurfaceProps
>(function PanoPlusCaptureSurface(props, ref): React.JSX.Element {
  const engine = useSweepEngine(props, ref);
  return <SweepScreenView surfaceProps={props} engine={engine} />;
});
