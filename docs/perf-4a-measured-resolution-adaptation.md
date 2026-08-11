# Perf 4a — Opt-in, measured resolution adaptation for finalize()

**Status:** spec, ready for review. Written 2026-08-03 as the structural
replacement for the RAM-keyed resolution cut in commit `7df2dba`
(`fix/RN0.79.X_optimize_process_time`), which the adversarial review rejected
and Phase 1 removes. Every factual claim below is pinned to a `file:line`
verified at `7df2dba`; if you change the code, update the citation.

**Depends on:** Phase 0 (finalize telemetry — `timings` block) for its gating
signal and its verification plan; Phase 1 (removal of the RAM-keyed cut) for
its insertion point. See §9.

---

## 1. Summary

Replace the removed always-on, RAM-keyed resolution cut with an **opt-in,
measured, floor-protected** adaptation:

- Fires only when the host selects `adaptiveStitchMode: 'measured'` **and** a
  measured signal says the device is actually slow: a persisted rolling median
  of previous
  **per-keyframe** stitch wall times (normalized by the accepted keyframe
  count so the signal measures the device, not the capture size — §4.2;
  keyed by capture configuration, seeded from core count on first run)
  and/or thermal state at finalize start.
- Never cuts compositing below the host's floor — the downstream consumer runs
  object detection **on the panorama**, so output resolution is a correctness
  constraint, not a nice-to-have.
- Registration adaptation keys on measured registration-phase time and is
  floored just above the ~0.3 MP native size of default 640 px keyframes —
  i.e. **it is a no-op by construction on default captures** (§4.4).
- Every applied budget is reported in the finalize result (riding the Phase 0
  `timings` / structured-result surface) so hosts and telemetry see every cut.
- `refinePanorama` re-stitches receive the same budgets the original stitch
  applied (result carries them; refine passes them back — §4.7), closing a
  consistency gap that exists **today** independent of this feature.
- Opted-out hosts are bit-for-bit unaffected: the values reaching
  `nativeStitchFramePaths` are identical to the pre-branch defaults (§7.2).

Android-first. iOS gets the identical config/result surface now and an
implementation follow-up (§4.8) — its bridge currently hardcodes its budgets
and has no resolution parameters at all
(`ios/Sources/RNImageStitcher/OpenCVStitcher.mm:466-468`).

---

## 2. Motivation — what the review found wrong with the removed cut

Commit `7df2dba` added this block to `finalize()`
(`android/src/main/java/io/imagestitcher/rn/IncrementalStitcher.kt:894-923`):
on `totalMem <= 4 GB || isLowRamDevice`, pass `registrationResolMP=0.4` and
`compositingResolMP=0.6` to `stitchSync` (call at `:924-937`). The adversarial
review confirmed three defects, each of which shapes a requirement here:

1. **Wrong signal.** `totalMem` / `isLowRamDevice` measures RAM. The problem
   being fixed is stitch **wall time** under CPU contention/throttling. RAM is
   uncorrelated with that: a 4 GB device with a mid-tier SoC can stitch a
   6-keyframe set faster than a hot 8 GB device. The commit's own comment
   claims "cuts feature-matching CPU ~35%" (`IncrementalStitcher.kt:900`) —
   an unmeasured number attached to an unmeasured trigger.
   → **Requirement: gate on a measured time/thermal signal, never on RAM.**

2. **Placebo on default captures.** Default Android keyframes are 640 px long
   edge (`AR_KEYFRAME_MAX_LONG_EDGE = 640`,
   `android/src/main/java/io/imagestitcher/rn/ar/YuvImageConverter.kt:22`),
   i.e. ≤ 0.31 MP (640×480). cv::Stitcher's work scale is
   `min(1.0, sqrt(resolMP/frameMP))`, so any registration budget ≥ 0.31 MP —
   including the commit's 0.4 — performs **zero downscale**. The registration
   "cut" did nothing on every default capture.
   → **Requirement: say so explicitly, and don't pretend a registration cut is
   a lever below the keyframes' native size.**

3. **Silent quality cut where it did fire.** On `keyframeQualityCapture`
   sessions (1280 px long edge, 0.92–1.23 MP —
   `YuvImageConverter.kt:30,78-85`), `compose 1.0 → 0.6 MP` is a real ~23%
   linear resolution loss on the panorama the host runs OD on — applied
   unconditionally on ~half the fleet (estimated from the ≤ 4 GB /
   `isLowRamDevice` share of the device mix; unverified — no fleet telemetry
   existed pre-Phase-0), unreported in the result, and **not**
   applied by `refinePanorama` (which re-stitches at the `stitchSync` defaults
   — `IncrementalStitcher.kt:2076-2095` reads no `*ResolMP` config keys), so
   the refine tab produced a different-sized panorama than finalize.
   → **Requirements: host opt-in, explicit output floor, budgets in the
   result, refine reuses the same budgets.**

---

## 3. Current state (verified at `7df2dba`)

### 3.1 The stitch entry chain (Android)

