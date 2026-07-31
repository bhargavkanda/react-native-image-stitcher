// SPDX-License-Identifier: Apache-2.0
/**
 * useContentRotation — returns a CSS transform that rotates control
 * content so labels stay upright relative to device gravity,
 * regardless of whether the OS rotated the framebuffer.
 *
 * ## Why this exists
 *
 * v0.12 anchored `<Camera>`'s bottom controls to the home-indicator
 * edge so they stay in thumb reach on phones in landscape on
 * non-locked iOS hosts.  The anchoring works because the OS rotates
 * the framebuffer to match the device, so a JS-bottom view in
 * landscape is the device's actual landscape-bottom edge.
 *
 * On locked-portrait hosts (the most common production
 * configuration) the OS does NOT rotate the framebuffer when the
 * device tilts to landscape.  v0.12 still anchored controls to
 * "JS-bottom" — which is now the device's side edge — so the
 * shutter sits where the thumb expects, BUT the labels inside
 * each control (`AR`, `1×`, `0.5×`, the lens chip pills, the gear)
 * render at their JS-portrait baseline, so the user holding the
 * device sideways reads them at 90°.
 *
 * This hook fixes that by applying a `transform: rotate(±90°)` to
 * the control's *content* so it appears upright relative to actual
 * gravity, while the control container itself stays in place.
 *
 * ## How the rotation is computed
 *
 * Two signals:
 *   - **Framebuffer rotation** — what rotation has the OS already
 *     applied to the JS layout?  Read from
 *     `useWindowDimensions().width > height` — non-locked +
 *     device-landscape is the only case where the OS rotates,
 *     and that's exactly when `jsLandscape === true`.
 *   - **Device-physical rotation** — what rotation does the device
 *     have relative to gravity?  Read from `useDeviceOrientation()`
 *     (accelerometer-derived).
 *
 * The content rotation we apply is the *difference* between
 * device-physical and framebuffer rotation, so the net rotation
 * (content × framebuffer) equals device-physical → labels are
 * upright in the world.
 *
 * ## Truth table
 *
 * |  Host config        | Device          | jsLandscape | Net rot |
 * |---                  |---              |---          |---      |
 * |  Locked-portrait    | portrait        | false       |  0°     |
 * |  Locked-portrait    | landscape-left  | false       |  90°    |
 * |  Locked-portrait    | landscape-right | false       | -90°    |
 * |  Locked-portrait    | upside-down     | false       | 180°    |
 * |  Non-locked         | portrait        | false       |  0°     |
 * |  Non-locked         | landscape-left  | true        |  0°     |
 * |  Non-locked         | landscape-right | true        |  0°     |
 *
 * The 0° case is the common one (locked-portrait + device-portrait
 * OR non-locked + framebuffer-already-rotated); we return an empty
 * style object so React skips the layout work.
 *
 * ## Caveats
 *
 * - Rotation transforms preserve hit-testing in RN 0.84 (verified
 *   on iOS + Android), but historical RN versions had bugs in this
 *   area.  If support for older RN is added, retest pressables.
 * - Containers whose sized layouts depend on un-rotated content
 *   (e.g. a 100px-wide pill containing text that's now rotated 90°)
 *   may overflow.  Fixed-size pills (the lens chip, AR toggle,
 *   flash button) are fine; the header title's `flex: 1 + textAlign:
 *   center` may need tuning when rotated — see `CaptureHeader`'s
 *   own rotation handling.
 */

import { createContext, useContext } from 'react';
import { useWindowDimensions, type ViewStyle } from 'react-native';

import {
  useDeviceOrientation,
  type DeviceOrientation,
} from './useDeviceOrientation';


/**
 * Measured JS-layout orientation provided by `<Camera>`.
 *
 * `useWindowDimensions()` freezes at its open-time value inside an iOS
 * RN `Modal` (any presentationStyle): the modal rotates but RN's global
 * window-dimension state never receives a change event, so hosts that
 * present `<Camera>` in a modal would get a stale `jsLandscape` and the
 * bottom controls would anchor to the wrong edge after rotation.
 *
 * `<Camera>` therefore measures its own root view via `onLayout` (which
 * IS reliable inside modals) and provides `width > height` here.  The
 * hook below prefers this context and only falls back to
 * `useWindowDimensions` when rendered outside a `<Camera>` tree.
 */
export const HostJsLandscapeContext = createContext<boolean | null>(null);


export type ContentRotationDeg = 0 | 90 | -90 | 180;


/**
 * Return type for `useContentRotation`.  Typed structurally on just
 * the `transform` property so it spreads cleanly into ViewStyle,
 * TextStyle, AND ImageStyle — all three accept identical transform
 * shapes in RN 0.84.  Returning the more specific `ViewStyle` would
 * collide with ImageStyle's stricter `overflow` enum at <Image>
 * call sites.
 */
export type ContentRotationStyle = {
  transform?: ViewStyle['transform'];
};


/**
 * Pure rotation computation.  Exported so tests can exercise the
 * full truth table without booting a React render.
 */
export function contentRotationDeg(
  jsLandscape: boolean,
  deviceOrient: DeviceOrientation,
): ContentRotationDeg {
  // Framebuffer rotation relative to device-physical.  Only the
  // non-locked + device-landscape cases see a rotated framebuffer.
  // jsLandscape can briefly be true mid-rotation on devices that
  // aren't a clean landscape orientation; the device-orientation
  // check below catches those and falls through to 0.
  const fbRot: 0 | 90 | -90 =
    !jsLandscape ? 0
    : deviceOrient === 'landscape-left' ? 90
    : deviceOrient === 'landscape-right' ? -90
    : 0;

  // Device-physical rotation relative to gravity.
  const deviceRot: 0 | 90 | -90 | 180 =
    deviceOrient === 'portrait' ? 0
    : deviceOrient === 'landscape-left' ? 90
    : deviceOrient === 'landscape-right' ? -90
    : 180;

  // Net rotation we need to apply to content so that
  // content + framebuffer = device-physical (upright in the world).
  // Normalise to [-180, 180] so transform values stay canonical.
  let net = deviceRot - fbRot;
  if (net > 180) net -= 360;
  if (net < -180) net += 360;
  return net as ContentRotationDeg;
}


/**
 * Returns the rotation as a ready-to-spread style object.  Empty
 * object in the common 0° case so React skips the layout work.
 * Type `ContentRotationStyle` is structurally just `{ transform? }`
 * so call sites can spread it into ViewStyle, TextStyle, or
 * ImageStyle interchangeably.
 */
export function useContentRotation(): ContentRotationStyle {
  const orient = useDeviceOrientation();
  const { width, height } = useWindowDimensions();
  // Prefer the layout measured by <Camera> — window dimensions freeze
  // inside iOS modals (see HostJsLandscapeContext).
  const measuredLandscape = useContext(HostJsLandscapeContext);
  const jsLandscape = measuredLandscape ?? width > height;
  const deg = contentRotationDeg(jsLandscape, orient);
  return deg === 0
    ? {}
    : { transform: [{ rotate: `${deg}deg` }] };
}
