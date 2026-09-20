// SPDX-License-Identifier: Apache-2.0
/**
 * panoPlusModel — every pano+ DECISION that is not a native call, as pure
 * functions.
 *
 * The rule this file exists to obey (the enforce-1D / overlayQuads precedent):
 * anything left inside a component is untestable by construction in this SDK's
 * jest (node env, React stubbed), and the two field bugs of 2026-07-22 both
 * lived in exactly that untestable HUD layer — the maths under them was tested
 * and correct, the WIRING was not. So the status parse, the governor copy, the
 * HUD line, the integrity verdict, the session naming and the result shape all
 * live here, and `PanoPlusCaptureSurface` is left holding only React state and
 * native calls.
 *
 * PURE + TOTAL: no `react-native`, no `expo-*`, no throws. Every function
 * takes `unknown` where the value crosses a bridge, because a native module on
 * an older binary can and does return a differently-shaped dict, and a HUD
 * that crashes on it is worse than one that says "—".
 */

import type {
  PanoPlusAbort,
  PanoPlusArExposure,
  PanoPlusArExposureProbe,
  PanoPlusCameraLock,
  PanoPlusCaptureResult,
  PanoPlusClipping,
  PanoPlusCounts,
  PanoPlusEnvelope,
  PanoPlusExposure,
  PanoPlusFailure,
  PanoPlusGain,
  PanoPlusHoldName,
  PanoPlusLatch,
  PanoPlusLens,
  PanoPlusOutcome,
  PanoPlusPoseSource,
  PanoPlusProjection,
  PanoPlusRegime,
  PanoPlusSeam,
  PanoPlusStatus,
  PanoPlusSubjectDistanceFit,
  PanoPlusSummary,
  PanoPlusTimingStats,
} from './panoPlusTypes';

// ── The one key both sides spell ────────────────────────────────────────────

/**
 * The AR-plugin registry key AND the `onArFrame` meta key.
 * Native: `RNISPanoPlusPlugin.pluginName` (ios/RNISPanoPlusPlugin.swift).
 * A typo here is a HUD that is permanently blank while the sweep runs
 * perfectly — silent, and indistinguishable from "the plugin never ran".
 */
export const PANO_PLUS_PLUGIN_KEY = 'sweep';
/**
 * The pre-migration registry key.  Read as a fallback so a pack or a live
 * frame produced by an older binary still resolves — see the dual-name
 * banner in panoPlusNative.ts.
 */
export const PANO_PLUS_PLUGIN_KEY_LEGACY = 'rnisPanoPlus';

/**
 * The AR-session swap grace, mirrored from the capture shell's
 * `MODE_SWAP_GRACE_MS`. There is ONE physical camera + ARKit session: the
 * outgoing surface's `<ARCameraView>` unmount is what calls
 * `RNSARSession.stop()`, and mounting the incoming one before that lands races
 * two `arSession.run` calls. Same number as the shell on purpose — a second,
 * different grace would be a second, differently-broken swap.
 */
export const PANO_PLUS_SWAP_GRACE_MS = 250;

/**
 * How often the surface POLLS `getStatus()` while a sweep is live.
 *
 * BELT AND BRACES, not the primary channel. The status reaches JS on the AR
 * plugin's sync return, folded into the throttled `onArFrame` meta — which is
 * the right channel (one native read, no bridge round-trip, already flowing).
 * But that channel has four points where it can go quiet without saying so:
 * the meta emit is gated on `setArFrameMetaEnabled`, the plugin must be in
 * `RNISARPluginRegistry`, the meta key must match on both sides, and the
 * `plugins` map is only attached when at least one plugin returned non-nil.
 * If ANY of those is wrong on a device, the HUD and the live preview are
 * simply blank — which is indistinguishable from a sweep that is not running,
 * and is exactly the report this poll was added to make impossible.
 *
 * 500 ms is two orders of magnitude below the engine's own cadence and half
 * the preview's, so it costs one small bridge call per half second and cannot
 * mask a stall: the poll and the AR channel read the SAME native snapshot, and
 * the surface keeps whichever carries the newer `seq`.
 */
export const PANO_PLUS_STATUS_POLL_MS = 500;

/**
 * The poll interval while the DECOUPLED (IMU) arm is sweeping. On that arm the
 * 500 ms figure above is not a fallback, it is the ONLY channel: the primary
 * status ride is `onArFrame`'s synchronous plugin return, and the ARCameraView
 * that fires it is deliberately never mounted on the IMU arm (the two cannot
 * share the camera). Five 2026-08-31 field packs measured the result — a
 * preview natively published at ~8 Hz reaching the screen at 2 Hz, which the
 * operator read as "laggy, it moved places, was stuck". 125 ms matches the
 * native publish cadence (`previewIntervalMs` 120) and costs one cached-
 * dictionary bridge read per tick; `RNISPanoCore.status()` allocates nothing.
 */
export const PANO_PLUS_STATUS_POLL_FAST_MS = 125;

/**
 * The IDLE heartbeat — how often the surface asks native whether the idle
 * viewfinder still has the camera.
 *
 * ⚠ THIS IS A LIVENESS PROBE, NOT A STATUS POLL, and the distinction is why it
 * gets its own number. Nothing on screen at idle changes at 8 Hz; the one
 * question is "are those pixels still arriving", and the cost of the wrong
 * answer is total — a `TextureView` holds its last frame after the producer
 * goes away, so a dead feed looks exactly like a live one (A35, 2026-09-03:
 * three screenshots two seconds apart byte-identical, `Active Camera Clients:
 * []`, and no notice on screen). One second is fast enough that the operator
 * cannot line up a shot against a stale frame, and slow enough to be free: it
 * is one bridge call against a cached native dictionary.
 */
export const PANO_PLUS_IDLE_HEARTBEAT_MS = 1000;

// ── Coercion helpers (bridge values are `unknown`, always) ──────────────────

