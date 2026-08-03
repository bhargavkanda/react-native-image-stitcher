# Perf 3b — Native stitch-pipeline speed (dedicated thread, range matcher, boost reach)

**Status:** spec — awaiting operator approval.
**Scope:** the shared C++ high-level `cv::Stitcher` path + the Android threading
that enters it.  RN-version-independent; helps every host.
**Companion phases (separate specs, parallel work):**
Phase 0 (finalize `timings` telemetry + arch fingerprint), Phase 1 (removal of
the 7df2dba AR-render pause + low-RAM adaptive block; reject-throttle config;
`Process.setThreadPriority(THREAD_PRIORITY_FOREGROUND)`; `subscribeStitchingPhase()`).
This spec **assumes both** land — see §9.

Every factual claim below is pinned to a `file:line` verified against this
worktree (commit `7df2dba`, base `f87ab91` = v0.22.0).  Per
`docs/stitch-pipeline-architecture.md` §8's standing rule, pipeline-selection
claims were re-checked via `grep -rn useManualPipeline cpp/ ios/Sources android/src`
rather than trusted from memory — and that check matters here (§2.1).

---

## 1. Summary

Three independently-togglable changes that attack the *stitch wall-clock* itself
(everything Phase 1 does merely stops other work from stealing cycles):

