// SPDX-License-Identifier: Apache-2.0
/**
 * `RectCropPreview` — the component the sweep review now IS.
 *
 * ── WHY THIS FILE EXISTS ────────────────────────────────────────────────
 *
 * ef4e95a deleted `PanoPlusResultView` and routed the sweep through this
 * component, so it became the review for EVERY engine. Nothing in the
 * package rendered it. An adversarial round measured two one-line
 * regressions that no test could see:
 *
 *   * `<Modal visible={visible}>` stops honouring the prop — the review sits
 *     permanently over the live viewfinder on every engine, swallowing
 *     touches. That is the iOS modal-stacking dead-shutter class this
 *     project has already shipped once.
 *   * `source={{ uri: imageUri }}` stops reading `imageUri` — the review
 *     shows the wrong image, or nothing, on every engine. That is exactly
 *     the blocker f769cba fixed one layer up, and it would have reappeared
 *     here undetected.
 *
 * Both are the whole point of the component, and both were free.
 */
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { RectCropPreview } from '../RectCropPreview';

const BASE = {
  imageUri: 'file:///var/mobile/Documents/pano_1/canvas.jpg',
  imageWidth: 4000,
  imageHeight: 1200,
  onConfirm: () => undefined,
  onUseOriginal: () => undefined,
  onRetake: () => undefined,
};

function mount(over: Partial<Record<string, unknown>> = {}): ReactTestRenderer {
  let t!: ReactTestRenderer;
  act(() => {
    const props: Record<string, unknown> = { ...BASE, visible: true };
    Object.assign(props, over);
    t = create(
      <RectCropPreview
        {...(props as unknown as React.ComponentProps<typeof RectCropPreview>)}
      />,
    );
  });
  return t;
}

/** The one `<Modal>` this component renders. */
function modal(t: ReactTestRenderer): Record<string, unknown> {
  const all = t.root.findAll(
    (n) => (n.type as unknown) === 'Modal', { deep: true },
  );
  if (all.length !== 1) throw new Error(`expected 1 Modal, found ${all.length}`);
  return all[0].props as Record<string, unknown>;
}

/** Every `<Image>` source uri the review painted. */
function imageUris(t: ReactTestRenderer): string[] {
  return t.root
    .findAll((n) => (n.type as unknown) === 'Image', { deep: true })
    .map((n) => (n.props as { source?: { uri?: string } }).source?.uri ?? '')
    .filter((u) => u !== '');
}

/** Fire the canvas `onLayout` so the image box resolves. */
function layout(t: ReactTestRenderer, w = 390, h = 700): void {
  const nodes = t.root.findAll(
    (n) => typeof (n.props as { onLayout?: unknown }).onLayout === 'function',
    { deep: true },
  );
  act(() => {
    for (const n of nodes) {
      (n.props as { onLayout: (e: unknown) => void }).onLayout({
        nativeEvent: { layout: { x: 0, y: 0, width: w, height: h } },
      });
    }
  });
}

describe('RectCropPreview — the shared review', () => {
  it('⚑ `visible` reaches the Modal — it is not pinned open', () => {
    // A modal that ignores `visible` sits over the live viewfinder for the
    // rest of the session and swallows every touch.
    expect(modal(mount({ visible: true })).visible).toBe(true);
    expect(modal(mount({ visible: false })).visible).toBe(false);
  });

  it('⚑ the review paints the uri it was GIVEN', () => {
    // The blocker one layer up was a review that opened on a path `<Image>`
    // cannot load. If this stops reading `imageUri`, that returns silently.
    const t = mount();
    layout(t);
    expect(imageUris(t)).toContain(BASE.imageUri);
  });

  it('⚑ …and a DIFFERENT uri paints differently — not a constant', () => {
    // Negative control: without it the case above passes for a hardcoded
    // source, which is the same defect wearing a different hat.
    const other = 'file:///var/mobile/Documents/pano_2/canvas.jpg';
    const t = mount({ imageUri: other });
    layout(t);
    expect(imageUris(t)).toContain(other);
    expect(imageUris(t)).not.toContain(BASE.imageUri);
  });

  it('⚑ Retake and Confirm are distinct channels', () => {
    // The sweep's whole reason for deferring is that Retake must discard and
    // Confirm must emit. Both arrive through this component.
    const seen: string[] = [];
    const t = mount({
      showCropControls: false,
      onUseOriginal: () => { seen.push('use'); },
      onRetake: () => { seen.push('retake'); },
    });
    layout(t);
    const press = (label: RegExp) => {
      const n = t.root.findAll(
        (x) => typeof (x.props as { onPress?: unknown }).onPress === 'function'
          && label.test(String(
            (x.props as { accessibilityLabel?: string }).accessibilityLabel ?? '',
          )),
        { deep: true },
      )[0];
      if (n == null) throw new Error(`no pressable matching ${String(label)}`);
      act(() => { (n.props as { onPress: () => void }).onPress(); });
    };
    press(/retake/i);
    expect(seen).toEqual(['retake']);
  });
});
