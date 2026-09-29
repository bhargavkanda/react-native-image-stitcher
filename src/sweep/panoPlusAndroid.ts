// SPDX-License-Identifier: Apache-2.0
/**
 * panoPlusAndroid — null-guarded access to the `RNSSweepTools` RN
 * module (`PanoPlusAndroidModule.kt`).
 *
 * Degradation contract, same as `panoPlusNative.ts` and `video/nativeModules.ts`:
 * a build without the Android module (iOS, SDK-standalone jest, a host that did
 * not carry the native half) resolves to null and the caller
 * renders its "Android only" state — NEVER a crash.
 *
 * Resolution is per-CALL, not per-import, so a test that assigns
 * `NativeModules.RNSSweepTools` after import behaves like a real
 * registry (the `stitchPluginsModule.ts` / `panoPlusNative.ts` precedent).
 *
 * ⚠️ THE MODULE NAME IS DELIBERATELY NOT iOS's. iOS registers
 * `RNSSweepSession`, a LIVE capture session (start → frames → stop). This is
 * `RNSSweepTools`, a pack RECORDER plus an offline REPLAY driver.
 * They are different surfaces with different methods, and sharing a name would
 * make `panoPlusIsAvailable()` mean two incompatible things by platform.
 *
 * ── WHY EVERY RESULT CARRIES A RAW `json` STRING ────────────────────────────
 *
 * The three native entries return one hand-rolled JSON string produced by C++
 * that the host gtest suite pins byte-for-byte (`rnis_pano_replay::reportToJson`,
 * `rnis_pano_android_report::basisReportToJson`). This module parses it and
 * narrows the few fields the panel needs — but it also passes the ORIGINAL
 * string through untouched.
 *
 * That is not redundancy. The reports carry ~70 fields between them, they will
 * grow, and the operator's workflow is to pull the payload off the phone with
 * adb and read it on a desk. A typed mapper that silently dropped everything it
 * did not know about would make this port's only instrument report less than it
 * measured — and the dropped field is always the one that mattered (the
 * `poseSource` incident in `panoPlusNative.ts` is the same mistake, already
 * paid for once in this file's sibling).
 *
 * ── NOTHING HERE THROWS ─────────────────────────────────────────────────────
 *
 * Native never rejects these three (it returns `{ok:false,error}` payloads),
 * and the wrappers convert a bridge-level rejection or an unparseable string
 * into the same shape. A diagnostic panel that can crash is a diagnostic that
 * is unavailable exactly when it is needed.
 */

import { NativeModules, Platform } from 'react-native';

/** The RN module name declared by `PanoPlusAndroidModule.getName()`. */
const MODULE_NAME = 'RNSSweepTools';

interface PanoPlusAndroidModuleShape {
  engineInfo(): Promise<unknown>;
  deriveBasis(options: Record<string, unknown>): Promise<unknown>;
  arcoreBasisRun(options: Record<string, unknown>): Promise<unknown>;
  replayPack(options: Record<string, unknown>): Promise<unknown>;
  probe(): Promise<unknown>;
  measureSensorRates(durationMs: number): Promise<unknown>;
  startRecording(options: Record<string, unknown>): Promise<unknown>;
  stopRecording(): Promise<unknown>;
  recordingStatus(): Promise<unknown>;
}

/** Common envelope: every native entry answers `nativeAvailable` + `json`. */
export interface PanoPlusAndroidEnvelope {
  /** The `.so` loaded and the entry ran. False ⇒ read `loadError`. */
  nativeAvailable: boolean;
  /** Native's reason the `.so` or the entry was unusable. */
  loadError?: string;
  /** The raw JSON string from C++ — ALWAYS kept, never lossily re-serialised. */
  json: string;
  /** `json` parsed, or null when it did not parse. */
  parsed: Record<string, unknown> | null;
  /** Set when the wrapper itself could not complete (bridge rejection, bad JSON). */
  error?: string;
}