function num(v: unknown, fallback = 0): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}
function bool(v: unknown, fallback = false): boolean {
  return typeof v === 'boolean' ? v : fallback;
}
function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}
function nullableStr(v: unknown): string | null {
  return typeof v === 'string' && v !== '' ? v : null;
}
function rec(v: unknown): Record<string, unknown> | null {
  return v != null && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

// ── Path hygiene ────────────────────────────────────────────────────────────

/**
 * `file:///a/b` → `/a/b`. REQUIRED before anything is handed to native:
 * `RNISPanoCore` calls `NSFileManager createDirectoryAtPath:`, which treats a
 * URI as a relative path and would happily create a directory literally named
 * `file:` — a pack that lands nowhere the host can find, with no error.
 */
export function barePath(p: string): string {
  return p.startsWith('file://') ? p.slice(7) : p;
}

/** The inverse, for `<Image source>` / expo-file-system. */
export function fileUri(p: string): string {
  if (p === '') return '';
  return p.startsWith('file://') || p.startsWith('http') ? p : `file://${p}`;
}

// ── Session placement ───────────────────────────────────────────────────────

/** The pack root's parent, under the app's Documents dir. Its own folder (not
 *  `scene-model/`) so an offline sweeper can find pano+ packs without
 *  understanding a host's own session-directory conventions. */
export const PANO_PLUS_DIR = 'panoplus';

/** A sortable, collision-free sweep id: `pp_<epoch-ms>`. Time-based rather
 *  than random so the on-disk order IS the capture order when the operator
 *  browses the folder after a field run. */
export function newPanoPlusSessionId(now: number = Date.now()): string {
  return `pp_${now}`;
}

/**
 * Where one sweep's pack lives.
 *
 * `dirPath` is what native gets (plain path — see {@link barePath});
 * `dirUri` is what expo-file-system / `<Image>` get. Returning BOTH from one
 * place is the whole point: the two forms are not interchangeable and the
 * failure mode of mixing them is silent on both sides.
 */
export function panoPlusSessionPaths(
  documentDirectory: string,
  sessionId: string,
): { dirPath: string; dirUri: string } {
  const base = documentDirectory.endsWith('/')
    ? documentDirectory
    : `${documentDirectory}/`;
  const uri = `${base}${PANO_PLUS_DIR}/${sessionId}`;
  return { dirPath: barePath(uri), dirUri: fileUri(uri) };
}

/** The minted id's shape — `pp_<epoch-ms>`, and nothing else. Matched against
 *  a single path COMPONENT, so it cannot be fooled by a parent dir. */
const PANO_PLUS_SESSION_ID_RE = /^pp_\d+$/;

/**
 * THE SESSION'S IDENTITY, from any spelling of its directory.
 *
 * The `pp_<epoch-ms>` component {@link newPanoPlusSessionId} minted — WHEREVER
 * IT SITS in the path, and deliberately not the whole string. One session is
 * spelled at least four ways along the round trip: JS sends `barePath(dirPath)`
 * (`…/panoplus/pp_<ms>`), iOS echoes `S->sessionDir` back verbatim, Android's
 * live module answers `optStr(m, "packDir", sessionDir)`, and `fileUri` puts
 * the scheme back for `<Image>`. A comparison that failed on any of those would
 * fail CLOSED — every status discarded, a panel that never updates for the whole
 * sweep — which is a worse bug than the one scoping exists to fix.
 *
 * ⚠ THE LAST COMPONENT IS NOT THE ID ON ANDROID (2026-09-07). The recorder's
 * `openPack()` does `packDir = File(base, "panoplus")` on the dir this SDK
 * sends, opens the engine on THAT (`PanoPlusLiveNative.start(sessionDir =
 * packDir.absolutePath)`), the shared C++ stamps it into every status
 * (`kvStr(s, "sessionDir", S.sessionDir)`), and the live module answers the
 * start with the same string — so both the claim and every status read
 * `…/pp_<ms>/panoplus`, whose last component is the CONSTANT "panoplus" for
 * every sweep. Reading it that way is not a blank panel (both sides agree) but
 * something quieter: a session test that always passes, i.e. no scoping at all,
 * and the seq-only guard back with it. Matching the minted component instead is
 * byte-identical on iOS (`…/pp_<ms>`) and unique on Android.
 *
 * A path carrying NO minted component falls back to its last component: still
 * stable per path, so an unrecognised spelling scopes to itself rather than
 * failing closed.
 *
 * `null` means "no id in this path", never "session zero": the caller must
 * decide what an unattributable path means, and no caller may read null as a
 * match.
 */
export function panoPlusSessionIdOf(path: string): string | null {
  const bare = barePath(path).replace(/\/+$/, '');
  if (bare === '') return null;
  const parts = bare.split('/');
  for (let i = parts.length - 1; i >= 0; i -= 1) {
    if (PANO_PLUS_SESSION_ID_RE.test(parts[i])) return parts[i];
  }
  const last = parts[parts.length - 1];
  return last === '' ? null : last;
}

/**
 * WHICH SWEEP THIS LIVE STATUS IS ABOUT.
 *
 * `sessionDir` first, and it is populated on both platforms for every RUNNING
 * status — `RNISPanoCore.mm` writes `@"sessionDir": S->sessionDir ?: @""` into
 * the per-frame dict the AR plugin returns (and the same dict is what the poll
 * reads back through `getStatus`), and the shared C++ `Session::appendStatus`
 * writes `kvStr(s, "sessionDir", S.sessionDir)` into the JSON Android polls.
 * Both are seeded from the `sessionDir` START OPTION this SDK sends, so the
 * round trip is closed by construction; the only status that carries none is
 * the `{running:false}` idle answer, which every caller already discards.
 *
 * `previewPath`'s PARENT is the fallback, because it carries the same id one
 * level up (`…/pp_<ms>/preview.jpg` on iOS, `…/pp_<ms>/panoplus/preview.jpg`
 * on Android — {@link panoPlusSessionIdOf} finds the minted component in
 * either) and would survive a binary that predated the `sessionDir` key.
 *
 * `null` is "this status cannot be placed" — see {@link panoPlusSessionIdOf}.
 */
export function panoPlusStatusSessionId(status: PanoPlusStatus): string | null {
  const fromDir = panoPlusSessionIdOf(status.sessionDir);
  if (fromDir != null) return fromDir;
  const pv = barePath(status.previewPath).replace(/\/+$/, '');
  const cut = pv.lastIndexOf('/');
  return cut <= 0 ? null : panoPlusSessionIdOf(pv.slice(0, cut));
}

// ── The live status, off the throttled AR meta ──────────────────────────────

const OUTCOMES: ReadonlySet<string> = new Set<PanoPlusOutcome>([
  'painted',
  'held-backtrack',
  'held-frontier',
  'skipped-no-advance',
  'rejected-low-response',
  'rejected-out-of-cage',
  'rejected-pose-speed',
  'rejected-rectify',
  'rejected-tracking',
  'rejected-input',
  'warming-up',
  'bootstrap',
  'gap-extended',
  'gap-break',
  'gap-backfilled',
  'tail-flush',
  'aborted',
  'canvas-full',
  'unknown',
]);

function outcomeOf(v: unknown): PanoPlusOutcome {
  return typeof v === 'string' && OUTCOMES.has(v)
    ? (v as PanoPlusOutcome)
    : 'unknown';
}

/**
 * Extract pano+'s status from one `ARFrameMeta`.
 *
 * `null` means "this frame carried nothing from pano+", which is a legitimate
 * and frequent state, not an error: the plugin returns `nil` whenever it is
 * registered-but-not-capturing, and `onArFrame` is throttled independently of
 * the frame rate. The caller must therefore KEEP its last non-null status
 * rather than blanking the HUD — the sweep did not stop just because this
 * particular metadata tick had nothing to say.
 */
export function readPanoPlusStatus(meta: unknown): PanoPlusStatus | null {
  const m = rec(meta);
  if (m == null) return null;
  const plugins = rec(m.plugins);
  if (plugins == null) return null;
  return coercePanoPlusStatus(
    plugins[PANO_PLUS_PLUGIN_KEY] ?? plugins[PANO_PLUS_PLUGIN_KEY_LEGACY],
  );
}

/** The same coercion, for the `getStatus()` poll fallback. */
export function coercePanoPlusStatus(raw: unknown): PanoPlusStatus | null {
  const s = rec(raw);
  if (s == null) return null;
  // `running` is the one key native ALWAYS writes, in both the per-frame dict
  // and the `{running:false}` fallback the bridge resolves when there is no
  // session. Its absence means this is not a pano+ status at all.
  if (typeof s.running !== 'boolean') return null;
  return {
    running: s.running,
    // `''` on a binary older than the field — the surface treats an empty
    // string as "native did not say", never as a third arm.
    poseSourceRan: str(s.poseSourceRan),
    sessionDir: str(s.sessionDir),
    seq: num(s.seq),
    framesSeen: num(s.framesSeen),
    painted: num(s.painted),
    heldBacktrack: num(s.heldBacktrack),
    heldFrontier: num(s.heldFrontier),
    skippedNoAdvance: num(s.skippedNoAdvance),
    rejectedLowResponse: num(s.rejectedLowResponse),
    rejectedOutOfCage: num(s.rejectedOutOfCage),
    rejectedPoseSpeed: num(s.rejectedPoseSpeed),
    rejectedTracking: num(s.rejectedTracking),
    rejectedRectify: num(s.rejectedRectify),
    gapExtended: num(s.gapExtended),
    gapBreak: num(s.gapBreak),
    gapBackfilled: num(s.gapBackfilled),
    limitedFrames: num(s.limitedFrames),
    clippedFrames: num(s.clippedFrames),
    clippedColumns: num(s.clippedColumns),
    paintedWidthPx: num(s.paintedWidthPx),
    canvasWidthPx: num(s.canvasWidthPx),
    canvasHeightPx: num(s.canvasHeightPx),
    advancePx: num(s.advancePx),
    stripPx: num(s.stripPx),
    outcome: outcomeOf(s.outcome),
    speed: str(s.speed, 'ok'),
    tracking: num(s.tracking, -1),
    // ARCore's OWN reason for not tracking, live. Empty while tracking is
    // fine. See the wait-state message below for why a bare 'waiting' was
    // not good enough.
    arTrackingFailure: str(s.arTrackingFailure),
    stalled: bool(s.stalled),
    axisLatched: bool(s.axisLatched),
    axis: num(s.axis),
    sweepSign: num(s.sweepSign, 1),
    maxRectifyDeg: num(s.maxRectifyDeg),
    rotationFraction: num(s.rotationFraction),
    relatchCount: num(s.relatchCount),
    advanceRotPx: num(s.advanceRotPx),
    // LIVE CUT VERDICT. The bridge has shipped these since v5; before this
    // they were emitted and read by nothing, so "the HUD can go red mid-sweep"
    // was true of the wire and false of the app.
    seamMeasured: bool(s.seamMeasured),
    integrityFailed: bool(s.integrityFailed),
    seamWorstBandP95Px: num(s.seamWorstBandP95Px),
    seamWorstBandMaxPx: num(s.seamWorstBandMaxPx),
    crossBandDivergenceNormPx: num(s.crossBandDivergenceNormPx),
    seamCanvasJogP95Px: num(s.seamCanvasJogP95Px),
    seamCanvasJogMaxPx: num(s.seamCanvasJogMaxPx),
    // LIVE BANDING VERDICT (v6). The operator rejected two builds for banding
    // while the HUD showed nothing about photometry at all; `photoDriftLocalPct`
    // is the one measured on COMMITTED PIXELS, so it is the one that goes red.
    seamPhotoStepP95DN: num(s.seamPhotoStepP95DN),
    seamPhotoStepMaxDN: num(s.seamPhotoStepMaxDN),
    // v8 — THE SUPPORT. The max clause fires the same for one anomalous
    // boundary and for an end-to-end band; the operator could not tell those
    // apart and said so, so the HUD now carries the count next to the word.
    seamPhotoStepOverBar: num(s.seamPhotoStepOverBar),
    seamPhotoSamples: num(s.seamPhotoSamples),
    // v8 — the band metric is the chain's OWN FIT under `crossAvgWindows`.
    seamBandSelfScored: bool(s.seamBandSelfScored),
    photoDriftLocalPct: num(s.photoDriftLocalPct),
    photoDriftTotalPct: num(s.photoDriftTotalPct),
    photoLocalP2PPct: num(s.photoLocalP2PPct),
    photoScaleRangePct: num(s.photoScaleRangePct),
    // 1.00 with metaFrames > 0 is the live proof the AE lock is holding;
    // 1.00 with metaFrames 0 is UNKNOWN. Defaulted to 1 so an older binary
    // reads as "unknown" rather than as a division by zero.
    exposureRangeRatio: num(s.exposureRangeRatio, 1),
    exposureMetaFrames: num(s.exposureMetaFrames),
    maxAreaScale: num(s.maxAreaScale, 1),
    previewPath: str(s.previewPath),
    previewSeq: num(s.previewSeq),
    // The preview's own pixel dims — the panorama's SHAPE, which is what the
    // on-screen box must be sized from. 0 on a binary that predates them, and
    // `panoPlusPreviewLayout` falls back to the oriented canvas dims.
    previewW: num(s.previewW),
    previewH: num(s.previewH),
    // RENDERED vs FAILED vs SKIPPED — see the type. renders > 0 with seq 0 is
    // the signature of a publisher that cannot write, which is what shipped.
    previewRenders: num(s.previewRenders),
    previewFails: num(s.previewFails),
    previewSkips: num(s.previewSkips),
    // WHERE the preview sits in the panorama — see the type. The default is
    // -1, NOT 0: 0 is a legitimate fraction (the frontier at the near end of
    // a reversed sweep) and an older binary that emits nothing must be
    // UNPLACEABLE, not placed at one end.
    previewFrontierFrac: num(s.previewFrontierFrac, -1),
    previewViewPx: num(s.previewViewPx),
    previewBandPx: num(s.previewBandPx),
    previewViewStartPx: num(s.previewViewStartPx),
    previewWindowed: s.previewWindowed === true,
    previewIntervalMs: num(s.previewIntervalMs),
    // THE CAMERA'S OWN FEED, not the panorama — see the type. Defaulted like
    // everything else here, so an iOS binary (where the question cannot arise)
    // and an older Android one both read `false` + `''`, and the notice these
    // drive stays silent because it is gated on the NOTE, never on `!attached`.
    viewfinderAttached: s.viewfinderAttached === true,
    viewfinderNote: str(s.viewfinderNote),
    droppedQueue: num(s.droppedQueue),
    droppedPack: num(s.droppedPack),
    engineMs: num(s.engineMs),
    abort: nullableStr(s.abort),
  };
}

// ── THE HOLD, AND THE SWEEP IT IMPLIES ──────────────────────────────────────

/**
 * WHICH SWEEP THE OPERATOR IS SET UP FOR — and why this is a first-class
 * question rather than a landscape check.
 *
 * pano+ shipped with `RotateToLandscapePrompt` on `!landscape` and an idle
 * headline that read "Hold landscape, face the shelf". Both were wrong, and
 * not in the harmless way: the ENGINE never constrained the gesture. Measured
 * on all three of the 2026-08-29 field packs, `Config::axisOverride` is 0
 * (auto) and the axis latch VOTES on measured translation — so it will latch
 * whatever the operator actually did. Both first-class holds land on the SAME
 * engine case:
 *
 *   hold        world sweep      sensor axis        latched
 *   landscape   top → bottom     image-Y (short)    axis 1
 *   portrait    left → right     image-Y (short)    axis 1
 *
 * The sensor's short edge runs across the phone's long edge in EVERY hold, so
 * motion along the phone's short edge is image-Y either way. There was never
 * anything to rotate FOR. What the prompt actually did was refuse to coach the
 * portrait gesture and nag about a hold the engine did not need.
 *
 * `portrait-upside-down` is kept apart because it is the one hold that is
 * genuinely worse: the sweep still works, but the operator's hand covers the
 * lens housing and the coaching graphics point the wrong way round for a
 * gesture nobody performs deliberately.
 */
export type PanoPlusHold = PanoPlusHoldName;

/**
 * THE ONE ORIENTATION DEFAULT, for every function that takes one.
 *
 * It is `'portrait'` because that is what `useDeviceOrientation` itself
 * reports before its first accelerometer sample — so a caller who omits the
 * hold gets the same answer the live surface gets in its first frame, rather
 * than a second opinion. Every public entry point in this file now reads this
 * constant; they did not, and two of them disagreed (see
 * {@link panoPlusGuidance}).
 */
export const PANO_PLUS_DEFAULT_ORIENTATION: PanoPlusOrientation = 'portrait';

export function panoPlusHoldOf(orientation: PanoPlusOrientation): PanoPlusHold {
  if (orientation === 'landscape-left' || orientation === 'landscape-right') {
    return 'landscape';
  }
  if (orientation === 'portrait-upside-down') return 'portrait-upside-down';
  return 'portrait';
}

/** A direction IN THE OPERATOR'S FRAME — gravity-aligned, which is the only
 *  frame an arrow on screen can honestly mean. */
export type PanoPlusSweepDir = 'up' | 'down' | 'left' | 'right';

export interface PanoPlusCoachedSweep {
  /** The direction the coach mark's arrow points. */
  dir: PanoPlusSweepDir;
  /** The gesture in words, e.g. `left to right`. */
  phrase: string;
  /** `true` when the sweep runs along the operator's vertical. */
  tall: boolean;
}

/**
 * THE GESTURE WE ASK FOR, per hold. Both are first-class; neither is a
 * fallback for the other.
 *
 * Landscape → top to bottom, because the shelf bay is wider than it is tall
 * and the phone's long edge already covers the width.
 * Portrait  → left to right, because the phone's long edge now covers the
 * shelf HEIGHT and the aisle is what the operator walks.
 */
export function panoPlusCoachedSweep(hold: PanoPlusHold): PanoPlusCoachedSweep {
  if (hold === 'landscape') {
    return { dir: 'down', phrase: 'top to bottom', tall: true };
  }
  return { dir: 'right', phrase: 'left to right', tall: false };
}

/**
 * WHICH WAY THE ENGINE IS ACTUALLY GROWING THE PANORAMA, in the operator's
 * frame — the claim the HUD's axis label made and got WRONG in portrait.
 *
 * The shipped line printed `${axis === 1 ? 'vert' : 'horiz'}`, which is the
 * axis IN THE JPEG'S PIXELS. That reads correctly in a landscape hold by
 * coincidence and is a straight lie in a portrait one: a portrait
 * left-to-right sweep latches `axis === 1` and the HUD announced `vert` for a
 * gesture running along the operator's HORIZONTAL. Same class of bug as the
 * preview panel's `usePanel = status.axis === 1`, on the same input, arriving
 * on the text line instead of the layout.
 *
 * The fix is the SAME rotation the aspect chain and {@link panoPlusSweepIsTall}
 * walk, applied to a vector instead of a boolean, so the three can never
 * disagree:
 *
 *   framebuffer direction = R_cw(imageRotateDeg) · sensorDir
 *
 * ── WHY THE FRAMEBUFFER FRAME IS THE OPERATOR'S FRAME FOR AN ARROW ────────
 * (2026-09-03, Pano parity.) This used to subtract a second term — the
 * chrome rotation, the turn the HUD BLOCK was given so its words read upright
 * on a portrait-locked host held sideways — because a glyph drawn inside a
 * block turned by `+chromeRotateDeg` had to be chosen `−chromeRotateDeg`
 * ahead to come out right. Pano turns no block (its containers stay in the
 * portrait framebuffer, `Camera.tsx` `pillStack` / `bottomBar`), so pano+ no
 * longer does either, and the compensation goes with it.
 *
 * What is left is physically right on its own. `imageRotateDeg` is a CONTENT
 * transform: the panorama is drawn with `rotate(imageRotateDeg)`, so a sensor
 * direction lands on the framebuffer turned by exactly `+imageRotateDeg` (RN's
 * rotate is clockwise-positive in a Y-down frame). The framebuffer is bolted
 * to the same body as the sensor, so a `→` drawn along framebuffer +X points
 * along the phone's portrait-right edge in EVERY hold — and that is the
 * direction the sweep is running in, gravity notwithstanding. An arrow has no
 * "up" to be read sideways.
 *
 * Landscape-left is the device rotated a quarter turn ANTI-clockwise from
 * portrait (home edge to the right); the sensor→framebuffer turn is a
 * constant +90° there (EXIF 6 — see {@link panoPlusImageRotationDeg}), so
 * sensor +Y lands on fb −X. Drawn as `←` on the portrait framebuffer, fb −X
 * is the phone's portrait-LEFT edge, which in that hold points DOWN to the
 * operator — the world direction his top-to-bottom sweep runs in. ✓
 *
 * The result is INVARIANT to whether the host is orientation-locked, which is
 * the check that pins the sign: on the locked host `imageRotateDeg` is 90 in
 * every hold and the framebuffer turns with the phone; on the unlocked host
 * the OS has already turned the framebuffer by `fbRot` and `imageRotateDeg`
 * carries `−fbRot`. Same arrow on the glass either way, and the tests assert
 * it by comparing the physical direction across the two regimes.
 *
 * Returns `null` before the latch — there is no direction yet, and inventing
 * one would put an arrow on screen that the engine has not committed to.
 */
export function panoPlusSweepDirection(
  status: PanoPlusStatus | null,
  screenIsLandscape: boolean,
  orientation: PanoPlusOrientation = PANO_PLUS_DEFAULT_ORIENTATION,
): PanoPlusSweepDir | null {
  if (status == null || !status.axisLatched) return null;
  const sign = status.sweepSign < 0 ? -1 : 1;
  // Sensor-space unit vector, Y-down: axis 1 grows along image-Y.
  let x = status.axis === 1 ? 0 : sign;
  let y = status.axis === 1 ? sign : 0;
  const total = panoPlusImageRotationDeg(screenIsLandscape, orientation);
  // Quarter turns only, so this is exact integer arithmetic — no trig, no
  // floating-point sign flips near zero.
  let quarters = Math.round(total / 90) % 4;
  if (quarters < 0) quarters += 4;
  for (let i = 0; i < quarters; i += 1) {
    const nx = -y;
    const ny = x;
    x = nx;
    y = ny;
  }
  if (y < 0) return 'up';
  if (y > 0) return 'down';
  return x < 0 ? 'left' : 'right';
}

/** The arrow glyph for a direction — used by the HUD, which has one line and
 *  cannot spend eight characters saying `downward`. */
export function panoPlusSweepArrow(dir: PanoPlusSweepDir | null): string {
  switch (dir) {
    case 'up': return '↑';
    case 'down': return '↓';
    case 'left': return '←';
    case 'right': return '→';
    default: return '';
  }
}

// ── THE LIVE PREVIEW'S TWO MEASURED DEFECTS ─────────────────────────────────
//
// Both come off the operator's three 2026-08-29 pano+ packs replayed through
// THIS file's own layout — `results/2026-08-30-panoplus-portrait/preview/`,
// which drives `panoPlusPreviewLayout` out of `dist/` rather than restating it.
// Neither is a filter, an interpolation or a resolution problem, and the two
// candidates that sounded most likely were exonerated by measurement:
//
//   · RESOLUTION.  The published JPEG lands at 1.03 JPEG px per DEVICE px on
//     his sweeps — neither upscaled soft nor downscaled hard, essentially 1:1.
//   · COALESCING.  A render costs previewMs p99 7.6 / 8.9 / 14.3 ms against a
//     250 ms interval on a queue behind a 6-slot ring, and all three packs
//     report droppedQueue 0.  Nothing was being coalesced away.
//
// What IS guilty:
//
//   1. THE OPENING STALL.  `bootstrap` paints one whole frame footprint
//      (canvas u 129..847 — 718 px, identical on all three packs) and the
//      strip commit then starts at the frame CENTRE, half a footprint behind
//      it.  So the painted band's OUTER EXTENT cannot move until the frontier
//      has crossed 359 canvas px.  Measured: the band sat at exactly 718 px
//      for 2.94 s / 2.39 s / 2.62 s — 40% / 30% / 33% of each sweep — while
//      the operator was already panning.  The panel is not frozen (strips are
//      landing, on top of imagery the bootstrap already drew) but it does not
//      GROW, and from behind the phone those are the same thing.
//
//      This is NOT fixable by painting faster: the engine has to traverse its
//      own bootstrap footprint.  What was missing was any signal that
//      something WAS happening.  The commit frontier moved the whole time —
//      it is now published (`previewFrontierFrac`) and drawn.
//
//   2. THE GROWING EDGE.  Fitting the WHOLE band into a fixed panel shrinks
//      the picture without bound.  Measured on his 390x844 portrait-locked
//      window, in the landscape hold, walking the shipped layout out past the
//      packs' own 7-8 s sweeps:
//
//        along px   shelf   panel drawn    source px per device px
//           718     0.70 m  259 x 153 pt         3.13
//          1464     1.42 m  259 x 312 pt         3.13   ← his sweeps end here
//          2000     1.94 m  227 x 373 pt         3.57   ← the knee
//          3040     2.95 m  150 x 374 pt         5.42
//          4000     3.89 m  114 x 374 pt         7.13
//          6000     5.83 m   76 x 374 pt        10.70
//
//      His three sweeps end at 1423 / 1711 / 1423 canvas px — one step SHORT
//      of the knee, which is exactly why he reports "does not look good"
//      rather than "is unusable".  A real aisle is past it the whole way.
//
// The fix for (2) is the frontier WINDOW, and it lives in native
// (`Engine::previewIntoFit`'s `windowAlongPx`) because only the engine knows
// which way the sweep runs.  What lives HERE is the number native cannot
// know: WHERE THE KNEE IS, which is a property of this phone's chrome.

/** The engine's own default for {@link panoPlusPreviewWindowMultiple}'s knob,
 *  mirrored so a test can assert the two have not drifted apart. */
export const PANO_PLUS_DEFAULT_PREVIEW_WINDOW_MULT = 1.44;

/** The engine's preview interval FLOOR (RNISPanoCore.mm `previewIntervalMs`),
 *  250 -> 120 ms on 2026-08-30. Mirrored here so the HUD can tell a panel that
 *  is refreshing at the configured rate from one the duty throttle has slowed,
 *  and print only the second. */
export const PANO_PLUS_PREVIEW_INTERVAL_MS = 120;

/**
 * THE KNEE, as an along ÷ cross ratio — the number passed to native as
 * `previewWindowCrossMult`.
 *
 * Past this ratio the preview stops gaining on-screen size and starts losing
 * it, so it is the longest window worth rendering: shorter throws away panel
 * the phone was willing to give, longer starts the collapse tabulated above.
 *
 * ⚠ REDERIVED 2026-09-03, AND IT HAD TO BE. The frame is a FIXED capsule now
 * (`fixedBand` / `fixedColumn`), so the knee is simply THE CAPSULE'S OWN
 * along ÷ cross ratio: while the panorama is squarer than the strip, fitting
 * the whole of it fills the strip's thickness and only its LENGTH grows — no
 * scale is lost. Past that ratio the fit becomes length-limited and the shelf
 * starts shrinking without bound, which is where the window must take over so
 * the strip holds its scale and older content slides off. That is Pano's
 * behaviour, and it is the reason the image never shrinks under the operator.
 *
 * Leaving the old derivation in place would have shipped the knee for a box
 * that no longer exists: it returned 1.558 on the operator's window — the
 * maximal OLD band's aspect — and would have windowed his sweep to an 81 pt
 * sliver stuck at one end of a 330 pt strip.
 *
 * The SMALLER of band and column is returned, because the placement is not
 * known until the axis latches and the options are sent before the first
 * frame. On a 390x844 portrait-locked window (insets 59/34, Pano's 240 pt
 * bottom stack): band 330/52 = 6.35, column 493/52 = 9.48, so 6.35.
 */
export function panoPlusPreviewWindowMultiple(
  screen: PanoPlusScreen,
  orientation: PanoPlusOrientation = PANO_PLUS_DEFAULT_ORIENTATION,
): number {
  const sw = Math.max(120, screen.width);
  const sh = Math.max(120, screen.height);
  // `orientation` is accepted for signature stability with the layout it
  // mirrors and read by nothing: the usable box is framebuffer-space and so is
  // the capsule (see `panoPlusPreviewLayout` — the chrome is not turned).
  void orientation;
  const u = usableBox(screen, sw, sh);
  const band = fixedBand(u);
  const column = fixedColumn(u);
  const ratio = (f: Frame): number => {
    const along = Math.max(1, Math.max(f.width, f.height) - 2 * PREVIEW_BAND_PADDING);
    const cross = Math.max(1, Math.min(f.width, f.height) - 2 * PREVIEW_BAND_PADDING);
    return along / cross;
  };
  // Bounded well away from both degenerate ends: a multiple under 1 would
  // window a panorama that is still narrower than its own canvas is tall, and
  // an unbounded one is the no-window case wearing a number. The CEILING is 12
  // rather than 6 because a 64 pt strip is legitimately that long and thin —
  // the A35's column reaches 11.25 — and 6 would have clipped the real knee.
  return clamp(Math.min(ratio(band), ratio(column)), 1.0, 12.0);
}

/**
 * THE FRONTIER MARKER — the answer to the opening stall.
 *
 * `frac` is 0..1 along the preview's OWN long axis, measured from the sweep's
 * start toward its end, and `dir` is the operator-facing direction that runs
 * in. The two together place a line on the panel that MOVES through the 2.4-2.9
 * seconds in which the panorama's extent does not.
 *
 * `dir` is {@link panoPlusSweepDirection} — deliberately reused rather than
 * re-derived. `previewFrontierFrac` is measured in the PUBLISHED image's own
 * order, and `Engine::orient` builds that order to run from the sweep's start
 * to its end (it mirrors the along axis for a negative sweep sign, and native
 * mirrors the fraction with it). So `frac === 1` IS the leading edge, and the
 * leading edge IS the direction the sweep advances. Deriving a second rotation
 * chain here is exactly how the HUD came to print `vert` for a horizontal
 * gesture; there is a validated function for this, so this uses it.
 *
 * `null` whenever there is nothing honest to draw: no status, no latch, an
 * engine that predates the field (it parses to -1, never to 0), or a fraction
 * outside [0, 1].
 */
export interface PanoPlusPreviewMarker {
  /** 0..1 from the sweep's start toward its end. */
  frac: number;
  /** Which way "toward 1" points for the operator. */
  dir: PanoPlusSweepDir;
  /** `true` when `dir` runs along the operator's vertical. */
  tall: boolean;
}

export function panoPlusPreviewMarker(
  status: PanoPlusStatus | null,
  screenIsLandscape: boolean,
  orientation: PanoPlusOrientation = PANO_PLUS_DEFAULT_ORIENTATION,
): PanoPlusPreviewMarker | null {
  if (status == null) return null;
  const frac = status.previewFrontierFrac;
  if (!(frac >= 0) || frac > 1) return null;
  const dir = panoPlusSweepDirection(status, screenIsLandscape, orientation);
  if (dir == null) return null;
  return { frac, dir, tall: dir === 'up' || dir === 'down' };
}

/**
 * "SHOWING x OF y" — the caption a windowed preview owes the operator.
 *
 * Once the frontier window engages, the panel is a SLICE and no longer the
 * whole panorama. Without a caption that is a silent lie of omission: the
 * operator's "where am I" question gets an answer that looks complete and is
 * not. `null` while the view IS the whole band, which is every one of his
 * sweeps to date — the window only engages past the knee.
 *
 * Metres, not pixels, and derived rather than assumed: one canvas px is
 * `subjectDistanceM / (fx * canvasScale)` of shelf, and neither the focal
 * length nor the canvas scale is a JS constant. So the host passes
 * `metresPerCanvasPx` when it can compute one and gets a metre caption; with
 * nothing passed the caption is a PERCENTAGE, which needs no calibration and
 * cannot be wrong.
 */
export function panoPlusPreviewWindowCaption(
  status: PanoPlusStatus | null,
  metresPerCanvasPx?: number,
): string | null {
  if (status == null || !status.previewWindowed) return null;
  const view = status.previewViewPx;
  const band = status.previewBandPx;
  if (!(view > 0) || !(band > view)) return null;
  if (metresPerCanvasPx != null && metresPerCanvasPx > 0) {
    return `showing the last ${(view * metresPerCanvasPx).toFixed(1)} m of `
      + `${(band * metresPerCanvasPx).toFixed(1)} m`;
  }
  return `showing the last ${Math.round((100 * view) / band)}% — `
    + 'the panel holds its scale instead of shrinking';
}

/**
 * v12 — the frontier marker's one-line explainer. The operator asked, of his
 * own recording, "what is the blue line in the preview part?" — a 2 pt
 * rgba(127,215,255) bar that had carried the engine's single most load-bearing
 * boundary (committed | provisional) for two builds without a word of caption.
 * Shown only while the marker itself is shown (a sweep in flight with the
 * frontier inside the view), and suppressed when the WINDOW caption needs the
 * same slot — that one changes what the whole panel means and wins.
 */
export function panoPlusFrontierCaption(
  status: PanoPlusStatus | null,
): string | null {
  if (status == null || !status.running) return null;
  const f = status.previewFrontierFrac;
  if (!(f >= 0 && f <= 1)) return null;
  return 'blue line = saved up to here · the dim end is live, not saved yet';
}

// ── THE CROSS-AXIS CEILING ──────────────────────────────────────────────────

/** `Config::canvasMaxHeightPx`. Mirrored here because the LIVE status reports
 *  the canvas's current cross extent and not the cap it is heading for, and a
 *  headroom warning needs both. A host that overrides the engine knob passes
 *  its own value; the constant is only the default. */
export const PANO_PLUS_DEFAULT_CANVAS_MAX_HEIGHT_PX = 2048;
/** `ensureCanvasBand`'s step. Growth is quantised to this, so "less than one
 *  step of room" is the exact point at which the next overhang is CLIPPED
 *  rather than absorbed. */
export const PANO_PLUS_CANVAS_GROW_STEP_PX = 128;
/** `Config::canvasScale`. Canvas px → source px, for a warning that quotes a
 *  number the operator's own frame can be measured against. */
export const PANO_PLUS_DEFAULT_CANVAS_SCALE = 0.5;
/** `Config::canvasMaxPixels`. `ensureCanvasBand` calls `areaWithinBudget`
 *  AFTER it has passed the height cap, so on a long sweep this is the bound
 *  that actually refuses the growth step. */
export const PANO_PLUS_DEFAULT_CANVAS_MAX_PIXELS = 18.0e6;

export interface PanoPlusCrossHeadroom {
  /** `'unknown'` before the latch — no canvas, nothing to be near. */
  level: 'unknown' | 'ok' | 'near' | 'full';
  canvasHeightPx: number;
  /** The CONFIGURED height cap, `Config::canvasMaxHeightPx`. */
  maxHeightPx: number;
  /** The cap that will actually bite, `min(maxHeightPx, ⌊maxPixels/width⌋)`,
   *  or `canvasHeightPx` itself when the host froze vertical growth. This is
   *  what the copy quotes; `maxHeightPx` is what the host configured. */
  effectiveMaxPx: number;
  /** Which of the three bounds produced `effectiveMaxPx`. `'frozen'` means
   *  `canvasGrowVertical` is off and the canvas will never grow again. */
  boundBy: 'height' | 'area' | 'frozen';
  /** Canvas px the cross axis can still grow by. */
  roomPx: number;
  /** The same room in SOURCE px, which is what a drift or a rectification
   *  angle is measured in. */
  roomSourcePx: number;
  /** Growth steps left. `0` ⇒ the next overhang clips. */
  stepsLeft: number;
}

/** The knobs beyond the two positional ones. Separated so the existing
 *  `(status, maxHeightPx, canvasScale)` call shape keeps working. */
export interface PanoPlusCrossHeadroomOptions {
  /** `Config::canvasMaxPixels`. */
  canvasMaxPixels?: number;
  /** `Config::canvasGrowVertical`. */
  canvasGrowVertical?: boolean;
}

/**
 * HOW CLOSE THE CROSS AXIS IS TO ITS CEILING — the one real risk portrait
 * capture carries, and the reason it gets its own reported quantity instead of
 * a reassurance.
 *
 * THE ARITHMETIC, from the three field packs (`meta.json`, verbatim):
 * `referenceIntrinsics` puts the stream at 1920x1440 (cx 958.86, cy 728.35);
 * `canvasScale` 0.5, `canvasPadPx` 128, `canvasMaxHeightPx` 2048. The latch
 * sizes the cross axis at one frame's footprint plus two pads:
 *
 *     1920 x 0.5 + 2 x 128 = 1216 canvas px
 *
 * and all three packs report `clipping.canvasH = 1216` exactly. So the ceiling
 * leaves 2048 − 1216 = 832 canvas px = 1664 SOURCE px of growth.
 *
 * ⚠️ AND THE FIRST VERSION OF THIS PARAGRAPH SPENT THAT BUDGET TWICE, which
 * matters because the "portrait can reach the ceiling" verdict rests on it.
 * It read the budget as ±544 canvas px about the centre — 1088 source px, 39°
 * — as though the band grew symmetrically. It does not. `ensureCanvasBand`
 * derives `needTop` and `needBot` INDEPENDENTLY and grows only the side that
 * overhangs (`addTop = stepUp(needTop)`, `addBot = stepUp(needBot)`), so a
 * MONOTONE one-way drift — which is what pitch and a drooping hand both are —
 * collects the entire 832 px on its own side:
 *
 *     128 (the pad already there) + 832 = 960 canvas px = 1920 SOURCE px
 *
 * Converted honestly, for one-directional drift:
 *
 *   · rotation:    1920 px ÷ fx 1338.46  ⇒  atan  =  55.1° of cross tilt
 *   · translation: 1920 x Z ÷ 1338.46    ⇒  1.43 x Z metres
 *                  = 0.72 m at 0.5 m standoff, 0.93 m at 0.65 m,
 *                    1.15 m at 0.8 m
 *
 * WHY HIS SWEEPS NEVER TOUCHED IT, and why portrait is different:
 * the cross axis is whatever the sweep is NOT. In his landscape top-to-bottom
 * hold the cross axis is world-HORIZONTAL, and a standing operator tilting the
 * phone down barely moves along it — measured `maxCrossRectifyDeg` 5.10°,
 * `canvasHeightGrowths` 0, `clipping.frames` 0 on the pack quoted above. In a
 * portrait left-to-right hold the cross axis is world-VERTICAL, which is the
 * axis PITCH moves the image along and the axis a walking operator's hand
 * height wanders along. Against the corrected 1920 px: 20° of pitch is 487
 * source px on its own (fx·tan20°) and a 15 cm hand droop over a 3 m aisle
 * walk at 0.65 m adds 309, so the two together are 796 — 41% of the budget,
 * not the 73% first claimed. Reachable on a long aisle, not on a bay.
 *
 * SO THE VERDICT IS WEAKER THAN IT WAS AND THE FUNCTION IS UNCHANGED BY THAT,
 * which is the point of measuring headroom live instead of predicting it:
 * `roomPx` is read off the canvas the engine actually built, so it is right
 * whichever way the arithmetic above lands.
 *
 * THE SECOND BOUND, which the first version named in prose and then did not
 * model. `ensureCanvasBand` checks `areaWithinBudget(canvasW, nh)` AFTER it
 * has passed `canvasMaxHeightPx`, so `canvasMaxPixels` (18e6) refuses the
 * height step once `canvasW · nh` exceeds it — at 2048 rows that is a canvas
 * ~8789 px wide, about 8.5 m of aisle at 0.65 m standoff. That is exactly the
 * long portrait walk being shipped, and without modelling it this function
 * would report `ok` right up to the clip. `effectiveMaxPx` is therefore
 * `min(maxHeightPx, ⌊maxPixels / canvasWidthPx⌋)`.
 *
 * THE THIRD: `canvasGrowVertical` is a host-settable option. With it off the
 * canvas never grows, clipping starts at the latch height, and a headroom
 * function that quoted the 2048 cap would be describing a ceiling the engine
 * will never walk to. That case reports `full` / `'frozen'` immediately.
 *
 * So this is reported BEFORE the loss, not after. `clippedFrames` is the
 * after: by the time it moves, shelf height is already gone and the hole gate
 * is blind to it.
 */
export function panoPlusCrossHeadroom(
  status: PanoPlusStatus | null,
  maxHeightPx: number = PANO_PLUS_DEFAULT_CANVAS_MAX_HEIGHT_PX,
  canvasScale: number = PANO_PLUS_DEFAULT_CANVAS_SCALE,
  opts: PanoPlusCrossHeadroomOptions = {},
): PanoPlusCrossHeadroom {
  const max = maxHeightPx > 0 ? maxHeightPx : PANO_PLUS_DEFAULT_CANVAS_MAX_HEIGHT_PX;
  const scale = canvasScale > 0.01 ? canvasScale : PANO_PLUS_DEFAULT_CANVAS_SCALE;
  const maxPixels =
    opts.canvasMaxPixels != null && opts.canvasMaxPixels > 0
      ? opts.canvasMaxPixels
      : PANO_PLUS_DEFAULT_CANVAS_MAX_PIXELS;
  const h = status?.canvasHeightPx ?? 0;
  if (status == null || h <= 0) {
    return {
      level: 'unknown',
      canvasHeightPx: 0,
      maxHeightPx: max,
      effectiveMaxPx: max,
      boundBy: 'height',
      roomPx: 0,
      roomSourcePx: 0,
      stepsLeft: 0,
    };
  }
  // The area bound, in the engine's own terms: `ensureCanvasBand` grows the
  // HEIGHT of a canvas whose width it does not touch, so the rows it can still
  // afford are `maxPixels / canvasWidthPx`. Unknown width ⇒ no area bound
  // rather than a guessed one.
  const w = status.canvasWidthPx;
  const areaMaxPx = w > 0 ? Math.floor(maxPixels / w) : Number.POSITIVE_INFINITY;
  let effectiveMaxPx = Math.min(max, areaMaxPx);
  let boundBy: 'height' | 'area' | 'frozen' = areaMaxPx < max ? 'area' : 'height';
  if (opts.canvasGrowVertical === false) {
    effectiveMaxPx = h;
    boundBy = 'frozen';
  }
  const roomPx = Math.max(0, effectiveMaxPx - h);
  const stepsLeft = Math.floor(roomPx / PANO_PLUS_CANVAS_GROW_STEP_PX);
  // `full` = the engine can no longer absorb ANY overhang, so the very next
  // one is clipped. `near` = under three steps, which at 128 canvas px a step
  // is 768 source px — about 30° of cross tilt at this device's fx, i.e. one
  // ordinary hand movement away from `full`.
  const level = stepsLeft < 1 ? 'full' : stepsLeft < 3 ? 'near' : 'ok';
  return {
    level,
    canvasHeightPx: h,
    maxHeightPx: max,
    effectiveMaxPx,
    boundBy,
    roomPx,
    roomSourcePx: Math.round(roomPx / scale),
    stepsLeft,
  };
}

// ── The 1D governor (R4) ────────────────────────────────────────────────────

/** How loud the guidance is. `stop` means the sweep is over or must be
 *  restarted; `warn` means correct NOW; `ok` means keep going. */
export type PanoPlusTone = 'ok' | 'warn' | 'stop';

export interface PanoPlusGuidance {
  headline: string;
  detail: string;
  tone: PanoPlusTone;
}

/**
 * THE CAPTURE GESTURE, in words. T1 is a governed 1D sweep — that is the
 * tier's spec, not a failure patch (V16 held "forward-only pan motion" against
 * the shelved engine while judging it by a free-motion ambition that belongs to
 * T2+).
 *
 * ORDER IS THE CONTRACT, most-serious first, because only one line is shown:
 *   1. aborted            — the sweep is dead; say which way it died.
 *   2. tracking not normal — nothing can be latched; ARKit has to settle.
 *   3. stalled            — the aliasing cage refused for `cageStallFrames`.
 *                           This is NF3's visible pause: the engine will NOT
 *                           widen its search, so the operator has to.
 *   4. too fast           — the next frame is at risk of leaving the cage.
 *   5. no motion          — held; the panorama is not growing.
 *   6. clipping           — cross-axis content is ALREADY being truncated and
 *                           the hole gate cannot see it.
 *   7. gap-break          — G1 already failed somewhere; say so DURING the
 *                           sweep, not only in the summary.
 *   8. backtrack          — high-water is holding; nothing is being lost, and
 *                           the copy has to say that or the operator "fixes"
 *                           a non-problem by restarting.
 *   9. cross-axis `full`  — nothing is lost YET; the next drift truncates.
 *  10. cross-axis `near`  — under one hand-movement of room left.
 *  11. ok.
 *
 * ⚠️ RUNGS 9 AND 10 SIT BELOW 6-8 ON PURPOSE, AND THE FIRST CUT OF THEM DID
 * NOT. They were written above `gap-break`, and `canvasHeightPx` only ever
 * grows (`ensureCanvasBand` never shrinks the band), so past ~1793 px the
 * SPECULATIVE warning masked the REALISED one permanently: a status carrying
 * `gapBreak 5` at canvas 1920 printed "Running out of room" and the hole was
 * never mentioned again for the rest of the sweep. A warning about a loss that
 * has not happened must never hide a loss that has.
 *
 * The mirror mistake — putting them below and letting a sticky `gapBreak` bury
 * the one rung that can still PREVENT a loss — is avoided by making the
 * ceiling NON-SUPPRESSING rather than merely lower: {@link crossCeilingNote}
 * rides in the `detail` of whichever realised-fault rung wins, and raises its
 * tone. So the headline always belongs to the most serious thing that has
 * actually happened, and the ceiling is still said. Reported, never hidden —
 * in both directions.
 */
export interface PanoPlusGuidanceContext {
  /** The hold the operator is ACTUALLY in. Drives the idle coaching, which is
   *  the whole point: both holds are first-class and the copy follows the
   *  operator rather than insisting on one. */
  orientation?: PanoPlusOrientation;
  /** `window.width > window.height`. Needed with `orientation` to turn the
   *  latched axis into a direction the operator's eye can check. */
  screenIsLandscape?: boolean;
  /** `Config::canvasMaxHeightPx`, so the cross-axis ceiling can be warned
   *  about BEFORE it truncates. Defaults to the engine's own 2048. */
  canvasMaxHeightPx?: number;
  /** `Config::canvasScale`, so the warning can quote source px. */
  canvasScale?: number;
  /** `Config::canvasMaxPixels`. The AREA budget refuses a height step before
   *  the height cap does on a long sweep — see {@link panoPlusCrossHeadroom}. */
  canvasMaxPixels?: number;
  /** `Config::canvasGrowVertical`. When the host turns it off the canvas
   *  cannot grow at all, so the pre-loss warning has to fire immediately
   *  rather than never. */
  canvasGrowVertical?: boolean;
}

export function panoPlusGuidance(
  status: PanoPlusStatus | null,
  phase: 'idle' | 'starting' | 'sweeping' | 'finishing',
  ctx: PanoPlusGuidanceContext = {},
): PanoPlusGuidance {
  // ONE DEFAULT, SHARED. This read `'landscape-left'` while
  // `panoPlusSweepDirection` defaulted to `'portrait'`, so a two-argument
  // caller got "Panning ↓" from the governor and "pano+ ←" from the HUD for
  // the SAME status — the two lines disagreeing by a quarter turn, which is
  // the exact class of bug this change set exists to remove. The live surface
  // always passes a context so it never showed, but both are public SDK
  // exports and the offline mockup tools call them bare.
  const orientation = ctx.orientation ?? PANO_PLUS_DEFAULT_ORIENTATION;
  const hold = panoPlusHoldOf(orientation);
  const coached = panoPlusCoachedSweep(hold);
  if (phase === 'idle') {
    // ── THE PRE-SWEEP COACHING IS GONE (2026-09-07) ────────────────────────
    //
    // The operator, looking at the capture screen: "Why is the text on the
    // screen needed - regarding the panning? pano works the same way already
    // right?" It does. Pano coaches nothing before a pan, pano+ is to look
    // exactly like Pano, and the paragraph that stood here — the hold
    // headline, the 0.5–0.8 m standoff, the ONE-direction sentence and the
    // "Either hold works" rider — was an INSTRUCTION, never a finding.
    //
    // ⚠ NOTHING IS LOST FROM THE PACK BY THIS, and that is checked rather
    // than assumed: `panoPlusSweepHudSidecar` records the guidance line the
    // surface last rendered BEFORE `'finishing'`, which on every sweep is a
    // SWEEPING line ('Panning ↓ — keep it steady', 'Break in the panorama').
    // The idle line could never reach the sidecar, so unlike the engine and
    // drops readouts — which were RELOCATED into the pack on 2026-09-03 —
    // this one is a deletion with nothing to relocate.
    //
    // The two holds stay first-class where it still matters: `coached` below
    // drives every DURING-sweep sentence about which edge is clipping and
    // which way the drift runs.
    if (hold === 'portrait-upside-down') {
      // KEPT, because it is a REASON and not coaching: the hand over the lens
      // and the reversed arrows are two things the operator cannot see for
      // himself, and this rung never disabled anything. Only its coaching
      // tail (the standoff and the ONE-direction spec) went with the rest.
      return {
        headline: 'Turn the phone the right way up',
        detail:
          'Upside-down works, but your hand sits over the lens and the '
          + 'coaching arrows point backwards.',
        tone: 'warn',
      };
    }
    // NOTHING TO SAY BEFORE THE SWEEP. Empty rather than a shorter sentence:
    // the surface gates the line on a non-empty headline, so this is what
    // draws no text at all — see `panoplus-guidance` in the capture surface.
    return { headline: '', detail: '', tone: 'ok' };
  }
  if (phase === 'starting') {
    // v6 — NAME THE METERING WAIT. `start()` locks AE/AWB/AF for the sweep,
    // and before it can it must let the camera re-converge after the video
    // format switch (`meteringSettleMs`, a ceiling on a poll of the device's
    // own `isAdjusting*` flags). The frame plugin registers only AFTER that,
    // so an operator who begins panning on the button press has that motion
    // dropped on the floor. Saying so is the difference between a deliberate
    // wait and what looks like lag.
    return {
      headline: 'Metering — hold still',
      detail:
        'Locking exposure and focus for the sweep. Do not start panning until '
        + 'this clears.',
      tone: 'ok',
    };
  }
  if (phase === 'finishing') {
    return {
      headline: 'Finishing the panorama…',
      detail: 'Writing the canvas and the pack. Do not leave this screen.',
      tone: 'ok',
    };
  }
  if (status == null) {
    return {
      headline: 'Waiting for frames…',
      detail:
        'No AR frame has reached the engine yet. If this persists, AR tracking '
        + 'has not started.',
      tone: 'warn',
    };
  }
  if (status.abort != null) {
    return {
      headline: `Sweep stopped — ${status.abort}`,
      detail: abortDetail(status.abort),
      tone: 'stop',
    };
  }
  if (status.tracking < 2) {
    // ⚠ SAY WHY, WHEN ARCORE HAS SAID WHY. The operator sat on this message
    // through four separate attempts, and its advice — hold steady — is
    // actively WRONG for the reason he was actually hitting: ARCore reported
    // INSUFFICIENT_LIGHT on 126 of 186 poses in a dark room, where holding
    // steady forever changes nothing. The reason was in the pack the whole
    // time and never reached the screen.
    const why = status.arTrackingFailure;
    if (why === 'INSUFFICIENT_LIGHT') {
      // ⚠ THIS LABEL IS NOT ABOUT LIGHT, AND SAYING IT WAS IS THE WORST THING
      // THIS FILE SHIPPED. Measured across all 17 ARCore sidecars on disk:
      // INSUFFICIENT_LIGHT first appears at ARCore row 60 in 12 of 13 failing
      // packs (row 61 in the thirteenth), 2001-2062 ms after ARCore's first
      // row, is contiguous to the last row in 13 of 13, and never returns to
      // NONE — one pack holds it for 7,245 rows across 247 seconds without
      // varying once. It is a COUNT of frames, not a clock and not a photometer.
      // Brightness does not move it: ISO p50 across the packs spans 30 to 1911,
      // a 64x range, and a capture at ISO 79 / 33.32 ms — about 3.3 stops
      // DARKER — tracked cleanly.
      //
      // It is the label ARCore latches when its one-shot motion-tracking
      // bootstrap fails to converge inside a fixed ~2 s window. pano+ spends
      // that single window inside the sweep, because ARCore is resumed only
      // after the AE settle, so its one attempt runs on a camera that is
      // already panning.
      //
      // The operator, on being told his sunlit room was too dark: "Are you
      // kidding me? I am sitting in a sun lit room!!" He was right, the camera
      // agreed with him at ISO 31, and a frame from that very sweep is a bright,
      // sharp, feature-rich room. Advising him to turn a light on could never
      // have worked.
      return {
        headline: 'AR tracking did not start',
        detail:
          'ARCore gives its motion tracking one short window at the start of '
          + 'the sweep and it missed it. This says nothing about the light. '
          + 'Switch the pose source to IMU — the sweep works without AR.',
        tone: 'warn',
      };
    }
    if (why === 'INSUFFICIENT_FEATURES') {
      return {
        headline: 'Not enough texture for AR',
        detail:
          'ARCore has nothing to lock onto. Point at a shelf with product on '
          + 'it rather than a blank wall.',
        tone: 'warn',
      };
    }
    if (why === 'EXCESSIVE_MOTION') {
      return {
        headline: 'Moving too fast for AR',
        detail: 'Slow down — ARCore has lost the world while you pan.',
        tone: 'warn',
      };
    }
    return {
      headline: 'Waiting for AR tracking',
      detail: why !== ''
        // A reason ARCore gave that this build has no phrasing for. Printed raw
        // rather than swallowed: an unnamed reason the operator can read to me
        // beats a generic wait he has already seen fail.
        ? `ARCore reports ${why}. Nothing is painted until tracking is normal.`
        : 'Point at textured shelf and hold steady — nothing is painted until '
          + 'tracking is normal.',
      tone: 'warn',
    };
  }
  if (status.stalled) {
    return {
      headline: 'Lost the chain — slow down and re-approach',
      detail:
        'The match window refuses to widen (that is deliberate: a wider search '
        + 'on repeated shelf texture can lock one product-pitch off and corrupt '
        + 'the count silently). Move back over the last painted area slowly.',
      tone: 'stop',
    };
  }
  if (status.speed === 'fast') {
    return {
      headline: 'Too fast — slow down',
      detail: 'Keep the pan under a slow walking reach; the strip cannot keep up.',
      tone: 'warn',
    };
  }
  if (status.speed === 'no-motion' || status.outcome === 'skipped-no-advance') {
    return {
      headline: 'Keep panning',
      detail: 'No advance — the panorama is not growing.',
      tone: 'warn',
    };
  }
  // ── THE CROSS-AXIS CEILING, said BEFORE the loss and again after ────────
  //
  // Two rungs, deliberately, because they are two different facts:
  //   · `clippedFrames > 0` — content is ALREADY gone. The hole gate cannot
  //     see it; without this line a truncated panorama looks clean.
  //   · headroom `full` / `near` — the canvas cannot absorb the next drift.
  //     Nothing is lost YET, and this is the only rung that can still be
  //     acted on. It did not exist, and the ceiling had never been exercised
  //     (0 growths on all three field packs) because a landscape hold puts
  //     the cross axis on the world HORIZONTAL where a standing operator does
  //     not move. Portrait puts it on the world VERTICAL. See
  //     `panoPlusCrossHeadroom` for the arithmetic.
  const headroom = panoPlusCrossHeadroom(
    status,
    ctx.canvasMaxHeightPx ?? PANO_PLUS_DEFAULT_CANVAS_MAX_HEIGHT_PX,
    ctx.canvasScale ?? PANO_PLUS_DEFAULT_CANVAS_SCALE,
    {
      ...(ctx.canvasMaxPixels != null ? { canvasMaxPixels: ctx.canvasMaxPixels } : {}),
      ...(ctx.canvasGrowVertical != null
        ? { canvasGrowVertical: ctx.canvasGrowVertical }
        : {}),
    },
  );
  // The ceiling rides ALONG a realised fault rather than replacing it. See the
  // ⚠️ note on the rung order above: written as a rung above `gapBreak` this
  // masked a hole permanently, and written as a rung below it would have been
  // masked BY one, equally permanently. `withCeiling` is the way out of both.
  const ceilingNote = crossCeilingNote(headroom, coached);
  const withCeiling = (g: PanoPlusGuidance): PanoPlusGuidance =>
    ceilingNote == null
      ? g
      : {
          headline: g.headline,
          detail: `${g.detail} ${ceilingNote}`,
          tone: g.tone === 'stop' ? 'stop' : 'warn',
        };
  if (status.clippedFrames > 0) {
    return {
      // NAME THE RIGHT DIMENSION. This headline was hardcoded to "shelf
      // height" — correct for the portrait gesture and exactly backwards for
      // the landscape one the operator actually shoots, which loses shelf
      // WIDTH off the left and right. The detail below it had already been
      // fixed; the headline, which is the half he reads, had not.
      headline: `Losing ${crossDimension(coached)} — recentre the phone`,
      detail:
        `${status.clippedFrames} strip(s) have drifted off the ${crossEdges(coached)} of `
        + 'the canvas and are being TRUNCATED. The break check cannot see this. '
        // ...AND ONLY CLAIM THE CEILING WHEN IT IS TRUE. This asserted "the
        // canvas is at its 2048 px ceiling" unconditionally, quoting the CAP
        // rather than the current height. With `canvasGrowVertical` off (a
        // host option) clipping starts at the latch height of 1216 and that
        // sentence is simply false.
        + (headroom.level === 'full'
          ? `The canvas is at its ${headroom.effectiveMaxPx} px cross-axis `
            + `ceiling${headroom.boundBy === 'frozen' ? ' (vertical growth is off)' : ''} `
            + 'and cannot grow any further. '
          : `The canvas is ${headroom.canvasHeightPx}/${headroom.effectiveMaxPx} px `
            + 'across and is still growing, so this is drift faster than the '
            + 'canvas can follow. ')
        + 'Bring the shelf back to the middle of the frame and keep the phone '
        + 'level.',
      tone: 'warn',
    };
  }
  if (status.gapBreak > 0) {
    return withCeiling({
      headline: 'Break in the panorama',
      detail:
        `${status.gapBreak} frame(s) could not reach back to the painted edge — `
        + 'there is a hole. Reported, never hidden. Finish and re-shoot slower.',
      tone: 'warn',
    });
  }
  if (status.outcome === 'held-backtrack') {
    return withCeiling({
      headline: 'Going backwards — nothing lost',
      detail:
        'The frontier holds while you back up (no repainting, so no duplicated '
        + 'facings). Carry on forward when you are ready.',
      tone: 'warn',
    });
  }
  if (headroom.level === 'full') {
    return {
      headline: 'Canvas is at its cross-axis ceiling',
      detail:
        `The panorama has grown to ${headroom.canvasHeightPx} px across the `
        + `sweep — ${ceilingReason(headroom)}. Nothing is lost yet, but `
        + `the next drift ${crossWord(coached)} will be truncated instead of `
        + 'absorbed. Recentre the shelf in the frame NOW.',
      // `warn`, NOT `stop`. `stop` is documented as "the sweep is over or must
      // be restarted" and this sweep is neither — it is still painting, and
      // the rung is sticky for every remaining frame. It is also strictly less
      // severe than `clippedFrames`, which is already losing content and is
      // itself a `warn`; a not-yet-loss shouting louder than a realised one is
      // how a governor teaches an operator to ignore it.
      tone: 'warn',
    };
  }
  if (headroom.level === 'near') {
    return {
      headline: `Running out of room ${crossWord(coached)}`,
      detail:
        `${headroom.roomSourcePx} px of drift left before the panorama starts `
        + `losing ${crossDimension(coached)} — the canvas `
        + `is ${headroom.canvasHeightPx}/${headroom.effectiveMaxPx} px across`
        + `${headroom.boundBy === 'area' ? ' (the area budget, not the height cap)' : ''}. `
        + 'Recentre the shelf and keep the phone level.',
      tone: 'warn',
    };
  }
  // NAME THE DIRECTION THE ENGINE LATCHED, in the operator's frame. A sweep
  // that latched the opposite sign to the one being performed is a real
  // failure mode (the operator turns round and the frontier holds), and until
  // now the only place it appeared was the HUD's pixel-space `vert+`.
  const dir = panoPlusSweepDirection(
    status,
    ctx.screenIsLandscape ?? false,
    orientation,
  );
  const arrow = panoPlusSweepArrow(dir);
  return {
    headline: arrow === '' ? 'Panning — keep it steady' : `Panning ${arrow} — keep it steady`,
    detail: `Painted ${status.paintedWidthPx} px of canvas.`,
    tone: 'ok',
  };
}

/** `top or bottom` / `left or right` — the edges the CROSS axis runs to, in
 *  the operator's frame. A landscape top-to-bottom sweep loses shelf WIDTH off
 *  the left and right; a portrait left-to-right sweep loses shelf HEIGHT off
 *  the top and bottom. The shipped copy said "top or bottom" unconditionally,
 *  which is exactly backwards for the portrait gesture. */
function crossEdges(coached: PanoPlusCoachedSweep): string {
  return coached.tall ? 'left or right' : 'top or bottom';
}

/** `up or down` / `left or right` — the same axis said as a movement. */
function crossWord(coached: PanoPlusCoachedSweep): string {
  return coached.tall ? 'left or right' : 'up or down';
}

/** `shelf width` / `shelf height` — WHAT is lost when the cross axis clips.
 *  A landscape top-to-bottom sweep already covers the shelf height with the
 *  phone's long edge, so what runs off the canvas is WIDTH; a portrait
 *  left-to-right sweep loses HEIGHT. Three call sites now share this instead
 *  of two of them agreeing and the headline going its own way. */
function crossDimension(coached: PanoPlusCoachedSweep): string {
  return coached.tall ? 'shelf width' : 'shelf height';
}

/** Which of the three bounds the canvas is up against, said in words, so the
 *  copy cannot quote a 2048 px height cap at an operator whose canvas was
 *  actually refused by the 18 MP area budget or by a host that turned vertical
 *  growth off. */
function ceilingReason(h: PanoPlusCrossHeadroom): string {
  if (h.boundBy === 'frozen') {
    return 'vertical growth is turned off, so it will not grow at all';
  }
  if (h.boundBy === 'area') {
    return `the ${h.effectiveMaxPx} px the memory budget allows at this width`;
  }
  return `the ${h.effectiveMaxPx} px cap`;
}

/**
 * THE CEILING AS A RIDER, not a rung — the fix for a speculative warning
 * masking a realised one (and for the mirror mistake of the reverse).
 *
 * Returns `null` when there is nothing to add, which is every sweep the
 * operator has shot so far: all three field packs sit at 1216/2048 with six
 * growth steps in hand.
 */
function crossCeilingNote(
  headroom: PanoPlusCrossHeadroom,
  coached: PanoPlusCoachedSweep,
): string | null {
  if (headroom.level === 'full') {
    return `Also: the canvas is at ${headroom.canvasHeightPx}/${headroom.effectiveMaxPx} px `
      + `across — the next drift ${crossWord(coached)} will be truncated too.`;
  }
  if (headroom.level === 'near') {
    return `Also: only ${headroom.roomSourcePx} px of drift ${crossWord(coached)} left `
      + `(canvas ${headroom.canvasHeightPx}/${headroom.effectiveMaxPx} px) before `
      + `${crossDimension(coached)} starts being lost as well.`;
  }
  return null;
}

function abortDetail(abort: PanoPlusAbort): string {
  switch (abort) {
    case 'tracking-lost':
      return 'ARKit tracking went unavailable and stayed there, so there was no attitude to rectify with. A brief LIMITED blink does not do this. What was painted is kept.';
    case 'tracking-limited':
      return 'ARKit tracking dropped to limited and abortOnLimitedTracking was turned on. What was painted is kept.';
    case 'session-restart':
      return 'ARKit restarted with a new world origin (the camera view was detached, or the app was backgrounded). Two coordinate frames cannot be fused into one canvas, so the sweep was ended rather than corrupted.';
    case 'chain-lost':
      return 'The bounded match window found nothing confident for ~2 s. It refuses to widen — a silent alias is worse than a visible stop.';
    case 'canvas-full':
      return 'The sweep exceeded the canvas budget. This is a visible stop, not a silent truncation.';
    default:
      return 'What was painted is kept, and the pack records why the sweep ended.';
  }
}

// ── HUD ─────────────────────────────────────────────────────────────────────

/** v8 — ` 12/431`, or '' when this binary reported no support. Never `0/0`:
 *  an older engine sends neither key, and printing zero there would assert
 *  that nothing breached the bar when in fact nothing counted. */
function bandSupport(status: PanoPlusStatus): string {
  if (status.seamPhotoSamples <= 0) return '';
  return ` ${status.seamPhotoStepOverBar}/${status.seamPhotoSamples}`;
}

/** One dense line of engine truth. Deliberately shows the REJECTION buckets:
 *  a sweep that looks fine and is quietly rejecting a third of its frames is
 *  exactly the pass the residual analysis needs flagged in the field. */
export function panoPlusHudLine(
  status: PanoPlusStatus | null,
  ctx: PanoPlusGuidanceContext = {},
): string {
  if (status == null) return 'pano+  ·  waiting for frames';
  const rej =
    status.rejectedLowResponse
    + status.rejectedOutOfCage
    + status.rejectedPoseSpeed
    + status.rejectedRectify
    + status.rejectedTracking;
  // THE RAW PIXEL-SPACE LABEL IS KEPT — it is what `meta.json` records and
  // what an engineer reading a pack matches against. What is ADDED is the
  // direction in the operator's own frame, because `vert+` is a straight lie
  // in a portrait hold: a portrait left-to-right sweep latches `axis === 1`
  // and this line announced `vert` for a gesture running along the operator's
  // HORIZONTAL. Both are printed, so neither reading has to be guessed at.
  const axis = status.axisLatched
    ? `${status.axis === 1 ? 'vert' : 'horiz'}${status.sweepSign < 0 ? '−' : '+'}`
    : 'axis?';
  const arrow = panoPlusSweepArrow(
    panoPlusSweepDirection(status, ctx.screenIsLandscape ?? false, ctx.orientation),
  );
  // THE CROSS-AXIS CEILING, on the same line as the strip count and DURING
  // the sweep. It prints only once the room is worth naming, so the ordinary
  // line is unchanged — and it prints BEFORE `CLIP`, which is the after.
  const headroom = panoPlusCrossHeadroom(
    status,
    ctx.canvasMaxHeightPx ?? PANO_PLUS_DEFAULT_CANVAS_MAX_HEIGHT_PX,
    ctx.canvasScale ?? PANO_PLUS_DEFAULT_CANVAS_SCALE,
    {
      ...(ctx.canvasMaxPixels != null ? { canvasMaxPixels: ctx.canvasMaxPixels } : {}),
      ...(ctx.canvasGrowVertical != null
        ? { canvasGrowVertical: ctx.canvasGrowVertical }
        : {}),
    },
  );
  // `effectiveMaxPx`, not the configured cap: on a long sweep the 18 MP area
  // budget refuses the growth step first, and a HUD reading `1920/2048` while
  // the engine is actually refusing at 1920 would be reassurance, not truth.
  // `!` marks the bound as something other than the height cap.
  const crossBoundMark = headroom.boundBy === 'height' ? '' : '!';
  const cross =
    headroom.level === 'full'
      ? `CROSS FULL ${headroom.canvasHeightPx}/${headroom.effectiveMaxPx}${crossBoundMark}  ·  `
      : headroom.level === 'near'
        ? `cross ${headroom.canvasHeightPx}/${headroom.effectiveMaxPx}${crossBoundMark}  ·  `
        : '';
  return (
    `pano+ ${arrow === '' ? '' : `${arrow} `}${axis}  ·  ${cross}`
    + `${status.painted}/${status.framesSeen} painted  ·  `
    + `${status.paintedWidthPx}px  ·  adv ${status.advancePx.toFixed(1)}  ·  `
    + `strip ${status.stripPx.toFixed(1)}  ·  rej ${rej}  ·  `
    + `hold ${status.heldBacktrack}/${status.heldFrontier}  ·  `
    + (status.clippedFrames > 0 ? `CLIP ${status.clippedFrames}  ·  ` : '')
    // THE LIVE CUT VERDICT. The operator recorded four packs he could see were
    // broken while the HUD said nothing, so the seam state rides on the same
    // line as the strip count and does it DURING the sweep.
    //
    // v8 — AND ITS PROVENANCE. `seamBandSelfScored` was coerced into the status
    // and then read by nothing: the review screen carried the warning and the
    // LIVE HUD — the surface the operator actually reads during a sweep —
    // printed the bare number. `⚠fit` marks the one case where the percentile
    // is the residual of the fit that produced it (crossAvgWindows on), so a
    // low number on this line can never be quoted as proof the placement
    // improved. Empty under shipped defaults, so the ordinary line is
    // unchanged.
    + (status.painted > 0 && !status.seamMeasured
      ? 'seam ?  ·  '
      : status.integrityFailed
        ? `CUTS p95 ${status.seamWorstBandP95Px.toFixed(2)}`
          + `${status.seamBandSelfScored ? '⚠fit' : ''}  ·  `
        : status.painted > 0
          ? `seam ${status.seamWorstBandP95Px.toFixed(2)}`
            + `${status.seamBandSelfScored ? '⚠fit' : ''}  ·  `
          : '')
    // THE LIVE BANDING VERDICT (v6).  Same reason, one rejection later: the
    // operator rejected two builds for banding while the HUD carried nothing
    // about photometry at all.  `photoDriftLocalPct` is measured on COMMITTED
    // pixels over a 40-column window, so it includes the camera's own drift —
    // it is the number that corresponds to what he can see.
    //
    // v8 — AND ITS SUPPORT. `BAND 15%` with twelve breaching boundaries out of
    // four hundred and thirty-one is a different sweep from `BAND 15%` with
    // two hundred, and the HUD was showing the same word for both. The
    // operator's reply to the v6 banding claim was "I am not sure I see the
    // banding issue you are talking about"; a count is what settles that
    // without either side arguing. Suppressed entirely when the binary sent no
    // support — `0/0` would read as "nothing breached", which is a claim, not
    // an absence.
    + (status.photoDriftLocalPct > PANOPLUS_PHOTO_DRIFT_LOCAL_BAR
      ? `BAND ${status.photoDriftLocalPct.toFixed(0)}%${bandSupport(status)}  ·  `
      : status.painted > 0 && status.photoDriftLocalPct > 0
        ? `band ${status.photoDriftLocalPct.toFixed(0)}%${bandSupport(status)}  ·  `
        : '')
    // THE BAND SHEAR, LIVE (Test 14, 2026-09-04).
    //
    // `crossBandDivergenceNormPx` was on the wire, typed on PanoPlusStatus,
    // coerced out of the native payload, given a named bar
    // (PANOPLUS_BAND_DIVERGENCE_NORM_BAR) and wired into the POST-HOC verdict —
    // and read by ZERO live surfaces. Same shape as the v6 banding gap and the
    // v8 seam gap before it: the number the operator needed was already being
    // computed and was only ever shown to him after the sweep was over.
    //
    // MEASURED on the five Test-14 pano+ packs: 4.00 / 6.79 / 9.70 / 15.00 /
    // 28.41 px/√n against a 6.0 bar — FOUR of five breached, and the worst
    // (28.41) printed a healthy-looking `CUTS p95 0.42` beside it, because the
    // per-boundary seam is fine while the top and bottom of the panorama
    // disagree by hundreds of pixels about where the world is. Two numbers,
    // two different faults; showing only the first is what let four sweeps in
    // one session go home broken.
    //
    // NO GESTURE IS PRESCRIBED — see `panoPlusSweepFaults`. This field cannot
    // see walking (its own v8 header correction says so), and walking is a
    // supported regime with its own fixture. The number is reported; the cure
    // is not invented.
    + (status.painted > 0
      && status.crossBandDivergenceNormPx > PANOPLUS_BAND_DIVERGENCE_NORM_BAR
      ? `SHEAR ${status.crossBandDivergenceNormPx.toFixed(1)} px/√n  ·  `
      : status.painted > 0 && status.crossBandDivergenceNormPx > 0
        ? `shear ${status.crossBandDivergenceNormPx.toFixed(1)}  ·  `
        : '')
    + (status.maxAreaScale > 4 ? `WARP ${status.maxAreaScale.toFixed(1)}×  ·  ` : '')
    // THE PANEL'S OWN REFRESH RATE, and it prints ONLY when the duty throttle
    // has slowed it. Native treats `previewIntervalMs` as a floor and holds
    // the next tick off until the preview costs no more than its share of the
    // ingest queue, so a panel updating at 5 Hz on a hot phone is a MEASURED
    // decision — and "the preview does not look good as I pan" must never
    // again be a symptom with no number behind it. Silent at the configured
    // rate, so the ordinary line is unchanged.
    + (status.previewIntervalMs > PANO_PLUS_PREVIEW_INTERVAL_MS + 1
      ? `prev ${(1000 / status.previewIntervalMs).toFixed(1)}Hz  ·  `
      : '')
    + `${status.engineMs.toFixed(1)}ms`
  );
}

/**
 * THE HARD FAULTS, and ONLY the hard faults — the line that may print over a
 * running sweep.
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────
 * The surface's own policy (PanoPlusCaptureSurface, "EVERYTHING BELOW THE
 * HEADLINE IS IDLE-ONLY") says: "WHILE SWEEPING the HUD carries the headline
 * AND HARD FAULTS, and nothing else." That rule came from the operator, on a
 * healthy sweep, looking at five simultaneous runs of text over his viewfinder:
 * "There is still some text shown in the pano+ screen - no point of it!"
 *
 * The half that shipped was `{!sweeping && <hud/>}` — which drops the WHOLE
 * line, hard faults included. The hard-fault half was never written. So on a
 * sweep the screen went quiet about everything: the v5 CUTS warning, the v6/v8
 * BAND verdict, the drops line, and the shear rung added the same week. Each of
 * those had its own field incident behind it, and each was reachable only after
 * the sweep it was supposed to save had ended.
 *
 * ── WHAT COUNTS AS A HARD FAULT ────────────────────────────────────────────
 * Only a breach of a NAMED BAR, plus real drops. Never a healthy reading. A
 * clean sweep returns `null` and the screen stays exactly as quiet as the
 * operator asked for — which is what makes this compatible with his complaint
 * rather than a revert of it. The full readout is unchanged at idle, where it
 * is the bench read.
 *
 * MEASURED on the five Test-14 pano+ packs: four breach the shear bar (6.79,
 * 9.70, 15.00, 28.41 against 6.0) and the worst of them printed a healthy-
 * looking `CUTS p95 0.42` beside it. Under this function all four would have
 * said so mid-sweep, while a re-shoot was still free.
 */
export function panoPlusSweepFaults(status: PanoPlusStatus | null): string | null {
  if (status == null || status.painted <= 0) return null;
  const bits: string[] = [];
  // The GEOMETRIC faults first — they are the ones a gesture can still fix.
  if (status.crossBandDivergenceNormPx > PANOPLUS_BAND_DIVERGENCE_NORM_BAR) {
    // ⚠️ NO GESTURE IS PRESCRIBED HERE, and that is a correction.
    //
    // The first cut read `SHEAR n — PIVOT, don't walk`. That attributes the
    // shear to walking, and this field CANNOT see walking. Its own header says
    // so, as a v8 correction to exactly this mistake: it "was documented as THE
    // WOBBLE NUMBER through v5-v7 and it is NOT one" — the rigid cross
    // placement is common to every band and cancels in the max−min BY
    // CONSTRUCTION. "This measures how much the strips SHEAR relative to each
    // other … it says nothing about how far the panorama has WALKED."
    //
    // Walking is also a SUPPORTED regime, not an error: the model is
    // byte-identical on a pure-translation sweep, the pack STATES its regime
    // rather than judging it, and there is a walk fixture at
    // rotationFraction 0.00. Telling the operator to stop walking a shelf would
    // push him off a gesture the engine handles, on the strength of a number
    // that cannot support the claim — the v5-v7 mislabel, repeated.
    //
    // So the rung reports the fault and stops. The honest action is the one
    // that is true of any breach: this sweep is degrading while you can still
    // re-shoot it. Matches the post-hoc verdict, which prints `band shear N
    // px/√n` with no cure attached for the same reason.
    bits.push(
      `SHEAR ${status.crossBandDivergenceNormPx.toFixed(1)} px/√n — strips drifting apart`,
    );
  }
  if (status.integrityFailed) {
    bits.push(`CUTS p95 ${status.seamWorstBandP95Px.toFixed(2)}`);
  }
  if (status.maxAreaScale > 4) bits.push(`WARP ${status.maxAreaScale.toFixed(1)}×`);
  // …then the PHOTOMETRIC one, which he cannot fix by moving but must know
  // about before he keeps the pack.
  if (status.photoDriftLocalPct > PANOPLUS_PHOTO_DRIFT_LOCAL_BAR) {
    bits.push(`BAND ${status.photoDriftLocalPct.toFixed(0)}%${bandSupport(status)}`);
  }
  return bits.length > 0 ? bits.join('  ·  ') : null;
}

/** The second HUD line — the things that are DROPS, not decisions. A drop is
 *  data; silence about it is the failure. `null` when there is nothing to
 *  report, so a healthy pass shows no extra chrome. */
export function panoPlusDropLine(status: PanoPlusStatus | null): string | null {
  if (status == null) return null;
  const bits: string[] = [];
  if (status.droppedQueue > 0) bits.push(`${status.droppedQueue} frame(s) dropped (engine behind)`);
  if (status.droppedPack > 0) bits.push(`${status.droppedPack} pack write(s) dropped`);
  // A PREVIEW THAT CANNOT BE WRITTEN IS A DROP, and it goes FIRST among the
  // preview bits. The 2026-08-29 build had exactly this condition on every
  // tick of every sweep and printed nothing anywhere; the operator's only
  // evidence was an empty rectangle.
  //
  // EMPTY AND FROZEN ARE DIFFERENT SCREENS AND MUST NOT SHARE A SENTENCE.
  // The first cut of this line said "the panel is empty for that reason"
  // unconditionally — but that is only true while NOTHING has ever published
  // (`previewSeq <= 0`). If previews published for a while and then started
  // failing, the panel is showing a REAL panorama that has stopped advancing,
  // and telling the operator it is empty sends him looking for the wrong
  // fault. Read the seq to decide which screen he is actually holding.
  if (status.previewFails > 0) {
    bits.push(
      `${status.previewFails} PREVIEW WRITE(S) FAILED — the panel is `
      + (status.previewSeq > 0
        ? `FROZEN at the last one that reached disk (#${status.previewSeq}), `
          + 'not live'
        : 'empty for that reason')
      + ', the sweep is not affected',
    );
  }
  // COALESCING IS CORRECT BEHAVIOUR, SO IT IS NOT REPORTED AS A DROP — but a
  // publisher that is losing MORE ticks than it lands is no longer merely
  // coalescing, it is falling behind, and the operator watching a panel crawl
  // deserves to be told that rather than left to wonder whether it has hung.
  // The threshold is the honest one: skips outnumbering renders.
  if (status.previewSkips > status.previewRenders && status.previewSkips > 0) {
    bits.push(
      `preview BEHIND — ${status.previewSkips} tick(s) coalesced away vs `
      + `${status.previewRenders} rendered; the panel updates slowly, the `
      + 'sweep is not affected',
    );
  }
  if (status.clippedFrames > 0) {
    bits.push(`${status.clippedFrames} strip(s) TRUNCATED (drifted off the band)`);
  }
  if (status.limitedFrames > 0) bits.push(`${status.limitedFrames} limited-tracking frame(s)`);
  if (status.maxRectifyDeg > 0) bits.push(`rectify ≤ ${status.maxRectifyDeg.toFixed(1)}°`);
  // v6 — AN UNLOCKED SWEEP IS A DROP, not a decision: the exposure lock is
  // best-effort (ARKit owns the capture session), so a refused lock has to be
  // visible DURING the sweep rather than in the pack afterwards.  1.000 with
  // metered frames is the proof it held; no metered frames at all is UNKNOWN
  // and says so rather than implying either.
  if (status.exposureMetaFrames > 0 && status.exposureRangeRatio > 1.02) {
    bits.push(
      `EXPOSURE UNLOCKED — drifting ${((status.exposureRangeRatio - 1) * 100).toFixed(0)}%`,
    );
  } else if (status.painted > 0 && status.exposureMetaFrames === 0) {
    bits.push('exposure UNMEASURED (no per-frame metadata on this path)');
  }
  return bits.length > 0 ? bits.join('  ·  ') : null;
}

/**
 * v6 — what the CAMERA LOCK reported at start, as one operator-facing line.
 *
 * WHY THIS EXISTS SEPARATELY from {@link panoPlusDropLine}'s drift clause. The
 * drift clause is the better signal — it reads what the exposure actually DID
 * — but it cannot fire until the exposure has already moved >2%, by which
 * point some of the sweep is already banded. This one fires at t=0, off the
 * device's own read-back, so an operator whose phone refused the lock learns it
 * before he pans rather than from the pack afterwards.
 *
 * `null` when the lock took cleanly and there is nothing to say — a healthy
 * sweep shows no extra chrome, same rule as the drop line.
 *
 * ⚠ AN ABSENT `locked` IS "NOT KNOWN YET", NOT "REFUSED". iOS writes the bit
 * on every path (`RNISPanoCameraLock.lockAttached` sets it on refusal, on
 * `device-busy`, and from the read-back), so on that contract this clause and
 * `!== true` are the same test. Android's `start()` cannot know: its read-back
 * is written on the camera thread and published at `stop()`, so the start bag
 * carries `requested` and no `locked` — and reading that as a refusal printed
 * EXPOSURE NOT LOCKED at t=0 of a sweep whose lock had not been read yet.
 * (Until 2026-09-03 the Android bag also omitted `available`, which this
 * function read as NO CAMERA DEVICE over a live feed from an open camera.) The
 * live measurement for the unknown case is `panoPlusDropLine`'s drift clause.
 */
export function panoPlusCameraLockLine(
  lock: PanoPlusCameraLock | null | undefined,
): string | null {
  if (lock == null) return null;
  if (!lock.available) return 'NO CAMERA DEVICE — exposure cannot be locked or measured';
  if (lock.requested !== true) return null;
  const bits: string[] = [];
  if (lock.locked === false) {
    bits.push(
      lock.reason != null && lock.reason !== ''
        ? `EXPOSURE NOT LOCKED — ${lock.reason}`
        : 'EXPOSURE NOT LOCKED',
    );
  }
  // A lock taken over a still-converging camera is not the same failure and
  // must not be reported as the same one: the sweep is uniformly mis-metered
  // rather than banded.
  if (lock.settleConverged === false) {
    bits.push('metering did not settle — sweep may be uniformly mis-metered');
  }
  if (lock.focusLockDeclined === true) {
    bits.push('focus left on AUTO (lens was still hunting)');
  }
  return bits.length > 0 ? bits.join('  ·  ') : null;
}

/**
 * The live preview's `<Image>` source.
 *
 * `previewSeq` is the cache-bust, and it is load-bearing: the engine writes the
 * SAME path every time (tmp + atomic rename, so JS can never read a half file),
 * so without the query RN's image cache would show frame 1 forever. Same
 * mechanism the library's own `PanoramaBandOverlay` uses.
 */
export function panoPlusPreviewSource(
  status: PanoPlusStatus | null,
): { uri: string } | null {
  if (status == null || status.previewPath === '' || status.previewSeq <= 0) {
    return null;
  }
  return { uri: `${fileUri(status.previewPath)}?v=${status.previewSeq}` };
}

/**
 * THE PANORAMA'S SHAPE, as width ÷ height OF THE JPEG'S PIXELS.
 *
 * NOT what the operator sees: `preview.jpg` is sensor-referenced (see
 * {@link panoPlusImageRotationDeg}), so on a portrait-locked host the two are
 * transposes of each other. {@link panoPlusPreviewLayout} does that conversion
 * once, in one place; everything else should read `layout.aspect`.
 *
 * Read in this order, and the order is the point:
 *  1. the published preview's own pixel dims — exact, and it is the very image
 *     that will be rendered;
 *  2. the oriented canvas dims — `canvasHeightPx`/`paintedWidthPx` are the
 *     INTERNAL canvas (the engine always sweeps along its own +X and transposes
 *     at the end), so a vertical sweep has to be un-transposed here. This is
 *     the path a binary that predates `previewW/H` takes, and it is why the fix
 *     works on a phone that has not been re-flashed with the new engine;
 *  3. {@link PANO_PLUS_DEFAULT_PREVIEW_ASPECT} — before the axis latches there
 *     is nothing painted and nothing to be shaped by, so the placeholder gets a
 *     neutral band.
 */
export const PANO_PLUS_DEFAULT_PREVIEW_ASPECT = 2.2;

export function panoPlusPreviewAspect(status: PanoPlusStatus | null): number {
  if (status == null) return PANO_PLUS_DEFAULT_PREVIEW_ASPECT;
  if (status.previewW > 0 && status.previewH > 0) {
    return status.previewW / status.previewH;
  }
  // The internal canvas sweeps along X and is transposed for a vertical sweep,
  // so the ORIENTED extents swap when `axis === 1`.
  const along = status.paintedWidthPx;
  const cross = status.canvasHeightPx;
  if (along > 0 && cross > 0) {
    return status.axis === 1 ? cross / along : along / cross;
  }
  return PANO_PLUS_DEFAULT_PREVIEW_ASPECT;
}

/**
 * DEVICE ORIENTATION, as this SDK needs it.
 *
 * Structurally identical to `react-native-image-stitcher`'s
 * `DeviceOrientation`, and deliberately re-declared rather than imported: the
 * hook that produces it is public, but the geometry helpers that consume it
 * (`contentRotationDeg`, `placeAtUserEdge`) are NOT exported from that
 * package's `src/index.ts`, and the stitcher is the PUBLIC repo — reaching
 * into it or widening its API for a private capture surface is the boundary
 * this project does not cross. The twenty lines below are the same model,
 * derived independently and pinned by tests here.
 */
export type PanoPlusOrientation =
  | 'portrait'
  | 'portrait-upside-down'
  | 'landscape-left'
  | 'landscape-right';

/** A quarter turn, in the sign RN's `transform: rotate` uses (clockwise). */
export type PanoPlusRotateDeg = 0 | 90 | -90 | 180;

function norm180(deg: number): PanoPlusRotateDeg {
  let d = deg;
  while (d > 180) d -= 360;
  while (d <= -180) d += 360;
  return d as PanoPlusRotateDeg;
}

function isQuarter(deg: PanoPlusRotateDeg): boolean {
  return deg === 90 || deg === -90;
}

/**
 * How far the FRAMEBUFFER is turned from the device, and how far the device is
 * turned from gravity. Everything else on this page is derived from these two.
 *
 * `jsLandscape` is measured (window width > height), not assumed: a
 * portrait-LOCKED host reports portrait dimensions no matter how the phone is
 * held — which is any portrait-locked host (an Info.plist listing
 * `UIInterfaceOrientationPortrait` and nothing else for iPhone, and no
 * `supportedInterfaceOrientations` override exists) — while a non-locked host
 * has the OS rotate the framebuffer for it.
 */
function frameBufferRotDeg(
  jsLandscape: boolean,
  orientation: PanoPlusOrientation,
): PanoPlusRotateDeg {
  if (!jsLandscape) return 0;
  if (orientation === 'landscape-left') return 90;
  if (orientation === 'landscape-right') return -90;
  return 0;
}

function deviceRotDeg(orientation: PanoPlusOrientation): PanoPlusRotateDeg {
  if (orientation === 'landscape-left') return 90;
  if (orientation === 'landscape-right') return -90;
  if (orientation === 'portrait-upside-down') return 180;
  return 0;
}

/**
 * THE GLYPH ROTATION — Pano's `contentRotation`, and ONLY that.
 *
 * ⚠ THIS WAS `panoPlusChromeRotationDeg` UNTIL 2026-09-03, AND IT TURNED
 * WHOLE LAYOUT BLOCKS: the HUD's inner box, the in-frame notices, the basis
 * card and the result screen's root were each rotated by it and their boxes
 * transposed, so a portrait-locked host held sideways showed pano+ chrome
 * lying the other way from Pano's. The operator's requirement is that pano+
 * looks EXACTLY like Pano, and Pano rotates nothing but GLYPHS: the stitcher's
 * `useContentRotation` is applied to the `<Text>` inside the lens chip's
 * pills and the AR pill (`Camera.tsx` :1245, :1265, :1342) while every
 * container — the pill stack, the bottom bar, the chip itself — stays laid
 * out in the portrait framebuffer. Nothing else on that screen turns.
 *
 * So this is now the same truth table (`useContentRotation.ts`: net =
 * deviceRot − framebufferRot, normalised to (−180, 180]) under a name that
 * says what it may be applied to. It is consumed by `PanoChrome`'s two pills
 * and by nothing that lays out a box. Zero on a non-locked host because the OS
 * already turned the framebuffer.
 */
export function panoPlusGlyphRotationDeg(
  jsLandscape: boolean,
  orientation: PanoPlusOrientation,
): PanoPlusRotateDeg {
  return norm180(deviceRotDeg(orientation) - frameBufferRotDeg(jsLandscape, orientation));
}

/**
 * THE ROTATION THE PANORAMA NEEDS — AND IT IS NOT THE CHROME'S.
 *
 * `preview.jpg` is written by `cv::imwrite` with NO EXIF orientation tag, so
 * RN's `<Image>` will not auto-rotate it, and its pixels are the engine's
 * ORIENTED canvas — which `Engine::orient` defines as an exact undo of the
 * axis/sign remap, i.e. the INPUT FRAME's own axes. The input frame is
 * `ARFrame.capturedImage`, the raw sensor buffer (RNISPanoCore.mm converts
 * NV12/BGRA to BGR and rotates nothing). So the panorama is SENSOR-REFERENCED.
 *
 * Sensor-referenced content behaves the opposite way to chrome: the sensor and
 * the screen are both bolted to the phone, so the transform between them is a
 * CONSTANT — which is exactly why a camera preview looks upright to you in any
 * hold while the buttons around it read sideways. The constant is a quarter
 * turn clockwise, and this codebase already states it: the stitcher's
 * `PanoramaBandOverlay.tileRotation` records that a saved keyframe is
 * "sensor-native landscape + EXIF Orientation 6, which RN's <Image> already
 * auto-rotates upright" and needs NO further transform in the portrait-locked
 * path. EXIF 6 IS a 90° clockwise rotation. We do not get the EXIF, so we
 * apply the 90° ourselves.
 *
 * On a NON-locked host the OS has already turned the framebuffer by `fbRot`,
 * so the remaining turn is `90 - fbRot` — 0° in landscape-left, 180° in
 * landscape-right. Same formula, and the locked host is the `fbRot = 0` case.
 *
 * This is why the fix does NOT ask the accelerometer for the preview: an
 * orientation-driven ±90 would be right in one landscape hold and 180° wrong
 * in the other.
 */
export function panoPlusImageRotationDeg(
  jsLandscape: boolean,
  orientation: PanoPlusOrientation,
): PanoPlusRotateDeg {
  return norm180(90 - frameBufferRotDeg(jsLandscape, orientation));
}

// ── THE UPRIGHT BAKE — the DELIVERABLE's turn, not the screen's ─────────────

/**
 * THE BACK-CAMERA SENSOR CONSTANT, named once.
 *
 * The raw camera raster is landscape-native and needs a quarter turn clockwise
 * to stand upright with the phone in ITS natural (portrait) orientation. This
 * is the same 90 {@link panoPlusImageRotationDeg} has spelled since v7 — it is
 * the iPhone back camera's fixed value, and it is Camera2's
 * `SENSOR_ORIENTATION` on the Galaxy A35 (`device.json`).
 *
 * ⚠ On Android it is an ASSUMPTION, not a law: some tablets report 0 or 270.
 * `PanoPlusLiveModule.correctUprightRotation` unwinds this constant and
 * re-derives the bake against the device's real `SENSOR_ORIENTATION` before the
 * sweep starts, which is why the SDK is allowed to assume it here.
 */
export const PANO_PLUS_SENSOR_ORIENTATION_CW_DEG = 90;

/**
 * THE QUARTER TURN THE FINISHED PANORAMA NEEDS BAKED INTO ITS PIXELS.
 *
 * ── THE DEFECT ────────────────────────────────────────────────────────────
 * Operator, 2026-09-02: *"the output image is sideways"*. Reproduced on his own
 * packs from that day — the four `hold: 'landscape'` sweeps come out upright
 * and the one `hold: 'portrait'` sweep comes out a quarter turn over, shelves
 * running DOWN the image. Rotating that canvas 90° CW gives a plumb, level,
 * correct panorama; nothing shears, so it is a missing turn and not a warp.
 *
 * ── WHY THE PREVIEW WAS ALWAYS RIGHT AND THE JPEG NEVER WAS ───────────────
 * `preview.jpg` and `canvas.jpg` come out of the SAME engine call chain in the
 * SAME (camera raster) frame. The preview looked correct anyway because it is
 * drawn on a screen bolted to the same body as the sensor, and this file
 * already turns it — {@link panoPlusImageRotationDeg} on the way to the
 * framebuffer — and the framebuffer is then turned by the operator's own hand
 * (`deviceRot − fbRot`, the glyph truth table in
 * {@link panoPlusGlyphRotationDeg}) on the way to his eye. A JPEG has no such
 * chain behind it. So the turn the display path performs live has to be BAKED
 * for the deliverable, and it is exactly the same turn:
 *
 *     panoPlusImageRotationDeg − panoPlusGlyphRotationDeg
 *       = (90 − fbRot) − (deviceRot − fbRot)
 *       = 90 − deviceRot
 *       = panoPlusUprightRotationDeg
 *
 * The `fbRot` terms cancel, so this is INVARIANT to whether the host is
 * orientation-locked — the same invariance check that pinned the sign of
 * {@link panoPlusSweepDirection}, and it is asserted in the tests. If a future
 * change makes those two disagree, one of the two paths has become wrong.
 *
 * ── THE FOUR HOLDS ────────────────────────────────────────────────────────
 *
 *   hold                    deviceRot   upright bake   verified
 *   portrait                     0          90         pack 22-56-36, was sideways
 *   landscape-left              90           0         pack 22-50-04, already right
 *   portrait-upside-down       180         270         derived
 *   landscape-right           −90 (270)    180         derived
 *
 * Only the two landscape holds are separable here, which is why this takes the
 * full {@link PanoPlusOrientation} and NOT `panoPlusHoldOf`'s collapsed
 * `'landscape'`: left and right differ by a half turn, and a pack recording only
 * `hold: 'landscape'` cannot tell them apart.
 *
 * ── WHAT IT IS NOT ────────────────────────────────────────────────────────
 * Not an EXIF tag (`cv::imwrite` writes none, and `rnis_pano_replay.cpp`
 * documents that an EXIF-applying `imread` would mis-scale every replayed
 * frame). Not a rotation at ingest (that is the standing repo trap — rotated
 * pixels against unoriented intrinsics, which would break every `H_rect`). Not
 * applied to the ledger, `unpaintedRuns`, `verticalEnvelope` or
 * `PreviewWindow`: those stay canvas-frame, and native publishes
 * `outputRotationCwDeg` so a reader can map them onto the image.
 *
 * Returned CLOCKWISE in 0..270, the sign and range
 * `rnis::pano::Config::outputRotationCwDeg` accepts — deliberately NOT
 * {@link PanoPlusRotateDeg}, whose `-90` the engine would refuse by name.
 */
export function panoPlusUprightRotationDeg(
  orientation: PanoPlusOrientation = PANO_PLUS_DEFAULT_ORIENTATION,
  sensorOrientationCwDeg: number = PANO_PLUS_SENSOR_ORIENTATION_CW_DEG,
): 0 | 90 | 180 | 270 {
  const d = ((sensorOrientationCwDeg - deviceRotDeg(orientation)) % 360 + 360) % 360;
  // Quarter turns only, by construction: both terms are quarter turns. The cast
  // is the type system catching up with that, not a rounding.
  return d as 0 | 90 | 180 | 270;
}

/** Where the growing panorama goes, and what the HUD must keep clear of it. */
export interface PanoPlusPreviewLayout {
  /** `band` — a wide panorama, AS THE OPERATOR SEES IT. `panel` — a TALL one
   *  down one side, which is what his top-to-bottom gesture produces. Both are
   *  decided in the operator's frame, not the framebuffer's. */
  placement: 'band' | 'panel';
  /** Absolute-position frame for the preview CONTAINER, in framebuffer dp.
   *
   *  ⚠ A PURE FUNCTION OF THE WINDOW SINCE 2026-09-03 — it does NOT read the
   *  panorama. See {@link fixedBand}. */
  frame: { left: number; top: number; width: number; height: number };
  /** The rotation container's box, in dp, BEFORE {@link imageRotateDeg} is
   *  applied: {@link frame} minus {@link PREVIEW_BAND_PADDING} on all four
   *  sides, transposed on a quarter turn. Rotating this box about its centre
   *  lands it exactly on the frame's padded interior. Fixed with the frame. */
  inner: { width: number; height: number };
  /** The IMAGE's DRAWN size, in dp, in the same pre-rotation coordinates as
   *  {@link inner}: the published preview `contain`-fitted into it. THIS is
   *  the thing that grows — the frame does not. */
  content: { width: number; height: number };
  /** Where {@link content} sits inside {@link inner}. The sweep's START edge
   *  is pinned and the cross axis is centred, so the image grows out of one
   *  fixed end of a fixed strip — which is what answers "not knowing where the
   *  pano starts", and what Pano does. */
  anchor: { left: number; top: number };
  /** The quarter turn the `<Image>` carries — see
   *  {@link panoPlusImageRotationDeg}. */
  imageRotateDeg: PanoPlusRotateDeg;
  /** Absolute-position frame for the HUD block, in framebuffer dp. Derived
   *  from the same numbers as {@link frame}, so the two can never overlap.
   *
   *  ⚠ THERE IS NO `hudContent` / `noticeContent` / `chromeRotateDeg` ANY MORE
   *  (2026-09-03). The HUD and the in-frame notices are laid out in the
   *  framebuffer and never turned — exactly as Pano's chrome is — so the box
   *  a word wraps in IS `hud` (or `frame`), not a transpose of it. See
   *  {@link panoPlusGlyphRotationDeg} for the one rotation that survives. */
  hud: { left: number; top: number; width: number; height: number };
  /** The panorama's shape ON THE FRAMEBUFFER (w ÷ h), i.e. after
   *  {@link imageRotateDeg}. Not the JPEG's pixel aspect: on a portrait-locked
   *  host those are transposes. */
  aspect: number;
}

/**
 * The window the preview is placed in — and its SAFE-AREA INSETS, which are
 * load-bearing for exactly one reason: the sensor housing is a bar down one
 * edge, and the panel this layout introduces lives at an edge. A panel that
 * loses its middle third behind the Dynamic Island reads as "I still cannot
 * see the preview", the report this whole change exists to answer. The insets
 * say which edges are actually usable, so nothing here has to guess.
 *
 * Absent insets are treated as zero: a host with no SafeAreaProvider gets the
 * previous geometry rather than a crash or a guess.
 */
export interface PanoPlusScreen {
  width: number;
  height: number;
  insets?: {
    top?: number;
    left?: number;
    right?: number;
    bottom?: number;
  };
  /**
   * Points of CHROME across the bottom of the window that the preview and the
   * HUD must stay above, measured from the bottom edge (2026-09-03).
   *
   * Since the parity change the bottom of this surface is Pano's stack —
   * the shell's shutter row, the mode bar and, above them, the lens chip — and
   * none of it is a safe-area inset: the shell docks the mode bar at
   * `insets.bottom + 96` and lifts the chip 150 pt over the bar. `usableBox`'s
   * own `PREVIEW_BOTTOM` was sized for the surface's OLD 52 pt button row, so
   * without this the HUD's slab could run down under the chip. Combined by
   * MAX with the inset rule so an absent value is byte-identical.
   */
  bottomChromePt?: number;
  /**
   * Has the OS rotated the FRAMEBUFFER — a WINDOW fact, not a box fact.
   *
   * ⚠ THIS FIELD EXISTS BECAUSE ONE ARGUMENT WAS ANSWERING TWO QUESTIONS.
   * `panoPlusPreviewLayout` derives `jsLandscape` from `width > height` of
   * whatever it is handed, and uses it for the image ROTATION — which is
   * about the framebuffer's turn and nothing else. When the surface moved
   * its layout onto its own measured BOX (so the capsule stops being placed
   * against a window it does not fill), that derivation moved with it. The
   * box's shape is the HOST's business: a host that gives this surface a
   * wide short area inside a portrait window would flip the bake.
   *
   * So width/height/insets/bottomChromePt describe the usable BOX, and this
   * describes the SCREEN. Absent ⇒ derived from width/height as before, so
   * every existing caller is byte-identical.
   */
  jsLandscape?: boolean;
}

/** Margins + reserved chrome, named rather than sprinkled through the maths. */
const PREVIEW_MARGIN = 8;
/** Clear of the notch / status area. */
const PREVIEW_TOP = 56;
/** Clear of the controls row (bottom 36 + a 52 pt button + breathing room). */
const PREVIEW_BOTTOM = 104;
// ── THE FIXED CAPSULE, COPIED FROM THE SLIT-SCAN BAND (owner, 2026-09-03) ───
//
// ⚠ `PREVIEW_PANEL_BIAS` / `PREVIEW_PANEL_WIDTH_FRAC` / `PREVIEW_PANEL_WIDTH_MAX`
// LIVED HERE UNTIL 2026-09-03, and with them the whole idea that the frame is
// computed FROM THE PANORAMA. That idea is the defect: `fitBand`/`fitPanel`
// derived width, height AND `left` from the live pixel aspect, so every publish
// moved the box. Measured on the operator's 03-01-08 pack against his own
// 390x844 window: the frame walked `left` 232 → 111 → 105 → 87 → 67 across one
// sweep and changed shape at the latch. His words: "As I start moving the
// location of the preview box changes — this is funny! WHY??"
//
// The replacement is the geometry the incremental / slit-scan pass already
// ships and that he asked for by name — `react-native-image-stitcher`'s
// `PanoramaBandOverlay.tsx`, mounted by the same unified chrome pano+ runs
// under (`Camera.tsx:3283`, `bottomBarOffset: 150`, `hideBuiltInShutter`). Its
// invariant, and now ours: THE CAPSULE IS A PURE FUNCTION OF THE WINDOW. Only
// the image inside it grows, along one axis, bounded.
/** `PanoramaBandOverlay.tsx:139` `BAND_THICKNESS`. */
const PREVIEW_BAND_THICKNESS = 64;
/** `PanoramaBandOverlay.tsx:138` `BAND_PADDING` — the inset between the dark
 *  capsule and the pixels, applied on all four sides (`:261-263`). */
const PREVIEW_BAND_PADDING = 6;
/** `layoutFor`'s portrait branch (`:351-356`) and its vertical branch
 *  (`:289-295`): 16 pt along the strip, 8 pt across it. Applied ON TOP of
 *  {@link PREVIEW_MARGIN}, which the stitcher does not have because its band
 *  sits inside an already-inset bottom area. */
const PREVIEW_BAND_MARGIN_LONG = 16;
const PREVIEW_BAND_MARGIN_CROSS = 8;

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

interface Frame {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** The usable rectangle: the window minus its insets minus the surface's own
 *  chrome (the controls row at the bottom, the status area at the top). All
 *  four numbers are FRAMEBUFFER-space, because that is where the chrome is. */
interface Usable {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

function usableBox(screen: PanoPlusScreen, sw: number, sh: number): Usable {
  const i = screen.insets ?? {};
  const left = PREVIEW_MARGIN + Math.max(0, i.left ?? 0);
  const right = sw - PREVIEW_MARGIN - Math.max(0, i.right ?? 0);
  const top = Math.max(PREVIEW_TOP, Math.max(0, i.top ?? 0) + 8);
  const bottom = sh - Math.max(
    PREVIEW_BOTTOM,
    Math.max(0, i.bottom ?? 0) + 96,
    Math.max(0, screen.bottomChromePt ?? 0),
  );
  return { left, right, top, bottom };
}

// ⚠ `toUserRect` / `toFbRect` / `usableUser` LIVED HERE UNTIL 2026-09-03. They
// mapped the usable box into "the operator's frame" (the framebuffer turned by
// the chrome rotation) so the fit could happen there. The chrome is not turned
// any more — Pano's is not — so the operator's frame IS the framebuffer and the
// fit happens directly in it. The two frames only ever differed by that one
// rotation, so nothing about the fit rules below changed.

/**
 * THE BAND CAPSULE — a fixed 64 pt strip along the framebuffer's BOTTOM edge.
 *
 * ⚠ NO `aspect` PARAMETER, and that absence is the fix. Bottom, not top,
 * because that is where the slit-scan band sits: the stitcher docks it inside
 * `bottomArea` (`Camera.tsx:3705-3723`, `position:'absolute', bottom:0`) just
 * above the shutter row, and the operator asked for pano+'s preview to "appear
 * like what we created for the incremental (slit-scan) method". `usableBox`
 * has already reserved Pano's whole bottom stack in `u.bottom`, so this clears
 * the shutter, the mode bar and the lens chip by construction.
 */
function fixedBand(u: Usable): Frame {
  const availW = Math.max(120, u.right - u.left);
  const availH = Math.max(96, u.bottom - u.top);
  const width = Math.max(96, availW - 2 * PREVIEW_BAND_MARGIN_LONG);
  // A window too short for the capsule plus its margin gets the capsule, moved
  // up rather than shrunk: a 40 pt strip would be a stamp, not a preview.
  const height = Math.min(PREVIEW_BAND_THICKNESS, Math.max(40, availH));
  return {
    left: Math.round(u.left + PREVIEW_BAND_MARGIN_LONG),
    top: Math.round(Math.max(u.top, u.bottom - PREVIEW_BAND_MARGIN_CROSS - height)),
    width: Math.round(width),
    height: Math.round(height),
  };
}

/** THE COLUMN CAPSULE — the same 64 pt strip stood on end down the
 *  framebuffer's right edge, mirroring `layoutFor`'s `vertical` branch
 *  (`PanoramaBandOverlay.tsx:289-295`: `width: BAND_THICKNESS`, margins 8
 *  across / 16 along). Fixed for the same reason the band is. */
function fixedColumn(u: Usable): Frame {
  const availW = Math.max(120, u.right - u.left);
  const availH = Math.max(96, u.bottom - u.top);
  const width = Math.min(PREVIEW_BAND_THICKNESS, Math.max(40, availW));
  const height = Math.max(96, availH - 2 * PREVIEW_BAND_MARGIN_LONG);
  return {
    left: Math.round(u.right - PREVIEW_BAND_MARGIN_CROSS - width),
    top: Math.round(u.top + PREVIEW_BAND_MARGIN_LONG),
    width: Math.round(width),
    height: Math.round(height),
  };
}

/**
 * THE HUD GOES IN THE BIGGEST LEFTOVER, and the split is chosen by area rather
 * than by which way the preview happens to be long. Computed in FRAMEBUFFER
 * space against the framebuffer rect the preview actually occupies, so no
 * mapping error can put a dense engine line on top of the panorama.
 */
function hudBox(frame: Frame, u: Usable): Frame {
  const uw = Math.max(0, u.right - u.left);
  const uh = Math.max(0, u.bottom - u.top);
  const above = Math.max(0, frame.top - u.top);
  const below = Math.max(0, u.bottom - (frame.top + frame.height));
  const leftOf = Math.max(0, frame.left - u.left);
  const rightOf = Math.max(0, u.right - (frame.left + frame.width));
  const horizontalH = Math.max(above, below);
  const verticalW = Math.max(leftOf, rightOf);
  if (horizontalH * uw >= verticalW * uh) {
    const useBelow = below >= above;
    const top = useBelow ? frame.top + frame.height + 12 : u.top + 4;
    const height = Math.max(48, (useBelow ? below : above) - 16);
    return clampToUsable(
      { left: u.left + 4, top: Math.round(top), width: Math.max(80, uw - 8), height: Math.round(height) },
      u,
    );
  }
  const useRight = rightOf >= leftOf;
  const left = useRight ? frame.left + frame.width + 8 : u.left + 4;
  const width = Math.max(80, (useRight ? rightOf : leftOf) - 12);
  return clampToUsable(
    { left: Math.round(left), top: u.top + 4, width: Math.round(width), height: Math.max(48, uh - 8) },
    u,
  );
}

/** Keep a derived rect on screen when the preview fills the usable box exactly
 *  and there is no leftover to put the HUD in — a degenerate case a near-square
 *  panorama on a small window can reach. Never grows a rect, only pulls it
 *  back, so the ordinary path is untouched. */
function clampToUsable(r: Frame, u: Usable): Frame {
  const width = Math.min(r.width, Math.max(60, u.right - u.left));
  const height = Math.min(r.height, Math.max(40, u.bottom - u.top));
  return {
    left: Math.round(clamp(r.left, u.left, Math.max(u.left, u.right - width))),
    top: Math.round(clamp(r.top, u.top, Math.max(u.top, u.bottom - height))),
    width: Math.round(width),
    height: Math.round(height),
  };
}

/**
 * IS THE SWEEP TALL ON THE FRAMEBUFFER? — the placement decision, and the one
 * thing `axis` on its own cannot answer.
 *
 * `axis === 1` says the panorama grows along the sensor's image-Y, i.e. it is
 * tall IN THE JPEG'S PIXELS. One quarter turn stands between those pixels and
 * the framebuffer — {@link panoPlusImageRotationDeg} — and it transposes tall
 * and wide. This walks it with the same number the aspect chain uses, so the
 * two can never disagree.
 *
 * ⚠ THIS TOOK A SECOND TURN (`chromeRotateDeg`, framebuffer → operator) UNTIL
 * 2026-09-03 and was named `…ToOperator`. That turn compensated for the HUD
 * block being rotated to read upright in a sideways hold; the block is not
 * rotated any more (Pano's is not), so the framebuffer IS the frame the
 * placement is decided in. What that means on the portrait-locked host (the
 * app: `Info.plist` lists only `UIInterfaceOrientationPortrait`, image = 90
 * in every hold): an axis-1 sweep is WIDE on the framebuffer and lands in the
 * band along the framebuffer's top edge — which, in the operator's landscape
 * hold, is the strip down the world's left, i.e. the same panel he had.
 *
 * Exported because it is a claim about geometry, and a claim about geometry
 * should be assertable on its own rather than only through a 40-line layout.
 */
export function panoPlusSweepIsTall(
  axis: number,
  imageRotateDeg: PanoPlusRotateDeg,
): boolean {
  const tallInPixels = axis === 1;
  return isQuarter(imageRotateDeg) ? !tallInPixels : tallInPixels;
}

/**
 * Size, place and ORIENT the live preview from the panorama's own shape.
 *
 * WHY THIS IS A PURE FUNCTION AND NOT A STYLESHEET ENTRY — the whole reason
 * this file exists. The shipped surface hard-coded
 * `{ left: 8, right: 8, top: 96, height: 120 }`: a landscape letterbox. Every
 * one of the operator's four packs is a VERTICAL sweep, so the preview it
 * received was a ~200x220 image of a 1344x1471 panorama, drawn `contain` into
 * a 120 pt-tall strip — 110x120 pt on screen, and SHRINKING as the sweep grew.
 * "I do not see a live preview of the image growing" is exactly that geometry.
 *
 * TWO THINGS MATTER ABOUT THE FRAME THIS IS COMPUTED IN, and both are pinned.
 *
 *  1. A PORTRAIT-LOCKED HOST (an Info.plist with only the portrait
 *     orientation; on Android the
 *     lock pano+ holds while mounted, the same one the stitcher's `<Camera>`
 *     holds). Held sideways, `useWindowDimensions()` still returns 390x844 —
 *     never 844x390. The fit happens IN THAT FRAMEBUFFER, and the chrome is not
 *     turned to compensate — since 2026-09-03, deliberately, because Pano's is
 *     not: a portrait-locked framebuffer held sideways shows Pano's bar down
 *     the side and its glyphs turned, nothing else. (Until then the fit was
 *     done in a transposed "operator" rectangle and the HUD block rotated
 *     back; that made pano+ lay out unlike the surface next to it.) The panel
 *     rules below still produce the same order of size either way — a tall
 *     sweep in a sideways hold fits as a band along the framebuffer's top,
 *     which is the strip down one side of what the operator sees.
 *
 *  2. THE PANORAMA IS SENSOR-REFERENCED, NOT FRAMEBUFFER-REFERENCED. Drawn
 *     with no transform it lies on its side. See
 *     {@link panoPlusImageRotationDeg} for why the correction is a CONSTANT
 *     quarter turn on a locked host and not an accelerometer-driven ±90. That
 *     turn STAYS: it is what makes the viewfinder-and-panorama read upright to
 *     the operator through any hold, which is exactly what Pano's own preview
 *     does for the same reason.
 *
 * PLACEMENT FOLLOWS THE LATCHED AXIS, not the current aspect — that is what
 * keeps it from flipping mid-sweep. A horizontal sweep starts nearly square
 * (one frame's footprint) and only becomes a band as it grows; deciding on
 * aspect alone would open it as a panel and snap it into a band a second
 * later.
 *
 * BUT THE AXIS IS NOT THE ANSWER — IT IS THE INPUT. This used to read
 * `usePanel = status.axis === 1`, with the comment conceding its own scope:
 * "in either landscape hold is the world vertical". In a PORTRAIT hold that
 * is false. The sensor's image-Y runs along the phone's SHORT edge in every
 * hold, so a portrait left-to-right sweep latches `axis === 1` too — and the
 * old line then opened a tall PANEL for a WIDE panorama and squeezed it into
 * a sliver, which is the exact failure shape of the 2026-08-23 bug this whole
 * function exists to fix, arriving from the other orientation.
 *
 * So the axis is carried through the SAME ROTATION the aspect is: pixel space
 * -> framebuffer (`imageRotateDeg`). `axis === 1` means the panorama grows
 * along the JPEG's pixel-Y, i.e. it is TALL IN PIXEL SPACE; a quarter turn
 * transposes that. What comes out is "tall on the framebuffer", which is the
 * thing actually being decided — and it agrees with `aspect < 1` by
 * construction, while staying a stable latched boolean instead of a ratio that
 * starts near 1 and moves.
 *
 * ⚠ THE FRAME NO LONGER HUGS THE IMAGE, AND THAT IS THE 2026-09-03 FIX. It
 * used to: `fitBand`/`fitPanel` took the live pixel aspect and returned width,
 * height AND `left` from it, so the box moved on every publish. On the
 * operator's 03-01-08 pack, in his own 390x844 window, it walked `left`
 * 232 → 111 → 105 → 87 → 67 and changed shape at the latch — "As I start
 * moving the location of the preview box changes - this is funny! WHY??", and
 * "The preview box is too big - why does it not appear like what we created
 * for the incremental (slit-scan) method?" (the old band reached 374x240 pt,
 * 27% of the screen).
 *
 * The frame is now a FIXED capsule copied from the slit-scan band the same
 * chrome already carries, and the panorama is `contain`-fitted INSIDE it,
 * anchored at the sweep's start edge. Only `content` and `anchor` move.
 */
export function panoPlusPreviewLayout(
  status: PanoPlusStatus | null,
  screen: PanoPlusScreen,
  orientation: PanoPlusOrientation = PANO_PLUS_DEFAULT_ORIENTATION,
): PanoPlusPreviewLayout {
  const sw = Math.max(120, screen.width);
  const sh = Math.max(120, screen.height);
  // ⚠ THE SCREEN'S TURN, NOT THE BOX'S — see `PanoPlusScreen.jsLandscape`.
  // The fallback keeps every caller that does not supply it unchanged.
  const jsLandscape = screen.jsLandscape ?? sw > sh;
  const imageRotateDeg = panoPlusImageRotationDeg(jsLandscape, orientation);

  // The JPEG's own pixel aspect → what it occupies on the framebuffer once
  // rotated. That is the frame the fit happens in: the chrome is never turned
  // (Pano parity, 2026-09-03), so there is no further "operator" transpose.
  const pixelAspect = clamp(panoPlusPreviewAspect(status), 0.05, 20);
  const aspect = isQuarter(imageRotateDeg) ? 1 / pixelAspect : pixelAspect;

  const u = usableBox(screen, sw, sh);

  // ── PLACEMENT ─────────────────────────────────────────────────────────────
  // Latched: follow the axis through the rotation, as before. UNLATCHED: the
  // BAND, unconditionally — the old area comparison (`PREVIEW_PANEL_BIAS`) has
  // nothing left to compare now that both candidates are constants, and it was
  // the second half of the operator's "this is funny!": a near-square bootstrap
  // publish scored `band` and the axis-0 latch then teleported it 157 pt into
  // the panel. Band is also the answer the field asks for — all five of his
  // 2026-09-01 packs latch `axis === 1`, which maps to `band` on this
  // portrait-locked host. An axis-0 sweep still flips ONCE, at the latch, and
  // must: a horizontal capsule for a vertical panorama is the 2026-08-23
  // sliver bug returning.
  const usePanel =
    status != null && status.axisLatched
    && panoPlusSweepIsTall(status.axis, imageRotateDeg);

  const frame = usePanel ? fixedColumn(u) : fixedBand(u);
  const hud = hudBox(frame, u);

  // The rotation container: the frame's padded interior, transposed on a
  // quarter turn so that rotating it about its centre lands it back on that
  // interior exactly.
  const padW = Math.max(8, frame.width - 2 * PREVIEW_BAND_PADDING);
  const padH = Math.max(8, frame.height - 2 * PREVIEW_BAND_PADDING);
  const inner = isQuarter(imageRotateDeg)
    ? { width: padH, height: padW }
    : { width: padW, height: padH };

  // ── THE IMAGE INSIDE, `contain`-FITTED ───────────────────────────────────
  // `pixelAspect` is the JPEG's own w÷h, so the fit is done in pre-rotation
  // coordinates — the same frame `inner` is in.
  const content = {
    width: Math.min(inner.width, inner.height * pixelAspect),
    height: Math.min(inner.height, inner.width / pixelAspect),
  };

  // ── THE ANCHOR: WHICH END OF THE STRIP THE PANORAMA GROWS OUT OF ─────────
  //
  // Derived from the PLACEMENT, not from `status.axis`, and the difference is
  // load-bearing. `status.axis` is 0 until the latch commits — so an anchor
  // read off it would pin the pre-latch seed frame across the strip's
  // thickness, centred along its length, and then jump it to the end at the
  // latch. Placement is the one decision that is already stable across that
  // boundary, and post-latch the two agree by construction: `panoPlusSweepIsTall`
  // IS the axis carried through `imageRotateDeg`, so band ⇔ (axis 1 under a
  // quarter turn) ⇔ along-is-pixel-Y, in every one of the four combinations.
  //
  // THE SWEEP SIGN DECIDES *WHICH* END, and this used to say it did not.
  //
  // The canvas always grows toward +u — the sign is folded into the projection
  // at `axisMatrix(axis, sweepSign)` (rnis_pano.cpp:2424) — and `Engine::orient`
  // then MIRRORS the along axis when the sign is negative (rnis_pano.cpp:2333-2341:
  // `cv::flip(band, out, 1)` for axis 0, `cv::flip(tr, out, 0)` for axis 1).
  // So the growing edge lands at along-MAX of the PUBLISHED image for sign +1
  // and at along-MIN for sign −1, which puts the sweep's START at the opposite
  // end in each case.
  //
  // The engine's own test is the oracle and it asserts exactly this:
  // rnis_pano_test.cpp:2764-2767 — `frontierFrac ≈ 1.0` for sweepSign +1,
  // `≈ 0.0` for sweepSign −1, commented "a negative sweep sign mirrors the
  // along axis, so the same physical frontier reports the OTHER end of the
  // image". The frontier IS the growing edge.
  //
  // Pinning along-MIN unconditionally therefore welded the LEADING edge to the
  // strip on every reversed sweep and slid the START away across it as the
  // image lengthened — defect #2's stated purpose ("not knowing where the pano
  // starts") failing for half of all holds, and a moving picture inside the
  // very box that was just pinned to stop things moving. It is in the
  // operator's own data: `Pano plus tau = 0/panoplus-debug-pack-2026-08-31T18-28-10-098Z`
  // records axis 1, sweepSign −1, 366 strips painted.
  //
  // Pre-latch the seed has no direction yet and `sweepSign` coerces to +1, so
  // it keeps the along-MIN end; the latch is where the sign becomes real.
  const alongIsPixelY = isQuarter(imageRotateDeg)
    ? !usePanel
    : usePanel;
  const startAtAlongMax = status != null && status.axisLatched && status.sweepSign < 0;
  //
  // ── AND THE CROSS AXIS IS PINNED TOO, WHICH IT WAS NOT ───────────────────
  //
  // ⚠ THE NOTE ABOVE STATED THE RULE AND THEN APPLIED IT TO ONE AXIS. "A
  // centred image in a fixed strip would still drift as it grew" is exactly
  // right, and the cross axis is the one that actually shrinks: the ALONG
  // extent saturates at `inner`'s long side early, and from then on a
  // `contain` fit can only keep the aspect by THINNING the cross extent. A
  // centred shrinking extent moves, every publish, for the rest of the sweep.
  //
  // Measured, iPhone 16 Pro band (`inner` 52 × 342), horizontal sweep:
  //
  //   along px │  1440  3000  6000  9000  14000
  //   cross pt │  52.0  52.0  52.0  41.0   26.4
  //   anchor   │   0.0   0.0   0.0   5.5   12.8   ← walks
  //
  // The rotation container turns pre-rotation `left` into a SCREEN-VERTICAL
  // offset, so the operator sees the strip slide down the band for the whole
  // second half of a long hold. Reported 2026-09-19: "Once I start the sweep,
  // everything drifts downward!"
  //
  // Pinning costs nothing before the thinning starts — `content` fills the
  // cross axis until then, so centred and pinned are the SAME number — and
  // after it starts, the strip stays welded instead of sliding.
  const anchor = alongIsPixelY
    ? {
        left: 0,
        top: startAtAlongMax ? inner.height - content.height : 0,
      }
    : {
        left: startAtAlongMax ? inner.width - content.width : 0,
        top: 0,
      };

  return {
    placement: usePanel ? 'panel' : 'band',
    frame,
    inner,
    content,
    anchor,
    imageRotateDeg,
    hud,
    aspect,
  };
}

/**
 * What to write inside the preview frame when there is no preview image yet.
 *
 * An EMPTY frame is the failure the operator reported, so the frame says which
 * of the FOUR states it is in rather than being a dark rectangle:
 *  · not sweeping                    → `null` (no frame is drawn at all)
 *  · sweeping, nothing painted yet   → the engine has not latched an axis
 *  · sweeping for a while and NO STATUS HAS EVER ARRIVED → the channel itself
 *    is down. This rung was missing, and its absence is the exact shape of the
 *    bug being fixed: with `status === null` the calm "will appear here as you
 *    pan" was printed forever, so an unregistered plugin, a dead bridge or an
 *    AR-meta channel that never fires all read as "not yet". Both channels
 *    (the AR frame meta at 10 Hz and the 2 Hz poll fallback) have to be silent
 *    for this to fire, so it cannot be a slow first frame.
 *  · sweeping, strips painted, still no preview → the engine is drawing them
 *    and this screen is not receiving them.
 *
 * `sweepingForMs` is how long the surface has been in `sweeping`; a host that
 * does not track it passes nothing and gets the previous three rungs.
 */
export const PANO_PLUS_NO_STATUS_MS = 4000;

export function panoPlusPreviewPlaceholder(
  status: PanoPlusStatus | null,
  phase: 'idle' | 'starting' | 'sweeping' | 'finishing',
  sweepingForMs = 0,
): string | null {
  if (phase !== 'sweeping' && phase !== 'starting') return null;
  if (status == null && phase === 'sweeping' && sweepingForMs >= PANO_PLUS_NO_STATUS_MS) {
    return 'The sweep is running but NO engine status has reached this screen '
      + 'on either channel. The pack is still being written — finish the '
      + 'sweep, keep it, and report this.';
  }
  if (status == null || status.painted === 0) {
    return 'The panorama will appear here as you pan.';
  }
  // THE ENGINE RENDERED PREVIEWS AND THE PUBLISHER COULD NOT WRITE THEM.
  //
  // This is the rung the 2026-08-29 build needed and did not have. The old
  // message below said "no preview has reached the app", which is true but
  // names no half of the seam — and the three candidate causes (nothing
  // rendered / nothing written / no status) all produce it. `previewFails`
  // separates them at the source, so when it is the writer, the screen says
  // the writer.
  if (status.previewFails > 0 && status.previewSeq <= 0) {
    return `${status.painted} strips painted and ${status.previewRenders} `
      + `previews RENDERED, but ${status.previewFails} could not be written `
      + 'to disk. The sweep is still recording and the pack is unaffected — '
      + 'finish it, keep it, and report this.';
  }
  if (status.previewSeq <= 0 || status.previewPath === '') {
    // Still ambiguous, deliberately: on an engine that predates the counters
    // they are all 0 and this is the honest thing to say.
    const rendered = status.previewRenders > 0
      ? ` The engine has rendered ${status.previewRenders}.`
      : '';
    return `${status.painted} strips painted, but no preview has reached the `
      + `app.${rendered} The sweep is still recording — report this.`;
  }
  return null;
}

/**
 * The notice that goes OVER a preview that is real but has stopped advancing.
 *
 * `panoPlusPreviewPlaceholder` above deliberately falls silent the moment
 * `previewSeq > 0`, because from that instant the panel is showing a genuine
 * panorama and a placeholder would HIDE it — the surface renders one or the
 * other, never both. That leaves a gap the 2026-08-30 review found: a sweep
 * whose publisher works for a while and then starts failing shows a FROZEN
 * image with nothing on it saying so, and a frozen panorama is
 * indistinguishable from a stalled sweep by eye. The drop line reports it, but
 * the drop line is not where the operator is looking.
 *
 * So it is an OVERLAY, on the same footing as the load-failure notice: the
 * real pixels stay visible underneath, with the reason written across them.
 * `null` whenever the panel is live, or empty (the placeholder owns that).
 */
export function panoPlusPreviewStaleNotice(
  status: PanoPlusStatus | null,
): string | null {
  if (status == null) return null;
  if (status.previewFails <= 0) return null;
  // Empty is the placeholder's case, not this one.
  if (status.previewSeq <= 0) return null;
  return `FROZEN at preview #${status.previewSeq} — ${status.previewFails} `
    + 'later write(s) failed. The sweep is still recording and the pack is '
    + 'unaffected; this panel is not live.';
}

/**
 * WHY THERE IS NO LIVE CAMERA FEED, in the words native already has.
 *
 * ── The failure this exists for ────────────────────────────────────────────
 *
 * The operator's report, verbatim, twice: "The camera screen is blank!!!" and
 * "no camera at all". On iOS that was a missing view and was fixed by adding
 * one. On Android a view is not sufficient, because Camera2 fixes a capture
 * session's OUTPUTS at `createCaptureSession`: a preview Surface that arrives
 * after that moment cannot join the session, and the sweep then records
 * HEADLESS — correctly, completely, at full quality, and with a black
 * rectangle where the shelf should be.
 *
 * `PanoPlusPreview` (PanoPlusPreviewView.kt) knows exactly which of those
 * happened and keeps the reason as a sentence. Until it reached JS, the
 * operator's evidence for "the camera is broken" and for "the camera is fine
 * and the panel is late" was the same black rectangle.
 *
 * ── Why it is gated on the NOTE and not on `!attached` ─────────────────────
 *
 * `viewfinderAttached` is `false` on iOS and on every binary that predates the
 * field, and absence of an answer is not a failure. A non-empty note means a
 * build that TRACKS this said something; only then is there anything to
 * report. That keeps this silent everywhere it does not apply.
 *
 * Returns null when there is nothing to say — including, deliberately, when
 * the viewfinder IS attached: a live feed explains itself and a permanent
 * caption over it is clutter.
 */
export function panoPlusViewfinderNotice(
  status: PanoPlusStatus | null,
): string | null {
  if (status == null) return null;
  if (status.viewfinderAttached) return null;
  const note = status.viewfinderNote.trim();
  if (note === '') return null;
  return `NO LIVE CAMERA FEED — ${note}`;
}

// ── Summary coercion + the integrity verdict ────────────────────────────────

function countsOf(raw: unknown): PanoPlusCounts {
  const c = rec(raw) ?? {};
  return {
    seen: num(c.seen),
    painted: num(c.painted),
    heldBacktrack: num(c.heldBacktrack),
    heldFrontier: num(c.heldFrontier),
    skippedNoAdvance: num(c.skippedNoAdvance),
    rejectedLowResponse: num(c.rejectedLowResponse),
    rejectedOutOfCage: num(c.rejectedOutOfCage),
    rejectedPoseSpeed: num(c.rejectedPoseSpeed),
    rejectedTracking: num(c.rejectedTracking),
    rejectedRectify: num(c.rejectedRectify),
    rejectedInput: num(c.rejectedInput),
    warmingUp: num(c.warmingUp),
    bootstrap: num(c.bootstrap),
    gapExtended: num(c.gapExtended),
    gapBreak: num(c.gapBreak),
    gapBackfilled: num(c.gapBackfilled),
    limitedFrames: num(c.limitedFrames),
    canvasGrowths: num(c.canvasGrowths),
    canvasHeightGrowths: num(c.canvasHeightGrowths),
  };
}

/** The PERPENDICULAR integrity block. Zero-filled when an older binary does
 *  not emit it — and `frames: 0` then reads as "no clipping reported", which
 *  is honest for a binary that could not report it. */
function clippingOf(raw: unknown): PanoPlusClipping {
  const c = rec(raw) ?? {};
  return {
    frames: num(c.frames),
    columns: num(c.columns),
    maxTopPx: num(c.maxTopPx),
    maxBottomPx: num(c.maxBottomPx),
    canvasH: num(c.canvasH),
    heightGrowths: num(c.heightGrowths),
  };
}

function timingOf(raw: unknown): PanoPlusTimingStats {
  const t = rec(raw) ?? {};
  return { p50: num(t.p50), p99: num(t.p99), max: num(t.max), n: num(t.n) };
}

function envelopeOf(raw: unknown): PanoPlusEnvelope {
  const e = rec(raw) ?? {};
  return {
    columns: num(e.columns),
    covered: num(e.covered),
    commonTop: num(e.commonTop),
    commonBottom: num(e.commonBottom),
  };
}

/** Coerce the session REGIME block. An older binary yields zeros, and a
 *  zero rotationFraction on a sweep that clearly pivoted is itself the signal
 *  that the pack predates the regime instrumentation. */
function regimeOf(raw: unknown): PanoPlusRegime {
  const r = rec(raw) ?? {};
  return {
    rotationFraction: num(r.rotationFraction),
    rotTravelPx: num(r.rotTravelPx),
    resTravelPx: num(r.resTravelPx),
    rotPathPx: num(r.rotPathPx),
    resPathPx: num(r.resPathPx),
  };
}

/** THE CUT METRIC block. Zero-filled by an older binary — and zeros there
 *  read as "this pack predates the cut metric", which is exactly the state
 *  every v4 pack is in: it reported clean because it could not see. */
function seamOf(raw: unknown): PanoPlusSeam {
  const s = rec(raw) ?? {};
  return {
    worstBandP50Px: num(s.worstBandP50Px),
    worstBandP95Px: num(s.worstBandP95Px),
    worstBandMaxPx: num(s.worstBandMaxPx),
    bandSpreadP95Px: num(s.bandSpreadP95Px),
    crossBandDivergencePx: num(s.crossBandDivergencePx),
    crossBandDivergenceNormPx: num(s.crossBandDivergenceNormPx),
    lumaStepP50DN: num(s.lumaStepP50DN),
    lumaStepP95DN: num(s.lumaStepP95DN),
    lumaStepMaxDN: num(s.lumaStepMaxDN),
    // v6 — the WHOLE-FOOTPRINT photometric seam and THE BAND on committed
    // pixels. Zeros here read as "this pack predates the photometric metric",
    // which is exactly the state every v5 pack is in: it reported a luma step
    // and verdicted clean because the step was never gated.
    photoStepP50DN: num(s.photoStepP50DN),
    photoStepP95DN: num(s.photoStepP95DN),
    photoStepMaxDN: num(s.photoStepMaxDN),
    photoSamples: num(s.photoSamples),
    photoNonUniform: num(s.photoNonUniform),
    // v8 — the SUPPORT behind the max clause, and the UNIFORM-ONLY cross-check
    // that answers "is the gate firing on scene structure?" from the pack
    // itself rather than from a claim in a design doc.
    photoStepOverBar: num(s.photoStepOverBar),
    photoUniformUnknown: num(s.photoUniformUnknown),
    photoUniStepP95DN: num(s.photoUniStepP95DN),
    photoUniStepMaxDN: num(s.photoUniStepMaxDN),
    photoUniSamples: num(s.photoUniSamples),
    photoSpreadP95DN: num(s.photoSpreadP95DN),
    photoSpreadMaxDN: num(s.photoSpreadMaxDN),
    photoDriftLocalPct: num(s.photoDriftLocalPct),
    photoDriftTotalPct: num(s.photoDriftTotalPct),
    photoDriftWorstU: num(s.photoDriftWorstU),
    boundaries: num(s.boundaries),
    coverageFrac: num(s.coverageFrac),
    canvasJogP50Px: num(s.canvasJogP50Px),
    canvasJogP95Px: num(s.canvasJogP95Px),
    canvasJogMaxPx: num(s.canvasJogMaxPx),
    canvasJogSamples: num(s.canvasJogSamples),
    // v8 — THE WALK. Reported, never gated; see PanoPlusSeam.jogDriftPx for
    // the scope, which must be read before this number is quoted.
    jogDriftPx: num(s.jogDriftPx),
    jogDriftEndPx: num(s.jogDriftEndPx),
    jogDriftSamples: num(s.jogDriftSamples),
    // v8 — whether the band percentiles above are a measurement or the
    // chain's own fit residual.
    bandSelfScored: bool(s.bandSelfScored),
    // An older binary has no `measured` key at all, and `bool(undefined)` is
    // false — which is the right default: a pack that cannot say whether it
    // measured anything has not measured anything.
    measured: bool(s.measured),
    integrityFailed: bool(s.integrityFailed),
    integrityReason: typeof s.integrityReason === 'string' ? s.integrityReason : '',
  };
}

function projectionOf(raw: unknown): PanoPlusProjection {
  const p = rec(raw) ?? {};
  const mode = num(p.mode);
  return {
    mode,
    name: mode === 1 ? 'sweep-cylindrical' : 'planar',
    maxAreaScalePainted: num(p.maxAreaScalePainted, 1),
    maxCrossRectifyDeg: num(p.maxCrossRectifyDeg),
    subjectDistanceConfiguredM: num(p.subjectDistanceConfiguredM),
    projectionSwitchSeq: num(p.switchSeq, -1),
    projectionSwitchStepPx: num(p.switchStepPx),
    sweepDeg: num(p.sweepDeg),
    crossScaleEnd: num(p.crossScaleEnd, 1),
    crossScaleCagedFrames: num(p.crossScaleCagedFrames),
    subjectDistanceUsedM: num(p.subjectDistanceUsedM),
    subjectDistanceFitM: num(p.subjectDistanceFitM),
    subjectDistanceFit: subjectDistanceFitOf(p.subjectDistanceFit),
  };
}

/** v11 — the fit's own internals. Defaults read as NOT GRADED (`samples` 0),
 *  never as a clean fit: a pack that predates the block must not come back
 *  claiming its 6.00 m was measured rather than clamped. The bars default to
 *  the shipped values so an old pack still renders, but `samples === 0` is
 *  what every reader must branch on. */
function subjectDistanceFitOf(raw: unknown): PanoPlusSubjectDistanceFit {
  const f = rec(raw) ?? {};
  return {
    rawM: num(f.rawM),
    clampLoM: num(f.clampLoM, 0.3),
    clampHiM: num(f.clampHiM, 6),
    saturated: bool(f.saturated),
    clampedUpdates: num(f.clampedUpdates),
    refusedUpdates: num(f.refusedUpdates),
    den: num(f.den),
    num: num(f.num),
    samples: num(f.samples),
    fwdSpanM: num(f.fwdSpanM),
    perpSpanM: num(f.perpSpanM),
    leverRatio: num(f.leverRatio),
    leverBar: num(f.leverBar, PANOPLUS_SUBJECT_FIT_LEVER_BAR),
    perpFloorM: num(f.perpFloorM, PANOPLUS_SUBJECT_FIT_PERP_FLOOR_M),
    degenerate: bool(f.degenerate),
    inForce: bool(f.inForce),
  };
}

function gainOf(raw: unknown): PanoPlusGain {
  const g = rec(raw) ?? {};
  return {
    cumEnd: num(g.cumEnd, 1),
    leak: num(g.leak),
    cumClamp: num(g.cumClamp, 2),
    // v6 — the field the ENGINE APPLIED. Read second; see the doc comment on
    // PanoPlusGain for why the measurement that decided the gainLeak default
    // was taken on committed pixels instead.
    localP2PPct: num(g.localP2PPct),
    localWorstU: num(g.localWorstU),
    localWindowPx: num(g.localWindowPx, 40),
    rangePct: num(g.rangePct),
    scaleMin: num(g.scaleMin, 1),
    scaleMax: num(g.scaleMax, 1),
    columns: num(g.columns),
  };
}

/** The capture-side camera-lock REPORT. Every field is what the device said
 *  AFTER the write; `null` when the binary predates the lock entirely. */
function cameraLockOf(raw: unknown): PanoPlusCameraLock | null {
  const l = rec(raw);
  if (!l) return null;
  const out: PanoPlusCameraLock = { available: bool(l.available) };
  if (l.requested !== undefined) out.requested = bool(l.requested);
  if (l.locked !== undefined) out.locked = bool(l.locked);
  if (l.exposureLocked !== undefined) out.exposureLocked = bool(l.exposureLocked);
  if (l.whiteBalanceLocked !== undefined) {
    out.whiteBalanceLocked = bool(l.whiteBalanceLocked);
  }
  if (l.focusLocked !== undefined) out.focusLocked = bool(l.focusLocked);
  if (typeof l.deviceId === 'string') out.deviceId = l.deviceId;
  if (typeof l.deviceName === 'string') out.deviceName = l.deviceName;
  if (l.exposureDurationS !== undefined) {
    out.exposureDurationS = num(l.exposureDurationS);
  }
  if (l.iso !== undefined) out.iso = num(l.iso);
  if (l.lensPosition !== undefined) out.lensPosition = num(l.lensPosition);
  if (l.exposureModeSupported !== undefined) {
    out.exposureModeSupported = bool(l.exposureModeSupported);
  }
  if (l.whiteBalanceModeSupported !== undefined) {
    out.whiteBalanceModeSupported = bool(l.whiteBalanceModeSupported);
  }
  if (l.focusModeSupported !== undefined) {
    out.focusModeSupported = bool(l.focusModeSupported);
  }
  if (l.settleCeilingMs !== undefined) out.settleCeilingMs = num(l.settleCeilingMs);
  if (l.settleMs !== undefined) out.settleMs = num(l.settleMs);
  if (l.settleConverged !== undefined) out.settleConverged = bool(l.settleConverged);
  if (l.adjustingExposureAtLock !== undefined) {
    out.adjustingExposureAtLock = bool(l.adjustingExposureAtLock);
  }
  if (l.adjustingWhiteBalanceAtLock !== undefined) {
    out.adjustingWhiteBalanceAtLock = bool(l.adjustingWhiteBalanceAtLock);
  }
  if (l.adjustingFocusAtLock !== undefined) {
    out.adjustingFocusAtLock = bool(l.adjustingFocusAtLock);
  }
  if (l.focusLockDeclined !== undefined) {
    out.focusLockDeclined = bool(l.focusLockDeclined);
  }
  if (l.observedUnlockedFrames !== undefined) {
    out.observedUnlockedFrames = num(l.observedUnlockedFrames);
  }
  if (l.reassertAttempts !== undefined) {
    out.reassertAttempts = num(l.reassertAttempts);
  }
  if (l.reassertSucceeded !== undefined) {
    out.reassertSucceeded = num(l.reassertSucceeded);
  }
  if (typeof l.restoreOutcome === 'string') out.restoreOutcome = l.restoreOutcome;
  if (l.restorePending !== undefined) out.restorePending = bool(l.restorePending);
  if (typeof l.reason === 'string') out.reason = l.reason;
  return out;
}

/** v6 — what the camera's exposure DID, and whether the sweep lock held.
 *  `rangeRatio` outranks `lock`: the lock says what we were told, this says
 *  what happened. Defaulted to 1 with `metaFrames` 0, which reads as UNKNOWN
 *  — never as locked. */
function exposureOf(raw: unknown): PanoPlusExposure {
  const e = rec(raw) ?? {};
  return {
    normalize: bool(e.normalize),
    gainClamp: num(e.gainClamp, 4),
    metaFrames: num(e.metaFrames),
    clampedFrames: num(e.clampedFrames),
    refValue: num(e.refValue),
    minValue: num(e.minValue),
    maxValue: num(e.maxValue),
    rangeRatio: num(e.rangeRatio, 1),
    lock: cameraLockOf(e.lock),
    ar: arExposureOf(e.ar),
  };
}

/** v11 — ARKit's own exposure. Defaults read as UNKNOWN (`frames` 0), which is
 *  the only honest state for a pack that predates the block: it is neither
 *  "the lock held on ARKit's pixels" nor "it did not". */
function arExposureOf(raw: unknown): PanoPlusArExposure {
  const a = rec(raw) ?? {};
  return {
    frames: num(a.frames),
    minDurationS: num(a.minDurationS),
    maxDurationS: num(a.maxDurationS),
    rangeRatio: num(a.rangeRatio, 1),
    offsetMinEV: num(a.offsetMinEV),
    offsetMaxEV: num(a.offsetMaxEV),
    pairedFrames: num(a.pairedFrames),
    maxAbsDeltaS: num(a.maxAbsDeltaS),
    maxRelDelta: num(a.maxRelDelta),
    probe: arExposureProbeOf(a.probe),
  };
}

/** `null` when the host wrote no probe report — deliberately distinguishable
 *  from a report that says "not found". */
function arExposureProbeOf(raw: unknown): PanoPlusArExposureProbe | null {
  const p = rec(raw);
  if (p == null) return null;
  return {
    outcome: typeof p.outcome === 'string' ? p.outcome : '',
    attempts: num(p.attempts),
    sessionResolved: bool(p.sessionResolved),
    samples: num(p.samples),
    currentFrameNil: num(p.currentFrameNil),
    unusableValues: num(p.unusableValues),
    frameMatched: num(p.frameMatched),
    frameMismatched: num(p.frameMismatched),
    maxFrameDeltaMs: num(p.maxFrameDeltaMs),
    route: typeof p.route === 'string' ? p.route : '',
  };
}

/** v10 — the lens gate's verdict. Defaults read as NOT CORRECTED, never as
 *  corrected: a summary that lost the block must not claim a correction that
 *  may not have happened. */
function lensOf(raw: unknown): PanoPlusLens {
  const l = rec(raw) ?? {};
  return {
    applied: bool(l.applied),
    gate: typeof l.gate === 'string' ? l.gate : 'unknown',
    device: typeof l.device === 'string' ? l.device : '',
    deviceLens: typeof l.deviceLens === 'string' ? l.deviceLens : '',
    k1: num(l.k1),
    k2: num(l.k2),
    source: typeof l.source === 'string' ? l.source : '',
    fxOverWidth: num(l.fxOverWidth),
    expectedFxOverWidth: num(l.expectedFxOverWidth),
    peakRadialPx: num(l.peakRadialPx),
    peakResidualPx: num(l.peakResidualPx),
    correctedStrips: num(l.correctedStrips),
    skippedStrips: num(l.skippedStrips),
  };
}

function pairOf(raw: unknown): [number, number] {
  return Array.isArray(raw) && raw.length >= 2
    ? [num(raw[0]), num(raw[1])]
    : [0, 0];
}

function latchOf(raw: unknown): PanoPlusLatch {
  const l = rec(raw) ?? {};
  return {
    framesUsed: num(l.framesUsed),
    weak: bool(l.weak),
    relatchCount: num(l.relatchCount),
    rotationPx: pairOf(l.rotationPx),
    totalPx: pairOf(l.totalPx),
    axis: num(l.axis),
    sweepSign: num(l.sweepSign, 1),
    latched: bool(l.latched),
  };
}

function runsOf(raw: unknown): Array<[number, number]> {
  if (!Array.isArray(raw)) return [];
  const out: Array<[number, number]> = [];
  for (const r of raw) {
    if (Array.isArray(r) && r.length >= 2) {
      out.push([num(r[0]), num(r[1])]);
    }
  }
  return out;
}

/** Coerce the `stop()` resolution. Total — an older/odd binary yields a
 *  zero-filled summary rather than a thrown promise, and the zeros are
 *  themselves readable evidence. */
export function coercePanoPlusSummary(raw: unknown): PanoPlusSummary {
  const s = rec(raw) ?? {};
  return {
    sessionDir: str(s.sessionDir),
    canvasPath: str(s.canvasPath),
    previewPath: str(s.previewPath),
    metaPath: str(s.metaPath),
    ledgerPath: str(s.ledgerPath),
    trackPath: str(s.trackPath),
    width: num(s.width),
    height: num(s.height),
    counts: countsOf(s.counts),
    axis: num(s.axis),
    sweepSign: num(s.sweepSign, 1),
    maxRectifyDeg: num(s.maxRectifyDeg),
    regime: regimeOf(s.regime),
    latch: latchOf(s.latch),
    unpaintedRuns: runsOf(s.unpaintedRuns),
    unpaintedColumns: num(s.unpaintedColumns),
    unpaintedRunsAxis: s.unpaintedRunsAxis === 'y' ? 'y' : 'x',
    clipping: clippingOf(s.clipping),
    projection: projectionOf(s.projection),
    seam: seamOf(s.seam),
    gain: gainOf(s.gain),
    exposure: exposureOf(s.exposure),
    lens: lensOf(s.lens),
    verticalEnvelope: envelopeOf(s.verticalEnvelope),
    engineMs: timingOf(s.engineMs),
    arThreadUs: timingOf(s.arThreadUs),
    previewMs: timingOf(s.previewMs),
    previewRendered: num(s.previewRendered),
    previewPublished: num(s.previewPublished),
    previewFailed: num(s.previewFailed),
    previewSkipped: num(s.previewSkipped),
    previewLastPublishedSeq: num(s.previewLastPublishedSeq),
    previewError: nullableStr(s.previewError),
    tailFlushAttempted: bool(s.tailFlushAttempted),
    tailFlushed: bool(s.tailFlushed),
    tailFlushError: nullableStr(s.tailFlushError),
    droppedQueue: num(s.droppedQueue),
    droppedPack: num(s.droppedPack),
    framesWritten: num(s.framesWritten),
    frameWriteFailed: num(s.frameWriteFailed),
    packBytes: num(s.packBytes),
    intrinsicsRescaled: num(s.intrinsicsRescaled),
    packFrameCapHit: bool(s.packFrameCapHit),
    sweepMs: num(s.sweepMs),
    fpsMeasured: num(s.fpsMeasured),
    finalizeMs: num(s.finalizeMs),
    abort: nullableStr(s.abort),
  };
}

/**
 * The integrity verdict, in BOTH directions.
 *
 * `holdsG1` is the design doc's headline gate: zero structural gaps over the
 * swept extent. It is computed ALONG THE SWEEP AXIS and it is blind
 * perpendicular to it — which is exactly how a panorama can be missing half
 * its shelf height and still report "no breaks". So the verdict also carries
 * {@link isIntact}, which is `holdsG1` AND no reported perpendicular
 * truncation, and that is the one the UI must gate on.
 */
export interface PanoPlusIntegrity {
  /** Zero interior gaps ALONG the sweep. Says nothing about height. */
  holdsG1: boolean;
  /** `holdsG1` AND nothing truncated across the sweep. THE verdict. */
  isIntact: boolean;
  holeRuns: number;
  holeColumns: number;
  /** Fraction of the swept extent that is a hole, 0..1. */
  holeFraction: number;
  /** Strips whose content ran off the canvas band and was discarded. */
  clippedFrames: number;
  /** Fraction of the panorama's width that is vertically truncated, 0..1. */
  clippedFraction: number;
  /** THE CUT VERDICT. `true` when the per-band seam residual, the normalised
   *  band shear or the committed-pixel jog breaches the shipped bars. This is
   *  the clause that makes v4's four packs impossible to call clean. */
  hasCuts: boolean;
  /** v6 — THE BANDING VERDICT. `true` when the per-boundary DC step or the
   *  committed photometric band breaches the shipped bars, OR when the pack
   *  painted strips and the photometric seam was never measured. Folded into
   *  {@link isIntact}, which is the whole point: v5 measured a step, reported
   *  it, and let three of four banded packs verdict clean. */
  hasBanding: boolean;
  /** `true` when the pack carries the photometric seam at all. `false` means
   *  the banding numbers describe NOTHING — a v5 pack is in that state. */
  photoMeasured: boolean;
  /** `true` when the pack carries BOTH seam instruments. `false` means the
   *  cut numbers describe NOTHING — and is deliberately NOT the same thing as
   *  clean: {@link isIntact} is false whenever a pack painted strips and this
   *  is false. Every v4 pack is in that state. */
  seamMeasured: boolean;
  /** One sentence, safe to put straight on screen. */
  line: string;
  /** The perpendicular sentence, or `null` when nothing was truncated. */
  clipLine: string | null;
  /** The cut sentence, or `null` when the seam metric is clean. */
  seamLine: string | null;
  /** The WARPING sentence — always present once a pack carries the metric. */
  warpLine: string | null;
  /** v11 — the fitted subject distance, GRADED. `warpLine` prints that number
   *  bare, and on all three Test-13 field packs it was 2x to 7.5x wrong with
   *  nothing saying so. LOUD when the fit is a clamp rail or its regressor had
   *  no leverage; `null` only when the pack has no fit at all. Deliberately
   *  NOT folded into {@link isIntact} — see
   *  {@link PanoPlusSubjectDistanceFit}. */
  subjectDistanceLine: string | null;
  /** v6 — the BANDING sentence, or `null` when the photometry is clean. */
  bandLine: string | null;
  /** v6 — what the camera's exposure did and whether the sweep lock held.
   *  Always present once a pack carries the block: an UNLOCKED sweep is
   *  something the operator must see even when the panorama came out fine. */
  exposureLine: string | null;
  /** v11 — ARKit'S OWN exposure, which is the half {@link exposureLine} is
   *  structurally unable to report: everything it quotes is read back off the
   *  same `AVCaptureDevice` the lock was asserted on. `null` only when the
   *  pack carries no exposure evidence at all; "NOT READ" otherwise, because
   *  an unmeasured non-circular check must not read as a passed one. */
  arExposureLine: string | null;
  /** The chained-exposure sentence, or `null` when the drift is small.
   *  REPORTED, never folded into {@link isIntact}: the fix
   *  ({@link PanoPlusEngineOptions.gainLeak}) is off pending the operator's
   *  approval, and gating a defect the engine may not correct would fail every
   *  pack for a reason nobody can act on. */
  gainLine: string | null;
}

/** The shipped cut bars, mirroring `rnis::pano::Engine::stats()` clause for
 *  clause. Calibration, on the operator's own four device packs: ALL FOUR fail
 *  these under the v4 model; three of four pass under v5 and the fourth fails
 *  on a real local parallax cut (2.48 px).
 *
 *  The shear bar is on the sqrt(n)-NORMALISED divergence, not the raw sum. The
 *  raw number is cumulative, so an absolute bar on it fails a long sweep for
 *  being long (measured on 15-58-22, truncated: 1.6 / 3.1 / 19.5 / 52.4 px at
 *  73 / 107 / 192 / 318 boundaries). Separation on the four packs after
 *  normalising: worst passing arm 3.72, best failing arm 8.70. */
export const PANOPLUS_SEAM_P95_BAR = 0.5;
export const PANOPLUS_SEAM_MAX_BAR = 1.5;
export const PANOPLUS_BAND_DIVERGENCE_NORM_BAR = 6.0;
export const PANOPLUS_CANVAS_JOG_P95_BAR = 1.5;
export const PANOPLUS_CANVAS_JOG_MAX_BAR = 4.0;
/** v6 — THE PHOTOMETRIC BARS, and the reason they exist: v5 MEASURED a seam DC
 *  step and left it out of the verdict, so three of the operator's four packs
 *  reported CLEAN with banding he could see. These mirror the engine's own
 *  clauses exactly (rnis_pano.cpp), because two gates that can disagree is one
 *  gate too many.
 *
 *  `PHOTO_STEP_*` are the per-boundary DC step over the shared LOW-GRADIENT
 *  footprint. `PHOTO_DRIFT_LOCAL_BAR` is THE BAND — the integral of the signed
 *  steps over a 40-column window, measured on COMMITTED pixels, so it sees the
 *  camera's own drift as well as the engine's.
 *
 *  Calibration on the operator's four v5 packs: photoStep p95 2.09 / 1.86 /
 *  0.77 / 2.43 DN, max 3.16 / 3.26 / 2.11 / 4.38 DN, committed band 14.7 / 7.7
 *  / 6.9 / 8.5% — ALL FOUR fail, against three of four passing under v5. */
export const PANOPLUS_PHOTO_STEP_P95_BAR = 1.2;
export const PANOPLUS_PHOTO_STEP_MAX_BAR = 3.0;

/**
 * v11 — the two named bars the engine grades the online subject-distance fit
 * against, mirrored VERBATIM from `rnis::pano::kSubjectDistanceFitLeverBar` /
 * `kSubjectDistanceFitPerpFloorM`.
 *
 * They are used ONLY as parse defaults for a pack that predates the block: a
 * graded pack carries its own bars, so a future move in the engine's values
 * cannot make this file grade an old pack by new rules. A drift between the
 * two files would otherwise let the phone and the engine disagree about the
 * same sweep, silently.
 *
 * Calibration, on the three Test-13 field packs: leverage 0.064 / 0.109 /
 * 0.057 against a bar of 0.20 — all three flagged, with ~1.8x margin on the
 * worst. A geometrically honest dolly runs well above it.
 */
export const PANOPLUS_SUBJECT_FIT_LEVER_BAR = 0.2;
export const PANOPLUS_SUBJECT_FIT_PERP_FLOOR_M = 0.01;
export const PANOPLUS_PHOTO_DRIFT_LOCAL_BAR = 6.0;
export const PANOPLUS_PHOTO_APPLIED_BAND_BAR = 6.0;
export const PANOPLUS_PHOTO_APPLIED_RANGE_BAR = 20.0;
/** @deprecated The raw cumulative bar this replaced. Kept only so a consumer
 *  pinned to it fails to compile rather than silently keeping a length-
 *  dependent gate. */
export const PANOPLUS_BAND_DIVERGENCE_BAR = 80;

/**
 * v8 — THE ANSWER TO "IS THE GATE FIRING ON SCENE STRUCTURE?", from the pack.
 *
 * A misregistered scene edge makes two owners differ, and that difference is
 * NOT a DC offset — it varies along the boundary. The engine already partitions
 * the boundaries by an across-extent uniformity test and keeps the percentiles
 * over the DC-like ones ALONE; that partition never reached the app, so the
 * claim "the verdict is not an artefact of registration" lived in a design doc
 * instead of in the operator's hand. On his four packs the gate still clears
 * its bar restricted to the uniform boundaries (1.57 / 1.66 / 0.75 / 1.85 DN),
 * which is what makes the banding claim survive his "I am not sure I see it".
 *
 * '' when the binary reported no partition — silence, never a reassuring zero.
 */
function uniformCrossCheck(seam: PanoPlusSeam): string {
  if (seam.photoUniSamples <= 0) return '';
  return ` Restricted to the ${seam.photoUniSamples} boundaries whose step is `
    + `DC-like across its own extent — i.e. exposure, not a shifted edge — the `
    + `step is p95 ${seam.photoUniStepP95DN.toFixed(2)} · `
    + `max ${seam.photoUniStepMaxDN.toFixed(2)} DN`
    + (seam.photoNonUniform > 0 || seam.photoUniformUnknown > 0
      ? ` (${seam.photoNonUniform} non-uniform, `
        + `${seam.photoUniformUnknown} unknown, all of them still inside the `
        + 'percentiles above).'
      : '.');
}

export function panoPlusIntegrity(summary: PanoPlusSummary): PanoPlusIntegrity {
  const runs = summary.unpaintedRuns.length;
  const cols = summary.unpaintedColumns;
  const holdsG1 = runs === 0 && cols === 0 && summary.counts.gapBreak === 0;

  // The runs index the SWEEP axis, which the finalize bake maps onto the
  // output's ROWS for a vertical sweep. Measuring the fraction against
  // `width` regardless would be wrong for half of all sweeps.
  const alongAxis = summary.unpaintedRunsAxis === 'y' ? summary.height : summary.width;
  const frac = alongAxis > 0 ? cols / alongAxis : 0;
  const unit = summary.unpaintedRunsAxis === 'y' ? 'row' : 'column';

  const clip = summary.clipping;
  const acrossAxis = summary.unpaintedRunsAxis === 'y' ? summary.height : summary.width;
  const clippedFraction =
    acrossAxis > 0 ? Math.min(1, clip.columns / acrossAxis) : 0;
  const clipped = clip.frames > 0;

  // ── THE CUT CLAUSE ──────────────────────────────────────────────────────
  // WHY THIS EXISTS. v4 reported all four of the operator's packs clean —
  // `holdsG1` true, `clipping.frames` 0 — while he could see "wobble, warping
  // and cuts through the output in multiple places". A verdict that passes
  // visibly broken output is the same failure class as the perpendicular blind
  // spot above it, so the cut metric is folded into `isIntact` rather than
  // printed beside it.
  //
  // A pack that predates the metric reports `boundaries: 0` and cannot be
  // judged on it — it is NOT silently called clean here, it is called
  // unmeasured, and `seamLine` says so.
  //
  // ...and "unmeasured" is NOT a pass. The first cut of this clause gated
  // `hasCuts` on `seamMeasured`, so a pack with no seam block flowed straight
  // through to `isIntact === true` and rendered the green banner — the exact
  // silence this verdict exists to remove, restored one line below the comment
  // that says it must never happen. BOTH instruments are required: the band
  // metric is the only one that sees progressive shear and the jog is the only
  // one that reads committed pixels.
  const seam = summary.seam;
  const painted = summary.counts.painted > 0;
  const seamMeasured =
    seam.boundaries > 0 && (seam.canvasJogSamples > 0 || seam.measured);
  const breachesBars =
    seam.worstBandP95Px > PANOPLUS_SEAM_P95_BAR
    || seam.worstBandMaxPx > PANOPLUS_SEAM_MAX_BAR
    || seam.crossBandDivergenceNormPx > PANOPLUS_BAND_DIVERGENCE_NORM_BAR
    || seam.canvasJogP95Px > PANOPLUS_CANVAS_JOG_P95_BAR
    || seam.canvasJogMaxPx > PANOPLUS_CANVAS_JOG_MAX_BAR;
  const hasCuts = breachesBars || (painted && !seamMeasured);
  // ⚠ THIS VERDICT IS OPTIMISTIC WHEN `seam.bandSelfScored` IS TRUE, and that
  // is stated rather than compensated for. Three of the five bars above read
  // the band percentiles, which under `crossAvgWindows` are the residual of the
  // fit that produced the placement — artificially low, so a real cut is less
  // likely to breach them. The two `canvasJog*` bars are unaffected (committed
  // pixels through the painting matrix) and still bar on their own.
  //
  // NOT re-weighted here, deliberately: dropping the band bars would make the
  // verdict MORE optimistic, and tightening them would need a calibration this
  // arm has never had on a device. The flag is off by default, has no device
  // path at all (no host passes `packOptions`, no capture flag exists), and
  // every surface that prints the band numbers now says they are self-scored —
  // which is the honest handling until someone measures the arm for real.

  // ── v6: THE BANDING VERDICT ───────────────────────────────────────────
  // v5 measured a seam DC step, printed it, and did NOT fold it into the
  // verdict — which is how three of the operator's four banded packs came back
  // clean. Same discipline as the cut clause above: NOT MEASURED is its own
  // failure, never silence.
  const photoMeasured = seam.photoSamples > 0;
  const breachesPhoto =
    seam.photoStepP95DN > PANOPLUS_PHOTO_STEP_P95_BAR
    || seam.photoStepMaxDN > PANOPLUS_PHOTO_STEP_MAX_BAR
    || seam.photoDriftLocalPct > PANOPLUS_PHOTO_DRIFT_LOCAL_BAR
    || summary.gain.localP2PPct > PANOPLUS_PHOTO_APPLIED_BAND_BAR
    || summary.gain.rangePct > PANOPLUS_PHOTO_APPLIED_RANGE_BAR;
  const hasBanding = breachesPhoto || (painted && !photoMeasured);
  // A session that painted NOTHING has no panorama to be intact. It used to
  // satisfy every clause vacuously — no holes, nothing clipped, no seams — and
  // render the green banner over an empty canvas.
  const empty = !painted;
  // The engine ships its OWN verdict in `seam.integrityFailed`. Honour it as
  // well as the locally recomputed bars: two gates that can disagree is one
  // gate too many, and the engine is the one that saw the samples.
  const isIntact =
    !empty && holdsG1 && !clipped && !hasCuts && !hasBanding
    && !seam.integrityFailed;

  const line = holdsG1
    ? `No breaks: ${summary.width}×${summary.height}, ${summary.counts.painted} strips painted.`
    : `${runs} interior hole(s) covering ${cols} ${unit}(s) `
      + `(${(frac * 100).toFixed(1)}% of the panorama)`
      + (summary.counts.gapBreak > 0
        ? `, ${summary.counts.gapBreak} gap-break frame(s).`
        : '.');

  const clipLine = clipped
    ? `TRUNCATED: ${clip.frames} strip(s) ran off the canvas band — `
      + `${clip.columns} ${unit}(s) (${(clippedFraction * 100).toFixed(1)}%) are `
      + 'missing shelf height '
      + `(worst overhang ${Math.max(clip.maxTopPx, clip.maxBottomPx).toFixed(0)} px). `
      + 'The hole check above cannot see this — it only looks along the sweep.'
    : null;

  const seamLine = !seamMeasured
    ? 'seam metric NOT MEASURED — this pack predates it (or ran with it off), '
      + 'so "no breaks" above says nothing about cuts or wobble. NOT the same '
      + 'thing as clean, and this pack is not being called clean.'
    : hasCuts
      ? `CUTS: per-boundary cross-sweep residual `
        + `p50 ${seam.worstBandP50Px.toFixed(2)} · p95 ${seam.worstBandP95Px.toFixed(2)} · `
        + `max ${seam.worstBandMaxPx.toFixed(2)} px over ${seam.boundaries} boundaries; `
        + `band shear ${seam.crossBandDivergenceNormPx.toFixed(2)} px/√n; `
        + `committed-pixel jog p95 ${seam.canvasJogP95Px.toFixed(2)} · `
        + `max ${seam.canvasJogMaxPx.toFixed(2)} px. `
        + (seam.integrityReason ? `(${seam.integrityReason}) ` : '')
        + 'The hole and clipping checks above are both blind to this.'
      : `seams clean: p95 ${seam.worstBandP95Px.toFixed(2)} px · `
        + `max ${seam.worstBandMaxPx.toFixed(2)} px · `
        + `band shear ${seam.crossBandDivergenceNormPx.toFixed(2)} px/√n · `
        + `committed-pixel jog p95 ${seam.canvasJogP95Px.toFixed(2)} px `
        + `over ${seam.boundaries} boundaries `
        + `(${(seam.coverageFrac * 100).toFixed(0)}% of strips measured).`;

  // ── v8: THE BAND NUMBERS ARE NOT EVIDENCE WHEN THE CHAIN FITTED THEM ────
  // Appended to whichever sentence was chosen, because it applies to both: a
  // pack that reads CUTS and one that reads clean are equally misread if the
  // p95 they are quoting is the residual of the fit that produced it.
  const selfScoredNote = seam.bandSelfScored
    ? ' ⚠ The band percentiles above are the chain’s OWN FIT — this sweep ran '
      + 'with crossAvgWindows on, so the placement is the least-squares centre '
      + 'of the very measurements those percentiles score it against, and a '
      + 'least-squares centre must win on its own residual. Read the '
      + `committed-pixel jog (p95 ${seam.canvasJogP95Px.toFixed(2)} · `
      + `max ${seam.canvasJogMaxPx.toFixed(2)} px) instead: it is correlated `
      + 'through the painting matrix and cannot be fitted. On the operator’s '
      + 'four packs that instrument went 2 worse / 1 flat / 1 better in this '
      + 'arm while the band residual improved on all four.'
    : '';

  const seamLineOut = seamLine + selfScoredNote;

  const proj = summary.projection;
  const warpLine = proj.maxAreaScalePainted > 1
    ? `warping: worst area magnification ${proj.maxAreaScalePainted.toFixed(2)}× `
      + `on a ${proj.name} canvas (one photo from this camera is already 2.45× `
      + `at its corner) · sweep ${proj.sweepDeg.toFixed(1)}° · `
      + `cross ${proj.maxCrossRectifyDeg.toFixed(1)}°`
      + (proj.subjectDistanceFitM > 0
        ? ` · subject plane ${proj.subjectDistanceFitM.toFixed(2)} m (fitted)`
        : '')
    : null;

  // ── v11: THE FITTED SUBJECT DISTANCE, GRADED ──────────────────────────
  //
  // `warpLine` above prints the fit as a bare number, and on all three
  // Test-13 field packs that number was 2x to 7.5x wrong against a standoff
  // measured two independent ways — silently, because the estimator
  // self-scores. This line is the grade. It is LOUD on purpose and it is NOT
  // folded into `isIntact`: the predictor is benign-degenerate, so failing
  // the pack for it would be a false alarm, but printing a wrong number with
  // no warning is what already happened three times.
  //
  // `samples === 0` ⇒ the pack predates the block. That must read as NOT
  // GRADED, never as a clean fit.
  const fit = proj.subjectDistanceFit;
  const subjectDistanceLine = fit.samples === 0
    ? (proj.subjectDistanceFitM > 0
      ? `subject distance: ${proj.subjectDistanceFitM.toFixed(2)} m fitted, `
        + 'NOT GRADED — this pack predates the fit diagnostics, so nothing '
        + 'here says whether that number is a measurement or a clamp rail.'
      : null)
    : !fit.degenerate && !fit.saturated
      ? `subject distance: ${proj.subjectDistanceFitM.toFixed(2)} m fitted from `
        + `${fit.samples} frames · forward travel ${(fit.fwdSpanM * 100).toFixed(1)} cm `
        + `across ${fit.perpSpanM.toFixed(2)} m of pan `
        + `(leverage ${fit.leverRatio.toFixed(3)}, bar ${fit.leverBar.toFixed(2)}) — `
        + 'the regressor had something to regress on.'
      : '⚠ SUBJECT DISTANCE NOT TRUSTWORTHY: '
        + `the placement ${fit.inForce ? 'RAN ON' : 'reported'} `
        + `${proj.subjectDistanceFitM.toFixed(2)} m`
        + (fit.saturated
          ? `, which is the ${fit.rawM > fit.clampHiM
            ? fit.clampHiM.toFixed(1) : fit.clampLoM.toFixed(1)} m CLAMP RAIL `
            + `(raw ratio ${fit.rawM.toFixed(2)} m)`
          : '')
        + (fit.degenerate
          ? ` · the fit regresses on FORWARD travel and this sweep moved `
            + `${(fit.fwdSpanM * 100).toFixed(1)} cm forward against `
            + `${fit.perpSpanM.toFixed(2)} m across `
            + `(leverage ${fit.leverRatio.toFixed(3)} vs bar `
            + `${fit.leverBar.toFixed(2)}, Σfwd² ${fit.den.toExponential(2)} m²) — `
            + 'holding standoff is the POINT of a shelf sweep, so this is '
            + 'structural, not bad luck'
          : '')
        + (fit.clampedUpdates > 0
          ? ` · ${fit.clampedUpdates} of the fit's updates were clamped`
          : '')
        + (fit.refusedUpdates > 0
          ? ` · ${fit.refusedUpdates} updates were REFUSED and silently kept `
            + 'the previous value'
          : '')
        + '. Reported, not gated: with almost no forward travel the placement '
        + 'predicts s ≈ 1 whatever d is, so the panorama is not damaged by it '
        + '— but the NUMBER must not be read as a standoff measurement.';

  // ── v6: THE BANDING SENTENCE ──────────────────────────────────────────
  const bandLine = !photoMeasured
    ? (painted
      ? 'photometric seam NOT MEASURED — this pack predates it (or ran with '
        + 'seamMetrics off), so nothing above says anything about banding. NOT '
        + 'the same thing as clean, and this pack is not being called clean.'
      : null)
    : hasBanding
      ? `BANDING: seam DC step p50 ${seam.photoStepP50DN.toFixed(2)} · `
        + `p95 ${seam.photoStepP95DN.toFixed(2)} · `
        + `max ${seam.photoStepMaxDN.toFixed(2)} DN over ${seam.photoSamples} `
        + `boundaries`
        // v8 — THE SUPPORT. A max clause fires the same way for one anomalous
        // boundary and for an end-to-end band. Say which this is.
        + (seam.photoSamples > 0
          ? ` (${seam.photoStepOverBar} of ${seam.photoSamples} over the `
            + `${PANOPLUS_PHOTO_STEP_MAX_BAR.toFixed(2)} DN bar)`
          : '')
        + `; committed brightness band `
        + `${seam.photoDriftLocalPct.toFixed(1)}% over `
        + `${summary.gain.localWindowPx} px (worst at column `
        + `${seam.photoDriftWorstU}), ${seam.photoDriftTotalPct.toFixed(1)}% `
        + 'end to end. Measured on painted pixels, so this includes the '
        + "camera's own drift, not just the engine's correction."
        + uniformCrossCheck(seam)
      : `photometry clean: seam DC step p95 ${seam.photoStepP95DN.toFixed(2)} DN · `
        + `band ${seam.photoDriftLocalPct.toFixed(1)}% over `
        + `${summary.gain.localWindowPx} px `
        + `across ${seam.photoSamples} boundaries`
        + (seam.photoSamples > 0
          ? ` (${seam.photoStepOverBar} over the `
            + `${PANOPLUS_PHOTO_STEP_MAX_BAR.toFixed(2)} DN bar)`
          : '')
        + '.';

  // ── v6: WHAT THE CAMERA'S EXPOSURE ACTUALLY DID ───────────────────────
  // `rangeRatio` outranks the lock report: one says what the device told us
  // when we asked, the other says what happened over the sweep.
  const exp = summary.exposure;
  const exposureLine = exp.metaFrames > 0
    ? `exposure: ${exp.rangeRatio <= 1.02
      ? 'LOCKED (ratio 1.00 across the sweep)'
      : `DRIFTED ${((exp.rangeRatio - 1) * 100).toFixed(0)}% `
        + `(${exp.minValue.toExponential(2)} → ${exp.maxValue.toExponential(2)})`}`
      + ` over ${exp.metaFrames} metered frames`
      + (exp.clampedFrames > 0
        ? ` · ${exp.clampedFrames} frame(s) had out-of-range metadata and were clamped`
        : '')
      + (exp.lock?.locked === false
        ? ` · SWEEP RAN UNLOCKED (${exp.lock.reason || 'no reason given'})`
        : '')
    // A pack that carries the exposure BLOCK but no metered frames must still
    // say so: "no evidence" is a state, and silence would let it read as fine.
    // A pack with no block at all predates v6 and gets no line.
    : (exp.lock != null || exp.normalize
      ? 'exposure: NO PER-FRAME METADATA on this path'
        + (exp.lock != null
          ? ` — the lock ${exp.lock.locked ? 'reported success' : 'did not take'}, `
            + 'but nothing in this pack can confirm what the exposure did.'
          : ' — nothing in this pack can confirm what the exposure did.')
      : null);

  // ── v11: THE NON-CIRCULAR HALF ────────────────────────────────────────
  //
  // Everything in `exposureLine` is read off the AVCaptureDevice this app
  // resolved and locked, then read back off that same object — so it cannot
  // say whether that is the device ARKit streams, nor whether the lock
  // reaches ARKit's pixels. This clause is measured on ARKit's own camera and
  // settles both. `frames === 0` is UNKNOWN and says so; it is neither a pass
  // nor a fail, which is exactly the state the pack could not express before.
  const ar = summary.exposure.ar;
  const arExposureLine = ar.frames === 0
    ? (exp.metaFrames > 0 || exp.lock != null
      ? 'ARKit exposure: NOT READ on this run — the device numbers above are '
        + 'therefore still circular (they are the object we locked, read back)'
        + (ar.probe != null
          ? `. Probe: ${ar.probe.outcome}`
            + (ar.probe.attempts > 0 ? ` after ${ar.probe.attempts} attempt(s)` : '')
            + `, ${ar.probe.samples} samples, `
            + `${ar.probe.currentFrameNil} frames with no current ARFrame.`
          : '. No probe report in this pack.')
      : null)
    : `ARKit exposure: ${ar.rangeRatio <= 1.02
      ? 'FLAT across the sweep — the lock reached ARKit’s own frames'
      : `DRIFTED ${((ar.rangeRatio - 1) * 100).toFixed(0)}% ON ARKIT’S OWN `
        + 'FRAMES while the device we locked read flat — the lock did NOT '
        + 'reach the pixels'}`
      + ` (${ar.minDurationS.toExponential(2)} → ${ar.maxDurationS.toExponential(2)} s`
      + `, EV offset ${ar.offsetMinEV.toFixed(2)}…${ar.offsetMaxEV.toFixed(2)}`
      + `, ${ar.frames} frames)`
      + (ar.pairedFrames > 0
        ? ` · device identity: ARKit and the locked AVCaptureDevice differ by `
          + `at most ${(ar.maxRelDelta * 100).toFixed(2)}% `
          + `(${ar.maxAbsDeltaS.toExponential(2)} s) over ${ar.pairedFrames} `
          + `paired frames${ar.maxRelDelta > 0.02
            // The delta says the two READINGS disagree. It cannot on its own
            // say which of the two causes it is, and claiming one would be
            // the same kind of over-read this whole block exists to stop.
            ? ' — THE TWO READINGS DISAGREE: either the lock was asserted on a '
              + 'different device, or it never reached ARKit’s stream'
            : ''}`
        : ' · no frame carried both readings, so device identity is still open')
      + (ar.probe != null && ar.probe.frameMismatched > 0
        ? ` · ⚠ ${ar.probe.frameMismatched} of ${ar.probe.samples} readings came `
          + `from a NEIGHBOURING ARFrame (worst Δ ${ar.probe.maxFrameDeltaMs.toFixed(2)} ms)`
        : '')
      + '.';

  // REPORTED, NOT GATED — see PanoPlusIntegrity.gainLine.
  const gainDrift = Math.abs(Math.log(Math.max(1e-6, summary.gain.cumEnd)));
  const gainLine = gainDrift > 0.08
    ? `exposure drift: chained gain ended at ${summary.gain.cumEnd.toFixed(3)} `
      + `(${((summary.gain.cumEnd - 1) * 100).toFixed(0)}% end to end), `
      + `seam DC step p95 ${seam.lumaStepP95DN.toFixed(1)} DN. `
      + (summary.gain.leak > 0
        ? `gainLeak ${summary.gain.leak.toFixed(2)} is ON.`
        : 'gainLeak is OFF — this is measured, not corrected.')
    : null;

  return {
    holdsG1,
    isIntact,
    holeRuns: runs,
    holeColumns: cols,
    holeFraction: frac,
    clippedFrames: clip.frames,
    clippedFraction,
    hasCuts,
    hasBanding,
    seamMeasured,
    photoMeasured,
    line,
    clipLine,
    seamLine: seamLineOut,
    warpLine,
    subjectDistanceLine,
    bandLine,
    exposureLine,
    arExposureLine,
    gainLine,
  };
}

/**
 * The residual line the operator's standing evaluation gate asks for — the
 * numbers that decide whether the attitude-rectification hypothesis held,
 * printed where he can read them on the phone before the pack ever leaves it.
 */
export function panoPlusResidualLines(
  summary: PanoPlusSummary,
  arms: { rectify: boolean; gainMatch: boolean },
): string[] {
  const c = summary.counts;
  const rejected =
    c.rejectedLowResponse + c.rejectedOutOfCage + c.rejectedPoseSpeed
    + c.rejectedRectify + c.rejectedInput;
  const lines = [
    `arm: rectify ${arms.rectify ? 'ON' : 'OFF (control)'} · gain ${arms.gainMatch ? 'ON' : 'off'}`,
    `${c.painted}/${c.seen} frames painted · ${rejected} rejected `
      + `(response ${c.rejectedLowResponse} · cage ${c.rejectedOutOfCage} · `
      + `pose ${c.rejectedPoseSpeed} · rectify ${c.rejectedRectify} · input ${c.rejectedInput})`,
    `held: ${c.heldBacktrack} backtrack · ${c.heldFrontier} frontier · ${c.skippedNoAdvance} no-advance`
      + (c.rejectedTracking > 0 ? ` · ${c.rejectedTracking} no-tracking` : ''),
    `max attitude correction ${summary.maxRectifyDeg.toFixed(2)}° — `
      + 'the wobble the offline replay could not remove is exactly this signal',
    // v5: the two defect classes v4's verdict could not see at all.
    `warping: ${summary.projection.maxAreaScalePainted.toFixed(2)}× worst area `
      + `magnification on a ${summary.projection.name} canvas `
      + `(a single photo is 2.45×) · sweep ${summary.projection.sweepDeg.toFixed(1)}° · `
      + `cross ${summary.projection.maxCrossRectifyDeg.toFixed(1)}°`,
    `cuts: seam residual p50 ${summary.seam.worstBandP50Px.toFixed(2)} / `
      + `p95 ${summary.seam.worstBandP95Px.toFixed(2)} / `
      + `max ${summary.seam.worstBandMaxPx.toFixed(2)} px · `
      // v8 — RELABELLED. This was called "the wobble" through v5-v7 and it is
      // not: it is identical to three figures in every placement arm of the
      // pose-anchor A/B while a slat-wall ruler on the same canvases moved by
      // up to 40%, because the rigid cross placement is common to every band
      // and cancels in the max−min. It measures cross-sweep SHEAR.
      + `cross-sweep shear ${summary.seam.crossBandDivergencePx.toFixed(0)} px `
      + `over ${summary.seam.boundaries} boundaries`
      + (summary.seam.bandSelfScored
        ? ' ⚠ band residual is the chain’s own fit (crossAvgWindows on)'
        : ''),
    // ── v8: THE WALK, WHICH IS THE COMPLAINT ───────────────────────────────
    // The operator called the wobble "very important". The honest state of it
    // is: NOT FIXED — the pose-anchor candidate was built, A/B'd on all four of
    // his packs and refused (it lowers the random-walk exponent on 4 of 4 and
    // the amplitude on 2 of 4, while making the seam worse on 4 of 4). What
    // this line does is stop the next attempt being judged the way that one
    // nearly was: it reports the walk from committed pixels, and it carries its
    // own scope so the number can never be quoted without it.
    `walk: committed-pixel jog drifts ${summary.seam.jogDriftPx.toFixed(1)} px `
      + `peak-to-peak (ends ${summary.seam.jogDriftEndPx.toFixed(1)} px) over `
      + `${summary.seam.jogDriftSamples} boundaries · per-boundary jog p95 `
      + `${summary.seam.canvasJogP95Px.toFixed(2)} px — this is NOT the wobble `
      + 'number: validated against a slat-wall ruler on all four operator '
      + 'packs the SLOPE tracks (both call it a random walk) but the amplitude '
      + 'runs 1-4× high, because a running sum integrates this measurement’s '
      + 'own correlation noise. Reported, never gated.',
    `exposure: chained gain ended ${summary.gain.cumEnd.toFixed(3)} · `
      + `seam DC step p95 ${summary.seam.lumaStepP95DN.toFixed(1)} DN · `
      + `gainLeak ${summary.gain.leak.toFixed(2)}`,
    // v6: the two numbers the operator's banding rejections were about.
    `banding: seam DC step p95 ${summary.seam.photoStepP95DN.toFixed(2)} / `
      + `max ${summary.seam.photoStepMaxDN.toFixed(2)} DN over `
      + `${summary.seam.photoSamples} boundaries `
      // v8 — the SUPPORT and the uniform-only cross-check, on the residual
      // page as well as in the verdict: this is the page the operator reads on
      // the phone before the pack leaves it.
      + `(${summary.seam.photoStepOverBar} over the 3.00 DN bar; DC-like only: `
      + `p95 ${summary.seam.photoUniStepP95DN.toFixed(2)} DN over `
      + `${summary.seam.photoUniSamples}) · committed band `
      + `${summary.seam.photoDriftLocalPct.toFixed(1)}% over `
      + `${summary.gain.localWindowPx} px · `
      + `${summary.seam.photoDriftTotalPct.toFixed(1)}% end to end`,
    `camera exposure: ${summary.exposure.metaFrames > 0
      ? `ratio ${summary.exposure.rangeRatio.toFixed(3)} over `
        + `${summary.exposure.metaFrames} metered frames `
        + `(1.000 = the sweep lock held)`
      : 'NO METADATA on this path — unmeasurable from this pack'}`,
    `engine ${summary.engineMs.p50.toFixed(1)}/${summary.engineMs.p99.toFixed(1)}/`
      + `${summary.engineMs.max.toFixed(1)} ms (p50/p99/max) · `
      + `AR thread ${(summary.arThreadUs.p50 / 1000).toFixed(2)} ms p50 · `
      + `preview ${summary.previewMs.p50.toFixed(1)}/${summary.previewMs.max.toFixed(1)} ms`,
    `${summary.fpsMeasured.toFixed(1)} fps measured over ${(summary.sweepMs / 1000).toFixed(1)} s`,
    `vertical envelope: ${summary.verticalEnvelope.covered}/${summary.verticalEnvelope.columns} columns, `
      + `common band ${summary.verticalEnvelope.commonTop}–${summary.verticalEnvelope.commonBottom}`,
  ];
  // PERPENDICULAR TRUTH, stated whether or not it is good news — the hole
  // gate above is structurally blind to it.
  const clip = summary.clipping;
  if (clip.frames > 0) {
    lines.push(
      `TRUNCATED: ${clip.frames} strip(s) lost shelf height off the canvas band `
      + `(worst ${Math.max(clip.maxTopPx, clip.maxBottomPx).toFixed(0)} px, `
      + `band ${clip.canvasH} px after ${clip.heightGrowths} growth(s)). `
      + 'Not visible in the hole check.',
    );
  } else {
    lines.push(
      `band ${clip.canvasH} px after ${clip.heightGrowths} vertical growth(s) — `
      + 'nothing truncated across the sweep',
    );
  }
  if (c.limitedFrames > 0) {
    lines.push(
      `${c.limitedFrames} frame(s) ran with ARKit tracking LIMITED (processed, `
      + 'not dropped — attitude stays gyro-driven there)',
    );
  }
  if (c.gapBackfilled > 0) {
    lines.push(`${c.gapBackfilled} gap(s) backfilled from the previous frame.`);
  }
  if (summary.intrinsicsRescaled > 0) {
    lines.push(
      `${summary.intrinsicsRescaled} frame(s) had intrinsics declared against a `
      + 'different raster than the pixel buffer and were rescaled — worth a look.',
    );
  }
  if (summary.packBytes > 0) {
    lines.push(
      `pack: ${summary.framesWritten} frame(s), `
      + `${(summary.packBytes / (1024 * 1024)).toFixed(0)} MB on disk`,
    );
  }
  if (summary.droppedQueue > 0 || summary.droppedPack > 0) {
    lines.push(
      `DROPS: ${summary.droppedQueue} frame(s) (engine behind) · `
      + `${summary.droppedPack} pack write(s). A drop is data, not silence.`,
    );
  }
  // THE LIVE PREVIEW'S VERDICT, ON THE RESULT SCREEN. A sweep whose panel was
  // empty the whole time must SAY so when it finishes — the operator should
  // never have to open a pack to learn that what he was watching was broken.
  // RENDERED != PUBLISHED IS THE VERDICT, not `previewFailed > 0`.
  //
  // Keying this on the failure counter alone left a hole the 2026-08-30 review
  // named: a sweep that renders previews and publishes NONE while counting no
  // failures says nothing at all — the exact silence this whole change exists
  // to end, reachable through any future path that loses a render without
  // routing it through the publisher's error arm. The invariant the operator
  // actually cares about is that everything the engine rendered reached disk,
  // so that is what is asserted, and the failure count is reported inside it.
  // THE ACCOUNTING IDENTITY IS THE VERDICT, not `previewFailed > 0`.
  //
  // Every render ends in exactly one of published / failed / skipped, so on a
  // drained queue `rendered === published + failed + skipped`. A SHORTFALL is
  // a render that reached none of them — silence of exactly the kind that hid
  // the blank panel for eleven days, and reachable through any future path
  // that loses a render without routing it through the publisher's error arm.
  //
  // Testing `rendered !== published` INSTEAD would be wrong, and wrong in the
  // expensive direction: coalescing is correct behaviour, so on a healthy but
  // loaded sweep published is legitimately below rendered by the skip count,
  // and that line would fire on good packs until the operator stopped reading
  // it.
  const previewAccounted = summary.previewPublished
    + summary.previewFailed
    + summary.previewSkipped;
  if (summary.previewFailed > 0
      || previewAccounted !== summary.previewRendered) {
    lines.push(
      `LIVE PREVIEW: ${summary.previewRendered} rendered, `
      + `${summary.previewPublished} published, ${summary.previewFailed} FAILED`
      + `, ${summary.previewSkipped} coalesced`
      + (summary.previewError != null ? ` — ${summary.previewError}` : '')
      // A shortfall is named as a shortfall. "40 rendered, 31 published,
      // 0 FAILED, 0 coalesced" is arithmetic the reader should not have to do
      // in his head on a result screen.
      + (previewAccounted !== summary.previewRendered
        ? ` — ${summary.previewRendered - previewAccounted} UNACCOUNTED `
          + '(rendered but reached neither disk nor a counter)'
        : '')
      + '. The panorama itself is unaffected.',
    );
  }
  // THE LEAD-OUT, ON THE RESULT SCREEN. A panorama short by 29-48% because
  // `Engine::finish()` threw used to be indistinguishable from a short sweep.
  // `attempted && !flushed` is the only combination that is a fault: a sweep
  // that never latched has no lead-out and correctly reports attempted false.
  if (summary.tailFlushAttempted && !summary.tailFlushed) {
    lines.push(
      'TAIL FLUSH FAILED — the final lead-out strip did not commit'
      + (summary.tailFlushError != null ? ` (${summary.tailFlushError})` : '')
      + '. On measured packs that strip is 29-48% of the panorama, so this '
      + 'image is SHORT at the end of the sweep.',
    );
  }
  if (summary.frameWriteFailed > 0) {
    lines.push(
      `PACK SHORT: ${summary.frameWriteFailed} frame JPEG(s) counted but not `
      + 'written. meta.json overstates this pack by that many frames.',
    );
  }
  if (summary.packFrameCapHit) {
    lines.push('pack frame cap HIT — later frames are not in the pack.');
  }
  if (summary.abort != null) {
    lines.push(`ABORTED: ${summary.abort} — ${abortDetail(summary.abort)}`);
  }
  return lines;
}

// ── The result the host receives ────────────────────────────────────────────

export function panoPlusResultOf(
  summary: PanoPlusSummary,
  arms: PanoPlusCaptureResult['arms'],
  capturedAt: string = new Date().toISOString(),
): PanoPlusCaptureResult {
  return {
    kind: 'panoplus',
    type: 'panoplus',
    uri: summary.canvasPath,
    sessionDir: summary.sessionDir,
    width: summary.width,
    height: summary.height,
    summary,
    arms,
    capturedAt,
  };
}

// ── Failure ─────────────────────────────────────────────────────────────────

/**
 * Read a pano+ rejection WITHOUT losing the pack it is carrying.
 *
 * RN copies an `NSError`'s `userInfo` onto the JS error object, so on
 * `panoplus-empty` the rejection holds `sessionDir` + `counts` + `abort`. A
 * `catch` that only reads `.message` throws away the evidence of the exact
 * failure the first device packs exist to explain.
 */
export function panoPlusErrorInfo(e: unknown): PanoPlusFailure {
  const err = rec(e) ?? {};
  const info = rec(err.userInfo) ?? {};
  const code = str(err.code, 'unknown');
  const message = str(err.message, 'The pano+ sweep failed.');
  return {
    code: code === '' ? 'unknown' : code,
    message,
    sessionDir: nullableStr(info.sessionDir),
    counts: info.counts != null ? countsOf(info.counts) : null,
    abort: nullableStr(info.abort),
  };
}

/** Operator-facing copy for a failure. Never leaks a raw code alone: a code
 *  with no sentence is what makes a field failure unreportable. */
export function panoPlusFailureCopy(f: PanoPlusFailure): string {
  switch (f.code) {
    case 'panoplus-unavailable':
      return 'pano+ is not in this build — the AR frame-plugin framework is not linked.';
    case 'panoplus-busy':
      return 'A pano+ sweep is already running. Finish or cancel it first.';
    case 'invalid-options':
      return `pano+ refused these settings: ${f.message}`;
    case 'panoplus-not-running':
      return 'No pano+ sweep was running — no AR frame ever reached the engine.';
    case 'panoplus-empty':
      return (
        'The sweep painted nothing'
        + (f.abort != null ? ` (${f.abort})` : '')
        + '. The pack was still written and is worth keeping.'
      );
    case 'panoplus-io':
      return `pano+ could not write its pack: ${f.message}`;

    // ── THE DECOUPLED (IMU) ARM'S OWN REFUSALS ──────────────────────────────
    //
    // Each one is a DIFFERENT finding and they must not collapse into one
    // sentence. The arm refuses rather than degrades by design, so a refusal
    // here is the feature working — but only if the operator can tell which of
    // "your phone cannot do this", "nobody has calibrated this phone" and
    // "something else is holding the camera" he is looking at. They lead to
    // three different actions, and exactly one of them is "run the gesture".
    case 'panoplus-alignment-unconfigured':
      return (
        'The IMU arm has no calibration on this phone, so it refused rather '
        + 'than sweeping on a guessed time offset. Close this, open the gear '
        + 'and run 🧭 IMU cal — both stages. '
        + f.message
      );
    case 'panoplus-no-ultrawide':
      return (
        'This phone publishes no PHYSICAL ultra-wide camera, so the IMU arm '
        + 'cannot run on it at all. That is a finding about the hardware, not '
        + 'something a calibration can fix — switch the pose source back to '
        + 'ARKit in the gear.'
      );
    case 'panoplus-no-60fps-format':
      return (
        'The ultra-wide on this phone publishes no 4:3 format reaching 60 fps. '
        + 'Frame rate is the motion-blur defence on a moving sweep and is not '
        + 'traded down, so the arm refuses instead of quietly running at 30.'
      );
    case 'panoplus-camera-busy':
      return (
        'Another session still holds the camera, so the IMU arm could not open '
        + 'it. ARKit and this arm cannot share it. Leave the screen, wait for '
        + 'the camera to come back, and start again.'
      );
    case 'panoplus-no-camera':
      return 'No back camera was discovered, so the IMU arm has nothing to open.';

    default:
      return f.message;
  }
}

// ── The IMU arm's precondition, ON SCREEN, BEFORE Start ─────────────────────

/**
 * WHAT THE OPERATOR IS TOLD ABOUT THE SELECTED ARM WHILE THE BUTTON IS STILL
 * IDLE.
 *
 * The problem this exists for, in one sentence: the IMU arm cannot start
 * without a τ and a basis that only exist on a device that has been calibrated,
 * and an entry that answers a tap with an opaque native rejection reads as
 * BROKEN rather than as UNCONFIGURED. The two must never look the same. So the
 * precondition is evaluated and stated before the tap, and the button below it
 * is labelled with the arm that will actually run.
 *
 * `canStart` is the only field a caller may gate on. `fallbackToAr` says
 * whether pressing the primary control will run the ARKit arm instead — an
 * EXPLICIT downgrade that the label announces and `arms.poseSource` records. It
 * is never silent: a silent fallback would produce an ordinary-looking pack
 * that the operator believes came off the decoupled arm, and nothing in the
 * pixels would contradict him.
 *
 * PURE, and deliberately so: every branch below is a device state that cannot
 * be produced on this machine, which makes the table the only thing that can be
 * tested here. Its inputs are the two things native answers — the planned
 * format (a HARDWARE question) and the store snapshot (a CALIBRATION question)
 * — kept separate because "there is no ultra-wide" and "no τ for this format"
 * lead to different actions.
 */
export interface PanoPlusArmNotice {
  tone: 'ok' | 'warn' | 'stop';
  headline: string;
  detail: string;
  /** Whether Start may be pressed at all. */
  canStart: boolean;
  /** The arm the primary control will actually run. */
  effectivePoseSource: PanoPlusPoseSource;
  /** True ⇒ IMU was selected and ARKit will run instead, announced. */
  fallbackToAr: boolean;
  /**
   * THE SWEEP THAT IS ABOUT TO RUN APPLIES NO CAMERA↔IMU TIMING CORRECTION.
   *
   * ⚠ OPTIONAL, AND ABSENT ON EVERY BRANCH BELOW ON PURPOSE. On iOS the fact is
   * already carried by the caller's own `tauUncorrected` flag — the operator
   * declared the experiment, so the surface knows without being told — and
   * answering it here as well would be a second owner of one fact.
   *
   * It exists for the platform where it is NOT a declaration. On Android there
   * is no τ at all (the clocks are directly comparable, so no calibration stage
   * exists) and every IMU sweep is uncorrected whatever any flag says. Without
   * this field the on-screen `⚗︎ τ=0` chip — the one that must stay up for the
   * whole sweep, because the operator's memory of which button he pressed is
   * not evidence — would be driven by a flag nobody set, and would be OFF on
   * precisely the platform where the statement is unconditionally true.
   *
   * ⚠ ON ANDROID THE CHIP STILL SPELLS THE SENTENCE OUT AT IDLE
   * (`⚗︎ τ=0 — NO CAMERA↔IMU TIMING CORRECTION ON THIS PLATFORM`). The iOS
   * EXPERIMENT wording came off the screen on 2026-09-07 because it restated a
   * choice the operator had already made in the gear; this one states a
   * PLATFORM fact he never chose and cannot change, so it stays.
   *
   * `undefined` therefore means "ask the caller's flag", not "false". See
   * `panoPlusAndroidArmNotice`, which is the only producer that sets it.
   */
  tauUncorrectedRun?: boolean;
  /**
   * THE NOTICE IS FOR THE PACK AND NOT FOR THE SCREEN (2026-09-07).
   *
   * ⚠ IT IS NOT "HIDE THIS", IT IS "THIS IS A DECLARATION, NOT A
   * PRECONDITION". Every other branch of this table is something the operator
   * can act on — a missing pod, a phone with no ultra-wide, an uncalibrated
   * device — and hiding one of those turns UNCONFIGURED into BROKEN, which is
   * the failure this whole notice exists to prevent. The τ = 0 branch is the
   * one that is not: the operator DECLARED the experiment himself, in the
   * gear, before he ever reached this screen. His words at the shelf: "what do
   * you mean by tau=0 experiment? Why should the user know this and what do
   * they have to do about it?" Nothing.
   *
   * So the STRING is untouched and `panoPlusNoticeSidecar` still writes it
   * whole — it is the pack's only prose statement of which arm ran, what τ
   * was applied and what the basis was, and that is how an uncorrected pack is
   * told apart from a calibrated one six weeks later. What changes is that the
   * capture surface does not draw it. The four-character `⚗︎ τ=0` chip carries
   * the FACT on screen for the whole sweep, as it already did mid-sweep.
   *
   * `undefined` on every other branch, so a caller that ignores it renders
   * exactly what it always did.
   */
  packOnly?: boolean;
  /**
   * The one-line NAME of the sweep that will run — `Start sweep (IMU)`,
   * `Sweep on ARKit instead`, `Start τ=0 EXPERIMENT` — always naming the arm
   * that will actually run, never the one requested.
   *
   * ⚠ IT IS NOT ON SCREEN ANY MORE (2026-09-03). It was the label ON the
   * surface's primary button, and that button is gone: pano+ is driven by
   * Pano's shutter (hold to sweep, release to finish) and Pano has no Start
   * button to label. The string survives because it is the pack's compact
   * statement of the arm decision — `panoPlusNoticeSidecar` writes it as
   * `startLabel` under schema `panoplus-host-notice/1`, and the offline
   * harness's wiring renders read it by that key — so renaming or dropping it
   * would be a schema change for a cosmetic gain. Read it as "what the sweep
   * is called", not as chrome.
   */
  startLabel: string;
}

function panoPlusArmNoticeForArm(
  poseSource: PanoPlusPoseSource,
  plan: { ok: boolean; reason: string | null; detail: string | null } | null,
  calib: {
    complete: boolean;
    missing: string | null;
    tauS: number | null;
    tauStdErrMs: number | null;
    basisIndex: number | null;
    basisLabel: string | null;
    tauKey: string | null;
    storedTauKeys: string[];
  } | null,
  /**
   * THE DELIBERATE τ = 0 EXPERIMENT. Defaults false, so every existing caller
   * and every existing pack reads exactly as it did.
   *
   * When true the CALIBRATION precondition changes shape rather than
   * relaxing: τ is no longer required (the sweep declares it applies none),
   * the BASIS still is, and the notice must read as an EXPERIMENT rather than
   * as a normal calibrated run — a screen that looked the same either way is
   * how an operator ends up believing an uncorrected pack was a corrected
   * one.
   */
  tauUncorrected: boolean = false,
  /**
   * THE BASIS GESTURE IS ON SCREEN RIGHT NOW (2026-09-01 first-run
   * acquisition). Defaults FALSE, so every existing caller reads exactly the
   * sentence it always did.
   *
   * It changes only WHERE the operator is sent, and that matters more than it
   * sounds: the old copy said "close this, open the gear and run 🧭 IMU cal",
   * which after the consolidation is two taps into a menu for a measurement the
   * surface is already offering in front of him. Sending him away from a live
   * overlay to find a panel that does the same thing is the failure the
   * operator's decision existed to remove.
   *
   * Passed as a FACT rather than assumed from `missing`, because a host that
   * embeds this surface without the overlay must keep reading the old sentence
   * — otherwise the notice would point at guidance that is not there.
   */
  basisGestureOffered: boolean = false,
): PanoPlusArmNotice {
  // THE ARKit ARM RENDERS NOTHING NEW. Byte-for-byte the surface that shipped:
  // no banner, no extra control, the same label. That is the point of the
  // default, and it is asserted by a test rather than left to inspection.
  if (poseSource === 'ar') {
    return {
      tone: 'ok',
      headline: '',
      detail: '',
      canStart: true,
      effectivePoseSource: 'ar',
      fallbackToAr: false,
      startLabel: 'Start sweep',
    };
  }

  const fellBack = (headline: string, detail: string): PanoPlusArmNotice => ({
    tone: 'stop',
    headline,
    detail,
    canStart: true,
    effectivePoseSource: 'ar',
    fallbackToAr: true,
    startLabel: 'Sweep on ARKit instead',
  });

  // 1. THE BUILD. No calibration module at all ⇒ this binary predates the
  //    pod install, which `git status` can never catch because every pano+
  //    native file is untracked.
  if (plan == null || plan.reason === 'calib-unavailable') {
    return fellBack(
      'IMU ARM — THIS BUILD CANNOT ANSWER',
      'The calibration module is not in this binary, so nothing here can say '
      + 'whether the phone is calibrated. That is an app-build fact (a missing '
      + 'pod install), not a device fact. ARKit is unaffected.',
    );
  }

  // 2. THE HARDWARE, asked BEFORE the calibration. On a body with no physical
  //    ultra-wide there is nothing to calibrate, and telling him to run the
  //    gesture would send him to do work that cannot fix the fault.
  if (!plan.ok) {
    return fellBack(
      plan.reason === 'panoplus-no-ultrawide'
        ? 'IMU ARM — NO PHYSICAL ULTRA-WIDE ON THIS PHONE'
        : plan.reason === 'panoplus-no-60fps-format'
          ? 'IMU ARM — NO 4:3 FORMAT REACHES 60 fps'
          : 'IMU ARM — THE CAMERA COULD NOT BE PLANNED',
      (plan.detail ?? 'The lens or format the arm needs is not published by '
        + 'this device.')
      + ' This is a hardware finding and a calibration cannot change it.',
    );
  }

  // 3. THE DELIBERATE τ = 0 EXPERIMENT, ASKED BEFORE THE ORDINARY
  //    CALIBRATION CHECK — because on this arm `calib.complete` is FALSE by
  //    construction (there is no τ on this device: the persist gate refused
  //    one, correctly) and the block below would fall back to ARKit and the
  //    experiment could never be run.
  //
  //    IT DOES NOT RELAX THE PRECONDITION, IT REPLACES ONE HALF OF IT. The
  //    basis is still required and is still a real measurement.
  if (tauUncorrected) {
    if (calib == null || calib.basisIndex == null) {
      return fellBack(
        basisGestureOffered
          ? 'IMU ARM — MEASURING THE BASIS, ONE TIME, ON THIS PHONE'
          : 'IMU ARM — THE τ = 0 EXPERIMENT STILL NEEDS THE BASIS',
        'An uncorrected sweep drops the TIMING correction, not the device→camera '
        + 'basis: without C the whole canvas is rotated by one of 24 signed '
        + 'permutations and no amount of τ would fix it. '
        + (basisGestureOffered
          ? 'The guidance on screen measures it now — move the phone on TWO '
            + 'axes, because a straight pan leaves four candidates matching '
            + 'exactly. It is saved for this phone model and never asked again.'
          : 'Close this, open the gear and run 🧭 IMU cal stage 2 — the gesture '
            + 'must turn on TWO axes, because a straight pan leaves four '
            + 'candidates matching exactly.'),
      );
    }
    return {
      tone: 'warn',
      headline: 'IMU ARM — EXPERIMENT: τ = 0, NO TIMING CORRECTION',
      detail:
        'This sweep applies NO camera↔IMU timing correction at all: attitude is '
        + "sampled at each frame's presentation timestamp exactly. It is an "
        + 'EXPERIMENT, not a calibrated run — τ measured 8 of 12 times and '
        + 'scattered 5.03 ms, wider than the 3.08 ms it was meant to buy back, so '
        + 'nothing was persisted and this pack is the evidence for whether τ binds '
        + `at all. The BASIS is real: C #${calib.basisIndex}`
        + `${calib.basisLabel != null ? ` ${calib.basisLabel}` : ''}, measured and `
        + 'stable under ±10 ms. The pack records tauProvenance: uncorrected and '
        + 'never claims a τ it does not have.',
      canStart: true,
      effectivePoseSource: 'imu',
      fallbackToAr: false,
      // THE SPLIT: this sentence goes to the pack, never to the screen. See
      // `packOnly` on the interface for why this branch and no other.
      packOnly: true,
      startLabel: 'Start τ=0 EXPERIMENT',
    };
  }

  // 4. THE CALIBRATION.
  if (calib == null || !calib.complete) {
    const missing = calib?.missing ?? 'tau+basis';
    const orphans = calib != null
      && calib.storedTauKeys.length > 0
      && missing !== 'basis'
      ? ' There ARE stored τ records under other keys ('
        + `${calib.storedTauKeys.join(', ')}), and this sweep would run at `
        + `${calib.tauKey ?? 'this format'} — a different lens or format needs `
        + 'its own τ, because the rolling-shutter constant is part of it.'
      : '';
    return {
      tone: 'stop',
      headline: basisGestureOffered
        ? `IMU ARM — MEASURING THE BASIS (still missing ${missing})`
        : `IMU ARM — NEEDS CALIBRATION (missing ${missing})`,
      detail:
        'It refuses rather than sweeping on a guessed time offset, and that '
        + 'refusal is correct: there is no default τ, and an unvalidated basis '
        + 'would rotate the whole canvas without saying so. '
        // WHERE THE FIX IS depends on WHICH half is missing, and since the
        // first-run acquisition landed the basis half is on this screen. τ is
        // not and cannot be: it needs an AVCaptureSession, which cannot coexist
        // with the ARKit reference the basis gesture is measured against.
        + (basisGestureOffered
          ? 'The basis is being measured by the guidance on screen — move the '
            + 'phone on TWO axes; a straight pan leaves four candidates '
            + 'matching exactly.'
            + (missing === 'tau+basis'
              ? ' τ is the other half and needs the gear: 🧭 IMU cal stage 1, '
                + 'three clock runs, because it needs the camera ARKit is '
                + 'currently holding.'
              : '')
          : 'Close this, open the gear and run 🧭 IMU cal — '
            + (missing === 'tau'
              ? 'stage 1 only, three clock runs.'
              : missing === 'basis'
                ? 'stage 2 only, and the gesture must turn on TWO axes: a '
                  + 'straight pan alone leaves four candidates matching exactly.'
                : 'both stages.'))
        + orphans,
      canStart: true,
      effectivePoseSource: 'ar',
      fallbackToAr: true,
      startLabel: 'Sweep on ARKit instead',
    };
  }

  // 5. CALIBRATED. Say WHAT it will use, not just that it is happy — the
  //    numbers are the thing the first field pack has to be read against.
  const tauMs = calib.tauS != null ? calib.tauS * 1000 : null;
  return {
    tone: 'ok',
    headline: 'IMU ARM — CALIBRATED',
    detail:
      `τ ${tauMs != null ? `${tauMs.toFixed(2)} ms` : '—'}`
      + (calib.tauStdErrMs != null ? ` ±${calib.tauStdErrMs.toFixed(2)} ms` : '')
      + ` (positive ⇒ attitude sampled at pts+τ), basis C #${calib.basisIndex ?? '—'}`
      + `${calib.basisLabel != null ? ` ${calib.basisLabel}` : ''}. `
      + 'This sweep runs on the physical ultra-wide at 60 fps with ARKit DOWN — '
      + 'there is no translation on this arm, so the pose-speed cage does not '
      + 'run and the pack says so rather than reporting a cage that passed.',
    canStart: true,
    effectivePoseSource: 'imu',
    fallbackToAr: false,
    startLabel: 'Start sweep (IMU)',
  };
}

/**
 * The arm notice, PLUS what became of the lens the operator asked for.
 *
 * ── WHY THIS IS A WRAPPER AND NOT A SIXTH BRANCH ────────────────────────
 *
 * Field report, 2026-09-19: *"0.5x lens does not go to that camera — shows
 * the same view as 1x."* Every layer was behaving correctly. 0.5× moves the
 * arm (Pano's rule); the iOS IMU arm has no τ for `model | lens | W×H | fps`
 * so it declines; ARKit publishes no ultra-wide format — 0 of 22 on
 * iPhone17,1 — so the fallback lands on the wide. `start` then DELETES the
 * lens key rather than recording one it did not use. All correct, and all
 * silent: the banner that fired said `IMU ARM — NEEDS CALIBRATION`, a
 * sentence about a thing the operator had not touched. He tapped a LENS.
 *
 * ⚠ IT DECORATES THE RESULT INSTEAD OF EDITING THE BRANCHES, AND THAT IS THE
 * FIX RATHER THAN TIDINESS. The first attempt put the sentence in `fellBack`
 * — which looks like the one place a fallback is built, and is not: branch 4,
 * the ordinary missing-calibration case and by far the commonest on a real
 * phone, returns its own object literal. It shipped green and silent on the
 * exact state the operator reported. Keying on `fallbackToAr` instead means a
 * branch added later cannot drop a lens quietly: the flag IS the condition.
 *
 * The τ = 0 experiment is deliberately NOT decorated — it answers
 * `fallbackToAr: false` and really does run the requested lens on the
 * decoupled arm.
 */
export function panoPlusArmNotice(
  poseSource: PanoPlusPoseSource,
  plan: Parameters<typeof panoPlusArmNoticeForArm>[1],
  calib: Parameters<typeof panoPlusArmNoticeForArm>[2],
  tauUncorrected: boolean = false,
  basisGestureOffered: boolean = false,
  /** The lens the operator asked for. `'wide'` adds nothing, so every
   *  existing caller renders exactly what it always did. */
  lensRequested: 'wide' | 'ultraWide' = 'wide',
): PanoPlusArmNotice {
  const notice = panoPlusArmNoticeForArm(
    poseSource, plan, calib, tauUncorrected, basisGestureOffered,
  );
  if (lensRequested !== 'ultraWide' || !notice.fallbackToAr) return notice;
  return {
    ...notice,
    // ⚠ THE HEADLINE, NOT ONLY THE DETAIL. The banner renders the headline
    // with `▸ tap for why` and keeps the detail COLLAPSED. A dropped 0.5×
    // explained only inside the fold is a dropped 0.5× he never reads.
    headline: `0.5× UNAVAILABLE — ${notice.headline}`,
    detail:
      'THE SWEEP AND THE VIEWFINDER ARE BOTH ON THE 1× WIDE CAMERA. The '
      + 'ultra-wide is reachable only on the decoupled (IMU) arm — ARKit '
      + 'publishes no ultra-wide format at all — so falling back to ARKit '
      + 'drops the lens with it. '
      + notice.detail,
  };
}


// ── The arm notice, ON DISK ─────────────────────────────────────────────────
//
// 2026-09-02. Until today the arm notice existed in exactly one place: as
// prose on the capture screen. On the Galaxy A35's IMU arm that prose measured
// 1,370 px of a 2,340 px display — 58.5% of the screen, over the live camera,
// printed on top of the host's own "ARCore is DOWN by design" banner so that
// neither could be read. It is now COLLAPSED behind its headline.
//
// Collapsing text that nobody can read costs nothing. Collapsing text that is
// the only record of WHICH ARM RAN AND WHY costs the next field RCA, and this
// programme has already paid that bill: `tauProvenance`, `basisProvenance` and
// `arms.poseSource` are all in the pack precisely because "the operator
// remembers what the screen said" is not evidence. So the sentence the screen
// no longer shows by default is written into the pack instead, in full, on
// every sweep — expanded or not.
//
// ⚠ IT GOES IN THE SESSION DIR, NOT INTO `meta.json`. `meta.json` is native's
// file and its fields are the ENGINE's resolved configuration; a host string
// in it would read as something the engine acted on. This is a separate,
// clearly host-authored sidecar, and `debugPack.ts` copies the whole session
// directory (`copyIfExists(panoPlusDir, …)`), so it reaches the debug pack
// without anything else being taught about it.

/** The sidecar's file name inside the sweep's session directory. */
export const PANO_PLUS_NOTICE_FILE = 'host_notice.json';

/**
 * The bytes of {@link PANO_PLUS_NOTICE_FILE}.
 *
 * PURE so the shape is testable here: the write itself happens in the surface,
 * where nothing can be asserted, and a sidecar that silently emitted `{}` would
 * look exactly like a sweep on which the notice was empty.
 *
 * `shownExpanded` records whether the operator had actually OPENED the detail
 * on screen when the sweep started. It is not decoration: when a field pack
 * disagrees with what he remembers reading, this says whether he could have
 * read it at all.
 */
export function panoPlusNoticeSidecar(
  notice: PanoPlusArmNotice,
  ctx: {
    /** Which policy produced the notice — see `panoPlusArmContract`. */
    armContract: string;
    /** The arm the operator SELECTED, before any announced fallback. */
    poseSourceRequested: PanoPlusPoseSource;
    /** Was the detail open on screen at the moment Start was pressed. */
    shownExpanded: boolean;
    writtenAtMs?: number;
  },
): string {
  return JSON.stringify(
    {
      schema: 'panoplus-host-notice/1',
      writtenAtMs: ctx.writtenAtMs ?? Date.now(),
      armContract: ctx.armContract,
      poseSourceRequested: ctx.poseSourceRequested,
      poseSourceEffective: notice.effectivePoseSource,
      fallbackToAr: notice.fallbackToAr,
      tone: notice.tone,
      startLabel: notice.startLabel,
      shownExpanded: ctx.shownExpanded,
      // ⚠ WITHOUT THIS, `shownExpanded: false` LIES. It means "he did not open
      // the detail", and on a pack-only notice (the τ = 0 experiment, since
      // 2026-09-07) there was no headline to tap in the first place. Recording
      // which of the two happened is the difference between "he could have
      // read it and did not" and "it was never on the screen".
      packOnly: notice.packOnly === true,
      // THE τ FACT AS A FIELD, not only inside the prose. `tauUncorrectedRun`
      // is set by the Android producer and is `undefined` on iOS (where the
      // caller's own declaration owns it) — `null` here is the honest encoding
      // of "this producer did not answer", never of "corrected".
      tauUncorrectedRun: notice.tauUncorrectedRun ?? null,
      // THE TWO STRINGS THIS FILE EXISTS FOR. Written whole and unwrapped —
      // a truncated diagnostic is worse than none, because it reads as
      // complete.
      headline: notice.headline,
      detail: notice.detail,
    },
    null,
    2,
  );
}

// ── The LIVE HUD, ON DISK ───────────────────────────────────────────────────
//
// 2026-09-03, and the THIRD instance of the same fix — the arm notice went to
// disk on 2026-09-02, the residual report below it on the same day, and this
// is the capture screen's own readout following them for the same stated
// reason. The operator, on a healthy sweep: "There is still some text shown in
// the pano+ screen - no point of it!"
//
// The engine line and the drops line are now IDLE-ONLY on screen. Their
// individual NUMBERS were never at risk — native writes every one of them into
// `meta.json` — but the rendered sentences carry judgement the raw fields do
// not: which threshold a value crossed, whether a drop was benign coalescing
// or the publisher falling behind, whether an unmeasured exposure is unknown or
// unlocked. That reading is exactly what a later RCA wants and exactly what
// nobody will reconstruct from `previewSkips: 41`. So the sentences are written
// at STOP, when they describe the finished sweep rather than a moment in it.
//
// Same placement rule as the notice sidecar: the session dir, not `meta.json`,
// because `meta.json` is native's file and a host string in it would read as
// something the engine acted on. `debugPack.ts` copies the session directory
// whole, so this reaches the debug pack with nothing else taught about it.

/** The sidecar's file name inside the sweep's session directory. */
export const PANO_PLUS_SWEEP_NOTICE_FILE = 'host_sweep_hud.json';

/**
 * The bytes of {@link PANO_PLUS_SWEEP_NOTICE_FILE} — the HUD's own text, as it
 * stood at the end of the sweep.
 *
 * PURE, for the same reason {@link panoPlusNoticeSidecar} is: the write happens
 * in the surface where nothing can be asserted, and a sidecar that silently
 * emitted `{}` would look exactly like a sweep with nothing to report.
 *
 * `null` fields are the honest encoding of "this line had nothing to say" and
 * are NOT collapsed to empty strings — `drops: null` (a clean sweep) and
 * `drops: ""` (a bug in this function) must not read the same.
 */
export function panoPlusSweepHudSidecar(
  lines: {
    /** `panoPlusGuidance`'s headline and detail at stop. */
    guidanceHeadline: string;
    guidanceDetail: string;
    /** `panoPlusHudLine` — the engine readout. */
    hud: string;
    /** `panoPlusDropLine` — drops, or `null` on a clean sweep. */
    drops: string | null;
    /** `panoPlusCameraLockLine` — the exposure lock's verdict, or `null`. */
    cameraLock: string | null;
    /** `panoPlusPreviewWindowCaption` — set once the frontier window engages,
     *  which is the one fact the preview no longer states on screen. */
    previewWindow: string | null;
    /** `panoPlusViewfinderNotice` — a headless sweep, or `null`. */
    viewfinder: string | null;
    writtenAtMs?: number;
  },
): string {
  return JSON.stringify(
    {
      schema: 'panoplus-host-sweep-hud/1',
      writtenAtMs: lines.writtenAtMs ?? Date.now(),
      guidanceHeadline: lines.guidanceHeadline,
      guidanceDetail: lines.guidanceDetail,
      hud: lines.hud,
      drops: lines.drops,
      cameraLock: lines.cameraLock,
      previewWindow: lines.previewWindow,
      viewfinder: lines.viewfinder,
    },
    null,
    2,
  );
}

// ── The RESIDUAL REPORT, ON DISK ────────────────────────────────────────────
//
// 2026-09-02, and it is the SECOND half of the same fix as
// `panoPlusNoticeSidecar` above. That one took the arm notice off the CAPTURE
// screen; this one takes the residual report off the OUTPUT screen, and the
// operator's report is what makes it necessary:
//
//   "There is SO MUCH text on the image output that I do not see the buttons
//    still!! WHY is that text needed on the output? What purpose is it
//    serving?"
//
// The answer to the second question is real and is why the text is RELOCATED
// rather than deleted: this is the pano+ residual diagnostic, the standing
// "residuals to the operator before iterating" instrument. Every one of its
// lines exists because a previous verdict lied — `seamLine` because four packs
// rejected for cuts all reported clean, `bandLine` because v5 measured a DC
// step and left it out of the verdict, `subjectDistanceLine` because three
// Test-13 packs printed a fitted distance that was 2x to 7.5x wrong with
// nothing saying so. It is ADVISORY: it gates nothing, it changes no pixel,
// and nothing downstream reads it.
//
// So it does not belong on top of the picture and the buttons. It belongs in
// the pack, which is where every other piece of pano+ evidence already lives,
// and where an RCA a week later can actually read it.
//
// ⚠ SAME PLACEMENT RULE AS THE NOTICE SIDECAR, and for the same reason: the
// SESSION DIR, never `meta.json`. `meta.json` is native's file and its fields
// are the engine's resolved configuration; a host-composed sentence in it would
// read as something the engine acted on. `debugPack.ts` copies the whole
// session directory recursively, so this reaches the debug pack with nothing
// else taught about it.

/** The sidecar's file name inside the sweep's session directory. */
export const PANO_PLUS_VERDICT_FILE = 'host_verdict.json';

/**
 * The bytes of {@link PANO_PLUS_VERDICT_FILE} — the WHOLE output-screen
 * report, in the exact words the screen would have printed.
 *
 * PURE, so the shape is testable off-device (the write happens in
 * `PanoPlusResultView`, where nothing can be asserted, and a sidecar that
 * silently emitted `{}` would look exactly like a sweep with no residuals).
 *
 * ⚠ THE RENDERED PROSE, NOT JUST ITS INPUTS. `meta.json` already carries every
 * NUMBER these sentences are computed from, so a reader could in principle
 * recompute them — but only by re-running this exact grading code at the exact
 * version that graded this sweep. The grading is what changed four times
 * between v4 and v11; the numbers did not. Writing the sentences is what makes
 * the pack answer "what was this build's verdict on this sweep" a month later.
 */
export function panoPlusVerdictSidecar(
  result: PanoPlusCaptureResult,
  ctx?: { writtenAtMs?: number },
): string {
  const integrity = panoPlusIntegrity(result.summary);
  const residuals = panoPlusResidualLines(result.summary, result.arms);
  return JSON.stringify(
    {
      schema: 'panoplus-host-verdict/1',
      writtenAtMs: ctx?.writtenAtMs ?? Date.now(),
      capturedAt: result.capturedAt,
      canvas: { width: result.width, height: result.height },
      // The one line the screen still shows. Repeated here so the file can be
      // read on its own without joining it back to `verdict.lines`.
      headline: panoPlusVerdictHeadline(integrity),
      isIntact: integrity.isIntact,
      verdict: {
        holdsG1: integrity.holdsG1,
        hasCuts: integrity.hasCuts,
        hasBanding: integrity.hasBanding,
        seamMeasured: integrity.seamMeasured,
        photoMeasured: integrity.photoMeasured,
        clippedFrames: integrity.clippedFrames,
        // THE SENTENCES, in the screen's own order and with the nulls dropped
        // — a null in this list would read as a line that rendered empty.
        lines: [
          integrity.line,
          integrity.clipLine,
          integrity.seamLine,
          integrity.warpLine,
          integrity.subjectDistanceLine,
          integrity.bandLine,
          integrity.exposureLine,
          integrity.arExposureLine,
          integrity.gainLine,
        ].filter((s): s is string => s != null && s !== ''),
      },
      residuals,
      // WHY THIS FILE EXISTS, inside the file. A sidecar whose purpose lives
      // only in the commit that added it is a sidecar the next reader deletes.
      note:
        'The pano+ residual diagnostic. ADVISORY: it gates nothing and no '
        + 'pixel depends on it. It lived on the output screen until 2026-09-02, '
        + 'where it covered the picture and pushed the Close/Save/Share controls '
        + 'off the bottom of the display; the screen now shows the headline with '
        + 'an expander and writes the full text here.',
    },
    null,
    2,
  );
}

/**
 * The ONE line the output screen shows.
 *
 * Extracted from the view's JSX so the screen and the sidecar cannot disagree
 * about the verdict — the failure this repo has already paid for twice, where
 * two spellings of one decision drifted apart and the pack and the screen said
 * different things about the same sweep.
 */
export function panoPlusVerdictHeadline(i: PanoPlusIntegrity): string {
  if (i.isIntact) return '✓ Intact — no breaks, nothing truncated, seams inside bars';
  if (!i.holdsG1) return '⚠ Breaks in the panorama (G1 FAILED)';
  if (i.clippedFrames > 0) return '⚠ Truncated — shelf height lost off the canvas band';
  // NOT MEASURED gets its own headline. It used to fall through to the green
  // banner, which then claimed "seams inside bars" about a pack that had
  // measured no seams at all.
  if (!i.seamMeasured) return '⚠ Seams NOT MEASURED — this pack cannot be called clean';
  if (!i.photoMeasured) return '⚠ Photometry NOT MEASURED — this pack cannot be called clean';
  if (i.hasCuts) return '⚠ Cuts — the strips do not line up across the sweep';
  return '⚠ Banding — the strips do not match in brightness';
}
