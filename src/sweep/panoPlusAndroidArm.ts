// SPDX-License-Identifier: Apache-2.0
/**
 * panoPlusAndroidArm — WHAT THE pano+ SURFACE MAY SAY AND SEND ON ANDROID.
 *
 * The engine is platform-free on purpose (`cpp/rnis_pano.*` links into the NDK
 * build and has replayed an operator sweep on this exact phone). What is NOT
 * platform-free is the ARM: the two producers that feed the engine, and the
 * precondition each one carries. Those differ between the platforms in ways
 * that are facts about the operating systems, not preferences:
 *
 *   ── THE BASIS `C` ────────────────────────────────────────────────────────
 *   iOS must MEASURE it (Apple documents no relation between CoreMotion's
 *   attitude frame and the camera raster). Android DERIVES it from two
 *   documented rotations — `SENSOR_ORIENTATION` and `LENS_FACING` — inside its
 *   own recorder. See {@link panoPlusBasisCapability}, which already states
 *   this asymmetry as data; this module is what ACTS on it for the arm notice.
 *
 *   ── τ, THE CAMERA↔IMU TIME OFFSET ────────────────────────────────────────
 *   iOS measures it with a dedicated calibration stage and REFUSES to sweep
 *   without one (or with the explicit τ=0 experiment declared). Android has no
 *   τ at all: `SENSOR_INFO_TIMESTAMP_SOURCE` is REALTIME on this device, the
 *   two clocks are directly comparable, and the residual ~97 ms of camera
 *   pipeline latency is UNCORRECTED and recorded as such. That is an
 *   approximation this port knowingly ships — so the arm notice SAYS it, on
 *   every Android IMU sweep, rather than only when a flag was flipped.
 *
 *   ── THE CALIBRATION MODULE ───────────────────────────────────────────────
 *   `RNSSweepCalibration` is an iOS module. Asking it anything on Android
 *   returns `calib-unavailable`, which `panoPlusArmNotice` correctly reads as
 *   "THIS BUILD CANNOT ANSWER" and falls back to the AR arm. On iOS that is the
 *   right answer (a missing pod install). On Android it would be a LIE in the
 *   other direction: the binary is complete, the arm is present, and there is
 *   simply no iOS calibration store because Android needs none. A platform that
 *   never has to be calibrated must not be reported as uncalibrated.
 *
 * ── WHY A SECOND NOTICE FUNCTION AND NOT A BRANCH INSIDE THE FIRST ──────────
 *
 * This codebase's rule against a second copy of a policy is about DUPLICATION
 * — two spellings of one decision that drift. This is not that: every rung of
 * `panoPlusArmNotice`'s ladder (planned AVCaptureDevice format, stored τ under
 * a format key, a measured basis index, the gesture) is a question Android does
 * not ask. Threading a platform flag through five positional parameters and
 * short-circuiting four of the five branches would leave one function whose
 * body is two functions, and would put a live Android regression one careless
 * edit away from every iOS branch. The two produce the SAME
 * {@link PanoPlusArmNotice} shape, so everything downstream of the notice —
 * the banner, the button label, the effective arm reported to the host's pill,
 * the arm latched into the pack — stays exactly one code path.
 *
 * PURE, and for the same reason its iOS twin is: every interesting state here
 * is a device state that cannot be produced on this machine.
 */

import type { PanoPlusArmNotice } from './panoPlusModel';
import type { PanoPlusBasisResolution } from './panoPlusBasisAcquisition';
import type { PanoPlusPackOptions, PanoPlusPoseSource } from './panoPlusTypes';

// ════════════════════════════════════════════════════════════════════════
//  1.  WHICH ARM CONTRACT THIS RUNTIME IS ON
// ════════════════════════════════════════════════════════════════════════

