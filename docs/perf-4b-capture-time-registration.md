# Perf 4b — Capture-Time Registration (feature sidecars + manual-pipeline finalize)

**Status:** spec — awaiting approval. Implementation gated on Phase 0 (telemetry)
and Phase 1 (revert/config cleanup) landing first; see §9.
**Branch context:** written against `fix/RN0.79.X_optimize_process_time` @ `7df2dba`
(base `f87ab91` = v0.22.0). Every `file:line` below was verified against that tree
on 2026-08-03; if the code moves, re-verify before implementing.
**Flag:** `useCaptureTimeRegistration` — **default OFF**. This spec cannot ship as
a default flip without the full output-parity gate in §7.

---

## 1. Summary

Move ORB feature detection for the batch-keyframe stitch from finalize time to
capture time. At each keyframe **commit** (both commit sites), a serial background
task decodes the just-written `keyframe-N.jpg`, computes
`cv::detail::ImageFeatures` at a fixed registration scale, and serializes them to
a platform-neutral binary sidecar (`keyframe-N.orbf`) beside the JPEG. At
finalize, Android routes to the **manual `cv::detail::*` pipeline**
(`stitchFramePathsManual`, `cpp/stitcher.cpp:1495`) extended to accept preloaded
features, skipping its feature step and using its prune-granularity retry — which
the repo's own header measures as 5-10× cheaper than re-running the whole
registration (`cpp/stitcher.hpp:201-205`).

Expected wins (**all estimated** — to be validated against the Phase 0 `timings`
block, §7.4):

- Happy path: 10-30% of `stitchWallMs` (skipped feature detect + the manual
  path's cheap prune retry replacing the high-level per-attempt full
  re-registration).
- Ladder-walking captures (ones that today reach high-level retry attempts 2/3,
  which re-register everything at raised 1.0/1.3 MP —
  `cpp/stitcher.cpp:952-957`): up to ~3×.

The hard part is not the sidecar — it is that **the manual and high-level
pipelines produce different output pixels** (§4.5). That makes this spec a
pipeline flip wearing a perf hat, and it is gated accordingly.

---

## 2. Motivation

The adversarial review of `7df2dba` established that the commit's finalize-time
"optimizations" (AR render pause, low-RAM resolution cuts, reject throttling)
either traded output quality for time or were placebo, and are being removed
(Phase 1). The structural observation that survives the review:

1. **All registration work is deferred to finalize.** The capture phase has idle
   headroom (the serial `workScope` at `IncrementalStitcher.kt:323` is unused
   between commits — its only `launch` sites are finalize `:853` and cancel
   cleanup `:1054`), while finalize serializes decode → feature-detect → match →
   BA → warp → seam → blend into one multi-second block the operator stares at.

2. **The high-level retry ladder is structurally wasteful.** `cv::Stitcher` is a
   black box: each of the up-to-3 attempts (`cpp/stitcher.cpp:952-1065`) plus the
   best-attempt recovery pass (`:1087-1129`) re-runs `estimateTransform()` —
   feature detection included — from scratch, at *raised* registration resolution
   on attempts 2/3. The manual pipeline already in this file retries at **prune
   granularity**: `leaveBiggestComponent` re-runs against restored backups while
   features and matches are computed once (`cpp/stitcher.cpp:1996-2098`). The
   structural fix for ladder cost is routing to the pipeline whose retry loop was
   designed for it — not shaving the ladder.

3. **Keyframes are immutable after commit.** Once a keyframe JPEG lands on disk
   it is never rewritten (fresh per-session UUID dir at
   `IncrementalStitcher.kt:448-451`; monotonic `keyframe-N.jpg` naming at
   `:1312-1314` and `:1531-1533`). Features derived from it are therefore
   cacheable at commit time with a simple staleness story.

This spec is the "no band-aids" version of finalize acceleration: it moves work
to where the idle time is and routes to the retry structure that does not repeat
work, instead of degrading resolution or starving other threads.

---

## 3. Current state (verified)

### 3.1 Pipelines and routing

- Both platforms call the shared `retailens::stitchFramePaths`
  (`cpp/stitcher.cpp:579`), which dispatches on
  `StitchConfig::useManualPipeline` (`cpp/stitcher.hpp:216`, default `false`) in
  `stitchFramePathsImpl_` (`cpp/stitcher.cpp:741`).
- **Android finalize is high-level**: `IncrementalStitcher.kt:936` passes
  `useManualPipeline = false` ("high level across the board"), `stitchMode =
  "panorama"` always (`:935`; `stitchModeResolved` is dev-readout only,
  `:813-817`). Call chain: `finalize()` → `workScope.launch` (`:853`) →
  `BatchStitcher.stitchSync` (`BatchStitcher.kt:849-880`) →
  `nativeStitchFramePaths` (JNI, `image_stitcher_jni.cpp:131-147`, 13 params) →
  shared C++.
- **iOS finalize is also high-level** (`IncrementalStitcher.swift:1656-1657`:
  `stitchMode: "panorama", useManualPipeline: false`) through the same shared
  C++ via `OpenCVStitcher.mm:426-510`. *Correction to the tasking brief: iOS no
  longer has a separate stitch core — `OpenCVStitcher.mm` is a bridge into
  `cpp/stitcher.cpp`. What is iOS-separate is keyframe collection
  (`OpenCVKeyframeCollector`, native-resolution keyframes, no clamp — see the
  platform-split note at `cpp/stitcher.cpp:1658-1665`) and Swift orchestration.*