- `IncrementalStitcher.finalize()` (`IncrementalStitcher.kt:692`) snapshots
  keyframe state, then on `workScope`
  (`CoroutineScope(Dispatchers.Default.limitedParallelism(1))`,
  `IncrementalStitcher.kt:323`) calls
  `BatchStitcher.stitchSync(...)` (`IncrementalStitcher.kt:924-937`) with
  `stitchMode="panorama"`, `useManualPipeline=false` ("high level across the
  board", `:936`).
- `BatchStitcher.stitchSync` (`android/src/main/java/io/imagestitcher/rn/BatchStitcher.kt:849-899`)
  has defaults `registrationResolMP = -1.0`, `seamEstimationResolMP = -1.0`,
  `compositingResolMP = 1.0` (`:863-865`) and forwards to JNI
  `nativeStitchFramePaths`.
- The JNI shim (`android/src/main/cpp/image_stitcher_jni.cpp:131-147`) copies
  the budgets into the shared `StitchConfig` (`:173-175`), **floors a
  sentinel registration at 0.6** (`:202-204`:
  `if (cfg.registrationResolMP <= 0.0) cfg.registrationResolMP = 0.6;`), and
  fills `availableRamMB` from `sysconf` (`:210-218`).
- `cpp/stitcher.cpp` pins `cv::setNumThreads(1)` on Android (`:602-608`,
  the v0.16.1 TLS-creep workaround) and routes to the high-level
  `cv::Stitcher` path (`useManualPipeline=false` branch).

### 3.2 Resolution handling inside the high-level C++ path

- Budgets applied at `cpp/stitcher.cpp:860-894`. Registration and seam are
  only set when `> 0` (`:867-872`).
- **The RAM-keyed compose fallback** (`:879-886`): when
  `config.compositingResolMP <= 0`, compose falls back to
  `totalRamMB >= 5 GB ? 1.0 : 0.6` (`kHighLevelComposeFallbackMP`). An
  explicit caller value `> 0` always wins (`:884-885`). Because Android's
  `stitchSync` default passes an explicit `1.0` and iOS hardcodes
  `cfg.compositingResolMP = 1.0` (`OpenCVStitcher.mm:468`), **this fallback is
  already dead on every RN-bridge path today** — it can only fire for a
  direct C++ caller that leaves the sentinel.
- **The retry ladder** (`:947-958`) escalates on failed attempts only:
  attempt 2 = `matchConf 0.25` + `regResol 1.0 MP`, attempt 3 = `0.20` /
  `1.3 MP`, PANORAMA-gated (`:984`), and **only raises** registration:
  `std::max(tune.regResolMP, config.registrationResolMP)` (`:993`).
- **The canvas-budget compose downscale** (`:1241-1250`): after
  `estimateTransform`, if the projected compose-scale canvas exceeds the RAM
  canvas budget and the overrun is ≤ 2×, the path silently calls
  `stitcher->setCompositingResol(targetMP)` with `targetMP = composeMP/over`.
  This is a second, *memory-safety* resolution cut that can undercut any
  caller value — today it is only visible in adb logs.
- Registration nondeterminism caveat: the file itself documents that
  cv::Stitcher registration is "NOT reproducible run-to-run" under
  multi-threaded BA + shared-RNG RANSAC (`:1079-1083`). On Android,
  `setNumThreads(1)` (`:602-608`) removes both sources; §7.2 verifies
  determinism before relying on byte-parity.

### 3.3 Keyframe geometry (why the no-op claim holds)

- Default 640 px long edge → ≤ 0.31 MP/frame (`YuvImageConverter.kt:22`).
- `keyframeQualityCapture` sessions: 1280 px → 0.92 MP (16:9) – 1.23 MP (4:3)
  (`YuvImageConverter.kt:30`; flipped via `setKeyframeQuality`, `:82-85`).
- Keyframe count: `keyframeMaxCount` config, default 6, clamped 3..10
  (`IncrementalStitcher.kt:452-453,487`).

### 3.4 Config plumbing available today

- `start(options)` carries a `config` map → `configOverrides`
  (`IncrementalStitcher.kt:434-435`), from which the batch stitch knobs are
  read and snapshotted (`:452-469`): `keyframeMaxCount`, `warperType`,
  `blenderType`, `seamFinderType`, `enableMaxInscribedRectCrop`,
  `stitchMode`. JS type: `IncrementalStartOptions.config?: Partial<StitcherConfig>`
  (`src/stitching/incremental.ts:434`).
- `finalize(options)` carries per-call values: `outputPath`, `quality`,
  `captureOrientation`, `imuTranslationMetres`, `lens`
  (`src/stitching/incremental.ts:924-957`).
- `refinePanorama(options.config)` (`IncrementalStitcher.kt:2019-2039`) reads
  warper/blender/seam/orientation/crop/mode/quality/pipeline — **no
  resolution keys**, so refine always runs at `stitchSync` defaults.
  JS type `IncrementalRefineOptions` (`src/stitching/incremental.ts:798-838`)
  likewise has no `*ResolMP` fields (its own doc comment at `:789-794`
  mentions them aspirationally; they were never added).

### 3.5 iOS (for the parity statement)

iOS finalize also runs the high-level path
(`IncrementalStitcher.swift:1640-1658`, `stitchMode:"panorama"`,
`useManualPipeline:false`) through its own bridge
`OpenCVStitcher.stitchFramePaths` — whose signature has **no resolution
parameters**; it hardcodes `registrationResolMP=0.6` / `compositingResolMP=1.0`
(`OpenCVStitcher.mm:466-468`) and plumbs `availableRamMB` (`:492-494`).
iOS `refinePanorama` (`IncrementalStitcher.swift:1883-1926`) mirrors Android's
config keys, also without resolution keys.

---

## 4. Design

### 4.1 Principle: policy in Kotlin, mechanics in C++, nothing silent

The adaptation decision is computed **once, in Kotlin, at finalize start** —
where PowerManager, SharedPreferences, and the capture configuration live —
and expressed as **explicit** `registrationResolMP` / `compositingResolMP`
values passed to `stitchSync`. C++ stays a deterministic function of its
config. This is the same insertion point the reverted commit used; the
difference is the trigger, the floor, the reporting, and the refine plumbing.

**C++ interplay decision:** the adaptation always passes explicit values
(adapted or the defaults `-1.0`/`1.0`), so the high-level path's own
`>=5GB ? 1.0 : 0.6` compose fallback (`stitcher.cpp:879-886`) stays dead on
every RN path — exactly as it is today (§3.2). We deliberately do **not**
delete the C++ fallback: it is defense-in-depth for non-RN C++ callers, and
deleting it would be an unrelated behavior change for them. Single source of
truth for RN callers = the Kotlin policy. Documented here so nobody
re-discovers the "two places set compose" question.

The one C++ change is **reporting**: the canvas-budget downscale
(`stitcher.cpp:1241-1250`) must stop being adb-log-only. It appends
`composeMPEffective=<final compositingResol>` to the existing
`debugSummary` side-channel (read via `nativeLastDebugSummary`,
`BatchStitcher.kt:897`) so Kotlin can surface a floor breach (§4.6). This is
additive telemetry — no output pixels change.

### 4.2 Gating signal A — persisted rolling median of per-keyframe stitch wall time

- **Store:** `SharedPreferences` file `rn-image-stitcher.adaptive-stitch`
  (new; the library currently uses no prefs — verified by grep). Per key,
  **two independent rolling windows plus persisted state**:
  - `defaultEntries` — last **5** entries recorded from default-budget runs
    (including probes, §4.5),
  - `adaptedEntries` — last **5** entries recorded from adapted-budget runs,
  - `fired: boolean` + `probeCounter: int` — the persisted signal-A state
    machine (§4.5).
  Each entry: `{wallMs, registrationMs, acceptedCount, timestamp}`. The
  windows evict independently — adapted runs can never push out the
  default-budget history the enter/exit decisions depend on.
- **Key (capture-configuration fingerprint):**
  `v1|longEdge=<measured px>|kfMax=<keyframeMaxCount>`. The long edge is
  **measured, verbatim, not an enum**: read from the accepted keyframes'
  JPEG headers at finalize (`BitmapFactory.Options.inJustDecodeBounds` — no
  full decode) so the fingerprint reflects what was *actually captured*, not
  what a prop claims. 640/1280 are only the AR-path budgets
  (`YuvImageConverter.kt:22,30`); non-AR frame-processor captures are not
  constrained to them, and `keyframeMaxLongEdge` is `@Volatile` and
  RNSARSession-flippable mid-session (`YuvImageConverter.kt:78-85`), so
  **mixed-size snapshots exist**. Mixed-size rule: the key uses the **max**
  long edge across the snapshot (all ≤ 10 headers are read; ~1 ms each,
  expected — measured in §7.4) — max, because the largest frames dominate
  registration/compose cost and understating the key would pollute the
  smaller-capture bucket. A change in capture configuration lands on a
  different key, which **is** the invalidation: history never crosses
  configurations.
- **Normalization — measure the device, not the capture.** The accepted
  keyframe count varies per capture (gate `maxCount` clamped 3..10,
  `IncrementalStitcher.kt:487`; a short pan accepts fewer than the budget),
  and full-pairwise matching cost grows superlinearly with count — raw
  `wallMs` conflates "slow device" with "big capture", and a 3-frame and a
  6-frame capture would otherwise share a key with wildly different wall
  times. The decision median is therefore computed over **per-keyframe wall
  time**, `wallMs / acceptedCount`. Raw `wallMs` + `acceptedCount` are
  stored and the division happens at read time, so §7.4 calibration can
  revisit the model without a store migration. Honest residual: dividing by
  N under-corrects the O(N²) pairwise-matching term, so unusually large
  captures still bias per-keyframe ms upward; the §7.4 matrix records
  per-count data to decide whether a pair-count normalization is warranted
  (open question, §11).
- **What is recorded — and what never is:**
  - Recording happens only on the success path, after `stitchSync` returns:
    `stitchSync` **throws** on stitch failure (`BatchStitcher.kt:842-848`)
    and the finalize catch rejects the promise
    (`IncrementalStitcher.kt:1005-1006`). **Errored finalizes are never
    recorded** — a failed run's wall time measures the retry ladder walking
    every attempt to defeat, not device speed.
  - **Ladder-escalated successes (`finalAttempt > 1`) are never recorded
    either.** Attempts 2/3 re-run full registration with regResol raised to
    1.0/1.3 MP on scene-hard captures (`stitcher.cpp:947-958,993`) —
    scene-dependent inflation, not device slowness. Escalation detection:
    primary = the attempt field in Phase 0's `timings` block; fallback (if
    Phase 0's frozen schema omits it) = `finalConfidenceThresh`, already
    surfaced to Kotlin via `dims[4]` (`IncrementalStitcher.kt:951-952`) —
    finalize runs PANORAMA and the ladder's thresholds are attempt-unique
    (1.0 / 0.5 / 0.3, `stitcher.cpp:954-957`), so `finalConfidenceThresh
    < 1.0` ⇒ escalated. A device whose captures *always* escalate accrues no
    history and keeps its seed — accepted: those captures are scene-limited,
    not budget-limited, and cutting resolution would not help them.
  - Entries are tagged by the budgets the run actually used: default-budget
    runs (including opted-out runs and probes) append to `defaultEntries`;
    adapted runs append to `adaptedEntries`.
  - **Recording (and the header read) is unconditional on opt-in** — an
    opted-out finalize still records its default-budget entry, so a host
    that opts in later starts from measured history instead of the
    core-count seed, and continuously refreshes `defaultEntries` for free.
    Thermal queries and the policy evaluation are skipped when opted out.
    §7.2 states precisely what "untouched" means for the opted-out fleet:
    output-untouched, not side-effect-free.
- **Median:** rolling median of the ≤ 5 `defaultEntries` per-keyframe
  values (`wallMs / acceptedCount`). Adapted entries never feed the
  enter/exit decision (§4.5); they exist for telemetry and for measuring the
  real adapted-vs-default speedup ratio in §7.4.
- **Seed (first run, empty `defaultEntries`):** derived from
  `Runtime.getRuntime().availableProcessors()` so an obviously weak device
  doesn't need N slow stitches before help arrives — per-keyframe values to
  match the normalized threshold:
  - ≤ 4 cores → seed median 1300 ms/keyframe (fires against the default
    threshold)
  - 5–6 cores → 850 ms/keyframe (does not fire)
  - ≥ 7 cores → 450 ms/keyframe (does not fire)
  The seed is consulted only while `defaultEntries` is empty (with 1–2 real
  entries, the median of what exists decides — the seed is already
  retired); it is never written. All three numbers are **estimated** and are
  a calibration deliverable of the device matrix (§7.4), validated against
  Phase 0 `stitchWallMs` / `acceptedCount`.
- **Measurement source:** Phase 0's `timings.stitchWallMs`, its
  registration-phase time (per-cv-phase field covering `estimateTransform`),
  its keyframe count, and its attempt field (exact names owned by the
  Phase 0 spec — §9; `acceptedCount` additionally already exists on the
  finalize result today, `IncrementalStitcher.kt:956`). Until Phase 0 lands,
  this spec cannot ship (hard dependency): we will not re-introduce a
  second, private timing measurement.

**Threshold:** fires when
`medianWallMsPerKeyframe > adaptiveSlowStitchMsPerFrame`
(default **1000 ms/keyframe** — the previous draft's 6000 ms absolute
threshold at the reference 6-keyframe budget; host-overridable). Estimated;
calibrate in §7.4.

### 4.3 Gating signal B — thermal state at finalize start (API-gated)

Read once at finalize entry, Android only:

- API ≥ 30: `PowerManager.getThermalHeadroom(forecastSeconds=15)`; treat
  `headroom >= 0.95` as hot. `NaN`/unsupported → signal absent.
- API 29: `PowerManager.getCurrentThermalStatus() >= THERMAL_STATUS_SEVERE`.
- API < 29 (`minSdkVersion 24`, `android/build.gradle:69`): signal absent.

Combination: adaptation fires on **A OR B** (a throttled fast phone *is* a
slow phone right now), and the result reports which signal(s) fired. Signal
B is **instantaneous and per-finalize**: a thermal-only fire adapts *this*
run (its entry lands in `adaptedEntries`) but never sets the persisted
`fired` state — only signal A's median does (§4.5) — so a transient hot
spell cannot latch a fast device into the adapted regime. Both thresholds
are **estimated** pending §7.4.

**Why not RAM (explicit non-signal):** `totalMem`/`isLowRamDevice` is what
the removed cut used. It neither predicts wall time (the thing being fixed)
nor correlates with the CPU contention/throttling this branch targets; and on
default 640 px captures the registration cut it drove was a measured no-op
(§2.2). RAM safety is already handled downstream by purpose-built guards:
the pre-stitch headroom abort (`stitcher.cpp:911-924`) and the canvas-budget
downscale (`:1241-1250`).

### 4.4 What is cut, and the floors

When the gate fires, in the (Phase-1-reverted) finalize call site:

| Budget | Default (opted-out) | Adapted | Floor |
|---|---|---|---|
| `compositingResolMP` | `1.0` (explicit, `BatchStitcher.kt:865`) | `max(adaptiveMinOutputMP, 0.6)` | `adaptiveMinOutputMP`, hard |
| `registrationResolMP` | `-1.0` → JNI floors to `0.6` (`image_stitcher_jni.cpp:202-204`) | `0.4`, only when the **registration-phase** per-keyframe median exceeds `adaptiveSlowRegistrationMsPerFrame` (default 350 ms/keyframe, estimated) | `0.35` MP, hard |

- **Compose floor semantics.** `compositingResolMP` is a *per-frame* budget;
  the panorama canvas is the union of the warped frames, so the composed
  output area is ≥ one compose-scale frame area. Flooring the per-frame
  budget at `adaptiveMinOutputMP` therefore guarantees output MP ≳
  `min(native frame MP, adaptiveMinOutputMP)` — a sound lower bound, with
  two honest caveats reported rather than hidden: (a) the inscribed-rect /
  bbox crop can trim the final image below the pre-crop bound; (b) the C++
  canvas-budget downscale (§3.2) can cut compose below the floor **for memory
  safety** — that guard stays authoritative (a smaller panorama beats an lmkd
  kill), but the breach is now surfaced (`floorBreached`, §4.6) so the host
  can prompt a re-capture instead of silently feeding OD a soft panorama.
  If `adaptiveMinOutputMP >= 1.0`, compose adaptation is a structural no-op —
  allowed; registration may still adapt.
- **Registration floor + the no-op-by-construction statement.** Default
  captures are ≤ 0.31 MP native (§3.3); cv::Stitcher never upscales
  (`work_scale = min(1, sqrt(resolMP/frameMP))`), so both the adapted 0.4 and
  the 0.35 floor perform zero downscale there — **on default captures the
  registration adaptation is a documented no-op by construction**, and the
  result reports it as applied-but-ineffective (`registrationEffective:
  false`) rather than pretending it helped. It is a real lever only on
  1280 px `keyframeQualityCapture` sessions (0.6 → 0.4 ≈ 18% linear working-
  image reduction — estimated, to be measured via the Phase 0 registration-
  phase field).
- **The registration adaptation never fires without measured registration
  history.** There is no registration-phase seed (§4.2 seeds `wallMs` only)
  and no thermal path to it: it requires ≥ 3 `defaultEntries` with a
  measured `registrationMs` under the key. A seeded first fire or a
  thermal-only fire is therefore **compose-only**, with registration left at
  the default — implicit in the previous draft, now stated; §7.1's truth
  table gains the case.
- **Interplay with the retry ladder:** attempts 2/3 raise registration via
  `max(tune.regResolMP, config.registrationResolMP)` (`stitcher.cpp:993`), so
  an adapted (lower) registration never weakens the failure-rescue path — the
  ladder still escalates to 1.0/1.3 MP. Rescue beats speed; unchanged and
  intentional.
- `seamEstimationResolMP` is untouched (default 0.1 MP is already the cheap
  phase) — non-goal (§10).

### 4.5 Hysteresis & recovery (no flapping, no lock-in)

The persisted per-key state is explicit: `fired: boolean` and
`probeCounter: int`, stored alongside the two entry windows (§4.2). The
state machine, opted-in path only (opted-out runs record entries but never
read or write `fired`):

- **Not fired (default regime).** Finalizes run at default budgets (unless
  thermal, §4.3) and append to `defaultEntries`. **Enter:** when the
  `defaultEntries` per-keyframe median (or the core-count seed while
  `defaultEntries` is empty; with 1–2 real entries the median of what
  exists decides — §4.2) exceeds `adaptiveSlowStitchMsPerFrame`, set
  `fired = true`.
- **Fired (adapted regime).** Finalizes run at adapted budgets and append to
  `adaptedEntries` — **except the probe**: every 5th fired finalize
  (`probeCounter`; `kProbeEveryN = 5`, internal constant) deliberately runs
  at **default budgets**, appends a fresh default-tagged entry, and reports
  itself (`probe: true` in `appliedBudgets`) so the host knows this capture
  traded speed for re-measurement. A probe is deferred to the next cadence
  slot when thermal signal B is hot at finalize start (a throttled default
  measurement would only re-confirm slowness while making the user wait).
  Probes are what keep the default-budget signal alive: once fired, ordinary
  runs are all adapted-tagged, and on a seeded-fire device `defaultEntries`
  may have started empty — without probes the enter/exit median would lose
  its data source permanently.
- **Exit:** when the `defaultEntries` per-keyframe median — which, while
  fired, refreshes only via probes (and any opted-out runs) — drops below
  `0.8 × adaptiveSlowStitchMsPerFrame`, clear `fired` and resume the default
  regime. The exit criterion is deliberately stated **relative to the enter
  threshold** and evaluated on **default-budget measurements**, never on
  adapted wall times: the adaptation's own expected saving (~30–45%,
  estimated, §7.4 measures it) means an adapted median can sit below any
  fixed absolute band forever without the device ever being fast at
  defaults. (The previous draft's exit — adapted median < 0.4 ×
  `adaptiveSlowStitchMs` — was structurally near-unreachable: a device
  firing at ~6–7 s stitches adapted at ~3.5–5 s and would have been locked
  into reduced resolution permanently. Lock-in, not oscillation, was the
  real failure mode; both are named in §8.)