/**
 * The arm contract, as DATA rather than as an `if (Platform.OS === …)` in the
 * component — the same discipline {@link panoPlusBasisCapability} follows, and
 * for the same reason: an asymmetry spelled in JSX is one no test can read.
 *
 * `ios-coremotion` is the DEFAULT for every unrecognised OS, deliberately. It
 * is the shipped path, and its precondition read degrades honestly on a
 * platform that carries no calibration module (`calib-unavailable` ⇒ an
 * announced fallback to the AR arm). Defaulting an unknown OS to the Android
 * contract would instead have it claim a derived basis that nothing derived.
 */
export type PanoPlusArmContract = 'ios-coremotion' | 'android-sensor';

export function panoPlusArmContract(os: string): PanoPlusArmContract {
  return os === 'android' ? 'android-sensor' : 'ios-coremotion';
}

/**
 * The AR session's name on this contract, so one string does not have to be
 * written twice and get out of step with the platform it is describing.
 *
 * It is not cosmetic. "ARKit is DOWN by design" on an Android screen reads as a
 * message meant for a different phone, and an operator who cannot trust the
 * words on the diagnostic surface stops reading them — which is how the one
 * failure that leaves no trace in the pixels (a sweep believed to be on the
 * other arm) gets past him.
 */
export function panoPlusArSessionName(c: PanoPlusArmContract): string {
  return c === 'android-sensor' ? 'ARCore' : 'ARKit';
}

// ════════════════════════════════════════════════════════════════════════
//  2.  THE UNAVAILABLE CARD — true on BOTH platforms, specific on each
// ════════════════════════════════════════════════════════════════════════

/**
 * Why `NativeModules.RNSSweepSession` is absent, and WHERE the fix is.
 *
 * ⚠ THE OLD COPY SAID "iOS-only", AND ON 2026-09-02 THAT BECAME THE BUG. It was
 * true while the session module existed only in the pod; once the Android live
 * module is registered the same sentence tells an operator holding a working
 * Android build that his feature does not exist on his phone — and he believes
 * it, because the card is the only thing on the screen. A message that was
 * accurate and is now stale is worse than no message: it is evidence pointing
 * the wrong way.
 *
 * The card renders ONLY when the module is genuinely missing, so both strings
 * below are refusals. What differs is the artefact that has to be rebuilt, and
 * naming the wrong one costs a build cycle.
 */
export function panoPlusUnavailableDetail(os: string): string {
  if (panoPlusArmContract(os) === 'android-sensor') {
    return (
      'The RNSSweepSession native module is not registered in this binary. '
      + 'On Android the sweep session lives in the react-native-image-stitcher '
      + 'Gradle module, registered by RNImageStitcherPackage — an APK built '
      + 'before the live arm landed, or one whose libimage_stitcher_panoplus.so did not '
      + 'relink, reads exactly this. The recorder-and-replay tools are a '
      + 'separate module and may still work.'
    );
  }
  return (
    'The RNSSweepSession native module is not registered in this binary. '
    + 'On iOS the sweep session lives in the react-native-image-stitcher '
    + 'pod — an app built before the pod landed reads exactly this.'
  );
}

// ════════════════════════════════════════════════════════════════════════
//  3.  THE ANDROID SESSION'S MEMORY BUDGET
// ════════════════════════════════════════════════════════════════════════

/**
 * THE LIVE PREVIEW BOX, ANDROID. Native default is 2000 x 800; this is 1200 x
 * 480, and it is a MEMORY decision rather than a visual one.
 *
 * RN Android renders the preview through Fresco, which keys its bitmap memory
 * cache by the FULL URI — query string included. The preview is cache-busted
 * with `?v=<previewSeq>`, so every publish is a new cache entry rather than a
 * replacement, and the LRU holds them. At the native box that is 2000 x 800 x
 * 4 B = 6.4 MB of ARGB_8888 per tick; at ~4 ticks a second on a phone this
 * programme has already measured at 733 MB RSS idle and 1.33 GB peak, the churn
 * is the problem and not the steady state.
 *
 * 1200 x 480 is 2.3 MB per bitmap and is still roughly 3x the device pixels of
 * the panel it is drawn into, so the cost is preview sharpness at maximum zoom
 * and nothing else. THE CANVAS IS UNTOUCHED: this box sizes only the JPEG the
 * engine publishes for the screen, never the panorama that is saved.
 *
 * ⚠ SENT AS A DEFAULT, NOT A POLICY — `packOptions` still overrides it, exactly
 * like `previewWindowCrossMult`. A host measuring the Fresco cost needs to be
 * able to put the native numbers back without a rebuild.
 */
