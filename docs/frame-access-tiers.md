# Frame-access tiers (v0.9.0+)

> [!WARNING]
> **Historical (pre-0.15.0).** The host-worklet / frame-stream hooks described
> below — `useFrameProcessor`, `useThrottledFrameProcessor`, `useFrameStream` —
> were **removed in v0.15.0** (see the CHANGELOG). For the current pattern,
> compose vision-camera's own `useFrameProcessor` with the kept
> `useStitcherWorklet().call(frame)` first-party stitching hook (see the example app).

The lib exposes four host-facing hooks for accessing camera frames during AR / non-AR capture. Each hook trades latency for ergonomics differently — pick the layer that matches what you need.

## Decision flow

```
                  ┌──────────────────────────────────┐
                  │ Do you need frame data on every  │
                  │ camera frame (~30-60 Hz)?        │
                  └────────┬─────────────────────────┘
                           │ yes
                           ▼
                  ┌──────────────────────────────────┐
                  │ useFrameProcessor (Tier 3)       │
                  │ — every frame in a worklet       │
                  └──────────────────────────────────┘

                           │ no, lower rate
                           ▼
              ┌────────────────────────────────────────────┐
              │ Do you want a JS-thread callback           │
              │ (with a JPEG file path)?                   │
              └─────┬──────────────────────────────┬───────┘
                yes │                              │ no
                    ▼                              ▼
        ┌────────────────────┐         ┌──────────────────────────┐
        │ useFrameStream     │         │ useThrottledFrameProcessor│
        │ (Tier 2 — Layer 3) │         │ (Tier 2 — Layer 2)        │
        │ JPEG → JS callback │         │ Worklet, your processing  │
        └────────────────────┘         └──────────────────────────┘

                           │ or, only when the lib accepts a frame
                           ▼
                  ┌──────────────────────────────────┐
                  │ useKeyframeStream (Tier 1)       │
                  │ — 4-6 events per panorama        │
                  └──────────────────────────────────┘
```

## Hook reference

### `useFrameProcessor` (Tier 3) — every frame in a worklet

```tsx
import { Camera, useFrameProcessor, type StitcherFrame }
  from 'react-native-image-stitcher';

const fp = useFrameProcessor((frame: StitcherFrame) => {
  'worklet';
  // Runs on the camera producer thread / AR session callback thread.
  // Direct access to frame.toArrayBuffer(), frame.pose, frame.arDepth.
}, []);

return <Camera frameProcessor={fp} ... />;
```

