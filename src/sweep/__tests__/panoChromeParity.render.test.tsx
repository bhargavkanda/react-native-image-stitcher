// SPDX-License-Identifier: Apache-2.0
//
// PanoChrome IS Pano's chrome — checked against the public package, not claimed.
//
// ── WHY THIS FILE EXISTS ───────────────────────────────────────────────────
//
// Owner, 2026-09-03: *"I want the UI for pano+ to be EXACTLY same as pano."*
// The requirement is a comparison between two screens, and the half of it that
// this repo can break silently is the copy: `PanoArToggle` / `PanoLensChip`
// reproduce `ARToggle` / `LensChip` from `react-native-image-stitcher`'s
// `Camera.tsx` style-for-style, because neither is exported from that package
// and the package is PUBLIC — widening its API, or carrying a patch to do it,
// is the boundary this project does not cross (`stitcherPatchesEmpty.test.ts`
// machine-checks that the overlay stays empty). A copy is the only lawful
// option here; a copy that nothing checks is a copy that drifts.
//
// The drift is invisible by construction: the stitcher bumps its pill radius,
// Pano's chip changes on the next `npm install`, pano+'s does not, every test
// in this repo still passes, and the two screens differ in exactly the way the
// owner asked them not to. This file makes that a red suite instead.
//
// ── WHAT IT CHECKS, AND AGAINST WHICH COPY ─────────────────────────────────
//
// Two installs of the package exist in this working tree and they are NOT the
// same version — camera-sdk's devDependency (which is what `tsc` reads) and
// the app's (which is what Metro bundles and what therefore SHIPS). Both are
// checked when both are present, because the one that ships is the one the
// operator compares against and the one that type-checks is the one a
// developer reads. The pill STYLE BLOCKS are byte-identical across the two
// today; the component bodies are not (0.24.2 labels the pill
// `${ultraWideFactor}×` when the device reports a factor), which is exactly
// why this file pins the styles and the accessibility contract rather than the
// rendered glyph — see the `uwLabel` note on the last case.
//
//   1. The premise: upstream still exports NEITHER pill, and still DOES export
//      `CameraShutter`. If (1) ever flips, this file's subject should be
//      deleted and the real component imported — the failure says so.
//   2. Fidelity: every style property upstream declares for the four entries
//      the AR pill uses, and the five the lens chip uses, is the property the
//      cloned component actually paints. Read off the RENDERED tree, so a
//      style declared and not applied fails too.
//   3. Only the GLYPH turns. Pano rotates the label `<Text>` and never the
//      pill container; pano+'s chrome rotation was removed on the same day for
//      the same requirement ("the pano UI does not rotate in landscape
//      currently — why does the pano+ rotate?"), and this is the guard that
//      keeps a container transform from creeping back in.
//
// ⚠️ THIS FILE MUST LIVE IN `__tests__/` — the BUILD config's `**/*.test.ts`
// exclude does not match `.tsx`, so a render test beside its component
// compiles into `dist/` and breaks `npm run build` on react-test-renderer's
// missing declarations. Its siblings carry the same warning.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import * as fs from 'fs';
import * as path from 'path';
import * as React from 'react';
import TestRenderer, {
  act,
  type ReactTestInstance,
  type ReactTestRenderer,
} from 'react-test-renderer';
import { StyleSheet } from 'react-native';

import { PanoArToggle, PanoLensChip } from '../chrome';
import { panoBottomChromePt } from '../PanoPlusCaptureSurface';

/** One installed copy of the public package's camera source. */
interface StitcherCopy {
  /** How a failure names it — the reader has to know WHICH install broke. */
  label: string;
  src: string;
  indexSrc: string;
}

/**
 * The installs to check, in the order a reader should care about them.
 *
 * Resolved by PATH rather than by `require.resolve`, deliberately: the render
 * project maps `react-native-image-stitcher` to a mock (jest.config.js), and a
 * resolver-based lookup here would be one config edit away from reading the
 * mock's directory and passing vacuously. A path also states out loud that
 * there are two installs and which one ships.
 */
