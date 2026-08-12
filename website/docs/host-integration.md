---
id: host-integration
title: Host app integration
sidebar_position: 3
---

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
| `react-native-sensors` | Accelerometer (orientation detection + IMU translation gate) and gyroscope (non-AR pose integration) |
| `react-native-safe-area-context` | UI insets so the shutter sits above the home bar |

Each one imposes a small amount of native-side wiring: Vision Camera
wants permission strings and a podfile declaration; `react-native-
sensors` is a legacy bridge module that needs a `mavenCentral()` swap
on RN 0.84+ (one `patch-package` patch).  That's it — **no Expo
modules infrastructure required** as of v0.2.0.

The good news: every step below is mechanical and the example app
demonstrates each one.  Reading through this page once should be a
~10 minute exercise.

## Supported React Native versions

This SDK is currently tested against **React Native 0.84.x** with
the New Architecture enabled (`newArchEnabled=true` /
`RCTNewArchEnabled=true`).  Older RN versions may work but the
`react-native-sensors` `jcenter()` patch below is RN-0.84 / Gradle-9
specific.

## Required peer dependencies

The SDK declares these as peer dependencies in `package.json`.
Pin the exact versions or use a `^` range as your taste dictates —
the SDK doesn't require a specific patch version of any of them.

```json
{
  "dependencies": {
    "react-native-sensors": "^7.3.4",
    "react-native-vision-camera": "^4.7.0",
    "react-native-worklets-core": "^1.3.0",
    "react-native-safe-area-context": "^5.5.2"
  }
}
```

:::warning Install order matters
`react-native-worklets-core` must be in `node_modules` **before** you run
`pod install`. vision-camera compiles its frame-processor subsystem only
when it can see worklets-core at pod-install time — and the SDK's non-AR
panorama capture depends on that subsystem (next section). If you added
worklets-core later, re-run `pod install` and rebuild.
:::

After updating `package.json`, run:

```sh
npm install
cd ios && pod install && cd ..
```

## Frame processors — the non-AR capture prerequisite

Panorama capture has two frame sources:

- **AR mode** (opt in with `defaultCaptureSource="ar"`): frames flow
  natively from the ARKit / ARCore session into the stitching engine.
  **No frame-processor dependency** — this whole failure class disappears.
  Caveats today: an Android device without "Google Play Services for AR"
  is prompted to install it and a declined install leaves the AR preview
  blank with no automatic downgrade; AR tap-photos come from the AR video
  stream (lower resolution, no flash, no iOS depth sidecar). Weigh these
  against the robustness win for your fleet.
- **Non-AR mode** (the default): frames flow through a vision-camera
  **frame-processor worklet** (the SDK's `cv_flow_gate_process_frame` plugin). This chain
  only exists if the native build enabled it.

Non-AR mode is the default AND is reachable on every install — devices
without ARKit/ARCore fall back to it automatically, selecting the 0.5×
lens forces it, and the runtime AR toggle can switch to it — so treat the
checklist below as required even if you plan to run AR-only. (To *lock* captures to
one source and hide the AR toggle entirely, set `captureSources="ar"` —
see the [`<Camera>` API](./camera-api.md).)

### Checklist

Common to both platforms:

1. **`react-native-vision-camera` ≥ 4.7** — older 4.x has different
   frame-processor APIs; npm only warns on peer-dep violations.
2. **`react-native-worklets-core` installed** — and present *before* the
   native build ran (see the install-order warning above). This is the
   most common failure.
3. **`react-native-worklets-core/plugin` in `babel.config.js`** — LAST in
   the `plugins` array. The SDK's ingest worklet (and any frame
   processor) is a `'worklet'` function; without the babel transform it
   fails at runtime even when the native build is perfect:

   ```js
   module.exports = {
     presets: ['module:@react-native/babel-preset'],
     plugins: ['react-native-worklets-core/plugin'],
   };
   ```

   Restart Metro with `--reset-cache` after adding it.

**iOS** (then `rm -rf ios/Pods ios/Podfile.lock && pod install` + a clean
rebuild — an ordinary `pod install` keeps build settings frozen from the
first install):

4. **No `$VCEnableFrameProcessors = false`** in your `Podfile` — some
   templates disable frame processors to cut build time.
