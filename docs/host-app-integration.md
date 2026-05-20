# Host-App Integration Guide

This guide is the **complete** list of host-app native configuration
required to consume `react-native-image-stitcher`.  The `example/`
directory in this repo is the canonical reference implementation
of everything described below — if anything here ever drifts from
the example, the example is the source of truth.

If you skip any step on this page, the symptom you see is named in
the [Troubleshooting](#troubleshooting) section at the end.  We
strongly suggest scanning that table first if you came here from a
crash or error.

## Why so much setup?

`react-native-image-stitcher` is a **camera + sensor + native-OpenCV**
SDK.  To do its job it depends on:

| Dependency | What we use it for |
|---|---|
| `react-native-vision-camera` | The actual camera preview + frame capture |
| `expo-sensors` | `DeviceMotion` (fused IMU) for the AR-fallback translation gate |
| `react-native-sensors` | Per-axis gyroscope on Android (more responsive than expo's fused stream for that one signal) |
| `react-native-safe-area-context` | UI insets so the shutter sits above the home bar |

The first three each impose their own host-app native setup
requirements: Vision Camera wants permission strings and a podfile
declaration; the Expo module system requires the host's
`AppDelegate` + `MainApplication` to use Expo's factory rather than
RN's default; `react-native-sensors` is a legacy bridge module that
needs interop wiring on RN 0.84+.

The good news: every step below is mechanical and the example app
demonstrates each one.  Reading through this page once should be a
~15 minute exercise.  The bad news: skipping any single step
produces a runtime crash, not a build error, so the failure can
look mysterious.

## Supported React Native versions

This SDK is currently tested against **React Native 0.84.x** with
the New Architecture enabled (`newArchEnabled=true` /
`RCTNewArchEnabled=true`).  Older RN versions may work but several
of the patches below are RN 0.84-specific.

## Required peer dependencies — pin these exact versions

The SDK declares these as peer dependencies.  We strongly recommend
pinning to the exact versions below in your host app's
`package.json` — patch-version drift in the Expo SDK has bitten us
multiple times (see [Troubleshooting](#troubleshooting)).

```json
{
  "dependencies": {
    "expo": "55.0.5",
    "expo-modules-core": "55.0.14",
    "expo-modules-autolinking": "55.0.8",
    "expo-sensors": "55.0.15",
    "react-native-sensors": "^7.3.4",
    "react-native-vision-camera": "^4.0.0",
    "react-native-safe-area-context": "^5.5.2"
  }
}
```

After updating `package.json`, run:

```sh
npm install
cd ios && pod install && cd ..
```

## iOS

### 1. `ios/Podfile`

The Podfile must (a) `require` Expo's autolinking helper, and (b)
call `use_expo_modules!`.  On React Native 0.84 we also patch two
Expo SDK 55 files that call into APIs that 0.84 removed.  All of
this is in the post_install hook, idempotent — pasting it twice
or running pod install repeatedly is safe.

```ruby
# Resolve react_native_pods.rb with node to allow for hoisting
require Pod::Executable.execute_command('node', ['-p',
  'require.resolve(
    "react-native/scripts/react_native_pods.rb",
    {paths: [process.argv[1]]},
  )', __dir__]).strip

# expo-modules-core: load the Expo pods helper.  Needed by use_expo_modules!.
require File.join(File.dirname(`node --print "require.resolve('expo/package.json')"`), "scripts/autolinking")

platform :ios, min_ios_version_supported
prepare_react_native_project!

target 'YourApp' do
  config = use_native_modules!

  # MUST come before use_react_native!
  use_expo_modules!(exclude: ['@expo/log-box'])

  use_react_native!(
    :path => config[:reactNativePath],
    :app_path => "#{Pod::Config.instance.installation_root}/.."
  )

  post_install do |installer|
    react_native_post_install(
      installer,
      config[:reactNativePath],
      :mac_catalyst_enabled => false,
    )

    # ─── React Native 0.84 compatibility patches for Expo SDK 55 ────
    # expo SDK 55 was written for RN 0.83; two of its files call
    # 4-arg overloads of RCTReactNativeFactory APIs that 0.84
    # removed.  These two gsubs replace them with the 3-arg form.
    # Idempotent — if the target string is absent (already patched
    # or fixed in a future expo release), they're no-ops.

    expo_factory_mm = File.join(File.dirname(__FILE__), '..', 'node_modules', 'expo',
                                'ios', 'AppDelegates', 'EXReactRootViewFactory.mm')
    if File.exist?(expo_factory_mm)
      mm_content = File.read(expo_factory_mm)
      mm_patched = mm_content.gsub(
        "return [super viewWithModuleName:moduleName initialProperties:initialProperties launchOptions:launchOptions devMenuConfiguration:devMenuConfiguration];",
        "return [super viewWithModuleName:moduleName initialProperties:initialProperties launchOptions:launchOptions];"
      )
      File.write(expo_factory_mm, mm_patched) if mm_patched != mm_content
    end

    expo_factory = File.join(File.dirname(__FILE__), '..', 'node_modules', 'expo',
                             'ios', 'AppDelegates', 'ExpoReactNativeFactory.swift')
    if File.exist?(expo_factory)
      content = File.read(expo_factory)
      patched = content.
        gsub(
          "launchOptions: launchOptions ?? [:],\n        devMenuConfiguration: self.devMenuConfiguration",
          "launchOptions: launchOptions ?? [:],\n        devMenuConfiguration: nil"
        ).
        gsub(
          "launchOptions: launchOptions,\n        devMenuConfiguration: self.devMenuConfiguration",
          "launchOptions: launchOptions"
        )
      File.write(expo_factory, patched) if patched != content
    end
  end
end
```

### 2. `ios/<YourApp>/AppDelegate.swift`

Replace your project's `AppDelegate.swift` with the version below.
The key differences from a stock RN 0.84 template:

- `internal import Expo` (Swift 5.9+ syntax)
- `reactNativeFactory: ExpoReactNativeFactory?` (not `RCTReactNativeFactory`)
- `ReactNativeDelegate: ExpoReactNativeFactoryDelegate`

```swift
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
      withModuleName: "YourApp",  // ← match your app's module name
      in: window,
      launchOptions: launchOptions
    )

    return true
  }
}

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
```

**Why this matters:** `ExpoReactNativeFactory` pre-initialises
`AppContext._runtime` on the correct Swift `JavaScriptActor` before
`RCTTurboModuleManager` calls `setBridge:`.  Without it,
`JavaScriptSerialExecutor.checkIsolated()` crashes at launch with
SIGABRT.  Using the default `RCTReactNativeFactory` will also leave
`DeviceMotion` undefined in JS even after a successful build.

### 3. `ios/<YourApp>/Info.plist` — required permission strings

iOS **force-kills** any app that accesses the camera, motion
sensors, or photo library without a declared usage description.
Every key below is required — even if your app never uses that
subsystem directly, Vision Camera or Expo Sensors will touch it
during init and your app will SIGABRT on launch.

```xml
<key>NSCameraUsageDescription</key>
<string>YourApp uses the camera to capture and stitch panoramas.</string>

<key>NSMicrophoneUsageDescription</key>
<string>Vision Camera initializes the microphone even in photo-only mode.</string>

<key>NSMotionUsageDescription</key>
<string>YourApp reads device motion to drive pose-aware panorama capture.</string>

<key>NSPhotoLibraryUsageDescription</key>
<string>YourApp saves captured panoramas to your photo library.</string>

<key>NSPhotoLibraryAddUsageDescription</key>
<string>YourApp saves captured panoramas to your photo library.</string>
```

### 4. `ios/<YourApp>/Info.plist` — network for live reload (optional)

If you ever want to develop against the Metro packager on a
**physical iPhone** (i.e., load JS from your Mac instead of the
bundled `main.jsbundle`), the iPhone needs to reach
`http://<your-mac>:8081`.  `NSAllowsLocalNetworking=true` only
covers `localhost` and `.local` mDNS — **NOT raw LAN IPs**.

For dev convenience, set:

```xml
<key>NSAppTransportSecurity</key>
<dict>
  <key>NSAllowsArbitraryLoads</key>
  <true/>
  <key>NSAllowsLocalNetworking</key>
  <true/>
</dict>
```

Apple will reject the App Store submission if `NSAllowsArbitraryLoads`
ships in your Release `Info.plist`.  You can scope it to debug
builds with a separate `Info-Debug.plist` if you want a clean
production build.

## Android

### 1. `android/settings.gradle`

```gradle
pluginManagement {
    includeBuild("../node_modules/@react-native/gradle-plugin")
    includeBuild("../node_modules/expo-modules-autolinking/android/expo-gradle-plugin")
}
plugins {
    id("com.facebook.react.settings")
    id("expo-autolinking-settings")
}
extensions.configure(com.facebook.react.ReactSettingsExtension){ ex -> ex.autolinkLibrariesFromCommand() }
expoAutolinking.useExpoModules()

rootProject.name = 'YourApp'
include ':app'
includeBuild('../node_modules/@react-native/gradle-plugin')
```

The two `includeBuild` lines in `pluginManagement` and the
`expoAutolinking.useExpoModules()` line are the Android analogue of
iOS's `use_expo_modules!` Podfile macro — they discover every
`expo-*` package in `node_modules` and pull its native code into the
Gradle build.

### 2. `android/build.gradle` (top-level)

```gradle
buildscript {
    ext {
        buildToolsVersion = "36.0.0"
        minSdkVersion = 24
        compileSdkVersion = 36
        targetSdkVersion = 36
        ndkVersion = "27.1.12297006"
        kotlinVersion = "2.1.20"
    }
    repositories {
        google()
        mavenCentral()
    }
    dependencies {
        classpath("com.android.tools.build:gradle")
        classpath("com.facebook.react:react-native-gradle-plugin")
        classpath("org.jetbrains.kotlin:kotlin-gradle-plugin")
    }
}

apply plugin: "com.facebook.react.rootproject"
apply plugin: "expo-root-project"
```

The `expo-root-project` plugin contributes default values for
`kotlinVersion`, `kspVersion`, etc. via `extra.setIfNotExist` so
autolinked Expo subprojects can resolve them.  Your explicit `ext{}`
values always win — this only fills gaps.

### 3. `android/gradle.properties`

```properties
android.useAndroidX=true
newArchEnabled=true
hermesEnabled=true
```

### 4. `android/app/src/main/java/<your.pkg>/MainApplication.kt`

```kotlin
package your.pkg

import android.app.Application
import android.content.res.Configuration
import com.facebook.react.PackageList
import com.facebook.react.ReactApplication
import com.facebook.react.ReactHost
import com.facebook.react.ReactNativeApplicationEntryPoint.loadReactNative
import expo.modules.ApplicationLifecycleDispatcher
import expo.modules.ExpoReactHostFactory

class MainApplication : Application(), ReactApplication {

  override val reactHost: ReactHost by lazy {
    val packages = PackageList(this).packages
    // Override jsMainModulePath: ExpoReactHostFactory defaults to
    // ".expo/.virtual-metro-entry" (only present in `expo prebuild`
    // projects).  Bare RN apps use "index".
    ExpoReactHostFactory.getDefaultReactHost(
      context = applicationContext,
      packageList = packages,
      jsMainModulePath = "index",
    )
  }

  override fun onCreate() {
    super.onCreate()
    loadReactNative(this)
    ApplicationLifecycleDispatcher.onApplicationCreate(this)
  }

  override fun onConfigurationChanged(newConfig: Configuration) {
    super.onConfigurationChanged(newConfig)
    ApplicationLifecycleDispatcher.onConfigurationChanged(this, newConfig)
  }
}
```

The key swap is `DefaultReactHost.getDefaultReactHost` →
`ExpoReactHostFactory.getDefaultReactHost`.  The latter wires in the
`ReactNativeHostHandlers` contributed by each expo module so they
get a chance to register native modules during host creation.  The
two `ApplicationLifecycleDispatcher` calls are the Android analogue
of iOS's `ExpoAppDelegateSubscriberRepository.subscribers` chain.

### 5. `android/app/src/main/AndroidManifest.xml` — permissions + ARCore meta-data

> [!WARNING]
> Android **silently auto-denies** any permission that isn't declared
> in the manifest.  If you omit `<uses-permission
> android:name="android.permission.CAMERA" />`, `requestPermissions()`
> returns *denied* without ever showing the user a system dialog —
> the SDK will display its own "Camera permission denied" UI and your
> users will (rightly) be confused.  Same trap applies to ARCore's
> high-rate sensor permission: omitting it doesn't fail at install,
> it fails inside `Session.resume()` deep in ARCore's native code at
> runtime.

```xml
<manifest xmlns:android="http://schemas.android.com/apk/res/android">

    <uses-permission android:name="android.permission.INTERNET" />

    <!-- Required by react-native-vision-camera.  Without this,
         requestPermissions() silently auto-denies (see warning). -->
    <uses-permission android:name="android.permission.CAMERA" />

    <!-- Required by ARCore on Android 12+ (API 31) because it
         polls accelerometer + gyroscope at >= 200 Hz to fuse pose.
         Normal protectionLevel: auto-granted at install, no
         runtime prompt needed.  Without it, Session.resume() throws
         a FatalException from android_sensors.cc. -->
    <uses-permission android:name="android.permission.HIGH_SAMPLING_RATE_SENSORS" />

    <uses-feature android:name="android.hardware.camera" />
    <uses-feature android:name="android.hardware.camera.autofocus" />
    <uses-feature android:name="android.hardware.sensor.gyroscope"
                  android:required="false" />
    <uses-feature android:name="android.hardware.sensor.accelerometer"
                  android:required="false" />

    <application … >
      <!-- ARCore meta-data: required by com.google.ar:core.
           Without this, ArCoreApk.requestInstall() throws on the
           first call.  `optional` (not `required`) keeps the app
           installable on non-ARCore devices, which fall back to
           the non-AR vision-camera + gyro capture path. -->
      <meta-data android:name="com.google.ar.core" android:value="optional" />

      <activity … />
    </application>
</manifest>
```

`android:required="false"` on the sensor `<uses-feature>` lets the
app install on devices that don't have a gyroscope; Play Store won't
filter them out, and the SDK gracefully falls back to non-AR
capture.

## `patch-package` — required patches

Two upstream packages need patches to compile cleanly against React
Native 0.84.  We strongly recommend setting up
[`patch-package`](https://github.com/ds300/patch-package) in your
host app and committing both patches under `patches/`.

### 1. `patches/expo-modules-core+55.0.14.patch`

RN 0.84 made `code` nullable on every `reject(...)` overload in
`com.facebook.react.bridge.Promise`.  `expo-modules-core@55.0.14`
still declares them as non-null `String`, so `override` fails at
compile time with `'reject' overrides nothing`.

```diff
diff --git a/node_modules/expo-modules-core/android/src/main/java/expo/modules/kotlin/Promise.kt b/node_modules/expo-modules-core/android/src/main/java/expo/modules/kotlin/Promise.kt
@@ -45,16 +45,22 @@ fun Promise.toBridgePromise(): com.facebook.react.bridge.Promise {
       resolveMethod(value)
     }
 
-    override fun reject(code: String, message: String?) {
-      expoPromise.reject(code, message, null)
+    override fun reject(code: String?, message: String?) {
+      expoPromise.reject(code ?: unknownCode, message, null)
     }
 
-    override fun reject(code: String, throwable: Throwable?) {
-      expoPromise.reject(code, null, throwable)
+    override fun reject(code: String?, throwable: Throwable?) {
+      expoPromise.reject(code ?: unknownCode, null, throwable)
     }
 
-    override fun reject(code: String, message: String?, throwable: Throwable?) {
-      expoPromise.reject(code, message, throwable)
+    override fun reject(code: String?, message: String?, throwable: Throwable?) {
+      expoPromise.reject(code ?: unknownCode, message, throwable)
     }
 
     override fun reject(throwable: Throwable) {
@@ -65,16 +71,16 @@ fun Promise.toBridgePromise(): com.facebook.react.bridge.Promise {
       expoPromise.reject(unknownCode, null, throwable)
     }
 
-    override fun reject(code: String, userInfo: WritableMap) {
-      expoPromise.reject(code, null, null)
+    override fun reject(code: String?, userInfo: WritableMap) {
+      expoPromise.reject(code ?: unknownCode, null, null)
     }
 
-    override fun reject(code: String, throwable: Throwable?, userInfo: WritableMap) {
-      expoPromise.reject(code, null, throwable)
+    override fun reject(code: String?, throwable: Throwable?, userInfo: WritableMap) {
+      expoPromise.reject(code ?: unknownCode, null, throwable)
     }
 
-    override fun reject(code: String, message: String?, userInfo: WritableMap) {
-      expoPromise.reject(code, message, null)
+    override fun reject(code: String?, message: String?, userInfo: WritableMap) {
+      expoPromise.reject(code ?: unknownCode, message, null)
     }
```

### 2. `patches/react-native-sensors+7.3.6.patch`

`react-native-sensors@7.3.6` references `jcenter()` in its
`build.gradle` — Bintray retired jcenter in 2022 and Gradle 9
removed the alias method entirely.  Swap to `mavenCentral()`.

```diff
diff --git a/node_modules/react-native-sensors/android/build.gradle b/node_modules/react-native-sensors/android/build.gradle
@@ -6,7 +6,7 @@ def safeExtGet(prop, fallback) {
 repositories {
   mavenCentral()
   google()
-  jcenter()
+  mavenCentral()
 }

 buildscript {
   repositories {
     google()
-    jcenter()
+    mavenCentral()
   }
```

### Setting up patch-package

Add to your host app's `package.json`:

```json
{
  "scripts": {
    "postinstall": "npx patch-package"
  },
  "devDependencies": {
    "patch-package": "^8.0.0"
  }
}
```

Now every `npm install` automatically re-applies both patches.

## Network access from devices to Metro

| Platform | What happens |
|---|---|
| **iOS Simulator** | `localhost:8081` resolves to the Mac. Works out of the box. |
| **iOS Physical Device** | `localhost` on the iPhone = the iPhone, not the Mac.  Either run `npx react-native run-ios` (it injects the Mac's IP into NSUserDefaults) or set the bundler IP manually in the in-app dev menu (Shake → Configure Bundler). |
| **Android Emulator** | `10.0.2.2:8081` from the emulator hits the host.  RN auto-configures this. |
| **Android Physical Device** | `adb reverse tcp:8081 tcp:8081` forwards the device's `localhost:8081` over USB to the Mac.  `npx react-native run-android` runs this automatically; re-run if you reconnect USB. |

If you set `NSAllowsArbitraryLoads=true` (per "iOS — Info.plist
network" above) the iPhone can also reach Metro at the Mac's mDNS
hostname (e.g. `http://my-mac.local:8081`) which is stable across
DHCP changes.

## Troubleshooting

| Symptom | Most likely cause | Fix |
|---|---|---|
| `Cannot read property 'useContext' of null` at runtime | Two copies of React in the bundle (commonly: a nested `node_modules/react` in the SDK or a `file:` linked package).  Both Reacts have independent context registries. | Ensure only ONE `react` in `find node_modules -name react -type d -path '*node_modules/react'`.  Add `resolver.blockList` to Metro config if needed. |
| `Cannot read property 'eventEmitter' of undefined` or `Cannot read property 'DeviceMotion' of undefined` | Either: Expo not initialized natively, OR `react-native-sensors` not registered on New Arch. | Confirm `use_expo_modules!` in Podfile, `ExpoReactNativeFactory` in AppDelegate, and `ExpoReactHostFactory` in MainApplication.kt. |
| iOS app SIGABRTs on launch immediately | Missing `NSCameraUsageDescription` / `NSMotionUsageDescription` in `Info.plist`. | Add the keys per "iOS — Info.plist permission strings" above.  iOS will not even log this — the only signature is `App terminated due to signal 6.` in `devicectl --console` output. The `.ips` crash log in `Settings → Privacy & Security → Analytics & Improvements → Analytics Data` will say verbatim *"The app's Info.plist must contain an NSCameraUsageDescription key..."*. |
| Android: SDK shows "Camera permission denied" but no system dialog ever appeared | Missing `<uses-permission android:name="android.permission.CAMERA" />` in `AndroidManifest.xml`.  Android silently auto-denies any permission not declared in the manifest — `requestPermissions()` returns *denied* without prompting the user. | Add the `<uses-permission>` line per "Android — AndroidManifest.xml" above and rebuild.  This **is not a runtime bug** — the manifest is the contract for what the app can request. |
| Android: AR mode crashes deep in native (`android_sensors.cc`) | Missing `<uses-permission android:name="android.permission.HIGH_SAMPLING_RATE_SENSORS" />`.  ARCore polls IMU at ≥200 Hz and Android 12+ rate-limits that without the permission. | Add the `<uses-permission>` line.  This is a normal-protection-level permission, no runtime prompt. |
| Android: AR mode crashes on `ArCoreApk.requestInstall()` | Missing `<meta-data android:name="com.google.ar.core" android:value="optional" />` inside `<application>`. | Add the meta-data tag per the manifest section above. |
| Android Gradle: `Could not find method jcenter()` | `react-native-sensors@7.3.6` references the retired Bintray jcenter. | Apply the `react-native-sensors+7.3.6.patch` from above. |
| Android Kotlin: `'reject' overrides nothing` in `expo-modules-core/.../Promise.kt` | RN 0.84 made `code` nullable; expo-modules-core 55.0.14 still declares it non-null. | Apply the `expo-modules-core+55.0.14.patch` from above. |
| iOS Pod install:  `framework not found 'opencv2'` | The npm postinstall fetcher hasn't downloaded the OpenCV xcframework. | Re-run `npm install`.  If you're offline, set `SKIP_OPENCV_FETCH=1` and place the framework manually under `node_modules/react-native-image-stitcher/ios/Frameworks/`. |
| iOS Pod install:  `EXReactRootViewFactory.mm:NN:M: no matching member function for call to 'viewWithModuleName'` | RN 0.84 patch in the Podfile post_install didn't run (or expo upgraded the source). | Confirm the two `gsub` blocks in the Podfile post_install are present.  If expo released a new version that fixed this, the gsub is a no-op (idempotent). |
| iOS:  `dyld: Library not loaded: @rpath/React.framework/React` at launch | CocoaPods didn't embed `React.framework` (a known intermittent issue with the prebuilt `React-Core-prebuilt` pod). | Run `pod deintegrate && pod install` from `ios/`. |
| iOS Build: `Signing for "YourApp" requires a development team` | Xcode signing not configured. | In `your.xcodeproj` → target settings → Signing & Capabilities, pick your team and ensure `CODE_SIGN_STYLE=Automatic`.  For headless builds, pass `-allowProvisioningUpdates` to `xcodebuild`. |
| `react-native run-ios --device` exits with `No simulator available with udid "undefined"` | RN CLI bug: when no fallback simulator (iPhone 14/13/12/11) is installed, `getFallbackSimulator` throws even on the device code path. | `xcrun simctl create "iPhone 14" "com.apple.CoreSimulator.SimDeviceType.iPhone-14" "com.apple.CoreSimulator.SimRuntime.iOS-17-5"` to create a dummy simulator. |

## What "fully working" looks like

After everything above is in place, a clean `npm install &&
cd ios && pod install && cd .. && npx react-native run-ios` on a
**fresh** clone should:

1. Run `patch-package` automatically as part of postinstall, applying both required patches.
2. Run the SDK's own postinstall fetcher, pulling the OpenCV
   xcframework + Android per-ABI `.so` files into `node_modules/react-native-image-stitcher/`.
3. Run `pod install`, which applies the RN 0.84 expo factory patches via the post_install hook and installs ~80 pods (including `Expo`, `ExpoSensors`, `ExpoModulesCore`, `VisionCamera`, `RNSensors`, `react-native-image-stitcher`).
4. Build + install + launch the iPhone app, which shows the `<Camera>` preview.
5. Tap shutter → photo captured.  Hold + pan → panorama stitched.

Any of those steps failing → consult the [Troubleshooting](#troubleshooting)
table above first.  If the symptom isn't listed there, please
open an issue at
[github.com/bhargavkanda/react-native-image-stitcher/issues](https://github.com/bhargavkanda/react-native-image-stitcher/issues).
