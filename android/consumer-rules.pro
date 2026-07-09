# react-native-image-stitcher — rules merged into CONSUMER app builds.
#
# v0.22.0 exposure-burst probe (`CameraHandle.captureExposureBurst`):
# the ONLY non-public hop to vision-camera's CameraX session is two
# reflected private fields (everything after is public CameraX
# Camera2-interop API).  Keep their NAMES stable under R8 so minified
# release builds of host apps don't break the probe.  Verified against
# react-native-vision-camera 4.7.3.
-keepclassmembers class com.mrousavy.camera.react.CameraView {
    ** cameraSession;
}
-keepclassmembers class com.mrousavy.camera.core.CameraSession {
    ** camera;
}
