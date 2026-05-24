import UIKit
import React
import React_RCTAppDelegate
import ReactAppDependencyProvider

@main
class AppDelegate: UIResponder, UIApplicationDelegate {
  var window: UIWindow?

  var reactNativeDelegate: ReactNativeDelegate?
  var reactNativeFactory: RCTReactNativeFactory?

  func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    let delegate = ReactNativeDelegate()
    let factory = RCTReactNativeFactory(delegate: delegate)
    delegate.dependencyProvider = RCTAppDependencyProvider()

    reactNativeDelegate = delegate
    reactNativeFactory = factory

    window = UIWindow(frame: UIScreen.main.bounds)

    factory.startReactNative(
      withModuleName: "RNImageStitcherExample",
      in: window,
      launchOptions: launchOptions
    )

    return true
  }
}

// F8.0.d — inherit from ReactNativeBridgeDelegate (Obj-C class) which
// overrides the C++-gated `getModuleClassFromName:` to bridge to
// RCTCoreModulesClassProvider.  Without this override, RN 0.84
// bridgeless cannot resolve core ObjC modules (PlatformConstants,
// RCTNetworking, etc.) in non-Expo projects with an empty
// RCTAppDependencyProvider.moduleProviders map.  See
// ReactNativeBridgeDelegate.h for the full rationale.
class ReactNativeDelegate: ReactNativeBridgeDelegate {
  override func sourceURL(for bridge: RCTBridge) -> URL? {
    self.bundleURL()
  }

  override func bundleURL() -> URL? {
#if DEBUG
    // Pin Metro to port 8082 (project-wide convention; 8081 is held
    // by Tug's Expo dev server on this machine).  Mirrors the same
    // pin in example/metro.config.js, example/package.json scripts,
    // and example/android/gradle.properties.
    //
    // Why mutate `jsLocation` instead of a hypothetical `.port`?
    // RN 0.84's RCTBundleURLProvider bakes the port into a compile-
    // time constant `kRCTBundleURLProviderDefaultPort = RCT_METRO_PORT`
    // (see node_modules/react-native/React/Base/RCTBundleURLProvider.mm:19)
    // and exposes NO Swift-bridged setter for it — we can't change
    // the constant without recompiling React.framework.  But the
    // internal `serverRootWithHostPort` helper checks whether the
    // stored `jsLocation` contains a ":" and, if so, uses it as
    // `host:port` directly, bypassing the constant.  So overriding
    // `jsLocation` to `"<host>:8082"` is the cleanest runtime knob.
    //
    // CRITICAL: `packagerServerHost()` triggers the proper host-
    // discovery chain (UserDefaults from dev-menu "Configure
    // bundler" → ip.txt that the build-phase script writes into the
    // .app bundle → fallback "localhost").  We MUST call it BEFORE
    // writing to `jsLocation`, otherwise on a fresh install where
    // jsLocation is empty, our code would set "localhost:8082" and
    // physical devices would try to reach localhost (themselves)
    // instead of the dev mac.  Earlier version of this patch did
    // exactly that — discovered the hard way on 2026-05-24.
    let provider = RCTBundleURLProvider.sharedSettings()
    let discoveredHostPort = provider.packagerServerHostPort() ?? ""
    // packagerServerHostPort returns "<host>" or "<host>:<port>";
    // strip any embedded port so we can force 8082.
    let strippedHost: String
    if let colon = discoveredHostPort.firstIndex(of: ":") {
      strippedHost = String(discoveredHostPort[..<colon])
    } else {
      strippedHost = discoveredHostPort
    }
    // Last-resort hardcoded fallback if the build-phase script
    // didn't write `packager-host` (observed intermittently on
    // rebuilds — see F8.0.c notes).  192.168.68.120 is the dev
    // mac's current local IP; update if you switch networks.
    //
    // TODO(F8.1+): replace with a build-setting / env-var driven
    // default so this isn't hardcoded per-machine.  Candidates:
    //   - RCT_DEFAULT_PACKAGER_HOST env var read by the build phase
    //   - Info.plist key driven from Build Settings
    //   - .xcconfig include in Pods-RNImageStitcherExample.debug
    let host = strippedHost.isEmpty ? "192.168.68.120" : strippedHost
    provider.jsLocation = "\(host):8082"
    return provider.jsBundleURL(forBundleRoot: "index")
#else
    return Bundle.main.url(forResource: "main", withExtension: "jsbundle")
#endif
  }
}