| # | Change | Where | Platforms affected |
|---|---|---|---|
| 1 | Dedicated pinned stitch thread(s) + undo `cv::setNumThreads(1)` behind a plumbed thread-budget config (cap moves to an eager `JNI_OnLoad`, §3.1a) | Kotlin dispatchers + Android JNI load hook + shared cpp entry | **Android only** (the RAII bracket is `#if defined(__ANDROID__)`-gated, the load hook is in the Android-only JNI layer; iOS is already multi-core on the GCD backend) |
| 2 | `BestOf2NearestRangeMatcher(range_width=3)` for PANORAMA **attempt 1 only**; attempts 2/3 keep the loosened full matchers as rescue | shared `cpp/stitcher.cpp` config site | **Both** once the default flips (both platforms' finalize now runs the shared high-level path — §2.1); staged per-platform via config |
| 3 | Make the priority boost reach the cv worker pool (warm-up parallel region) + an ADPF `PerformanceHintManager` session over the stitch thread | cpp warm-up + Android Kotlin | **Android only** (ADPF is API 31+; the warm-up is config-gated and never enabled from iOS) |

Structural framing (no band-aids): the `setNumThreads(1)` cap is itself a
**workaround** whose root cause — native entry from an unpinned, migrating
coroutine pool — item 1 fixes, which is what makes undoing the cap safe.
Item 2 replaces O(N²) pairwise matching with O(N·w) *because the input is
provably capture-ordered end-to-end* (§2.4), not because we hope it is.
Item 3 closes the gap Phase 1's boost leaves: the boost lands on the Kotlin
coroutine thread, but the cv parallel workers that do most of the compute are
spawned lazily by OpenCV and don't automatically get it.

Expected impact (all **estimated** until Phase 0 telemetry says otherwise, §7.4):
the adversarial review of 7df2dba identified the single-thread cap as the
dominant lever, est. **2–4×** on the estimate/compose phases; the range matcher
trims the matching share of `estimateTransform` by ~40 % at N=6 keyframes up to
~62 % at N=10; ADPF/boost-reach is device-dependent single-digit-to-low-tens %.

---

## 2. Current state (verified)

### 2.1 Which pipeline actually runs — high-level, on BOTH platforms

`docs/stitch-pipeline-architecture.md` §0 says both platforms unified on the
**manual** pipeline (2026-06-07).  **That is superseded at this commit** — the
2026-06-16 "HIGH-LEVEL ACROSS THE BOARD" change flipped both finalize paths back
to stock `cv::Stitcher`:

- Android finalize: `IncrementalStitcher.kt:813-815` ("HIGH-LEVEL ACROSS THE
  BOARD… useManualPipeline=false at the stitchSync call below") and the call at
  `IncrementalStitcher.kt:935-936` (`stitchMode = "panorama"`,
  `useManualPipeline = false`).
- iOS finalize: `ios/Sources/RNImageStitcher/IncrementalStitcher.swift:1649-1658`
  (same "HIGH-LEVEL ACROSS THE BOARD (mirrors Android)" comment,
  `useManualPipeline: false`), routed through
  `OpenCVStitcher.mm:426-510` into the same shared
  `retailens::stitchFramePaths`.

So "iOS has a separate stitch implementation" is true only of the *bridge*
(`OpenCVStitcher.mm`) and the archived manual path — the high-level config site
this spec touches at `cpp/stitcher.cpp:833-894` is **shared**.  Item 2 therefore
reaches iOS the moment its default flips; the staging in §6 accounts for that.

Stale artifacts that contradict this (candidates for a docs-only cleanup, not
this spec): `image_stitcher_jni.cpp:182-189` ("The batch finalize passes
useManualPipeline=true"), `BatchStitcher.kt:872-877` (`stitchSync` default
`useManualPipeline: Boolean = true` — the finalize call site overrides it), and
`docs/stitch-pipeline-architecture.md` §0/§7.

### 2.2 The thread cap and its stated root cause

`cpp/stitcher.cpp:585-608`: a C++11 static once-guard, **`#if defined(__ANDROID__)`
only** (`:602`), runs `cv::setNumThreads(1)` (`:604`).  The comment (`:585-593`)
attributes the ~7–9 MB/stitch native-heap creep to "TBB per-worker TLS —
re-primed as the calling thread migrates across the Kotlin Dispatchers.Default
pool", and the 2026-06-16 audit note (`:595-601`) records that the **iOS**
xcframework uses the GCD parallel backend ("Parallel framework: GCD" from
`getBuildInformation`), which is why the cap was iOS-ungated.

Two things about that comment need honesty:

1. **The "TBB" attribution is unverified for the Android build.**
   `scripts/build-opencv-android.sh:89-97` builds OpenCV **4.10.0**
   (`scripts/opencv-version.txt`) via OpenCV's own `build_sdk.py` with a module
   allow-list and *no* `WITH_TBB` flag — and OpenCV's Android build defaults TBB
   **off**, using its built-in pthreads `ThreadPool` backend.  The vendored SDK
   is not present in a fresh checkout (`android/vendor/` is gitignored; fetched
   by `scripts/postinstall-fetch-binaries.js`), so this spec could not read the
   produced binary's build info directly.  §7.1 gates on confirming the actual
   backend via `cv::getBuildInformation()`.
2. **The mechanism survives the misattribution.**  Both the TBB and pthreads
   backends keep per-worker state, and OpenCV's `cv::TLSData` containers grow a
   slot per *distinct thread that enters OpenCV* — so an unpinned caller that
   migrates across the Default pool accumulates TLS on every pool thread it
   visits, cap or no cap.  Pinning the entry thread is the root-cause fix
   either way.

### 2.3 The unpinned native entries

- `IncrementalStitcher.kt:316-323` — `workScope =
  CoroutineScope(Dispatchers.Default.limitedParallelism(1))`.  The comment
  itself says it is "still backing onto the Default pool": `limitedParallelism(1)`
  serializes but **does not pin** — successive tasks may run on different pool
  threads.  Finalize launches on it (`:853`) and calls
  `BatchStitcher.stitchSync` (`:924`) → JNI → shared cpp.
- `IncrementalStitcher.kt:342-345` — `refineScope`, same construction, drives
  `refinePanorama`'s stitch (`:2056`, `:2076-2095`).
- `BatchStitcher.kt:186` — the `stitch` @ReactMethod launches
  `CoroutineScope(Dispatchers.Default).launch` (not even serialized) and enters
  native at `:190`.
- The 7df2dba priority boost sits inside the finalize coroutine
  (`IncrementalStitcher.kt:860-864`, `Thread.currentThread().priority = 8`);
  Phase 1 converts it to `Process.setThreadPriority(THREAD_PRIORITY_FOREGROUND)`.
  Either way it boosts *the entry thread only* — cv pool workers are spawned by
  OpenCV on first parallel region and are not touched by it.

Contract note: `cpp/stitcher.hpp:311-312` says "caller must serialise concurrent
calls" — but `workScope` (finalize) and `refineScope` (refine) are *different*
serial scopes, so a finalize stitch and a refine stitch **can run concurrently
today**.  Harmless-ish while `setNumThreads` is a once-guard; it becomes a real
race once the thread budget is per-call config (§3.1 adds the missing lock).

### 2.4 High-level matcher config + retry ladder

`stitchFramePathsHighLevel` body (the `else` branch of
`stitchFramePathsImpl_`):

- Frames are `imread` in caller order into `images` (`cpp/stitcher.cpp:811-828`).
- `cv::Stitcher::create(PANORAMA|SCANS)` (`:834-838`); warper set only for
  PANORAMA (`:849-856`); blender + seam finder (`:857-858`); resolution budgets
  with the RAM-aware compose fallback `(totalRam ≥ 5 GB) ? 1.0 : 0.6` MP and
  caller-override-wins (`:879-886`).
- **Attempt 1 uses the `create()` default matcher** — full-pairwise
  `BestOf2NearestMatcher`, `match_conf = 0.3` (documented in-repo at
  `:939-946`).  The 2026-07-01 combined-lever retry ladder `kRetries`
  (`:947-957`) loosens the matcher (`0.25`/`0.20`) and raises regResol
  (`1.0`/`1.3` MP) on attempts 2/3 only, PANORAMA-gated (`:984-997`), swapping
  in `BestOf2NearestMatcher(false, tune.matchConf)` at `:986-987`.  SCANS runs
  only the 0.3 attempt (`:976`) and never gets a matcher swap.
- Two-phase estimate/compose with the degenerate-canvas guard between
  (`:1004-1009`, `:1161-1216`) and the compose-canvas budget downscale
  (`:1229-1259`).
- The ladder advances when `framesIncluded < framePaths.size()` (`:1053-1056`)
  — this is the hook item 2 relies on for fall-through (§3.2).
- Best-attempt recovery (`:1087-1128`) re-applies the winning tune, and — load-
  bearing for item 2 — **resets the matcher to full `BestOf2NearestMatcher(false)`
  when the best attempt didn't set matchConf** (`:1094-1098`).  If attempt 1 ran
  the range matcher, a naïve recovery would re-estimate with a *different*
  matcher than the attempt it claims to reproduce.
- Above all of this, the outer wrapper adds a spherical-warper rescue for
  high-level PANORAMA failures (`:682-700`) and preserves the opposite-mode
  fallback for manual callers (`:702-716`).

### 2.5 Keyframe ordering — capture order is preserved end-to-end

Accept paths append to `batchKeyframePaths` in accept order
(`IncrementalStitcher.kt:1327` AR path; the frame-processor accept path writes
`keyframe-${batchKeyframePaths.size}.jpg` and appends likewise, `:1532` area).
`finalize` snapshots with `toList()` (`:764`), passes
`keyframePathsSnapshot.toTypedArray()` (`:925`); the JNI unmarshals with an
index-preserving loop (`image_stitcher_jni.cpp:153-164`); the cpp `imread` loop
preserves vector order (`cpp/stitcher.cpp:814-828`); `estimateTransform(images)`
receives that vector (`:1009`).  **Capture order in = image index order at the
matcher.**  This is the precondition that makes a range matcher sound.

### 2.6 Keyframe count and size (the N in O(N²))

- `keyframeMaxCount` default **6** (`IncrementalStitcher.kt:453`; JS doc
  `src/stitching/incremental.ts:57` "default 6") — the briefing's "keyframeMax=10"
  is not the default, but settings raise it and
  `android/src/main/java/io/imagestitcher/rn/ar/YuvImageConverter.kt:27` notes a
  "typical 10–15-keyframe pan" under the quality budget.
- Keyframe long edge: 640 px default / 1280 px with `keyframeQualityCapture`
  (`YuvImageConverter.kt:22`, `:30`).
- Pair counts, full vs `range_width=3` (window |i−j| ≤ 2):
  N=6 → 15 vs 9 (−40 %); N=10 → 45 vs 17 (−62 %); N=15 → 105 vs 27 (−74 %).
- One more registration input, discovered verifying this spec: the JNI **forces
  `registrationResolMP = 0.6` whenever the caller passes ≤ 0**
  (`image_stitcher_jni.cpp:202-204`).  So "restore regResol=-1" (Phase 1's
  removal of the low-RAM block) actually yields an *explicit* 0.6 at the config
  layer, and the ladder's `max(tune, config)` (`cpp/stitcher.cpp:993`) operates
  against 0.6, not against a sentinel.  Phase 1 should be told this (§9).

### 2.7 Memory telemetry available for the gates

- Per-stitch record: `[memstat] record: … before/peak/after/floor`
  (`image_stitcher_jni.cpp:255-263`), `memFloor` = post-`mallopt(M_PURGE)` RSS
  (`:244`, `purgeNativeAllocator` `:104-126`), gated by the
  `RNIS_MEMORY_PROFILING` compile flag (debug-on).
- In-cpp peak sampler + `memBefore/Peak/After` on the result
  (`cpp/stitcher.cpp:610-642`, `cpp/stitcher.hpp:273-289`).
- SSIM tooling already exists: `scripts/ssim-compare.py` (threshold 0.98,
  resize-tolerant) — reused for the parity gate.
- Host-side gtest harness exists and has an **optional OpenCV-linked second
  binary** when `find_package(OpenCV)` succeeds
  (`cpp/tests/CMakeLists.txt:27-34`, `find_package` at `:128`) — but as it
  stands it **cannot host the parity runner**: its documented host OpenCV is a
  minimal core+imgproc static build (`scripts/run-cpp-tests.sh:26-40` — "a
  static core+imgproc build is enough"), which cannot link
  `retailens::stitchFramePaths` (needs `stitching, features2d, calib3d, flann,
  imgcodecs` as well), and the host OpenCV version is unpinned.  §7.2 specs
  the expanded, version-pinned host build the parity runner requires.

---

## 3. Design

### 3.1 Item 1 — dedicated pinned stitch thread + configurable cv thread budget

**Structural fix first.**  Replace the migrating-pool entries (§2.3) with two
**named, dedicated, single-thread dispatchers** created lazily in a small
`StitchDispatchers` object (`android/src/main/java/io/imagestitcher/rn/`):

- `rnis-stitch` — backs `workScope` (ingest serialization + finalize stitch).
  Replaces `Dispatchers.Default.limitedParallelism(1)` at
  `IncrementalStitcher.kt:323`.  Same serialization semantics (one task at a
  time), now also a **stable thread identity**, so OpenCV TLS lands on one
  thread forever.
- `rnis-refine` — backs `refineScope` (`IncrementalStitcher.kt:343-345`) *and*
  the `BatchStitcher.stitch` @ReactMethod scope (`BatchStitcher.kt:186`).  Two
  threads, not one, because the refine path is *designed* not to queue behind a
  new capture (`IncrementalStitcher.kt:325-331`); TLS is then bounded to
  exactly two stable threads instead of the whole Default pool.

`Executors.newSingleThreadExecutor { Thread(it, name) }.asCoroutineDispatcher()`
is sufficient; a `HandlerThread` adds nothing we need.  Kill switch:
`useDedicatedStitchThread` (default **true**; `false` restores the current
constructions verbatim) read from the module's first `start()` options, same
plumbing as `keyframeMaxCount` (`IncrementalStitcher.kt:453`).

**Serialise the native entry — at every call site.**  `nativeStitchFramePaths`
has exactly **two** live call sites (verified via
`grep -rn nativeStitchFramePaths android/src` — the only other hit,
`BatchStitcher.kt:247`, is a comment inside the unimplemented `stitchVideo`):

- `BatchStitcher.kt:880` — inside `stitchSync` (finalize and refine route here);
- `BatchStitcher.kt:190` — the `stitch` @ReactMethod, which does
  `ensureNativeStitcher()` + `nativeStitchFramePaths(...)` **directly** from a
  `CoroutineScope(Dispatchers.Default).launch` (`:186`), never passing through
  `stitchSync`.

A lock inside `stitchSync` alone therefore leaves the
"caller must serialise concurrent calls" contract (`cpp/stitcher.hpp:311-312`)
violable — a finalize stitch and an @ReactMethod batch stitch could still enter
native concurrently.  Fix: **refactor the @ReactMethod to delegate to
`stitchSync`** (same params, its `useManualPipeline = true` preserved; it also
gains `stitchSync`'s `lastDebugSummary` capture for free) so there is a single
choke point, then hold one process-wide `synchronized(stitchLock)` around the
native call inside `stitchSync`.  §5 step 2 carries a grep-enumeration gate so
a future entry point can't silently bypass the lock.  This is a correctness
prerequisite for a per-call global `cv::setNumThreads`, not an optimization.
Consequence: a refine issued mid-finalize *waits* (thread blocks, ingest
unaffected because it lives on the other thread) — acceptable; today's overlap
doubles peak memory and races global cv state.

**Then undo the cap — as config, not as a new hardcode.**  Two pieces; the
first is load-bearing for the kill-switch semantics *and* for §3.3.

*(a) Eager cap at library load.*  Today's once-guard
(`cpp/stitcher.cpp:602-608`) fires at `stitchFramePaths` **entry** — i.e. at
the first stitch, not at process start.  That timing has a hole this redesign
must not inherit: capture-path cv work runs **before** any stitch — the
keyframe gate's `cv::goodFeaturesToTrack` / `cv::calcOpticalFlowPyrLK` per
frame (`cpp/keyframe_gate.cpp:846`, `:880`), sharpness `cv::Laplacian`
(`cpp/sharpness.cpp:59`), glare `cv::resize` (`cpp/glare.cpp:72`) — all from
camera threads, all at OpenCV's *default* thread count until the first stitch
trips the guard.  Deleting the guard and relying on an RAII destructor to
restore the cap would make it worse: the first stitch after every process
start would run uncapped at the shipped `numThreads=0` default — the exact
multi-threaded/low-RAM behavior the cap exists to prevent, with the kill
switch nominally engaged.  Fix: move the cap to a new **`JNI_OnLoad` in
`android/src/main/cpp/image_stitcher_jni.cpp`** (no `JNI_OnLoad` exists
anywhere in the library today — verified by grep over `android/src/main/cpp/`
and `cpp/`), running `cv::setNumThreads(1)` when `libimage_stitcher.so`
loads.  Coverage argument: every native entry of this library requires that
.so loaded first — the stitcher (`BatchStitcher.kt:911`), the keyframe gate
(`KeyframeGate.kt:360-361` loads the same lib), sharpness/glare
(`QualityChecker.kt:259-269` — the `external fun` lives in
`libimage_stitcher.so`, loaded in the companion `init` at class load, before
any of that module's cv work including its `org.opencv.*` Java-API calls) —
so the cap precedes *any* OpenCV work through this library.  The file is
Android-only, so no `#ifdef` needed there.  Honest delta vs today:
pre-first-stitch capture-path ops drop from cv-default threads to 1.  That is
a deliberate tightening — it removes a today-existing exposure (camera threads
priming a full-size worker pool + per-worker TLS fan-out before the first
stitch) and it is precisely what makes the `n=0` legacy-parity claim below and
§3.3's pool-birth claim true.  §7.1's control run is annotated accordingly.

*(b) Per-stitch RAII budget.*  Replace the in-function once-guard with a
per-call, RAII-scoped application at `stitchFramePaths` entry:

```
struct ThreadBudgetScope {           // cpp/stitcher.cpp, Android-gated
  ThreadBudgetScope(int n) { cv::setNumThreads(n > 0 ? n : 1); }  // unconditional pin
  ~ThreadBudgetScope()     { cv::setNumThreads(1); }              // restore cap
};
```

driven by a new `StitchConfig::numThreads` (`int`, default **0**).  The ctor
is **unconditional on Android** — at `n=0` it re-pins 1 rather than no-op'ing,
so every stitch enters at its configured budget even if some future path ever
raised the global.  Semantics:

- `0` → legacy behavior exactly: the eager `JNI_OnLoad` cap plus the
  unconditional ctor pin mean Android runs at 1 thread from .so load through
  every stitch **including the first one per process** — without (a), this
  claim is false.  iOS untouched.  **This is the kill switch.**
- `> 0` → `cv::setNumThreads(n)` for the duration of the stitch, restored to 1
  on exit.  Honest blast-radius statement: `setNumThreads` is process-global,
  so cv work running *concurrently with an active bracket* also sees `n`.
  For **finalize** brackets that is a non-event: finalize cuts frame-processor
  ingest before stitching (`IncrementalStitcher.kt:737`) and the plugin
  fast-exits when ingest is off (`:310-315`), so gate/sharpness work does not
  run during a finalize.  For **refine** brackets it is real: refineScope
  exists precisely so a refine can overlap a *new* capture
  (`IncrementalStitcher.kt:325-341`), and during that window the camera
  producer thread's gate/sharpness/glare ops parallelize too — see the
  refine-window note below; §8's risk row matches it.

The RAII scope stays inside `#if defined(__ANDROID__)`; iOS keeps its GCD
backend with no cap and no new behavior (`cpp/stitcher.cpp:595-601`).

**Refine-during-capture window — accept-and-measure.**  Decision: ship the
overlap as a known, bounded exposure rather than pre-emptively complicating
the budget logic:

- *Exposure:* a multi-second refine bracket at `n=4` while ingest is active
  means gate optical-flow / sharpness / glare on the camera producer thread
  run multi-threaded — CPU contention with the stitch and frame-pacing risk on
  low-end SoCs.  (TLS-wise it adds little: the camera threads already enter
  OpenCV per-frame today, and the pool population is bounded by item 1.)
- *Measurement:* §7.5 point 6 adds a device-verify point — capture frame
  pacing + gate cadence during an N=4 refine-while-capturing on the A35 — and
  §4 asks Phase 0 for a `timings.overlappedIngest` flag so telemetry rows from
  overlapped brackets are separable from clean ones.
- *Named structural fallback (no band-aid):* thread-count resolution lives in
  Kotlin (below), so if measurement shows a regression, the refine call site
  resolves its budget ingest-aware — `numThreads = 1` whenever
  `frameProcessorIngestEnabled` / `ingestActive` is set at refine launch — one
  conditional at one call site, zero cpp change.  Not shipped by default
  because it forfeits refine speed for a window not yet measured to matter.

**Thread-count resolution lives in Kotlin** (it knows RAM + cores):
`stitchNumThreads` config; `0`/absent → legacy; `-1` → auto =
`min(4, availableProcessors() / 2)` clamped to `max(2, …)`, and capped at **2**
when total RAM < 4 GB (same `ActivityManager` read the low-RAM block used,
`IncrementalStitcher.kt:909-915` — that block is removed by Phase 1, but the
`MemoryInfo` pattern is reusable).  Big-core detection via
`/sys/devices/system/cpu/cpufreq/policy*/cpuinfo_max_freq` is a possible
refinement — deliberately deferred (§11).  The resolved int is passed through
`stitchSync` → JNI (new trailing parameter — order/count/type must match
exactly or `UnsatisfiedLinkError`, per the in-repo caution
`BatchStitcher.kt:117-119`) → `cfg.numThreads`.

**Why this is safe from the original leak:** the creep came from *unbounded
distinct threads* entering OpenCV (§2.2).  After this change the only threads
that ever enter the stitcher are `rnis-stitch` and `rnis-refine`, and the
worker pool (whatever backend) is primed from a stable thread.  TLS then
plateaus instead of ratcheting — which is precisely what the §7.1 memstat gate
measures before the default flips.

### 3.2 Item 2 — `BestOf2NearestRangeMatcher(range_width=3)` on PANORAMA attempt 1

**Config:** `StitchConfig::rangeMatcherWidth` (`int`, default **0** = off;
`3` = window |i−j| ≤ 2).  Plumbed like `numThreads` (JNI param + Kotlin +
JS settings key `stitchRangeMatcherWidth`).  iOS picks the C++ default up with
zero bridge changes; enabling on iOS later is an `OpenCVStitcher.mm` cfg line.

**Mechanics** (all at the `kRetries` loop, `cpp/stitcher.cpp:973-997`):

- Attempt 1, PANORAMA, `rangeMatcherWidth > 0` →
  `stitcher->setFeaturesMatcher(makePtr<detail::BestOf2NearestRangeMatcher>(width, false, 0.3f))`
  (keep the default `match_conf = 0.3` — attempt 1's looseness must not change,
  only its pair set).  Because the ladder loop reuses one `cv::Stitcher`
  instance, attempt 1 must now set its matcher **explicitly on every pass**
  (today it inherits the `create()` default) — attempts 2/3 already overwrite
  it with the loosened full matchers (`:986-987`), which stay byte-identical as
  the rescue for pan-back captures.
- SCANS: untouched — the escalation is already PANORAMA-gated (`:984`) and
  SCANS uses the affine matcher family (`:936-937`, `:979-981`).
- **Best-attempt recovery fix** (`:1092-1098`): when `bestAttempt == 0` and the
  range matcher is enabled, recovery must re-apply the *range* matcher, not
  `BestOf2NearestMatcher(false)` — otherwise the recovery re-run isn't the
  attempt it claims to reproduce.  One conditional at the reset site.

**Why order makes this sound:** §2.5 proves image index order == capture accept
order.  On a linear pan, non-adjacent pairs are exactly the pairs with
near-zero overlap — computing them buys ~nothing and costs the O(N²) bulk.

**API verification** (2026-08-03 — **constructor CONFIRMED** against the
vendored `android/vendor/OpenCV-android-sdk/.../stitching/detail/matchers.hpp`,
`CV_VERSION 4.10`):

```cpp
BestOf2NearestRangeMatcher(int range_width = 5, bool try_use_gpu = false,
                           float match_conf = 0.3f,
                           int num_matches_thresh1 = 6,
                           int num_matches_thresh2 = 6);
```

So `makePtr<cv::detail::BestOf2NearestRangeMatcher>(width, false, 0.3f)` binds
`range_width=width, try_use_gpu=false, match_conf=0.3f` — the two thresholds keep
their `BestOf2NearestMatcher` defaults (6/6), matching attempt 1's current
`create(PANORAMA)` default. It subclasses `BestOf2NearestMatcher` and overrides
`match()` (honoring the passed `mask`). Two obligations REMAIN (need the `.cpp`,
not just the header):

1. Confirm the `match()` `near_pairs` window is `|i−j| < range_width` (so
   `range_width=3` ⇒ neighbours at distance 1 and 2) and that it honors the
   Stitcher's `matching_mask_`.
2. Confirm uncomputed pairs remain default `MatchesInfo` (confidence 0) — i.e.
   *absent edges* for `leaveBiggestComponent`, not spurious weak edges.

**Failure semantics — fall through, never silently degrade:** on a pan-back
capture whose adjacent overlap is weak, the range matcher can split the match
graph; `leaveBiggestComponent` then retains a subset, `framesIncluded <
framePaths.size()` and the ladder advances to attempt 2's loosened **full**
matcher (`:1053-1059`).  So the worst case is the *status quo* pipeline paying
one cheap extra attempt — verified explicitly by the pan-back parity set
(§7.2).  The residual risk — attempt 1 keeps all N frames via a chain of
adjacent matches but produces a *different* (not worse-in-count, possibly
worse-in-geometry) registration than full-pairwise — is exactly what the SSIM
gate exists to catch.

**Operator decision (2026-08-03) — pan-backs are being designed out at capture
time.** The pan-back capture shape is not a case we intend to support: the
capture UX will *stop accepting keyframes* the moment the operator reverses
direction (turn the pan-speed border red, show a "capture paused" message,
resume only once the pan passes the last accepted keyframe in the original
direction).  That work is specified separately and **deferred** — see
[`perf-5-capture-pause-on-reversal.md`](perf-5-capture-pause-on-reversal.md).
Its consequence for item 2: once capture-pause ships, the accepted keyframe set
is **monotonic in one direction by construction**, so `range_width=3` can never
miss a real overlap edge and the full-matcher rescue on attempts 2/3 is no
longer needed *for the pan-back reason* (it still earns its place as the
weak-adjacent-overlap rescue, so we keep it regardless).  **Sequencing:** item 2
ships *before* capture-pause, so the pan-back rescue and Set P parity gate below
remain load-bearing until that feature lands; treat them as a safety bridge, not
permanent scaffolding.  Do **not** couple item 2's default flip to capture-pause
— item 2 is safe on its own merits via the ladder fall-through above.

### 3.3 Item 3 — make the boost reach the compute + ADPF

Phase 1's `Process.setThreadPriority(THREAD_PRIORITY_FOREGROUND)` boosts the
finalize coroutine's thread.  After item 1, that thread is `rnis-stitch` —
stable — and the **eager `JNI_OnLoad` cap (§3.1a)** guarantees no cv worker
pool can exist before the first `n>1` stitch bracket: from .so load onward the
process runs `numThreads=1` outside brackets, so parallel regions — including
the per-frame capture-path ops that run *before* any stitch
(`cpp/keyframe_gate.cpp:846/:880`, `cpp/sharpness.cpp:59`) — execute inline
and spawn nothing.  (This claim is **false** without the eager cap: today the
once-guard fires at first *stitch* entry, so gate/sharpness ops entering
OpenCV from camera threads beforehand would birth the pool at default size
from an unboosted camera thread — which is exactly why §3.1 moves the cap to
library load.)  Linux threads inherit the creator's nice value, so workers
spawned during a boosted bracket are born boosted.

- **Warm-up parallel region** — `StitchConfig::warmUpThreadPool` (`bool`,
  default false): immediately after `ThreadBudgetScope` raises the budget, run
  one trivial `cv::parallel_for_(Range(0, numThreads * 4), no-op)` so pool
  spawn happens *deterministically inside the boosted window* (and before
  `imread`, keeping Phase 0's per-phase timings clean), rather than mid-ORB.
  Cost: sub-millisecond, **estimated**.  Also gives the ADPF tid enumeration
  (below) a fixed point to diff `/proc/self/task` around.  The
  boost+warm-up pairing applies on the refine path too, so pool birth priority
  doesn't depend on which entry stitches first.
- **ADPF session** (Android 12+, API 31): in `IncrementalStitcher.finalize`'s
  stitch block, if `stitchAdpfEnabled` (default true — it degrades to a no-op)
  and `PerformanceHintManager` is available: capture `Process.myTid()` **on the
  stitch thread**, `createHintSession(tids, targetNs)` with target = a rolling
  estimate of stitch duration (seed 5 s; after Phase 0 lands, the previous
  `stitchWallMs`), `reportActualWorkDuration()` after `stitchSync` returns,
  `close()` in the `finally`.  Null session (unsupported device / power policy)
  → silently proceed.  Never request above the foreground tier — the session
  *hints* sustained CPU need so the governor holds clocks; it does not elevate
  scheduling class, and the priority side stays exactly Phase 1's
  `THREAD_PRIORITY_FOREGROUND`.
  **Envelope-risk honesty:** ADPF is designed for repeated, frame-cadenced
  work cycles with ms-scale target durations; one ~5 s cycle per stitch is
  outside that envelope, and OEM power-hint HALs may clamp or ignore long
  targets — a session can be *accepted-but-ignored*, which the null-session
  check cannot detect.  Per-phase reporting (cycles in the hundreds-of-ms
  range, fitting the envelope) has no plumbing today: the only native phase
  surface is the coarse started/finished `StitchingPhaseChanged`
  (`IncrementalStitcher.kt:851`, `:1017`, emitter `:2343-2349`); per-cv-phase
  callbacks would be new cpp→Kotlin surface, deliberately not spec'd here.
  Decision: keep the single-cycle design but gate it on evidence — §7.5
  point 7 (sustained-clock A/B, ADPF on/off, `stitchWallMs` tail variance on
  the A35) must show a measurable effect, else the default flips to
  `stitchAdpfEnabled=false` and open question 6's per-phase fork activates.
- **Optional extension (flagged, default off):** include worker tids in the
  session by diffing `/proc/self/task` across the warm-up region from Kotlin
  (no JNI needed to *enumerate*; a JNI `gettid` helper is only needed if we
  ever tag from the C++ side).  Expected benefit unquantified — see §11.

`minSdk` is 24 (`image_stitcher_jni.cpp:36`), so every ADPF touch is
`Build.VERSION.SDK_INT >= 31`-guarded and reflection-free via the platform API.

---

## 4. API / config surface changes

New keys, all optional, all defaulting to current behavior (the settings docs
pattern follows `src/stitching/incremental.ts:560-640`):

| Key (JS settings → start options) | Type / default | Consumed by | Meaning |
|---|---|---|---|
| `useDedicatedStitchThread` | bool, `true` | Kotlin (`StitchDispatchers`) | Kill switch back to `Dispatchers.Default.limitedParallelism(1)` |
| `stitchNumThreads` | int, `0` | Kotlin → JNI → `StitchConfig.numThreads` | `0` legacy (Android cap 1); `-1` auto heuristic; `>0` explicit |
| `stitchRangeMatcherWidth` | int, `0` | Kotlin → JNI → `StitchConfig.rangeMatcherWidth` | `0` off; `3` recommended once gated |
| `stitchWarmUpPool` | bool, `false` | Kotlin → JNI → `StitchConfig.warmUpThreadPool` | Warm-up parallel region inside the boosted bracket |
| `stitchAdpfEnabled` | bool, `true` | Kotlin only | ADPF hint session around `stitchSync` (no-op < API 31) |

C++ (`cpp/stitcher.hpp` `StitchConfig`, after `:233`): `int numThreads = 0;
int rangeMatcherWidth = 0; bool warmUpThreadPool = false;` — defaults preserve
byte-identical behavior for every existing caller, including iOS, whose
bridge needs **no change** until it opts in.

JNI: `nativeStitchFramePaths` gains three trailing params
(`int numThreads, int rangeMatcherWidth, boolean warmUpThreadPool`) in **one
Stage-A signature change** — Stages B/C only start *consuming* the
already-plumbed values (defaults `0/0/false` keep behavior byte-identical), so
there is exactly one `UnsatisfiedLinkError` exposure window and one lockstep
Kotlin/C++ update, not two.  Kotlin `external fun` + `stitchSync` (the single
call site after §3.1's @ReactMethod delegation) updated in the same commit
(`BatchStitcher.kt:117-119`'s order/count/type warning applies).
`refinePanorama` (`IncrementalStitcher.kt:2076-2095`) passes the same resolved
values as finalize so re-stitches stay budget-consistent with the primary
stitch — same rule the resolution budgets already follow.

Phase 0 dependency (requested addition, see §9): the arch fingerprint should
include the `Parallel framework:` line of `cv::getBuildInformation()` plus
effective `cv::getNumThreads()`, and the `timings` block should carry
`budgets.numThreads` and `budgets.rangeMatcherWidth` so every telemetry row is
attributable to a configuration, plus an `overlappedIngest` flag (was ingest
active at any point inside the stitch bracket) so refine-overlap rows (§3.1's
refine-window note) are separable from clean brackets.

---

## 5. Implementation plan (ordered)

Each stage lands independently togglable and independently revertible.

**Stage A — thread hygiene (Android Kotlin + shared cpp, Android-gated):**

1. `StitchDispatchers` object; swap `IncrementalStitcher.kt:323` (`workScope`)
   and `:343-345` (`refineScope`); route `BatchStitcher.kt:186` onto the refine
   dispatcher.  Files: `IncrementalStitcher.kt`, `BatchStitcher.kt`, new
   `StitchDispatchers.kt`.
2. Native-entry choke point: refactor the `stitch` @ReactMethod
   (`BatchStitcher.kt:190`) to delegate to `stitchSync`, then add the
   process-wide `synchronized(stitchLock)` around the native call inside
   `stitchSync` (`BatchStitcher.kt:880`).  **Gate:** `grep -rn
   nativeStitchFramePaths android/src` must show exactly one call site
   (inside `stitchSync`) plus the `external fun` declaration; re-run the grep
   in review whenever a native entry point is added, so future callers can't
   silently bypass the lock.
3. cpp/JNI: add the eager `JNI_OnLoad` cap in `image_stitcher_jni.cpp`
   (§3.1a); delete the in-function once-guard `cpp/stitcher.cpp:602-608`; add
   `ThreadBudgetScope` (unconditional pin, §3.1b) + `StitchConfig.numThreads`
   (`cpp/stitcher.hpp`, `cpp/stitcher.cpp` entry at `:584`).
4. The **single** JNI signature change: add all three trailing params
   (`numThreads`, `rangeMatcherWidth`, `warmUpThreadPool`) now, defaults
   `0/0/false` (§4) — Stage B step 8 and Stage C step 10 consume them without
   touching the signature again.  Plus Kotlin plumb + auto-resolver.  Files:
   `image_stitcher_jni.cpp:131-147`, `BatchStitcher.kt:81-121/849-899`,
   `IncrementalStitcher.kt` finalize + refine call sites.
5. Ship with `stitchNumThreads=0` (behavior-identical); flip the example app to
   `-1` for the §7.1 device runs; flip the library default only after the gate.

**Stage B — range matcher (shared cpp; Android plumb; iOS later):**

6. Verify vendored 4.10.0 API (§3.2 obligations) — blocking precondition.
7. cpp: attempt-1 matcher selection + recovery-path matcher fix
   (`cpp/stitcher.cpp:973-997`, `:1092-1098`); `rangeMatcherWidth` config.
8. Kotlin/JS plumb of the already-present JNI param (Stage A step 4),
   default 0 — **no signature change**.
9. Parity gate §7.2 on Android; flip Android default to 3.  iOS: separate
   follow-up — one cfg line in `OpenCVStitcher.mm:426-510` + the same frozen-set
   parity run on an iOS device build; until then iOS keeps full-pairwise
   attempt 1 (divergence is *config*, not code — both platforms run the same
   ladder).

**Stage C — boost reach + ADPF (Android only):**

10. cpp warm-up region behind `warmUpThreadPool` (inside the Stage-A
    bracket).  cpp-only: the config crossed JNI in Stage A step 4 — no
    signature touch.
11. Kotlin ADPF session wrapper around the `stitchSync` calls in finalize
    (`IncrementalStitcher.kt:924`) and refine (`:2076`); API-31 guard;
    null degrade.  Files: `IncrementalStitcher.kt` (+ a small
    `AdpfSession.kt` helper).
12. Measure via Phase 0 fields (§7.4); the optional worker-tid extension only
    if the measured gap justifies it.

---

## 6. Platform parity statement

- **Item 1** — Android-only by construction: the cap being removed is
  Android-gated (`cpp/stitcher.cpp:602`), iOS is documented multi-core GCD
  (`:595-601`), and iOS already enters native on serial dedicated queues
  (`IncrementalStitcher.swift:279`, `:296`).  No iOS behavior change: the
  RAII bracket sits inside the existing `#if defined(__ANDROID__)`, and the
  eager cap lives in `JNI_OnLoad` of the Android-only JNI layer
  (`android/src/main/cpp/image_stitcher_jni.cpp`), which iOS never compiles.
- **Item 2** — **shared code, both platforms** (§2.1).  Default-off C++ config
  keeps iOS byte-identical until its own gated flip (step 9).  Honest
  consequence: after both flips the platforms remain in lockstep; if only
  Android flips, attempt-1 output can differ across platforms for the same
  keyframes — an accepted, documented, *temporary* divergence.
- **Item 3** — Android-only (ADPF is an Android 12 API; iOS thermal/QoS is a
  different system and its queues already run at the bridge's QoS).  The cpp
  warm-up is config-gated and iOS never sets it.
- The **manual pipeline** (`stitchFramePathsManual`) is untouched by all three
  items; it no longer serves finalize on either platform (§2.1) but remains
  reachable via `refinePanorama` config (`IncrementalStitcher.kt:2036-2037`)
  and the `BatchStitcher.stitch` @ReactMethod (`BatchStitcher.kt:205`) — those
  callers gain the thread-hygiene benefits of Stage A automatically (same
  dispatchers, same bracket) but no matcher change (the range matcher is
  ladder-only, and the ladder is high-level-only).

---

## 7. Verification & gates

### 7.1 Gate A — memory plateau (blocks flipping `stitchNumThreads` default)

- **Backend fingerprint first:** one debug log of `cv::getBuildInformation()`'s
  "Parallel framework" line on an Android device build (and requested as a
  permanent Phase 0 arch-fingerprint field).  This settles §2.2's TBB-vs-pthreads
  question before any conclusions are drawn from memory numbers.
- **Plateau run:** RNIS_MEMORY_PROFILING debug build, `stitchNumThreads=-1`,
  `useDedicatedStitchThread=true`; **N ≥ 10 consecutive captures+finalizes** on
  the low-RAM reference device; harvest `[memstat] record:` lines
  (`image_stitcher_jni.cpp:255-263`).  PASS = `memFloor` deltas between
  consecutive stitches → ~0 (plateau) after the first 2 stitches; FAIL = a
  ratcheting floor reproducing the v0.16.1 creep → do not flip, kill switch
  stays, investigate backend TLS lifecycle (§11).
- **Control:** same run with `stitchNumThreads=0` must match today's floor
  (regression guard on the dispatcher swap alone).  One known, deliberate
  delta vs a pre-branch build: the eager `JNI_OnLoad` cap (§3.1a) now caps the
  *pre-first-stitch* capture-path cv ops (gate flow / sharpness / glare) at 1
  thread — today those run uncapped until the first stitch trips the old
  guard.  A control floor *below* the pre-branch baseline is therefore the
  expected direction of this change, not noise; only a **higher** floor is a
  finding.  State this in the run notes so the gate isn't confounded.
- Peak check: `memPeakMB` with threads=4 must stay under the existing budgets
  (the canvas/compose guards at `cpp/stitcher.cpp:1161-1259` are
  thread-count-independent, but multi-threaded warp/blend has per-worker
  scratch — verify, don't assume).

### 7.2 Gate B — output parity (blocks flipping `stitchRangeMatcherWidth`)

Frozen inputs, not live captures: two archived keyframe sets (the finalize
result already surfaces exact paths via `batchKeyframePaths`,
`IncrementalStitcher.kt:978-980` — capture once, copy off-device, commit to a
fixtures location or CI artifact):

- **Set L (linear pan):** ~10 keyframes, monotonic pan, the happy path.
- **Set P (pan-back):** a capture with deliberate direction reversal so
  non-adjacent frames overlap (the case full-pairwise handles natively).

Runner — host-side, but against a **pinned, full-module host OpenCV** (the
existing minimal harness cannot do this job — §2.7):

- Host OpenCV pinned to **exactly the vendored version** —
  `scripts/opencv-version.txt` = 4.10.0 — built with
  `-DBUILD_LIST=core,imgproc,imgcodecs,features2d,calib3d,flann,stitching
  -DBUILD_SHARED_LIBS=OFF`; extend `scripts/run-cpp-tests.sh:26-40`'s
  opencv-host build instructions with this second (superset) profile.
- New `stitch_paths_parity` target in the optional-OpenCV section of
  `cpp/tests/CMakeLists.txt`, guarded by a CMake check that
  `OpenCV_VERSION VERSION_EQUAL` the contents of `scripts/opencv-version.txt`
  and **fails configure loudly** on any other version.  Rationale: matcher/BA
  behavior varies across OpenCV versions, so a parity verdict computed against
  a stray system OpenCV (4.9/4.11/…) does not transfer to the shipped
  Android/iOS 4.10.0 binaries — the guard makes a bogus verdict impossible
  rather than merely discouraged.
- The target invokes `retailens::stitchFramePaths` twice per set
  (rangeMatcherWidth 0 vs 3, all else identical) — no device in the loop.
- Honest transfer statement: a same-version host run transfers *matcher/BA
  semantics* (what this gate judges), not device timing or memory — those come
  from §7.4/§7.1 — and §7.5 point 4's on-device live captures remain the final
  pre-flip confirmation through the real vendored `.so`.

Compare:

1. `framesIncluded` **equal** on Set L (both must retain all frames), and the
   attempt number that succeeded (from the result/log) equal — the range run
   must win on attempt 1, not by silently escalating.
2. `scripts/ssim-compare.py` **SSIM ≥ 0.98** on Set L outputs (the repo's
   established parity threshold).  Note the in-repo caveat: cv::Stitcher
   registration is *not* run-to-run reproducible (`cpp/stitcher.cpp:1079-1082`),
   so also run same-config-twice as a noise baseline; the gate is
   "cross-config SSIM within the same-config noise band", not naive equality.
3. Set P: the range run must either (a) match the full run's `framesIncluded`
   after falling through to attempts 2/3 (verify via the attempt telemetry /
   `[stitch-retry]` logs that fall-through actually occurred), or (b) match on
   attempt 1 outright.  A range run that returns *fewer frames overall* than
   the full run FAILS the gate.
4. Wall-clock of the parity runs is recorded but is **not** the gate (host ≠
   device) — device numbers come from §7.4.

### 7.3 Unit tests (host, no OpenCV needed)

- Kotlin (JUnit, `android/src/test/java/io/imagestitcher/rn/`): thread-count
  resolver table (cores × RAM → resolved N, low-RAM cap, 0/−1 semantics);
  `stitchSync` lock serialization (two threads, second blocks); the `stitch`
  @ReactMethod delegates to `stitchSync` (choke-point regression guard, §3.1);
  dispatcher selection under the kill switch.
- C++ (gtest, OpenCV-free binary): config-default assertions pinning
  `numThreads=0 / rangeMatcherWidth=0 / warmUpThreadPool=false` (the
  "byte-identical by default" contract, same style as the existing POD/layout
  pins).

### 7.4 On-device measurement (Phase 0 telemetry — the perf claims' judge)

All performance claims in §1 are **estimated** until these fields say
otherwise, on the A35-class reference device, ≥ 5 stitches per configuration:

| Claim | Phase 0 fields that validate it |
|---|---|
| Threads 1→N: 2–4× on estimate/compose | `timings.stitchWallMs` + per-cv-phase ms (estimate vs compose split), before/after `budgets.numThreads` |
| Range matcher: matching share −40…−74 % | per-phase ms of `estimateTransform` at `budgets.rangeMatcherWidth` 0 vs 3, same keyframe count (`keyframes.count`) |
| Dedicated thread: no queueing regression | `timings.queueDelayMs` unchanged vs baseline |
| ADPF/warm-up: sustained clocks | `timings.stitchWallMs` variance across consecutive stitches (throttling shows as tail inflation), ADPF on/off |
| No memory regression | `[memstat]` `memPeakMB`/`memFloor` per §7.1 |

### 7.5 Device-verify points (native paths that host tests cannot cover)

1. §7.1 plateau run (low-RAM device + 6 GB device).
2. `UnsatisfiedLinkError` smoke: one finalize on-device immediately after the
   **single** Stage-A JNI signature change (Stages B/C never touch the
   signature again — §4).
3. ADPF liveness: verify session creation succeeds on an API 31+ device and
   the null-degrade path on an API < 31 device (or with the manager absent).
4. Range matcher on-device: one Set-L-style and one Set-P-style *live* capture
   per platform at the default flip, eyeballed + `framesIncluded` checked —
   the host parity gate uses fixed inputs; this catches capture-pipeline
   interactions the fixtures can't.
5. iOS no-change verification for Stages A/C: one iOS finalize before/after,
   asserting identical `debugSummary` + dimensions (cheap guard that the
   Android-gated ifdef actually gates).
6. Refine-overlap frame pacing (§3.1 refine-window note): start a capture,
   trigger `refinePanorama` at N=4 mid-capture on the A35; verify preview
   frame pacing and gate accept cadence do not visibly regress while the
   bracket is active (`timings.overlappedIngest` marks the rows).  Regression
   → enable the ingest-aware refine budget fallback (Kotlin-only, §3.1).
7. ADPF **effectiveness** (not just liveness — an accepted-but-ignored session
   passes point 3): ≥ 5 consecutive finalizes ADPF-on vs ADPF-off on the A35;
   `stitchWallMs` tail variance must show a measurable sustained-clock effect
   at the multi-second target, else default `stitchAdpfEnabled=false` and open
   question 6's per-phase fork activates.

---

## 8. Risks & mitigations

| Risk | Mitigation | Structural fix behind it |
|---|---|---|
| TLS creep returns at N>1 (backend keeps per-worker scratch) | §7.1 plateau gate before default flip; `stitchNumThreads=0` kill switch | Pinned entry threads + pool primed from one stable thread — bounded thread population is the fix, the gate only proves it |
| Range matcher silently degrades a pan-back that *keeps* all frames via weak adjacency chains | SSIM gate + Set P; attempts 2/3 unchanged as rescue; per-platform staged default | Escalation ladder already exists (`:1053-1059`) — item 2 rides it instead of adding a new fallback |
| Recovery path re-runs attempt 1 with the wrong matcher | Explicit recovery-matcher fix (§3.2) + a `[stitch-retry]` log line naming the matcher applied | Recovery re-applies *the actual tune*, matcher included |
| Global `setNumThreads` raises capture-path CPU **during a refine-while-capturing overlap** (finalize is not exposed — ingest is cut at `IncrementalStitcher.kt:737` before its bracket) | Accept-and-measure: §7.5 point 6 frame-pacing check + `timings.overlappedIngest` telemetry separation; RAII bracket still restores 1 outside brackets | Ingest-aware refine budget — Kotlin resolves refine to N=1 while ingest is active (§3.1 refine-window note); shipped only if §7.5.6 measures a regression |
| First-stitch-per-process runs uncapped once the once-guard is deleted; capture-path cv primes a full pool pre-first-stitch | Eager `JNI_OnLoad` cap (§3.1a) — cap active from .so load, before any native entry | Cap applied at library load instead of first-stitch entry — the timing hole is removed, not patched around |
| Concurrent native entry — finalize, refine, **or the `stitch` @ReactMethod** (`BatchStitcher.kt:190` bypasses `stitchSync` today; pre-existing, worsened by per-call config) | @ReactMethod delegates to `stitchSync`; one `synchronized(stitchLock)` there covers what were two call sites (`:190`, `:880`); grep-enumeration gate §5 step 2 | Enforces the documented `stitcher.hpp:311-312` contract at a single choke point |
| JNI signature drift → `UnsatisfiedLinkError` | ONE signature change (Stage A, all three params); same-commit updates both sides; device smoke §7.5.2 | (procedural) |
| ADPF misuse (over-requesting) throttles instead of helping | Session carries only the stitch tid by default; target from measured wall; `stitchAdpfEnabled` off switch | Hint reflects *actual measured* work via Phase 0 numbers |
| ADPF session silently inert at multi-second targets (API envelope is ms-scale repeated cycles; OEM HALs may clamp/ignore — null check can't detect accepted-but-ignored) | §7.5 point 7 effectiveness A/B is the gate; default flips to off if inert | Per-phase reporting redesign (needs new native per-cv-phase callbacks) is the named fork — open question 6 |
| Refine now waits for an in-flight finalize (lock) | Acceptable: refine is on-demand UX; ingest is unaffected (separate thread); document in the refine JSDoc | (accepted trade, stated) |
| Dedicated thread leaks across RN reloads (module re-instantiation) | `StitchDispatchers` is a process singleton (mirrors the `bridgeInstance` pattern, `BatchStitcher.kt:927-947`); executors are named for leak triage | Singleton ownership instead of per-instance executors |

---

## 9. Dependencies & sequencing

- **Phase 0 (telemetry) — hard dependency for §7.4 and the ADPF target
  duration.**  Stage A can *land* before it (the memstat gate uses existing
  `[memstat]` plumbing) but the default flip's perf justification and item 3's
  measurements need `timings.*`.  Three requested Phase 0 additions (§4):
  arch fingerprint gains the `Parallel framework:` build-info line +
  `cv::getNumThreads()`; `budgets.*` gains `numThreads`/`rangeMatcherWidth`;
  `timings` gains the `overlappedIngest` flag (§3.1 refine-window note).
- **Phase 1 — soft dependency.**  Item 3 builds on Phase 1's
  `THREAD_PRIORITY_FOREGROUND` boost (the warm-up inherits *whatever* the entry
  thread's priority is, so item 3 works — just less — against the 7df2dba
  `priority=8` too).  Phase 1's removal of the low-RAM block
  (`IncrementalStitcher.kt:894-923`) must land before §7.4 baselines are taken,
  or the before/after numbers confound resolution with threading.
  **Handoff note to Phase 1:** "restore regResol=-1" lands as an *explicit 0.6*
  at the config layer because the JNI floors non-positive values
  (`image_stitcher_jni.cpp:202-204`) — the restored default is 0.6-explicit,
  not sentinel; behaviorally identical to cv's default but it changes what the
  ladder's `max(tune, config)` (`cpp/stitcher.cpp:993`) compares against.
  Phase 1 should state which layer it edits.
- **Within this spec:** A → B → C strictly.  B's parity runs want A's
  deterministic threading (run-to-run noise shrinks when the thread budget is
  fixed); C's inheritance argument (§3.3) *requires* A's RAII bracket.
- **No dependency on** the Phase 1 reject-throttle / event-wrapper items.

---

## 10. Non-goals

- Re-tuning stitch *quality* knobs (warper tree, blender, seam finder,
  resolution budgets, `kRetries` thresholds/matchConf values) — attempts 2/3
  and SCANS stay byte-identical.
- The manual pipeline (`stitchFramePathsManual`) — no threading, matcher, or
  config changes; it keeps its own documented cost model
  (`cpp/stitcher.hpp:153-215`).
- iOS threading/QoS work and the iOS range-matcher default flip (follow-up,
  §5 step 9 / §6).
- Ingest-path costs: the synchronous accept-path JPEG encode (30–50 ms on the
  producer thread, `IncrementalStitcher.kt` `consumeFrameFromPlugin` docstring),
  `packNV21` copies, worklet cadence / `evalEveryNFrames`, and the double
  setState re-renders — separate specs.
- The Phase 1 items themselves (render pause removal, low-RAM block removal,
  throttle config, phase-event wrapper).
- Cleaning up the stale `useManualPipeline` comments/doc (§2.1) — flagged for a
  docs commit, not this change-set.
- Any change to keyframe budgets (count 6 / 640 px / 1280 px quality).

---

## 11. Open questions

1. **Which parallel backend is the Android build actually using?**  pthreads is
   the strong prior (no `WITH_TBB` in `scripts/build-opencv-android.sh`;
   OpenCV Android defaults), but the answer changes the TLS-lifecycle analysis
   in §7.1's failure branch.  Resolved by the Gate-A fingerprint log — do this
   first, it's one log line.
2. **Vendored 4.10.0 `BestOf2NearestRangeMatcher` exact signature** — asserted
   from upstream 4.10.0, unverifiable in this worktree (vendor dir is
   postinstall-fetched).  Blocking precondition for Stage B (§5 step 6).
3. **Persistent-N vs RAII-restore under the real backend:** if setNumThreads
   down-resize churns pool threads per stitch (spawn/kill each bracket → fresh
   TLS per stitch), the RAII design itself would creep; the fix would be
   persistent N on a still-capped capture path via `parallel_for_` nstripes
   control instead of the global. Gate A's control-vs-treatment floors decide;
   design flips to persistent-N only with that evidence.
4. **Thread-count heuristic:** is `min(4, cores/2)` right on 8-big.LITTLE
   mid-rangers, and is the <4 GB cap of 2 correct?  §7.4 wall-clock at N ∈
   {2, 3, 4} on the A35 settles it; `/sys` cpufreq big-core parsing only if the
   simple heuristic measurably misses.
5. **Does the warm-up region actually matter,** or does the first stitch phase
   (ORB detect) spawn the pool early enough inside the boosted window anyway?
   Measured by comparing per-phase timings with `warmUpThreadPool` on/off; if
   indistinguishable, drop the config to reduce surface.
6. **Does ADPF do anything at a multi-second target — and if not, which
   fork?**  The API's design envelope is repeated ms-scale cycles; §7.5
   point 7's on/off A/B answers whether the single-cycle session has any
   effect on real OEM HALs (a null check cannot — accepted-but-ignored is
   invisible).  If inert: either drop ADPF (default off) or redesign to
   per-phase reporting, which needs new native per-cv-phase callbacks (the
   only existing phase surface is start/finish `StitchingPhaseChanged`,
   `IncrementalStitcher.kt:851/:1017`) — a real surface addition needing its
   own sign-off.  The worker-tid extension is subordinate to this: only pursue
   it if the session is effective on the recorded tid but throttling persists
   on worker threads.
7. **Refine-waits-for-finalize lock UX:** accepted here (§8); needs operator
   sign-off since the refine tab's "re-stitch while browsing" flow gains a
   worst-case multi-second wait when invoked mid-finalize.
8. **Where do the frozen parity sets live** — repo fixtures (adds ~1–3 MB of
   JPEGs) vs CI artifact bucket?  Needs a repo-policy call.
