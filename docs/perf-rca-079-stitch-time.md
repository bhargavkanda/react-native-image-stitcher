# perf-RCA — 8 s vs 29 s stitch time (baseline vs Samsung A34 / 0.79 host)

**Status:** leading cause identified and **measured on-device**; the final
attribution for the specific A34 capture is a one-line read of its debug pack
(`finalConfidenceThresh`, §5).

## TL;DR

The regression is **not** RN 0.79 itself and **not** keyframe count. The prime
suspect is the **native stitch retry ladder escalating to attempt 3**, whose
registration runs at **1.3 MP** — a measured **~20–25× cliff** (2.3 s → **48–60 s**
on an A35) that *also drops frames*. A field capture that fails attempts 1–2
(weaker overlap: noisier A34 camera, faster pan, rolling shutter) falls onto that
rung. The debug pack's `finalConfidenceThresh` tells you immediately: `1.0` =
happy attempt 1, `0.5` = attempt 2, **`0.3` = attempt 3 (the cliff)**.

## 1. The observation

Same capture: **~8 s** baseline vs **~29 s** on a Samsung A34 (RN 0.79 host) — a
**~3.6×** regression.

## 2. Two constraints before measuring

- **A34 vs A35 hardware ≈ within 25 %** (Dimensity 1080 vs Exynos 1380). Raw
  silicon cannot produce 3.6× alone.
- **The native `cv::Stitcher` path is RN-version-invariant** (same C++). So a
  3.6× gap is either (a) different **input/config** into the native stitch,
  (b) **device/thermal**, or (c) **RN/JS/bridge** overhead. Phase-0 timings
  separate (c): `stitchWallMs` (native) vs `queueDelayMs`/total (bridge).

## 3. Measured evidence (A35, real `stitchFramePaths` via `stitch_probe`)

**Registration-resolution cliff — the headline.** Same 5-keyframe scene, compose
1.0, graphcut, 1 thread; only the registration budget varies:

| registration MP | wall time | frames included |
|---|---|---|
| 0.6 (attempt-1 default) | 2393 ms | 5/5 |
| 0.9 | 2183 ms | 5/5 |
| 1.0 (attempt-2 rung) | 2083 ms | 5/5 |
| 1.1 | 2295 ms | 5/5 |
| 1.2 | 2313 ms | 5/5 |
| **1.3 (attempt-3 rung)** | **48 000–60 000 ms** | **3/5** |

A **razor-sharp knee between 1.2 and 1.3 MP**: ~20–25× slower **and** it drops 2
of 5 frames. At 1.3 MP the ORB feature count and `BundleAdjusterRay` optimisation
blow up (super-quadratic), and the higher-res matches are *worse*, not better.
The ladder uses exactly this rung on attempt 3 (`cpp/stitcher.cpp:979`,
`{ 0.3, 0.20f, 1.3, 0 }`).

**The other levers, for scale** (same scene, attempt-1 path):

| factor | change | effect |
|---|---|---|
| compose MP | 1.0 → 0.6 | ~10 % |
| threads | 1 → 4 | ~2 % (negligible) |
| seam finder | graphcut → voronoi → skip | 2779 → 1674 → 1334 ms (graphcut ≈ 40–52 %) |
| keyframe count | N = 2 → 5 | 786 → 2450 ms (super-linear) |

None of these reaches the 12× needed for 8 s → 29 s. **Only the ladder cliff
does** (and, secondarily, device/thermal — see H2).

## 4. Ranked hypotheses (settle with the A34 pack)

