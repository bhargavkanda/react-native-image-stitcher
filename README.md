# @retailens/capture-sdk

Camera capture + quality scoring + (stubbed) video stitching, extracted
from `retailens-mobile` so we can ship it to partners and white-label
it later.  Lives in this monorepo and is consumed by `retailens-mobile`
as a `file:` dependency.

## Status

| Surface                 | Status                                           |
| ----------------------- | ------------------------------------------------ |
| `useCapture` hook       | ✅ shipped — used by `AuditCaptureScreen`        |
| `<CameraView>`          | ✅ shipped — used by `AuditCaptureScreen`        |
| `useVideoCapture` hook  | ⚠️ recording works; `extractFrames` stub         |
| `runQualityCheck`       | ⚠️ JS shim — returns optimistic pass until native|
| `stitchFrames`          | ⚠️ stub — throws `StitchNotImplementedError`    |

The real OpenCV-backed quality + stitching native modules are the next
increment (roadmap item #8, second-half).

## Usage (from a React Native host app)

```tsx
import {
  CameraView,
  useCapture,
} from '@retailens/capture-sdk';

export function ShelfCaptureScreen() {
  const { cameraRef, device, hasPermission, requestPermission,
          flash, toggleFlash, isCapturing, takePhoto } = useCapture({
    cameraPosition: 'back',
  });

  if (!hasPermission) {
    return <Button title="Grant camera" onPress={requestPermission} />;
  }

  return (
    <View style={{ flex: 1 }}>
      <CameraView ref={cameraRef} device={device} flash={flash} />
      <Button title="Flash"   onPress={toggleFlash} />
      <Button title="Capture" onPress={takePhoto} disabled={isCapturing} />
    </View>
  );
}
```

## Peer dependencies

Host apps MUST provide:

- `react ≥ 18.0.0`
- `react-native ≥ 0.72.0`
- `react-native-vision-camera ≥ 4.0.0`

This is intentional.  Nesting them here causes a duplicate
TurboModule registry when the host app runs Jest tests — the
`.npmrc` uses `legacy-peer-deps=true` to stop npm v7+ from
auto-installing them.

## Building

```sh
cd retailens-capture-sdk
npm install          # installs typescript + @types/react only
npm run build        # tsc → dist/
npm run typecheck    # tsc --noEmit
```

The TypeScript config uses `paths` to resolve `react-native` and
`react-native-vision-camera` types from the sibling `retailens-mobile`
install.  That means you need `retailens-mobile` to be bootstrapped
(`npm install` there) before the SDK's own build succeeds.

## Host-app Jest integration

Jest resolving a symlinked local dep (this package via `file:`)
won't walk up to the host's `node_modules` on its own, so the host
must set:

```js
// retailens-mobile/jest.config.js
modulePaths: ['<rootDir>/node_modules'],
moduleNameMapper: {
  '^@retailens/capture-sdk$':
    '<rootDir>/../retailens-capture-sdk/src/index.ts',
},
```

The first line makes transitive `react-native` / `vision-camera`
imports land on the host's single copy; the second short-circuits
the SDK's `dist/` so tests see the TypeScript source directly.

## Roadmap

- **Native stitcher (iOS)**: OpenCV for iOS + Swift bridging header
  that wraps `cv::Stitcher::stitch`.  Registers as
  `NativeModules.BatchStitcher`.  Unlocks both `stitchFrames`
  and `useVideoCapture.extractFrames` in one go.
- **Native stitcher (Android)**: JNI binding to OpenCV for Android.
  Blocked on iOS validating the panorama UX first.
- **Native quality module**: Laplacian variance + mean intensity
  sampling on a downscaled copy of the capture.  Same native module
  surface as the stitcher, so they ship together.
- **Framing overlay**: a themed bounding-box / rule-of-thirds
  overlay layered on top of `<CameraView>`.  Pure-JS, separate PR.