/** `engineInfo()`'s narrowed answers. Every field is optional: an older or
 *  partial native build must render as "not reported", never as a zero. */
export interface PanoPlusAndroidEngineInfo extends PanoPlusAndroidEnvelope {
  engineVersion?: number;
  /** A call into `rnis_pano.cpp`'s own object file — the proof the ENGINE (not
   *  merely its header) is linked into this `.so`. */
  outcomeProbe?: string;
  basisCandidateCount?: number;
  /** The derivation re-run for the configuration iOS MEASURED as basis 8. A
   *  device answering anything else has a toolchain difference the host tests
   *  cannot see, and the whole port is suspect. */
  basisSelfTestIndex?: number;
  basisSelfTestExpected?: number;
  basisSelfTestPassed?: boolean;
}

export interface PanoPlusAndroidBasisResult extends PanoPlusAndroidEnvelope {
  ok?: boolean;
  basisIndex?: number;
  basisLabel?: string;
  /** `"none"` on success. Stable, greppable, lowercase-hyphen. */
  refusal?: string;
  appliedRotationCwDeg?: number;
  residualRotationCwDeg?: number;
  /** Always `"derived"` — never `"measured"`. See the C++ header: a pack that
   *  said `measured` would certify a calibration nobody ran. */
  basisProvenance?: string;
  /** True when a `lensPoseRotation` was supplied — the difference between a
   *  REFUSED LENS_POSE block and one that was never asked for. */
  lensPoseSupplied?: boolean;
}

export interface PanoPlusAndroidReplayResult extends PanoPlusAndroidEnvelope {
  ok?: boolean;
  framesIngested?: number;
  /** Median `Engine::ingest()` wall time, ms — THE Android throughput answer.
   *  Frame decode is NOT in here (it is `loadMsTotal`): on a live capture that
   *  work belongs to the camera pipeline, and conflating them inflates every
   *  projection. */
  msP50?: number;
  msP95?: number;
  msMax?: number;
  painted?: number;
  held?: number;
  rejected?: number;
  skipped?: number;
  holes?: number;
  /** False ⇒ the pack had no ledger, so agreement was NOT MEASURED. Never read
   *  a zero disagreement count as agreement without this. */
  haveOracle?: boolean;
  outcomeAgree?: number;
  outcomeDisagree?: number;
  /** Native-call wall time including JNI marshalling and frame decode — a
   *  CEILING on engine cost, never the engine cost itself. */
  wallMs?: number;
}

function looksLikeTheModule(native: unknown): native is PanoPlusAndroidModuleShape {
  return (
    native != null
    && typeof native === 'object'
    // Per-METHOD probing: a module object existing is not evidence its methods
    // are linked (this codebase's standing typeof-probe rule).
    && typeof (native as Record<string, unknown>).engineInfo === 'function'
    && typeof (native as Record<string, unknown>).replayPack === 'function'
    && typeof (native as Record<string, unknown>).deriveBasis === 'function'
  );
}

function getModule(): PanoPlusAndroidModuleShape | null {
  // One read, and return the value the type guard narrowed. Reading the
  // proxy twice and casting throws away the guard for no reason.
  const native = (NativeModules as Record<string, unknown>)[MODULE_NAME];
  return looksLikeTheModule(native) ? native : null;
}

/** True when this binary carries the pano+ Android module. False on iOS. */
export function panoPlusAndroidIsAvailable(): boolean {
  return getModule() != null;
}

/**
 * Why the module is absent, for the panel's empty state.
 *
 * Distinguishes "wrong platform" from "Android, but the module did not
 * register" — the second is a BUILD fault (autolinking, a missing package
 * entry) and the first is expected. Rendering both as "unavailable" is how a
 * broken Android build gets mistaken for an iOS device.
 */