function stitcherCopies(): StitcherCopy[] {
  // ⚠ REWRITTEN FOR IN-PACKAGE USE. This test was written when the clone
  // lived in a DIFFERENT package and had to find installed copies of this
  // one under node_modules — two of them, because the SDK and the app each
  // had their own and they could disagree. The clone now lives HERE, so
  // there is exactly one upstream and it is a sibling file.
  //
  // The check it performs is unchanged: the clone's styles must still match
  // what `Camera.tsx` declares, and the index must still export the pills.
  const camera = path.resolve(__dirname, '../../camera/Camera.tsx');
  const index = path.resolve(__dirname, '../../index.ts');
  if (!fs.existsSync(camera) || !fs.existsSync(index)) {
    // Not a skip. An empty list makes `describe.each` throw, and the length
    // assertion below says why — both louder than a green run over nothing.
    return [];
  }
  return [{
    label: 'this package (the clone lives beside it now)',
    src: fs.readFileSync(camera, 'utf8'),
    indexSrc: fs.readFileSync(index, 'utf8'),
  }];
}

const COPIES = stitcherCopies();

/** Comments out — the blocks carry them (`nativeUwPill` explains its outline)
 *  and they would fail the pure-data check below for no reason. */
function stripComments(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

/**
 * `const <name> = StyleSheet.create({ … })` from the source, as DATA.
 *
 * Brace-matched rather than regex-terminated so a nested style object cannot
 * end the block early, then whitelist-checked: if upstream ever puts a
 * computed value (a token, a helper call, a spread) in one of these blocks,
 * the check fails loudly HERE with a message a human can act on, instead of
 * the eval below doing something surprising with the package's source.
 */
function upstreamStyles(
  src: string, name: string,
): Record<string, Record<string, unknown>> {
  const head = `const ${name} = StyleSheet.create({`;
  const at = src.indexOf(head);
  if (at < 0) {
    throw new Error(
      `upstream no longer declares \`${name}\` — Pano's pill was renamed or `
      + 'restructured, and PanoChrome.tsx has to be re-read against it.',
    );
  }
  const open = at + head.length - 1;  // the `{` of the object literal
  let depth = 0;
  let close = -1;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) { close = i; break; }
    }
  }
  if (close < 0) throw new Error(`unbalanced braces in ${name}`);
  const literal = stripComments(src.slice(open, close + 1));
  if (!/^[A-Za-z0-9_'"#(),.:{}\s-]*$/.test(literal)) {
    throw new Error(
      `${name} is no longer plain data — re-read it by hand before trusting `
      + 'this comparison.',
    );
  }
  // Evaluated only AFTER the whitelist above has proved the text is object
  // literals, numbers and quoted strings — a hand-rolled parser for the same
  // grammar would be more code and one more thing to be subtly wrong about.
  // The input is this package's own dependency, already executed at runtime.
  return new Function(`"use strict"; return (${literal});`)() as Record<
    string, Record<string, unknown>
  >;
}

/** What a node actually paints: its style array, flattened the way RN would. */
function painted(node: ReactTestInstance): Record<string, unknown> {
  return StyleSheet.flatten(
    node.props.style as never,
  ) as unknown as Record<string, unknown>;
}

/** Mount, hand back the tree, and always unmount — no renderer outlives its
 *  case (the sibling suites' rule). */
function withRender(
  el: React.ReactElement,
  body: (root: ReactTestInstance) => void,
): void {
  let renderer!: ReactTestRenderer;
  act(() => { renderer = TestRenderer.create(el); });
  try {
    body(renderer.root);
  } finally {
    act(() => { renderer.unmount(); });
  }
}

/** The AR pill's own `Pressable`, and the `Text` inside it. */
function arNodes(root: ReactTestInstance): {
  pill: ReactTestInstance; label: ReactTestInstance;
} {
  const pill = root.findAllByProps({ accessibilityRole: 'switch' })[0];
  if (pill == null) throw new Error('no AR pill rendered');
  return { pill, label: pill.findAllByType('Text' as never)[0] };
}

/**
 * The HOST node carrying `testID` — the `View`, not the React element.
 *
 * `findAllByProps` matches the COMPONENT element too (it was handed the same
 * `testID` prop), and that element paints nothing: reading `[0]` there gave an
 * empty style object and a green comparison against a container that had never
 * been checked. Filtering on a string `type` is what makes this the rendered
 * box.
 */
function hostByTestID(root: ReactTestInstance, testID: string): ReactTestInstance {
  const node = root
    .findAll((n) => n.props.testID === testID && typeof n.type === 'string')[0];
  if (node == null) throw new Error(`no host node with testID ${testID}`);
  return node;
}

