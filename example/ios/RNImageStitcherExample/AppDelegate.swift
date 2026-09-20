import UIKit
import React
import React_RCTAppDelegate
import ReactAppDependencyProvider
import RNImageStitcher  // v0.19.0 — RNISARPluginRegistry (AR plugin framework)

@main
class AppDelegate: UIResponder, UIApplicationDelegate {
  /// Mirrored from the scene's window. RN's own `RCTKeyWindow()` is
  /// scene-aware, but `RCTLogBoxView` still reaches for the app delegate's
  /// `window` directly, and third-party code may too.
  var window: UIWindow?

  var reactNativeDelegate: ReactNativeDelegate?
  var reactNativeFactory: RCTReactNativeFactory?

  /// Kept for `SceneDelegate`, which is what starts React Native under the
  /// scene lifecycle. Only the APP delegate is handed these, so they have to
  /// cross that gap — RN reads them for, among other things, the notification
  /// that launched the app.
  var launchOptions: [UIApplication.LaunchOptionsKey: Any]?

  func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    let delegate = ReactNativeDelegate()
    let factory = RCTReactNativeFactory(delegate: delegate)
    delegate.dependencyProvider = RCTAppDependencyProvider()

    reactNativeDelegate = delegate
    reactNativeFactory = factory
    self.launchOptions = launchOptions

    // v0.19.0 — register the sample native AR plugin to exercise the
    // `RNISARFramePlugin` framework end-to-end.  Its per-frame mean-luma
    // result rides the `onArFrame` meta as
    // `meta.plugins.frameBrightness.brightness` (see FrameBrightnessPlugin
    // + the on-screen AR overlay in App.tsx).  A real host registers its
    // own plugin (e.g. OCR) the same way.
    RNISARPluginRegistry.shared.register(FrameBrightnessPlugin())

    // ⚠ NO WINDOW AND NO `startReactNative` HERE — both live in
    // `SceneDelegate` now.
    //
    // Building a window in `didFinishLaunchingWithOptions` is the pre-scene
    // shape, and as of iOS 27 UIKit evaluates scene-lifecycle adoption when
    // the first scene is created and TRAPS the process when it finds none:
    // `__UIApplicationEvaluateRuntimeIssueForNoSceneLifecycleAdoption`,
    // EXC_BREAKPOINT/SIGTRAP, before a single line of JS runs. It presents as
    // an instant white flash and quit, with nothing in the app's own log —
    // the crash report is the only place it is visible
    // (`devicectl device copy from --domain-type systemCrashLogs`).
    //
    // The factory and its delegate stay here: they are built once per
    // PROCESS, not once per scene, so a second scene reuses them.
    return true
  }

  // MARK: - Scene lifecycle

  /// The one scene configuration this app offers.
  ///
  /// Declared in CODE rather than as `UISceneConfigurations` in Info.plist so
  /// the delegate is a compile-checked type instead of a
  /// `"$(PRODUCT_MODULE_NAME).SceneDelegate"` string that silently stops
  /// matching if the module is renamed. Info.plist still needs
  /// `UIApplicationSceneManifest` — that DECLARES adoption, this IMPLEMENTS
  /// it, and ⚠ both are required: adding the manifest alone leaves the trap
  /// in place (verified on device, the crash was byte-identical).
  func application(
    _ application: UIApplication,
    configurationForConnecting connectingSceneSession: UISceneSession,
    options: UIScene.ConnectionOptions
  ) -> UISceneConfiguration {
    let config = UISceneConfiguration(
      name: "Default Configuration",
      sessionRole: connectingSceneSession.role
    )
    config.delegateClass = SceneDelegate.self
    return config
  }
}

/// Starts React Native when the window scene connects.
class SceneDelegate: UIResponder, UIWindowSceneDelegate {
  var window: UIWindow?

  func scene(
    _ scene: UIScene,
    willConnectTo session: UISceneSession,
    options connectionOptions: UIScene.ConnectionOptions
  ) {
    guard
      let windowScene = scene as? UIWindowScene,
      let appDelegate = UIApplication.shared.delegate as? AppDelegate,
      let factory = appDelegate.reactNativeFactory
    else {
      return
    }

    // `UIWindow(windowScene:)` — NOT `UIWindow(frame: UIScreen.main.bounds)`.
    // A window built from the screen's bounds belongs to no scene, which is
    // the same non-adoption UIKit traps on, and it takes the wrong size in
    // any resized or multi-window context.
    let window = UIWindow(windowScene: windowScene)
    self.window = window
    appDelegate.window = window

    factory.startReactNative(
      withModuleName: "RNImageStitcherExample",
      in: window,
      launchOptions: appDelegate.launchOptions
    )
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