export function panoPlusAndroidUnavailableReason(): string | null {
  if (getModule() != null) return null;
  if (Platform.OS !== 'android') {
    return `pano+ Android is Android-only — this is ${Platform.OS}.`;
  }
  return (
    'NativeModules.RNSSweepTools is not registered on this Android '
    + 'build. Check that react-native-image-stitcher autolinked and that '
    + 'RNImageStitcherPackage lists PanoPlusAndroidModule.'
  );
}

const UNAVAILABLE_JSON = '{"ok":false,"error":"module not available"}';

function unavailableEnvelope(): PanoPlusAndroidEnvelope {
  return {
    nativeAvailable: false,
    loadError: panoPlusAndroidUnavailableReason() ?? 'module not available',
    json: UNAVAILABLE_JSON,
    parsed: null,
  };
}

function num(o: Record<string, unknown> | null, k: string): number | undefined {
  const v = o?.[k];
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function str(o: Record<string, unknown> | null, k: string): string | undefined {
  const v = o?.[k];
  return typeof v === 'string' ? v : undefined;
}

function bool(o: Record<string, unknown> | null, k: string): boolean | undefined {
  const v = o?.[k];
  return typeof v === 'boolean' ? v : undefined;
}

/** A nested object, or null. The S1 report is three levels deep and every
 *  level can be absent on a refusal path — `obj(obj(p,'report'),'agreement')`
 *  must yield undefined fields, never a TypeError in a diagnostic panel. */
function obj(
  o: Record<string, unknown> | null,
  k: string,
): Record<string, unknown> | null {
  const v = o?.[k];
  return v != null && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

/**
 * Turn a native resolve into the common envelope.
 *
 * `JSON.parse` is wrapped because it THROWS on malformed input, and the one
 * input most likely to be malformed is the one produced under memory pressure
 * — i.e. exactly when the operator most needs to see what happened. A parse
 * failure keeps the raw string and reports itself; it never propagates.
 */
function toEnvelope(raw: unknown): PanoPlusAndroidEnvelope {
  const r = (raw ?? {}) as Record<string, unknown>;
  const json = typeof r.json === 'string' ? r.json : '';
  let parsed: Record<string, unknown> | null = null;
  let error: string | undefined;
  if (json.length > 0) {
    try {
      const p: unknown = JSON.parse(json);
      if (p != null && typeof p === 'object' && !Array.isArray(p)) {
        parsed = p as Record<string, unknown>;
      } else {
        error = 'native JSON was not an object';
      }
    } catch (e) {
      error = `could not parse the native JSON: ${
        e instanceof Error ? e.message : String(e)
      }`;
    }
  } else {
    error = 'native returned no JSON';
  }
  const env: PanoPlusAndroidEnvelope = {
    nativeAvailable: r.nativeAvailable === true,
    json,
    parsed,
  };
  if (typeof r.loadError === 'string') env.loadError = r.loadError;
  if (error != null) env.error = error;
  return env;
}

/** A bridge-level rejection rendered as the same envelope, so the caller has
 *  exactly one shape to handle and a panel cannot be crashed by a reject. */
function rejectedEnvelope(e: unknown): PanoPlusAndroidEnvelope {
  const message = e instanceof Error ? e.message : String(e);
  return {
    nativeAvailable: false,
    loadError: message,
    json: UNAVAILABLE_JSON,
    parsed: null,
    error: message,
  };
}

/**
 * Is the pano+ engine in this build, and does it run on this device?
 *
 * The first thing to call: no arguments, no permission, no pack.
 */
export function panoPlusAndroidEngineInfo(): Promise<PanoPlusAndroidEngineInfo> {
  const mod = getModule();
  if (mod == null) return Promise.resolve(unavailableEnvelope());
  return mod.engineInfo().then(
    (raw) => {
      const env = toEnvelope(raw);
      const p = env.parsed;
      if (p == null) return env;
      return {
        ...env,
        engineVersion: num(p, 'engineVersion'),
        outcomeProbe: str(p, 'outcomeProbe'),
        basisCandidateCount: num(p, 'basisCandidateCount'),
        basisSelfTestIndex: num(p, 'basisSelfTestIndex'),
        basisSelfTestExpected: num(p, 'basisSelfTestExpected'),
        basisSelfTestPassed: bool(p, 'basisSelfTestPassed'),
      };
    },
    (e) => rejectedEnvelope(e),
  );
}

/** Options for {@link panoPlusAndroidDeriveBasis}. Raw Camera2 values. */
export interface PanoPlusAndroidBasisOptions {
  /**
   * `CameraCharacteristics.SENSOR_ORIENTATION`. Must be 0/90/180/270.
   *
   * ⚠️ NO DEFAULT ON PURPOSE. Omitting it means "never read", which native
   * REFUSES by name; defaulting it to 0 would turn a refusal into a plausible
   * wrong answer.
   */
  sensorOrientationDeg?: number;
  /**
   * `CameraCharacteristics.LENS_FACING` (FRONT=0, BACK=1, EXTERNAL=2).
   *
   * ⚠️ Must come from `CameraCharacteristics`, NEVER from the deprecated
   * `Camera.CameraInfo` — those two numberings are SWAPPED, and the legacy one
   * derives the FRONT basis for a BACK sweep while refusing nothing.
   */
  lensFacing?: number;
  /** 0 raw sensor buffer (what iOS does, the default) · 1 upright in the
   *  natural orientation · 2 upright for the display rotation · 3 explicit. */
  recorderRotation?: number;
  displayRotationDeg?: number;
  explicitRotationCwDeg?: number;
  /** A horizontal flip is a REFLECTION (det −1) and is always refused: no
   *  member of the 24-candidate set can express it. */
  mirrored?: boolean;
  /** `LENS_POSE_ROTATION` as `[x, y, z, w]`, when the HAL publishes one. */
  lensPoseRotation?: readonly number[];
  /** `LENS_POSE_REFERENCE` (PRIMARY_CAMERA=0, GYROSCOPE=1, UNDEFINED=2,
   *  AUTOMOTIVE=3). Only GYROSCOPE is usable; the rest are refused by name. */
  lensPoseReference?: number;
  poseQuatSense?: number;
  cameraFrameAdjustIndex?: number;
  poseThresholdDeg?: number;
  /** A `selectBasis()` winner to compare the derivation against — the
   *  falsification sweep's other half. Omit (or −1) for no comparison. */
  referenceBasisIndex?: number;
}

/** Derive the IMU→camera basis `C` from the device's own characteristics. */
export function panoPlusAndroidDeriveBasis(
  options: PanoPlusAndroidBasisOptions,
): Promise<PanoPlusAndroidBasisResult> {
  const mod = getModule();
  if (mod == null) return Promise.resolve(unavailableEnvelope());
  const clean: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(options)) {
    if (v !== undefined) clean[k] = v;
  }
  return mod.deriveBasis(clean).then(
    (raw) => {
      const env = toEnvelope(raw);
      const r = (raw ?? {}) as Record<string, unknown>;
      const p = env.parsed;
      const lensPoseSupplied = bool(r, 'lensPoseSupplied');
      if (p == null) return { ...env, lensPoseSupplied };
      return {
        ...env,
        lensPoseSupplied,
        ok: bool(p, 'ok'),
        basisIndex: num(p, 'basisIndex'),
        basisLabel: str(p, 'basisLabel'),
        refusal: str(p, 'refusal'),
        appliedRotationCwDeg: num(p, 'appliedRotationCwDeg'),
        residualRotationCwDeg: num(p, 'residualRotationCwDeg'),
        basisProvenance: str(p, 'basisProvenance'),
      };
    },
    (e) => rejectedEnvelope(e),
  );
}

/** Options for {@link panoPlusAndroidArCoreBasisRun}. */
export interface PanoPlusAndroidArCoreBasisOptions {
  /** The pack root OR its `panoplus/` directory — both are accepted, because
   *  `stopRecording()` reports the second and an operator types the first. */
  packDir: string;
  /** Which `sensors.jsonl` row type is the IMU series. `rotation-vector`
   *  (default) or `game-rotation-vector` — the magnetometer-free arm logged
   *  beside it, so both can be run from ONE sweep. */
  imuType?: 'rotation-vector' | 'game-rotation-vector';
  /** `q` (ARCore `Camera.getPose()`, the default and the one `selectBasis()`
   *  wants) or `qDisplayOriented` (`getDisplayOrientedPose()`, which folds in
   *  the display rotation). */
  refField?: 'q' | 'qDisplayOriented';
  /** τ applied to the REFERENCE timestamps, seconds. 0 is right only when both
   *  series share a clock — on Android that holds when the camera's
   *  `SENSOR_INFO_TIMESTAMP_SOURCE` is `REALTIME`, which `device.json` states
   *  rather than assumes. */
  tauS?: number;
  /** Offsets to re-fit at, so a winner chosen BY the offset is caught.
   *  Omitted ⇒ native uses ±10/±5/0 ms. An explicit `[]` turns the check off,
   *  and it is then reported as not-run, never as passed. */
  tauCandidatesS?: number[];
  /** The DERIVED index to falsify. Omit (or −1) for no comparison — which is
   *  reported as `withheld:"no-derived-index-supplied"`, never as agreement. */
  derivedBasisIndex?: number;
  /** Sweep length + canvas scale for the drift verdict's pixel conversion. */
  sweepSeconds?: number;
  canvasPxPerDeg?: number;
}

/** {@link panoPlusAndroidArCoreBasisRun}'s narrowed answers. */
export interface PanoPlusAndroidArCoreBasisResult extends PanoPlusAndroidEnvelope {
  /** True only when the measured index may be PERSISTED — i.e. a unique
   *  winner, over enough pairs, at a small enough residual, from a gesture
   *  that could physically identify it. */
  ok?: boolean;
  /** `ok` | `arcore-jsonl-missing` | `sensors-jsonl-missing` |
   *  `ambiguous-axis` | `excitation-insufficient` | `rms-too-large` | … */
  reason?: string;
  /** False ⇒ this pack has no ARCore reference series at all. That is the
   *  COMMON case (the channel is off by default) and it is NOT a failure. */
  arcoreFound?: boolean;
  sensorsFound?: boolean;
  /** The MEASURED index, and whether the search could distinguish it. Never
   *  render the index without `unique` — a single-axis gesture leaves a 4-way
   *  EXACT tie, and `ranked[0]` is then an arbitrary member of it. */
  measuredIndex?: number;
  measuredLabel?: string;
  unique?: boolean;
  marginDeg?: number;
  rmsDeg?: number;
  pairs?: number;
  runnerUpIndex?: number;
  /** The falsification. `agreementCompared` false ⇒ read `agreementWithheld`;
   *  it is never defaulted to agreement. */
  agreementCompared?: boolean;
  agree?: boolean;
  agreementWithheld?: string;
  relativeAngleDeg?: number;
  agreementDiagnosis?: string;
  /** Gesture coaching, from the REFERENCE series' excitation. `sufficient`
   *  false with `needMoreAxes` naming which of tilt/pan/roll to add. */
  excitationSufficient?: boolean;
  excitationReason?: string;
  exercisedAxes?: number;
  needMoreAxes?: string[];
  /** True when a derived index was passed across the bridge at all. */
  derivedIndexSupplied?: boolean;
  /** How much of each ledger SURVIVED the reader, and how much was there.
   *
   * ⚠ `refRowsAccepted: 0` with `refLinesTotal: 850` is a real and common
   * state — every ARCore row was dropped because it was not `TRACKING` — and
   * it must be reported as "ARCore never tracked", NEVER as a bad gesture. An
   * empty series also makes `excitationReason` read `too-few-samples`, which
   * a panel that checks excitation first will render as "single-axis pan",
   * sending the operator to redo a gesture that was never the fault. */
  imuRowsAccepted?: number;
  refRowsAccepted?: number;
  refLinesTotal?: number;
  refRowsWrongType?: number;
  /** THE CLOCK THE FIT WAS MADE UNDER, read out of the pack's own
   *  `device.json` rather than assumed.
   *
   * ⚠ NOT COSMETIC. The run joins `sensors.jsonl` (`SensorEvent.timestamp`) to
   * `attitude_arcore.jsonl` (ARCore's frame timestamp, the Camera2
   * `SENSOR_TIMESTAMP` domain) at `tauS`, which is 0 unless a caller supplied
   * one — and 0 is correct ONLY when `SENSOR_INFO_TIMESTAMP_SOURCE` is
   * `REALTIME`. `UNKNOWN` is the boot/uptime clock, which STOPS in suspend, so
   * the two series are offset by the accumulated suspend time: small enough to
   * fit, and far outside the ±10 ms stability sweep, which would then report a
   * stable unique winner for a fit made across two epochs.
   *
   * `clockAssumption` is `confirmed-realtime` | `not-realtime` |
   * `unconfirmed` | `caller-supplied-tau` | `not-run`. Anything but the first
   * means the measured index has not been shown to come from a same-clock fit,
   * so the measured-beats-derived rule must not be applied on it alone. */
  cameraTimestampSource?: string;
  clockAssumption?: string;
  deviceJsonFound?: boolean;
}

/**
 * MEASURE the IMU→camera basis from a recorded pack, and falsify the derived
 * one.
 *
 * The other half of {@link panoPlusAndroidDeriveBasis}. That one computes `C`
 * from `SENSOR_ORIENTATION` + lens facing; on a device that publishes no
 * `LENS_POSE_ROTATION` nothing can contradict it. This runs the engine's own
 * `selectBasis()` over the ARCore reference series a sweep recorded beside the
 * rotation vector, and compares.
 *
 * ⚠ THE MEASURED INDEX WINS IF THEY DISAGREE, and the size of the difference
 * localises the fault: ~90° about the optical axis means the recorder rotated
 * the buffer without saying so, 180° is a CV-convention error.
 */
export function panoPlusAndroidArCoreBasisRun(
  options: PanoPlusAndroidArCoreBasisOptions,
): Promise<PanoPlusAndroidArCoreBasisResult> {
  const mod = getModule();
  if (mod == null || typeof mod.arcoreBasisRun !== 'function') {
    return Promise.resolve(unavailableEnvelope());
  }
  const clean: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(options)) {
    if (v !== undefined) clean[k] = v;
  }
  return mod.arcoreBasisRun(clean).then(
    (raw) => {
      const env = toEnvelope(raw);
      const r = (raw ?? {}) as Record<string, unknown>;
      const p = env.parsed;
      const derivedIndexSupplied = bool(r, 'derivedIndexSupplied');
      if (p == null) return { ...env, derivedIndexSupplied };
      const report = obj(p, 'report');
      const verdict = obj(report, 'basisVerdict');
      const agreement = obj(report, 'agreement');
      const exc = obj(report, 'excitation');
      const excVerdict = obj(exc, 'verdict');
      const needMore: string[] = [];
      const rows = excVerdict?.needMore;
      if (Array.isArray(rows)) {
        for (const row of rows) {
          if (row != null && typeof row === 'object') {
            const rr = row as Record<string, unknown>;
            if (rr.needMore === true && typeof rr.axis === 'string') needMore.push(rr.axis);
          }
        }
      }
      return {
        ...env,
        derivedIndexSupplied,
        ok: bool(p, 'ok'),
        reason: str(p, 'reason'),
        arcoreFound: bool(p, 'arcoreFound'),
        sensorsFound: bool(p, 'sensorsFound'),
        measuredIndex: num(verdict, 'index'),
        measuredLabel: str(verdict, 'label'),
        unique: bool(verdict, 'unique'),
        marginDeg: num(verdict, 'marginDeg'),
        rmsDeg: num(verdict, 'rmsDeg'),
        pairs: num(verdict, 'pairs'),
        runnerUpIndex: num(verdict, 'runnerUpIndex'),
        agreementCompared: bool(agreement, 'compared'),
        agree: bool(agreement, 'agree'),
        agreementWithheld: str(agreement, 'withheld'),
        relativeAngleDeg: num(agreement, 'relativeAngleDeg'),
        agreementDiagnosis: str(agreement, 'diagnosis'),
        excitationSufficient: bool(excVerdict, 'sufficient'),
        excitationReason: str(excVerdict, 'reason'),
        exercisedAxes: num(excVerdict, 'exercisedAxes'),
        needMoreAxes: needMore,
        imuRowsAccepted: num(obj(obj(report, 'series'), 'imu'), 'accepted'),
        refRowsAccepted: num(obj(obj(report, 'series'), 'reference'), 'accepted'),
        refLinesTotal: num(obj(obj(report, 'series'), 'reference'), 'linesTotal'),
        refRowsWrongType: num(obj(obj(report, 'series'), 'reference'), 'wrongType'),
        cameraTimestampSource: str(p, 'cameraTimestampSource'),
        clockAssumption: str(p, 'clockAssumption'),
        deviceJsonFound: bool(p, 'deviceJsonFound'),
      };
    },
    (e) => rejectedEnvelope(e),
  );
}

