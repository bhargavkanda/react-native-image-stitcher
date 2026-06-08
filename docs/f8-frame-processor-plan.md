# F8 — Frame Processor port: non-AR optical flow on YUV frames

> _Historical — references the host-worklet frame-processor API removed in
> v0.15.0 (see the CHANGELOG)._

**Status:** planned, not started.
**Branch:** `feature/f8-frame-processor-yuv`
**Estimated:** 12-15 focused hours, ~5 sub-tasks.

---

## 1. Background — the current non-AR pipeline

`src/stitching/useIncrementalJSDriver.ts` is the JS-side driver for non-AR
capture on both iOS and Android. Its lifecycle:

1. `start(cameraRef)` is called from `<Camera>`'s `handleHoldStart`.
2. A `setInterval(tick, snapshotIntervalMs)` runs on the JS thread,
   default 250 ms (4 fps cap).
3. Each tick:
   - `cam.takeSnapshot({ quality: 70 })` — vision-camera encodes a JPEG
     and writes it to the app's tmp dir (Android `cache`, iOS `Caches`).
   - Returns `{ path, width, height }` to JS.
4. JS integrates gyroscope on its own ~33 ms cadence into `yaw`/`pitch`
   refs, computes a quaternion, derives `fx/fy/cx/cy` from an assumed
   FoV.
5. Calls `native.processFrameAtPath({ path, yaw, pitch, qx/qy/qz/qw,
   fx/fy/cx/cy, imageWidth, imageHeight, ... })` via the RN bridge.
6. Native (Kotlin / Swift):
   - Reads JPEG from disk.
   - Decodes to `cv::Mat`.
   - Feeds into `keyframe_gate.cpp` (the optical-flow gate).
   - On accept: optionally writes a JPEG keyframe back to disk; emits a
     state event up to JS.

### Costs per candidate frame

| Cost | Where | Notes |
|---|---|---|
| JPEG encode | vision-camera (CPU) | ~15-25 ms on Galaxy A35, similar on iPhone 14 |
| Disk write | OS | Smallish (~50-150 KB) but synchronous on the producer thread |
| JS bridge hop | RN bridge | Marshalls 14+ numeric args + a string path |
| JPEG decode | native | Mirror of the encode cost |
| `cv::Mat` allocation | native | Per-frame |
| Disk write | native (if accepted) | Only for the ~5-10% of frames that pass the gate |

Effectively the *rejected-frame* cost is paid by 90%+ of frames. That's
the dominant inefficiency: we encode + write + JS-bridge + read + decode
*just to throw the frame away*.

### Throughput ceiling

Hard-capped at 4 fps by the interval. Optical flow is more robust with
denser sampling — Shi-Tomasi + KLT works at any rate the device can
sustain, and at 30 fps the inter-frame displacement is small enough that
we can use cheaper integer-pyramid LK without losing accuracy.

---

## 2. Target — Frame Processor architecture

Vision-camera v3+ exposes a *frame processor* — a Reanimated worklet that
runs **on the camera producer thread** (Camera2 image-reader thread on
Android, `AVCaptureVideoDataOutput` queue on iOS). Worklets call into
native via Frame Processor Plugins (JSI bindings, not the RN bridge).

```
camera sensor ──► YUV frame (CMSampleBuffer / Image)
                       │
                       ▼ (producer thread)
              ┌──────────────────────┐
              │ frameProcessor       │  ← worklet, throttled to N fps
              │ worklet              │
              └──────────────────────┘
                       │ JSI call (synchronous, no bridge)
                       ▼
              ┌──────────────────────┐
              │ FrameProcessorPlugin │  ← Obj-C/Kotlin shim
              │ - YUV→cv::Mat        │     zero-copy planar refs
              │ - keyframe_gate.cpp  │
              └──────────────────────┘
                       │
            ┌──────────┴──────────┐
            ▼                     ▼
       reject (90%+)         accept (~5-10%)
       ─ nothing              ─ encode JPEG once
                              ─ persist as keyframe
                              ─ emit state event
```