export const PANO_PLUS_ANDROID_PREVIEW_MAX_ALONG = 1200;
export const PANO_PLUS_ANDROID_PREVIEW_MAX_CROSS = 480;

/**
 * THE CANVAS CAP, ANDROID. Native default is 18e6 px (~72 MB across canvas +
 * coverage, and ~126 MB transiently while a grow reallocates); this is 8e6
 * (~32 MB steady, ~56 MB transient).
 *
 * The number is chosen from the evidence rather than from caution: the
 * operator's own A35 sweep — the one whose replay produced a clean 986 x 1470
 * panorama — ended at a 2048 x 1216 canvas, i.e. 2.5e6 px. 8e6 is more than
 * three times the largest sweep this phone has actually recorded, and it keeps
 * the transient reallocation off a process that has been measured at 1.33 GB.
 *
 * ⚠ IT IS A REFUSAL, NOT A CROP, AND THE PACK SAYS SO. Growth past the cap
 * surfaces as `canvas-full` along the sweep axis and as reported clipping
 * across it — so a sweep that outgrows this reports it in `meta.json` instead
 * of silently losing shelf. If the operator's real racks need more, the
 * evidence for raising it arrives in the pack rather than as a guess.
 */
export const PANO_PLUS_ANDROID_CANVAS_MAX_PIXELS = 8.0e6;

/**
 * The Android session defaults, as one bag the surface spreads BEFORE
 * `engineOptions` / `packOptions` so every one of them stays overridable.
 *
 * Empty on the iOS contract — byte-for-byte, so the shipped surface sends
 * exactly the bag it always sent. That is a property of the code here rather
 * than a claim in a comment, and it is what the render suite pins.
 */
export function panoPlusArmSessionDefaults(
  c: PanoPlusArmContract,
): PanoPlusPackOptions & { canvasMaxPixels?: number } {
  if (c !== 'android-sensor') return {};
  return {
    previewMaxAlong: PANO_PLUS_ANDROID_PREVIEW_MAX_ALONG,
    previewMaxCross: PANO_PLUS_ANDROID_PREVIEW_MAX_CROSS,
    canvasMaxPixels: PANO_PLUS_ANDROID_CANVAS_MAX_PIXELS,
  };
}

// ════════════════════════════════════════════════════════════════════════
//  4.  THE ARM NOTICE
// ════════════════════════════════════════════════════════════════════════

/**
 * The τ sentence, written once because it is true on every Android IMU sweep
 * and a second phrasing of it would be a second claim about the same
 * approximation.
 */
const TAU_SENTENCE =
  'τ IS 0 AND UNCORRECTED on this platform: the camera and IMU clocks are '
  + 'directly comparable here (SENSOR_INFO_TIMESTAMP_SOURCE = REALTIME, so no '
  + 'calibration stage exists), but the ~97 ms of camera pipeline latency is '
  + 'not compensated. That is a recorded approximation, not a bug — the pack '
  + 'carries tauProvenance: uncorrected.';

