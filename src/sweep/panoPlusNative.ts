// SPDX-License-Identifier: Apache-2.0
/**
 * panoPlusNative — null-guarded access to the `RNSSweepSession` RN module
 * (`ios/PanoPlus/PanoPlusBridge.{swift,m}`).
 *
 * Degradation contract, same as `video/nativeModules.ts` and `liveness.ts`:
 * a build without the private pod (Android, SDK-standalone jest, a host that
 * does not carry the native half) resolves to null and the pano+
 * surface renders its "unavailable" state — NEVER a crash.
 *
 * Resolution is per-CALL, not per-import, so a test that assigns
 * `NativeModules.RNSSweepSession` after import behaves like a real registry
 * (the `stitchPluginsModule.ts` precedent).
 *
 * ⚠️ WHY THIS IS ITS OWN MODULE AND NOT MORE METHODS ON
 * `HostStitchPlugins`: pano+ is a capture SESSION with a lifecycle
 * (start → many frames → stop), while that module's contract is "one call, one
 * render". A separate name also makes the availability probe a plain
 * `typeof NativeModules.RNSSweepSession?.start === 'function'` — no platform
 * branch, which is this codebase's standing rule for native probes.
 */

import { NativeModules } from 'react-native';

import { coercePanoPlusStatus, coercePanoPlusSummary } from './panoPlusModel';
import type {
  PanoPlusStartOptions,
  PanoPlusStarted,
  PanoPlusStatus,
  PanoPlusSummary,
} from './panoPlusTypes';

/**
 * ── DUAL-NAME ACCEPTANCE ────────────────────────────────────────────────
 * pano+ is moving out of the private native overlay and into the public
 * stitcher package, and its React Native identifiers are being renamed on
 * the way (`the host app*` -> `RNSSweep*`).  There is no atomic commit across
 * two npm packages, so this SDK accepts BOTH spellings: the new name first,
 * the old one as a fallback.  That makes every later native rename invisible
 * here, and it means a device can run an old binary against new JS or the
 * reverse without a coordinated release.
 *
 * Delete the legacy branch once no supported binary predates the rename.
 */
/** The RN module name declared by `RCT_EXTERN_MODULE(RNSSweepSession, …)`. */
const MODULE_NAME = 'RNSSweepSession';
/** The pre-migration spelling. */
const LEGACY_MODULE_NAME = 'RNISPanoPlus';

interface PanoPlusModule {
  start(options: Record<string, unknown>): Promise<unknown>;
  stop(): Promise<unknown>;
  cancel(): Promise<unknown>;
  getStatus(): Promise<unknown>;
  /** v12 — optional: absent on builds older than the idle-viewfinder cut. */
  setIdlePreview?(on: boolean, options: Record<string, unknown>): Promise<unknown>;
}

function looksLikeTheModule(native: unknown): native is PanoPlusModule {
  return (
    native != null
    && typeof native === 'object'
    && typeof (native as Record<string, unknown>).start === 'function'
    && typeof (native as Record<string, unknown>).stop === 'function'
    && typeof (native as Record<string, unknown>).cancel === 'function'
  );
}

function getModule(): PanoPlusModule | null {
  const mods = NativeModules as Record<string, unknown>;
  for (const name of [MODULE_NAME, LEGACY_MODULE_NAME]) {
    const native = mods[name];
    if (looksLikeTheModule(native)) return native;
  }
  return null;
}

/** True when this binary carries the pano+ session module. */
export function panoPlusIsAvailable(): boolean {
  return getModule() != null;
}

/**
 * M5 — can this binary run a sweep on `<Camera>`'s own vision-camera camera?
 *
 * Android: the live module has taken the plugin arm since S5 (a build without
 * the plugin is refused by the plugin acquisition instead). iOS: the native
 * module must SAY so — `vcArmSupported`, exported since M5 — because an older
 * iOS binary IGNORES `vcPluginArm` and opens its own `AVCaptureSession` behind
 * the preview. So an absent answer is NO, and the hold is refused by name.
 */
