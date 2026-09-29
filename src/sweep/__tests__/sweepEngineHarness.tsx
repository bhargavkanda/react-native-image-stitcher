// SPDX-License-Identifier: Apache-2.0
/**
 * M10 — a TEST-ONLY mount for the sweep engine.
 *
 * The sweep's own screen (`PanoPlusCaptureSurface`) is deleted: in the product
 * the engine is `useSweepEngine`, called by `<Camera>`, and what it draws is
 * `SweepHoldOverlay` (on the DR-1a hatch, `SweepHatchScreen`). The suites that
 * drove the engine through that screen — its handle, its start bag, its
 * status, its notices — still need a mount, and this is it: the real hook,
 * drawn by the hatch view (its viewfinder / explainer / fallback AR view and
 * the hold overlay). It has NO chrome — no pill, chip or shutter — because
 * the engine has none any more; the handle (`holdStart` / `holdEnd`) is how a
 * test presses the shutter.
 *
 * ⚠ `hostPreviewLive` DEFAULTS TO FALSE HERE, where the hook's own default is
 * true. This mount draws the hatch view, and `<Camera>` draws that view only
 * when its own preview is out of the tree — so on every render it sends the
 * hatch `hostPreviewLive: false`. A case that wants the other value (a
 * control on the engine's input) must say so, rather than inherit a
 * composition `<Camera>` never produces.
 *
 * Not a test file (no `.test.` in the name), so neither jest project collects
 * it.
 */
import React, { forwardRef } from 'react';

import { useSweepEngine } from '../useSweepEngine';
import { SweepHatchScreen } from '../SweepHatchScreen';
import type { SweepEngineProps } from '../sweepEngineProps';
import type { SweepSurfaceHandle } from '../panoPlusTypes';

export const SweepEngineHarness = forwardRef<
  SweepSurfaceHandle,
  SweepEngineProps & { enabled?: boolean }
>(function SweepEngineHarness(
  { enabled = true, hostPreviewLive = false, ...rest },
  ref,
): React.JSX.Element {
  const props: SweepEngineProps = { ...rest, hostPreviewLive };
  const engine = useSweepEngine(props, ref, { enabled });
  return <SweepHatchScreen surfaceProps={props} engine={engine} />;
});