/** Options for {@link panoPlusAndroidReplayPack}. */
export interface PanoPlusAndroidReplayOptions {
  /** The pack root, or its `panoplus/` directory. Both are accepted. */
  packDir: string;
  /** Empty ⇒ measure-only, nothing written (what a read-only location needs).
   *  Native REFUSES an outDir resolving to the pack's own `panoplus/` — it
   *  would overwrite the ledger it is being graded against. */
  outDir?: string;
  /** Stop after this many track rows. 0 ⇒ all of them. */
  maxFrames?: number;
  writeCanvas?: boolean;
  writeLedger?: boolean;
  canvasQuality?: number;
  canvasCropPad?: boolean;
  /** Adopt the pack's own recorded Config. ON is what makes a replay a replay. */
  useMetaConfig?: boolean;
  compareLedger?: boolean;
  frameMissingReportCap?: number;
  /** A/B knobs forced after the pack's config is adopted, by the name
   *  `meta.json` uses. Every entry lands in `overridesApplied`,
   *  `overridesUnknown` or `overridesMalformed` — never silently ignored. */
  configOverrides?: Record<string, number | boolean | string>;
}

/**
 * Replay a pano+ pack through the engine: throughput, outcome counts, and the
 * per-row diff against the pack's own iOS ledger.
 *
 * ⚠️ MINUTES on a full pack. Native runs it off the JS thread, but the promise
 * is correspondingly long-lived — the caller must show progress, not freeze.
 */