- **`adaptedEntries` feed no decision.** They exist for telemetry and for
  §7.4's measurement of the real adapted-vs-default speedup ratio per key.
  No minimum count is required on them — the previous draft's "last 3
  adapted entries" requirement is gone along with the criterion that needed
  it.

Enter at 1.0×, exit at 0.8× is the anti-flap band; the 0.8 margin and the
probe cadence are estimated, calibrated in §7.4.

### 4.6 Reporting — every cut is visible

The finalize result (and refine result) gains a structured block, riding the
Phase 0 result extension:

```ts
appliedBudgets: {
  registrationResolMP: number;      // value passed to native (-1 = default→0.6)
  compositingResolMP: number;       // value passed to native
  composeMPEffective?: number;      // parsed from debugSummary; differs only
                                    // when the C++ canvas guard downscaled
  // 'default' | 'adapted' on finalize; 'caller' | 'default' on refine
  // ('caller' = the host passed resolution keys back — §4.7; refine never
  // runs the adaptation policy, so 'adapted' never appears on it).
  source: 'default' | 'adapted' | 'caller';
  adaptationFired: boolean;         // always false on refine results
  probe?: boolean;                  // fired-state finalize that ran at
                                    // defaults to re-measure (§4.5)
  adaptationReason?: 'median' | 'thermal' | 'median+thermal';
  medianStitchMsPerKeyframe?: number; // the median that drove the decision
  seededFromCores?: boolean;        // true while defaultEntries was empty
  thermalStatus?: number;           // getCurrentThermalStatus, when available
  thermalHeadroom?: number;         // getThermalHeadroom(15), when available
  floorMP?: number;                 // adaptiveMinOutputMP, when opted in
  composeClampedByFloor?: boolean;  // floor raised the adapted compose value
  floorBreached?: boolean;          // composeMPEffective < floorMP (C++ guard)
  registrationEffective?: boolean;  // false when keyframes ≤ budget (no-op)
}
```

