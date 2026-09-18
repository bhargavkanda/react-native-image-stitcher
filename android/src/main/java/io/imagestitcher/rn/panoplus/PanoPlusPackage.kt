// SPDX-License-Identifier: Apache-2.0
//
// PanoPlusPackage.kt — the PANO+ half's registrar.
//
// ⚠ THIS IS NOT AUTOLINKED, AND MUST NOT BE. React Native's Gradle generator
// instantiates exactly ONE ReactPackage per npm dependency
// (GeneratePackageListTask keys on the package, and react-native.config.js
// names a single packageInstance), so a second top-level registrar in the same
// npm package compiles, ships inside the .aar, and is never constructed — five
// pano+ module ids simply absent from NativeModules at runtime, with a green
// build and a successful install. That failure mode has already cost this
// project eighteen days once.
//
// So StitchPluginsPackage stays the sole autolinked entry point and DELEGATES
// to this class. That keeps the split self-contained inside this repo: no
// MainApplication.kt edit in the host, no react-native.config.js change, and
// nothing to remember when the package is consumed elsewhere.
//
// When the pano+ half moves to its own npm package, this class becomes THAT
// package's autolinked registrar and the delegation in StitchPluginsPackage is
// deleted — a three-line change, and the only step that touches a host.

package io.imagestitcher.rn.panoplus

import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.ViewManager

class PanoPlusPackage : ReactPackage {
    // ⚠ THE PROBE AND RECORDER INSTANCES ARE SHARED, NOT RE-CREATED — carried
    // verbatim from StitchPluginsPackage, because the reason is unchanged by
    // the split and is the kind of thing a move quietly loses. The recorder
    // holds its capture session in an instance field, so a second instance
    // would let `RNSSweepTools.startRecording()` and
    // `RNSSweepRecorder.stop()` address DIFFERENT sessions — a camera
    // left open with nothing able to close it. There is exactly one back
    // camera. Constructing them here, once, and passing them in is what makes
    // that impossible rather than merely unlikely.
    //
    // ⚠ AND THE SPLIT MAKES THAT SHARPER, NOT SOFTER: if this registrar and the
    // private one each built their own recorder, the two Camera2 owners would
    // be in different libraries and the symptom would read as a native bug.
    override fun createNativeModules(
        reactContext: ReactApplicationContext,
    ): List<NativeModule> {
        val probe = PanoPlusAndroidProbe(reactContext)
        val recorder = PanoPlusAndroidRecorder(reactContext)
        return listOf(
            probe,
            recorder,
            PanoPlusAndroidModule(reactContext, probe, recorder),
            PanoPlusLiveModule(reactContext, recorder),
        )
    }

    // The pano+ VIEWFINDER. Holds no instance state: the view and the recorder
    // rendezvous through the process-wide PanoPlusPreview object, because React
    // creates the view and RN creates the module and neither can be handed a
    // reference to the other.
    override fun createViewManagers(
        reactContext: ReactApplicationContext,
    ): List<ViewManager<*, *>> = listOf(PanoPlusPreviewViewManager())
}
