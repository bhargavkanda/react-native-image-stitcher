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
    // Preserve any existing host the dev menu may have set (e.g.
    // dev-machine IP for physical-device builds); fall back to
    // "localhost" for simulator + first-launch device builds.
    let provider = RCTBundleURLProvider.sharedSettings()
    let existing = provider.jsLocation ?? ""
    let host: String
    if let colon = existing.firstIndex(of: ":"), !existing.isEmpty {
      host = String(existing[..<colon])
    } else if !existing.isEmpty {
      host = existing
    } else {
      host = "localhost"
    }
    provider.jsLocation = "\(host):8082"
    return provider.jsBundleURL(forBundleRoot: "index")
#else
    return Bundle.main.url(forResource: "main", withExtension: "jsbundle")
#endif
  }
}
