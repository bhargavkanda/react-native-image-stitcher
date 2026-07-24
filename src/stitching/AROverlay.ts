// SPDX-License-Identifier: Apache-2.0

/**
 * v0.20.0 — the AR OVERLAY / ANNOTATION renderer's data model.
 *
 * An {@link AROverlay} describes a 2D shape (a billboard marker/box or a
 * world-anchored quad) that the native overlay layer draws ON TOP of the AR
 * camera preview (`RNSARCameraView`).  Each overlay is anchored to WORLD
 * positions and REPROJECTED to screen on EVERY AR frame from the current
 * camera pose + intrinsics — so it tracks the scene at display rate with no
 * 3D-engine dependency.
 *
 * ## Two ways to anchor an overlay
 *
 *   1. **A single world point** (`worldPosition`) — drawn as a billboard
 *      marker/box facing the camera, sized by `sizeMeters` (default a small
 *      marker).  Use this for a pin on a detected plane anchor, a label on a
 *      point of interest, etc.
 *   2. **Explicit world corners** (`worldQuad`, 3–4 points) — drawn as the
 *      outline/box connecting the projected corners.  Use this for a detected
 *      quad (a shelf face, a packet, a door) whose real-world shape you
 *      already know.
 *
 * Provide ONE of the two anchor forms.  If both are present `worldQuad` wins
 * (it's the more specific description); the native renderers read `worldQuad`
 * first and fall back to `worldPosition` + `sizeMeters`.
 *
 * ## Rendering / reprojection (native)
 *
 * The native side reprojects each overlay's world point(s) to screen with the
 * AR framework's BUILT-IN, correct projection — iOS
 * `ARFrame.camera.projectPoint(_:orientation:viewportSize:)`, Android
 * `viewMatrix · projectionMatrix` → clip → NDC → screen.  Points behind the
 * camera or off-screen are hidden.  The layer redraws every frame so the
 * outline/box + label stay pinned to the world as the camera moves.
 *
 * ## Where overlays come from
 *
 * Overlays reach the native renderer through two INDEPENDENT, merged sets:
 *
 *   - **JS-set** — the declarative `overlays` prop or the imperative ref
 *     methods (`setOverlays` / `addOverlay` / `updateOverlay` / `removeOverlay`
 *     / `clearOverlays`) on `<Camera>` and `<ARCameraView>`.
 *   - **Native-plugin-set** — a registered AR plugin places overlays directly
 *     via the 0.19 registry (`RNISARPluginRegistry.setOverlays(...)` on iOS /
 *     `RNSARPluginRegistry.setOverlays(...)` on Android), with zero JS latency.
 *
 * The native renderer draws the UNION of both sets; the plugin set is
 * namespaced so a JS `setOverlays(...)` never clobbers plugin overlays.
 */
export interface AROverlay {
  /**
   * Stable identifier.  The declarative `overlays` prop diffs the incoming
   * array against the current set BY `id` (add / update / remove); the
   * imperative `updateOverlay` / `removeOverlay` methods key off it too.  Must
   * be unique within a set.
   */
  id: string;

  /**
   * Anchor form 1 — a single world point in METRES (world space `[x, y, z]`).
   * Drawn as a billboard marker/box of `sizeMeters` extent facing the camera.
   * Ignored when `worldQuad` is provided.
   */
  worldPosition?: [number, number, number];

  /**
   * Box extent in METRES `[width, height]` at `worldPosition`.  Only meaningful
   * with `worldPosition`.  Defaults to a small marker on the native side when
   * omitted.
   */
  sizeMeters?: [number, number];

  /**
   * Anchor form 2 — 3 or 4 explicit world corners in METRES (e.g. a detected
   * quad).  Each corner is `[x, y, z]` in world space.  Drawn as the
   * outline/box connecting the projected corners.  Takes precedence over
   * `worldPosition` + `sizeMeters` when both are present.
   */
  worldQuad?: Array<[number, number, number]>;

  /**
   * Draw style.  Default `'outline'` (stroked edges).  `'box'` is a filled /
   * boxed marker.  Both render in 2D this release.
   */
  shape?: 'box' | 'outline';

  /** Optional text label drawn at the overlay's anchor point. */
  label?: string;

  /**
   * Stroke / fill colour as a hex string (e.g. `'#00E5FF'`).  Defaults to a
   * theme colour on the native side when omitted.
   */
  color?: string;

  /**
   * Fill opacity `0..1` for a `'box'` overlay (0 = no fill, 1 = opaque).
   * Optional; when omitted the native renderer uses its default fill opacity.
   * SCAFFOLD this release: the field is part of the overlay data model so
   * consumers can express per-overlay fill/stroke opacity (e.g. a tiled
   * coverage region that must fill without per-strip outlines), but the native
   * overlay layers do not yet read it — they draw at their default opacity.
   * Document-only forward compatibility, matching `mode: '3d'` above.
   */
  fillAlpha?: number;

  /**
   * Stroke (outline) opacity `0..1` for the overlay edges (0 = no outline).
   * Same optional / scaffold semantics as {@link fillAlpha}: honoured by the
   * native renderer where supported, otherwise the default outline is drawn.
   */
  strokeAlpha?: number;

  /**
   * Render mode.  Default `'2d'` — a flat shape reprojected to screen.
   * `'3d'` is SCAFFOLD ONLY this release: the data-model field exists and the
   * native renderers leave a marked hook for a future SceneKit (iOS) / Android
   * 3D renderer, but v1 treats `'3d'` as `'2d'` (with a one-time native log
   * warning).  Document-only forward compatibility.
   */
  mode?: '2d' | '3d';
}
