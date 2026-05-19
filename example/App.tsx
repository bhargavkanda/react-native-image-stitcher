/**
 * RNImageStitcherExample — minimal host that demonstrates the public
 * `<Camera>` component end-to-end.
 *
 *   - Tap shutter → photo captured.
 *   - Hold + pan + release → panorama stitched.
 *   - All callback props are wired and either Alert / console.log
 *     the result, so you can confirm the event flow on-device.
 *
 * The component is the only thing exported by the library that you
 * actually need to render — everything else (preview, shutter, lens
 * chip, AR toggle, settings modal) is owned by `<Camera>`.
 */

import React from 'react';
import { Alert, SafeAreaView, StatusBar, StyleSheet } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import {
  Camera,
  type CameraCaptureResult,
  type CameraError,
  type CaptureSource,
  type CameraLens,
  type FramesDroppedInfo,
} from 'react-native-image-stitcher';


function App(): React.JSX.Element {
  const handleCapture = (result: CameraCaptureResult): void => {
    // eslint-disable-next-line no-console
    console.log('[example] onCapture', result);
    if (result.type === 'photo') {
      Alert.alert(
        'Photo captured',
        `${result.width}×${result.height}\n${result.uri}`,
      );
    } else {
      Alert.alert(
        'Panorama stitched',
        `${result.width}×${result.height}\n`
          + `${result.framesIncluded}/${result.framesRequested} frames\n`
          + `${result.durationMs} ms`,
      );
    }
  };

  const handleCaptureSourceChange = (source: CaptureSource): void => {
    // eslint-disable-next-line no-console
    console.log('[example] onCaptureSourceChange', source);
  };

  const handleLensChange = (lens: CameraLens): void => {
    // eslint-disable-next-line no-console
    console.log('[example] onLensChange', lens);
  };

  const handleFramesDropped = (info: FramesDroppedInfo): void => {
    // eslint-disable-next-line no-console
    console.warn(
      '[example] onFramesDropped',
      `${info.included}/${info.requested}`,
    );
  };

  const handleError = (err: CameraError): void => {
    // eslint-disable-next-line no-console
    console.error('[example] onError', err.code, err.message);
    Alert.alert(`Camera error (${err.code})`, err.message);
  };

  return (
    <SafeAreaProvider>
      <StatusBar barStyle="light-content" />
      <SafeAreaView style={styles.safe}>
        <Camera
          defaultCaptureSource="ar"
          defaultLens="1x"
          enablePhotoMode
          enablePanoramaMode
          // Internal-tester mode: gear icon at top-right opens
          // PanoramaSettingsModal.  Defaults to false for public
          // consumers; flip on for development.
          showSettingsButton={__DEV__}
          onCapture={handleCapture}
          onCaptureSourceChange={handleCaptureSourceChange}
          onLensChange={handleLensChange}
          onFramesDropped={handleFramesDropped}
          onError={handleError}
        />
      </SafeAreaView>
    </SafeAreaProvider>
  );
}


const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: '#000',
  },
});


export default App;
