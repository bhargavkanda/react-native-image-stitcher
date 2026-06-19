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