### Wins (concrete)

- **Zero work for rejected frames** beyond a Shi-Tomasi + KLT call on a
  pyramidal cv::Mat that aliases the camera buffer directly. Estimated
  per-rejected-frame cost: ~3-8 ms on the producer thread (vs. ~50-80
  ms round-trip today).
- **Throughput:** up to 30 fps (camera native), throttled by the
  existing `frameSelection.flow.evalEveryNFrames` setting which we'll
  reinterpret as "process every Nth producer-thread frame".
- **No disk thrash:** rejected frames never touch the filesystem. The
  app's cache directory stops growing during a recording.
- **Lower latency to accept:** the moment the flow exceeds the novelty
  threshold, we encode and persist; no waiting for the next JS tick.

### Why YUV (and not RGB or RGBA)

Camera sensors output YUV (specifically NV12 / NV21 on Android, BiPlanar
420 on iOS). RGB conversion is a per-pixel cost that's ~5-10 ms on a
1920×1080 frame. The keyframe gate only needs **grayscale Y** for
optical flow (Shi-Tomasi operates on luma) — and YUV's Y-plane *is*
grayscale, contiguous, and we can construct a `cv::Mat` that aliases it
with zero copy. Same trick on both platforms.

---

## 3. Sub-tasks (commit-sized)

### F8.1 — Frame Processor Plugin: iOS side

**Goal:** Expose a `cv_flow_gate_process_frame` JSI plugin on iOS that
accepts a `Frame` + pose args and returns `{ accepted, novelty,
acceptedCount }`.

**Files to create / modify:**
- `ios/Sources/RNImageStitcher/CvFlowGateFrameProcessor.swift` — new.
  Implements `VisionCameraProxy.addFrameProcessorPlugin(...)`. Uses
  `CMSampleBufferGetImageBuffer` → `CVPixelBufferGetBaseAddressOfPlane(0)`
  to read the Y plane.
- `ios/Sources/RNImageStitcher/CvFlowGateBridge.h` / `.mm` — C ABI shim
  that takes a YUV plane pointer + dimensions and calls into
  `cpp/keyframe_gate.cpp::processFrame`.
- `RNImageStitcher.podspec` — confirm `VisionCamera` dependency is
  pulled (peer) and that the new files compile.

**Acceptance:**
- Plugin registered and callable from a worklet under both Debug + Release.
- Smoke test in `example/`: tap-and-hold non-AR capture for 5 s, see
  keyframes accumulating in the band overlay, no JPEG candidates left in
  the cache dir.

### F8.2 — Frame Processor Plugin: Android side

**Goal:** Same plugin on Android. Different scaffolding (`FrameProcessorPlugin` Kotlin class registered via `FrameProcessorPluginRegistry.addFrameProcessorPlugin`).

**Files to create / modify:**
- `android/src/main/java/io/imagestitcher/rn/CvFlowGateFrameProcessor.kt`
  — new.
- `android/src/main/cpp/CvFlowGateJNI.cpp` — JNI shim, mirrors the iOS
  C ABI. Reads `Image.Plane.buffer` for the Y plane (direct
  `ByteBuffer`).
- `android/CMakeLists.txt` — link the new JNI source.
- `RNImageStitcherPackage.kt` — register the plugin at module load via
  `FrameProcessorPluginRegistry.addFrameProcessorPlugin("cv_flow_gate_process_frame", ::CvFlowGateFrameProcessor)`.

**Acceptance:** mirrors F8.1 on Android (A35 hardware).

### F8.3 — JS side: rewrite `useIncrementalJSDriver` as `useFrameProcessorDriver`

**Goal:** Replace the interval-based driver with a worklet-based one.
Keep the gyro integration on JS thread; expose yaw/pitch via Reanimated
`useSharedValue` so the worklet reads them without a thread hop.

