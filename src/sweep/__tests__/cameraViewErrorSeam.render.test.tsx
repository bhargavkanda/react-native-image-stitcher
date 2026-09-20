// SPDX-License-Identifier: Apache-2.0
/**
 * `CameraView`'s two error seams — and the ORDER, which is the whole fix.
 *
 * ── WHY THIS FILE EXISTS ────────────────────────────────────────────────
 *
 * `CameraView` deliberately SWALLOWS three transient vision-camera codes so
 * routine screen-lock / app-switch churn is not reported to the host as a
 * crash. Those same three are exactly the ones that leave a preview dark
 * with nothing else to say — so the sweep's "why is this black" caption
 * hangs off `onAnyError`, which fires BEFORE the filter.
 *
 * That ordering IS the fix, and an adversarial round found it had no
 * falsifiable test anywhere: every `onAnyError` reference in the package
 * invoked the PROP on a rendered element, so `handleVcError` — the function
 * that does the ordering — was never executed. The seam could be deleted, or
 * moved below the filter it exists to bypass, with the whole suite green.
 */
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { Camera as VisionCamera } from 'react-native-vision-camera';

import { CameraView } from '../../camera/CameraView';

/** The three codes `CameraView` swallows — the reason the seam exists. */
const SWALLOWED = [
  'system/camera-is-restricted',
  'system/camera-has-been-disconnected',
  'device/camera-already-in-use',
];

/** A plausible back camera — `CameraView` renders a placeholder without one. */
const DEVICE = {
  id: 'back-0',
  position: 'back',
  physicalDevices: ['wide-angle-camera'],
  hasTorch: true,
  minZoom: 1,
  maxZoom: 8,
  neutralZoom: 1,
  formats: [],
  isMultiCam: false,
  supportsFocus: true,
  name: 'back-0',
};

function mount(props: Record<string, unknown>): ReactTestRenderer {
  let t!: ReactTestRenderer;
  act(() => {
    t = create(<CameraView device={DEVICE as never} {...(props as any)} />);
  });
  return t;
}

/** Fire the INNER vision-camera `onError`, i.e. drive the real filter. */
function raise(tree: ReactTestRenderer, code: string): void {
  const inner = tree.root.findAllByType(VisionCamera);
  if (inner.length !== 1) {
    throw new Error(`expected one inner camera, found ${inner.length}`);
  }
  act(() => {
    (inner[0].props.onError as (e: unknown) => void)({ code, message: code });
  });
}

describe('CameraView — onAnyError fires BEFORE the swallow filter', () => {
  it('⚑ a SWALLOWED code reaches onAnyError and NOT onError', () => {
    for (const code of SWALLOWED) {
      const any: unknown[] = [];
      const host: unknown[] = [];
      const tree = mount({
        onAnyError: (e: unknown) => { any.push(e); },
        onError: (e: unknown) => { host.push(e); },
      });
      raise(tree, code);
      // The seam sees it…
      expect(any).toHaveLength(1);
      // …and the host's crash-reporting path still does not.
      expect(host).toHaveLength(0);
      act(() => { tree.unmount(); });
    }
  });

  it('⚑ NEGATIVE CONTROL: a forwarded code reaches BOTH', () => {
    // Without this the case above passes for a seam that fires on nothing,
    // or for a filter that swallows everything.
    const any: unknown[] = [];
    const host: unknown[] = [];
    const tree = mount({
      onAnyError: (e: unknown) => { any.push(e); },
      onError: (e: unknown) => { host.push(e); },
    });
    raise(tree, 'device/fatal-error');
    expect(any).toHaveLength(1);
    expect(host).toHaveLength(1);
    act(() => { tree.unmount(); });
  });

  it('⚑ …and it is ADDITIVE — a host that passes no onAnyError is unaffected', () => {
    // The seam must not change what an existing caller sees.
    const host: unknown[] = [];
    const tree = mount({ onError: (e: unknown) => { host.push(e); } });
    raise(tree, 'device/fatal-error');
    expect(host).toHaveLength(1);
    raise(tree, 'device/camera-already-in-use');
    expect(host).toHaveLength(1);   // still swallowed
    act(() => { tree.unmount(); });
  });
});
