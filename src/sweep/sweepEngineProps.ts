// SPDX-License-Identifier: Apache-2.0
/**
 * The sweep ENGINE's inputs — what `<Camera>` hands `useSweepEngine`.
 *
 * M10: this was `PanoPlusCaptureSurfaceProps`, the props of the sweep's own
 * capture screen. That screen is gone — the sweep runs inside `<Camera>`,
 * on `<Camera>`'s camera, shutter and chrome — and what is left is the engine's
 * input. The props that only drove the old screen's own chrome (its lens chip
 * and AR pill writers, its built-in shutter switch, and the effective-arm feed
 * that let `<Camera>` mirror them) went with it.
 *
 * `SweepOptions` — the part a host sets, through `<Camera sweep={…}>` — is an
 * allow-list over this interface (`Camera.tsx`).
 */
import type {
  SweepSurfaceState as SurfaceControlState,
} from './panoPlusTypes';
import type {
  PanoPlusGuidanceContext,
  PanoPlusDefectCode,
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

/** The lens as the capture chrome names it. */
export type PanoLens = '1x' | '0.5x';

export interface SweepEngineProps {
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
   *
   * M8 — `'host-ar'`: the host owns the AR SESSION (its own `<ARCameraView>`
   * on `RNSARSession.shared`, which is where the AR arm's frames come from).
   * The engine mounts no camera view of its own, never asks native for a
   * camera of its own, and refuses a sweep that resolves to anything but the
   * AR arm. `<Camera>` passes it whenever its AR view is the camera.
   */
  frameSource?: 'own' | 'host' | 'host-ar';
  /**
   * M8 — told `true` once a finishing sweep has passed native's
   * camera-release point (`PanoPlusStatus.cameraReleased`), and `false` again
   * when the finish ends. `<Camera>` unmounts its camera for that window, as
   * it does for a keyframe stitch.
   */
  onStitchingChange?: (stitching: boolean) => void;
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
   * LAYOUT ONLY (M10): whether `<Camera>`'s built-in shutter is drawn, so the
   * hold overlay's bottom reservation matches it (`panoBottomChromePt`).
   * `<Camera>` passes `hideBuiltInShutter`. The sweep draws no shutter of its
   * own any more.
   */
  hideBuiltInControls?: boolean;
  /** `<Camera>`'s own report of whether its shutter should look enabled /
   *  busy (see {@link SurfaceControlState}). Internal: `SweepOptions` does not
   *  carry it — a host follows `onSweepingChange`. */
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
}