export function panoPlusVcArmSupported(platformOS: string): boolean {
  if (platformOS === 'android') return true;
  const m = getModule() as unknown as
    | { vcArmSupported?: unknown; getConstants?: () => unknown }
    | null;
  if (m == null) return false;
  if (m.vcArmSupported === true) return true;
  if (typeof m.getConstants === 'function') {
    try {
      const c = m.getConstants() as { vcArmSupported?: unknown } | null;
      return c?.vcArmSupported === true;
    } catch {
      return false;
    }
  }
  return false;
}

/** Thrown (as a rejection) when the module is absent, with the same `code`
 *  shape a native rejection carries so ONE `panoPlusErrorInfo` handles both. */
function unavailable(): Error & { code: string } {
  const e = new Error(
    `pano+ is not available in this build (neither NativeModules.${MODULE_NAME} `
    + `nor NativeModules.${LEGACY_MODULE_NAME} is registered).`,
  ) as Error & { code: string };
  e.code = 'panoplus-unavailable';
  return e;
}

/**
 * Begin a sweep.
 *
 * ⚠️ `sessionDir` MUST be a plain absolute path, never a `file://` URI — use
 * `barePath()` from panoPlusModel. Native calls
 * `NSFileManager createDirectoryAtPath:`, which would create a literal `file:`
 * directory from a URI and report success.
 *
 * The engine starts DROPPING frames on the floor until this resolves — the
 * plugin is registered by native only after the engine is configured, so
 * ordering is native's problem, not the caller's. But the caller MUST have the
 * AR session live (an `<ARCameraView>` mounted) or no frame ever arrives and
 * `stop()` will reject `panoplus-not-running`.
 *
 * ⚠ ANDROID, SINCE M3: a live IMU start (the Android default `poseSource`)
 * needs a camera arm — `vcPluginArm` + `vcCameraId` when `<Camera>`'s
 * vision-camera owns the camera, or `allowOwnCamera: true` when the caller
 * wants pano+'s own camera. With neither it is refused with
 * `live-sweep-without-camera` rather than opening a second camera.
 */
export function startPanoPlus(
  options: PanoPlusStartOptions,
): Promise<PanoPlusStarted> {
  const mod = getModule();
  if (mod == null) return Promise.reject(unavailable());
  // Strip `undefined` values before the bag crosses the bridge.
  //
  // HONEST SCOPE, because the obvious story is the wrong one: today's native
  // helpers (`numOr` / `boolOr` / `strOr` in RNISPanoCore.mm) all guard with
  // `isKindOfClass:`, so an `undefined` that RN bridges to NSNull ALREADY falls
  // back to the C++ default. This strip is therefore not fixing a live bug. It
  // is here because the alternative is depending on that null-tolerance from
  // the JS side, where it is invisible — a future helper written as a plain
  // `[v doubleValue]` (which NSNull answers with 0) would silently run the
  // engine at `stripMargin: 0`, and nothing in JS would look different. Sending
  // only keys the caller actually chose also keeps the intent legible: what
  // crosses is what was asked for, and everything else is native's default.
  const clean: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(options)) {
    if (v !== undefined) clean[k] = v;
  }
  return mod.start(clean).then((raw) => {
    const r = (raw ?? {}) as Record<string, unknown>;
    return {
      sessionDir:
        typeof r.sessionDir === 'string' ? r.sessionDir : options.sessionDir,
      startedAtMs: typeof r.startedAtMs === 'number' ? r.startedAtMs : Date.now(),
      pluginAvailable: r.pluginAvailable === true,
      // ── WHICH ARM NATIVE STARTED ────────────────────────────────────────
      // Native answers this on BOTH branches, and until 2026-08-31 this mapper
      // dropped it on the floor along with `cameraLock`'s neighbours. A dropped
      // key is not a neutral omission here: the only way a wrong arm shows up
      // is in a field nobody kept, because the two arms paint pixels that look
      // identical.
      //
      // NARROWED, not passed through: an unrecognised string is left
      // `undefined` rather than widened into the union, so a native build that
      // one day answers something new cannot make the result CLAIM an arm the
      // types promise.
      ...(r.poseSource === 'ar' || r.poseSource === 'imu'
        ? { poseSource: r.poseSource }
        : {}),
      ...(r.avfSource != null && typeof r.avfSource === 'object'
        ? { avfSource: r.avfSource as Record<string, unknown> }
        : {}),
      // ── M5: WHICH CAMERA FED IT ─────────────────────────────────────────
      // Kept, because the iOS host arm FAILS CLOSED on its absence: a binary
      // that does not say `'vc-plugin'` opened a camera of its own. Dropping
      // it here would cancel every real sweep on that arm.
      ...(typeof r.frameSource === 'string' ? { frameSource: r.frameSource } : {}),
      ...(typeof r.opensAvCaptureSession === 'boolean'
        ? { opensAvCaptureSession: r.opensAvCaptureSession }
        : {}),
      ...(r.vcArm != null && typeof r.vcArm === 'object'
        ? { vcArm: r.vcArm as Record<string, unknown> }
        : {}),
      ...(r.cameraLock != null && typeof r.cameraLock === 'object'
        ? { cameraLock: r.cameraLock as PanoPlusStarted['cameraLock'] }
        : {}),
    };
  });
}

