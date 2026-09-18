// SPDX-License-Identifier: Apache-2.0
/**
 * Pano's shutter, driven from a render test.
 *
 * Since 2026-09-03 pano+ has no Start / Done / Discard buttons of its own: it
 * is driven by Pano's `CameraShutter` — held 250 ms to start the sweep,
 * released to finish it. The render mock of `react-native-image-stitcher`
 * renders that shutter as a host node carrying every prop the surface gave it
 * (`jest.mocks/react-native-image-stitcher.render.js`), so a test presses and
 * releases by calling the SAME callbacks the real button would, and reads the
 * SAME `disabled` / `isProcessing` the real button paints.
 *
 * Shared by every pano+ render suite so "hold" means one thing everywhere.
 * Not a test file — the pure project's `testMatch` needs `.test.` in the name.
 */

import { act, type ReactTestInstance } from 'react-test-renderer';

interface Root {
  findAllByProps: (props: Record<string, unknown>) => ReactTestInstance[];
}

/** The shutter's props — the host node the mock renders, which carries them. */
export function shutterProps(root: Root): Record<string, unknown> {
  const nodes = root.findAllByProps({ testID: 'camera-shutter' });
  const host = nodes.find((n) => typeof n.props.onHoldStart === 'function');
  if (host == null) throw new Error('no CameraShutter is rendered');
  return host.props as Record<string, unknown>;
}

/** Press and hold past the threshold: `onHoldStart` — the sweep starts. */
export function holdShutter(root: Root): void {
  const onHoldStart = shutterProps(root).onHoldStart as () => void;
  act(() => { onHoldStart(); });
}

/** Lift the finger after a hold: `onHoldComplete` — the sweep finishes. */
export function releaseShutter(root: Root): void {
  const onHoldComplete = shutterProps(root).onHoldComplete as () => void;
  act(() => { onHoldComplete(); });
}

/** A short tap: `onTap` — inert on pano+, and a test may say so. */
export function tapShutter(root: Root): void {
  const onTap = shutterProps(root).onTap as () => void;
  act(() => { onTap(); });
}

/** What the shutter would paint: greyed-out (`disabled`), busy ring
 *  (`isProcessing`). `CameraShutter` refuses a press-in on either. */
export function shutterState(root: Root): { disabled: boolean; busy: boolean } {
  const p = shutterProps(root);
  return { disabled: p.disabled === true, busy: p.isProcessing === true };
}
