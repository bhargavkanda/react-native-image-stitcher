// SPDX-License-Identifier: Apache-2.0
//
// PanoPlusResultView — THE CONTROLS ARE REACHABLE. MOUNTED.
//
// ── WHY THIS FILE EXISTS ───────────────────────────────────────────────────
//
// Operator, 2026-09-02, verbatim: *"There is SO MUCH text on the image output
// that I do not see the buttons still!! WHY is that text needed on the output?
// What purpose is it serving?"*
//
// MEASURED ON HIS OWN PACK (`Pano plus tau = 0/panoplus-debug-pack-
// 2026-08-31T18-29-47-653Z/panoplus/meta.json`, the pack in his screenshot),
// by running the shipped graders over it:
//
//     headline                       51 chars
//     verdict paragraphs        8 lines / 1,810 chars   ← rendered unconditionally
//     residual lines           15 lines / 1,492 chars   ← in a ScrollView that
//                                                         had collapsed to 0 px
//     ON SCREEN, UNCONDITIONALLY:  1,861 chars
//
// 1,861 characters of prose in a `View` that React Native does not shrink
// (`flexShrink` defaults to 0 here, the OPPOSITE of CSS) sat between a fixed
// 0.42·H viewport and the actions row, and pushed Close/Save/Share off the
// bottom of the display with no scroll path to them.
//
// ── WHAT THIS FILE ASSERTS, AND WHAT IT CANNOT ─────────────────────────────
//
// react-test-renderer runs no layout engine: it cannot compute that a child
// overflowed. So this file does not assert pixels. It asserts the three
// STRUCTURAL properties that make the overflow impossible, each of which is
// exactly the thing that was false before:
//
//   1. the prose is not rendered by default (the volume test);
//   2. the expanded report is `position: 'absolute'` INSIDE the content box,
//      so it cannot displace a sibling however long it grows;
//   3. the controls are present AND touch-reachable in BOTH states.
//
// (3) uses the `blockers()` ancestor walk rather than `tap()`, and the reason
// is on the record: `tap()` calls `props.onPress` directly, which bypasses
// touch dispatch and therefore passes happily on a control sealed inside
// `pointerEvents="none"`. `panoplus-lens-chip` shipped in exactly that state
// and was dead on both platforms until 2026-09-02; uiautomator could not see
// it either, because `pointerEvents` is not an accessibility property.
//
// ⚠️ THIS FILE MUST LIVE IN `__tests__/` — the BUILD config's `**/*.test.ts`
// exclude does not match `.tsx`, so a render test beside its component
// compiles into `dist/` and breaks `npm run build` on react-test-renderer's
// missing declarations. Its two siblings carry the same warning and it has
// still cost a build once.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import * as React from 'react';
import TestRenderer, {
  act,
  type ReactTestInstance,
  type ReactTestRenderer,
} from 'react-test-renderer';

// Same local extension as the sibling suite, for the same reason: this screen
// mounts PinchZoomView, which builds a `PanResponder` at render time, and the
// shared render mock is owned by the T2 surfaces.
jest.mock('react-native', () => ({
  ...jest.requireActual('react-native'),
  PanResponder: {
    create: (config: Record<string, unknown>) => ({
      panHandlers: {},
      __config: config,
    }),
  },
}));

// ── ITEM E's HALF OF THIS SCREEN: the device's ORIENTATION ──────────────
// `useDeviceOrientation` reads the accelerometer through a native module that
// does not exist here, so the hold is injected. Mutable because the two cases
// that matter — portrait (identity) and a landscape hold under a
// PORTRAIT-LOCKED host (a quarter turn) — differ only in this value.
let heldAs: 'portrait' | 'landscape-left' | 'landscape-right' = 'portrait';
jest.mock('react-native-image-stitcher', () => ({
  ...jest.requireActual('react-native-image-stitcher'),
  useDeviceOrientation: () => heldAs,
}));

import { PanoPlusResultView } from '../PanoPlusResultView';
import {
  PANO_PLUS_VERDICT_FILE,
  coercePanoPlusSummary,
  panoPlusIntegrity,
  panoPlusResidualLines,
  panoPlusVerdictSidecar,
  panoPlusBasisImageCheck,
  panoPlusBasisTravelCheck,
} from '../panoPlusModel';
import type { PanoPlusCaptureResult } from '../panoPlusTypes';

/**
 * A pack shaped like the operator's — every optional verdict sentence present,
 * so the fixture exercises the WORST case rather than a tidy one. The numbers
 * are the Test-13 field shape the sibling suite already uses; what matters
 * here is the VOLUME of prose they produce, not their values.
 */
