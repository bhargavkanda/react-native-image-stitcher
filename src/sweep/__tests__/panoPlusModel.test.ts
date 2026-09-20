// SPDX-License-Identifier: Apache-2.0
/**
 * panoPlusModel — the pure pano+ decisions.
 *
 * WHAT THESE TESTS PIN, and why each one exists rather than "it looks right":
 *
 *  · THE BRIDGE BOUNDARY. Every value below crosses a native bridge, so every
 *    field arrives as `unknown`. The parse is tested against a MALFORMED dict,
 *    an absent plugin key and a null meta, because on device those are not
 *    hypotheticals — the plugin returns nil whenever it is registered-but-idle,
 *    and `onArFrame` ticks independently of the frame rate.
 *  · NULL ≠ STOPPED. The single most likely HUD bug in this surface is
 *    blanking on a null tick, which makes a healthy sweep flicker between
 *    "panning" and "waiting for frames". The parse returns null and the SURFACE
 *    keeps its last status; this file pins the parse half.
 *  · THE `file://` TRAP. `barePath` is not cosmetic: native calls
 *    `NSFileManager createDirectoryAtPath:`, which would create a literal
 *    directory named `file:` from a URI and report success — a pack that lands
 *    nowhere, with no error anywhere.
 *  · GOVERNOR PRECEDENCE. Only one guidance line is shown, so the ORDER is the
 *    contract, not a detail. A stall that renders as "too fast" tells the
 *    operator to do the opposite of the recovery.
 *  · REJECTIONS ARE EVIDENCE. `panoplus-empty` carries the pack on
 *    `error.userInfo`; a catch that reads only `.message` throws away exactly
 *    the pack the first device sweeps exist to explain.
 */

import {
  PANOPLUS_BAND_DIVERGENCE_BAR,
  PANO_PLUS_DEFAULT_PREVIEW_ASPECT,
  coercePanoPlusStatus,
  PANO_PLUS_PLUGIN_KEY,
  barePath,
  coercePanoPlusSummary,
  fileUri,
  newPanoPlusSessionId,
  panoPlusCameraLockLine,
  panoPlusDropLine,
  panoPlusErrorInfo,
  panoPlusFailureCopy,
  panoPlusGuidance,
  panoPlusHudLine,
  panoPlusIntegrity,
  panoPlusPreviewAspect,
  panoPlusGlyphRotationDeg,
  panoPlusImageRotationDeg,
  panoPlusUprightRotationDeg,
  PANO_PLUS_SENSOR_ORIENTATION_CW_DEG,
  panoPlusPreviewLayout,
  panoPlusPreviewPlaceholder,
  panoPlusPreviewStaleNotice,
  panoPlusPreviewSource,
  panoPlusSweepIsTall,
  panoPlusHoldOf,
  panoPlusCoachedSweep,
  panoPlusSweepDirection,
  panoPlusSweepArrow,
  panoPlusCrossHeadroom,
  panoPlusPreviewMarker,
  panoPlusFrontierCaption,
  panoPlusPreviewWindowCaption,
  panoPlusPreviewWindowMultiple,
  panoPlusSweepHudSidecar,
  panoPlusArmNotice,
  panoPlusNoticeSidecar,
  PANO_PLUS_DEFAULT_ORIENTATION,
  PANO_PLUS_DEFAULT_PREVIEW_WINDOW_MULT,
  PANO_PLUS_PREVIEW_INTERVAL_MS,
  panoPlusResidualLines,
  panoPlusResultOf,
  panoPlusSessionIdOf,
  panoPlusSessionPaths,
  panoPlusStatusSessionId,
  readPanoPlusStatus,
} from '../panoPlusModel';
import type { PanoPlusStatus } from '../panoPlusTypes';

/** A healthy mid-sweep status, as native emits it.
 *
 *  The base is annotated `PanoPlusStatus` and the override spread on TOP of a
 *  COMPLETE value rather than into the literal: spreading a `Partial<T>` into
 *  an object literal makes every field `T[k] | undefined`, so the literal no
 *  longer satisfies `T` and `npm run typecheck:tests` was red on this file for
 *  a reason that had nothing to do with the fixture's contents. */
function statusFixture(over: Partial<PanoPlusStatus> = {}): PanoPlusStatus {
  const base: PanoPlusStatus = {
    running: true,
    poseSourceRan: '',
    sessionDir: '/var/mobile/Documents/panoplus/pp_1',
    seq: 120,
    framesSeen: 120,
    painted: 114,
    heldBacktrack: 0,
    heldFrontier: 2,
    skippedNoAdvance: 3,
    rejectedLowResponse: 1,
    rejectedOutOfCage: 0,
    rejectedPoseSpeed: 0,
    rejectedTracking: 0,
    rejectedRectify: 0,
    gapExtended: 0,
    gapBreak: 0,
    gapBackfilled: 0,
    limitedFrames: 0,
    clippedFrames: 0,
    clippedColumns: 0,
    paintedWidthPx: 3400,
    canvasWidthPx: 4096,
    canvasHeightPx: 796,
    advancePx: 9.9,
    stripPx: 12.4,
    outcome: 'painted',
    speed: 'ok',
    tracking: 2,
    // ANDROID AR ARM only, and EMPTY while tracking is fine — which is what a
    // healthy sweep is. `readPanoPlusStatus` coerces an absent field to '' via
    // `str()`, so this is also exactly what an iOS binary produces.
    arTrackingFailure: '',
    stalled: false,
    axisLatched: true,
    axis: 0,
    sweepSign: 1,
    maxRectifyDeg: 4.2,
    previewPath: '/var/mobile/Documents/panoplus/pp_1/preview.jpg',
    previewSeq: 12,
    // The PUBLISHED preview's own pixel dims — the panorama's shape, which is
    // what the on-screen box is sized from. This fixture is a HORIZONTAL sweep
    // (axis 0), so the preview is a band.
    previewW: 1400,
    previewH: 328,
    // RENDERED / FAILED / SKIPPED. A healthy sweep has published everything it
    // rendered, so failed and skipped are 0 and `previewRenders` tracks
    // `previewSeq`. The 2026-08-29 device build produced renders ~30 with
    // seq 0 and fails ~30 — see the placeholder tests.
    previewRenders: 12,
    previewFails: 0,
    previewSkips: 0,
    // WHERE the preview sits. -1 is "not placeable", which is what an engine
    // that predates the field reports and what the fixture defaults to, so no
    // existing expectation acquires a frontier marker it never had.
    previewFrontierFrac: -1,
    previewViewPx: 0,
    previewBandPx: 0,
    previewViewStartPx: 0,
    previewWindowed: false,
    previewIntervalMs: 0,
    // THE CAMERA'S OWN FEED, not the panorama preview. `false` + `''` is what
    // iOS reports and what `readPanoPlusStatus` coerces an absent pair to
    // (`s.viewfinderAttached === true` / `str()`), and the headless notice is
    // gated on a NON-EMPTY note — so the fixture stays a healthy sweep.
    viewfinderAttached: false,
    viewfinderNote: '',
    // ── The 22 fields the fixture silently omitted ──────────────────────
    // They were not "defaults": the old `...over`-into-the-literal spread hid
    // the omission from the type checker, so every test that read one of them
    // read `undefined` while TS believed it was a number. `seamMeasured:
    // false` is what the fixture EFFECTIVELY had (undefined is falsy), so the
    // HUD keeps printing `seam ?` and no existing expectation moves — the
    // values below are chosen to preserve behaviour exactly, not to improve it.
    rotationFraction: 0,
    relatchCount: 0,
    advanceRotPx: 0,
    seamMeasured: false,
    integrityFailed: false,
    seamWorstBandP95Px: 0,
    seamWorstBandMaxPx: 0,
    crossBandDivergenceNormPx: 0,
    seamCanvasJogP95Px: 0,
    seamCanvasJogMaxPx: 0,
    seamPhotoStepP95DN: 0,
    seamPhotoStepMaxDN: 0,
    seamPhotoStepOverBar: 0,
    seamPhotoSamples: 0,
    seamBandSelfScored: false,
    photoDriftLocalPct: 0,
    photoDriftTotalPct: 0,
    photoLocalP2PPct: 0,
    photoScaleRangePct: 0,
    // A HEALTHY sweep, which means the AE lock HELD and was measured: ratio
    // 1.00 with metered frames is the proof, and 1.00 with ZERO metered frames
    // is UNKNOWN and correctly reports "exposure UNMEASURED".  The old
    // fixture left this `undefined`, and `undefined === 0` is false, so the
    // UNMEASURED clause could never fire and 'a healthy pass shows NO drop
    // line' passed for the wrong reason.
    exposureRangeRatio: 1,
    exposureMetaFrames: 120,
    maxAreaScale: 1,
    droppedQueue: 0,
    droppedPack: 0,
    engineMs: 1.4,
    abort: null,
  };
  return { ...base, ...over };
}

describe('path hygiene', () => {
  it('strips file:// before anything reaches native', () => {
    expect(barePath('file:///var/mobile/Documents/panoplus/pp_1')).toBe(
      '/var/mobile/Documents/panoplus/pp_1',
    );
    // Idempotent — a plain path must survive untouched, or a double-strip
    // would eat the leading slash and produce a RELATIVE path.
    expect(barePath('/var/mobile/x')).toBe('/var/mobile/x');
  });

  it('re-adds the scheme for <Image> / expo-file-system, and leaves http alone', () => {
    expect(fileUri('/a/b.jpg')).toBe('file:///a/b.jpg');
    expect(fileUri('file:///a/b.jpg')).toBe('file:///a/b.jpg');
    expect(fileUri('https://x/y.jpg')).toBe('https://x/y.jpg');
    expect(fileUri('')).toBe('');
  });

  it('session paths hand native a plain path and JS a URI, from ONE call', () => {
    const { dirPath, dirUri } = panoPlusSessionPaths(
      'file:///var/mobile/Documents/',
      'pp_42',
    );
    expect(dirPath).toBe('/var/mobile/Documents/panoplus/pp_42');
    expect(dirUri).toBe('file:///var/mobile/Documents/panoplus/pp_42');
  });

  it('tolerates a documentDirectory without a trailing slash', () => {
    const { dirPath } = panoPlusSessionPaths('file:///var/mobile/Documents', 'pp_1');
    expect(dirPath).toBe('/var/mobile/Documents/panoplus/pp_1');
  });

  it('session ids sort in capture order', () => {
    expect(newPanoPlusSessionId(1000) < newPanoPlusSessionId(2000)).toBe(true);
  });

  // ── THE IDENTITY THE LIVE PANEL IS SCOPED BY (2026-09-07) ────────────────
  //
  // The surface has to answer "is this status MINE?" about a status that
  // travelled through the bridge, and the two sides do not agree on the SPELLING
  // of a session dir: JS sends `barePath(dirPath)`, native may echo its own
  // normalisation (Android answers `packDir` when it has one), and `fileUri`
  // puts the scheme back for `<Image>`. Comparing whole strings makes two
  // spellings of ONE session look like two sessions, which fails CLOSED — every
  // status discarded, a panel that never updates. So the comparison is on the
  // last path component, the `pp_<epoch-ms>` id, which no spelling touches.
  it('reads the session id off any spelling of the same directory', () => {
    expect(panoPlusSessionIdOf('/var/mobile/Documents/panoplus/pp_42')).toBe('pp_42');
    expect(panoPlusSessionIdOf('file:///var/mobile/Documents/panoplus/pp_42'))
      .toBe('pp_42');
    expect(panoPlusSessionIdOf('/var/mobile/Documents/panoplus/pp_42/')).toBe('pp_42');
    expect(panoPlusSessionIdOf('file:///var/mobile/Documents/panoplus/pp_42//'))
      .toBe('pp_42');
    // A bare id is already the answer — Android's `packDir` echo has been a
    // relative path in the past and must not read as "no session".
    expect(panoPlusSessionIdOf('pp_42')).toBe('pp_42');
  });

  // ── ANDROID NESTS THE PACK ONE COMPONENT DEEPER ─────────────────────────
  //
  // The bare last component is NOT the id on Android. `PanoPlusAndroidRecorder`
  // .openPack() does `packDir = File(base, "panoplus")` on the
  // `<Documents>/panoplus/pp_<ms>` this SDK sends, the engine is opened on THAT
  // (`PanoPlusLiveNative.start(sessionDir = packDir.absolutePath)`), the shared
  // C++ stamps it into every status (`kvStr(s, "sessionDir", S.sessionDir)`),
  // and the live module answers the start with the same string
  // (`optStr(m, "packDir", sessionDir)`). So the claim AND every status spell
  // the session `…/pp_<ms>/panoplus`, and reading the last component makes
  // EVERY Android sweep the constant "panoplus" — a session test that always
  // passes, which is no scoping at all. The id is the minted `pp_<epoch-ms>`
  // component, wherever it sits in the path.
  it('keeps two ANDROID sweeps distinct, though both packs end in "panoplus"',
    () => {
      const a = '/data/user/0/com.example.app/files/panoplus/pp_1788806676180/panoplus';
      const b = '/data/user/0/com.example.app/files/panoplus/pp_1788806692615/panoplus';
      expect(panoPlusSessionIdOf(a)).toBe('pp_1788806676180');
      expect(panoPlusSessionIdOf(b)).toBe('pp_1788806692615');
      expect(panoPlusSessionIdOf(a)).not.toBe(panoPlusSessionIdOf(b));
    });

  it('falls back to the last component when no minted id is in the path', () => {
    // Not a lie and not null: an unrecognised spelling still answers something
    // STABLE for that path, so a binary whose dir this helper does not know
    // still scopes to itself rather than failing closed.
    expect(panoPlusSessionIdOf('/var/mobile/Documents/panoplus/whatever'))
      .toBe('whatever');
    expect(panoPlusSessionIdOf('pp_42')).toBe('pp_42');
    // `pp_` with anything but digits after it is not a minted id.
    expect(panoPlusSessionIdOf('/d/pp_beta/panoplus')).toBe('panoplus');
  });

  it('answers null rather than a lie when there is no id in the path', () => {
    expect(panoPlusSessionIdOf('')).toBeNull();
    expect(panoPlusSessionIdOf('/')).toBeNull();
    expect(panoPlusSessionIdOf('file:///')).toBeNull();
  });

  it('takes the status id from sessionDir, which both platforms populate', () => {
    expect(panoPlusStatusSessionId(statusFixture())).toBe('pp_1');
    expect(panoPlusStatusSessionId(statusFixture({
      sessionDir: 'file:///d/panoplus/pp_9/',
    }))).toBe('pp_9');
  });

  it('falls back to the previewPath\'s PARENT when sessionDir is empty', () => {
    // `sessionDir` is written by `RNISPanoCore.mm` (`@"sessionDir": S->sessionDir`)
    // and by the shared C++ `Session::appendStatus` (`kvStr(s, "sessionDir", ...)`),
    // so a running sweep always carries it. A binary that predates the key would
    // still carry `previewPath`, which contains the same id one level up.
    expect(panoPlusStatusSessionId(statusFixture({
      sessionDir: '',
      previewPath: '/var/mobile/Documents/panoplus/pp_7/preview.jpg',
    }))).toBe('pp_7');
  });

  it('places an ANDROID status, whose sessionDir carries the extra component',
    () => {
      expect(panoPlusStatusSessionId(statusFixture({
        sessionDir: '/data/user/0/com.example.app/files/panoplus/pp_9/panoplus',
      }))).toBe('pp_9');
      // …and through the previewPath fallback, which on Android is
      // `…/pp_<ms>/panoplus/preview.jpg` (rnis_pano_live.cpp joins "preview.jpg"
      // onto the pack dir), so its PARENT is the nested dir, not the session.
      expect(panoPlusStatusSessionId(statusFixture({
        sessionDir: '',
        previewPath: '/data/user/0/com.example.app/files/panoplus/pp_7/panoplus/preview.jpg',
      }))).toBe('pp_7');
    });

  it('answers null when a status carries no id at all, so the caller can decide',
    () => {
      // NOT a discard signal on its own: an unattributable status is one this
      // helper cannot place, and refusing it here would blank the HUD of any
      // build that ever shipped without the key. The surface treats null as
      // "belongs to whatever sweep is live" — see `applyStatus`.
      expect(panoPlusStatusSessionId(statusFixture({
        sessionDir: '', previewPath: '',
      }))).toBeNull();
      expect(panoPlusStatusSessionId(statusFixture({
        sessionDir: '', previewPath: '/preview.jpg',
      }))).toBeNull();
    });
});

describe('status parse (the bridge boundary)', () => {
  it('reads the plugin dict off an ARFrameMeta', () => {
    const s = readPanoPlusStatus({
      plugins: { [PANO_PLUS_PLUGIN_KEY]: statusFixture() },
    });
    expect(s).not.toBeNull();
    expect(s!.painted).toBe(114);
    expect(s!.outcome).toBe('painted');
    expect(s!.axisLatched).toBe(true);
  });

  it('returns null — NOT a zeroed status — when the frame carried nothing', () => {
    // Each of these is a real on-device state, and a HUD that treated them as
    // "sweep stopped" would flicker on a perfectly healthy sweep.
    expect(readPanoPlusStatus(null)).toBeNull();
    expect(readPanoPlusStatus({})).toBeNull();
    expect(readPanoPlusStatus({ plugins: {} })).toBeNull();
    expect(readPanoPlusStatus({ plugins: { somethingElse: { running: true } } })).toBeNull();
  });

  it('refuses a dict that is not a pano+ status at all', () => {
    // `running` is the one key native always writes; without it this is some
    // other plugin's payload and must not be read as ours.
    expect(
      readPanoPlusStatus({ plugins: { [PANO_PLUS_PLUGIN_KEY]: { seq: 3 } } }),
    ).toBeNull();
  });

  it('survives a malformed/older dict without throwing, and marks what it cannot read', () => {
    const s = readPanoPlusStatus({
      plugins: {
        [PANO_PLUS_PLUGIN_KEY]: {
          running: true,
          painted: 'lots', // wrong type
          outcome: 'a-future-outcome-name', // unknown enum
          // tracking absent entirely
        },
      },
    });
    expect(s).not.toBeNull();
    expect(s!.painted).toBe(0);
    expect(s!.outcome).toBe('unknown');
    // -1, not 0: 0 is a REAL tracking state (notAvailable), so an absent value
    // must not masquerade as a measured one.
    expect(s!.tracking).toBe(-1);
  });
});

