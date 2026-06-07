# Stitch Pipeline Architecture — iOS vs Android, and the Parity Plan

**Status:** living reference. Created **2026-06-06** to end repeated re-discovery
of how the iOS and Android stitch paths relate. Every factual claim below is
pinned to a `file:line` you can verify with the command given. If you change the
code, update the citation.

---

## 0. The one fact that settles "do iOS and Android use the same stitch path?"

They call the **same function** in the **same file** — but take **different
branches inside it**:

- **iOS → manual `cv::detail` pipeline.**
- **Android → high-level `cv::Stitcher` pipeline.**

**Verify in 5 seconds:**

```
grep -rn useManualPipeline cpp/ ios/Sources android/src
```

You will see `useManualPipeline` set to `true` only on iOS, referenced only in
`cpp/`, and **zero hits under `android/`**. That asymmetry is the whole answer.

---

## 1. The fork

Both platforms call the shared entry point `retailens::stitchFramePaths`
(`cpp/stitcher.cpp:299`). Inside, everything routes through a single branch:

| | iOS | Android |
|---|---|---|
| Calls | `OpenCVStitcher.stitchFramePaths` → `retailens::stitchFramePaths` | `BatchStitcher.stitchSync` → JNI `nativeStitchFramePaths` → `retailens::stitchFramePaths` |
| Sets `useManualPipeline`? | **`true`** (`ios/Sources/RNImageStitcher/OpenCVStitcher.mm:481`) | **never set** — the JNI has no such parameter (`android/src/main/cpp/image_stitcher_jni.cpp:80-83`, `:105-113`) |
| Effective value | `true` | `false` (struct default, `cpp/stitcher.hpp:198`) |
| Branch taken (`cpp/stitcher.cpp:386 if (config.useManualPipeline)`) | **manual** `cv::detail::*` | **else** → high-level `cv::Stitcher::create` (`:445-449`) |

So: **same door, different room.** "Shared cpp file" is true; "same pipeline" is
not. (This is the point that was answered inconsistently several times — see §8.)

---

## 2. PANORAMA ↔ SCANS mode handling

### 2a. Initial mode is resolved BEFORE the native call (both platforms, symmetric)
`auto` → `panorama` or `scans` via a translation/rotation heuristic:
- Android: `IncrementalStitcher.kt:642-670` (`resolveStitchModeAuto`; ratio ≥ 0.55 → SCANS, else PANORAMA).
- iOS: `IncrementalStitcher.swift:414-416` (`resolveStitchModeAuto`, "matches Android's" `:221-223`).

### 2b. There IS a PANORAMA↔SCANS fallback, and it is SHARED (both platforms)
`stitchFramePaths` (`cpp/stitcher.cpp:299-370`) is a wrapper around the inner
`stitchFramePathsImpl_`. It runs the chosen mode, and on a *retryable* failure
(homography / camera-params / warp / empty — `:334-339`) retries the **opposite**
mode (`:344-353`). Because the wrapper is shared, **Android gets the fallback
too** — it is NOT manual-only.

### 2c. ⚠️ The fallback is a FULL re-run, not the cheap partial re-run we intended
The comment at `:316-318` claims *"only the estimator/BA/warp middle is re-run."*
**The code does not do that.** `runOnce` (`:321-324`) calls the entire
`stitchFramePathsImpl_` again — including re-`imread` and re-detecting features
(`:861`). So today both platforms pay a **full second pass** for the SCANS
fallback. The "use the manual pipeline so the retry is cheap" goal is documented
but **never implemented**. (This is Part 1's cheap-re-run work — §7.)

---

## 3. Why the two paths produce DIFFERENT output (Android currently looks better)

The manual path is a **hand-rolled reimplementation** of `cv::Stitcher::PANORAMA`
using `cv::detail::*` (`cpp/stitcher.cpp:661`, `:884-897`) — **not** the library's
own code. It replicates the major steps: `BundleAdjusterRay` (`:1322`), wave
correction (`:1419`), `GraphCutSeamFinder` (`:1910`), `MultiBandBlender`
(`:1710`). It diverges in two ways that degrade iOS:

1. **Resolution.** iOS passes no resolution overrides, so the manual path uses its
   defaults **registration 0.3 MP / compose 0.6 MP** (`cpp/stitcher.cpp:954`,
   `:964`). Android passes **compose 1.0 MP** (`BatchStitcher.kt:155`) +
   registration 0.6 (cv default, `:144`). → Android localizes features at **2×**
   and composites at **~1.7×** the pixels = sharper, tighter alignment.
   *(The iOS comment at `OpenCVStitcher.mm:446-448` claiming "registration 0.6 MP"
   is STALE — the code path actually uses 0.3.)*
2. **Exposure compensation — the manual path skips it.** `cv::Stitcher::PANORAMA`
   runs a `GainCompensator` to even brightness/color across frames before
   blending. The manual path creates **no compensator** — warped frames go
   straight to the blender (`cpp/stitcher.cpp:1960`, `:2004`). The file header
   even says it *should* have one (`:12`) but it was never wired. → iOS panoramas
   get **visible brightness/color steps at seams** that Android does not.

There may be further hand-rolled-vs-library param differences (BA convergence,
seam/blend tuning), but (1) and (2) are the concrete, verified ones.

---

## 4. Orientation — investigated and CLEARED (it is NOT the iOS↔Android cause)

The orientation handling is **symmetric across iOS and Android** and **byte-
identical to v0.6.0**:
- Both save keyframes unrotated (`rotationDegrees=0`) with a hardcoded **EXIF=6**
  tag (iOS `OpenCVKeyframeCollector.mm`; Android `YuvImageConverter.kt` → also 6
  for a portrait host).
- `cv::imread` applies that tag on **both** (`cpp/stitcher.cpp:426` high-level,
  `:861` manual); `bake_rotation` (`:122-148`, called `:600`/`:2400`) runs
  identically.
- The ARKit-roll classifier, EXIF=6 hardcode, etc. all already existed at v0.6.0
  (verified via `git show v0.6.0:…`). The one orientation-related change since
  v0.6.0 *removed* a bug (the dead `cameraParamsFromPose` landscape-K injection).

So orientation cannot explain "iOS ≠ Android" (it is identical on both) nor "iOS
regressed" (it did not change). The real differences are §3 (pipeline/res/
exposure) and §5 (geometry).

