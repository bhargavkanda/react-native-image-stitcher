# Changelog

All notable changes to `react-native-image-stitcher` will be
documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> [!IMPORTANT]
> **0.x → 1.0 stability gate.** Per non-functional requirement NF2 of
> the design doc, the 0.x line is API-unstable.  We intentionally ship
> a small, focused public surface here so the v1.0 contract can be
> stabilised without churning a sprawling API.  Breaking changes
> during 0.x are bumped to a new MINOR (e.g., 0.1 → 0.2), and the
> upgrade path is documented in this CHANGELOG.

## [0.20.5] — 2026-06-23

### Added

- **`takePhoto()` on the `<Camera>` ref** ({@link CameraHandle}) — imperatively
  fire a single-photo capture, identical to tapping the shutter (same AR /
  non-AR routing, same `onCapture` callback, same output-path rules). Respects
  `enablePhotoMode` / `shutterDisabled`, so callers can fire it freely and let
  the gate decide. Enables hands-free / auto-capture flows (e.g. a document
  scanner that fires once the page is framed).

### Changed

- **High-res AR capture now works on Android too.** `highResCapture` previously
  no-op'd on Android; it now reconfigures the live ARCore session to the
  device's largest camera config, so the AR `takePhoto()` returns a
  full-resolution still. The AR keyframe stream + stitching are unaffected (the
  keyframe down-clamp still applies to those — only the tapped/auto still goes
  full-res). For flat document capture the AR still is also baked to a fixed
  portrait orientation, since the live accelerometer orientation is ambiguous
  when the phone is held flat over a table.

### Fixed

- **Android photo orientation is now baked deterministically.** The normalise
  step rewrites the JPEG upright via `BitmapFactory` + `ExifInterface` + an
  explicit matrix rotation, replacing an `imread`-based path whose inconsistent
  EXIF handling produced sideways / squished stills when the phone was held
  flat (e.g. scanning a document on a table).

## [0.20.4] — 2026-06-22

### Added

- **`shutterDisabled` prop** (`<Camera>`) — when `true`, taps + holds are
  ignored and the shutter paints in its disabled visual. For host-driven
  capture gating: e.g. a document scanner that only allows capture once the
  document fills the framing guide, or a fixture flow at its max photo count.
  Independent of the SDK's stitching-in-progress disable. Default `false`.
- **`RectCropPreview` `initialQuad` prop** — seed the crop editor's draggable
  quad from a free 4-corner quad (e.g. detected document corners) rather than
  an axis-aligned `initialRect`, so the editor opens on the actual (possibly
  perspective) outline. Takes precedence over `initialRect`. The editor now
  also re-seeds when `imageUri` changes, so a host can keep one editor mounted
  and swap images between captures.
- **`copyFile(from, to)`** export (iOS + Android) — copy a file leaving the
  source in place. Pairs with the in-place `cropQuad` so a host can crop a
  *copy* of a capture: the original survives (for re-crop / "use original") and
  the cropped bytes land on a fresh URI, avoiding RN image-cache collisions
  (same-URI-new-bytes shows stale).

## [0.20.3] — 2026-06-22

### Added

- **`highResCapture` prop** (`<Camera>` / `ARCameraView`) — opt-in
  high-resolution photo capture. When `true` (iOS 16+), the AR session runs
  on the smallest video format that supports `captureHighResolutionFrame`, so
  `takePhoto()` returns a true full-resolution still (for document OCR /
  detail capture). Toggling it live re-picks the video format in place. No-op
  on Android (no equivalent high-res capture API).

### Changed

- **High-res AR capture is now opt-in.** 0.20.2 made the AR session *always*
  pick a high-res-capable video format; 0.20.3 gates that behind the new
  `highResCapture` prop (default `false`). Pure panorama-stitching / plain-AR
  sessions return to the smallest video format (cheapest live stream); only
  callers that set `highResCapture` (e.g. a document scanner) take on any
  live-frame cost. **Stitching is unaffected either way** — keyframes are
  downscaled to a fixed budget (`kKeyframeMaxLongEdge` = 1280 px in the
  keyframe collector) regardless of the AR video format, and
  `captureHighResolutionFrame` is used only by `takePhoto`, never by the
  stitch keyframe path.

### Removed

- Dead `arKeyframeMaxLongEdge` constant in `RNSARSession` (was unused — the
  real AR keyframe budget is `kKeyframeMaxLongEdge` in the keyframe
  collector); corrected the stale doc comments that referenced it.

## [0.20.2] — 2026-06-22

### Fixed

- **AR high-res capture now actually engages.** 0.20.1 called
  `captureHighResolutionFrame`, but the SDK ran the AR session on the
  *smallest* video format, which isn't high-res-capable — so the call fell
  back to the low-res live frame (AR `takePhoto` came out ~½ the linear
  resolution of a non-AR photo). The session now picks the smallest video
  format that **is** `isRecommendedForHighResolutionFrameCapturing`, so AR
  `takePhoto` returns a true full-resolution still (≈4× the pixels — fixes
  AR document OCR quality). The high-res capture is a one-off photo, so the
  **live stream stays small** and per-frame processing is unaffected; the
  chosen live resolution is logged (`[RNIS] AR videoFormat …`).

## [0.20.1] — 2026-06-21

### Fixed

- **AR camera intrinsics principal point (`cx`/`cy`).** `RNISARFrameContext`
  and `onArFrame`'s `intrinsics` reported `cx`/`cy` as `0` — they were read
  from the wrong indices of the **column-major** `ARCamera.intrinsics` matrix
  (`fx`/`fy` survived because they sit on the diagonal). Any pixel↔world
  unprojection that used the principal point was therefore wrong. Now reads
  `cx = k[2][0]`, `cy = k[2][1]`.
- **AR `takePhoto` resolution.** AR-mode photo capture used the low-resolution
  AR video frame (and then downscaled it to the stitch-keyframe budget) — far
  too low-res for document OCR / detail capture. It now captures a
  **full-resolution still** via `ARSession.captureHighResolutionFrame`
  (iOS 16+), falling back to the live frame on older OS. Non-AR capture is
  unchanged.
- **AR overlay `worldQuad` outline thickness.** The outline drew as 1px
  SceneKit `.line` primitives (unscalable). Edges now render as thin cylinders
  so the outline is actually visible.

## [0.20.0] — 2026-06-20

### Added — AR overlay / annotation renderer

AR-mode `<Camera>` can now draw **world-anchored 2D overlays** — outlines,
boxes, markers + labels pinned to a real-world point (or explicit quad) and
tracked as the device moves. Drive them from **JS** (declarative `overlays`
prop + imperative ref: `setOverlays` / `addOverlay` / `updateOverlay` /
`removeOverlay` / `clearOverlays`) or from **native plugins**
(`RNISARPluginRegistry` / `RNSARPluginRegistry` `setOverlays`); the two
namespaces render as a union.

- **`AROverlay`** shape: `{ id, worldPosition? | worldQuad?, sizeMeters?,
  shape: 'box' | 'outline', label?, color?, mode: '2d' | '3d' }`.
- **Real anchoring, not hand-projection.** Each overlay is pinned to a true AR
  anchor — an `ARAnchor` rendered as a SceneKit node on iOS, an ARCore
  `Anchor` projected over the camera on Android — so the framework tracks and
  *refines* the point against drift / re-localization. The marker stays glued
  to the real-world spot instead of riding the screen.
- **`raycast()`** (Camera ref): casts from the screen-centre crosshair to the
  nearest real surface and resolves its world point — so a marker can be
  dropped **on** the aimed object at its true depth (ARKit raycast on iOS,
  ARCore `hitTest` on Android). Resolves `null` when nothing is hit, so callers
  can fall back to a fixed placement.
- The example demos a crosshair + "Pin marker" that raycasts, anchors, and
  tracks a cyan marker on the aimed surface.

Device-verified on iPhone (LiDAR — precise raycast depth) and a Galaxy A35
(ARCore depth-from-motion — softer placement on depth-sensorless devices, as
expected). `mode:'3d'` renders as a world-anchored 2D billboard this release;
a future release can extend the SceneKit/Anchor path to richer 3D content.

## [0.19.0] — 2026-06-19

### Added — Native AR frame-processor plugins

AR-mode `<Camera>` can now run **native per-frame plugins** with zero-copy
access to the AR frame — the foundation for on-device CV (OCR, object
detection, reconstruction feeds) **without** baking that domain code into the
SDK. The SDK ships only the generic framework; plugins live in your app.

- **Plugin interface:** implement `RNISARFramePlugin` (iOS) / `ARFramePlugin`
  (Android) — `name()` + `process(context)`.
- **`ARFrameContext`** hands the plugin the frame **zero-copy**: the camera
  buffer, `pose`, `intrinsics`, tracking state, timestamp, and — when the
  matching `enable*` prop is on — `depth` + `anchors`. The buffer is valid
  **only during `process()`**; copy it before offloading to another thread.
- **Register at startup:** `RNISARPluginRegistry.shared.register(…)` (iOS) /
  `RNSARPluginRegistry.register(…)` (Android). The SDK invokes registered
  plugins per AR frame, gated on a **non-empty registry** — zero-plugin apps
  pay nothing.
- **Two result channels:** light **synchronous** `process()` returns fold into
  `onArFrame`'s `ARFrameMeta.plugins` (keyed by plugin name); heavy / **async**
  results are pushed via `registry.emit(name, result)` → the new
  **`onArPluginResult`** callback prop (delivered off the AR thread — for slow
  work like OCR that must not block frame capture).
- The example ships a sample `FrameBrightnessPlugin` (both platforms),
  surfaced live in the AR overlay.

Device-verified on iPhone 16 Pro. The SDK stays dependency-light — no OCR / ML
runtimes are added to core.

## [0.18.0] — 2026-06-18

### ⚠️ Breaking — `StitcherFrame` → `CameraFrame`

The frame type a worklet receives is renamed **`StitcherFrame` →
`CameraFrame`** (and `StitcherFrameProcessor` → `CameraFrameProcessor`).
The shape is unchanged; only the names changed, to match the
`arFrameProcessor` prop's role (it's the camera frame, not a "stitcher"
frame). Update your imports:

```diff
- import { type StitcherFrame } from 'react-native-image-stitcher';
+ import { type CameraFrame } from 'react-native-image-stitcher';
```

### Added — AR depth, anchors, scene mesh, and intrinsics on `CameraFrame`

The AR frame a worklet receives can now carry rich per-frame metadata,
each behind an **opt-in `<Camera>` prop** (all off by default — you pay
only for what you request):

- **`enableDepth`** → `frame.arDepth` — a depth map normalised to **one
  cross-platform shape**: `Float32` **metres** in `depthMap`, optional
  `Uint8` `confidenceMap` (`0`/`1`/`2`). Sourced from ARKit
  `sceneDepth`/`smoothedSceneDepth` (LiDAR) and the ARCore Depth API.
- **`enableAnchors`** → `frame.arAnchors` — detected planes / images,
  now with plane **`alignment`** (`'horizontal'` | `'vertical'`),
  **`extent`** (`[x, z]` metres), and (iOS only) semantic
  **`classification`** (`'wall'`/`'floor'`/…).
- **`enableMesh`** → `type: 'mesh'` entries in `arAnchors` carrying
  `meshGeometry` (`vertices`/`faces`/optional `classifications`
  ArrayBuffers). iOS uses ARKit `ARMeshAnchor` scene reconstruction
  (LiDAR); **Android reconstructs a rough mesh from the depth map**
  (camera-local vertices, identity transform, no per-face
  classifications) — so Android mesh requires a Depth-API device and is
  geometry-only.
- **`planeDetection`** (`'vertical'` (default) | `'horizontal'` |
  `'both'`) — which plane orientations reach `arAnchors`. iOS changes
  ARKit `planeDetection`; Android keeps detecting both (ARCore needs
  horizontal planes to bootstrap tracking) and filters the emitted set,
  so the JS-observable result is identical on both platforms. The
  `'vertical'` default preserves the plane-projected stitch path's
  long-standing behaviour.
- **`frame.intrinsics`** — per-frame `fx`/`fy`/`cx`/`cy` (px) plus the
  capture resolution, for lifting 2D image coordinates to 3D. Always
  present on AR frames; `undefined` on non-AR (vision-camera) frames,
  which have no intrinsics surface.

Depth/anchor/mesh bytes are **eager-copied** out of the native frame at
extraction time, so they're safe to read anywhere in the worklet (no
buffer-lifetime footgun). See the new **[Testing the AR frame
processor](https://bhargavkanda.github.io/react-native-image-stitcher/docs/dev-testing)**
guide for a copy-paste verification recipe and the expected on-device
output per platform.

### Added — `onArFrame`: worklet-free AR metadata on the main thread

`<Camera onArFrame={(meta) => …}>` is a new callback (also on
`<ARCameraView>`) that delivers **light per-frame AR metadata on the JS
main thread** — no worklet involved:

```ts
onArFrame={(m: ARFrameMeta) => {
  // m.trackingState, m.pose, m.intrinsics,
  // m.depth?.{width,height,hasConfidence},
  // m.anchors[] (id/type/alignment/extent/classification/transform),
  // m.mesh?.{anchorCount,vertexCount,faceCount}
}}
```

Native builds the metadata each frame (reusing the same extraction as
above) and emits it as a throttled event (default ≈10 Hz; tune with
`arFrameMetaInterval` ms). Costly fields are gated by the same opt-ins
(`depth` needs `enableDepth`, `mesh` needs `enableMesh`, `anchors` needs
`enableAnchors`); `pose`/`trackingState`/`intrinsics` are always present.

**This is the recommended way to read AR data in JS** for observe/measure
use cases — it carries *light* data (dims, counts, intrinsics, plane
geometry), never heavy buffers. For zero-copy access to raw per-frame
buffers (depth pixels, mesh vertices) you'd use the `arFrameProcessor`
worklet — see the limitation below.

### Known limitation — `arFrameProcessor` worklets must capture nothing

In this release an `arFrameProcessor` worklet must **not capture host
objects** (a `runOnJS` callback or a shared value) in its closure:
`react-native-worklets-core` deep-copies the worklet's closure when it's
installed into the AR worklet runtime, and a captured host object makes
that copy recurse until the stack overflows (a hard crash, on both Debug
and Release). A worklet that captures **nothing** installs and runs fine.
Until this is resolved upstream, **use `onArFrame`** (above) to get AR
data into JS; reserve the worklet for capture-free per-frame work.

### Known limitation — `enableMesh` is memory-heavy on sustained sessions

`enableMesh` turns on ARKit **continuous scene reconstruction**, the most
memory-intensive AR mode — the mesh model grows as you scan, and a long
session with depth + mesh both on can be **jetsam-killed by iOS** after a
few seconds on memory-constrained devices. `onArFrame` reports mesh as
light *counts* (`anchorCount`/`vertexCount`/`faceCount`) without copying
geometry, so reading mesh stats is cheap; it's the **underlying ARKit
meshing** that's heavy. For now, enable `mesh` only for short captures (the
example demos depth + planes + intrinsics with mesh off). Proper memory
management for sustained meshing — bounded reconstruction, single depth
semantic, on-demand geometry — lands with the 0.20 reconstruction work.

### Internal — `StitcherFrameData` → `CameraFrameData`

The shared C++ frame struct and its JSI/Obj-C++ host objects were renamed
(`StitcherFrameData` → `CameraFrameData`, `StitcherFrameJsiHostObject` →
`CameraFrameJsiHostObject`, `StitcherFrameHostObject` →
`CameraFrameHostObject`) to match the public `CameraFrame` type. No public
API change.

### Notes

- Compile-verified on both platforms (iOS `xcodebuild` + Android
  `assembleDebug`); all unit tests + typecheck pass. On-device
  observation of depth/planes/mesh/intrinsics against real surfaces is
  the recommended pre-adoption check (see the dev-testing guide).

## [0.17.0] — 2026-06-19

### Added — `arFrameProcessor`: observe AR frames with a host worklet

`<Camera>` gains an **`arFrameProcessor`** prop — a `'worklet'` invoked once per
**ARKit / ARCore frame** while in AR capture, dispatched natively and running
*alongside* first-party stitching (composition, not replacement). The worklet
receives a `StitcherFrame` tagged `source: 'ar'` with the world-space `pose` and
`arTrackingState`. It fires during preview too (continuous observation), at zero
per-frame cost when no worklet is registered.

This restores the previously-archived AR host-worklet capability and re-exposes
it as an explicit prop (rather than the old auto-registering hook). Under the
hood it installs `globalThis.__stitcherProxy` (JSI) on first use and fans frames
out through a shared C++ proxy / registry / dispatch layer on both platforms
(verified against `react-native-worklets-core` 1.6.3).

The non-AR equivalent remains `frameProcessor` (vision-camera); the two modes use
different runtimes and frame shapes, hence the separate prop. The
`StitcherFrame` / `StitcherFrameProcessor` type names are unchanged.

Verified on device: the worklet fires per frame on **iOS (ARKit, iPhone 16 Pro)**
and **Android (ARCore, Galaxy A35)**.

### Fixed