function fieldResult(): PanoPlusCaptureResult {
  return {
    kind: 'panoplus',
    type: 'panoplus',
    uri: '/tmp/pp/canvas.jpg',
    sessionDir: '/tmp/pp',
    width: 1216,
    height: 1866,
    capturedAt: new Date(0).toISOString(),
    arms: {
      rectify: true,
      gainMatch: true,
      packFrames: 'all' as PanoPlusCaptureResult['arms']['packFrames'],
      // The arm NATIVE REPORTED STARTING. The field shape this fixture copies
      // was captured on the AR arm, which is also the production default.
      poseSource: 'ar',
    },
    summary: coercePanoPlusSummary({
      width: 1216,
      height: 1866,
      counts: { seen: 438, painted: 343 },
      axis: 1,
      sweepSign: 1,
      maxRectifyDeg: 35.36,
      unpaintedRuns: [],
      unpaintedColumns: 0,
      unpaintedRunsAxis: 'y',
      clipping: { frames: 0, columns: 0, canvasH: 1216, heightGrowths: 0 },
      seam: {
        // Over the bar, so the headline is a CUTS verdict — his pack's verdict.
        worstBandP50Px: 2.42, worstBandP95Px: 3.38, worstBandMaxPx: 6.63,
        bandSpreadP95Px: 2.5, crossBandDivergencePx: 52.4,
        crossBandDivergenceNormPx: 2.94, lumaStepP95DN: 4.0,
        boundaries: 342, coverageFrac: 0.994, canvasJogP50Px: 0.21,
        canvasJogP95Px: 0.68, canvasJogMaxPx: 1.53, canvasJogSamples: 343,
        measured: true, integrityFailed: false, integrityReason: '',
        photoStepP50DN: 0.2, photoStepP95DN: 0.6, photoStepMaxDN: 1.1,
        photoSamples: 343, photoNonUniform: 343, photoDriftLocalPct: 1.2,
        photoDriftTotalPct: 3.0, photoDriftWorstU: 0,
      },
      projection: {
        mode: 1, maxAreaScalePainted: 2.7, maxCrossRectifyDeg: 5.1,
        sweepDeg: 35.1, subjectDistanceConfiguredM: 1.5,
        subjectDistanceFitM: 6.0, subjectDistanceUsedM: 6.0,
        subjectDistanceFit: {
          rawM: 495.84, clampLoM: 0.3, clampHiM: 6.0, saturated: true,
          clampedUpdates: 37, refusedUpdates: 75, den: 3.0145, num: 0.000197,
          samples: 439, fwdSpanM: 0.127, perpSpanM: 1.1627,
          leverRatio: 0.1092, leverBar: 0.2, perpFloorM: 0.01,
          degenerate: true, inForce: true,
        },
      },
      gain: {
        cumEnd: 1.0, leak: 0, cumClamp: 2, localP2PPct: 1.0, localWorstU: 0,
        localWindowPx: 40, rangePct: 2.0, scaleMin: 0.99, scaleMax: 1.01,
        columns: 1340,
      },
      exposure: {
        normalize: true, gainClamp: 4, metaFrames: 438, clampedFrames: 0,
        refValue: 2.4695, minValue: 2.4695, maxValue: 2.4695, rangeRatio: 1,
        lock: { locked: true, available: true },
        ar: {
          frames: 438, minDurationS: 0.016566, maxDurationS: 0.024849,
          rangeRatio: 1.5, offsetMinEV: -0.5, offsetMaxEV: 0.5,
          pairedFrames: 438, maxAbsDeltaS: 0.008283, maxRelDelta: 0.5,
          probe: null,
        },
      },
    }),
  };
}

interface Rig {
  /** Every rendered string, concatenated — what the operator can actually read. */
  screenText: () => string;
  has: (testID: string) => boolean;
  /** `props` of the first node carrying `testID`. */
  propsOf: (testID: string) => Record<string, unknown>;
  /**
   * Every `pointerEvents` value on the ANCESTOR CHAIN of `testID`, root-first.
   *
   * ⚠ THE ONE CHECK `tap()` CANNOT MAKE. See this file's header: a control
   * inside a `pointerEvents="none"` wrapper has a working `onPress` and no
   * finger can reach it, and that exact defect shipped on `panoplus-lens-chip`.
   */
  blockers: (testID: string) => string[];
  expand: () => void;
  unmount: () => void;
}

