# v0.8.0 Phase 7 — AR-mode stitching parity gate

**Status:** mandatory pre-flight check before the v0.8.0 tag.

**Why this exists:** v0.8.0 migrated AR-mode capture from a direct
`ARSessionDelegate` → `IncrementalStitcher` path to a worklet-runtime-
mediated dispatch (`RNSARWorkletRuntime.dispatchFrame` on iOS,
`StitcherWorkletRuntime.runFirstParty` + `dispatchToHostWorklets`
on Android — Phases 3c, 4b.i, 4b.iii).  The migration's **strict
additive** BC posture (hosts that don't use `useFrameProcessor`
see no behavioural change) is verified by this gate: capturing the
same physical scene before and after the migration must produce
panoramas with pixel-wise SSIM ≥ 0.98.

If the gate fails, **do not ship v0.8.0**.  See "What to do if
parity fails" below.

## Prerequisites

- A device with v0.7.x and v0.8.0 builds installable side-by-side
  (or git-bisect-able)
- Python 3 + `Pillow numpy scikit-image`:
  ```bash
  python3 -m pip install Pillow numpy scikit-image
  ```
- A repeatable physical scene (textured wall, bookshelf, lab
  setup) where the operator can perform the same hold-and-release
  panorama sequence twice

## Procedure

### 1. Capture v0.7.x baseline

Check out the last v0.7.x release tag and build the example app:

```bash
git checkout v0.7.1   # or the latest v0.7.x tag
npm install
# iOS:
cd example/ios && pod install && cd -
LANG=en_US.UTF-8 xcodebuild -workspace example/ios/RNImageStitcherExample.xcworkspace \
  -scheme RNImageStitcherExample -configuration Debug \
  -destination 'generic/platform=iOS' \
  -derivedDataPath /tmp/v0.7-parity build
xcrun devicectl device install app --device <iPhone-udid> \
  /tmp/v0.7-parity/Build/Products/Debug-iphoneos/RNImageStitcherExample.app
# Android (from example/):
JAVA_HOME=$JAVA_HOME ./android/gradlew -p android :app:installDebug
```

Perform the panorama sequence in AR mode.  Use Files / `adb pull`
to extract the resulting JPEG.  Save to:

```
parity-baselines/v0.7-<device>-<scene-id>.jpg
```

(Both `parity-baselines/` and `*.parity-verification.md` are
gitignored — these are per-developer artifacts.)

### 2. Capture v0.8.0 candidate

```bash
git checkout main   # or the v0.8.0 release candidate tag
# Rebuild + install per above
```

Perform the SAME panorama sequence (same starting orientation,
same pan speed, same end orientation).  Save the output:

```
parity-baselines/v0.8-<device>-<scene-id>.jpg
```

### 3. Run the SSIM gate

```bash
python3 scripts/ssim-compare.py \
  parity-baselines/v0.7-<device>-<scene-id>.jpg \
  parity-baselines/v0.8-<device>-<scene-id>.jpg
```

Expected output:

```
[ssim-compare] PASS  score=0.99XX  threshold=0.9800  channel=luma  dims=WxH
```

Exit code:
- `0` → SSIM ≥ 0.98, parity OK
- `1` → SSIM < 0.98, parity FAILED (do not ship)
- `2` → usage error / missing file / missing dependency

### 4. Repeat per device + per mode

Minimum verification matrix:

| Device | Capture mode | Required |
|--------|--------------|----------|
| iPhone (latest tested — 16 Pro) | AR mode (default) | ✅ |
| Galaxy A35 (or other Android ARCore device) | AR mode | ✅ |
| Either | Non-AR (vc Frame Processor) | If feasible |

The non-AR mode is technically out of scope for the v0.8.0
migration (worklet runtime only touches AR mode), but a quick
visual smoke test confirms no accidental regression.

### 5. Record the verification

Save the SSIM scores + a short note (date, device, scene) to:

```
docs/v0.8.0.parity-verification.md
```

(`*.parity-verification.md` is gitignored.)  When v0.8.0 ships,
paste the verification summary into the GitHub Release body — see
v0.7.0's release notes for the format.

## What to do if parity fails

Per the v0.8.0 plan: **stop and root-cause; do not paper over
with thresholds.**

Likely culprits if SSIM is degraded:

1. **Frame ordering changed** — the worklet runtime delivers
   frames out of order vs. v0.7.x's direct ARSessionDelegate
   call.  Check `RNSARWorkletRuntime.dispatchFrame:pose:` — the
   first-party callback runs synchronously on the caller thread,
   so order should be preserved.  Confirm `_firstPartyCallback`
   isn't being posted onto a separate queue.

2. **ARFrame strong-reference lifetime is wrong** — the
   `CFBridgingRetain(arFrame)` in iOS' `IOSPixelBufferReader` (or
   the `std::vector` copy in Android's `AndroidNV21BufferReader`)
   must outlive the engine's read.  Check via Xcode Instruments
   → Allocations: are ARFrames being deallocated mid-read?

3. **Pose decomposition lost precision** — the `RNSARFramePose`
   struct on iOS / pose-extraction in `RNSARCameraView.onDrawFrame`
   on Android should produce bit-identical quaternions to v0.7.x.
   Spot-check by dumping pose values for the same frame on both
   builds.

4. **NV21 byte-pack divergence (Android only)** — the same
   `YuvImageConverter.packNV21` is called in both paths.  Confirm
   the call site hasn't changed + the pixel format is still
   `YUV_420_888`.

Fix the underlying cause; do not skip the gate.

## Frame-rate parity (separate gate)

The SSIM gate verifies stitching output; the per-frame native
cost of the new worklet dispatch path is a separate concern.
Acceptance: per-frame native cost (ARFrame → ingestion) is
within +1ms of baseline.

To measure, run an AR-mode capture under Xcode Instruments
(Time Profiler) and compare the sum of `RNSARWorkletRuntime
::dispatchFrame:` + `incrementalConsumer.consumeFrame(...)`
timings to the v0.7.x baseline.  If higher, investigate the
worklet runtime dispatch overhead.

The Android equivalent: capture an `adb shell perfetto` trace
over `forwardToIncremental` and compare.