/**
 * Finish the sweep: drain, tail-flush, write `canvas.jpg` + `meta.json`, and
 * resolve the summary.
 *
 * REJECTS ARE EVIDENCE. On `panoplus-empty` the original NSError crosses the
 * bridge, so `error.userInfo` carries `sessionDir` + `counts` + `abort` — read
 * them with `panoPlusErrorInfo`, never discard the rejection.
 */
export function stopPanoPlus(): Promise<PanoPlusSummary> {
  const mod = getModule();
  if (mod == null) return Promise.reject(unavailable());
  return mod.stop().then((raw) => coercePanoPlusSummary(raw));
}

/**
 * Abandon the sweep and DELETE its session directory. Always resolves — a
 * cancel that could fail would leave the native session latched, and the next
 * `start()` would reject `panoplus-busy` for the rest of the app's life.
 */
export function cancelPanoPlus(): Promise<void> {
  const mod = getModule();
  if (mod == null) return Promise.resolve();
  return mod.cancel().then(
    () => undefined,
    () => undefined,
  );
}

/**
 * v12 — the decoupled arm's idle viewfinder. `true` runs the arm's own
 * AVCaptureSession input-only so `PanoPlusSourceView` shows a live feed
 * BEFORE the sweep; `false` releases the camera. Serialized with start/stop
 * on the module's method queue natively. Never rejects; resolves `false` on
 * a build without the method, when ARKit holds the camera, or when the open
 * fails.
 *
 * On ANDROID it opens `PanoPlusIdlePreviewSession` — a device, a surface and a
 * repeating request — on BOTH arms. ARCore is not up at idle on either one, so
 * there is nothing to contend with; the recorder takes the camera back inside
 * `start()`, which waits for this session's `onClosed` before it opens
 * anything.
 *
 * Never rejects. `on: false` always carries a `reason` the panel can render.
 */