| # | hypothesis | mechanism (code) | pack signature |
|---|---|---|---|
| **H1** | **retry-ladder escalation to attempt 3 (leading)** | attempts re-run full registration at 0.6→1.0→**1.3** MP; the 1.3 rung is a 20–25× cliff (`stitcher.cpp:966-1052`, rungs at `:978-979`) | **`finalConfidenceThresh = 0.3`** (0.5 = attempt 2); `stitchWallMs` carries the whole gap |
| **H2** | **device + thermal** | serial phases (graphcut seam ~41 %, ORB/BA) run ~2–3× slower on the A34 and throttle when warm | identical `keyframeCount`/recipe/`finalConfidenceThresh=1.0` on both, but every phase uniformly ~2–3× |
| **H3** | **auto → PANORAMA vs SCANS** | rotation-vs-translation classification picks the heavier PANORAMA pipeline (BA-Ray + MultiBand + GraphCut) vs cheap SCANS | `stitchModeResolved="panorama"` on A34 vs `"scans"` on baseline |
| **H4** | **compose 1.0 vs 0.6 (RAM tier)** | high-level default `≥5 GB ? 1.0 : 0.6` (`stitcher.cpp:900`); A34 (6/8 GB) composes 1.0 MP; an iOS-manual or <5 GB baseline composes 0.6 | `compositingResolMP = 1.0` vs `0.6` (~1.5–1.7× on compose phases only) |
| **H5** | **sparse-settings config** | a bare `stitcher:{}` host sends `numThreads=0` (auto-multi = a measured −7…−18 % regression) + `rangeMatcherWidth=0` (full pairwise) | `numThreads=0`, `rangeMatcherWidth=0` (~1.2–1.3×, real but small) |
| ~~H6~~ | ~~keyframe-count explosion~~ | **disproven**: the gate hard-caps at `maxCount = 6` before force-accept (`keyframe_gate.cpp:288,470`). Only an explicit host `setMaxCount(>6)` raises it | `keyframeCount > 6` (would indicate an explicit override) |
| ~~H7~~ | ~~RN/bridge overhead~~ | unlikely to be the driver; `queueDelayMs` is bounded | `stitchWallMs ≈ 8000` but total ≈ 29000 → then it *is* bridge |

Why H1 leads: it's the only factor with the measured magnitude, it has a clear
trigger (attempt-1 failure, which a lower-quality A34 capture hits far more
often than a clean reference of the "same" scene), and it's a single pack field
to confirm.

## 5. The definitive measurement (one A34 capture)

1. Settings modal → **Debug pack → on**.
2. Capture the **slow shelf** on the A34.
3. Pull the pack:
   ```bash
   adb -s <A34> exec-out run-as <fleet.app.id> \
     tar c cache/rlis-capture-<uuid> | tar x -C ./a34-pack
   ```
4. **Read `pack.json` → `result.finalConfidenceThresh` first.**
   - `0.3` → **H1 confirmed** (attempt 3, the 1.3 MP cliff). Done.
   - `0.5` → attempt 2 (1.0 MP) — check `stitchWallMs`; likely H2/H3/H4 on top.
   - `1.0` → happy path; the cost is elsewhere → compare `stitchWallMs`
     (native, H2/H3/H4) vs `queueDelayMs`/total (bridge, H7), and
     `stitchModeResolved` (H3), `compositingResolMP` (H4), `numThreads`/`rangeMatcherWidth` (H5).
5. Reproduce + ablate offline on the pack's exact keyframes:
   ```bash
   venv/bin/python tools/offline-compare/offline_compare.py ./a34-pack --ablate
   ```

## 6. Optimization levers (ranked by measured impact)