describe('the 1D governor — precedence is the contract', () => {
  const g = (s: PanoPlusStatus | null) => panoPlusGuidance(s, 'sweeping');

  it('an abort wins over everything and names the cause', () => {
    const out = g(statusFixture({ abort: 'session-restart', stalled: true, speed: 'fast' }));
    expect(out.tone).toBe('stop');
    expect(out.headline).toContain('session-restart');
    expect(out.detail).toMatch(/world origin/i);
  });

  it('tracking outranks the stall — nothing can be latched before tracking is normal', () => {
    const out = g(statusFixture({ tracking: 1, stalled: true }));
    expect(out.headline).toMatch(/AR tracking/);
  });

  it('a stall outranks "too fast", and tells the operator to SLOW DOWN, not speed up', () => {
    const out = g(statusFixture({ stalled: true, speed: 'fast' }));
    expect(out.tone).toBe('stop');
    expect(out.headline).toMatch(/slow down/i);
    // NF3, in operator words: the window deliberately does not widen.
    expect(out.detail).toMatch(/refuses to widen/i);
  });

  it('a backtrack is reported as SAFE — the high-water rule loses nothing', () => {
    const out = g(statusFixture({ outcome: 'held-backtrack' }));
    expect(out.headline).toMatch(/nothing lost/i);
    // Without this sentence the operator "fixes" a non-problem by restarting.
    expect(out.detail).toMatch(/no duplicated facings|no repainting/i);
  });

  // ── THE LIVE RUNGS ARE ACTIONABLE AND STAY (2026-09-07) ─────────────────
  // The pre-sweep coaching came off the screen the same day. These did not,
  // and the difference is the whole rule: this text is an instruction the
  // operator can still act on WHILE the sweep is failing.
  it('KEEPS "Keep panning" when nothing is advancing', () => {
    for (const s of [
      statusFixture({ speed: 'no-motion' }),
      statusFixture({ outcome: 'skipped-no-advance' }),
    ]) {
      const out = g(s);
      expect(out.headline).toBe('Keep panning');
      expect(out.detail).toBe('No advance — the panorama is not growing.');
      expect(out.tone).toBe('warn');
    }
  });

  it('KEEPS the too-fast and lost-chain rungs', () => {
    expect(g(statusFixture({ speed: 'fast' })).headline).toBe('Too fast — slow down');
    expect(g(statusFixture({ stalled: true })).headline)
      .toBe('Lost the chain — slow down and re-approach');
  });

  it('a gap-break is surfaced DURING the sweep, not only in the summary', () => {
    const out = g(statusFixture({ gapBreak: 2 }));
    expect(out.headline).toMatch(/Break/i);
    expect(out.tone).toBe('warn');
  });

  it('a null status while sweeping is a WARNING, never a healthy-looking line', () => {
    expect(g(null).tone).toBe('warn');
  });

  // ── THE PRE-SWEEP COACHING IS GONE (2026-09-07) ─────────────────────────
  // The operator: "Why is the text on the screen needed - regarding the
  // panning? pano works the same way already right?" It is. Pano ships no
  // coaching paragraph, and this one was an INSTRUCTION, never evidence — the
  // pack's HUD sidecar records the guidance line at STOP, which is a sweeping
  // line and never this one. The live during-sweep rungs below are unaffected.
  it('the idle line says NOTHING — pano ships no coaching and nor does this', () => {
    const out = panoPlusGuidance(null, 'idle');
    expect(out.headline).toBe('');
    expect(out.detail).toBe('');
    expect(out.tone).toBe('ok');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// BOTH HOLDS ARE FIRST-CLASS — the shipped copy insisted on landscape.
// ════════════════════════════════════════════════════════════════════════════
//
// The engine never constrained the gesture: `axisOverride` is 0 (auto) on all
// three 2026-08-29 field packs and the latch votes on measured translation, so
// a portrait left-to-right sweep and a landscape top-to-bottom one are the
// SAME engine case. These were red against "Hold landscape, face the shelf".

describe('the idle coaching follows the hold, not a landscape assumption', () => {
  it('maps every orientation to a hold', () => {
    expect(panoPlusHoldOf('landscape-left')).toBe('landscape');
    expect(panoPlusHoldOf('landscape-right')).toBe('landscape');
    expect(panoPlusHoldOf('portrait')).toBe('portrait');
    expect(panoPlusHoldOf('portrait-upside-down')).toBe('portrait-upside-down');
  });

  it('coaches top-to-bottom in landscape and left-to-right in portrait', () => {
    expect(panoPlusCoachedSweep('landscape')).toEqual({
      dir: 'down', phrase: 'top to bottom', tall: true,
    });
    expect(panoPlusCoachedSweep('portrait')).toEqual({
      dir: 'right', phrase: 'left to right', tall: false,
    });
  });

  it('coaches NOTHING before the sweep, in either first-class hold', () => {
    // Both holds stayed first-class — the coached-sweep table above still
    // drives every DURING-sweep sentence (which edge is clipping, which way
    // the drift runs). What is gone is the paragraph that told the operator
    // how to stand, which is the half he objected to.
    for (const o of ['portrait', 'landscape-left', 'landscape-right'] as const) {
      const g = panoPlusGuidance(null, 'idle', { orientation: o });
      expect(g.headline).toBe('');
      expect(g.detail).toBe('');
      expect(g.tone).toBe('ok');
    }
  });

  it('produces NONE of the three stripped strings in ANY hold', () => {
    for (const o of [
      'portrait', 'portrait-upside-down', 'landscape-left', 'landscape-right',
    ] as const) {
      const { headline, detail } = panoPlusGuidance(null, 'idle', { orientation: o });
      const both = `${headline} ${detail}`;
      expect(both).not.toContain('Hold portrait — sweep left to right');
      expect(both).not.toContain('Hold landscape — sweep top to bottom');
      expect(both).not.toContain('Either hold works');
      expect(both).not.toContain('0.5–0.8 m');
    }
  });

  it('KEEPS the one hold that really is worse — upside-down', () => {
    // This rung is a REASON, not coaching: the hand sits over the lens and the
    // arrows point the wrong way, and neither is something the operator can
    // see for himself. It survives the strip; only its coaching tail went.
    const u = panoPlusGuidance(null, 'idle', {
      orientation: 'portrait-upside-down',
    });
    expect(u.tone).toBe('warn');
    expect(u.headline).toMatch(/right way up/);
    expect(u.detail).toMatch(/over the lens/);
    expect(u.detail).not.toMatch(/0\.5–0\.8 m/);
    expect(u.detail).not.toMatch(/ONE direction/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// THE PAN GUIDE POINTS ALONG THE RIGHT AXIS — `vert+` is a lie in portrait.
// ════════════════════════════════════════════════════════════════════════════

describe('the latched sweep direction, in the framebuffer', () => {
  const latched = (axis: number, sweepSign: number) =>
    statusFixture({ axis, sweepSign, axisLatched: true });
  const HOLDS = [
    'portrait', 'portrait-upside-down', 'landscape-left', 'landscape-right',
  ] as const;
  const opp: Record<string, string> = {
    up: 'down', down: 'up', left: 'right', right: 'left',
  };
  /**
   * Where a FRAMEBUFFER direction points IN THE WORLD, for a hold. The
   * framebuffer is turned by `deviceRot − fbRot` (the glyph truth table)
   * relative to gravity, so a framebuffer vector reaches the world through the
   * INVERSE turn: `R_cw(−glyphRot)`. This is the physical check that pins the
   * sign of everything above — the direction of a sweep is a fact about a
   * phone and a shelf, and two hosts that lay their framebuffers out
   * differently must agree on it.
   */
  const inWorld = (
    dir: 'up' | 'down' | 'left' | 'right' | null,
    jsLandscape: boolean,
    o: (typeof HOLDS)[number],
  ): string | null => {
    if (dir == null) return null;
    let [x, y] = dir === 'up' ? [0, -1] : dir === 'down' ? [0, 1]
      : dir === 'left' ? [-1, 0] : [1, 0];
    let quarters = Math.round(-panoPlusGlyphRotationDeg(jsLandscape, o) / 90) % 4;
    if (quarters < 0) quarters += 4;
    for (let i = 0; i < quarters; i += 1) { const nx = -y; const ny = x; x = nx; y = ny; }
    if (y < 0) return 'up';
    if (y > 0) return 'down';
    return x < 0 ? 'left' : 'right';
  };

  it('is a constant on the portrait-LOCKED field build — the framebuffer is bolted to the sensor', () => {
    // 2026-09-03: the chrome no longer turns, so the arrow is chosen in the
    // FRAMEBUFFER and drawn there. On a locked host the sensor→framebuffer
    // turn is 90 in every hold (EXIF 6), so sensor +Y always lands on fb −X:
    // the same `←` glyph whichever way the phone is held — and it is right in
    // every hold, because the glass turns WITH the sweep axis (see the world
    // table below).
    for (const o of HOLDS) {
      expect(panoPlusSweepDirection(latched(1, +1), false, o)).toBe('left');
      expect(panoPlusSweepDirection(latched(1, -1), false, o)).toBe('right');
      expect(panoPlusSweepDirection(latched(0, +1), false, o)).toBe('down');
      expect(panoPlusSweepDirection(latched(0, -1), false, o)).toBe('up');
    }
  });

  it('points the right way IN THE WORLD, in every hold — the old operator table, kept', () => {
    // The table the operator-frame version pinned, now reached through the
    // physical turn of the glass instead of a compensation inside the chrome:
    //   portrait               ⇒ +Y appears LEFT
    //   portrait-upside-down   ⇒ +Y appears RIGHT
    //   landscape-left         ⇒ +Y appears DOWN  (his top-to-bottom sweep)
    //   landscape-right        ⇒ +Y appears UP
    const world = (o: (typeof HOLDS)[number]) =>
      inWorld(panoPlusSweepDirection(latched(1, +1), false, o), false, o);
    expect(world('portrait')).toBe('left');
    expect(world('portrait-upside-down')).toBe('right');
    expect(world('landscape-left')).toBe('down');
    expect(world('landscape-right')).toBe('up');
  });

  it('is INVARIANT to the host orientation lock IN THE WORLD — this is what pins the sign', () => {
    // A portrait-LOCKED host (fbRot 0) and an unlocked one (the OS having
    // already turned the framebuffer by ±90) draw DIFFERENT glyphs for the
    // same hold — their framebuffers are laid out differently — but the glyph
    // must point the same way in the world once each framebuffer's own turn is
    // applied. A `+` where the `−` is in `panoPlusImageRotationDeg` breaks this
    // by a half turn in both landscape holds.
    for (const o of HOLDS) {
      for (const axis of [0, 1]) {
        for (const sign of [1, -1]) {
          expect(inWorld(panoPlusSweepDirection(latched(axis, sign), false, o), false, o))
            .toBe(inWorld(panoPlusSweepDirection(latched(axis, sign), true, o), true, o));
        }
      }
    }
  });

  it('reverses when the sweep sign reverses', () => {
    for (const o of HOLDS) {
      for (const jsLandscape of [false, true]) {
        for (const axis of [0, 1]) {
          const a = panoPlusSweepDirection(latched(axis, 1), jsLandscape, o)!;
          expect(panoPlusSweepDirection(latched(axis, -1), jsLandscape, o)).toBe(opp[a]);
        }
      }
    }
    // A half turn of the device reverses it IN THE WORLD (portrait vs
    // upside-down) while the framebuffer glyph stays put — the glass turned.
    expect(inWorld(panoPlusSweepDirection(latched(1, 1), false, 'portrait'), false, 'portrait'))
      .toBe('left');
    expect(inWorld(
      panoPlusSweepDirection(latched(1, 1), false, 'portrait-upside-down'),
      false, 'portrait-upside-down',
    )).toBe('right');
  });

  it('agrees with panoPlusSweepIsTall on EVERY hold and axis', () => {
    // Two independent derivations of the same geometry — a boolean and a
    // vector. If they can disagree, one of them is wrong and the preview
    // panel and the HUD arrow would coach opposite gestures.
    for (const o of HOLDS) {
      for (const jsLandscape of [false, true]) {
        for (const axis of [0, 1]) {
          const dir = panoPlusSweepDirection(latched(axis, 1), jsLandscape, o);
          const tall = panoPlusSweepIsTall(
            axis,
            panoPlusImageRotationDeg(jsLandscape, o),
          );
          expect(dir === 'up' || dir === 'down').toBe(tall);
        }
      }
    }
  });

  it('has NO direction before the latch — an arrow would be invented', () => {
    expect(panoPlusSweepDirection(statusFixture({ axisLatched: false }), false, 'portrait'))
      .toBeNull();
    expect(panoPlusSweepDirection(null, false, 'portrait')).toBeNull();
    expect(panoPlusSweepArrow(null)).toBe('');
  });

  it('prints the framebuffer arrow AND the raw pixel axis on the HUD', () => {
    // A portrait left-to-right sweep latches axis 1. The raw label reads
    // `vert+` — correct in pixel space and a lie to the operator — so the
    // line carries BOTH. The arrow is a framebuffer glyph since 2026-09-03,
    // so it is the same `→` in the landscape hold: the glass has turned with
    // the sweep and the glyph turns with the glass.
    const line = panoPlusHudLine(latched(1, -1), { orientation: 'portrait' });
    expect(line).toContain('→ vert−');
    const land = panoPlusHudLine(latched(1, -1), { orientation: 'landscape-left' });
    expect(land).toContain('→ vert−');
  });

  it('names the direction in the live governor line', () => {
    const g = panoPlusGuidance(latched(1, -1), 'sweeping', { orientation: 'portrait' });
    expect(g.headline).toBe('Panning → — keep it steady');
    expect(g.tone).toBe('ok');
  });

  // THE TWO LINES MUST NOT DISAGREE BY A QUARTER TURN WHEN NOBODY PASSES A
  // HOLD. `panoPlusGuidance` defaulted to `landscape-left` while
  // `panoPlusSweepDirection` defaulted to `portrait`, so the bare two-argument
  // call — which the offline mockup tools make, and which is the whole point
  // of the back-compat signature — got "Panning ↓" from the governor and
  // "pano+ ←" from the HUD for the same status.
  it('agrees between the governor and the HUD with no context at all', () => {
    for (const [axis, sign] of [[0, 1], [0, -1], [1, 1], [1, -1]] as const) {
      const s = latched(axis, sign);
      const arrow = panoPlusSweepArrow(panoPlusSweepDirection(s, false));
      expect(panoPlusGuidance(s, 'sweeping').headline)
        .toBe(`Panning ${arrow} — keep it steady`);
      expect(panoPlusHudLine(s)).toContain(`pano+ ${arrow} `);
    }
  });

  it('exports ONE orientation default, and every entry point uses it', () => {
    expect(PANO_PLUS_DEFAULT_ORIENTATION).toBe('portrait');
    // The idle line follows it too, rather than a second opinion. Since the
    // coaching was stripped both are the empty string, so the emptiness is
    // asserted as well — otherwise this reads as a passing comparison of two
    // values that no longer exist.
    expect(panoPlusGuidance(null, 'idle').headline).toBe(
      panoPlusGuidance(null, 'idle', { orientation: PANO_PLUS_DEFAULT_ORIENTATION })
        .headline,
    );
    expect(panoPlusGuidance(null, 'idle').headline).toBe('');
    // The SWEEPING line still follows the default, and that is where the
    // orientation contract now bites.
    expect(panoPlusGuidance(latched(0, 1), 'sweeping').headline).toBe(
      panoPlusGuidance(latched(0, 1), 'sweeping', {
        orientation: PANO_PLUS_DEFAULT_ORIENTATION,
      }).headline,
    );
  });
});

// ════════════════════════════════════════════════════════════════════════════
// THE CROSS-AXIS CEILING — never exercised in landscape, reachable in portrait
// ════════════════════════════════════════════════════════════════════════════
//
// Arithmetic pinned from the three 2026-08-29 field packs' own `meta.json`:
// stream 1920x1440 (cx 958.86), `canvasScale` 0.5, `canvasPadPx` 128 ⇒ the
// latch sizes the cross axis at 1920*0.5 + 2*128 = 1216, and all three packs
// report `clipping.canvasH = 1216`. `canvasMaxHeightPx` 2048 ⇒ 832 canvas px
// = 1664 source px of growth left. Landscape put the cross axis on the world
// HORIZONTAL and used none of it (`canvasHeightGrowths` 0, `clipping.frames`
// 0, `maxCrossRectifyDeg` 5.10°). Portrait puts it on the world VERTICAL.

describe('the cross-axis ceiling is LOUD before it truncates', () => {
  const at = (canvasHeightPx: number, over: Partial<PanoPlusStatus> = {}) =>
    statusFixture({ canvasHeightPx, ...over });

  it('reproduces the field packs: 1216 of 2048, three-quarters of the room left', () => {
    const h = panoPlusCrossHeadroom(at(1216));
    expect(h.canvasHeightPx).toBe(1216);
    expect(h.maxHeightPx).toBe(2048);
    expect(h.roomPx).toBe(832);
    expect(h.roomSourcePx).toBe(1664);   // canvasScale 0.5
    expect(h.stepsLeft).toBe(6);         // 128 px steps
    expect(h.level).toBe('ok');
  });

  it('is `near` under three growth steps and `full` when it cannot grow', () => {
    expect(panoPlusCrossHeadroom(at(2048 - 3 * 128)).level).toBe('ok');
    expect(panoPlusCrossHeadroom(at(2048 - 2 * 128)).level).toBe('near');
    expect(panoPlusCrossHeadroom(at(2048 - 128)).level).toBe('near');
    expect(panoPlusCrossHeadroom(at(2048 - 127)).level).toBe('full');
    expect(panoPlusCrossHeadroom(at(2048)).level).toBe('full');
    expect(panoPlusCrossHeadroom(at(2048)).stepsLeft).toBe(0);
  });

  it('is `unknown` before the latch — there is no canvas to be near', () => {
    expect(panoPlusCrossHeadroom(at(0)).level).toBe('unknown');
    expect(panoPlusCrossHeadroom(null).level).toBe('unknown');
  });

  it('honours a host that raised the engine cap', () => {
    const h = panoPlusCrossHeadroom(at(2048), 3072);
    expect(h.level).toBe('ok');
    expect(h.roomPx).toBe(1024);
  });

  it('WARNS BEFORE the loss, and again AT the ceiling', () => {
    const near = panoPlusGuidance(at(2048 - 200), 'sweeping', { orientation: 'portrait' });
    expect(near.tone).toBe('warn');
    expect(near.headline).toMatch(/Running out of room up or down/);
    expect(near.detail).toContain('1848/2048');

    const full = panoPlusGuidance(at(2048), 'sweeping', { orientation: 'portrait' });
    expect(full.headline).toMatch(/cross-axis ceiling/);
    expect(full.detail).toMatch(/truncated instead of absorbed/);
    // `warn`, not `stop`. `stop` is documented as "the sweep is over or must
    // be restarted"; this sweep is still painting, the rung is sticky for
    // every remaining frame, and the rung ABOVE it — `clippedFrames`, which
    // is already losing content — is itself only a `warn`.
    expect(full.tone).toBe('warn');
  });

  // ── THE REGRESSION THIS BLOCK EXISTS TO PREVENT ─────────────────────────
  //
  // The two ceiling rungs were first written ABOVE `gapBreak`. `canvasHeightPx`
  // only ever grows, so past ~1793 px a SPECULATIVE warning masked a REALISED
  // hole for the whole rest of the sweep. The suite stayed green because the
  // fixture defaults to 796 px and nothing combined the two.

  it('never lets the ceiling MASK a hole that already exists', () => {
    for (const cross of [1216, 1848, 2048]) {
      const g = panoPlusGuidance(at(cross, { gapBreak: 5 }), 'sweeping', {
        orientation: 'portrait',
      });
      expect(g.headline).toBe('Break in the panorama');
      expect(g.detail).toContain('there is a hole');
    }
  });

  it('never lets the ceiling mask a backtrack either', () => {
    const g = panoPlusGuidance(at(2048, { outcome: 'held-backtrack' }), 'sweeping', {
      orientation: 'portrait',
    });
    expect(g.headline).toMatch(/Going backwards/);
  });

  // ...and the mirror mistake is not made either: a sticky `gapBreak` must not
  // bury the one rung that can still PREVENT a loss. It rides in the detail.
  it('still SAYS the ceiling while a realised fault owns the headline', () => {
    const full = panoPlusGuidance(at(2048, { gapBreak: 5 }), 'sweeping', {
      orientation: 'portrait',
    });
    expect(full.detail).toMatch(/Also: the canvas is at 2048\/2048 px across/);
    expect(full.detail).toMatch(/next drift up or down will be truncated too/);

    const near = panoPlusGuidance(at(1848, { gapBreak: 5 }), 'sweeping', {
      orientation: 'portrait',
    });
    expect(near.detail).toMatch(/Also: only 400 px of drift up or down left/);

    // ...and stays quiet when there is room — every sweep shot to date.
    expect(panoPlusGuidance(at(1216, { gapBreak: 5 }), 'sweeping', {
      orientation: 'portrait',
    }).detail).not.toMatch(/Also:/);
  });

  it('models the AREA budget, which bites before the height cap on a long sweep', () => {
    // `ensureCanvasBand` calls `areaWithinBudget(canvasW, nh)` AFTER passing
    // `canvasMaxHeightPx`, so at 18 MP a 12 000 px-wide canvas can only reach
    // 1500 rows — and the height cap says 2048.
    const wide = statusFixture({ canvasHeightPx: 1450, canvasWidthPx: 12000 });
    const h = panoPlusCrossHeadroom(wide, 2048, 0.5);
    expect(h.maxHeightPx).toBe(2048);
    expect(h.effectiveMaxPx).toBe(1500);   // floor(18e6 / 12000)
    expect(h.boundBy).toBe('area');
    expect(h.level).toBe('full');          // 50 px of room ⇒ 0 steps
    // Without the area bound this reported `ok` right up to the clip.
    expect(panoPlusGuidance(wide, 'sweeping', { orientation: 'portrait' }).headline)
      .toMatch(/cross-axis ceiling/);
    expect(panoPlusHudLine(wide)).toContain('CROSS FULL 1450/1500!');
  });

  it('reports `frozen` when the host turned vertical growth OFF', () => {
    // `canvasGrowVertical` is a host option. With it off the canvas clips at
    // the latch height, and quoting the 2048 cap describes a ceiling the
    // engine will never walk to.
    const h = panoPlusCrossHeadroom(at(1216), 2048, 0.5, { canvasGrowVertical: false });
    expect(h.boundBy).toBe('frozen');
    expect(h.effectiveMaxPx).toBe(1216);
    expect(h.level).toBe('full');
    expect(h.roomPx).toBe(0);
  });

  it('does NOT claim a ceiling it has not reached when reporting clipping', () => {
    // The shipped copy asserted "the canvas is at its 2048 px cross-axis
    // ceiling" whenever ANY strip clipped — quoting the cap, not the height.
    const g = panoPlusGuidance(
      at(1216, { clippedFrames: 4 }),
      'sweeping',
      { orientation: 'portrait', canvasGrowVertical: false },
    );
    expect(g.detail).toContain('vertical growth is off');
    expect(g.detail).toContain('1216 px cross-axis ceiling');

    const growing = panoPlusGuidance(at(1216, { clippedFrames: 4 }), 'sweeping', {
      orientation: 'portrait',
    });
    expect(growing.detail).not.toContain('cross-axis ceiling');
    expect(growing.detail).toContain('1216/2048 px across and is still growing');
  });

  it('names the right DIMENSION in the clipped headline, per hold', () => {
    // The headline was hardcoded to "shelf height" — right for portrait and
    // exactly backwards for the landscape hold the operator actually shoots.
    const clipped = at(2048, { clippedFrames: 7 });
    expect(panoPlusGuidance(clipped, 'sweeping', { orientation: 'portrait' }).headline)
      .toBe('Losing shelf height — recentre the phone');
    expect(panoPlusGuidance(clipped, 'sweeping', { orientation: 'landscape-left' }).headline)
      .toBe('Losing shelf width — recentre the phone');
  });

  it('names the CORRECT edges per hold — the shipped copy said top/bottom always', () => {
    // A landscape top-to-bottom sweep loses shelf WIDTH off the left and
    // right; a portrait left-to-right sweep loses HEIGHT off top and bottom.
    const clipped = at(2048, { clippedFrames: 7 });
    expect(panoPlusGuidance(clipped, 'sweeping', { orientation: 'portrait' }).detail)
      .toContain('top or bottom');
    expect(panoPlusGuidance(clipped, 'sweeping', { orientation: 'landscape-left' }).detail)
      .toContain('left or right');
    expect(panoPlusGuidance(at(2048 - 200), 'sweeping', { orientation: 'landscape-left' })
      .headline).toMatch(/left or right/);
  });

  it('puts it on the HUD too, and only once it is worth naming', () => {
    expect(panoPlusHudLine(at(1216))).not.toContain('cross');
    expect(panoPlusHudLine(at(2048 - 200))).toContain('cross 1848/2048');
    expect(panoPlusHudLine(at(2048))).toContain('CROSS FULL 2048/2048');
  });

  it('leaves the already-clipping rung LOUDER, not replaced', () => {
    const g = panoPlusGuidance(at(2048, { clippedFrames: 3 }), 'sweeping', {
      orientation: 'portrait',
    });
    expect(g.headline).toMatch(/Losing shelf height/);
    expect(g.detail).toMatch(/TRUNCATED/);
    expect(g.detail).toContain('2048 px cross-axis ceiling');
  });
});

describe('HUD', () => {
  it('shows the rejection buckets — a quietly-rejecting sweep must be visible', () => {
    const line = panoPlusHudLine(
      statusFixture({ rejectedLowResponse: 4, rejectedOutOfCage: 2, rejectedPoseSpeed: 1 }),
    );
    expect(line).toContain('rej 7');
    expect(line).toContain('114/120 painted');
    expect(line).toContain('horiz+');
  });

  it('says "axis?" until the axis is latched', () => {
    expect(panoPlusHudLine(statusFixture({ axisLatched: false }))).toContain('axis?');
  });

  it('a healthy pass shows NO drop line; drops are never silent', () => {
    expect(panoPlusDropLine(statusFixture({ maxRectifyDeg: 0 }))).toBeNull();
    const drops = panoPlusDropLine(statusFixture({ droppedQueue: 3, droppedPack: 5 }));
    expect(drops).toContain('3 frame(s) dropped');
    expect(drops).toContain('5 pack write(s) dropped');
  });

  it('a lock that took cleanly shows NO chrome; a refused one warns AT START', () => {
    // The drift clause in `panoPlusDropLine` is the better signal but cannot
    // fire until >2% has already drifted, i.e. until part of the sweep is
    // already banded. This one reads the device's own read-back at t=0.
    expect(
      panoPlusCameraLockLine({
        available: true,
        requested: true,
        locked: true,
        settleConverged: true,
      }),
    ).toBeNull();
    const refused = panoPlusCameraLockLine({
      available: true,
      requested: true,
      locked: false,
      reason: 'device-busy: the device is in use',
    });
    expect(refused).toContain('EXPOSURE NOT LOCKED');
    expect(refused).toContain('device-busy');
  });

  it('an unconverged settle and a declined focus lock are NOT the same failure', () => {
    // A lock taken over a still-converging camera makes the sweep uniformly
    // mis-metered, not banded — reporting it as "not locked" would send the
    // operator after the wrong defect. And focus is DELIBERATELY left on auto
    // when the lens was hunting: a pinned unconverged lens trades the banding
    // defect for a defocused sweep, which no photometry can undo.
    const line = panoPlusCameraLockLine({
      available: true,
      requested: true,
      locked: true,
      settleConverged: false,
      focusLockDeclined: true,
    });
    expect(line).not.toContain('EXPOSURE NOT LOCKED');
    expect(line).toContain('metering did not settle');
    expect(line).toContain('focus left on AUTO');
  });

  it('lockCamera=false is a DECISION, not a warning; no device at all IS one', () => {
    expect(
      panoPlusCameraLockLine({ available: true, requested: false, locked: false }),
    ).toBeNull();
    expect(panoPlusCameraLockLine(null)).toBeNull();
    expect(panoPlusCameraLockLine({ available: false })).toContain(
      'NO CAMERA DEVICE',
    );
  });

  it('the Android start bag — requested, read-back pending — prints NOTHING', () => {
    // Android's `start()` resolves before the lock read-back exists (it is
    // written on the camera thread and published at stop()), so the bag says
    // `requested` and stays silent on `locked`. That is "not known yet", and
    // it used to render as EXPOSURE NOT LOCKED at t=0 — and, when the bag also
    // omitted `available`, as NO CAMERA DEVICE over a live feed from a camera
    // the recorder had demonstrably opened (A35, 2026-09-03).
    expect(
      panoPlusCameraLockLine({ available: true, requested: true }),
    ).toBeNull();
    // The AR arm: ARCore owns the shared session, so no lock is REQUESTED and
    // the reason travels with the bag. A decision, not a warning — the arm
    // banner already names the cost.
    expect(
      panoPlusCameraLockLine({
        available: true,
        requested: false,
        reason: 'arcore-owns-session: ARCore installs its own repeating request',
      }),
    ).toBeNull();
    // An EXPLICIT refusal still warns — the iOS read-back is unchanged.
    expect(
      panoPlusCameraLockLine({ available: true, requested: true, locked: false }),
    ).toContain('EXPOSURE NOT LOCKED');
  });

  it('the starting phase NAMES the metering wait rather than looking like lag', () => {
    // ~600 ms of motion after the button press is dropped on the floor while
    // the frame plugin waits for the lock. Saying so is the difference between
    // a deliberate wait and a bug report.
    const g = panoPlusGuidance(null, 'starting');
    expect(g.headline).toContain('Metering');
    expect(g.detail).toContain('exposure');
  });

  it('the preview source carries the seq cache-bust, and is null before the first preview', () => {
    expect(panoPlusPreviewSource(statusFixture({ previewSeq: 0 }))).toBeNull();
    expect(panoPlusPreviewSource(statusFixture({ previewPath: '' }))).toBeNull();
    // Without `?v=`, RN's image cache shows preview #1 for the whole sweep —
    // native writes the SAME path every time (atomic rename).
    expect(panoPlusPreviewSource(statusFixture())!.uri).toBe(
      'file:///var/mobile/Documents/panoplus/pp_1/preview.jpg?v=12',
    );
  });
});

describe('summary coercion + the G1 verdict', () => {
  it('a zero-filled summary is produced rather than a throw on an odd binary', () => {
    const s = coercePanoPlusSummary(undefined);
    expect(s.width).toBe(0);
    expect(s.counts.painted).toBe(0);
    expect(s.unpaintedRuns).toEqual([]);
    expect(s.abort).toBeNull();
  });

  it('holds G1 only when there are no holes AND no gap-break frames', () => {
    const base = coercePanoPlusSummary({
      width: 4000,
      height: 600,
      counts: { seen: 300, painted: 280, gapBreak: 0 },
      unpaintedRuns: [],
      unpaintedColumns: 0,
    });
    expect(panoPlusIntegrity(base).holdsG1).toBe(true);

    // A gap-break with no surviving hole run is still a G1 failure: the frame
    // could not reach the frontier, and pretending otherwise is exactly the
    // "fill/dims gate blind to it" failure the batch stitcher shipped.
    const broken = { ...base, counts: { ...base.counts, gapBreak: 2 } };
    expect(panoPlusIntegrity(broken).holdsG1).toBe(false);
    expect(panoPlusIntegrity(broken).line).toContain('gap-break');
  });

  it('reports hole extent as a fraction of the panorama, not a bare count', () => {
    const s = coercePanoPlusSummary({
      width: 1000,
      height: 600,
      counts: {},
      unpaintedRuns: [[100, 140], [300, 310]],
      unpaintedColumns: 50,
    });
    const v = panoPlusIntegrity(s);
    expect(v.holeRuns).toBe(2);
    expect(v.holeFraction).toBeCloseTo(0.05, 6);
    expect(v.line).toContain('5.0%');
  });

  // THE finding this block exists for: G1 only looks ALONG the sweep. A
  // panorama that drifted off the canvas band is missing shelf height on every
  // truncated strip, and the hole check reports it CLEAN. `isIntact` is what
  // the UI must gate on.
  it('a vertically truncated panorama is NOT intact, even with zero holes', () => {
    const s = coercePanoPlusSummary({
      width: 4000,
      height: 451,
      counts: { seen: 220, painted: 210, gapBreak: 0 },
      unpaintedRuns: [],
      unpaintedColumns: 0,
      clipping: { frames: 60, columns: 813, maxTopPx: 0, maxBottomPx: 440, canvasH: 796, heightGrowths: 4 },
    });
    const v = panoPlusIntegrity(s);
    expect(v.holdsG1).toBe(true);           // the sweep-axis gate is clean…
    expect(v.isIntact).toBe(false);         // …and the panorama is still broken
    expect(v.clippedFrames).toBe(60);
    expect(v.clippedFraction).toBeCloseTo(813 / 4000, 6);
    expect(v.clipLine).toContain('TRUNCATED');
    expect(v.clipLine).toContain('440');
  });

  // ── v5: THE CUT BLIND SPOT ────────────────────────────────────────────
  //
  // THE finding this block exists for, and it is the operator's own words:
  // "there is wobble, warping and cuts through the output in multiple places.
  // Not the production quality that is expected." Every gate v4 shipped
  // reported that pack CLEAN. The numbers below are pack
  // panoplus-debug-pack-2026-08-20T15-58-22-393Z's real ones — its canvas, its
  // counts, its zero holes, its zero clipping — plus the seam metric v5 adds.
  it('the operator’s 15-58-22 pack cannot report clean once seams are measured', () => {
    const s = coercePanoPlusSummary({
      width: 1344,
      height: 1474,
      counts: { seen: 537, painted: 318, gapBreak: 0 },
      unpaintedRuns: [],
      unpaintedColumns: 0,
      unpaintedRunsAxis: 'y',
      clipping: { frames: 0, columns: 0, maxTopPx: 0, maxBottomPx: 0, canvasH: 1344, heightGrowths: 1 },
      // measured by replaying the pack through the offline twin under the v4
      // placement model, with the v5 metric switched on
      seam: {
        worstBandP50Px: 0.20,
        worstBandP95Px: 0.45,
        worstBandMaxPx: 2.44,
        bandSpreadP95Px: 0.62,
        crossBandDivergencePx: 56.4,
        crossBandDivergenceNormPx: 3.16,
        lumaStepP50DN: 0.5,
        lumaStepP95DN: 4.0,
        lumaStepMaxDN: 21.5,
        boundaries: 318,
        coverageFrac: 1.0,
        canvasJogP50Px: 0.16,
        canvasJogP95Px: 0.79,
        canvasJogMaxPx: 1.08,
        canvasJogSamples: 319,
        measured: true,
        integrityFailed: true,
        integrityReason: 'band max > 1.50 px',
      },
      projection: { mode: 0, maxAreaScalePainted: 5.23, maxCrossRectifyDeg: 16.07, sweepDeg: 0 },
      gain: { cumEnd: 0.764, leak: 0, cumClamp: 2 },
    });
    const v = panoPlusIntegrity(s);

    // Everything v4 could see says this pack is perfect:
    expect(v.holdsG1).toBe(true);
    expect(v.clippedFrames).toBe(0);
    expect(v.clipLine).toBeNull();

    // ...and it is not.
    expect(v.hasCuts).toBe(true);
    expect(v.isIntact).toBe(false);
    expect(v.seamLine).toContain('CUTS');
    expect(v.seamLine).toContain('2.44');
    expect(v.warpLine).toContain('5.23');
    expect(v.gainLine).toContain('gainLeak is OFF');
  });

  // A pack written before the metric existed must be called UNMEASURED, never
  // silently clean — that conflation is the whole defect.
  it('a pack with no seam block is reported unmeasured, not clean', () => {
    const s = coercePanoPlusSummary({
      // A REAL v4 pack: strips painted, no seam block at all.
      width: 4000, height: 540,
      counts: { seen: 420, painted: 400, gapBreak: 0 },
      unpaintedRuns: [], unpaintedColumns: 0,
      clipping: { frames: 0, columns: 0, canvasH: 796, heightGrowths: 2 },
    });
    const v = panoPlusIntegrity(s);
    // THE FIX. `hasCuts` used to be gated on `seamMeasured`, so an unmeasured
    // pack flowed straight through to `isIntact === true` and rendered the
    // green "seams inside bars" banner. Unmeasured is not a pass.
    expect(v.seamMeasured).toBe(false);
    expect(v.hasCuts).toBe(true);
    expect(v.isIntact).toBe(false);
    expect(v.seamLine).toContain('NOT MEASURED');
    expect(v.seamLine).toContain('NOT the same thing as clean');
  });

  // ...and the same is true of a pack whose seam block exists but is EMPTY,
  // which is what `seamMetrics: false` or `crossWindows: 1` produces on a
  // current binary. Both are reachable through PanoPlusEngineOptions, so both
  // are live ways to turn the gate green.
  it('a pack whose seam block measured nothing is unmeasured, not clean', () => {
    const s = coercePanoPlusSummary({
      width: 4000, height: 540,
      counts: { seen: 400, painted: 380, gapBreak: 0 },
      unpaintedRuns: [], unpaintedColumns: 0,
      clipping: { frames: 0, columns: 0, canvasH: 796, heightGrowths: 2 },
      seam: { boundaries: 0, canvasJogSamples: 0, measured: false,
              integrityFailed: true,
              integrityReason: 'band metric NOT MEASURED; '
                + 'committed-pixel metric NOT MEASURED' },
    });
    const v = panoPlusIntegrity(s);
    expect(v.holdsG1).toBe(true);
    expect(v.clippedFrames).toBe(0);
    expect(v.seamMeasured).toBe(false);
    expect(v.hasCuts).toBe(true);
    expect(v.isIntact).toBe(false);
  });

  // ...and the bar must be PASSABLE, or it is not a gate. These are the v5
  // replay numbers for the same pack.
  // THE v6 HEADLINE, on the operator's own pack 15-58-22 with the numbers the
  // offline twin measured: the CUT bars pass exactly as they did under v5, and
  // the pack still must not be called clean, because it is BANDED.  v5 had
  // every one of these photometric numbers available, printed the DC step, and
  // left it out of the verdict.
  it('the v5 replay of 15-58-22 passes the cut bars and FAILS on banding', () => {
    const s = coercePanoPlusSummary({
      width: 1216, height: 1522,
      counts: { seen: 537, painted: 319, gapBreak: 0 },
      unpaintedRuns: [], unpaintedColumns: 0, unpaintedRunsAxis: 'y',
      clipping: { frames: 0, columns: 0, canvasH: 1216, heightGrowths: 1 },
      seam: {
        worstBandP50Px: 0.17, worstBandP95Px: 0.38, worstBandMaxPx: 0.63,
        bandSpreadP95Px: 0.5, crossBandDivergencePx: 52.4,
        crossBandDivergenceNormPx: 2.94,
        lumaStepP95DN: 4.0, boundaries: 319, coverageFrac: 1.0,
        canvasJogP50Px: 0.15, canvasJogP95Px: 0.87, canvasJogMaxPx: 1.10,
        canvasJogSamples: 319, measured: true,
        // The engine's own verdict, which under v6 fires on the photometry.
        integrityFailed: true,
        integrityReason: 'seam DC step p95 > 1.20 DN; seam DC step max > 3.00 DN',
        // MEASURED BY THE TWIN on this exact pack.
        photoStepP50DN: 0.44, photoStepP95DN: 1.86, photoStepMaxDN: 3.26,
        photoSamples: 319, photoNonUniform: 319,
        photoDriftLocalPct: 7.71, photoDriftTotalPct: 11.34,
        photoDriftWorstU: 632,
      },
      projection: { mode: 1, maxAreaScalePainted: 2.45, maxCrossRectifyDeg: 4.4, sweepDeg: 15.9,
                    subjectDistanceFitM: 0.72 },
      gain: {
        cumEnd: 0.764, leak: 0, cumClamp: 2,
        localP2PPct: 14.04, localWorstU: 632, localWindowPx: 40,
        rangePct: 36.34, scaleMin: 0.7195, scaleMax: 0.9878, columns: 1340,
      },
      exposure: {
        // No per-frame metadata on this path — every pack captured before v6
        // is in this state, and the verdict must say UNKNOWN rather than
        // implying the exposure was fine.
        normalize: true, gainClamp: 4, metaFrames: 0, clampedFrames: 0,
        refValue: 0, minValue: 0, maxValue: 0, rangeRatio: 1, lock: null,
      },
    });
    const v = panoPlusIntegrity(s);
    // The GEOMETRY is unchanged and still passes — this is a photometric
    // finding, not a re-litigation of the cut metric.
    expect(v.seamMeasured).toBe(true);
    expect(v.hasCuts).toBe(false);
    expect(v.seamLine).toContain('seams clean');
    expect(v.warpLine).toContain('sweep-cylindrical');
    expect(v.warpLine).toContain('0.72 m');
    // ...and the pack is NOT clean.
    expect(v.photoMeasured).toBe(true);
    expect(v.hasBanding).toBe(true);
    expect(v.isIntact).toBe(false);
    expect(v.bandLine).toContain('BANDING');
    expect(v.bandLine).toContain('7.7%');
    expect(v.exposureLine).toContain('NO PER-FRAME METADATA');
  });

  // THE OTHER DIRECTION, and it matters just as much: the operator has been
  // handed four false "clean" verdicts, so a gate added in response must not
  // now fail output that is genuinely fine.
  it('a locked, photometrically flat sweep is still called intact', () => {
    const s = coercePanoPlusSummary({
      width: 1216, height: 1522,
      counts: { seen: 537, painted: 319, gapBreak: 0 },
      unpaintedRuns: [], unpaintedColumns: 0, unpaintedRunsAxis: 'y',
      clipping: { frames: 0, columns: 0, canvasH: 1216, heightGrowths: 1 },
      seam: {
        worstBandP50Px: 0.17, worstBandP95Px: 0.38, worstBandMaxPx: 0.63,
        crossBandDivergencePx: 52.4, crossBandDivergenceNormPx: 2.94,
        boundaries: 319, coverageFrac: 1.0,
        canvasJogP50Px: 0.15, canvasJogP95Px: 0.87, canvasJogMaxPx: 1.10,
        canvasJogSamples: 319, measured: true,
        integrityFailed: false, integrityReason: '',
        photoStepP50DN: 0.18, photoStepP95DN: 0.51, photoStepMaxDN: 1.40,
        photoSamples: 319, photoNonUniform: 4,
        photoDriftLocalPct: 1.2, photoDriftTotalPct: 2.4, photoDriftWorstU: 88,
      },
      projection: { mode: 1, maxAreaScalePainted: 2.45 },
      gain: {
        cumEnd: 0.995, leak: 0, cumClamp: 2,
        localP2PPct: 0.9, localWorstU: 88, localWindowPx: 40,
        rangePct: 1.8, scaleMin: 0.99, scaleMax: 1.008, columns: 1340,
      },
      exposure: {
        normalize: true, gainClamp: 4, metaFrames: 519, clampedFrames: 0,
        refValue: 0.00167, minValue: 0.00167, maxValue: 0.00167, rangeRatio: 1.0,
        lock: { available: true, requested: true, locked: true,
                exposureLocked: true, whiteBalanceLocked: true,
                focusLocked: true, reason: '' },
      },
    });
    const v = panoPlusIntegrity(s);
    expect(v.photoMeasured).toBe(true);
    expect(v.hasBanding).toBe(false);
    expect(v.hasCuts).toBe(false);
    expect(v.isIntact).toBe(true);
    expect(v.bandLine).toContain('photometry clean');
    // 1.00 WITH metered frames is the proof the sweep lock held.  1.00 with
    // none is UNKNOWN, and the line above says so instead.
    expect(v.exposureLine).toContain('LOCKED');
  });

  // NOT MEASURED IS ITS OWN FAILURE — the clause v5 lacked, restated for the
  // photometric instrument.  A v5 pack replayed through a v6 reader carries no
  // photometric block at all, and must not inherit v5's silence.
  it('a pack with no photometric block cannot be called clean', () => {
    const s = coercePanoPlusSummary({
      width: 1216, height: 1522,
      counts: { seen: 537, painted: 319, gapBreak: 0 },
      unpaintedRuns: [], unpaintedColumns: 0, unpaintedRunsAxis: 'y',
      clipping: { frames: 0, columns: 0, canvasH: 1216, heightGrowths: 1 },
      seam: {
        worstBandP50Px: 0.17, worstBandP95Px: 0.38, worstBandMaxPx: 0.63,
        crossBandDivergencePx: 52.4, crossBandDivergenceNormPx: 2.94,
        boundaries: 319, coverageFrac: 1.0,
        canvasJogP50Px: 0.15, canvasJogP95Px: 0.87, canvasJogMaxPx: 1.10,
        canvasJogSamples: 319, measured: true,
        integrityFailed: false, integrityReason: '',
      },
      projection: { mode: 1, maxAreaScalePainted: 2.45 },
      gain: { cumEnd: 0.764, leak: 0, cumClamp: 2 },
    });
    const v = panoPlusIntegrity(s);
    expect(v.seamMeasured).toBe(true);
    expect(v.hasCuts).toBe(false);
    expect(v.photoMeasured).toBe(false);
    expect(v.hasBanding).toBe(true);
    expect(v.isIntact).toBe(false);
    expect(v.bandLine).toContain('NOT MEASURED');
  });

  // THE LENGTH CLAUSE. The raw cumulative divergence grows with the sweep, so
  // an absolute bar on it fails a long sweep of identical per-frame quality.
  // The shipped bar is on the sqrt(n)-normalised number: same pack, four times
  // the boundaries, same quality, still clean.
  it('a long sweep is not failed for being long', () => {
    const mk = (boundaries: number, raw: number) =>
      coercePanoPlusSummary({
        width: 6000, height: 1500,
        counts: { seen: boundaries + 20, painted: boundaries + 1, gapBreak: 0 },
        unpaintedRuns: [], unpaintedColumns: 0, unpaintedRunsAxis: 'y',
        clipping: { frames: 0, columns: 0, canvasH: 1216, heightGrowths: 1 },
        seam: {
          worstBandP50Px: 0.17, worstBandP95Px: 0.38, worstBandMaxPx: 0.63,
          crossBandDivergencePx: raw,
          crossBandDivergenceNormPx: raw / Math.sqrt(boundaries),
          boundaries, coverageFrac: 1, canvasJogP50Px: 0.15,
          canvasJogP95Px: 0.87, canvasJogMaxPx: 1.10,
          canvasJogSamples: boundaries, measured: true, integrityFailed: false,
          // v6 — a MEASURED, clean photometric block.  Without one the
          // verdict now (correctly) refuses to call the pack clean, which is
          // the whole point of the v6 clause: v5 measured a seam DC step,
          // printed it, and let three of the operator's four banded packs
          // through.
          photoStepP50DN: 0.21, photoStepP95DN: 0.44, photoStepMaxDN: 1.10,
          photoSamples: 300, photoNonUniform: 0,
          photoDriftLocalPct: 1.8, photoDriftTotalPct: 3.1,
          photoDriftWorstU: 120,
        },
        projection: { mode: 1, maxAreaScalePainted: 2.45 },
        gain: { cumEnd: 1, leak: 0, cumClamp: 2 },
      });
    // 318 boundaries at 52.4 px raw is the operator's own v5 replay.  A sweep
    // four times as long with the SAME per-boundary quality accumulates
    // sqrt(4) x the raw sum.
    const shortSweep = panoPlusIntegrity(mk(318, 52.4));
    const longSweep = panoPlusIntegrity(mk(1272, 52.4 * 2));
    expect(shortSweep.isIntact).toBe(true);
    expect(longSweep.isIntact).toBe(true);
    // ...and the retired raw bar would have failed the long one.
    expect(52.4 * 2).toBeGreaterThan(PANOPLUS_BAND_DIVERGENCE_BAR);
  });

  it('a clean sweep has no clip line at all', () => {
    const s = coercePanoPlusSummary({
      width: 4000, height: 540,
      counts: { seen: 420, painted: 400, gapBreak: 0 },
      unpaintedRuns: [], unpaintedColumns: 0,
      clipping: { frames: 0, columns: 0, canvasH: 796, heightGrowths: 2 },
      // A MEASURED clean seam block: without one the verdict now (correctly)
      // reports the pack unmeasured, and this test is about the clip line.
      seam: {
        worstBandP50Px: 0.13, worstBandP95Px: 0.38, worstBandMaxPx: 0.85,
        crossBandDivergencePx: 32.2, crossBandDivergenceNormPx: 1.73,
        boundaries: 345, coverageFrac: 1, canvasJogP50Px: 0.10,
        canvasJogP95Px: 0.31, canvasJogMaxPx: 0.80, canvasJogSamples: 345,
        measured: true, integrityFailed: false,
        // v6 — a MEASURED, clean photometric block; see the note above.
        photoStepP50DN: 0.21, photoStepP95DN: 0.44, photoStepMaxDN: 1.10,
        photoSamples: 345, photoNonUniform: 0,
        photoDriftLocalPct: 1.8, photoDriftTotalPct: 3.1, photoDriftWorstU: 120,
      },
    });
    const v = panoPlusIntegrity(s);
    expect(v.isIntact).toBe(true);
    expect(v.clipLine).toBeNull();
  });

  // A vertical sweep is TRANSPOSED by the finalize bake, so the runs index the
  // output's ROW axis. Measuring them against `width` would be wrong for every
  // portrait-held sweep.
  it('measures hole extent against the axis the runs actually index', () => {
    const s = coercePanoPlusSummary({
      width: 600,
      height: 1000,
      counts: {},
      unpaintedRuns: [[100, 150]],
      unpaintedColumns: 50,
      unpaintedRunsAxis: 'y',
    });
    const v = panoPlusIntegrity(s);
    expect(v.holeFraction).toBeCloseTo(0.05, 6);   // 50 / height, not / width
    expect(v.line).toContain('row(s)');
  });
});

describe('residual lines — the operator’s evaluation gate, on the phone', () => {
  it('names the arm first, so a control run can never be mistaken for the hypothesis', () => {
    const s = coercePanoPlusSummary({ counts: {}, engineMs: {}, arThreadUs: {} });
    expect(panoPlusResidualLines(s, { rectify: false, gainMatch: true })[0]).toContain(
      'rectify OFF (control)',
    );
    expect(panoPlusResidualLines(s, { rectify: true, gainMatch: true })[0]).toContain(
      'rectify ON',
    );
  });

  it('reports drops and the abort explicitly', () => {
    const s = coercePanoPlusSummary({
      counts: {},
      engineMs: {},
      arThreadUs: {},
      droppedQueue: 7,
      abort: 'chain-lost',
      packFrameCapHit: true,
    });
    const lines = panoPlusResidualLines(s, { rectify: true, gainMatch: true }).join('\n');
    expect(lines).toContain('DROPS');
    expect(lines).toContain('pack frame cap HIT');
    expect(lines).toContain('ABORTED: chain-lost');
  });

  it('states the perpendicular truth either way — it is not in the hole check', () => {
    const clean = coercePanoPlusSummary({
      counts: {}, engineMs: {}, arThreadUs: {}, previewMs: {},
      clipping: { frames: 0, columns: 0, canvasH: 924, heightGrowths: 1 },
    });
    expect(panoPlusResidualLines(clean, { rectify: true, gainMatch: true }).join('\n'))
      .toContain('nothing truncated');

    const cut = coercePanoPlusSummary({
      counts: {}, engineMs: {}, arThreadUs: {}, previewMs: {},
      clipping: { frames: 60, columns: 813, maxTopPx: 0, maxBottomPx: 440, canvasH: 796, heightGrowths: 4 },
    });
    expect(panoPlusResidualLines(cut, { rectify: true, gainMatch: true }).join('\n'))
      .toContain('TRUNCATED');
  });

  it('surfaces limited-tracking frames rather than hiding a poor-tracking pass', () => {
    const s = coercePanoPlusSummary({
      counts: { limitedFrames: 34 }, engineMs: {}, arThreadUs: {}, previewMs: {},
    });
    expect(panoPlusResidualLines(s, { rectify: true, gainMatch: true }).join('\n'))
      .toContain('34 frame(s) ran with ARKit tracking LIMITED');
  });

  it('reports the pack size — hundreds of MB should not be a surprise', () => {
    const s = coercePanoPlusSummary({
      counts: {}, engineMs: {}, arThreadUs: {}, previewMs: {},
      framesWritten: 1500, packBytes: 512 * 1024 * 1024,
    });
    expect(panoPlusResidualLines(s, { rectify: true, gainMatch: true }).join('\n'))
      .toContain('512 MB on disk');
  });
});

describe('result shape (a contract other files key off)', () => {
  it('stamps kind + type panoplus and carries the pack root', () => {
    const summary = coercePanoPlusSummary({
      sessionDir: '/d/pp_1',
      canvasPath: '/d/pp_1/canvas.jpg',
      width: 4000,
      height: 600,
      counts: {},
    });
    const r = panoPlusResultOf(
      summary,
      // `poseSource` is the arm NATIVE REPORTED STARTING. `'ar'` is the
      // production default (PanoPlusCaptureSurface's own default), which is the
      // arm this shape-of-the-result case is about.
      { rectify: true, gainMatch: true, packFrames: 'all', poseSource: 'ar' },
      '2026-08-19T00:00:00.000Z',
    );
    // debugPack.ts routes the pack-name prefix and the sessionDir collection
    // off these two — a rename here silently changes where field packs land.
    expect(r.kind).toBe('panoplus');
    expect(r.type).toBe('panoplus');
    expect(r.uri).toBe('/d/pp_1/canvas.jpg');
    expect(r.sessionDir).toBe('/d/pp_1');
    expect(r.arms.rectify).toBe(true);
    expect(r.capturedAt).toBe('2026-08-19T00:00:00.000Z');
  });
});

describe('failures carry their pack', () => {
  it('reads sessionDir + counts + abort off an RN-bridged NSError userInfo', () => {
    const e = {
      code: 'panoplus-empty',
      message: 'The sweep produced no panorama (chain-lost).',
      userInfo: {
        sessionDir: '/d/pp_9',
        abort: 'chain-lost',
        counts: { seen: 90, painted: 0, rejectedOutOfCage: 61 },
      },
    };
    const info = panoPlusErrorInfo(e);
    expect(info.code).toBe('panoplus-empty');
    expect(info.sessionDir).toBe('/d/pp_9');
    expect(info.abort).toBe('chain-lost');
    expect(info.counts!.rejectedOutOfCage).toBe(61);
    // The copy must SAY the pack is worth keeping, or a field operator deletes
    // the one artifact that explains the failure.
    expect(panoPlusFailureCopy(info)).toMatch(/worth keeping/i);
  });

  it('degrades to a usable code on a non-native throw', () => {
    const info = panoPlusErrorInfo(new Error('boom'));
    expect(info.code).toBe('unknown');
    expect(info.sessionDir).toBeNull();
    expect(info.counts).toBeNull();
    expect(panoPlusFailureCopy(info)).toBe('boom');
  });

  it('names the unavailable case rather than showing a bare code', () => {
    expect(
      panoPlusFailureCopy({
        code: 'panoplus-unavailable',
        message: 'x',
        sessionDir: null,
        counts: null,
        abort: null,
      }),
    ).toMatch(/not in this build/i);
  });
});

// ── THE LIVE VERDICT ────────────────────────────────────────────────────────
//
// The bridge has shipped the seam state on every status frame since v5, and
// before this it was read by nothing: "the HUD can go red mid-sweep" was true
// of the wire and false of the app. The operator recorded four packs he could
// see were broken while the HUD said nothing about them.
describe('the live cut verdict on the HUD', () => {
  const base = {
    running: true,
    framesSeen: 400, painted: 380, paintedWidthPx: 1340, advancePx: 4.1,
    stripPx: 6.2, heldBacktrack: 0, heldFrontier: 0, rejectedLowResponse: 0,
    rejectedOutOfCage: 0, rejectedPoseSpeed: 0, rejectedRectify: 0,
    rejectedTracking: 0, clippedFrames: 0, limitedFrames: 0, axisLatched: true,
    axis: 0, sweepSign: 1, engineMs: 0.8, previewSeq: 3,
  };

  it('shows the seam number while the sweep is running', () => {
    const st = coercePanoPlusStatus({
      ...base, seamMeasured: true, integrityFailed: false,
      seamWorstBandP95Px: 0.38, maxAreaScale: 2.45,
    });
    expect(st).not.toBeNull();
    expect(panoPlusHudLine(st)).toContain('seam 0.38');
    expect(panoPlusHudLine(st)).not.toContain('CUTS');
  });

  // THE LIVE HUD IS THE SURFACE THE OPERATOR READS DURING A SWEEP, and it was
  // the one place `seamBandSelfScored` did not reach: the field was coerced off
  // the status and then read by nothing, so the review screen carried the
  // warning while the HUD printed the bare (artificially low) percentile.
  it('marks the seam percentile when the chain was fitted to it', () => {
    const plain = coercePanoPlusStatus({
      ...base, seamMeasured: true, integrityFailed: false,
      seamWorstBandP95Px: 0.38, seamBandSelfScored: false,
    });
    expect(panoPlusHudLine(plain)).toContain('seam 0.38');
    expect(panoPlusHudLine(plain)).not.toContain('fit');

    const fitted = coercePanoPlusStatus({
      ...base, seamMeasured: true, integrityFailed: false,
      seamWorstBandP95Px: 0.25, seamBandSelfScored: true,
    });
    expect(panoPlusHudLine(fitted)).toContain('seam 0.25⚠fit');

    // ...and on the red rung too, which is where a low number would be most
    // misleading.
    const cut = coercePanoPlusStatus({
      ...base, seamMeasured: true, integrityFailed: true,
      seamWorstBandP95Px: 0.25, seamBandSelfScored: true,
    });
    expect(panoPlusHudLine(cut)).toContain('CUTS p95 0.25⚠fit');
  });

  it('goes red mid-sweep when the engine says the seams are cut', () => {
    const st = coercePanoPlusStatus({
      ...base, seamMeasured: true, integrityFailed: true,
      seamWorstBandP95Px: 1.75, maxAreaScale: 13.02,
    });
    expect(panoPlusHudLine(st)).toContain('CUTS p95 1.75');
    // ...and the warping number surfaces at the same time. 13.0x is the
    // operator's own 15-59-29 pack.
    expect(panoPlusHudLine(st)).toContain('WARP 13.0×');
  });

  it('says NOTHING IS MEASURED rather than showing a reassuring zero', () => {
    const st = coercePanoPlusStatus({ ...base, seamMeasured: false });
    expect(panoPlusHudLine(st)).toContain('seam ?');
    expect(panoPlusHudLine(st)).not.toContain('seam 0.00');
  });
});

// ── v8: THE BANDING, MADE CHECKABLE ────────────────────────────────────────
//
// WHY THIS BLOCK EXISTS, verbatim from the operator on 2026-08-23: "I am not
// sure I see the banding issue you are talking about." The v6 measurement that
// found the banding was sound (unlocked AE brightening 50-79% end to end; the
// compensator removing only 24-29%), so the answer is not to argue with him and
// not to rip the lock out — it is to make the next capture SETTLE it.
//
// Two things were missing from what he can read. (1) The verdict's max clause
// is a MAX: one anomalous boundary out of six hundred fires it exactly as
// loudly as an end-to-end band, and neither the HUD nor the pack said which he
// was looking at. (2) The uniformity CROSS-CHECK — the same percentiles over
// the DC-like boundaries alone — existed in the engine and never reached the
// app, so "this gate is not firing on scene structure" was a claim in a design
// doc rather than a number in his hand.
describe('v8 — the banding verdict states its own support', () => {
  const base = {
    running: true,
    framesSeen: 400, painted: 380, paintedWidthPx: 1340, advancePx: 4.1,
    stripPx: 6.2, heldBacktrack: 0, heldFrontier: 0, rejectedLowResponse: 0,
    rejectedOutOfCage: 0, rejectedPoseSpeed: 0, rejectedRectify: 0,
    rejectedTracking: 0, clippedFrames: 0, limitedFrames: 0, axisLatched: true,
    axis: 0, sweepSign: 1, engineMs: 0.8, previewSeq: 3, seamMeasured: true,
  };

  it('carries the breached-boundary count off the wire', () => {
    const st = coercePanoPlusStatus({
      ...base, seamPhotoStepOverBar: 12, seamPhotoSamples: 431,
    });
    expect(st).not.toBeNull();
    expect(st!.seamPhotoStepOverBar).toBe(12);
    expect(st!.seamPhotoSamples).toBe(431);
    // An older binary sends neither, and 0/0 has to read as "no support
    // reported" — never as "nothing breached".
    const old = coercePanoPlusStatus({ ...base });
    expect(old!.seamPhotoStepOverBar).toBe(0);
    expect(old!.seamPhotoSamples).toBe(0);
  });

  it('puts the support next to the word BAND on the HUD', () => {
    const st = coercePanoPlusStatus({
      ...base, photoDriftLocalPct: 14.7,
      seamPhotoStepOverBar: 12, seamPhotoSamples: 431,
    });
    const line = panoPlusHudLine(st);
    expect(line).toContain('BAND 15%');
    // THE POINT: 12 of 431 and 200 of 431 must not read identically.
    expect(line).toContain('12/431');
  });

  it('does not invent a support figure when the binary did not send one', () => {
    const st = coercePanoPlusStatus({ ...base, photoDriftLocalPct: 14.7 });
    const line = panoPlusHudLine(st);
    expect(line).toContain('BAND 15%');
    // NOT a bare `not.toContain('0/0')` — the hold chip legitimately reads
    // `hold 0/0`, and an assertion that cannot tell those apart would go green
    // for the wrong reason the moment the hold counts were non-zero.
    expect(line).not.toMatch(/BAND 15% \d/);
  });

  it('quotes the uniform-only cross-check in the banding sentence', () => {
    const v = panoPlusIntegrity(coercePanoPlusSummary({
      counts: { seen: 400, painted: 380 },
      canvas: { paintedW: 1340, outputW: 1340, outputH: 1471 },
      seam: {
        measured: true, boundaries: 380, coverageFrac: 1,
        canvasJogSamples: 380, canvasJogP95Px: 0.31,
        photoSamples: 431, photoStepP50DN: 0.21, photoStepP95DN: 2.09,
        photoStepMaxDN: 4.68, photoStepOverBar: 12,
        photoNonUniform: 37, photoUniformUnknown: 4,
        photoUniStepP95DN: 1.57, photoUniStepMaxDN: 3.2, photoUniSamples: 390,
        photoDriftLocalPct: 14.7, photoDriftTotalPct: 18.3,
        photoDriftWorstU: 512,
      },
    }));
    expect(v.hasBanding).toBe(true);
    const line = v.bandLine ?? '';
    // The support...
    expect(line).toContain('12 of 431');
    // ...and the answer to "is this scene structure?", from the pack.
    expect(line).toContain('1.57');
    expect(line).toContain('390');
  });

  it('says the walk out loud in the residual lines, with its scope', () => {
    const summary = coercePanoPlusSummary({
      counts: { seen: 400, painted: 380 },
      canvas: { paintedW: 1340, outputW: 1340, outputH: 1471 },
      seam: {
        measured: true, boundaries: 380, coverageFrac: 1,
        canvasJogSamples: 380, canvasJogP95Px: 0.31,
        jogDriftPx: 4.82, jogDriftEndPx: -3.1, jogDriftSamples: 380,
      },
    });
    expect(summary.seam.jogDriftPx).toBeCloseTo(4.82, 5);
    const lines = panoPlusResidualLines(summary, { rectify: true, gainMatch: true });
    const walk = lines.find((l) => l.includes('4.8'));
    expect(walk).toBeDefined();
    // NEVER quotable as the wobble number without its caveat travelling with it.
    expect(walk).toMatch(/not the wobble number/i);
  });

  it('marks the band metric as the chain’s own fit when it is', () => {
    const v = panoPlusIntegrity(coercePanoPlusSummary({
      counts: { seen: 400, painted: 380 },
      canvas: { paintedW: 1340, outputW: 1340, outputH: 1471 },
      seam: {
        measured: true, boundaries: 380, coverageFrac: 1,
        worstBandP95Px: 0.25, worstBandMaxPx: 0.5,
        canvasJogSamples: 380, canvasJogP95Px: 1.03, canvasJogMaxPx: 1.33,
        photoSamples: 380, bandSelfScored: true,
      },
    }));
    // 0.25 px looks like the cleanest seam this engine has ever produced. It
    // is the residual of the fit that produced it, and on the operator's own
    // packs the INDEPENDENT instrument got 3.3x worse in the same arm.
    expect(v.seamLine).toMatch(/own fit/i);
    expect(v.seamLine).toContain('1.03');
  });
});

// ── THE LIVE PREVIEW'S GEOMETRY ────────────────────────────────────────────
//
// WHY THIS BLOCK EXISTS, verbatim from the operator on 2026-08-23: "I do not
// see a live preview of the image growing as I take the capture". The engine
// was rendering one every 250 ms the whole time (meta.json previewMs, n=138 on
// pack 15-57-16). What he could not see was the RESULT of two hard-coded
// landscape assumptions stacked on each other:
//
//   · native fitted the preview into a 1400x220 ORIENTED box, and his sweeps
//     are VERTICAL (axis 1, 1344x1471 output — he pans top to bottom holding
//     the phone in landscape), so the fit collapsed to 220/1471 = 0.15 and
//     produced a 201x220 JPEG of a 1344-px-wide shelf;
//   · the surface then drew that into a fixed strip 120 pt tall spanning the
//     screen, `contain` — 108x120 pt of image in an 828 pt-wide dark band,
//     SHRINKING as the sweep grew.
//
// Both halves are fixed. This suite pins the JS half: the box is derived from
// the panorama's own shape, and a tall panorama gets a portrait panel.
describe('the live preview geometry', () => {
  /** The operator's own pack: 1344x1471, a vertical sweep. */
  const tall = statusFixture({
    axis: 1,
    axisLatched: true,
    paintedWidthPx: 1471,   // internal: ALONG the sweep
    canvasHeightPx: 1344,   // internal: ACROSS it
    previewW: 360,
    previewH: 394,
  });
  /** A left-to-right sweep on the same rack. */
  const wide = statusFixture({
    axis: 0,
    axisLatched: true,
    paintedWidthPx: 3400,
    canvasHeightPx: 796,
    previewW: 1400,
    previewH: 328,
  });
  /**
   * THE OPERATOR'S ACTUAL WINDOW.
   *
   * a portrait-locked host's Info.plist lists `UIInterfaceOrientationPortrait` and
   * nothing else for iPhone, there is no `supportedInterfaceOrientations`
   * override in `AppDelegate.swift`, and no orientation-locker package is
   * installed — so RN reports PORTRAIT dimensions however the phone is held.
   * The stitcher's own `useDeviceOrientation` documents exactly this case.
   *
   * The previous fixture here was `{ width: 844, height: 390 }`, commented "a
   * landscape phone, which is the only orientation pano+ runs in". That window
   * shape is unreachable on this host, and sizing the panel against it is what
   * made the "fix" measure 3.7x in a test and 1.2x on the phone.
   */
  const screen = {
    width: 390,
    height: 844,
    insets: { top: 59, bottom: 34, left: 0, right: 0 },
  };
  /** A host that is NOT portrait-locked, kept as the second regime. */
  const unlocked = {
    width: 844,
    height: 390,
    insets: { top: 0, left: 59, right: 0, bottom: 21 },
  };

  it('takes the aspect from the published preview when native reports it', () => {
    expect(panoPlusPreviewAspect(tall)).toBeCloseTo(360 / 394, 5);
    expect(panoPlusPreviewAspect(wide)).toBeCloseTo(1400 / 328, 5);
  });

  // THE DE-RISKING CLAUSE. `previewW/H` are new in this engine build; the fix
  // must still place a tall panorama correctly on a binary that does not send
  // them, because the whole point is that the operator can test TODAY.
  it('falls back to the ORIENTED canvas dims when the binary predates previewW/H', () => {
    const noDims = statusFixture({
      axis: 1, paintedWidthPx: 1471, canvasHeightPx: 1344,
      previewW: 0, previewH: 0,
    });
    // A vertical sweep is transposed on the way out, so the oriented aspect is
    // cross ÷ along — under 1, i.e. TALL in pixels. Reading it as along ÷
    // cross (the internal canvas) would flip the placement. On the
    // portrait-locked framebuffer a pixel-tall panorama is WIDE (the quarter
    // turn), so it takes the band — the same answer `tall` gets below.
    expect(panoPlusPreviewAspect(noDims)).toBeCloseTo(1344 / 1471, 5);
    expect(panoPlusPreviewLayout(noDims, screen, 'landscape-left').placement)
      .toBe(panoPlusPreviewLayout(tall, screen, 'landscape-left').placement);
  });

  // ── THE STRIP MUST NOT WALK WHILE IT GROWS ──────────────────────────────
  //
  // Field report, iPhone, 2026-09-19: "Once I start the sweep, everything
  // drifts downward!"
  //
  // The ALONG axis was pinned in 2026-09-03 with the note "a centred image in
  // a fixed strip would still drift as it grew" — correct, and applied to one
  // axis. The CROSS axis is the one that actually shrinks: the along extent
  // saturates at `inner`'s long side early, and after that a `contain` fit can
  // only hold the aspect by THINNING the cross extent. Centred, that moves
  // every publish; and the rotation container turns pre-rotation `left` into a
  // screen-VERTICAL offset, which is why it read as downward drift.
  it('⚑ the cross anchor does not move across a whole growing sweep', () => {
    // A horizontal sweep on a portrait host: axis 1, transposed on the way
    // out, so the oriented aspect is cross ÷ along and falls as it grows.
    const at = (alongPx: number) => panoPlusPreviewLayout(
      statusFixture({
        axis: 1, axisLatched: true, sweepSign: 1,
        paintedWidthPx: alongPx, canvasHeightPx: 1080,
        previewW: 0, previewH: 0,
      }),
      screen,
      'landscape-left',
    );
    const series = [1440, 3000, 6000, 9000, 14000, 20000].map(at);

    // FIRST: the case is not vacuous — the strip really does thin, which is
    // the whole reason a centred anchor moved. If a future change makes the
    // cross extent constant this assertion fails and the test is retired
    // deliberately rather than passing for a reason that stopped existing.
    const cross = series.map((l) => l.content.width);
    expect(cross[cross.length - 1]).toBeLessThan(cross[0] - 10);

    // THEN: the anchor is nailed down anyway.
    for (const l of series) expect(l.anchor.left).toBe(0);
  });

  it('⚑ …and the ALONG anchor still tracks the sweep sign', () => {
    // The cross pin must not flatten the along pin it sits next to: a
    // negative sweep mirrors the along axis, so the START edge is the other
    // end and the growing edge must not be welded to the strip.
    const at = (sign: 1 | -1) => panoPlusPreviewLayout(
      statusFixture({
        axis: 1, axisLatched: true, sweepSign: sign,
        paintedWidthPx: 3000, canvasHeightPx: 1080,
        previewW: 0, previewH: 0,
      }),
      screen,
      'landscape-left',
    );
    expect(at(1).anchor.top).toBe(0);
    expect(at(-1).anchor.top).toBeGreaterThan(0);
  });

  it('is neutral before anything is painted, and never NaN', () => {
    expect(panoPlusPreviewAspect(null)).toBe(PANO_PLUS_DEFAULT_PREVIEW_ASPECT);
    const fresh = statusFixture({
      painted: 0, paintedWidthPx: 0, canvasHeightPx: 0, previewW: 0, previewH: 0,
    });
    expect(panoPlusPreviewAspect(fresh)).toBe(PANO_PLUS_DEFAULT_PREVIEW_ASPECT);
    const l = panoPlusPreviewLayout(fresh, screen, 'landscape-left');
    expect(Number.isFinite(l.frame.width)).toBe(true);
    expect(Number.isFinite(l.frame.height)).toBe(true);
    expect(Number.isFinite(l.content.width)).toBe(true);
  });

  // ── THE TWO ROTATIONS, WHICH ARE NOT THE SAME NUMBER ───────────────────
  //
  // A reviewer proposed reusing the stitcher's `bandThumbRotation` for the
  // panorama: +90 in landscape-left, -90 in landscape-right. That is the right
  // model for FRAMEBUFFER-authored chrome and the WRONG one for the panorama,
  // and being wrong costs 180° — the operator would see it upside down in one
  // of the two holds instead of sideways in both. These pin the distinction.
  describe('the two rotations', () => {
    it('turns the pill GLYPHS with the hold — and nothing else', () => {
      // The stitcher's `contentRotationDeg` truth table, which Pano applies to
      // the `<Text>` inside its lens chip and AR pill and to nothing that lays
      // out a box. pano+ applies it to the same two pills, since 2026-09-03,
      // and no longer to any block.
      expect(panoPlusGlyphRotationDeg(false, 'landscape-left')).toBe(90);
      expect(panoPlusGlyphRotationDeg(false, 'landscape-right')).toBe(-90);
      expect(panoPlusGlyphRotationDeg(false, 'portrait')).toBe(0);
      expect(panoPlusGlyphRotationDeg(false, 'portrait-upside-down')).toBe(180);
      // A non-locked host: the OS already turned the framebuffer, so a glyph
      // needs nothing.
      expect(panoPlusGlyphRotationDeg(true, 'landscape-left')).toBe(0);
      expect(panoPlusGlyphRotationDeg(true, 'landscape-right')).toBe(0);
    });

    it('turns the SENSOR-REFERENCED panorama by a constant on a locked host', () => {
      // The sensor and the screen are both bolted to the phone, so the turn
      // between them does not depend on how the phone is held — which is why a
      // camera preview looks upright to you in any hold while the buttons
      // around it read sideways.
      for (const o of
        ['landscape-left', 'landscape-right', 'portrait', 'portrait-upside-down'] as const) {
        expect(panoPlusImageRotationDeg(false, o)).toBe(90);
      }
      // On a NON-locked host the OS did part of the turn already.
      expect(panoPlusImageRotationDeg(true, 'landscape-left')).toBe(0);
      expect(panoPlusImageRotationDeg(true, 'landscape-right')).toBe(180);
    });

    // ── v14: THE UPRIGHT BAKE ────────────────────────────────────────────
    //
    // Operator, 2026-09-02: "the output image is sideways". His own packs from
    // that day: four `hold: 'landscape'` sweeps upright, one `hold: 'portrait'`
    // sweep a quarter turn over. The deliverable and the live preview leave the
    // engine in the SAME (camera raster) frame; the preview looked right only
    // because this file turns it on screen. A JPEG has no screen behind it, so
    // the same turn has to be BAKED — and these tests pin that it is the SAME
    // turn, because the day the two disagree one of them is wrong.
    it('bakes the deliverable turn the display path already performs', () => {
      // THE IDENTITY. `panoPlusImageRotationDeg - panoPlusGlyphRotationDeg` is
      // how a sensor direction reaches the operator's eye (the derivation that
      // pinned panoPlusSweepDirection's sign). The deliverable has to arrive at
      // the same place with no screen to help it.
      for (const jsLandscape of [false, true]) {
        for (const o of
          ['portrait', 'portrait-upside-down',
           'landscape-left', 'landscape-right'] as const) {
          const viaScreen =
            panoPlusImageRotationDeg(jsLandscape, o)
            - panoPlusGlyphRotationDeg(jsLandscape, o);
          const baked = panoPlusUprightRotationDeg(o);
          // Compared modulo 360: the screen chain is normalised to (-180, 180]
          // and the bake to [0, 360) — deliberately, because the engine refuses
          // a negative. Same angle, different spelling.
          expect(((viaScreen % 360) + 360) % 360).toBe(baked);
        }
      }
    });

    it('is INVARIANT to whether the host is orientation-locked', () => {
      // The same check that settled the sign of panoPlusSweepDirection: the
      // bake is a physical fact about a phone and a shelf, so a portrait-locked
      // host and an unlocked one must agree. They do because both `fbRot` terms
      // cancel in the identity above. A `+` instead of a `-` would make the two
      // hosts disagree by a half turn.
      for (const o of
        ['portrait', 'portrait-upside-down',
         'landscape-left', 'landscape-right'] as const) {
        const locked =
          panoPlusImageRotationDeg(false, o) - panoPlusGlyphRotationDeg(false, o);
        const unlockedTurn =
          panoPlusImageRotationDeg(true, o) - panoPlusGlyphRotationDeg(true, o);
        expect(((locked % 360) + 360) % 360)
          .toBe(((unlockedTurn % 360) + 360) % 360);
      }
    });

    it('gives every hold its own quarter turn, and only the right one', () => {
      // The table, and it is verified at both ends: `portrait` is the pack that
      // came out sideways (22-56-36) and rotating its canvas 90 CW makes it
      // plumb; `landscape-left` is the pack that was already upright
      // (22-50-04), which is why 0 has to stay 0 or the fix breaks what worked.
      expect(panoPlusUprightRotationDeg('portrait')).toBe(90);
      expect(panoPlusUprightRotationDeg('landscape-left')).toBe(0);
      expect(panoPlusUprightRotationDeg('landscape-right')).toBe(180);
      expect(panoPlusUprightRotationDeg('portrait-upside-down')).toBe(270);
      // Never negative and never 360: the engine refuses anything outside
      // {0, 90, 180, 270} by name at configure time.
      for (const o of
        ['portrait', 'portrait-upside-down',
         'landscape-left', 'landscape-right'] as const) {
        expect([0, 90, 180, 270]).toContain(panoPlusUprightRotationDeg(o));
      }
    });

    it('separates the two landscape holds, which `hold` cannot', () => {
      // `panoPlusHoldOf` collapses them into one name, and they are a HALF TURN
      // apart. This is the one place that distinction is load-bearing, and the
      // reason the surface sends `orientation` and not `hold`.
      expect(panoPlusHoldOf('landscape-left')).toBe(panoPlusHoldOf('landscape-right'));
      expect(panoPlusUprightRotationDeg('landscape-left'))
        .not.toBe(panoPlusUprightRotationDeg('landscape-right'));
    });

    it('tracks the sensor constant rather than hard-coding 90', () => {
      // Android's `SENSOR_ORIENTATION` is 90 on the A35 and on every phone this
      // ships to, but it is not a law — `PanoPlusLiveModule.correctUprightRotation`
      // re-derives against the device's real value, and this is the arithmetic
      // it relies on.
      expect(PANO_PLUS_SENSOR_ORIENTATION_CW_DEG).toBe(90);
      expect(panoPlusUprightRotationDeg('portrait', 270)).toBe(270);
      expect(panoPlusUprightRotationDeg('landscape-left', 270)).toBe(180);
      expect(panoPlusUprightRotationDeg('portrait', 0)).toBe(0);
      expect(panoPlusUprightRotationDeg('landscape-right', 0)).toBe(90);
    });

    it('carries the panorama rotation into the layout, both holds alike', () => {
      expect(panoPlusPreviewLayout(tall, screen, 'landscape-left').imageRotateDeg)
        .toBe(90);
      expect(panoPlusPreviewLayout(tall, screen, 'landscape-right').imageRotateDeg)
        .toBe(90);
      expect(panoPlusPreviewLayout(tall, unlocked, 'landscape-left').imageRotateDeg)
        .toBe(0);
    });
  });

  it('gives a pixel-TALL panorama a FIXED band, and never moves it', () => {
    // 2026-09-03: the fit is in the FRAMEBUFFER (the chrome does not turn,
    // Pano's does not). The operator's vertical sweep is tall in pixels, a
    // quarter turn makes it WIDE on the portrait-locked framebuffer, so it
    // takes the band — which, with the phone held landscape-left, is the strip
    // down one side of the world, next to Pano's shutter.
    const l = panoPlusPreviewLayout(tall, screen, 'landscape-left');
    expect(l.placement).toBe('band');
    // `aspect` is still the FRAMEBUFFER shape of the PANORAMA: the pixel
    // aspect's transpose. It no longer sizes anything — it is reported.
    expect(l.aspect).toBeCloseTo(394 / 360, 3);

    // THE CAPSULE IS THE SLIT-SCAN BAND'S, to the point.
    // `PanoramaBandOverlay.tsx:139` BAND_THICKNESS = 64.
    expect(l.frame.height).toBe(64);
    expect(l.frame.width).toBe(342);      // 374 usable − 2 × 16 margin
    // BOTTOM-pinned, above whatever bottom chrome the window reserves — which
    // is where the stitcher docks its band. This fixture passes no
    // `bottomChromePt`, so `usableBox` falls back to `insets.bottom + 96` =
    // 130; the surface passes Pano's real 240 and the capsule rides up with
    // it, which the `bottomChromePt` case below pins.
    expect(l.frame.top + l.frame.height).toBe(844 - 130 - 8);
    expect(
      panoPlusPreviewLayout(tall, { ...screen, bottomChromePt: 240 },
        'landscape-left').frame.top,
    ).toBe(844 - 240 - 8 - 64);
    // ...and SMALL, which is the complaint being answered. The old band
    // reached 374x240 = 89 760 pt², 27% of a 390x844 screen.
    expect(l.frame.width * l.frame.height / (390 * 844)).toBeLessThan(0.08);

    // ── THE FRAME DOES NOT MOVE. The whole of defect #3. ──────────────────
    // Frame 1 through a 4 m sweep: same box, four times over.
    const grown = [
      [718, 718], [718, 1000], [718, 2000], [718, 4000],
    ].map(([w, h]) => panoPlusPreviewLayout(
      statusFixture({ axis: 1, axisLatched: true, previewW: w, previewH: h }),
      screen, 'landscape-left',
    ));
    for (const g of grown) expect(g.frame).toEqual(l.frame);
    // ...and the IMAGE inside it grows, monotonically, along one axis only.
    for (let i = 1; i < grown.length; i += 1) {
      expect(grown[i].content.height)
        .toBeGreaterThanOrEqual(grown[i - 1].content.height);
      expect(grown[i].content.width)
        .toBeLessThanOrEqual(grown[i - 1].content.width);
    }
    // Inside the window, clear of the notch and of Pano's controls.
    expect(l.frame.left).toBeGreaterThanOrEqual(0);
    expect(l.frame.top).toBeGreaterThanOrEqual(0);
    expect(l.frame.left + l.frame.width).toBeLessThanOrEqual(screen.width - 8);
  });

  // THE OTHER HALF OF #3: the image is pinned at the sweep's START edge, so it
  // grows out of one fixed end instead of re-centring under the operator —
  // "This is creating the issue of not knowing where the pano starts".
  it('pins the panorama at the sweep’s start edge and centres it across', () => {
    for (const [w, h] of [[718, 718], [718, 1400], [718, 3000]]) {
      const l = panoPlusPreviewLayout(
        statusFixture({ axis: 1, axisLatched: true, previewW: w, previewH: h }),
        screen, 'landscape-left',
      );
      // axis 1 under a quarter turn ⇒ band ⇒ the strip's long axis is the
      // JPEG's pixel-Y, so along-min is `top` and it is pinned at 0.
      expect(l.anchor.top).toBe(0);
      expect(l.anchor.left)
        .toBeCloseTo((l.inner.width - l.content.width) / 2, 6);
      // ...and the image never escapes the capsule's padded interior.
      expect(l.content.width).toBeLessThanOrEqual(l.inner.width + 1e-9);
      expect(l.content.height).toBeLessThanOrEqual(l.inner.height + 1e-9);
    }
  });

  // 2026-09-04: THE OTHER HALF OF "WHERE DOES THE PANO START".
  //
  // `statusFixture` defaults `sweepSign: 1`, so the test above only ever
  // exercised one of the two directions — and the layout pinned along-MIN
  // unconditionally, which is wrong for the other one. The engine mirrors the
  // along axis for a negative sign (`Engine::orient`, rnis_pano.cpp:2333-2341)
  // and its own test says so: rnis_pano_test.cpp:2764-2767 asserts the frontier
  // — the GROWING edge — reports 1.0 for sign +1 and 0.0 for sign −1. So the
  // START is at along-MAX on a reversed sweep, and pinning along-MIN welds the
  // leading edge to the strip and slides the start away across it.
  //
  // It is in the operator's own data: the 2026-08-31T18-28-10 pack records
  // axis 1, sweepSign −1, 366 strips.
  it('pins the START edge for BOTH sweep signs, not just the +1 one', () => {
    for (const [w, h] of [[718, 1400], [718, 3000]]) {
      const base = { axis: 1, axisLatched: true, previewW: w, previewH: h };
      const fwd = panoPlusPreviewLayout(
        statusFixture({ ...base, sweepSign: 1 }), screen, 'landscape-left');
      const rev = panoPlusPreviewLayout(
        statusFixture({ ...base, sweepSign: -1 }), screen, 'landscape-left');

      // Same capsule, same fitted content — ONLY the end it hangs from moves.
      expect(rev.frame).toEqual(fwd.frame);
      expect(rev.content).toEqual(fwd.content);
      expect(rev.anchor.left).toBeCloseTo(fwd.anchor.left, 6);

      expect(fwd.anchor.top).toBe(0);
      expect(rev.anchor.top).toBeCloseTo(rev.inner.height - rev.content.height, 6);
      // And the reversed one is genuinely a DIFFERENT place — a fixture whose
      // content happened to fill the strip would make this vacuous.
      expect(rev.anchor.top).toBeGreaterThan(0);
      expect(rev.content.height).toBeLessThanOrEqual(rev.inner.height + 1e-9);
    }
  });

  // Pre-latch the sign is not yet real (it coerces to +1 and the engine has
  // cast no vote), so the seed keeps the along-MIN end. Without this, a future
  // reader could "fix" the sign handling to apply before the latch and move
  // the bootstrap frame for no reason.
  it('ignores the sweep sign until the axis has latched', () => {
    const seed = statusFixture({
      axisLatched: false, axis: 0, sweepSign: -1, previewW: 1920, previewH: 1080,
    });
    const l = panoPlusPreviewLayout(seed, screen, 'landscape-left');
    expect(l.anchor.top).toBe(0);
  });

  // ── THE AXIS-0 FLIP IS KNOWN, ACCEPTED, AND PINNED HERE ────────────────────
  //
  // Pre-latch the placement is the BAND unconditionally; an axis-0 latch moves
  // it to the COLUMN, and the capsule jumps across the screen once, at the
  // latch. That flip is deliberate — a horizontal capsule holding a vertical
  // panorama is the 2026-08-23 sliver bug — but the pre-latch seed (2026-09-03)
  // now puts a live picture in the box before the jump, so the operator watches
  // an image move rather than an empty placeholder.
  //
  // It does NOT affect the reported defect: all ten of the operator's packs
  // latch axis 1, which is the band on both sides of the latch. This test
  // exists so the flip stays a CHOICE — if a future change removes it, or a
  // pre-latch placement heuristic lands, this fails and the reasoning above
  // gets re-read rather than silently invalidated. Flagged to the operator
  // 2026-09-04 as an open item, not fixed.
  it('flips band→column ONCE on an axis-0 latch, and not at all on axis 1', () => {
    const seed = panoPlusPreviewLayout(
      statusFixture({ axisLatched: false, axis: 0, previewW: 1920, previewH: 1080 }),
      screen, 'landscape-left');
    expect(seed.placement).toBe('band');

    const latched1 = panoPlusPreviewLayout(
      statusFixture({ axisLatched: true, axis: 1, previewW: 718, previewH: 3000 }),
      screen, 'landscape-left');
    // THE FIELD CASE: no move at all across the latch.
    expect(latched1.placement).toBe('band');
    expect(latched1.frame).toEqual(seed.frame);

    const latched0 = panoPlusPreviewLayout(
      statusFixture({ axisLatched: true, axis: 0, previewW: 3000, previewH: 718 }),
      screen, 'landscape-left');
    expect(latched0.placement).toBe('panel');
    expect(latched0.frame).not.toEqual(seed.frame);
  });

  // THE PADDING IS THE STITCHER'S, and `inner` is the frame's padded interior
  // transposed — the identity the render's rotation container depends on.
  it('builds `inner` as the frame’s padded interior, transposed on a quarter turn', () => {
    for (const o of ['landscape-left', 'portrait'] as const) {
      const l = panoPlusPreviewLayout(tall, screen, o);
      const quarter = l.imageRotateDeg === 90 || l.imageRotateDeg === -90;
      // `PanoramaBandOverlay.tsx:138` BAND_PADDING = 6, all four sides.
      expect(quarter ? l.inner.height : l.inner.width)
        .toBe(l.frame.width - 12);
      expect(quarter ? l.inner.width : l.inner.height)
        .toBe(l.frame.height - 12);
    }
  });

  it('keeps the HUD clear of the panel in EVERY hold and both regimes', () => {
    const cases = [
      panoPlusPreviewLayout(tall, screen, 'landscape-left'),
      panoPlusPreviewLayout(tall, screen, 'landscape-right'),
      panoPlusPreviewLayout(tall, screen, 'portrait'),
      panoPlusPreviewLayout(wide, screen, 'landscape-left'),
      panoPlusPreviewLayout(wide, screen, 'landscape-right'),
      panoPlusPreviewLayout(tall, unlocked, 'landscape-left'),
      panoPlusPreviewLayout(wide, unlocked, 'landscape-left'),
      // A window small enough that the panel can fill the usable box outright
      // — the degenerate case where there is no leftover to put the HUD in.
      panoPlusPreviewLayout(tall, { width: 320, height: 480 }, 'landscape-left'),
      panoPlusPreviewLayout(tall, { width: 240, height: 320 }, 'landscape-right'),
    ];
    for (const l of cases) {
      const a = l.frame;
      const b = l.hud;
      const overlaps =
        a.left < b.left + b.width && b.left < a.left + a.width
        && a.top < b.top + b.height && b.top < a.top + a.height;
      expect(overlaps).toBe(false);
      expect(b.width).toBeGreaterThan(60);
      expect(b.height).toBeGreaterThan(40);
      // No transposed inner box any more: the HUD is laid out in `hud` itself.
      expect('hudContent' in l).toBe(false);
      expect('chromeRotateDeg' in l).toBe(false);
    }
  });

  it('gives a pixel-WIDE panorama the column down the framebuffer side', () => {
    // The mirror of the case above: wide in pixels ⇒ TALL on the locked
    // framebuffer ⇒ the column, which in the landscape hold is the band across
    // the top of what the operator sees. Same 64 pt thickness — the stitcher's
    // `vertical` branch is the same capsule stood on end
    // (`PanoramaBandOverlay.tsx:289-295`).
    const l = panoPlusPreviewLayout(wide, screen, 'landscape-left');
    expect(l.placement).toBe('panel');
    expect(l.frame.width).toBe(64);
    expect(l.frame.height).toBeGreaterThan(l.frame.width);
    // The image inside is the wide one, and it keeps the panorama's aspect.
    expect(l.content.width).toBeGreaterThan(l.content.height);
    expect(l.content.width / l.content.height).toBeCloseTo(1400 / 328, 1);
    // ...and on a COLUMN the strip's long axis is the JPEG's pixel-X, so the
    // anchor flips to `left` — the mirror of the band's `top`.
    expect(l.anchor.left).toBe(0);
  });

  // PLACEMENT FOLLOWS THE LATCHED AXIS, and this is the reason: a horizontal
  // sweep is nearly SQUARE for its first second (one frame's footprint) and
  // only becomes a band as it grows. Choosing on aspect alone would open it as
  // a side panel and snap it into a band a moment later, in the middle of the
  // gesture the operator is concentrating on.
  it('keeps a young sweep on the placement its AXIS will grow into', () => {
    // axis 0 is pixel-wide ⇒ tall on the locked framebuffer ⇒ the column, from
    // the first near-square frame on — the placement must not snap mid-sweep.
    const young = statusFixture({
      axis: 0, axisLatched: true, previewW: 1200, previewH: 1000,
    });
    expect(panoPlusPreviewLayout(young, screen, 'landscape-left').placement)
      .toBe('panel');
    // ⚠ BEFORE THE LATCH IT IS ALWAYS THE BAND NOW (2026-09-03). The old rule
    // compared the two candidates' AREAS with a 1.25 bias; both candidates are
    // constants now, so that comparison has nothing left to weigh — and it was
    // the second half of the operator's "this is funny!": a near-square
    // bootstrap publish scored `band` and an axis-0 latch then teleported the
    // box 157 pt into the panel. Band is also what the field asks for: all
    // five of his 2026-09-01 packs latch `axis === 1`.
    for (const [w, h] of [[1200, 1000], [2400, 900], [900, 2400], [718, 718]]) {
      expect(
        panoPlusPreviewLayout(
          statusFixture({ axisLatched: false, previewW: w, previewH: h }),
          screen, 'landscape-left',
        ).placement,
      ).toBe('band');
    }
  });

  it('never flips a vertical sweep out of its band as it grows', () => {
    // Frame 1 (near-square) through the operator's finished 1344x1471: the
    // placement must not change under him, in either hold.
    for (const o of ['landscape-left', 'landscape-right'] as const) {
      for (const [w, h] of [[1344, 1400], [1344, 1471], [1344, 2600]]) {
        const l = panoPlusPreviewLayout(
          statusFixture({ axis: 1, axisLatched: true, previewW: w, previewH: h }),
          screen,
          o,
        );
        expect(l.placement).toBe('band');
      }
    }
  });

  // THE SENSOR HOUSING IS A BAR DOWN ONE EDGE, and the panel lives at an edge.
  // A panel that loses its middle third behind the Dynamic Island is what the
  // operator would report as still not seeing the preview.
  it('keeps the capsule clear of the sensor housing', () => {
    const l = panoPlusPreviewLayout(tall, screen, 'landscape-left');
    // On a portrait-locked window the housing inset is `top` (59) — which is a
    // SIDE edge to the operator, and the mapping has to honour it there.
    expect(l.frame.top).toBeGreaterThanOrEqual(0);
    expect(l.frame.left + l.frame.width).toBeLessThanOrEqual(screen.width - 8);

    // On a NON-locked host the housing is a side inset (59 on the left), and
    // the capsule must start clear of it.
    const withSideHousing = panoPlusPreviewLayout(tall, unlocked, 'landscape-left');
    expect(withSideHousing.frame.left).toBeGreaterThanOrEqual(59);
    expect(withSideHousing.frame.left + withSideHousing.frame.width)
      .toBeLessThanOrEqual(unlocked.width);
    expect(withSideHousing.frame.top).toBeGreaterThanOrEqual(0);
    expect(withSideHousing.frame.top + withSideHousing.frame.height)
      .toBeLessThanOrEqual(unlocked.height);
  });

  it('is unchanged when the host has no SafeAreaProvider (insets absent)', () => {
    const a = panoPlusPreviewLayout(
      tall, { width: screen.width, height: screen.height }, 'landscape-left');
    const b = panoPlusPreviewLayout(
      tall, { width: screen.width, height: screen.height, insets: {} },
      'landscape-left');
    expect(b).toEqual(a);
  });

  // THE MAPPING IS INVERTIBLE, pinned end to end rather than by inspecting the
  // two matrices: the same panorama placed under every hold must come back
  // inside the window with the aspect the operator sees unchanged.
  it('round-trips every hold back inside the window', () => {
    for (const o of
      ['landscape-left', 'landscape-right', 'portrait', 'portrait-upside-down'] as const) {
      for (const scr of [screen, unlocked]) {
        const l = panoPlusPreviewLayout(tall, scr, o);
        expect(l.frame.left).toBeGreaterThanOrEqual(0);
        expect(l.frame.top).toBeGreaterThanOrEqual(0);
        expect(l.frame.left + l.frame.width).toBeLessThanOrEqual(scr.width);
        expect(l.frame.top + l.frame.height).toBeLessThanOrEqual(scr.height);
        expect(l.aspect).toBeGreaterThan(0);
        // `inner` rotated by `imageRotateDeg` is exactly the frame's PADDED
        // interior — the identity the render's rotation container relies on.
        const quarter = l.imageRotateDeg === 90 || l.imageRotateDeg === -90;
        expect(quarter ? l.inner.height : l.inner.width)
          .toBe(l.frame.width - 12);
        expect(quarter ? l.inner.width : l.inner.height)
          .toBe(l.frame.height - 12);
        // ...and the image never leaves it.
        expect(l.anchor.left).toBeGreaterThanOrEqual(0);
        expect(l.anchor.top).toBeGreaterThanOrEqual(0);
        expect(l.anchor.left + l.content.width)
          .toBeLessThanOrEqual(l.inner.width + 1e-9);
        expect(l.anchor.top + l.content.height)
          .toBeLessThanOrEqual(l.inner.height + 1e-9);
      }
    }
  });

  // THE REGRESSION GUARD FOR THE OTHER REGIME. If this host is ever unlocked,
  // the layout must not silently become the portrait-locked one.
  it('reproduces the plain landscape geometry on a non-locked host', () => {
    const l = panoPlusPreviewLayout(tall, unlocked, 'landscape-left');
    expect(l.imageRotateDeg).toBe(0);
    expect(l.placement).toBe('panel');
    expect(l.frame.width).toBe(64);
    expect(l.frame.height).toBeGreaterThan(l.frame.width);
    // No quarter turn ⇒ `inner` is the padded interior untransposed.
    expect(l.inner).toEqual({
      width: l.frame.width - 12, height: l.frame.height - 12,
    });
  });

  // The cache-bust half — unchanged mechanism, restated because the SEQ now
  // means "written to disk", which is what makes the first <Image> load valid.
  it('renders no source until a preview has actually been written', () => {
    expect(panoPlusPreviewSource(statusFixture({ previewSeq: 0 }))).toBeNull();
    expect(panoPlusPreviewSource(statusFixture({ previewPath: '' }))).toBeNull();
    expect(panoPlusPreviewSource(tall)).toEqual({
      uri: `file://${tall.previewPath}?v=${tall.previewSeq}`,
    });
  });

  it('says WHY the frame is empty instead of drawing a blank box', () => {
    // Not sweeping: no frame at all.
    expect(panoPlusPreviewPlaceholder(null, 'idle')).toBeNull();
    // Sweeping, nothing painted: the honest "not yet".
    expect(
      panoPlusPreviewPlaceholder(statusFixture({ painted: 0 }), 'sweeping'),
    ).toContain('will appear here');
    // Painting, but no preview has reached the app — the state that used to be
    // a silent blank rectangle and is the whole reason for the placeholder.
    const stuck = statusFixture({ painted: 240, previewSeq: 0 });
    expect(panoPlusPreviewPlaceholder(stuck, 'sweeping')).toContain('240 strips');
    // A healthy sweep shows the image, not a caption.
    expect(panoPlusPreviewPlaceholder(tall, 'sweeping')).toBeNull();
  });

  // THE RUNG THAT WAS MISSING, and its absence is the exact shape of the bug:
  // with `status === null` — plugin unregistered, bridge dead, AR meta never
  // firing, i.e. precisely what the poll fallback exists to make impossible —
  // BOTH earlier rungs printed the calm "will appear here as you pan" forever.
  it('names the case where no status has reached the app AT ALL', () => {
    // Early in the sweep a null status is just a slow first frame.
    expect(panoPlusPreviewPlaceholder(null, 'sweeping', 500))
      .toContain('will appear here');
    // Past the bar, with BOTH channels still silent, it is a report.
    const said = panoPlusPreviewPlaceholder(null, 'sweeping', 8000);
    expect(said).toContain('NO engine status');
    expect(said).toContain('report this');
    // One status of any kind takes it back to the ordinary ladder.
    expect(panoPlusPreviewPlaceholder(statusFixture({ painted: 0 }), 'sweeping', 8000))
      .toContain('will appear here');
    // And it never fires outside a live sweep.
    expect(panoPlusPreviewPlaceholder(null, 'idle', 60000)).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// THE EMPTY PANEL — 2026-08-29, and it was reported "for a while" before that.
// ════════════════════════════════════════════════════════════════════════════
//
// The engine rendered ~30 previews per sweep and the ObjC++ publisher wrote
// none of them: `cv::imwrite` to a "preview.jpg.tmp" path THROWS (no encoder
// for ".tmp") and the catch below it was empty. `previewSeq` therefore stayed
// 0, this file's `panoPlusPreviewSource` correctly refused to build an
// <Image> source for seq 0, and the operator watched a dark rectangle while
// the HUD beside it updated live.
//
// Nothing here could have caught the write itself — that is a C++/ObjC++
// concern and `PanoPreviewPublish.*` in the pod's host suite owns it now. What
// these pin is everything on THIS side of that seam: the screen must be able
// to say WHICH half failed, and the panel it says it in must be readable in
// the hold the operator actually uses.

describe('the preview publish, as JS sees it', () => {
  it('names the WRITER when the engine rendered previews and none published', () => {
    // The exact shape of the 2026-08-29 status: strips painted, previews
    // rendered, published seq still 0, failures counted.
    const msg = panoPlusPreviewPlaceholder(
      statusFixture({
        painted: 326,
        previewSeq: 0,
        previewRenders: 31,
        previewFails: 31,
      }),
      'sweeping',
      6000,
    );
    expect(msg).toContain('326 strips painted');
    expect(msg).toContain('31 previews RENDERED');
    expect(msg).toContain('31 could not be written');
    // And it must NOT scare the operator off the sweep: the pack is fine.
    expect(msg).toContain('still recording');
    expect(msg).toContain('pack is unaffected');
  });

  it('stays vague on an OLD engine that has no counters, rather than accusing', () => {
    // A binary that predates the counters reports 0/0/0. The message must fall
    // back to the previous wording — "no preview has reached the app" — with
    // no claim about a writer it cannot see.
    const msg = panoPlusPreviewPlaceholder(
      statusFixture({ painted: 326, previewSeq: 0, previewRenders: 0, previewFails: 0 }),
      'sweeping',
      6000,
    );
    expect(msg).toContain('326 strips painted');
    expect(msg).toContain('no preview has reached the');
    expect(msg).not.toContain('could not be written');
    expect(msg).not.toContain('RENDERED');
  });

  it('reports rendered-but-not-yet-published without blaming the writer', () => {
    // Renders ahead of publishes with NO failures is the ordinary first tick:
    // the engine has drawn one and the publish is still in flight.
    const msg = panoPlusPreviewPlaceholder(
      statusFixture({ painted: 12, previewSeq: 0, previewRenders: 1, previewFails: 0 }),
      'sweeping',
      1000,
    );
    expect(msg).toContain('The engine has rendered 1');
    expect(msg).not.toContain('could not be written');
  });

  it('says nothing at all once a preview HAS published', () => {
    expect(
      panoPlusPreviewPlaceholder(
        statusFixture({ painted: 200, previewSeq: 9, previewRenders: 9 }),
        'sweeping',
        9000,
      ),
    ).toBeNull();
  });

  it('puts a failed preview write on the drop line — it is a drop, not silence', () => {
    const drops = panoPlusDropLine(
      statusFixture({ maxRectifyDeg: 0, previewFails: 17, previewSeq: 0 }),
    );
    expect(drops).toContain('17 PREVIEW WRITE(S) FAILED');
    expect(drops).toContain('empty for that reason');
    expect(drops).toContain('the sweep is not affected');
  });

  // EMPTY AND FROZEN ARE DIFFERENT SCREENS. The first cut of the drop line
  // said "the panel is empty" whenever a write failed — but if previews
  // published for a while and THEN started failing, the operator is looking at
  // a real panorama that has stopped advancing, and being told it is empty
  // sends him hunting the wrong fault.
  it('says FROZEN, not empty, when previews published before they started failing', () => {
    const drops = panoPlusDropLine(
      statusFixture({ maxRectifyDeg: 0, previewFails: 17, previewSeq: 9 }),
    );
    expect(drops).toContain('17 PREVIEW WRITE(S) FAILED');
    expect(drops).toContain('FROZEN at the last one that reached disk (#9)');
    expect(drops).not.toContain('empty for that reason');
  });

  it('does NOT report healthy coalescing as a drop — dropping a stale one is correct', () => {
    // `previewSkips` counts publishes skipped because a newer render was
    // already in flight. At a healthy rate that is the design, not a fault,
    // and putting it on the drop line would train the operator to ignore that
    // line.
    expect(
      panoPlusDropLine(
        statusFixture({ maxRectifyDeg: 0, previewSkips: 8, previewRenders: 40 }),
      ),
    ).toBeNull();
  });

  it('DOES report a publisher that loses more ticks than it lands', () => {
    // Coalescing is correct; coalescing away the MAJORITY is a publisher
    // falling behind, and the operator watching a panel crawl deserves to be
    // told which of the two he is looking at.
    const drops = panoPlusDropLine(
      statusFixture({ maxRectifyDeg: 0, previewSkips: 44, previewRenders: 12 }),
    );
    expect(drops).toContain('preview BEHIND');
    expect(drops).toContain('44 tick(s) coalesced away');
    expect(drops).toContain('the sweep is not affected');
  });

  it('carries rendered / published / failed across the bridge as numbers', () => {
    const s = readPanoPlusStatus({
      plugins: {
        [PANO_PLUS_PLUGIN_KEY]: {
          running: true,
          previewRenders: 31,
          previewFails: 31,
          previewSkips: 2,
          previewSeq: 0,
        },
      },
    });
    expect(s).not.toBeNull();
    expect(s!.previewRenders).toBe(31);
    expect(s!.previewFails).toBe(31);
    expect(s!.previewSkips).toBe(2);
    // Absent (old engine) reads as 0, never NaN — a NaN here would render as
    // "NaN previews RENDERED" on the one screen that must stay trustworthy.
    const old = readPanoPlusStatus({
      plugins: { [PANO_PLUS_PLUGIN_KEY]: { running: true } },
    });
    expect(old!.previewRenders).toBe(0);
    expect(old!.previewFails).toBe(0);
  });

  it('makes the finished sweep say the preview never published', () => {
    const s = coercePanoPlusSummary({
      sessionDir: '/d/pp_1',
      counts: { seen: 482, painted: 421 },
      previewRendered: 32,
      previewPublished: 0,
      previewFailed: 32,
      previewSkipped: 0,
      previewError: 'cv::imencode threw: could not find a writer',
    });
    expect(s.previewRendered).toBe(32);
    expect(s.previewFailed).toBe(32);
    const lines = panoPlusResidualLines(s, { rectify: true, gainMatch: true });
    const line = lines.find((l) => l.includes('LIVE PREVIEW'));
    expect(line).toBeDefined();
    expect(line).toContain('32 rendered');
    expect(line).toContain('0 published');
    expect(line).toContain('32 FAILED');
    expect(line).toContain('could not find a writer');
    expect(line).toContain('panorama itself is unaffected');
  });

  it('says when the pack is SHORT of the frames meta.json claims', () => {
    const s = coercePanoPlusSummary({
      sessionDir: '/d/pp_1',
      counts: { seen: 480, painted: 406 },
      framesWritten: 234,
      frameWriteFailed: 9,
    });
    const line = panoPlusResidualLines(s, { rectify: true, gainMatch: true })
      .find((l) => l.includes('PACK SHORT'));
    expect(line).toContain('9 frame JPEG(s)');
    expect(line).toContain('overstates');
  });

  it('is silent about the preview on a sweep where it worked', () => {
    const s = coercePanoPlusSummary({
      sessionDir: '/d/pp_1',
      counts: { seen: 482, painted: 421 },
      previewRendered: 32,
      previewPublished: 32,
      previewFailed: 0,
    });
    const lines = panoPlusResidualLines(s, { rectify: true, gainMatch: true });
    expect(lines.some((l) => l.includes('LIVE PREVIEW'))).toBe(false);
    expect(lines.some((l) => l.includes('PACK SHORT'))).toBe(false);
  });

  // THE ACCOUNTING IDENTITY IS THE VERDICT, not `previewFailed > 0`. Keying
  // the line on the failure counter alone left a sweep that renders and
  // publishes nothing while counting no failures completely silent — the exact
  // silence this whole change exists to end.
  it('reports a shortfall even when NOTHING was counted as a failure', () => {
    const s = coercePanoPlusSummary({
      sessionDir: '/d/pp_1',
      counts: { seen: 482, painted: 421 },
      previewRendered: 32,
      previewPublished: 0,
      previewFailed: 0,
      previewSkipped: 0,
    });
    const line = panoPlusResidualLines(s, { rectify: true, gainMatch: true })
      .find((l) => l.includes('LIVE PREVIEW'));
    expect(line).toBeDefined();
    expect(line).toContain('32 rendered');
    expect(line).toContain('0 published');
    expect(line).toContain('32 UNACCOUNTED');
  });

  // AND IT MUST NOT CRY WOLF ON A LOADED-BUT-HEALTHY SWEEP. Coalescing is
  // correct behaviour: every skipped tick legitimately leaves `published`
  // below `rendered`. Testing `rendered !== published` instead of the identity
  // would fire on every thermally-loaded sweep and train the operator to stop
  // reading the one line that matters.
  it('stays silent when coalescing fully explains the gap', () => {
    const s = coercePanoPlusSummary({
      sessionDir: '/d/pp_1',
      counts: { seen: 482, painted: 421 },
      previewRendered: 40,
      previewPublished: 31,
      previewFailed: 0,
      previewSkipped: 9,
    });
    expect(s.previewRendered).toBe(
      s.previewPublished + s.previewFailed + s.previewSkipped,
    );
    expect(
      panoPlusResidualLines(s, { rectify: true, gainMatch: true })
        .some((l) => l.includes('LIVE PREVIEW')),
    ).toBe(false);
  });

  // The seq is NOT the count, and filing it under a name that reads like one
  // is what invited the wrong invariant in the first place.
  it('keeps the last published SEQ apart from the published COUNT', () => {
    const s = coercePanoPlusSummary({
      sessionDir: '/d/pp_1',
      counts: { seen: 482, painted: 421 },
      previewRendered: 40,
      previewPublished: 31,
      previewSkipped: 9,
      previewLastPublishedSeq: 39,
    });
    expect(s.previewPublished).toBe(31);
    expect(s.previewLastPublishedSeq).toBe(39);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// THE LEAD-OUT, MADE OBSERVABLE — the 2026-08-30 review's highest finding.
// ════════════════════════════════════════════════════════════════════════════
//
// `Engine::finish()` paints a final strip from the last painted frame, and on
// the operator's packs that ONE strip is 29-48% of the deliverable. Its body
// sat inside two EMPTY catches — the same swallow-everything idiom that hid
// the blank preview for eleven days — and `tailFlushed` reached no status
// field, no meta.json key and no summary. A throw there silently dropped the
// last third of the panorama.
describe('panoPlus tail flush', () => {
  it('says on the result screen when the lead-out did not commit', () => {
    const s = coercePanoPlusSummary({
      sessionDir: '/d/pp_1',
      counts: { seen: 482, painted: 421 },
      tailFlushAttempted: true,
      tailFlushed: false,
      tailFlushError: 'cv::Exception: bad alloc',
    });
    expect(s.tailFlushAttempted).toBe(true);
    expect(s.tailFlushed).toBe(false);
    const line = panoPlusResidualLines(s, { rectify: true, gainMatch: true })
      .find((l) => l.includes('TAIL FLUSH'));
    expect(line).toBeDefined();
    expect(line).toContain('TAIL FLUSH FAILED');
    expect(line).toContain('cv::Exception: bad alloc');
    expect(line).toContain('29-48%');
    expect(line).toContain('SHORT');
  });

  it('is silent on a clean lead-out', () => {
    const s = coercePanoPlusSummary({
      sessionDir: '/d/pp_1',
      counts: { seen: 482, painted: 421 },
      tailFlushAttempted: true,
      tailFlushed: true,
    });
    expect(
      panoPlusResidualLines(s, { rectify: true, gainMatch: true })
        .some((l) => l.includes('TAIL FLUSH')),
    ).toBe(false);
  });

  // A sweep that never latched has NO lead-out, and that is not a fault. If
  // this fired on every abandoned sweep the line would be noise within a week.
  it('does NOT cry wolf on a sweep that never latched', () => {
    const s = coercePanoPlusSummary({
      sessionDir: '/d/pp_1',
      counts: { seen: 4, painted: 0 },
      tailFlushAttempted: false,
      tailFlushed: false,
    });
    expect(
      panoPlusResidualLines(s, { rectify: true, gainMatch: true })
        .some((l) => l.includes('TAIL FLUSH')),
    ).toBe(false);
  });

  it('reads as no-fault on an engine that predates the counters', () => {
    const s = coercePanoPlusSummary({
      sessionDir: '/d/pp_1',
      counts: { seen: 482, painted: 421 },
    });
    expect(s.tailFlushAttempted).toBe(false);
    expect(s.tailFlushed).toBe(false);
    expect(s.tailFlushError).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// A FROZEN PANEL IS NOT A LIVE ONE — and nothing on the panel said so.
// ════════════════════════════════════════════════════════════════════════════
//
// `panoPlusPreviewPlaceholder` falls silent the moment `previewSeq > 0`,
// because from then on the panel shows a genuine panorama and a placeholder
// would HIDE it (the surface renders one or the other). That left a publisher
// which works and then fails showing a frozen image with nothing saying so.
describe('panoPlusPreviewStaleNotice', () => {
  it('names a panel that has stopped advancing, and the seq it stopped at', () => {
    const n = panoPlusPreviewStaleNotice(
      statusFixture({ previewSeq: 9, previewFails: 23 }),
    );
    expect(n).toContain('FROZEN at preview #9');
    expect(n).toContain('23 later write(s) failed');
    expect(n).toContain('not live');
  });

  it('is silent while the panel is live', () => {
    expect(
      panoPlusPreviewStaleNotice(statusFixture({ previewSeq: 9, previewFails: 0 })),
    ).toBeNull();
  });

  it('leaves the EMPTY case to the placeholder — the two must not both fire', () => {
    const status = statusFixture({ previewSeq: 0, previewFails: 31, previewRenders: 31 });
    expect(panoPlusPreviewStaleNotice(status)).toBeNull();
    expect(panoPlusPreviewPlaceholder(status, 'sweeping', 9000)).toContain(
      'could not be written',
    );
  });

  it('is silent with no status at all', () => {
    expect(panoPlusPreviewStaleNotice(null)).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// PLACEMENT IN A PORTRAIT HOLD — break 4, and it is the 2026-08-23 bug again.
// ════════════════════════════════════════════════════════════════════════════
//
// The placement used to read `usePanel = status.axis === 1`, with a comment
// that conceded its own scope: "in either landscape hold is the world
// vertical". The sensor's image-Y runs along the phone's SHORT edge in EVERY
// hold, so a portrait left-to-right sweep latches axis 1 as well — and the
// shipped line then opened a tall PANEL for a WIDE panorama and squeezed it
// into a sliver, which is exactly the geometry `panoPlusPreviewLayout` was
// written to eliminate.
//
// These were red against `status.axis === 1` and are green against
// `panoPlusSweepIsTall`. (2026-09-03: the second, chrome turn is gone — the
// placement is decided on the framebuffer, where the chrome now stays.)

describe('preview placement follows the axis THROUGH the rotation', () => {
  const screen = { width: 402, height: 874, insets: { top: 59, bottom: 34 } };

  it('is a truth table over the image turn, not a landscape assumption', () => {
    // `image` is what panoPlusImageRotationDeg produces: 90 on a
    // portrait-LOCKED host in every hold, 0 on an unlocked one in landscape.
    // axis 1 = the sweep runs along the sensor's image-Y (tall in pixels).
    expect(panoPlusSweepIsTall(1, 90)).toBe(false);   // locked: transposed ⇒ wide
    expect(panoPlusSweepIsTall(0, 90)).toBe(true);    // locked: transposed ⇒ tall
    expect(panoPlusSweepIsTall(1, 0)).toBe(true);     // unlocked: as in pixels
    expect(panoPlusSweepIsTall(0, 0)).toBe(false);
    expect(panoPlusSweepIsTall(1, 180)).toBe(true);   // a half turn transposes nothing
  });

  it('agrees with the aspect it is a stable proxy for', () => {
    // The whole justification for deciding on the axis rather than the aspect
    // is that the axis does not flip mid-sweep. That is only defensible if the
    // two AGREE once the panorama has a shape, so pin it: a tall preview in
    // the operator's frame ⇒ panel, a wide one ⇒ band, in both holds.
    for (const orientation of ['landscape-left', 'portrait'] as const) {
      for (const [axis, w, h] of [[1, 800, 1236], [0, 1400, 328]] as const) {
        const l = panoPlusPreviewLayout(
          statusFixture({ axis, axisLatched: true, previewW: w, previewH: h }),
          screen,
          orientation,
        );
        expect(l.placement).toBe(l.aspect < 1 ? 'panel' : 'band');
      }
    }
  });

  it('gives a PORTRAIT left-to-right sweep a band, not a sliver panel', () => {
    // The operator's question — "can it not be done in portrait left to
    // right?" — through the layout. Same engine case as his landscape hold
    // (axis 1: motion along the sensor's short edge), opposite placement.
    const layout = panoPlusPreviewLayout(
      statusFixture({ axis: 1, axisLatched: true, previewW: 800, previewH: 1236 }),
      screen,
      'portrait',
    );
    expect(layout.placement).toBe('band');
    expect(layout.aspect).toBeGreaterThan(1);
    // AND IT IS NOT A SLIVER. The failure mode being prevented is a wide
    // panorama fitted ACROSS a narrow strip — the 2026-08-23 geometry, where
    // the shelf ended up 110 pt of a 374 pt box. The capsule is deliberately
    // small now (64 pt, the slit-scan band's thickness), so the assertion has
    // to be about the IMAGE, not the box: the panorama must fill the strip's
    // whole thickness and use its length, never the other way round.
    //
    // ⚠ ASSERTING `frame.width * frame.height > 30000` HERE WOULD NOW BE
    // MEANINGLESS — the frame is a constant, so it would pass for any content
    // at all, sliver included. That is the test this replaces.
    expect(layout.frame.width).toBeGreaterThan(300);
    expect(layout.frame.width).toBeGreaterThan(layout.frame.height);
    // Band + quarter turn ⇒ the strip's THICKNESS is `inner.width`, and the
    // image spans all of it.
    expect(layout.content.width).toBeCloseTo(layout.inner.width, 6);
    expect(layout.content.height).toBeGreaterThan(layout.content.width);
    // On screen.
    expect(layout.frame.left).toBeGreaterThanOrEqual(0);
    expect(layout.frame.top).toBeGreaterThanOrEqual(0);
    expect(layout.frame.left + layout.frame.width).toBeLessThanOrEqual(402);
    expect(layout.frame.top + layout.frame.height).toBeLessThanOrEqual(874);
  });

  it('lays the operator\'s landscape hold out on the framebuffer, both holds alike', () => {
    // Since 2026-09-03 the two landscape holds are the SAME framebuffer
    // layout (the chrome does not turn with the hold, so nothing else may
    // either): a pixel-tall sweep is wide on the locked framebuffer and takes
    // the band. The band's top edge is the world's left in one hold and the
    // world's right in the other — which is exactly what Pano's own portrait
    // layout does, held sideways.
    const left = panoPlusPreviewLayout(
      statusFixture({ axis: 1, axisLatched: true, previewW: 800, previewH: 1236 }),
      screen, 'landscape-left',
    );
    const right = panoPlusPreviewLayout(
      statusFixture({ axis: 1, axisLatched: true, previewW: 800, previewH: 1236 }),
      screen, 'landscape-right',
    );
    expect(left.placement).toBe('band');
    expect(left.aspect).toBeGreaterThan(1);
    expect(right).toEqual(left);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// THE NOTICE IS CHROME — AND CHROME DOES NOT TURN (2026-09-03).
// ════════════════════════════════════════════════════════════════════════════
//
// The placeholder and the load-failure line are WORDS drawn inside the preview
// frame. For four days the layout handed them a transposed, chrome-rotated
// `noticeContent` box so they read upright in the operator's sideways hold.
// Pano's words on the same screen are laid out in the portrait framebuffer and
// turn with nothing, and pano+ is to look EXACTLY like Pano — so the layout
// no longer carries any box but the frame itself.

describe('the in-frame notice box', () => {
  const screen = { width: 402, height: 874, insets: { top: 59, bottom: 34 } };

  it('is the frame — no transposed or rotated box exists any more', () => {
    for (const o of ['landscape-left', 'landscape-right', 'portrait'] as const) {
      const l = panoPlusPreviewLayout(
        statusFixture({ axis: 1, axisLatched: true, previewW: 800, previewH: 1236 }),
        screen,
        o,
      );
      expect('noticeContent' in l).toBe(false);
      expect('hudContent' in l).toBe(false);
      expect('chromeRotateDeg' in l).toBe(false);
    }
  });

  it('reserves the bottom chrome a host names, by MAX with the inset rule', () => {
    // Pano's bottom stack (shutter row, mode bar, lens chip) is not a
    // safe-area inset, so the layout is TOLD about it. Absent ⇒ byte-identical.
    const base = panoPlusPreviewLayout(
      statusFixture({ axis: 1, axisLatched: true, previewW: 800, previewH: 1236 }),
      screen, 'portrait',
    );
    const same = panoPlusPreviewLayout(
      statusFixture({ axis: 1, axisLatched: true, previewW: 800, previewH: 1236 }),
      { ...screen, bottomChromePt: 100 }, 'portrait',
    );
    expect(same).toEqual(base);   // 100 < insets.bottom + 96 = 130: the inset rule wins
    const lifted = panoPlusPreviewLayout(
      statusFixture({ axis: 1, axisLatched: true, previewW: 800, previewH: 1236 }),
      { ...screen, bottomChromePt: 260 }, 'portrait',
    );
    const bottomOf = (l: typeof base) =>
      Math.max(l.frame.top + l.frame.height, l.hud.top + l.hud.height);
    expect(bottomOf(lifted)).toBeLessThanOrEqual(874 - 260);
    expect(bottomOf(base)).toBeGreaterThan(874 - 260);
  });
});

/**
 * v11 — THE TWO EVIDENCE FIXES, at the surface the operator actually reads.
 *
 * Both exist because a measurement that is SILENTLY WRONG is worse than one
 * that is missing, and this pack format had one of each:
 *
 *  (a) `subjectDistanceFitM` returned 1.95 / 6.00 / 5.87 m on the three
 *      Test-13 field packs against a standoff measured two independent ways at
 *      0.6-1.0 m, and the result screen printed it as a bare number with no
 *      grade. Reproduced offline from those packs' own poses (see
 *      tools/t2-offline-harness/results/2026-08-30-panoplus-probe): leverage
 *      0.064 / 0.109 / 0.057 against a bar of 0.20, and ONE of the three
 *      (22-57-48) was on the 6.0 m clamp rail at the end of the sweep — the
 *      fixtures below are those measured numbers, not invented ones.
 *  (b) `exposure.rangeRatio` is read back off the same `AVCaptureDevice` the
 *      lock was asserted on, so it cannot answer device identity nor whether
 *      the lock reaches ARKit's pixels.
 */
describe('panoPlusIntegrity — v11 subject-distance grading', () => {
  const geometryCleanSummary = (
    projection: Record<string, unknown>,
    exposure: Record<string, unknown> = {},
  ) =>
    coercePanoPlusSummary({
      width: 1216, height: 1522,
      counts: { seen: 400, painted: 320 },
      axis: 1, sweepSign: 1, maxRectifyDeg: 12.0,
      unpaintedRuns: [], unpaintedColumns: 0, unpaintedRunsAxis: 'y',
      clipping: { frames: 0, columns: 0, canvasH: 1216, heightGrowths: 0 },
      seam: {
        worstBandP50Px: 0.17, worstBandP95Px: 0.38, worstBandMaxPx: 0.63,
        bandSpreadP95Px: 0.5, crossBandDivergencePx: 52.4,
        crossBandDivergenceNormPx: 2.94,
        lumaStepP95DN: 4.0, boundaries: 319, coverageFrac: 1.0,
        canvasJogP50Px: 0.15, canvasJogP95Px: 0.87, canvasJogMaxPx: 1.10,
        canvasJogSamples: 319, measured: true,
        integrityFailed: false, integrityReason: '',
        photoStepP50DN: 0.20, photoStepP95DN: 0.60, photoStepMaxDN: 1.10,
        photoSamples: 319, photoNonUniform: 319,
        photoDriftLocalPct: 1.2, photoDriftTotalPct: 3.0, photoDriftWorstU: 0,
      },
      projection: {
        mode: 1, maxAreaScalePainted: 2.45, maxCrossRectifyDeg: 4.4,
        sweepDeg: 15.9, ...projection,
      },
      gain: {
        cumEnd: 1.0, leak: 0, cumClamp: 2,
        localP2PPct: 1.0, localWorstU: 0, localWindowPx: 40,
        rangePct: 2.0, scaleMin: 0.99, scaleMax: 1.01, columns: 1340,
      },
      exposure: {
        normalize: true, gainClamp: 4, metaFrames: 400, clampedFrames: 0,
        refValue: 2.47, minValue: 2.47, maxValue: 2.47, rangeRatio: 1,
        lock: { locked: true, available: true },
        ...exposure,
      },
    });

  // Pack 22-57-48, the one that ended ON the rail. `subjectDistanceFitM` alone
  // cannot be told apart from a genuine 6 m standoff.
  it('says a clamped fit is a RAIL and prints the raw ratio', () => {
    const v = panoPlusIntegrity(geometryCleanSummary({
      subjectDistanceFitM: 6.0,
      subjectDistanceUsedM: 6.0,
      subjectDistanceConfiguredM: 1.5,
      subjectDistanceFit: {
        rawM: 21.8, clampLoM: 0.3, clampHiM: 6.0, saturated: true,
        clampedUpdates: 118, refusedUpdates: 0,
        den: 3.0145, num: 0.138, samples: 439,
        fwdSpanM: 0.1270, perpSpanM: 1.1627, leverRatio: 0.1092,
        leverBar: 0.2, perpFloorM: 0.01,
        degenerate: true, inForce: true,
      },
    }));
    const line = v.subjectDistanceLine ?? '';
    expect(line).toContain('NOT TRUSTWORTHY');
    expect(line).toContain('CLAMP RAIL');
    expect(line).toContain('21.80');          // the raw ratio, the proof
    expect(line).toContain('RAN ON');         // the placement really used it
    expect(line).toContain('0.109');          // the leverage
    expect(line).toContain('118');            // clamped updates
  });

  // Packs 22-56-49 (1.95 m) and 22-58-49 (5.87 m) are NOT on a rail, so
  // `saturated` alone would have missed two of the three. `degenerate` grades
  // the INPUT and catches all three — which is why it, not saturation, is the
  // headline of this fix.
  it('flags an unsaturated fit whose regressor had no leverage', () => {
    const v = panoPlusIntegrity(geometryCleanSummary({
      subjectDistanceFitM: 1.9513,
      subjectDistanceUsedM: 1.9513,
      subjectDistanceConfiguredM: 1.5,
      subjectDistanceFit: {
        rawM: 1.9513, clampLoM: 0.3, clampHiM: 6.0, saturated: false,
        clampedUpdates: 0, refusedUpdates: 0,
        den: 0.2753, num: 0.1411, samples: 377,
        fwdSpanM: 0.0674, perpSpanM: 1.0577, leverRatio: 0.0638,
        leverBar: 0.2, perpFloorM: 0.01,
        degenerate: true, inForce: true,
      },
    }));
    const line = v.subjectDistanceLine ?? '';
    expect(line).toContain('NOT TRUSTWORTHY');
    expect(line).not.toContain('CLAMP RAIL');
    expect(line).toContain('6.7 cm');         // forward travel
    expect(line).toContain('1.06 m');         // perpendicular travel
    expect(line).toContain('structural, not bad luck');
  });

  // THE CRY-WOLF GUARD. A warning that fires on a healthy sweep is learned to
  // be ignored inside a week, and then it is worse than nothing.
  it('stays calm on a fit whose regressor actually moved', () => {
    const v = panoPlusIntegrity(geometryCleanSummary({
      subjectDistanceFitM: 0.72,
      subjectDistanceUsedM: 0.72,
      subjectDistanceConfiguredM: 1.5,
      subjectDistanceFit: {
        rawM: 0.72, clampLoM: 0.3, clampHiM: 6.0, saturated: false,
        clampedUpdates: 0, refusedUpdates: 0,
        den: 1.84, num: 2.56, samples: 300,
        fwdSpanM: 0.26, perpSpanM: 0.61, leverRatio: 0.426,
        leverBar: 0.2, perpFloorM: 0.01,
        degenerate: false, inForce: true,
      },
    }));
    const line = v.subjectDistanceLine ?? '';
    expect(line).not.toContain('NOT TRUSTWORTHY');
    expect(line).toContain('0.72 m fitted');
    expect(line).toContain('the regressor had something to regress on');
  });

  // A PACK THAT PREDATES THE BLOCK must read as NOT GRADED. The failure mode
  // this guards is the one that already cost three field packs: an ungraded
  // number rendering as an endorsed one.
  it('calls an ungraded pack ungraded rather than clean', () => {
    const v = panoPlusIntegrity(geometryCleanSummary({
      subjectDistanceFitM: 5.8652,
      subjectDistanceUsedM: 5.8652,
      subjectDistanceConfiguredM: 1.5,
      // no subjectDistanceFit block at all — every v10 pack is in this state
    }));
    const line = v.subjectDistanceLine ?? '';
    expect(line).toContain('NOT GRADED');
    expect(line).toContain('5.87 m');
    expect(line).not.toContain('the regressor had something to regress on');
  });

  // THE GATE-NEUTRALITY CLAUSE. The diagnostics are REPORTED, never folded
  // into the verdict: with almost no forward travel the placement predicts
  // s = exp(-fwd/d) ~ 1 whatever d is, so these packs are not damaged by the
  // wrong number and failing them for it would be a false alarm.
  it('does not move the intact verdict either way', () => {
    const degenerate = panoPlusIntegrity(geometryCleanSummary({
      subjectDistanceFitM: 6.0, subjectDistanceUsedM: 6.0,
      subjectDistanceFit: {
        rawM: 21.8, saturated: true, degenerate: true, inForce: true,
        clampedUpdates: 118, den: 3.01, num: 0.138, samples: 439,
        fwdSpanM: 0.127, perpSpanM: 1.163, leverRatio: 0.109,
        leverBar: 0.2, perpFloorM: 0.01, clampLoM: 0.3, clampHiM: 6.0,
        refusedUpdates: 0,
      },
    }));
    const healthy = panoPlusIntegrity(geometryCleanSummary({
      subjectDistanceFitM: 0.72, subjectDistanceUsedM: 0.72,
      subjectDistanceFit: {
        rawM: 0.72, saturated: false, degenerate: false, inForce: true,
        clampedUpdates: 0, den: 1.84, num: 2.56, samples: 300,
        fwdSpanM: 0.26, perpSpanM: 0.61, leverRatio: 0.426,
        leverBar: 0.2, perpFloorM: 0.01, clampLoM: 0.3, clampHiM: 6.0,
        refusedUpdates: 0,
      },
    }));
    expect(degenerate.isIntact).toBe(healthy.isIntact);
    expect(degenerate.isIntact).toBe(true);
    expect(degenerate.hasCuts).toBe(healthy.hasCuts);
    expect(degenerate.hasBanding).toBe(healthy.hasBanding);
  });
});

describe('panoPlusIntegrity — v11 non-circular exposure evidence', () => {
  const withAr = (ar: Record<string, unknown> | undefined) =>
    coercePanoPlusSummary({
      width: 1216, height: 1522,
      counts: { seen: 400, painted: 320 },
      axis: 1, sweepSign: 1, maxRectifyDeg: 12.0,
      unpaintedRuns: [], unpaintedColumns: 0, unpaintedRunsAxis: 'y',
      clipping: { frames: 0, columns: 0, canvasH: 1216, heightGrowths: 0 },
      seam: {
        worstBandP50Px: 0.17, worstBandP95Px: 0.38, worstBandMaxPx: 0.63,
        bandSpreadP95Px: 0.5, crossBandDivergencePx: 52.4,
        crossBandDivergenceNormPx: 2.94, lumaStepP95DN: 4.0,
        boundaries: 319, coverageFrac: 1.0, canvasJogP50Px: 0.15,
        canvasJogP95Px: 0.87, canvasJogMaxPx: 1.10, canvasJogSamples: 319,
        measured: true, integrityFailed: false, integrityReason: '',
        photoStepP50DN: 0.2, photoStepP95DN: 0.6, photoStepMaxDN: 1.1,
        photoSamples: 319, photoNonUniform: 319, photoDriftLocalPct: 1.2,
        photoDriftTotalPct: 3.0, photoDriftWorstU: 0,
      },
      projection: { mode: 1, maxAreaScalePainted: 2.45, sweepDeg: 15.9 },
      gain: { cumEnd: 1.0, leak: 0, cumClamp: 2, localP2PPct: 1.0,
              localWindowPx: 40, rangePct: 2.0, scaleMin: 0.99,
              scaleMax: 1.01, columns: 1340 },
      exposure: {
        normalize: true, gainClamp: 4, metaFrames: 438, clampedFrames: 0,
        refValue: 2.4695, minValue: 2.4695, maxValue: 2.4695, rangeRatio: 1,
        lock: { locked: true, available: true,
                deviceId: 'com.apple.avfoundation.avcapturedevice.built-in_video:0' },
        ...(ar === undefined ? {} : { ar }),
      },
    });

  // The three Test-13 field packs are exactly this: rangeRatio 1.00, locked
  // true, and NOTHING that could confirm the device or that the lock reached
  // ARKit's frames. That state must not read as a passed check.
  it('says the non-circular check was NOT READ rather than passed', () => {
    const v = panoPlusIntegrity(withAr(undefined));
    expect(v.exposureLine).toContain('LOCKED');
    const line = v.arExposureLine ?? '';
    expect(line).toContain('NOT READ');
    expect(line).toContain('circular');
    expect(line).toContain('No probe report in this pack.');
  });

  it('reports WHY the probe came back empty when it did report', () => {
    const v = panoPlusIntegrity(withAr({
      frames: 0, minDurationS: 0, maxDurationS: 0, rangeRatio: 1,
      offsetMinEV: 0, offsetMaxEV: 0, pairedFrames: 0,
      maxAbsDeltaS: 0, maxRelDelta: 0,
      probe: {
        outcome: 'no-arscnview', attempts: 14, sessionResolved: false,
        samples: 0, currentFrameNil: 0, unusableValues: 0,
        frameMatched: 0, frameMismatched: 0, maxFrameDeltaMs: 0,
        route: 'arscnview-in-window-hierarchy',
      },
    }));
    const line = v.arExposureLine ?? '';
    expect(line).toContain('NOT READ');
    expect(line).toContain('no-arscnview');
    expect(line).toContain('14 attempt(s)');
  });

  // THE CLAIM THE CAMERA-LOCK HEADER DECLINED TO MAKE.
  it('says the lock reached ARKit’s own frames when ARKit’s trace is flat', () => {
    const v = panoPlusIntegrity(withAr({
      frames: 438, minDurationS: 0.016566, maxDurationS: 0.016566,
      rangeRatio: 1, offsetMinEV: -0.12, offsetMaxEV: -0.12,
      pairedFrames: 438, maxAbsDeltaS: 0, maxRelDelta: 0,
      probe: {
        outcome: 'found', attempts: 1, sessionResolved: true, samples: 438,
        currentFrameNil: 0, unusableValues: 0, frameMatched: 438,
        frameMismatched: 0, maxFrameDeltaMs: 0,
        route: 'arscnview-in-window-hierarchy',
      },
    }));
    const line = v.arExposureLine ?? '';
    expect(line).toContain('FLAT across the sweep');
    expect(line).toContain('lock reached ARKit');
    expect(line).toContain('438 paired frames');
    expect(line).not.toContain('DISAGREE');
  });

  // THE FAILURE `exposure.rangeRatio` IS STRUCTURALLY UNABLE TO SEE: our own
  // device reads flat because we locked it, while ARKit's frames drift.
  it('catches a lock that held on our device but not on ARKit’s pixels', () => {
    const v = panoPlusIntegrity(withAr({
      frames: 438, minDurationS: 0.016566, maxDurationS: 0.024849,
      rangeRatio: 1.5, offsetMinEV: -0.5, offsetMaxEV: 0.5,
      pairedFrames: 438, maxAbsDeltaS: 0.008283, maxRelDelta: 0.5,
      probe: null,
    }));
    expect(v.exposureLine).toContain('LOCKED');   // the circular reading
    const line = v.arExposureLine ?? '';
    expect(line).toContain('DRIFTED 50%');
    expect(line).toContain('did NOT reach the pixels');
    // The delta says the two READINGS disagree — it cannot on its own say
    // WHICH cause, and the line must not pick one.
    expect(line).toContain('THE TWO READINGS DISAGREE');
    expect(line).toContain('either the lock was asserted on a different device');
  });

  // A neighbouring-frame reading is a real risk of sampling `currentFrame`
  // rather than being handed the ARFrame, so the pack measures it and the
  // line says so instead of quietly averaging it away.
  it('warns when the ARKit reading came from a neighbouring frame', () => {
    const v = panoPlusIntegrity(withAr({
      frames: 400, minDurationS: 0.016566, maxDurationS: 0.016566,
      rangeRatio: 1, offsetMinEV: 0, offsetMaxEV: 0,
      pairedFrames: 400, maxAbsDeltaS: 0, maxRelDelta: 0,
      probe: {
        outcome: 'found', attempts: 1, sessionResolved: true, samples: 400,
        currentFrameNil: 3, unusableValues: 0, frameMatched: 388,
        frameMismatched: 12, maxFrameDeltaMs: 16.7,
        route: 'arscnview-in-window-hierarchy',
      },
    }));
    const line = v.arExposureLine ?? '';
    expect(line).toContain('NEIGHBOURING ARFrame');
    expect(line).toContain('12 of 400');
    expect(line).toContain('16.70 ms');
  });
});

// ── THE LIVE PREVIEW'S TWO MEASURED DEFECTS ─────────────────────────────────
//
// Every number quoted below comes from the operator's three 2026-08-29 pano+
// packs replayed through THIS module out of `dist/` —
// `tools/t2-offline-harness/results/2026-08-30-panoplus-portrait/preview/`.
// Nothing here is a taste argument, and the two candidates that sounded most
// likely (resolution, coalescing) were EXONERATED there: the JPEG lands at
// 1.03 px per device px and a render costs 7.6-14.3 ms against a 250 ms tick
// with droppedQueue 0 on all three packs.

describe('the frontier window multiple', () => {
  const phone = {
    width: 390, height: 844,
    insets: { top: 59, bottom: 34, left: 0, right: 0 },
  };

  // The knee is not a remembered constant: it is derived from the same
  // capsule `panoPlusPreviewLayout` draws, so this test is what stops the two
  // drifting apart silently.
  it('is the fixed capsule’s own along ÷ cross ratio, in every hold', () => {
    // 2026-09-03: the frame is a FIXED 64 pt strip, so the knee is simply its
    // aspect — while the panorama is squarer than the strip, fitting the whole
    // of it fills the thickness and only the LENGTH grows, and no scale is
    // lost. On this 390x844 window with Pano's 240 pt bottom stack: band
    // 330/52 = 6.35, column 493/52 = 9.48 ⇒ 6.35. It does not depend on the
    // hold, because the usable box is the framebuffer's in all of them.
    expect(panoPlusPreviewWindowMultiple(phone, 'landscape-left'))
      .toBeCloseTo(6.346, 2);
    expect(panoPlusPreviewWindowMultiple(phone, 'landscape-right'))
      .toBeCloseTo(6.346, 2);
    expect(panoPlusPreviewWindowMultiple(phone, 'portrait'))
      .toBeCloseTo(6.346, 2);
  });

  // ⚠ THIS USED TO ASSERT THE DERIVED KNEE WAS WITHIN 0.15 OF NATIVE'S OWN
  // FALLBACK, and that premise died on 2026-09-03. It held while both numbers
  // described the same thing — a band FITTED to the panorama, whose knee any
  // reasonable geometry lands near. The frame is now a fixed capsule whose
  // aspect is a property of the HOST'S chrome, which native has no way to
  // know: it cannot see the shutter row, the mode bar or the lens chip. So the
  // two are now legitimately far apart, and the honest assertion is that the
  // SDK always sends its own — a host that fell back to native's constant
  // would window a 330 pt strip at 1.44 and show an 81 pt sliver.
  it('is what the SDK sends, and is deliberately NOT native’s fallback', () => {
    const m = panoPlusPreviewWindowMultiple(phone, 'landscape-left');
    expect(Math.abs(m - PANO_PLUS_DEFAULT_PREVIEW_WINDOW_MULT))
      .toBeGreaterThan(1.0);
    // Native's fallback is unchanged and still documented — it is what an
    // omitting host gets, and this pins that the mirror has not silently
    // drifted from `RNISPanoCore.mm`'s literal.
    expect(PANO_PLUS_DEFAULT_PREVIEW_WINDOW_MULT).toBe(1.44);
  });

  // The window must never be a knob that can strangle the panel or disable
  // itself by accident.
  it('is bounded on both ends however odd the window is', () => {
    for (const s of [
      { width: 120, height: 120 },
      { width: 1600, height: 200 },
      { width: 200, height: 2400 },
    ]) {
      for (const o of ['portrait', 'landscape-left'] as const) {
        const m = panoPlusPreviewWindowMultiple(s, o);
        expect(m).toBeGreaterThanOrEqual(1.0);
        // 12, not 6: a 64 pt strip is legitimately that long and thin — the
        // A35's column reaches 11.25 — and the old ceiling would have clipped
        // the real knee and re-opened the collapse it exists to prevent.
        expect(m).toBeLessThanOrEqual(12.0);
      }
    }
  });

  // THE MEASURED CLAIM, restated as an assertion about this function: at the
  // knee the panorama still fills the strip's thickness, and past it it starts
  // shrinking. 1216 is the canvas cross extent on two of the three packs.
  //
  // ⚠ MEASURED ON `content`, NOT ON `frame`. The frame is a constant now — an
  // area comparison against it would pass for any knee at all, which is
  // exactly the shape of test that certifies nothing.
  it('is the ratio past which the drawn panorama stops gaining size', () => {
    const cross = 1216;
    const mult = panoPlusPreviewWindowMultiple(phone, 'landscape-left');
    const at = (along: number) => {
      const l = panoPlusPreviewLayout(
        statusFixture({
          axis: 1, axisLatched: true, canvasHeightPx: cross,
          paintedWidthPx: along, previewW: 800,
          previewH: Math.round(800 * along / cross),
        }),
        phone, 'landscape-left',
      );
      return { area: l.content.width * l.content.height, l };
    };
    const knee = Math.round(mult * cross);
    // AT the knee the image still spans the strip's full thickness — that is
    // what "no scale lost yet" means, and it is the whole claim.
    const atKnee = at(knee).l;
    expect(atKnee.content.width).toBeCloseTo(atKnee.inner.width, 0);
    // Growing INTO the knee gains area; growing past it loses area, without
    // bound, which is why the engine must window instead.
    expect(at(knee).area).toBeGreaterThan(at(Math.round(knee * 0.6)).area);
    expect(at(Math.round(knee * 2.5)).area).toBeLessThan(at(knee).area);
    expect(at(Math.round(knee * 4)).area)
      .toBeLessThan(at(Math.round(knee * 2.5)).area);
  });
});

describe('the sweep HUD, on disk', () => {
  // The capture screen stopped printing the engine and drops lines during a
  // sweep on 2026-09-03. This is where they go instead, and the shape has to
  // be pinned here because the write itself happens in the surface, where
  // nothing can be asserted about the bytes.
  it('carries every line whole, and encodes “nothing to say” as null', () => {
    const body = JSON.parse(panoPlusSweepHudSidecar({
      guidanceHeadline: 'Panning ↓ — keep it steady',
      guidanceDetail: 'Painted 1832 px of canvas.',
      hud: 'band 4% · 40/42 painted · 1234px · 1.2ms',
      drops: null,
      cameraLock: null,
      previewWindow: null,
      viewfinder: null,
      writtenAtMs: 1_700_000_000_000,
    })) as Record<string, unknown>;
    expect(body.schema).toBe('panoplus-host-sweep-hud/1');
    expect(body.writtenAtMs).toBe(1_700_000_000_000);
    expect(body.hud).toBe('band 4% · 40/42 painted · 1234px · 1.2ms');
    // ⚠ NULL, NOT ''. A clean sweep and a bug in this function must not read
    // the same to whoever opens the pack six weeks from now.
    expect(body.drops).toBeNull();
    expect(body.cameraLock).toBeNull();
    expect(body.previewWindow).toBeNull();
    expect(body.viewfinder).toBeNull();
  });

  it('does not truncate a long drops line', () => {
    const long = `${'x'.repeat(4000)} · 12 pack write(s) dropped`;
    const body = JSON.parse(panoPlusSweepHudSidecar({
      guidanceHeadline: 'h', guidanceDetail: 'd', hud: 'u',
      drops: long, cameraLock: null, previewWindow: null, viewfinder: null,
    })) as Record<string, unknown>;
    // A truncated diagnostic is worse than none — it reads as complete.
    expect(body.drops).toBe(long);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// THE ARM NOTICE, ON DISK — THE PACK KEEPS WHAT THE SCREEN LOST (2026-09-07)
//
// The τ = 0 EXPERIMENT banner came OFF the capture screen: the operator has
// nothing to do about it, and pano shows no such thing. It is still the only
// prose statement of WHICH ARM RAN AND WHY, so it is still written whole into
// `host_notice.json` — and `packOnly` records that the screen did not show it,
// which `shownExpanded: false` on its own would have misreported as "he chose
// not to open it".
// ═══════════════════════════════════════════════════════════════════════════
describe('the arm notice, on disk', () => {
  const OK_PLAN = { ok: true, reason: null, detail: null };
  const BASIS_ONLY = {
    complete: false,
    missing: 'tau' as string | null,
    tauS: null as number | null,
    tauStdErrMs: null as number | null,
    basisIndex: 8 as number | null,
    basisLabel: '-y+x+z' as string | null,
    tauKey: 'iPhone17,1|AVCaptureDeviceTypeBuiltInUltraWideCamera|1920x1440|60',
    storedTauKeys: [] as string[],
  };

  it('carries the τ = 0 arm, its provenance and its calibration state VERBATIM', () => {
    const notice = panoPlusArmNotice('imu', OK_PLAN, BASIS_ONLY, true);
    const body = JSON.parse(panoPlusNoticeSidecar(notice, {
      armContract: 'ios-tau-basis',
      poseSourceRequested: 'imu',
      shownExpanded: false,
      writtenAtMs: 1_700_000_000_000,
    })) as Record<string, unknown>;
    expect(body.schema).toBe('panoplus-host-notice/1');
    // THE ARM.
    expect(body.poseSourceEffective).toBe('imu');
    expect(body.poseSourceRequested).toBe('imu');
    expect(body.fallbackToAr).toBe(false);
    expect(body.startLabel).toBe('Start τ=0 EXPERIMENT');
    // THE τ PROVENANCE — the exact sentence that left the screen.
    expect(body.headline).toBe('IMU ARM — EXPERIMENT: τ = 0, NO TIMING CORRECTION');
    expect(String(body.detail)).toContain('NO camera↔IMU timing correction');
    expect(String(body.detail)).toContain('tauProvenance: uncorrected');
    // THE CALIBRATION STATE — the basis is real and the pack says which.
    expect(String(body.detail)).toContain('C #8');
    expect(String(body.detail)).toContain('-y+x+z');
    // AND THAT THE SCREEN NEVER SHOWED IT.
    expect(body.packOnly).toBe(true);
  });

  it('marks a REAL refusal as one the screen DID show', () => {
    const refused = panoPlusArmNotice('imu', OK_PLAN, null, true);
    const body = JSON.parse(panoPlusNoticeSidecar(refused, {
      armContract: 'ios-tau-basis',
      poseSourceRequested: 'imu',
      shownExpanded: true,
    })) as Record<string, unknown>;
    expect(body.packOnly).toBe(false);
    expect(String(body.headline)).toContain('BASIS');
  });
});

describe('the frontier marker', () => {
  it('is silent on an engine that does not publish a frontier', () => {
    // -1, not 0. 0 is a legitimate fraction, and an old binary must be
    // UNPLACEABLE rather than placed at one end of the panel.
    expect(panoPlusPreviewMarker(statusFixture(), false, 'landscape-left'))
      .toBeNull();
    expect(panoPlusPreviewMarker(null, false)).toBeNull();
  });

  it('is silent before the axis latches, and outside [0,1]', () => {
    expect(panoPlusPreviewMarker(
      statusFixture({ previewFrontierFrac: 0.5, axisLatched: false }),
      false, 'landscape-left',
    )).toBeNull();
    expect(panoPlusPreviewMarker(
      statusFixture({ previewFrontierFrac: 1.4 }), false, 'landscape-left',
    )).toBeNull();
  });

  // THE ONE THING THAT MUST NOT BE RE-DERIVED. `previewFrontierFrac` is
  // measured in the PUBLISHED image's own order, which `Engine::orient` builds
  // to run from the sweep's start to its end — so frac 1 IS the leading edge,
  // and the leading edge IS the direction the sweep advances. Deriving a
  // second rotation chain here is how the HUD came to print `vert` for a
  // horizontal gesture.
  it('points the same way the coach mark and the HUD do, in every hold', () => {
    for (const o of ['portrait', 'portrait-upside-down',
                     'landscape-left', 'landscape-right'] as const) {
      for (const axis of [0, 1]) {
        for (const sweepSign of [1, -1]) {
          const st = statusFixture({
            axis, sweepSign, axisLatched: true, previewFrontierFrac: 0.5,
          });
          const m = panoPlusPreviewMarker(st, false, o);
          expect(m).not.toBeNull();
          expect(m!.dir).toBe(panoPlusSweepDirection(st, false, o));
          expect(m!.tall).toBe(m!.dir === 'up' || m!.dir === 'down');
        }
      }
    }
  });

  // The stall, as the surface will see it: the fraction climbs while nothing
  // else on the panel changes.
  it('carries the fraction through unchanged so the line can move', () => {
    for (const f of [0, 0.25, 0.5, 0.75, 1]) {
      const m = panoPlusPreviewMarker(
        statusFixture({ previewFrontierFrac: f }), false, 'landscape-left',
      );
      expect(m!.frac).toBe(f);
    }
  });
});

describe('the frontier caption (v12 — "what is the blue line?")', () => {
  it('captions the marker exactly when the marker itself can render', () => {
    const s = statusFixture({ previewFrontierFrac: 0.6 });
    expect(panoPlusFrontierCaption(s)).toMatch(/blue line/);
  });

  it('says nothing without a placeable frontier, a status, or a session', () => {
    // -1 is native's "nothing to place" — the same value the marker refuses.
    expect(panoPlusFrontierCaption(
      statusFixture({ previewFrontierFrac: -1 }))).toBeNull();
    expect(panoPlusFrontierCaption(
      statusFixture({ previewFrontierFrac: Number.NaN }))).toBeNull();
    expect(panoPlusFrontierCaption(
      statusFixture({ previewFrontierFrac: 0.6, running: false }))).toBeNull();
    expect(panoPlusFrontierCaption(null)).toBeNull();
  });
});

describe('the windowed-preview caption', () => {
  it('says nothing while the panel IS the whole panorama', () => {
    // Which is every sweep the operator has recorded: his three end at
    // 1423-1711 canvas px, and the window engages past ~1757.
    expect(panoPlusPreviewWindowCaption(statusFixture())).toBeNull();
    expect(panoPlusPreviewWindowCaption(statusFixture({
      previewWindowed: false, previewViewPx: 1464, previewBandPx: 1464,
    }))).toBeNull();
    expect(panoPlusPreviewWindowCaption(null)).toBeNull();
  });

  it('refuses a nonsensical view/band pair rather than printing one', () => {
    expect(panoPlusPreviewWindowCaption(statusFixture({
      previewWindowed: true, previewViewPx: 0, previewBandPx: 4000,
    }))).toBeNull();
    expect(panoPlusPreviewWindowCaption(statusFixture({
      previewWindowed: true, previewViewPx: 4000, previewBandPx: 1000,
    }))).toBeNull();
  });

  it('is a percentage with no calibration, and metres with one', () => {
    const st = statusFixture({
      previewWindowed: true, previewViewPx: 1757, previewBandPx: 6000,
    });
    expect(panoPlusPreviewWindowCaption(st)).toContain('29%');
    // 0.65 m standoff / (fx 1338.46 * canvasScale 0.5) = 0.971 mm per canvas px
    const cap = panoPlusPreviewWindowCaption(st, 0.000971) ?? '';
    expect(cap).toContain('1.7 m');
    expect(cap).toContain('5.8 m');
  });
});

describe('the preview refresh rate on the HUD', () => {
  it('says nothing at the configured rate', () => {
    const line = panoPlusHudLine(statusFixture({
      previewIntervalMs: PANO_PLUS_PREVIEW_INTERVAL_MS,
    }));
    expect(line).not.toContain('prev ');
  });

  // A panel updating slowly because the duty throttle decided so is a
  // MEASURED fact, and "the preview does not look good as I pan" must never
  // again be a symptom with no number behind it.
  it('names the rate once the duty throttle has slowed it', () => {
    expect(panoPlusHudLine(statusFixture({ previewIntervalMs: 400 })))
      .toContain('prev 2.5Hz');
  });

  it('says nothing on a binary that predates the field', () => {
    expect(panoPlusHudLine(statusFixture({ previewIntervalMs: 0 })))
      .not.toContain('prev ');
  });
});

describe('the preview status fields survive the coercion', () => {
  it('defaults the frontier to UNPLACEABLE and not to one end', () => {
    const st = coercePanoPlusStatus({ running: true });
    expect(st!.previewFrontierFrac).toBe(-1);
    expect(st!.previewWindowed).toBe(false);
    expect(st!.previewViewPx).toBe(0);
    expect(st!.previewBandPx).toBe(0);
    expect(st!.previewIntervalMs).toBe(0);
  });

  it('reads the native block through', () => {
    const st = coercePanoPlusStatus({
      running: true, previewFrontierFrac: 0.42, previewViewPx: 1757,
      previewBandPx: 6000, previewViewStartPx: 4243, previewWindowed: true,
      previewIntervalMs: 137.5,
    });
    expect(st!.previewFrontierFrac).toBeCloseTo(0.42, 5);
    expect(st!.previewViewPx).toBe(1757);
    expect(st!.previewBandPx).toBe(6000);
    expect(st!.previewViewStartPx).toBe(4243);
    expect(st!.previewWindowed).toBe(true);
    expect(st!.previewIntervalMs).toBeCloseTo(137.5, 5);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  THE HOST'S OWN TOP CHROME (2026-09-03)
// ═══════════════════════════════════════════════════════════════════════════
//
// The IR shell absolutely-positions its field-baseline banner at `top: 48`
// over whatever surface is mounted, and the pano+ guidance headline rendered
// into the same pixels: "Hold portrait — sweep left to right" survived on
// screen as "H…" and "right", and the banner's lower edge struck through the
// next line. Neither view can see the other, so the host measures its banner
// and hands the bottom edge down as `hostChromeTopPt`, which the surface folds
// into `insets.top` (by MAX — both are measured from the top of the window).
//
// What is testable here is the layout's half of that contract: nothing the
// surface places may start above the inset it was given.
describe('the layout starts below the inset it is given', () => {
  const status = null;

  it('the HUD and the preview both clear a host banner', () => {
    // 48 (the banner's top) + 57 (its measured two-line height) + 8 = 113.
    const top = 113;
    const l = panoPlusPreviewLayout(
      status,
      { width: 384, height: 832, insets: { top, bottom: 0, left: 0, right: 0 } },
      'portrait',
    );
    expect(l.hud.top).toBeGreaterThanOrEqual(top);
    expect(l.frame.top).toBeGreaterThanOrEqual(top);
  });

  it('a bigger inset moves both DOWN, so the number is load-bearing', () => {
    const small = panoPlusPreviewLayout(
      status,
      { width: 384, height: 832, insets: { top: 24, bottom: 0, left: 0, right: 0 } },
      'portrait',
    );
    const big = panoPlusPreviewLayout(
      status,
      { width: 384, height: 832, insets: { top: 160, bottom: 0, left: 0, right: 0 } },
      'portrait',
    );
    expect(big.hud.top).toBeGreaterThan(small.hud.top);
    expect(big.hud.top).toBeGreaterThanOrEqual(160);
  });
});