export interface PanoPlusAndroidArmInput {
  poseSource: PanoPlusPoseSource;
  /**
   * Is the live session module (`RNSSweepSession`) registered in THIS
   * binary? The Android equivalent of the `plan` argument's build question.
   *
   * ⚠ NOT the same as "the app has the pano+ Android panel". The recorder /
   * probe / replay module (`RNSSweepTools`) is a DIFFERENT
   * registration and can be present while the live one is not — that is
   * precisely the state this port started from.
   */
  liveModule: boolean;
  /**
   * Where `C` comes from on this device, as {@link resolvePanoPlusBasis}
   * answered it. On Android the expected route is `derived`; `stored` is
   * reachable and RANKS HIGHER, because a `selectBasis()` measurement against a
   * concurrent ARCore reference log is evidence and the derivation is a
   * hypothesis about the sensor mounting.
   */
  basis: PanoPlusBasisResolution;
  /**
   * M2 — can ARCore run on this phone (`RNSARSession.isSupported()`)? `null`
   * while the one-shot probe is in flight. The AR arm has NO fallback since
   * M2 (it runs only on the stitcher's ARCore session), so an ARCore that
   * cannot run is a named refusal, and the AR view is not mounted until this
   * says yes (mounting it on an unsupported phone is a black view that never
   * delivers a frame).
   */
  arcoreAvailable?: boolean | null;
}

/**
 * What the operator is told about the selected arm on Android, before the tap.
 *
 * Same contract as {@link panoPlusArmNotice}: `canStart` is the only field a
 * caller may gate on, `effectivePoseSource` is the arm that will ACTUALLY run,
 * and `fallbackToAr` is an announced downgrade rather than a silent one.
 */
