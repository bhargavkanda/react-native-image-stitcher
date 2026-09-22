package com.rnimagestitcherexample

import android.app.Application
import com.facebook.react.PackageList
import com.facebook.react.ReactApplication
import com.facebook.react.ReactHost
import com.facebook.react.ReactNativeApplicationEntryPoint.loadReactNative
import com.facebook.react.defaults.DefaultReactHost.getDefaultReactHost
import io.imagestitcher.rn.RNSARPluginRegistry

class MainApplication : Application(), ReactApplication {

  override val reactHost: ReactHost by lazy {
    getDefaultReactHost(
      context = applicationContext,
      packageList = PackageList(this).packages,
      jsMainModulePath = "index",
      // ⚠ THE FIELD LEVER. `useDevSupport` defaults to `ReactBuildConfig.DEBUG`
      // (DefaultReactHost.kt:69), and when it is true RN loads the bundle from
      // Metro and has NO fallback to the embedded one — an unreachable dev
      // server is a red screen, not a graceful degrade. Forcing it false on a
      // `-PfieldBuild=true` build makes it load `assets/index.android.bundle`
      // instead, so the app is standalone while the APK stays debuggable and
      // `run-as` can still pull the capture packs back off the phone.
      //
      // `__DEV__` is NOT affected: it comes from the bundle's own `--dev`
      // flag, not from this, so a `--dev true` bundle keeps every
      // `__DEV__`-gated path alive exactly as it behaves under Metro.
      useDevSupport = !BuildConfig.FIELD_BUILD,
    )
  }

  override fun onCreate() {
    super.onCreate()
    loadReactNative(this)

    // 0.19.0 — register the sample AR frame-processor plugin (Android twin
    // of the example iOS AppDelegate's FrameBrightnessPlugin registration).
    // Proves the AR plugin framework end-to-end: the SDK calls
    // FrameBrightnessPlugin.process() per ARCore frame while the registry is
    // non-empty, and its SYNC { brightness } result rides the onArFrame
    // event under `meta.plugins.frameBrightness` (surfaced in App.tsx's AR
    // overlay).  The SDK ships only the generic framework — concrete plugins
    // like this one live in the host app.
    RNSARPluginRegistry.register(FrameBrightnessPlugin())
  }
}
