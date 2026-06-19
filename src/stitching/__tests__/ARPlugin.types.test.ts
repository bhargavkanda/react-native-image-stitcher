// SPDX-License-Identifier: Apache-2.0
/**
 * Type-contract tests for the v0.19.0 AR PLUGIN FRAMEWORK surface.
 *
 * v0.19.0 ships a generic, host-extensible AR frame-plugin framework (the
 * SDK itself ships NO plugins — the host writes them against this contract).
 * Two JS-visible channels reach a consumer:
 *
 *   - `ARFrameMeta.plugins`   — SYNC results, keyed by plugin name, riding
 *                               the existing throttled `onArFrame` event.
 *   - `onArPluginResult`      — ASYNC results (`{ plugin, result }`), a plugin
 *                               pushing out-of-band via `registry.emit(...)`,
 *                               surfaced as `ARPluginResult` on a new prop on
 *                               both `<Camera>` and `<ARCameraView>`.
 *
 * ## Why a "types" test
 *
 * The plugins themselves live entirely in native + the host app; the SYNC
 * results are built natively and the ASYNC results arrive over a device
 * event.  There's no JS code path to unit-test directly.  What CAN silently
 * break is the **public TS contract** consumers compile against — a renamed
 * field, a narrowed `unknown`, or a dropped prop would be a breaking change
 * no other test catches.  This file pins it two ways (mirroring
 * `CameraFrame.types.test.ts`):
 *
 *   1. Runtime assertions over realistic mock values (so `jest` — configured
 *      with `isolatedModules`, i.e. no on-the-fly type-checking — has
 *      something concrete to run).
 *   2. `@ts-expect-error` negative checks validated by `npm run typecheck`
 *      (`tsc --noEmit`) — the authoritative type gate run in `prepublishOnly`.
 */

import type { ARFrameMeta, ARPluginResult } from '../ARFrameMeta';
// Type-only imports — erased at runtime, so importing the components' prop
// types never pulls react-native into the pure-TS jest env.  Their presence
// still makes `tsc` check the `onArPluginResult` prop typing.
import type { ARCameraViewProps } from '../../camera/ARCameraView';
import type { CameraProps } from '../../camera/Camera';

describe('AR plugin framework v0.19.0 type contract', () => {
  it('carries SYNC plugin results on ARFrameMeta.plugins (keyed by name)', () => {
    const meta: ARFrameMeta = {
      timestamp: 123456789,
      trackingState: 'normal',
      pose: { rotation: [0, 0, 0, 1], translation: [0.1, 0.2, 0.3] },
      intrinsics: {
        fx: 1597.3,
        fy: 1597.3,
        cx: 959.5,
        cy: 719.5,
        imageWidth: 1920,
        imageHeight: 1440,
      },
      depth: null,
      anchors: [],
      mesh: null,
      // The sample FrameBrightnessPlugin's sync result, plus a second
      // plugin returning an arbitrary (plugin-defined) shape — values are
      // `unknown`, so the map accepts heterogeneous payloads.
      plugins: {
        brightness: 0.42,
        someOtherPlugin: { confidence: 0.9, label: 'shelf' },
      },
    };

    // `plugins` is optional + present here.
    expect(meta.plugins).toBeDefined();
    // Values are `unknown` — a consumer narrows per-key before use.
    const brightness = meta.plugins?.brightness;
    expect(typeof brightness).toBe('number');
    expect(brightness as number).toBeCloseTo(0.42);
    expect((meta.plugins?.someOtherPlugin as { label: string }).label).toBe(
      'shelf',
    );
  });

  it('treats ARFrameMeta.plugins as OPTIONAL (omitted when registry empty)', () => {
    // A zero-plugin app's frame: native skips building the plugin map, so the
    // field is simply absent.  The contract MUST keep `plugins` optional so
    // existing 0.18 consumers compile unchanged.
    const meta: ARFrameMeta = {
      timestamp: 1,
      trackingState: 'limited',
      pose: { rotation: [0, 0, 0, 1], translation: [0, 0, 0] },
      intrinsics: null,
      depth: null,
      anchors: [],
      mesh: null,
    };
    expect(meta.plugins).toBeUndefined();
  });

  it('models an ASYNC ARPluginResult ({ plugin, result })', () => {
    const result: ARPluginResult = {
      plugin: 'FrameBrightnessPlugin',
      result: { brightness: 0.77 },
    };
    expect(result.plugin).toBe('FrameBrightnessPlugin');
    // `result` is `unknown` — branch on `plugin`, then cast.
    expect((result.result as { brightness: number }).brightness).toBeCloseTo(
      0.77,
    );
  });

  it('accepts an onArPluginResult handler typed against the public prop', () => {
    const onArPluginResult: NonNullable<CameraProps['onArPluginResult']> = (
      e,
    ) => {
      // Field access compiles → the public handler shape is intact.
      void e.plugin;
      void e.result;
    };
    expect(typeof onArPluginResult).toBe('function');

    // The two components' `onArPluginResult` props are the SAME shape — a
    // handler valid for one is valid for the other (so `<Camera>` can thread
    // it straight through to `<ARCameraView>`).
    const arViewHandler: NonNullable<ARCameraViewProps['onArPluginResult']> =
      onArPluginResult;
    expect(typeof arViewHandler).toBe('function');
  });
});

// ── Compile-time negative assertions (validated by `npm run typecheck`) ──

// `ARPluginResult.plugin` is a string, not arbitrary.
// @ts-expect-error — a number is not a valid plugin name.
const _badPluginName: ARPluginResult['plugin'] = 42;

// `onArPluginResult` must receive the `{ plugin, result }` shape — a handler
// taking a bare string is NOT assignable.
// @ts-expect-error — the handler arg is ARPluginResult, not string.
const _badHandler: NonNullable<CameraProps['onArPluginResult']> = (
  _s: string,
) => undefined;

// Reference the guards so "unused const" lint/TS doesn't strip them before
// the `@ts-expect-error` is evaluated.
void _badPluginName;
void _badHandler;
