// SPDX-License-Identifier: Apache-2.0
/**
 * useSweepEngine — the sweep ENGINE, lifted out of its screen (M7).
 *
 * Everything `PanoPlusCaptureSurface` did that is not drawing: the arm and
 * calibration read, start / finish / abandon, the status poll and push, the
 * pack sidecars and the teardown, and the imperative handle. MOVED VERBATIM —
 * this commit changes no behaviour; the surface is now a composite that calls
 * this hook and renders what it returns, and its render suites are the oracle.
 *
 * It takes the surface's props (so both the composite and, from M8,
 * `<Camera>` drive it with the same inputs) and never opens a camera: which
 * camera feeds it is the caller's `frameSource` / `poseSource`.
 *
 * Must not import '../index' (the barrel re-exports the surface, and a cycle
 * through it is how a half-initialised module reaches a render).
 */
import type React from 'react';
import {
  useCallback,
  useContext,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  AppState,
  NativeModules,
  Platform,
  useWindowDimensions,
} from 'react-native';
import { useDeviceOrientation } from '../camera/useDeviceOrientation';
import type { ARFrameMeta } from '../stitching/ARFrameMeta';
// THE CONTEXT, NOT `useSafeAreaInsets()`. The hook THROWS when no
// SafeAreaProvider is mounted; reading the context yields `null` instead, so a
// host without one gets zero insets rather than a capture surface that
// crashes. (Hook order also stays fixed either way, which a try/catch around
// the hook would not guarantee once a provider mounted late.)
import { SafeAreaInsetsContext } from 'react-native-safe-area-context';
import type { PanoLens } from './chrome';
import type { SweepSurfaceHandle as SurfaceControlHandle } from './panoPlusTypes';
import { loadVideoFileSystem, nativeDocumentDirectory } from './fileSystem';
import { getPanoPlusSourceView } from './panoPlusSourceView';
import { getPanoPlusAndroidPreviewView } from './panoPlusAndroidPreviewView';
import {
  panoPlusAndroidArmNotice,
  panoPlusArmContract,
  panoPlusArmSessionDefaults,
  panoPlusUnavailableDetail,
} from './panoPlusAndroidArm';
import {
  PANO_PLUS_NOTICE_FILE,
  PANO_PLUS_SWEEP_NOTICE_FILE,
  PANO_PLUS_IDLE_HEARTBEAT_MS,
  PANO_PLUS_IDLE_REOPEN_MS,
  PANO_PLUS_IDLE_REOPEN_TRIES,
  PANO_PLUS_STATUS_POLL_FAST_MS,
  PANO_PLUS_STATUS_POLL_MS,
  PANO_PLUS_SWAP_GRACE_MS,
  barePath,
  fileUri,
  newPanoPlusSessionId,
  panoPlusNoticeSidecar,
  panoPlusCameraLockLine,
  panoPlusViewfinderNotice,
  panoPlusDropLine,
  panoPlusArmNotice,
  panoPlusIosVcHostArmNotice,
  panoPlusVcDeviceRefusalFailure,
  panoPlusErrorInfo,
  panoPlusFailureCopy,
  panoPlusGlyphRotationDeg,
  panoPlusGuidance,
  panoPlusHoldOf,
  panoPlusHudLine,
  panoPlusSweepFaults,
  panoPlusPreviewLayout,
  panoPlusPreviewPlaceholder,
  panoPlusPreviewStaleNotice,
  panoPlusPreviewSource,
  panoPlusPreviewWindowCaption,
  panoPlusPreviewWindowMultiple,
  panoPlusResultOf,
  panoPlusSweepHudSidecar,
  panoPlusSessionIdOf,
  panoPlusSessionPaths,
  panoPlusStatusSessionId,
  panoPlusUprightRotationDeg,
  readPanoPlusStatus,
} from './panoPlusModel';
import {
  panoPlusCameraOffNotice,
  panoPlusPreviewPinNotice,
} from './panoPlusCameraOffNotice';
import {
  cancelPanoPlus,
  getPanoPlusStatus,
  setPanoPlusIdlePreview,
  panoPlusIsAvailable,
  startPanoPlus,
  stopPanoPlus,
} from './panoPlusNative';
import type {
  PanoPlusCameraLock,
  PanoPlusCaptureResult,
  PanoPlusFailure,
  PanoPlusPoseSource,
  PanoPlusStartOptions,
  PanoPlusStatus,
} from './panoPlusTypes';
import type {
  CalibPlannedFormat,
  CalibSnapshot,
  PanoPlusLensAvailability,
} from './panoPlusCalibration';
import {
  calibrationForPlannedFormat,
  panoPlusLensAvailability,
} from './panoPlusCalibration';
import {
  panoPlusBasisCapability,
  resolvePanoPlusBasis,
} from './panoPlusBasisAcquisition';
import type { PanoPlusCaptureSurfaceProps } from './PanoPlusCaptureSurface';
import {
  PANO_BOTTOM_BAR_INSET,
  panoBottomChromePt,
  withHostChromeTop,
  type Phase,
} from './sweepLayout';

/** One of the two ping-pong preview image slots — see `previewSlots`. */
export type PreviewSlot = {
  uri: string;
  width: number;
  height: number;
  left: number;
  top: number;
};

