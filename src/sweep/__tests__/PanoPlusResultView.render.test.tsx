// SPDX-License-Identifier: Apache-2.0
//
// PanoPlusResultView — the v11 evidence lines, MOUNTED.
//
// ⚠ 2026-09-02: THE EVIDENCE LINES ARE NOW BEHIND ONE TAP, and these tests
// tap. That is not a weakening of the guarantee — it is the guarantee this
// file was written for, moved one interaction later. The operator could not
// see the CONTROLS because these same sentences were rendered unconditionally
// in a non-shrinkable block that pushed Close/Save/Share off the bottom of the
// display, so the screen now shows one verdict line with an expander. `expand()`
// below is what proves the relocation kept every line reachable; the sibling
// `PanoPlusResultView.layout.render.test.tsx` proves the controls came back.
//
// WHY THIS FILE EXISTS. `panoPlusModel.test.ts` proves the two new sentences
// are COMPUTED. It cannot prove they are RENDERED, and a verdict the operator
// never sees is worth exactly nothing — he is holding a Release field build with
// no console, so this screen is the channel.
//
// That gap is not hypothetical in this repo: the 2026-07-22 field bugs both
// lived in the wiring under correct, well-tested maths, which is why the render
// project exists at all. The specific failure this file forecloses is the one
// where `subjectDistanceLine` / `arExposureLine` are added to the integrity
// record and to its interface, compile clean on both sides, and are never
// added to the JSX — the seam where both halves build and neither can reach
// the other.
//
// ⚠️ THIS FILE MUST LIVE IN `__tests__/`, and the reason is not style. The
// BUILD config excludes `**/*.test.ts` and `**/__tests__/**` — the FIRST
// pattern does not match `.tsx`. Sitting beside its component this file
// compiled INTO `dist/` and broke `npm run build` on `react-test-renderer`
// (which ships no declarations; the ambient shim is itself inside a
// `__tests__/` dir and so is excluded from that program too). Caught by
// running the build rather than the test runner — the sibling
// PanoPlusCaptureSurface.render.test.tsx carries the same warning, and it
// still cost a build.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import * as React from 'react';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';

// The shared render mock (jest.mocks/react-native.render.js) is owned by the
// T2 surfaces and carries only the primitives THEY reach for. This screen also
// mounts PinchZoomView, which builds a `PanResponder` at render time. Extended
// LOCALLY rather than by editing the shared mock: that file is live in another
// workstream, and a gesture stub good enough for one screen's smoke test has
// no business becoming everyone's contract.
jest.mock('react-native', () => ({
  ...jest.requireActual('react-native'),
  PanResponder: {
    create: (config: Record<string, unknown>) => ({
      panHandlers: {},
      // Kept reachable so a future test can drive the gesture if it wants to;
      // nothing in THIS file touches it.
      __config: config,
    }),
  },
}));

import { PanoPlusResultView } from '../PanoPlusResultView';
import { coercePanoPlusSummary } from '../panoPlusModel';
import type { PanoPlusCaptureResult } from '../panoPlusTypes';

/** The three Test-13 field packs' shape, with the v11 grading the same sweeps
 *  would now carry (numbers recomputed from their own poses — see
 *  tools/t2-offline-harness/results/2026-08-30-panoplus-probe/job2-evidence). */
function resultWith(
  projection: Record<string, unknown>,
  exposure: Record<string, unknown>,
): PanoPlusCaptureResult {
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
        worstBandP50Px: 0.42, worstBandP95Px: 0.38, worstBandMaxPx: 0.63,
        bandSpreadP95Px: 0.5, crossBandDivergencePx: 52.4,
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
        sweepDeg: 35.1, subjectDistanceConfiguredM: 1.5, ...projection,
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
        ...exposure,
      },
    }),
  };
}

/** Open the collapsed report. Every `testID` this file asserts on lives
 *  inside it — see the header. */
