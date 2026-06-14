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
    // Pin Metro to port 8082 (project-wide convention; 8081 is held by Tug's
    // Expo dev server on this machine).  Mirrors the pin in
    // example/metro.config.js, example/package.json scripts, and
    // example/android/gradle.properties.
    //
    // Why mutate `jsLocation` instead of a hypothetical `.port`?  RN 0.84's
    // RCTBundleURLProvider bakes the port into a compile-time constant
    // `kRCTBundleURLProviderDefaultPort = RCT_METRO_PORT` and exposes NO
    // Swift-bridged setter — but its `serverRootWithHostPort` helper uses any
    // ":"-bearing `jsLocation` as `host:port` directly, bypassing the constant.
    //
    // HOST resolution (the .120→.92 "app won't load on device" bug, 2026-06-14):
    // the dev Mac's LAN IP changes with DHCP, which silently breaks the two
    // sources the old code relied on — a hardcoded fallback constant, and the
    // dev-menu "Configure Bundler" host cached in UserDefaults (which a
    // reinstall wipes, dropping back to the stale constant).  The ONE source
    // that is always current is `ip.txt`, which RN's "Bundle React Native code
    // and images" build phase writes into the .app on EVERY Debug build.  Read
    // it FIRST and treat it as authoritative; the discovery chain / constant
    // are fallbacks only for the rare build where ip.txt is missing.
    let provider = RCTBundleURLProvider.sharedSettings()
    let host =
      Self.hostFromBundledIPFile()
      ?? Self.discoveredPackagerHost(provider)
      ?? "192.168.68.92"  // last-resort; only hit if ip.txt isn't written
    provider.jsLocation = "\(host):8082"
    return provider.jsBundleURL(forBundleRoot: "index")
#else
    return Bundle.main.url(forResource: "main", withExtension: "jsbundle")
#endif
  }

#if DEBUG
  /// The dev Mac's current LAN IP, written into the .app bundle as `ip.txt` by
  /// RN's build phase on every Debug build.  The single non-stale host source —
  /// immune to DHCP changes and to UserDefaults being wiped on reinstall.
  private static func hostFromBundledIPFile() -> String? {
    guard
      let url = Bundle.main.url(forResource: "ip", withExtension: "txt"),
      let raw = try? String(contentsOf: url, encoding: .utf8)
    else { return nil }
    let host = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    return host.isEmpty ? nil : host
  }

  /// RCTBundleURLProvider's discovery host (dev-menu "Configure Bundler"
  /// UserDefaults), with any embedded port stripped so we can force :8082.
  /// Used only when `ip.txt` is absent.
  private static func discoveredPackagerHost(
    _ provider: RCTBundleURLProvider
  ) -> String? {
    let hostPort = provider.packagerServerHostPort() ?? ""
    let host = hostPort.split(separator: ":", maxSplits: 1)
      .first.map(String.init) ?? hostPort
    return host.isEmpty ? nil : host
  }
#endif
}
