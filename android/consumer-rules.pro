# SPDX-License-Identifier: Apache-2.0
#
# Consumer R8/ProGuard rules, applied to every HOST app that minifies.
#
# RNImageStitcherPackage resolves the vision-camera plugin registrar BY NAME
# (Class.forName + getMethod) so this package still builds without
# vision-camera, where the class is excluded. Nothing references it
# statically, so a minified host strips it and every Frame Processor plugin
# this package ships (the keyframe gate, save-frame, the sweep ingest) goes
# unregistered with no build error. On a build without vision-camera the class
# is absent and this rule matches nothing, which is harmless.
-keep class io.imagestitcher.rn.VisionCameraPluginRegistrations {
    public static void registerAll();
}

# The ARCore availability probe (panoplus/PanoPlusArCoreReference.kt) is also
# reflective: it looks up ArCoreApk.getInstance / checkAvailability by name so
# a missing ARCore runtime is a reported reason, not a crash.
-keep class com.google.ar.core.ArCoreApk {
    public static com.google.ar.core.ArCoreApk getInstance();
    public *** checkAvailability(android.content.Context);
}
