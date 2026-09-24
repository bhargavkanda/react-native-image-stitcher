# D3 basis proofs (offline)

Two offline proofs the unify-camera plan requires before device rounds on the
iOS vision-camera sweep arm. That arm now derives the device-to-camera basis
`C` at hold start instead of reading a measured one, and it refuses any
answer other than basis #8 (`-y+x+z`, row-major `[[0,1,0],[-1,0,0],[0,0,1]]`,
measured on iPhone17,1).

1. **Is #8 right?** This runs the shared C++ `rnis::pano::selectBasis`, the
   same function production calibration calls, over packs that recorded both
   attitude channels. It also runs the shared derivation
   `rnis::pano::android::deriveBasis(90°, Back, RawSensorBuffer)`, which is
   what the iOS arm computes from Apple's 90° back-camera mounting.
2. **Does the image-side check catch a wrong `C`?** The same packs are
   replayed through the engine once with #8 and once with several wrong
   bases. Each replayed latch is then graded with the shipped JS
   `panoPlusBasisImageCheck`.

The results are in [results.md](results.md).

## What is called, and what is not re-implemented

| Step | Code |
|---|---|
| Basis selection | `selectBasis`, `excitation`, `gradeExcitation`, `gradeBasis`, `basisStability` from `cpp/panoplus/rnis_pano_{attitude,calib}.cpp`. This follows the sequence in `RNISPanoCalibCore.mm solveBasisWithTauS:` (τ = 0, stability at ±5 and ±10 ms). |
| Derivation | `rnis::pano::android::deriveBasis` (`cpp/panoplus/rnis_pano_android_basis.cpp`), called with the request `RNISPanoAttitude.mm deriveBackBasisForMountingAngleDeg:` builds. |
| Reading the reference series | `track.jsonl` via `replay::parseTrackRow`, the replay's own parser. Only `"normal"` tracking rows are kept, following the `RNISPanoBasisCalibration.swift` rule. |
| Reading the IMU series | `attitude_imu.jsonl` (see `RNISPanoImuSidecar.swift`). It is read with the ingest rules of `RNISPanoCalibCore.mm pushImu`: drop non-finite rows, normalise, and keep only strictly increasing timestamps. |
| Mapping the IMU through `C` | `rnis::pano::AttitudeAligner` with τ = 0 uncorrected and `basisIndex = C`, which gives `R_engine = R_imu · C`. |
| Engine replay | the unmodified `replay::replayPack`. The tool writes a synthetic pack whose `track.jsonl` differs from the original only in its attitude columns. `frames/`, `meta.json` and `ledger.jsonl` are symlinks to the original pack. |
| Verdict | `panoPlusBasisImageCheck` and `PANO_PLUS_BASIS_CHECK`, imported from `src/sweep/panoPlusModel.ts` under Node's type stripping. |

This tool does not modify any production file. `replayPack` has no basis
override, so the override exists only in `d3_basis_replay.cpp`, as a rewritten
`track.jsonl`.

### The rewritten row (vision-camera arm shape)

These fields match `RNISPanoSweepFrameProcessor.mm`:

- `q` comes from the aligner.
- `tracking` is 2 or 1 as the aligner reports it. A refused alignment is still
  ingested, with `tracking` 0 and the aligner's identity `q`.
- `t = 0`.
- There is no ARKit exposure.
- Everything else in the row is the original.

### Replay arms

| Arm | Attitude |
|---|---|
| `ar` | the pack's own `track.jsonl` (ARKit), unchanged |
| `arq` | ARKit `q` and tracking in the vision-camera row shape. Comparing `arq` with `ar` isolates the row shape. |
| `<n>` | CoreMotion sidecar through basis #n |

The default arms are `ar arq 8 0 9 10 11 13`. Relative to #8:

| Basis | Rotation relative to #8 | Role in the test |
|---|---|---|
| #0 | quarter turn about the optical axis | wrong basis |
| #9 | 180° about the optical axis (both image axes flipped) | wrong basis |
| #10 | 180° about camera y | wrong basis |
| #11 | 180° about camera x | commutes with the sweep's own rotation axis. The image check is predicted to be blind to it. |
| #13 | 90° about camera x | same as #11. It is also `selectBasis`'s usual runner-up. |

## Build and run

You need:

- CMake 3.20 or later and a C++17 compiler
- the host OpenCV at `build/opencv-host/install`, which is the one
  `scripts/run-cpp-tests.sh` uses
- Node 22.6 or later for the verdict step, because it imports the `.ts` file
  directly
- `python3` with `cv2` and `numpy`, for contact sheets only

Commands, run from the package root:

```bash
# everything: build, (1a) derive, (1b) selectBasis x 9 packs, (2) replay x 9 packs x 8 arms, tables
NODE=~/.nvm/versions/node/v22.22.3/bin/node tools/d3-basis-proof/run_all.sh

# or step by step
cmake -S tools/d3-basis-proof -B tools/d3-basis-proof/build \
      -DOpenCV_DIR=$PWD/build/opencv-host/install/lib/cmake/opencv4
cmake --build tools/d3-basis-proof/build -j8
tools/d3-basis-proof/build/d3_select_basis --derive
tools/d3-basis-proof/build/d3_select_basis "<packDir>" ["<packDir>" ...]
tools/d3-basis-proof/build/d3_basis_replay "<packDir>" tools/d3-basis-proof/out <tag> ar arq 8 0 9 10 11 13
node --experimental-strip-types --no-warnings tools/d3-basis-proof/tables.mjs tools/d3-basis-proof/out

# see the canvases side by side
python3 tools/d3-basis-proof/contact_sheet.py tools/d3-basis-proof/out PP3-124737 ar imu_C8 imu_C0 imu_C9 imu_C10 imu_C11 imu_C13
```

To change the arms, set `ARMS="ar 8 0 9"`. To add or remove packs, edit
`packs.txt` (tab-separated `<tag>	<packDir>`, git-ignored: copy
`packs.example.txt` and point each row at the pack on your machine).

A full run takes about 4 minutes on an M-series Mac. The engine is built
without a build type, the same as `build/cpp-tests-panoplus`.

## Outputs

Everything goes under `out/`, which is gitignored:

| File | Contents |
|---|---|
| `derive.jsonl` | the derivation, plus the 24-candidate table |
| `select.jsonl` | one `selectBasis` report per pack: the top 6 fits, the fit for #8, the grade, stability and excitation |
| `replay.jsonl` | one replay report per pack and arm: latch, regime, outcome counts, aligner counters, oracle diff, canvas size |
| `tables.md` | the tables in `results.md`, regenerated |
| `<tag>/<arm>/panoplus/` | the synthesised pack |
| `<tag>/<arm>/replay/` | the replayed `canvas.jpg` and `ledger.jsonl` |
| `contact_<tag>.jpg` | the canvases for every arm, side by side |

## Files

| File | Purpose |
|---|---|
| `CMakeLists.txt` | builds the two CLIs against `cpp/panoplus/*.cpp` in place |
| `d3_packio.hpp` | readers for `track.jsonl` and `attitude_imu.jsonl`, following the calibration recorder's ingest rules |
| `d3_select_basis.cpp` | proof (1) |
| `d3_basis_replay.cpp` | proof (2) |
| `tables.mjs` | grades each latch with the shipped JS check and writes the tables |
| `run_all.sh` | runs everything end to end |
| `contact_sheet.py` | renders the canvases side by side |
| `packs.example.txt` | the nine packs (template for the git-ignored `packs.txt`) |
| `results.md` | the results as of 2026-09-24 |
