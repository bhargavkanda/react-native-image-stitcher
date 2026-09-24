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
>(function SweepEngineHarness({ enabled = true, ...props }, ref): React.JSX.Element {
  const engine = useSweepEngine(props, ref, { enabled });
  return <SweepHatchScreen surfaceProps={props} engine={engine} />;
});