The adaptation-only fields (`probe`, `adaptationReason`,
`medianStitchMsPerKeyframe`, `seededFromCores`, `thermal*`) are **never
present on refine results** — refine does not run the policy; its block
reports only what was actually passed to native and where it came from
(§4.7).

`appliedBudgets` is **always present on Android** (opted-out hosts see
`source:'default', adaptationFired:false`) so telemetry can prove the
opted-out fleet is **output-untouched**, not merely assume it — the budgets
reaching native are the pre-branch defaults. ("Untouched" means output, not
side-effect-free: opted-out runs still record timing history, §4.2/§7.2.)
Absent on iOS until the follow-up (§4.8) — hosts feature-detect by presence.

### 4.7 refinePanorama budget consistency

Chosen plumbing: **the result carries the budgets; the refine call passes
them back.** Concretely:

- `IncrementalRefineOptions` gains optional `registrationResolMP` /
  `compositingResolMP` (`src/stitching/incremental.ts:798-838`); Kotlin
  `refinePanorama` reads them from `config` (`IncrementalStitcher.kt:2019-2039`)
  and forwards to `stitchSync` (`:2076-2095`) instead of today's implicit
  defaults; the refine result carries its own `appliedBudgets`.
- **Refine `appliedBudgets` semantics (defined, not echoed):** refine never
  runs the adaptation policy. Its block reports the values *actually passed
  to native* with `source: 'caller'` when the host supplied the keys and
  `source: 'default'` when they were absent; `adaptationFired` is always
  `false`, and the adaptation-only fields are never present (§4.6). This
  keeps the §7.3 identical-dims assertion and telemetry consumers reading a
  well-defined block rather than an ambiguous echo.