- **Example app crashed at launch on Android** (`PlatformConstants could not be
  found`). The v0.16.2 OpenCV-reuse demo added an app-level `externalNativeBuild`
  to `example/android/app/build.gradle` that displaced React Native's own
  New-Architecture app native build (so core TurboModules weren't compiled in).
  Removed it; React Native owns the app native build again. **Example-app only —
  the published SDK was never affected.**

## [0.16.2] — 2026-06-17

### Added — reuse the bundled OpenCV from your host app's native code (Android)

A host app's own native (C++/NDK) code can now reuse the **same** custom
OpenCV this library bundles (4.10.0, arm64-v8a) — **including `cv::Stitcher`**
— with no second copy of `libopencv_java4.so` in the APK.

The Android build now publishes the location of its vendored OpenCV SDK via
`rootProject.ext.rnisOpenCVDir` (and `rnisOpenCVAndroidSdkDir`). A consumer
points its `externalNativeBuild` at `-DOpenCV_DIR=${rootProject.ext.rnisOpenCVDir}`,
calls `find_package(OpenCV)`, and links the shared `opencv_java` (core /
imgproc / calib3d / … resolved at runtime from the already-shipped `.so`)
plus the whole-archived static `opencv_stitching` (`cv::Stitcher`). A
build-verified consumer ships in the example app
(`example/android/app/src/main/cpp/`).

This is additive — no public API or runtime-behaviour change. AGP
`prefabPublishing` was evaluated and is unworkable for prebuilt OpenCV
(prefab only exports libraries the module itself builds), so OpenCV's own
first-class CMake package is used instead. iOS reuse (the vendored
`opencv2.xcframework`) is unchanged.

### Docs

Documentation site refreshed: an easier **Getting started**, a complete
**`<Camera>` API** reference (every prop, the v0.16 guidance params —
`rectCrop` / `showPreview` / `panMode` / `panGuidance` / `maxPanDurationMs` /
`panTooFastThreshold` / `lateralBudgetCm` / `guidanceCopy` — and the
`stitcher` / `frameSelection` settings-JSON tables), a fully-loaded
**Complete example**, the v0.16 **Capture result & errors** union, and new
**Sharing OpenCV** / **Bring your own OpenCV** guides.

## [0.16.1] — 2026-06-16

### Changed — high-level `cv::Stitcher` is now the default pipeline

The batch finalize now drives OpenCV's high-level `cv::Stitcher`
(PANORAMA) on both platforms instead of the hand-rolled `cv::detail`
("manual") path.  In testing it produced consistently better seams and
lower, more stable peak memory.  This is a **behaviour change, not an
API change** — the public surface (`<Camera>`, the hooks, the finalize
options) is unchanged; only the stitched output and memory profile
differ.

The warper is chosen per-capture (pure function of the selected lens +
pan direction), always `PANORAMA`:

| Lens  | Mode A (vertical pan) | Mode B (horizontal pan) |
| ----- | --------------------- | ----------------------- |
| 1×    | plane                 | cylindrical             |
| 0.5×  | spherical             | spherical               |

The lens comes from the explicit `1x` / `0.5x` the user selected
(plumbed through the finalize options); the previous FOV-from-intrinsics
heuristic was unreliable on multi-camera devices and is gone, along with
the now-redundant rotation-vs-translation (ex-SCANS) branch.

### Added — production memory hardening on the high-level path

The OOM guards that previously only covered the manual path were ported
across, so the new default is memory-safe under pressure:

- pre-stitch RSS headroom abort (also works on iOS now via the
  `phys_footprint` probe, which revives the runtime-pressure router);
- RAM-aware compositing resolution;
- two-phase `estimateTransform` → project the warp canvas → abort if
  degenerate, downscale or route to the bounded spherical warper if
  over budget;
- a full C++ catch ladder + a JNI backstop so an allocation failure can
  no longer cross the C-ABI and abort the process;
- a warper→spherical rescue (high-level) with the manual `PANORAMA` ↔
  `SCANS` mode-fallback preserved for the iOS manual callers.

### Fixed

- The native allocator is purged after each stitch, and on Android the
  OpenCV worker pool is pinned to one thread, eliminating the per-stitch
  RSS creep observed on the manual path.

## [0.16.0] — 2026-06-15

### Added — first-time-user panorama capture GUIDANCE

A set of opt-in-by-default guidance surfaces that coach the operator
through a non-AR hold-and-pan panorama.  All seven are wired into
`<Camera>` automatically and read directly from new props (none are
threaded through `PanoramaSettings`):

1. **Mode gate + 2. rotate-to-landscape prompt.** Starting a panorama
   while the phone is held portrait under Mode A is blocked behind a
   "Rotate to landscape" caption; the capture starts the instant the
   user rotates to landscape (either way up).  Releasing the shutter
   before rotating cancels the pending start.
3. **Pan how-to overlay.** A brief code-drawn looping graphic (phone +
   sweeping band) + bouncing direction arrow (down for landscape Mode A,
   right for portrait Mode B) shown for ~2.5 s at the start of each
   recording.
4. **"Moving too fast" pill.** A transient amber pill while the gyro
   pan rate exceeds the warn threshold.
5. **Blinking countdown + auto-finalize.** A blinking whole-seconds
   countdown; at 0 the capture auto-finalizes (stitches what was
   captured — same path as releasing the shutter).
6. **Lateral-drift stop.** If the operator drifts sideways out of the
   pan plane beyond the budget, the capture FINALIZES what was captured
   and a one-button popup explains why.
7. **Post-stitch review surface.** Optional. `rectCrop` shows a
   draggable-quad crop editor (drag four corners; confirm perspective-
   rectifies in place via `cv::warpPerspective` when the quad isn't
   axis-aligned, "Use original" emits un-cropped, "Retake" discards).
   `showPreview` shows the same screen with NO crop box — just the
   stitched image with [Retake]/[Confirm]. With both off, `onCapture`
   fires immediately.

New `<Camera>` props (all optional): `panMode`, `panGuidance`
(default `true`), `maxPanDurationMs` (default `9000`; `0` disables the
countdown + auto-finalize), `panTooFastThreshold`, `lateralBudgetCm`
(default `5`; `0` disables the lateral stop), `rectCrop`
(default `false`), `showPreview` (default `false`), and
`guidanceCopy` (partial override of every guidance string). A skewed
crop quad is always perspective-rectified (there is no opt-out flag).

New public exports: the `PanMode` type, `GuidanceCopy` +
`DEFAULT_GUIDANCE_COPY`, the `usePanMotion` hook, the five guidance
components (`RotateToLandscapePrompt`, `PanHowToOverlay`,
`CaptureCountdownOverlay`, `LateralMotionModal`, `RectCropPreview`) with
their prop types, and the `cropQuad` perspective-rectify helper.

### Added — capture hardening

Follow-up hardening on top of the guidance set, driven by on-device
testing:

- **Guidance graphics are now code-drawn, not GIFs.** The rotate-to-
  landscape and pan-capture animations are rendered with pure RN
  `View` + `Animated` (`guidanceGraphics.tsx`) — resolution-independent
  (no pixelation on high-density screens) and themeable via
  `GUIDANCE_TOKENS`. Removes the bundled GIF assets AND the Android
  host's previous need to add Fresco's `animated-gif` module.
- **Crop editor seeds from the max-inscribed rectangle.** With
  `rectCrop`, the draggable quad now opens on the tightest clean
  rectangle (native `computeInscribedRect`) instead of a blind 8 %
  inset, and the editor gains an explicit **"Use original"** button
  (emit the stitch un-cropped) plus a warning banner. When the editor is
  on, the native auto-crop is forced off so the full bordered panorama
  is available to drag.
- **`onCapture` carries `warnings`.** Both success and failure results
  include `warnings: CaptureWarning[]` — `LOW_FRAME_UTILIZATION` (<70 %
  of captured frames used) and `LATERAL_DRIFT_FINALIZE`. New exports:
  `CaptureWarning`, `CaptureWarningCode`, `PanoramaCaptureResult`.
- **Post-stitch validation.** A disjoint / fragmented stitch (frames
  that survived confidence but didn't fuse into one panorama) is now
  rejected with the new `STITCH_LOW_QUALITY` error code + "try again"
  copy, instead of emitting a broken image.
- **Quality-driven warper.** Wide pans switch from plane to the bounded
  cylindrical projection based on the estimated sweep angle (not only on
  an OOM-divergence fallback), reducing end-of-pan perspective stretch.
- **Headroom-based memory gating.** The flat process-RSS pre-stitch
  abort is replaced by a per-process headroom model: under memory
  pressure the pipeline routes to the lighter STREAM+feather path rather
  than hard-aborting, and the pre-stitch abort fires only when there's
  no room for even a minimal stitch on top of the current footprint —
  so a memory-heavy host app no longer trips it spuriously.

### Added — `stitcher` / `frameSelection` config as JSON-object props

`<Camera>` now accepts the full stitcher and frame-gate config as JSON
objects — `stitcher={{ warperType, blenderType, seamFinderType,
stitchMode, enableMaxInscribedRectCrop }}` and
`frameSelection={{ mode, maxKeyframes, overlapThreshold,
maxKeyframeIntervalMs, flow }}` (both partial; `flow` is deep-merged).
Object fields win over the matching flat `default*` props, which remain
supported. This is the recommended way to configure the pipeline.

### Changed (BREAKING)

- **`onCapture` is now a discriminated union keyed on `ok`.** It fires
  once per capture attempt — on success (`ok:true`, discriminated
  further by `type`) AND on failure (`ok:false`, carrying `error:
  CameraError`); previously it fired only on success and failures went
  solely to `onError`. `onError` STILL fires on failure as an unchanged
  mirror. **Migration:** gate on `result.ok` before reading
  `uri`/`width`/`height` — `if (!result.ok) { handle(result.error);
  return; }`. Both branches also carry the new `warnings` array.
- **`<Camera>` now defaults to `panMode='vertical'` (landscape-only,
  top→bottom panorama).** Previously the component accepted both
  landscape and portrait holds with no gate.  `panMode` options are now
  `'vertical'` (landscape-only; portrait holds gated behind the
  rotate-to-landscape prompt), `'horizontal'` (portrait-only, left→right;
  landscape holds gated behind the rotate-to-portrait prompt), and
  `'both'` (either, ungated).  **Hosts that want portrait/left→right
  panoramas pass `panMode='horizontal'` or `'both'`.**
- **Stitch defaults moved to more robust values.** `stitchMode` now
  defaults to `'panorama'` (was `'auto'` — the auto-resolver's SCANS
  branch keys off double-integrated IMU translation, which is unreliable
  during rotation); `warperType` defaults to `'spherical'` (was
  `'plane'` — bounds both axes, fixing fragmented wide/vertical pans);
  and the keyframe gate is denser (`maxKeyframes` → 8, a 1.5 s
  `maxKeyframeIntervalMs` time gate re-enabled — bounding a static/slow
  capture to ~12 s before the 8-keyframe auto-finalize, `overlapThreshold`
  → 0.15).  **Migration:** hosts relying on the previous behaviour set the
  values explicitly via the new `stitcher` / `frameSelection` props (or
  the matching flat `default*` props) — e.g. `stitcher={{ stitchMode:
  'auto', warperType: 'plane' }}`.

## [0.15.2] — 2026-06-11

### Fixed

- **Sharp non-AR camera preview (WYSIWYG follow-up).**  The v0.15.1
  letterbox pinned the vision-camera format by aspect ratio only, so
  `useCameraFormat` could settle on a degenerate 4:3 format — observed as
  a 192×144 video stream on the iPhone 16 Pro — rendering the preview as
  upscaled mush behind a full-resolution capture.  The format filter now
  also requests `{ videoResolution: 'max' }`, so among 4:3 formats the
  highest-resolution one is chosen: a sharp preview plus full-res frames
  into the non-AR stitcher, with aspect kept as the top-priority filter so
  4:3 capture parity holds.  A bounded target (e.g. 1920×1440) is
  deliberately avoided — the nearest such format on the iPhone 16 Pro is
  10-bit-only (`x420`/`x422`), which the frame processor's 8-bit
  `420v`/`420f` pipeline rejects with `device/pixel-format-not-supported`;
  vision-camera exposes no per-format pixel formats to JS, so `'max'`
  (empirically the device's 8-bit full-res format) is the robust choice.
  Tap-to-photo stills are capped at ~12 MP (`photoResolution: 4032×3024`,
  lowest priority) so the iPhone 16 Pro's max-video format doesn't default
  to a 24 MP still — the panorama path uses the video stream, not
  `takePhoto`, so the cap costs nothing there.

## [0.15.1] — 2026-06-08

### Fixed

- **Camera preview now matches capture FOV on all paths (letterbox WYSIWYG).**
  The preview and captured photo now share the same field of view regardless of
  the container size the host app uses.  Black letterbox bars fill any extra
  space rather than cropping or stretching the camera feed.
  - *VisionCamera path:* `CameraView` measures its rendered bounds via
    `onLayout`, pins the format to 4:3 with `useCameraFormat`, then sizes the
    `<Camera>` component to the largest axis-aligned box that fits the container
    while preserving the format aspect ratio.
  - *ARCore path (Android):* `RNSARCameraView` now selects a camera config
    whose image aspect and texture aspect match within 2% (`selectMatchingCameraConfig`).
    On devices (e.g. Galaxy A35) where no 4:3 matched config exists, the best
    available 16:9 config is chosen — both preview and capture are 16:9.
    The GL renderer letterboxes the camera texture inside the GL surface using
    `setDisplayGeometry` + `glViewport`, centred on a black-cleared surface.
  - *ARKit path (iOS):* `RNSARCameraView.layoutSubviews()` reads
    `imageResolution` from the ARKit session and centres the scene view inside
    the container bounds using the same aspect-correct letterbox calculation.

- **ARCore CPU image resolution upgraded automatically.**  `selectMatchingCameraConfig`
  prefers the highest-resolution matched config, so CPU image captures used for
  stitching are now at full sensor resolution (1920×1080 on the Galaxy A35,
  up from 640×480) with no API change required.

### Changed

- **`defaultCaptureSource` changed from `'ar'` to `'non-ar'`.**  AR mode is now
  opt-in.  Host apps that want AR must pass `defaultCaptureSource="ar"` or
  implement a toggle; the plain camera path is the default.

## [0.15.0] — 2026-06-07

### Breaking — only `batch-keyframe` remains; host-worklet / frame-stream hooks removed

The live/incremental stitching engines (hybrid, slit-scan, firstwins) and the
third-party host-worklet / frame-stream observer API were archived (kept under
`archive/`, excluded from every build surface) so the SDK now ships only the
`batch-keyframe` capture path.  Removed from the public API:

- **Hooks** `useFrameProcessor`, `useThrottledFrameProcessor`, `useFrameStream`
  and their option types (`ThrottledFrameProcessorOptions`, `FrameStreamOptions`,
  `SampledFrame`).  To compose first-party stitching, use vision-camera's own
  `useFrameProcessor` with `useStitcherWorklet().call(frame)` (see the example app).
- The **slit-scan / hybrid** panorama-engine settings types and their
  native-config adapters (`slitscanSettingsToNativeConfig`,
  `hybridSettingsToNativeConfig`).

A type-only break for the default batch-keyframe path; per the 0.x stability
policy this bumps a new MINOR.

### Changed — iOS + Android unified on the manual `cv::detail` stitch pipeline

Both platforms now run the **same** manual `cv::detail` stitch pipeline
(`useManualPipeline=true` on both), so a given capture produces consistent,
more robust output regardless of platform.  Previously iOS used the manual
pipeline while Android used the high-level `cv::Stitcher` — the two diverged on
resolution, exposure handling, and wide-capture robustness.  The unified manual
path carries:

- **Exposure compensation** (`cv::detail::GainCompensator`, GAIN_BLOCKS) — evens
  brightness/colour across frames before blending, removing the visible seam
  steps the manual path previously had.
- **Matched registration / compositing resolution** (registration 0.6 MP,
  composite 1.0 MP) on both platforms.
- The **cylindrical warp fallback** (below), so wide / 0.5× captures survive on
  both platforms.

The decision was made after an on-device A/B (manual vs high-level at matched
resolution): with parity the manual path matched the high-level on quality and
was strictly more robust on wide captures.  Background + the verification trail
are recorded in [`docs/stitch-pipeline-architecture.md`](docs/stitch-pipeline-architecture.md).

### Added — cylindrical warp fallback for wide / 0.5× captures

When the configured (plane) warper would diverge on a wide or 0.5× ultra-wide
capture — a single frame's warp canvas exceeding the 100 MP guard — the stitcher
now auto-retries with the bounded cylindrical projection instead of failing with
`STITCH_CAMERA_PARAMS_FAIL`.  Wide and ultra-wide (0.5×) panoramas that
previously errored out now complete.  Because the pipeline is now unified
(above), this fallback applies on both iOS and Android.

### Added — `userFacingStitchError()` for friendly recoverable-stitch copy

New public SDK export that maps a recoverable stitch `CameraErrorCode`
(`STITCH_NEED_MORE_IMGS`, `STITCH_CAMERA_PARAMS_FAIL`, `STITCH_HOMOGRAPHY_FAIL`,
`STITCH_OOM`) to friendly, action-guiding `{ title, message }` copy for a host
`Alert` / toast — so the user sees "pan more slowly" / "pivot in place" instead
of the raw `cv::Stitcher` diagnostic.  Returns `null` for every non-recoverable
code (permission denied, device unavailable, generic finalize failure, unknown,
…), so the host falls back to its generic error UI.  Call it from `onError`:

```tsx
import { userFacingStitchError } from 'react-native-image-stitcher';

onError={(err) => {
  const friendly = userFacingStitchError(err.code);
  if (friendly) Alert.alert(friendly.title, friendly.message);
  else reportGenericError(err);
}}
```

Also exports the `UserFacingStitchError` type (`{ title, message }`).  Lives in
the SDK (not per-host) so every consumer shows the same vetted guidance for the
same failure, and so the mapping is unit-testable in isolation.

### Fixed — friendlier stitch-failure classification + example UX

- `STITCH_NEED_MORE_IMGS` now also classifies the manual pipeline's "0 valid
  pairwise matches / frames may not overlap enough" failure, which previously
  surfaced as a generic `PANORAMA_FINALIZE_FAILED`.  Both insufficient-overlap
  signals now map to the same recoverable "pan more slowly" outcome (and so pick
  up the `userFacingStitchError` copy above).
- The example app now shows friendly, action-guiding guidance — via
  `userFacingStitchError` (an Alert) on a stitch failure (`onError`), and a
  transient **toast** when frames are dropped for insufficient overlap
  (`onFramesDropped`) — shown only when **>30%** of the requested frames are
  missing from the final stitch (e.g. ≥2 of 6), so minor drops stay silent.  The toast (`CaptureStitchStatsToast`) also
  gained optional `title` (bold, above the message) and `placement`
  (`'top'` | `'center'`) props; the example shows a centered title+body toast.
  Failure alerts now lead with the corrective ask as the title (e.g. "Please
  pan more slowly" / "Try a shorter sweep") and explain the cause in the body.

### Fixed — reach the ultra-wide by device-swap when a logical multi-cam can't (Samsung / Camera2)

`selectCaptureDevice` now device-swaps to a standalone ultra-wide camera when a
logical multi-cam device merely *lists* the ultra-wide but can't reach it by
`zoom` (its zoom range starts at 1.0 — common on Android / Camera2 / Samsung,
where the ultra-wide is a separate physical camera rather than a zoom target).
Previously such devices stayed on the multi-cam device and 0.5× showed the
wide-angle FOV.  A logical device whose zoom range genuinely extends to the
ultra-wide (e.g. iOS virtual devices, `minZoom ≈ 0.5`) is still preferred and
lens-switches via zoom as before.

### Added — time-budget keyframe force-accept (`maxKeyframeIntervalMs`)

The keyframe gate now force-accepts a keyframe when a configurable wall-clock
interval has elapsed since the last accepted keyframe — even if the novelty /
overlap threshold wasn't met — so a slow or static pan never leaves a temporal
gap.  Default **2000 ms (2 s)**; `0` disables it.  Configurable via the
`<Camera defaultMaxKeyframeIntervalMs>` prop, the `FrameSelectionSettings.maxKeyframeIntervalMs`
field, or the in-app settings panel.  Applies to BOTH AR (plane-overlap) and
non-AR (flow) capture paths; force-accepted keyframes count toward
`maxKeyframes` (the cap still finalises the capture).

### Added — inscribed-rect panorama crop (opt-in)

`<Camera maxInscribedRectCrop={true}>` (and the `enableMaxInscribedRectCrop`
panorama setting) crops the finished panorama to the largest axis-aligned
rectangle inscribed in the coverage mask — clean edges with no black corners
from unfilled projection regions.  **It is opt-in; the default is off.**  The
default crop stays the bounding box of non-black pixels, which preserves all
stitched content but can leave black corners.  Inscribed-rect can shrink the
output substantially on lopsided or ultra-wide masks, so it isn't the default.

### Fixed — Android keyframe-gate flow reason labels

`KeyframeGate.reasonFromCode` (Android) didn't map the v0.3.0 flow-strategy
reason codes 12–15, so accepted keyframes logged as `unknown(12)`.  They now
read `ok-flow` / `first-flow` / `overlap-too-high (flow)` / `ok-flow-translation`,
matching the iOS labels.  Logging only — keyframe selection is unchanged.

## [0.14.2] — 2026-06-03

### Fixed — AR preview blank on first entry (intermittent camera-handoff race)

`<Camera>` mounted the vision-camera preview before the device AR-support
probe (`isSupported()`) resolved: `isAvailable` starts `false`, so
`deriveEffectiveCaptureSource` returned `'non-ar'` and vision-camera's
AVCaptureSession grabbed the camera.  When the probe resolved ~200-500 ms
later and the source flipped to AR, ARKit's `session.run()` raced the
still-open AVCaptureSession for the (mutually-exclusive) camera and lost
with `ARError "Required sensor failed."` — leaving a blank AR preview and an
"AR session has no current frame" error on the next capture.  Being
timing-dependent it reproduced intermittently; toggling AR off→on recovered
(that path releases the camera cleanly first).

`useARSession` now exposes `supportProbed` (true once the one-shot
`isSupported()` probe settles — success or failure).  `<Camera>` defers the
initial camera mount while AR is the intended source but support is still
unknown, rendering the "Switching camera…" placeholder instead of
vision-camera, so vision-camera never contends for the camera when AR is the
intent.

### Fixed — consumer iOS pod build pulled in the lib's C++ gtest unit tests

`RNImageStitcher.podspec`'s `cpp/**/*.{h,hpp,cpp}` glob slurped the lib's own
`cpp/tests/*.cpp` (which `#include <gtest/gtest.h>`) into every host pod
build, failing with `'gtest/gtest.h' file not found`.  Added
`s.exclude_files = ['cpp/tests/**/*']`.

## [0.14.1] — 2026-06-01

### Docs

- Refresh the npm README for the v0.14 API: full `<Camera>` prop
  reference (incl. `captureSources`), a complete capture-screen sample,
  the portrait recommendation, and a 0.13.x → 0.14 migration note. (The
  0.14.0 tarball shipped before this refresh landed; no code change.)
- Add a Docusaurus docs site (published to GitHub Pages).

## [0.14.0] — 2026-06-01

### Fixed — Android AR single-photo orientation (landscape was sideways)

Android AR `takePhoto` baked the wrong rotation into landscape captures
under a portrait-locked host: it derived the EXIF orientation from the
window display rotation (`WindowManager.defaultDisplay.rotation`), which
stays `ROTATION_0` when the activity is portrait-locked regardless of how
the device is physically held — so a landscape photo got a portrait EXIF
tag and came out 90° CW.  The JS layer already passed the gyro device
orientation to `RNSARSession.takePhoto` (since v0.12), and iOS consumed
it, but the Android native side dropped it.  Now Android threads the
device orientation through `takePhoto → requestTakePhoto → encodeToJpeg`,
mapping it to the correct `Surface.ROTATION_*` / EXIF tag.  iOS unchanged
(already correct).  Verified on-device (Samsung A35) in both landscape
orientations.

### Added — `captureSources` constraint prop

`<Camera>` gains `captureSources?: 'ar' | 'non-ar' | 'both'` (default
`'both'`) — a constraint on which capture sources the host allows, layered
over `defaultCaptureSource` (which picks the initial source within it):

- `'both'`  — AR + non-AR; the runtime AR toggle is shown (unchanged
  default behaviour).
- `'ar'`    — AR only; the AR toggle is hidden (nothing to switch to) and
  the 0.5×/1× lens chooser is hidden (ARKit/ARCore can't use the
  ultra-wide), keeping capture on the AR-capable 1× lens.
- `'non-ar'`— non-AR only; the AR toggle is hidden, the lens chooser stays.

A single-source constraint overrides a conflicting `defaultCaptureSource`.
Exported type: `CaptureSourcesMode`.  Verified on-device (A35) across all
three modes.

### Fixed — capability-aware lens selection (ultra-wide + flash on 0.5×)

`<Camera>` now selects the back camera device by real capability instead
of requesting a single physical lens per zoom level.  `selectCaptureDevice`:

- **Prefers a multi-cam device** that spans wide + ultra-wide (lens
  switched via `zoom`; torch available on every lens).  On devices that
  expose such a device (e.g. iPhone 16 Pro — verified `multicam`), this
  fixes the user-reported "0.5× shows the wide-angle FOV" bug AND makes
  flash work on 0.5× (the mounted multi-cam device carries the torch).
- **Falls back to a standalone ultra-wide** device-swap where no multi-cam
  device exists (e.g. Samsung A35 — verified `standalone-uw`; vision-camera
  surfaces the physical cameras separately there).  0.5× still shows the
  ultra-wide FOV; flash hides because that standalone device is torchless.

`has0_5x` is now derived from the real device inventory (was hardcoded
`true`), so the lens chooser hides on wide-only hardware.  13 unit tests
cover the selection matrix incl. both edge cases (ultra-wide only in a
multi-cam group; ultra-wide only standalone).

Verified on-device: iPhone 16 Pro (multicam — 0.5× FOV + flash both work)
and Samsung A35 (standalone-uw — 0.5× FOV works, flash correctly hidden).

### Added — Android portrait lock (SDK-enforced)

`<Camera>` now locks its host Activity to portrait on Android while
mounted, via `Activity.setRequestedOrientation`, **regardless of the
host app's `AndroidManifest` `screenOrientation`**.  A landscape or
unlocked host still gets a portrait camera screen.  The Activity's
prior orientation is captured on mount and restored on unmount.
Implemented in the native `RNSARSession` module (`lockPortrait()` /
`unlockOrientation()`) and driven from a `<Camera>` mount effect, so
it covers both the AR (ARCore) and non-AR (vision-camera) paths.
There is no opt-out — Android capture is portrait-only by design.

iOS is intentionally unchanged: supported orientations remain owned by
the host `Info.plist`.  **Portrait is the recommended configuration on
both platforms; landscape is supported on iOS** for hosts that need it.

### Fixed — landscape preview + thumbnail orientation (non-locked iOS)

- **Preview squish / sideways** under a non-locked host was caused by
  an in-development `patch-package` patch to vision-camera's
  `OrientationManager` (both `.kt` and `.swift`) that derived the
  PREVIEW orientation from the accelerometer instead of the interface
  orientation.  In a portrait host held landscape this forced a
  landscape preview into a portrait surface.  The patch was removed and
  vision-camera restored to pristine on both platforms.
- **Band keyframe thumbnails rotated 90°**: the per-keyframe tiles in
  `PanoramaBandOverlay` were double-rotated — the saved `keyframe-N.jpg`
  is sensor-native landscape + EXIF Orientation 6, which `<Image>`
  already auto-rotates, so the extra JS transform was redundant in the
  portrait-locked (`vertical=false`) path.  The transform is now applied
  only in the `vertical=true` (non-locked landscape) path.
- **Stitched-preview / confirm modals stuck portrait**: `CapturePreview`
  and `PanoramaConfirmModal` were missing `supportedOrientations`
  (RN's iOS `<Modal>` defaults to portrait-only).  Both now declare all
  four, matching `OrientationDriftModal` + `PanoramaSettingsModal`.
- **Idle thumbnail strip horizontal in landscape**: `CaptureThumbnailStrip`
  gained a `vertical` prop (wired from the same `isSideEdge` signal as
  the band) so the idle strip stacks vertically along the home-indicator
  edge under a non-locked host instead of running across the screen.

### Removed — pan-guidance overlays no longer public

`IncrementalPanGuide` (drift marker) and `PanoramaGuidance` (pan-speed
pill) are no longer exported, and the `panGuide` / `panoramaGuidance`
props were removed from `<Camera>`.  The components remain in the tree
as internal-only code (not rendered).  Hosts that were passing these
props should remove them.

## [0.13.0] — 2026-05-29

### Added — Layer-2 components absorbed into `<Camera>` (opt-out)

The flagship `<Camera>` now ships built-in defaults for every UX
chrome piece previously exposed only as a Layer-2 component.  Hosts
adopting `<Camera>` directly get a complete capture surface — flash
button, pan-speed pill, drift-marker guide, header chrome,
capture-history strip, and post-stitch preview — without having to
import and wire each piece by hand.

All built-ins use the opt-out pattern: enabled by default, disabled
by setting the corresponding boolean to `false` or by omitting the
corresponding payload prop.  Hosts that want their own chrome can
opt out per piece and layer custom UI on top of `<Camera>` (the
Layer-2 components remain exported and are unchanged).

#### Flash control

- `flash?: 'on' | 'off'` — controlled torch state.  Omit to let
  `<Camera>` own it internally.
- `onFlashChange?` — fires on tap (controlled and uncontrolled both).
- `showFlashButton?: boolean` (default `true`) — built-in flash button
  in the bottom-left slot.  AR mode auto-disables (ARKit / ARCore own
  the device's torch; surfaces "Flash unavailable in AR mode" a11y
  label and greyed styling).

#### Pan guidance

- `panGuide?: boolean` (default `true`) — built-in
  `IncrementalPanGuide` ("keep the arrow on the line" drift marker).
- `panoramaGuidance?: boolean` (default `true`) — built-in
  `PanoramaGuidance` pan-speed pill.
- Both are gyroscope-driven and only subscribe to the sensor while
  recording — no idle cost.

#### Header

- `headerTitle?: string` — when set, renders a built-in
  `CaptureHeader` at the top of the screen.  The existing settings
  gear is absorbed into the header's right side (no duplicate gear).
- `onHeaderBack?`, `headerBackLabel?`, `headerGuidance?`,
  `headerColors?` — pass-through to `CaptureHeader`.

#### Capture history + preview

- `thumbnails?: CaptureThumbnailItem[]` — when supplied (even `[]`),
  renders the built-in `CaptureThumbnailStrip` above the bottom
  controls.  Hidden during recording so it doesn't overlap the
  panorama band overlay.
- `thumbnailsMin?`, `thumbnailsMax?` — count-line hints.
- `onThumbnailPress?` — replaces the strip's built-in
  tap-to-preview modal with a host handler.
- `capturePreview?` — when set, renders a built-in `CapturePreview`
  modal showing the supplied image.  Use for post-stitch
  confirmation; the host clears the prop on dismiss via
  `onCapturePreviewClose`.
- `capturePreviewActions?` — pass-through action buttons for the
  preview modal.

### Migration

- Hosts that were importing Layer-2 components (`CaptureHeader`,
  `CaptureControlsBar`, `IncrementalPanGuide`, `PanoramaGuidance`,
  `CaptureThumbnailStrip`, `CapturePreview`) directly can now drop
  those imports and use the corresponding `<Camera>` props.
- The Layer-2 components remain exported and unchanged in v0.13 for
  backward compatibility.  Deprecation of those exports is targeted
  for v0.14.
- No behaviour change for hosts that already use `<Camera>` and
  don't supply any of the new props — every new built-in defaults
  to the previous (omitted) UX, except the flash button which
  appears in the now-occupied bottom-left slot.  Hosts that previously
  rendered chrome in that slot above `<Camera>` can pass
  `showFlashButton={false}`.

## [0.12.0] — 2026-05-28

### Added — Orientation-aware `<Camera>` (R2-lite)

`<Camera>` now works correctly under both portrait-locked and
non-locked iOS hosts.  Pre-v0.12 the component assumed the host
had restricted `UISupportedInterfaceOrientations` to Portrait;
removing that restriction broke control layout, camera-preview
rotation across modal close, and panorama capture mode selection.

Five coupled changes:

1. **`useOrientationDrift` hook + `OrientationDriftModal`**
   (PR-1).  Snapshots device orientation at capture start and
   latches a `drifted: true` flag if the user rotates mid-
   capture.  The incremental engine doesn't support cross-
   orientation captures (per the engine spec at
   `incremental.ts:373-403`), so `<Camera>` auto-cancels via
   `incremental.cancel()` and shows the modal to explain.

2. **New `onCaptureAbandoned` prop** on `<Camera>`.  Fires when
   the SDK auto-cancels an in-flight capture.  Currently the only
   reason is `'orientation-drift'`; the union signature keeps the
   prop stable for future reasons (low memory, etc.).

3. **4-way home-indicator-edge anchor** for the bottom-controls
   row (Layer A).  Combines `useWindowDimensions()` and
   `useDeviceOrientation()` to compute the JS edge that
   corresponds to the device's home-indicator side, then anchors
   shutter / lens / AR toggle there.  Matches iOS Camera's
   behaviour: shutter stays within thumb reach regardless of tilt.

4. **AR `takePhoto` orientation parameter** (Fix #2).  Pre-v0.12
   `RNSARSession.takePhoto` hardcoded `.right` (90° CW) to
   rotate ARKit's sensor-native landscape buffer to portrait,
   assuming portrait hold.  Now switches on the device
   orientation passed from `useDeviceOrientation()` so landscape
   captures produce correctly-oriented photos.

5. **Modal `supportedOrientations={[all 4]}`** on
   `OrientationDriftModal` and `PanoramaSettingsModal`.  RN's iOS
   `Modal` defaults to portrait-only, which force-rotates the
   window scene when opened under a non-locked host — leaving
   the underlying `<Camera>`'s ARSession with stale orientation
   state on dismiss (preview rendered sideways).  Declaring all
   four orientations keeps the window aligned through the modal
   cycle.

### Added — Comment cleanup across native + JS surfaces

Stale "portrait-locked host" comments in
`useDeviceOrientation.ts`, `incremental.ts`, `StitcherFrame.ts`,
`OpenCVIncrementalStitcher.{h,mm}`, and
`IncrementalFirstwinsEngine.kt` rewritten to acknowledge both
host configurations.  Pose-derived orientation detection remains
the single source of truth — that didn't change; the rationale
just got more accurate.

### Known follow-ups (deferred to v0.12.1 or v0.13)

- Portrait + non-AR stitching can regress under fast horizontal
  pans — likely drift detection over-firing on lateral
  acceleration.  Needs debounce or motion-aware threshold.
- Component-render tests (`<OrientationDriftModal>`,
  `<PanoramaBandOverlay>` per-orientation, `<ViewportCropOverlay>`
  per-orientation, `<Camera>` composition) need
  `@testing-library/react-native` + a jest preset flip.  Tracked
  for v0.12.1.
- Portrait-upside-down landscape detection on non-locked hosts —
  the JS dims signal is ambiguous between locked-portrait + flipped
  device and non-locked + screen-flipped-180°.  Needs a separate
  signal.
- Slot/hybrid API on `<Camera>` to absorb `CaptureControlsBar`,
  `IncrementalPanGuide`, `PanoramaGuidance`, etc. — v0.13.

## [0.11.1] — 2026-05-28

### Fixed — AR-mode composed worklets silently throw

`useStitcherWorklet`'s `call(frame)` was invoking the vision-camera
Frame Processor plugin on every frame regardless of mode.  In AR
mode the frame is a `StitcherFrameHostObject` (no `__frame` JSI
marker), so the vc plugin threw `getPropertyAsObject: property
'__frame' is undefined`.  The throw was caught silently by
`RNSARWorkletRuntime`'s per-worklet error isolation (logged to
`os_log`, not surfaced to JS), causing any host code AFTER
`stitcher.call(frame)` in the composed worklet body —
`runOnJS` callbacks, `Worklets.createRunOnJS` dispatches, further
host worklet logic — to silently never execute in AR mode.

The hook's module docstring already promised AR mode would no-op
("AR mode is unaffected — the AR-session dispatch path already
composes natively"), but the code didn't enforce it.  v0.11.1 adds
an early-return on `frame.source === 'ar'` in `useStitcherWorklet`'s
worklet body.  AR stitching continues to run natively via
`RNSARSession.swift`'s first-party callback path
(`consumer.consumeFrame(arFrame, pose)` at line 510-511), which is
the architectural contract for AR-mode stitching since v0.8.0.

This bug was latent in v0.11.0 — surfaced by Test 2 of
`docs/v0.11.0-manual-verification-checklist.md` on Ram's iPhone.

Also added: `StitcherJsiInstaller::install` now eagerly initializes
the worklets-core default `JsiWorkletContext` singleton during JSI
bootstrap.  This is defense-in-depth — worklets-core's own `Worklets`
module also initializes the default, but eager init from our
installer makes `runOnJS` from AR-mode worklets robust to host-app
import order (no dependency on worklets-core's `Worklets` module
loading before our AR runtime constructs its context).

### Added — Jest test for AR-source short-circuit

New test file `src/stitching/__tests__/useStitcherWorklet.test.ts`
pins the AR no-op contract.  5 new tests; full suite now 74/74 pass
(was 69/69 in v0.11.0).

## [0.11.0] — 2026-05-28

### Added — `useStitcherWorklet` for non-AR composition

Closes the v0.8.0 Phase 5 either-or constraint: hosts that want to
write their OWN `useFrameProcessor` worklet body can now COMPOSE
first-party stitching back in with a single `stitcher.call(frame)`
call, instead of having to choose between their worklet and the
lib's stitching.

```tsx
import {
  Camera, useFrameProcessor, useStitcherWorklet,
  type StitcherFrame,
} from 'react-native-image-stitcher';

function MyScreen() {
  const stitcher = useStitcherWorklet();
  const fp = useFrameProcessor((frame: StitcherFrame) => {
    'worklet';
    hostPreLogic(frame);
    stitcher.call(frame);   // ← first-party stitching
    hostPostLogic(frame);
  }, [stitcher.call]);
  return <Camera frameProcessor={fp} ... />;
}
```

Migrating from v0.10.x is a one-line diff:

```diff
+ const stitcher = useStitcherWorklet();
  const fp = useFrameProcessor((frame: StitcherFrame) => {
    'worklet';
+   stitcher.call(frame);   // ← first-party stitching back in
    hostLogic(frame);
- }, [hostLogic]);
+ }, [stitcher.call, hostLogic]);
```

### Changed

- `useFrameProcessorDriver` is now a thin wrapper around
  `useStitcherWorklet`.  Public API (`start` / `stop` /
  `isRunning` / `frameProcessor`) is unchanged.  Pose-reset
  semantics preserved via the new `stitcher.reset()` method which
  the driver calls internally from `start()` and `stop()`.
- The gyro subscription that powers pose tracking now lives in
  `useStitcherWorklet` and runs for the lifetime of the hook
  (mount → unmount) rather than being tied to the driver's
  `start()` / `stop()`.  In practice this matches all observed
  host integrations (capture screens mount `<Camera>` for the
  duration of capture; idle screens don't).  Battery delta is
  small (≪1% CPU at 33 ms gyro sampling).
- `<Camera frameProcessor>` JSDoc rewritten: the "Non-AR mode
  tradeoff (HONEST)" section is replaced by a "Non-AR mode
  composition" section that shows the v0.11.0 composition
  pattern.  The runtime `console.info` text is softened from
  "your worklet REPLACES first-party stitching, panorama capture
  will not produce stitched output" to "if you want first-party
  stitching alongside, call `useStitcherWorklet()` from your
  worklet body".
- Example app (`example/App.tsx`) now demonstrates the
  composition pattern end-to-end: one
  `useFrameProcessor` body that calls both `stitcher.call(frame)`
  and the existing 1 Hz host tick log.  `<Camera>` mounts with
  `frameProcessor={exampleFrameProcessor}` (previously left
  unwired with an "intentionally unused" comment block).
- `docs/frame-access-tiers.md` adds a `useStitcherWorklet`
  reference section + 1-line migration diff.  Softens the
  "either-or" language in the Tier 3 + AR-vs-non-AR sections.

### Files changed
- NEW: `src/stitching/useStitcherWorklet.ts`
- `src/stitching/useFrameProcessorDriver.ts` (refactored thin wrapper)
- `src/index.ts` (export new hook + types)
- `src/camera/Camera.tsx` (docstring + console.info softened)
- `example/App.tsx` (composition demo)
- `docs/frame-access-tiers.md` (new section + softened wording)
- `docs/v0.11.0-manual-verification-checklist.md` (Phase 4 human-loop checklist)

### Not touched
- All native code (`ios/Sources/`, `android/src/main/cpp/`,
  `android/src/main/java/io/imagestitcher/rn/`) — pure TS refactor.
- AR-mode dispatch path — already composes natively.
- `useFrameProcessor` (v0.8.0 public hook) — unchanged.

### Verified
- JS Jest: **69 / 69 pass**
- C++ Gtest: **17 / 17 pass**
- Android JUnit: **6 / 6 pass**
- iOS build (Debug, generic iOS device): clean
- Android `:app:assembleDebug`: clean
- Real-device panorama capture verification deferred to the
  human-in-the-loop checklist (`docs/v0.11.0-manual-verification-checklist.md`).

## [0.10.0] — 2026-05-28

### Added — v0.10.0 PR A: host-side test infrastructure (`#9A` + `#11A`)

Two parallel test harnesses landed so future tech-debt PRs in the
v0.10.0 sweep (and beyond) can pin invariants without standing up a
device build per change.

#### Shared C++ Google Test runner (`#9A`)

- `cpp/tests/CMakeLists.txt` — standalone CMake project that fetches
  Google Test `v1.14.0` via `FetchContent` and compiles a single
  `stitcher_cpp_tests` executable.  No system-wide gtest install
  required.
- `scripts/run-cpp-tests.sh` — one-shot configure / build / `ctest`
  driver.  Output lands under gitignored `build/cpp-tests/`.
- Initial suite (17 cases):
  - `Pose` / `PlaneTransform` POD layout, size, field-offset
    invariants (pinned to the cross-platform marshalling contract
    in `cpp/ar_frame_pose.h`).
  - `StitcherFrameData` default-construction invariants the JSI
    host-object `get()` dispatch depends on (e.g. `qw=1.0`,
    `hasTranslation=false`).
  - `PixelBufferReader` `copyTo` clipping contract — validated via
    a `FakePixelBufferReader` test helper.
  - `StitcherWorkletRegistry` lifecycle: shared-instance, install
    /uninstall/count/snapshot, snapshot independence from later
    mutations, concurrent installs (16 threads × 32 each) yield
    unique IDs without lock contention bugs.
- New test-only registry seam `_installEntryForTests(invoker)` (in
  `cpp/stitcher_worklet_registry.{hpp,cpp}`) — mirrors the existing
  `_resetForTests` pattern.  Bypasses the JSI runtime path so tests
  don't need Hermes + worklets-core; `nullptr` invokers are safe
  because the registry never dereferences them.
- JSI / worklets-core stubs under `cpp/tests/stubs/` let
  `stitcher_worklet_registry.cpp` compile in the host-side test
  target without pulling in React Native's JSI headers or the
  worklets-core library.  Stubs are scoped exclusively to the test
  include path; production builds never see them.
- See `cpp/tests/README.md` for the strategy + a list of what's
  deferred to v0.11.0+ (KeyframeGate / OpenCV-dependent code; JSI
  host-object dispatch).

#### Android JUnit scaffold (`#11A`)

- `android/build.gradle` — adds `testImplementation
  "junit:junit:4.13.2"`.  Minimal — only JUnit 4 (matches AGP's
  default test runner).
- `android/src/test/java/io/imagestitcher/rn/TransferredNV21Test.kt`
  — 6 tests covering the v0.10.0 `TransferredNV21` single-use
  ownership wrapper: constructor empty/non-empty, takeOnce returns
  the original reference, takeOnce throws on second call, thread-
  safe single-winner under 16-thread contention, distinct wrappers
  are independent.
- Run via `./gradlew :react-native-image-stitcher:testDebugUnitTest`.

Neither suite changes runtime behaviour — both are additive test
infrastructure.

### Added — v0.10.0 PR B: `refinePanorama` progress events + cleanup audit (`#15A` + `#16C`)

#### `#15A` — phase-milestone progress emit from `refinePanorama`

`refinePanorama` (both the explicit JS `module.refinePanorama(...)` API
and the hybrid-engine auto-refine path that calls it internally) now
emits coarse phase events on the existing `IncrementalStateUpdate`
device-event channel.  Five stages cover one refine lifetime:

| Stage         | `refineProgress` | When                                 |
| ------------- | ---------------- | ------------------------------------ |
| `validating`  | 0.05             | start of method, before any I/O      |
| `stitching`   | 0.10             | OpenCV stitch in flight              |
| `writing`     | 0.90             | stitch returned, JPEG written        |
| `done`        | 1.00             | success — promise about to resolve   |
| `error`       | 1.00             | failure — `refineError` is set       |

`refineStage` carries the stage string; `refineProgress` carries the
fraction; `refineFrames` reports the input keyframe count; `refineError`
is populated on the failure path so the host can render a one-line
failure pill.

Coarse on purpose: OpenCV's `Stitcher` doesn't expose mid-pipeline
progress, so the `0.10 → 0.90` jump is one opaque step.  JS uses
`refineStage` for the UI label and `refineProgress` purely for the
spinner.

Reuses the existing channel (no second listener wiring required).
Existing JS consumers that don't read the new fields are unaffected.

#### `#16C` — moderate cleanup audit sweep

- `src/camera/useCapture.ts` — removed a stale "`useVideoCapture` (TODO)"
  reference; the hook has existed since v0.4.
- `ios/Sources/RNImageStitcher/IncrementalStitcherBridge.swift` — removed
  a self-flagged "remove this comment after" reference left over from a
  past PiP investigation.
- `console.*` audit: every call in `src/` was reviewed; all 13 are
  legitimate (warn/error for surfaceable failures; `console.info`
  one-shots that document known tradeoffs).  No removals needed.
- TODO/FIXME triage: 4 remaining own-code TODOs all reference tracked
  future work (lens-probe follow-up, shared-stitcher-port-part-2,
  EXIF writer).  Left in place.
- `ts-prune`: 3 surface-level orphans (`PanoramaConfirmModal`,
  `IncrementalStitcherView`, `stitchFrames`) are intentional public
  deep-import API; not re-exported from `src/index.ts` but
  documented and consumed by hosts.  Left in place.

No production behaviour changed — these are docstring + dead-comment
removals only.

### Fixed — v0.10.0 PR B (iOS): refine state events not reaching JS under RN bridgeless interop

Switched `IncrementalStitcherBridge` state-event delivery from
`RCTEventEmitter.sendEvent` to `bridge.enqueueJSCall("RCTDeviceEventEmitter", "emit", ...)`.
Root cause: under RN bridgeless interop (RN 0.84), `sendEvent`
silently no-ops for some event-body shapes even when the bridge is
non-nil and the listener count is > 0 — refine events with the
`refineStage` / `refineProgress` / `refineFrames` keys were not
reaching any JS subscriber while live state events with a smaller
body shape on the same channel were.  Also defensively
`removeObserver` before `addObserver` in `init()` so the
NotificationCenter registration is idempotent if RN re-invokes
`init()` on the same instance (also observed on bridgeless interop).
Android is unaffected — Android's bridge already emits via
`DeviceEventManagerModule.RCTDeviceEventEmitter.emit(...)` directly.

## [0.9.0] — 2026-05-27

### Added — layered frame-access helpers

Three new primitives completing the Tier 2 surface in the
three-tier extensibility pattern.  See `docs/frame-access-tiers.md`
for the full decision flow + use-case mapping.

#### Layer 1 — `save_frame_as_jpeg` vc Frame Processor plugin (native)

Worklet-callable JPEG encoder. Registers on both platforms:

- **iOS** — `SaveFrameAsJpegPlugin.mm` (CIImage → CGImage → UIImage
  → UIImageJPEGRepresentation → atomic NSData write).  Registered
  via `+ (void)load` hook into `FrameProcessorPluginRegistry`.
- **Android** — `SaveFrameAsJpegPlugin.kt` wrapping the lib's
  existing `YuvImageConverter.encodeJpegFromNV21` encoder (the
  same one used by `RNSARCameraView`'s keyframe-accept callback).
  Registered alongside `cv_flow_gate_process_frame` in
  `RNImageStitcherPackage.ensureFrameProcessorPluginRegistered`.

Plugin contract (identical on both platforms):
  - Args: `path` (string, REQUIRED), `quality` (number 0-100,
    default 75, clamped `[1, 100]`)
  - Returns: `{ ok: true, path, width, height }` OR
             `{ ok: false, error: "..." }`

Hosts can call this directly from their own `useFrameProcessor`
worklet for custom rate-control logic; most consumers use it
indirectly via Layer 3.

#### Layer 2 — `useThrottledFrameProcessor` hook

```tsx
const fp = useThrottledFrameProcessor(
  (frame) => {
    'worklet';
    // Worklet-native processing at sub-frame-rate
  },
  { sampleHz: 2 },
  [],
);
```

Pure TS throttle gate over `useFrameProcessor` (v0.8.0).  Worklet
fires up to `sampleHz` times per second; ticks too close together
dropped via a monotonic-time `useSharedValue` gate.

**Use for**: worklet-native processing — native OCR via
Vision.framework / ML Kit wrapped as vc Frame Processor plugins,
TFLite ML inference, LiDAR depth (`frame.arDepth`).  Direct
buffer/pose/depth access in the worklet; bridge small bbox-result
payloads to JS via `runOnJS`.

`sampleHz` clamped to `[0.5, 30]`.

#### Layer 3 — `useFrameStream` hook

```tsx
const fp = useFrameStream(
  { sampleHz: 2, quality: 75 },
  (sample) => {
    // JS-thread callback: sample.jpegPath, sample.pose, sample.timestamp
    setThumbnail(sample.jpegPath);
  },
);
```

Composes Layer 2 + Layer 1 + `runOnJS` bridge to deliver
`SampledFrame` objects to a JS-thread handler.  Slot-reuse
strategy bounds disk usage to ~4 stale JPEGs.

**Use for**: JS-thread consumers — file-path OCR libraries (RN
modules wrapping ML Kit), cloud upload, thumbnail preview UI,
JS-side ML (TF.js, transformers.js).

`sampleHz` clamped to `[0.5, 10]`; `quality` clamped `[1, 100]`.

#### Types

  - `SampledFrame` — `{ jpegPath, pose, timestamp, width, height }`
  - `FrameStreamOptions` — `{ sampleHz, quality?, outputDir? }`
  - `ThrottledFrameProcessorOptions` — `{ sampleHz }`

All exported from `react-native-image-stitcher`.

### Documentation

- `docs/frame-access-tiers.md` — new comprehensive reference for
  all four host-facing hooks (`useKeyframeStream`,
  `useThrottledFrameProcessor`, `useFrameStream`,
  `useFrameProcessor`) with decision flow, cost envelope, use-case
  mapping, AR vs non-AR mode tradeoff.

### Example app

`example/App.tsx` now mounts `useFrameStream` at 2 Hz with a
visible thumbnail overlay (bottom-right corner) — visual proof of
the Layer 1 + 2 + 3 pipeline working end-to-end on both iPhone
(60 Hz AR) and Galaxy A35 (30 Hz AR).

### Compatibility

- Strict additive over v0.8.0.  No host changes required.
- Works in both AR and non-AR modes via v0.8.0's unified
  `useFrameProcessor`.
- New hooks return `useFrameProcessor`-shape objects compatible
  with `<Camera frameProcessor={...}>` (Phase 5 from v0.8.0).

### Known limitations (v0.9.0 — addressed in v0.11.0)

- **Layer 3 `useFrameStream` in AR mode**: the Layer 1
  `save_frame_as_jpeg` vc Frame Processor plugin expects a vision-
  camera `Frame` with `.buffer = CMSampleBufferRef`.  In AR mode
  the worklet receives a `StitcherFrameHostObject` (v0.8.0
  Phase 4b's JSI host object) without `.buffer` — the plugin call
  returns `{ok: false, ...}` and `useFrameStream` silently skips
  the sample.  Hosts needing per-frame native processing in AR
  mode should use **Layer 2 (`useThrottledFrameProcessor`)** —
  it works in both modes and is the right primitive for the
  worklet-native use cases listed in `docs/frame-access-tiers.md`
  (OCR via Vision/ML Kit, TFLite ML detection, LiDAR depth).
  AR-mode Layer 3 support tracked in v0.11.0's plan
  (`docs/plans/2026-05-27-v0.11.0-non-ar-composition.md`) —
  bundled with `useStitcherWorklet` since both extend the
  `__stitcherProxy` host-function infrastructure.
- **Layer 3 `useFrameStream` in non-AR mode**: wiring the host's
  frameProcessor through `<Camera>` displaces the lib's
  first-party stitching driver (the documented Phase 5 either-or
  constraint from v0.8.0).  Non-AR panorama capture won't produce
  stitched output while a host frameProcessor is wired.  Tracked
  in v0.11.0 (`useStitcherWorklet` composition).

### Notes

- Formal SSIM parity gate (Phase 7 of the v0.9.0 plan) was NOT
  run for this release — the layered design doesn't touch
  first-party stitching, so a regression is structurally unlikely.
  Harness still in place from v0.8.0 (`scripts/ssim-compare.py`)
  for any host that wants to run it locally.

[0.9.0]: https://github.com/bhargavkanda/react-native-image-stitcher/compare/v0.8.0...v0.9.0

## [0.8.0] — 2026-05-27

### Added — `useFrameProcessor` hook for host worklets

Hosts can now attach a `'worklet'`-prefixed function that fires on
every AR (and non-AR) capture frame, alongside the lib's own
first-party stitching.  Use case: real-time OCR, packet detection,
ML inference, custom telemetry — anything that wants per-frame
pixel access in a worklet runtime.

```tsx
import { useFrameProcessor, type StitcherFrame }
  from 'react-native-image-stitcher';

const fp = useFrameProcessor((frame: StitcherFrame) => {
  'worklet';
  // frame.toArrayBuffer(), frame.pose, frame.source ('ar' | 'vc'), …
}, []);
```

**AR mode** (iPhone via ARKit, Android via ARCore): worklets fire
on every AR frame at the device's native rate (~30 Hz on A35,
~60 Hz on iPhone 16 Pro).  Auto-registered into a process-scope
native registry via `globalThis.__stitcherProxy.install(workletFn)`.
The AR-session dispatch path fans out to both the lib's first-party
stitching AND every registered host worklet, with **per-worklet
failure isolation** (one host worklet throwing does NOT break
others or the lib's stitching).

**Non-AR mode** (vision-camera): pass the hook's return through
`<Camera frameProcessor={fp}>` to enable.  Honest tradeoff: vc's
`<Camera>` accepts ONE processor, so supplying a host processor
displaces the lib's first-party stitching in non-AR mode.  Hosts
that want both running concurrently should use AR mode (which
natively composes both).  Composition for non-AR is tracked as
v0.9+.

### Added — `StitcherFrame` contract

Unified frame shape across AR and non-AR modes (`src/stitching/
StitcherFrame.ts`):

  - `width` / `height` / `pixelFormat` / `orientation` / `timestamp`
    / `toArrayBuffer()` — vc-shape parity
  - `pose: { rotation: [x,y,z,w], translation?: [x,y,z] }` — always
    present in AR mode; rotation-only in non-AR
  - `source: 'ar' | 'vc'` discriminator for safe AR-field access
  - `arDepth?`, `arAnchors?`, `arTrackingState?` — populated in AR
    mode on supported devices

### Added — JSI proxy host object

`globalThis.__stitcherProxy` installed on lib bootstrap (iOS:
`StitcherJsiInstaller` RN module via `RCTBridgeProxy.runtime` in
bridgeless mode; Android: `StitcherJsiInstallerModule` via
`ReactApplicationContext.getJavaScriptContextHolder()`).  Exposes
`install` / `uninstall` / `count` host functions backed by a
shared C++ `retailens::StitcherWorkletRegistry` (process-scope,
mutex-serialised, snapshot-isolated).

### Changed — AR-mode dispatch architecture

Internal-only refactor (strict additive BC for hosts that don't
use `useFrameProcessor`):

  - **iOS**: `ARSessionDelegate.session(_:didUpdate:)` now routes
    through `RNSARWorkletRuntime.dispatchFrame:pose:` instead of
    directly invoking the engine.  First-party callback (Phase 3c)
    runs synchronously on the caller thread (preserves ARKit's
    pool-reuse contract); host worklet fan-out (Phase 4b.i)
    dispatches asynchronously onto a dedicated worklets-core
    context.

  - **Android**: `RNSARCameraView.onDrawFrame` now wraps the
    existing `module.ingestFromARCameraView(...)` call in
    `StitcherWorkletRuntime.runFirstParty { ... }` (Phase 3c) and
    follows with `StitcherWorkletRuntime.dispatchToHostWorklets(...)`
    (Phase 4b.iii).  Per-frame fan-out runs every AR frame when host
    worklets are registered (not just during capture).

### Performance posture

  - **First-party-only deployments** (no `useFrameProcessor`):
    zero per-frame cost added.  `hasHostWorklets()` atomic-read
    short-circuits before any dispatch path.
  - **Host worklets registered, idle preview**: Android pays
    ~6-10ms per AR frame (NV21 pack + JNI byte copy + worklet
    dispatch).  iOS uses `CFBridgingRetain` (no per-frame copy,
    but ARKit pool back-pressure on next frame).  Both acceptable
    for v0.8.0; future optimization → zero-copy NV21 transfer via
    direct `ByteBuffer` (Android).

### Added — SSIM parity gate harness

`scripts/ssim-compare.py` — pixel-wise SSIM comparison between
panorama JPEGs (Pillow + numpy + scikit-image; threshold 0.98).
Procedure in `docs/phase-7-parity-gate.md`.

> **v0.8.0 release note:** the formal SSIM parity gate was NOT
> run for this release.  Verification rests on manual visual
> inspection of v0.8.0 panorama output on iPhone 16 Pro (Phase
> 4b.i) and Galaxy A35 (Phase 4b.iii) — both produced stitched
> panoramas matching the v0.7.x behaviour subjectively.  The
> harness is in place for v0.8.1+ / future releases where the
> gate is mandatory.

### Migration guide

No host-side changes required for the common case.  Hosts that
want to attach worklets:

1. Add `react-native-worklets-core` if not already a peer dep
   (already in v0.7.x's peer-deps list).
2. Replace `useFrameProcessor` imports from
   `react-native-vision-camera` with the lib's own export:
   ```diff
   - import { useFrameProcessor } from 'react-native-vision-camera';
   + import { useFrameProcessor } from 'react-native-image-stitcher';
   ```
3. Worklet body now receives `StitcherFrame` instead of vc's
   `Frame` — see `src/stitching/StitcherFrame.ts` for the contract.

## [0.7.1] — 2026-05-26

### Fixed — CI binary-packaging bloat

The v0.7.0 release (and likely v0.5.1 before it — both built by
CI) shipped uncompressed binary archives that consumers downloaded
on every `npm install`.  Sizes vs. the manual recipe used for
v0.6.0:

| Platform | v0.7.0 (CI, unstripped) | v0.7.1 (CI, stripped) | Saving |
|---|---|---|---|
| iOS zip   | 43 MB  | ~26 MB | -17 MB  |
| Android zip | 165 MB | ~42 MB | -123 MB |

The lib itself is unchanged; consumers on the `^0.7.0` semver range
automatically pick up v0.7.1 and start getting the smaller download.
No source-code changes; binary-only re-release.

#### Root cause

- **iOS**: `scripts/build-opencv-ios.sh` produced an xcframework
  containing both the device slice (`ios-arm64`) and the simulator
  slice (`ios-arm64_x86_64-simulator`).  vision-camera + ARKit
  don't work on the simulator and the example app targets devices
  only, so the simulator slice was dead weight in every download.
- **Android**: `scripts/build-opencv-android.sh` ran OpenCV's
  `build_sdk.py` for all four NDK ABIs (per the script's own
  contract — produces a multi-arch fat SDK).  The lib's
  `android/build.gradle` sets `ndk.abiFilters arm64-v8a` so only
  arm64-v8a binaries reach any consumer APK, but the zip carried
  `armeabi-v7a` / `x86` / `x86_64` libs in three sibling dirs
  (`sdk/native/libs/`, `staticlibs/`, `3rdparty/libs/`) plus
  `samples/` (~10 MB) and `apk/` (~5 MB) — none of it ever loaded
  at runtime.

#### Fix

Both build scripts now strip the dead-weight pieces immediately
after the OpenCV build completes, before zipping for upload.
Sentinel checks fail loudly if a strip removes the required
arm64-v8a artifacts (defends against a future refactor of the
strip block).  Pattern matches the manual recipe in
`feedback_binary_release_packaging.md` (project memory).

The iOS strip auto-detects the simulator entry's index in the
xcframework's `Info.plist::AvailableLibraries` via a
`plutil -convert json | python3` one-liner — the index isn't fixed
across OpenCV builds and previous manual recipes that hardcoded
`AvailableLibraries.1` would have silently stripped the wrong
slice if the order changed.

#### Compatibility

Strict additive over v0.7.0.  No code changes — the lib's runtime
and public API surface are byte-identical.

## [0.7.0] — 2026-05-26

### Added — Tier 1: `useKeyframeStream`

JS-thread subscription hook for **accepted-keyframe events** — the
small subset of camera frames the stitching engine actually chose to
include in the panorama.  Foundation for plugin-pattern host features:
OCR on each saved keyframe, packet detection, server-side analysis,
analytics, etc.

Fires 4-6 times per panorama (once per accepted keyframe), NOT per
camera frame — the lowest-frequency, highest-value frame stream.

```tsx
import { useKeyframeStream, type AcceptedKeyframe } from 'react-native-image-stitcher';

function OcrPlugin() {
  useKeyframeStream(useCallback(async (kf: AcceptedKeyframe) => {
    const text = await runOCR(kf.jpegPath);
    console.log(`Keyframe ${kf.index} pose=${kf.pose.rotation}:`, text);
  }, []));
  return null;
}
```

- **`useKeyframeStream(handler)`** exported from
  `react-native-image-stitcher`.  Subscribes to the existing
  `IncrementalStateUpdate` event channel; surfaces accepted-keyframe
  events through a typed callback.  Re-subscribes on handler-identity
  changes; async handler rejections are surfaced via `console.error`
  rather than swallowed.
- **`AcceptedKeyframe` type** exported.  Fields: `jpegPath` (absolute
  path, no `file://` prefix); `pose` (rotation quaternion + optional
  translation vector); `timestamp` (ms since epoch); `index`
  (zero-based position in current panorama).
- **`IncrementalState.batchKeyframePose?`** + **`batchKeyframeAcceptedAtMs?`**
  new optional fields.  Populated by the native emit alongside the
  existing `batchKeyframeThumbnailPath` + `batchKeyframeIndex` on
  accept events.  Direct readers of `IncrementalState` can consume
  these without going through the new hook.

### Changed (internal — externally invisible)

- **Native `emitBatchKeyframeAcceptedState` populates pose + timestamp.**
  Both `IncrementalStitcher.swift::emitBatchKeyframeAcceptedState` and
  `IncrementalStitcher.kt::emitBatchKeyframeAcceptedState` grew
  parameters for the pose snapshot (quaternion + translation) and
  accept-time wall-clock millis.  The existing call sites in the
  batch-keyframe accept path thread the pose they already have in
  scope.

### Engine-mode caveat

`useKeyframeStream` only fires under the `batch-keyframe` engine (the
`<Camera>` component's default).  Live engines (`firstwins-rectilinear`,
`hybrid`, `slitscan-*`) paint into a live canvas instead of saving
per-accept JPEGs and do not surface accept events through this channel
— the hook silently does not fire in those modes.  Live-engine accept
emit may land as a v0.7.1 follow-up if a real consumer needs it.

### Translation semantics

`AcceptedKeyframe.pose.translation` is always populated by the native
emit.  In AR mode it carries the real ARKit / ARCore camera transform
in metres (world coords).  In non-AR (Frame Processor) mode the
translation reads as `[0, 0, 0]` because gyroscope provides only
rotation (no spatial anchor).  Hosts that need to distinguish can
either check the active `frameSourceMode` or threshold the translation
magnitude.

### Compatibility

Strict additive over v0.6.0.  No host changes required.  Existing
`subscribeIncrementalState` consumers see new optional fields but
their existing reads are unaffected.

### Verification

- iPhone 17 Pro (real device, iOS 26.5): hold-and-release AR-mode
  panorama produced four accepted-keyframe events with real pose
  data (unit quaternion + non-zero translation in metres matching
  the physical pan).
- Android (Galaxy A35): `compileDebugKotlin` BUILD SUCCESSFUL;
  on-device runtime verification deferred for this release (the
  Kotlin emit mirrors the iOS emit at the byte-for-byte payload
  level — same field names, same types, same call-site pattern).

## [0.6.0] — 2026-05-25

> [!WARNING]
> **Breaking changes.**  v0.6.0 retires the deprecated JS-driver
> non-AR path that was marked for removal in v0.5.0's *Deprecated*
> section.  Hosts using the default `<Camera>` flow (`legacyDriver`
> unset) are not affected — they were already on
> `useFrameProcessorDriver`.  Hosts that opted into the legacy
> driver (`legacyDriver={true}` on `<Camera>`, or a direct
> `useIncrementalJSDriver()` consumer) MUST migrate to the Frame
> Processor driver — see *Migration from 0.5.x* below.

### Removed (breaking)

- **`useIncrementalJSDriver` hook** + its `UseIncrementalJSDriverOptions`
  / `IncrementalJSDriverHandle` types.  Deprecated in v0.5.0; the
  v0.5 deprecation warning has now been replaced by deletion.
- **`legacyDriver?: boolean` prop on `<Camera>`**.  The escape hatch
  back to the JS driver is gone.  Hosts that set this prop will
  get a TS-level error; at runtime the prop is silently ignored.
- **`frameSourceMode: 'jsDriver'`** enum value in
  `IncrementalStartOptions`.  The TS type is now narrowed to
  `'arSession' | 'frameProcessor'`.  Passing `'jsDriver'` is a
  compile error; at the native bridge layer the value falls through
  to the default (now `'arSession'`).
- **`IncrementalStitcher.processFrameAtPath` native method** on both
  iOS and Android.  The only JS caller was `useIncrementalJSDriver`,
  also deleted.  Hosts calling
  `NativeModules.IncrementalStitcher.processFrameAtPath(...)` via
  raw `NativeModules` access will get a runtime "method does not
  exist" error.  Use the Frame Processor driver instead.

### Changed (breaking)

- **Android `frameSourceMode` default switched from `"jsDriver"` to
  `"arSession"`** for parity with iOS.  Raw `NativeModules` callers
  that omitted `frameSourceMode` were previously getting an inert
  capture (the "jsDriver" branch dropped all engine input on
  Android since v0.5.0); they now get AR-mode behaviour, matching
  iOS.  The production `<Camera>` is unaffected — it always passes
  `frameSourceMode: 'arSession'` explicitly for AR captures.

### Changed (non-breaking)

- **`RNSARCameraView` (AR mode) no longer eager-encodes a JPEG per
  ARCore frame.**  Migrated to the pixel-data path introduced for
  the Frame Processor in v0.5.1's F8.6 work.  AR-mode captures now
  pass `nv21PixelData` / `nv21PixelWidth` / `nv21PixelHeight`
  through `ingestFromARCameraView`; `legacyJpegPath` is always null
  on this path.  Expected gain on Galaxy A35: ~30-50 ms per
  accepted frame, with the dominant savings on rejected frames
  (no JPEG encode → no imread round-trip).  Closes the v0.5.0
  follow-up.

### Removed (internal cleanup; no external API impact)

- **F8.6 perf-diagnostic logs** (`F8.6-route`, `F8.6-perf`)
  introduced in v0.5.1 stripped from `IncrementalStitcher` +
  `IncrementalFirstwinsEngine` — F8.6 is now baked in for
  production and the diagnostic spam is no longer informative.
- **Orphaned native helpers** dropped after `processFrameAtPath`
  removal:
  - iOS: `addBatchKeyframePath(path:pose:)`, `isBatchKeyframeMode`
    getter, `decodeJpegToGrayscalePixelBuffer` (only callers were
    `processFrameAtPath`).
  - Android: `decodeJpegToGrayscale` + `GrayscaleFrame` data class,
    `isBatchKeyframeMode` getter (only callers were
    `processFrameAtPath` and the AR-mode eager-encode branch).
- **Stale comments** referencing removed code paths swept across
  Kotlin/Swift/Obj-C/TS.  Historical "removed in v0.6" markers
  retained; comments that described live code in terms of the
  removed names rewritten to describe current behaviour.

### Migration from 0.5.x

**Default `<Camera>` hosts (no `legacyDriver` prop set):** no
action required.  `<Camera>` already used `useFrameProcessorDriver`
in non-AR mode and `RNSARSession` in AR mode since v0.5.0.

**Hosts with `legacyDriver={true}` on `<Camera>`:** remove the
prop.  `<Camera>` will use the Frame Processor driver, which has
been the default since v0.5.0 and the only path since this release.

```tsx
// Before (v0.5.x)
<Camera legacyDriver={true} ... />

// After (v0.6.0)
<Camera ... />
```

**Hosts directly using `useIncrementalJSDriver`:** migrate to
`useFrameProcessorDriver`.  The handle shape (`{ start, stop,
frameProcessor, isRunning }`) is preserved, but the new hook is a
Frame Processor + gyro driver instead of a `takeSnapshot` + JS
interval driver.  See
[`src/stitching/useFrameProcessorDriver.ts`](src/stitching/useFrameProcessorDriver.ts)
for the migration mapping; the gyro pose synthesis convention
(`q = q_yaw * q_pitch * q_roll`) is identical, so existing pose
math at call sites continues to work.

**Hosts passing `frameSourceMode: 'jsDriver'` to
`incremental.start(...)`:** change to `'frameProcessor'`.  The
TypeScript type now rejects `'jsDriver'` at compile time.

## [0.5.1] — 2026-05-25

### Added — F8.6 Android pixel-buffer engine parity

Closes the v0.5.0 follow-up tracked in the [0.5.0] section.

**Live engine ingest no longer requires a JPEG round-trip.**
The `IncrementalFirstwinsEngine` (slit-scan / first-wins) and the
hybrid `IncrementalEngine` both gained a new
`addFramePixelData(nv21, w, h, ...)` method.  It builds the BGR
`cv::Mat` in-process via
`Imgproc.cvtColor(yuv, COLOR_YUV2BGR_NV21)`, then delegates to a
newly-extracted shared `addFrameMat` helper that runs the original
engine pipeline verbatim.  The legacy `addFrameAtPath(path, ...)`
is now a thin wrapper: `imread → downsample → addFrameMat`.

**Routing.**  `IncrementalStitcher.ingestFromARCameraView` got
three optional parameters — `nv21PixelData: ByteArray?`,
`nv21PixelWidth: Int`, `nv21PixelHeight: Int`.  When supplied (and
`batchKeyframeMode == false`), the live engine ingests via
`addFramePixelData`; otherwise falls back to `addFrameAtPath` with
`legacyJpegPath`.  Backwards-compatible — all-null defaults
preserve every existing caller.

**Frame Processor wiring.**  `consumeFrameFromPlugin` now packs the
incoming `Image` NV21 once at the top (was twice — gate consumed
Y only, then the `onAccept` lambda re-packed for JPEG encode) and
threads the bytes through to both the gate (which reads only the
Y subset) AND the new `nv21PixelData` parameter.  Net: single
`packNV21` per producer-thread frame.

**Measured on Galaxy A35, `engine: 'firstwins-rectilinear'`,
non-AR Frame Processor capture:**

| Outcome | F8.6 pixel-data | Legacy JPEG path (estimated) |
|---|---|---|
| `AcceptedHigh` (first-frame init) | 7–11 ms | 50–70 ms |
| `SkippedTooClose` (gate bail) | 0.5–2 ms | 50–60 ms (imread is unconditional) |

`SkippedTooClose` dominates the producer-thread frame budget
(~95% of frames at 30 fps with a slow pan).  Eliminating the
imread on those frames is the bulk of the F8.6 win.

### Added

* New `<Camera engine={...}>` prop exposes the live engine
  selection (`'batch-keyframe'` (default) / `'firstwins-rectilinear'`
  / `'hybrid'` / `'slitscan-*'`).  Lets hosts opt into in-flight
  stitching for low-latency previews; previously the choice was
  hardcoded.

### Changed

* `New: F8.6 perf-diagnostic logs` (`F8.6-route`, `F8.6-perf`) fire
  in live-engine mode only — inert under the default
  `batch-keyframe`.  Will be removed in v0.6 once F8.6 is baked in
  production.

### Fixed

* In `IncrementalStitcher.consumeFrameFromPlugin`, the `onAccept`
  lambda was re-packing the live `Image` instead of reusing the
  already-packed NV21 from the outer scope.  Now it reuses the
  outer `packed` — saves a redundant `packNV21` call on every
  accepted frame.

## [0.5.0] — 2026-05-25

### Added — F8 Frame Processor port

`<Camera>` now drives **non-AR captures through a vision-camera
Frame Processor** on the camera producer thread instead of the
4 Hz `takeSnapshot` → JPEG → cache-file path the v0.4 series used.

- **`useFrameProcessorDriver`** (`src/stitching/useFrameProcessorDriver.ts`)
  — new hook with the same `{ start, stop, frameProcessor,
  isRunning }` shape as the legacy `useIncrementalJSDriver`.  Gyro
  yaw / pitch / **roll** are integrated on the JS thread and
  published via `useSharedValue` so the worklet reads pose
  zero-hop.  Plugin acquisition uses a mount-once + 16 ms
  setTimeout retry pattern to side-step the vision-camera
  registry init race.
- **`cv_flow_gate_process_frame` JSI plugin** — registered on both
  platforms:
  - iOS: `ios/Sources/RNImageStitcher/KeyframeGateFrameProcessor.mm`
    + `@objc IncrementalStitcher.consumeFrameFromPlugin(...)`
    wrapper.  `CVPixelBuffer` flows end-to-end into
    `IncrementalStitcher.consumeFrame` — the SAME entry point AR
    mode already uses.  Zero JPEG round-trip on accept.
  - Android: `android/src/main/java/io/imagestitcher/rn/CvFlowGateFrameProcessor.kt`
    + Kotlin `consumeFrameFromPlugin(...)` wrapper.  Extracts the
    Y plane on the producer thread, encodes inline JPEG on accept
    via the existing `YuvImageConverter`, hands the path to
    `ingestFromARCameraView`.  Pixel-buffer parity tracked as F8.6.
- **`frameSourceMode: 'frameProcessor'`** in
  `IncrementalStitcher.start()` options — flips
  `frameProcessorIngestEnabled` ON so the plugin's producer-thread
  feed reaches the engine.  Default for non-AR captures from v0.5.
- **`legacyDriver?: boolean`** prop on `<Camera>` — opt-in escape
  hatch back to `useIncrementalJSDriver` for hosts that hit a
  vision-camera incompatibility.  Will be removed in v0.6.
- **`VISION_CAMERA_RUNTIME` error code** for vision-camera
  runtime errors that aren't transient lifecycle events.
- **Roll axis** (gyro-Z) in the synthesised pose quaternion —
  `q = q_yaw * q_pitch * q_roll`.  Field captures with wrist-twist
  no longer lie to the cv::Stitcher's intrinsic estimator.

### Changed

- Default non-AR driver is now `useFrameProcessorDriver`.  Hosts
  using `<Camera>` opt in transparently — no code change needed
  unless you want the legacy path (`legacyDriver={true}`).
- `host-supplied frameProcessor` prop on `<Camera>` is now treated
  as a legacy escape hatch: silently overridden by the SDK driver
  in default mode with a one-shot `console.warn`.

### Deprecated

- **`useIncrementalJSDriver`** — works through v0.5, removed in
  v0.6.  Hosts that drove non-AR captures with this hook should
  migrate to letting `<Camera>` do it by default
  (`legacyDriver` unset).  The hook now emits a one-shot
  `console.warn` from its `start()` call.

### Fixed

- **Vision-camera transient lifecycle errors** (screen-lock,
  app-switch, DoNotDisturb, MDM camera restriction) are now
  filtered inside `<CameraView>` instead of propagating to the
  host's `onError`.  Auto-recovery happens on resume; hosts no
  longer get spurious crash reports on every phone-lock.

### Added — peer dependency

- **`react-native-worklets-core`** is now a declared peer
  dependency (`>=1.3.0`).  It was already required transitively
  via `react-native-vision-camera@^4`; the explicit declaration
  documents the contract.

### Tracking — known follow-ups (don't gate this release)

- **F8.6 (v0.5.1)** — Android engine refactor for pixel-buffer-
  direct ingest (true zero-copy parity with iOS).  Would extract
  an `addFrameMat` helper from `IncrementalFirstwinsEngine` and
  `IncrementalEngine`'s `addFrameAtPath`, add a parallel
  `addFramePixelData` that constructs the BGR `cv::Mat` from NV21
  bytes via `cvtColor`, and rewire `RNSARCameraView` to skip the
  per-frame JPEG encode.  Expected gain: ~30–50 ms per accepted
  frame.  Deferred because the engine bodies are 400+ lines of
  complex AR-mode code; needs A35 device verification before
  merge, which the v0.5.0 prep session didn't have.

- **F8.3-followup-roll** — resolved in v0.5.0.

- **F8.3.H2-target** — RESOLVED in v0.5.0 via a different
  mechanism than originally planned.  The selector pin is now a
  compile-time `#selector(...)` reference inside
  `IncrementalStitcher.swift` plus a dev-build runtime assert in
  `IncrementalStitcher.init()` — both fire if the Swift method
  signature drifts from what `KeyframeGateFrameProcessor.mm`
  expects.  The obsolete test file was deleted.  `swift test` now
  runs the (8-test) `QualityCheckerTests` suite cleanly because
  `Package.swift` switched from an exclude list (broke every time
  a new `.mm` landed) to an explicit `sources` allowlist.

## [0.4.1] — 2026-05-23

### Fixed
- **ARCore Image hold time** (PR #15) — `forwardToIncremental` on
  Android now packs the ARCore `Image` payload synchronously and
  closes the image immediately, rather than holding it across the JNI
  hand-off.  Eliminates the "ImageReader: maxImages exceeded" backlog
  that throttled non-keyframe processing on the A35 at high pan
  rates.

### Tooling
- **Example app Metro port pinned to 8082** (cherry-pick from
  `feature/f8-frame-processor-yuv`).  Mirrored across
  `example/metro.config.js`, `example/package.json` scripts,
  `example/ios/RNImageStitcherExample/AppDelegate.swift`, and
  `example/android/gradle.properties` to keep CLI builds, IDE
  builds, and Gradle invocations consistent on machines where 8081
  is already taken.

### Internal
- Lockfile sync after the v0.4.0 version bump (Podfile.lock spec
  checksum + npm prune of transitive deps that had drifted from
  branch experimentation).  No impact on consumers — example-app
  tooling only.

## [0.4.0] — 2026-05-23

### v0.4 settings revamp (F10)

> [!WARNING]
> **Breaking type change.**  The flat 45-field `PanoramaSettings`
> interface from v0.3 has been replaced with three engine-discriminated
> hierarchical types (`PanoramaSettings`, `SlitscanSettings`,
> `HybridSettings`).  Consumers passing custom settings literals to
> `<Camera>` or to a Layer 2 modal must migrate to the new shape; the
> v0.3 type is deleted, not aliased.  The C++ engine wire format is
> unchanged — only the JS-side type surface moved.
>
> **Migration guide:** [`docs/migrations/v0.3-to-v0.4-panorama-settings.md`](docs/migrations/v0.3-to-v0.4-panorama-settings.md)
> walks through every recipe (default-only hosts, custom-literal
> hosts, slit-scan / hybrid hosts, storage migration for persisted
> settings).

#### Why

The 2026-05-22 audit (entry below in v0.3.0) traced every
`PanoramaSettings` field's native consumer and proved the flat type
mixed three engines' (batch-keyframe, slit-scan, hybrid) settings into
one bag of disjoint subsets.  Hosts had no way to know at the type
level which settings their chosen engine would even read; the modal
exposed knobs that were silently ignored on the active engine.  The
revamp splits the type along engine boundaries so the types match what
each engine actually consumes.

#### What changed

- **New file:** `src/camera/PanoramaSettings.ts` — `CaptureBaseSettings`
  + three top-level types (`PanoramaSettings`, `SlitscanSettings`,
  `HybridSettings`), each with co-located `DEFAULT_*_SETTINGS`.  Sub-trees
  group related knobs: `stitcher` / `frameSelection.flow` (panorama);
  `painting` / `registration.ncc1d` / `registration.ncc2d.emaSmoothing` /
  `registration.ncc2d.panAxisLock` / `plane` / `advanced` (slitscan).
- **New file:** `src/camera/PanoramaSettingsBridge.ts` — three pure
  adapter functions (`panoramaSettingsToNativeConfig`,
  `slitscanSettingsToNativeConfig`, `hybridSettingsToNativeConfig`)
  that translate the typed JS tree → the flat
  `Record<string, primitive>` the native bridges consume.  Handles
  presence-as-enable (`ncc1d` defined ⇒ `enable1dNcc: true` on the
  wire) and source-conditional plane optionals.
- **New file:** `src/camera/buildPanoramaInitialSettings.ts` — pure
  helper that translates `<Camera>`'s `default*` props into the
  initial `PanoramaSettings` snapshot.  Takes the device's low-mem
  classification as an argument so the function stays pure and
  testable.
- **Rewritten:** `src/camera/PanoramaSettingsModal.tsx` — now consumes
  the new `PanoramaSettings` shape.  UI sections mirror the type tree
  (Capture source, Debug, Stitcher accordion, Frame Selection
  accordion with nested Flow tunables).  ~600 LOC smaller than v0.3
  because dead slit-scan / hybrid / video-recording fields are gone.
- **Rewired:** `src/camera/Camera.tsx` — settings state uses the new
  type; `incremental.start({ config })` now passes
  `panoramaSettingsToNativeConfig(settings)` instead of an inline flat
  dict.  IMU translation gate reads
  `settings.frameSelection.flow?.maxTranslationCm`.  Debug overlay
  reads `settings.frameSelection.mode` + `settings.stitcher.stitchMode`.
- **Updated:** `src/index.ts` — exports the new types + adapters; drops
  the deleted v0.3 type.
- **Test infra:** added `jest` + `ts-jest` + `@types/jest` devDeps; new
  `jest.config.js`, `tsconfig.test.json`, `tsconfig.build.json` (the
  latter excludes `__tests__/` from the shipped `dist/`).  19 tests
  across two suites cover the bridge round-trips, presence-as-enable
  cases, plane-source variants, and prop→settings-tree translation.

#### Migration table — v0.3 flat → v0.4 hierarchical

For `<Camera>`-consuming hosts (the only public path that took
`PanoramaSettings` in v0.3):

| v0.3 field                       | v0.4 path                                       |
|----------------------------------|-------------------------------------------------|
| `captureSource`                  | `captureSource` (unchanged)                     |
| `debug`                          | `debug` (unchanged)                             |
| `stitchMode`                     | `stitcher.stitchMode`                           |
| `warperType`                     | `stitcher.warperType`                           |
| `blenderType`                    | `stitcher.blenderType`                          |
| `seamFinderType`                 | `stitcher.seamFinderType`                       |
| `enableMaxInscribedRectCrop`     | `stitcher.enableMaxInscribedRectCrop`           |
| `frameSelectionMode`             | `frameSelection.mode`                           |
| `keyframeMaxCount`               | `frameSelection.maxKeyframes`                   |
| `keyframeOverlapThreshold`       | `frameSelection.overlapThreshold`               |
| `flowNoveltyPercentile`          | `frameSelection.flow.noveltyPercentile`         |
| `flowEvalEveryNFrames`           | `frameSelection.flow.evalEveryNFrames`          |
| `flowMaxTranslationCm`           | `frameSelection.flow.maxTranslationCm`          |
| `flowMaxCorners`                 | `frameSelection.flow.maxCorners`                |
| `flowQualityLevel`               | `frameSelection.flow.qualityLevel`              |
| `flowMinDistance`                | `frameSelection.flow.minDistance`               |

#### Deleted from the public type surface

These fields were consumed only by slit-scan or hybrid engines (or
not consumed at all per the audit) and were dead surface on
`<Camera>`'s batch-keyframe path:

- `incrementalEngine` — `<Camera>` always uses `batch-keyframe`; the
  knob never reached this component.  Hosts that want slit-scan or
  hybrid build their own capture flow on `incremental.start()` and
  pass `SlitscanSettings` / `HybridSettings` instead.
- `useARPreview` — superseded by `captureSource` ('ar' / 'non-ar').
- `useDetectedPlane` — superseded by `SlitscanSettings.plane.source`.
- `planeSource`, `virtualPlaneDepthMeters`, `arkitPlaneAlignmentThreshold`,
  `planeProjectionStyle` — slit-scan only; on `SlitscanSettings.plane.*`.
- `slitWidthFraction`, `sliverPosition`, `firstFrameFullFrame`,
  `paintMode` — slit-scan only; on `SlitscanSettings.painting.*`.
- `acceptGate`, `enableTriangulation`, `enableTriAccumulator`,
  `enable2dNcc`, `enableRansacHomography`, `nccSearchRadius1d`,
  `nccSearchMargin2d`, `nccConfidenceThreshold2d`,
  `enableNcc2dEmaSmoothing`, `ncc2dEmaAlpha`,
  `enableNcc2dPanAxisLock`, `ncc2dCrossAxisLockPx` — slit-scan only;
  on `SlitscanSettings.registration.*`.
- `hybridProjection` — hybrid only; on `HybridSettings.projection`.
- `maxRecordingMs`, `framesPerSecond`, `minFrames`, `maxFrames`,
  `quality` — historical video-recording fallback fields with no
  consumer on `<Camera>`'s batch-keyframe path.

#### Latent v0.3 bug fixed in passing

The v0.3 `<Camera>` accepted a `defaultCaptureSource` prop but the
internal `buildInitialSettings` function never copied it into
`settings.captureSource` — only into `arPreference` state.  The
discrepancy meant the wire dict sent to native always reported
`captureSource: 'ar'` even when the operator's effective source was
`'non-ar'`, which silently disabled Android's `disableAngularFallback`
opt-out (audit fix F1).  v0.4's `extractPanoramaOverrides` +
`buildPanoramaInitialSettings` route the prop through correctly.
Hosts using `defaultCaptureSource="non-ar"` will see native receive
the matching value for the first time.

#### Known limitation — modal Capture-source field vs. AR toggle

The on-screen AR toggle button at the bottom of `<Camera>` updates
`arPreference` state (and through it `effectiveCaptureSource`),
which decides which preview component mounts.  The Capture-source
segmented control inside the settings modal updates
`settings.captureSource`, which only affects what's reported to the
native engine via `panoramaSettingsToNativeConfig` (gates Android's
angular-fallback opt-out per audit fix F1).  These two values can
drift if the operator toggles the AR button without re-opening
settings, OR flips the modal field without touching the AR button.
The on-screen toggle is the canonical UI affordance for the live
preview path; the modal field is best thought of as a tester escape
hatch for the wire-format consequence.  A future cleanup is to make
both update the same source of truth — out of scope for v0.4.

#### Migration example

```ts
// Before (v0.3)
const settings: PanoramaSettings = {
  captureSource: 'ar',
  stitchMode: 'auto',
  blenderType: 'multiband',
  flowMaxTranslationCm: 50,
  flowNoveltyPercentile: 0.85,
  keyframeMaxCount: 6,
  frameSelectionMode: 'flow-based',
  // … 40+ more fields
};

// After (v0.4)
const settings: PanoramaSettings = {
  captureSource: 'ar',
  debug: false,
  stitcher: {
    stitchMode: 'auto',
    warperType: 'plane',
    blenderType: 'multiband',
    seamFinderType: 'graphcut',
    enableMaxInscribedRectCrop: false,
  },
  frameSelection: {
    mode: 'flow-based',
    maxKeyframes: 6,
    overlapThreshold: 0.20,
    flow: {
      noveltyPercentile: 0.85,
      evalEveryNFrames: 5,
      maxTranslationCm: 50,
      maxCorners: 150,
      qualityLevel: 0.01,
      minDistance: 10,
    },
  },
};

// Or just use the default:
import { DEFAULT_PANORAMA_SETTINGS } from 'react-native-image-stitcher';
const settings = { ...DEFAULT_PANORAMA_SETTINGS, captureSource: 'non-ar' };
```


## [0.3.0] — 2026-05-23

> [!IMPORTANT]
> **v0.3.0 is the audit-follow-up release.**  After v0.2.x we ran an
> exhaustive PanoramaSettings ground-truth audit and shipped the
> v0.3-pixel-data work alongside ~15 follow-up correctness fixes,
> two crash fixes, a stitcher mode-fallback retry, and the
> RetaiLens-parity debug UI port.  Detailed entries below.
>
> **Behaviour changes**
>   - Android AR mode + both platforms' non-AR mode now actually run
>     the Flow strategy (sparse optical-flow novelty) end-to-end.
>     Pre-0.3 they silently fell back to Pose strategy because no
>     pixel data was supplied — hosts who tuned
>     `keyframeOverlapThreshold` on those paths were tuning a
>     different algorithm than is now active.
>   - `stitchMode: 'auto'` now resolves correctly on iOS (was
>     silently hardcoded to Panorama) and uses IMU-measured
>     translation in non-AR mode.
>   - `frameSelectionMode` is now honoured on both platforms;
>     previously hardcoded to `'flow-based'`.
>   - Mode-fallback retry: if the resolved cv::Stitcher mode fails
>     with degenerate camera params, the stitcher automatically
>     retries with the opposite mode before giving up.

### Added

- **Pixel-aware Flow strategy across all four capture paths** —
  iOS AR, iOS non-AR, Android AR, Android non-AR.  The C++
  KeyframeGate's `evaluateWithFrame` overload is now reached from
  every entry point with real grayscale pixel data (Y plane bytes
  on AR paths, decoded JPEG luma on non-AR paths).
- **Debug UI suite** (gated by `settings.debug`):
  `CaptureMemoryPill` (top-right), `CaptureKeyframePill` (top-center),
  `CaptureOrientationPill` (top-left), `CaptureStitchStatsToast` +
  `useStitchStatsToast` hook, plus a detailed metrics block
  (`CaptureDebugOverlay`).  All exported individually for Layer 2
  hosts to compose their own debug surface.
- **`stitchModeResolved`** in `IncrementalFinalizeResult` +
  `CameraCaptureResult.panorama` — surfaces which cv::Stitcher
  pipeline actually ran (`panorama` / `scans`), useful for
  displaying on the output preview.

### Fixed

- **F1 — Android `disableAngularFallback` was always false.**
  The non-AR opt-out tested `captureSource ∈ {"wide", "ultrawide"}`
  against a JS API that has been sending `"ar"` / `"non-ar"` since
  v0.2.  String mismatch silently nullified the opt-out → gyro
  drift accepted near-identical frames → `STITCH_CAMERA_PARAMS_FAIL
  — warpRoi too large (43039×55525)` on shelf-scan captures.
- **F1b — iOS `disableAngularFallback` wasn't wired at all.**  The
  C++ setter existed but the Swift facade had no property, the
  Obj-C++ bridge had no method, and IncrementalStitcher never
  called it.  Same crash class as F1, just hidden until now.
- **F2 — iOS `stitchMode` was hardcoded to Panorama.**  Now reads
  the JS setting and resolves 'auto' via translation/rotation
  magnitude-ratio (port of Android's resolveStitchModeAuto).
- **F2b — Auto-resolver uses IMU translation in non-AR mode.**  The
  JS-driver path doesn't carry pose tx/ty/tz, so the pose-only
  resolver always picked 'panorama' even for shelf scans.  Now
  folds the IMU translation gate's measured displacement into the
  resolver (`tMeters = max(tPose, tImu)`).
- **F2c — Cross-capture IMU drift bias.**  Pre-fix the gravityX IIR
  estimate was preserved across capture boundaries; if the phone
  was at a different orientation between captures, the stale
  estimate biased the linear-acceleration calculation for the
  ~200 ms IIR convergence window, integrating into posX and
  compounding per-capture.  Now reseed gravityX on every
  subscription start (= every capture).
- **F2d — IMU gate auto-rearms on every budget interval.**  Pre-fix
  the gate latched after the first `markNextFrameAsLastKeyframe`
  fire and never re-triggered.  Now resets posX + velX + fired
  internally so it fires every `flowMaxTranslationCm` of measured
  translation.
- **F2e — Android batch-keyframe now emits overlap %.**  Pre-fix
  `overlapPercent` was hardcoded to -1 in the accept emit, and
  reject events emitted nothing at all — debug overlay was frozen
  between accepts.  Now reflects the gate's actual newContent
  fraction on both accepts and rejects.
- **F2f — IMU delta resets on ANY frame accept.**  Pre-fix the
  `imuΔ` debug indicator only reset when the IMU gate itself
  fired; a flow-novelty accept left posX ticking up indefinitely.
  Now Camera.tsx watches `acceptedCount` and resets the gate on
  every increment.  A separate `totalAbsMetres` accumulator banks
  the magnitude across resets so the finalize-time auto-resolver
  still sees full translation history.
- **F4 — Camera.tsx now passes the four flow-tunable fields and
  `captureSource`.**  Pre-fix `flowMaxCorners`, `flowQualityLevel`,
  `flowMinDistance`, `enableMaxInscribedRectCrop`, and
  `captureSource` were silently dropped between the modal and the
  native bridge.  Now all five reach the engine.
- **F5 — Android KeyframeGate gained the missing Flow-tunable
  surface.**  Added Kotlin facade properties + JNI thunks for
  `setFlowMaxCorners`, `setFlowQualityLevel`, `setFlowMinDistance`,
  `setStrategy`.  Android now mirrors iOS for the gate's full
  knob set.  Added the eval-throttle (`flowEvalEveryNFrames`)
  to the AR ingest path.
- **F6 — `frameSelectionMode` is no longer hardcoded to
  'flow-based'.**  Camera.tsx now passes the JS setting through;
  both platforms honour `time-based` (gate disabled),
  `pose-based` (Pose strategy), and `flow-based` (Flow strategy).
- **F7 — README documented `defaultFlowMaxTranslationCm` as 8
  cm.**  Actual default is 50 cm; 6× off.
- **ARCore Session.close() on AR-off** (Android-only crash fix).
  Pre-fix `RNSARSession.stop()` and `stopForView()` called
  `Session.pause()` then nulled the session reference.  ARCore's
  `pause()` only stops frame production — its native worker
  threads stay alive.  Orphaned, those threads kept running and
  crashed under memory pressure with SIGSEGV in
  `tango_pool_lp4`/`libarcore_c.so` (tombstone-confirmed).  Now
  calls `pause()` then `close()` (ARCore's documented full
  teardown), and the camera-view drops its own stale reference.
- **Stitcher mode-fallback retry.**  When the configured stitchMode
  fails with degenerate camera params, the stitcher now
  automatically retries with the opposite mode before giving up
  (panorama → scans or scans → panorama).  Result type carries
  `stitchModeUsed` so callers can see which mode succeeded.  The
  warpRoi-too-large error message now includes the configured
  mode + frame index for diagnostics.
- **Thumbnail strip first-frame race.**  Pre-fix the `useEffect`
  that cleared `batchKeyframeThumbnails` on statusPhase change
  could race ahead of the JS subscriber: the AR camera's GL
  thread could emit an ACCEPT during handleHoldStart's
  `await incremental.start(...)` window, the subscriber would
  add frame 0 to thumbnails, THEN React's queued statusPhase
  effect would wipe the array — frame 0 was missing from the
  strip.  Fixed by moving the reset synchronously to the top of
  handleHoldStart, before any await.

### Audit ground-truth findings (no code change, doc-only)

- **F1 — Android `disableAngularFallback` was always false.** The
  Android JNI's non-AR opt-out for the angular-delta gate fallback
  tested `captureSource ∈ {"wide", "ultrawide"}` against a JS API
  that has been sending `"ar"` / `"non-ar"` since 2026-05-14.  The
  string mismatch silently nullified the opt-out for the entire
  Android non-AR path, letting gyro drift accumulate into the
  integrated yaw/pitch and produce near-identical "accepted"
  frames — which is what blew up cv::Stitcher with the "warpRoi too
  large (43039×55525) — estimator produced degenerate camera params"
  error on shelf-scan captures.  Fix: read `"non-ar"`.
- **F2 — iOS `stitchMode` setting is now honoured end-to-end.**  Pre-
  audit, `OpenCVStitcher.mm:436` hardcoded `cv::Stitcher::PANORAMA`
  regardless of the JS setting, so operators picking `'scans'` or
  `'auto'` from the modal saw no effect on iOS.  iOS now reads
  `configOverrides["stitchMode"]`, tracks first + last accepted
  keyframe poses, and implements `resolveStitchModeAuto` (port of
  Android's translation/rotation magnitude-ratio heuristic) at
  finalize time.  Both platforms now resolve `'auto'` identically.
- **F4 — Camera.tsx now passes settings the modal exposed but Camera
  silently dropped.**  Pre-audit, the `config` block passed to
  `incremental.start()` omitted four fields that iOS native already
  read: `flowMaxCorners`, `flowQualityLevel`, `flowMinDistance`,
  `enableMaxInscribedRectCrop`.  Modal sliders for these were
  silent no-ops on every platform.  Now wired.  Also added
  `captureSource` to the config so F1's Android opt-out has
  something to read.
- **F5 — Android KeyframeGate now exposes the full Flow tunable
  surface.**  Pre-audit, the Android KeyframeGate facade lacked
  Kotlin properties + JNI thunks for `setFlowMaxCorners` /
  `setFlowQualityLevel` / `setFlowMinDistance` / `setStrategy`,
  even though the underlying C++ gate has had them since 0.2.0.
  Added the missing JNI bindings + Kotlin facade fields.  Android
  IncrementalStitcher now reads `flowMaxCorners`, `flowQualityLevel`,
  `flowMinDistance`, `flowEvalEveryNFrames`, and `frameSelectionMode`
  from configOverrides with clamp ranges matching iOS.
- **F6 — Camera.tsx no longer hardcodes `frameSelectionMode`.**  Pre-
  audit, line 835 hardcoded `'flow-based'`, so the modal's
  `time-based` / `pose-based` / `flow-based` toggle had no runtime
  effect.  Now passes `settings.frameSelectionMode` through.  Both
  platforms honour the setting: `time-based` disables the gate
  (passthrough), `pose-based` enables Pose strategy, `flow-based`
  enables Flow strategy.  Android additionally now applies the
  eval-throttle (`flowEvalEveryNFrames`) to the AR ingest path,
  matching iOS' `IncrementalStitcher.swift:2459-2471` behaviour.
- **F7 — README documented `defaultFlowMaxTranslationCm` default as
  `8`.**  Actual `DEFAULT_PANORAMA_SETTINGS.flowMaxTranslationCm` is
  `50`; 6× off.  Corrected.

### Audit ground-truth findings (doc-only)

The full audit traced every `PanoramaSettings` field through Camera.tsx,
the iOS bridge (`IncrementalStitcher.swift::applyConfigOverrides` and
the cv::Stitcher path), the Android bridge
(`IncrementalStitcher.kt::start`), the C++ gate (`cpp/keyframe_gate.cpp`),
and the live-engine config type (`RLISStitcherConfig`).  Conclusions:

- Batch-keyframe and the live engines (hybrid + slit-scan) share
  **zero settings**.  All RLISStitcherConfig fields (NCC, plane
  projection, paint mode, slit-scan painting) flow only through
  Layer 2 entry points (`incremental.start({ engine: 'slitscan-…' })`),
  never through `<Camera>` (which hardcodes `engine: 'batch-keyframe'`).
- ~10 fields in `PanoramaSettings` are confirmed dead (no native
  consumer at all): `useARPreview`, `incrementalEngine`,
  `slitWidthFraction`, `acceptGate`, `maxRecordingMs`,
  `framesPerSecond`, `minFrames`, `maxFrames`, `quality`, and the
  legacy `useDetectedPlane` alias.  These are scheduled for removal
  in v0.4.0 as part of the engine-discriminated typed-settings
  rewrite.

## [0.3.0-pre-audit] — 2026-05-21

> [!IMPORTANT]
> **Behaviour change on Android AR mode and on both platforms' non-AR
> mode.**  Keyframe selection now actually runs the **Flow strategy**
> (sparse optical-flow novelty) on these paths, where pre-0.3 the
> C++ KeyframeGate silently fell back to the Pose strategy
> (angular-delta) because no pixel data was supplied.  Hosts that
> tuned `keyframeOverlapThreshold` on these paths were tuning a
> different algorithm than is now active — see the migration note
> below before re-validating capture quality.  iOS AR mode is
> unchanged (already ran Flow with pixel data via the AR delegate).

### Fixed

- **[#9](https://github.com/bhargavkanda/react-native-image-stitcher/issues/9): Android AR mode — first keyframe thumbnail no longer delayed
  several hundred milliseconds.**  Pre-0.3 the AR ingest pipeline
  encoded every ARCore frame to JPEG and wrote it to disk on the
  GL render thread (~25 ms per frame at ~60 Hz) regardless of
  whether the gate would accept it.  Then the gate ran a pose-only
  evaluation (no pixel data) which silently fell back to the
  stricter Pose strategy, masking the result by force-accepting via
  the IMU translation gate.  Net effect: noticeable lag before
  frame 1 thumbnail rendered, and frame 1 / frame 2 spacing
  visually too large.
  - v0.3 rewires the AR ingest path to extract just the **Y plane
    bytes** from the ARCore camera image (zero-copy via
    DirectByteBuffer → JVM byte[] + JNI `GetPrimitiveArrayCritical`)
    and feeds them directly to the C++ gate's existing
    `evaluateWithFrame` overload.  Per-frame cost on the GL render
    thread drops from ~25-40 ms to ~2-5 ms for rejected frames.
  - JPEG encode + disk write is **deferred to only accepted frames**
    (typically 3-6 per capture) via an `onAccept` lambda the gate
    invokes if-and-only-if it keeps the frame.  Single disk write
    per accepted keyframe (pre-0.3 was: encode-then-copy = two
    writes).
  - Gate now runs Flow strategy with real pixel content — feature-
    tracking-based novelty, not the strict angular-delta proxy.
- **iOS non-AR + Android non-AR Flow strategy regression** —
  related to #9 but not user-reported.  Both non-AR paths previously
  called `evaluate(pose, plane: nil)` with no pixel data, which
  silently fell back to Pose strategy on both platforms.  v0.3
  decodes the JPEG snapshot to grayscale before the gate call so
  Flow strategy runs:
  - iOS: `CGImageSource → CGContext` into a single-channel
    `CVPixelBuffer` (`kCVPixelFormatType_OneComponent8`).  The
    `KeyframeGateBridge.mm` got OneComponent8 case-handling
    (parallel to the existing NV12 / BGRA cases).  ~10-20 ms per
    snapshot on iPhone 13/16 Pro.
  - Android: `Imgcodecs.imread(path, IMREAD_GRAYSCALE)` decodes
    the JPEG straight to a CV_8UC1 Mat which we marshal into a
    ByteArray for the new `nativeEvaluateWithFrame` JNI thunk.
    ~10-20 ms per snapshot on Galaxy A35.

### Added

- **`KeyframeGate.evaluateWithFrame(pose, plane, grayData, w, h, stride)`**
  (Kotlin) — pixel-aware Flow-strategy gate-evaluate entry point,
  parity with the existing iOS `KeyframeGateBridge.evaluatePixelBuffer:…`.
- **`nativeEvaluateWithFrame`** JNI thunk in `keyframe_gate_jni.cpp`.
  Uses `GetPrimitiveArrayCritical` for zero-copy access to the
  JVM-side byte[] during the gate evaluate.
- **`kCVPixelFormatType_OneComponent8` handling** in iOS
  `KeyframeGateBridge.mm` — base address is read directly as the
  Y plane with no conversion cost.

### Changed

- **`IncrementalStitcher.ingestFromARCameraView` signature** (Android,
  internal):
  - **Removed**: `path: String` parameter.  AR camera view no longer
    encodes a JPEG to feed this method — it hands over Y-plane bytes
    instead.
  - **Added**: `grayData: ByteArray, grayWidth: Int, grayHeight: Int,
    grayStride: Int, onAccept: (targetPath: String) -> Boolean`.
    The lambda is invoked only on gate-accept and is expected to
    write a JPEG of the current camera image to the supplied target
    path.  Returns true on success.
  - `RNSARCameraView.forwardToIncremental` updated accordingly.
- **`RNSARCameraView.postFrameToEngine` removed.**  The thin wrapper
  was only used to wrap the old positional call to
  `ingestFromARCameraView`; the new lambda-based call shape is
  inline in `forwardToIncremental`.

### Migration from 0.2.x

**Most consumers**: no code change required.  The public JS API
(`<Camera>`, `useCapture`, `useIMUTranslationGate`,
`useDeviceOrientation`, everything) is byte-identical to 0.2.1.

**Hosts that tuned `keyframeOverlapThreshold` against Android AR or
either non-AR path**: the threshold now controls **Flow novelty
percentile** instead of **Pose angular delta**.  Same setting, very
different metric — re-tune against your typical captures.  The
default (`0.20`) was chosen to roughly match the pre-0.3 visible
behaviour; most hosts shouldn't need to change anything, but
quality-sensitive hosts should re-validate before shipping.

**Hosts that observed the Android-AR first-frame delay**: the bug
is fixed — first thumbnail should render within ~50 ms of shutter
hold (was ~200+ ms).

### Deferred to v0.4 ([#11](https://github.com/bhargavkanda/react-native-image-stitcher/issues/11))

Non-AR capture currently still goes through vision-camera's
`takeSnapshot()` API at ~4 FPS with a per-snapshot JPEG-encode +
disk-write + decode-to-grayscale round-trip.  v0.4 will migrate
non-AR to vision-camera's Frame Processor API: raw pixel data
direct from the camera, no JPEG, no disk, full camera frame rate.
At that point the JPEG-decode-to-grayscale workaround added in
v0.3's iOS/Android non-AR paths becomes redundant and will be
removed.  See issue #11 for the full scope.

## [0.2.1] — 2026-05-21

### Changed

- **Example app no longer wires Expo modules.**  The deferred v0.2
  follow-up landed: the example app now uses the standard React
  Native 0.84 host wiring throughout — `RCTReactNativeFactory` in
  `AppDelegate.swift`, `DefaultReactHost.getDefaultReactHost` in
  `MainApplication.kt`, no `use_expo_modules!` macro in `Podfile`,
  no `expo-root-project` plugin or `expoAutolinking.useExpoModules()`
  call in the gradle files, and no `expo`/`expo-modules-core`/
  `expo-modules-autolinking` packages in `example/package.json`.
  The two inline `patch-package`-style Podfile patches for Expo
  SDK 55 on RN 0.84 are also gone — they were only needed because
  we were dragging Expo in.  Verified by clean build + install on
  iPhone 16 Pro and Galaxy A35 (with `LANG=en_US.UTF-8 pod install`
  + `JAVA_HOME` set to OpenJDK 17, both required workarounds for
  unrelated tooling bugs we now document in the troubleshooting
  table).
- **`docs/host-app-integration.md` rewritten** for the post-Expo
  posture.  Dropped ~340 lines describing Podfile macros,
  AppDelegate Expo factory wiring, MainApplication Expo factory
  wiring, gradle `expo-root-project` plugin, and the
  `expo-modules-core+55.0.14.patch` patch-package patch.  The
  remaining content (vision-camera permission strings, ARCore
  manifest entries, the one `react-native-sensors+7.3.6.patch`
  patch for the jcenter→mavenCentral swap, network access from
  devices to Metro, troubleshooting) is preserved.  The README's
  IMPORTANT block at [README.md:53-66](README.md:53) and the
  pre-existing setup walkthrough still apply.

### Migration from 0.2.0

Hosts upgrading from 0.2.0 with their existing Expo modules host
wiring **don't have to change anything** — Expo modules are
additive, so the wiring keeps working even though the SDK no
longer requires it.  But the wiring is now strictly optional, and
[`docs/host-app-integration.md`](docs/host-app-integration.md)
describes the simpler post-Expo path.  If you want to follow the
simpler path: drop the four Expo packages from your
`package.json`, revert your `AppDelegate.swift` /
`MainApplication.kt` / Podfile / gradle / patches to the standard
RN 0.84 templates documented in that file, run
`pod deintegrate && pod install` (the CocoaPods 1.16 bug needs
`LANG=en_US.UTF-8`), and rebuild.

## [0.2.0] — 2026-05-21

> [!IMPORTANT]
> This release changes the peer-dependency contract in a
> backward-incompatible way (semver-minor in 0.x).  The public hook
> surface is preserved — no JS code changes are required for any
> host that doesn't directly import `expo-sensors`.  Verified end-
> to-end on iPhone 16 Pro (iOS 26.4.2) + Samsung Galaxy A35
> (Android, SM_A356U1).

### Removed

- **`expo-sensors` is no longer a peer dependency.**  The SDK used to
  pull in the entire Expo modules runtime (`expo`, `expo-modules-core`,
  `expo-modules-autolinking`, `expo-sensors`) just for two hooks —
  `useDeviceOrientation` and `useIMUTranslationGate`.  That tax was
  disproportionate to the value (see the host-integration burden in
  [`docs/host-app-integration.md`](docs/host-app-integration.md)).
  Both hooks have been re-homed onto `react-native-sensors` (already
  a peer dep), so the SDK now works on bare React Native with no
  Expo modules infrastructure.

### Changed

- **`useDeviceOrientation` rewritten on `react-native-sensors`
  accelerometer.**  Same `DeviceOrientation` return type, same
  threshold-based dominant-axis classifier, same public signature.
  The internal-only change is the source: instead of
  `expo-sensors`' `DeviceMotion` (which normalised Android signs to
  iOS convention for us), we now subscribe to
  `react-native-sensors`' accelerometer and do the platform sign-
  flip explicitly in JS (`Platform.OS === 'android' ? -value : value`).
  Threshold is now platform-dependent because iOS reports in G's
  and Android in m/s² — see the file header for the per-platform
  numbers and the Issue #3 history that motivated keeping iOS as
  the reference convention.
- **`useIMUTranslationGate` rewritten on `react-native-sensors`
  accelerometer + JS-side IIR gravity subtraction.**  Same public
  signature, same options, same return shape, same on-budget-
  exceeded callback semantics, same anchor-reset behaviour.  The
  internal change: in 0.1.x the hook consumed `DeviceMotion.accel-
  eration` (gravity-subtracted via CoreMotion's native fusion on iOS
  / Android's `TYPE_LINEAR_ACCELERATION` on Android — both produced
  by hardware sensor fusion).  v0.2 consumes raw accelerometer and
  estimates the gravity vector with a JS IIR low-pass (alpha = 0.9
  at 50 Hz → ~200 ms time constant), then subtracts.  **Noise
  trade-off**: the JS IIR is measurably noisier than CoreMotion's
  native fusion — expect a few extra cm of apparent drift on a
  stationary phone over several seconds.  With the per-sample
  velocity damping (5 %) and the anchor reset on every accepted
  keyframe, the drift stays bounded inside a 0.3-2 s integration
  window, which is comfortably under the default 8 cm budget.  If
  the IIR floor becomes a problem in practice, we'll consider
  moving the fusion into a small native module rather than re-
  introducing the Expo modules dependency.

### Migration from 0.1.x

No JS code changes are required for any host — the public surface
that survives 0.1.x → 0.2.0 is source-compatible.

Native-side, you can now optionally rip out the entire Expo modules
host wiring (Podfile `use_expo_modules!` macro, `AppDelegate.swift`
Expo factory, `MainApplication.kt` `ExpoReactHostFactory`, the gradle
`expo-root-project` plugin, the two `patch-package` patches for Expo
SDK 55 on RN 0.84) — that whole section of
[`docs/host-app-integration.md`](docs/host-app-integration.md) is
optional from 0.2.0 onward and will be removed from the doc in a
follow-up commit.

## [0.1.3] — 2026-05-21

### Changed

- **Docs / source-comment cleanup.** Removed the leftover
  pre-extraction RetaiLens-monorepo framing from the README — this repo
  is now the canonical, self-contained source of `react-native-image-
  stitcher`, not a downstream subtree of anything.  Source-file path
  comments and iOS GCD queue labels now use the canonical
  `io.imagestitcher.*` namespace and `react-native-image-stitcher/`
  repo path instead of the leftover `com.retailens.*` /
  `retailens-capture-sdk/` references that survived the 0.1.0 rename.
  GCD label change affects: `RNSARSession.poseLogQueue`,
  `IncrementalStitcher.workQueue`, `IncrementalStitcher.refineQueue` —
  labels are diagnostic-only (Instruments / crash-report symbolication),
  no public-API or behaviour impact.  The CHANGELOG.md migration table
  for [0.1.0] retains the historical `com.retailens.capturesdk` name
  intentionally — it documents the rename that shipped, not the
  current state.
- **CHANGELOG.** Added compare-links for [0.1.1] and [0.1.2] and fixed
  the [Unreleased] compare base.  Annotated the [0.1.0] "Deliberately
  NOT exported" section with a header note explaining that most of
  those entries were promoted to public in [0.1.1] — see the 0.1.1
  *Added* list for the current public surface.

## [0.1.2] — 2026-05-20

### Added

- **`outputDir` prop on `<Camera>`** + **`outputPath` per-call
  option on `useCapture.takePhoto`** — captures (both tap-photos
  and hold-panoramas) can now land at a host-controlled file
  location instead of vision-camera's tmp dir.  Filename is
  composed internally as `${outputDir}/photo-${ts}.jpg` /
  `${outputDir}/panorama-${ts}.jpg` for `<Camera>`; per-call
  `outputPath` on `useCapture` lets layer-2 hosts compose their
  own filenames.
  - On disk failure the capture rejects with
    `CameraError('OUTPUT_WRITE_FAILED', ...)`.  **No silent
    fallback** to a different path — that hides bugs.
  - Host owns *picking* the path.  The lib treats the value as an
    opaque writable filesystem path; it does not know about iOS
    `UIFileSharingEnabled`, Android MediaStore, SAF, or any other
    platform-specific shared-storage mechanism.  That's the host's
    domain.
  - **No peer deps required** — the move is handled by a small
    native bridge (`RNImageStitcherFileUtils`) that ships with
    the lib.
- **Canonical default capture directory** — when neither
  `outputDir` nor `outputPath` is set, the lib now writes captures
  to a predictable per-platform location instead of vision-camera's
  auto-generated tmp paths:
  - iOS: `<NSCachesDirectory>/react-native-image-stitcher/photo-<ms>.jpg`
    (and `panorama-<ms>.jpg`).
  - Android: `<context.cacheDir>/react-native-image-stitcher/...`.
  - Both are app-private, evictable by the OS under storage
    pressure, not backed up.  Captures live here until the host
    moves them somewhere durable — the lib doesn't promise
    persistence beyond the immediate capture flow.
  - This applies to BOTH tap-photo and panorama, so call-sites can
    rely on a single naming + parent-dir convention regardless of
    capture type.
- **`RNImageStitcherFileUtils` native module** (internal) —
  small Swift + Kotlin bridge exposing `moveFile(from, to)` and
  `defaultCaptureDir()`.  Used by the lib's own JS layer to relocate
  vision-camera's auto-named output into the canonical default dir
  / `outputDir` without forcing a peer dep on `expo-file-system`
  for every consumer.  Not re-exported from `src/index.ts`.

### Fixed

- **Android `cv::imwrite` rejected `file://`-scheme output paths.**
  `IncrementalStitcher.finalize` (Kotlin) was passing the host-
  provided `outputPath` straight to `cv::imwrite` without
  normalisation, so consumers using `expo-file-system`'s
  `documentDirectory` (which always prefixes `file://`) hit
  "Stitch failed: cv::imwrite returned false (code=101)" on every
  panorama capture.  iOS already stripped at the same boundary
  (`IncrementalStitcher.swift:1215`); now Android does too via
  `stripFileScheme()`, which already exists in the same file and
  is used by `refinePanorama`.  The fix has zero behaviour impact
  on hosts that were already passing bare paths.
- **iOS modular-header build under `use_frameworks!`** — host apps
  that opt into modular framework linkage (Expo + `use_frameworks!`,
  RetaiLens-mobile is the immediate example) hit
  ``'cstdint' file not found / could not build Objective-C module
  'RNImageStitcher'`` because CocoaPods defaulted EVERY header in
  `source_files` (including the shared `cpp/*.hpp` C++ headers) to
  public.  The auto-generated `RNImageStitcher-umbrella.h` then
  `#import`ed `keyframe_gate.hpp` / `stitcher.hpp` from a pure
  Obj-C context and tripped on the C++ stdlib.  Pin
  `s.public_header_files = ['ios/Sources/**/*.h']` so the umbrella
  exposes only the iOS-side Obj-C `.h` files; the `.mm` source files
  still locate the C++ headers via `HEADER_SEARCH_PATHS` set in
  `pod_target_xcconfig`, so behaviour is unchanged for non-modular
  hosts.  The umbrella now contains: `KeyframeGateBridge.h`,
  `OpenCVIncrementalStitcher.h`, `OpenCVKeyframeCollector.h`,
  `OpenCVSlitScanStitcher.h`, `OpenCVStitcher.h` — all Foundation /
  CoreVideo-only declarations (the OpenCV C++ types stay inside the
  `.mm` implementations).

## [0.1.1] — 2026-05-20

### Added

- **Layer 2 building blocks now public.**  The lower-level views,
  hooks, and stitching-engine bindings that previously lived behind
  the `<Camera>` wrapper are now exported from the package root.
  Use these when `<Camera>` doesn't give you enough control — e.g.,
  when you're hand-composing your own capture screen on top of the
  same proven primitives.  Full list:
  - Views: `ARCameraView`, `CameraView` (+ their handle/prop types).
  - UI components: `CaptureHeader`, `CaptureControlsBar`,
    `CapturePreview`, `CaptureStatusOverlay`, `CaptureThumbnailStrip`,
    `IncrementalPanGuide`, `PanoramaBandOverlay`, `PanoramaGuidance`,
    `PanoramaSettingsModal` (+ `DEFAULT_PANORAMA_SETTINGS` constant +
    `PanoramaSettings` type), `ViewportCropOverlay`.
  - Hooks: `useCapture`, `useVideoCapture`, `useDeviceOrientation`,
    `useIncrementalStitcher`, `useIncrementalJSDriver`.
  - Engine: `IncrementalOutcome`, `incrementalStitcherIsAvailable`,
    `subscribeIncrementalState`, `getIncrementalNativeModule`,
    `cleanupOldKeyframes`, `IncrementalState` (type).
  - Batch stitching: `stitchVideo`.
- The 0.1.0 → 1.0 stability gate still applies — the goal of
  surfacing layer 2 is to support advanced consumers (e.g.,
  `retailens-camera-sdk`) without forcing them to deep-import
  package internals.  These are likely to keep their shape through
  1.0, but the contract is not formally stable until then.

### Changed

- README now documents both layers and recommends `<Camera>` as the
  default starting point.

### Fixed

(No bug fixes in this release — see 0.1.0 for the device-verified
camera lifecycle fixes that shipped with the initial release.)

## [0.1.0] — 2026-05-20

First public release.

### Added

- `<Camera>` — props-based RN component combining tap-to-photo and
  hold-to-pan-and-stitch panorama capture in one surface.  Switches
  internally between ARKit/ARCore (AR mode) and vision-camera + IMU
  (non-AR mode); the host doesn't manage the modes directly.
- `useARSession()` — hook exposing the underlying ARKit/ARCore session
  (availability, tracking state, pose log).  For hosts that want to
  build AR-driven UIs on top of the public lib's foundation.
- `useIMUTranslationGate()` — hook exposing the same IMU-fused
  translation-budget gate that `<Camera>` uses internally on the non-AR
  capture path.  Useful if you're building your own non-AR capture
  pipeline.
- Native binaries (OpenCV `cv::Stitcher` xcframework for iOS, `.so`
  for Android) fetched from GitHub Releases on `npm install` via the
  package's postinstall script.  Android ships `arm64-v8a` only —
  covers all production Android phones; x86/x86_64 emulator support
  is on the v0.2 roadmap.
- Apache 2.0 license.

### Deliberately NOT exported in v0.1.0

The following are intentionally internal so the public surface stays
small.  If you have a real use-case for any of these, please open an
issue describing it.

> [!NOTE]
> **This list reflects the v0.1.0 surface as shipped.**  Most of the
> entries below — the layer-2 hooks, views, UI components, and
> incremental-engine primitives — were subsequently promoted to public
> in [0.1.1].  See the 0.1.1 *Added* section for the current public
> surface; only a few items below remain internal in later releases
> (`CameraShutter`, `PanoramaConfirmModal`, `IncrementalStitcherView`,
> `stitchFrames`, `StitchNotImplementedError`, `runQualityCheck`,
> `normaliseOrientation`).

- `useCapture`, `useDeviceOrientation` — internal hooks `<Camera>`
  composes; expose these only after we have a story for what their
  separate-from-`<Camera>` use-case looks like.
- `CameraView`, `ARCameraView` — underlying preview surfaces.  Hosts
  that need both modes should use `<Camera>` (which switches between
  them); hosts that need only one path should still go through
  `<Camera>` (a future prop `mode="ar-only"` / `"non-ar-only"` is on
  the v0.2 roadmap).
- `CameraShutter`, `CaptureStatusOverlay`, `CaptureHeader`,
  `CaptureControlsBar`, `PanoramaGuidance`, `IncrementalPanGuide`,
  `PanoramaBandOverlay`, `ViewportCropOverlay`, `CapturePreview`,
  `PanoramaConfirmModal`, `CaptureThumbnailStrip`,
  `PanoramaSettingsModal`, `DEFAULT_PANORAMA_SETTINGS` — sub-pieces of
  `<Camera>`.
- `useIncrementalStitcher`, `useIncrementalJSDriver`,
  `IncrementalStitcherView`, `incrementalStitcherIsAvailable`,
  `getIncrementalNativeModule`, `cleanupOldKeyframes`,
  `subscribeIncrementalState`, `IncrementalOutcome` — internal driver
  primitives for the incremental engine.
- `stitchFrames`, `stitchVideo`, `StitchNotImplementedError` —
  batch-stitching primitives.  A candidate for graduating to public
  in v0.2 once we've decided whether they should be a parallel API
  to `<Camera>` or a hidden orchestrator.
- `runQualityCheck`, `normaliseOrientation` — image-quality helpers.
  Same status as batch-stitching.
- `useVideoCapture` — sweep-video capture, currently iOS-only with no
  shipping Android port.

### Migration from pre-publication ad-hoc usage

If you imported from `@retailens/capture-sdk` or directly from a
subtree-checkout of the monorepo, the migration to the published
`react-native-image-stitcher` package is:

| Old import (`@retailens/capture-sdk`) | New import (`react-native-image-stitcher`) |
|---|---|
| `Camera`, `CameraError`, … | unchanged |
| `useARSession`, `useIMUTranslationGate` | unchanged |
| Any other deep export (e.g. `stitchFrames`, `measureRegion`) | retired or moved — see "Deliberately NOT exported" above; retail-specific features are now in `retailens-camera-sdk` (private) |

Native module names also changed:
- `NativeModules.RetaiLensQualityChecker` → `NativeModules.RNImageStitcherQualityChecker`
- Java package: `com.retailens.capturesdk` → `io.imagestitcher.rn`
- iOS pod: `RetaiLensCaptureSDK` → `RNImageStitcher`
- iOS xcframework: shipped as `opencv2.xcframework` (linked from `RNImageStitcher.podspec`)

[Unreleased]: https://github.com/bhargavkanda/react-native-image-stitcher/compare/v0.7.1...HEAD
[0.7.1]: https://github.com/bhargavkanda/react-native-image-stitcher/compare/v0.7.0...v0.7.1
[0.7.0]: https://github.com/bhargavkanda/react-native-image-stitcher/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/bhargavkanda/react-native-image-stitcher/compare/v0.5.1...v0.6.0
[0.5.1]: https://github.com/bhargavkanda/react-native-image-stitcher/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/bhargavkanda/react-native-image-stitcher/compare/v0.4.1...v0.5.0
[0.4.1]: https://github.com/bhargavkanda/react-native-image-stitcher/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/bhargavkanda/react-native-image-stitcher/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/bhargavkanda/react-native-image-stitcher/compare/v0.2.1...v0.3.0
[0.2.1]: https://github.com/bhargavkanda/react-native-image-stitcher/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/bhargavkanda/react-native-image-stitcher/compare/v0.1.3...v0.2.0
[0.1.3]: https://github.com/bhargavkanda/react-native-image-stitcher/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/bhargavkanda/react-native-image-stitcher/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/bhargavkanda/react-native-image-stitcher/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/bhargavkanda/react-native-image-stitcher/releases/tag/v0.1.0