**Files to create / modify:**
- `src/stitching/useFrameProcessorDriver.ts` — new. Returns
  `{ start, stop, frameProcessor }`. `frameProcessor` is the worklet
  that the `<Camera>` JSX binds to vision-camera's `<VisionCamera
  frameProcessor={fp} />` prop.
- `src/camera/Camera.tsx` — switch the non-AR path from `jsDriver` to
  the new hook. Wire the worklet to `VisionCamera`. Keep the AR path
  untouched.
- `src/stitching/useIncrementalJSDriver.ts` — **keep**, mark deprecated,
  use as fallback when `useFrameProcessor` is unavailable (older
  vision-camera, or per-host opt-out via a new `Camera` prop).

**Throttling:** the worklet reads `frameSelection.flow.evalEveryNFrames`
from a shared value and skips when `frameIdx % N !== 0`. Counter lives in
a `useSharedValue<number>`.

**Acceptance:** typecheck clean, unit tests for the throttle logic
(jest, not on-device).

### F8.4 — Tests + on-device verification

- **Unit:** YUV→cv::Mat aliasing correctness (mock buffers, verify
  stride handling). Throttle counter behaviour. Settings round-trip.
- **Integration:** `example/` build runs on iPhone + A35.
  - Camera mounts.
  - Non-AR capture accumulates keyframes at the operator-felt rate
    (should feel snappier than before).
  - AR mode still works (regression check).
  - Debug overlay shows the new metrics: per-frame gate processing
    time, frames-since-last-keyframe.
- **Stress:** 60 s continuous recording, watch peak memory + CPU
  (`xcrun instruments` on iOS, `simpleperf` on Android). Should show
  *lower* CPU than the jsDriver path.

### F8.5 — Migration + docs

- `CHANGELOG.md` — feature entry under `v0.5.0` heading.
- `docs/host-app-integration.md` — update with the new
  `vision-camera` peer-dep version + the optional opt-out flag.
- README — note Frame Processor architecture in the non-AR section.
- Backward compatibility: keep the deprecated `useIncrementalJSDriver`
  export for one minor cycle (`v0.5.x` → remove in `v0.6.0`). Add a
  `console.warn` on its `start()` call directing users to the new hook.

---

## 4. Risks + open questions

### Risk: vision-camera Frame Processor stability on RN 0.84

Vision-camera v4 supports RN 0.74+ officially. We're on RN 0.84.1 +
new architecture + bridgeless + prebuilt React. The Frame Processor
worklet path goes through Reanimated 3, which has its own bridgeless
compatibility caveats. **Action:** before starting F8.1, run a smoke
test on a hello-world frame processor (just `console.log` the frame
dimensions from the worklet) on both devices. If it fires once per
frame, we're good. If not, we have a vision-camera/Reanimated upgrade
to do first.

### Risk: YUV format variance

Android exposes `YUV_420_888` which can have stride padding (`rowStride
> width`). iOS `kCVPixelFormatType_420YpCbCr8BiPlanarFullRange` is
biplanar (Y + interleaved UV). The keyframe gate only reads Y, so
biplanar vs planar doesn't matter — but the row stride does. The
`cv::Mat` constructor that takes a stride parameter handles it:

```cpp
cv::Mat yPlane(height, width, CV_8UC1, yPtr, rowStride);
```

**Action:** F8.1 and F8.2 both need to pass `rowStride` through the JNI
/ C ABI, not just `width`. Easy to forget.

### Risk: Frame lifecycle / use-after-free

The `Frame` object passed to the worklet has a *very short* lifetime —
it's owned by the camera's image reader / capture queue and recycled
back as soon as the worklet returns. **The C++ keyframe gate must not
retain the buffer pointer beyond the synchronous call.** If we want to
*encode + save* a frame, we have to do that *inside* the synchronous
plugin call before returning, while the buffer is still valid. That's
~5-15 ms of additional work on the producer thread for accepted frames.
Acceptable trade because we only pay it on accept (rare), and skipping
the disk round-trip saves much more.

**Open question:** should we copy the Y+UV planes into a managed buffer
*before* releasing the camera buffer, then encode JPEG on a background
thread? Probably overengineered for v0.5 — measure first, optimise if
producer thread blocking becomes a problem.

### Risk: Reanimated peer dependency

Frame processor worklets require Reanimated 3. Currently the example
project doesn't list Reanimated. **Action:** F8.3 must add Reanimated 3
to `example/package.json` peer/dev deps and document it as a peer dep on
the SDK (`react-native-image-stitcher` package.json).

### Open question: what about the iOS `processFrameAtPath` path that
still exists for the JPEG encode?

The existing `processFrameAtPath` ObjC method (used by `jsDriver` today)
can be repurposed: when the gate *accepts* a frame inside the Frame
Processor, we still need to write a JPEG to disk so the batch stitcher
can pick it up at finalize. The simplest path:

- Add a *second* native method `processYUVFrame(yPtr, width, height,
  rowStride, pose, intrinsics)` that does the gate + (on accept) encodes
  + saves.
- Keep `processFrameAtPath` for the deprecated `jsDriver` fallback.
- Both share the same `keyframe_gate.cpp` core.

This duplication is intentional and short-lived; remove
`processFrameAtPath` in v0.6.

### Open question: do we keep the gyro on JS thread?

Yes, recommended. Gyro is ~33 ms cadence (low rate, low cost) and JS is
fine. The worklet reads the latest integrated yaw/pitch from a Reanimated
`SharedValue` (atomic, no synchronization needed for double-word reads
on ARM64). Don't move gyro into the worklet — it would require a native
sensor binding inside the worklet, which is harder than it sounds.

---

## 5. Acceptance criteria for the F8 PR as a whole

- [ ] All 5 sub-tasks merged into `feature/f8-frame-processor-yuv`.
- [ ] `jest` 28/28 still passing + new throttle test added.
- [ ] On-device verification on both iPhone + A35 (non-AR captures
      produce keyframes at expected rate, AR mode untouched).
- [ ] CPU profile shows non-AR capture using *less* CPU than v0.4
      jsDriver path.
- [ ] CHANGELOG entry under v0.5.0.
- [ ] Deprecation warning fires in dev when `useIncrementalJSDriver` is
      imported (not when example app runs — only on direct import).

---

## 6. Sub-task task-list entries (TaskCreate these when starting)

- F8.1 — iOS Frame Processor Plugin (Swift + Obj-C++ shim)
- F8.2 — Android Frame Processor Plugin (Kotlin + JNI shim)
- F8.3 — JS hook rewrite (`useFrameProcessorDriver`) + Camera.tsx wire
- F8.4 — Tests + on-device verification (both platforms)
- F8.5 — Migration: CHANGELOG, docs, deprecation warning, peer-dep doc

Each is a separate commit on `feature/f8-frame-processor-yuv`. Merge to
main when all 5 land + on-device pass.

---

## 7. Pre-flight checklist for next session

Run these *before* writing F8.1 code:

1. `git checkout feature/f8-frame-processor-yuv && git pull --ff-only`
2. Confirm the example app still launches end-to-end (regression check
   after the v0.4 merge).
3. Smoke-test a hello-world frame processor on iPhone + A35
   (verifies vision-camera v4 + Reanimated 3 + RN 0.84 bridgeless work
   together). If this fails, F8 stalls until vision-camera + Reanimated
   compatibility resolves.
4. Read `node_modules/react-native-vision-camera/docs/docs/guides/FRAME_PROCESSORS_CREATE_PLUGIN_*` (separate files for iOS / Android).
5. Confirm `cpp/keyframe_gate.cpp` is stride-aware in its current
   `processFrame` signature — if not, add stride as a free parameter
   in F8.1.