- Host contract, documented on both types: pass
  `finalizeResult.appliedBudgets.{registrationResolMP,compositingResolMP}`
  into `refinePanorama`'s config. The SDK docstring includes the two-line
  snippet.

Why not native per-session persistence: refine can legitimately run after a
process restart (the keyframe JPEGs persist on disk and the finalize result —
including `batchKeyframePaths`, `IncrementalStitcher.kt:978-980` — is what the
host stored). In-memory session state would silently miss exactly that case;
result-carried budgets survive anywhere the host can store the result. This
also fixes the **pre-existing** finalize-vs-refine divergence noted in §2.3
for opted-in hosts, and leaves opted-out refine behavior byte-identical
(absent keys → today's defaults).

### 4.8 iOS: identical surface, implementation follow-up

- The JS config keys, result block, and refine keys are specced platform-
  neutral; the TS types and docs land now.
- iOS implementation is a **separate follow-up**: extend the
  `OpenCVStitcher.stitchFramePaths` signature with the two resolution
  parameters (today hardcoded, `OpenCVStitcher.mm:466-468`), port the policy
  object (ProcessInfo.thermalState is the iOS thermal analog;
  UserDefaults the store), and emit `appliedBudgets`. Until then iOS parses
  and ignores the config keys with a single `os_log` notice, returns no
  `appliedBudgets`, and its output is unchanged. The iOS stitcher shares
  `cpp/stitcher.cpp` but its finalize orchestration/bridge is separate
  (`IncrementalStitcher.swift:1640-1658`), so nothing in the Android change
  set touches iOS output pixels.

---

## 5. API / config surface changes

### 5.1 `start(options.config)` — the chosen plumbing (with rationale)

New flat keys in the existing `config` map (`configOverrides`,
`IncrementalStitcher.kt:434-469`):

```ts
// StitcherConfig additions (all optional)
// AS SHIPPED (perf-4a focused build), the original boolean opt-in was
// generalized to a 3-position mode so a DETERMINISTIC cut is available for a
// clean field A/B alongside the measured/self-tuning path:
adaptiveStitchMode?: 'off' | 'always' | 'measured'; // default 'off'
                                              // 'always' = deterministic cut
                                              // 'measured' = self-tuning
adaptiveMinOutputMP?: number;         // floor MP; default 0.6, clamped [0.6,1.0]
adaptiveSlowStitchMsPerFrame?: number;        // default 1000 ms/keyframe
                                              // ('measured' only; §4.2)
// Deferred (registration adaptation + thermal — see notes below):
// adaptiveSlowRegistrationMsPerFrame?: number;  // default 350 (§4.4)
```

The stitch threshold is per-accepted-keyframe (§4.2's normalization) — an
absolute-ms threshold would conflate device slowness with capture size.

As shipped, rather than rejecting a missing floor, `adaptiveMinOutputMP` is
clamped to `[0.6, 1.0]` at read (0.6 = hard OD/OCR floor, 1.0 = no-op), so a
cut can never silently exceed the default budget or drop below the OD/OCR
minimum. Values are snapshotted into `batch*` fields at start like every other
knob.

**Why `start().config` and not the alternatives considered:**

- *`finalize()` options* — finalize's options are per-call physical facts
  (orientation, lens, IMU translation; `incremental.ts:924-957`). The
  adaptation is a capture-session policy, decided by the same host code that
  sets `keyframeMaxCount`/`stitchMode`; splitting policy across two call
  sites invites a host passing the floor on one path and not the other.
  Also, the history fingerprint depends on capture config fixed at start.
- *Stitcher settings / a module-global setter* — nothing else in this SDK
  uses process-global mutable config; a global would leak policy across
  concurrent hosts/screens and is untestable per-capture.
- `start().config` is where every other cv::Stitcher knob already flows
  (V16 pattern, `IncrementalStitcher.kt:452-469`), keeps the native finalize
  signature stable, and refine symmetry comes via §4.7.

### 5.2 Result surfaces

- `IncrementalFinalizeResult` (`incremental.ts:667-761`) +=
  `appliedBudgets` (§4.6).
- `IncrementalRefineResult` (`incremental.ts:846-868`) += `appliedBudgets` —
  with the refine-specific semantics of §4.7: `source: 'caller' | 'default'`
  reflecting what was passed to native, `adaptationFired: false` always,
  adaptation-only fields absent. The TS doc comment on the type states this.
- `IncrementalRefineOptions` (`incremental.ts:798-838`) +=
  `registrationResolMP?`, `compositingResolMP?`.

### 5.3 Explicit non-surface

No new event, no new native method, no `finalize()` signature change, no
change to `stitchSync`'s parameter list (it already accepts both budgets,
`BatchStitcher.kt:863-865`), no JNI signature change
(`image_stitcher_jni.cpp:131-147` already carries them).

---

## 6. Implementation plan (ordered; per-platform; files touched)

**Android / shared TS — the shippable unit:**

1. **`AdaptiveStitchPolicy.kt`** (new,
   `android/src/main/java/io/imagestitcher/rn/AdaptiveStitchPolicy.kt`) —
   pure function: `(optIn, minOutputMP, medianWallMsPerKeyframe,
   medianRegistrationMsPerKeyframe?, registrationEntryCount,
   thermalStatus?, thermalHeadroom?, seededFromCores, firedState,
   probeCounter, keyframeLongEdge, thresholds) → Decision{regMP, composeMP,
   fired, probe, reason, clampedByFloor, registrationEffective,
   nextFiredState, nextProbeCounter}`. The state transition is part of the
   pure function's output (§4.5's machine), so enter/exit/probe are all
   JVM-unit-testable. No Android types in the signature.