export function panoPlusAndroidArmNotice(
  i: PanoPlusAndroidArmInput,
): PanoPlusArmNotice {
  /**
   * A rung that cannot paint. `canStart` is FALSE and the control STAYS.
   *
   * ⚠ STILL NOT AN AUTOMATIC UPGRADE TO THE AR ARM, EVEN NOW THAT ONE EXISTS.
   * The iOS twin answers `effectivePoseSource: 'ar'` with the label "Sweep on
   * ARKit instead", because there the fallback costs nothing the operator did
   * not already have. Here it costs the ultra-wide, the AE lock and half the
   * pose rate, and it can still refuse at open — so a silent upgrade would
   * hand him a 69.7° banded canvas he never chose. These rungs REFUSE, name
   * the AR arm in prose, and leave taking it as a tap on the pill.
   *
   * A state with no primary button is a state the operator cannot leave except
   * backwards, and this refusal is about the picture rather than about safety:
   * the pack is still written and is still evidence. Without `C` the attitude
   * map is inactive (`qSource: "none"`, q identity on every row), so the engine
   * sees no rotation, never advances, and paints nothing.
   */
  const fellBack = (headline: string, detail: string): PanoPlusArmNotice => ({
    tone: 'stop',
    headline,
    detail,
    // FALSE, and it is the one field a caller is allowed to gate on. Nothing in
    // the shipped surface reads it today, so this is a truthful record rather
    // than a behaviour change — see the arm-notice suite, which pins it.
    canStart: false,
    effectivePoseSource: 'imu',
    fallbackToAr: false,
    startLabel: 'Start anyway — expect no canvas',
  });

  // ── THE BUILD ───────────────────────────────────────────────────────────
  // FIRST, and above the arm fork: a missing session module refuses BOTH arms,
  // so answering the AR rung here would describe an ARCore sweep in a binary
  // that cannot open a sweep at all. Near-unreachable from the surface (a
  // missing live module renders the unavailable card instead of this banner)
  // and written out anyway: this function is also the answer a host asking
  // about the arm gets, and a table with a hole in it is a table that answers
  // `undefined` one refactor later.
  if (!i.liveModule) {
    return fellBack(
      'IMU ARM — THIS BUILD CARRIES NO pano+ SESSION',
      'RNSSweepSession is not registered in this APK, so neither arm can '
      + 'open a session here. That is an app-build fact — nothing on this '
      + 'phone can change it.',
    );
  }

  // ── THE AR PILL ON ANDROID ──────────────────────────────────────────────
  //
  // Since M2 the AR arm is the stitcher's own ARCore session (RNSARSession)
  // feeding the engine through PanoPlusArFramePlugin; pano+ opens no ARCore
  // and no camera of its own for it. The copy must not promise what the arm
  // cannot do: there is no IMU fallback (an ARCore that cannot run is a named
  // refusal), no exposure lock (a normal ARCore session exposes none), and no
  // 0.5× (ARCore chooses the camera). And it must not claim the basis problem
  // applies — `Camera.getPose()` is already in the engine's convention, so
  // this rung sits ABOVE the basis rungs.
  if (i.poseSource === 'ar') {
    if (i.arcoreAvailable === false) {
      // A NAMED REFUSAL, not a silent loss. Before M2 the recorder fell back
      // to the IMU on its own Camera2 client; the AR-plugin arm cannot.
      return {
        tone: 'stop',
        headline: 'AR ARM — ARCore CANNOT RUN ON THIS PHONE',
        detail:
          'The AR sweep runs on ARCore, and ARCore is not supported here, or '
          + 'Google Play Services for AR is missing or too old. Turn AR off to '
          + 'sweep on the phone\u2019s motion sensors instead.',
        canStart: false,
        effectivePoseSource: 'imu',
        fallbackToAr: false,
        startLabel: 'Start sweep (ARCore unavailable)',
      };
    }
    return {
      // `warn`, not `ok`: the arm is real and so are its costs.
      tone: 'warn',
      headline: i.arcoreAvailable == null
        ? 'AR ARM — CHECKING ARCore\u2026'
        : 'AR ARM — THE STITCHER\u2019S ARCore SESSION, NO ULTRA-WIDE, NO AE LOCK',
      detail:
        'The sweep runs on the same ARCore session the AR view shows (the '
        + 'stitcher\u2019s), and each frame arrives with the pose it was taken at '
        + '\u2014 no pose ring, no bracket wait, no basis: Camera.getPose() is '
        + 'already in the engine\u2019s own convention. WHAT IT COSTS: ARCore '
        + 'picks the camera and the image size, so the 0.5\u00d7 ultra-wide is '
        + 'NOT available on this arm; and an ARCore session exposes no exposure '
        + 'lock, so the exposure is measured per frame (not held) and banding is '
        + 'more likely than on a locked sweep. There is NO fallback: if ARCore '
        + 'delivers no frames, the sweep paints nothing and the pack\u2019s '
        + 'arPlugin counters say so.',
      // Not until the probe has answered: a hold before then could arm a
      // plugin no frame will reach.
      canStart: i.arcoreAvailable === true,
      effectivePoseSource: 'ar',
      fallbackToAr: false,
      // NO τ CHIP ON THIS ARM: ARCore's pose and the frame come from the same
      // capture, so there is no camera↔IMU offset in the pose path.
      startLabel: 'Start sweep (ARCore)',
    };
  }

  // ── THE BASIS ───────────────────────────────────────────────────────────
  // `blocked` on Android means the derivation itself refused — the recorder
  // never read `SENSOR_ORIENTATION`, or `LENS_POSE_REFERENCE` was not
  // GYROSCOPE, or the mounting is a reflection no member of the 24-candidate
  // set can express. None of those is fixable by a gesture (Android has none)
  // and none is fixable at the shelf, so the arm falls back and says which.
  if (i.basis.route === 'blocked' || i.basis.route === 'gesture') {
    return fellBack(
      'IMU ARM — NO BASIS FOR THIS DEVICE',
      `${i.basis.detail} Without C the recorder leaves the attitude map `
      + 'INACTIVE — `qSource: "none"`, q identity on every row — so the engine '
      + 'never sees a rotation, never advances, and paints nothing. The pack is '
      + 'still written and still carries the frames. ⚠ THE AR PILL IS THE WAY '
      + 'OUT OF EXACTLY THIS STATE (2026-09-02): the ARCore arm needs no C at '
      + 'all, because Camera.getPose() is already world←camera in the '
      + 'engine\u2019s own convention. It costs the ultra-wide, the AE lock and '
      + 'half the pose rate, and it can still refuse at open — but on a phone '
      + 'with no derivable basis it is the only arm that can paint.',
    );
  }

  // ── A MEASURED BASIS BEATS A DERIVED ONE ────────────────────────────────
  // Reachable on Android through the ARCore cross-check run (`arcoreBasisRun`),
  // which is a `selectBasis()` fit against a concurrent reference log. When it
  // has produced and persisted an index, that index is EVIDENCE and the
  // derivation was a hypothesis — so the screen stops carrying the derived
  // caveat, because it no longer applies.
  if (i.basis.route === 'stored') {
    return {
      tone: 'ok',
      headline: 'IMU ARM — BASIS MEASURED ON THIS PHONE',
      detail:
        `C #${i.basis.basisIndex ?? '—'}`
        + `${i.basis.basisLabel != null ? ` ${i.basis.basisLabel}` : ''} was `
        + 'measured against a live ARCore reference and persisted for this '
        + 'model. This sweep runs on the physical camera the recorder plans, '
        + 'with AE/AWB locked after a settle poll and ARCore down. '
        + TAU_SENTENCE,
      canStart: true,
      effectivePoseSource: 'imu',
      fallbackToAr: false,
      // NOT a τ=0 EXPERIMENT the way iOS means it: uncorrected τ is the only
      // mode this platform has, so the chip is a standing statement of fact
      // about every Android IMU sweep rather than a declaration the operator
      // made. The label says the arm; the chip and this detail say the τ.
      tauUncorrectedRun: true,
      startLabel: 'Start sweep (IMU)',
    };
  }

  // ── DERIVED, WHICH IS THE ORDINARY ANDROID CASE ─────────────────────────
  //
  // ⚠ `warn`, NOT `ok`, AND THAT IS THE WHOLE POINT OF THIS BRANCH. The
  // derivation is a HYPOTHESIS about how the sensor is bolted into this
  // chassis, computed from two documented rotations and never checked against
  // anything on this device — the falsification instrument exists
  // (`arcoreBasisRun`) and REFUSED on the only run attempted, reporting
  // `excitation-insufficient` with ARCore calling INSUFFICIENT_LIGHT on 790 of
  // 850 poses. So no basis has been measured on this phone, and the honest
  // screen says `derived` in the same words the pack does.
  //
  // The failure mode is LOUD rather than silent — a wrong C rotates the canvas
  // visibly, immediately, on the first sweep — which is why the arm is offered
  // at all rather than blocked. Naming the provenance here is what makes that
  // rotation attributable in one glance instead of becoming a two-day hunt.
  return {
    tone: 'warn',
    headline: 'IMU ARM — BASIS DERIVED, NEVER MEASURED',
    detail:
      'C is computed from SENSOR_ORIENTATION and LENS_FACING — two documented '
      + 'rotations — so no gesture and no calibration trip is needed. It has '
      + 'NOT been checked against a reference on this phone: the ARCore '
      + 'cross-check refused (excitation-insufficient, INSUFFICIENT_LIGHT on '
      + '790 of 850 poses), so the pack stamps `derived` and never `measured`. '
      + 'If the derivation is wrong the whole canvas comes out rotated — '
      + 'visibly, on the first sweep. ⚠ THE AR PILL IS A WAY OUT OF THIS ONE '
      + '(2026-09-02): the ARCore arm uses no basis at all, so a wrong C '
      + 'cannot reach its canvas — at the price of the ultra-wide, the AE lock '
      + 'and half the pose rate. Tap AR to read what that trade is. '
      + TAU_SENTENCE,
    canStart: true,
    effectivePoseSource: 'imu',
    fallbackToAr: false,
    tauUncorrectedRun: true,
    startLabel: 'Start sweep (IMU · τ=0)',
  };
}