- Historical context: the manual pipeline previously WON an on-device A/B and
  both platforms unified on it (`docs/stitch-pipeline-architecture.md` §7
  Outcome, 2026-06-07), then commit `aa6c4e4` (2026-06-16, "high-level
  cv::Stitcher as the default pipeline + memory hardening") flipped both back.
  The arch doc's §7 is stale relative to this branch. The manual pipeline is
  alive, maintained, and reachable today via `refinePanorama`
  (`IncrementalStitcher.kt:2036-2037`, `:2076-2095`).

### 3.2 Keyframe commit sites (the hook points)

- **Immediate-commit path** (gate accept, window disabled or K==1):
  `IncrementalStitcher.kt:1293-1327`. Path minted at `:1312-1314`
  (`keyframe-${batchKeyframePaths.size}.jpg` in `captureSessionDir`), JPEG
  encode+write via the `onAccept` lambda at `:1315` (synchronous on the
  producer thread, 30-50 ms per accept — docstring `:1630-1632`), path appended
  at `:1327`.
- **Sharpness-window commit**: `commitSharpnessWindowLocked`
  (`IncrementalStitcher.kt:1512-1589`). Candidates are buffered **in RAM** and
  the single JPEG encode happens at commit (`:1538-1544`,
  `YuvImageConverter.encodeJpegFromNV21`); path appended at `:1562`. A window
  *replace* (`:1478-1493`) swaps the RAM buffer only — **no file exists for a
  replaced candidate**. Finalize drains an open window synchronously on the
  bridge thread *before* dispatching the stitch (`:758-761`, then
  `workScope.launch` at `:853`).
- Session lifecycle: fresh UUID dir per `start()` (`:448-451`); `cancel()`
  deletes it recursively on `workScope` (`:1036-1056`); successful finalize
  **keeps** it (for `refinePanorama`); `cleanupKeyframes` age-gates whole
  session dirs with `walkTopDown` (`:1894-1917`).

### 3.3 Keyframe bytes vs. what finalize actually decodes

- Android keyframes: NV21 → `YuvImage.compressToJpeg` (q=70 default) → optional
  decode/rescale/re-encode to the 640 px long-edge clamp
  (`YuvImageConverter.kt:22`, `:271-292`; 1280 px when the session opts into
  `keyframeQualityCapture`, `:30`, `:78-85`) → **EXIF orientation tag written**
  (`:316-329`, e.g. `ROTATE_90` for portrait).
- The manual pipeline loads via `cv::imread(path)` (`cpp/stitcher.cpp:1675`),
  which applies the EXIF tag; then downscales to `REGISTRATION_MP` with
  `INTER_AREA` (`:1789-1798`) and runs `cv::ORB::create(800)` +
  `computeImageFeatures` (`:1827-1836`).
- **Consequence:** the in-RAM frame available at commit time (unrotated NV21,
  pre-JPEG) is *not* the image finalize registers on. JPEG round-trip is lossy,
  the clamp path re-encodes, and EXIF rotation changes geometry. See §4.2.

### 3.4 Manual-pipeline facts a preload must respect

- PANORAMA-only: `stitchFramePathsImpl_:741` routes
  `useManualPipeline && stitchMode==Scans` to the high-level affine path.
- Frame cap: `kMaxFramesForStitch = 8` with evenly-spaced downsample
  (`cpp/stitcher.cpp:1641-1655`). Default `keyframeMaxCount` is 6
  (`IncrementalStitcher.kt:452-453`), so the cap doesn't bite by default — but
  it is host-configurable.
- Defaults: `REGISTRATION_MP = 0.3` / `COMPOSE_MP = 0.6` when config sentinels
  are negative (`:1767-1778`); caller override wins.
- Prune ladder (PANORAMA): thresholds 1.0 → 0.5; the 0.3 floor is deliberately
  skipped (`:2019-2021`). Restore-from-backup between attempts (`:1999-2031`).
- Exposure compensation exists (GAIN_BLOCKS, BATCH route only —
  `:3032-3062`); the STREAM route stays uncompensated.
- Wrapper-level fallbacks: manual gets opposite-mode retry (`:701-716`) plus a
  LowQualityStitch plane→spherical self-rescue (`:753-763`); high-level gets a
  spherical-warper rescue (`:681-700`).
- `cv::setNumThreads(1)` is Android-gated — single-threaded OpenCV on
  Android, multi-core on iOS. **It is a function-local `static` inside
  `stitchFramePaths` (`:602-608`)**, so it only fires once a stitch entry has
  executed; any new native entry point that touches OpenCV before the
  process's first stitch would bypass it and run on the default
  multi-threaded TBB pool. §4.2 / §6 step 2 factor it into a shared
  `ensureCvTuned()` for exactly this reason.
- Registration is **not reproducible run-to-run** (RANSAC draws from the
  thread-local RNG; multi-threaded BA has no fixed reduction order — the repo's
  own analysis at `:1079-1083`). Parity gates must not demand byte-equality of
  panoramas (§7.3).

### 3.5 Existing verification assets

- `refinePanorama` re-stitches an explicit keyframe path list with a
  caller-chosen pipeline (`IncrementalStitcher.kt:2036-2037`, `:2076-2095`, on
  `refineScope` `:343-345`) — a ready-made on-device dual-pipeline A/B harness
  over frozen keyframes. Three verified footguns the §7.3 harness config must
  neutralize: (a) it collapses `stitchMode 'auto' → 'scans'` (`:2075`), and
  the dispatcher guard routes manual+SCANS to the high-level affine path
  (`cpp/stitcher.cpp:741`) — a harness omitting explicit
  `stitchMode:'panorama'` silently compares high-level vs high-level; (b) its
  default `warperType` is `"spherical"` (`:2021`) while real finalize passes
  the tree-chosen `pickHighLevelWarper` result (`:822`, `:928`); (c) it
  passes **no resolution budgets** to `stitchSync`, silently inheriting that
  function's defaults (`registrationResolMP=-1.0`,
  `seamEstimationResolMP=-1.0`, `compositingResolMP=1.0` —
  `BatchStitcher.kt:863-865`).
- SSIM gate methodology + script already exist
  (`docs/phase-7-parity-gate.md`, `scripts/ssim-compare.py`).
- Host gtest suite for shared C++ (`cpp/tests/`, `scripts/run-cpp-tests.sh`)
  with a minimal host OpenCV (core+imgproc today — §6 step 1 extends it).
- Vendored OpenCV is 4.10.0 (`scripts/opencv-version.txt`).

---

## 4. Design

### 4.1 Overview

```
capture:                                   finalize (flag ON):
  gate accept → keyframe-N.jpg committed     stitchSync(useManualPipeline=true,
       │  (either commit site, §3.2)                    preloadFeatureSidecars=true,
       ▼                                                registrationResolMP=<pinned>,
  workScope.launch (serial, FIFO)                       compositingResolMP=1.0)
       │                                        │
       ▼                                        ▼
  nativeComputeFeatureSidecar(jpg)         stitchFramePathsManual step 1:
    ensureCvTuned()  [Android: 1 thread]     for each frame:
    imread → EXIF applied                      sidecar valid?  → deserialize
    → INTER_AREA to work_scale                 missing/stale/  → imread+resize+ORB
      (from the frame's OWN dims, §4.2)          corrupt          (per-frame fallback)
    → ORB(800) + computeImageFeatures        steps 2-10 unchanged
    → serialize → tmp → atomic rename
  keyframe-N.orbf
```