2. **`StitchTimeStore.kt`** (new, same package) — fingerprint keying
   (measured max long edge, §4.2), the two independent 5-entry windows
   (`defaultEntries` / `adaptedEntries`), the persisted `fired` +
   `probeCounter` state, per-keyframe median (raw `wallMs` +
   `acceptedCount` stored, division at read time), core-count seeding,
   escalated/errored-run exclusion at the record API — behind a small
   interface over `SharedPreferences` for testability.
3. **Config parsing + validation** — `IncrementalStitcher.kt:434-469` block:
   read the four keys, snapshot to `batchAdaptive*` fields, reject invalid
   opt-in (§5.1).
4. **Finalize integration** — at the stitchSync call site (post-Phase-1
   revert; today `IncrementalStitcher.kt:924-937`): read the keyframe long
   edges (header-only decode of **every** path in `keyframePathsSnapshot`,
   max rule — §4.2); when opted in, query thermal (API-gated, §4.3), consult
   the store, run the policy (incl. probe cadence, §4.5), pass explicit
   budgets, and build `appliedBudgets` into the result map. **Recording is
   unconditional on opt-in**: after a *successful*, *non-escalated* stitch
   (success = `stitchSync` returned rather than threw,
   `IncrementalStitcher.kt:1005-1006`; non-escalated = attempt 1 per the
   §4.2 detection), record `{wallMs, registrationMs, acceptedCount}` from
   the Phase 0 timings into the window matching the budgets used. The prefs
   write happens after the stitch, off the result path. When opted out:
   header read + recording only — no thermal query, no policy evaluation, no
   `fired`/`probeCounter` access. One `Log.i` line mirroring the result
   block.
5. **Refine passthrough** — `IncrementalStitcher.kt:2019-2039`: read the two
   new config keys, forward at `:2076-2095`, emit `appliedBudgets` in the
   refine result.
6. **C++ reporting** — `cpp/stitcher.cpp:1241-1250`: append
   `composeMPEffective=%.2f` to `result.debugSummary` when the canvas guard
   downscales (and, for symmetry, the final `compositingResol()` on success);
   Kotlin parses it into `appliedBudgets.composeMPEffective` /
   `floorBreached`. Additive; no pixel change. Coordinate the key name with
   the Phase 0 telemetry spec so it lands once.
7. **TS types + docs** — `src/stitching/incremental.ts` (types in §5),
   docstrings including the refine passback snippet; CHANGELOG.

**iOS (follow-up, separate change set — §4.8):**

8. `OpenCVStitcher.h/.mm` signature + `IncrementalStitcher.swift` policy port
   (ProcessInfo.thermalState, UserDefaults store) + `appliedBudgets` in
   `FinalizePayload`-derived results. Until it lands: parse-and-log stub only.

Ordering constraint: 1–2 land with their unit tests first (reviewable without
device); 3–5 are one commit (config without effect or effect without config
are both broken intermediate states); 6 can land independently before or
after; 7 rides 3–5.

---

## 7. Verification & gates

Every perf number in this spec is **estimated** until the device matrix run;
the measured source of truth is the Phase 0 `timings` block
(`stitchWallMs`, the registration-phase field, keyframe count/dims, budgets
applied — exact names owned by the Phase 0 spec).

### 7.1 Unit (JVM, no device)

