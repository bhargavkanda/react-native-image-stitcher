# `cpp/tests/` — shared C++ unit test suite

v0.10.0 audit `#9A` introduced this directory to give the cross-platform
shared C++ code under `cpp/` a Google Test harness that runs on the
developer's host machine (not on a device or emulator).  Pairs with the
Android-side JUnit suite added in `#11A` (see
`android/src/test/java/io/imagestitcher/rn/`).

## Run

```sh
scripts/run-cpp-tests.sh           # configure + build + ctest
scripts/run-cpp-tests.sh --clean   # nuke build/cpp-tests/ first
```

Requires `cmake ≥ 3.20` and a C++17 toolchain (the macOS AppleClang
shipped with Xcode 14+ is fine; Linux GCC 9+ / Clang 10+ also work).

Build artefacts land under `build/cpp-tests/` (gitignored).  Google
Test is fetched at configure time via CMake `FetchContent` pinned to
`v1.14.0`; no system-wide install required.

## Scope (v0.10.0)

Covered:

- `Pose`, `PlaneTransform` (POD layout / size / field offsets — pinned
  to the cross-platform marshalling contract documented in
  `cpp/ar_frame_pose.h`).
- `CameraFrameData` (default-construction invariants the JSI host
  object's `get()` dispatch relies on).
- `PixelBufferReader` interface contract (clipping behaviour of
  `copyTo` — validated via the `FakePixelBufferReader` test helper).
- `StitcherWorkletRegistry` storage lifecycle: shared-instance,
  install/uninstall/count/snapshot, snapshot independence, concurrent
  installs yield unique IDs (16 threads × 32 installs).

Not yet covered (intentional deferrals):

- `KeyframeGate` (`cpp/keyframe_gate.cpp`) — depends on OpenCV
  (`opencv2/imgproc.hpp`, `opencv2/video.hpp` for `calcOpticalFlowPyrLK`).
  Linking the production OpenCV xcframework / Android SDK into the
  host-side test target would balloon CI time and disk usage; the
  alternative is to land a stripped-down `libopencv-core` host build
  just for tests.  Deferred — comes with the v0.11.0 cross-platform
  parity suite (`#2C`).
- `stitcher.cpp` — uses the full OpenCV stitching pipeline; same
  reason as above.
- JSI host-object dispatch (`camera_frame_jsi.cpp`,
  `stitcher_proxy_jsi.cpp`, `stitcher_worklet_dispatch.cpp`) — needs
  a real Hermes runtime.  The `StitcherWorkletRegistry` tests sidestep
  this via the `_installEntryForTests` seam + JSI stubs under
  `stubs/`; the JSI dispatch paths can't be similarly stubbed because
  they actively call into the runtime.

## How the JSI-dependent registry tests work without a real JSI

`stitcher_worklet_registry.cpp` `#include`s
`<jsi/jsi.h>` and `<react-native-worklets-core/WKTJsiWorklet.h>` to
construct `WorkletInvoker` instances from a real JS runtime.  The test
target sidesteps both by:

1. Putting `cpp/tests/stubs/` first on the compiler's include path so
   `#include <jsi/jsi.h>` resolves to `stubs/jsi/jsi.h` (which declares
   `facebook::jsi::Runtime` / `Value` as empty classes — enough for
   the registry's reference-only usage), and
   `#include <react-native-worklets-core/WKTJsiWorklet.h>` resolves to
   `stubs/react-native-worklets-core/WKTJsiWorklet.h` (which declares
   `RNWorklet::WorkletInvoker` with a no-op constructor).
2. Calling `_installEntryForTests(nullptr)` instead of the production
   `install(runtime, value)` path.  The registry stores the
   `shared_ptr<WorkletInvoker>` but never dereferences it (it only
   hands it back via `snapshot`), so `nullptr` is safe.

The stubs live exclusively under `cpp/tests/stubs/`; production
builds never see them.  See `stubs/jsi/jsi.h`'s docstring for the
guard-rails.

## Two projects, no aggregator

There are TWO independent CMake projects under `cpp/tests/`, and that is
deliberate:

| project | source dir | what it covers | cases |
|---|---|---|---|
| `stitcher_cpp_tests` | `cpp/tests/` | the shared C++ port — keyframe gate, glare, sharpness, blur policy, the JSI helpers | 124 |
| pano+ | `cpp/tests/panoplus/` | the sweep engine that arrived with the `PanoPlus` subspec | 523 |

There is no `add_subdirectory` parent joining them. A parent would make them
one CMake project again and hide exactly the coupling the package split
exists to expose — and they must not share a `FETCHCONTENT_BASE_DIR` either:
with a shared one both configures exit 0 and then the FIRST-configured
project dies at link time on a missing `lib/libgtest_main.a`.

Drive both with `scripts/run-cpp-tests.sh`, which gives each its own build
directory and asserts a minimum discovered-case count per project.

### Both need a host OpenCV, and one of them lies about it

`cpp/tests` declares its OpenCV cases inside `if(OpenCV_FOUND)`: with no host
OpenCV it configures them out, ctest prints `0 tests failed out of 115` and
exits 0, and nine cases have vanished behind a green run. `cpp/tests/panoplus`
uses `find_package(OpenCV REQUIRED)` and fails to configure instead, which is
the louder and better behaviour. `scripts/run-cpp-tests.sh` refuses to run
without one unless `--allow-no-opencv` is passed.

Build one locally with `cmake -DBUILD_LIST=core,imgproc,imgcodecs
-DBUILD_SHARED_LIBS=OFF` against an OpenCV 4.10 source tree, installed to
`build/opencv-host/install` — the path the script auto-detects. Pin 4.10 to
match the vendored device build; a newer host OpenCV is API-compatible for
the surface used here but is not byte-parity evidence.

## When NOT to add a test here

- If the test needs a real JSI runtime or real-device sensor data, it belongs
  in `android/src/androidTest/` (instrumented), the iOS Swift test target, or
  the parity harness — NOT here.
- Real OpenCV operations ARE in scope now, in both projects: four pano+
  runners call `imread`/`imwrite` and the sharpness suite needs `imgproc`.
  That is what the host-OpenCV requirement above is for.
- If the test verifies TypeScript/JS-side behaviour, it belongs under
  `src/**/__tests__/` (Jest).
