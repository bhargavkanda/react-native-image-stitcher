// SPDX-License-Identifier: Apache-2.0
//
// StitcherFrameHostObject.h — Obj-C facade for the v0.8.0
// `StitcherFrame` JSI host object.  Header is intentionally
// Obj-C-only (no `<jsi/jsi.h>` import) so this can land in the
// public CocoaPods umbrella without breaking `use_frameworks!` hosts
// (same rationale as `KeyframeGateBridge.h`).
//
// The C++ JSI host object class lives in the .mm; this facade
// exposes only what cross-module callers need:
//
//   - Factory `+ fromARFrame:pose:` that the AR worklet runtime
//     calls per ARFrame to construct a host object backed by the
//     current AR session's frame.
//   - Opaque accessor `- (void *)jsiHostObjectPtr` returning the
//     `std::shared_ptr<facebook::jsi::HostObject> *` (boxed) that
//     the worklet runtime hands to `jsi::Object::createFromHostObject`.
//
// Lifetime: the Obj-C wrapper holds the C++ shared_ptr; ARC frees
// the wrapper when nothing references it.  Worklet runtime
// invalidates the underlying ARFrame retain when the dispatch
// returns; after invalidation, JSI access throws.

#pragma once

#import <Foundation/Foundation.h>
#import <ARKit/ARKit.h>

@class RNSARFramePose;

NS_ASSUME_NONNULL_BEGIN

NS_SWIFT_NAME(StitcherFrameHostObject)
@interface StitcherFrameHostObject : NSObject

/// Construct a host object backed by the supplied ARFrame + pose.
/// Retains the ARFrame for the host object's lifetime — caller can
/// safely release their reference.
///
/// Thread: safe to call from the ARSession delegate queue; the
/// resulting host object's JSI access must happen on the worklet
/// runtime's thread (separate queue).
+ (instancetype)fromARFrame:(ARFrame *)arFrame pose:(RNSARFramePose *)pose;

/// Mark the host object's underlying ARFrame as no longer accessible.
/// Subsequent JSI property reads return `undefined` or throw,
/// depending on the property.  Idempotent.
- (void)invalidate;

/// Opaque pointer to a `std::shared_ptr<facebook::jsi::HostObject>`.
/// The worklet runtime (Obj-C++ context with JSI available) casts
/// this back via `*reinterpret_cast<std::shared_ptr<facebook::jsi::HostObject>*>(ptr)`
/// to hand to `jsi::Object::createFromHostObject`.
///
/// Returns `NULL` if the host object has been invalidated.
- (nullable void *)jsiHostObjectPtr;

@end

NS_ASSUME_NONNULL_END
