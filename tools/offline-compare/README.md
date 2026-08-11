# offline-compare — replay a debug pack through the real stitcher

Turns a field capture into a **decomposable measurement** instead of an
eyeballed preview. Given a *debug pack* (the keyframes + `pack.json` the app
writes when `debugPack` is on), it runs the **real** `retailens::stitchFramePaths`
on-device at several budgets and reports wall time, output dims, and SSIM.

Primary uses:
- **compose A/B** — off (1.0 MP) vs always (floor, e.g. 0.6): measure exactly
  what the `adaptiveStitchMode` cut costs in pixels (SSIM) and saves in time.
- **RCA ablation** — sweep one factor (registration MP, threads, seam, compose)
  to attribute a slow stitch. See `docs/perf-rca-079-stitch-time.md`.

## Pieces

| file | what |
|---|---|
| `stitch_probe.cpp` | arm64 probe; runs `stitchFramePaths` with compose/reg/range/threads/seam/warper/orient/mode from argv, prints a `RESULT {json}` line |
| `build_stitch_probe.sh` | cross-compiles the probe against the vendored OpenCV android SDK (NDK 27.1) |
| `offline_compare.py` | pushes a pack's keyframes + probe to a device, runs field/off/always (+`--ablate`), pulls outputs, computes SSIM, writes `report.json` + a side-by-side PNG |

## Prereqs

- Android NDK 27.1 (override with `ANDROID_NDK`), `adb` (override with `ADB`).
- The repo's vendored OpenCV at `android/vendor/OpenCV-android-sdk` (the normal
  OpenCV fetch/postinstall).
- A device on adb. Python with `numpy` + `Pillow`.

## Use

```bash
# 1. build the probe (once)
bash tools/offline-compare/build_stitch_probe.sh

# 2. get a pack off the device (debugPack must have been ON for the capture)
adb -s <serial> exec-out run-as <app.id> \
  tar c cache/rlis-capture-<uuid> | tar x -C ./pack

# 3. compare / ablate
python tools/offline-compare/offline_compare.py ./pack --ablate
```

Outputs land in `./pack/compare/`: `report.json`, `off_1.0.jpg`,
`always_floor.jpg`, `off_vs_always.png`.

## Notes

- The probe runs on the **device**, so wall times are that device's native cost
  (`stitchWallMs`-equivalent). Run it on the A34 to reproduce a field time; run
  it on any arm64 device for a relative A/B.
- The registration-resolution sweep is the retry-ladder cliff probe:
  `stitch_probe out.jpg 1.0 1.3 3 1 graphcut spherical portrait panorama <kf…>`
  (the `1.3` is `regMP`). See the RCA doc.
- `pack.json` has no image bytes — device/recipe/result/timings + keyframe
  filenames only.