function mount(result: PanoPlusCaptureResult): Rig {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(
      <PanoPlusResultView
        result={result}
        onDismiss={() => undefined}
        debugActions={{
          onShare: () => undefined,
          onSave: () => undefined,
          onAddNotes: () => undefined,
        }}
      />,
    );
  });
  const collect = (): string => {
    const out: string[] = [];
    const walk = (n: ReactTestInstance | string | null): void => {
      if (n == null) return;
      if (typeof n === 'string') { out.push(n); return; }
      for (const c of n.children ?? []) walk(c as ReactTestInstance | string);
    };
    walk(renderer.root as unknown as ReactTestInstance);
    return out.join(' ');
  };
  const first = (testID: string): ReactTestInstance => {
    const [node] = renderer.root.findAllByProps({ testID });
    if (node == null) throw new Error(`no node with testID ${testID}`);
    return node;
  };
  return {
    screenText: collect,
    has: (testID) => renderer.root.findAllByProps({ testID }).length > 0,
    propsOf: (testID) => first(testID).props as Record<string, unknown>,
    blockers: (testID) => {
      const out: string[] = [];
      // `parent` exists at runtime but is absent from the `ReactTestInstance`
      // typing this repo's react-test-renderer ships, so the walk is typed
      // locally rather than cast at every hop.
      interface Walkable { props: { pointerEvents?: string }; parent: Walkable | null }
      let cur = (first(testID) as unknown as Walkable).parent;
      while (cur != null) {
        const pe = cur.props?.pointerEvents;
        if (typeof pe === 'string') out.unshift(pe);
        cur = cur.parent;
      }
      return out;
    },
    expand: () => {
      const onPress = first('panoplus-integrity').props.onPress as
        | (() => void)
        | undefined;
      if (onPress == null) throw new Error('the verdict chip has no onPress');
      act(() => { onPress(); });
    },
    unmount: () => { act(() => { renderer.unmount(); }); },
  };
}

/** Every control the operator must be able to reach on this screen. */
const CONTROLS = [
  'panoplus-result-close',
  'panoplus-result-save',
  'panoplus-result-share',
  'panoplus-result-notes',
];

describe('the output screen shows the image and the controls', () => {
  let rig: Rig | null = null;
  afterEach(() => { rig?.unmount(); rig = null; });

  it('renders one verdict line, not the eight-paragraph report', () => {
    rig = mount(fieldResult());
    const text = rig.screenText();

    // The headline IS there — G1 is the T1 contract's headline measure and
    // burying it is the opposite mistake.
    expect(text).toContain('⚠ Cuts');
    // And the affordance says where the rest went. A collapsed diagnostic with
    // no visible handle is indistinguishable from a deleted one.
    expect(text).toContain('tap for the residuals');
    expect(text).toContain(PANO_PLUS_VERDICT_FILE);

    // NONE of the report is on screen. Sampled by the sentences that made his
    // screenshot unreadable rather than by a character budget alone, so a
    // future line that reintroduces the wall fails here by name.
    const r = fieldResult();
    for (const line of panoPlusResidualLines(r.summary, r.arms)) {
      expect(text).not.toContain(line);
    }
    const integrity = panoPlusIntegrity(r.summary);
    expect(text).not.toContain(integrity.line);
    expect(integrity.subjectDistanceLine).not.toBeNull();
    expect(text).not.toContain(integrity.subjectDistanceLine as string);

    // The budget, as a backstop. His pack put 1,861 characters here.
    expect(text.length).toBeLessThan(300);
  });

  it('keeps every control present and touch-reachable, collapsed AND expanded',
    () => {
      rig = mount(fieldResult());
      for (const id of CONTROLS) {
        expect(rig.has(id)).toBe(true);
        // ⚠ NOT `toEqual([])` — an ancestor may legitimately be `box-none`
        // (transparent to touch itself, children still hit). `none` is the
        // value that kills the control.
        expect(rig.blockers(id)).not.toContain('none');
      }

      rig.expand();
      expect(rig.has('panoplus-report')).toBe(true);
      for (const id of CONTROLS) {
        expect(rig.has(id)).toBe(true);
        expect(rig.blockers(id)).not.toContain('none');
      }
    });

  it('expands the report OVER the picture, not above the controls', () => {
    rig = mount(fieldResult());
    expect(rig.has('panoplus-report')).toBe(false);
    rig.expand();

    // THE STRUCTURAL INVARIANT. `position: 'absolute'` is what makes the
    // report's height irrelevant to its siblings — the property the old
    // auto-height `View` did not have, and the whole of why the buttons
    // vanished. A flow-positioned report would pass every text assertion above
    // and reproduce the bug the moment it was opened.
    const style = rig.propsOf('panoplus-report').style as
      | Record<string, unknown>
      | undefined;
    expect(style?.position).toBe('absolute');

    // And it is INSIDE the content box, so `absolute` is bounded by the
    // picture rather than by the screen. Proven by the chain rather than by
    // reading the JSX: the viewport is its sibling.
    expect(rig.has('panoplus-result-viewport')).toBe(true);

    const text = rig.screenText();
    for (const line of panoPlusResidualLines(fieldResult().summary, fieldResult().arms)) {
      expect(text).toContain(line);
    }
  });

  it('bounds the headline so the chip cannot grow with the pack', () => {
    rig = mount(fieldResult());
    // Every other child of the root is fixed-size; this is the only text that
    // could grow, and an unbounded headline would put the actions row back at
    // the mercy of the verdict string's length.
    expect(rig.propsOf('panoplus-integrity-headline').numberOfLines).toBe(2);
  });
});