export function panoPlusAndroidReplayPack(
  options: PanoPlusAndroidReplayOptions,
): Promise<PanoPlusAndroidReplayResult> {
  const mod = getModule();
  if (mod == null) return Promise.resolve(unavailableEnvelope());
  const clean: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(options)) {
    if (v !== undefined) clean[k] = v;
  }
  return mod.replayPack(clean).then(
    (raw) => {
      const env = toEnvelope(raw);
      const r = (raw ?? {}) as Record<string, unknown>;
      const p = env.parsed;
      const wallMs = num(r, 'wallMs');
      if (p == null) return { ...env, wallMs };
      return {
        ...env,
        wallMs,
        ok: bool(p, 'ok'),
        framesIngested: num(p, 'framesIngested'),
        msP50: num(p, 'msP50'),
        msP95: num(p, 'msP95'),
        msMax: num(p, 'msMax'),
        painted: num(p, 'painted'),
        held: num(p, 'held'),
        rejected: num(p, 'rejected'),
        skipped: num(p, 'skipped'),
        holes: num(p, 'holes'),
        haveOracle: bool(p, 'haveOracle'),
        outcomeAgree: num(p, 'outcomeAgree'),
        outcomeDisagree: num(p, 'outcomeDisagree'),
      };
    },
    (e) => rejectedEnvelope(e),
  );
}

