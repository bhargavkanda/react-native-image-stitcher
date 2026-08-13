// SPDX-License-Identifier: Apache-2.0
package io.imagestitcher.rn

import android.util.Log
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

/**
 * v0.8.0 Phase 4b.ii — Android-side JSI installer for the host
 * worklet proxy.  Mirror of iOS' `StitcherJsiInstaller`.
 *
 * The module exposes one synchronous method, `install()`, which JS
 * calls once at lib bootstrap (via the
 * `ensureStitcherProxyInstalled` helper in
 * `src/stitching/ensureStitcherProxyInstalled.ts`).  We reach into
 * the main JS runtime via `ReactApplicationContext.getJavaScriptContextHolder().get()`
 * — the canonical bridgeless-compatible accessor in modern RN
 * (worklets-core's `WorkletsModule` uses the same pattern, verified
 * working on RN 0.84.1 + new arch + Hermes).
 *
 * The native `nativeInstall(jsiRuntimeRef)` JNI then casts the long
 * back to a `jsi::Runtime*` and calls into the shared C++
 * `retailens::installStitcherProxy(runtime)` (in
 * `cpp/stitcher_proxy_jsi.{hpp,cpp}`).  Identical destination on
 * both platforms — `globalThis.__stitcherProxy` exposes the same
 * `install` / `uninstall` / `count` host functions.
 *
 * ## Returning `Boolean` (not `Promise`) from a sync method
 *
 * `isBlockingSynchronousMethod = true` + `Boolean` return is the
 * documented pattern for "I'm doing one-shot native setup that
 * needs to complete before the next JS line runs."  Same shape as
 * `WorkletsModule.install()`.
 *
 * ## What we DON'T do here (Phase 4b.ii follow-up)
 *
 * Phase 4b.ii's MVP installs the proxy ONLY.  Host worklets that
 * register through `__stitcherProxy.install` land in the native
 * `retailens::StitcherWorkletRegistry`.  Per-frame fan-out from
 * Android's `StitcherWorkletRuntime` is a separate piece of work
 * (Phase 4b.ii follow-up) — needs the Kotlin↔JNI bridge that
 * constructs a `CameraFrameJsiHostObject` from an `ArImage` +
 * pose and posts it through a worklet runtime.  Until that lands,
 * Android-registered worklets behave exactly like iOS-registered
 * worklets BEFORE Phase 4b.i: they exist in the registry but
 * aren't invoked.
 *
 * The proxy install itself is still useful as a foundation —
 * verifies the JNI handshake works, exercises the bridgeless
 * runtime accessor, and gives us a `count()` smoke test for the
 * device verification step.
 */
class StitcherJsiInstallerModule(
    private val reactContext: ReactApplicationContext,
) : ReactContextBaseJavaModule(reactContext) {
    override fun getName(): String = NAME

    @ReactMethod(isBlockingSynchronousMethod = true)
    fun install(): Boolean {
        return try {
            // `getJavaScriptContextHolder().get()` returns a raw
            // `jsi::Runtime*` boxed as `Long`.  Same accessor
            // worklets-core's `WorkletsModule.install()` uses;
            // documented to work in both legacy + bridgeless modes
            // on RN 0.71+.
            val holder = reactContext.javaScriptContextHolder
            if (holder == null) {
                Log.e(TAG, "getJavaScriptContextHolder() returned null; runtime unreachable")
                return false
            }
            val runtimeRef = holder.get()
            if (runtimeRef == 0L) {
                Log.e(TAG, "JavaScriptContextHolder.get() returned 0; runtime not initialized yet")
                return false
            }
            val ok = nativeInstall(runtimeRef)
            if (!ok) {
                Log.e(TAG, "nativeInstall(runtimeRef=$runtimeRef) returned false")
            }
            ok
        } catch (t: Throwable) {
            Log.e(TAG, "install() threw — falling back to JS-side registry", t)
            false
        }
    }

    private external fun nativeInstall(jsiRuntimeRef: Long): Boolean

    companion object {
        const val NAME = "StitcherJsiInstaller"
        private const val TAG = "StitcherJsiInstaller"

        init {
            // The Phase 3a JNI shim (`libimage_stitcher.so`) absorbed
            // the JSI-install JNI binding from Phase 4b.ii.  Loading
            // it once is enough — Android's loader deduplicates,
            // so even if `IncrementalStitcher.kt`'s init block
            // already loaded the lib, calling again is a cheap no-op.
            //
            // v0.24.4 — via NativeLibraryLoader.tryLoad(), which never
            // throws.  This class is constructed eagerly by
            // RNImageStitcherPackage.createNativeModules() during bridge
            // startup, so a throwing static initialiser here crashed the
            // whole app before any JS ran (see NativeLibraryLoader's
            // header).  install() already returns false on any failure,
            // which is exactly the right degradation.
            NativeLibraryLoader.tryLoad()
        }
    }
}
