import UIKit
import React
import React_RCTAppDelegate
import ReactAppDependencyProvider
internal import Expo

@main
class AppDelegate: UIResponder, UIApplicationDelegate {
  var window: UIWindow?

  var reactNativeDelegate: ReactNativeDelegate?
  var reactNativeFactory: ExpoReactNativeFactory?

  func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    let delegate = ReactNativeDelegate()
    let factory = ExpoReactNativeFactory(delegate: delegate)
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

// ExpoReactNativeFactoryDelegate extends RCTDefaultReactNativeFactoryDelegate
// and is required by ExpoReactNativeFactory (it casts the delegate to this
// type internally).  It wires ExpoAppDelegateSubscriberRepository into
// customizeRootView and createRootViewController, which expo modules use
// for their own AppDelegate hooks.
class ReactNativeDelegate: ExpoReactNativeFactoryDelegate {
  override func sourceURL(for bridge: RCTBridge) -> URL? {
    self.bundleURL()
  }

  override func bundleURL() -> URL? {
#if DEBUG
    RCTBundleURLProvider.sharedSettings().jsBundleURL(forBundleRoot: "index")
#else
    Bundle.main.url(forResource: "main", withExtension: "jsbundle")
#endif
  }
}