/**
 * The pure-read capability probe (Camera2 + SensorManager). Opens no camera,
 * requests no permission.
 *
 * Resolves the native map as-is: it is a large, deeply nested capability tree
 * whose whole value is completeness, and narrowing it here would drop exactly
 * the field the next hardware question needs. Null when unavailable.
 */
export function panoPlusAndroidProbe(): Promise<Record<string, unknown> | null> {
  const mod = getModule();
  if (mod == null || typeof mod.probe !== 'function') return Promise.resolve(null);
  return mod.probe().then(
    (raw) => (raw != null && typeof raw === 'object'
      ? (raw as Record<string, unknown>)
      : null),
    () => null,
  );
}

/**
 * Measure the real delivered rate of the motion sensors for `durationMs`.
 *
 * A MEASUREMENT, not a capability read: it registers listeners and waits. Null
 * when unavailable or when the measurement failed.
 */
export function panoPlusAndroidMeasureSensorRates(
  durationMs: number,
): Promise<Record<string, unknown> | null> {
  const mod = getModule();
  if (mod == null || typeof mod.measureSensorRates !== 'function') {
    return Promise.resolve(null);
  }
  return mod.measureSensorRates(durationMs).then(
    (raw) => (raw != null && typeof raw === 'object'
      ? (raw as Record<string, unknown>)
      : null),
    () => null,
  );
}