/** One lens pill by its accessibility label, and its `Text`. */
function lensNodes(root: ReactTestInstance, a11y: string): {
  pill: ReactTestInstance; label: ReactTestInstance;
} {
  const pill = root.findAllByProps({ accessibilityLabel: a11y })[0];
  if (pill == null) throw new Error(`no lens pill labelled ${a11y}`);
  return { pill, label: pill.findAllByType('Text' as never)[0] };
}

/**
 * Assert every property upstream declares is painted on `node`.
 *
 * ONE-DIRECTIONAL, and honestly so: it cannot compare key SETS, because a
 * rendered pill legitimately carries the merge of two upstream entries (`pill`
 * + `pillActive`) and equality would fail on the correct case. What guards the
 * other direction — a local style Pano does not have — is the handful of
 * explicit `toBeUndefined()` checks in the cases below, on exactly the
 * properties a divergence would show up in (the inactive pill's fill, any
 * container `transform`).
 *
 * The assertion carries `where` and the key INSIDE the compared value so a
 * failure names the entry and the property rather than printing two colours.
 */
function matchesUpstream(
  node: ReactTestInstance,
  upstream: Record<string, unknown>,
  where: string,
): void {
  const actual = painted(node);
  for (const [k, v] of Object.entries(upstream)) {
    expect([where, k, actual[k]]).toEqual([where, k, v]);
  }
}

