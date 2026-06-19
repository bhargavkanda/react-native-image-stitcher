// SPDX-License-Identifier: Apache-2.0
/**
 * Type-contract tests for the v0.18.0 `CameraFrame` surface.
 *
 * v0.18.0 broadened the AR frame contract a worklet receives:
 *
 *   - `arDepth`        — Float32 depth (metres) + optional Uint8
 *                        confidence (0..2), unified across ARKit / ARCore.
 *   - `arAnchors`      — now carry plane `alignment` ('horizontal' |
 *                        'vertical'), `extent` ([x, z] metres),
 *                        `classification` (ARKit semantic class), and —
 *                        on `type: 'mesh'` — `meshGeometry` ArrayBuffers.
 *   - `intrinsics`     — per-frame fx/fy/cx/cy (px) + capture resolution,
 *                        for lifting 2D image coords to 3D.
 *   - `planeDetection` — the `<Camera>` / `<ARCameraView>` prop selecting
 *                        which plane orientations reach `arAnchors`.
 *
 * ## Why a "types" test
 *
 * These fields are populated entirely in native + the C++ JSI layer, so
 * there is no JS code path to unit-test directly.  The thing that CAN
 * silently break is the **public TS contract** consumers compile their
 * worklets against — a renamed field or a narrowed union would be a
 * breaking change that no other test catches.  This file pins that
 * contract two ways:
 *
 *   1. Runtime assertions over realistic mock frames (so `jest` has
 *      something concrete to run — the project's jest is configured with
 *      `isolatedModules`, so it does not type-check on its own).
 *   2. `@ts-expect-error` negative checks validated by `npm run
 *      typecheck` (`tsc --noEmit`) — the authoritative type gate, run in
 *      `prepublishOnly`.  Each one fails the build if the field it guards
 *      stops rejecting bad values (i.e. the union widened by accident).
 */

import type {
  CameraFrame,
  ARAnchor,
  CameraFrameProcessor,
} from '../CameraFrame';
// Type-only imports — erased at runtime, so importing the components'
// prop types never pulls react-native into the pure-TS jest env.  Their
// presence still makes `tsc` check the `planeDetection` prop typing.
import type { ARCameraViewProps } from '../../camera/ARCameraView';
import type { CameraProps } from '../../camera/Camera';

/** Minimal pixel reader stub so mock frames satisfy the interface. */
const toArrayBuffer = (): ArrayBuffer => new ArrayBuffer(0);

describe('CameraFrame v0.18.0 type contract', () => {
  it('models a fully-populated AR frame (depth + anchors + intrinsics)', () => {
    const planeAnchor: ARAnchor = {
      id: 'plane-1',
      type: 'plane',
      transform: new Array(16).fill(0),
      alignment: 'vertical',
      extent: [1.2, 0.8],
      classification: 'wall',
    };

    const meshAnchor: ARAnchor = {
      id: 'mesh-depth',
      type: 'mesh',
      transform: new Array(16).fill(0),
      meshGeometry: {
        vertices: new ArrayBuffer(36), // 3 verts × 3 floats × 4 bytes
        faces: new ArrayBuffer(12), //    1 tri × 3 indices × 4 bytes
        classifications: new ArrayBuffer(1),
      },
    };

    const frame: CameraFrame = {
      width: 1920,
      height: 1440,
      pixelFormat: 'yuv',
      orientation: 'landscape-right',
      timestamp: 123456789,
      toArrayBuffer,
      pose: {
        rotation: [0, 0, 0, 1],
        translation: [0.1, 0.2, 0.3],
      },
      source: 'ar',
      arDepth: {
        width: 256,
        height: 192,
        depthMap: new ArrayBuffer(256 * 192 * 4),
        confidenceMap: new ArrayBuffer(256 * 192),
      },
      arAnchors: [planeAnchor, meshAnchor],
      arTrackingState: 'normal',
      intrinsics: {
        fx: 1597.3,
        fy: 1597.3,
        cx: 959.5,
        cy: 719.5,
        imageWidth: 1920,
        imageHeight: 1440,
      },
    };

    // Discriminant + AR-only fields present.
    expect(frame.source).toBe('ar');
    expect(frame.arDepth?.width).toBe(256);
    expect(frame.arDepth?.confidenceMap?.byteLength).toBe(256 * 192);
    expect(frame.arAnchors).toHaveLength(2);
    expect(frame.arAnchors?.[0].alignment).toBe('vertical');
    expect(frame.arAnchors?.[0].extent).toEqual([1.2, 0.8]);
    expect(frame.arAnchors?.[0].classification).toBe('wall');
    expect(frame.arAnchors?.[1].meshGeometry?.vertices.byteLength).toBe(36);
    expect(frame.intrinsics?.fx).toBeGreaterThan(1000);
    expect(frame.intrinsics?.imageWidth).toBe(frame.width);
  });

  it('models a non-AR (vc) frame with the AR-only fields absent', () => {
    const frame: CameraFrame = {
      width: 1280,
      height: 720,
      pixelFormat: 'yuv',
      orientation: 'portrait',
      timestamp: 42,
      toArrayBuffer,
      pose: { rotation: [0, 0, 0, 1] },
      source: 'vc',
    };

    expect(frame.source).toBe('vc');
    // AR-only fields are optional — undefined on vc frames.
    expect(frame.arDepth).toBeUndefined();
    expect(frame.arAnchors).toBeUndefined();
    expect(frame.intrinsics).toBeUndefined();
    expect(frame.pose.translation).toBeUndefined();
  });

  it('accepts a worklet typed against the public processor signature', () => {
    const processor: CameraFrameProcessor = (frame) => {
      'worklet';
      // Field access compiles → the worklet-facing shape is intact.
      void frame.source;
      void frame.intrinsics?.fx;
      void frame.arAnchors?.map((a) => a.alignment);
    };
    expect(typeof processor).toBe('function');
  });
});

// ── Compile-time negative assertions (validated by `npm run typecheck`) ──
// Each guards a union from silently widening.  If the field stops
// rejecting the bad value, the `@ts-expect-error` becomes unused and tsc
// fails — turning an accidental contract change into a build break.

// `alignment` is exactly 'horizontal' | 'vertical'.
// @ts-expect-error — 'diagonal' is not a valid plane alignment.
const _badAlignment: ARAnchor['alignment'] = 'diagonal';

// `classification` is the ARKit semantic-class union.
// @ts-expect-error — 'sofa' is not an ARKit plane classification.
const _badClassification: ARAnchor['classification'] = 'sofa';

// `extent` is a fixed-length [x, z] tuple, not an arbitrary array.
// @ts-expect-error — a three-element tuple is not assignable to [x, z].
const _badExtent: NonNullable<ARAnchor['extent']> = [1, 2, 3];

// `planeDetection` prop is the three-value union, identical on both
// component prop types.
// @ts-expect-error — 'none' is not a valid planeDetection mode.
const _badPlaneAR: ARCameraViewProps['planeDetection'] = 'none';
// @ts-expect-error — 'all' is not a valid planeDetection mode.
const _badPlaneCamera: CameraProps['planeDetection'] = 'all';

// Reference the guards so "unused const" lint/TS doesn't strip them
// before the `@ts-expect-error` is evaluated.
void _badAlignment;
void _badClassification;
void _badExtent;
void _badPlaneAR;
void _badPlaneCamera;
