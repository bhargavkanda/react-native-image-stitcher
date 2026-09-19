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

/**
 * How long to keep retrying acquisition before concluding the plugin is not
 * in this build.
 *
 * ⚠ THE OLD LOOP HAD NO BOUND. It re-armed a 16 ms timer forever, and the
 * hook is called UNCONDITIONALLY from `<Camera>` — photo, scan, doc and
 * keyframe pano as well as sweep. On any build without
 * `panoplus_sweep_ingest` registered (every build without vision-camera's
 * plugin, and every iOS build until the arm exists) that is a permanent
 * ~62 Hz JS timer for the life of every camera screen, in four modes that
 * will never use it. The pattern was inherited verbatim from
 * `useStitcherWorklet`; S7 is what made it run everywhere.
 *
 * 1.5 s is far beyond the registry's real resolve time — the race it exists
 * for (F8.1.a) is a handful of frames at startup, not a second and a half.
 */
const ACQUIRE_BUDGET_MS = 1500;
const ACQUIRE_RETRY_MS = 16;

/** Acquire once, tolerating a registry that is not up yet. */
function acquire(): FrameProcessorPlugin | null {
  try {
    return VisionCameraProxy.initFrameProcessorPlugin(SWEEP_PLUGIN_NAME, {})
      ?? null;
  } catch {
    // A build without the plugin, or without vision-camera's proxy at all.
    // Not an error: this arm is optional on both platforms.
    return null;
  }
}

/**
 * @param enabled — whether this screen could ever use the arm. `false` skips
 *   acquisition entirely rather than polling for a plugin that will not be
 *   called.
 */
export function useSweepWorklet(enabled: boolean = true): SweepWorkletHandle {
  // ⚠ ACQUIRED DURING THE FIRST RENDER, NOT IN AN EFFECT, and that is a fix
  // rather than a micro-optimisation. `isReady` decides who owns the camera
  // (`sweepHostOwnsCamera`), so acquiring in an effect meant render #1 always
  // said "the surface owns it" and render #2, ~one frame later, said "the
  // host owns it". On Android that flap is two camera opens back to back
  // against one device — the "the previous camera owner was still letting
  // go" state the recorder already reports having hit. The registry is
  // normally up by first render, so this settles the question before anyone
  // acts on it; the effect below remains for the case where it is not.
  const [plugin, setPlugin] = useState<FrameProcessorPlugin | null>(
    () => (enabled ? acquire() : null),
  );
  useEffect(() => {
    if (!enabled || plugin != null) return undefined;
    let cancelled = false;
    let timerId: ReturnType<typeof setTimeout> | null = null;
    let waitedMs = 0;
    const tryAcquire = (): void => {
      if (cancelled) return;
      const p = acquire();
      if (p != null) { setPlugin(p); return; }
      waitedMs += ACQUIRE_RETRY_MS;
      // GIVE UP RATHER THAN POLL FOREVER. A plugin that has not registered
      // in 1.5 s is not in this build, and `isReady` stays false — which is
      // the correct answer, and the one the ownership predicate needs.
      if (waitedMs >= ACQUIRE_BUDGET_MS) return;
      timerId = setTimeout(tryAcquire, ACQUIRE_RETRY_MS);
    };
    tryAcquire();
    return () => {
      cancelled = true;
      if (timerId != null) clearTimeout(timerId);
    };
  }, [enabled, plugin]);

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
