/**
 * CameraExample — minimal usage demonstration of the public `<Camera>`
 * component (step 2 of the SDK-extract plan).
 *
 * Purpose:
 *   1. Document the simplest possible `<Camera>` call-site so SDK
 *      consumers (and us, during step-2 validation) can copy/paste
 *      a working starting point.
 *   2. Exercise every callback prop at least once so the type
 *      contracts are checked at build time (the TS compiler verifies
 *      all callbacks against the discriminated union, error codes,
 *      etc.).
 *
 * This module is INTENTIONALLY not re-exported from the SDK's
 * `index.ts` — it ships in the `src/_examples/` directory of the
 * tarball as reference material, but consumers don't import it.
 *
 * Path conventions: anything under `src/_examples/` is reference
 * material.  Anything under `src/camera/`, `src/stitching/`, etc., is
 * production code.  When the public lib is extracted (step 5), this
 * file moves to `example/App.tsx` in the new repo for the Detox /
 * Snack demo path.
 */

import React from 'react';
import { Alert, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import {
  Camera,
  type CameraCaptureResult,
  type CameraError,
  type CaptureSource,
  type CameraLens,
  type FramesDroppedInfo,
} from '../camera/Camera';


/**
 * Reference screen — drop into a host app's navigator to verify the
 * `<Camera>` component end-to-end.
 *
 * Usage:
 *   <Stack.Screen name="CameraExample" component={CameraExample} />
 *
 * The default props produce a working capture screen with:
 *   - 1× wide-angle lens, AR ON
 *   - Tap shutter → photo, hold shutter → panorama
 *   - No internal settings button (consumers don't see it)
 *   - All callbacks log + alert for visual confirmation
 */
export function CameraExample(): React.JSX.Element {
  const handleCapture = (result: CameraCaptureResult): void => {
    // eslint-disable-next-line no-console
    console.log('[CameraExample] onCapture', result);
    if (result.type === 'photo') {
      Alert.alert(
        'Photo captured',
        `${result.width}×${result.height}\n${result.uri}`,
      );
    } else {
      Alert.alert(
        'Panorama stitched',
        `${result.width}×${result.height}\n${result.framesIncluded}/${result.framesRequested} frames\n${result.durationMs} ms`,
      );
    }
  };

  const handleCaptureSourceChange = (source: CaptureSource): void => {
    // eslint-disable-next-line no-console
    console.log('[CameraExample] onCaptureSourceChange', source);
  };

  const handleLensChange = (lens: CameraLens): void => {
    // eslint-disable-next-line no-console
    console.log('[CameraExample] onLensChange', lens);
  };

  const handleFramesDropped = (info: FramesDroppedInfo): void => {
    // eslint-disable-next-line no-console
    console.warn(
      '[CameraExample] onFramesDropped',
      `${info.included}/${info.requested}`,
    );
  };

  const handleError = (err: CameraError): void => {
    // eslint-disable-next-line no-console
    console.error('[CameraExample] onError', err.code, err.message);
    Alert.alert(`Camera error (${err.code})`, err.message);
  };

  return (
    <SafeAreaView edges={['top']} style={styles.safe}>
      <View style={styles.container}>
        <Camera
          defaultCaptureSource="ar"
          defaultLens="1x"
          enablePhotoMode
          enablePanoramaMode
          // Internal tester mode — set to true to see the settings
          // gear icon at top-right.  Public consumers leave at false.
          showSettingsButton={__DEV__}
          onCapture={handleCapture}
          onCaptureSourceChange={handleCaptureSourceChange}
          onLensChange={handleLensChange}
          onFramesDropped={handleFramesDropped}
          onError={handleError}
        />
      </View>
    </SafeAreaView>
  );
}


const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: '#000',
  },
  container: {
    flex: 1,
  },
});
