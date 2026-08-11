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
   * Optional IMAGE drawn INSIDE a `'box'` overlay, anchored bottom-left and
   * inset, so it annotates without covering what the box marks.  A local
   * `file://` path (or plain filesystem path); the native renderers decode
   * and CACHE it by URI and silently ignore an undecodable file (the box
   * then draws without it).  When present it REPLACES the centroid `label`.
   */
  imageUri?: string;

  /**
   * Stroke / fill colour as a hex string (e.g. `'#00E5FF'`).  Defaults to a
   * theme colour on the native side when omitted.
   */
  color?: string;

  /**
   * Fill opacity `0..1` for a `'box'` overlay (0 = no fill).  Omitted = the
   * native default (~22%, identical on both platforms), so pre-existing
   * overlays render pixel-identically.  A non-finite or out-of-range value
   * falls back to the default rather than being clipped — nonsense never
   * silently produces an invisible or opaque fill.
   */
  fillAlpha?: number;

  /**
   * Stroke (outline) opacity `0..1` for the overlay edges.  Omitted = 1
   * (the historical fully-opaque outline).  `0` yields a FILL-ONLY quad —
   * what lets a tiled set of adjacent quads read as one continuous region
   * with no internal seams.  Same fallback-not-clip rule as
   * {@link fillAlpha}.
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

  /**
   * Orientation of a `worldQuad` `'box'` overlay (iOS renderer).  Default
   * `'plane'` — the box is drawn in the plane of its world corners (tilts
   * and foreshortens with the surface it marks), matching every pre-`orient`
   * build byte-for-byte.  `'camera'` re-orients the box to FACE THE CAMERA
   * and stay gravity-upright on screen regardless of the quad's orientation
   * (a billboard sized by the quad's own edge lengths at its centroid) —
   * for a live detection box that must stay readable when the fitted plane
   * is oblique or edge-on (where a plane-oriented box foreshortens to a
   * sliver).  Ignored for `'outline'` shapes and for overlays without a
   * `worldQuad`; Android's screen-space renderer projects corners directly
   * and ignores it too.
   */
  orient?: 'plane' | 'camera';

  /**
   * Opt-in for the iOS renderer's box-vs-box DEPTH-OCCLUSION scheme on a
   * `'box'` overlay.  Default `false` — the box renders with the legacy
   * pipeline exactly as it did before this field existed: no depth writer,
   * no depth reads, fill under stroke in the historical overlay order, and
   * overlapping boxes draw over each other regardless of world depth.
   * `true` — the box participates in depth occlusion: an invisible depth
   * writer 3 cm behind the box culls other opted-in boxes genuinely behind
   * it, while coplanar neighbours still draw.  Occlusion is strictly
   * between opted-in boxes; non-opted-in boxes, `'outline'` overlays,
   * labels, and badges neither occlude nor are occluded.  Same
   * fallback-not-clip rule as the other new fields: a non-boolean value
   * reads as `false` (legacy) rather than being coerced.  Android's
   * screen-space renderer has no depth scheme and ignores the flag.
   */
  depthOcclusion?: boolean;
}