- **Rate:** ~30-60 Hz (camera's native rate)
- **Threading:** worklet runtime (producer thread non-AR; lib's AR runtime in AR mode)
- **Use for:** anything that NEEDS every frame — true-realtime tracking, custom stabilisation

### `useThrottledFrameProcessor` (Tier 2 — Layer 2) — sub-frame-rate worklet

```tsx
import { Camera, useThrottledFrameProcessor, type StitcherFrame }
  from 'react-native-image-stitcher';

const fp = useThrottledFrameProcessor(
  (frame: StitcherFrame) => {
    'worklet';
    // Fires up to `sampleHz` times per second.
    // Same direct buffer/pose/depth access as Tier 3.
  },
  { sampleHz: 2 },
  [],
);

return <Camera frameProcessor={fp} ... />;
```

- **Rate:** host-controlled, clamped `[0.5, 30]` Hz
- **Threading:** same as Tier 3
- **Use for:** worklet-native processing at a sub-frame-rate
  - **Native OCR** via Vision.framework (iOS) / ML Kit (Android) wrapped as vc Frame Processor plugins
  - **TFLite ML inference** via vc plugins
  - **LiDAR depth** processing — `frame.arDepth` is too large to bridge to JS
  - **Pose-only telemetry** — tiny payload, no encoding needed

### `useFrameStream` (Tier 2 — Layer 3) — sampled JPEGs to JS thread

> [!IMPORTANT]
> **v0.9.0 limitation**: Layer 3 has two known constraints addressed in v0.11.0:
> 1. **AR mode** — the underlying `save_frame_as_jpeg` plugin doesn't yet
>    handle `CameraFrameHostObject` (the JSI frame from v0.8.0 Phase 4b);
>    `useFrameStream` samples silently never fire. For per-frame native
>    processing in AR mode, use **`useThrottledFrameProcessor`** (Layer 2)
>    instead — it's the right primitive for OCR via Vision/ML Kit, TFLite
>    ML, LiDAR depth.
> 2. **Non-AR mode** — wiring `useFrameStream`'s returned processor through
>    `<Camera frameProcessor={...}>` REPLACES the lib's first-party
>    stitching driver unless the host's worklet body also calls
>    `useStitcherWorklet().call(frame)` to compose first-party stitching
>    back in (v0.11.0+). See `useStitcherWorklet` reference below.

```tsx
import { Camera, useFrameStream, type SampledFrame }
  from 'react-native-image-stitcher';

const fp = useFrameStream(
  { sampleHz: 2, quality: 75 },
  (sample: SampledFrame) => {
    // JS-thread callback.  `sample.jpegPath` points at a JPEG on
    // disk; `sample.pose`, `sample.timestamp`, `sample.width`,
    // `sample.height` are metadata.
    setThumbnail(sample.jpegPath);
  },
);

return <Camera frameProcessor={fp} ... />;
```

- **Rate:** host-controlled, clamped `[0.5, 10]` Hz
- **Threading:** worklet → producer-thread JPEG encode → JS-thread callback via `runOnJS`
- **Slot reuse:** writes to `<outputDir>/stream-N.jpg` (N cycles 0..3 based on `timestamp / 1000`); bounds disk usage to ~4 stale JPEGs
- **Use for:** JS-thread consumers
  - **File-path OCR libraries** (RN modules wrapping ML Kit / Tesseract)
  - **Cloud upload** (sampled JPEG feed)
  - **Thumbnail preview UI** (`<Image source={{uri: sample.jpegPath}}>`)
  - **JS-side ML** (TF.js, transformers.js)

### `useKeyframeStream` (Tier 1) — accepted keyframes only

```tsx
import { useKeyframeStream, type AcceptedKeyframe }
  from 'react-native-image-stitcher';

useKeyframeStream(
  (kf: AcceptedKeyframe) => {
    // Fires only on stitcher-accepted keyframes (typically 4-6 per
    // panorama capture).  kf.jpegPath + kf.pose + kf.timestamp.
  },
);

// No `<Camera frameProcessor=...>` wiring needed.
```

- **Rate:** 4-6 events per panorama (whatever the lib's KeyframeGate decides)
- **Threading:** JS-thread callback
- **Use for:** per-keyframe enrichment that should align with what the lib stitches
  - Server-side analysis of the stitched scene
  - Packet detection / shelf inventory aligned with panorama keyframes
  - OCR on every accepted-frame JPEG

## Use-case mapping (canonical reference)

| Use case | Hook | Why |
|----------|------|-----|
| OCR via Vision.framework / ML Kit (wrapped as vc plugin) | `useThrottledFrameProcessor` | Native libs, bbox in frame coords; no JPEG roundtrip |
| OCR via RN module (file-path API) | `useFrameStream` | Host has JS-side OCR; just needs a JPEG |
| LiDAR depth → 3D reconstruction | `useThrottledFrameProcessor` | `frame.arDepth` too large to bridge |
| Native ML detection (TFLite as vc plugin) | `useThrottledFrameProcessor` | Same shape as native OCR |
| JS-side ML detection (TF.js, transformers.js) | `useFrameStream` | JS lib needs a file/path |
| Sampled cloud upload (1 Hz JPEG feed) | `useFrameStream` | JPEG IS the payload |
| Live thumbnail preview UI | `useFrameStream` | `<Image>` consumes the JPEG path |
| Pose-only telemetry | `useThrottledFrameProcessor` | Tiny payload, no encoding needed |
| Per-stitcher-accepted-frame enrichment | `useKeyframeStream` | Aligned with stitched output |
| Custom real-time stabilisation | `useFrameProcessor` | Needs every frame |
| Drawing bbox overlays on camera | Whatever drives detection | Boxes are JS state; rendering is independent |

## Cost envelope

| Hook | Cost per frame (no host worklets registered) | Cost per frame (when active) |
|------|-----------------------------------------------|------------------------------|
| `useKeyframeStream` | 0 — engine-internal; fires only on accept | ~10ms JPEG encode (already paid by engine) |
| `useFrameProcessor` | ~1 µs atomic-read for registry check | host's worklet body cost |
| `useThrottledFrameProcessor` | ~1 µs atomic-read | host's worklet body cost; only at `sampleHz` Hz |
| `useFrameStream` | ~1 µs atomic-read | ~20-50ms JPEG encode + runOnJS bridge; only at `sampleHz` Hz |

When no host hooks are mounted, the lib's first-party stitching path is unchanged (zero added cost).

## AR vs non-AR mode

All four hooks work in both modes:

- **AR mode**: worklets auto-register via `globalThis.__stitcherProxy` (v0.8.0 Phase 4b.i / 4b.iii). The AR-session dispatch path fans out to first-party stitching + every registered host worklet on every AR frame, with per-worklet failure isolation.
- **Non-AR mode**: the returned frame processor is passed to `<Camera frameProcessor={...}>` to wire up. vc's `<Camera>` accepts ONE processor — supplying a host processor in non-AR mode REPLACES the lib's first-party stitching driver unless the host worklet body calls `stitcher.call(frame)` (from `useStitcherWorklet`) to compose it back in. See the `useStitcherWorklet` reference below.

## Worklet hygiene

Three constraints all worklet bodies share:

1. **`'worklet'` prefix required.** TS can't enforce this; the runtime throws if missing.
2. **Buffer lifetime is one worklet call.** `frame.toArrayBuffer()` returns bytes valid only inside the worklet. Copy synchronously or pass to a native plugin that takes ownership.
3. **Don't block.** The next frame's processing is gated on the previous one returning. Long work belongs behind `runOnJS` or `Worklets.createRunOnJS`.

## `useStitcherWorklet` (v0.11.0+) — composable first-party stitching

Exposes the lib's first-party stitching (throttle + pose synthesis + native plugin call) as a callable worklet function.  Use this when you want to write your OWN `useFrameProcessor` worklet body that calls custom per-frame logic AND first-party stitching, without one displacing the other.

```tsx
import {
  Camera, useFrameProcessor, useStitcherWorklet,
  type StitcherFrame,
} from 'react-native-image-stitcher';

function MyScreen() {
  const stitcher = useStitcherWorklet();
  const fp = useFrameProcessor((frame: StitcherFrame) => {
    'worklet';
    hostPreLogic(frame);
    stitcher.call(frame);   // ← first-party stitching
    hostPostLogic(frame);
  }, [stitcher.call]);
  return <Camera frameProcessor={fp} ... />;
}
```

- **Threading:** producer-thread (the worklet runtime vc dispatches to).  `stitcher.call` is itself a worklet — no thread hop.
- **Pose tracking:** auto-managed.  Gyro subscribes on mount, unsubscribes on unmount.  Call `stitcher.reset()` at the start of each capture to zero accumulated pose between captures (the lib's built-in `useFrameProcessorDriver` does this internally for the default `<Camera>` integration; composed hosts should do it explicitly).
- **Lifetime:** safe to call before the JSI plugin has resolved — internally short-circuits.  Read `stitcher.isReady` (boolean) to gate UI on plugin readiness.
- **Pairing with `IncrementalStitcher.start`:** the plugin's per-frame call into the engine is gated by `frameProcessorIngestEnabled`, which is TRUE only when the stitcher was started with `frameSourceMode === 'frameProcessor'`.  Composed hosts must do this wiring themselves; the lib's `<Camera>` does it automatically when using the default driver.
- **AR mode:** no effect — `<Camera frameProcessor>` is non-functional in AR mode (vc's `<Camera>` isn't mounted in that path).  Host worklets in AR mode fire via `useFrameProcessor`'s `__stitcherProxy` auto-registration (v0.8.0 Phase 4b.i / 4b.iii).

### Migrating from v0.10.x

Hosts that adopted the v0.8.0 Phase 5 `frameProcessor` prop on v0.10.x currently REPLACE first-party stitching in non-AR mode (one-shot `console.info` notes this).  One-line code change to compose:

```diff
+ const stitcher = useStitcherWorklet();
  const fp = useFrameProcessor((frame: StitcherFrame) => {
    'worklet';
+   stitcher.call(frame);   // ← first-party stitching back in
    hostLogic(frame);
- }, [hostLogic]);
+ }, [stitcher.call, hostLogic]);
```

## See also

- `src/stitching/useFrameProcessor.ts` — the v0.8.0 base hook with full docstring
- `src/stitching/useThrottledFrameProcessor.ts` — Layer 2 hook
- `src/stitching/useFrameStream.ts` — Layer 3 hook
- `src/stitching/useKeyframeStream.ts` — Tier 1 hook
- `src/stitching/useStitcherWorklet.ts` — v0.11.0 composition hook
- `src/stitching/StitcherFrame.ts` — the unified frame contract worklets receive
- `docs/plans/2026-05-27-v0.9.0-layered-frame-helpers.md` — design rationale
