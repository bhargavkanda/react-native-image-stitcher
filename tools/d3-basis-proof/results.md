# D3 offline proofs: results (2026-09-24)

These results come from `tools/d3-basis-proof/run_all.sh` at worktree HEAD
`b4f0a32` on branch `feat/unify-camera`, run over the nine iPhone17,1 AR-arm
packs in `packs.txt` (iOS 26.5.2). Every pack carries both `track.jsonl`
(ARKit) and `attitude_imu.jsonl` (CoreMotion, 100 Hz delivered).

## Follow-up (same day)

Proof 2 changed the shipped check. `PANO_PLUS_BASIS_CHECK.minTotalPx` is now
16, below the latch's own 24 px trigger. A second advisory signal,
`panoPlusBasisTravelCheck`, grades the sign of `regime.rotTravelPx`. It is
measured only when |rotTravelPx| ≥ 100 px and rotation carries ≥ 25 % of the
net travel. Both verdicts are written to `host_verdict.json`. On the rows
below, they combine like this:

| Arm | Latch check | Travel check |
|---|---|---|
| #8 | agrees 8/9 | agrees 8/9, never disagrees |
| #0 | disagrees 8/9 | blind |
| #9, #10 | disagree 7/9 | disagree 7/9, including relatched sweeps |
| #11, #13 | blind | blind |

The tables below are the run as recorded, with the old floor of 40.

## Bottom line

### Proof 1: #8 is confirmed on all nine packs

- **Derivation.** `deriveBasis(sensorOrientationDeg=90, Back, RawSensorBuffer)`
  returns **#8 `-y+x+z`**, with a matrix identical to `basisMatrix(8)`.
- **Selection.** `selectBasis` picks **#8 as a unique winner on 9 of 9
  packs**:
  - residual 0.115 to 0.997° rms, over 147 to 558 pairs;
  - margin to the runner-up 2.06 to 6.64°;
  - the winner is stable across τ = 0, ±5 and ±10 ms on every pack.
- **Runner-up.** The runner-up is always #13 or #14. Both are quarter turns
  about camera x, which is the sweep's own rotation axis. This is the
  documented single-axis degeneracy. Here it is broken only by the incidental
  secondary motion of a hand-held sweep.
- **Persist gate.** The production gate `gradeBasis` would persist #8 from
  **only 1 of 9** packs (T14-225636). The other 8 fail
  `excitation-insufficient`. These are panorama sweeps, not the calibration
  gesture, so the selection is consistent evidence for #8 but mostly not
  gesture-grade evidence.

### Proof 2: the negative control does NOT flip the shipped verdict

The shipped `panoPlusBasisImageCheck` returns **`not-measurable` on all 72
replays**: 9 packs × 8 arms, covering the truth, four wrong bases, and both
ARKit baselines. It also returns `not-measurable` on all 9 device latches
recorded in the packs. It cannot tell #8 from a quarter turn or from a sign
flip. The cause is structural:

- **The latch vote sets the size of `totalPx`.** The engine latches the axis
  the moment `max(|totX|, |totY|) >= latchTotalPx = 24` canvas px
  (`rnis_pano.cpp` around line 5685, `rnis_pano.hpp:1030`). The latched
  `|totalPx|` is therefore about 24 to 36 px, and the check's `minTotalPx` is
  **40**. The only replays with `|totalPx| > 40` were relatched ones, which
  hits the second cause below.
- **A relatch zeroes `latchRotPx`** (`rnis_pano.cpp:5785`). The rotation-share
  floor then makes every relatched session `not-measurable`.

### The direction information is there

The shipped floors throw away direction information that does exist. Among
latched, non-relatched, non-aborted runs, the unthresholded cosine is:

| Arm | Rotation relative to #8 | cosRaw range | n |
|---|---|---|---|
| #8 (truth) | none | +0.891 to +1.000 | 8 |
| #0 | quarter turn about the optical axis | −0.455 to +0.002 | 6 |
| #9 | 180° about the optical axis | −1.000 to −0.893 | 7 |
| #10 | 180° about camera y | −0.986 to −0.380 | 7 |

A what-if with `minTotalPx = 20` is not the shipped check. It is computed by
the shipped function on vectors scaled ×2, with every other threshold as
shipped. It gives:

- #8 agrees on 8 of 9. The ninth is not measurable because it relatched.
- #0 disagrees on 8 of 9.
- #9 and #10 disagree on 7 of 9 each.
- There are no false "disagrees" on #8.

### The check is blind to wrong bases about the sweep axis

#11 (180° about camera x) and #13 (90° about camera x) commute with the
sweep's dominant rotation, so they predict the same motion. At
`minTotalPx = 20` they would **agree on 8 of 9 and 7 of 9**. Their cosRaw
range is 0.26 to 0.99.