export interface PanoPlusIdlePreviewResult {
  /** Whether there is a live feed. */
  on: boolean;
  /**
   * WHY, in native's own words, or `''` when this build does not say.
   *
   * ⚠ THIS USED TO BE THROWN AWAY, AND THAT IS HOW THE SCREEN LIED. Native has
   * always answered `{on, reason}` and the SDK read only `on`, so the surface
   * knew a feed had failed but never why — and filled the gap with prose
   * written from the ARM ("ARCore is UP, inside the sweep's own camera
   * session") rather than from the failure. On 2026-09-03 that prose was
   * printed at idle, on a phone where ARCore was NOT up and nothing held the
   * camera. A reason the operator can read is the whole difference between a
   * black screen that looks broken and one that reports itself.
   */
  reason: string;
  /**
   * pano+ ⇄ Pano parity (2026-09-03) — THE LENS THAT IS LIVE, in native's
   * own words: on iOS the `AVCaptureDevice.DeviceType` raw value of the
   * device the idle input was built on; null when there is no feed, or on a
   * build that predates the field. The viewfinder note can then say which
   * camera the operator is framing through instead of inferring it from the
   * request.
   */
  lens: string | null;
  /** The request native honoured, in the flag's spelling (`ultraWide` |
   *  `wide`); null when absent. Beside `lens` so a mismatch is readable. */
  lensRequested: string | null;
  /**
   * DID THE VIEWFINDER GET THE SWEEP'S FRAME RATE — `true` pinned, `false`
   * declined, `null` when this build does not say.
   *
   * ⚠ THE THREE-STATE IS THE CONTRACT, AND FLATTENING IT TO A BOOLEAN WOULD
   * INVENT A FAULT. Android answers the flag on every path since 2026-09-07
   * (`PanoPlusLiveModule.kt:932`), computed by
   * `PanoPlusIdlePreviewSession.planFpsRange`/`configure`; every binary older
   * than that, and every iOS build (which reports {@link previewFormatApplied}
   * instead), answers nothing at all. `false` means native tried and the
   * viewfinder is running at a rate the sweep will not — which the panel
   * SHOUTS about. `null` is silence, and silence is not evidence.
   */
  previewFpsApplied: boolean | null;
  /**
   * iOS'S ANSWER TO THE SAME QUESTION, UNDER ITS OWN NAME — `true` the
   * viewfinder got the sweep's format AND rate, `false` it did not, `null`
   * when this build does not say (every Android build; every iOS build before
   * 2026-09-07).
   *
   * ⚠ IT IS ONE FLAG BECAUSE IT IS ONE LOCK. `RNISPanoAvfSource` sets
   * `activeFormat` and both frame durations inside a single
   * `lockForConfiguration()` `do` block (`RNISPanoAvfSource.swift:383-389`), so
   * a throw declines the format and the rate together and one boolean is the
   * honest report of it. That is why iOS has no `previewFpsApplied`: there is
   * no state where the rate took and the format did not.
   *
   * ⚠ AND THE FEED IS STILL LIVE WHEN IT IS `false`. The lock failure is
   * deliberately non-fatal at idle — the session starts anyway and native
   * returns `on: true` with "PREVIEW FORMAT NOT APPLIED (…) — this viewfinder
   * does NOT match what the sweep will record" inside `reason`
   * (`RNISPanoAvfSource.swift:394-410`). So this is exactly the case the panel
   * has to speak for, and it is the case the surface's success path throws the
   * reason away on. Until 2026-09-08 this key was never coerced here, so it
   * died at the bridge and the operator framed a 16:9 viewfinder for a 4:3
   * sweep in silence — the field incident at
   * `RNISPanoAvfSource.swift:331-345`.
   *
   * Same three-state contract as {@link previewFpsApplied}, for the same
   * reason: flattening `null` to `false` invents a fault out of a silent build.
   */
  previewFormatApplied: boolean | null;
  /** The AE target range that was REQUESTED, in Android's own `[lower,
   *  upper]` spelling; null when none was asked for or the build is silent.
   *  Beside `previewFpsApplied` for the same reason `lensRequested` sits
   *  beside `lens`: a request and its answer are only readable together. */
  previewFpsRange: string | null;
  /** Native's sentence for what happened to the rate, or `''` on a build that
   *  does not say. The words are native's because it is the only layer that
   *  knows WHICH of the four declines happened (the knob is off, the camera
   *  advertises no ranges, the preview output cannot clock the range, the HAL
   *  refused) — see `PanoPlusIdlePreview.kt:145-165`. */
  previewFpsNote: string;
}

/**
 * "NOTHING IS KNOWN ABOUT WHETHER THE VIEWFINDER MATCHES" — the answer on every
 * path that never got a report out of native: no method in this build, a bridge
 * rejection, an answer that was not an object.
 *
 * A CONSTANT rather than four copies because the three-state only works if
 * every silent path spells silence the same way. It covers BOTH platforms'
 * flags — see `previewFpsApplied` and `previewFormatApplied` — because a build
 * that says nothing says nothing under either name.
 */
