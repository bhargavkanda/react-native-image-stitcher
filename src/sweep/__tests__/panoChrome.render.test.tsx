// SPDX-License-Identifier: Apache-2.0
//
// PANO'S CHIP OFFERS ONLY LENSES THE BODY CAN OPEN — and never drops the one
// that is selected.
//
// pano+ ⇄ Pano parity (2026-09-03): `PanoLensChip` reproduces Pano's `LensChip`
// (`react-native-image-stitcher/src/camera/Camera.tsx:1187-1272`), including
// the single-lens branch Pano shows when `has0_5x` is false. pano+'s answer to
// `has0_5x` is `panoPlusLensAvailability()`, which asks the SAME selector the
// sweep opens through (`RNISPanoAvfSource.planFormat`) once per lens — so
// "offered" and "openable" cannot drift apart.
//
// The property under test: A PILL IS SHOWN EXACTLY WHEN THE ARM COULD OPEN IT
// OR IT IS THE CURRENT SELECTION. Two failures it forbids:
//   * a `0.5×` pill on a body that publishes no ultra-wide — tapping it moves
//     the flag into a sweep the planner will refuse (`panoplus-no-ultrawide`);
//   * a chip with the SELECTED lens missing from it, which shows a selection
//     the operator can neither see nor move.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import * as React from 'react';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';

import { PanoLensChip, panoGlyphRotationStyle } from '../chrome';
import type { PanoLens } from '../chrome';

/**
 * The rendered tree, read through `toJSON()` rather than `findAllByType` —
 * this package's `ReactTestInstance` typing carries `findAllByProps` and not
 * the type-based finders, and the house idiom in every other render suite is
 * to query by props. Text has no testID here BECAUSE Pano's has none.
 */
interface JsonNode {
  type: string;
  props: Record<string, unknown>;
  children: unknown[] | null;
}

function isNode(v: unknown): v is JsonNode {
  return typeof v === 'object' && v !== null && 'type' in v && 'children' in v;
}

/** Every `Text` node in render order. */
function textNodes(v: unknown, out: JsonNode[] = []): JsonNode[] {
  if (Array.isArray(v)) {
    for (const c of v) textNodes(c, out);
  } else if (isNode(v)) {
    if (v.type === 'Text') out.push(v);
    else textNodes(v.children, out);
  }
  return out;
}

function textOf(n: JsonNode): string {
  const flat: string[] = [];
  const walk = (v: unknown): void => {
    if (typeof v === 'string') flat.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (isNode(v)) walk(v.children);
  };
  walk(n.children);
  return flat.join('');
}

interface Rig {
  /** `true` when a tappable pill with this testID suffix is in the tree. */
  pill: (suffix: '0_5x' | '1x') => boolean;
  /** Every `<Text>` string the chip rendered, in order. */
  labels: () => string[];
  /** The style array the first label carries (glyph rotation lives here). */
  labelStyle: () => unknown;
  taps: PanoLens[];
  unmount: () => void;
}

function mount(props: {
  lens: PanoLens;
  has0_5x?: boolean;
  has1x?: boolean;
  glyphRotateDeg?: number;
}): Rig {
  let renderer!: ReactTestRenderer;
  const taps: PanoLens[] = [];
  act(() => {
    renderer = TestRenderer.create(
      <PanoLensChip
        lens={props.lens}
        onChange={(l) => taps.push(l)}
        has0_5x={props.has0_5x}
        has1x={props.has1x}
        glyphRotateDeg={props.glyphRotateDeg}
        testID="chip"
      />,
    );
  });
  return {
    pill: (suffix) =>
      renderer.root.findAllByProps({ testID: `chip-${suffix}` }).length > 0,
    labels: () => textNodes(renderer.toJSON()).map(textOf),
    labelStyle: () => textNodes(renderer.toJSON())[0]?.props.style,
    taps,
    unmount: () => { act(() => { renderer.unmount(); }); },
  };
}