describe('the clone\'s justification still holds', () => {
  it('finds the upstream it is cloned from', () => {
    // A silent zero-copy run is the one way this whole file could pass while
    // checking nothing at all — and a silent ONE-copy run where two were
    // expected is the same failure, just harder to see in the summary.
    expect(COPIES.length).toBe(1);
  });

  it.each(COPIES.map((c) => [c.label, c] as const))(
    'exports the shutter AND the two pills, which the copy cannot yet use — %s',
    (_label, copy) => {
      // ⚠ THIS ASSERTION FIRED AND HAS BEEN RETARGETED, 2026-09-18.
      //
      // It used to read `not.toMatch(/ARToggle/)` — "the pills cannot be
      // imported, so the copy is justified" — and it was written to go RED
      // the day that stopped being true. It went red: the stitcher now
      // exports both (`export { LensChip, ARToggle }`).
      //
      // Deleting PanoChrome was NOT the next step, and flipping this test
      // green would have hidden why. The PROP SHAPES diverged while the two
      // were apart:
      //
      //   · rotation — copy takes `glyphRotateDeg: number`, upstream takes
      //     `contentRotation: { transform }`. Mechanical, two call sites.
      //   · `has1x` — the copy has it and upstream does not, and it is not
      //     cosmetic: the sweep's AVFoundation source can REFUSE a wide
      //     (`panoplus-no-wide`, or a wide with no 4:3 at 60 fps), and a
      //     pill offering a lens that will be refused is a pill that lies.
      //     vision-camera cannot produce that state, so upstream never
      //     needed the prop.
      //
      // Closing the gap means widening a SHIPPED public component with
      // `has1x` and re-verifying it on a device. That is its own change, not
      // a rider on a file move. Until then the copy stays and this test pins
      // the exact remaining distance.
      expect(copy.indexSrc).toMatch(/export \{ CameraShutter \}/);
      expect(copy.indexSrc).toMatch(/export \{ LensChip, ARToggle \}/);
      expect(copy.src).toMatch(/^export function ARToggle\(/m);
      expect(copy.src).toMatch(/^export function LensChip\(/m);
      // The gap itself. When BOTH of these flip, delete PanoChrome.tsx and
      // import from the package instead.
      expect(copy.src).not.toMatch(/\bhas1x\b/);
      expect(copy.src).not.toMatch(/glyphRotateDeg/);
    },
  );

  it.each(COPIES.map((c) => [c.label, c] as const))(
    'pano+ anchors its bottom bar at the SAME inset Pano does — %s',
    (_label, copy) => {
      // THE ONE NUMBER THAT PUT THE TWO CHIPS AT DIFFERENT HEIGHTS. Pano's
      // bottom area is `paddingBottom: insets.bottom + N` (`Camera.tsx`, the
      // `bottomAreaStyleForEdge` call), the inner bar adds no vertical padding
      // on the bottom edge, and both bars are lifted by the same
      // `bottomBarOffset` — so N is the whole of the anchor and pano+ must use
      // it verbatim. It was hardcoded to 16 from a uiautomator dump that had
      // measured the PILL rather than its row container, which is 3 pt larger,
      // and 4 pt of that error went straight into the gap between the modes.
      //
      // Read from the INSTALLED package so the number cannot drift silently on
      // an upgrade: if Pano moves its bar, this fails and names the new value.
      const m = copy.src.match(
        /bottomAreaStyleForEdge\(\s*homeIndicatorEdge\([^)]*\),\s*insets\.bottom \+ (\d+)/,
      );
      expect(m).not.toBeNull();
      const panoInset = Number(m![1]);
      // `panoBottomChromePt` is the only consumer, and with the built-in
      // shutter hidden it is `inset + LENS_CHIP_HEIGHT(36) + 8`.
      expect(panoBottomChromePt(0, 0, true) - 44).toBe(panoInset);
      // …and it tracks the safe-area and the offset it is handed, so the whole
      // anchor matches Pano's and not just its constant term.
      expect(panoBottomChromePt(21, 150, true) - 44).toBe(panoInset + 21 + 150);
    },
  );
});

describe.each(COPIES.map((c) => [c.label, c] as const))(
  'PanoChrome paints what Pano declares — %s',
  (_label, copy) => {
    const ar = upstreamStyles(copy.src, 'arToggleStyles');
    const chip = upstreamStyles(copy.src, 'lensChipStyles');

    it('the AR pill, off: container + label', () => {
      withRender(
        <PanoArToggle arEnabled={false} onToggle={() => undefined} />,
        (root) => {
          const { pill, label } = arNodes(root);
          matchesUpstream(pill, ar.container, 'arToggleStyles.container');
          matchesUpstream(label, ar.label, 'arToggleStyles.label');
          // OFF must not carry the ON overrides — a pill that always looked
          // filled would read as "AR is on" on the decoupled arm.
          expect(painted(pill).backgroundColor).toBe(ar.container.backgroundColor);
          expect(painted(label).color).toBe(ar.label.color);
        },
      );
    });

    it('the AR pill, on: the two ON overrides and nothing else', () => {
      withRender(
        <PanoArToggle arEnabled onToggle={() => undefined} />,
        (root) => {
          const { pill, label } = arNodes(root);
          matchesUpstream(pill, ar.containerOn, 'arToggleStyles.containerOn');
          matchesUpstream(label, ar.labelOn, 'arToggleStyles.labelOn');
          // The base entries survive underneath, exactly as Pano's array does.
          expect(painted(pill).borderRadius).toBe(ar.container.borderRadius);
          expect(painted(label).fontWeight).toBe(ar.label.fontWeight);
        },
      );
    });

    it('the lens switcher: row container, both pills, the active one', () => {
      withRender(
        <PanoLensChip lens="1x" onChange={() => undefined} testID="chip" />,
        (root) => {
          const row = hostByTestID(root, 'chip');
          matchesUpstream(row, chip.container, 'lensChipStyles.container');
          const uw = lensNodes(root, '0.5x ultra-wide lens');
          const wide = lensNodes(root, '1x wide-angle lens');
          matchesUpstream(uw.pill, chip.pill, 'lensChipStyles.pill');
          matchesUpstream(wide.pill, chip.pill, 'lensChipStyles.pill');
          matchesUpstream(
            wide.pill, chip.pillActive, 'lensChipStyles.pillActive',
          );
          matchesUpstream(
            wide.label, chip.labelActive, 'lensChipStyles.labelActive',
          );
          matchesUpstream(uw.label, chip.label, 'lensChipStyles.label');
          // The INACTIVE pill must not carry the active fill: two filled pills
          // is a switcher that cannot say which lens is running.
          expect(painted(uw.pill).backgroundColor).toBeUndefined();
          expect(painted(uw.label).color).toBe(chip.label.color);
        },
      );
    });

    it('the selection follows the prop, on the other lens too', () => {
      withRender(
        <PanoLensChip lens="0.5x" onChange={() => undefined} />,
        (root) => {
          const uw = lensNodes(root, '0.5x ultra-wide lens');
          const wide = lensNodes(root, '1x wide-angle lens');
          matchesUpstream(uw.pill, chip.pillActive, 'lensChipStyles.pillActive');
          expect(painted(wide.pill).backgroundColor).toBeUndefined();
          expect(uw.pill.props.accessibilityState).toEqual({ selected: true });
          expect(wide.pill.props.accessibilityState).toEqual({ selected: false });
        },
      );
    });

    it('speaks the accessibility contract Pano\'s own dump shows', () => {
      // The A35 dump of the PANO screen (2026-09-03) names its three nodes
      // `0.5x ultra-wide lens`, `1x wide-angle lens`, `AR mode on|off` — a
      // screen reader on pano+ must hear the same words.
      //
      // ⚠ MATCHED AS PHRASES, NOT AS SOURCE LITERALS, and the two installs are
      // why: 0.22.0 writes the ultra-wide glyph as JSX text (`0.5×`) while
      // 0.24.2 builds the label from `uwLabel` and keeps `'0.5×'` only as the
      // fallback; both write the wide pill as an attribute
      // (`accessibilityLabel="1x wide-angle lens"`). Pinning the quoting would
      // fail on a reformat and say nothing about the screen.
      //
      // The ultra-wide label is the one place pano+ CAN legitimately differ
      // from Pano: on a device whose ultra-wide factor vision-camera reports,
      // Pano's pill reads `0.6×` and pano+ — which mounts no vision-camera
      // device and has no factor to read — takes upstream's own `0.5×`
      // fallback. On the A35 Pano itself falls back (its dump reads
      // `0.5x ultra-wide lens`), so the two agree on the phone this was built
      // for. What is pinned here is that the fallback still EXISTS upstream.
      expect(copy.src).toMatch(/0\.5×/);
      expect(copy.src).toMatch(/ultra-wide lens/);
      expect(copy.src).toMatch(/1x wide-angle lens/);
      expect(copy.src).toMatch(/AR mode \$\{arEnabled \? 'on' : 'off'\}/);
      withRender(
        <PanoLensChip lens="1x" onChange={() => undefined} />,
        (root) => {
          expect(lensNodes(root, '0.5x ultra-wide lens').label.children)
            .toEqual(['0.5×']);
          expect(lensNodes(root, '1x wide-angle lens').label.children)
            .toEqual(['1×']);
        },
      );
      withRender(
        <PanoArToggle arEnabled onToggle={() => undefined} />,
        (root) => {
          const { pill, label } = arNodes(root);
          expect(pill.props.accessibilityLabel).toBe('AR mode on');
          expect(pill.props.accessibilityState).toEqual({ checked: true });
          expect(label.children).toEqual(['AR']);
        },
      );
    });
  },
);

describe('only the GLYPH turns — the pill never does', () => {
  // This is requirement E, in the one place a rotation could come back. Pano
  // applies `useContentRotation()` to the label `<Text>` and nothing else;
  // pano+ had a chrome rotation that turned whole layout blocks and it was
  // removed on 2026-09-03 for this reason. A container transform here would
  // be that rotation returning through the copy.
  it('rotates the AR label and leaves the container square', () => {
    withRender(
      <PanoArToggle arEnabled onToggle={() => undefined} glyphRotateDeg={90} />,
      (root) => {
        const { pill, label } = arNodes(root);
        expect(painted(label).transform).toEqual([{ rotate: '90deg' }]);
        expect(painted(pill).transform).toBeUndefined();
      },
    );
  });

  it('rotates both lens glyphs and leaves both pills and the row square', () => {
    withRender(
      <PanoLensChip
        lens="1x"
        onChange={() => undefined}
        glyphRotateDeg={-90}
        testID="chip"
      />,
      (root) => {
        for (const a11y of ['0.5x ultra-wide lens', '1x wide-angle lens']) {
          const { pill, label } = lensNodes(root, a11y);
          expect(painted(label).transform).toEqual([{ rotate: '-90deg' }]);
          expect(painted(pill).transform).toBeUndefined();
        }
        expect(painted(hostByTestID(root, 'chip')).transform).toBeUndefined();
      },
    );
  });

  it('emits NO transform at all in the upright case', () => {
    // `panoGlyphRotationStyle` returns `{}` at 0° so React skips the layout
    // work — the same shape `useContentRotation()` returns. A `rotate: '0deg'`
    // here would be a behaviour difference from Pano on every portrait hold,
    // which is every hold on a portrait-locked host.
    withRender(
      <PanoArToggle arEnabled={false} onToggle={() => undefined} />,
      (root) => {
        expect(painted(arNodes(root).label).transform).toBeUndefined();
      },
    );
  });
});