This is the same degeneracy `selectBasis` documents. An image check at the
latch cannot separate these bases on a pan. Their panoramas also come out
the same size as #8's (see the next section).

### What a wrong basis looks like in the canvas

| Arm | Effect on the replayed canvas |
|---|---|
| #0 | Visibly broken. 6 of 9 packs log `rejected-rectify` (17 to 59 frames). The output grows across the sweep, to 1638 to 2048 px against 1216 to 1839 px for #8. 2 of 9 runs end `chain-lost`. |
| #9, #10 | Placement survives because the residual channel compensates. `rotTravelPx` is negated, and `resTravelPx` grows by exactly twice the true rotation travel (res#9 ≈ res#8 + 2·rot#8). Output sizes stay within a few px of #8's. On `out/contact_T14-225004.jpg` the #9 canvas has visibly different geometry (re-projected shelf rows) but is plausible at a glance. |
| #11, #13 | Plausible panoramas at the same size as #8's. On T14-225004 they are near-identical to #8. On PP3-124737 the painted band is visibly slanted against #8's. |

Canvas sizes alone would not catch #9, #10, #11 or #13. The along-sweep
regime number `rotTravelPx` does separate a sign flip: it is negative on #9
and #10 in 8 of 9 packs. The ninth (PP6-195027) aborted `chain-lost` before
painting. For #8, `rotTravelPx` is positive on all 9. This is an observation,
not a proposal.

## Tables