- Policy truth table: opted-out → defaults regardless of signals; opted-in +
  fast median + cool → defaults; slow median → adapted with floor clamps
  (`minOutputMP` above/below 0.6; ≥ 1.0 → compose no-op); thermal-only fire
  (adapts the run, does **not** set persisted `fired`); API-level gating
  (absent thermal → median-only); registration cut only when the
  registration per-keyframe median exceeds its threshold **and ≥ 3 measured
  registration entries exist — seeded-fire and thermal-only fire are
  compose-only (§4.4)**; `registrationEffective=false` when
  `keyframeLongEdge=640`; hysteresis enter (1.0×) / exit (0.8×) bands;
  probe cadence (every 5th fired run → default budgets, `probe:true`;
  deferred when thermal-hot).
- Normalization: same per-keyframe median from `{wallMs=3000,
  acceptedCount=3}` and `{wallMs=6000, acceptedCount=6}` (both 1000
  ms/keyframe); a raw-6000ms 6-frame entry does not fire what a raw-3000ms
  3-frame entry wouldn't.
- Recording exclusions (store API level): an escalated run
  (`attempt > 1` / `finalConfidenceThresh < 1.0`) is not recorded; the
  errored path never reaches the record call (asserted structurally: record
  sits after `stitchSync` on the success branch).
- Store: fingerprint isolation (measured-long-edge variants incl. non-AR
  sizes, kfMax variants), **mixed-size snapshot → max-long-edge key**,
  window truncation at 5, **independent eviction** (5 adapted appends leave
  `defaultEntries` intact), default-window-only median selection, core-count
  seed table (per-keyframe values), seed-not-written invariant, seed retired
  once ≥ 1 real entry exists, `fired`/`probeCounter` persistence round-trip.
- Hysteresis/recovery: seeded-fire device with empty `defaultEntries` →
  probes populate the default window → exit when the probe median lands
  under 0.8×; fired state with < 5 entries anywhere behaves (no
  minimum-count requirement on `adaptedEntries`).
- Config validation: opt-in without floor rejects; refine passthrough
  defaults when keys absent; refine `appliedBudgets.source` is
  `'caller'`/`'default'` per §4.7 with `adaptationFired:false`.

### 7.2 Output-parity gate — opted-out hosts are byte-identical (blocking)

Structural guarantee first, pixels second:

1. **Config-boundary assertion.** Instrumented (debug-build) log of the exact
   arguments reaching `nativeStitchFramePaths`. An opted-out finalize must
   pass `registrationResolMP=-1.0, compositingResolMP=1.0` — the pre-branch
   `stitchSync` defaults (`BatchStitcher.kt:863-865`). This is asserted in an
   instrumentation test, not eyeballed. Scope of the guarantee: opted-out
   parity is **output parity** — the values reaching native and the output
   pixels are unchanged. It is deliberately *not* side-effect-free: an
   opted-out finalize still reads the keyframe JPEG headers and records its
   timing entry into SharedPreferences (§4.2 — that is what makes a later
   opt-in immediately measured), but performs no thermal query and no policy
   evaluation. The instrumentation test asserts both halves: default budgets
   at the native boundary, and a `defaultEntries` append in the store.
2. **Determinism pre-check.** Stitch a frozen 6-keyframe set (device-captured
   once, kept under `parity-baselines/` per the phase-7 convention,
   `docs/phase-7-parity-gate.md`) **twice on the same build**. Expected
   byte-identical on Android (single-threaded BA + per-thread RNG under
   `setNumThreads(1)`, `stitcher.cpp:602-608`) despite the general
   nondeterminism caveat at `stitcher.cpp:1079-1083`. If not byte-stable,
   record that and fall back to the SSIM criterion below for step 3.
3. **Before/after.** Same frozen set, build without vs with this change,
   opted out: byte-compare (`cmp`); fallback criterion identical dims +
   `scripts/ssim-compare.py` ≥ 0.999 (stricter than the 0.98 release gate —
   this is the *same input, same config* case). Repeat opted-in on a fast
   device (budgets = defaults → same expectation).
4. **Refine parity.** Opted-out `refinePanorama` on the frozen set, before vs
   after: same criterion (absent config keys must not change behavior).

### 7.3 Adapted-output gate (opted-in, fired)

- Frozen 1280 px quality-capture set, forced-fire (test hook: threshold
  override via `adaptiveSlowStitchMsPerFrame=1`): output dims must satisfy
  `W×H ≥ adaptiveMinOutputMP` (pre-crop bound caveat documented §4.4);
  `appliedBudgets` reflects the cut; refine with passed-back budgets returns
  **identical dims** to finalize, and its `appliedBudgets` reads
  `source:'caller'` with the passed values (§4.7 semantics — well-defined,
  not an echo).
- Floor-breach path: a wide-canvas set that trips the C++ canvas guard →
  `floorBreached=true` surfaces (may require a synthetic low-`availableRamMB`
  debug hook; if impractical, verify the `composeMPEffective` parse against a
  captured `debugSummary` string in a unit test and mark the on-device breach
  cell "best-effort").

### 7.4 On-device matrix (device-verify points)

| Cell | Device | Verify |
|---|---|---|
| Slow | 4-core / ≤4 GB Android (or preheated device at `THERMAL_STATUS_SEVERE`) | Fires (correct `reason`); floor respected; Phase 0 `stitchWallMs` delta recorded — this converts the estimated "compose 1.0→0.6 saves ~X%" and the §4.5 "~30–45% adapted saving" into measured adapted-vs-default ratios (from the paired `adaptedEntries`/probe data); recovery: after cooldown, probes (every 5th capture, `probe:true` visible in results) refresh the default median and the policy exits — verify exit occurs, i.e. no lock-in |
| Fast | Galaxy A35 / Pixel-class | Never fires across ≥ 5 consecutive captures (median stays under threshold); seed (≥ 7 cores) does not fire on first run; short-pan (3-keyframe) captures interleaved with full 6-keyframe captures do not shift the per-keyframe median (normalization check) |
| Both | — | Threshold + seed-table + 0.8× exit-band + probe-cadence calibration (§4.2/§4.3/§4.5), recorded in this doc's revision; per-`acceptedCount` wall-time data collected to decide the pair-count-normalization open question (§11) |

Native-code device-verify points: thermal API behavior on API 29/30/34
handsets (NaN handling), header-only keyframe-dims read cost (expected
< 1 ms, measured), `debugSummary` round-trip of `composeMPEffective`.

---

## 8. Risks & mitigations

