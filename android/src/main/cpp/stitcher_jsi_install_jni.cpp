// SPDX-License-Identifier: Apache-2.0
//
// stitcher_jsi_install_jni.cpp — JNI binding for the Android-side
// JSI install (v0.8.0 Phase 4b.ii).
//
// Kotlin's `StitcherJsiInstallerModule.nativeInstall(jsiRuntimeRef)`
// calls into this file.  We unbox the `jsi::Runtime*` from the
// Java `long` and hand it to the shared
// `retailens::installStitcherProxy(runtime)` function which sets
// `globalThis.__stitcherProxy`.  Same destination as iOS — the
// host object class lives in `cpp/stitcher_proxy_jsi.{hpp,cpp}`.
//
// ## Why a `long` ref, not a JSI handle wrapper class
//
// `ReactApplicationContext.getJavaScriptContextHolder()` returns a
// `JavaScriptContextHolder` whose `.get()` returns a Java `long`
// that's the raw pointer to the C++ `jsi::Runtime*`.  Same
// contract as worklets-core's `WorkletsModule.nativeInstall`
// (verified at the same call site).  Caller is responsible for
// ensuring the runtime outlives this call — in practice, the
// runtime IS the JS thread's runtime which lives the whole
// process lifetime, so this is structurally always safe in our
// usage.
//
// ## Threading
//
// Kotlin invokes this from a `@ReactMethod(isBlockingSynchronousMethod
// = true)` so we're already on the JS thread.  Synchronous JSI
// access is safe.

#include "stitcher_proxy_jsi.hpp"

#include <jni.h>
#include <jsi/jsi.h>

#include <android/log.h>

#define LOG_TAG "StitcherJsiInstaller"
#define LOGI(...) __android_log_print(ANDROID_LOG_INFO, LOG_TAG, __VA_ARGS__)

extern "C" JNIEXPORT jboolean JNICALL
Java_io_imagestitcher_rn_StitcherJsiInstallerModule_nativeInstall(
    JNIEnv* /*env*/, jobject /*thiz*/, jlong jsiRuntimeRef) {
  if (jsiRuntimeRef == 0) {
    // ReactApplicationContext.getJavaScriptContextHolder().get()
    // returns 0 when the runtime isn't ready (rare — JS would have
    // had to call us before its own runtime was up; impossible in
    // practice).  Defensive.
    return JNI_FALSE;
  }
  auto* runtime = reinterpret_cast<facebook::jsi::Runtime*>(jsiRuntimeRef);
  retailens::installStitcherProxy(*runtime);
  LOGI("installed globalThis.__stitcherProxy on main JS runtime.");
  return JNI_TRUE;
}