function expand(tree: ReactTestRenderer): void {
  const [chip] = tree.root.findAllByProps({ testID: 'panoplus-integrity' });
  if (chip == null) throw new Error('no verdict chip to expand');
  const onPress = chip.props.onPress as (() => void) | undefined;
  if (onPress == null) throw new Error('the verdict chip has no onPress');
  act(() => { onPress(); });
}

function textAt(tree: ReactTestRenderer, testID: string): string {
  // `findAllByProps(...)[0]`, not `findByProps`: the render rig's ambient types
  // (`src/video/__tests__/renderTypes.d.ts`) declare only the plural form, and
  // the singular compiles under `jest` while failing `npm run typecheck:tests`
  // — a gate that runs on this file but not on the runner's happy path.
  const [node] = tree.root.findAllByProps({ testID });
  if (node == null) throw new Error(`no node with testID ${testID}`);
  const flat = (c: unknown): string =>
    Array.isArray(c) ? c.map(flat).join('') : String(c ?? '');
  return flat(node.props.children);
}

describe('PanoPlusResultView — the v11 evidence reaches the screen', () => {
  let tree: ReactTestRenderer | null = null;
  afterEach(() => {
    act(() => { tree?.unmount(); });
    tree = null;
  });

  it('renders the degenerate subject-distance warning and the AR exposure line',
    () => {
      const result = resultWith(
        {
          subjectDistanceFitM: 6.0,
          subjectDistanceUsedM: 6.0,
          subjectDistanceFit: {
            rawM: 495.84, clampLoM: 0.3, clampHiM: 6.0, saturated: true,
            clampedUpdates: 37, refusedUpdates: 75, den: 3.0145, num: 0.000197,
            samples: 439, fwdSpanM: 0.127, perpSpanM: 1.1627,
            leverRatio: 0.1092, leverBar: 0.2, perpFloorM: 0.01,
            degenerate: true, inForce: true,
          },
        },
        {
          ar: {
            frames: 438, minDurationS: 0.016566, maxDurationS: 0.024849,
            rangeRatio: 1.5, offsetMinEV: -0.5, offsetMaxEV: 0.5,
            pairedFrames: 438, maxAbsDeltaS: 0.008283, maxRelDelta: 0.5,
            probe: null,
          },
        },
      );

      act(() => {
        tree = TestRenderer.create(
          <PanoPlusResultView result={result} onDismiss={() => {}} />,
        );
      });
      const t = tree as unknown as ReactTestRenderer;
      expand(t);

      const subject = textAt(t, 'panoplus-integrity-subject-distance');
      expect(subject).toContain('SUBJECT DISTANCE NOT TRUSTWORTHY');
      expect(subject).toContain('CLAMP RAIL');
      expect(subject).toContain('495.84');

      const ar = textAt(t, 'panoplus-integrity-ar-exposure');
      expect(ar).toContain('ARKit exposure');
      expect(ar).toContain('did NOT reach the pixels');

      // The circular line is STILL THERE and still says LOCKED — the two are
      // meant to be read together, and removing the old one would hide the
      // very contradiction that makes the new one worth printing.
      expect(textAt(t, 'panoplus-integrity-exposure')).toContain('LOCKED');
    });

  it('renders the NOT READ state for a pack with no ARKit exposure at all',
    () => {
      const result = resultWith(
        { subjectDistanceFitM: 1.95, subjectDistanceUsedM: 1.95 },
        {},
      );
      act(() => {
        tree = TestRenderer.create(
          <PanoPlusResultView result={result} onDismiss={() => {}} />,
        );
      });
      const t = tree as unknown as ReactTestRenderer;
      expand(t);

      // v10 pack: the fit is present but ungraded, and that must NOT read as a
      // clean fit — it is the exact state all three field packs are in.
      expect(textAt(t, 'panoplus-integrity-subject-distance'))
        .toContain('NOT GRADED');
      expect(textAt(t, 'panoplus-integrity-ar-exposure')).toContain('NOT READ');
    });
});