FIFO ordering on the serial `workScope` guarantees every enqueued sidecar task
completes before the finalize stitch task runs (finalize launches on the same
scope at `IncrementalStitcher.kt:853`, after the synchronous drain-commit at
`:758-761` has enqueued the trailing keyframe's task). No completion tracking,
no latches.

### 4.2 What the feature task computes — decode-from-disk, not the RAM frame

**Deviation from the tasking sketch, with rationale.** The sketch says "ORB on
the already-decoded frame". Verified against the code, that would be wrong three
ways (§3.3): the RAM frame is pre-JPEG (lossy round-trip q=70, plus a second
decode/rescale/re-encode on the 640-clamp path, `YuvImageConverter.kt:271-292`),
un-rotated (finalize's `cv::imread` applies the EXIF tag written at
`:316-329`), and NV21→BGR converted by a different path than libjpeg's. Features
computed on it would silently differ from what a flag-OFF manual run computes,
making the manual-internal parity gate (§7.3) unfalsifiable.

Instead, the sidecar task **re-reads the committed JPEG through the exact
finalize chain**: `cv::imread(path)` → `INTER_AREA` resize to the pinned
registration scale → `cv::ORB::create(800)` + `computeImageFeatures` — the same
code, factored into a shared helper used by both the capture-time task and the
manual pipeline's fallback. Cost: one extra ~0.31 MP JPEG decode per keyframe,
~5-10 ms (**estimated**), on `workScope`, off the producer thread. This buys
by-construction feature equality: ORB detection is deterministic on identical
input (no RNG in detect/compute), so sidecar features are byte-identical to
what finalize would have computed — unit-gated in §7.1.

Two rules the shared helper must hard-code:

- **Thread tuning travels with the entry point.** The Android
  `cv::setNumThreads(1)` once-guard is today a function-local static inside
  `stitchFramePaths` (`cpp/stitcher.cpp:602-608`). A capture-time entry that
  skipped it would run imread/resize/ORB on OpenCV's default multi-threaded
  TBB pool from migrating `Dispatchers.Default` threads until the process's
  first stitch — re-creating, during capture and per commit, the exact
  ~7-9 MB TLS-creep condition the guard was added for (v0.16.1 comment,
  `cpp/stitcher.cpp:585-601`), plus capture-phase CPU contention. §6 step 2
  factors the guard into a shared `ensureCvTuned()` called at the top of both
  `stitchFramePaths` and `computeFeatureSidecarForFrame`. The determinism
  claim above is argued for **single-threaded** execution;
  `ensureCvTuned()` is what makes it hold on Android (multi-threaded iOS is
  a §4.9 caution, not silently assumed away). Gates: §7.2's on-device
  byte-compare doubles as the Android determinism assertion, and §7.5.7
  verifies the fresh-process RSS behaviour.
- **`work_scale` derives from the frame's own post-EXIF decoded dims.** The
  capture-time task has no future finalize frame set to consult. Finalize, by
  contrast, computes ONE `work_scale` from `frames[0]` and applies it to
  every frame (`cpp/stitcher.cpp:1782-1798`). For same-dims sessions — the
  norm, since Android clamps all keyframes identically
  (`YuvImageConverter.kt:22`) — the two agree exactly. In a mixed-dims
  session (e.g. an EXIF orientation flip mid-capture), every sidecar whose
  dims differ from the frame-0-derived expectation fails the §4.3
  `workW/workH` check and triggers per-frame recompute: safe by
  construction, visible as `sidecar.staleDims` in telemetry (§7.4), and
  exercised by the mixed-orientation corpus set (§7.3).

### 4.3 Sidecar format — custom binary, versioned, self-validating

**Decision: custom binary, not `cv::FileStorage`.** Rationale:

- `FileStorage` is text-only (XML/YAML/JSON, optionally gzipped): a 800-keypoint
  + 800×32 B descriptor payload serializes to roughly 300-500 KB of YAML
  (estimated) with multi-ms parse cost, versus ~50-60 KB raw binary (arithmetic:
  800 × 28 B keypoints + 800 × 32 B descriptors + header). Gzip narrows size but
  adds CPU and keeps the parse.
- `FileStorage`'s schema follows OpenCV's persistence module across versions;
  our own fixed layout is auditable and testable in isolation.
- Both target ABIs (Android arm64, iOS arm64) are little-endian; an endianness
  sentinel in the header hard-fails exotic hosts into the recompute path.

**Layout v1** (`keyframe-N.orbf`, all little-endian, written by shared C++ —
`cpp/feature_sidecar.{hpp,cpp}`, new):

| field | type | notes |
|---|---|---|
| magic | `u32` | `'RNIF'` — also the endianness sentinel |
| version | `u32` | `1`; loader rejects ≠ supported |
| jpegHashFnv1a64 | `u64` | FNV-1a over the JPEG file bytes |
| jpegSizeBytes | `u64` | cheap pre-hash reject |
| origW, origH | `i32×2` | decoded dims **post-EXIF** |
| workW, workH | `i32×2` | dims features were computed at |
| registrationResolMP | `f64` | budget in force when computed (§4.4) |
| orbFingerprint | `u32` | packed ORB params: nfeatures=800 + the `ORB::create` defaults (scaleFactor, nlevels, edgeThreshold, …) + OpenCV version `4.10.0` |
| keypointCount | `u32` | |
| keypoints | `{f32 x,y,size,angle,response; i32 octave,class_id}×N` | |
| descRows, descCols, descType | `i32×3` | `descType` must be `CV_8U` |
| descriptors | raw bytes | row-major |

Write protocol: serialize to `keyframe-N.orbf.tmp`, `fsync`-less `rename()` to
final name. A process death mid-write leaves only a `.tmp` the loader never
looks at; `deleteRecursively`/`walkTopDown` cleanup catches strays. Write
failure is logged and swallowed — a missing sidecar is always recoverable
(§4.6).

Load-time validation (all must pass, else per-frame recompute): magic, version,
endianness, `jpegSizeBytes` + `jpegHashFnv1a64` against the JPEG on disk,
`orbFingerprint`, and `workW/workH == ` the dims the manual pipeline is about to
produce for **that frame** from its own `work_scale` computation — i.e.
`round(origW_i × work_scale_finalize)` per frame, not a comparison against
frame 0's dims. The dims check makes a 4a-style budget change self-invalidating
even if the recorded `registrationResolMP` were ignored. Note the asymmetry
behind it: finalize's single `work_scale` comes from `frames[0]`
(`cpp/stitcher.cpp:1782-1791`) while each sidecar's came from its own frame
(§4.2), so mixed-dims sessions invalidate by design — sidecars recompute
(`sidecar.staleDims`) rather than silently registering at inconsistent scales.

### 4.4 Registration scale — pinned, and how 4a must interact

**Rule: sidecars are always computed at one FIXED default registration budget;
adaptive behaviour (spec 4a) may only vary compose.** Justification: a sidecar
computed at a different scale than finalize uses is dead weight (dims check
fails → full recompute → the feature was pure cost), and capture time cannot
know finalize-time device pressure. Compose is the memory lever anyway — in the
manual pipeline registration and compose are independent stages by design
(`cpp/stitcher.cpp:1739-1766`).

**Pinned value: `registrationResolMP = 0.3`** (the manual default,
`cpp/stitcher.cpp:1767-1768`), passed explicitly by the flag-ON finalize call
site so a future default drift can't split capture from finalize. Why 0.3 and
not the high-level path's 0.6 cv-default:

- Default Android keyframes are ~0.31 MP (640 px clamp,
  `YuvImageConverter.kt:22`), so 0.3 vs 0.6 budgets both yield
  `work_scale ≈ 1.0` — near-identical registration inputs for the default
  capture. The choice only matters for `keyframeQualityCapture` (1280 px,
  ~0.92-1.23 MP).
- 0.3 is the configuration the manual pipeline's BA behaviour was tuned and
  validated at (`cpp/stitcher.cpp:1741-1745`).
- Smaller work frames → cheaper capture-time ORB and smaller sidecars.

This is **open question #1** (§11): the parity corpus must include 1280 px
quality-capture sets, and if registration quality regresses vs. today's
high-level 0.6, the pinned constant moves to 0.6 for *both* capture and
finalize — a one-constant change the sidecar validation makes safe.

Ladder note: the high-level combined-lever ladder raises regResol to 1.0/1.3 MP
on attempts 2/3 (`cpp/stitcher.cpp:952-957`). The manual pipeline has no
resolution-escalation ladder — its retry is prune-granularity — so under
flag-ON that lever simply does not exist. If a future spec adds escalation to
the manual path, escalated attempts must recompute features at the new scale;
sidecars serve only the base attempt.

### 4.5 The parity problem — verified pipeline differences

Routing finalize from high-level to manual **changes output pixels**. Every
difference below was verified in this tree:

| dimension | high-level (today) | manual (flag ON) |
|---|---|---|
| seam cost | GraphCut `COST_COLOR_GRAD` (`cpp/stitcher.cpp:222-223`) | GraphCut `COST_COLOR`, hardcoded — ignores `seamFinderType` at the seam stage (`:2990-2992`) |
| ORB budget | cv::Stitcher default 500/frame (`:930-932`) | 800/frame (`:1827`) |
| match_conf | create() default 0.3; ladder loosens to 0.25/0.20 (`:939-957`) | 0.65 fixed (`:1885`) |
| registration MP | cv default 0.6 (post-Phase-1 `regResol=-1`); ladder raises 1.0/1.3 | pinned 0.3 (§4.4) |
| compose MP | finalize passes 1.0 post-Phase-1; RAM fallback `>=5GB?1.0:0.6` when sentinel (`:879-886`) | caller override wins (`:1777-1778`) — flag-ON passes 1.0 explicitly; manual blends at compose MP directly (different memory shape, `cpp/stitcher.hpp:153-159`) |
| retry structure | 3-attempt combined-lever ladder + best-attempt recovery (`:952-1129`) | prune-only ladder 1.0→0.5 (0.3 floor skipped, `:2019-2021`), no matcher/resolution escalation |
| frame cap | none | `kMaxFramesForStitch=8`, evenly-spaced downsample (`:1641-1655`) |
| wrapper fallback | spherical-warper rescue (`:681-700`) | plane→spherical LowQualityStitch self-rescue (`:753-763`, re-enters manual); wrapper-level opposite-mode retry (`:701-716`) — which the `:741` guard turns into a **high-level affine SCANS** stitch; replaced under `preloadFeatureSidecars` by a high-level PANORAMA rescue (§4.6) |
| exposure comp | internal to cv::Stitcher | GAIN_BLOCKS on BATCH route; STREAM route uncompensated (`:3032-3062`) |
| memory strategy | compose-all + pre-stitch headroom abort (`:911-924`) | STREAM routing + canvas-budget downscale (safer on wide pans) |

Consequences owned by this spec:

- **No default flip without the §7 gate.** `useCaptureTimeRegistration`
  defaults OFF; staged rollout in §7.5.
- **Frame-cap guard:** if `keyframePathsSnapshot.size > 8`, flag-ON finalize
  falls back to the high-level path (sidecars unused) rather than silently
  downsampling the operator's capture. Sessions *configured* with
  `keyframeMaxCount > 8` (host-configurable, `IncrementalStitcher.kt:452-453`)
  additionally skip sidecar enqueueing entirely at `start()` (§6 step 5) —
  otherwise every commit would pay capture-time cost for sidecars this
  fallback guarantees are never used; the finalize-time guard remains as the
  backstop. Structural fix behind the cap is BA instability on >~10 landscape
  frames (`:1629-1640`) — lifting it is open question #2, not smuggled in
  here.
- **PANORAMA-only is compatible today**: this branch's finalize always passes
  `"panorama"` (`IncrementalStitcher.kt:935`); the `:741` guard protects any
  future SCANS routing by falling back to high-level (sidecars unused, not
  wrong).

### 4.6 Fallback ladder (never fail a stitch because of a sidecar)

Per frame, in `stitchFramePathsManual` step 1 when
`config.preloadFeatureSidecars` is true:

1. Sidecar exists and validates (§4.3) → deserialize into `imgFeatures[i]`
   (set `img_idx`, `img_size` from `workW/workH`).
2. Anything else — missing, magic/version/endian mismatch, hash mismatch, dims
   mismatch, fingerprint mismatch, truncated read → compute features for that
   frame exactly as today (`:1827-1836`), count it, continue.

Mixed loaded/recomputed sets are valid — `ImageFeatures` are per-frame
independent. The stitch result's telemetry reports
`sidecar{loaded,staleHash,staleDims,missing,corrupt}` counts (§7.4).

**Failure-rescue routing under the flag (a decision, not an accident).** The
wrapper-level fallbacks do NOT all re-enter the manual pipeline — verified:
only the LowQualityStitch plane→spherical self-rescue (`:753-763`) re-enters
`stitchFramePathsManual` (and re-loads the sidecars — cheap, correct). The
wrapper's manual-caller retry (`:702-716`) flips to the OPPOSITE mode: a
manual-PANORAMA retryable failure retries SCANS, and the `:741` guard routes
manual+SCANS to the **high-level affine** path — a different pipeline, no
sidecars, different output geometry. Left as-is, flag-ON would silently change
failure-rescue behaviour from today's high-level spherical-PANORAMA rescue
(`:681-700`) to an affine SCANS stitch, precisely on the marginal captures a
success-oriented parity corpus never exercises.

Decision: **when `config.preloadFeatureSidecars` is true, the wrapper
suppresses the opposite-mode SCANS retry** and instead rescues with the full
**high-level PANORAMA** path (`useManualPipeline=false`, same warper),
including its spherical-warper second chance when the warper isn't already
spherical (the `:681-700` logic). The flag-ON terminal fallback is therefore
the flag-OFF pipeline itself — worst-case failure behaviour converges with
today's instead of diverging into affine. The manual plane→spherical
self-rescue (`:753-763`) is retained unchanged (it fires inside the impl,
before the wrapper fallback, and stays within manual). The preserved
opposite-mode retry is untouched for manual callers that don't set the new
flag — the iOS pre-Phase-2 no-regression it exists for (`:651-655`). §7.3's
corpus includes known-marginal sets that exercise the rescue path under both
flags and asserts the flag-ON arm never terminates in affine SCANS.

### 4.7 Interaction with spec 3b (range matcher)

Features are matcher-independent: `ImageFeatures` (keypoints + descriptors)
feed `BestOf2NearestMatcher` today (`cpp/stitcher.cpp:1885`) and would feed a
`BestOf2NearestRangeMatcher` identically. Matching still happens at finalize;
the sidecar encodes nothing about the matcher. If 3b lands first or later, the
only shared obligation is re-running the §7 parity corpus with the combined
configuration before any default flip.

### 4.8 Memory and cleanup

- Sidecars live on disk (~50-60 KB × ≤ `keyframeMaxCount`; ≤ ~0.5 MB/session).
  Finalize deserializes into the same `imgFeatures` vector that exists today —
  no new steady-state RAM.
- Cancel: sidecars are inside `captureSessionDir`, deleted by the existing
  recursive cleanup (`IncrementalStitcher.kt:1054-1056`). FIFO on `workScope`
  means queued sidecar tasks run before the deletion task — they write into a
  dir that is then deleted; wasted ~30-50 ms, harmless. The task itself checks
  the JPEG still exists and no-ops otherwise.
- Age-based cleanup: `cleanupKeyframes` already sums and deletes whole session
  dirs (`:1894-1917`) — sidecars covered with zero changes.
- Successful finalize keeps the session dir (`:1030-1035` comment), so
  `refinePanorama` with `useManualPipeline:true` + preload can reuse the
  sidecars. Budget consistency for refine does **not** fall out for free:
  refine today passes no resolution budgets to `stitchSync` and silently
  inherits its defaults (`registrationResolMP=-1.0` → manual 0.3,
  `compositingResolMP=1.0` — `BatchStitcher.kt:863-865`), which match the
  flag-ON finalize budgets only by coincidence of those defaults. §5
  therefore extends refine's config map with explicit `registrationResolMP` /
  `compositingResolMP` (defaulting to the current `stitchSync` values so
  absent keys stay byte-identical to today), and the §7.3 harness always
  passes them explicitly.

### 4.9 iOS (spec-only here; implementation out of scope)

The sidecar reader/writer and the manual-pipeline preload live entirely in
shared C++, so iOS adoption is: (a) call the same
`computeFeatureSidecarForFrame` from `OpenCVKeyframeCollector`'s commit path on
its serial queue; (b) flip its finalize routing the same way. Two iOS-specific
cautions to spec now: iOS keyframes are **native capture resolution** (no clamp
— `cpp/stitcher.cpp:1658-1665`), so capture-time decode+ORB is ~30-80 ms/frame
(**estimated**) and `work_scale ≪ 1`; and iOS runs OpenCV multi-threaded
(`:595-608`, GCD backend) — the §4.2 determinism argument is made for
single-threaded execution and does **not** transfer; whether ORB
detect/compute stays deterministic under the GCD parallel backend must be
established by running the §7.1 determinism guard and the §7.2 byte-compare
on iOS before adoption. The format itself carries no platform assumptions
(§4.3).

---

## 5. API / config surface changes

- **TS (`src/stitching/incremental.ts` types + start/finalize plumbing):**
  `config.useCaptureTimeRegistration?: boolean` (default `false`). Documented
  as: "computes registration features during capture and finalizes via the
  manual cv::detail pipeline; output pixels may differ from the default
  pipeline — see docs/perf-4b-capture-time-registration.md".
- **Kotlin `IncrementalStitcher`:** new session flag read from `config` at
  `start()` (near `:452-469`); flag-ON `start()` additionally (a) calls
  `BatchStitcher.ensureNativeStitcher()` once, so the first commit-site hook
  in a fresh process cannot hit `UnsatisfiedLinkError` — the JNI shim is
  otherwise lazy-loaded only at stitch time (`BatchStitcher.kt:879`,
  `:907-921`) — and (b) computes `sidecarsEnabled = keyframeMaxCount <= 8`
  (§4.5). Commit-site hooks (§6 step 5); finalize routing (§6 step 6).
  `refinePanorama` already passes `useManualPipeline` through (`:2036-2037`)
  — it additionally learns `preloadFeatureSidecars`, `registrationResolMP`,
  and `compositingResolMP` from its config map (defaults `false` / `-1.0` /
  `1.0`, i.e. exactly the `stitchSync` defaults it silently inherits today,
  `BatchStitcher.kt:863-865`, so absent keys remain byte-identical) — this
  is what lets the §7.3 harness pin both arms' budgets explicitly.
- **Kotlin `BatchStitcher.stitchSync`:** new parameter
  `preloadFeatureSidecars: Boolean = false` (`BatchStitcher.kt:849-880`).
- **JNI:** `nativeStitchFramePaths` gains one trailing `jboolean`
  (`image_stitcher_jni.cpp:131-147`); new
  `nativeComputeFeatureSidecar(framePath, registrationResolMP): jboolean`.
- **C++ (`cpp/stitcher.hpp`):** `StitchConfig::preloadFeatureSidecars = false`;
  new `cpp/feature_sidecar.{hpp,cpp}` exposing
  `writeFeatureSidecarForFrame(...)` / `loadFeatureSidecar(...)` and the shared
  decode→resize→ORB helper; the Android-gated `cv::setNumThreads(1)`
  once-guard factored out of `stitchFramePaths` into a shared
  `ensureCvTuned()` called by both entries (§4.2, §6 step 2); wrapper
  fallback routing keyed on `preloadFeatureSidecars` (§4.6).
- Sidecar path convention: `<framePath minus .jpg> + ".orbf"` — derived, never
  marshalled, so `refinePanorama`'s JS-supplied path lists work unchanged.
- **No changes** to the high-level path, to `stitchFramePaths`' public
  signature, or to any default behaviour while the flag is OFF. Flag OFF must
  be **byte-identical** in behaviour to today (no sidecar tasks enqueued, no
  extra I/O) — that is a review gate, not an aspiration.

---

## 6. Implementation plan (ordered; Android + shared C++)

1. **Shared C++ sidecar module + tests.** New `cpp/feature_sidecar.{hpp,cpp}`
   (serializer, loader, FNV-1a64, validation, ORB fingerprint). Extend the host
   gtest OpenCV build to include `features2d` (touches
   `scripts/run-cpp-tests.sh` comment block + `cpp/tests/CMakeLists.txt`); add
   `cpp/tests/feature_sidecar_test.cpp` (§7.1 cases).
   *Files:* `cpp/feature_sidecar.hpp`, `cpp/feature_sidecar.cpp`,
   `cpp/tests/feature_sidecar_test.cpp`, `cpp/tests/CMakeLists.txt`,
   `scripts/run-cpp-tests.sh`.
2. **Shared compute entry + thread-tuning factor-out.** First extract the
   Android-gated `cv::setNumThreads(1)` once-guard from `stitchFramePaths`
   (`cpp/stitcher.cpp:602-608`) into a shared `ensureCvTuned()` (function-local
   static preserved; called at the top of both `stitchFramePaths` and the new
   entry — flag-OFF behaviour stays byte-identical, it's the same guard from a
   new call site). Without this, the capture-time entry would run OpenCV
   multi-threaded on migrating `Dispatchers.Default` threads until the
   process's first stitch — re-creating the v0.16.1 TLS creep during capture
   (§4.2). Then `computeFeatureSidecarForFrame(framePath, registrationResolMP,
   logFn)`: `ensureCvTuned()` → `cv::imread` → `work_scale` from the frame's
   own post-EXIF dims (same formula as `cpp/stitcher.cpp:1789-1791`; §4.2
   rule) → `INTER_AREA` resize → shared ORB helper → atomic write. Refactor
   the manual pipeline's step-1 body (`:1824-1836`) to call the same ORB
   helper so capture and finalize cannot drift.
   *Files:* `cpp/feature_sidecar.cpp`, `cpp/stitcher.cpp`.
3. **Manual-pipeline preload + wrapper rescue routing.** In
   `stitchFramePathsManual` step 1: per-frame load-or-compute per §4.6;
   populate telemetry counters into `StitchResult` (+ `debugSummary` keys,
   joining the existing `pipe=/warp=/...` format, `cpp/stitcher.hpp:264-271`).
   In the `stitchFramePaths` wrapper: implement the §4.6 flag-ON rescue —
   when `config.preloadFeatureSidecars` and the manual attempt fails
   retryably, suppress the opposite-mode SCANS retry (`:702-716`) and rescue
   via high-level PANORAMA (same warper, then spherical second chance per
   `:681-700`); manual callers without the flag keep today's behaviour.
   *Files:* `cpp/stitcher.cpp`, `cpp/stitcher.hpp`.
4. **JNI + Kotlin bridge.** New extern + param per §5; thread the flag through
   `stitchSync`.
   *Files:* `android/src/main/cpp/image_stitcher_jni.cpp`,
   `android/src/main/java/io/imagestitcher/rn/BatchStitcher.kt`.
5. **Commit-site hooks + start()-time guards.** At `start()`, when the flag
   is on: call `BatchStitcher.ensureNativeStitcher()` (load guard — the JNI
   shim is otherwise first loaded at stitch time, `BatchStitcher.kt:879`,
   `:907-921`; without it the first hook in a fresh process throws
   `UnsatisfiedLinkError`), and set `sidecarsEnabled = keyframeMaxCount <= 8`,
   logging the skip reason when false (§4.5 — the >8 finalize fallback means
   those sidecars would be pure capture-time cost). Then, after
   `batchKeyframePaths.add(...)` at both commit sites
   (`IncrementalStitcher.kt:1327` and `:1562`), when `sidecarsEnabled`:
   `workScope.launch { nativeComputeFeatureSidecar(path, PINNED_REG_MP) }`
   with an exists-check and a caught-and-logged failure path (any
   `Throwable`, including a load-guard miss, degrades to no-sidecar — never a
   crash, never a failed capture). Emit a capture-side timing marker (Phase 0
   JS markers) per task.
   *Files:* `android/src/main/java/io/imagestitcher/rn/IncrementalStitcher.kt`.
6. **Finalize routing.** In the flag-ON branch of `finalize()` (replacing
   nothing in the flag-OFF branch): guard `keyframePathsSnapshot.size <= 8`
   (else log + fall back to high-level), then `stitchSync(...,
   registrationResolMP = 0.3, compositingResolMP = 1.0, stitchMode =
   "panorama", useManualPipeline = true, preloadFeatureSidecars = true)`.
   `refinePanorama` passthrough. **Sequenced after Phase 1's edits to the same
   call site** (`:894-937`) to avoid textual and semantic conflicts.
   *Files:* `android/src/main/java/io/imagestitcher/rn/IncrementalStitcher.kt`.
7. **TS surface.** Config type + plumbing + docs.
   *Files:* `src/stitching/incremental.ts`, `src/stitching/types` (as
   structured today), README/docs touch-ups.
8. **Parity corpus + gate run + device verify** (§7), then staged rollout
   (§7.5).

iOS: no implementation steps in this spec (§4.9, §10).

---

## 7. Verification & gates

### 7.1 Unit (host gtests, step-1 deliverable)

- Round-trip: serialize → load → keypoints and descriptors byte-identical.
- Rejection matrix: truncated file, bad magic, wrong version, wrong endianness
  sentinel, hash mismatch (JPEG mutated), dims mismatch, fingerprint mismatch —
  each returns "invalid", never throws across the boundary.
- Atomicity: loader ignores `.tmp` files.
- **Determinism guard:** `computeImageFeatures` twice on the same Mat →
  identical output (protects the §4.2 by-construction-equality claim against
  OpenCV upgrades; runs in CI so a vendored-OpenCV bump that breaks it is
  caught before devices are).

### 7.2 Feature-equality gate (device, debug builds)

Debug-only path: at finalize, for each *loaded* sidecar also recompute and
byte-compare; log mismatches. Expected: zero. This isolates "capture-time
features are wrong" from "the manual pipeline differs" — without it, a parity
failure is unattributable. On Android this gate doubles as the **on-device
single-threaded-determinism assertion** behind §4.2's by-construction claim:
with `ensureCvTuned()` in force in both entries, a nonzero mismatch count
means either the thread-pinning guard regressed (multi-threaded ORB) or the
compute paths drifted — both hard failures, not noise.

### 7.3 Output-parity gates (the shipping gates)

Frozen-corpus method per `docs/phase-7-parity-gate.md` /
`scripts/ssim-compare.py`, but replayed **on-device from frozen keyframe sets**
via `refinePanorama` (`IncrementalStitcher.kt:2076-2095`) so both pipelines see
byte-identical inputs in one build — no double physical capture.

**The harness config is load-bearing** — refine's defaults do not reproduce
finalize (§3.5 footguns): `'auto'` collapses to `'scans'` (`:2075`) and
manual+SCANS routes to high-level affine (`cpp/stitcher.cpp:741`), so a
harness omitting explicit `stitchMode:'panorama'` compares high-level against
high-level and Gates A/B pass vacuously; refine's default warper is
`"spherical"` (`:2021`) while real flag-OFF finalize passes the tree-chosen
`pickHighLevelWarper` result (`:822`, `:928`); and refine passes no budgets,
inheriting `stitchSync` defaults (`BatchStitcher.kt:863-865`). Every gate run
therefore pins the full config per arm, using the §5 refine config-map
extension. Each corpus set records, from its originating session's Phase 0
telemetry, the finalize-chosen `warperType` and `captureOrientation` (plus
`blenderType`/`seamFinderType`, defaults `multiband`/`graphcut` matching
finalize's) and replays them into **both** arms:

| config key | Gate A arm 1 (preload) | Gate A arm 2 (recompute) | Gate B arm 1 (flag-OFF replica) | Gate B arm 2 (flag-ON replica) |
|---|---|---|---|---|
| `stitchMode` | `"panorama"` explicit | `"panorama"` explicit | `"panorama"` explicit | `"panorama"` explicit |
| `useManualPipeline` | `true` | `true` | `false` | `true` |
| `preloadFeatureSidecars` | `true` | `false` | `false` | `true` |
| `warperType` | recorded per set | recorded per set | recorded per set (`pickHighLevelWarper` output) | recorded per set |
| `captureOrientation` | recorded per set | recorded per set | recorded per set | recorded per set |
| `registrationResolMP` | `0.3` (pinned, §4.4) | `0.3` | `-1.0` (cv default ≈0.6 — post-Phase-1 finalize) | `0.3` |
| `compositingResolMP` | `1.0` | `1.0` | `1.0` | `1.0` |

A harness run that omits any row is invalid — rerun it, don't reinterpret it.

Corpus (minimum 20 sets, pulled from real sessions): default 640 px and
1280 px quality captures; 3/6/8/12 keyframes (12 exercises the >8 fallback
guard); 1x and 0.5x lens; portrait + landscape; low-texture walls; **at least
one mixed-orientation set** (EXIF flip mid-capture — exercises the §4.2/§4.3
`staleDims` recompute path and its telemetry); **at least two known-marginal
sets** that today trigger a wrapper-level rescue (identified from Phase 0
telemetry: `stitchModeUsed` + fallback log lines — these exercise the §4.6
flag-ON rescue routing under both flags); and captures that historically
walked the high-level ladder to attempts 2/3.

- **Gate A — manual-internal (preload vs recompute):** same pipeline, sidecars
  on vs off. `framesIncluded` identical on every set. The SSIM threshold is
  **calibrated per set against the run-to-run null distribution, not fixed**:
  registration is not reproducible run-to-run (`cpp/stitcher.cpp:1079-1083`),
  so any fixed floor (e.g. 0.99) produces unattributable failures on
  hard/low-texture sets where two *identical-config* runs also dip. Per set:
  run arm 2 (recompute) N=3 times → the 3 pairwise same-config SSIMs are the
  null distribution; pass iff `SSIM(arm1, arm2) ≥ min(null SSIMs)`. Record
  both numbers. A preload-vs-recompute SSIM below the same-config floor means
  the preload changed registration inputs → bug, full stop — and §7.2's
  byte-compare attributes it (features wrong vs downstream RANSAC variance).
  Sets where either arm exits via a wrapper-level rescue are excluded from
  the Gate A comparison (the rescue routing intentionally differs by flag,
  §4.6) and evaluated under Gate B's marginal-set criteria instead.
- **Gate B — pipeline flip (high-level flag-OFF vs manual flag-ON):** different
  pipelines legitimately differ, so cross-pipeline SSIM is recorded but not
  pass/fail. Pass criteria: `framesIncluded(manual) ≥ framesIncluded(high)` on
  ≥ 90% of sets and never worse by > 1 frame; no set that succeeds today may
  fail; on the known-marginal sets, the rescue actually taken is logged per
  arm (`debugSummary` pipe/route keys + `stitchModeUsed` + fallback logs) and
  the flag-ON arm must terminate in the §4.6 high-level PANORAMA rescue —
  never affine SCANS; output dims within ±15%; `validateStitchOutput`
  (`cpp/stitcher.cpp:355`) passes; side-by-side visual review signed off by
  the operator (per the "gate the deliverable" standing directive).

### 7.4 Perf gate — Phase 0 telemetry (hard dependency)

All §1 numbers are **estimated** until measured through Phase 0's finalize
`timings` block. Fields consumed: `queueDelayMs`, `stitchWallMs`, per-cv-phase
ms (specifically the feature-detect and registration-retry phases), keyframe
count + dims, budgets applied, arch fingerprint. Fields this spec **adds**:
`pipelineUsed` (`highlevel|manual`),
`sidecar{loaded,staleHash,staleDims,missing,corrupt}`, `captureFeatureMs`
(capture-side marker per task, JS), `sidecarBytesTotal`. Acceptance: happy-path
`stitchWallMs` reduction ≥ 10% median on the corpus devices; ladder-walking
sets ≥ 2×; `sidecar.loaded / total ≥ 0.95` in normal operation (a lower hit
rate means the pipeline is paying sidecar cost for nothing — investigate before
rollout).

### 7.5 On-device verify points (native code — cannot be host-tested)

1. Sidecars appear for both commit paths (immediate + window), including the
   finalize drain-commit's trailing keyframe.
2. Kill-test: force-stop mid-capture → only `.tmp` strays, next session
   unaffected, loader never accepts a partial file.
3. Cancel + `cleanupKeyframes` remove sidecars (dir listing before/after).
4. `>8` keyframes with flag ON → high-level fallback taken, logged.
5. Memory: `memPeakMB` (existing profiling record, `cpp/stitcher.hpp:273-289`)
   flag-ON vs flag-OFF within noise; no capture-phase RSS growth.
6. Thermal/CPU: capture-phase frame pacing unchanged with the flag on
   (sidecar tasks are on `workScope`, not the producer thread — verify no
   regression in accept latency, which stays 30-50 ms per `:1630-1632`).
7. Fresh-process TLS guard: on a process with **no prior stitch**, capture
   with the flag on for ≥20 commits — capture-phase RSS stays flat (no
   ~7-9 MB/commit native-heap creep). This proves `ensureCvTuned()` fires in
   the sidecar entry before any OpenCV work; the guard was previously only
   reachable via `stitchFramePaths` (`cpp/stitcher.cpp:602-608`), so a fresh
   process is the only state that can expose a bypass.

Staged rollout after gates: (1) flag ON in the example app + internal use;
(2) flag ON default in a **minor** release with changelog calling out the
output-pixel change and the one-line opt-out; (3) high-level path retained
indefinitely as the `>8`-keyframe fallback and the flag-OFF escape hatch.

---

## 8. Risks & mitigations

Every mitigation names its structural fix per house rules.

- **Pipeline flip changes output pixels.** Mitigation: default-OFF flag + Gate
  B + staged rollout. *Structural fix:* there should be one pipeline, chosen on
  evidence — this spec's gate IS the evidence-gathering; the end state
  (open question #3) is deleting one path, not maintaining both forever.
- **Manual 8-frame cap silently degrades big captures.** Mitigation: automatic
  high-level fallback at `>8` (§4.5). *Structural fix:* re-measure the V12.14
  BA-instability cap (`cpp/stitcher.cpp:1629-1640`) on current OpenCV/devices —
  open question #2 — rather than inheriting it blind.
- **Sidecar/JPEG divergence (the stale-cache class).** Mitigation: content hash
  + dims + fingerprint validation, per-frame recompute fallback (§4.3, §4.6).
  *Structural fix:* single shared compute helper (§6 step 2) so there is no
  second implementation to drift; hash check makes any residual drift loud in
  telemetry (`sidecar.staleHash`).
- **New native entry bypasses the Android thread-pinning guard.** The
  `cv::setNumThreads(1)` once-guard lives inside `stitchFramePaths`
  (`cpp/stitcher.cpp:602-608`); a sidecar entry that skipped it would
  re-create the v0.16.1 TLS creep *during capture* and void the Android
  determinism argument (§4.2). Mitigation: shared `ensureCvTuned()` called by
  both entries (§6 step 2) + §7.5.7 fresh-process RSS verify + §7.2 mismatch
  counter. *Structural fix:* one process-wide tuning helper instead of
  per-entry copies — there is no second guard to forget.
- **OpenCV upgrade changes ORB output.** Mitigation: fingerprint includes the
  OpenCV version; CI determinism test (§7.1). Sidecars self-invalidate on
  upgrade → recompute path, correctness preserved at the cost of one slow
  finalize.
- **Capture-time CPU on low-end devices.** ~25-50 ms/commit (**estimated**) on
  the otherwise-idle serial `workScope`, commits ≤ ~1-2/s. Verified via §7.5.6
  and the `captureFeatureMs` marker. If it measurably harms capture, the
  fallback is automatic by design (skip enqueueing under load — the finalize
  recompute path is always there); *structural fix* is that the fallback ladder
  makes the optimization strictly optional at every frame.
- **Concurrent lifecycle races (cancel/finalize/refine).** Mitigation: all
  writes on the serial `workScope` FIFO (§4.1, §4.8); sidecars are
  write-once + atomic-rename; `refinePanorama` reads finalized sessions on a
  different scope with no writer active. No new locks introduced —
  *structurally*, the design adds zero shared mutable state (disk artifacts +
  existing queues only).
- **Phase 1 edits the same finalize call site.** Mitigation: hard sequencing
  (§9); step 6 lands after Phase 1.

---

## 9. Dependencies & sequencing

- **Phase 0 (telemetry) — hard dependency for verification.** §7.4's gates are
  defined in terms of its `timings` fields; the ladder-walking corpus is
  selected from its data. Implementation steps 1-5 can proceed in parallel;
  gate runs cannot.
- **Phase 1 (revert/cleanup) — sequencing dependency.** It rewrites the same
  finalize block this spec routes (`IncrementalStitcher.kt:894-937`, removing
  the adaptive-resolution block; restoring `regResol=-1/compose=1.0`). Step 6
  assumes Phase 1's end state and lands after it.
- **Spec 3b (range matcher)** — orthogonal (§4.7); combined-config parity rerun
  required before either flips a default that the other's gate baselined.
- **Spec 4a (adaptive budgets)** — must adopt §4.4's rule (compose-only
  adaptation). If 4a needs to adapt registration, sidecar validation makes it
  safe but wasteful; that conflict escalates to a joint decision, not a silent
  override.
- **Within this spec:** steps 1→2→3 strictly ordered (shared code), 4→5→6
  strictly ordered (bridge), the two chains parallelizable; 7 anytime; 8 last.

---

## 10. Non-goals

- iOS implementation (format-neutrality is in scope; wiring is not — §4.9).
- SCANS/affine support in the manual pipeline (the `:741` guard stands).
- Injecting features into the high-level `cv::Stitcher` (the 4.10.0 API has no
  seam for it — that is precisely why the manual path exists).
- Caching pairwise **matches** (matcher-dependent, frame-set-dependent;
  see open question #4).
- Pose-seeded registration (archived ARKit path; different project).
- Any change to keyframe encoding, gating, or the sharpness window.
- Any behaviour change while `useCaptureTimeRegistration` is OFF.

---

## 11. Open questions

1. **Pinned registration budget: 0.3 or 0.6 MP?** Decided provisionally 0.3
   (§4.4); the 1280 px quality-capture corpus sets make the call. Needs
   measurement, not opinion.
2. **Lift the manual 8-frame cap?** The V12.14 BA-instability evidence
   (`cpp/stitcher.cpp:1629-1640`) predates current OpenCV and devices. Until
   re-measured, flag-ON captures with >8 keyframes fall back to high-level —
   which caps this spec's reach for hosts that raise `keyframeMaxCount`.
3. **End-state pipeline consolidation.** If Gate B passes broadly, do we
   re-unify on manual (as the repo did once before, `docs/
   stitch-pipeline-architecture.md` §7) and delete the ladder? Out of scope
   here; the flag's success criteria feed that decision.
4. **Capture-time pairwise matching (follow-up).** Adjacent-pair matches could
   also be computed incrementally at commit time — a bigger ladder-walker win —
   but they are matcher-config-dependent (3b) and are invalidated by the
   trailing drain-commit keyframe. Deferred; the sidecar format's version field
   leaves room.
5. **Gate thresholds.** Gate B's "≥ 90% of sets, never >1 worse" and Gate A's
   N=3 null-distribution calibration runs (§7.3) are reasoned starting
   points, not measured; tighten or justify after the first corpus run.
6. **iOS capture-time cost at native-resolution keyframes** (~30-80 ms/frame,
   estimated §4.9): acceptable on the collector's queue, or does iOS need the
   640-clamp first? Measure before the iOS spec.