1. **Cap the ladder's registration resolution — DONE (biggest win).** The 1.3 MP
   attempt-3 rung is pathological — measured 20–25× slower *and it dropped
   frames*, so it wasn't buying quality. **Shipped:** `cpp/stitcher.cpp` now caps
   the ladder's registration escalation at `kLadderRegResolCeilingMP = 1.0` (a
   `std::min` clamp on both the forward attempt and the best-attempt recovery
   re-estimate), so attempt 3 keeps its *real* rescue levers (lower confidence
   threshold 0.3 + wider range matcher) but runs registration at the proven-safe
   1.0 MP. An **explicit** caller `registrationResolMP > 1.0` still wins (the
   caller owns that trade-off). Validated on-device: attempt-1 scenes byte-
   identical (5/5), attempt-3 registration `1.30 → 1.00` in the ladder log; a
   capture that reaches attempt 3 now pays ~2 s registration instead of 48–60 s.
   (Ceiling is 1.0 not 1.2 because the knee "shifts with scene texture" and is
   razor-sharp — 1.0 = attempt-2's proven value, with margin.) The end-to-end
   field improvement lands once the A34 pack confirms `finalConfidenceThresh=0.3`.
2. **Reduce attempt-1 failures** so captures never reach the ladder at all — see
   §6a; this is the *upstream* fix.
3. **Seam finder → voronoi** (~40 %) — the `seamFinder` A/B knob (watch shelf
   label tearing at parallax).
4. **Compose cut** — `adaptiveStitchMode = always/measured` (~10–15 %); quantify
   the OD/OCR cost with the offline compare (SSIM), don't guess.
5. **Force SCANS** where the capture is translation-dominant (H3) — much cheaper
   than PANORAMA.
6. **Spread canonical settings** so the fleet doesn't get `numThreads=0` /
   `rangeMatcherWidth=0` (H5).

These stack multiplicatively. **#1 is shipped**; #2 (below) is the upstream fix.

## 6a. Reducing attempt-1 failures (the upstream lever)

Attempt 1 fails when **consecutive keyframes don't match** at
`panoConfidenceThresh = 1.0` — i.e. adjacent frames share too little
well-featured overlap. On the A34 that's more likely than on a clean reference
(noisier camera, faster pan, rolling shutter, low-texture shelf gaps). What
governs consecutive overlap, and the levers:

- **Overlap between consecutive keyframes.** Two gates decide when a frame
  becomes a keyframe:
  - **Novelty / overlap gate** — `frameSelection.overlapThreshold` (default
    **0.20**: accept once ~20 % novel ⇒ ~80 % overlap). Lowering it (e.g. 0.15)
    accepts keyframes *closer together* ⇒ more overlap ⇒ better matching. But
    with `maxKeyframes` fixed at **6**, denser frames cover a *narrower* pan, so
    for a wide shelf the trade is coverage.
  - Better lever for wide pans: **raise `maxKeyframes`** (6 → 8–10). More frames
    across the same pan ⇒ more overlap per pair ⇒ fewer attempt-1 failures. The
    range matcher (shipped, width 3) keeps the extra matching cost at O(N·3), not
    O(N²), and with the ladder cap the downside of more frames is bounded.
- **Motion blur** — already mitigated: the sharpness window
  (`frameSelection.sharpnessWindow`, default 4) picks the sharpest frame in a
  window, so keyframes aren't blurry ⇒ more/stronger features.
- **Reversals** — a backward pan drops a keyframe that doesn't match the forward
  chain. The deferred **perf-5 capture-pause-on-reversal** (red border + "paused"
  until the operator resumes past the frontier) prevents chain-breaking frames.

### The time-based keyframe gate (your question)

Yes — there is a **time-budget force-accept**: `maxKeyframeIntervalMs`. It accepts
a keyframe once this much wall-clock has elapsed since the last accept **even if
the novelty gate hasn't tripped**, so a slow/static/hesitant pan doesn't leave a
big gap.

- **Interval:** native default is `0.0` (disabled), but the **JS/fleet default is
  `1500` ms (1.5 s)** — sent over the wire, and the example app sets
  `defaultMaxKeyframeIntervalMs={1500}`.
- **Configurable:** yes — `frameSelection.maxKeyframeIntervalMs` per capture, the
  settings modal ("Keyframe interval"), and it counts toward the `maxKeyframes=6`
  cap (`keyframe_gate.cpp:292`, `PanoramaSettings.ts` frameSelection).
- **Interaction with attempt-1 failures:** it cuts both ways. On a *slow* pan it
  helps (fills gaps). On a *fast* pan a 1.5 s force-accept can fire *after* the
  operator has already swept far, producing a low-overlap pair → an attempt-1
  failure. If the A34 captures are fast pans, a *shorter* interval (or leaning on
  the novelty gate) gives tighter, better-overlapping keyframes. The debug pack's
  `keyframeCount` + the per-pair overlap tell you which regime you're in.

## 7. Instruments (this RCA's tooling)

- **Debug pack** — `debugPack` config flag → `pack.json` next to the persisted
  keyframes on finalize (device + recipe + result incl. `finalConfidenceThresh`
  + timings). Off by default; toggle in the settings modal.
- **`tools/offline-compare/`** — `stitch_probe` (arm64; runs the real
  `stitchFramePaths` with compose/reg/threads/seam/warper from argv) +
  `offline_compare.py` (replays a pack at field/off/always, reports SSIM +
  wall time; `--ablate` sweeps one factor). Build: `build_stitch_probe.sh`.
  The registration-resolution sweep above is `stitch_probe … <regMP> …`.