const noPinReport = {
  previewFpsApplied: null,
  previewFpsRange: null,
  previewFpsNote: '',
  previewFormatApplied: null,
} as const;

export function setPanoPlusIdlePreview(
  on: boolean,
  options: Record<string, unknown> = {},
): Promise<PanoPlusIdlePreviewResult> {
  const mod = getModule();
  if (mod == null || typeof mod.setIdlePreview !== 'function') {
    return Promise.resolve({
      on: false,
      reason:
        'this build carries no pano+ idle-viewfinder method, so the camera '
        + 'cannot be opened before the sweep.',
      lens: null,
      lensRequested: null,
      ...noPinReport,
    });
  }
  const str = (x: unknown): string | null => (typeof x === 'string' ? x : null);
  return mod.setIdlePreview(on, options).then(
    (raw) => {
      if (raw != null && typeof raw === 'object') {
        const r = raw as Record<string, unknown>;
        return {
          on: typeof r.on === 'boolean' ? r.on : false,
          reason: typeof r.reason === 'string' ? r.reason : '',
          lens: str(r.lens),
          lensRequested: str(r.lensRequested),
          // ⚠ COERCED FIELD BY FIELD, WHICH IS WHY THESE THREE HAD TO BE
          // NAMED HERE OR DIE HERE. This function builds a fresh object and
          // drops every key it does not mention, so a report native has
          // computed since 2026-09-07 reached the bridge and went no further:
          // built, wired, tested natively, and unreachable from the screen.
          // The boolean stays a THREE-STATE on the way through — see
          // `previewFpsApplied`.
          previewFpsApplied:
            typeof r.previewFpsApplied === 'boolean' ? r.previewFpsApplied : null,
          previewFpsRange: str(r.previewFpsRange),
          previewFpsNote:
            typeof r.previewFpsNote === 'string' ? r.previewFpsNote : '',
          // ⚠ THE FOURTH KEY, AND THE ONE THAT MADE THE OTHER THREE HALF A
          // FIX. iOS reports the identical fault as `previewFormatApplied`
          // (`RNISPanoAvfSource.swift:407`) because it pins format and rate
          // under one lock. It was not named here, so it died exactly the way
          // the three above did before 2026-09-07 — and on the ONE platform
          // where native also writes the operator's sentence and the surface
          // then clears it on the success path. Coerced to the SAME
          // three-state; never folded into `previewFpsApplied`, because a
          // silent Android build and a declining iOS build are different
          // facts.
          previewFormatApplied:
            typeof r.previewFormatApplied === 'boolean'
              ? r.previewFormatApplied
              : null,
        };
      }
      return {
        on: false, reason: '', lens: null, lensRequested: null, ...noPinReport,
      };
    },
    (e: unknown) => ({
      on: false,
      // A REJECTION IS NOT A REFUSAL, and the two must not read alike: native
      // resolves `{on:false}` when it decided not to open, and rejects only
      // when the bridge itself failed. Naming it keeps a wiring fault from
      // being read as a camera that is merely busy.
      reason:
        'the idle-viewfinder call failed at the bridge '
        + `(${e instanceof Error ? e.message : String(e)}).`,
      lens: null,
      lensRequested: null,
      // A CALL THAT NEVER REACHED NATIVE KNOWS NOTHING ABOUT THE RATE. Not
      // `false`: there is no viewfinder to accuse of running at the wrong one.
      ...noPinReport,
    }),
  );
}

/** Poll fallback for the live status. The PRIMARY channel is the AR plugin's
 *  sync return riding `onArFrame.plugins['sweep']`; this exists for
 *  hosts that are not mounting the AR meta callback, and as a liveness probe. */
export function getPanoPlusStatus(): Promise<PanoPlusStatus | null> {
  const mod = getModule();
  if (mod == null) return Promise.resolve(null);
  return mod.getStatus().then(
    (raw) => coercePanoPlusStatus(raw),
    () => null,
  );
}
