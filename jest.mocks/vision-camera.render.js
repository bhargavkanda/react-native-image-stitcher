// SPDX-License-Identifier: Apache-2.0
/**
 * `react-native-vision-camera` — render-project mock.
 *
 * ⚠ WHY THIS EXISTS AT ALL. Importing the real package executes a module-
 * scope initializer that throws `system/camera-module-not-found` the moment
 * `NativeModules.CameraView` is absent — which it always is off-device. That
 * is a TEST SUITE FAILED TO RUN, not a test failure, so it takes every case
 * in the file with it and reports nothing about the code under test.
 *
 * The sweep surface never mounts `<Camera>` (it draws an `<ARCameraView>`
 * over an AR session it does not own), but it imports modules that import it
 * transitively. So this stands in for the module, not for a camera: every
 * export exists, nothing pretends to produce frames, and a test that wants a
 * device says so itself.
 *
 * ⚠ `useCameraDevice` RETURNS null BY DEFAULT, and that is deliberate. "No
 * camera on this machine" is the honest answer off-device, and it is the
 * branch a component must survive. A mock that invented a device would make
 * every no-device path untested and every test a little bit fictional.
 */
const React = require('react');

const Camera = React.forwardRef((props, ref) => null);
Camera.displayName = 'Camera';
Camera.getAvailableCameraDevices = () => [];
Camera.requestCameraPermission = async () => 'granted';
Camera.getCameraPermissionStatus = () => 'granted';

module.exports = {
  Camera,
  useCameraDevice: () => null,
  useCameraDevices: () => [],
  useCameraPermission: () => ({ hasPermission: true, requestPermission: async () => true }),
  // A frame processor is a worklet in production. Off-device it is the
  // identity: the tests that care about fan-out drive the registry directly.
  useFrameProcessor: (fn) => fn,
  VisionCameraProxy: {
    initFrameProcessorPlugin: () => null,
    removeFrameProcessorPlugin: () => undefined,
  },
  // Enum-ish values that appear in format-selection code paths.
  PhysicalCameraDeviceType: {
    'ultra-wide-angle-camera': 'ultra-wide-angle-camera',
    'wide-angle-camera': 'wide-angle-camera',
    'telephoto-camera': 'telephoto-camera',
  },
};