(Generated by `tables.mjs`. The (2) table is every replay, and the (2b) table is each pack's own device latch.)

### (1a) deriveBasis(sensorOrientationDeg=90, Back, RawSensorBuffer, mirrored=false)

| ok | index | label | refusal | residualRotationCwDeg | C (row-major) | equals #8 | provenance |
|---|---|---|---|---|---|---|---|
| true | 8 | `-y+x+z` | none | 90 | `[[0,1,0],[-1,0,0],[0,0,1]]` | **true** | derived |

### (1b) selectBasis(imu = attitude_imu.jsonl, ref = track.jsonl ARKit, tau = 0) per pack

| pack | imu n (Hz) | ref n | pairs | winner | residual rms deg | runner-up | runner-up rms deg | margin deg | unique | refusal | = #8 | stability ±10 ms | gradeBasis (persist gate) | ref excitation tilt/pan/roll deg (rank2) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| PP6-195027 | 435 (100) | 261 | 256 | #8 `-y+x+z` | 0.473 | #13 `-y-z+x` | 7.116 | 6.643 | true | ok | **yes** | ok (#8, min margin 6.60) | excitation-insufficient | 55.3/8.1/3.6 (0.11) |
| PP6-195035 | 252 (100) | 151 | 147 | #8 `-y+x+z` | 0.313 | #14 `-y+z-x` | 5.473 | 5.159 | true | ok | **yes** | ok (#8, min margin 5.08) | excitation-insufficient | 54.8/7.0/3.3 (0.07) |
| PP6-225431 | 314 (100) | 189 | 185 | #8 `-y+x+z` | 0.115 | #14 `-y+z-x` | 2.568 | 2.453 | true | ok | **yes** | ok (#8, min margin 2.45) | excitation-insufficient | 27.6/5.7/3.6 (0.26) |
| T14-225636 | 1312 (100) | 393 | 390 | #8 `-y+x+z` | 0.997 | #13 `-y-z+x` | 6.006 | 5.009 | true | ok | **yes** | ok (#8, min margin 4.90) | ok | 108.1/66.9/72.5 (0.67) |
| T14-225753 | 572 (100) | 171 | 168 | #8 `-y+x+z` | 0.292 | #13 `-y-z+x` | 2.388 | 2.096 | true | ok | **yes** | ok (#8, min margin 1.97) | excitation-insufficient | 40.9/19.7/20.7 (0.59) |
| T14-230008 | 715 (100) | 214 | 211 | #8 `-y+x+z` | 0.169 | #13 `-y-z+x` | 2.230 | 2.061 | true | ok | **yes** | ok (#8, min margin 1.98) | excitation-insufficient | 39.1/22.1/17.4 (0.63) |
| T14-225004 | 638 (100) | 385 | 380 | #8 `-y+x+z` | 0.896 | #13 `-y-z+x` | 3.675 | 2.778 | true | ok | **yes** | ok (#8, min margin 2.73) | excitation-insufficient | 41.4/11.9/6.6 (0.33) |
| PP3-124737 | 938 (100) | 562 | 558 | #8 `-y+x+z` | 0.413 | #13 `-y-z+x` | 6.570 | 6.158 | true | ok | **yes** | ok (#8, min margin 6.02) | excitation-insufficient | 79.5/24.1/23.7 (0.39) |
| T15-225457 | 741 (100) | 223 | 219 | #8 `-y+x+z` | 0.318 | #14 `-y+z-x` | 3.194 | 2.876 | true | ok | **yes** | ok (#8, min margin 2.79) | excitation-insufficient | 36.3/23.9/22.7 (0.71) |

### (2) Wrong-basis negative control — replayed latch, graded by the shipped `panoPlusBasisImageCheck`

Thresholds in force (read from src/sweep/panoPlusModel.ts at run time): `{"minTotalPx":40,"minRotationShare":0.25,"agreeCos":0.707}`

| pack | arm | latch rotationPx | latch totalPx | abs rot / abs total | **verdict (shipped)** | cos (check) | cosRaw (no floors) | what-if minTotalPx=20 | latched / frames / relatch | rotTravel / resTravel px | rotationFraction | painted / held / rejected | output WxH | abort |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| PP6-195027 | ARKit (as captured) | [-6.8, 24.7] | [12.0, -12.1] | 25.6 / 17.1 | **not-measurable** | — | -0.871 | not-measurable | NO / 20 / 0 | -7 / 19 | 0.27 | 22 / 0 / 59 | 0x0 | chain-lost |
| PP6-195027 | ARKit q, vc row shape | [-6.8, 24.7] | [12.0, -12.1] | 25.6 / 17.1 | **not-measurable** | — | -0.871 | not-measurable | NO / 20 / 0 | -7 / 19 | 0.27 | 22 / 0 / 59 | 0x0 | chain-lost |
| PP6-195027 | IMU·C#8 `-y+x+z` | [-40.9, 233.2] | [-7.5, 26.3] | 236.8 / 27.4 | **not-measurable** | — | 0.994 | agrees | yes / 99 / 0 | 637 / -193 | 0.73 | 245 / 8 / 0 | 1216x1141 |  |
| PP6-195027 | IMU·C#0 `+x+y+z` | [-170.7, -29.8] | [-0.1, 24.3] | 173.3 / 24.3 | **not-measurable** | — | -0.170 | disagrees | yes / 76 / 0 | -86 / 332 | 0.19 | 151 / 19 / 59 | 2048x1127 | chain-lost |
| PP6-195027 | IMU·C#9 `+y-x+z` | [5.0, -21.3] | [8.0, 0.6] | 21.9 / 8.0 | **not-measurable** | — | 0.159 | not-measurable | NO / 16 / 0 | 5 / 3 | 0.27 | 18 / 0 / 59 | 0x0 | chain-lost |
| PP6-195027 | IMU·C#10 `+y+x-z` | [-5.0, -21.3] | [7.9, 0.5] | 21.9 / 8.0 | **not-measurable** | — | -0.290 | not-measurable | NO / 16 / 0 | -5 / 13 | 0.28 | 18 / 0 / 59 | 0x0 | chain-lost |
| PP6-195027 | IMU·C#11 `-y-x-z` | [40.2, 229.8] | [-3.5, 24.4] | 233.3 / 24.7 | **not-measurable** | — | 0.951 | agrees | yes / 98 / 0 | 637 / -192 | 0.73 | 244 / 9 / 0 | 1216x1142 |  |
| PP6-195027 | IMU·C#13 `-y-z+x` | [-1.9, 21.3] | [8.1, 0.5] | 21.4 / 8.1 | **not-measurable** | — | -0.031 | not-measurable | NO / 16 / 0 | -2 / 10 | 0.16 | 18 / 0 / 59 | 0x0 | chain-lost |
| PP6-195035 | ARKit (as captured) | [-1.9, 7.8] | [4.4, -15.7] | 8.0 / 16.3 | **not-measurable** | — | -1.000 | not-measurable | NO / 15 / 0 | -2 / 6 | 0.27 | 17 / 0 / 59 | 0x0 | chain-lost |
| PP6-195035 | ARKit q, vc row shape | [-1.9, 7.8] | [4.4, -15.7] | 8.0 / 16.3 | **not-measurable** | — | -1.000 | not-measurable | NO / 15 / 0 | -2 / 6 | 0.27 | 17 / 0 / 59 | 0x0 | chain-lost |
| PP6-195035 | IMU·C#8 `-y+x+z` | [0.0, 0.0] | [-16.1, 32.1] | 0.0 / 35.9 | **not-measurable** | — | — | not-measurable | yes / 13 / 1 | 560 / -51 | 0.89 | 113 / 19 / 0 | 1344x1195 |  |
| PP6-195035 | IMU·C#0 `+x+y+z` | [0.0, 0.0] | [12.4, 49.2] | 0.0 / 50.7 | **not-measurable** | — | — | not-measurable | yes / 13 / 1 | -67 / 436 | 0.13 | 83 / 24 / 23 | 2048x1396 |  |
| PP6-195035 | IMU·C#9 `+y-x+z` | [0.0, 0.0] | [-12.7, 28.1] | 0.0 / 30.8 | **not-measurable** | — | — | not-measurable | yes / 13 / 1 | -560 / 1072 | 0.34 | 114 / 20 / 0 | 1216x1193 |  |
| PP6-195035 | IMU·C#10 `+y+x-z` | [0.0, 0.0] | [23.5, 38.1] | 0.0 / 44.8 | **not-measurable** | — | — | not-measurable | yes / 13 / 1 | -560 / 1064 | 0.34 | 108 / 19 / 0 | 1216x1186 |  |
| PP6-195035 | IMU·C#11 `-y-x-z` | [15.3, 100.1] | [-12.1, 26.8] | 101.2 / 29.4 | **not-measurable** | — | 0.838 | agrees | yes / 39 / 0 | 636 / -119 | 0.82 | 130 / 13 / 0 | 1216x1211 |  |
| PP6-195035 | IMU·C#13 `-y-z+x` | [-8.4, 100.3] | [-11.3, 26.0] | 100.6 / 28.3 | **not-measurable** | — | 0.947 | agrees | yes / 39 / 0 | 636 / -121 | 0.81 | 130 / 7 / 0 | 1216x1215 |  |
| PP6-225431 | ARKit (as captured) | [-6.9, 24.8] | [-5.5, 24.0] | 25.7 / 24.6 | **not-measurable** | — | 0.999 | agrees | yes / 20 / 0 | 317 / 36 | 0.86 | 153 / 29 / 0 | 1216x1019 |  |
| PP6-225431 | ARKit q, vc row shape | [-6.9, 24.8] | [-5.5, 24.0] | 25.7 / 24.6 | **not-measurable** | — | 0.999 | agrees | yes / 20 / 0 | 317 / 36 | 0.86 | 153 / 29 / 0 | 1216x1019 |  |
| PP6-225431 | IMU·C#8 `-y+x+z` | [-7.9, 25.3] | [-5.8, 24.2] | 26.5 / 24.9 | **not-measurable** | — | 0.998 | agrees | yes / 19 / 0 | 315 / 35 | 0.85 | 143 / 35 / 0 | 1216x1016 |  |
| PP6-225431 | IMU·C#0 `+x+y+z` | [-25.3, -7.9] | [-5.7, 24.2] | 26.5 / 24.8 | **not-measurable** | — | -0.070 | disagrees | yes / 19 / 0 | -32 / 400 | 0.14 | 145 / 33 / 0 | 1728x1315 |  |
| PP6-225431 | IMU·C#9 `+y-x+z` | [7.9, -25.3] | [-5.9, 24.1] | 26.5 / 24.8 | **not-measurable** | — | -0.998 | disagrees | yes / 19 / 0 | -315 / 662 | 0.32 | 155 / 24 / 0 | 1216x1016 |  |
| PP6-225431 | IMU·C#10 `+y+x-z` | [-8.1, -26.5] | [-5.8, 24.5] | 27.7 / 25.2 | **not-measurable** | — | -0.863 | disagrees | yes / 20 / 0 | -315 / 662 | 0.32 | 154 / 26 / 0 | 1216x1015 |  |
| PP6-225431 | IMU·C#11 `-y-x-z` | [8.1, 26.5] | [-6.1, 24.5] | 27.7 / 25.3 | **not-measurable** | — | 0.857 | agrees | yes / 20 / 0 | 315 / 32 | 0.86 | 154 / 25 / 0 | 1216x1013 |  |
| PP6-225431 | IMU·C#13 `-y-z+x` | [1.6, 25.3] | [-5.5, 24.1] | 25.3 / 24.7 | **not-measurable** | — | 0.959 | agrees | yes / 19 / 0 | 315 / 34 | 0.86 | 156 / 22 / 0 | 1216x1025 |  |
| T14-225636 | ARKit (as captured) | [3.5, -21.8] | [4.8, -27.4] | 22.1 / 27.8 | **not-measurable** | — | 1.000 | agrees | yes / 13 / 0 | 270 / 1960 | 0.39 | 316 / 59 / 0 | 1472x2973 |  |
| T14-225636 | ARKit q, vc row shape | [3.5, -21.8] | [4.8, -27.4] | 22.1 / 27.8 | **not-measurable** | — | 1.000 | agrees | yes / 13 / 0 | 270 / 1960 | 0.39 | 316 / 59 / 0 | 1344x2973 |  |
| T14-225636 | IMU·C#8 `-y+x+z` | [4.3, -19.9] | [5.4, -24.9] | 20.4 / 25.5 | **not-measurable** | — | 1.000 | agrees | yes / 11 / 0 | 249 / 1983 | 0.38 | 317 / 54 / 0 | 1216x2973 |  |
| T14-225636 | IMU·C#0 `+x+y+z` | [19.9, 4.2] | [5.3, -25.0] | 20.4 / 25.5 | **not-measurable** | — | 0.002 | disagrees | yes / 11 / 0 | 28 / 2354 | 0.25 | 301 / 72 / 0 | 1728x3223 |  |
| T14-225636 | IMU·C#9 `+y-x+z` | [-4.2, 19.9] | [5.3, -25.1] | 20.3 / 25.6 | **not-measurable** | — | -1.000 | disagrees | yes / 11 / 0 | -249 / 2476 | 0.29 | 317 / 54 / 0 | 1216x2954 |  |
| T14-225636 | IMU·C#10 `+y+x-z` | [4.2, 19.9] | [5.1, -24.8] | 20.4 / 25.3 | **not-measurable** | — | -0.917 | disagrees | yes / 11 / 0 | -249 / 2461 | 0.29 | 312 / 59 / 0 | 1472x2939 |  |
| T14-225636 | IMU·C#11 `-y-x-z` | [-4.2, -19.9] | [5.1, -24.8] | 20.3 / 25.3 | **not-measurable** | — | 0.916 | agrees | yes / 11 / 0 | 248 / 1961 | 0.39 | 312 / 58 / 0 | 1344x2953 |  |
| T14-225636 | IMU·C#13 `-y-z+x` | [-7.5, -20.0] | [5.3, -24.9] | 21.3 / 25.4 | **not-measurable** | — | 0.843 | agrees | yes / 11 / 0 | 246 / 1965 | 0.39 | 313 / 57 / 0 | 1344x2918 |  |
| T14-225753 | ARKit (as captured) | [13.4, 16.9] | [20.3, 25.8] | 21.6 / 32.8 | **not-measurable** | — | 1.000 | agrees | yes / 20 / 0 | 459 / 282 | 0.62 | 163 / 5 / 0 | 1216x1404 |  |
| T14-225753 | ARKit q, vc row shape | [13.4, 16.9] | [20.3, 25.8] | 21.6 / 32.8 | **not-measurable** | — | 1.000 | agrees | yes / 20 / 0 | 459 / 282 | 0.62 | 163 / 5 / 0 | 1216x1404 |  |
| T14-225753 | IMU·C#8 `-y+x+z` | [10.7, 17.0] | [18.6, 25.1] | 20.1 / 31.2 | **not-measurable** | — | 0.997 | agrees | yes / 18 / 0 | 458 / 282 | 0.62 | 161 / 5 / 0 | 1216x1400 |  |
| T14-225753 | IMU·C#0 `+x+y+z` | [-16.9, 10.6] | [18.7, 25.1] | 20.0 / 31.3 | **not-measurable** | — | -0.082 | disagrees | yes / 18 / 0 | 7 / 712 | 0.22 | 123 / 25 / 18 | 2048x1924 |  |
| T14-225753 | IMU·C#9 `+y-x+z` | [-10.5, -17.0] | [18.6, 25.0] | 20.0 / 31.2 | **not-measurable** | — | -0.996 | disagrees | yes / 18 / 0 | -458 / 1199 | 0.28 | 161 / 5 / 0 | 1216x1406 |  |
| T14-225753 | IMU·C#10 `+y+x-z` | [10.5, -17.0] | [18.3, 25.3] | 20.0 / 31.2 | **not-measurable** | — | -0.380 | disagrees | yes / 18 / 0 | -458 / 1200 | 0.28 | 161 / 5 / 0 | 1216x1407 |  |
| T14-225753 | IMU·C#11 `-y-x-z` | [-10.6, 17.0] | [18.2, 25.0] | 20.1 / 31.0 | **not-measurable** | — | 0.374 | disagrees | yes / 18 / 0 | 458 / 284 | 0.62 | 161 / 5 / 0 | 1216x1402 |  |
| T14-225753 | IMU·C#13 `-y-z+x` | [-13.3, 16.8] | [18.6, 25.0] | 21.5 / 31.2 | **not-measurable** | — | 0.258 | disagrees | yes / 18 / 0 | 458 / 283 | 0.62 | 161 / 5 / 0 | 1216x1408 |  |
| T14-230008 | ARKit (as captured) | [-1.9, 12.5] | [7.8, 24.2] | 12.6 / 25.4 | **not-measurable** | — | 0.896 | agrees | yes / 28 / 0 | 429 / 383 | 0.54 | 200 / 10 / 0 | 1216x1480 |  |
| T14-230008 | ARKit q, vc row shape | [-1.9, 12.5] | [7.8, 24.2] | 12.6 / 25.4 | **not-measurable** | — | 0.896 | agrees | yes / 28 / 0 | 429 / 383 | 0.54 | 200 / 10 / 0 | 1216x1480 |  |
| T14-230008 | IMU·C#8 `-y+x+z` | [-5.5, 14.7] | [1.8, 26.3] | 15.7 / 26.4 | **not-measurable** | — | 0.912 | agrees | yes / 27 / 0 | 429 / 382 | 0.54 | 199 / 9 / 0 | 1216x1479 |  |
| T14-230008 | IMU·C#0 `+x+y+z` | [-14.8, -5.4] | [1.8, 26.3] | 15.8 / 26.4 | **not-measurable** | — | -0.407 | disagrees | yes / 27 / 0 | -2 / 835 | 0.22 | 176 / 16 / 17 | 2048x2027 |  |
| T14-230008 | IMU·C#9 `+y-x+z` | [5.4, -14.7] | [1.8, 26.3] | 15.7 / 26.4 | **not-measurable** | — | -0.915 | disagrees | yes / 27 / 0 | -428 / 1240 | 0.26 | 199 / 9 / 0 | 1216x1489 |  |
| T14-230008 | IMU·C#10 `+y+x-z` | [-5.5, -14.7] | [1.9, 26.2] | 15.7 / 26.2 | **not-measurable** | — | -0.959 | disagrees | yes / 27 / 0 | -428 / 1241 | 0.26 | 197 / 11 / 0 | 1216x1490 |  |
| T14-230008 | IMU·C#11 `-y-x-z` | [5.3, 14.7] | [1.8, 26.1] | 15.7 / 26.1 | **not-measurable** | — | 0.962 | agrees | yes / 27 / 0 | 429 / 384 | 0.54 | 199 / 9 / 0 | 1216x1482 |  |
| T14-230008 | IMU·C#13 `-y-z+x` | [-3.4, 14.8] | [1.9, 26.2] | 15.1 / 26.2 | **not-measurable** | — | 0.957 | agrees | yes / 27 / 0 | 429 / 382 | 0.54 | 198 / 10 / 0 | 1216x1487 |  |
| T14-225004 | ARKit (as captured) | [5.0, 18.4] | [7.9, 26.8] | 19.1 / 27.9 | **not-measurable** | — | 1.000 | agrees | yes / 42 / 0 | 474 / 306 | 0.61 | 240 / 12 / 0 | 1216x1464 |  |
| T14-225004 | ARKit q, vc row shape | [5.0, 18.4] | [7.9, 26.8] | 19.1 / 27.9 | **not-measurable** | — | 1.000 | agrees | yes / 42 / 0 | 474 / 306 | 0.61 | 240 / 12 / 0 | 1216x1464 |  |
| T14-225004 | IMU·C#8 `-y+x+z` | [-1.8, 18.5] | [10.1, 25.5] | 18.5 / 27.5 | **not-measurable** | — | 0.891 | agrees | yes / 38 / 0 | 475 / 304 | 0.61 | 236 / 12 / 0 | 1216x1467 |  |
| T14-225004 | IMU·C#0 `+x+y+z` | [-18.5, -1.8] | [10.2, 25.6] | 18.6 / 27.5 | **not-measurable** | — | -0.455 | disagrees | yes / 38 / 0 | -60 / 788 | 0.13 | 185 / 23 / 41 | 2048x1870 |  |
| T14-225004 | IMU·C#9 `+y-x+z` | [1.7, -18.5] | [10.1, 25.6] | 18.5 / 27.5 | **not-measurable** | — | -0.893 | disagrees | yes / 38 / 0 | -475 / 1254 | 0.27 | 236 / 12 / 0 | 1216x1445 |  |
| T14-225004 | IMU·C#10 `+y+x-z` | [-1.8, -18.5] | [10.1, 25.7] | 18.6 / 27.6 | **not-measurable** | — | -0.961 | disagrees | yes / 38 / 0 | -474 / 1253 | 0.28 | 236 / 12 / 0 | 1216x1444 |  |
| T14-225004 | IMU·C#11 `-y-x-z` | [1.7, 18.5] | [10.1, 25.6] | 18.5 / 27.5 | **not-measurable** | — | 0.960 | agrees | yes / 38 / 0 | 475 / 304 | 0.61 | 236 / 12 / 0 | 1216x1466 |  |
| T14-225004 | IMU·C#13 `-y-z+x` | [1.6, 18.5] | [10.1, 25.5] | 18.5 / 27.5 | **not-measurable** | — | 0.959 | agrees | yes / 38 / 0 | 473 / 305 | 0.61 | 236 / 12 / 0 | 1216x1460 |  |
| PP3-124737 | ARKit (as captured) | [-1.3, -16.7] | [-1.6, -26.3] | 16.7 / 26.4 | **not-measurable** | — | 1.000 | agrees | yes / 20 / 0 | 920 / 230 | 0.80 | 493 / 20 / 0 | 1841x1344 |  |
| PP3-124737 | ARKit q, vc row shape | [-1.3, -16.7] | [-1.6, -26.3] | 16.7 / 26.4 | **not-measurable** | — | 1.000 | agrees | yes / 20 / 0 | 920 / 230 | 0.80 | 493 / 20 / 0 | 1841x1216 |  |
| PP3-124737 | IMU·C#8 `-y+x+z` | [1.5, -17.3] | [2.1, -26.0] | 17.3 / 26.1 | **not-measurable** | — | 1.000 | agrees | yes / 17 / 0 | 919 / 231 | 0.80 | 491 / 20 / 0 | 1839x1216 |  |
| PP3-124737 | IMU·C#0 `+x+y+z` | [17.3, 1.5] | [2.1, -26.0] | 17.4 / 26.1 | **not-measurable** | — | -0.006 | disagrees | yes / 17 / 0 | -2 / 553 | 0.17 | 204 / 42 / 59 | 1638x2048 | chain-lost |
| PP3-124737 | IMU·C#9 `+y-x+z` | [-1.5, 17.2] | [2.1, -26.0] | 17.3 / 26.1 | **not-measurable** | — | -1.000 | disagrees | yes / 17 / 0 | -919 / 2068 | 0.31 | 491 / 20 / 0 | 1858x1216 |  |
| PP3-124737 | IMU·C#10 `+y+x-z` | [1.5, 17.3] | [2.1, -26.0] | 17.3 / 26.1 | **not-measurable** | — | -0.986 | disagrees | yes / 17 / 0 | -919 / 2066 | 0.31 | 494 / 16 / 0 | 1855x1344 |  |
| PP3-124737 | IMU·C#11 `-y-x-z` | [-1.5, -17.3] | [2.1, -26.0] | 17.3 / 26.1 | **not-measurable** | — | 0.986 | agrees | yes / 17 / 0 | 919 / 227 | 0.80 | 495 / 16 / 0 | 1834x1344 |  |
| PP3-124737 | IMU·C#13 `-y-z+x` | [-1.0, -17.3] | [2.1, -26.0] | 17.3 / 26.1 | **not-measurable** | — | 0.991 | agrees | yes / 17 / 0 | 923 / 234 | 0.80 | 494 / 18 / 0 | 1860x1216 |  |
| T15-225457 | ARKit (as captured) | [-11.0, 12.9] | [-5.6, 24.7] | 16.9 / 25.3 | **not-measurable** | — | 0.886 | agrees | yes / 33 / 0 | 397 / 348 | 0.55 | 212 / 7 / 0 | 1344x1425 |  |
| T15-225457 | ARKit q, vc row shape | [-11.0, 12.9] | [-5.6, 24.7] | 16.9 / 25.3 | **not-measurable** | — | 0.886 | agrees | yes / 33 / 0 | 397 / 348 | 0.55 | 211 / 8 / 0 | 1344x1425 |  |
| T15-225457 | IMU·C#8 `-y+x+z` | [-9.1, 13.4] | [-3.5, 24.5] | 16.2 / 24.7 | **not-measurable** | — | 0.899 | agrees | yes / 30 / 0 | 400 / 344 | 0.55 | 207 / 9 / 0 | 1344x1423 |  |
| T15-225457 | IMU·C#0 `+x+y+z` | [-13.4, -9.1] | [-3.5, 24.6] | 16.2 / 24.8 | **not-measurable** | — | -0.442 | disagrees | yes / 30 / 0 | 36 / 752 | 0.26 | 192 / 25 / 0 | 1984x1906 |  |
| T15-225457 | IMU·C#9 `+y-x+z` | [9.2, -13.4] | [-3.7, 24.5] | 16.3 / 24.8 | **not-measurable** | — | -0.900 | disagrees | yes / 30 / 0 | -400 / 1144 | 0.26 | 207 / 9 / 0 | 1216x1408 |  |
| T15-225457 | IMU·C#10 `+y+x-z` | [-9.1, -13.4] | [-3.4, 24.5] | 16.2 / 24.7 | **not-measurable** | — | -0.740 | disagrees | yes / 30 / 0 | -400 / 1142 | 0.26 | 208 / 8 / 0 | 1344x1406 |  |
| T15-225457 | IMU·C#11 `-y-x-z` | [9.1, 13.4] | [-3.4, 24.2] | 16.2 / 24.4 | **not-measurable** | — | 0.741 | agrees | yes / 30 / 0 | 400 / 342 | 0.55 | 208 / 8 / 0 | 1216x1420 |  |
| T15-225457 | IMU·C#13 `-y-z+x` | [-6.0, 15.5] | [-1.3, 27.0] | 16.6 / 27.0 | **not-measurable** | — | 0.949 | agrees | yes / 31 / 0 | 400 / 346 | 0.55 | 209 / 8 / 0 | 1216x1420 |  |

### (2b) The DEVICE latch each pack recorded (ARKit arm, meta.json), same check

| pack | latch rotationPx | latch totalPx | abs total | verdict | cosRaw |
|---|---|---|---|---|---|
| PP6-195027 | [-46.8, 245.0] | [-4.6, 25.9] | 26.3 | not-measurable | 1.000 |
| PP6-195035 | [-33.2, 219.4] | [-2.3, 29.7] | 29.8 | not-measurable | 0.997 |
| PP6-225431 | [-6.9, 24.8] | [-5.6, 24.4] | 25.0 | not-measurable | 0.999 |
| T14-225636 | [3.5, -21.8] | [4.8, -27.4] | 27.8 | not-measurable | 1.000 |
| T14-225753 | [13.4, 16.9] | [20.2, 25.9] | 32.8 | not-measurable | 1.000 |
| T14-230008 | [-1.9, 12.5] | [7.8, 24.1] | 25.3 | not-measurable | 0.895 |
| T14-225004 | [4.9, 16.5] | [5.8, 24.1] | 24.8 | not-measurable | 0.999 |
| PP3-124737 | [-1.2, -14.9] | [-1.8, -24.1] | 24.2 | not-measurable | 1.000 |
| T15-225457 | [-11.0, 12.9] | [-5.6, 24.7] | 25.4 | not-measurable | 0.886 |


## Caveats

1. **One device model.** All nine packs come from iPhone17,1, the model #8 was
   measured on. The proof confirms #8 on that model. It says nothing offline
   about other iPhones.
2. **The replay is differential.** The replay reads JPEG luma where the device
   used NV12 Y.
   - The ARKit baseline (`ar`) does **not** reproduce the device on
     PP6-195027 or PP6-195035. It hits 59 consecutive
     `rejected-low-response`, then `chain-lost`, where the device painted the
     full sweep (device latch after 105 and 65 frames).
   - `arq` (ARKit `q` in the vision-camera row shape) fails identically, so
     the row shape is not the cause (`t`, ARKit exposure).
   - IMU·#8 paints both of these packs. Why the ARKit replay fails there was
     not investigated. One known difference: the IMU arms start 2 to 4 frames
     later on every pack, because those first track rows predate the first
     CoreMotion sample and are ingested as `notAvailable`. The IMU arms
     therefore latch their reference on a different frame.
   - All IMU arms share one timeline, so the comparison between bases is
     like-for-like. Compare `ar` against IMU·#8 only loosely.
3. **Offline alignment has every IMU sample.** In every IMU arm the aligner
   refused only the 2 to 4 leading frames (`before-first-sample`), with 0
   `after-last-sample`, 0 `limited`, and a 10 ms maximum bracket gap. The live
   arm can additionally hold or refuse frames when the IMU trails the camera.
4. **τ = 0, uncorrected,** as the vision-camera arm runs and as production
   calibration uses. ARFrame and CMDeviceMotion timestamps are both uptime.
   The ±10 ms stability sweep shows the selected basis does not depend on τ.
5. **The verdict comes from the live source.** It is computed by the real
   `panoPlusBasisImageCheck`, imported from `src/sweep/panoPlusModel.ts` in a
   worktree that another engineer is editing. The thresholds read at run time
   were `{minTotalPx: 40, minRotationShare: 0.25, agreeCos: 0.707}`. If they
   change, re-run `tables.mjs`.
6. **The what-if column is not the shipped check.** It exists to calibrate the
   check, which is what the plan says the negative control is for.
7. **The check never reads `latch.latched`.** Aborted sessions that never
   latched are graded on pre-latch vectors (for example PP6-195027 with
   `ar`, #9, #10 and #13). Here they come out `not-measurable` anyway.
8. **Excitation.** The reference excitation is dominated by camera x, labelled
   "tilt" in the camera frame, which is a portrait pan. Secondary axes carry
   3 to 72°. Only T14-225636 clears the production excitation policy.
9. **Build.** The engine is built without a build type, as
   `build/cpp-tests-panoplus` is. It links OpenCV 4.10.0 from
   `build/opencv-host`, which is a symlink to the sibling
   `react-native-image-stitcher` build.

## Reproduce

```bash
cd <repo root>
NODE=~/.nvm/versions/node/v22.22.3/bin/node tools/d3-basis-proof/run_all.sh
python3 tools/d3-basis-proof/contact_sheet.py tools/d3-basis-proof/out T14-225004 ar imu_C8 imu_C0 imu_C9 imu_C10 imu_C11 imu_C13
```