/**
 * Start recording a replayable pano+ pack.
 *
 * REJECTS ARE EVIDENCE here, unlike the diagnostic entries above: `start` fails
 * for reasons the operator must act on (`permission-denied` when CAMERA is not
 * granted — the recorder never requests it, because a native module has no
 * Activity to host the dialog). Swallowing that into a resolved envelope would
 * make a permission problem look like a hardware one.
 */
export function panoPlusAndroidStartRecording(
  options: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const mod = getModule();
  if (mod == null || typeof mod.startRecording !== 'function') {
    const e = new Error(
      panoPlusAndroidUnavailableReason() ?? 'pano+ Android is not available.',
    ) as Error & { code: string };
    e.code = 'panoplus-android-unavailable';
    return Promise.reject(e);
  }
  const clean: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(options)) {
    if (v !== undefined) clean[k] = v;
  }
  return mod.startRecording(clean).then(
    (raw) => (raw != null && typeof raw === 'object'
      ? (raw as Record<string, unknown>)
      : {}),
  );
}

/**
 * Stop the recorder and resolve its summary.
 *
 * ALWAYS resolves — including when nothing was running (native answers
 * `wasRecording: false`, by design: an unmount, a crash-recovery path and an
 * operator tap all call this). A stop that could reject would leave the camera
 * open with the UI believing it had closed.
 */
export function panoPlusAndroidStopRecording(): Promise<Record<string, unknown>> {
  const mod = getModule();
  if (mod == null || typeof mod.stopRecording !== 'function') {
    return Promise.resolve({ wasRecording: false });
  }
  return mod.stopRecording().then(
    (raw) => (raw != null && typeof raw === 'object'
      ? (raw as Record<string, unknown>)
      : {}),
    (e) => ({
      wasRecording: false,
      error: e instanceof Error ? e.message : String(e),
    }),
  );
}

/** Live recorder counters, safe to poll while a sweep runs. */
export function panoPlusAndroidRecordingStatus(): Promise<Record<string, unknown>> {
  const mod = getModule();
  if (mod == null || typeof mod.recordingStatus !== 'function') {
    return Promise.resolve({ running: false });
  }
  return mod.recordingStatus().then(
    (raw) => (raw != null && typeof raw === 'object'
      ? (raw as Record<string, unknown>)
      : { running: false }),
    () => ({ running: false }),
  );
}
