// SPDX-License-Identifier: Apache-2.0
/**
 * useSweepWorklet — hand vision-camera frames to the sweep engine (S5/S7).
 *
 * The non-AR sweep used to open its OWN Camera2 session beside the one
 * `<Camera>` already had. This is the JS half of the arm that stops it:
 * `panoplus_sweep_ingest` is a Frame Processor plugin on the session
 * `<Camera>` owns, and the recorder — which still owns the rotation-vector
 * SENSOR — supplies everything that is not pixels.
 *
 * ── DELIBERATELY SMALLER THAN `useStitcherWorklet` ──────────────────────
 * That hook synthesises a pose from the gyro, throttles by a cadence and
 * carries an intrinsics numerator, because the keyframe plugin needs all of
 * it passed IN. This one passes NOTHING but the frame: the sweep's attitude
 * is solved natively against the recorder's own timestamped ring (bracketed
 * and SLERPed to the frame's own clock), and its intrinsics come from
 * `CameraCharacteristics`. Synthesising a second pose here and handing it
 * over would be a second, worse answer to a question already answered
 * correctly one layer down — and the two would disagree silently.
 *
 * So there is no cadence either. The native side decides what to do with
 * every frame it is offered, and it counts what it drops
 * (`vcFramesDroppedBusy`); a JS-side skip would hide that in a place the
 * pack cannot see.
 */
import { useCallback, useEffect, useState } from 'react';
import { VisionCameraProxy } from 'react-native-vision-camera';
import { useSharedValue } from 'react-native-worklets-core';
import type { FrameProcessorPlugin } from 'react-native-vision-camera';

/** The frame shape the plugin needs — structurally what vision-camera's
 *  `Frame` provides, declared locally so this file takes no type-level
 *  dependency on a version of vc's `Frame` we do not control. */
export interface SweepWorkletInput {
  readonly width: number;
  readonly height: number;
}

export interface SweepWorkletHandle {
  /**
   * Worklet: offer ONE frame to the sweep engine. Safe to call from inside
   * another `'worklet'` function, and safe before the plugin has acquired
   * (it short-circuits).
   *
   * ⚠ INCLUDE THIS IN YOUR `useFrameProcessor` DEPS. The reference changes
   * once, when the JSI plugin finishes registering; a worklet built before
   * that and never rebuilt holds a null plugin for the life of the screen
   * and every frame is silently dropped.
   */
  call: (frame: SweepWorkletInput) => void;
  /** Open/close the gate. The sweep is not running most of the time, and a
   *  plugin call per frame while idle is a JNI hop for nothing. */
  setActive: (on: boolean) => void;
  /** The plugin has acquired. */
  isReady: boolean;
}

/** The registered name — must match `PanoPlusSweepFrameProcessor.PLUGIN_NAME`. */
export const SWEEP_PLUGIN_NAME = 'panoplus_sweep_ingest';

export function useSweepWorklet(): SweepWorkletHandle {
  // Same mount-once retry as `useStitcherWorklet`:
  // `initFrameProcessorPlugin` returns undefined when called before
  // vision-camera's registry has finished initialising, and the race is
  // real (F8.1.a).
  const [plugin, setPlugin] = useState<FrameProcessorPlugin | null>(null);
  useEffect(() => {
    let cancelled = false;
    let timerId: ReturnType<typeof setTimeout> | null = null;
    const tryAcquire = (): void => {
      if (cancelled) return;
      const p = VisionCameraProxy.initFrameProcessorPlugin(SWEEP_PLUGIN_NAME, {});
      if (p != null) { setPlugin(p); return; }
      timerId = setTimeout(tryAcquire, 16);
    };
    tryAcquire();
    return () => {
      cancelled = true;
      if (timerId != null) clearTimeout(timerId);
    };
  }, []);

  const active = useSharedValue(false);
  const setActive = useCallback((on: boolean) => { active.value = on; }, [active]);

  const call = useCallback((frame: SweepWorkletInput) => {
    'worklet';
    if (!active.value) return;
    if (plugin == null) return;
    // No params. Everything the engine needs beyond pixels is resolved
    // natively — see the file header.
    plugin.call(frame as unknown as Parameters<typeof plugin.call>[0]);
  }, [plugin, active]);

  return { call, setActive, isReady: plugin != null };
}