export function useSweepEngine(
  props: PanoPlusCaptureSurfaceProps,
  ref: React.ForwardedRef<SurfaceControlHandle>,
  /**
   * M8 — `enabled: false` is the hook mounted but not selected (`<Camera>`
   * calls it on every engine). Every NATIVE call is gated on it: no
   * calibration or lens read, no ARCore probe, no idle viewfinder, no start.
   * When it falls with a sweep live, the sweep is STOPPED — finalized, its
   * pack kept, never cancelled — and `onSweepingChange(false)` is reported,
   * exactly as an unmount does.
   */
  options: { enabled?: boolean } = {},
) {
  const enabled = options.enabled ?? true;
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const {
    onComplete,
    onFailure,
    rectify = true,
    gainMatch = true,
    packFrames = 'none',
    engineOptions,
    attitudeMagFree,
    vcPluginArm,
    vcCameraId,
    hostArmRefusal,
    vcViewTag,
    frameSource = 'own',
    hostPreviewLive = true,
    hostPreviewError = '',
    lockCamera = true,
    pinPreviewFps = true,
    meteringSettleMs,
    poseSource = 'ar',
    lurchAccelMps2,
    tauUncorrected = false,
    lens = 'ultraWide',
    hostChromeTopPt = 0,
    guidanceCopy,
    onLensChange,
    onPoseSourceChange,
    hideBuiltInControls = false,
    onControlsState,
    bottomBarOffset = 0,
    jogGuard = false,
    imuSidecar = false,
    packOptions,
    onSweepingChange,
    onPaintedChange,
    onEffectiveArmChange,
  } = props;

  const orientation = useDeviceOrientation();
  // The live window, so the preview is placed against the CURRENT geometry —
  // the surface is used in landscape, and a Dimensions.get() read taken at
  // mount would size the panel from the portrait screen it was mounted on.
  const window = useWindowDimensions();
  /**
   * The surface's OWN box, measured — not the window.
   *
   * ⚠ THESE DIFFER, AND THE DIFFERENCE HID THE LIVE PREVIEW. This surface
   * is mounted INSIDE `<Camera>`, which a host commonly wraps in a
   * `<SafeAreaView>`, so the box is shorter than the window (874 → 781 pt
   * on the example app's iPhone). Placing the growing-canvas capsule
   * against the WINDOW while living in the smaller box pushed it down by
   * the difference, and its lower half landed under this surface's own
   * shutter row. The operator reported it as "I do not see the preview
   * with the expanding canvas as I take the capture" — it was on screen,
   * behind the shutter.
   *
   * Falls back to the window until the first layout pass, which is the
   * only frame where nothing is drawn against it yet.
   */
  const [surfaceBox, setSurfaceBox] = useState<{ width: number; height: number } | null>(null);
  const box = surfaceBox ?? { width: window.width, height: window.height };
  // In LANDSCAPE the sensor housing is a bar down one SIDE — exactly where the
  // tall-panorama panel lives. The insets say which edge that is on this
  // device, so the layout never has to guess what `landscape-left` means.
  const safeAreaInsets = useContext(SafeAreaInsetsContext);
  const [phase, setPhase] = useState<Phase>('idle');
  /**
   * THE ARM THIS SWEEP IS ACTUALLY RUNNING ON — latched at Start, null at idle.
   *
   * ⚠ THE `poseSource` PROP CAN MOVE UNDER A LIVE SWEEP SINCE 2026-09-01, and
   * everything below used to derive from it directly. Before the consolidation
   * the flag could only be reached from a gear panel, and reaching that panel
   * meant leaving pano+ — so the prop only ever changed while this component
   * was unmounted and a bare derivation was safe by construction. The capture
   * screen's AR pill removed that guarantee, and two failures follow from a
   * derivation with no phase term:
   *
   *  · `arArmed` re-derives mid-sweep, so React UNMOUNTS `<ARCameraView>` under
   *    an ARKit sweep (that unmount IS `RNSARSession.shared.stop()`) or MOUNTS
   *    it on top of the decoupled arm's live AVCaptureSession. One body, two
   *    clients — the P0 this component already carried once.
   *  · the reported effective arm changes, and the host's pill draws it. A pill
   *    reading IMU over a sweep ARKit recorded is the one failure that leaves
   *    no trace in the pixels.
   *
   * It is the render-visible twin of `armsRef` — which latches the same answer
   * for the PACK — so the screen and the pack cannot disagree about the arm.
   * `fallbackToAr` rides with it because the downgrade is a fact about the
   * sweep that started, not about the flag as it stands now.
   */
  const [runningArm, setRunningArm] = useState<
    { poseSource: PanoPlusPoseSource; fallbackToAr: boolean } | null
  >(null);
  const [status, setStatus] = useState<PanoPlusStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** v6 — what the camera-lock attempt reported, kept so the HUD can warn the
   *  operator AT START. The drift clause in `panoPlusDropLine` is the better
   *  signal (it reads what the exposure actually did) but it cannot fire until
   *  >2% has already drifted, i.e. until some of the sweep is already banded. */
  const [cameraLock, setCameraLock] = useState<PanoPlusCameraLock | null>(null);
  // The AR view is held down for one swap grace after mount — see the module
  // doc's LIFECYCLE note. Rendering it immediately races the outgoing
  // surface's `RNSARSession.stop()`.
  const [arReady, setArReady] = useState(false);
  const [howToVisible, setHowToVisible] = useState(true);
  /**
   * IS THE ARM NOTICE'S DETAIL OPEN. Collapsed by default — 2026-09-02.
   *
   * Measured on the Galaxy A35 before this change, with the IMU arm selected:
   * the HUD's text ran from y=169 to y=1539 of a 2,340 px display (58.5% of
   * the screen), over the live camera, and the host's own "IMU arm — ARCore is
   * DOWN by design" banner at y=1101..1238 was printed on top of it — two
   * paragraphs in the same pixels, neither readable. The headline alone is 86
   * px and says which arm and what is wrong with it, which is the whole of
   * what has to be legible while the phone is up at a shelf.
   *
   * The detail is NOT deleted, in either direction: it is one tap away here,
   * and it is written into the pack in full on every sweep (see
   * `panoPlusNoticeSidecar`), expanded or not. A diagnostic that survives only
   * as something the operator remembers reading is not evidence.
   */
  const [armDetailOpen, setArmDetailOpen] = useState(false);
  /** How long the surface has been in `sweeping`, ms — the only input the
   *  "no status has reached this screen at all" placeholder rung has. */
  const [sweepingForMs, setSweepingForMs] = useState(0);
  /**
   * `true` when RN could not LOAD the preview file the status pointed at.
   *
   * The one link in this chain that no test on this machine can exercise: the
   * engine writes `preview.jpg` and JS renders `file://…/preview.jpg?v=<seq>`,
   * and whether iOS's image loader reads that path is a device fact. It is the
   * SAME mechanism the library's own PanoramaBandOverlay ships, and RN's
   * file-request handler reads `URL.path` (so the cache-bust query is ignored
   * for the read) — but "should work" is what the last blank preview was, so
   * the failure gets a caption instead of silence.
   */
  const [previewLoadFailed, setPreviewLoadFailed] = useState(false);
  /**
   * THE TWO-SLOT PING-PONG — the third and, this time, mechanism-level fix for
   * the flicker.
   *
   * ⚠ WHY THE FIRST TWO FAILED, because the reason is the design constraint.
   * On Android an `<Image>` is a Fresco DraweeView, and assigning a NEW source
   * to a MOUNTED one calls `AbstractDraweeController.init()` →
   * `hierarchy.reset()` → the actual-image layer becomes a fully transparent
   * `ColorDrawable(0)`, SYNCHRONOUSLY, before the replacement request is even
   * submitted. RN installs no placeholder to fall back on. So the capsule is
   * transparent for one disk-read plus one JPEG decode on EVERY publish, and
   * what shows through is the frame's own dark scrim over the live viewfinder.
   * That is the flicker. iOS cannot do this: `RCTImageComponentView` only ever
   * assigns `_imageView.image` inside `didReceiveImage:`, so it holds the last
   * frame until the new one is decoded and then swaps atomically. Same
   * component, opposite behaviour, which is exactly why it is Android-only.
   *
   *   · `fadeDuration={0}` governed how the ARRIVING image appears. The
   *     disappearance is `resetFade()` → `finishTransitionImmediately()`,
   *     which has no duration knob. It could never have closed the gap.
   *   · The under-layer could not work EVEN IN PRINCIPLE: Fresco resolves a
   *     `file://` request through `new File(uri.getPath())`, which DROPS the
   *     query string — so `?v=N-1` and `?v=N` name the same bytes on disk, and
   *     `preview.jpg` is one file rewritten in place. There is no previous
   *     frame to hold. It also mounted a fresh view at the exact instant the
   *     gap opened, so it was blank too, and it cost a second full decode per
   *     publish on a CPU already dropping 44% of camera frames.
   *
   * THE FIX REMOVES THE MECHANISM RATHER THAN COVERING IT. Two slots, both
   * mounted for the life of the sweep. A new uri is assigned to the slot that
   * is currently HIDDEN; the VISIBLE slot's source prop never changes, so
   * `setSource` early-returns, its Drawee is never re-initialised, and it keeps
   * the bitmap it already holds. When the hidden slot reports `onLoad` we swap
   * which one is visible — by OPACITY, a view prop, so it cannot dirty either
   * Drawee. The held frame lives in the visible view's own drawable, which is
   * why the single-rewritten-file problem does not defeat it.
   *
   * Each slot freezes the geometry it decoded at. Without that, the held frame
   * would be re-fitted into a box that has grown since, and with
   * `resizeMode="contain"` it would letterbox-centre rather than stay anchored
   * — a moving preview boundary, which this operator has already reported as a
   * defect in its own right.
   *
   * A pure SIZE change does not re-request (`onSizeChanged` sets isDirty only
   * for multiple sources or tiling; there is one source and contain is not
   * tiled), so the held slot survives the panorama growing.
   */
  // (`PreviewSlot` — module scope, below the imports: the composite draws it.)
  const [previewSlots, setPreviewSlots] = useState<{
    a: PreviewSlot | null;
    b: PreviewSlot | null;
    visible: 'a' | 'b';
  }>({ a: null, b: null, visible: 'a' });
  /**
   * How long a slot may sit loading before we show it anyway.
   *
   * ⚠ WITHOUT THIS THE FIX IS WORSE THAN THE BUG. The swap is driven solely by
   * `onLoad`; a decode that is lost, errors silently, or simply never fires on
   * a given device would freeze the panorama on one buffer for the rest of the
   * sweep, which presents as "the preview stopped growing". Swapping on the
   * timeout shows a possibly-blank slot — the old behaviour — rather than a
   * stuck one, so the failure mode degrades to what shipped before instead of
   * to something new.
   */
  const PREVIEW_SLOT_TIMEOUT_MS = 900;

  /**
   * ⚠️ THE UNMOUNT GUARD, and it is deliberately NOT derived from `phase`.
   *
   * `true` from the moment native has a live session that THIS component is
   * responsible for, `false` the instant some other path has taken that
   * responsibility over (finish / abandon / the started-after-unmount branch).
   * It is written SYNCHRONOUSLY at each of those points, never through state
   * and never through an effect.
   *
   * The reason is a real, silent, data-destroying race that a `phase`-derived
   * ref does not survive. `finish()` resolves and does
   * `setPhase('idle'); onComplete(...)`; `onComplete` makes the host unmount
   * this surface. React batches all of that into ONE commit, and in that commit
   * the surface is REMOVED — so an effect that mirrors `phase` into a ref never
   * runs, the unmount cleanup still reads `'sweeping'`, and it fires a SECOND
   * `stopPanoPlus()`. That second stop rejects `panoplus-not-running`, takes the
   * cancel branch, and DELETES the pack the first stop just wrote — the whole
   * capture, gone, with no error anywhere.
   */
  const sweepLiveRef = useRef(false);
  /**
   * WHICH SWEEP THE PANEL IS SHOWING — the session id this surface is
   * currently responsible for DISPLAYING, `null` when that is none.
   *
   * ⚠ IT IS NOT A SECOND `sweepLiveRef`, and the two lifetimes differ on
   * purpose. `sweepLiveRef` is NATIVE-SESSION OWNERSHIP — who is allowed to
   * call `stop()` — and it is dropped the instant `finish()` starts awaiting,
   * because a second stop would delete the pack. This one is DISPLAY
   * ATTRIBUTION, and the finishing window still belongs to the sweep being
   * finished: its tail-flush previews are the last pixels it will ever
   * publish, and blanking them there would put the panel back one frame short
   * of the panorama the operator just recorded. So this is released where the
   * panel itself is released — at the two `setStatus(null)` sites in `finish`
   * and at a start that failed — and it is written SYNCHRONOUSLY in `start`,
   * never through state and never through an effect, for the same reason
   * `sweepLiveRef` is: the AR push channel can land inside the very commit an
   * effect would still be waiting for.
   *
   * WHY IT EXISTS (operator, 2026-09-07, iPhone17,1, ARKit arm): "the preview
   * just shows the previous output from the next capture onwards". `seq` is
   * the PER-SWEEP frame counter and restarts at 0 every capture, so the bare
   * monotonic guard in `applyStatus` was session-blind — one status held from
   * a finished sweep swallowed every frame of the next one until its counter
   * overtook, which on a shorter second sweep never happens. The two packs
   * pulled off the phone show capture 2 publishing 23 previews into its own
   * dir with 0 failures while the panel drew capture 1's.
   */
  const liveSessionRef = useRef<string | null>(null);
  /** Single-flight over start/stop/cancel: two concurrent `stop()`s would
   *  race the same finalize, and the second would reject `not-running` and
   *  then `cancel()` — deleting the pack the first one just wrote. */
  const busyRef = useRef(false);
  const mountedRef = useRef(true);
  /** The phase as the IMPERATIVE handle sees it — `holdStart`/`holdEnd` are
   *  called from the shell's shutter callbacks, whose closures are older than
   *  this render, so they read the mirror rather than the state. Written on
   *  every render, never inside an effect (an effect would lag one commit,
   *  which is the same class of race `sweepLiveRef`'s doc describes). */
  const phaseRef = useRef<Phase>('idle');
  phaseRef.current = phase;
  /**
   * THE RELEASE THAT ARRIVED BEFORE THE START LANDED (2026-09-03).
   *
   * Pano's shutter fires `onHoldComplete` on release, and Pano's `handleHoldEnd`
   * finalizes because its `statusPhase` is already `recording` before the
   * native start is awaited. pano+'s start is a bridge round-trip during which
   * the phase is `starting` and no session exists yet to stop — so a release
   * in that window would either be dropped (a sweep the operator has let go
   * of keeps running until something else stops it) or `stop()` a session
   * that is not there (`not-running` → cancel, deleting the pack the start is
   * about to create). Neither is "release finalizes". So the release is
   * LATCHED here, and the start's success branch finishes at once — a
   * near-empty pack, which the existing `panoplus-empty` path reports with
   * its location, exactly as it would any other sweep too short to paint.
   */
  const stopOnStartRef = useRef(false);
  /**
   * The same latch for a GUARD RAIL that fires in the start window.
   *
   * ⚠ AND IT IS NOT `stopOnStartRef`. That one FINALIZES — it is the
   * operator's release, and a release keeps what was painted. A guard rail
   * has decided the capture is not worth keeping, so the start window's
   * abandon must DISCARD. Holding both in one flag would have a rotation
   * mid-open ship the near-empty pack as a panorama.
   *
   * Before this, `abandon()` in the `starting` phase called
   * `cancelPanoPlus()` against a session native had not created yet — which
   * rejects `panoplus-not-running`, is swallowed — set the phase to idle,
   * and returned. The in-flight `start()` then resolved into the branch
   * below, raised `sweepLiveRef` and set the phase back to `'sweeping'`:
   * the guard rail reported the capture abandoned to the host and the sweep
   * carried on painting behind it. Holds the reason so the discard reports
   * the same one the caller passed.
   */
  const abandonOnStartRef = useRef<string | null>(null);
  /** Arms latched at START, so the result reports what the sweep ACTUALLY ran
   *  even if the host flips a pill mid-sweep.
   *
   *  `poseSource` here is what NATIVE ANSWERED, not what was requested — it is
   *  overwritten from `started.poseSource` before the sweep goes live. The one
   *  failure that would leave no trace in the pixels is a sweep believed to be
   *  decoupled that ran on ARKit, so the result records the reported arm. */
  const armsRef = useRef<PanoPlusCaptureResult['arms']>({
    rectify, gainMatch, packFrames, poseSource: 'ar',
  });

  // ── THE SELECTED ARM'S PRECONDITION ───────────────────────────────────────
  //
  // Read at mount and ONLY when the IMU arm is selected: on the ARKit default
  // this whole block never runs, no native call is made, and the surface is the
  // one that shipped. That is what makes "the default path is unchanged" a
  // property of the code rather than a claim in a comment.
  //
  // TWO SEPARATE QUESTIONS, kept separate all the way to the screen. `plan` is
  // a HARDWARE fact (is there a physical ultra-wide publishing 4:3 at 60 fps?);
  // `calib` is a DEVICE-STATE fact (has anyone measured τ and the basis for the
  // format that plan names?). Merging them would tell an operator holding a
  // phone with no ultra-wide to go and run a calibration that cannot help him.
  const [plan, setPlan] = useState<CalibPlannedFormat | null>(null);
  const [calib, setCalib] = useState<CalibSnapshot | null>(null);
  const [calibRead, setCalibRead] = useState(false);
  /**
   * Bumped when the in-camera gesture has PERSISTED a basis, to re-read the
   * store.
   *
   * The read is the only thing that knows the basis now exists — the overlay
   * writes through native and the snapshot in this component's state is a
   * frozen copy of the moment before. Without the re-read the arm would stay
   * fallen-back on the very device that had just been calibrated, and the only
   * way out would be leaving the mode and coming back.
   */
  const [calibEpoch, setCalibEpoch] = useState(0);
  /**
   * The per-lens calibration snapshot, so a lens FLIP does not black the
   * viewfinder while a native round trip runs. Dropped on `calibEpoch`, which
   * is the one thing that can change the store under us (the in-camera
   * gesture and the gear both bump it). Keyed by lens because the snapshot is
   * — τ is `model | lens | W×H | fps`.
   */
  const calibCacheRef = useRef(new Map<string, {
    plan: CalibPlannedFormat | null;
    snapshot: CalibSnapshot | null;
  }>());
  useEffect(() => { calibCacheRef.current.clear(); }, [calibEpoch]);
  /**
   * The operator skipped the first-run basis gesture for THIS mounting.
   *
   * ⚠ NOT PERSISTED, and see `PanoPlusBasisResolutionInput.gestureDeclined` for
   * why: a decline is an answer about this capture, not about this phone.
   */
  const [gestureDeclined, setGestureDeclined] = useState(false);
  /**
   * A basis was measured AND persisted during this mounting.
   *
   * ⚠ IT IS A LATCH, AND WITHOUT IT THE OVERLAY LOOPS FOREVER. The acquisition
   * ends by re-reading the store; if that read comes back still reporting no
   * basis — a key the writer and the reader spell differently, which this repo
   * has already paid for once on the τ side, where the panel reported "τ saved"
   * and "NOT CALIBRATED" one refresh apart — then `needsGesture` is true again
   * and the overlay remounts, re-records, re-saves, and does it again. The
   * operator would be trapped performing the same gesture indefinitely with no
   * error anywhere. So a successful acquisition ends the offer for this
   * mounting whatever the read then says, and the DISAGREEMENT is reported in
   * words instead of retried in silence.
   */
  const [basisAcquired, setBasisAcquired] = useState(false);
  /** v12 review fix — did the idle viewfinder's session actually open?  The
   *  explainer re-appears on `false`; a black feed must never be silent. */
  const [idleFeedLive, setIdleFeedLive] = useState(false);
  /** WHY it did not, in native's words. Rendered by
   *  `panoPlusCameraOffNotice` — see that module's header for the incident
   *  that made a reason-driven notice non-optional. */
  const [idleReason, setIdleReason] = useState('');
  /**
   * WHAT HAPPENED TO THE VIEWFINDER'S FRAME RATE, as native reported it.
   *
   * ⚠ A SECOND FACT ABOUT THE SAME FEED, AND IT IS NOT `idleReason`. That one
   * answers "is there a picture"; this one answers "is the picture the one the
   * sweep will record". They fail independently — the decline this carries
   * arrives on a viewfinder that came up perfectly — so they are held apart
   * rather than merged into one sentence the panel would have to parse.
   * `applied: null` is the honest start: nothing has been reported yet.
   */
  const [idlePin, setIdlePin] = useState<{
    applied: boolean | null;
    range: string | null;
    note: string;
    /** Which fact `applied` is about — Android answers the rate, iOS the whole
     *  framing. See `panoPlusPreviewPinNotice`. */
    subject: 'rate' | 'framing';
  }>({ applied: null, range: null, note: '', subject: 'rate' });

  // Availability is a two-part question and BOTH parts must be reported
  // separately, or "pano+ is missing" and "this host has no filesystem" look
  // identical on screen.
  //
  // ⚠ HOISTED ABOVE THE PRECONDITION READ (2026-09-02), and the order is now
  // load-bearing rather than incidental: on the Android contract `nativeReady`
  // IS the build half of the basis question (`plan`, below), where on iOS that
  // half is answered by the calibration module. A `useMemo` declared after its
  // reader cannot be read by it, and moving the read instead would have meant
  // asking the iOS calibration module on a platform that does not carry it.
  const fs = useMemo(() => loadVideoFileSystem(), []);
  const nativeReady = useMemo(() => panoPlusIsAvailable(), []);
  // ⚠ THE HOST'S FILESYSTEM FIRST, THIS PACKAGE'S OWN DIRECTORY SECOND.
  // The order is load-bearing: a host that HAS expo-file-system keeps writing
  // to exactly the directory it always wrote to, so this change moves no
  // existing host's data. The fallback exists for hosts that have no Expo at
  // all, which used to be told "pano+ is not available" — a sentence about
  // the build, for a missing peer dependency. See `fileSystem.ts`.
  const documentDirectory = fs?.documentDirectory ?? nativeDocumentDirectory();
  const available = nativeReady && documentDirectory != null;

  /**
   * WHICH ARM CONTRACT THIS RUNTIME IS ON — asked ONCE, answered as data.
   *
   * Same discipline as `panoPlusBasisCapability(Platform.OS)` below and for the
   * same reason: the two platforms' arms differ in what they must MEASURE
   * before a sweep (iOS: τ and the basis, both on device; Android: neither —
   * the clocks are comparable and `C` derives from two documented rotations),
   * and an asymmetry spelled `if (Platform.OS === 'android')` in JSX is one no
   * test can reach. See `panoPlusAndroidArm.ts` for the whole argument.
   */
  const armContract = useMemo(() => panoPlusArmContract(Platform.OS), []);
  /**
   * M5 — THE iOS ARM ON THE HOST'S CAMERA. `<Camera>`'s vision-camera owns the
   * camera, τ is 0 by default and the basis is derived natively at the hold,
   * so none of the own-camera ladder applies: no calibration read, no basis
   * gesture, no ARKit fallback (`panoPlusIosVcHostArmNotice`).
   */
  const vcHostArm = armContract === 'ios-coremotion' && frameSource === 'host';

  useEffect(() => {
    if (!enabled) return undefined;   // M8 — no native read for a hook not selected
    if (poseSource !== 'imu') return undefined;
    // ── THE ANDROID CONTRACT ASKS NOTHING ─────────────────────────────────
    //
    // `calibrationForPlannedFormat` reaches for `RNSSweepCalibration`, an iOS
    // module. On Android it resolves `calib-unavailable`, which
    // `panoPlusArmNotice` reads — correctly, for iOS — as "this build cannot
    // answer" and turns into an announced fallback to the AR arm. That answer
    // is right on a phone with a missing pod and WRONG here: the Android binary
    // is complete and the arm needs no calibration at all, so the read would
    // have made the IMU arm permanently unreachable on the platform this port
    // exists for, with a banner blaming a build fault that does not exist.
    //
    // Settled synchronously rather than through a resolved promise: there is no
    // question in flight, so `armPending` must never be true here — a spinner
    // over a decision already made is the flash the Start button's own
    // `resolving` guard exists to prevent.
    if (armContract === 'android-sensor' || vcHostArm) {
      // M5 — the iOS host arm reads no store either: τ is 0 by default and
      // the basis is derived natively from the open camera at the hold.
      setPlan(null);
      setCalib(null);
      setCalibRead(true);
      return undefined;
    }
    let live = true;
    // Re-entry (a lens flip) starts a FRESH read: the previous lens's
    // snapshot must not gate this lens's arm while the new read is in flight.
    //
    // ⚠ …UNLESS THIS LENS HAS ALREADY BEEN READ, because clearing then costs
    // the operator a BLACK SCREEN and nothing else. `armPendingForIdle` is
    // `!calibRead`, and `avfIdleWanted` ANDs `!armPendingForIdle` — so
    // clearing the snapshot takes the idle viewfinder down and the camera is
    // not even ASKED for until the native round trip returns. On the device
    // that read is the first link of a serial chain the operator experiences
    // as "the camera has not opened yet" for seconds on every AR→0.5× flip,
    // where Pano's lens change is instant because it never closes a session.
    //
    // The snapshot is keyed by lens and the store only changes through the
    // gear — which bumps `calibEpoch`, a dep of this effect, and the cache is
    // dropped there. So a flip BACK to a lens already read reuses its answer,
    // keeps the viewfinder up, and still re-reads in the background.
    const cached = calibCacheRef.current.get(lens);
    if (cached !== undefined) {
      setPlan(cached.plan);
      setCalib(cached.snapshot);
      setCalibRead(true);
    } else {
      setCalibRead(false);
      setPlan(null);
      setCalib(null);
    }
    // NEVER THROWS OUTWARD. A rejection here must degrade to "this build cannot
    // answer" — which `panoPlusArmNotice` renders as an explicit ARKit fallback
    // — and never to an unhandled rejection that leaves the button in a state
    // nothing explains.
    void calibrationForPlannedFormat({ lens }).then(
      (r) => {
        if (!live) return;
        calibCacheRef.current.set(lens, { plan: r.plan, snapshot: r.snapshot });
        setPlan(r.plan);
        setCalib(r.snapshot);
        setCalibRead(true);
      },
      () => {
        if (!live) return;
        setPlan(null);
        setCalib(null);
        setCalibRead(true);
      },
    );
    return () => { live = false; };
    // `lens` is a dep (P5 review fix): flipping the pill re-reads the
    // precondition for the camera the sweep will actually open.
    // `calibEpoch` is a dep (2026-09-01): the in-camera gesture writes the
    // basis through native, and nothing else would tell this component.
    // `armContract` is a dep (2026-09-02) only to satisfy exhaustive-deps —
    // it is fixed for the life of the process.
  }, [poseSource, lens, calibEpoch, armContract, vcHostArm, enabled]);

  /**
   * WHICH LENSES THIS BODY CAN ACTUALLY OPEN — pano+'s answer to Pano's
   * `has0_5x`, so the chip never offers a pill the sweep would refuse.
   *
   * Asked ONCE, at mount: it is a fact about the hardware, and neither the
   * lens flag nor the arm can change it. `panoPlusLensAvailability` asks the
   * SAME selector the sweep and the idle viewfinder open through
   * (`RNISPanoAvfSource.planFormat`, once per lens) rather than a separate
   * capability list, so "offered" and "openable" cannot drift apart; it is
   * `null` off iOS and on a build whose calibration module cannot be asked,
   * and `null` means BOTH PILLS STAND — a hardware claim must not be made out
   * of silence. Session-free and permission-free on the native side (device
   * discovery plus a format enumeration), so it is safe beside a live ARKit
   * session, which is exactly when the surface is mounted.
   */
  const [lensAvail, setLensAvail] = useState<PanoPlusLensAvailability | null>(
    null,
  );
  const lensAvailAskedRef = useRef(false);
  useEffect(() => {
    // ⚠ NOT ON THE ARKit ARM, AND NOT BEFORE THE ARM READ. Two gates, each
    // protecting something that was measured, not guessed:
    //
    //  · `poseSource === 'imu'` — the AR arm makes NO calibration call at
    //    all, deliberately (`panoPlusPoseSource.render`: "a per-mount cost
    //    and a new failure mode for the path that carries the entire
    //    programme").
    //
    //    ⚠ THIS GATE USED TO BE FREE AND IS NOT ANY MORE. Until 2026-09-03
    //    it read "the chip is hidden under AR anyway, so the question is not
    //    even asked there" — true then, false now: the chip is mounted on
    //    BOTH arms. What the gate costs today is written up where it lands,
    //    beside `ultraWideOfferable`, as a KNOWN BOUNDED GAP: on the AR arm
    //    the hardware question is unanswered, so both pills stand and a body
    //    with no ultra-wide is over-offered until the tap moves the arm and
    //    the probe finally runs. Keeping the gate is still the right trade —
    //    the AR arm is the path that carries the entire programme — but it
    //    is now a trade rather than a tautology.
    //  · `calibRead` — the arm's own precondition read goes FIRST and alone.
    //    This is chrome: which pills to draw. It must never interleave with,
    //    or delay, the read that decides whether the arm can run.
    //
    // Then once per mount: it is a fact about the hardware, and neither the
    // flag nor the arm can change it. (`askedRef` rather than `lensAvail !=
    // null` because null is also the legitimate "not ours to answer" answer.)
    if (!enabled) return undefined;   // M8
    if (poseSource !== 'imu' || !calibRead) return undefined;
    // M5 — not on the iOS host arm either: the question asks pano+'s OWN
    // camera planner which lenses IT could open, and on this arm pano+ opens
    // none — `<Camera>`'s lens chip owns the lens.
    if (vcHostArm) return undefined;
    if (lensAvailAskedRef.current) return undefined;
    lensAvailAskedRef.current = true;
    // ⚠ `mountedRef`, NOT A PER-RUN `live` FLAG, and the once-only latch is
    // why. A cleanup that flipped a closure flag would, under StrictMode's
    // mount → unmount → mount, silence the ONE request this effect will ever
    // make: the re-run finds the latch set and never asks again, so the chip
    // would default to both pills for the life of the surface. `mountedRef`
    // is restored by the mount effect below, so the answer still lands.
    // Never throws outward by contract; the rejection arm is here because a
    // dead chip is not worth an unhandled rejection if that ever changes.
    void panoPlusLensAvailability().then(
      (a) => { if (mountedRef.current) setLensAvail(a); },
      () => undefined,
    );
    return undefined;
  }, [poseSource, calibRead, vcHostArm, enabled]);

  // ── WHERE THE BASIS COMES FROM, AND WHETHER TO ASK FOR IT ────────────────
  //
  // The ladder is `panoPlusBasisAcquisition`'s and not this file's, for the
  // reason `panoPlusArmNotice` is not this file's either: every rung is a
  // device state that cannot be produced on this machine, so the decision has
  // to live where a test can reach it. This component only ACTS on the route.
  //
  // ⚠ `Platform.OS` IS A CAPABILITY QUESTION, NOT A BRANCH. It is asked once,
  // here, and answered as data — iOS cannot derive `C` because Apple does not
  // document CoreMotion's frame against the camera raster, which is the whole
  // reason basis #8 had to be measured on hardware. Android can, and does it
  // inside its own recorder. Spelling that as `if (Platform.OS === 'ios')` in
  // the JSX would put the asymmetry somewhere no test could read it.
  const basisResolution = useMemo(
    () => resolvePanoPlusBasis({
      capability: panoPlusBasisCapability(Platform.OS),
      // ⚠ `plan` IS THE *BUILD* HALF OF THE QUESTION, AND THE TWO PLATFORMS
      // ANSWER IT FROM DIFFERENT MODULES. `resolvePanoPlusBasis` reads a null
      // plan (or `calib-unavailable`) as "this binary cannot derive OR record a
      // basis", which on iOS means the calibration pod is missing. On Android
      // nothing about the basis goes through that pod — the derivation lives in
      // the recorder behind the live session module — so the honest build probe
      // there is whether THAT module is registered. Passing the iOS null
      // through would have reported `no-calibration-module` on a complete APK
      // and blocked the arm with a sentence naming a pod Android does not use.
      plan: armContract === 'android-sensor'
        ? {
            ok: nativeReady,
            reason: nativeReady ? null : 'calib-unavailable',
            detail: nativeReady
              ? null
              : panoPlusUnavailableDetail(Platform.OS),
          }
        : plan,
      // NOT the derived index, on purpose and permanently. A non-null
      // `basisIndex` takes the `stored` rung, which stamps provenance
      // `measured` — and nothing on an Android phone has measured anything
      // (the derivation multiplies two documented rotations; the falsification
      // run refused). Leaving it null is what routes Android to `derived`,
      // which is the word the pack uses. A `stored` index here can only come
      // from a real `selectBasis()` fit that was persisted.
      basisIndex: calib?.basisIndex ?? null,
      basisLabel: calib?.basisLabel ?? null,
      gestureDeclined,
      // ⚠ "NOBODY LOOKED" IS NOT "THE LOOK CAME BACK EMPTY" (2026-09-03). The
      // precondition effect early-returns on the ARKit arm — correctly: that
      // arm consumes no `C` — so `plan` and `calib` stay null for the life of
      // the mount, and the ladder's BUILD rung read that null as a missing
      // calibration pod and reported `no-calibration-module` on a complete
      // binary. Nothing consumes `basisRoute` outside tests today, which is the
      // only reason it has cost nothing; the moment it lands in a pack sidecar
      // or a screenshot it is a diagnostic naming the wrong artefact to
      // rebuild. `needsGesture` is false on both answers, so the overlay's gate
      // does not move either way.
      //
      // Android is pinned TRUE rather than passed `calibRead`: its `plan` above
      // is synthesized from `nativeReady`, a mount-time availability fact that
      // needs no read, so its answer is genuinely known on BOTH arms. Handing
      // it `calibRead` would route the Android ARKit arm — where the same
      // early-return leaves `calibRead` false — to `not-asked`, and
      // `panoPlusAndroidArm` reads this route.
      planRead: armContract === 'android-sensor' ? true : calibRead,
    }),
    [
      armContract,
      calib?.basisIndex,
      calib?.basisLabel,
      calibRead,
      gestureDeclined,
      nativeReady,
      plan,
    ],
  );

  /** The sentence above the button and the label ON it. Pure — see the model.
   *
   *  ⚠ TWO PRODUCERS, ONE SHAPE. The Android arm's precondition is a different
   *  question (no τ stage exists, `C` derives, there is no calibration store to
   *  read), so it has its own table — see `panoPlusAndroidArm.ts` for why that
   *  is a second POLICY rather than a second copy of one. Everything below this
   *  line reads `armNotice` and cannot tell which produced it, which is the
   *  property that keeps the arm latch, the pack stamp and the host's pill on
   *  one code path. */
  // ── M2: CAN ARCore RUN HERE? ─────────────────────────────────────────────
  // One probe per mount, Android only. The AR arm has no fallback since M2,
  // so the notice needs the answer to refuse by name, and the AR view is not
  // mounted until it is yes (an unsupported phone would show a black view
  // that never delivers a frame, and a hold would paint nothing).
  const [arcoreAvailable, setArcoreAvailable] = useState<boolean | null>(null);
  useEffect(() => {
    if (!enabled) return undefined;   // M8
    if (armContract !== 'android-sensor') return undefined;
    const mod = (NativeModules as Record<string, unknown>).RNSARSession as
      | { isSupported?: () => Promise<boolean> }
      | undefined;
    if (mod?.isSupported == null) { setArcoreAvailable(false); return undefined; }
    let live = true;
    mod.isSupported()
      .then((ok) => { if (live) setArcoreAvailable(ok === true); })
      .catch(() => { if (live) setArcoreAvailable(false); });
    return () => { live = false; };
  }, [armContract, enabled]);

  // M8 — ON `'host-ar'` THE HOST'S AR VIEW IS THE ANSWER. `<Camera>` mounts
  // it only once its own `RNSARSession.isSupported()` said yes, and this
  // probe only starts when the engine is selected — so a hold in the first
  // commits after an engine switch would otherwise resolve the arm against
  // an unanswered probe while the AR session is already on screen.
  const arcoreAnswer = frameSource === 'host-ar' ? true : arcoreAvailable;
  const armNotice = useMemo(
    () => (armContract === 'android-sensor'
      ? panoPlusAndroidArmNotice({
          poseSource,
          liveModule: nativeReady,
          basis: basisResolution,
          arcoreAvailable: arcoreAnswer,
        })
      : vcHostArm
        ? panoPlusIosVcHostArmNotice(poseSource)
      : panoPlusArmNotice(
          poseSource, plan, calib, tauUncorrected,
          // The copy for a missing basis has to say WHERE the fix is, and since
          // 2026-09-01 that is "on this screen, now" rather than "open the
          // gear". Sent as a fact rather than assumed, so a host embedding this
          // surface without the overlay still reads the old sentence and is not
          // lying.
          basisResolution.needsGesture,
          // The lens the operator asked for, so a fallback can say what
          // happened to it. `lens` and not `effectiveLens`: the mask is
          // DERIVED from this notice's answer, so reading it back here would
          // be circular and would silence the very sentence it needs.
          lens,
        )),
    [
      armContract,
      arcoreAnswer,
      basisResolution,
      calib,
      lens,
      nativeReady,
      plan,
      poseSource,
      tauUncorrected,
      vcHostArm,
    ],
  );
  /** TRUE while this surface will actually run the uncorrected experiment.
   *  Read from `armNotice`, not from the raw prop: a fallback to ARKit is a
   *  corrected run whatever the flag says, and a chip claiming otherwise would
   *  be the same lie one layer up.
   *
   *  ⚠ THE NOTICE MAY OVERRIDE THE FLAG, IN ONE DIRECTION ONLY. On Android
   *  there is no τ at all and every IMU sweep is uncorrected whatever the
   *  operator selected, so the notice answers the question itself and the chip
   *  must follow it — a chip driven by the flag would be dark on precisely the
   *  platform where the statement is unconditionally true. `undefined` means
   *  "the flag is the owner", which is every iOS branch. */
  const runningUncorrected =
    armNotice.tauUncorrectedRun
    ?? (tauUncorrected && armNotice.effectivePoseSource === 'imu');
  /** IMU selected and the read has not landed yet. The button waits rather than
   *  offering a label it may have to take back one frame later. */
  const armPending = poseSource === 'imu' && !calibRead;

  /**
   * THE SELECTED ARM CONSUMES `C` — so this arm, and only this arm, may be
   * asked for it.
   *
   * ⚠ THE **REQUESTED** ARM, NEVER `armNotice.effectivePoseSource`, AND THE
   * DIFFERENCE IS THE WHOLE TRAP. On precisely the state this overlay exists
   * for — decoupled arm selected, no basis on file — the notice has ALREADY
   * fallen back and the effective arm reads `'ar'` (`panoPlusModel`'s
   * basis-missing rungs). Reading the effective arm here would therefore hide
   * the overlay on every device that needs it, forever, while looking like a
   * more correct expression. The fallback is a consequence of the missing
   * basis; it must not become the reason not to measure one.
   *
   * The ARKit arm's absence from this term is not a proxy for the requirement
   * either: `C` maps the CoreMotion frame onto the camera raster, and an arm
   * whose pose already arrives in the camera frame has nothing to map. That is
   * the operator's own second clause — "if it is not needed, it is not needed
   * anyway" — and it is also what keeps the default screen pixel-identical,
   * the property the arm-notice suite pins.
   */
  const armWantsBasis = poseSource === 'imu';

  /**
   * …AND THIS RUNTIME CAN ACTUALLY ACQUIRE ONE.
   *
   * ⚠ NEVER SHOW A GESTURE THAT CANNOT COMPLETE. The overlay measures against
   * `<ARCameraView>`'s pose, and `arArmed` is hard-`false` on the Android
   * contract by construction (see its own doc above: mounting a second ARCore
   * client would take the one back camera from the arm that needs it). An
   * overlay shown there would sit on `arming` behind a spinner for the life of
   * the surface, coaching nothing, with `panoCalibNative()` null underneath it
   * so even a forced start would reject `calib-unavailable`.
   *
   * Android does not reach this today — `panoPlusBasisCapability('android')`
   * derives `C` analytically, so `needsGesture` is structurally false there.
   * That is exactly why this term is written down: the no-dead-overlay rule is
   * currently an EMERGENT property of a decision made in another file, and one
   * widening of that file's ladder would turn it into a stuck screen with
   * nothing here to refuse it. Asserting it costs nothing and makes any future
   * widening safe by construction.
   */
  const armCanAcquireBasis = armContract === 'ios-coremotion';

  /**
   * SHOW THE FIRST-RUN BASIS GESTURE.
   *
   * ⚠ IT WAITS FOR THE READ (`calibRead`). Mounting on the frame before the
   * snapshot lands would ask an already-calibrated phone to perform a gesture
   * it does not need, and the overlay would then vanish a beat later — which
   * reads as a glitch and teaches the operator to distrust it.
   *
   * `needsGesture` is the ladder's whole verdict and the ONLY term that decides
   * whether a basis is genuinely required: `stored` (his iPhone, C #8 on file
   * since August) and `derived` (Android) both answer no, which is why this has
   * correctly never fired on his device rather than having been withheld.
   */
  const basisGestureVisible =
    armWantsBasis
    && armCanAcquireBasis
    // M5 — the host arm derives the basis natively; there is nothing to measure.
    && !vcHostArm
    && phase === 'idle'
    && calibRead
    && !basisAcquired
    && basisResolution.needsGesture;

  /**
   * THE WRITE SAID YES AND THE READ SAYS NO — reported, never retried.
   *
   * The one way this can happen is a key disagreement between the store's
   * `basisKey()` and the key this surface looks under, and it is not
   * hypothetical: the τ half of exactly this store shipped that bug on
   * 2026-08-31, reporting "τ saved" one line after "NOT CALIBRATED — missing
   * tau" and listing the record it had just written under `storedTauKeys`. A
   * silent retry loop would hide it behind an operator repeating a gesture; a
   * sentence puts it in a screenshot.
   */
  /**
   * ⚠ STABLE IDENTITIES, not inline arrows. The overlay's solve effect lists
   * `onAcquired` among its dependencies, and a fresh closure on every host
   * re-render would re-run that effect continuously while the gesture is live.
   * It is guarded (`solvingRef` + the phase check) so it would not misbehave —
   * but a guard that is load-bearing on every frame is a guard waiting to be
   * refactored away.
   */
  const onBasisAcquired = useCallback((): void => {
    // LATCH FIRST, then re-read. The overlay wrote through native; nothing else
    // would tell this component the basis now exists, and the arm would stay
    // fallen-back on the phone that had just been calibrated. The latch is what
    // stops a read that disagrees with the write from remounting the overlay
    // forever.
    setBasisAcquired(true);
    setCalibEpoch((n) => n + 1);
  }, []);
  const onBasisDeclined = useCallback((): void => {
    setGestureDeclined(true);
  }, []);

  const basisWriteDisagreement =
    basisAcquired && calibRead && calib?.basisIndex == null
      ? 'A basis was measured and the store accepted it, but reading it back '
        + `under ${calib?.basisKey ?? 'this device key'} still reports none. `
        + 'That is a key disagreement inside the calibration store, not a bad '
        + 'gesture — the sweep will run on ARKit and this needs reporting.'
      : null;

  // ── REPORTING UP (2026-09-01) ────────────────────────────────────────────
  //
  // Both effects live HERE, above every early return in the render below, and
  // that placement is load-bearing rather than stylistic: the unavailable /
  // no-filesystem states return early, and a hook declared past one of them
  // changes hook ORDER between renders the moment availability resolves.
  //
  // BUSY IS EVERY NON-IDLE PHASE, not just `'sweeping'`. `'starting'` has
  // already asked native to open the camera and `'finishing'` is writing the
  // pack; a mode switch in either window unmounts the surface mid-call, which
  // is the same loss the sweeping guard exists to prevent and is harder to
  // see because it is brief.
  const busy = phase !== 'idle';
  // Read by the UNMOUNT cleanup below AND by the emit effect, neither of
  // which may re-run when the host passes a fresh closure.
  //
  // ⚠ THE EFFECT USED TO DEPEND ON THE CALLBACK, and the comment beside it
  // already explained why that is wrong — it was just applied to the cleanup
  // only. `<Camera>` composes its own gate into this prop with an INLINE
  // arrow, so the identity changes on every parent render and the effect
  // re-fired each time, re-emitting the phase to a host that had not asked.
  // Harmless while the value happens to match, but it makes any host
  // handler that sets state a re-entrancy hazard: set state → parent
  // re-renders → new closure → effect fires → handler runs again. React's
  // bail-on-identical-state is the only thing that kept that from looping,
  // which is not a guarantee to rest a capture on.
  //
  // The phase is what changed or nothing did, so `busy` is the only dep.
  //
  // ⚠ M8: AND ONLY WHILE SELECTED. `<Camera>` mounts this hook on every
  // engine; an engine that is not selected reports nothing to the host. The
  // rising edge re-reports (`enabled` is a dep), and the falling edge's
  // `false` is the deselect effect's, below.
  const onSweepingChangeRef = useRef(onSweepingChange);
  onSweepingChangeRef.current = onSweepingChange;
  useEffect(() => {
    if (!enabled) return;
    onSweepingChangeRef.current?.(busy);
  }, [busy, enabled]);
  // Same ref shape, for the same reason: `painted` is what changed or nothing
  // did. `status` is null whenever no sweep is live, which reports 0.
  const onPaintedChangeRef = useRef(onPaintedChange);
  onPaintedChangeRef.current = onPaintedChange;
  const livePainted = status?.painted ?? 0;
  useEffect(() => {
    if (!enabled) return;
    onPaintedChangeRef.current?.(livePainted);
  }, [livePainted, enabled]);
  // Told on every change, INCLUDING the first resolve: the host's pill renders
  // before the precondition read lands, so without the mount-time call it would
  // show the requested arm until something else happened to change.
  //
  // ⚠ THE LATCHED ARM WINS WHILE ONE IS RUNNING. `armNotice` re-derives from
  // the live `poseSource` prop, which the capture screen's own AR pill can move
  // mid-sweep — and a pill that named the newly requested arm would be
  // describing a sweep that is not happening. The pack says what `armsRef`
  // latched; this says the same thing, so the two cannot disagree.
  // ── THE ARM THE PILL SHOWS MUST BE THE ARM THAT IS RUNNING ──────────
  //
  // `runningArm` is latched from the REQUEST at start, which was the whole
  // truth while the arm could not change. It can now: the Android recorder
  // gives the ARCore arm up mid-sweep when ARCore reports it cannot track,
  // and finishes on the IMU ring. Native says so on every status poll via
  // `poseSourceRan`; without reading it the AR pill keeps claiming "AR" for
  // the rest of a sweep ARCore is no longer feeding.
  //
  // ⚠ ONE DIRECTION ONLY, MIRRORING THE RECORDER. The degrade is one-way
  // there, so this only ever moves 'ar' -> 'imu'. Accepting a move back
  // would let a stale poll un-report a downgrade that has already happened.
  useEffect(() => {
    const ran = status?.poseSourceRan;
    if (ran !== 'imu') return;
    setRunningArm((prev) => (
      prev == null || prev.poseSource === 'imu'
        ? prev
        : { ...prev, poseSource: 'imu' }
    ));
  }, [status?.poseSourceRan]);

  const reportedArm = runningArm ?? {
    poseSource: armNotice.effectivePoseSource,
    fallbackToAr: armNotice.fallbackToAr,
  };
  // THE SAME FACT THE START BUTTON'S SPINNER READS (`armPending`), reused
  // rather than re-spelled — a second copy of "is the precondition read still
  // in flight?" is the thing that drifts. The extra `runningArm` term is what
  // keeps it false mid-sweep: a running sweep is on a settled arm whatever the
  // prop has done since.
  const armResolving = runningArm == null && armPending;
  // M8 — keyed on the VALUES, not on the callback's identity (`<Camera>` passes
  // a fresh props object on every render), and reported only while selected;
  // the rising edge re-reports, so `<Camera>`'s copy is never left cleared.
  const onEffectiveArmChangeRef = useRef(onEffectiveArmChange);
  onEffectiveArmChangeRef.current = onEffectiveArmChange;
  useEffect(() => {
    if (!enabled) return;
    onEffectiveArmChangeRef.current?.({
      poseSource: reportedArm.poseSource,
      fallbackToAr: reportedArm.fallbackToAr,
      basisRoute: basisResolution.route,
      resolving: armResolving,
      // The SAME boolean this surface gates its own two pills on, so the
      // host's copies cannot disagree with them. See the prop's doc.
      chromeSuppressed: basisGestureVisible,
    });
  }, [
    armResolving,
    reportedArm.poseSource,
    reportedArm.fallbackToAr,
    basisResolution.route,
    basisGestureVisible,
    enabled,
  ]);
  // A surface that goes away must not leave the shell believing a sweep is
  // still in flight — that would latch the mode-switch guard for the rest of
  // the session and there is no affordance to clear it.
  useEffect(
    () => () => {
      onSweepingChangeRef.current?.(false);
    },
    [],
  );

  /**
   * ⚠ WHETHER TO MOUNT `<ARCameraView>` AT ALL — the P0 this component carried
   * until 2026-08-31.
   *
   * Mounting that view IS what starts ARKit (`RNSARCameraView.didMoveToWindow`
   * → `RNSARSession.shared.start()`), and it was rendered in the single main
   * return on EVERY phase and on BOTH arms: `arReady` was a bare swap-grace
   * timer with no dependency on `poseSource`. So a sweep on the decoupled arm
   * mounted ARKit, waited 250 ms for it to take the camera, and THEN asked
   * AVFoundation for the same body. ARKit and an AVCaptureSession cannot share
   * it. The two outcomes were an unactionable `panoplus-camera-busy` — whose
   * own detail says "the router must tear ARKit DOWN before this arm starts",
   * which nothing anywhere did — or, worse, a `canAddInput` that succeeded
   * (ARKit holds the WIDE camera; this opens the ULTRA-WIDE, a different
   * `AVCaptureDevice`, and `canAddInput` tests configuration compatibility
   * rather than runtime exclusivity) and a silent zero-frame pack.
   *
   * THE HANDOFF IS NOW GENUINELY SEQUENTIAL AND IT IS REACT THAT PERFORMS IT:
   * on the IMU arm this view is never mounted, so ARKit is never started by
   * this surface; and if it was already up when the arm was selected, React
   * UNMOUNTS it here, which runs `didMoveToWindow(nil)` →
   * `RNSARSession.shared.stop()` before Start can be pressed. Native then
   * carries the belt (`tearDownArkitForDecoupledArm` + a bounded input-open
   * retry + interruption observers) for every OTHER path that may hold ARKit.
   *
   * WHILE THE PRECONDITION READ IS IN FLIGHT we mount nothing: the answer is
   * one native call away, and starting ARKit only to stop it 40 ms later would
   * cost a `arSession.run` teardown for no gain. `panoPlusArmNotice` resolves
   * every unusable IMU state to `effectivePoseSource: 'ar'`, so a fallback
   * sweep gets its AR view the moment the read lands.
   *
   * ⚠ THE LATCH WINS WHILE A SWEEP IS LIVE (2026-09-01). See `runningArm`: the
   * prop can move under a running sweep now, and re-deriving from it here is
   * exactly how a session gets stopped — or started — under one.
   */
  //
  // ⚠ ON ANDROID THIS IS ALWAYS FALSE, ON BOTH ARMS, AND THAT IS NOT A BUG.
  // `arArmed` does not mean "the sweep runs on the AR arm". It means "THIS
  // SURFACE has mounted and owns an AR session" — it gates `<ARCameraView>`,
  // it hides the AVF viewfinder, and it is what `arLive` reports. Those are
  // iOS facts: there ARKit is the SDK's to start and the pixels arrive through
  // the frame plugin.
  //
  // On Android the ARCore session belongs to `PanoPlusAndroidRecorder`, which
  // opens it in SHARED-camera mode INSIDE the sweep (`arcoreReference:
  // 'shared'`) and feeds the engine from `ArCorePoseSink`. There is exactly one
  // back camera. Mounting `<ARCameraView>` here would stand up a SECOND ARCore
  // client and take that camera from the arm that needs it — and it would also
  // unmount `RNSSweepPreviewView`, which VENDS the Surface the recorder
  // must claim before `createCaptureSession`, leaving the operator with no
  // viewfinder on the very arm he selected.
  //
  // So the Android AR arm is selected through `poseSource` in the start bag
  // (`armNotice.effectivePoseSource`, which really can be `'ar'` since
  // 2026-09-02) and never through this flag. `runningArm.poseSource` still
  // carries the truth for the host's pill; this constant is only about who owns
  // a session. iOS keeps the expression it has always had, unchanged.
  //
  // ── 2026-09-10: THE ANDROID EXCEPTION, AND WHY THE OBJECTION ABOVE NO
  //    LONGER APPLIES ──────────────────────────────────────────────────────
  //
  // Both reasons the flag was hard-`false` on Android are premised on THE
  // RECORDER RUNNING: it opens ARCore itself (so ours would be a second
  // client) and it needs the Surface `RNSSweepPreviewView` vends (so
  // unmounting it would blind the operator).
  //
  // On the AR-PLUGIN arm the recorder opens NOTHING — no Camera2 client, no
  // ARCore session, no preview Surface. The stitcher's `<ARCameraView>` owns
  // the camera and IS the viewfinder, and pano+ consumes its frames through
  // `PanoPlusArFramePlugin`. So there is exactly one ARCore client and exactly
  // one viewfinder, which is the arrangement iOS has always had and the one
  // Pano's own AR capture uses successfully in this operator's room.
  //
  // ── M2: THE AR-PLUGIN ARM IS THE ONLY ANDROID AR ARM ───────────────────
  // It used to be gated on an `arPluginArm` prop the library never sent, so
  // the library-default Android AR sweep ran on pano+'s OWN shared-camera
  // ARCore arm — a second camera owner that never painted a strip in 23
  // packs. The recorder now takes the plugin arm for EVERY live AR sweep
  // (PanoPlusStartMode.kt), so this surface mounts the stitcher's AR view
  // whenever the sweep runs on AR.
  const arArmed = armContract === 'android-sensor'
    // The same test `androidArArm` makes, inlined because that constant is
    // declared BELOW this one and reordering would move a value other effects
    // key on. `armContract` is already 'android-sensor' in this branch.
    ? (runningArm != null
      ? runningArm.poseSource !== 'imu'
      // …and only once ARCore has said it can run (M2).
      : armNotice.effectivePoseSource !== 'imu' && arcoreAnswer === true)
    : runningArm != null
      ? runningArm.poseSource !== 'imu'
      : poseSource !== 'imu'
        || (calibRead && armNotice.effectivePoseSource !== 'imu');

  /** The Android AR arm, as a SEPARATE fact from `arArmed` — see above. True
   *  when the sweep will run (or is running) on ARCore poses. */
  const androidArArm = armContract === 'android-sensor'
    && (runningArm != null
      ? runningArm.poseSource !== 'imu'
      : armNotice.effectivePoseSource !== 'imu');

  // THE UNMOUNT GUARD, ON ITS OWN. Split out of the swap-grace effect below
  // (2026-09-03) so that effect can be keyed on `arArmed` without the guard
  // being torn down and restored on every arm change — a `mountedRef` that
  // briefly reads false while the component is very much mounted would silence
  // whichever async answer happened to land in that window.
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  /**
   * THE SWAP GRACE, RE-ARMED ON EVERY SWAP — not only the first.
   *
   * ⚠ THIS USED TO BE A ONE-SHOT `[]` EFFECT AND THE MISS WAS THE 0.5× DOOR.
   * The grace exists (module doc, LIFECYCLE) because there is ONE ARKit session
   * and mounting `<ARCameraView>` IS `RNSARSession.shared.start()`: standing
   * ours up before the outgoing one has finished `stop()` races two
   * `arSession.run` calls. That was written when the only swap was BETWEEN
   * surfaces, so a timer keyed on this surface's mount covered every case.
   *
   * It does not any more. `arArmed` now moves UNDER a mounted surface — both
   * doors onto the decoupled arm dip it false and back true within a few
   * commits (tap 0.5×, or the AR pill: `poseSource` flips while `calibRead` is
   * still true, then the read lands and the arm notice falls back) — and React
   * unmounts and remounts the AR view across that dip. So the surface stopped
   * ARKit and restarted it microseconds later with the grace already spent:
   * the very race, on this surface's own session instead of a neighbour's.
   *
   * It also fixed `arLive` (`arArmed && arReady`) true on the commit the
   * restart happened, and `PanoPlusBasisOverlayProps.arLive` forbids exactly
   * that — its doc: "Starting before the session is up records a log with no
   * reference in it, which the solve then correctly refuses — an operator
   * performing a perfect gesture and being told it was not good enough."
   *
   * ⚠ WHAT THIS DOES NOT BUY, stated so it is not read as more than it is: the
   * grace is a gap BEFORE the mount, so `arLive` still goes true on the same
   * commit ARKit starts, here and on a cold first mount alike. Warm-up after
   * `start()` is covered by the overlay's own `REFERENCE_GRACE_S`, which is why
   * a reference-less first second is coached rather than blamed on the hands.
   */
  // ⚠ M2: AND ONLY ONCE THE PREVIOUS CAMERA OWNER HAS LET GO. Inside
  // `<Camera>`'s release window the surface is told `frameSource: 'host'` on
  // purpose — neither side may open a camera yet — and the AR view opening
  // there raced the host's own camera. On Android the grace is the measured
  // Camera2 release (the recorder reclaimed the camera at ~479 ms on the
  // A35; `<Camera>` settles 600 ms), not iOS's 250 ms.
  const arMayOpen = arArmed && frameSource === 'own';
  const arGraceMs = armContract === 'android-sensor'
    ? Math.max(PANO_PLUS_SWAP_GRACE_MS, 600)
    : PANO_PLUS_SWAP_GRACE_MS;
  useEffect(() => {
    // Down means down: an arm that is not armed has no session to be ready
    // for, and leaving `arReady` true there is what let the next arming
    // commit claim a live reference it did not have.
    setArReady(false);
    if (!arMayOpen) return undefined;
    const t = setTimeout(() => {
      if (mountedRef.current) setArReady(true);
    }, arGraceMs);
    return () => { clearTimeout(t); };
  }, [arMayOpen, arGraceMs]);

  // The coach mark self-fades; the component never self-times (its contract).
  useEffect(() => {
    if (phase !== 'idle') {
      setHowToVisible(false);
      return undefined;
    }
    const t = setTimeout(() => setHowToVisible(false), 6000);
    return () => clearTimeout(t);
  }, [phase]);

  // UNMOUNT TEARDOWN. Fire-and-forget `stop()` — never `cancel()`: an
  // abandoned sweep's pack is evidence, and deleting it is the one
  // irreversible thing this surface could do by accident. The native session
  // is torn down either way, which is the part that must never leak.
  //
  // ⚠️ GATED ON `sweepLiveRef`, NOT ON `phase` — see that ref's own doc for the
  // batching race that makes a phase-derived guard destroy the pack. What the
  // guard buys, case by case:
  //  · STARTING — native's `start()` is still in flight on its own global
  //    queue, so a `stop()` dispatched now can be SERVICED FIRST, reject
  //    `not-running`, take the cancel branch, and then the start lands and
  //    latches a session nobody will ever stop. The guard is still false here,
  //    and the start resolution handler owns the case instead (it checks
  //    `mountedRef` and tears down there) — exactly ONE teardown path.
  //  · FINISHING / CANCELLING — those calls clear the guard synchronously
  //    before they await, so a second `stop()` (which would reject
  //    `not-running` and then CANCEL, deleting the pack the first one just
  //    wrote) can never be issued from here.
  //  · SWEEPING — the only state that reaches the stop below, which is the
  //    whole point: an abandoned sweep must never leave the native session
  //    running, and must never lose its pack either.
  useEffect(
    () => () => {
      if (!sweepLiveRef.current) return;
      sweepLiveRef.current = false;
      void stopPanoPlus().then(
        (s) => {
          // eslint-disable-next-line no-console
          console.log(
            '[pano+] surface unmounted mid-sweep — pack finalized at',
            s.sessionDir,
          );
        },
        (e: unknown) => {
          const info = panoPlusErrorInfo(e);
          // eslint-disable-next-line no-console
          console.warn('[pano+] unmount stop failed —', info.code, info.message);
          // The ONE native path that leaves the session latched without
          // finalizing. Without this, every later start() rejects
          // `panoplus-busy` for the life of the process.
          if (info.code === 'panoplus-not-running') void cancelPanoPlus();
        },
      );
    },
    [],
  );

  // ── M8: `enabled` FALLING IS AN UNMOUNT, WITHOUT THE UNMOUNT ─────────────
  // `<Camera>` keeps this hook mounted on every engine; a host that switches
  // the engine (or turns panorama off) mid-sweep ends the sweep exactly as an
  // unmount would — STOPPED, so the pack is finalized and kept, never
  // cancelled — and the shell is told the sweep is over. Unlike an unmount the
  // hook lives on, so its own state goes back to idle as well.
  const prevEnabledRef = useRef(enabled);
  useEffect(() => {
    const was = prevEnabledRef.current;
    prevEnabledRef.current = enabled;
    if (!was || enabled) return;
    if (phaseRef.current === 'starting') {
      // The start resolves into a stop (see `stopOnStartRef`).
      stopOnStartRef.current = true;
    } else if (sweepLiveRef.current) {
      sweepLiveRef.current = false;
      liveSessionRef.current = null;
      void stopPanoPlus().then(
        (st) => {
          // eslint-disable-next-line no-console
          console.log('[pano+] sweep ended by the host (engine off) — pack finalized at', st.sessionDir);
        },
        (e: unknown) => {
          const info = panoPlusErrorInfo(e);
          if (info.code === 'panoplus-not-running') void cancelPanoPlus();
        },
      );
      setRunningArm(null);
      setCameraLock(null);
      setStatus(null);
      setPhase('idle');
    }
    onSweepingChangeRef.current?.(false);
    // Deps: the EDGE only.
  }, [enabled]);

  /**
   * ONE writer for both status channels.
   *
   * NULL IS NOT "STOPPED". The plugin returns nil while registered-but-idle,
   * and `onArFrame` is throttled independently of the frame rate — blanking
   * the HUD on a null tick would make a healthy sweep flicker between
   * "panning" and "waiting for frames".
   *
   * `seq` ORDERS THE TWO CHANNELS. Both read the same native snapshot, so a
   * poll that resolves after a newer AR frame has landed must not roll the HUD
   * (and with it the preview's cache-bust) backwards.
   */
  /**
   * ⚠ SESSION FIRST, `seq` SECOND (2026-09-07). `seq` orders TICKS WITHIN ONE
   * SWEEP and says nothing across sweeps — it restarts at 0 on every capture —
   * so it is only ever consulted after both statuses have been placed in the
   * SAME session. Scoping is what the operator's "the preview shows the
   * previous output from the next capture onwards" needed; see
   * `liveSessionRef`.
   *
   * A status this helper cannot PLACE (no `sessionDir`, no `previewPath` — a
   * binary predating both keys) is treated as the live sweep's rather than
   * discarded: refusing it would blank the HUD of such a build entirely, which
   * is a worse failure than the one being fixed, and no shipping binary on
   * either platform reaches it (see `panoPlusStatusSessionId`).
   */
  const applyStatus = useCallback((next: PanoPlusStatus | null) => {
    if (next == null) return;
    const live = liveSessionRef.current;
    // NO SWEEP THIS SURFACE OWNS. A status arriving now is a dead session's
    // last tick (ARKit's push is throttled and queued, and that view stays
    // mounted at idle) or a foreign one — either way it is not a description
    // of anything on this screen, and drawing it IS the reported defect.
    if (live == null) return;
    const nextId = panoPlusStatusSessionId(next) ?? live;
    if (nextId !== live) return;
    setStatus((prev) => {
      if (prev == null) return next;
      const prevId = panoPlusStatusSessionId(prev) ?? live;
      // The monotonic guard, kept and now scoped: both channels read the same
      // native snapshot, so a poll that resolves after a newer AR frame must
      // not roll the HUD — and with it the preview's cache-bust — backwards.
      return prevId === nextId && next.seq < prev.seq ? prev : next;
    });
  }, []);

  const handleArFrame = useCallback(
    (meta: ARFrameMeta) => {
      applyStatus(readPanoPlusStatus(meta));
    },
    [applyStatus],
  );

  /**
   * THE POLL FALLBACK — see {@link PANO_PLUS_STATUS_POLL_MS} for why a second
   * channel exists at all. Bounded (2 Hz), live only while a sweep is, and
   * cleared on unmount as well as on every phase change, so it can never
   * outlive the session it is describing.
   *
   * A `running: false` answer is DISCARDED rather than rendered: that is what
   * the bridge resolves when there is no session, and letting it through would
   * blank a live HUD on the one tick a poll raced a teardown.
   */
  useEffect(() => {
    if (phase !== 'sweeping') {
      setSweepingForMs(0);
      return undefined;
    }
    const startedAt = Date.now();
    const id = setInterval(() => {
      // The ELAPSED tick is deliberately driven from the same interval as the
      // poll, and it is why the "no status on either channel" rung can fire at
      // all: with both channels dead nothing else re-renders this component,
      // so a placeholder that depended on a status update to appear could
      // never appear in the one case it exists for.
      if (mountedRef.current) setSweepingForMs(Date.now() - startedAt);
      void getPanoPlusStatus().then((s) => {
        if (!mountedRef.current || s == null || !s.running) return;
        applyStatus(s);
      });
      // v12 — on the IMU arm this poll is not a fallback, it is the ONLY
      // channel (the ARCameraView that carries the 10 Hz push is deliberately
      // never mounted there), so it runs at the preview's own cadence instead
      // of 2 Hz. The AR arm keeps the slow poll: its push channel carries the
      // load and a second fast reader would be redundant.
      //
      // ⚠ ANDROID POLLS FAST ON BOTH ARMS (2026-09-02). The push channel is the
      // stitcher's `ARFramePlugin` SPI folding a sync map into the same
      // `plugins['sweep']` field, which is a verbatim twin of the
      // iOS one — but it is a NEWLY PORTED twin, and the failure mode of a
      // status channel that is silently not wired is a HUD that stays empty for
      // the whole sweep with nothing saying why. The poll is a bridge call
      // every 125 ms against a cached dict; paying it on the arm where it is
      // usually redundant is cheaper than a field trip spent looking at a blank
      // governor. Drop this term once the plugin's push has been seen on
      // hardware.
    }, poseSource === 'imu' || armContract === 'android-sensor'
      ? PANO_PLUS_STATUS_POLL_FAST_MS
      : PANO_PLUS_STATUS_POLL_MS);
    return () => clearInterval(id);
  }, [applyStatus, armContract, phase, poseSource]);

  /**
   * v12 — THE IDLE VIEWFINDER. While the IMU arm is armed and no sweep is
   * running, ask native to run the arm's session input-only so the viewfinder
   * shows a live feed and the operator can FRAME the first shot (the first
   * frame anchors the whole canvas). Off during the sweep — the sweep owns
   * the session and its own feed is what the layer draws — and off on
   * unmount, so leaving the screen releases the camera. Serialized with
   * start/stop on the native module's method queue, so this can never race a
   * Start into a half-configured session.
   */
  // Same fact as `armPending` below (declared later for the JSX); the idle
  // preview must not open the camera while the precondition read is still in
  // flight — the arm could resolve to the ARKit fallback, which then needs
  // the camera this session would be holding.
  //
  // ⚠ THE `calibRead` TERM IS iOS-ONLY, AND MAKING IT SO IS A BUG FIX.
  // It reserves the camera for an ARKit fallback that only the iOS contract
  // can resolve to. On Android it gated nothing — `RNSSweepCalibration` is an
  // iOS module, so the read is a `calib-unavailable` round-trip — but it still
  // DELAYED this effect on the IMU arm by one bridge call. That delay was the
  // only reason the IMU arm ever showed a viewfinder: it was long enough to
  // lose a race against the native view's mount that the AR arm won and then
  // died on (see `PanoPlusPreview.awaitSurface`). Both Android arms now take
  // the identical path at the identical moment, and the race is closed where
  // it lives instead of being papered over by an unrelated async call.
  const armPendingForIdle =
    armContract === 'ios-coremotion' && poseSource === 'imu' && !calibRead;
  const avfIdleWanted =
    enabled
    // ⚠ NEVER ON THE HOST ARM. This opens a Camera2 client of our own; the
    // host already has one on the same back camera, and the second open is
    // ERROR_CAMERA_IN_USE at mount time.
    && frameSource === 'own'
    && !arArmed
    // M2: nor for a sweep that will run on AR while ARCore is still being
    // probed (or has refused) — the Camera2 viewfinder is the IMU arm's.
    && !(armContract === 'android-sensor' && armNotice.effectivePoseSource !== 'imu')
    && !armPendingForIdle
    && available
    && phase !== 'sweeping'
    && phase !== 'starting';
  /**
   * WHY THE IDLE VIEWFINDER IS RE-ASKED FOR — and why nothing used to.
   *
   * ⚠ THE FROZEN-FRAME INCIDENT, 2026-09-03. The effect below is the ONLY
   * caller of `setPanoPlusIdlePreview(true)` and its deps are `[avfIdleWanted,
   * lens]`, neither of which can change when NATIVE loses the camera. Anything
   * that takes the camera away — HOME, another app opening it, the Activity
   * pausing — therefore ended the feed for good. And a `TextureView` keeps its
   * last frame after the producer goes away, so the screen did not go black:
   * it showed a full, sharp, STALE picture. Measured on the operator's A35:
   * `Active Camera Clients: []` with three screenshots two seconds apart
   * byte-identical (md5 a92b035f…), and no notice anywhere on screen. He would
   * have framed a bay against a picture of wherever he stood minutes ago.
   *
   * This counter is bumped by the two things that can make the answer change —
   * the app coming back to the foreground, and the heartbeat below noticing
   * that native's viewfinder went away — and it re-runs the effect, which
   * re-asks. It is deliberately NOT a timer: a re-ask on a loop would reopen a
   * camera the operator's other app is deliberately using.
   */
  const [idleRearm, setIdleRearm] = useState(0);
  useEffect(() => {
    if (!avfIdleWanted) return undefined;
    const sub = AppState.addEventListener('change', (next) => {
      // 'active' only. 'background'/'inactive' are handled where the camera is
      // — `PanoPlusAndroidRecorder.onHostPause` releases it — because a JS
      // listener is not a guarantee the Activity's own callback already is.
      if (next === 'active' && mountedRef.current) setIdleRearm((n) => n + 1);
    });
    return () => sub.remove();
  }, [avfIdleWanted]);

  /**
   * THE IDLE HEARTBEAT — the fact channel the notice never had.
   *
   * Native already KNOWS the feed died: `PanoPlusIdlePreviewSession`'s
   * `onDisconnected`/`onError` call `PanoPlusPreview.setAttached(false, why)`
   * and `getStatus` publishes it as `viewfinderAttached`/`viewfinderNote`. The
   * surface simply never read it at idle — the status poll above is gated on
   * `phase === 'sweeping'` — so `idleFeedLive` kept the stale `true` from the
   * last resolve and `panoPlusCameraOffNotice` correctly returned null for the
   * facts it was given. The notice module was honest; it was uninformed.
   *
   * 1 Hz against a cached native snapshot, and only while an idle feed is
   * BELIEVED to be up: the moment it is known to be down this effect stops, so
   * there is no poll running behind an explainer.
   *
   * ⚠ ANDROID ONLY. `viewfinderAttached` is hard-false on iOS and on every
   * binary that predates the key, so reading it elsewhere would report a dead
   * feed on a live AVCaptureSession.
   */
  /**
   * RE-ASK AFTER A REFUSED OPEN — the handoff, not a loop.
   *
   * ⚠ THE HEARTBEAT BELOW CANNOT DO THIS. It is Android-only and gated on
   * `idleFeedLive`, so it recovers a feed that WAS live and went away; a feed
   * that never came up is outside it entirely. Turning AR off asks for the
   * AVF session the instant `arArmed` drops, ARKit has not finished releasing
   * the camera, native refuses — and on iOS nothing asked again, so "No live
   * camera feed — ARKit is running" stayed up until some unrelated dep moved.
   *
   * Bounded on purpose (see `PANO_PLUS_IDLE_REOPEN_TRIES`): a handoff is a
   * transient, and an unbounded retry would fight another app that is
   * deliberately holding the camera.
   */
  const [handoffBudget, setHandoffBudget] = useState(0);
  const prevArArmedRef = useRef(arArmed);
  useEffect(() => {
    const fell = prevArArmedRef.current && !arArmed;
    prevArArmedRef.current = arArmed;
    // ⚠ ONLY THE FALLING EDGE GRANTS A RETRY BUDGET, and that is the whole
    // difference between this and a retry loop. A refusal with no ARKit
    // teardown behind it is another app holding the camera, and the policy
    // next door is explicit that re-asking there "would fight the other app
    // the operator deliberately opened". The budget is granted by OUR OWN
    // teardown and by nothing else.
    if (fell) setHandoffBudget(PANO_PLUS_IDLE_REOPEN_TRIES);
  }, [arArmed]);
  useEffect(() => {
    if (idleFeedLive || !avfIdleWanted) {
      if (handoffBudget !== 0) setHandoffBudget(0);
      return undefined;
    }
    if (handoffBudget <= 0) return undefined;
    const t = setTimeout(() => {
      if (!mountedRef.current) return;
      setHandoffBudget((n) => n - 1);
      setIdleRearm((n) => n + 1);
    }, PANO_PLUS_IDLE_REOPEN_MS);
    return () => { clearTimeout(t); };
  }, [avfIdleWanted, idleFeedLive, handoffBudget]);

  useEffect(() => {
    if (armContract !== 'android-sensor') return undefined;
    // `idleFeedLive` is native's own `on: true`, which it only answers with a
    // claimed surface — so it already implies the viewfinder view is mounted,
    // and reading `AvfViewfinder` here would be a TDZ reference (it is declared
    // with the JSX, hundreds of lines below).
    if (!avfIdleWanted || !idleFeedLive) return undefined;
    const id = setInterval(() => {
      void getPanoPlusStatus().then((s) => {
        if (!mountedRef.current || s == null) return;
        if (s.viewfinderAttached) return;
        // The feed is gone. Say so FIRST — the operator must stop trusting
        // those pixels this tick, not after a re-open round-trip — then ask
        // for it back exactly once.
        setIdleFeedLive(false);
        setIdleReason(
          s.viewfinderNote.trim() !== ''
            ? s.viewfinderNote
            : 'the camera was taken by something else and the picture on screen '
              + 'is the last frame before that happened.',
        );
        setIdleRearm((n) => n + 1);
      });
    }, PANO_PLUS_IDLE_HEARTBEAT_MS);
    return () => clearInterval(id);
  }, [armContract, avfIdleWanted, idleFeedLive]);

  useEffect(() => {
    if (!avfIdleWanted) {
      setIdleFeedLive(false);
      // The session this described is gone; a rate report about it would
      // outlive its own camera.
      setIdlePin({ applied: null, range: null, note: '', subject: 'rate' });
      return undefined;
    }
    let live = true;
    // ⚠ BOTH THE ARM AND THE LENS TRAVEL WITH THE REQUEST, because the idle
    // viewfinder's ONE job is to frame what the sweep will record, and each
    // half can put it on a different camera.
    //
    //   `poseSource` — ARCore's shared-camera CameraConfig outranks the
    //   recorder's own rule, so an idle session that does not know the arm
    //   opens the ultra-wide (96.2°) to frame a sweep recorded through the wide
    //   (69.7°): measured on the A35, 1.60× tighter, from the identical pose.
    //   `armNotice.effectivePoseSource` is the SAME value `start` sends, so the
    //   framing and the capture cannot disagree about the arm.
    //
    //   `lens` — the chip's request, HONOURED on the decoupled arm since
    //   2026-09-03 by the same `pickCameraForLens` the recorder runs over the
    //   same camera enumeration (`PanoPlusIdlePreview.kt:697-700`,
    //   `PanoPlusLens.kt:154`), which is what makes a flip of Pano's switcher
    //   re-open this viewfinder on the camera the next sweep will open — 1× =
    //   the wide-band back camera, 0.5× = the ultra-wide. (It said here, until
    //   that landed, that `lens` did nothing on Android; it does now, and the
    //   sentence outliving the wiring is the class of comment this file keeps
    //   citing line numbers to avoid.) On the AR arm it is ignored — ARCore
    //   chooses — and the refusal is spoken rather than silent: native's reason
    //   string names the ignored request, and `res.reason` is what the
    //   explainer prints.
    //
    // A CHANGE OF EITHER RE-RUNS THIS EFFECT (both are deps), and React runs
    // the cleanup first — so the CLOSE is asked for before the OPEN, in that
    // order on the module's queue. That is the whole of the "one viewfinder
    // changes lens" behaviour on this side; whether the old camera is fully
    // released before the new one opens is native's serialization to keep, and
    // a refused open comes back as `on: false` with its reason rather than as
    // a black rectangle.
    void setPanoPlusIdlePreview(true, {
      lens,
      poseSource: armNotice.effectivePoseSource,
      // ⚠ THE RATE TRAVELS WITH THEM, AND FOR THE IDENTICAL REASON. The arm
      // and the lens decide WHICH camera frames the shot; this decides how
      // that camera is CLOCKED, and an unpinned viewfinder is the same class
      // of lie as an unpinned lens: `PanoPlusIdlePreviewSession` otherwise
      // inherits TEMPLATE_PREVIEW's HAL-default CONTROL_AE_TARGET_FPS_RANGE,
      // which is VARIABLE on most bodies, so AE lengthens the exposure in a
      // dim aisle and the operator frames through a viewfinder that dims and
      // stutters where the pinned sweep will not
      // (`PanoPlusAndroidRecorder.kt:3276` pins the sweep's).
      //
      // ⚠ THE HOST'S ANSWER, NOT A LITERAL. This was a hardcoded `true` until
      // 2026-09-08, which contradicted the four Kotlin comments saying the
      // default is the operator's to flip after he has seen both pictures
      // (`PanoPlusLiveModule.kt:974-985`, `PanoPlusIdlePreview.kt:94`,
      // `:301-313`, `PanoPlusAndroidRecorder.kt:961-964`) — the only host that
      // exists always overrode the knob, so the second picture was
      // unreachable. Native's default stays FALSE
      // (`PanoPlusLiveModule.kt:985`) so a host that never asks gets
      // byte-identical behaviour to what shipped; the prop's default is TRUE
      // so what THIS surface ships is byte-identical to what it shipped
      // yesterday. The cost is named rather than hidden: a pinned 60 means
      // shorter exposures, so this preview is DARKER in a dim aisle than the
      // free-running one — and that is the honest picture, because it is what
      // the sweep records. See `pinPreviewFps` and `panoPlusPinPreviewFps`.
      //
      // Inert on iOS: `PanoPlusBridge.setIdlePreview` forwards this bag to
      // `RNISPanoAvfSource.startIdlePreview`, which reads `lens` and nothing
      // else. It applies the sweep's own format and rate from its plan — under
      // ONE `lockForConfiguration()`, whose `catch` is NOT fatal
      // (`RNISPanoAvfSource.swift:380-392`): on a throw the feed still comes
      // up and native reports the mismatch as `previewFormatApplied: false`,
      // which is what `idlePin` carries below.
      pinPreviewFps,
    attitudeMagFree,
    }).then((res) => {
      // REVIEW FIX — the resolved answer is kept, not discarded: a refused
      // open (ARKit up, camera busy, older native) re-shows the explainer
      // instead of leaving a silent black screen behind a dead viewfinder.
      // The REASON is kept too, so the explainer can report the refusal
      // rather than guess at it from the arm.
      if (live && mountedRef.current) {
        setIdleFeedLive(res.on);
        // ⚠ CLEARED ON SUCCESS, NOT JUST OVERWRITTEN. Native's success reason
        // is a sentence about a LIVE feed ("idle viewfinder LIVE on camera 2
        // at 1440x1080"), and the explainer's job is to report a DEAD one. A
        // re-open — the cleanup sets `idleFeedLive` false a tick before the
        // next answer lands — would otherwise render that success sentence
        // under "No live camera feed —" for the width of one round-trip.
        setIdleReason(res.on ? '' : res.reason);
        // NOT CLEARED ON SUCCESS, unlike `idleReason`. This report's whole
        // subject is a viewfinder that IS live — clearing it on `on: true`
        // would delete the only case it exists for. `applied: null` on a
        // build that does not report the pin, which prints nothing.
        //
        // ⚠ BOTH PLATFORMS' FLAGS, BECAUSE IT IS ONE FAULT UNDER TWO NAMES.
        // Android reports the RATE (`previewFpsApplied`); iOS pins format and
        // rate under one device lock and reports the pair as
        // `previewFormatApplied` (`RNISPanoAvfSource.swift:383-389`, `:407`).
        // Exactly one of the two is ever non-null on a given binary, so the
        // `??` is a choice between an answer and a silence, never between two
        // answers. `subject` then picks the honest noun for the headline.
        //
        // This mattered because the iOS half was SILENT ON SCREEN: native
        // writes its own sentence into `reason`, and the line above clears
        // `reason` on `on: true` — which is exactly the state a declined lock
        // leaves. Note is left EMPTY on that branch rather than replaying
        // native's success-shaped sentence ("idle viewfinder LIVE on …"),
        // which would read as a contradiction under the headline; the notice
        // supplies its own words for the framing subject.
        const iosFormat = res.previewFormatApplied;
        setIdlePin({
          applied: res.previewFpsApplied ?? iosFormat,
          range: res.previewFpsRange,
          note: res.previewFpsNote,
          subject: res.previewFpsApplied == null && iosFormat != null
            ? 'framing'
            : 'rate',
        });
      }
    });
    return () => {
      live = false;
      setIdleFeedLive(false);
      setIdlePin({ applied: null, range: null, note: '', subject: 'rate' });
      // Not cleared: the panel re-reads it on the next open, and blanking it
      // here would make a fast re-render lose the only sentence explaining a
      // feed that never came up.
      void setPanoPlusIdlePreview(false, {});
    };
    // `idleRearm` is a DEP AND NOT A READ — it exists only to re-run this
    // effect, which is the whole re-open mechanism. See its declaration.
    // `pinPreviewFps` IS A DEP for the same reason `lens` is: it changes what
    // native is asked to open, so a gear flip must close the current request
    // and re-open on the new one rather than leave a stale viewfinder claiming
    // the operator's new choice.
  }, [
    avfIdleWanted, lens, armNotice.effectivePoseSource, idleRearm,
    pinPreviewFps,
  ]);

  /** `finish`, reachable from inside `start`'s own resolution handler — see
   *  `stopOnStartRef`. A ref rather than a dependency because `finish` is
   *  declared after `start` and the two would otherwise be a cycle. */
  const finishRef = useRef<() => void>(() => undefined);

  const start = useCallback(() => {
    if (!enabledRef.current) return;   // M8 — a hook not selected starts nothing
    if (busyRef.current || !available || documentDirectory == null) return;
    busyRef.current = true;
    stopOnStartRef.current = false;
    abandonOnStartRef.current = null;
    setError(null);
    const { dirPath } = panoPlusSessionPaths(
      documentDirectory,
      newPanoPlusSessionId(),
    );
    // The arm we are ASKING for. `armsRef` is corrected to what native
    // ANSWERS the moment start resolves, a few lines below.
    const wantPoseSource = armNotice.effectivePoseSource;

    // ── FAIL CLOSED WHEN THE HOST OWNS THE CAMERA AND WE CANNOT USE IT ──
    //
    // `frameSource === 'host'` means the embedding `<Camera>` has mounted
    // vision-camera on the back camera and this surface has NO viewfinder
    // and NO session. The recorder must therefore open nothing, and the
    // only thing that tells it so is `vcPluginArm` — which is sent below
    // ONLY on the IMU arm, because the recorder reads the two together.
    //
    // So a host arm whose EFFECTIVE pose source is not `'imu'` is a state
    // with no correct action.
    //
    // ⚠ AND `<Camera>` CANNOT REACH IT ANY MORE — which is the point, not an
    // argument for deleting this. Since M3 `sweepHostOwnsCamera` is
    // `!isAR && <platform arm> && no DR-1a override`, and the pose arm it
    // sends is `isAR ? 'ar' : 'imu'` from the SAME state, so a host-owned
    // sweep is always an IMU sweep. This is what happens if that is ever
    // relaxed.
    //
    // It also covers the case `<Camera>` is not: `PanoPlusCaptureSurface` is
    // an exported component and a third-party host can set `frameSource` and
    // `poseSource` inconsistently with no `<Camera>` in between.
    //
    // Starting anyway opens a second Camera2 / AVCapture client against a
    // device vision-camera already holds. On Android that is
    // ERROR_CAMERA_IN_USE; on iOS `canAddInput` tests configuration
    // compatibility rather than runtime exclusivity, so it SUCCEEDS and one
    // of the two sessions is interrupted moments later — a dead preview
    // with no error anywhere. A named refusal is strictly better than
    // either, and unlike both it is visible.
    //
    // ⚠ THE CONDITION IS "WILL THE ARM ACTUALLY BE SENT", not one named
    // cause. It used to test `wantPoseSource !== 'imu'` alone, which is one
    // of THREE things that drop the arm from the bag below — the others are
    // an absent plugin handle and an empty camera id, and a fourth arrives
    // with `<Camera>`'s ownership settle window, in which the surface is
    // told `'host'` on purpose while neither side may open a camera yet.
    // Every one of them lands in the same place: no viewfinder here and no
    // instruction to native — which native now refuses by name
    // (`live-sweep-without-camera`, the M3 backstop) rather than opening its
    // own client, but a refusal from there says less than one from here. So
    // the guard is derived from the same expression the bag uses, and the
    // two cannot drift.
    // ⚠ M3: A NAMED REFUSAL FROM THE HOST COMES FIRST. `<Camera>` knows WHY
    // its camera cannot serve this hold (plugin missing or loading, a zoom-
    // only 0.5× lens, a drawable host processor, the camera still opening);
    // saying so beats every generic message below, and it reaches the host
    // on `onFailure` as well as the screen.
    if (hostArmRefusal != null) {
      busyRef.current = false;
      setError(hostArmRefusal.message);
      onFailure?.({
        code: hostArmRefusal.code,
        message: hostArmRefusal.message,
        sessionDir: null,
        counts: null,
        abort: null,
      } as PanoPlusFailure);
      return;
    }
    const willSendArm = vcPluginArm === true
      && typeof vcCameraId === 'string'
      && vcCameraId.length > 0
      && wantPoseSource === 'imu';
    // ⚠ M8 — THE HOST'S AR SESSION IS THE CAMERA, SO ONLY THE AR ARM MAY RUN.
    // `<Camera>` sends the pose arm from the same `isAR` that mounted its AR
    // view, so this is unreachable from `<Camera>`; it is what a host that
    // says `'host-ar'` and asks for IMU gets instead of a second camera.
    if (frameSource === 'host-ar' && wantPoseSource !== 'ar') {
      busyRef.current = false;
      const message = 'This sweep cannot start: the camera on screen is the AR '
        + 'session, and the sweep resolved to the non-AR arm, which needs the '
        + 'non-AR camera. Turn AR back on, or turn it off on the screen.';
      setError(message);
      onFailure?.({
        code: 'panoplus-refused-wrong-arm',
        message,
        sessionDir: null,
        counts: null,
        abort: null,
      } as PanoPlusFailure);
      return;
    }
    if (frameSource === 'host' && !willSendArm) {
      busyRef.current = false;
      // ⚠ THE COPY IS SELECTED BY THE SAME SHAPE THE CONDITION USES. The
      // guard was widened to `!willSendArm` while the message stayed keyed
      // on `wantPoseSource !== 'imu'` alone — two independent questions, so
      // a handoff refusal on the AR arm told the operator to turn off the
      // AR they had just turned on, for a state that clears itself in
      // 600 ms. Only a host that HAS armed us and still resolved to AR is
      // the genuine "wrong arm" case; everything else is transient.
      const wrongArm = vcPluginArm === true && wantPoseSource !== 'imu';
      setError(
        wrongArm
          ? 'This sweep cannot start: the camera belongs to the host preview '
            + 'on this screen, and the sweep resolved to the AR arm, which '
            + 'needs a camera of its own. Turn AR off for the sweep, or '
            + 'switch back to the 1× lens.'
          : 'This sweep cannot start yet: the camera is still being handed '
            + 'over to this screen. Try again in a moment.',
      );
      return;
    }
    armsRef.current = {
      rectify, gainMatch, packFrames, poseSource: wantPoseSource,
    };
    // THE RENDER-VISIBLE TWIN OF THE LINE ABOVE, set in the same breath so the
    // two can never latch different answers. From here until the phase returns
    // to idle, `arArmed` and the arm reported to the host both read THIS —
    // never the `poseSource` prop, which the capture screen's AR pill can move
    // under a live sweep.
    setRunningArm({
      poseSource: wantPoseSource,
      fallbackToAr: armNotice.fallbackToAr,
    });
    setPhase('starting');
    setCameraLock(null);
    // A new sweep restarts `seq` at 0, and `applyStatus` refuses to go
    // backwards — so a status left over from a previous sweep (a failed start,
    // an aborted one) would swallow every frame of this one.
    //
    // ⚠ CLEARING IS NOT ENOUGH ON ITS OWN, which is the 2026-09-07 lesson: the
    // ARKit push channel can deliver a tick from the FINISHED sweep after this
    // line has run, re-latching it at a `seq` this sweep will take hundreds of
    // frames to overtake. So the panel is CLAIMED as well as cleared, and the
    // claim is what `applyStatus` measures every later tick against. Written
    // here, synchronously, before the bridge call: the window between the two
    // is exactly the window the straggler arrives in.
    setStatus(null);
    liveSessionRef.current = panoPlusSessionIdOf(dirPath);
    // ── THE BAG, BUILT BEFORE IT IS SENT ──────────────────────────────────
    // Named rather than inlined so `tauUncorrected` can be settled AFTER every
    // spread — see the block below the literal. A conditional spread cannot
    // DELETE a key an escape hatch already put there, and that asymmetry is
    // exactly the hole this closes.
    const startOptions: PanoPlusStartOptions = {
      // ── THE PLATFORM'S OWN MEMORY BUDGET ──────────────────────────────────
      // FIRST in the literal, so `engineOptions` and `packOptions` both still
      // win: these are defaults chosen for the platform, never a policy the
      // host cannot measure against.
      //
      // Empty object on iOS — byte-for-byte the bag that shipped. On Android it
      // caps the live preview JPEG (Fresco keys its bitmap cache by the FULL
      // uri, and this preview is cache-busted `?v=<seq>` on every publish, so
      // each tick is a NEW retained entry rather than a replacement) and caps
      // the canvas growth (the process has been measured at 733 MB RSS idle and
      // 1.33 GB peak on this phone, and an 18e6-px canvas costs ~72 MB steady
      // with a ~126 MB transient while it grows). The numbers and the evidence
      // behind each are in `panoPlusAndroidArm.ts`; the canvas cap is a REFUSAL
      // that reports itself (`canvas-full` + clipping in the pack), never a
      // silent crop.
      ...panoPlusArmSessionDefaults(armContract),
      // ── THE FRONTIER WINDOW'S ONE NUMBER ──────────────────────────────────
      // Sent FIRST, so `packOptions` can still override it: this is a default
      // derived from the chrome, not a policy.
      //
      // It is a RATIO, not a pixel count, because the canvas is not sized
      // until the axis latches and the options go out before the first frame —
      // but the KNEE is knowable now. Past `along / cross = this`, fitting the
      // whole panorama into the panel stops gaining on-screen size and starts
      // losing it without bound: measured on a 390x844 portrait-locked window,
      // 3.9 m of shelf draws a 114x374 pt sliver at 7.1 source px per device
      // px and 5.8 m draws 76x374 pt at 10.7. Below the knee the window is
      // longer than the panorama and native's path is byte-identical to the
      // whole-canvas one — which is every sweep the operator has recorded so
      // far, so nothing he has already seen changes.
      previewWindowCrossMult: panoPlusPreviewWindowMultiple(
        {
          // The same measured box the layout below uses, so the knee that
          // native sizes the preview against and the panel that displays
          // it are derived from ONE usable area.
          //
          // No `jsLandscape` here, deliberately: this function does not read
          // it (it `void`s `orientation` too — the knee is a pure shape
          // question). Passing it would be an inert field that reads as a
          // wire, which is the failure this subspec keeps naming.
          width: box.width,
          height: box.height,
          insets: withHostChromeTop(safeAreaInsets, hostChromeTopPt),
          // The same reservation the layout is given below, so the knee and
          // the panel are derived from ONE usable box.
          bottomChromePt: panoBottomChromePt(
            safeAreaInsets?.bottom ?? 0,
            bottomBarOffset,
            hideBuiltInControls,
          ),
        },
        orientation,
      ),
      ...engineOptions,
      ...packOptions,
      // The three arms are applied AFTER the escape hatches so a host cannot
      // silently disagree with its own pills.
      sessionDir: barePath(dirPath),
      // THE HOLD, MEASURED AND RECORDED. After the escape hatches, because it
      // is a FACT about this sweep and not a knob: the accelerometer said so,
      // and a host overriding it would be recording a lie into the pack.
      //
      // Sampled at the moment Start is pressed, which is the hold the sweep
      // begins in. It is written to `meta.json` and read by nothing, so the
      // next pack can be checked against the coach arrow and the preview
      // panel instead of having its orientation DERIVED from `referenceQuat`.
      hold: panoPlusHoldOf(orientation),
      // v14 — THE UPRIGHT BAKE, from the SAME sampled orientation as `hold`
      // one line up, and for the same reason: it is a measured fact about this
      // sweep, not a knob, so it sits after the escape hatches where a host
      // cannot overwrite it with a lie.
      //
      // The FULL `orientation`, not `hold`: `panoPlusHoldOf` collapses
      // landscape-left and landscape-right into one name and those two need
      // bakes a half turn apart. This is the one place that distinction is
      // load-bearing, which is why the pack records both.
      outputRotationCwDeg: panoPlusUprightRotationDeg(orientation),
      rectify,
      gainMatch,
      packFrames,
      // v6 — a SWEEP-LEVEL arm, not an engine knob: it changes what the camera
      // does, not what the engine computes, so it sits beside the other three.
      lockCamera,
      // A SWEEP-LEVEL ARM like lockCamera: it changes which SENSOR the camera
      // path feeds the engine, not what the engine computes. Sent only when the
      // host actually set it, so an unset prop leaves the native default alone.
      ...(attitudeMagFree != null ? { attitudeMagFree } : {}),
      // The camera arm (`vcPluginArm` / `vcCameraId` / `vcViewTag` /
      // `allowOwnCamera`) is ASSIGNED below the literal — see there.
      ...(meteringSettleMs != null ? { meteringSettleMs } : {}),
      // WHICH PRODUCER. Sent last, with the other sweep-level arms, and it is
      // `armNotice.effectivePoseSource` rather than the raw prop: when the IMU
      // arm was selected but its precondition is unmet, the button said
      // "Sweep on ARKit instead" and this is the half that makes the button
      // honest. The downgrade is announced, chosen, and recorded — never
      // silent.
      poseSource: wantPoseSource,
      // The acceleration cage, sent ONLY when the sweep is actually going to
      // run on the decoupled arm and only when a host asked for one. Native
      // reads 0 as "not configured" and counts every frame as such, so an
      // absent key is an UNCAGED sweep that SAYS SO in the pack — never a cage
      // silently set to zero.
      ...(wantPoseSource === 'imu' && lurchAccelMps2 != null
        ? { lurchAccelMps2 }
        : {}),
    };
    // ── THE τ = 0 EXPERIMENT — ONE OWNER, SETTLED AFTER THE SPREADS ────────
    //
    // Sent ONLY when the sweep is actually going to run on the decoupled arm:
    // on an ARKit fallback there is no τ in the path at all and the key would
    // be a claim about a sweep that never happened. Native reads its ABSENCE as
    // an ordinary sweep, so a `false` is never sent — the flag is a
    // DECLARATION, and a declaration nobody made should not appear in the pack.
    //
    // ⚠ ASSIGNED-OR-DELETED, not conditionally spread, and the difference is
    // the whole point. `tauUncorrected` is a legal `PanoPlusStartOptions` key,
    // so a host could put it in `engineOptions` — which is spread ABOVE — and a
    // conditional spread can only ever ADD. That host would have run an
    // uncorrected sweep behind chrome that says CALIBRATED: no purple chip, no
    // amber headline, an ordinary `Start sweep` button. The pack would have
    // been honest and the screen would not, and this surface's job is that they
    // agree. `poseSource` is immune only because it is ASSIGNED after the
    // spreads; this now is too.
    // ── THE CAMERA ARM — ASSIGNED, NOT SPREAD (M3 review) ──────────────────
    // `vcPluginArm` / `vcCameraId` / `vcViewTag` / `allowOwnCamera` are typed
    // `PanoPlusStartOptions` keys, assigned after the escape-hatch spreads so
    // tsc checks their spelling and a host key cannot override ownership:
    //   · the host arm (`frameSource === 'host'`) sends the plugin arm — the
    //     SAME `willSendArm` the guard at the top of `start` tested, so the
    //     guard and the bag cannot drift;
    //   · only a surface that OWNS its camera (`frameSource: 'own'` — a
    //     standalone mount, or `<Camera>`'s DR-1a reference hatch) sends
    //     `allowOwnCamera`; a host-camera sweep that somehow lost its arm is
    //     then refused natively (`live-sweep-without-camera`) rather than
    //     opening a second camera.
    delete startOptions.vcPluginArm;
    delete startOptions.vcCameraId;
    delete startOptions.vcViewTag;
    delete startOptions.allowOwnCamera;
    if (willSendArm && frameSource === 'host') {
      startOptions.vcPluginArm = true;
      startOptions.vcCameraId = vcCameraId;
      if (vcViewTag != null) startOptions.vcViewTag = vcViewTag;
    }
    if (frameSource === 'own') startOptions.allowOwnCamera = true;
    // M5 — the iOS host arm runs τ = 0 by default (D2); sent so the bag, the
    // chip and the pack all state it, rather than leaving native to default.
    if (wantPoseSource === 'imu' && (tauUncorrected || vcHostArm)) {
      startOptions.tauUncorrected = true;
    } else {
      delete startOptions.tauUncorrected;
    }
    // P5 — the lens, same ownership rule: assigned on the decoupled arm,
    // deleted everywhere else (the AR arm cannot honour it, and a stale host
    // key must not ride the pack as a claim about a lens nothing chose).
    if (wantPoseSource === 'imu') {
      startOptions.lens = lens;
    } else {
      delete startOptions.lens;
    }
    // v13 — same ownership rule for the guard: the PROP is the one owner,
    // over anything a host put in engineOptions, in both directions.
    if (jogGuard) {
      startOptions.d8JogGuard = true;
    } else {
      delete startOptions.d8JogGuard;
    }
    // 2026-09-01 — THE SECOND ATTITUDE CHANNEL, on the SAME ownership rule and
    // gated on the arm that can actually produce the comparison.
    //
    // ⚠ THE ARM CHECK IS `wantPoseSource`, NOT THE RAW `poseSource` PROP. When
    // the IMU arm is selected but its precondition is unmet the button offers
    // an ARKit sweep instead, and that downgraded sweep is exactly one this
    // instrument CAN record — reading the prop would have refused the sidecar
    // on the very sweep it applies to. It is the mirror of the two keys above:
    // `lens` and `tauUncorrected` are decoupled-arm-only and deleted here, this
    // one is ARKit-arm-only and deleted there.
    //
    // Assigned-or-deleted rather than conditionally spread, for the reason the
    // `tauUncorrected` block states: `imuSidecar` is a legal
    // `PanoPlusStartOptions` key, so a host could put it in `engineOptions` —
    // which is spread ABOVE — and a conditional spread can only ever ADD. That
    // host would have armed a second CoreMotion plugin on an arm where native
    // refuses it, and the pack would carry a refusal nobody asked for.
    //
    // ⚠ AND IT IS AN iOS-CONTRACT KEY (2026-09-02). The instrument is a second
    // CoreMotion plugin registered on the ARKit delegate thread; Android's AR
    // arm is ARCore and its IMU is a SensorManager listener, so there is no
    // implementation for this key to reach. The field build ships
    // `panoPlusImuSidecar: true`, so without this term every Android AR sweep
    // would send a declaration nothing on that platform honours — and if the
    // module ever echoed its resolved options into `meta.json` the pack would
    // claim a same-pixels pose-arm comparison that does not exist in it. An
    // Android equivalent is buildable (TYPE_ROTATION_VECTOR beside ARCore's
    // pose) and is not in this pass; when it lands, widen this condition rather
    // than removing it.
    if (wantPoseSource === 'ar' && imuSidecar && armContract !== 'android-sensor') {
      startOptions.imuSidecar = true;
    } else {
      delete startOptions.imuSidecar;
    }
    void startPanoPlus(startOptions).then(
      (started) => {
        busyRef.current = false;
        // ⚠ M5 — FAIL CLOSED ON AN ABSENT ECHO. On the iOS host arm native
        // must SAY it ran on vision-camera's camera. A binary that did not is
        // one that ignored `vcPluginArm` and opened its own AVCaptureSession
        // behind the preview — stopped at once and refused by name, never
        // left running as a second camera.
        // ⚠ M8 — AND ON THE HOST'S AR SESSION, NATIVE MUST HAVE RUN THE AR ARM.
        // Any other arm under `'host-ar'` is one that opened a camera of its
        // own behind `<Camera>`'s AR view.
        const wrongHostArm = frameSource === 'host-ar'
          && started.poseSource != null && started.poseSource !== 'ar';
        if ((vcHostArm && started.frameSource !== 'vc-plugin') || wrongHostArm) {
          void cancelPanoPlus().catch(() => undefined);
          stopOnStartRef.current = false;
          abandonOnStartRef.current = null;
          if (!mountedRef.current) return;
          setRunningArm(null);
          setPhase('idle');
          setCameraLock(null);
          liveSessionRef.current = null;
          const info = {
            code: 'panoplus-vc-arm-unavailable',
            message: 'native did not confirm the sweep ran on the camera on screen '
              + `(frameSource: ${String(started.frameSource ?? 'absent')}, `
              + `poseSource: ${String(started.poseSource ?? 'absent')}); it was `
              + 'cancelled rather than left running on a camera of its own.',
            sessionDir: null,
            counts: null,
            abort: null,
          } as PanoPlusFailure;
          setError(panoPlusFailureCopy(info));
          onFailure?.(info);
          return;
        }
        // THE ARM NATIVE REPORTED, over the one we asked for. Native answers
        // `poseSource` on BOTH branches; if a build ever answers neither, the
        // requested value stands and the pack's own `pose_source.json` remains
        // the arbiter. Written synchronously, before any state, so a result
        // assembled during this same commit cannot read the stale value.
        if (started.poseSource != null) {
          armsRef.current = {
            ...armsRef.current, poseSource: started.poseSource,
          };
        }
        // THE SESSION NATIVE ANSWERED, over the one we asked for — the same
        // correction as the arm one line up, and for the same reason. iOS
        // echoes the directory verbatim, but Android's live module answers
        // `optStr(m, "packDir", sessionDir)` and may hand back its own; the
        // statuses will carry THAT, so the panel must be scoped to it or every
        // tick of this sweep would fail the session test and the screen would
        // stay empty for the whole capture. Only while we still hold the claim
        // (a start that resolved after a teardown owns nothing).
        if (mountedRef.current && liveSessionRef.current != null) {
          const answered = panoPlusSessionIdOf(started.sessionDir);
          if (answered != null) liveSessionRef.current = answered;
        }
        // v6 — the lock report is CONSUMED, not discarded. Set before the
        // unmount check so the state write is unconditional in the mounted
        // case and skipped entirely in the unmounted one.
        if (mountedRef.current) setCameraLock(started.cameraLock ?? null);
        // ── THE ARM NOTICE, INTO THE PACK ────────────────────────────────
        // Written here rather than before the call because the session dir
        // is NATIVE'S to create; writing first would either race it or make
        // this layer a second owner of `mkdir -p`. `started.sessionDir` is
        // the directory native actually used, not the one we asked for, so a
        // build that ever relocates the pack still gets its sidecar.
        //
        // ⚠ BEFORE THE `mountedRef` EARLY-RETURN, deliberately — the same
        // placement, and the same reason, as the sweep-HUD sidecar in
        // `finish()`. Native does not resolve `start()` until the camera is
        // open and ingesting, so a host that unmounted us in that window
        // (a mode-bar switch: the host camera gates our mount on
        // `captureMode === 'panoplus'`) leaves a REAL, finalized pack on
        // disk — the branch immediately below stops it and keeps it, because
        // an abandoned sweep's pack is evidence. Below the return, that pack
        // got no sidecar at all. That was survivable while the notice was
        // also printed on screen; since the τ = 0 notice became `packOnly`
        // (2026-09-07) this file is the ONLY place the arm, `tauProvenance`
        // and the basis history are stated in words, so the one pack that
        // never had a screen is exactly the one that must not lose them.
        //
        // FIRE-AND-FORGET AND SWALLOWED. A sweep must never fail because a
        // diagnostic could not be written; the sidecar is evidence about the
        // sweep, not part of it. `fs` is the same lazily-resolved
        // expo-file-system slice the rest of this surface uses and is null on
        // a host without the dep — in which case there is nothing to write to
        // and nothing to report.
        if (fs != null && started.sessionDir !== '') {
          const noticeUri =
            `${fileUri(started.sessionDir).replace(/\/$/, '')}`
            + `/${PANO_PLUS_NOTICE_FILE}`;
          void fs
            .writeAsStringAsync(
              noticeUri,
              panoPlusNoticeSidecar(armNotice, {
                armContract,
                poseSourceRequested: poseSource,
                shownExpanded: armDetailOpen,
              }),
            )
            .catch((e: unknown) => {
              // eslint-disable-next-line no-console
              console.warn('[pano+] notice sidecar not written —', e);
            });
        }
        if (!mountedRef.current) {
          // The surface went away while native was starting. The session IS
          // now live and nothing else will ever stop it — the unmount cleanup
          // has already run and `sweepLiveRef` was never raised, precisely so
          // this handler owns the case and the two cannot both fire.
          void stopPanoPlus().then(
            (s) => {
              // eslint-disable-next-line no-console
              console.log('[pano+] started after unmount — finalized', s.sessionDir);
            },
            (e: unknown) => {
              const info = panoPlusErrorInfo(e);
              if (info.code === 'panoplus-not-running') void cancelPanoPlus();
            },
          );
          return;
        }
        // ⚠ A GUARD RAIL FIRED WHILE THE CAMERA WAS OPENING — DISCARD, and
        // do it BEFORE ownership is taken. Raising `sweepLiveRef` first
        // would make this a live sweep that something else has to stop, and
        // the phase would flick through 'sweeping' on the way — which is
        // the resurrection this latch exists to prevent. `stopOnStartRef`
        // is cleared with it: a release and a rotation can land in the same
        // window, and the guard rail wins (the operator's release keeps
        // what was painted; the guard rail has already decided it is not
        // worth keeping).
        if (abandonOnStartRef.current != null) {
          const reason = abandonOnStartRef.current;
          abandonOnStartRef.current = null;
          stopOnStartRef.current = false;
          void cancelPanoPlus().catch(() => undefined);
          setRunningArm(null);
          setPhase('idle');
          setCameraLock(null);   // see finish() — it dies with its sweep
          liveSessionRef.current = null;
          onFailure?.({
            code: 'panoplus-abandoned',
            message: `sweep abandoned: ${reason}`,
          } as PanoPlusFailure);
          return;
        }
        // Ownership is ours from here: only finish / unmount may release it,
        // and each clears this flag before it acts.
        sweepLiveRef.current = true;
        setPhase('sweeping');
        // The operator let go while native was still opening the camera. The
        // session is live for exactly as long as it takes to say so; finish
        // it now, the way Pano's release would have. See `stopOnStartRef`.
        if (stopOnStartRef.current) {
          stopOnStartRef.current = false;
          finishRef.current();
        }
      },
      (e: unknown) => {
        busyRef.current = false;
        // A release that landed during the failed start has nothing to end.
        stopOnStartRef.current = false;
        const info = panoPlusErrorInfo(e);
        // eslint-disable-next-line no-console
        console.error('[pano+] start failed —', info.code, info.message);
        if (!mountedRef.current) return;
        // THE LATCH IS RELEASED ON EVERY RETURN TO IDLE, this one included: no
        // sweep is running, so the requested arm is once again the honest
        // answer for both `arArmed` and the host's pill.
        setRunningArm(null);
        setPhase('idle');
        setCameraLock(null);  // see finish() — it dies with its sweep
        // Nothing was ever started, so there is no sweep to attribute a status
        // to. Released here rather than left dangling: a claim with no session
        // behind it would let a straggler paint an idle screen.
        liveSessionRef.current = null;
        setError(panoPlusFailureCopy(info));
        onFailure?.(info);
      },
    );
  }, [
    // ⚠ THE FOURTH ROUND OF THIS LIST BEING SHORT, and the note below already
    // records three. All four are READ in this callback — `hostChromeTopPt`
    // by `withHostChromeTop` (the start bag's insets), `attitudeMagFree`
    // and `arArmed` by the start bag's arm keys — and they resolve
    // ASYNCHRONOUSLY relative to the last time it was built: `arArmed`
    // re-derives when `<ARCameraView>` mounts, `hostChromeTopPt` when the host
    // lays out. (`arPluginArm` was the fourth until M2 made the AR-plugin arm
    // the only Android AR arm.) A
    // sweep started from a stale closure would send the arm keys for the
    // previous frame's arm, and the pack would record them as though they had
    // been chosen — which is the same failure the S7 note describes, one
    // release later.
    arArmed,
    attitudeMagFree,
    hostChromeTopPt,
    armContract,
    vcHostArm,
    // ⚠️ THE WHOLE NOTICE, not two of its fields. The sidecar writes
    // `headline`/`detail`/`tone`/`startLabel`, so pinning only the two fields
    // the start bag reads would let a stale closure write the PREVIOUS arm's
    // paragraph into this sweep's pack — the same class of miss the 2026-08-31
    // note below records for `lockCamera`. It is a `useMemo` result, so this
    // is one reference, not five.
    armNotice,
    // Which state the operator could actually READ when he pressed Start.
    armDetailOpen,
    available,
    // The bottom-chrome reservation is read into the start bag (the frontier
    // window's knee), so the two chrome props are deps like the insets are.
    bottomBarOffset,
    hideBuiltInControls,
    documentDirectory,
    engineOptions,
    fs,
    gainMatch,
    // ⚠️ `lockCamera` and `meteringSettleMs` were READ in this callback and
    // ABSENT from these deps until 2026-08-31. A host that flipped the camera
    // lock while the surface sat idle would have started the next sweep on the
    // captured value — silently, with the pack recording the arm it actually
    // ran, so the A/B would have looked like it produced two identical arms.
    // Found while adding `poseSource` to the same list.  `lens` repeated the
    // same omission and was caught in the P5 review; `jogGuard` joins with it.
    // ⚠ AND THE SAME OMISSION AGAIN, WITH THE S7 PROPS. `frameSource`,
    // `vcPluginArm` and `vcCameraId` are all READ in this callback — by the
    // fail-closed guard and by the start bag's arm — and all three were
    // absent from these deps. A host arm that resolved AFTER the callback
    // was last built (which is the normal order: the plugin handle and the
    // ownership settle both land asynchronously) would have started the
    // sweep on the captured values: the guard judging a stale
    // `frameSource`, and the bag omitting an arm the recorder needed. The
    // note above says this list has been short three times before.
    frameSource,
    imuSidecar,
    jogGuard,
    lens,
    lockCamera,
    lurchAccelMps2,
    meteringSettleMs,
    onFailure,
    orientation,
    packFrames,
    packOptions,
    // The arm the operator SELECTED, recorded in the sidecar beside the one
    // that will actually run — an announced ARKit fallback is exactly the case
    // where those two differ and the pack has to say both.
    poseSource,
    rectify,
    safeAreaInsets,
    tauUncorrected,
    vcCameraId,
    vcPluginArm,
    hostArmRefusal,
    vcViewTag,
    box.height,
    box.width,
  ]);

  /** THE HUD'S OWN TEXT, LATCHED FOR THE PACK. `finish` is a `useCallback`
   *  over `[onComplete, onFailure]`, so reading `hud` / `drops` / `guidance`
   *  from its closure would write whatever those said when the callback was
   *  last rebuilt — which is not the end of the sweep. A ref rewritten every
   *  render is read at CALL time, which is. Assigned below, next to the lines
   *  themselves, so the two cannot drift. */
  const hudTextRef = useRef<{
    guidanceHeadline: string;
    guidanceDetail: string;
    hud: string;
    drops: string | null;
    cameraLock: string | null;
    previewWindow: string | null;
    viewfinder: string | null;
  }>({
    guidanceHeadline: '', guidanceDetail: '', hud: '',
    drops: null, cameraLock: null, previewWindow: null, viewfinder: null,
  });
  const finish = useCallback(() => {
    if (busyRef.current) return;
    busyRef.current = true;
    // Ownership passes to THIS call, synchronously and before any await: if the
    // host unmounts us the moment `onComplete` fires, the cleanup must not fire
    // a second stop against a session this one has already finalized.
    sweepLiveRef.current = false;
    setPhase('finishing');
    const arms = armsRef.current;
    void stopPanoPlus().then(
      (summary) => {
        busyRef.current = false;
        // eslint-disable-next-line no-console
        console.log(
          '[pano+] sweep done —',
          `${summary.width}×${summary.height}`,
          `${summary.counts.painted}/${summary.counts.seen} painted`,
          `${summary.unpaintedRuns.length} hole(s)`,
          summary.abort != null ? `ABORT ${summary.abort}` : '',
        );
        // ── THE HUD'S TEXT, INTO THE PACK ────────────────────────────────
        // The screen stopped printing the engine and drops lines during a
        // sweep on 2026-09-03 ("There is still some text shown in the pano+
        // screen - no point of it!"). This is where they go instead, written
        // from the LAST render before stop — the same fire-and-forget,
        // swallowed write the arm notice uses, for the same reason: a sweep
        // must never fail because a diagnostic could not be saved.
        //
        // BEFORE the `mountedRef` early-return, deliberately. The pack is
        // native's and it survives this component; a host that unmounted us
        // the instant stop resolved would otherwise silently lose the record
        // of the very sweep it just took.
        if (fs != null && summary.sessionDir !== '') {
          const hudUri =
            `${fileUri(summary.sessionDir).replace(/\/$/, '')}`
            + `/${PANO_PLUS_SWEEP_NOTICE_FILE}`;
          void fs
            .writeAsStringAsync(
              hudUri,
              panoPlusSweepHudSidecar(hudTextRef.current),
            )
            .catch((e: unknown) => {
              // eslint-disable-next-line no-console
              console.warn('[pano+] sweep HUD sidecar not written —', e);
            });
        }
        if (!mountedRef.current) return;
        // Released with the phase. `arms` was read BEFORE the await, so the
        // pack still carries the arm this sweep ran on whatever the prop has
        // done since — and from here the two agree again on the requested one.
        setRunningArm(null);
        setPhase('idle');
        setStatus(null);
        // Released WITH the panel it scopes — the sweep has published its last
        // preview and this surface is responsible for showing nothing until
        // the next start claims it again.
        liveSessionRef.current = null;
        // ⚠ THE LOCK REPORT DIES WITH ITS SWEEP. `cameraLock` is written once,
        // when start resolves, and was cleared only by the NEXT start — so a
        // sweep whose AE lock came back `available:false` left "NO CAMERA
        // DEVICE — exposure cannot be locked or measured" printed over the idle
        // viewfinder, with the camera demonstrably open and the feed live
        // (A35, 2026-09-03). That is the same class of false sentence this
        // change set exists to remove, two lines above the notice it fixed.
        setCameraLock(null);
        onComplete(panoPlusResultOf(summary, arms));
      },
      (e: unknown) => {
        busyRef.current = false;
        const info = panoPlusErrorInfo(e);
        // eslint-disable-next-line no-console
        console.error('[pano+] stop failed —', info.code, info.message);
        // See the module doc: this is the only path that leaves the native
        // session latched without finalizing.
        if (info.code === 'panoplus-not-running') void cancelPanoPlus();
        if (!mountedRef.current) return;
        setRunningArm(null);
        setPhase('idle');
        setStatus(null);
        liveSessionRef.current = null;   // with the panel — see the success path
        setCameraLock(null);  // see the success path — it dies with its sweep
        setError(panoPlusFailureCopy(info));
        onFailure?.(info);
      },
    );
  }, [onComplete, onFailure]);
  finishRef.current = finish;
  const startRef = useRef(start);
  startRef.current = start;

  /**
   * SHOULD THE SHUTTER LOOK ENABLED — the gates the Start button used to
   * carry by not rendering, now reported as a level (`SurfaceControlState`).
   *
   * `armResolving`, not `armPending`: a running sweep is on a settled arm
   * whatever the prop has done since, and `armPending` CAN go true mid-sweep
   * (the host's pill moves `poseSource`, the read restarts) — which would dim
   * the red ring under the operator's finger for the width of a bridge call.
   * `basisGestureVisible` is idle-only by construction, so neither term can
   * disable a live hold; the shutter's `disabled` only ever refuses a NEW
   * press-in, and `CameraShutter` fires the release regardless.
   *
   * NOT phase-gated. `'finishing'` is reported through `busy` (the grey ring)
   * and `'starting'`/`'sweeping'` have the finger already down.
   */
  const canCapture = available && !armResolving && !basisGestureVisible;
  const canCaptureRef = useRef(canCapture);
  canCaptureRef.current = canCapture;

  // ⚠ THERE IS NO `abandon()` ANY MORE (2026-09-03). It was the Discard
  // button's handler — `cancelPanoPlus` + `onCancel` — and Discard has no
  // gesture in Pano's shutter vocabulary (release always finalizes). Its one
  // internal use, recovering a `panoplus-not-running` stop, lives in `finish`.

  // ── THE SHUTTER, MAPPED (2026-09-03) ─────────────────────────────────────
  //
  // pano+ uses Pano's `CameraShutter` — the shell's in unified chrome, its own
  // below otherwise — and Pano's press semantics drive the sweep:
  //
  //   press-in < 250 ms, release  (onTap)          → INERT. Pano takes a photo;
  //                                                  pano+ has none, like the
  //                                                  `enablePhotoMode=false`
  //                                                  Pano variant.
  //   held 250 ms       (onHoldStart, ring red)    → START the sweep.
  //   release after hold (onHoldComplete)          → FINISH — keep the pack.
  //                                                  Pano: "release ALWAYS
  //                                                  stops the recording".
  //   release while native start is in flight      → latched; finished the
  //                                                  moment the start lands
  //                                                  (see `stopOnStartRef`).
  //   release after a start FAILURE                → nothing to end; Pano's
  //                                                  `handleHoldEnd` early-
  //                                                  returns the same way.
  //   engine abort mid-sweep (`status.abort`)      → ring stays red, the HUD
  //                                                  says stopped; release
  //                                                  keeps what was painted.
  //                                                  No auto-finalize — that
  //                                                  would be a `maxHoldMs`
  //                                                  timer, not requested.
  //   Discard / cancel without a pack              → NO GESTURE. Pano has no
  //                                                  mid-hold discard either.
  const holdStart = useCallback(() => {
    // The gates the Start BUTTON used to encode by not rendering: the arm
    // precondition still resolving, or the basis gesture owning the screen.
    // A hold that starts a sweep under the basis recorder would fit `C` from
    // a log recorded during somebody's pan.
    if (phaseRef.current !== 'idle') return;
    if (!canCaptureRef.current) return;
    startRef.current();
  }, []);
  const holdEnd = useCallback(() => {
    if (phaseRef.current === 'starting') {
      stopOnStartRef.current = true;
      return;
    }
    // `finish` would `stop()` a session that is not there, reject
    // `not-running` and CANCEL — so a release with no live sweep (a start
    // that failed, a release the shutter fires while disabled) ends nothing.
    if (!sweepLiveRef.current) return;
    finishRef.current();
  }, []);
  // The shell's contract. `capture` (a TAP) is inert by design — see the
  // mapping above — and `finalize` has nothing to finalize: the release is
  // what finishes a sweep, so `canFinalize` is never reported true.
  useImperativeHandle(
    ref,
    () => ({
      capture: () => undefined,
      finalize: () => undefined,
      holdStart,
      holdEnd,
      // ⚠ DISCARD, NOT FINALIZE. `holdEnd` ships whatever has been painted;
      // a guard rail that fires mid-sweep has decided the capture is not
      // worth keeping, so it must be able to drop it. This is the path
      // Pano's `incremental.cancel()` occupies on the keyframe engine.
      abandon: (reason: string) => {
        if (phaseRef.current === 'idle') return;
        // ⚠ THE START WINDOW IS NOT A LIVE SWEEP. `cancelPanoPlus()` here
        // rejects `panoplus-not-running` and the in-flight `start()` then
        // resolves and goes live behind us — see `abandonOnStartRef`, which
        // carries the discard into that resolution instead.
        if (phaseRef.current === 'starting') {
          abandonOnStartRef.current = reason;
          return;
        }
        // ⚠ AND INERT ONCE `finish()` HAS TAKEN OWNERSHIP. `busyRef` is the
        // latch `finish` sets before awaiting native `stop()`; firing
        // `cancel()` against a session with `stop()` in flight leaves the
        // pending continuation untouched, so the surface still resolves
        // `onComplete` afterwards — the host would be told the capture was
        // abandoned and then handed that same capture.
        if (busyRef.current) return;
        void cancelPanoPlus().catch(() => undefined);
        // ⚠ THE OWNERSHIP FLAGS COME DOWN WITH THE SESSION, and the first cut
        // of this dropped them. A sweep is a HOLD: the operator is still
        // pressing when a guard rail fires, and his release runs `holdEnd`
        // one moment later. `holdEnd` early-returns only on
        // `!sweepLiveRef.current` — so with the flag left raised it called
        // `finish()` on a session that had just been cancelled, which
        // `stop()`s a session that is not there, rejects `not-running` and
        // CANCELS again: a second teardown against native, a second
        // `onFailure`, and on a build where cancel deletes by path the
        // NEXT sweep's directory is the one at risk.
        //
        // These are the same four `start()`'s own failure branch releases,
        // for the same reason it releases them: no sweep is running, so a
        // claim with no session behind it must not outlive it.
        sweepLiveRef.current = false;
        liveSessionRef.current = null;
        setRunningArm(null);
        setCameraLock(null);   // see finish() — it dies with its sweep
        // The live status goes with the session, so `onPaintedChange` reports
        // 0 on an abandon as it does after a finish. Safe against a late
        // tick: `liveSessionRef` is already null, so `applyStatus` drops it.
        setStatus(null);
        setPhase('idle');
        onFailure?.({
          code: 'panoplus-abandoned',
          message: `sweep abandoned: ${reason}`,
        } as PanoPlusFailure);
      },
    }),
    [holdStart, holdEnd, onFailure],
  );

  // ── M5: A DEVICE-LEVEL REFUSAL MID-SWEEP ENDS IT, BY NAME ────────────────
  // The iOS vision-camera arm refuses frames it cannot paint correctly (a
  // mirrored or rotated buffer, a changed orientation, a zoom) and the bridge's
  // status names the first one. Letting the sweep run on would show a canvas
  // that never grows and end in "too short"; it is stopped the moment the
  // status says so — FINALIZED rather than cancelled, because the pack is the
  // evidence of what the camera did — and reported with the refusal's code.
  const vcDeviceRefusal = status?.vcDeviceRefusal ?? null;
  const statusSessionDir = status?.sessionDir ?? null;
  useEffect(() => {
    if (vcDeviceRefusal == null) return;
    if (phaseRef.current !== 'sweeping' || busyRef.current || !sweepLiveRef.current) return;
    busyRef.current = true;
    const named = panoPlusVcDeviceRefusalFailure(vcDeviceRefusal);
    // ⚠ THE SHAPE OF `finish()`, NOT OF AN ABANDON (M5 review). Native's stop
    // is a finalize and a pack write — seconds on a device — and until it
    // settles this sweep still owns the camera. Going 'idle' at once reported
    // `busy` false while native was still tearing down: the shutter looked
    // free and the next hold was silently swallowed by `start()`'s `busyRef`
    // return, and `<Camera>`'s ownership latch and the host's mode-switch
    // guard came down early. So: ownership passes to this call synchronously
    // (late status ticks are dropped), the refusal is reported at once, and
    // the phase is 'finishing' until stop settles.
    sweepLiveRef.current = false;
    liveSessionRef.current = null;
    setPhase('finishing');
    const info = {
      code: named.code,
      message: named.message,
      sessionDir: statusSessionDir,
      counts: null,
      abort: null,
    } as PanoPlusFailure;
    setError(panoPlusFailureCopy(info));
    onFailure?.(info);
    const settle = (): void => {
      busyRef.current = false;
      if (!mountedRef.current) return;
      setRunningArm(null);
      setCameraLock(null);
      setStatus(null);
      setPhase('idle');
    };
    void stopPanoPlus().then(settle, (e: unknown) => {
      if (panoPlusErrorInfo(e).code === 'panoplus-not-running') void cancelPanoPlus();
      settle();
    });
  }, [vcDeviceRefusal, statusSessionDir, onFailure]);
  /** `busy` is `'finishing'` ONLY. Reporting `'sweeping'` would have
   *  `CameraShutter` paint its grey processing ring over the red one and
   *  refuse the press-in it is already inside (`CameraShutter.tsx:184,
   *  :247-249`). The pack write is the one window in which the shutter is
   *  genuinely unavailable. */
  const shutterBusy = phase === 'finishing';
  // M8 — the same ref shape as `onSweepingChange`: `<Camera>` composes its own
  // handler into this prop inline, so keyed on the callback it re-fired on
  // every `<Camera>` render (8 Hz during a sweep, now that the engine's state
  // re-renders `<Camera>`) and called the host's copy each time. The values
  // are what changed or nothing did. Reported only while selected.
  const onControlsStateRef = useRef(onControlsState);
  onControlsStateRef.current = onControlsState;
  useEffect(() => {
    if (!enabled) return;
    onControlsStateRef.current?.({ canCapture, canFinalize: false, busy: shutterBusy });
  }, [canCapture, shutterBusy, enabled]);

  // THE COACHING CONTEXT — one object, read by BOTH the governor line and the
  // HUD so the two can never coach different gestures. `screenIsLandscape` is
  // MEASURED (this app is portrait-locked, so it is false in every hold on the
  // field build) and `orientation` is the physical hold from the sensor, which
  // is the only thing that survives the lock.
  const guidanceCtx = useMemo(
    () => ({
      orientation,
      screenIsLandscape: window.width > window.height,
      canvasMaxHeightPx: engineOptions?.canvasMaxHeightPx,
      canvasScale: engineOptions?.canvasScale,
      // BOTH OTHER BOUNDS, because `canvasMaxHeightPx` is not the only one and
      // on the long portrait aisle walk it is not even the first: the 18 MP
      // area budget refuses the height step once the canvas is ~8789 px wide,
      // and a host that sets `canvasGrowVertical: false` gets clipping at the
      // latch height with no growth at all. Passed as `undefined` when unset,
      // which leaves the engine's own defaults in charge.
      canvasMaxPixels: engineOptions?.canvasMaxPixels,
      canvasGrowVertical: engineOptions?.canvasGrowVertical,
      copy: guidanceCopy,
    }),
    [orientation, window.width, window.height, engineOptions, guidanceCopy],
  );
  /** A SWEEP IS IN FLIGHT — the one gate the HUD's prose is scoped by since
   *  2026-09-03. `'finishing'` counts: the pack write is not a moment to put a
   *  paragraph back on screen. */
  const sweeping = phase === 'sweeping' || phase === 'finishing';
  const guidance = panoPlusGuidance(status, phase, guidanceCtx);
  const hud = panoPlusHudLine(status, guidanceCtx);
  const drops = panoPlusDropLine(status);
  // The half of the idle-only rule that was never written — see
  // `panoPlusSweepFaults`. Null on a healthy sweep, so the quiet screen the
  // operator asked for stays quiet.
  const sweepFaults = panoPlusSweepFaults(status);
  const lockWarning = panoPlusCameraLockLine(cameraLock);
  // WHY THERE IS NO LIVE CAMERA FEED, when native knows and the screen does
  // not. The viewfinder and the panorama panel are two different pictures, and
  // until this line the operator's evidence for "the camera is broken" and for
  // "the camera is fine, the panel is just behind" was the same black
  // rectangle. Null — and therefore invisible — on iOS and on any build that
  // does not track it. See `panoPlusViewfinderNotice`.
  const viewfinderNotice = panoPlusViewfinderNotice(status);
  // ── THE HUD'S TEXT, LATCHED FOR THE PACK ────────────────────────────────
  // Written on every render, read once at stop. `panoPlusPreviewWindowCaption`
  // is called HERE and only here: the preview no longer says "showing the last
  // x%" on screen, so the pack is the only place that fact can now be read.
  //
  // ⚠ FROZEN AT `'finishing'`, DELIBERATELY. `finish()` flips the phase
  // synchronously and the write happens when native's stop resolves, so
  // without this gate the sidecar would record the render IN BETWEEN — whose
  // governor line is "Finishing the panorama…", a statement about the button
  // rather than about the sweep. The status-derived lines are unaffected
  // either way (`setStatus(null)` runs after the write), but recording a
  // headline nobody can act on would make the file read as if the sweep ended
  // healthy whatever it actually did.
  if (phase !== 'finishing') {
    hudTextRef.current = {
      guidanceHeadline: guidance.headline,
      guidanceDetail: guidance.detail,
      hud,
      drops,
      cameraLock: lockWarning,
      previewWindow: panoPlusPreviewWindowCaption(status),
      viewfinder: viewfinderNotice,
    };
  }
  const preview = panoPlusPreviewSource(status);
  // THE PREVIEW CAPSULE. A FIXED strip whose only input is this window and the
  // latched axis — never the panorama's live shape, which is what used to make
  // it walk. The panorama grows INSIDE it, out of a pinned start edge. See
  // `panoPlusPreviewLayout`, and `PanoramaBandOverlay.tsx` for the slit-scan
  // band it is copied from.
  const previewLayout = panoPlusPreviewLayout(
    status,
    {
      // ⚠ THE SURFACE'S BOX, NOT THE WINDOW — see `surfaceBox`.
      width: box.width,
      height: box.height,
      // The framebuffer's turn is a WINDOW fact and must not follow the box.
      jsLandscape: window.width > window.height,
      // `hostChromeTopPt` rides on the TOP inset because that is exactly what
      // it is to this surface: pixels at the top that belong to somebody else.
      // See the prop's own note for the overprint it ends.
      insets: withHostChromeTop(safeAreaInsets, hostChromeTopPt),
      // Pano's bottom stack — the lens chip's slot is ALWAYS reserved, chip
      // shown or not, so flipping the AR pill cannot move the HUD.
      bottomChromePt: panoBottomChromePt(
        safeAreaInsets?.bottom ?? 0,
        bottomBarOffset,
        hideBuiltInControls,
      ),
    },
    // THE ORIENTATION IS LOAD-BEARING TWICE OVER, and neither use is the one a
    // reader expects. A portrait-locked host (one whose Info.plist lists only
    // UIInterfaceOrientationPortrait)
    // so `window` is 390x844 however the phone is held: without this the panel
    // would be sized against 390 pt of "width" and land at ~120x131 pt, and
    // the panorama — whose pixels are sensor-referenced, not
    // framebuffer-referenced — would be drawn lying on its side.
    orientation,
  );

  /**
   * ASSIGN EACH NEW PREVIEW TO THE HIDDEN SLOT, never to the visible one.
   *
   * This is the whole ping-pong (see [previewSlots]). The visible slot's
   * `source` prop must not change, or Fresco resets it to transparent and the
   * flicker is back. The layout is frozen HERE, at assign time, because this
   * is the geometry that belongs to this uri.
   *
   * Guard order matters: a uri already held by EITHER slot is ignored, so a
   * re-render that does not carry a new publish cannot ping-pong on the spot.
   */
  /**
   * ⚑ THE PING-PONG MUST NOT SPAN TWO SWEEPS.
   *
   * Holding the last decoded frame is correct WITHIN a sweep and is exactly
   * the defect the operator reported on 2026-09-05 ACROSS sweeps: "After I
   * take the first capture, the preview just shows the previous output from
   * the next capture onwards." Without this reset the visible slot would keep
   * painting the previous panorama until the new sweep's first frame decoded.
   *
   * Declared BEFORE the assignment effect so that, in a commit where the
   * session changed, the clear is applied first and the new uri lands in an
   * empty pair — which the first-assignment rule then routes to the VISIBLE
   * slot. The session-scoping tests cover this and they caught it.
   */
  const statusSessionId =
    status != null ? panoPlusStatusSessionId(status) : null;
  useEffect(() => {
    setPreviewSlots({ a: null, b: null, visible: 'a' });
  }, [statusSessionId]);

  // M8 — THE SURFACE'S ANDROID PORTRAIT LOCK IS GONE, and that is a FIX.
  // `RNSARSession`'s lock is ONE non-refcounted slot, and `<Camera>` already
  // takes it on mount; this hook took it a second time and released it on
  // unmount — which, with the surface unmounted behind the review, UNLOCKED
  // the screen `<Camera>` had locked. `<Camera>` is the one owner now.

  const previewUri = preview?.uri ?? null;
  const previewGeom = previewLayout.content;
  const previewAnchor = previewLayout.anchor;
  useEffect(() => {
    if (previewUri == null) return;
    setPreviewSlots((prev) => {
      if (prev.a?.uri === previewUri || prev.b?.uri === previewUri) return prev;
      // THE FIRST ASSIGNMENT GOES TO THE VISIBLE SLOT. There is nothing on
      // screen yet, so there is nothing to protect, and sending it to the
      // hidden one would leave the panel empty until that slot loaded and
      // promoted itself — a delay on the very frame the operator is waiting
      // for. From the second publish on it always goes to the hidden slot,
      // which is the mechanism.
      const nothingHeld = prev.a == null && prev.b == null;
      const hidden = nothingHeld
        ? prev.visible
        : prev.visible === 'a' ? 'b' : 'a';
      return {
        ...prev,
        [hidden]: {
          uri: previewUri,
          width: previewGeom.width,
          height: previewGeom.height,
          left: previewAnchor.left,
          top: previewAnchor.top,
        },
      };
    });
    // previewGeom/previewAnchor are read at assign time on purpose and must
    // NOT re-run this effect on their own, or a growing panorama would
    // re-assign the same uri and undo the hold.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewUri]);

  /**
   * THE TIMEOUT SWAP. See [PREVIEW_SLOT_TIMEOUT_MS] — a decode that never
   * reports would otherwise freeze the panorama on one buffer for the rest of
   * the sweep, which is a worse defect than the flicker.
   */
  const hiddenSlotUri =
    previewSlots.visible === 'a' ? previewSlots.b?.uri : previewSlots.a?.uri;
  useEffect(() => {
    if (hiddenSlotUri == null) return undefined;
    const t = setTimeout(() => {
      setPreviewSlots((prev) => {
        const hidden = prev.visible === 'a' ? 'b' : 'a';
        if (prev[hidden]?.uri !== hiddenSlotUri) return prev;
        return { ...prev, visible: hidden };
      });
    }, PREVIEW_SLOT_TIMEOUT_MS);
    return () => clearTimeout(t);
  }, [hiddenSlotUri]);

  /** Promote a slot once its own image has actually decoded. */
  const onPreviewSlotLoad = useCallback((which: 'a' | 'b', uri: string) => {
    setPreviewLoadFailed(false);
    setPreviewSlots((prev) => {
      if (prev[which]?.uri !== uri) return prev;   // a stale load, ignore
      if (prev.visible === which) return prev;
      return { ...prev, visible: which };
    });
  }, []);
  const previewPlaceholder = panoPlusPreviewPlaceholder(
    status,
    phase,
    sweepingForMs,
  );
  // A REAL PANORAMA THAT HAS STOPPED ADVANCING IS NOT A LIVE ONE, and until
  // 2026-08-30 nothing on this panel said so — the placeholder goes quiet the
  // moment anything publishes, so a publisher that failed part-way through
  // left a frozen image that looks exactly like a stalled sweep. This rides
  // OVER the pixels rather than replacing them.
  const previewStale = panoPlusPreviewStaleNotice(status);
  // ⚠ `previewMarker` / `previewWindowCaption` / `frontierCaption` WERE READ
  // HERE UNTIL 2026-09-03. The frontier marker existed for a real measured
  // fact — on the 2026-08-29 packs the painted extent did not move for the
  // first 2.4-2.9 s of a sweep, so a line that DID move was the only evidence
  // the engine was alive. The seed fix (`rnis_pano.cpp`'s pre-latch preview)
  // removes the stall the marker was reporting, and the operator's verdict on
  // the marker itself was unambiguous. All three functions are still exported
  // and still tested; nothing on the CAPTURE SCREEN reads them.
  //
  // v12 — the decoupled arm's viewfinder component, or null on builds (and
  // under Jest) that do not carry it. Resolved once per process.
  //
  // ⚠ TWO NATIVE COMPONENTS, NO PLATFORM BRANCH (2026-09-02). Each resolver
  // already answers null off its own platform and memoises its one permitted
  // `requireNativeComponent` call, so `??` reads as "whichever of the two this
  // runtime carries" and can never resolve both. They are separate modules
  // rather than one with a branch because the CONTRACTS differ: the iOS view
  // draws a session it does not own and may be mounted at any moment, while the
  // Android one VENDS a Surface the recorder must claim before
  // `createCaptureSession` — Camera2 fixes a session's outputs at configure
  // time, so a view mounted after Start is a black rectangle with nothing to
  // explain it. Mounting on `!arArmed` (which is true through the whole idle
  // phase) is what puts the Android view up before the tap.
  const AvfViewfinder = getPanoPlusSourceView()
    ?? getPanoPlusAndroidPreviewView();
  /**
   * THE CENTRED EXPLAINER, or null when there is something live to look at.
   *
   * ⚠ THIS USED TO BE A CONDITIONAL SPELLED IN JSX, AND IT PRINTED A LIE.
   * The old expression chose its words from the ARM the surface believed it
   * was on, so the Android AR arm read "ARCore is UP, inside the sweep's own
   * camera session" AT IDLE — on a phone where ARCore was down, no session
   * existed and nothing held the camera. An arm is not a state. The decision
   * now lives in `panoPlusCameraOffNotice`, which is keyed on who owns the
   * camera in this phase and prefers native's own reason to any prose written
   * here — and, being pure, is walked by a test rather than by a field trip.
   */
  // M8 — nothing to explain on `'host-ar'`: the host's AR view is on screen.
  const cameraOffNotice = frameSource === 'host-ar' ? null : panoPlusCameraOffNotice({
    armContract,
    arArmed,
    arReady,
    androidArArm,
    hasViewfinderView: AvfViewfinder != null,
    frameSource,
    hostPreviewLive,
    hostPreviewError,
    idleFeedLive,
    idleReason,
    phase,
  });
  /**
   * THE SAME QUESTION FOR A FEED THAT IS UP: does it MATCH?
   *
   * Null whenever there is nothing to warn about, which is the ordinary case —
   * a pinned viewfinder, a build that does not report the pin, or a screen the
   * explainer above already owns. See `panoPlusPreviewPinNotice` for each
   * silence and why it is one. It is deliberately NOT folded into
   * `cameraOffNotice`: that notice is the CENTRED explainer over a dead
   * screen, and this fault has live pixels under it — a centred caption over
   * them is exactly the clutter that module refuses to print.
   */
  const previewPinNotice = panoPlusPreviewPinNotice({
    applied: idlePin.applied,
    range: idlePin.range,
    note: idlePin.note,
    subject: idlePin.subject,
    idleFeedLive,
    phase,
  });
  // ⚠ `markerStyle` LIVED HERE UNTIL 2026-09-03 — deleted with the marker it
  // positioned. See the note where `previewMarker` was read.
  // ── PANO'S TWO PILLS, AND WHEN EACH SHOWS ────────────────────────────────
  //
  // THE AR PILL draws the arm that will RUN (`reportedArm`, which is the
  // latched arm mid-sweep and the notice's effective arm at idle), except
  // while the precondition read is in flight, when it follows the REQUEST —
  // see `onPoseSourceChange`'s doc for why each half is the honest one.
  const arPillOn = armResolving
    ? poseSource !== 'imu'
    : reportedArm.poseSource !== 'imu';
  // ── PANO'S REAL RULE, ADOPTED (owner, 2026-09-03) ────────────────────────
  //
  // The chip is ALWAYS on screen and the AR PILL is what hides, gated on the
  // lens being 1× — so picking 0.5× is what drops you out of AR, exactly as it
  // does in Pano. This replaces the earlier reading ("show the switcher if AR
  // is off"), which put the gate on the wrong control: it was written believing
  // Pano hides its chip under AR, and Pano does the mirror of that. The three
  // terms are below; `capture/PanoChrome.tsx`'s header carries the decision.
  //
  //  (1) THE LENS THE RUNNING ARM WILL ACTUALLY OPEN — not the flag. On the AR
  //      arm the lens is structurally the WIDE camera (ARKit publishes no
  //      ultra-wide format — 0 of 22 on iPhone17,1; ARCore forces camera 0 on
  //      the A35), and `start` DELETES the `lens` key there, so the pack's
  //      `lensRequested` is null and `lensHonoured` false. `panoPlusLens`
  //      defaults to `'ultraWide'` and `panoPlusPoseSource` to `'ar'`, so the
  //      FRESH-DEVICE state is literally (0.5×, AR): painting the flag would
  //      put `0.5×` under the operator's finger while the viewfinder, the
  //      sweep and the pack all run 1×. This is the same derive-from-what-runs
  //      rule `arPillOn` already follows, applied to the other control, and it
  //      is what makes the "no reachable state where the chip claims a lens the
  //      running arm cannot deliver" property hold for the DEFAULTS as well as
  //      for the taps.
  const effectiveLens: PanoLens =
    arPillOn ? '1x' : lens === 'wide' ? '1x' : '0.5x';
  //  (2) A 0.5× THE SURFACE CANNOT DELIVER IS NOT OFFERED. On the AR arm the
  //      0.5× pill's whole meaning is "leave the AR arm and open the
  //      ultra-wide" (see `onLensPill`). A host that wired `onLensChange` but
  //      NOT `onPoseSourceChange` has given this surface no way to move the
  //      arm, so that tap would re-label a chip over a viewfinder still on
  //      ARCore's camera 0 — the exact "a control that moves a flag and not a
  //      lens" the 2026-09-02 inversion removed. It is withheld instead.
  //      `PanoLensChip` never drops the SELECTED pill, so the chip cannot go
  //      empty, and on the decoupled arm this term is inert.
  //
  //      ⚠ KNOWN BOUNDED GAP, stated rather than hidden: `lensAvail` is probed
  //      only on the IMU arm (see its effect — the AR arm makes NO calibration
  //      call, deliberately, and that invariant is pinned by a test). So on the
  //      AR arm the hardware question is unanswered and BOTH pills stand. On a
  //      body that publishes no ultra-wide, tapping 0.5× there moves the arm,
  //      the probe then runs, and the arm read refuses with
  //      `panoplus-no-ultrawide` under the notice. That is a transient
  //      over-offer with a spoken recovery, on hardware this arm has never run
  //      on; closing it means asking the planner on the AR arm, which is a
  //      per-mount native call on the path that carries the entire programme.
  //
  //      ⚠ AND "CAN LEAVE THE AR ARM" IS NOT THE SAME QUESTION AS "HAS A
  //      WRITER", which is what this term asked until 2026-09-03. On the iOS
  //      FALLBACK RUNG — the decoupled arm requested on a phone with no τ and
  //      no basis, which `panoPlusModel`'s own history says is the normal
  //      state of an iPhone rather than a corner case — `panoPlusArmNotice`
  //      answers `effectivePoseSource: 'ar'` with `fallbackToAr: true`, so the
  //      write lands and the arm does not move. Measured, not argued: tapping
  //      0.5× there left the screen byte-identical (chip `1×`, pill `AR mode
  //      on`) while both persisted flags went (wide, ar) → (ultraWide, imu).
  //      Two taps of a dead pill, and a phone calibrated later would come up
  //      decoupled at 0.5× from a tap that visibly did nothing. So the term
  //      now asks whether the arm CAN move, and on the rung where it cannot
  //      the chip collapses to Pano's static `1×` — truthful, and the notice
  //      under `▸ tap for why` already says what would fix it. `fallbackToAr`
  //      is `false` on the plain AR arm of BOTH producers
  //      (`panoPlusModel.ts:3623`, and every branch of `panoPlusAndroidArm`),
  //      so this term is inert on Android and on every calibrated body — it
  //      cannot cost the A35 the 0.5× pill.
  const ultraWideOfferable =
    (lensAvail?.ultraWide ?? true)
    && (!arPillOn || (onPoseSourceChange != null && !reportedArm.fallbackToAr));
  //  (3) THE TWO GATES. The chip needs only a writer; the AR pill mirrors
  //      Pano's `Camera.tsx:3382` — `!hideBuiltInShutter && arAllowed &&
  //      nonArAllowed && lens === '1x' && isARSupportedOnDevice`. Mapped:
  //        · `arAllowed && nonArAllowed` (Pano's `captureSources='both'` — a
  //          single-source constraint has nothing to toggle) ⇒ `onPoseSourceChange
  //          != null`, which is this surface's "the host will accept both arms";
  //        · `lens === '1x'` ⇒ `effectiveLens === '1x'`, term (1);
  //        · `isARSupportedOnDevice` ⇒ NOT mapped, and deliberately: pano+'s
  //          answer to "can this phone do AR" is not a boolean at mount but the
  //          arm ladder itself (`panoPlusArmNotice`), which resolves an
  //          unsupported phone to the arm that CAN run and says so on the
  //          notice. A pill hidden on that phone would remove the switch and
  //          leave the explanation with nothing to point at;
  //        · `!hideBuiltInShutter` ⇒ NOT mapped, and this is the one forced
  //          asymmetry: it is the term that makes Pano draw NO pill at all
  //          under `unifiedChrome`. pano+ cannot lose the pill — it is the only
  //          switch between the ARCore and decoupled arms. See PanoChrome.tsx.
  //
  // ⚠ …EXCEPT UNDER THE BASIS MEASUREMENT, and that term is CORRECTNESS rather
  // than tidiness — the same argument `PanHowToOverlay` is suppressed on.
  // These two pills are the only affordances on this screen that write the
  // host flags (`lens`, `poseSource`) which the precondition read is keyed on
  // (`calibrationForPlannedFormat` effect, deps `[poseSource, lens, …]`). One
  // tap re-runs that read, `setCalibRead(false)` drops `basisGestureVisible`,
  // React unmounts the overlay mid-recording and its teardown DISCARDS the
  // log. Measured on a gesture already coaching "MOVE IT ON MORE THAN ONE
  // AXIS": one tap → `discardBasisCalibration` 0→1, `startBasisCalibration`
  // 1→2, headline back to "ONE-TIME SETUP FOR THIS PHONE". No message; the
  // operator simply starts again and is not told why.
  //
  // The AR pill is the worse of the two, because through the 0.5× door it is
  // LABELLED WITH THE ARM HE IS TRYING TO LEAVE: the notice has already fallen
  // back, so `arPillOn` is true and it reads "AR mode ON", while its handler
  // can only write `poseSource: 'imu'` (already set — a no-op) plus a lens
  // change. Its entire effect is to reset the measurement.
  //
  // Nothing is lost by hiding them: `basisGestureVisible` is idle-only by
  // construction, so no live sweep is touched; the overlay carries its own SKIP
  // (which is the documented way out, and leaves the ARKit fallback standing);
  // and both flags remain reachable from the gear panel.
  const lensChipVisible = onLensChange != null && !basisGestureVisible;
  //  (4) …AND ONE CONTROL IS ALWAYS LEFT ON SCREEN. This term is NOT Pano's
  //      and is the one deliberate deviation from `:3382`; it exists because
  //      Pano cannot reach the state it guards and pano+ can.
  //
  //      Pano's `lens` state is owned by the chip, which never offers a lens
  //      the body lacks, so Pano's lens is always one the chip can move off.
  //      pano+'s lens is a PERSISTED HOST FLAG that can already name a lens
  //      this body does not publish — and when it does, `PanoLensChip` takes
  //      Pano's single-lens branch and renders a static `Text` with NO
  //      `Pressable` (`PanoChrome.tsx:247`). Pair that with a pill gated away
  //      at 0.5× and the surface has no writer for EITHER flag. Not a
  //      hypothesis: with the wide refused, one tap of 0.5× from (wide, AR)
  //      left the whole surface with exactly one pressable — `panoplus-arm-
  //      notice`, the expand/collapse affordance, which writes nothing — under
  //      a headline reading `IMU ARM — CALIBRATED`. Both flags persist, so a
  //      relaunch lands straight back in it.
  //
  //      So: the pill shows under Pano's rule, OR whenever nothing else on
  //      screen can write a flag. `lensChipVisible` is in the term because a
  //      chip that is not mounted plainly cannot be the escape either.
  const chipCanMoveLens =
    lensChipVisible
    // The two-pill branch, computed from the SAME pair the chip is handed
    // below — if these ever drift the invariant is being asserted about a
    // control that is not on screen.
    && (ultraWideOfferable || effectiveLens === '0.5x')
    && ((lensAvail?.wide ?? true) || effectiveLens === '1x');
  // ⚠ THE `!basisGestureVisible` TERM IS NOT OPTIONAL HERE, AND IT IS NOT A
  // COPY OF THE CHIP'S. `chipCanMoveLens` contains `lensChipVisible`, which the
  // measurement now clears — so WITHOUT this term the escape-hatch clause
  // (`!chipCanMoveLens`, term (4) above) would read "nothing else on screen can
  // write a flag" and switch the AR pill ON under the overlay: the suppression
  // would summon the more damaging of the two controls. The hatch's premise
  // does not hold in this state anyway — the overlay's own SKIP is the control
  // left on screen, and it is the one that belongs there.
  const arPillVisible =
    onPoseSourceChange != null
    && !basisGestureVisible
    && (effectiveLens === '1x' || !chipCanMoveLens);
  // Pano's GLYPH rotation, and nothing else on this screen turns — see
  // `panoPlusGlyphRotationDeg`.
  const glyphRotateDeg = panoPlusGlyphRotationDeg(
    window.width > window.height,
    orientation,
  );
  // Both taps are inert off-idle: the arm is latched for the sweep and the
  // lens cannot change under one. Pano's pill has no phase guard because
  // Pano's `<Camera>` mounts a different camera the moment it flips; here a
  // flip mid-sweep would only move a flag the pack has already recorded.
  //
  // ⚠ THE WRITE IS DERIVED FROM WHAT THE PILL PAINTS, NOT FROM THE REQUEST
  // FLAG, and the two are not the same value. `arPillOn` reads the EFFECTIVE
  // arm; `poseSource` is what was ASKED for. They diverge on the iOS fallback
  // rung — `panoPlusArmNotice` answers `effectivePoseSource: 'ar'` with
  // `fallbackToAr: true` when the IMU arm is requested but τ/basis calibration
  // is missing (`panoPlusModel.ts:3628`, `:3754`) — and there the pill paints
  // ON while the flag reads `'imu'`. Toggling off `poseSource` in that state
  // wrote `'ar'`: the operator taps a pill showing ON to turn AR OFF and the
  // handler requests AR, the opposite of the tap, with nothing moving on
  // screen. Deriving from `arPillOn` makes the direction always match the
  // glyph the finger landed on.
  //
  // In that fallback state the tap is then a NO-OP (the request is already
  // `'imu'`; the arm falls back again), which is the honest outcome — the IMU
  // arm genuinely cannot run on an uncalibrated phone, and the notice under
  // `▸ tap for why` is what says so. What it no longer does is move the flag
  // AWAY from what the operator asked for. Not reachable on Android, where
  // `panoPlusAndroidArm` answers `'ar'` only when `'ar'` was asked.
  //
  // ⚠ AND LEAVING AR COMMITS THE LENS THE CHIP WAS PAINTING, which is why this
  // handler writes two flags where Pano's writes one. Pano's `handleARToggle`
  // (`Camera.tsx:2952`) touches only `arPreference` and can afford to: its
  // `lens` defaults to `'1x'` (`:1504`, `:1614`) and its chip is the only
  // writer, so what the toggle leaves behind is what the chip was showing.
  // pano+'s lens is a persisted flag defaulting to `'ultraWide'`
  // (`captureFlagsStore.ts:1910`) that `effectiveLens` MASKS while AR runs — so
  // on a fresh device the chip paints `1×` over a flag reading `ultraWide`, and
  // an AR-off tap that moved only the arm unmasked it. Measured: from the
  // shipped default, one tap of the pill jumped the chip `1×` → `0.5×` and
  // deleted the pill itself (its gate is `effectiveLens === '1x'`), on a
  // control that says nothing about lenses — and the next sweep then sent
  // `lens: 'ultraWide'`, recorded in the pack as `lensRequested` as though
  // somebody had chosen it.
  //
  // Writing `'wide'` here is not a preference being overridden: it is the
  // value already under the operator's finger being made real. 0.5× stays one
  // deliberate tap away, on the chip that is still on screen. Both writes leave
  // one synchronous handler, so React batches them into a single commit exactly
  // as `onLensPill` does — and `effectiveLens` makes even a torn read paint
  // `1×`, stale rather than false.
  const onArToggle = useCallback(() => {
    if (phaseRef.current !== 'idle') return;
    if (arPillOn) {
      onPoseSourceChange?.('imu');
      onLensChange?.('wide');
    } else {
      onPoseSourceChange?.('ar');
    }
  }, [onPoseSourceChange, onLensChange, arPillOn]);
  // ── THE LENS TAP, AND WHY 0.5× MOVES THE ARM ─────────────────────────────
  //
  // Pano's rule, adopted 2026-09-03: picking 0.5× drops you out of AR. Here it
  // has to be WRITTEN rather than implied, because the two halves live in two
  // host flags — Pano keeps `lens` and `arPreference` in one component's state
  // and re-derives its pill from both on the same render.
  //
  // ⚠ BOTH WRITES ARE ISSUED FROM THIS ONE SYNCHRONOUS HANDLER, so React 18
  // batches them into a SINGLE commit and the screen never shows `0.5×`
  // selected with the AR pill still up. That batching is the host's to keep,
  // though, so it is not the only thing standing between the operator and that
  // frame: `effectiveLens` (above) is derived from the arm that will RUN, so
  // even a torn read — the lens landing a render before the arm — paints `1×`
  // and the pill ON, which is a state that is merely stale rather than false.
  // The arm is written FIRST for the same reason: its intermediate state
  // (1×, decoupled) is one the operator could have reached by hand.
  //
  // ⚠ AND THE RETURN LEG DOES NOT RE-ARM AR. Tapping 1× writes the lens and
  // NOTHING ELSE: it brings the AR pill back — OFF, because the arm is still
  // the decoupled one — and the operator decides from there. Re-arming ARCore
  // silently would make one tap on a LENS control change which engine records
  // the sweep, and `panoPlusPoseSource` is a persisted flag: a phone put on the
  // decoupled arm on purpose would quietly come back ARKit. Pinned by a test.
  const onLensPill = useCallback(
    (next: '1x' | '0.5x') => {
      if (phaseRef.current !== 'idle') return;
      if (next === '0.5x') onPoseSourceChange?.('imu');
      onLensChange?.(next === '0.5x' ? 'ultraWide' : 'wide');
    },
    [onLensChange, onPoseSourceChange],
  );
  // WHERE THE PILLS GO — Pano's own positions, cited. The AR pill sits in the
  // stitcher's `pillStack` (`Camera.tsx:3844-3849`: absolute, `right: 14`)
  // at the `top` it uses under a settings gear (`:2990-2995`,
  // `insets.top + 8 + 44`) — the host draws its own affordances in the gear's
  // slot — and never above the host's top chrome (`hostChromeTopPt`). The
  // lens chip is the `bottomBarCenter` of a bar lifted by `bottomBarOffset`
  // (`:3322-3347`), which is what lands it at the height Pano's chip measures
  // on the same phone.
  const pillStackTop = Math.max(
    (safeAreaInsets?.top ?? 0) + 8 + 44,
    hostChromeTopPt,
  );
  const bottomBarBottom =
    (safeAreaInsets?.bottom ?? 0) + PANO_BOTTOM_BAR_INSET + bottomBarOffset;
  // THE HOLD IS NOT A GATE ANY MORE. It used to be: `landscape` drove a
  // rotate-to-landscape nag on every portrait hold and gated the pan coach
  // mark to landscape only, so the operator who set up for the portrait
  // left-to-right sweep got scolded and then taught nothing. The engine never
  // asked for landscape — `axisOverride` is 0 on all three field packs and the
  // latch votes on measured translation, so both holds are the SAME engine
  // case (see `panoPlusHoldOf`). What survives is the ONE hold that really is
  // worse: upside-down, where the hand covers the lens housing.
  const hold = panoPlusHoldOf(orientation);

  return {
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
  };
}

/** What the engine hands its screen. */
export type SweepEngine = ReturnType<typeof useSweepEngine>;