describe('both lenses available — Pano’s two-pill chip, unchanged', () => {
  it('offers both pills and reports the tap in Pano’s own vocabulary', () => {
    const r = mount({ lens: '0.5x', has0_5x: true, has1x: true });
    expect(r.pill('0_5x')).toBe(true);
    expect(r.pill('1x')).toBe(true);
    expect(r.labels()).toEqual(['0.5×', '1×']);
    r.unmount();
  });

  it('defaults to both when nothing was measured — silence is not a hardware claim', () => {
    // Android (`panoPlusLensAvailability` → null) and any build whose
    // calibration module cannot be asked land here. Hiding a pill because
    // nobody answered would be a NO invented out of a missing answer.
    const r = mount({ lens: '1x' });
    expect(r.pill('0_5x')).toBe(true);
    expect(r.pill('1x')).toBe(true);
    r.unmount();
  });
});

describe('a lens this body cannot open is not offered', () => {
  it('collapses to Pano’s static 1× when there is no ultra-wide', () => {
    // Pano's own case (`Camera.tsx:1222-1227`): one usable lens, nothing to
    // switch, a label rather than a control.
    const r = mount({ lens: '1x', has0_5x: false, has1x: true });
    expect(r.pill('0_5x')).toBe(false);
    expect(r.pill('1x')).toBe(false);
    expect(r.labels()).toEqual(['1×']);
    r.unmount();
  });

  it('collapses to a static 0.5× when the WIDE is the refused one', () => {
    // `panoplus-no-wide`, or a wide with no 4:3 format at 60 fps. Pano
    // hard-codes `1×` here because vision-camera cannot produce this body;
    // the label names the surviving lens instead of asserting the wrong one.
    const r = mount({ lens: '0.5x', has0_5x: true, has1x: false });
    expect(r.pill('0_5x')).toBe(false);
    expect(r.labels()).toEqual(['0.5×']);
    r.unmount();
  });

  it('the collapsed label still turns with the hold, like every Pano glyph', () => {
    const r = mount({ lens: '1x', has0_5x: false, glyphRotateDeg: 90 });
    expect(JSON.stringify(r.labelStyle())).toContain('90deg');
    r.unmount();
  });

  it('is not tappable — a label, not a pill', () => {
    const r = mount({ lens: '1x', has0_5x: false });
    expect(
      r.pill('0_5x') || r.pill('1x'),
    ).toBe(false);
    expect(r.taps).toEqual([]);
    r.unmount();
  });
});

describe('the SELECTED pill is never dropped', () => {
  it('keeps 0.5× when the flag is on it, even with no ultra-wide on the body', () => {
    // `panoPlusLens` is a PERSISTED host flag, so it can already name a lens
    // this body does not publish. A chip that dropped it would show a
    // selection the operator can neither see nor move.
    const r = mount({ lens: '0.5x', has0_5x: false, has1x: true });
    expect(r.pill('0_5x')).toBe(true);
    expect(r.pill('1x')).toBe(true);
    r.unmount();
  });

  it('keeps 1× when the flag is on it and the wide is refused', () => {
    const r = mount({ lens: '1x', has0_5x: true, has1x: false });
    expect(r.pill('0_5x')).toBe(true);
    expect(r.pill('1x')).toBe(true);
    r.unmount();
  });

  it('never renders an empty chip — one of the two is always the selection', () => {
    for (const lens of ['0.5x', '1x'] as PanoLens[]) {
      const r = mount({ lens, has0_5x: false, has1x: false });
      expect(r.labels().length).toBeGreaterThan(0);
      r.unmount();
    }
  });
});

describe('panoGlyphRotationStyle — the stitcher’s useContentRotation shape', () => {
  it('is an EMPTY object at 0°, so React skips the transform entirely', () => {
    expect(panoGlyphRotationStyle(0)).toEqual({});
  });

  it('is a single rotate otherwise', () => {
    expect(panoGlyphRotationStyle(-90)).toEqual({
      transform: [{ rotate: '-90deg' }],
    });
  });
});