---

## 5. 0.5× ultra-wide / parallax, and the cylindrical fallback

- `STITCH_CAMERA_PARAMS_FAIL` ("warpRoi too large 8171×12336 … degenerate camera
  params") is the **warp guard** (`cpp/stitcher.cpp` step8b + `cpp/warp_guard.hpp`
  `warpRoiExceedsGuard`, 100 MP cap). Root cause: PANORAMA assumes pure rotation;
  camera **translation** breaks it, and **0.5× ultra-wide amplifies parallax**, so
  even small hand movement diverges the bundle adjuster.
- A **cylindrical-fallback pre-pass** (`cpp/stitcher.cpp` "step 7.6", commit
  `68c13db`) salvages it: if the plane warp would exceed the guard, retry with the
  bounded cylindrical projection before failing. **This lives in the MANUAL
  branch**, so today it only helps iOS; Android's high-level `cv::Stitcher` has its
  own internal warp/ROI handling.

---

## 6. Relevant history (dates matter — versions move fast here)

- `f07b4ba` (2026-05-15) — ported the iOS manual `cv::detail` pipeline into shared
  `cpp/stitcher.cpp` behind `useManualPipeline`.
- `7e6a918` (2026-05-16) — iOS bridge swapped to shared cpp; sets
  `useManualPipeline=true`. **iOS has been on the manual path ever since** (present
  at v0.6.0, v0.14.2, HEAD).
- `c01f6ed` (2026-06-03) — archived the ARKit **pose-driven** stitch. iOS's manual
  pipeline went from ARKit rotations → feature-based BA. (Candidate cause of any
  iOS regression *vs v0.6.0*, distinct from the iOS↔Android gap.)
- `68c13db` (2026-06-06) — cylindrical warp fallback (§5).

---

## 7. The plan (decided 2026-06-06)

### Part 1 — bring the manual path to parity, run BOTH paths for comparison
1. **Parity (manual path):**
   - Raise its resolution to match the high-level path (registration 0.6, compose
     1.0). *(Memory note: 1.0 MP compose ≈ +memory; fine on iPhone 16 Pro, RAM-gate
     for the fleet via the existing `cfg.availableRamMB` at `OpenCVStitcher.mm:473`.)*
   - Wire the missing `cv::detail::GainCompensator` before the blender feed loop
     (`cpp/stitcher.cpp` ~`:1950`), matching what `cv::Stitcher` does.
2. **Dual-path comparison harness (temporary):** on a capture, run BOTH the manual
   and high-level pipelines on BOTH iOS and Android, save BOTH outputs (e.g.
   `…_manual.jpg` + `…_highlevel.jpg`) so results can be compared side by side.
   Gated behind a temporary debug flag; removed after the decision.
3. **Cheap partial re-run for the SCANS fallback (manual only):** refactor
   `stitchFramePathsImpl_` so load + feature-detect + match run **once**, and only
   estimator → BA → warp → blend re-run for the opposite mode. (High-level
   `cv::Stitcher` is a black box and cannot do this — that asymmetry is the whole
   reason the manual path was chosen.)

### Part 2 — conditional
If the manual path still loses the comparison after parity, point **both**
platforms at the high-level `cv::Stitcher` (flip iOS's flag; the shared mode-
fallback still applies) and measure how expensive the PANORAMA↔SCANS switch is
there (it will be a full re-run — see §2c).

### Part 3 — this document
Keep it current. It is the single source of truth for this subsystem.

---

## 8. Flip-flop log (so this never happens again)

The question "do iOS and Android share the stitch path?" was answered
**inconsistently at least four times** across this work — "parity" → "not
identical" → "parity" → "different". Root cause: every check confirmed *"both
call `stitchFramePaths`"* (true) and stopped there, or chased the genuinely-dead
`stitchKeyframePaths` (`OpenCVStitcher.mm:352`, defined-but-uncalled) — **without
ever checking the `useManualPipeline` flag that actually selects the branch.**

**Rule for the future:** to answer anything about iOS-vs-Android stitch behavior,
run `grep -rn useManualPipeline cpp/ ios/Sources android/src` FIRST. The flag is
the answer.
