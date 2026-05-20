// SPDX-License-Identifier: Apache-2.0
/**
 * react-native-image-stitcher — public API surface.
 *
 * Single component (`<Camera>`) + supporting types + the two public
 * hooks the design doc calls out (`useARSession`, `useIMUTranslationGate`).
 * Everything else (internal sub-components, drivers, bridges) is
 * deliberately NOT re-exported so the v0.1.0 → 1.0 stability window
 * doesn't lock us into an inflated public surface.
 *
 * If you need access to something that used to be exported and isn't
 * now, please open an issue describing the use-case before reaching
 * into the package internals.
 *
 * Public/private split: this lib is the open-source foundation.  The
 * `retailens-camera-sdk` package depends on this lib and adds
 * RetaiLens-specific features (measurement, packet detection, etc.)
 * on top.  Consumers wanting those features install
 * `retailens-camera-sdk` instead.
 */

// ── The main component ────────────────────────────────────────────────────
export { Camera, CameraError } from './camera/Camera';
export type {
  CameraProps,
  CameraCaptureResult,
  CameraErrorCode,
  CaptureSource,
  CameraLens,
  StitchMode,
  Blender,
  SeamFinder,
  Warper,
  FramesDroppedInfo,
} from './camera/Camera';

// ── AR foundation (public per design doc) ─────────────────────────────────
// Hosts that want raw AR pose access (e.g., to build their own
// measurement/detection on top) consume these directly.
export { useARSession, ARTrackingState } from './ar/useARSession';
export type {
  UseARSessionReturn,
  FramePose,
} from './ar/useARSession';

// ── IMU translation gate (public per design doc R5) ───────────────────────
// Hosts running their own non-AR capture flow can reuse this hook to
// get the same gating logic <Camera> uses internally.
export { useIMUTranslationGate } from './sensors/useIMUTranslationGate';
export type {
  UseIMUTranslationGateOptions,
  UseIMUTranslationGateReturn,
} from './sensors/useIMUTranslationGate';
