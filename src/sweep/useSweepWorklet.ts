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
import { useCallback, useEffect, useRef, useState } from 'react';
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
  /**
   * Acquisition gave up after its bounded retry: the plugin is not in this
   * build. Distinct from `!isReady`, which is also true for the first moments
   * while it registers — a hold then is refused as "still loading", not as
   * "not in this build".
   */
  unavailable: boolean;
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
  //
  // ⚠ AND A `useState` INITIALIZER IS NOT ENOUGH, because it runs only on
  // the hook's FIRST render. `enabled` is `engine === 'sweep'`, and
  // `<Camera>` is NOT remounted when `engine` changes — the whole
  // `prevEngineRef` / `sweepHandoffPending` machinery exists because it is
  // not. So on any runtime switch INTO the sweep (photo→sweep,
  // keyframe→sweep) the initializer had already run with `enabled` false,
  // and `isReady` was false for the first render the sweep surface is
  // mounted on: exactly the one-render flap this was added to remove, moved
  // from mount time to switch time. Resolving through a ref during render
  // covers both, and the bounded effect below stays for the case the
  // initializer exists for — a registry that is not up yet.
  const [plugin, setPlugin] = useState<FrameProcessorPlugin | null>(null);
  const pluginRef = useRef<FrameProcessorPlugin | null>(null);
  // ⚠ THE RENDER-PHASE ACQUIRE NEEDS THE BUDGET TOO, and the first version
  // of it did not have one — so on a build where the plugin never registers
  // it issued a JSI `initFrameProcessorPlugin` on EVERY render, for the life
  // of the screen. That is the same unbounded-poll defect `ACQUIRE_BUDGET_MS`
  // was added to fix, reintroduced beside its own fix, and the test
  // certifying the bound could not see it because it never re-rendered.
  // Latched in a ref so the render path can read it.
  const acquireGaveUpRef = useRef(false);
  // The render-visible twin of the ref, so a caller learns it gave up.
  const [gaveUp, setGaveUp] = useState(false);
  if (enabled && pluginRef.current == null && !acquireGaveUpRef.current) {
    const p = acquire();
    if (p != null) {
      pluginRef.current = p;
      // Safe during render: `setState` on the CURRENT component before it
      // commits is React's own render-phase-update path, and the condition
      // above makes it converge in one extra pass.
      setPlugin(p);
    }
  }
  useEffect(() => {
    // `enabled` going back on is a fresh question: the registry may have come
    // up since. Re-open the budget, once, on that edge. (Since M3 `<Camera>`
    // passes `enablePanoramaMode` — an ENGINE switch no longer toggles it, so
    // a plugin that is not in the build after the first 1.5 s stays refused
    // by name for the life of the mount, which is the honest answer.)
    if (!enabled) { acquireGaveUpRef.current = false; setGaveUp(false); return undefined; }
    if (plugin != null) return undefined;
    let cancelled = false;
    let timerId: ReturnType<typeof setTimeout> | null = null;
    let waitedMs = 0;
    const tryAcquire = (): void => {
      if (cancelled) return;
      const p = acquire();
      if (p != null) { pluginRef.current = p; setPlugin(p); return; }
      waitedMs += ACQUIRE_RETRY_MS;
      // GIVE UP RATHER THAN POLL FOREVER. A plugin that has not registered
      // in 1.5 s is not in this build, and `isReady` stays false — which is
      // the correct answer, and the one the ownership predicate needs.
      if (waitedMs >= ACQUIRE_BUDGET_MS) {
        acquireGaveUpRef.current = true;
        setGaveUp(true);
        return;
      }
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

  // ⚠ `isReady` READS THE REF, `call` READS THE STATE, and the difference
  // is deliberate. A render-phase `setPlugin` does not change `plugin` for
  // the render it happens on, so reporting readiness from the state would
  // still hand `<Camera>` a false on the first render the sweep is enabled
  // — which is the whole flap this is here to remove, since `isReady` is a
  // TERM of the ownership predicate.
  //
  // `call` staying one render behind is harmless and cannot be avoided: the
  // worklet is rebuilt by identity (that is why `plugin` is in its deps at
  // all), and native reads the arm at `start()`, which is a deliberate
  // operator hold many renders later — not during this one.
  return {
    call,
    setActive,
    isReady: pluginRef.current != null,
    unavailable: plugin == null && gaveUp,
  };
}
