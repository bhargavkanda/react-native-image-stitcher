---
id: photo-depth
title: Photo depth sidecar (iOS)
---

# Photo depth sidecar (iOS)

Opting into `<Camera captureDepthData>` makes each **non-AR tap photo**
also save the capture's `AVDepthData` as a small binary sidecar next to
the photo, and return its path as `depthPath` on the photo
[`CameraCaptureResult`](./capture-result.md):

```tsx
<Camera captureDepthData onCapture={(r) => {
  if (r.ok && r.type === 'photo' && r.depthPath) {
    // r.depthPath === `${bare(r.uri)}.depth.bin`
  }
}} />
```

Why a sidecar instead of the photo's own embedded depth: the SDK
normalises every photo's EXIF orientation by re-encoding the JPEG, which
strips all auxiliary images — embedded depth can never survive to
consumers. The SDK extracts the depth **before** that re-encode and
parks it in the sidecar.

## Device support

| Hardware | Depth | Notes |
|---|---|---|
| Dual-/triple-camera iPhones | ✅ stereo | Disparity-derived; `accuracy` may be `relative`. |
| LiDAR iPhones (Pro/Pro Max) | ✅ LiDAR-backed | `accuracy: "absolute"`. |
| Single-lens iPhones (SE etc.), front camera in this SDK, Android | ❌ | Capture proceeds normally; `depthPath` is simply absent. |

The **mounted device** must be depth-capable: the SDK's lens-driven
multicam selection (the default in `<Camera>`) qualifies on any
multi-lens phone. The format picker automatically prefers a
`supportsDepthCapture` format while the flag is on. AR captures never
produce a sidecar (ARKit owns the camera there — use the AR depth
surfaces instead).

Depth delivery adds per-shot latency (stereo/LiDAR processing), which is
why the prop is opt-in.

## Sidecar container format — `RNISDEP1`, version 1

`<photo>.depth.bin`, little-endian throughout:

| Offset | Size | Content |
|---|---|---|
| 0 | 8 | ASCII magic `RNISDEP1` |
| 8 | 4 | `UInt32` LE — byte length **N** of the JSON header |
| 12 | N | UTF-8 JSON header (fields below) |
| 12 + N | `width × height × 4` | `Float32` LE depth in **metres**, row-major, top-left origin |

Payload values that are non-finite (NaN/±Inf) or ≤ 0 are **holes** — "no
depth measured here". The raster is in the photo's **sensor orientation
as captured** (i.e. *before* the SDK bakes the EXIF rotation into the
photo's pixels), so it is typically landscape even for a portrait shot.
Plane-fit / statistics consumers can ignore orientation entirely — 3-D
structure is rotation-invariant when back-projecting with the matching
intrinsics.

### JSON header fields

```jsonc
{
  "version": 1,
  "width": 768, "height": 576,      // depth-map dims (px)
  "unit": "m",
  "byteOrder": "LE",
  "rowMajor": true,
  "source": "disparity",            // "disparity" | "depth" — which auxiliary
                                     // image the photo carried; the payload is
                                     // ALWAYS converted to depth-in-metres
  "accuracy": "absolute",           // AVDepthData.depthDataAccuracy
  "quality": "high",                // AVDepthData.depthDataQuality
  "filtered": true,                 // holes interpolated by AVFoundation
  "orientation": 6,                 // EXIF orientation of the photo file, 0 = unknown
  "photoWidth": 4032,               // photo raster dims as stored (sensor
  "photoHeight": 3024,              //  orientation, pre-normalise)
  "intrinsics": {                   // null when the capture carried no calibration
    "fx": 3021.5, "fy": 3021.5,     // focal lengths (px)
    "cx": 2011.0, "cy": 1507.5,     // principal point (px)
    "refWidth": 4032.0,             // dims the intrinsics are expressed at —
    "refHeight": 3024.0             //  the FULL sensor raster, NOT the depth map
  }
}
```

### Consuming the depth

- **Map depth pixels → photo pixels**: scale by
  `photoWidth / width` (both are sensor-oriented).
- **Back-project to 3-D camera space**: scale the intrinsics to the depth
  raster first — `s = width / refWidth`, then
  `X = (x − cx·s)·Z / (fx·s)`, `Y = (y − cy·s)·Z / (fy·s)`, `Z = depth[y][x]`.
- **No intrinsics** (`intrinsics: null`): fall back to a nominal iPhone
  wide-camera FOV (≈ 60–70° horizontal, i.e. `fx ≈ 0.8–0.9 × width`);
  fine for relative-geometry uses like planarity.
- `source` is informational only — the payload is metres either way.

The reference encoder/decoder lives in
`ios/Sources/RNImageStitcher/PhotoDepthSidecar.swift`, with the framing
pinned byte-by-byte in `ios/Tests/RNImageStitcherTests/PhotoDepthSidecarTests.swift`
(`swift test` from `ios/`). Treat this page + those tests as the contract;
the container is designed to be trivially parseable from Swift, Kotlin,
Python (`struct` + `json`), or JS.

## Failure modes (all non-fatal)

The sidecar is an **advisory extra** — no depth condition ever fails the
photo capture. `depthPath` is absent when:

- the platform is Android, or the capture ran in AR mode;
- the device/format has no depth support (single-lens hardware);
- the host app's native lib predates this feature;
- depth extraction or the sidecar file move failed (a `console.warn`
  explains why).
