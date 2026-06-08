# archive/ — dormant source (NOT built or shipped)

Code archived during the **batch-keyframe cleanup** (2026-06-02). The SDK
now ships only the `batch-keyframe` stitching engine. The live/incremental
engines (hybrid, slit-scan, firstwins) and the third-party host-worklet /
frame-stream observer API (`__stitcherProxy`, `useFrameProcessor` /
`useThrottledFrameProcessor` / `useFrameStream`) were moved here. So was the
audit-dead **pose-driven stitch** (`OpenCVPoseDrivenStitch.mm` — build OpenCV
`CameraParams` directly from ARKit poses instead of feature-matching; the
unbuilt "Phase 5" direction). NOTE: AR pose-based *keyframe gating* is NOT
archived — it stays in the live batch-keyframe path; only the pose-driven
*stitch geometry* was dead.

**This tree is excluded from every build surface:**
- `tsc` — root tsconfig `include: ["src"]` (archive/ is outside src/)
- jest — `testMatch: ['<rootDir>/src/**/__tests__/**']`
- npm tarball — package.json `files` allowlist (archive/ not listed) + `.npmignore`
- iOS podspec — `source_files` globs `ios/**` / `cpp/**` (archive/ is outside)
- Android — Gradle compiles only `android/src/main/java`; CMakeLists lists only the kept cpp sources (archive/ is outside both)

Imports inside these files still point at their original (pre-move) relative
paths, so they will need path fixes when resurrected.

Layout mirrors the original source tree:
- `archive/src/stitching/` — host-worklet/frame-stream hooks + live preview (P1)
- `archive/ios/` — hybrid + slit-scan engines, worklet JSI, pose-driven stitch (P2)
- `archive/android/` — Android live engines: `IncrementalFirstwinsEngine.kt`
  (firstwins/slit) + `IncrementalEngine.kt` (hybrid engine + live auto-refine +
  frame-outcome data classes, extracted from `IncrementalStitcher.kt`); worklet
  runtime (`StitcherWorkletRuntime.kt`, `StitcherJsiInstallerModule.kt`,
  `stitcher_jsi_install_jni.cpp`) (P3)
- `archive/cpp/` — shared `__stitcherProxy` worklet/JSI C++ cluster
  (`stitcher_frame_jsi`, `stitcher_proxy_jsi`, `stitcher_worklet_dispatch`,
  `stitcher_worklet_registry`) — both platforms (P3)

Full keep/archive map + restoration notes:
`docs/plans/2026-06-02-batch-keyframe-cleanup.md`.