describe('the report that left the screen is in the pack', () => {
  it('carries BOTH D3 basis checks, each read off this sweep\'s own summary', () => {
    const r = fieldResult();
    const written = JSON.parse(panoPlusVerdictSidecar(r, { writtenAtMs: 0 }));
    expect(written.basisImageCheck).toEqual(
      JSON.parse(JSON.stringify(panoPlusBasisImageCheck(r.summary.latch))),
    );
    expect(written.basisTravelCheck).toEqual(
      JSON.parse(JSON.stringify(panoPlusBasisTravelCheck(r.summary.regime))),
    );
    expect(written.basisTravelCheck.rotTravelPx).toBe(r.summary.regime.rotTravelPx);
  });

  it('carries every sentence and every residual, verbatim', () => {
    const r = fieldResult();
    const written = JSON.parse(panoPlusVerdictSidecar(r, { writtenAtMs: 0 }));
    const integrity = panoPlusIntegrity(r.summary);

    expect(written.schema).toBe('panoplus-host-verdict/1');
    expect(written.headline).toContain('⚠ Cuts');
    expect(written.isIntact).toBe(false);

    // EVERY sentence the screen stopped showing by default. A relocation that
    // dropped one would be a deletion wearing a relocation's name.
    for (const line of [
      integrity.line,
      integrity.seamLine,
      integrity.warpLine,
      integrity.subjectDistanceLine,
      integrity.bandLine,
      integrity.exposureLine,
      integrity.arExposureLine,
      integrity.gainLine,
    ]) {
      if (line == null) continue;
      expect(written.verdict.lines).toContain(line);
    }
    // …and no nulls, which would read as a line that rendered empty.
    for (const line of written.verdict.lines) expect(typeof line).toBe('string');

    expect(written.residuals).toEqual(panoPlusResidualLines(r.summary, r.arms));
    expect(written.note).toContain('ADVISORY');
  });
});

// ── THE REVIEW SCREEN DOES NOT TURN WITH THE HOLD (2026-09-03) ────────────
//
// It did, for one day (item E): the root was rotated by the surface's chrome
// rotation and its box transposed, so a portrait-locked framebuffer held
// sideways showed the review upright. Owner, 2026-09-03: "the pano UI does not
// rotate in landscape currently — why does the pano+ rotate?" Pano's review is
// laid out in the portrait framebuffer and turns with nothing; pano+ now does
// the same in every hold. The PICTURE inside is still world-upright — that is
// the engine's bake (`panoPlusUprightRotationDeg`), which is untouched.
describe('the review screen is laid out in the framebuffer, whichever way the phone is held', () => {
  let rig: Rig | null = null;
  afterEach(() => { rig?.unmount(); rig = null; heldAs = 'portrait'; });

  function rootStyle(r: Rig): Record<string, unknown> {
    const style = r.propsOf('panoplus-result').style;
    const flat = (Array.isArray(style) ? style : [style])
      .filter((x) => x != null)
      .reduce<Record<string, unknown>>(
        (acc, x) => ({ ...acc, ...(x as Record<string, unknown>) }),
        {},
      );
    return flat;
  }

  it('never carries a transform, in any hold', () => {
    for (const hold of ['portrait', 'landscape-left', 'landscape-right'] as const) {
      heldAs = hold;
      rig = mount(fieldResult());
      const st = rootStyle(rig);
      expect(st.transform).toBeUndefined();
      // The box is the framebuffer, not a transpose of it.
      expect(st.left).toBe(0);
      expect(st.top).toBe(0);
      expect(st.width as number).toBeLessThan(st.height as number);
      rig.unmount();
      rig = null;
    }
  });

  it('the controls are present in a sideways hold — item F stands', () => {
    heldAs = 'landscape-right';
    rig = mount(fieldResult());
    for (const id of CONTROLS) expect(rig.has(id)).toBe(true);
    rig.expand();
    for (const id of CONTROLS) expect(rig.has(id)).toBe(true);
  });
});