| Risk | Mitigation | Structural fix behind it |
|---|---|---|
| **Lock-in**: once fired, ordinary runs are adapted-tagged and would starve the default-budget signal — the device never re-measures defaults and stays at reduced resolution forever (the primary failure mode of the previous draft's adapted-median exit, §4.5) | Periodic default-budget probe (every 5th fired finalize) keeps `defaultEntries` fresh; exit stated relative to the enter threshold and evaluated on those probe measurements | Two independent entry windows + probe cadence (§4.2/§4.5) — the enter/exit signal always has a live data source |
| Oscillation between adapted/default across captures | Hysteresis band: enter at 1.0×, exit at 0.8× of `adaptiveSlowStitchMsPerFrame` (§4.5) | Signal separation: enter/exit only ever measured at default budgets |
| Workload leaks into the device signal (big captures / hard scenes inflate the median) | Per-keyframe normalization; escalated (`finalAttempt > 1`) and errored runs never recorded (§4.2) | Store keyed on capture config + normalized by measured `acceptedCount`; residual O(N²) bias named and calibrated in §7.4 |
| Host forgets to pass budgets back to refine → size-inconsistent re-stitch | Documented contract + `appliedBudgets` on both results makes divergence visible in telemetry | Result-carried budgets (§4.7); a JS auto-passthrough wrapper is listed as an open question, not assumed |
| C++ canvas guard cuts below the host's floor | `floorBreached` reported; memory-safety stays authoritative | The guard is the structural OOM fix (`stitcher.cpp:1241-1250`); this spec adds visibility, not a bypass |
| Thresholds mis-calibrated (fires on healthy devices / never fires on slow ones) | All thresholds host-overridable; defaults marked estimated; §7.4 calibration is a blocking deliverable | Gating on the measured Phase 0 signal rather than any device-class proxy |
| Stale history after OS upgrade / thermal-paste-degradation drift | Rolling window of 5 self-heals in ≤ 5 default-budget captures (≤ 5 × probe cadence while fired, since only probes refresh `defaultEntries` then) | Windowed median, not lifetime average |
| Phase 0 field names drift from this spec | §9 names Phase 0 as the owner; this spec binds to semantics, not names | Single telemetry source of truth |
| Registration cut regresses stitch success on weak-overlap scenes | Retry ladder still escalates to 1.0/1.3 MP regardless of the adapted value (`stitcher.cpp:993`) | Ladder raise-only semantics preserved |

## 9. Dependencies & sequencing

- **Phase 0 (telemetry) — hard dependency.** The store records Phase 0's
  measured `stitchWallMs` / registration-phase ms; `appliedBudgets` rides the
  Phase 0 result extension; §7's gates read Phase 0 fields. This spec must
  not introduce a parallel timing system. Field names are owned by Phase 0;
  this doc binds to semantics.
- **Phase 1 (reverts) — sequencing dependency.** Phase 1 removes the RAM-keyed
  block (`IncrementalStitcher.kt:894-923`) and restores `-1.0/1.0` defaults;
  this spec's step 4 edits that exact call site. Land after Phase 1 (or
  rebase onto it) — never both active (double adaptation).
- **Within this spec:** steps 1–2 → 3–5 (atomic) → 7; 6 independent; 8 (iOS)
  after the Android unit ships and its calibration numbers exist.

## 10. Non-goals

- iOS implementation (surface only; follow-up §4.8).
- The manual pipeline (`stitchFramePathsManual`) and its 0.3/0.6 defaults
  (`stitcher.cpp:1767-1778`) — finalize runs high-level on both platforms
  (`IncrementalStitcher.kt:936`, `IncrementalStitcher.swift:1657`).
- Changing keyframe capture budgets (640/1280, `YuvImageConverter.kt:22,30`)
  or the keyframe gate.
- `seamEstimationResolMP` adaptation.
- Retry-ladder tuning (`stitcher.cpp:952-957`) — Phase 1 / separate work.
- Any RAM-keyed behavior; removing the C++ compose fallback for non-RN
  callers (§4.1).
- Switching pipelines (manual vs high-level) as an adaptation lever — output
  pixels differ structurally between them (seam cost, ORB budget, match_conf);
  that is a product decision, not a perf knob.

## 11. Open questions

1. **Threshold calibration** — `adaptiveSlowStitchMsPerFrame=1000`,
   `adaptiveSlowRegistrationMsPerFrame=350`, thermal `headroom ≥ 0.95`, the
   per-keyframe seed table, the hysteresis exit band (`0.8×`), and the probe
   cadence (`kProbeEveryN=5`): all estimated; §7.4 must produce measured
   values before defaults are considered final.
2. **`adaptiveMinOutputMP` semantics under crop** — the floor is enforced on
   the per-frame compose budget (provable pre-crop bound, §4.4). Should we
   additionally hard-report (or reject?) when the *post-crop* output lands
   below the floor? Needs a product call on what OD actually requires.
3. **Thermal-only firing** — should signal B alone fire, or only reinforce A?
   Current design: OR (§4.3). If the fast-cell matrix shows warm-but-fast
   devices firing, demote B to a tie-breaker.
4. **JS auto-passthrough for refine** — should the SDK add a thin
   `refinePanoramaConsistent(result, opts)` helper that injects
   `result.appliedBudgets` automatically, instead of relying on the
   documented contract? Leaning yes, but it's additive and can follow.
5. **History key: include OS build fingerprint?** An OS upgrade can shift
   perf; the 5-entry window self-heals quickly, so probably unnecessary.
   Decide after matrix data.
6. **Phase 0 field names** — bind `appliedBudgets` and the registration-phase
   field names once the Phase 0 spec freezes its schema.
7. **iOS thermal mapping** — `ProcessInfo.thermalState` bands vs Android's
   headroom float: pick equivalence classes in the iOS follow-up.
8. **Pair-count normalization** — per-keyframe division under-corrects the
   O(N²) full-pairwise matching term (§4.2). If the §7.4 per-count data
   shows the residual bias moves the fire decision on real captures, switch
   the normalization to `wallMs / (N·(N−1)/2)` for the registration
   component (compose is O(N)); the store already carries raw `wallMs` +
   `acceptedCount`, so this is a read-time change, no migration.
9. **Probe cadence exposure** — `kProbeEveryN=5` is an internal constant; a
   probe costs the user one default-speed stitch. Expose as
   `adaptiveProbeEveryN` config only if a host asks (§7.4 may also move the
   default).