5. **With `use_frameworks!`**: `<VisionCamera/FrameProcessorPlugin.h>`
   must be visible to the `RNImageStitcher` pod at compile time. The
   SDK's plugin file is guarded by `__has_include` — if the header isn't
   visible, the plugin **compiles to nothing** (deliberately, so your
   build doesn't break) and non-AR capture silently loses its frame
   source.

**Android** (then a clean rebuild — `cd android && ./gradlew clean`):

6. vision-camera compiles its frame-processor subsystem only when Gradle
   can resolve `react-native-worklets-core` at build time. Adding
   worklets-core without a clean rebuild leaves the old AAR (frame
   processors compiled out) in place.

### How the SDK tells you it's broken (v0.24.3+)

You do **not** need to instrument anything — the SDK self-diagnoses:

- **Immediately**, if vision-camera reports frame processors are disabled
  (its proxy throws), or **~3 s after mount** if nothing ever registers,
  the SDK logs a `console.error` from `[react-native-image-stitcher]`
  with the platform-specific remediation from the checklist above.
- **At capture start**, a non-AR hold in such a build fails fast with
  `PANORAMA_START_FAILED` ("the frame-processor worklet is unavailable…")
  instead of running a doomed capture that ends in the misleading
  `0 keyframes saved`. Captures started during the normal ~1-frame
  acquisition window at mount are unaffected.
- Hosts can read `acquisitionFailed` from `useStitcherWorklet()` /
  `useFrameProcessorDriver()` to gate their own UI.

To check manually (any SDK version):

```ts
import { VisionCameraProxy } from 'react-native-vision-camera';
console.log(
  'cv_flow_gate plugin:',
  VisionCameraProxy.initFrameProcessorPlugin('cv_flow_gate_process_frame', {}),
); // null/undefined = the chain is dead in this build
```

One more integration trap: if you pass your **own `frameProcessor` prop**
to `<Camera>`, it *replaces* the SDK's internal ingest worklet — you must
call `stitcher.call(frame)` (from `useStitcherWorklet`) inside your
worklet body, or non-AR panoramas will capture zero frames with the same
symptom. See the `frameProcessor` prop JSDoc for the composition pattern.

## iOS

### 1. `ios/Podfile`

Standard React Native 0.84 Podfile.  No extra plugin macros, no
post-install patches.

```ruby
# Resolve react_native_pods.rb with node to allow for hoisting
require Pod::Executable.execute_command('node', ['-p',
  'require.resolve(
    "react-native/scripts/react_native_pods.rb",
    {paths: [process.argv[1]]},
  )', __dir__]).strip

platform :ios, min_ios_version_supported
prepare_react_native_project!

linkage = ENV['USE_FRAMEWORKS']
if linkage != nil
  Pod::UI.puts "Configuring Pod with #{linkage}ally linked Frameworks".green
  use_frameworks! :linkage => linkage.to_sym
end

target 'YourApp' do
  config = use_native_modules!

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
  end
end
```

### 2. `ios/<YourApp>/AppDelegate.swift`

Standard React Native 0.84 AppDelegate using `RCTReactNativeFactory`.

```swift
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
      withModuleName: "YourApp",
      in: window,
      launchOptions: launchOptions
    )

    return true
  }
}

class ReactNativeDelegate: RCTDefaultReactNativeFactoryDelegate {
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

### 3. `ios/<YourApp>/Info.plist` — required permission strings

iOS **force-kills** any app that accesses the camera, motion
sensors, or photo library without a declared usage description.
Every key below is required — even if your app never uses that
subsystem directly, Vision Camera or `react-native-sensors` will
touch it during init and your app will SIGABRT on launch.

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

Standard React Native 0.84 settings file.

```gradle
pluginManagement {
    includeBuild("../node_modules/@react-native/gradle-plugin")
}
plugins {
    id("com.facebook.react.settings")
}
extensions.configure(com.facebook.react.ReactSettingsExtension){ ex -> ex.autolinkLibrariesFromCommand() }

rootProject.name = 'YourApp'
include ':app'
includeBuild('../node_modules/@react-native/gradle-plugin')
```

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
```

### 3. `android/gradle.properties`

```properties
android.useAndroidX=true
newArchEnabled=true
hermesEnabled=true
```

### 4. `android/app/src/main/java/<your.pkg>/MainApplication.kt`

Standard React Native 0.84 MainApplication using
`DefaultReactHost.getDefaultReactHost`.

```kotlin
package your.pkg

import android.app.Application
import com.facebook.react.PackageList
import com.facebook.react.ReactApplication
import com.facebook.react.ReactHost
import com.facebook.react.ReactNativeApplicationEntryPoint.loadReactNative
import com.facebook.react.defaults.DefaultReactHost.getDefaultReactHost

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
  }
}
```

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

## `patch-package` — one required patch

One upstream package needs a patch to compile cleanly against React
Native 0.84.  We recommend setting up
[`patch-package`](https://github.com/ds300/patch-package) in your
host app and committing the patch under `patches/`.

### `patches/react-native-sensors+7.3.6.patch`

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

Now every `npm install` automatically re-applies the patch.

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
| `Cannot read property 'eventEmitter' of undefined` | `react-native-sensors` not registered on New Arch.  Usually a stale `pod install` or autolinking cache. | Run `cd ios && pod deintegrate && pod install` and rebuild.  For Android, `cd android && ./gradlew clean && cd .. && npx react-native run-android`. |
| iOS app SIGABRTs on launch immediately | Missing `NSCameraUsageDescription` / `NSMotionUsageDescription` in `Info.plist`. | Add the keys per "iOS — Info.plist permission strings" above.  iOS will not even log this — the only signature is `App terminated due to signal 6.` in `devicectl --console` output. The `.ips` crash log in `Settings → Privacy & Security → Analytics & Improvements → Analytics Data` will say verbatim *"The app's Info.plist must contain an NSCameraUsageDescription key..."*. |
| Android: SDK shows "Camera permission denied" but no system dialog ever appeared | Missing `<uses-permission android:name="android.permission.CAMERA" />` in `AndroidManifest.xml`.  Android silently auto-denies any permission not declared in the manifest — `requestPermissions()` returns *denied* without prompting the user. | Add the `<uses-permission>` line per "Android — AndroidManifest.xml" above and rebuild.  This **is not a runtime bug** — the manifest is the contract for what the app can request. |
| Android: AR mode crashes deep in native (`android_sensors.cc`) | Missing `<uses-permission android:name="android.permission.HIGH_SAMPLING_RATE_SENSORS" />`.  ARCore polls IMU at ≥200 Hz and Android 12+ rate-limits that without the permission. | Add the `<uses-permission>` line.  This is a normal-protection-level permission, no runtime prompt. |
| Android: AR mode crashes on `ArCoreApk.requestInstall()` | Missing `<meta-data android:name="com.google.ar.core" android:value="optional" />` inside `<application>`. | Add the meta-data tag per the manifest section above. |
| Android Gradle: `Could not find method jcenter()` | `react-native-sensors@7.3.6` references the retired Bintray jcenter. | Apply the `react-native-sensors+7.3.6.patch` from above. |
| Android Gradle: `Gradle requires JVM 17 or later to run. Your build is currently configured to use JVM 11.` | Default JDK on macOS/Linux is often Java 11 even when 17 is installed. | Set `JAVA_HOME` to a Java 17 install before running gradle.  Homebrew: `export JAVA_HOME=/usr/local/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home`. |
| iOS Pod install:  `framework not found 'opencv2'` | The npm postinstall fetcher hasn't downloaded the OpenCV xcframework. | Re-run `npm install`.  If you're offline, set `SKIP_OPENCV_FETCH=1` and place the framework manually under `node_modules/react-native-image-stitcher/ios/Frameworks/`. |
| iOS Pod install: `Unicode Normalization not appropriate for ASCII-8BIT` (Ruby 3.4 + CocoaPods 1.16) | Known Ruby-stdlib / CocoaPods interaction bug. | Prepend `LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8` to the `pod install` command. |
| iOS:  `dyld: Library not loaded: @rpath/React.framework/React` at launch | CocoaPods didn't embed `React.framework` (a known intermittent issue with the prebuilt `React-Core-prebuilt` pod). | Run `pod deintegrate && pod install` from `ios/`. |
| iOS Build: `Signing for "YourApp" requires a development team` | Xcode signing not configured. | In `your.xcodeproj` → target settings → Signing & Capabilities, pick your team and ensure `CODE_SIGN_STYLE=Automatic`.  For headless builds, pass `-allowProvisioningUpdates` to `xcodebuild`. |
| `react-native run-ios --device` exits with `No simulator available with udid "undefined"` | RN CLI bug: when no fallback simulator (iPhone 14/13/12/11) is installed, `getFallbackSimulator` throws even on the device code path. | `xcrun simctl create "iPhone 14" "com.apple.CoreSimulator.SimDeviceType.iPhone-14" "com.apple.CoreSimulator.SimRuntime.iOS-17-5"` to create a dummy simulator. |

## What "fully working" looks like

After everything above is in place, a clean `npm install &&
cd ios && pod install && cd .. && npx react-native run-ios` on a
**fresh** clone should:

1. Run `patch-package` automatically as part of postinstall, applying the `react-native-sensors+7.3.6.patch`.
2. Run the SDK's own postinstall fetcher, pulling the OpenCV
   xcframework + Android per-ABI `.so` files into `node_modules/react-native-image-stitcher/`.
3. Run `pod install`, installing ~75 pods (including `VisionCamera`, `RNSensors`, `react-native-image-stitcher`, and all the standard RN 0.84 pods).
4. Build + install + launch the iPhone app, which shows the `<Camera>` preview.
5. Tap shutter → photo captured.  Hold + pan → panorama stitched.

Any of those steps failing → consult the [Troubleshooting](#troubleshooting)
table above first.  If the symptom isn't listed there, please
open an issue at
[github.com/bhargavkanda/react-native-image-stitcher/issues](https://github.com/bhargavkanda/react-native-image-stitcher/issues).
