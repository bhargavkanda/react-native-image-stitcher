package com.rnimagestitcherexample

import android.app.Application
import android.content.res.Configuration
import com.facebook.react.PackageList
import com.facebook.react.ReactApplication
import com.facebook.react.ReactHost
import com.facebook.react.ReactNativeApplicationEntryPoint.loadReactNative
import expo.modules.ApplicationLifecycleDispatcher
import expo.modules.ExpoReactHostFactory

class MainApplication : Application(), ReactApplication {

  // ── ReactHost: Expo-aware factory ───────────────────────────────────
  // ExpoReactHostFactory.getDefaultReactHost is the Expo replacement for
  // com.facebook.react.defaults.DefaultReactHost.getDefaultReactHost.
  // It wires in the ReactNativeHostHandlers contributed by each expo
  // module so expo-sensors etc. get a chance to register native modules
  // during host creation.
  //
  // PackageList(this).packages already includes ExpoModulesPackage via
  // RN-CLI autolinking; do NOT add it manually here.
  override val reactHost: ReactHost by lazy {
    val packages = PackageList(this).packages.apply {
      // Packages that cannot be autolinked yet can be added manually here.
    }
    // jsMainModulePath default mismatch:
    //   DefaultReactHost defaults to "index" (our entry: index.js).
    //   ExpoReactHostFactory defaults to ".expo/.virtual-metro-entry" —
    //   a Metro virtual module only present in `expo prebuild` projects.
    //   We are a bare RN project, so override explicitly to "index".
    ExpoReactHostFactory.getDefaultReactHost(
      context = applicationContext,
      packageList = packages,
      jsMainModulePath = "index",
    )
  }

  override fun onCreate() {
    super.onCreate()
    loadReactNative(this)
    // Notify every expo module that the Application is up.  iOS analogue:
    // listeners ExpoReactDelegate hooks up in AppDelegate during
    // application(didFinishLaunchingWithOptions:).
    ApplicationLifecycleDispatcher.onApplicationCreate(this)
  }

  override fun onConfigurationChanged(newConfig: Configuration) {
    super.onConfigurationChanged(newConfig)
    ApplicationLifecycleDispatcher.onConfigurationChanged(this, newConfig)
  }
}
